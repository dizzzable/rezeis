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

  public constructor(
    private readonly autoRenewService: AutoRenewService,
    private readonly rawCacheService: RawCacheService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'auto-renew-cycle' })
  public async tick(): Promise<void> {
    if (!shouldRunSchedules()) return;
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error('AutoRenewScheduler cycle failed', error instanceof Error ? error.stack : undefined);
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
