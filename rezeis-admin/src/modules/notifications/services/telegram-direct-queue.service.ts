import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

import {
  BULLMQ_RETAINED_COMPLETED_JOBS,
  BULLMQ_RETAINED_FAILED_JOBS,
  runBullMqEnqueueWithTimeout,
} from '../../../common/queue/bullmq-enqueue-options';
import {
  TELEGRAM_DIRECT_ATTEMPTS,
  TELEGRAM_DIRECT_JOB,
  TELEGRAM_DIRECT_QUEUE,
  type TelegramDirectJobData,
} from '../telegram-direct.constants';
import { TelegramDirectClient } from './telegram-direct.client';

/**
 * TelegramDirectQueueService
 * ══════════════════════════
 * Producer half of panel-owned Telegram delivery, deliberately built to the
 * same contract as `ReiwaRelayQueueService`: never throws, answers "accepted
 * for durable delivery" rather than "delivered", and degrades to one direct
 * attempt when Redis will not take the job.
 *
 * Same contract on purpose. `SystemEventsService` picks between the two on one
 * condition — does this panel hold a bot token — and a caller that has to
 * remember which of two producers might throw is a caller that will eventually
 * forget.
 */
@Injectable()
export class TelegramDirectQueueService {
  private readonly logger = new Logger(TelegramDirectQueueService.name);

  public constructor(
    @InjectQueue(TELEGRAM_DIRECT_QUEUE)
    private readonly queue: Queue<TelegramDirectJobData>,
    private readonly client: TelegramDirectClient,
  ) {}

  /**
   * Queue one Telegram send.
   *
   * `eventId` is optional and is used only to derive a stable `jobId`, which
   * collapses an accidental double-enqueue of the same logical card into one
   * job. It is NOT a Telegram-side idempotency key and cannot be: the Bot API
   * has no such concept, so a retry that times out after Telegram accepted the
   * message can still produce a duplicate card. That was equally true of the
   * relay path — the bot's `IdempotencyCache` deduped the RELAY call, not the
   * send — so nothing regressed here, but it should be stated rather than
   * assumed from the presence of a key.
   */
  public async enqueue(
    data: TelegramDirectJobData,
    eventId: string | null = null,
  ): Promise<boolean> {
    try {
      await runBullMqEnqueueWithTimeout(() =>
        this.queue.add(TELEGRAM_DIRECT_JOB, data, {
          attempts: TELEGRAM_DIRECT_ATTEMPTS,
          // `custom`, not `exponential`, so the strategy registered on the
          // worker gets to see the error and honour a 429's `retry_after`.
          // An exponential backoff cannot: it is handed the attempt number and
          // nothing else, which is how a flood-wait turns into three more
          // requests inside the same flood-wait.
          backoff: { type: 'custom' },
          removeOnComplete: BULLMQ_RETAINED_COMPLETED_JOBS,
          removeOnFail: BULLMQ_RETAINED_FAILED_JOBS,
          ...(eventId !== null ? { jobId: `${TELEGRAM_DIRECT_JOB}:${eventId}` } : {}),
        }),
      );
      return true;
    } catch (err: unknown) {
      // Redis unreachable or slow. One direct attempt keeps the floor at what
      // this path did before it was durable at all, rather than turning a
      // Redis blip into a silently dropped operator card.
      this.logger.warn(
        `Telegram enqueue failed for ${data.sourceEventType} ` +
          `(${err instanceof Error ? err.message : String(err)}); falling back to one direct attempt`,
      );
      const outcome = await this.client.send(data).catch(() => null);
      this.logger.warn(
        `Telegram direct fallback for ${data.sourceEventType}: ${outcome === null ? 'threw' : outcome.status}`,
      );
      return false;
    }
  }
}
