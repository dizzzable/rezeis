import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { runBullMqEnqueueWithTimeout } from '../../../common/queue/bullmq-enqueue-options';
import {
  BROADCAST_BATCH_SIZE,
  BROADCAST_BLOCKED_REASON,
  BROADCAST_DELIVERY_QUEUE,
  BROADCAST_JOBS,
} from '../broadcast.constants';

// ── Job Data Interfaces ─────────────────────────────────────────────────────

/**
 * The one start job a broadcast may have queued at a time.
 *
 * Exported so the producer and the two lookups cannot drift apart — they
 * did, and both lookups spent a release finding nothing.
 */
export const startJobId = (broadcastId: string): string => `broadcast-start:${broadcastId}`;

export interface BroadcastStartJobData {
  readonly broadcastId: string;
  /** The admin who pressed send; `null` when the reconciler put it back. */
  readonly adminId: string | null;
}

export interface BroadcastBatchJobData {
  readonly broadcastId: string;
  readonly messageIds: string[];
}

export interface BroadcastEditJobData {
  readonly broadcastId: string;
  readonly newText: string;
  readonly parseMode: string | null;
  readonly messageIds: string[];
}

export interface BroadcastDeleteJobData {
  readonly broadcastId: string;
  readonly messageIds: string[];
}

export interface BroadcastRetryJobData {
  readonly broadcastId: string;
  readonly messageIds: string[];
}

/**
 * A fan-out that failed partway, carrying the number of batches that DID reach
 * the queue and are now running.
 */
export class PartialEnqueueError extends Error {
  public constructor(
    jobName: string,
    public readonly batchesEnqueued: number,
    public readonly cause: unknown,
  ) {
    super(
      `Enqueue of ${jobName} failed after ${batchesEnqueued} batch(es): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = 'PartialEnqueueError';
  }
}

// ── Service ─────────────────────────────────────────────────────────────────

/**
 * Producer service — enqueues broadcast jobs into BullMQ.
 *
 * All operations return immediately (fire-and-forget from the API perspective).
 * The BroadcastProcessor picks up jobs and executes them with retry/backoff.
 */
@Injectable()
export class BroadcastQueueService {
  private readonly logger = new Logger(BroadcastQueueService.name);

  public constructor(
    @InjectQueue(BROADCAST_DELIVERY_QUEUE)
    private readonly queue: Queue,
    private readonly prismaService: PrismaService,
  ) {}

  // ── Send ────────────────────────────────────────────────────────────────

  /**
   * Enqueue the initial "start" job. Supports optional delay for scheduled sends.
   */
  public async enqueueStart(
    data: BroadcastStartJobData,
    options?: { delayMs?: number },
  ): Promise<string> {
    // ── ONE START JOB PER BROADCAST, addressable by name ──────────────────
    //
    // `dropPendingStart` and `hasPendingStart` both look the job up by this
    // exact id. Without it BullMQ assigns a number, both helpers find nothing
    // for every broadcast that ever existed, and two things break silently:
    // rescheduling never removes the earlier job (so the old time still fires
    // and the operator's correction is discarded), and the reconciler's "is a
    // job already pending" guard is always false, so it piles a second start
    // job onto a broadcast that is running perfectly well.
    //
    // A FINISHED job keeps its id for as long as it is retained (a day, per
    // `removeOnComplete` below), and BullMQ refuses to add a second job under
    // an id it still holds — it hands the old one back instead. That would
    // make the reconciler's re-enqueue a silent no-op on exactly the
    // broadcasts it exists to rescue, since their start job has already
    // completed. So the slot is cleared first. `dropPendingStart` declines to
    // remove an ACTIVE job and answers `false`; the add below then returns the
    // running job, which is the right outcome — one is already under way.
    await this.dropPendingStart(data.broadcastId);
    const job = await this.queue.add(BROADCAST_JOBS.START, data, {
      jobId: startJobId(data.broadcastId),
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 604_800 },
      delay: options?.delayMs,
    });
    this.logger.log(
      `Enqueued broadcast start: broadcastId=${data.broadcastId} jobId=${job.id}` +
        (options?.delayMs ? ` delay=${options.delayMs}ms` : ''),
    );
    return job.id ?? data.broadcastId;
  }

  /**
   * Enqueue a batch delivery job. Called by the processor after staging.
   *
   * Wrapped in the shared enqueue timeout like every other producer in this
   * repository (relay, telegram-direct, automations). It was the one that was
   * not, and an unbounded `queue.add` here is the likeliest way the start job's
   * fan-out loop ever died halfway — which used to lose every batch it had not
   * reached. The loop resumes now, but a hang that outlives the stall timeout
   * is still worth failing fast on.
   */
  public async enqueueBatch(data: BroadcastBatchJobData): Promise<void> {
    await runBullMqEnqueueWithTimeout(() =>
      this.queue.add(BROADCAST_JOBS.DELIVER_BATCH, data, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { age: 86_400 },
        removeOnFail: { age: 604_800 },
      }),
    );
  }

  // ── Edit ────────────────────────────────────────────────────────────────

  /** Enqueue edit jobs for already-sent messages. Returns batch count. */
  public async enqueueEdit(data: {
    broadcastId: string;
    newText: string;
    parseMode: string | null;
    messageIds: string[];
  }): Promise<number> {
    return this.enqueueBatched<BroadcastEditJobData>(
      BROADCAST_JOBS.EDIT_BATCH,
      data.messageIds,
      (batch) => ({
        broadcastId: data.broadcastId,
        newText: data.newText,
        parseMode: data.parseMode,
        messageIds: batch,
      }),
    );
  }

  // ── Delete ──────────────────────────────────────────────────────────────

  /** Enqueue delete jobs for already-sent messages. Returns batch count. */
  public async enqueueDelete(data: {
    broadcastId: string;
    messageIds: string[];
  }): Promise<number> {
    return this.enqueueBatched<BroadcastDeleteJobData>(
      BROADCAST_JOBS.DELETE_BATCH,
      data.messageIds,
      (batch) => ({
        broadcastId: data.broadcastId,
        messageIds: batch,
      }),
    );
  }

  // ── Retry ───────────────────────────────────────────────────────────────

  /** Enqueue retry jobs for failed messages. Returns batch count. */
  public async enqueueRetry(data: {
    broadcastId: string;
    messageIds: string[];
  }): Promise<number> {
    return this.enqueueBatched<BroadcastRetryJobData>(
      BROADCAST_JOBS.RETRY_FAILED,
      data.messageIds,
      (batch) => ({
        broadcastId: data.broadcastId,
        messageIds: batch,
      }),
    );
  }

  // ── Cancel ──────────────────────────────────────────────────────────────

  /**
   * Cancel all pending jobs for a broadcast.
   * Removes waiting/delayed jobs from the queue and marks pending messages as CANCELED.
   */
  /**
   * Removes the pending start job for this broadcast, if there is one.
   *
   * Addressed by id rather than found by scanning: the id is deterministic, and
   * a scan of `waiting`/`delayed` is O(queue) on a queue that also carries every
   * batch job. Returns whether anything was removed.
   */
  public async dropPendingStart(broadcastId: string): Promise<boolean> {
    const job = await this.queue.getJob(startJobId(broadcastId));
    if (job === undefined) return false;
    try {
      await job.remove();
      return true;
    } catch {
      // Already active or already gone — either way there is nothing pending
      // left to drop, and a reschedule on top of a job that is already running
      // is refused by the status check in the caller.
      return false;
    }
  }

  /**
   * Remove every batch job for this broadcast that has not started yet.
   *
   * ── Why a resume has to do this ───────────────────────────────────────────
   *
   * `stageRecipients` resumes by handing back every recipient still PENDING,
   * and the caller re-batches all of them from scratch. The batches from the
   * interrupted attempt are still sitting in Redis, so without this the same
   * recipient is in two queued jobs. Both read the row as PENDING and both
   * send: a media broadcast delivers the photo TWICE (a direct Bot API call has
   * no idempotency of any kind), and a text one has its second attempt
   * deduplicated by the bot into an `unconfirmed` — which is not retryable, so
   * it overwrites the SENT row the first attempt just wrote with FAILED.
   *
   * ACTIVE jobs cannot be removed and are not attempted; their recipients are
   * being written right now, and the fresh batch re-reads status per row.
   */
  public async dropPendingBatches(broadcastId: string): Promise<number> {
    const queued = await this.queue.getJobs(['waiting', 'delayed']);
    let removed = 0;
    for (const job of queued) {
      // RETRY_FAILED counts too: it delivers to the same rows through the same
      // path, so a start job resuming over a running retry would double every
      // recipient the retry had queued.
      if (
        job.name !== BROADCAST_JOBS.DELIVER_BATCH &&
        job.name !== BROADCAST_JOBS.RETRY_FAILED
      ) {
        continue;
      }
      if (job.data?.broadcastId !== broadcastId) continue;
      try {
        await job.remove();
        removed++;
      } catch {
        // Promoted to active between the scan and the remove — its recipients
        // are being settled now, which the fresh batch will see.
      }
    }
    if (removed > 0) {
      this.logger.warn(`Dropped ${removed} superseded batch job(s) for broadcast ${broadcastId}`);
    }
    return removed;
  }

  /** Whether a start job for this broadcast is still queued or delayed. */
  public async hasPendingStart(broadcastId: string): Promise<boolean> {
    const job = await this.queue.getJob(startJobId(broadcastId));
    if (job === undefined) return false;
    const state = await job.getState();
    return state === 'waiting' || state === 'delayed' || state === 'active';
  }

  public async cancelBroadcast(broadcastId: string): Promise<number> {
    // The start job first, by its deterministic id.
    let removed = (await this.dropPendingStart(broadcastId)) ? 1 : 0;
    // Then any batch jobs, which have no such id and must still be scanned.
    const waiting = await this.queue.getJobs(['waiting', 'delayed']);
    for (const job of waiting) {
      if (job.data?.broadcastId === broadcastId) {
        await job.remove();
        removed++;
      }
    }

    // Mark remaining PENDING messages as CANCELED
    const { count } = await this.prismaService.broadcastMessage.updateMany({
      where: { broadcastId, status: 'PENDING' },
      data: { status: 'CANCELED' },
    });

    this.logger.log(
      `Canceled broadcast ${broadcastId}: ${removed} jobs removed, ${count} messages canceled`,
    );
    return count;
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  /** Get IDs of all successfully sent messages (with telegramMessageId). */
  public async getSentMessageIds(broadcastId: string): Promise<string[]> {
    const messages = await this.prismaService.broadcastMessage.findMany({
      where: {
        broadcastId,
        status: 'SENT',
        telegramMessageId: { not: null },
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    return messages.map((m) => m.id);
  }

  /**
   * Messages a retry could actually change — failures EXCEPT blocked bots.
   *
   * A recipient who has blocked the bot cannot receive this broadcast, and the
   * relay deduplicates the retry by the same event id anyway, so including them
   * made "retry failed" a button whose count never moved. They keep their own
   * reason and their own number on screen; this list is what pressing the
   * button can still fix.
   */
  public async getFailedMessageIds(broadcastId: string): Promise<string[]> {
    const messages = await this.prismaService.broadcastMessage.findMany({
      where: {
        broadcastId,
        status: 'FAILED',
        NOT: { errorMessage: BROADCAST_BLOCKED_REASON },
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    return messages.map((m) => m.id);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private async enqueueBatched<T>(
    jobName: string,
    messageIds: string[],
    buildData: (batch: string[]) => T,
  ): Promise<number> {
    let batchCount = 0;
    try {
      for (let i = 0; i < messageIds.length; i += BROADCAST_BATCH_SIZE) {
        const batch = messageIds.slice(i, i + BROADCAST_BATCH_SIZE);
        await this.queue.add(jobName, buildData(batch), {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: { age: 86_400 },
          removeOnFail: { age: 604_800 },
        });
        batchCount++;
      }
    } catch (err: unknown) {
      // ── HOW FAR IT GOT MATTERS TO THE CALLER ─────────────────────────────
      //
      // This is a LOOP of `queue.add` calls, so a Redis blip on batch 3 of 8
      // leaves batches 1-2 queued and about to run. A caller that reads the
      // throw as "nothing was enqueued" and rolls the broadcast's status back
      // is then wrong: those batches flip rows to PENDING and re-deliver
      // against a broadcast the panel says has finished.
      throw new PartialEnqueueError(jobName, batchCount, err);
    }
    this.logger.log(`Enqueued ${batchCount} ${jobName} batches`);
    return batchCount;
  }
}
