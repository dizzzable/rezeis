import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';

import { EVENT_TYPES, type SystemEventsService } from '../../common/services/system-events.service';
import { isFinalProcessorAttempt } from '../backup/backup-delivery-retry.util';
import {
  TELEGRAM_DIRECT_QUEUE,
  TELEGRAM_FLOOD_WAIT_CEILING_SECONDS,
  resolveTelegramDirectBackoff,
  type TelegramDirectJobData,
} from './telegram-direct.constants';
import { isRetryableTelegramOutcome, type TelegramDirectResult } from './telegram-direct.outcome';
import { TelegramDirectClient } from './services/telegram-direct.client';
import {
  buildTelegramDirectUndeliveredRecord,
  TELEGRAM_DIRECT_UNDELIVERED_RECORDER,
  type UndeliveredRecord,
  type UndeliveredRecorder,
} from './undelivered-record';

/**
 * The one place a `telegram.direct_undelivered` record becomes a system event.
 *
 * Reached only through `TELEGRAM_DIRECT_UNDELIVERED_RECORDER`, which
 * `TelegramDirectModule` binds to this behind the alert gate, and which both
 * roads use: this processor (a job out of attempts, or refused for good) and
 * `TelegramDirectQueueService` (the direct attempt it makes when Redis refused
 * the job). The loop guard in `SystemEventsService` keys on this type, so both
 * roads are covered by it for the same reason.
 */
export function emitTelegramDirectUndelivered(
  events: Pick<SystemEventsService, 'warn'>,
  record: UndeliveredRecord,
): void {
  events.warn(EVENT_TYPES.TELEGRAM_DIRECT_UNDELIVERED, 'SYSTEM', record.message, record.metadata);
}

/**
 * Three at a time.
 *
 * Lower than the relay's five, and not arbitrarily: this queue talks to
 * Telegram, which rate-limits per bot rather than per connection. Extra
 * concurrency here does not buy throughput, it buys 429s — and a 429 costs
 * more than the send it replaced, because it delays every subsequent card for
 * the whole flood-wait. Three keeps a burst draining without racing the limit.
 */
const TELEGRAM_DIRECT_CONCURRENCY = 3;

/**
 * An attempt that failed in a way another attempt might fix, carrying the
 * flood-wait when Telegram named one.
 *
 * The `retryAfterSeconds` field is the entire reason this class exists rather
 * than a plain `Error`: BullMQ's custom backoff strategy is handed the thrown
 * error, and that is the only channel through which "wait 42 seconds, Telegram
 * says so" can reach the scheduler.
 */
export class TelegramDirectRetryError extends Error {
  public readonly retryAfterSeconds: number | null;

  public constructor(message: string, retryAfterSeconds: number | null) {
    super(message);
    this.name = 'TelegramDirectRetryError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * The worker's `custom` backoff. Pure logic lives in
 * `resolveTelegramDirectBackoff`; this is only the adapter that digs the
 * flood-wait out of the error BullMQ hands back.
 */
export function telegramDirectBackoffStrategy(attemptsMade: number, _type?: string, err?: Error): number {
  const retryAfter =
    err instanceof TelegramDirectRetryError ? err.retryAfterSeconds : null;
  return resolveTelegramDirectBackoff(attemptsMade, retryAfter);
}

/**
 * TelegramDirectProcessor
 * ═══════════════════════
 * The consumer half of panel-owned Telegram delivery. Four exits, mirroring
 * `ReiwaRelayProcessor` so the two queues can be read side by side:
 *
 *  - sent → complete.
 *  - not sent, retryable, attempts remain → throw `TelegramDirectRetryError`,
 *    so BullMQ retries on a backoff that honours a flood-wait.
 *  - not sent, terminal → `UnrecoverableError`: fail now without burning the
 *    remaining attempts on a request whose answer cannot change.
 *  - not sent, retryable, out of attempts → fail, so the job lands in the
 *    retained failed set next to the audit-log row.
 *
 * Every exit that is not "sent" first records a `telegram.direct_undelivered`
 * system event — once per cause per cooldown, the rest counted into the next
 * one (`undelivered-alert-gate.ts`): a revoked token refuses every card at
 * once, and one card saying so is the alert, not a hundred. That row in
 * `AdminAuditLog` is the durable trace, and it is the whole reason this is a
 * queue rather than a `fetch` in a `catch`: before, the entire record of a lost
 * operator card was a `logger.warn` in an in-memory ring buffer that a restart
 * erases.
 */
@Processor(TELEGRAM_DIRECT_QUEUE, {
  concurrency: TELEGRAM_DIRECT_CONCURRENCY,
  settings: { backoffStrategy: telegramDirectBackoffStrategy },
})
export class TelegramDirectProcessor extends WorkerHost {
  private readonly logger = new Logger(TelegramDirectProcessor.name);

  public constructor(
    private readonly client: TelegramDirectClient,
    /** The coalescing emitter, shared with the producer's direct fallback. */
    @Inject(TELEGRAM_DIRECT_UNDELIVERED_RECORDER)
    private readonly recordUndeliveredSend: UndeliveredRecorder,
  ) {
    super();
  }

  public async process(job: Job<TelegramDirectJobData>): Promise<{
    readonly status: string;
    readonly delivered: boolean;
  }> {
    const outcome = await this.client.send(job.data);

    if (outcome.status === 'sent') {
      return { status: outcome.status, delivered: true };
    }

    const retryable = isRetryableTelegramOutcome(outcome, TELEGRAM_FLOOD_WAIT_CEILING_SECONDS);
    const finalAttempt = isFinalProcessorAttempt(job);

    if (retryable && !finalAttempt) {
      // No operator event yet: attempt two may well deliver, and one alert per
      // attempt is four alerts for one card. Same split the relay processor
      // makes.
      this.logger.warn(
        `Telegram ${job.data.kind} for ${job.data.sourceEventType} ${outcome.status} ` +
          `(attempt ${job.attemptsMade + 1}/${job.opts?.attempts ?? 1}) — retrying`,
      );
      throw new TelegramDirectRetryError(
        `telegram direct ${outcome.status}`,
        outcome.retryAfterSeconds,
      );
    }

    await this.recordUndelivered(job, outcome);

    if (retryable) {
      throw new TelegramDirectRetryError(
        `telegram direct ${outcome.status} (attempts exhausted)`,
        outcome.retryAfterSeconds,
      );
    }
    throw new UnrecoverableError(`telegram direct ${outcome.status} (permanent)`);
  }

  /**
   * Leave a trace that survives the process, and say something the operator
   * can act on. What the sentence and the metadata carry, and why, is written
   * beside `buildTelegramDirectUndeliveredRecord`.
   */
  private async recordUndelivered(
    job: Job<TelegramDirectJobData>,
    outcome: TelegramDirectResult,
  ): Promise<void> {
    try {
      await this.recordUndeliveredSend(
        buildTelegramDirectUndeliveredRecord({
          data: job.data,
          outcome,
          attemptsMade: job.attemptsMade + 1,
          attempts: job.opts?.attempts ?? 1,
        }),
      );
    } catch (err: unknown) {
      // What the job does next must not depend on whether the record could be
      // written; the log line is what is left.
      this.logger.warn(
        `Could not record the undelivered card for ${job.data.sourceEventType}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  @OnWorkerEvent('failed')
  public onFailed(job: Job<TelegramDirectJobData> | undefined, error: Error): void {
    this.logger.warn(
      `Telegram direct job ${job?.id ?? 'unknown'} ` +
        `(${job?.data?.sourceEventType ?? 'unknown'}) failed: ${error.message}`,
    );
  }
}
