import { InjectQueue } from '@nestjs/bullmq';
import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Queue } from 'bullmq';

import { runBullMqEnqueueWithTimeout } from '../../../common/queue/bullmq-enqueue-options';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import {
  ADD_ON_CUTOVER_BATCH_SIZE,
  ADD_ON_CUTOVER_JOB_ID,
  ADD_ON_CUTOVER_MAX_ROWS_PER_TICK,
  ADD_ON_CUTOVER_PAUSE_MS,
  ADD_ON_CUTOVER_QUEUE,
  ADD_ON_CUTOVER_TICK_BUDGET_MS,
  ADD_ON_CUTOVER_TICK_JOB,
} from '../add-on-cutover.constants';
import { resolveAddOnRolloutFlags } from '../add-on-rollout.config';
import { CutoverRunReport, EntitlementCutoverService } from './entitlement-cutover.service';

/**
 * BRINGS EVERY EXISTING SUBSCRIPTION INTO THE TERM MODEL, IN THE BACKGROUND,
 * WHILE STAGE 1 IS ON.
 *
 * The operator does nothing: no script to run, no batch to repeat until the
 * count reaches zero. Each pass is `EntitlementCutoverService.runCutover` with
 * a budget — pages of {@link ADD_ON_CUTOVER_BATCH_SIZE}, at most
 * {@link ADD_ON_CUTOVER_MAX_ROWS_PER_TICK} rows or
 * {@link ADD_ON_CUTOVER_TICK_BUDGET_MS}, one transaction per subscription.
 *
 * ── How it is scheduled ────────────────────────────────────────────────────
 *
 *  - A `@Cron` every five minutes, on the process that runs schedules (the
 *    worker), enqueues one tick — only while `ADDON_ENTITLEMENT_SHADOW` is on.
 *    Once everything is in the model a tick is one short query that finds
 *    nothing: cheap enough to keep running, which is what picks up subscriptions
 *    created later by a path that does not create their term itself (imports,
 *    today every creation path).
 *  - `onApplicationBootstrap` enqueues the first one WITHOUT awaiting it: boot
 *    never waits on Redis or the database, and an outage there cannot fail it.
 *  - The processor re-reads the flag before it starts: a tick queued just before
 *    stage 1 was switched off does nothing.
 *
 * ── Why it is safe ─────────────────────────────────────────────────────────
 *
 *  - ONE RUNNER. The tick has a fixed BullMQ id ({@link ADD_ON_CUTOVER_JOB_ID}),
 *    so while one waits or runs, every other enqueue — the next cron, another
 *    worker, a blue/green twin — adds nothing.
 *  - IDEMPOTENT AND RESTART-SAFE. A subscription that has a term is not a
 *    candidate, and each one is brought in by `ensureTermInTransaction` under
 *    its row lock, so a pass interrupted anywhere — deploy, crash, SIGKILL after
 *    the grace period — has committed every row it finished and none it did not.
 *    The next pass starts over from the candidates left; there is no cursor to
 *    persist. A worker that dies mid-pass leaves the job stalled, and BullMQ
 *    hands it to the next worker.
 *  - SAFE BESIDE PAYMENTS. Every payment path that writes terms takes the same
 *    subscription row lock first.
 *  - A ROW THAT FAILS DOES NOT STOP THE PASS: see `runCutover`.
 *
 * ── Where an operator sees it ──────────────────────────────────────────────
 *
 * `GET /admin/add-on-entitlements/metrics` carries `cutover` — eligible, in
 * the model, remaining, needing attention. The «Дополнительные опции»
 * entitlements tab loads that endpoint but does not render the block yet; what
 * it does render today is the `SHADOW` projection count (one per subscription
 * brought in) and open `RECONCILIATION_REQUIRED` incidents (a row that could
 * not be). Each pass that did anything also logs its report.
 */
@Injectable()
export class EntitlementCutoverJobService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(EntitlementCutoverJobService.name);
  private stopping = false;

  public constructor(
    private readonly cutoverService: EntitlementCutoverService,
    @InjectQueue(ADD_ON_CUTOVER_QUEUE) private readonly queue: Queue,
  ) {}

  /** Every five minutes on the worker: queue a tick while stage 1 is on. */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'add-on-entitlement-cutover' })
  public async schedule(): Promise<boolean> {
    if (!shouldRunSchedules()) return false;
    if (!resolveAddOnRolloutFlags().entitlementShadow) return false;
    return this.enqueueTick();
  }

  public onApplicationBootstrap(): void {
    // Not awaited, deliberately: see the class note.
    void this.schedule().catch((error: unknown) => {
      this.logger.warn(
        `Cutover tick not queued at boot; the next cron queues it: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  public beforeApplicationShutdown(): void {
    // A pass in flight finishes the row it is on and stops there; the rest is
    // the next pass's.
    this.stopping = true;
  }

  /**
   * Queues one tick under the fixed id. Bounded, and never thrown: a tick that
   * never reached Redis is queued again by the next cron.
   */
  public async enqueueTick(): Promise<boolean> {
    try {
      await runBullMqEnqueueWithTimeout(() =>
        this.queue.add(
          ADD_ON_CUTOVER_TICK_JOB,
          {},
          {
            jobId: ADD_ON_CUTOVER_JOB_ID,
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: true,
          },
        ),
      );
      return true;
    } catch (error: unknown) {
      this.logger.warn(
        `Cutover tick not queued; the next cron retries: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  /** One pass, as the processor runs it. `null` when stage 1 is off. */
  public async runTick(now: number = Date.now()): Promise<CutoverRunReport | null> {
    if (!resolveAddOnRolloutFlags().entitlementShadow) {
      this.logger.log('Cutover tick skipped: ADDON_ENTITLEMENT_SHADOW is off');
      return null;
    }
    return this.cutoverService.runCutover({
      dryRun: false,
      batchSize: ADD_ON_CUTOVER_BATCH_SIZE,
      maxRows: ADD_ON_CUTOVER_MAX_ROWS_PER_TICK,
      deadline: now + ADD_ON_CUTOVER_TICK_BUDGET_MS,
      pauseMs: ADD_ON_CUTOVER_PAUSE_MS,
      shouldStop: () => this.stopping,
    });
  }
}
