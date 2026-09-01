import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { runBullMqEnqueueWithTimeout } from '../../../common/queue/bullmq-enqueue-options';
import {
  BROADCAST_BATCH_SIZE,
  BROADCAST_DELIVERY_QUEUE,
  BROADCAST_JOBS,
} from '../broadcast.constants';

// ── Job Data Interfaces ─────────────────────────────────────────────────────

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
    const job = await this.queue.add(BROADCAST_JOBS.START, data, {
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
    const job = await this.queue.getJob(`broadcast-start:${broadcastId}`);
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

  /** Whether a start job for this broadcast is still queued or delayed. */
  public async hasPendingStart(broadcastId: string): Promise<boolean> {
    const job = await this.queue.getJob(`broadcast-start:${broadcastId}`);
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

  /** Get IDs of all failed messages (for retry). */
  public async getFailedMessageIds(broadcastId: string): Promise<string[]> {
    const messages = await this.prismaService.broadcastMessage.findMany({
      where: { broadcastId, status: 'FAILED' },
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
    this.logger.log(`Enqueued ${batchCount} ${jobName} batches`);
    return batchCount;
  }
}
