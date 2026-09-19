import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  PaymentGatewayType,
  Prisma,
  ReferralRewardType,
  TransactionStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { SystemEventsService, EVENT_TYPES } from '../../../common/services/system-events.service';
import { writeTransactionGatewayData } from '../../payments/utils/transaction-gateway-data.util';
import { PointsWalletService } from '../../points/services/points-wallet.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import {
  applyReferralRewardEffect,
  ReferralRewardEffectRefusal,
  ReferralRewardToIssue,
  reverseReferralRewardEffect,
} from './referral-reward-effect';

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

/** A reward the payment path issued on the spot. */
export interface AutomaticallyIssuedReferralReward extends ReferralRewardToIssue {
  readonly syncJobId: string | null;
}

/** A reward the payment path created but could not issue; «Выдать» takes it from here. */
export interface PendingReferralReward extends ReferralRewardToIssue {
  readonly refusal: ReferralRewardEffectRefusal;
}

/**
 * What one payment did to the referral program. The payment pipeline reads it
 * to tell each earner what arrived — the same split as the cashback, where the
 * credit is durable before the message is attempted.
 */
export interface ReferralPurchaseOutcome {
  readonly transactionId: string;
  readonly issued: readonly AutomaticallyIssuedReferralReward[];
  readonly pending: readonly PendingReferralReward[];
}

interface ConfiguredRewardsResult {
  readonly created: number;
  readonly issued: readonly AutomaticallyIssuedReferralReward[];
  readonly pending: readonly PendingReferralReward[];
}

/**
 * The idempotency key of the reward ONE payment earned at ONE level.
 *
 * Rewards used to be exactly-once per REFERRAL (`referral.qualifiedAt`), which
 * made «При каждом платеже» pay once, like «Только при первом платеже». Keyed
 * per payment, a replayed webhook still cannot pay twice — `source_key` is
 * UNIQUE — while a second real payment earns its own reward, and a refund
 * finds exactly the rewards its payment produced, level 2 included (a level-2
 * reward sits on the GRANDPARENT's referral row, where the old
 * "every reward on this referral" reversal could not find it and revoked
 * somebody else's instead).
 *
 * `source_key` was introduced for imported rewards; those carry their donor's
 * prefix, so this namespace cannot collide with them.
 */
export const REFERRAL_PAYMENT_SOURCE_KEY_PREFIX = 'referral-payment:';

export function referralPaymentRewardSourceKey(transactionId: string, level: 1 | 2): string {
  return `${REFERRAL_PAYMENT_SOURCE_KEY_PREFIX}${transactionId}:L${level}`;
}

/**
 * Stamped into the refunded payment's `gatewayData` by
 * `reverseQualificationForTransaction`, under the payer's referral row lock,
 * and read under the same lock by `qualifyReferralAfterPurchase`.
 *
 * A refund reverses the referral program BEFORE `reverseFulfilledPayment`
 * marks the payment CANCELED at its very end. The payment's own reward hook
 * could run in between — the two stall on the same Redis outage and resume in
 * either order — find the payment still COMPLETED, and issue a reward the
 * refund had already looked for and not found. Nothing reversed it later: the
 * `refundReversedAt` stamp short-circuits a repeated refund. The stamp is what
 * the hook sees instead.
 */
export const REFERRAL_REVERSED_AT_KEY = 'referralReversedAt';

/** How many times a transaction PostgreSQL aborted on a conflict is run again. */
const MAX_TRANSACTION_ATTEMPTS = 3;

/**
 * A transaction PostgreSQL aborted to break a deadlock or a serialization
 * conflict — rolled back whole, so running it again from the start is safe.
 *
 * Decided by the SQLSTATE, not by Prisma's code: through the pg driver adapter
 * (Prisma 7) a deadlock is NOT the documented P2034. Measured on PostgreSQL 17:
 * a model statement reports `P2039` ("Database error") and a raw one `P2010`,
 * both with the SQLSTATE under `meta.driverAdapterError.cause.code`. A check for
 * P2034 alone never matched, and the transaction it was meant to rescue was
 * simply lost.
 */
export function isRetryableTransactionConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2034') return true;
  const meta = error.meta as
    | {
        readonly code?: unknown;
        readonly driverAdapterError?: { readonly cause?: { readonly code?: unknown; readonly originalCode?: unknown } };
      }
    | undefined;
  const cause = meta?.driverAdapterError?.cause;
  const sqlState = cause?.code ?? cause?.originalCode ?? meta?.code;
  if (sqlState === '40P01' || sqlState === '40001') return true;
  return /Code: `(?:40P01|40001)`/.test(error.message);
}

@Injectable()
export class ReferralQualificationService {
  private readonly logger = new Logger(ReferralQualificationService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly events: SystemEventsService,
    private readonly pointsWallet: PointsWalletService,
    private readonly profileSyncQueue: ProfileSyncQueueService,
  ) {}

  /**
   * Called after a completed payment. Qualifies the referral edge (if any),
   * creates the reward rows for the referrer (and optionally the L2 referrer)
   * and ISSUES them in the same transaction.
   *
   * Issuing on the spot is the owner's decision of 2026-09-14 («Сразу
   * автоматически»). Until then every reward row was born pending and nothing
   * but an operator's «Выдать» ever paid it — while the cabinet, the
   * `referral_attached` template and the parity docs all promised automatic
   * crediting. A reward whose effect cannot be applied yet (EXTRA_DAYS for an
   * inviter with no finite active subscription) stays pending instead of
   * failing the payment's qualification: that is the case «Выдать» remains for.
   *
   * Atomicity: the referral row is locked with `FOR UPDATE` and every write —
   * the qualification stamp, the reward rows, their effects and the ISSUED
   * marks — happens inside one transaction. Concurrent duplicate calls for the
   * same payment queue on the lock, and the second one finds the first one's
   * keyed rewards (or its `qualifiedTransactionId`) and exits.
   *
   * @returns what the payment produced, or `null` when it produced nothing.
   */
  public async qualifyReferralAfterPurchase(
    transactionId: string,
  ): Promise<ReferralPurchaseOutcome | null> {
    const transaction = await this.prismaService.transaction.findUnique({
      where: { id: transactionId },
      select: {
        id: true,
        userId: true,
        channel: true,
        planSnapshot: true,
        amount: true,
        status: true,
        gatewayType: true,
        createdAt: true,
      },
    });

    if (!transaction) {
      this.logger.warn(`Transaction not found: ${transactionId}`);
      return null;
    }

    // Rewards are now paid out on the spot, so the question "did money really
    // arrive" is asked here and not left to every caller. A payment that is
    // not COMPLETED earns nothing yet, and a zero-amount one — a 100% promo
    // code, a free renewal — was never a payment: every real zero-total path
    // already skips this hook on purpose, this only makes a stray call harmless.
    if (transaction.status !== TransactionStatus.COMPLETED) {
      this.logger.debug(
        `Skipping qualification for ${transactionId}: status is ${transaction.status}, not COMPLETED`,
      );
      return null;
    }
    if (!new Prisma.Decimal(transaction.amount).greaterThan(0)) {
      this.logger.debug(`Skipping qualification for ${transactionId}: nothing was paid`);
      return null;
    }
    // A partner paying with his accrued partner balance is not a payment the
    // referral program counts: the live path runs no post-payment hooks for it
    // on purpose (`PartnerBalancePaymentService`), and it must not become one
    // through the manual-attach replay either — nor, below, take the "first
    // payment" place from a later payment with money.
    if (transaction.gatewayType === PaymentGatewayType.PARTNER_BALANCE) {
      this.logger.debug(`Skipping qualification for ${transactionId}: paid from the partner balance`);
      return null;
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
      return null;
    }

    // Plan eligibility filter (donor: eligible_plan_ids). A payment qualifies
    // when it bought an eligible plan — through its own snapshot or, for a
    // combined renewal, one of its items. One that bought no plan at all (an
    // add-on) is not eligible under a restricted list: it used to pass the
    // filter for lack of an `id` to compare, and then took the first-payment
    // place from the plan the operator actually meant.
    const eligiblePlanIds = settings.eligible_plan_ids ?? [];
    if (eligiblePlanIds.length > 0) {
      const purchasedPlanIds = await this.purchasedPlanIds(transaction.id, transaction.planSnapshot);
      if (!purchasedPlanIds.some((planId) => eligiblePlanIds.includes(planId))) {
        this.logger.debug(
          `Skipping qualification for ${transactionId}: bought ${
            purchasedPlanIds.length > 0 ? purchasedPlanIds.join(', ') : 'no plan'
          }, none of them in eligible_plan_ids`,
        );
        return null;
      }
    }

    // ── Atomic critical section ──────────────────────────────────────────────
    // Lock the referral row to serialise concurrent calls for the same user.
    // All writes execute inside a single transaction; the events fire after
    // commit so observers never see a partially-qualified referral.
    const outcome = await this.withConflictRetry(`qualification of ${transactionId}`, () =>
      this.prismaService.$transaction(async (tx) => {
      // Lock by referred_id (UNIQUE) so parallel calls queue here.
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "referrals" WHERE "referred_id" = ${transaction.userId} FOR UPDATE`,
      );

      const referral = await tx.referral.findUnique({
        where: { referredId: transaction.userId },
        select: { id: true, referrerId: true, qualifiedAt: true, qualifiedTransactionId: true },
      });

      if (!referral) return null;

      // Asked again under the lock a refund of this payer takes: the status
      // read above is from before it, and a refund reverses the referral
      // program before it marks the payment CANCELED (`REFERRAL_REVERSED_AT_KEY`).
      const current = await tx.transaction.findUnique({
        where: { id: transaction.id },
        select: { status: true, gatewayData: true },
      });
      if (current === null || current.status !== TransactionStatus.COMPLETED) return null;
      const gatewayData = readRecord(current.gatewayData);
      if (
        typeof gatewayData[REFERRAL_REVERSED_AT_KEY] === 'string' ||
        typeof gatewayData['refundReversedAt'] === 'string'
      ) {
        this.logger.debug(`Skipping qualification for ${transactionId}: the payment was refunded`);
        return null;
      }

      // THIS payment already produced its rewards: a replayed webhook, the
      // manual-attach replay, or a second worker that queued on the lock. The
      // `qualifiedTransactionId` half covers payments that qualified before
      // rewards were keyed per payment — their rows carry no `source_key`, and
      // without it a replay of such a payment would pay it a second time.
      if (referral.qualifiedTransactionId === transaction.id) return null;
      const alreadyRewarded = await tx.referralReward.count({
        where: {
          sourceKey: {
            in: [
              referralPaymentRewardSourceKey(transaction.id, 1),
              referralPaymentRewardSourceKey(transaction.id, 2),
            ],
          },
        },
      });
      if (alreadyRewarded > 0) return null;

      // «Только при первом платеже» means the first payment that QUALIFIES —
      // whatever it bought, but past every gate above. It used to be decided
      // by purchase type — only NEW and UPGRADE could qualify — so a first
      // payment that was a renewal of a promo-code subscription, or a second
      // subscription bought on top of a trial, paid the inviter nothing, ever.
      //
      // `qualifiedAt` alone decides, not a count of earlier payments. Counting
      // them let a payment that earned nothing take the place for good: a plan
      // outside eligiblePlanIds, a payment made while the program was paused,
      // or one made while an earlier, since refunded, payment held the
      // qualification — so the refund promised the next payment a
      // qualification and the count took it away. A payment that fails a gate
      // returns before anything is stamped, and a refund clears the stamp.
      if (settings.accrual_strategy === 'ON_FIRST_PAYMENT') {
        if (referral.qualifiedAt !== null) return null;
        // A referral imported together with its donor's rewards was already
        // paid for in the donor system, so its first payment HERE is not the
        // first payment of that referral. The Bedolaga and Remnashop importers
        // create such edges without `qualifiedAt` (Stealthnet's sync stamps it
        // for exactly this reason), and their donor payments may not have been
        // imported at all, so the earlier-payment count below cannot see them.
        const importedRewards = await tx.referralReward.count({
          where: {
            referralId: referral.id,
            sourceKey: { not: null },
            NOT: { sourceKey: { startsWith: REFERRAL_PAYMENT_SOURCE_KEY_PREFIX } },
          },
        });
        if (importedRewards > 0) {
          this.logger.debug(
            `Skipping qualification: referral ${referral.id} was imported with its donor rewards`,
          );
          return null;
        }
      }

      // `qualifiedAt` keeps meaning "first qualified" under both strategies:
      // it is what the referral tables count and what invite-friends quests
      // react to (`referral.qualified`), so a later payment under «При каждом
      // платеже» earns a reward without re-qualifying the referral.
      const firstQualification = referral.qualifiedAt === null;
      if (firstQualification) {
        await tx.referral.update({
          where: { id: referral.id },
          data: {
            qualifiedAt: new Date(),
            qualifiedTransactionId: transaction.id,
            qualifiedPurchaseChannel: transaction.channel,
          },
        });
      }

      const rewards = await this.createConfiguredRewards(tx, {
        referralId: referral.id,
        referrerId: referral.referrerId,
        reward: settings.reward,
        sourceTransactionId: transaction.id,
      });

      return { referral, firstQualification, rewards };
      }),
    );

    if (outcome === null) return null;

    // Post-commit — never fires for duplicate/skipped calls.
    if (outcome.firstQualification) {
      this.events.info(
        EVENT_TYPES.REFERRAL_QUALIFIED,
        'REFERRAL',
        'Referral qualified after purchase',
        {
          referralId: outcome.referral.id,
          referrerId: outcome.referral.referrerId,
          referredUserId: transaction.userId,
          userId: transaction.userId,
          transactionId: transaction.id,
        },
      );
    }

    for (const reward of outcome.rewards.issued) {
      // A failed enqueue does not undo the grant: the job row committed with
      // it, and the profile-sync sweep re-drives PENDING jobs. Same order and
      // same reasoning as `AdminRewardsService.issueOne`.
      if (reward.syncJobId !== null) {
        try {
          await this.profileSyncQueue.enqueue(reward.syncJobId);
        } catch (error: unknown) {
          this.logger.warn(
            `Referral reward ${reward.id} issued but sync enqueue failed (sweep will recover): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      // The metadata keys are the ones `AdminRewardsService.issueOne` sends and
      // `USER_EVENT_WHITELIST['referral.reward_issued']` projects for the
      // earner: without `referrerId`, `rewardType` and `rewardValue` the
      // cabinet is told nothing. `issuedBy: null` is how the schema spells
      // "issued automatically".
      this.events.info(
        EVENT_TYPES.REFERRAL_REWARD_ISSUED,
        'REFERRAL',
        'Referral reward issued automatically after a payment',
        {
          rewardId: reward.id,
          referralId: reward.referralId,
          userId: reward.userId,
          referrerId: reward.userId,
          rewardType: reward.type,
          rewardValue: reward.amount,
          issuedBy: null,
          automatic: true,
          transactionId: transaction.id,
          syncJobId: reward.syncJobId,
        },
      );
    }

    for (const reward of outcome.rewards.pending) {
      this.logger.warn(
        `Referral reward ${reward.id} (${reward.type} ${reward.amount}) for user ${reward.userId} ` +
          `left pending after transaction ${transaction.id}: ${reward.refusal.kind}. ` +
          'Issue it from the panel once it can be granted.',
      );
    }

    if (outcome.rewards.issued.length === 0 && outcome.rewards.pending.length === 0) {
      return null;
    }
    return {
      transactionId: transaction.id,
      issued: outcome.rewards.issued,
      pending: outcome.rewards.pending,
    };
  }

  /**
   * Explicit admin qualification for a valid, already attached edge. The
   * operation is idempotent and creates the configured reward rows, but — unlike
   * the payment path — leaves them PENDING for the reviewed «Выдать» workflow
   * (including profile sync for EXTRA_DAYS). A qualification that no payment
   * produced is an operator's judgement call, and so is paying for it; the
   * owner's «Сразу автоматически» was about the friend who paid.
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
    const result = await this.withConflictRetry(`manual qualification of ${input.referredUserId}`, () =>
      this.prismaService.$transaction(async (tx) => {
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
      const rewards = await this.createConfiguredRewards(tx, {
        referralId: referral.id,
        referrerId: referral.referrerId,
        reward: settings.reward,
        grantedBy: input.actorAdminId,
      });
      return {
        referralId: referral.id,
        referrerId: referral.referrerId,
        qualified: true,
        rewardsCreated: rewards.created,
      };
      }),
    );

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
   * Reverses what a now-refunded / charged-back transaction earned in the
   * referral program, and nothing else:
   *   - every reward keyed on THIS payment (`referralPaymentRewardSourceKey`),
   *     at both levels, on whichever referral row it sits;
   *   - when THIS payment is the one that qualified the referral, what that
   *     qualification produced without a per-payment key: the unkeyed rows —
   *     only when the payment has no keyed reward at all, i.e. it qualified
   *     before rewards were keyed (a newer qualification's unkeyed neighbours
   *     are manual grants and older history) — and rewards imported with their
   *     donor's own `source_key` — only when the payment is itself imported
   *     (`planSnapshot.importedFrom`). A local payment that became the first
   *     qualification of an imported referral used to take the donor history
   *     back with it: refunding a 100-point payment took 600;
   *   - and the qualification itself, which moves to the earliest payment on
   *     the referral that still holds its reward (under «При каждом платеже» a
   *     later payment keeps the referral qualified) or is cleared when there is
   *     none.
   *
   * Each reward:
   *   - pending (not issued) → mark revoked (never pays out);
   *   - already issued → `reverseReferralRewardEffect` takes the effect back
   *     (floored POINTS debit; EXTRA_DAYS off the subscription that got them,
   *     with a sync job so Remnawave follows) and the reward is marked revoked so
   *     it can't be reversed twice.
   *
   * Locking: the payer's referral row is taken FOR UPDATE first — the row every
   * qualification of the payer locks first — and rewards are reversed level 1
   * before level 2. The reversal used to write wallets and subscriptions first
   * and touch the referral row last, the opposite order to a qualification, and
   * a refund racing the payer's next payment (or a payment by one of his
   * invitees, whose level-2 reward sits on this row) could deadlock; PostgreSQL
   * then aborted one of them, and the aborted refund's rewards were never taken
   * back. It also meant a refund reading before a concurrent qualification of the
   * same payment committed found nothing to reverse. Under that lock the
   * payment is stamped `REFERRAL_REVERSED_AT_KEY`, so its own reward hook, if it
   * runs after this, issues nothing. The rewards themselves are locked before
   * their state is read: «Выдать» locks the reward row, and a reversal that read
   * `isIssued` first marked revoked a reward whose issue committed a moment
   * later, with the days or points still granted.
   *
   * Idempotent: an already-revoked reward is skipped and an already-cleared
   * qualification is left alone. All writes run in one transaction, run again
   * when PostgreSQL aborts it on a conflict; sync jobs are enqueued after commit.
   */
  public async reverseQualificationForTransaction(transactionId: string): Promise<void> {
    try {
      const payment = await this.prismaService.transaction.findUnique({
        where: { id: transactionId },
        select: { userId: true, planSnapshot: true },
      });
      const importedPayment =
        payment !== null && readOptionalString(readRecord(payment.planSnapshot), 'importedFrom') !== null;
      const paymentKeys = [
        referralPaymentRewardSourceKey(transactionId, 1),
        referralPaymentRewardSourceKey(transactionId, 2),
      ];

      const syncJobIds = await this.withConflictRetry(`referral reversal of ${transactionId}`, () =>
        this.prismaService.$transaction(async (tx) => {
        if (payment !== null) {
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "referrals" WHERE "referred_id" = ${payment.userId} FOR UPDATE`,
          );
          await stampReferralReversal(tx, transactionId);
        }

        // Revoked ones included: whether this payment ever had keyed rewards is
        // what says which kind of qualification it was, and a replayed refund
        // must answer that the same way the first one did.
        const keyed = await tx.referralReward.findMany({
          where: { sourceKey: { in: paymentKeys } },
          select: { id: true, sourceKey: true, revokedAt: true },
        });
        const referral = await tx.referral.findFirst({
          where: { qualifiedTransactionId: transactionId },
          select: { id: true },
        });

        // What the qualification produced without a per-payment key — see the
        // list above. `NOT startsWith` alone drops NULL keys (SQL's NOT on a NULL
        // LIKE), so the unkeyed rows are asked for on their own.
        const unkeyedFilters: Prisma.ReferralRewardWhereInput[] = [];
        if (referral !== null && keyed.length === 0) unkeyedFilters.push({ sourceKey: null });
        if (referral !== null && importedPayment) {
          unkeyedFilters.push({ NOT: { sourceKey: { startsWith: REFERRAL_PAYMENT_SOURCE_KEY_PREFIX } } });
        }
        const ofTheQualification =
          referral === null || unkeyedFilters.length === 0
            ? []
            : await tx.referralReward.findMany({
                where: { referralId: referral.id, revokedAt: null, OR: unkeyedFilters },
                select: { id: true },
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              });

        // Level 1 before level 2 — see "Locking" above. Keys sort `…:L1` before
        // `…:L2`; the qualification's other rewards follow.
        const orderedIds = [
          ...keyed
            .filter((reward) => reward.revokedAt === null)
            .sort((a, b) => (a.sourceKey ?? '').localeCompare(b.sourceKey ?? ''))
            .map((reward) => reward.id),
          ...ofTheQualification.map((reward) => reward.id),
        ];

        const now = new Date();
        const jobs: string[] = [];
        if (orderedIds.length > 0) {
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "referral_rewards" WHERE "id" IN (${Prisma.join(orderedIds)}) ORDER BY "id" FOR UPDATE`,
          );
          const locked = await tx.referralReward.findMany({
            where: { id: { in: orderedIds }, revokedAt: null },
            select: {
              id: true,
              referralId: true,
              userId: true,
              type: true,
              amount: true,
              isIssued: true,
            },
          });
          const lockedById = new Map(locked.map((reward) => [reward.id, reward]));
          for (const rewardId of orderedIds) {
            const reward = lockedById.get(rewardId);
            // Revoked while this waited for the lock: someone else took it back.
            if (reward === undefined) continue;
            if (reward.isIssued) {
              const effect = await reverseReferralRewardEffect(tx, this.pointsWallet, reward, {
                transactionId,
              });
              if (effect.syncJobId !== null) jobs.push(effect.syncJobId);
            }
            await tx.referralReward.update({
              where: { id: reward.id },
              data: { revokedAt: now, revokeReason: `Refund/chargeback on transaction ${transactionId}` },
            });
          }
        }

        if (referral !== null) {
          // The earliest payment on this referral whose level-1 reward still
          // stands takes the qualification over; with none, a legitimate later
          // re-payment can re-qualify.
          const remaining = await tx.referralReward.findFirst({
            where: {
              referralId: referral.id,
              revokedAt: null,
              sourceKey: { startsWith: REFERRAL_PAYMENT_SOURCE_KEY_PREFIX, endsWith: ':L1' },
            },
            select: { sourceKey: true, createdAt: true },
            orderBy: { createdAt: 'asc' },
          });
          const nextTransactionId =
            remaining?.sourceKey
              ?.slice(REFERRAL_PAYMENT_SOURCE_KEY_PREFIX.length)
              .replace(/:L1$/, '') ?? null;
          const nextTransaction =
            nextTransactionId === null
              ? null
              : await tx.transaction.findUnique({
                  where: { id: nextTransactionId },
                  select: { id: true, channel: true },
                });
          await tx.referral.update({
            where: { id: referral.id },
            data:
              nextTransaction !== null && remaining !== null
                ? {
                    qualifiedAt: remaining.createdAt,
                    qualifiedTransactionId: nextTransaction.id,
                    qualifiedPurchaseChannel: nextTransaction.channel,
                  }
                : { qualifiedAt: null, qualifiedTransactionId: null, qualifiedPurchaseChannel: null },
          });
        }
        return jobs;
        }),
      );

      for (const syncJobId of syncJobIds) {
        try {
          await this.profileSyncQueue.enqueue(syncJobId);
        } catch (error: unknown) {
          this.logger.warn(
            `Referral reward reversal for transaction ${transactionId}: sync enqueue failed (sweep will recover): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
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

  /**
   * Runs one of this service's transactions, again from the start when
   * PostgreSQL aborted it to break a deadlock or a serialization conflict
   * (`isRetryableTransactionConflict`). The whole transaction was rolled back
   * and every check in it is re-read, so a second run is the same decision on
   * fresh rows. The callers log and swallow what finally throws, and a lost
   * reward or reversal was never retried by anything else.
   */
  private async withConflictRetry<T>(what: string, run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await run();
      } catch (error: unknown) {
        if (attempt >= MAX_TRANSACTION_ATTEMPTS || !isRetryableTransactionConflict(error)) throw error;
        this.logger.warn(`${what}: PostgreSQL aborted the transaction on a conflict, running it again (${attempt + 1}/${MAX_TRANSACTION_ATTEMPTS})`);
      }
    }
  }

  /**
   * The plans a payment bought: its snapshot's own `id`, and for a combined
   * renewal the plan of every item — its snapshot names none.
   */
  private async purchasedPlanIds(transactionId: string, planSnapshot: unknown): Promise<string[]> {
    const ids = new Set<string>();
    const ownPlanId = readOptionalString(readRecord(planSnapshot), 'id');
    if (ownPlanId !== null) ids.add(ownPlanId);
    const items = await this.prismaService.transactionItem.findMany({
      where: { transactionId },
      select: { planId: true },
    });
    for (const item of items) ids.add(item.planId);
    return [...ids];
  }

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
      /**
       * The payment that earned the rewards. The payment path passes it: the
       * rows are keyed on it and issued on the spot. The manual qualification
       * does not: its rows carry no key and stay pending for «Выдать».
       */
      readonly sourceTransactionId?: string;
    },
  ): Promise<ConfiguredRewardsResult> {
    const nothing: ConfiguredRewardsResult = { created: 0, issued: [], pending: [] };
    if (!input.reward) return nothing;
    const referrerPartner = await tx.partner.findUnique({
      where: { userId: input.referrerId },
      select: { isActive: true },
    });
    if (referrerPartner?.isActive === true) return nothing;

    const rewardType =
      input.reward.type === 'EXTRA_DAYS'
        ? ReferralRewardType.EXTRA_DAYS
        : ReferralRewardType.POINTS;
    let created = 0;
    const issued: AutomaticallyIssuedReferralReward[] = [];
    const pending: PendingReferralReward[] = [];

    const createReward = async (row: {
      readonly referralId: string;
      readonly userId: string;
      readonly amount: number;
      readonly level: 1 | 2;
    }): Promise<void> => {
      const reward = await tx.referralReward.create({
        data: {
          referralId: row.referralId,
          userId: row.userId,
          type: rewardType,
          amount: row.amount,
          ...(input.grantedBy ? { grantedBy: input.grantedBy } : {}),
          ...(input.sourceTransactionId !== undefined
            ? { sourceKey: referralPaymentRewardSourceKey(input.sourceTransactionId, row.level) }
            : {}),
        },
        select: { id: true, referralId: true, userId: true, type: true, amount: true },
      });
      created += 1;
      if (input.sourceTransactionId === undefined) return;

      // The shared effect, the same one «Выдать» applies. A refusal comes back
      // as a value, so the reward simply stays pending and the payment's
      // qualification — already written in this transaction — stands.
      const effect = await applyReferralRewardEffect(tx, this.pointsWallet, reward);
      if (!effect.applied) {
        pending.push({ ...reward, refusal: effect.refusal });
        return;
      }
      await tx.referralReward.update({
        where: { id: reward.id },
        data: { isIssued: true, issuedAt: new Date(), issuedBy: null },
      });
      issued.push({ ...reward, syncJobId: effect.syncJobId });
    };

    const firstAmount = input.reward.config.FIRST ?? 0;
    const secondAmount = input.reward.config.SECOND ?? 0;

    // The level-2 reward is inserted on the INVITER's referral row, and that
    // insert waits for any refund of the inviter's own payment holding the row.
    // Taken here, before the level-1 credit locks the inviter's wallet: taken at
    // the insert, this transaction held the wallet a refund of the inviter
    // needed (for a grant to him on that row) while waiting for the row the
    // refund held, PostgreSQL aborted one of them, and the lost side's work was
    // only logged. Same order as the reversal: referral rows, then wallets.
    const l2Referral =
      secondAmount > 0
        ? await (async () => {
            await tx.$queryRaw(
              Prisma.sql`SELECT "id" FROM "referrals" WHERE "referred_id" = ${input.referrerId} FOR UPDATE`,
            );
            return tx.referral.findUnique({
              where: { referredId: input.referrerId },
              select: { id: true, referrerId: true },
            });
          })()
        : null;

    if (firstAmount > 0) {
      await createReward({
        referralId: input.referralId,
        userId: input.referrerId,
        amount: firstAmount,
        level: 1,
      });
    }

    if (secondAmount > 0) {
      if (l2Referral) {
        const l2Partner = await tx.partner.findUnique({
          where: { userId: l2Referral.referrerId },
          select: { isActive: true },
        });
        if (l2Partner?.isActive !== true) {
          await createReward({
            referralId: l2Referral.id,
            userId: l2Referral.referrerId,
            amount: secondAmount,
            level: 2,
          });
        }
      }
    }

    return { created, issued, pending };
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

/**
 * See `REFERRAL_REVERSED_AT_KEY`. A payment already stamped is left as it is.
 *
 * The stamp is merged by PostgreSQL onto what the payment holds when it is
 * written (`writeTransactionGatewayData`). The lock held here is the payer's
 * referral row, not the payment's, and the copy read above used to be written
 * back whole: a «Мой налог» receipt or a refund recorded on the payment in
 * between was erased. Without its receipt, the refund's cancellation found
 * nothing to cancel, and the income stayed declared.
 */
async function stampReferralReversal(tx: Prisma.TransactionClient, transactionId: string): Promise<void> {
  const row = await tx.transaction.findUnique({
    where: { id: transactionId },
    select: { gatewayData: true },
  });
  if (row === null) return;
  if (typeof readRecord(row.gatewayData)[REFERRAL_REVERSED_AT_KEY] === 'string') return;
  await writeTransactionGatewayData(tx, transactionId, {
    merge: { [REFERRAL_REVERSED_AT_KEY]: new Date().toISOString() },
  });
}

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

  // Every payment only when the stored value SAYS so — the form's
  // `ON_EACH_PAYMENT` or the legacy `ON_EVERY_PAYMENT`. Anything else,
  // including no key at all, is the first payment only.
  //
  // It used to be the other way round: only `ON_FIRST_PAYMENT` restricted, and
  // an absent key meant every payment. That was invisible while a referral paid
  // out once whatever the strategy said; with a reward per payment it would
  // quietly pay every renewal on installs whose settings carry no key (the
  // legacy nested `reward` shape, a hand-written row) — while the panel's form
  // shows exactly those installs «Только при первом платеже», its default for a
  // missing key. The engine now reads a missing key the way the operator sees it.
  const accrual = record['accrualStrategy'] ?? record['accrual_strategy'];
  result.accrual_strategy =
    accrual === 'ON_EACH_PAYMENT' || accrual === 'ON_EVERY_PAYMENT'
      ? 'ON_EVERY_PAYMENT'
      : 'ON_FIRST_PAYMENT';

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
