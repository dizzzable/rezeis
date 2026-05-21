import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';

interface ToggleStatusInput {
  readonly subscriptionId: string;
  readonly targetStatus: 'ACTIVE' | 'DISABLED';
}

interface ExtendSubscriptionInput {
  readonly subscriptionId: string;
  readonly additionalDays: number;
}

interface GrantTrialInput {
  readonly userId: string;
  readonly planId: string;
  readonly durationDays: number;
}

/**
 * Admin-side subscription mutations. These are operator actions that bypass
 * the payment pipeline — they directly mutate subscription state and
 * optionally enqueue a profile sync job for Remnawave reconciliation.
 *
 * Donor parity: altshop `subscription_core.py` + admin bot dashboard actions.
 */
@Injectable()
export class SubscriptionMutationsService {
  private readonly logger = new Logger(SubscriptionMutationsService.name);

  public constructor(private readonly prismaService: PrismaService) {}

  /**
   * Toggles a subscription between ACTIVE and DISABLED. Donor parity:
   * the admin bot dashboard has explicit enable/disable buttons.
   */
  public async toggleStatus(input: ToggleStatusInput): Promise<{ readonly id: string; readonly status: SubscriptionStatus }> {
    const subscription = await this.prismaService.subscription.findUnique({
      where: { id: input.subscriptionId },
      select: { id: true, status: true },
    });
    if (subscription === null) {
      throw new NotFoundException('Subscription not found');
    }
    if (subscription.status === SubscriptionStatus.DELETED) {
      throw new BadRequestException('Cannot toggle a deleted subscription');
    }
    const nextStatus =
      input.targetStatus === 'ACTIVE'
        ? SubscriptionStatus.ACTIVE
        : SubscriptionStatus.DISABLED;
    if (subscription.status === nextStatus) {
      return { id: subscription.id, status: subscription.status };
    }
    const updated = await this.prismaService.subscription.update({
      where: { id: input.subscriptionId },
      data: { status: nextStatus },
      select: { id: true, status: true },
    });
    this.logger.log(
      `Subscription ${input.subscriptionId} status toggled to ${nextStatus}`,
    );
    return updated;
  }

  /**
   * Extends a subscription's expiry by the given number of days. If the
   * subscription has no current `expiresAt` (unlimited), this is a no-op.
   */
  public async extend(input: ExtendSubscriptionInput): Promise<{ readonly id: string; readonly expiresAt: Date | null }> {
    if (input.additionalDays <= 0) {
      throw new BadRequestException('additionalDays must be positive');
    }
    const subscription = await this.prismaService.subscription.findUnique({
      where: { id: input.subscriptionId },
      select: { id: true, expiresAt: true, status: true },
    });
    if (subscription === null) {
      throw new NotFoundException('Subscription not found');
    }
    if (subscription.status === SubscriptionStatus.DELETED) {
      throw new BadRequestException('Cannot extend a deleted subscription');
    }
    if (subscription.expiresAt === null) {
      // Unlimited subscription — nothing to extend.
      return { id: subscription.id, expiresAt: null };
    }
    const baseDate =
      subscription.expiresAt.getTime() > Date.now()
        ? subscription.expiresAt
        : new Date();
    const nextExpiry = new Date(
      baseDate.getTime() + input.additionalDays * 24 * 60 * 60 * 1000,
    );
    const updated = await this.prismaService.subscription.update({
      where: { id: input.subscriptionId },
      data: { expiresAt: nextExpiry, status: SubscriptionStatus.ACTIVE },
      select: { id: true, expiresAt: true },
    });
    this.logger.log(
      `Subscription ${input.subscriptionId} extended by ${input.additionalDays}d → ${nextExpiry.toISOString()}`,
    );
    return updated;
  }

  /**
   * Grants a trial subscription to a user. Donor parity: altshop
   * `subscription_trial.py` — creates a local subscription record and
   * enqueues a profile sync job. The Remnawave profile is created
   * asynchronously by the sync worker.
   */
  public async grantTrial(input: GrantTrialInput): Promise<{ readonly subscriptionId: string }> {
    // Guard: user must not already have a trial grant
    const existingGrant = await this.prismaService.trialGrant.findUnique({
      where: { userId: input.userId },
      select: { id: true },
    });
    if (existingGrant !== null) {
      throw new BadRequestException('User has already used a trial');
    }

    // Resolve plan for snapshot
    const plan = await this.prismaService.plan.findUnique({
      where: { id: input.planId },
      select: {
        id: true,
        name: true,
        type: true,
        trafficLimit: true,
        deviceLimit: true,
        trafficLimitStrategy: true,
        internalSquads: true,
        externalSquad: true,
        tag: true,
      },
    });
    if (plan === null) {
      throw new NotFoundException('Plan not found');
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.durationDays * 24 * 60 * 60 * 1000);

    const result = await this.prismaService.$transaction(async (tx) => {
      const subscription = await tx.subscription.create({
        data: {
          userId: input.userId,
          status: SubscriptionStatus.ACTIVE,
          isTrial: true,
          planSnapshot: plan as unknown as Prisma.InputJsonValue,
          trafficLimit: plan.trafficLimit,
          deviceLimit: plan.deviceLimit,
          internalSquads: plan.internalSquads,
          externalSquad: plan.externalSquad,
          startedAt: now,
          expiresAt,
        },
      });
      await tx.trialGrant.create({
        data: {
          userId: input.userId,
          planId: input.planId,
        },
      });
      // Enqueue profile sync job so the worker creates the Remnawave profile
      await tx.profileSyncJob.create({
        data: {
          subscriptionId: subscription.id,
          action: 'CREATE',
          status: 'PENDING',
          payload: { source: 'TRIAL_GRANT' },
        },
      });
      return subscription;
    });

    this.logger.log(
      `Trial granted to user ${input.userId}: subscription ${result.id}, plan ${plan.name}, ${input.durationDays}d`,
    );
    return { subscriptionId: result.id };
  }
}
