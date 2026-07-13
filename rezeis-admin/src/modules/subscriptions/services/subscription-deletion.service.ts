import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  DeviceReductionPlanState,
  EffectiveProjectionState,
  Prisma,
  SubscriptionStatus,
  SyncAction,
  SyncJobStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { AddOnEntitlementService } from '../../add-on-entitlements/services/add-on-entitlement.service';
import { SubscriptionTermService } from '../../add-on-entitlements/services/subscription-term.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';

export interface SubscriptionDeleteInput {
  readonly userId?: string;
  readonly telegramId?: string;
  readonly subscriptionId: string;
}

export interface SubscriptionDeleteResult {
  readonly deleted: true;
}

export interface OperatorSubscriptionDeleteResult extends SubscriptionDeleteResult {
  readonly userId: string;
  readonly hadRemnawaveProfile: boolean;
}

type DeletableSubscription = {
  readonly id: string;
  readonly userId: string;
  readonly status: SubscriptionStatus;
  readonly remnawaveId: string | null;
  readonly expiresAt: Date | null;
};

export interface ExpiredSubscriptionDeleteInput {
  readonly subscriptionId: string;
  readonly expectedExpiresAt: Date;
  readonly expectedRemnawaveId: string | null;
  readonly cutoff: Date;
}

export interface ExpiredSubscriptionDeleteResult {
  readonly deleted: boolean;
  readonly syncJobId: string | null;
}

interface LifecycleDeleteOptions {
  readonly source: 'SELF_SERVICE_DELETE' | 'ADMIN_PANEL' | 'EXPIRED_PROFILE_CLEANUP';
  readonly correlationId: string;
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
 *   4. In one transaction: close commercial lifecycle, supersede narrower
 *      projection/device/sync work, enqueue a Remnawave revocation job
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
    private readonly addOnEntitlementService: AddOnEntitlementService,
    private readonly subscriptionTermService: SubscriptionTermService,
  ) {}

  public async delete(input: SubscriptionDeleteInput): Promise<SubscriptionDeleteResult> {
    const userId = await this.resolveUserId(input);
    const subscription = await this.findSubscription(input.subscriptionId);

    // Ownership check: unknown id or foreign owner → 404 (no existence leak).
    if (subscription.userId !== userId) {
      throw new NotFoundException('Subscription not found');
    }
    await this.deleteSubscription(subscription, {
      source: 'SELF_SERVICE_DELETE',
      correlationId: `subscription-delete:${subscription.id}`,
    });

    this.logger.log(`Subscription ${subscription.id} deleted by owner ${userId}`);
    return { deleted: true };
  }

  public async deleteByOperator(subscriptionId: string): Promise<OperatorSubscriptionDeleteResult> {
    const subscription = await this.findSubscription(subscriptionId);
    await this.deleteSubscription(subscription, {
      source: 'ADMIN_PANEL',
      correlationId: `subscription-delete:${subscription.id}`,
    });
    return {
      deleted: true,
      userId: subscription.userId,
      hadRemnawaveProfile: subscription.remnawaveId !== null,
    };
  }

  private async findSubscription(subscriptionId: string): Promise<DeletableSubscription> {
    const subscription = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      select: { id: true, userId: true, status: true, remnawaveId: true, expiresAt: true },
    });
    if (subscription === null) {
      throw new NotFoundException('Subscription not found');
    }
    return subscription;
  }

  public async deleteExpiredIfUnchanged(
    input: ExpiredSubscriptionDeleteInput,
  ): Promise<ExpiredSubscriptionDeleteResult> {
    const subscription: DeletableSubscription = {
      id: input.subscriptionId,
      userId: '',
      status: SubscriptionStatus.EXPIRED,
      remnawaveId: input.expectedRemnawaveId,
      expiresAt: input.expectedExpiresAt,
    };
    const syncJobId = await this.deleteSubscription(subscription, {
      source: 'EXPIRED_PROFILE_CLEANUP',
      correlationId: `expired-profile-cleanup:${input.subscriptionId}:${input.expectedExpiresAt.toISOString()}`,
    }, input);
    return { deleted: syncJobId !== undefined, syncJobId: syncJobId ?? null };
  }

  private async deleteSubscription(
    subscription: DeletableSubscription,
    options: LifecycleDeleteOptions,
    expiryGuard?: ExpiredSubscriptionDeleteInput,
  ): Promise<string | null | undefined> {
    // Idempotent: deleting an already-deleted subscription is a no-op.
    if (subscription.status === SubscriptionStatus.DELETED) {
      return;
    }

    const syncJobId = await this.prismaService.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<DeletableSubscription[]>(Prisma.sql`
        SELECT
          "id",
          "user_id" AS "userId",
          "status"::text AS "status",
          "remnawave_id" AS "remnawaveId",
          "expires_at" AS "expiresAt"
        FROM "subscriptions"
        WHERE "id" = ${subscription.id}
        FOR UPDATE
      `);
      const current = locked[0];
      if (current === undefined) {
        throw new NotFoundException('Subscription not found');
      }
      if (current.status === SubscriptionStatus.DELETED) {
        return null;
      }
      if (
        expiryGuard !== undefined &&
        (
          current.expiresAt === null ||
          current.expiresAt.getTime() !== expiryGuard.expectedExpiresAt.getTime() ||
          current.expiresAt.getTime() >= expiryGuard.cutoff.getTime() ||
          current.remnawaveId !== expiryGuard.expectedRemnawaveId
        )
      ) {
        return undefined;
      }
      await this.addOnEntitlementService.terminateForSubscriptionDeletion(tx, {
        subscriptionId: subscription.id,
        correlationId: options.correlationId,
        reason: 'SUBSCRIPTION_DELETED',
      });
      await this.subscriptionTermService.closeForSubscriptionDeletion(tx, subscription.id);

      const supersededAt = new Date();
      await tx.subscriptionEffectiveProjection.updateMany({
        where: { subscriptionId: subscription.id },
        data: { state: EffectiveProjectionState.DELETED },
      });
      await tx.deviceReductionPlan.updateMany({
        where: {
          subscriptionId: subscription.id,
          state: {
            in: [
              DeviceReductionPlanState.PENDING,
              DeviceReductionPlanState.IN_PROGRESS,
              DeviceReductionPlanState.BLOCKED,
            ],
          },
        },
        data: {
          state: DeviceReductionPlanState.SUPERSEDED,
        },
      });
      await tx.profileSyncJob.updateMany({
        where: {
          subscriptionId: subscription.id,
          action: { not: SyncAction.DELETE },
          status: { in: [SyncJobStatus.PENDING, SyncJobStatus.RUNNING, SyncJobStatus.FAILED] },
          supersededAt: null,
        },
        data: { supersededAt },
      });

      let createdJobId: string | null = null;
      if (current.remnawaveId !== null) {
        const job = await tx.profileSyncJob.create({
          data: {
            subscriptionId: subscription.id,
            action: SyncAction.DELETE,
            status: SyncJobStatus.PENDING,
            payload: {
              source: options.source,
              targetRemnawaveId: current.remnawaveId,
            } as Prisma.InputJsonObject,
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

    if (syncJobId !== null && syncJobId !== undefined) {
      await this.profileSyncQueueService.enqueue(syncJobId);
    }
    return syncJobId;
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
