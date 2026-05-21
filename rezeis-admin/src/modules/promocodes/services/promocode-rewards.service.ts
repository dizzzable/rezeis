import { Injectable, Logger } from '@nestjs/common';
import { Prisma, PromocodeRewardType, SubscriptionStatus } from '@prisma/client';

import { PromocodeInterface } from '../interfaces/promocode.interface';

/**
 * Donor: `src/services/promocode_rewards.py`.
 *
 * The rewards service contains the pure mutation rules that turn an
 * activated promocode into concrete database changes. Each method works on
 * an already-opened Prisma transaction client so the caller (lifecycle
 * service) can wrap validation + activation + reward application into a
 * single atomic step. A failure here MUST roll back the activation row.
 *
 * The current first slice intentionally does NOT trigger Remnawave panel
 * synchronization. Donor parity for that orchestration moves into a
 * separate `ProfileSyncJob` row created elsewhere — keeping this service
 * deterministic and easy to reason about under transaction control.
 */
@Injectable()
export class PromocodeRewardsService {
  private readonly logger = new Logger(PromocodeRewardsService.name);

  /**
   * Applies the resolved reward to the matching aggregate. Returns `true`
   * when the reward was applied so the lifecycle service can finalize the
   * activation; returns `false` to signal a soft failure that should roll
   * back the activation. Hard errors are re-thrown.
   */
  public async applyReward(input: {
    readonly transactionClient: Prisma.TransactionClient;
    readonly promocode: PromocodeInterface;
    readonly userId: string;
    readonly targetSubscriptionId: string | null;
  }): Promise<{ readonly applied: boolean; readonly rewardValue: number }> {
    const { promocode } = input;
    const reward = promocode.reward ?? 0;

    switch (promocode.rewardType) {
      case PromocodeRewardType.PERSONAL_DISCOUNT:
        return this.applyDiscount({
          transactionClient: input.transactionClient,
          userId: input.userId,
          field: 'personalDiscount',
          value: clampDiscount(reward),
        });
      case PromocodeRewardType.PURCHASE_DISCOUNT:
        return this.applyDiscount({
          transactionClient: input.transactionClient,
          userId: input.userId,
          field: 'purchaseDiscount',
          value: clampDiscount(reward),
        });
      case PromocodeRewardType.DURATION:
        return this.applyDurationReward({
          transactionClient: input.transactionClient,
          targetSubscriptionId: input.targetSubscriptionId,
          days: reward,
        });
      case PromocodeRewardType.TRAFFIC:
        return this.applyTrafficReward({
          transactionClient: input.transactionClient,
          targetSubscriptionId: input.targetSubscriptionId,
          additionalGigabytes: reward,
        });
      case PromocodeRewardType.DEVICES:
        return this.applyDevicesReward({
          transactionClient: input.transactionClient,
          targetSubscriptionId: input.targetSubscriptionId,
          additionalDevices: reward,
        });
      case PromocodeRewardType.SUBSCRIPTION:
        return this.applySubscriptionReward({
          transactionClient: input.transactionClient,
          promocode,
          userId: input.userId,
          targetSubscriptionId: input.targetSubscriptionId,
        });
      default:
        return { applied: false, rewardValue: 0 };
    }
  }

  /**
   * Donor parity helper exposed to the portal layer so it can decorate
   * activation responses with a stable i18n key per reward type.
   */
  public getSuccessMessageKey(rewardType: PromocodeRewardType): string {
    switch (rewardType) {
      case PromocodeRewardType.DURATION:
        return 'ntf-promocode-activated-duration';
      case PromocodeRewardType.TRAFFIC:
        return 'ntf-promocode-activated-traffic';
      case PromocodeRewardType.DEVICES:
        return 'ntf-promocode-activated-devices';
      case PromocodeRewardType.SUBSCRIPTION:
        return 'ntf-promocode-activated-subscription';
      case PromocodeRewardType.PERSONAL_DISCOUNT:
        return 'ntf-promocode-activated-personal-discount';
      case PromocodeRewardType.PURCHASE_DISCOUNT:
        return 'ntf-promocode-activated-purchase-discount';
      default:
        return 'ntf-promocode-activated';
    }
  }

  /**
   * Donor parity helper used when the reward magnitude is implicit. Callers
   * pass `Promocode.reward` first and fall back to `Promocode.plan.duration`
   * for SUBSCRIPTION rewards that store the duration inside the snapshot.
   */
  public resolveActivationRewardValue(promocode: PromocodeInterface): number {
    if (promocode.reward !== null && promocode.reward !== 0) {
      return promocode.reward;
    }
    if (
      promocode.rewardType === PromocodeRewardType.SUBSCRIPTION &&
      promocode.plan !== null &&
      typeof promocode.plan.duration === 'number'
    ) {
      return promocode.plan.duration;
    }
    return 0;
  }

  private async applyDiscount(input: {
    readonly transactionClient: Prisma.TransactionClient;
    readonly userId: string;
    readonly field: 'personalDiscount' | 'purchaseDiscount';
    readonly value: number;
  }): Promise<{ readonly applied: boolean; readonly rewardValue: number }> {
    await input.transactionClient.user.update({
      where: { id: input.userId },
      data: { [input.field]: input.value },
    });
    return { applied: true, rewardValue: input.value };
  }

  private async applyDurationReward(input: {
    readonly transactionClient: Prisma.TransactionClient;
    readonly targetSubscriptionId: string | null;
    readonly days: number;
  }): Promise<{ readonly applied: boolean; readonly rewardValue: number }> {
    if (input.targetSubscriptionId === null || input.days <= 0) {
      return { applied: false, rewardValue: 0 };
    }
    const subscription = await input.transactionClient.subscription.findUnique({
      where: { id: input.targetSubscriptionId },
      select: { expiresAt: true, status: true },
    });
    if (subscription === null || subscription.status !== SubscriptionStatus.ACTIVE) {
      return { applied: false, rewardValue: 0 };
    }
    const baseExpiry = subscription.expiresAt ?? new Date();
    const nextExpiry = new Date(
      baseExpiry.getTime() + input.days * 24 * 60 * 60 * 1000,
    );
    await input.transactionClient.subscription.update({
      where: { id: input.targetSubscriptionId },
      data: { expiresAt: nextExpiry },
    });
    return { applied: true, rewardValue: input.days };
  }

  private async applyTrafficReward(input: {
    readonly transactionClient: Prisma.TransactionClient;
    readonly targetSubscriptionId: string | null;
    readonly additionalGigabytes: number;
  }): Promise<{ readonly applied: boolean; readonly rewardValue: number }> {
    if (input.targetSubscriptionId === null || input.additionalGigabytes <= 0) {
      return { applied: false, rewardValue: 0 };
    }
    const subscription = await input.transactionClient.subscription.findUnique({
      where: { id: input.targetSubscriptionId },
      select: { trafficLimit: true, status: true, planSnapshot: true },
    });
    if (subscription === null || subscription.status !== SubscriptionStatus.ACTIVE) {
      return { applied: false, rewardValue: 0 };
    }
    const currentLimit = subscription.trafficLimit ?? 0;
    const nextLimit = currentLimit + input.additionalGigabytes;
    const nextSnapshot = patchSnapshotNumeric(
      subscription.planSnapshot,
      'trafficLimit',
      nextLimit,
    );
    await input.transactionClient.subscription.update({
      where: { id: input.targetSubscriptionId },
      data: {
        trafficLimit: nextLimit,
        planSnapshot: nextSnapshot,
      },
    });
    return { applied: true, rewardValue: input.additionalGigabytes };
  }

  private async applyDevicesReward(input: {
    readonly transactionClient: Prisma.TransactionClient;
    readonly targetSubscriptionId: string | null;
    readonly additionalDevices: number;
  }): Promise<{ readonly applied: boolean; readonly rewardValue: number }> {
    if (input.targetSubscriptionId === null || input.additionalDevices <= 0) {
      return { applied: false, rewardValue: 0 };
    }
    const subscription = await input.transactionClient.subscription.findUnique({
      where: { id: input.targetSubscriptionId },
      select: { deviceLimit: true, status: true, planSnapshot: true },
    });
    if (subscription === null || subscription.status !== SubscriptionStatus.ACTIVE) {
      return { applied: false, rewardValue: 0 };
    }
    const nextLimit = subscription.deviceLimit + input.additionalDevices;
    const nextSnapshot = patchSnapshotNumeric(
      subscription.planSnapshot,
      'deviceLimit',
      nextLimit,
    );
    await input.transactionClient.subscription.update({
      where: { id: input.targetSubscriptionId },
      data: {
        deviceLimit: nextLimit,
        planSnapshot: nextSnapshot,
      },
    });
    return { applied: true, rewardValue: input.additionalDevices };
  }

  private async applySubscriptionReward(input: {
    readonly transactionClient: Prisma.TransactionClient;
    readonly promocode: PromocodeInterface;
    readonly userId: string;
    readonly targetSubscriptionId: string | null;
  }): Promise<{ readonly applied: boolean; readonly rewardValue: number }> {
    const plan = input.promocode.plan;
    if (plan === null) {
      this.logger.warn(
        `Promocode ${input.promocode.code} has rewardType=SUBSCRIPTION but no plan snapshot`,
      );
      return { applied: false, rewardValue: 0 };
    }
    const days = plan.duration ?? 0;

    if (input.targetSubscriptionId !== null) {
      // Extend an existing eligible subscription by the snapshot duration.
      if (days <= 0) {
        return { applied: false, rewardValue: 0 };
      }
      const subscription = await input.transactionClient.subscription.findUnique({
        where: { id: input.targetSubscriptionId },
        select: { expiresAt: true, status: true },
      });
      if (subscription === null || subscription.status !== SubscriptionStatus.ACTIVE) {
        return { applied: false, rewardValue: 0 };
      }
      const baseExpiry = subscription.expiresAt ?? new Date();
      const nextExpiry = new Date(baseExpiry.getTime() + days * 24 * 60 * 60 * 1000);
      await input.transactionClient.subscription.update({
        where: { id: input.targetSubscriptionId },
        data: { expiresAt: nextExpiry },
      });
      return { applied: true, rewardValue: days };
    }

    // Create a brand-new subscription from the plan snapshot. The Remnawave
    // sync is left to the profile-sync queue; we only persist the local
    // record so the activation transaction stays fast and atomic.
    const startedAt = new Date();
    const expiresAt =
      days > 0 ? new Date(startedAt.getTime() + days * 24 * 60 * 60 * 1000) : null;
    await input.transactionClient.subscription.create({
      data: {
        userId: input.userId,
        status: SubscriptionStatus.ACTIVE,
        isTrial: false,
        planSnapshot: plan as unknown as Prisma.InputJsonValue,
        trafficLimit: plan.trafficLimit ?? null,
        deviceLimit: plan.deviceLimit,
        internalSquads: [...plan.internalSquads],
        externalSquad: plan.externalSquad,
        startedAt,
        expiresAt,
      },
    });
    return { applied: true, rewardValue: days };
  }
}

function clampDiscount(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.trunc(value)));
}

function patchSnapshotNumeric(
  snapshot: Prisma.JsonValue,
  key: 'trafficLimit' | 'deviceLimit',
  value: number,
): Prisma.InputJsonValue {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { [key]: value } as Prisma.InputJsonValue;
  }
  const next = { ...(snapshot as Record<string, unknown>) };
  next[key] = value;
  return next as Prisma.InputJsonValue;
}
