import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';

import { EVENT_TYPES, SystemEventsService } from '../../common/services/system-events.service';
import { isFinalProcessorAttempt } from '../backup/backup-delivery-retry.util';
import {
  TELEGRAM_DIRECT_QUEUE,
  TELEGRAM_FLOOD_WAIT_CEILING_SECONDS,
  resolveTelegramDirectBackoff,
  type TelegramDirectJobData,
} from './telegram-direct.constants';
import {
  describeTelegramOutcome,
  isRetryableTelegramOutcome,
  type TelegramDirectResult,
} from './telegram-direct.outcome';
import { TelegramDirectClient } from './services/telegram-direct.client';

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
 * Every exit that is not "sent" first writes a `telegram.direct_undelivered`
 * system event. That row in `AdminAuditLog` is the durable trace, and it is
 * the whole reason this is a queue rather than a `fetch` in a `catch`: before,
 * the entire record of a lost operator card was a `logger.warn` in an
 * in-memory ring buffer that a restart erases.
 */
@Processor(TELEGRAM_DIRECT_QUEUE, {
  concurrency: TELEGRAM_DIRECT_CONCURRENCY,
  settings: { backoffStrategy: telegramDirectBackoffStrategy },
})
export class TelegramDirectProcessor extends WorkerHost {
  private readonly logger = new Logger(TelegramDirectProcessor.name);

  public constructor(
    private readonly client: TelegramDirectClient,
    private readonly systemEventsService: SystemEventsService,
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

    this.recordUndelivered(job, outcome);

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
   * can act on.
   *
   * `describeTelegramOutcome` supplies the sentence; the metadata carries the
   * raw evidence. The two most valuable cases are the ones a bare status code
   * would hide: a 401 means the token in Settings is wrong, and a 400 with
   * `migrate_to_chat_id` means the group became a supergroup and the stored
   * Chat ID is now permanently dead — Telegram says so exactly once, on that
   * first 400, and never again.
   */
  private recordUndelivered(job: Job<TelegramDirectJobData>, outcome: TelegramDirectResult): void {
    this.systemEventsService.warn(
      EVENT_TYPES.TELEGRAM_DIRECT_UNDELIVERED,
      'SYSTEM',
      `Панель не доставила карточку в Telegram: ${describeTelegramOutcome(outcome)}`,
      {
        sourceEventType: job.data.sourceEventType,
        sendKind: job.data.kind,
        chatId: job.data.chatId,
        telegramStatus: outcome.status,
        httpStatus: outcome.httpStatus,
        detail: outcome.detail,
        ...(outcome.retryAfterSeconds === null
          ? {}
          : { retryAfterSeconds: outcome.retryAfterSeconds }),
        ...(outcome.migrateToChatId === null
          ? {}
          : { migrateToChatId: outcome.migrateToChatId }),
        attemptsMade: job.attemptsMade + 1,
        attempts: job.opts?.attempts ?? 1,
      },
    );
  }

  @OnWorkerEvent('failed')
  public onFailed(job: Job<TelegramDirectJobData> | undefined, error: Error): void {
    this.logger.warn(
      `Telegram direct job ${job?.id ?? 'unknown'} ` +
        `(${job?.data?.sourceEventType ?? 'unknown'}) failed: ${error.message}`,
    );
  }
}
