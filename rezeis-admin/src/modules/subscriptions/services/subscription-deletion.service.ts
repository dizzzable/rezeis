import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';

export interface SubscriptionDeleteInput {
  readonly userId?: string;
  readonly telegramId?: string;
  readonly subscriptionId: string;
}

export interface SubscriptionDeleteResult {
  readonly deleted: true;
}

/**
 * SubscriptionDeletionService
 * ───────────────────────────
 * Self-service subscription deletion. The user chose to delete, so deletion is
 * final and no refund is issued (digital goods, no-refund policy).
 *
 * Flow:
 *   1. Resolve the canonical user from `userId` (reiwa_id) or `telegramId`.
 *   2. Ownership-check the target subscription (must belong to that user).
 *   3. Already DELETED → idempotent no-op.
 *   4. In one transaction: enqueue a Remnawave revocation job
 *      (`ProfileSyncJob` with `SyncAction.DELETE`) and flip the subscription to
 *      `DELETED`. The job is then pushed to BullMQ. The revocation job reads
 *      `subscription.remnawaveId` (left intact), so revoking after the status
 *      flip is safe — there is never a `DELETED` row with a live profile that
 *      isn't already queued for removal.
 */
@Injectable()
export class SubscriptionDeletionService {
  private readonly logger = new Logger(SubscriptionDeletionService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly profileSyncQueueService: ProfileSyncQueueService,
  ) {}

  public async delete(input: SubscriptionDeleteInput): Promise<SubscriptionDeleteResult> {
    const userId = await this.resolveUserId(input);

    const subscription = await this.prismaService.subscription.findUnique({
      where: { id: input.subscriptionId },
      select: { id: true, userId: true, status: true, remnawaveId: true },
    });
    // Ownership check: unknown id or foreign owner → 404 (no existence leak).
    if (subscription === null || subscription.userId !== userId) {
      throw new NotFoundException('Subscription not found');
    }
    // Idempotent: deleting an already-deleted subscription is a no-op.
    if (subscription.status === SubscriptionStatus.DELETED) {
      return { deleted: true };
    }

    const syncJobId = await this.prismaService.$transaction(async (tx) => {
      // Only schedule Remnawave revocation when a profile actually exists.
      let createdJobId: string | null = null;
      if (subscription.remnawaveId !== null) {
        const job = await tx.profileSyncJob.create({
          data: {
            subscriptionId: subscription.id,
            action: SyncAction.DELETE,
            status: SyncJobStatus.PENDING,
            payload: { source: 'SELF_SERVICE_DELETE' } as Prisma.InputJsonObject,
          },
          select: { id: true },
        });
        createdJobId = job.id;
      }
      await tx.subscription.update({
        where: { id: subscription.id },
        data: { status: SubscriptionStatus.DELETED },
      });
      return createdJobId;
    });

    if (syncJobId !== null) {
      await this.profileSyncQueueService.enqueue(syncJobId);
    }

    this.logger.log(`Subscription ${subscription.id} deleted by owner ${userId}`);
    return { deleted: true };
  }

  private async resolveUserId(input: SubscriptionDeleteInput): Promise<string> {
    if (typeof input.userId === 'string' && input.userId.length > 0) {
      return input.userId;
    }
    if (typeof input.telegramId === 'string' && input.telegramId.length > 0) {
      const user = await this.prismaService.user.findFirst({
        where: { telegramId: BigInt(input.telegramId) },
        select: { id: true },
      });
      if (user === null) {
        throw new NotFoundException('User not found');
      }
      return user.id;
    }
    throw new NotFoundException('A userId or telegramId is required');
  }
}
