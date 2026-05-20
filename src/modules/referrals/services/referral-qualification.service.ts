import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PurchaseType, ReferralRewardType } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { SystemEventsService, EVENT_TYPES } from '../../../common/services/system-events.service';

/**
 * Shape of `Settings.referralSettings` JSON (donor: altshop referral_settings).
 */
interface ReferralSettingsJson {
  enabled?: boolean;
  accrual_strategy?: 'ON_FIRST_PAYMENT' | 'ON_EVERY_PAYMENT';
  reward?: {
    type: 'POINTS' | 'EXTRA_DAYS';
    strategy: 'AMOUNT' | 'PERCENT';
    config: {
      FIRST?: number;
      SECOND?: number;
    };
  };
  /** Plan IDs eligible for referral rewards. Empty array = all plans eligible. */
  eligible_plan_ids?: string[];
}

@Injectable()
export class ReferralQualificationService {
  private readonly logger = new Logger(ReferralQualificationService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly events: SystemEventsService,
  ) {}

  /**
   * Called after a completed payment. Qualifies the referral edge (if any)
   * and creates reward rows for the referrer (and optionally L2 referrer).
   */
  public async qualifyReferralAfterPurchase(transactionId: string): Promise<void> {
    const transaction = await this.prismaService.transaction.findUnique({
      where: { id: transactionId },
      select: {
        id: true,
        userId: true,
        purchaseType: true,
        channel: true,
        planSnapshot: true,
      },
    });

    if (!transaction) {
      this.logger.warn(`Transaction not found: ${transactionId}`);
      return;
    }

    const settings = await this.loadReferralSettings();

    // Extract planId from planSnapshot JSON
    const planSnapshot = readRecord(transaction.planSnapshot);
    const transactionPlanId = readOptionalString(planSnapshot, 'id');

    // Plan eligibility filter (donor: eligible_plan_ids)
    if (
      settings.eligible_plan_ids &&
      settings.eligible_plan_ids.length > 0 &&
      transactionPlanId !== null &&
      !settings.eligible_plan_ids.includes(transactionPlanId)
    ) {
      this.logger.debug(
        `Skipping qualification: plan ${transactionPlanId} not in eligible_plan_ids`,
      );
      return;
    }

    // If accrual_strategy = ON_FIRST_PAYMENT, skip non-NEW purchases
    if (
      settings.accrual_strategy === 'ON_FIRST_PAYMENT' &&
      transaction.purchaseType !== PurchaseType.NEW
    ) {
      this.logger.debug(
        `Skipping qualification: accrual_strategy=ON_FIRST_PAYMENT but purchaseType=${transaction.purchaseType}`,
      );
      return;
    }

    // Find the L1 referral edge where this user is the referred party
    const referral = await this.prismaService.referral.findUnique({
      where: { referredId: transaction.userId },
      select: {
        id: true,
        referrerId: true,
        level: true,
        qualifiedAt: true,
      },
    });

    if (!referral) {
      this.logger.debug(`No referral edge for user ${transaction.userId}`);
      return;
    }

    // Already qualified — skip
    if (referral.qualifiedAt !== null) {
      this.logger.debug(`Referral ${referral.id} already qualified`);
      return;
    }

    // Check if referrer is an active Partner (donor parity — skip reward)
    const referrerPartner = await this.prismaService.partner.findUnique({
      where: { userId: referral.referrerId },
      select: { isActive: true },
    });

    const referrerIsActivePartner = referrerPartner?.isActive === true;

    // Mark referral as qualified
    await this.prismaService.referral.update({
      where: { id: referral.id },
      data: {
        qualifiedAt: new Date(),
        qualifiedTransactionId: transaction.id,
        qualifiedPurchaseChannel: transaction.channel,
      },
    });

    // Emit referral qualified event
    this.events.info(EVENT_TYPES.REFERRAL_QUALIFIED, 'REFERRAL', 'Referral qualified after purchase', {
      referralId: referral.id,
      referrerId: referral.referrerId,
      referredUserId: transaction.userId,
      transactionId: transaction.id,
    });

    // Skip reward creation if referrer is an active partner
    if (referrerIsActivePartner) {
      this.logger.debug(
        `Referrer ${referral.referrerId} is an active partner — skipping reward`,
      );
      return;
    }

    const rewardConfig = settings.reward;
    if (!rewardConfig) {
      this.logger.warn('No reward configuration in referralSettings');
      return;
    }

    const rewardType: ReferralRewardType =
      rewardConfig.type === 'EXTRA_DAYS'
        ? ReferralRewardType.EXTRA_DAYS
        : ReferralRewardType.POINTS;

    const firstAmount = rewardConfig.config?.FIRST ?? 0;
    const secondAmount = rewardConfig.config?.SECOND ?? 0;

    // Create L1 reward for the referrer
    if (firstAmount > 0) {
      await this.prismaService.referralReward.create({
        data: {
          referralId: referral.id,
          userId: referral.referrerId,
          type: rewardType,
          amount: firstAmount,
        },
      });
    }

    // Create L2 reward if configured — find the referrer's own referral edge
    if (secondAmount > 0) {
      const l2Referral = await this.prismaService.referral.findUnique({
        where: { referredId: referral.referrerId },
        select: { id: true, referrerId: true },
      });

      if (l2Referral) {
        // Check if L2 referrer is also an active partner
        const l2Partner = await this.prismaService.partner.findUnique({
          where: { userId: l2Referral.referrerId },
          select: { isActive: true },
        });

        if (l2Partner?.isActive !== true) {
          await this.prismaService.referralReward.create({
            data: {
              referralId: l2Referral.id,
              userId: l2Referral.referrerId,
              type: rewardType,
              amount: secondAmount,
            },
          });
        }
      }
    }
  }

  /**
   * Marks a reward as issued and applies the effect (points or extra days).
   */
  public async issueReward(rewardId: string): Promise<void> {
    const reward = await this.prismaService.referralReward.findUnique({
      where: { id: rewardId },
      select: {
        id: true,
        userId: true,
        type: true,
        amount: true,
        isIssued: true,
      },
    });

    if (!reward) {
      throw new NotFoundException(`ReferralReward not found: ${rewardId}`);
    }

    if (reward.isIssued) {
      this.logger.debug(`Reward ${rewardId} already issued`);
      return;
    }

    const now = new Date();

    await this.prismaService.$transaction(async (tx) => {
      // Mark reward as issued
      await tx.referralReward.update({
        where: { id: rewardId },
        data: { isIssued: true, issuedAt: now },
      });

      if (reward.type === ReferralRewardType.POINTS) {
        // Increment user points
        await tx.user.update({
          where: { id: reward.userId },
          data: { points: { increment: reward.amount } },
        });
      } else if (reward.type === ReferralRewardType.EXTRA_DAYS) {
        // Extend the user's current subscription expiresAt
        const user = await tx.user.findUnique({
          where: { id: reward.userId },
          select: { currentSubscriptionId: true },
        });

        if (user?.currentSubscriptionId) {
          const subscription = await tx.subscription.findUnique({
            where: { id: user.currentSubscriptionId },
            select: { id: true, expiresAt: true },
          });

          if (subscription) {
            const baseDate = subscription.expiresAt ?? now;
            const newExpiresAt = new Date(baseDate);
            newExpiresAt.setUTCDate(newExpiresAt.getUTCDate() + reward.amount);

            await tx.subscription.update({
              where: { id: subscription.id },
              data: { expiresAt: newExpiresAt },
            });
          }
        }
      }
    });
  }

  /**
   * Returns all referral rewards for a given user.
   */
  public async listRewardsByUser(userId: string) {
    return this.prismaService.referralReward.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async loadReferralSettings(): Promise<ReferralSettingsJson> {
    const settings = await this.prismaService.settings.findFirst({
      select: { referralSettings: true },
    });

    if (!settings) {
      return {};
    }

    return settings.referralSettings as unknown as ReferralSettingsJson;
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readOptionalString(record: Record<string, unknown>, key: string): string | null {
  const candidate = record[key];
  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    return candidate.trim();
  }
  if (typeof candidate === 'number' && Number.isFinite(candidate)) {
    return String(candidate);
  }
  return null;
}
