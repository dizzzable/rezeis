import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  BULLMQ_RETAINED_COMPLETED_JOBS,
  BULLMQ_RETAINED_FAILED_JOBS,
  runBullMqEnqueueWithTimeout,
} from '../../../common/queue/bullmq-enqueue-options';
import { toOptionalBullMqJobId } from '../../../common/queue/bullmq-job-id';
import {
  lateEnqueueOf,
  probeLateJob,
  withdrawLateJob,
} from '../../../common/queue/bullmq-late-enqueue';
import { rememberLostChannelPost, rememberRelayedChannelPost } from '../relay-channel-post';
import {
  REIWA_RELAY_JOB,
  REIWA_RELAY_QUEUE,
  type ReiwaRelayEvent,
  type ReiwaRelayJobData,
} from '../reiwa-relay.constants';
import {
  isRelayDelivered,
  RELAY_BACKOFF_TYPE,
  RELAY_EVENT_POLICY,
  shouldAlertOperator,
} from '../reiwa-relay.policy';
import {
  buildRelayUndeliveredRecord,
  RELAY_UNDELIVERED_RECORDER,
  recordingOf,
  type UndeliveredRecorder,
} from '../undelivered-record';
import { BotNotifierClient, type NotifyDeliveryResult } from './bot-notifier.client';

/**
 * What became of one relay handed to `ReiwaRelayQueueService.submit`.
 *
 *  - `queued` — the queue has it and owns every attempt from here, including
 *    the record if they all fail. Also the answer when the add timed out but
 *    the job landed after all.
 *  - `delivered` — Redis did not take it, and the one direct attempt delivered.
 *  - `lost-alerted` — neither road delivered, and a `reiwa.relay_undelivered`
 *    card about THIS relay went out. A caller must not raise a second one.
 *  - `lost-counted` — neither road delivered, and the loss was only counted into
 *    an alert the same cause raised earlier: no card names this relay. A caller
 *    that owes its operator a card about it still has to raise one.
 *  - `lost-unrecorded` — neither road delivered, and nothing recorded it: an
 *    outcome `shouldAlertOperator` keeps quiet (a blocked subscriber, a dev
 *    route to nobody), or a recorder that failed.
 *  - `disabled` — the relay is not configured; nothing was attempted.
 */
export type RelaySubmission =
  | 'queued'
  | 'delivered'
  | 'lost-alerted'
  | 'lost-counted'
  | 'lost-unrecorded'
  | 'disabled';

/**
 * ReiwaRelayQueueService
 * ══════════════════════
 * The producer half of durable panel → cabinet delivery. Callers hand it an
 * event and its metadata; it puts a BullMQ job on `reiwa-relay` with the retry
 * policy that event earned, and `ReiwaRelayProcessor` does the HTTP.
 *
 * The whole point is that the caller stops being the last line of defence.
 * Before this, nine event kinds went out on a single `fetch` whose result was
 * dropped by every caller — a `logger.warn` into a 5 000-entry in-memory ring
 * buffer was the entire record that a subscriber never got their message.
 *
 * Two deliberate non-guarantees:
 *
 *  - **Not transactional with the caller's write.** Enqueue happens after the
 *    row is committed, so a crash between the two still loses the relay. Fixing
 *    that means an outbox table, i.e. a migration; the queue closes the large
 *    hole (the network) without one.
 *
 *  - **Not ordered.** BullMQ retries with backoff, so two events touching the
 *    same subject can land out of order. Every event on this queue is either a
 *    cache bust (order-free by construction — a bust carries no state) or a
 *    Telegram message (which is a log, not a state machine). Nothing here
 *    reads-modify-writes cabinet state, so ordering has nothing to break.
 */
@Injectable()
export class ReiwaRelayQueueService {
  private readonly logger = new Logger(ReiwaRelayQueueService.name);

  public constructor(
    @InjectQueue(REIWA_RELAY_QUEUE)
    private readonly queue: Queue<ReiwaRelayJobData>,
    private readonly botNotifier: BotNotifierClient,
    /**
     * Writes `reiwa.relay_undelivered` for a relay the direct fallback could
     * not deliver — the record an exhausted job writes. A token, not
     * `SystemEventsService`: see `undelivered-record.ts`.
     */
    @Inject(RELAY_UNDELIVERED_RECORDER)
    private readonly recordUndelivered: UndeliveredRecorder,
    /**
     * Only for a channel post on the direct fallback: a delivered post's address
     * has to be stored exactly as the processor stores it, or it can never be
     * edited or recalled, and a post that certainly never went up has to stop
     * reading as a public copy. See `rememberRelayedChannelPost` and
     * `rememberLostChannelPost`.
     */
    private readonly prismaService: PrismaService,
  ) {}

  /** Whether the relay is configured at all (REIWA_URL + WEBHOOK_SECRET_HEADER). */
  public get isEnabled(): boolean {
    return this.botNotifier.isEnabled;
  }

  /**
   * Queue one relay event. Never throws — the callers are `void`-ed fanouts,
   * post-response taps and interceptors, none of which can absorb one.
   *
   * Answers whether the event is in hand: `true` when it was accepted for
   * durable delivery, AND when Redis refused it but the one direct attempt
   * that follows delivered it — the operator's "send message" is then sent,
   * and saying otherwise invites a second press and a duplicate. `false` means
   * nothing has it: the relay is unconfigured, or the direct attempt did not
   * deliver either, which is recorded exactly as an exhausted job would be.
   * `submit` answers the same question with the reason.
   */
  public async enqueue(
    event: ReiwaRelayEvent,
    metadata: Record<string, unknown>,
  ): Promise<boolean> {
    const submission = await this.submit(event, metadata);
    return submission === 'queued' || submission === 'delivered';
  }

  /**
   * `enqueue`, answering what became of the relay rather than only whether it
   * is in hand — for a caller that has its own record to write about a loss,
   * and must not write it when this one already has. Never throws.
   */
  public async submit(
    event: ReiwaRelayEvent,
    metadata: Record<string, unknown>,
  ): Promise<RelaySubmission> {
    if (!this.botNotifier.isEnabled) {
      // No REIWA_URL / WEBHOOK_SECRET_HEADER. Queuing would bank jobs that can
      // only fail: `disabled` is not a transient status, and nothing short of
      // a restart with new env changes it.
      return 'disabled';
    }
    const policy = RELAY_EVENT_POLICY[event];
    const eventId = typeof metadata['eventId'] === 'string' ? metadata['eventId'] : null;
    // Named before the add and kept, because a timed-out add is looked up by it
    // afterwards (`deliverWithoutQueue`). Built inside the `try`: a scope this
    // producer got wrong must take the fallback, not throw at the caller.
    let jobId: string | null = null;
    try {
      jobId = toOptionalBullMqJobId(event, eventId);
      const customId = jobId;
      await runBullMqEnqueueWithTimeout(() =>
        this.queue.add(
          REIWA_RELAY_JOB,
          { event, metadata },
          {
            attempts: policy.attempts,
            // A custom type, so the worker's `relayBackoffStrategy` computes the
            // delay: the policy's own fixed/exponential schedule, pushed back to
            // the cabinet's `Retry-After` when a 503 names one. A built-in type
            // here would be resolved by BullMQ's table and never see the error.
            // `delay` stays on the job so an inspector still reads the base.
            backoff: { type: RELAY_BACKOFF_TYPE, delay: policy.backoff.delay },
            removeOnComplete: BULLMQ_RETAINED_COMPLETED_JOBS,
            // Failed jobs are the durable evidence of an exhausted relay that
            // survives the process; keep the same bound as everywhere else.
            //
            // The bound stays at the shared 100 on purpose. It was the wrong
            // knob: what made this set useless was not its size but its
            // CONTENTS — every subscriber who blocked the bot produced a
            // failed `reiwa.user.notify`, so on a platform with churn the
            // routine per-recipient outcomes churned the set continuously and
            // evicted the jobs worth reading. Any number large enough to
            // outlast that on one platform is wrong on the next. Fixed at the
            // source instead: `ReiwaRelayProcessor` COMPLETES every outcome
            // `shouldFailRelayJob` turns away — per-recipient facts, dev-route
            // dead ends, and messages Telegram refused — so what lands here is
            // now only relays that genuinely failed the link.
            removeOnFail: BULLMQ_RETAINED_FAILED_JOBS,
            // A stable job id collapses an accidental double-enqueue of the
            // same logical event into one job. Only set where the metadata
            // already carries a per-event key the producer minted — the
            // `UserNotificationEvent` CUID, `broadcast-channel:${id}`,
            // `sysevt:...` — because that key is also what the bot dedups on,
            // so the two collapses agree. Inventing one here would key on
            // nothing and defeat the purpose.
            //
            // DIGESTED, never used raw. Raw, `reiwa.user.notify:<cuid>` is two
            // colon parts and every `sysevt:` key is five or more, and BullMQ
            // refused all of them: every subscriber notification and every
            // system card took the direct fallback below, and the queue carried
            // almost nothing. The keys that did pass (exactly three parts, such
            // as `…:operator-mirror`) move to the same shape on purpose — one
            // shape, not a second one reached only by the keys that happen to
            // be long. Nothing is lost by renaming them: each is enqueued once
            // per event, and the cabinet's own dedup reads `metadata.eventId`,
            // which is untouched. See `toBullMqJobId`.
            ...(customId !== null ? { jobId: customId } : {}),
          },
        ),
      );
      return 'queued';
    } catch (err: unknown) {
      return this.deliverWithoutQueue(event, metadata, err, jobId);
    }
  }

  /**
   * Redis is unreachable or slow, or refused the job. Falling back to one
   * direct attempt keeps the floor at exactly the pre-queue behaviour instead
   * of turning a Redis blip into a silently dropped notification.
   *
   * What that attempt proves is judged by the processor's own rules —
   * `isRelayDelivered` for "delivered", `shouldAlertOperator` for "record it" —
   * because this is the same relay, merely on a road with one attempt. It used
   * to be neither judged nor recorded: a delivered fallback was reported as a
   * failure, and a failed one left nothing but a log line.
   *
   * ── When the add only TIMED OUT ────────────────────────────────────────────
   *
   * Then it may still land (`bullmq-late-enqueue.ts`), and a keyed job can be
   * looked for. Three checks follow from that, each closing one way the two
   * roads collided:
   *
   *  - the job is already there → the queue has the relay; no direct attempt.
   *  - the direct attempt delivered → the job is withdrawn, so a late landing
   *    does not deliver the relay a second time.
   *  - the direct attempt did not deliver, and the job is there now → the job
   *    owns the relay, and this miss is not a loss. The case it was written for
   *    is the cabinet's 503 "a send with this key is still in flight": that was
   *    the job delivering, recorded here as undelivered and reported to the
   *    operator as a failure.
   */
  private async deliverWithoutQueue(
    event: ReiwaRelayEvent,
    metadata: Record<string, unknown>,
    err: unknown,
    jobId: string | null,
  ): Promise<RelaySubmission> {
    const enqueueError = err instanceof Error ? err.message : String(err);
    const landed = jobId === null ? null : lateEnqueueOf(err);
    if (jobId !== null && landed !== null && (await probeLateJob(this.queue, jobId)) === 'landed') {
      this.logger.warn(
        `Relay enqueue for ${event} timed out, but the job landed; no direct attempt`,
      );
      return 'queued';
    }
    this.logger.warn(
      `Relay enqueue failed for ${event} (${enqueueError}); falling back to a single direct attempt`,
    );
    const outcome = await this.botNotifier
      .deliverRelayEvent(event, metadata)
      // `deliver()` answers every failure with a status. Should it ever throw
      // regardless, that is a failed attempt, not a reason to throw at the
      // caller.
      .catch(
        (thrown: unknown): NotifyDeliveryResult => ({
          status: 'failed',
          messageId: null,
          httpStatus: null,
          detail: thrown instanceof Error ? thrown.message : String(thrown),
        }),
      );
    if (isRelayDelivered(event, outcome)) {
      this.logger.warn(`Relay direct fallback for ${event} delivered (${outcome.status})`);
      if (jobId !== null && landed !== null) {
        await withdrawLateJob(this.queue, jobId, landed, (message) => this.logger.warn(message));
      }
      // The same bookkeeping a delivered job does. Without it a broadcast's
      // channel post sent on this road kept no address, and could never be
      // edited or recalled.
      await rememberRelayedChannelPost(this.prismaService, { event, metadata }, outcome, (message) =>
        this.logger.warn(message),
      );
      return 'delivered';
    }
    if (jobId !== null && landed !== null && (await probeLateJob(this.queue, jobId)) === 'landed') {
      this.logger.warn(
        `Relay direct fallback for ${event}: ${outcome.status}, but the timed-out job landed ` +
          'meanwhile and owns the relay; not recorded as undelivered',
      );
      return 'queued';
    }
    this.logger.warn(`Relay direct fallback for ${event}: ${outcome.status}`);
    // A broadcast's channel post that never went up must stop reading as a
    // public copy on the broadcast page — the same bookkeeping the processor
    // does for a job that ends this way.
    await rememberLostChannelPost(this.prismaService, { event, metadata }, outcome, (message) =>
      this.logger.warn(message),
    );
    if (!shouldAlertOperator(event, outcome)) return 'lost-unrecorded';
    try {
      const recording = recordingOf(
        await this.recordUndelivered(
          buildRelayUndeliveredRecord({
            event,
            metadata,
            outcome,
            attemptsMade: 1,
            attempts: 1,
            enqueueError,
          }),
        ),
      );
      return recording === 'alerted'
        ? 'lost-alerted'
        : recording === 'counted'
          ? 'lost-counted'
          : 'lost-unrecorded';
    } catch (recordErr: unknown) {
      // The recorder writes a system event; if even that throws, the caller
      // still must not — the log line above is what is left.
      this.logger.warn(
        `Could not record the undelivered ${event}: ${
          recordErr instanceof Error ? recordErr.message : String(recordErr)
        }`,
      );
      return 'lost-unrecorded';
    }
  }
}
