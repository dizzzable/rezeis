import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma, SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../common/runtime/process-role.util';
import { EVENT_TYPES, SystemEventsService } from '../../common/services/system-events.service';
import { ProfileSyncQueueService } from './profile-sync-queue.service';

/** Max subscriptions cleaned per sweep — bounds the load on the panel. */
const CLEANUP_BATCH = 100;

/**
 * ExpiredProfileCleanupService
 * ────────────────────────────
 * Worker-only cron that removes the Remnawave **panel profile** for expired
 * subscriptions while keeping the local `Subscription` row intact.
 *
 * Why detach but keep the row:
 *   Trial accounting (`grantTrial` / trial eligibility) counts `isTrial`
 *   subscriptions with **no status filter**, plus `TrialGrant` and paid-trial
 *   `Transaction` rows. Those must survive so a user can never re-claim a free
 *   trial or exceed a paid-trial limit just because their old profile expired
 *   and was cleaned off the panel. We therefore only delete the upstream panel
 *   profile (frees panel space + declutters the operator UI) and null the
 *   local `remnawaveId`; the row — incl. `isTrial`, `status`, `planSnapshot` —
 *   is retained as the durable trial-usage ledger.
 *
 * The sweep is a thin selector: it finds expired, profile-bearing
 * subscriptions that don't already have a pending/in-flight `DELETE` job and
 * enqueues the existing `ProfileSyncJob(DELETE)` for each. The actual panel
 * call + local detach happen in `ProfileSyncProcessor.handleDelete`.
 *
 * See `.kiro/specs/trial-aware-profile-cleanup`.
 */
@Injectable()
export class ExpiredProfileCleanupService {
  private readonly logger = new Logger(ExpiredProfileCleanupService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly profileSyncQueueService: ProfileSyncQueueService,
    private readonly events: SystemEventsService,
  ) {}

  @Cron(CronExpression.EVERY_30_MINUTES, { name: 'expired-profile-cleanup' })
  public async sweepExpiredProfiles(): Promise<void> {
    if (!shouldRunSchedules()) return;
    await this.runSweep();
  }

  /**
   * Selects up to `CLEANUP_BATCH` expired, profile-bearing subscriptions with
   * no pending/in-flight `DELETE` job and enqueues a `DELETE` job for each.
   * Returns the number of subscriptions enqueued (exposed for tests).
   */
  public async runSweep(): Promise<number> {
    const now = new Date();
    const candidates = await this.prismaService.subscription.findMany({
      where: {
        remnawaveId: { not: null },
        OR: [
          { status: SubscriptionStatus.EXPIRED },
          { expiresAt: { not: null, lt: now } },
        ],
        // Skip subscriptions that already have a DELETE job in flight so the
        // sweep is idempotent across overlapping runs.
        syncJobs: {
          none: {
            action: SyncAction.DELETE,
            status: { in: [SyncJobStatus.PENDING, SyncJobStatus.RUNNING] },
          },
        },
      },
      select: { id: true, userId: true, isTrial: true },
      take: CLEANUP_BATCH,
      orderBy: { expiresAt: 'asc' },
    });

    if (candidates.length === 0) return 0;

    let enqueued = 0;
    for (const subscription of candidates) {
      try {
        const job = await this.prismaService.profileSyncJob.create({
          data: {
            subscriptionId: subscription.id,
            action: SyncAction.DELETE,
            status: SyncJobStatus.PENDING,
            payload: { source: 'EXPIRED_PROFILE_CLEANUP' } as Prisma.InputJsonObject,
          },
          select: { id: true },
        });
        await this.profileSyncQueueService.enqueue(job.id);
        enqueued += 1;
        this.events.info(
          EVENT_TYPES.SUBSCRIPTION_DELETED,
          'SUBSCRIPTION',
          'Expired profile cleanup scheduled',
          {
            subscriptionId: subscription.id,
            userId: subscription.userId,
            isTrial: subscription.isTrial,
            source: 'EXPIRED_PROFILE_CLEANUP',
          },
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        this.logger.warn(
          `Failed to schedule cleanup for subscription ${subscription.id}: ${message}`,
        );
      }
    }

    if (enqueued > 0) {
      this.logger.log(`Expired-profile cleanup: scheduled ${enqueued} profile deletion(s)`);
    }
    return enqueued;
  }
}
