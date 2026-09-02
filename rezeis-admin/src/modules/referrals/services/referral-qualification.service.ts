import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  PointsLedgerSource,
  Prisma,
  PurchaseType,
  ReferralRewardType,
  TransactionStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { SystemEventsService, EVENT_TYPES } from '../../../common/services/system-events.service';
import { PointsWalletService } from '../../points/services/points-wallet.service';

/**
 * Shape of `Settings.referralSettings` JSON (donor: altshop referral_settings).
 */
export interface ReferralSettingsJson {
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
    private readonly pointsWallet: PointsWalletService,
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

    // Operator kill-switch. `enabled` was parsed but never checked, so turning
    // the referral program off in the panel kept qualifying referrals and
    // handing out rewards. Only an explicit `false` disables — an absent flag
    // stays enabled so existing installs are unaffected.
    //
    // Scope: this gates the REFERRAL program only. The partner program is a
    // separate system with its own `partnerSettings.enabled`
    // (`PartnerEarningsService.processPartnerEarning`) and its own payout path,
    // and it must keep working when referral rewards are switched off — the two
    // only share the invite-code mechanic, not the economics.
    if (settings.enabled === false) {
      this.logger.debug(
        `Skipping qualification for ${transactionId}: referral program is disabled`,
      );
      return;
    }

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

      await tx.referral.update({
        where: { id: referral.id },
        data: {
          qualifiedAt: new Date(),
          qualifiedTransactionId: transaction.id,
          qualifiedPurchaseChannel: transaction.channel,
        },
      });

      await this.createConfiguredRewards(tx, {
        referralId: referral.id,
        referrerId: referral.referrerId,
        reward: settings.reward,
      });

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
   * Explicit admin qualification for a valid, already attached edge. The
   * operation is idempotent and creates the same *pending* reward rows as the
   * payment path; rewards are not issued here, so the usual reviewed issue
   * workflow (including profile sync for EXTRA_DAYS) remains in control.
   */
  public async qualifyReferralManually(input: {
    readonly referredUserId: string;
    readonly actorAdminId: string | null;
  }): Promise<{ readonly referralId: string; readonly qualified: boolean; readonly rewardsCreated: number }> {
    const settings = await this.loadReferralSettings();
    // Deliberately NOT gated on `settings.enabled`. Turning the program off
    // stops the automatic engine; an admin explicitly qualifying one referral
    // by hand is a deliberate, audited act (`grantedBy` is stamped below) and
    // is exactly how a support case gets settled after the program is paused.
    const result = await this.prismaService.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "referrals" WHERE "referred_id" = ${input.referredUserId} FOR UPDATE`,
      );
      const referral = await tx.referral.findUnique({
        where: { referredId: input.referredUserId },
        select: { id: true, referrerId: true, qualifiedAt: true },
      });
      if (!referral) {
        throw new NotFoundException('Referral attribution not found for user');
      }
      if (referral.qualifiedAt !== null) {
        return { referralId: referral.id, referrerId: referral.referrerId, qualified: false, rewardsCreated: 0 };
      }

      await tx.referral.update({
        where: { id: referral.id },
        data: { qualifiedAt: new Date() },
      });
      const rewardsCreated = await this.createConfiguredRewards(tx, {
        referralId: referral.id,
        referrerId: referral.referrerId,
        reward: settings.reward,
        grantedBy: input.actorAdminId,
      });
      return { referralId: referral.id, referrerId: referral.referrerId, qualified: true, rewardsCreated };
    });

    if (result.qualified) {
      this.events.info(
        EVENT_TYPES.REFERRAL_QUALIFIED,
        'REFERRAL',
        'Referral manually qualified',
        {
          referralId: result.referralId,
          referrerId: result.referrerId,
          referredUserId: input.referredUserId,
          userId: input.referredUserId,
          manual: true,
          actorAdminId: input.actorAdminId,
          rewardsCreated: result.rewardsCreated,
        },
      );
    }

    return {
      referralId: result.referralId,
      qualified: result.qualified,
      rewardsCreated: result.rewardsCreated,
    };
  }

  /**
   * Reverses the referral qualification produced by a now-refunded /
   * charged-back transaction. Only un-qualifies the edge that THIS transaction
   * qualified (`qualifiedTransactionId === transactionId`), then revokes every
   * reward on that edge:
   *   - pending (not issued) → mark revoked (never pays out).
   *   - already issued → reverse the effect (debit POINTS, roll back EXTRA_DAYS)
   *     and mark revoked so it can't be reversed twice.
   *
   * Idempotent: an already-cleared qualification (or already-revoked reward) is
   * skipped. All writes run in one transaction so the edge and its rewards
   * reverse atomically.
   */
  public async reverseQualificationForTransaction(transactionId: string): Promise<void> {
    try {
      await this.prismaService.$transaction(async (tx) => {
        const referral = await tx.referral.findFirst({
          where: { qualifiedTransactionId: transactionId },
          select: { id: true },
        });
        if (referral === null) return;

        const rewards = await tx.referralReward.findMany({
          where: { referralId: referral.id, revokedAt: null },
          select: { id: true, userId: true, type: true, amount: true, isIssued: true },
        });

        const now = new Date();
        for (const reward of rewards) {
          if (reward.isIssued) {
            // Reverse the applied effect before revoking.
            if (reward.type === ReferralRewardType.POINTS) {
              // Floored, through the wallet. This used to be a bare
              // `decrement` with no floor — the only writer of the balance
              // without one — and a referrer who had already spent the payout
              // was driven negative. The money has gone back to the payer;
              // what the referrer still holds is taken, the rest is recorded
              // as shortfall on the ledger row, and the balance stops at zero.
              //
              // The result is not inspected on purpose: DUPLICATE means this
              // reward was already reversed by an earlier replay, and
              // USER_NOT_FOUND means the referrer is gone. Neither is a reason
              // to abort the rest of the reversal.
              await this.pointsWallet.apply(tx, {
                userId: reward.userId,
                delta: -reward.amount,
                source: PointsLedgerSource.REFERRAL_REWARD_REVOKED,
                referenceKey: reward.id,
                shortfall: 'floor',
                details: { rewardId: reward.id, referralId: referral.id, transactionId },
              });
            } else if (reward.type === ReferralRewardType.EXTRA_DAYS) {
              const user = await tx.user.findUnique({
                where: { id: reward.userId },
                select: { currentSubscriptionId: true },
              });
              if (user?.currentSubscriptionId) {
                const subscription = await tx.subscription.findUnique({
                  where: { id: user.currentSubscriptionId },
                  select: { id: true, expiresAt: true },
                });
                if (subscription !== null && subscription.expiresAt !== null) {
                  const rolledBack = new Date(subscription.expiresAt);
                  rolledBack.setUTCDate(rolledBack.getUTCDate() - reward.amount);
                  await tx.subscription.update({
                    where: { id: subscription.id },
                    data: { expiresAt: rolledBack },
                  });
                }
              }
            }
          }
          await tx.referralReward.update({
            where: { id: reward.id },
            data: { revokedAt: now, revokeReason: `Refund/chargeback on transaction ${transactionId}` },
          });
        }

        // Clear the qualification so a legitimate later re-payment can re-qualify.
        await tx.referral.update({
          where: { id: referral.id },
          data: { qualifiedAt: null, qualifiedTransactionId: null, qualifiedPurchaseChannel: null },
        });
      });
    } catch (error: unknown) {
      this.logger.error(
        `Referral qualification reversal failed for transaction ${transactionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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

  private async createConfiguredRewards(
    tx: Prisma.TransactionClient,
    input: {
      readonly referralId: string;
      readonly referrerId: string;
      readonly reward: ReferralSettingsJson['reward'] | undefined;
      readonly grantedBy?: string | null;
    },
  ): Promise<number> {
    if (!input.reward) return 0;
    const referrerPartner = await tx.partner.findUnique({
      where: { userId: input.referrerId },
      select: { isActive: true },
    });
    if (referrerPartner?.isActive === true) return 0;

    const rewardType =
      input.reward.type === 'EXTRA_DAYS'
        ? ReferralRewardType.EXTRA_DAYS
        : ReferralRewardType.POINTS;
    let created = 0;
    const firstAmount = input.reward.config.FIRST ?? 0;
    if (firstAmount > 0) {
      await tx.referralReward.create({
        data: {
          referralId: input.referralId,
          userId: input.referrerId,
          type: rewardType,
          amount: firstAmount,
          ...(input.grantedBy ? { grantedBy: input.grantedBy } : {}),
        },
      });
      created += 1;
    }

    const secondAmount = input.reward.config.SECOND ?? 0;
    if (secondAmount <= 0) return created;
    const l2Referral = await tx.referral.findUnique({
      where: { referredId: input.referrerId },
      select: { id: true, referrerId: true },
    });
    if (!l2Referral) return created;
    const l2Partner = await tx.partner.findUnique({
      where: { userId: l2Referral.referrerId },
      select: { isActive: true },
    });
    if (l2Partner?.isActive === true) return created;
    await tx.referralReward.create({
      data: {
        referralId: l2Referral.id,
        userId: l2Referral.referrerId,
        type: rewardType,
        amount: secondAmount,
        ...(input.grantedBy ? { grantedBy: input.grantedBy } : {}),
      },
    });
    return created + 1;
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
 *
 * EXPORTED because it now has a SECOND reader. `ReferralsService.listReferrals`
 * decides whether a level-2 payout row exists at all, and that decision is the
 * same `reward.config.SECOND` this function assembles. Reading the raw JSON
 * there instead would have re-implemented the camelCase/legacy bridge and
 * disagreed with the engine the moment an install used the shape the copy did
 * not handle - the panel would then promise a payout `createConfiguredRewards`
 * never makes, or hide one it does.
 */
export function normalizeReferralSettings(raw: unknown): ReferralSettingsJson {
  const record = readRecord(raw);
  const result: ReferralSettingsJson = {};

  // The admin form falls back to a legacy `enable` key when reading, so an
  // older install can hold the switch under that name. Now that this flag
  // actually gates accrual, reading only `enabled` would show the toggle OFF
  // in the panel while rewards kept being handed out.
  const enabledFlag = record['enabled'] ?? record['enable'];
  if (typeof enabledFlag === 'boolean') {
    result.enabled = enabledFlag;
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
