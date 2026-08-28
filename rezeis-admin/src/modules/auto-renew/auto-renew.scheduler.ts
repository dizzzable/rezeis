import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { RawCacheService } from '../../common/cache/raw-cache.service';
import { shouldRunSchedules } from '../../common/runtime/process-role.util';

import { AutoRenewService } from './auto-renew.service';

export interface AutoRenewCycleResult {
  readonly expired: number;
  readonly warnings3d: number;
  readonly warnings1d: number;
  readonly autopayAttempted: number;
  readonly autopaySucceeded: number;
  readonly autopayFailed: number;
  readonly autopaySkipped: number;
  readonly finishedAt: string;
  readonly durationMs: number;
}

/**
 * Redis key under which the most recent cycle result is stored. Both the
 * API and worker containers share the same Redis instance, so writes from
 * either side are visible to the other when the admin panel queries
 * `/admin/auto-renew/status`.
 */
const LAST_RESULT_KEY = 'rezeis:auto-renew:last-result';

/**
 * AutoRenewScheduler
 * ──────────────────
 * Periodically fires `AutoRenewService.runCycle()` so subscriptions move
 * out of `ACTIVE` once they cross their expiry timestamp and end-users
 * get timely "expiring soon" pings.
 *
 * The cadence is intentionally aggressive (every minute). The service is
 * idempotent — `markExpiredSubscriptions` only touches rows that crossed
 * the threshold since the last tick, and `createExpiryWarnings` skips
 * users that have already been notified inside the recent window.
 *
 * The last result is mirrored into Redis so the admin panel can see it
 * regardless of which container ran the cycle (the cron tick fires in
 * the worker, an operator-triggered "run now" fires in the API).
 */
@Injectable()
export class AutoRenewScheduler {
  private readonly logger = new Logger(AutoRenewScheduler.name);

  /**
   * True while a cycle is running, so the next tick stands down.
   *
   * THE CRON FIRES EVERY MINUTE AND THE CYCLE IS NO LONGER SHORT. Until the
   * expiry notices learned to quote the customer's traffic and devices, the
   * loop body was a single insert and two ticks could not realistically
   * overlap. Now each notice may consult the panel, so a slow panel stretches
   * one cycle past its own tick — and two cycles walking the same window both
   * read "not yet notified" for the customers the first has not reached, and
   * both write. The customer is told twice.
   *
   * The 20-hour throttle cannot help: it is a read-then-write with no unique
   * constraint underneath, so it stops a LATER cycle and not a CONCURRENT one.
   *
   * This guard covers the ticks, which is where the overlap actually comes
   * from — the cron runs in one process, gated by `shouldRunSchedules`. It does
   * NOT cover an operator pressing "run now" in the API while the worker's tick
   * is mid-cycle; that is a deliberate, rare action, and the bounded panel
   * reads now keep the window it could land in small.
   */
  private running = false;

  public constructor(
    private readonly autoRenewService: AutoRenewService,
    private readonly rawCacheService: RawCacheService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'auto-renew-cycle' })
  public async tick(): Promise<void> {
    if (!shouldRunSchedules()) return;
    if (this.running) {
      // Debug, not warn: on a healthy install this never fires, and on a slow
      // panel it fires every minute until the panel recovers. A warning that
      // repeats sixty times an hour is one an operator filters out.
      this.logger.debug('Auto-renew cycle still running; this tick stands down');
      return;
    }
    this.running = true;
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error('AutoRenewScheduler cycle failed', error instanceof Error ? error.stack : undefined);
    } finally {
      // `finally`, so a throw cannot leave the flag set and silence the
      // scheduler for the lifetime of the process.
      this.running = false;
    }
  }

  /**
   * Runs the cycle once and returns the result. Used both by the cron
   * tick and by the admin-triggered "run now" endpoint.
   */
  public async runOnce(): Promise<AutoRenewCycleResult> {
    const startedAt = Date.now();
    const cycleResult = await this.autoRenewService.runCycle();
    const finishedAt = new Date();
    const result: AutoRenewCycleResult = {
      ...cycleResult,
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt,
    };
    // Best-effort write to Redis — if the cache backend is down we just
    // lose the visibility for the admin panel until the next tick.
    try {
      await this.rawCacheService.set(LAST_RESULT_KEY, result);
    } catch (error) {
      this.logger.warn(
        `Failed to mirror cycle result to cache: ${(error as Error).message}`,
      );
    }
    return result;
  }

  public async getStatus(): Promise<{
    readonly lastResult: AutoRenewCycleResult | null;
    readonly cron: string;
  }> {
    let lastResult: AutoRenewCycleResult | null = null;
    try {
      lastResult = await this.rawCacheService.get<AutoRenewCycleResult>(LAST_RESULT_KEY);
    } catch (error) {
      this.logger.warn(
        `Failed to read cycle result from cache: ${(error as Error).message}`,
      );
    }
    return {
      lastResult,
      cron: 'every-minute',
    };
  }
}
