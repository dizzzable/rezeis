import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, PurchaseType, ReferralRewardType, TransactionStatus } from '@prisma/client';

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
   *
   * Atomicity: the referral row is locked with `FOR UPDATE` and all writes
   * (qualify + reward creates) happen inside a single transaction. Concurrent
   * duplicate calls for the same user will queue on the lock; only the first
   * one will see `qualifiedAt === null` and proceed — subsequent calls exit
   * early, keeping the reward set exactly-once.
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

    // ON_FIRST_PAYMENT pre-filter: only NEW and UPGRADE are eligible types.
    // RENEW / ADDITIONAL always imply a prior payment, so they never qualify.
    // For UPGRADE we do an additional DB check inside the transaction below
    // to confirm this is truly the user's first completed payment.
    const FIRST_PAYMENT_TYPES: readonly PurchaseType[] = [PurchaseType.NEW, PurchaseType.UPGRADE];
    if (
      settings.accrual_strategy === 'ON_FIRST_PAYMENT' &&
      !FIRST_PAYMENT_TYPES.includes(transaction.purchaseType)
    ) {
      this.logger.debug(
        `Skipping qualification: accrual_strategy=ON_FIRST_PAYMENT but purchaseType=${transaction.purchaseType}`,
      );
      return;
    }

    // ── Atomic critical section ──────────────────────────────────────────────
    // Lock the referral row to serialise concurrent calls for the same user.
    // All writes execute inside a single transaction; the event fires after
    // commit so observers never see a partially-qualified referral.
    const qualified = await this.prismaService.$transaction(async (tx) => {
      // Lock by referred_id (UNIQUE) so parallel calls queue here.
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "referrals" WHERE "referred_id" = ${transaction.userId} FOR UPDATE`,
      );

      const referral = await tx.referral.findUnique({
        where: { referredId: transaction.userId },
        select: { id: true, referrerId: true, level: true, qualifiedAt: true },
      });

      if (!referral) return null;
      // Already qualified — idempotent exit (concurrent winner ran first).
      if (referral.qualifiedAt !== null) return null;

      // For UPGRADE under ON_FIRST_PAYMENT: prove this is truly the first
      // completed payment by counting any prior COMPLETED tx for the same user
      // (excluding the current one). A paid→paid upgrade has prior completeds.
      if (
        settings.accrual_strategy === 'ON_FIRST_PAYMENT' &&
        transaction.purchaseType === PurchaseType.UPGRADE
      ) {
        const priorCount = await tx.transaction.count({
          where: {
            userId: transaction.userId,
            status: TransactionStatus.COMPLETED,
            id: { not: transaction.id },
          },
        });
        if (priorCount > 0) {
          this.logger.debug(
            `Skipping UPGRADE qualification: user has ${priorCount} prior completed transaction(s)`,
          );
          return null;
        }
      }

      const referrerPartner = await tx.partner.findUnique({
        where: { userId: referral.referrerId },
        select: { isActive: true },
      });
      const referrerIsActivePartner = referrerPartner?.isActive === true;

      await tx.referral.update({
        where: { id: referral.id },
        data: {
          qualifiedAt: new Date(),
          qualifiedTransactionId: transaction.id,
          qualifiedPurchaseChannel: transaction.channel,
        },
      });

      const rewardConfig = settings.reward;
      const rewardType: ReferralRewardType =
        rewardConfig?.type === 'EXTRA_DAYS'
          ? ReferralRewardType.EXTRA_DAYS
          : ReferralRewardType.POINTS;

      const firstAmount = rewardConfig?.config?.FIRST ?? 0;
      const secondAmount = rewardConfig?.config?.SECOND ?? 0;

      if (!referrerIsActivePartner && rewardConfig) {
        if (firstAmount > 0) {
          await tx.referralReward.create({
            data: {
              referralId: referral.id,
              userId: referral.referrerId,
              type: rewardType,
              amount: firstAmount,
            },
          });
        }

        if (secondAmount > 0) {
          const l2Referral = await tx.referral.findUnique({
            where: { referredId: referral.referrerId },
            select: { id: true, referrerId: true },
          });
          if (l2Referral) {
            const l2Partner = await tx.partner.findUnique({
              where: { userId: l2Referral.referrerId },
              select: { isActive: true },
            });
            if (l2Partner?.isActive !== true) {
              await tx.referralReward.create({
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

      return { referral, transaction };
    });

    // Post-commit event — never fires for duplicate/skipped calls.
    if (qualified) {
      this.events.info(
        EVENT_TYPES.REFERRAL_QUALIFIED,
        'REFERRAL',
        'Referral qualified after purchase',
        {
          referralId: qualified.referral.id,
          referrerId: qualified.referral.referrerId,
          referredUserId: qualified.transaction.userId,
          userId: qualified.transaction.userId,
          transactionId: qualified.transaction.id,
        },
      );
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
        referralId: true,
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

    // Notify the dev that a referral reward landed (points or extra days).
    // `issueReward` previously applied the effect silently.
    this.events.info(EVENT_TYPES.REFERRAL_REWARD_ISSUED, 'REFERRAL', 'Referral reward issued', {
      referralId: reward.referralId,
      referrerId: reward.userId,
      userId: reward.userId,
      rewardType: reward.type,
      rewardValue: reward.amount,
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

    return normalizeReferralSettings(settings.referralSettings);
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readOptionalNumber(
  record: Record<string, unknown>,
  ...keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

/**
 * Normalises the raw `Settings.referralSettings` JSON into the internal
 * {@link ReferralSettingsJson} shape the qualification engine reads.
 *
 * The admin panel form persists a camelCase contract (`accrualStrategy`,
 * `rewardType`, `level1Reward`/`level2Reward`), while the engine historically
 * read a snake_case/nested donor shape (`accrual_strategy`, `reward.config`).
 * This bridged reader prefers the FORM keys (so operator config actually
 * drives referral rewards — previously it was silently ignored and NO reward
 * rows were created) and falls back to the legacy shape for backward
 * compatibility with older data and existing tests.
 */
function normalizeReferralSettings(raw: unknown): ReferralSettingsJson {
  const record = readRecord(raw);
  const result: ReferralSettingsJson = {};

  if (typeof record['enabled'] === 'boolean') {
    result.enabled = record['enabled'];
  }

  // Only `ON_FIRST_PAYMENT` changes behavior (it gates accrual to the referred
  // user's FIRST purchase). Every other value — the form's `ON_EACH_PAYMENT`,
  // the legacy `ON_EVERY_PAYMENT`, or unset — means "accrue on every qualifying
  // payment", which is the engine's default when `accrual_strategy` is absent.
  const accrual = record['accrualStrategy'] ?? record['accrual_strategy'];
  if (accrual === 'ON_FIRST_PAYMENT') {
    result.accrual_strategy = 'ON_FIRST_PAYMENT';
  }

  const eligibleRaw = record['eligiblePlanIds'] ?? record['eligible_plan_ids'];
  if (Array.isArray(eligibleRaw)) {
    result.eligible_plan_ids = eligibleRaw.filter((id): id is string => typeof id === 'string');
  }

  // Reward: prefer the FORM's flat shape (rewardType + levelNReward), else the
  // legacy nested `reward: { type, strategy, config: { FIRST, SECOND } }`.
  const rewardType = record['rewardType'];
  if (rewardType === 'POINTS' || rewardType === 'EXTRA_DAYS') {
    const first = readOptionalNumber(record, 'level1Reward', 'pointsPerReferral') ?? 0;
    const second = readOptionalNumber(record, 'level2Reward') ?? 0;
    result.reward = {
      type: rewardType,
      strategy: 'AMOUNT',
      config: { FIRST: first, SECOND: second },
    };
  } else {
    const legacyReward = readRecord(record['reward']);
    const legacyType = legacyReward['type'];
    if (legacyType === 'POINTS' || legacyType === 'EXTRA_DAYS') {
      const legacyConfig = readRecord(legacyReward['config']);
      result.reward = {
        type: legacyType,
        strategy: legacyReward['strategy'] === 'PERCENT' ? 'PERCENT' : 'AMOUNT',
        config: {
          FIRST: readOptionalNumber(legacyConfig, 'FIRST') ?? 0,
          SECOND: readOptionalNumber(legacyConfig, 'SECOND') ?? 0,
        },
      };
    }
  }

  return result;
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
