import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SyncJobStatus } from '@prisma/client';
import { Queue } from 'bullmq';

import { PrismaService } from '../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../common/runtime/process-role.util';
import {
  PROFILE_SYNC_BACKOFF_MS,
  PROFILE_SYNC_JOB,
  PROFILE_SYNC_MAX_ATTEMPTS,
  PROFILE_SYNC_QUEUE,
} from './profile-sync.constants';

/** Recover stuck CREATE jobs no more than this often (avoid hammering a down panel). */
const FAILED_RECOVERY_MAX = 50;

/** Max stale-RUNNING (dead-worker) jobs reclaimed per sweep. */
const STALE_RUNNING_RECOVERY_MAX = 50;

/**
 * A job that has been `RUNNING` longer than this almost certainly belongs to a
 * worker that died mid-flight (a live run finishes its Remnawave call + BullMQ
 * attempts well within this window). Its lease is considered expired and the
 * row is reclaimed to `PENDING`. Handlers are idempotent (CREATE reuses an
 * existing panel profile, UPDATE is an absolute write, DELETE re-checks
 * `isDeleted`), so a re-run cannot double-apply.
 */
const STALE_RUNNING_LEASE_MS = 15 * 60 * 1000;

/**
 * Legacy rows written before recovery classification existed are safe to retry
 * only during the explicitly enabled rollout. Keep this off by default: an
 * empty recoveryData object does not prove that the old failure was transient.
 */
function shouldRecoverLegacyFailedRows(): boolean {
  const value = process.env['PROFILE_SYNC_RECOVER_LEGACY_FAILED'];
  return value === 'true' || value === '1';
}

/**
 * Enqueues pending `ProfileSyncJob` rows into BullMQ so the processor can
 * pick them up. Called by:
 *  - `PaymentSubscriptionMutationService` after creating a subscription
 *  - `SubscriptionMutationsService.grantTrial()`
 *  - A scheduled cron that sweeps for stuck PENDING jobs
 */
@Injectable()
export class ProfileSyncQueueService {
  private readonly logger = new Logger(ProfileSyncQueueService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    @InjectQueue(PROFILE_SYNC_QUEUE)
    private readonly queue: Queue,
  ) {}

  /**
   * Enqueues a single sync job by id. Idempotent — BullMQ deduplicates by
   * jobId so the same row won't be processed twice concurrently.
   *
   * `force` removes any prior BullMQ job carrying the same `jobId` first.
   * This is required when re-driving a row that previously COMPLETED or
   * FAILED: because we keep finished jobs around (`removeOnComplete/Fail`),
   * a plain re-`add` with the same `jobId` is silently ignored by BullMQ.
   */
  public async enqueue(syncJobId: string, force = false): Promise<void> {
    const jobId = `sync_${syncJobId}`;
    if (force) {
      // Remove any retained finished/failed job with this id so the
      // re-add is not deduplicated away.
      await this.queue.remove(jobId).catch((): void => undefined);
    }
    await this.queue.add(
      PROFILE_SYNC_JOB,
      { syncJobId },
      {
        jobId,
        attempts: PROFILE_SYNC_MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: PROFILE_SYNC_BACKOFF_MS },
        removeOnComplete: 200,
        removeOnFail: 200,
      },
    );
    this.logger.debug(`Enqueued profile sync job ${syncJobId}`);
  }

  /**
   * Sweeps for PENDING sync jobs that haven't been picked up yet and
   * enqueues them. Designed to be called from a cron interval.
   */
  public async sweepPending(): Promise<number> {
    const pendingJobs = await this.prismaService.profileSyncJob.findMany({
      where: { status: 'PENDING', supersededAt: null },
      select: { id: true },
      take: 100,
      orderBy: { createdAt: 'asc' },
    });
    for (const job of pendingJobs) {
      await this.enqueue(job.id);
    }
    return pendingJobs.length;
  }

  /**
   * Self-healing sweep (runs in the worker process only).
   *
   * Two recovery passes guard against subscriptions that never get a
   * Remnawave profile because of a transient panel outage:
   *
   *  1. **PENDING** rows that were created but never enqueued (e.g. by code
   *     paths that only `profileSyncJob.create()` without calling `enqueue`,
   *     or after a producer crash between the two) are pushed to BullMQ.
   *  2. **FAILED rows** are reset to PENDING and re-enqueued, so CREATE,
   *     UPDATE, DELETE and TRAFFIC_RESET all recover after transient panel
   *     outages. Superseded rows are excluded and remain inert.

   * BullMQ deduplicates by `jobId` so re-enqueuing an in-flight row is safe.
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'profile-sync-sweep' })
  public async sweepAndRecover(): Promise<void> {
    if (!shouldRunSchedules()) return;

    try {
      const swept = await this.sweepPending();

      const failedRecoveryWhere = shouldRecoverLegacyFailedRows()
        ? {
            OR: [
              { recoveryData: { path: ['classification'], equals: 'TRANSIENT' } },
              { recoveryData: { equals: {} } },
            ],
          }
        : { recoveryData: { path: ['classification'], equals: 'TRANSIENT' } };
      const failedJobs = await this.prismaService.profileSyncJob.findMany({
        where: {
          status: SyncJobStatus.FAILED,
          supersededAt: null,
          ...failedRecoveryWhere,
        },
        select: { id: true },
        take: FAILED_RECOVERY_MAX,
        orderBy: { createdAt: 'asc' },
      });

      let recoveredFailedCount = 0;
      for (const job of failedJobs) {
        const recovered = await this.prismaService.profileSyncJob.updateMany({
          where: {
            id: job.id,
            status: SyncJobStatus.FAILED,
            supersededAt: null,
            ...failedRecoveryWhere,
          },
          data: { status: SyncJobStatus.PENDING, attempts: 0, lastError: null },
        });
        if (recovered.count === 1) {
          recoveredFailedCount += 1;
          await this.enqueue(job.id, /* force */ true);
        }
      }

      // 3. **Stale RUNNING** rows whose worker died mid-flight (lease expired)
      //    are reclaimed to PENDING and re-enqueued. Without this a crashed
      //    worker leaves the row RUNNING forever — the processor's claim only
      //    matches PENDING/FAILED, so it would never be retried.
      const cutoff = new Date(Date.now() - STALE_RUNNING_LEASE_MS);
      const staleRunning = await this.prismaService.profileSyncJob.findMany({
        where: {
          status: SyncJobStatus.RUNNING,
          supersededAt: null,
          startedAt: { lt: cutoff },
        },
        select: { id: true, startedAt: true },
        take: STALE_RUNNING_RECOVERY_MAX,
        orderBy: { startedAt: 'asc' },
      });
      for (const job of staleRunning) {
        // Guard on status=RUNNING so a worker that finished between the read
        // and now always wins (no reset of a just-completed row).
        const reclaimed = await this.prismaService.profileSyncJob.updateMany({
          where: {
            id: job.id,
            status: SyncJobStatus.RUNNING,
            supersededAt: null,
            startedAt: job.startedAt,
          },
          data: { status: SyncJobStatus.PENDING, lastError: null },
        });
        if (reclaimed.count === 1) {
          await this.enqueue(job.id, /* force */ true);
        }
      }

      if (swept > 0 || recoveredFailedCount > 0 || staleRunning.length > 0) {
        this.logger.log(
          `Profile-sync sweep: re-enqueued ${swept} pending + recovered ${recoveredFailedCount} failed + ${staleRunning.length} stale-running job(s)`,
        );
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`Profile-sync sweep failed: ${message}`);
    }
  }
}
