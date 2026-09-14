import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

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
import {
  TELEGRAM_DIRECT_ATTEMPTS,
  TELEGRAM_DIRECT_JOB,
  TELEGRAM_DIRECT_QUEUE,
  type TelegramDirectJobData,
} from '../telegram-direct.constants';
import type { TelegramDirectResult } from '../telegram-direct.outcome';
import {
  buildTelegramDirectUndeliveredRecord,
  TELEGRAM_DIRECT_UNDELIVERED_RECORDER,
  type UndeliveredRecorder,
} from '../undelivered-record';
import { TelegramDirectClient } from './telegram-direct.client';

/**
 * TelegramDirectQueueService
 * ══════════════════════════
 * Producer half of panel-owned Telegram delivery, deliberately built to the
 * same contract as `ReiwaRelayQueueService`: never throws, answers "the card is
 * in hand" (queued, or delivered by the fallback) rather than "accepted by
 * Redis", and degrades to one direct attempt when Redis will not take the job.
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
    /**
     * Writes `telegram.direct_undelivered` for a card the direct fallback could
     * not send — the record the processor writes. A token, not
     * `SystemEventsService`: see `undelivered-record.ts`.
     */
    @Inject(TELEGRAM_DIRECT_UNDELIVERED_RECORDER)
    private readonly recordUndelivered: UndeliveredRecorder,
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
   *
   * `true` means the card is in hand: queued (an add that timed out and
   * landed after all included), or refused by Redis and then sent by the one
   * direct attempt. `false` means it was not sent, and that is recorded as
   * `telegram.direct_undelivered`.
   */
  public async enqueue(
    data: TelegramDirectJobData,
    eventId: string | null = null,
  ): Promise<boolean> {
    // Kept past the add: a timed-out add is looked up by it (`sendWithoutQueue`).
    // Built inside the `try`, so a bad scope takes the fallback like any refusal.
    let jobId: string | null = null;
    try {
      jobId = toOptionalBullMqJobId(TELEGRAM_DIRECT_JOB, eventId);
      const customId = jobId;
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
          // Digested: a system card's key is `sysevt:<type>:<ISO time>:…`, and
          // BullMQ refused every one of them raw ("Custom Id cannot contain :"),
          // so every operator card went out on the one-attempt fallback. See
          // `toBullMqJobId`, and the relay producer for why the keys that did
          // pass move to the same shape.
          ...(customId !== null ? { jobId: customId } : {}),
        }),
      );
      return true;
    } catch (err: unknown) {
      return this.sendWithoutQueue(data, err, jobId);
    }
  }

  /**
   * Redis unreachable or slow, or the job refused. One direct attempt keeps
   * the floor at what this path did before it was durable at all, rather than
   * turning a Redis blip into a silently dropped operator card — and a card
   * that attempt cannot send is recorded as the processor records one, instead
   * of vanishing into a log line.
   *
   * Still ONE attempt, with no wait for a flood-wait's `retry_after`: this
   * runs inline in the caller, and holding a fanout for minutes is worse than
   * the recorded miss.
   *
   * When the add only TIMED OUT, the job may still land, and the Bot API has no
   * idempotency key to save the operator from two identical cards. So, for a
   * keyed job (`bullmq-late-enqueue.ts`): a job that is already there is not
   * sent again here; a card this attempt did send has its job withdrawn; and a
   * card this attempt could not send is not recorded as lost when its job
   * landed meanwhile — the job's own attempts own it.
   */
  private async sendWithoutQueue(
    data: TelegramDirectJobData,
    err: unknown,
    jobId: string | null,
  ): Promise<boolean> {
    const enqueueError = err instanceof Error ? err.message : String(err);
    const landed = jobId === null ? null : lateEnqueueOf(err);
    if (jobId !== null && landed !== null && (await probeLateJob(this.queue, jobId)) === 'landed') {
      this.logger.warn(
        `Telegram enqueue for ${data.sourceEventType} timed out, but the job landed; not sent directly`,
      );
      return true;
    }
    this.logger.warn(
      `Telegram enqueue failed for ${data.sourceEventType} (${enqueueError}); ` +
        'falling back to one direct attempt',
    );
    const outcome = await this.client.send(data).catch(
      // `send` answers with a status for everything it anticipates; the token
      // read in front of it can still throw (a database error). The message is
      // not repeated — `describeFetchFailure` explains why a Telegram-side
      // error message is not something to print.
      (thrown: unknown): TelegramDirectResult => ({
        status: 'failed',
        httpStatus: null,
        detail: thrown instanceof Error ? thrown.name : 'unknown',
        retryAfterSeconds: null,
        migrateToChatId: null,
      }),
    );
    this.logger.warn(`Telegram direct fallback for ${data.sourceEventType}: ${outcome.status}`);
    if (outcome.status === 'sent') {
      if (jobId !== null && landed !== null) {
        await withdrawLateJob(this.queue, jobId, landed, (message) => this.logger.warn(message));
      }
      return true;
    }
    if (jobId !== null && landed !== null && (await probeLateJob(this.queue, jobId)) === 'landed') {
      this.logger.warn(
        `Telegram direct fallback for ${data.sourceEventType}: ${outcome.status}, but the ` +
          'timed-out job landed meanwhile and owns the card; not recorded as undelivered',
      );
      return true;
    }
    try {
      await this.recordUndelivered(
        buildTelegramDirectUndeliveredRecord({
          data,
          outcome,
          attemptsMade: 1,
          attempts: 1,
          enqueueError,
        }),
      );
    } catch (recordErr: unknown) {
      this.logger.warn(
        `Could not record the undelivered card for ${data.sourceEventType}: ${
          recordErr instanceof Error ? recordErr.message : String(recordErr)
        }`,
      );
    }
    return false;
  }
}
