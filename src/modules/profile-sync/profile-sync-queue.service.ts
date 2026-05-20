import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

import { PrismaService } from '../../common/prisma/prisma.service';
import {
  PROFILE_SYNC_BACKOFF_MS,
  PROFILE_SYNC_JOB,
  PROFILE_SYNC_MAX_ATTEMPTS,
  PROFILE_SYNC_QUEUE,
} from './profile-sync.constants';

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
   */
  public async enqueue(syncJobId: string): Promise<void> {
    await this.queue.add(
      PROFILE_SYNC_JOB,
      { syncJobId },
      {
        jobId: `sync_${syncJobId}`,
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
      where: { status: 'PENDING' },
      select: { id: true },
      take: 100,
      orderBy: { createdAt: 'asc' },
    });
    for (const job of pendingJobs) {
      await this.enqueue(job.id);
    }
    return pendingJobs.length;
  }
}
