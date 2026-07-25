import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  Currency,
  ImportStatus,
  Locale,
  PaymentGatewayType,
  Prisma,
  PurchaseChannel,
  PurchaseType,
  ReferralInviteSource,
  ReferralRewardType,
  SubscriptionStatus,
  TransactionStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import { ImportSummary } from '../interfaces/import-summary.interface';
import {
  buildPanelLookup,
  isLivePanelStatus,
  panelSubscriptionState,
  reconcileMissingPanelStatus,
  resolvePanelProfile,
  type PanelLookup,
} from '../utils/remnawave-overlay.util';
import {
  RemnashopPlan,
  RemnashopPlanDuration,
  RemnashopPlanPrice,
} from '../utils/remnashop-backup-parser';

/**
 * Shape of a remnashop user record as exported from the remnashop PostgreSQL DB.
 * Matches the `users` table joined with `subscriptions`.
 */
export interface RemnashopUser {
  /** Auto-increment PK from remnashop */
  readonly id: number;
  /** Telegram user ID */
  readonly telegram_id: number;
  /** Telegram @username */
  readonly username: string | null;
  /** Personal referral code */
  readonly referral_code: string | null;
  /** Display name */
  readonly name: string | null;
  /** Role enum: USER=1, PREVIEW=2, ADMIN=3, DEV=4, OWNER=5, SYSTEM=6 */
  readonly role: number;
  /** Locale code (e.g. 'EN', 'RU') */
  readonly language: string | null;
  /** Personal discount percent */
  readonly personal_discount: number;
  /** Purchase discount percent */
  readonly purchase_discount: number;
  /** Loyalty/referral points */
  readonly points: number;
  /** Admin-blocked flag */
  readonly is_blocked: boolean;
  /** User blocked the bot */
  readonly is_bot_blocked: boolean;
  /** Rules acceptance flag */
  readonly is_rules_accepted: boolean;
  /** Whether trial is available */
  readonly is_trial_available: boolean;
  /** ISO timestamp */
  readonly created_at: string;
  /** ISO timestamp */
  readonly updated_at: string;
}

/**
 * Shape of a remnashop subscription record.
 */
export interface RemnashopSubscription {
  /** Auto-increment PK */
  readonly id: number;
  /** Remnawave user UUID */
  readonly user_remna_id: string | null;
  /** Owner's telegram_id */
  readonly user_telegram_id: number;
  /** Status: ACTIVE, DISABLED, LIMITED, EXPIRED, DELETED */
  readonly status: string;
  /** Trial subscription flag */
  readonly is_trial: boolean;
  /** Traffic limit (bytes or GB depending on version) */
  readonly traffic_limit: number;
  /** Max devices */
  readonly device_limit: number;
  /** Traffic limit strategy: NO_RESET, DAY, WEEK, MONTH, YEAR */
  readonly traffic_limit_strategy: string | null;
  /** Optional tag */
  readonly tag: string | null;
  /** Remnawave inbound squad UUIDs */
  readonly internal_squads: string[];
  /** External squad UUID */
  readonly external_squad: string | null;
  /** Expiration timestamp (ISO) */
  readonly expire_at: string | null;
  /** Subscription connect URL */
  readonly url: string | null;
  /** Frozen plan data at purchase time */
  readonly plan_snapshot: Record<string, unknown> | null;
  /** ISO timestamp */
  readonly created_at: string;
}

/** Historical checkout row. It is imported as an audit-only transaction. */
export interface RemnashopTransaction {
  readonly id: number;
  readonly payment_id: string | null;
  readonly user_telegram_id: number;
  readonly status: string;
  readonly is_test: boolean;
  readonly purchase_type: string;
  readonly gateway_type: string;
  readonly pricing: Record<string, unknown> | null;
  readonly currency: string;
  readonly plan_snapshot: Record<string, unknown> | null;
  readonly created_at: string;
}

/** Direct referral edge from the RemnaShop bot database. */
export interface RemnashopReferral {
  readonly id: number;
  readonly referrer_telegram_id: number;
  readonly referred_telegram_id: number;
  readonly level: string;
  readonly created_at: string;
}

/** Historical referral reward. Creating it must never credit points again. */
export interface RemnashopReferralReward {
  readonly id: number;
  readonly referral_id: number;
  readonly user_telegram_id: number;
  readonly type: string;
  readonly amount: number;
  readonly is_issued: boolean;
  readonly created_at: string;
}

/** Counts of intentionally excluded secret-bearing or runtime-only donor data. */
export interface RemnashopExcludedDataSummary {
  readonly settings: number;
  readonly paymentGateways: number;
  readonly broadcasts: number;
  readonly broadcastMessages: number;
}

interface RunInput {
  readonly mode: 'import' | 'sync';
  readonly createdBy: string | null;
  /** Pre-allocated `ImportRecord.id` to update instead of creating new. */
  readonly importRecordId?: string | null;
  readonly users: readonly RemnashopUser[];
  readonly subscriptions: readonly RemnashopSubscription[];
  readonly transactions?: readonly RemnashopTransaction[];
  readonly referrals?: readonly RemnashopReferral[];
  readonly referralRewards?: readonly RemnashopReferralReward[];
  readonly excludedData?: RemnashopExcludedDataSummary;
  /** See remnashop-backup-parser.ts for shape. */
  readonly plans?: readonly RemnashopPlan[];
  readonly planDurations?: readonly RemnashopPlanDuration[];
  readonly planPrices?: readonly RemnashopPlanPrice[];
}

/**
 * Importer for remnashop (Python/SQLAlchemy) data.
 *
 * Expects two JSON arrays: users + subscriptions (exported from remnashop's
 * PostgreSQL database).
 *
 * Matching priority:
 *   1. telegram_id → match by telegramId
 *   2. No match → create new User (import mode only)
 *
 * After matching/creating a User:
 *   - Creates or updates Subscriptions linked by user_remna_id (Remnawave UUID)
 */
@Injectable()
export class RemnashopImporterService {
  private readonly logger = new Logger(RemnashopImporterService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
  ) {}

  public async run(input: RunInput): Promise<ImportSummary> {
    const {
      users,
      subscriptions,
      transactions = [],
      referrals = [],
      referralRewards = [],
      excludedData,
      mode,
      createdBy,
      importRecordId,
      plans,
      planDurations,
      planPrices,
    } = input;

    if (!users || users.length === 0) {
      throw new BadRequestException('No user records provided');
    }

    // Index subscriptions by telegram_id for fast lookup
    const subsByTelegramId = new Map<number, RemnashopSubscription[]>();
    for (const sub of subscriptions ?? []) {
      const existing = subsByTelegramId.get(sub.user_telegram_id) ?? [];
      existing.push(sub);
      subsByTelegramId.set(sub.user_telegram_id, existing);
    }

    const transactionsByTelegramId = new Map<number, RemnashopTransaction[]>();
    for (const transaction of transactions) {
      const existing = transactionsByTelegramId.get(transaction.user_telegram_id) ?? [];
      existing.push(transaction);
      transactionsByTelegramId.set(transaction.user_telegram_id, existing);
    }

    // Live Remnawave snapshot for the read-only cross-check (scales past the
    // bulk ceiling via per-UUID fallback; fail-soft to backup if unreachable).
    const panelLookup = await buildPanelLookup(() => this.remnawaveApiService.getAllPanelUsers());

    const errors: string[] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let subscriptionsCreated = 0;
    let subscriptionsUpdated = 0;
    let transactionsCreated = 0;
    let transactionsExisting = 0;
    let transactionsSkipped = 0;
    const createdUserIds: string[] = [];
    const userIdsByTelegramId = new Map<number, string>();
    const conflictCounts = {
      missingStableIdentity: 0,
      subscriptionOwnerMismatch: 0,
      panelOwnerMismatch: 0,
      nonDirectReferral: 0,
      referralConflict: 0,
      partnerAttribution: 0,
      referralRewardSkipped: 0,
    };

    for (const remnashopUser of users) {
      try {
        const user = await this.matchOrCreateUser(remnashopUser, mode);
        if (user === null) {
          skipped += 1;
          conflictCounts.missingStableIdentity += 1;
          continue;
        }
        const userId = user.id;
        userIdsByTelegramId.set(remnashopUser.telegram_id, userId);

        if (user.created) {
          created += 1;
          createdUserIds.push(userId);
        } else {
          updated += 1;
        }

        // Sync subscriptions for this user
        const userSubs = subsByTelegramId.get(remnashopUser.telegram_id) ?? [];
        for (const sub of userSubs) {
          const subResult = await this.syncSubscription(
            userId,
            remnashopUser.telegram_id,
            sub,
            panelLookup,
          );
          if (subResult === 'created') subscriptionsCreated += 1;
          if (subResult === 'updated') subscriptionsUpdated += 1;
          if (subResult === 'owner-mismatch') conflictCounts.subscriptionOwnerMismatch += 1;
          if (subResult === 'panel-owner-mismatch') conflictCounts.panelOwnerMismatch += 1;
        }

        // Historical rows are imported for audit only: no checkout, payment
        // provider or subscription fulfillment code is invoked here.
        const userTransactions = transactionsByTelegramId.get(remnashopUser.telegram_id) ?? [];
        for (const transaction of userTransactions) {
          const outcome = await this.importTransaction(userId, transaction);
          if (outcome === 'created') transactionsCreated += 1;
          else if (outcome === 'existing') transactionsExisting += 1;
          else transactionsSkipped += 1;
        }
      } catch (err) {
        const message = `source user ${remnashopUser.id}: ${(err as Error).message}`;
        if (errors.length < 50) errors.push(message);
        this.logger.warn(`remnashop importer row failed: ${message}`);
      }
    }

    let referralResult = { created: 0, existing: 0, rewardsCreated: 0, rewardsExisting: 0 };
    try {
      referralResult = await this.importReferrals({
        referrals,
        referralRewards,
        userIdsByTelegramId,
        conflictCounts,
      });
    } catch (error) {
      const message = `referral history failed: ${(error as Error).message}`;
      if (errors.length < 50) errors.push(message);
      this.logger.error(`remnashop import ${message}`);
    }

    const finalStatus = errors.length === 0 ? ImportStatus.COMMITTED : ImportStatus.FAILED;
    const resultPayload: Prisma.InputJsonValue = {
      mode,
      fetched: users.length,
      created,
      updated,
      skipped,
      subscriptionsCreated,
      subscriptionsUpdated,
      transactionsProcessed: transactions.length,
      transactionsCreated,
      transactionsExisting,
      transactionsSkipped,
      referralsProcessed: referrals.length,
      referralsCreated: referralResult.created,
      referralsExisting: referralResult.existing,
      referralRewardsProcessed: referralRewards.length,
      referralRewardsCreated: referralResult.rewardsCreated,
      referralRewardsExisting: referralResult.rewardsExisting,
      conflictCounts,
      excludedData: JSON.parse(
        JSON.stringify(
          excludedData ?? {
            settings: 0,
            paymentGateways: 0,
            broadcasts: 0,
            broadcastMessages: 0,
          },
        ),
      ) as Prisma.InputJsonValue,
      errors,
      // We never claim to undo history written onto matched local users: their
      // pre-import state is unknown, so rollback must fail closed for that run.
      rollback: { createdUserIds, hasMatchedWrites: updated > 0 },
      // Catalog snapshot — see altshop-importer.service.ts.
      catalog: JSON.parse(
        JSON.stringify({
          plans: plans ?? [],
          planDurations: planDurations ?? [],
          planPrices: planPrices ?? [],
        }),
      ),
    };
    const errorMessage = errors.length === 0 ? null : errors.slice(0, 5).join('; ');

    // See remnawave-importer.service.ts for rationale: when a pre-allocated
    // ImportRecord exists (queue producer made one), update it instead of
    // creating a parallel row that the SPA cannot find.
    const importRecord = importRecordId
      ? await this.prismaService.importRecord.update({
          where: { id: importRecordId },
          data: {
            status: finalStatus,
            recordsTotal: users.length,
            recordsOk: created + updated,
            recordsFailed: errors.length,
            result: resultPayload,
            errorMessage,
            committedAt: new Date(),
          },
        })
      : await this.prismaService.importRecord.create({
          data: {
            filename: `remnashop-${mode}-${new Date().toISOString()}.json`,
            sourceType: 'remnashop',
            status: finalStatus,
            recordsTotal: users.length,
            recordsOk: created + updated,
            recordsFailed: errors.length,
            result: resultPayload,
            errorMessage,
            createdBy,
            committedAt: new Date(),
          },
        });

    return {
      importRecordId: importRecord.id,
      fetched: users.length,
      created,
      updated,
      skipped,
      subscriptionsCreated,
      subscriptionsUpdated,
      errors,
    };
  }

  // ── User matching ─────────────────────────────────────────────────────────

  private async matchOrCreateUser(
    remnashopUser: RemnashopUser,
    mode: 'import' | 'sync',
  ): Promise<{ id: string; created: boolean } | null> {
    // The donor auto-increment id is not a safe cross-system identity. A
    // missing Telegram id would create a duplicate on every retry.
    if (!Number.isSafeInteger(remnashopUser.telegram_id) || remnashopUser.telegram_id <= 0) {
      return null;
    }

    const user = await this.prismaService.user.findUnique({
      where: { telegramId: BigInt(remnashopUser.telegram_id) },
      select: { id: true },
    });
    if (user) {
      await this.updateUserFields(user.id, remnashopUser);
      return { id: user.id, created: false };
    }

    // No match — create (import mode only)
    if (mode === 'sync') {
      return null;
    }

    const newUser = await this.prismaService.user.create({
      data: {
        telegramId: BigInt(remnashopUser.telegram_id),
        username: remnashopUser.username || null,
        name: remnashopUser.name || remnashopUser.username || `remnashop-${remnashopUser.id}`,
        language: this.mapLocale(remnashopUser.language),
        personalDiscount: remnashopUser.personal_discount,
        purchaseDiscount: remnashopUser.purchase_discount,
        // Matched accounts retain their current balance. Fresh accounts start
        // with legacy points; imported reward rows are audit-only.
        points: Math.max(0, remnashopUser.points),
        isBlocked: remnashopUser.is_blocked,
        isBotBlocked: remnashopUser.is_bot_blocked,
        isRulesAccepted: remnashopUser.is_rules_accepted,
      },
    });
    return { id: newUser.id, created: true };
  }

  private async updateUserFields(userId: string, remnashopUser: RemnashopUser): Promise<void> {
    const data: Prisma.UserUpdateInput = {};
    if (remnashopUser.username) data.username = remnashopUser.username;
    if (remnashopUser.name) data.name = remnashopUser.name;
    if (remnashopUser.personal_discount > 0)
      data.personalDiscount = remnashopUser.personal_discount;
    if (remnashopUser.purchase_discount > 0)
      data.purchaseDiscount = remnashopUser.purchase_discount;
    data.isBlocked = remnashopUser.is_blocked;
    data.isBotBlocked = remnashopUser.is_bot_blocked;
    if (Object.keys(data).length > 0) {
      await this.prismaService.user.update({ where: { id: userId }, data });
    }
  }

  // ── Subscription sync ─────────────────────────────────────────────────────

  private async syncSubscription(
    userId: string,
    expectedTelegramId: number,
    sub: RemnashopSubscription,
    panelLookup: PanelLookup,
  ): Promise<'created' | 'updated' | 'skipped' | 'owner-mismatch' | 'panel-owner-mismatch'> {
    // If subscription has a Remnawave UUID, use it as the unique key
    if (sub.user_remna_id) {
      const existing = await this.prismaService.subscription.findFirst({
        where: { remnawaveId: sub.user_remna_id },
        select: { id: true, userId: true, planSnapshot: true },
      });

      // Remnawave is the truth: if the panel still has this profile, overlay
      // its FRESH state (active subscriptions become accurate). If it's gone,
      // keep the backup's own (stale) state as-is — the user re-buys via bot.
      const { panel, known } = await resolvePanelProfile(sub.user_remna_id, panelLookup, (uuid) =>
        this.remnawaveApiService.getPanelUser(uuid),
      );
      // A donor backup is only a snapshot. It cannot authorize a transfer of a
      // live profile or overwrite an existing local ownership relation.
      if (panel && panel.telegramId !== null && panel.telegramId !== expectedTelegramId) {
        return 'panel-owner-mismatch';
      }
      if (existing && existing.userId !== userId) {
        return 'owner-mismatch';
      }
      const fresh = panel ? panelSubscriptionState(panel) : null;
      const status = fresh
        ? fresh.status
        : reconcileMissingPanelStatus(known, this.mapStatus(sub.status));
      const expiresAt = fresh ? fresh.expiresAt : this.parseOptionalDate(sub.expire_at);
      const trafficLimit = fresh
        ? fresh.trafficLimit
        : sub.traffic_limit > 0
          ? sub.traffic_limit
          : null;
      const deviceLimit = fresh ? fresh.deviceLimit : sub.device_limit;
      const internalSquads = fresh ? fresh.internalSquads : (sub.internal_squads ?? []);
      const externalSquad = fresh ? fresh.externalSquad : (sub.external_squad ?? null);
      const configUrl = fresh ? fresh.configUrl : sub.url || null;

      const subscriptionData: Prisma.SubscriptionUpdateInput = {
        status,
        isTrial: sub.is_trial,
        trafficLimit,
        deviceLimit,
        configUrl,
        expiresAt,
        internalSquads,
        externalSquad,
        planSnapshot: this.buildSubscriptionPlanSnapshot(sub, existing?.planSnapshot),
      };

      if (existing) {
        await this.prismaService.subscription.update({
          where: { id: existing.id },
          data: subscriptionData,
        });
        return 'updated';
      }

      const newSub = await this.prismaService.subscription.create({
        data: {
          user: { connect: { id: userId } },
          remnawaveId: sub.user_remna_id,
          status,
          isTrial: sub.is_trial,
          trafficLimit,
          deviceLimit,
          configUrl,
          expiresAt,
          startedAt: this.parseOptionalDate(sub.created_at) ?? new Date(),
          internalSquads,
          externalSquad,
          planSnapshot: this.buildSubscriptionPlanSnapshot(sub),
        },
      });

      // No ProfileSyncJob: import is READ-ONLY toward Remnawave (the truth) —
      // it never pushes the backup's possibly-stale state back, and gone/expired
      // profiles are not re-provisioned (the user re-buys via the bot).

      // Set as current subscription if user doesn't have one
      const user = await this.prismaService.user.findUnique({
        where: { id: userId },
        select: { currentSubscriptionId: true },
      });
      if (!user?.currentSubscriptionId && isLivePanelStatus(status)) {
        await this.prismaService.user.update({
          where: { id: userId },
          data: { currentSubscriptionId: newSub.id },
        });
      }

      return 'created';
    }

    return 'skipped';
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async importTransaction(
    userId: string,
    transaction: RemnashopTransaction,
  ): Promise<'created' | 'existing' | 'skipped'> {
    if (!Number.isSafeInteger(transaction.id) || transaction.id <= 0) return 'skipped';

    // Source payment ids are provider-local. Namespace the immutable donor row
    // id so it cannot collide with a live Rezeis checkout.
    const paymentId = 'remnashop:' + transaction.id;
    const existing = await this.prismaService.transaction.findUnique({
      where: { paymentId },
      select: { id: true },
    });
    if (existing) return 'existing';

    const gatewayType = this.mapGatewayType(transaction.gateway_type);
    const currency = this.mapCurrency(transaction.currency);
    const amount = this.extractAmount(transaction.pricing);
    if (!gatewayType || !currency || amount === null) return 'skipped';

    await this.prismaService.transaction.create({
      data: {
        user: { connect: { id: userId } },
        paymentId,
        status: this.mapTransactionStatus(transaction.status),
        purchaseType: this.mapPurchaseType(transaction.purchase_type),
        gatewayType,
        amount,
        currency,
        channel: PurchaseChannel.TELEGRAM,
        planSnapshot: {
          importedFrom: 'remnashop',
          sourceTransactionId: transaction.id,
          sourcePaymentId: transaction.payment_id,
          sourceIsTest: transaction.is_test,
          originalPricing: transaction.pricing as Prisma.InputJsonValue,
          originalPlanSnapshot: transaction.plan_snapshot as Prisma.InputJsonValue,
        },
        createdAt: this.parseOptionalDate(transaction.created_at) ?? new Date(),
      },
    });
    return 'created';
  }

  private async importReferrals(input: {
    readonly referrals: readonly RemnashopReferral[];
    readonly referralRewards: readonly RemnashopReferralReward[];
    readonly userIdsByTelegramId: ReadonlyMap<number, string>;
    readonly conflictCounts: {
      nonDirectReferral: number;
      referralConflict: number;
      partnerAttribution: number;
      referralRewardSkipped: number;
    };
  }): Promise<{
    readonly created: number;
    readonly existing: number;
    readonly rewardsCreated: number;
    readonly rewardsExisting: number;
  }> {
    const referralIdsBySourceId = new Map<number, { id: string; referrerId: string }>();
    let created = 0;
    let existing = 0;

    for (const referral of input.referrals) {
      if (!this.isDirectReferral(referral.level)) {
        input.conflictCounts.nonDirectReferral += 1;
        continue;
      }
      const referrerId = input.userIdsByTelegramId.get(referral.referrer_telegram_id);
      const referredId = input.userIdsByTelegramId.get(referral.referred_telegram_id);
      if (!referrerId || !referredId || referrerId === referredId) {
        input.conflictCounts.referralConflict += 1;
        continue;
      }

      const stored = await this.prismaService.referral.findUnique({
        where: { referredId },
        select: { id: true, referrerId: true },
      });
      if (stored) {
        if (stored.referrerId === referrerId) {
          existing += 1;
          referralIdsBySourceId.set(referral.id, stored);
        } else {
          input.conflictCounts.referralConflict += 1;
        }
        continue;
      }

      const partnerAttribution = await this.prismaService.partnerReferral.findFirst({
        where: { referralUserId: referredId },
        select: { id: true },
      });
      if (partnerAttribution) {
        input.conflictCounts.partnerAttribution += 1;
        continue;
      }

      try {
        const importedAt = this.parseOptionalDate(referral.created_at);
        const storedReferral = await this.prismaService.referral.create({
          data: {
            referrerId,
            referredId,
            level: 1,
            inviteSource: ReferralInviteSource.UNKNOWN,
            ...(importedAt ? { createdAt: importedAt } : {}),
          },
          select: { id: true, referrerId: true },
        });
        created += 1;
        referralIdsBySourceId.set(referral.id, storedReferral);
      } catch (error) {
        if (this.isUniqueConstraintError(error)) {
          const concurrent = await this.prismaService.referral.findUnique({
            where: { referredId },
            select: { id: true, referrerId: true },
          });
          if (concurrent?.referrerId === referrerId) {
            existing += 1;
            referralIdsBySourceId.set(referral.id, concurrent);
          } else {
            input.conflictCounts.referralConflict += 1;
          }
        } else {
          throw error;
        }
      }
    }

    let rewardsCreated = 0;
    let rewardsExisting = 0;
    for (const reward of input.referralRewards) {
      const sourceKey = 'remnashop:referral-reward:' + reward.id;
      const alreadyImported = await this.prismaService.referralReward.findUnique({
        where: { sourceKey },
        select: { id: true },
      });
      if (alreadyImported) {
        rewardsExisting += 1;
        continue;
      }

      const referral = referralIdsBySourceId.get(reward.referral_id);
      const sourceUserId = input.userIdsByTelegramId.get(reward.user_telegram_id);
      const type = this.mapReferralRewardType(reward.type);
      if (
        !referral ||
        !sourceUserId ||
        sourceUserId !== referral.referrerId ||
        !type ||
        reward.amount <= 0
      ) {
        input.conflictCounts.referralRewardSkipped += 1;
        continue;
      }

      const createdAt = this.parseOptionalDate(reward.created_at) ?? new Date();
      try {
        await this.prismaService.referralReward.create({
          data: {
            referralId: referral.id,
            userId: referral.referrerId,
            type,
            amount: reward.amount,
            isIssued: reward.is_issued,
            issuedAt: reward.is_issued ? createdAt : null,
            createdAt,
            sourceKey,
          },
        });
        rewardsCreated += 1;
      } catch (error) {
        if (this.isUniqueConstraintError(error)) rewardsExisting += 1;
        else throw error;
      }
    }

    return { created, existing, rewardsCreated, rewardsExisting };
  }

  private buildSubscriptionPlanSnapshot(
    sub: RemnashopSubscription,
    existingSnapshot?: Prisma.JsonValue,
  ): Prisma.InputJsonValue {
    // A plan cloned or selected locally after a previous import is target
    // state, not donor state. Keep that CUID on a retry so the catalog linker
    // cannot overwrite an operator's choice.
    const existingPlanId =
      existingSnapshot &&
      typeof existingSnapshot === 'object' &&
      !Array.isArray(existingSnapshot) &&
      typeof existingSnapshot.planId === 'string' &&
      existingSnapshot.planId.length > 0
        ? existingSnapshot.planId
        : undefined;

    return {
      importedFrom: 'remnashop',
      ...(existingPlanId ? { planId: existingPlanId } : {}),
      tag: sub.tag,
      trafficLimitStrategy: sub.traffic_limit_strategy,
      originalPlanSnapshot: sub.plan_snapshot as Prisma.InputJsonValue,
    };
  }

  private mapStatus(status: string): SubscriptionStatus {
    switch (status.toUpperCase()) {
      case 'ACTIVE':
        return SubscriptionStatus.ACTIVE;
      case 'DISABLED':
        return SubscriptionStatus.DISABLED;
      case 'LIMITED':
        return SubscriptionStatus.LIMITED;
      case 'EXPIRED':
        return SubscriptionStatus.EXPIRED;
      case 'DELETED':
        return SubscriptionStatus.DELETED;
      default:
        return SubscriptionStatus.ACTIVE;
    }
  }

  private mapLocale(locale: string | null): Locale {
    if (!locale) return Locale.EN;
    const upper = locale.toUpperCase();
    if (upper in Locale) return upper as Locale;
    return Locale.EN;
  }

  private mapTransactionStatus(status: string): TransactionStatus {
    switch (status.toUpperCase()) {
      case 'COMPLETED':
        return TransactionStatus.COMPLETED;
      case 'PENDING':
        return TransactionStatus.PENDING;
      case 'CANCELED':
      case 'CANCELLED':
      case 'REFUNDED':
        return TransactionStatus.CANCELED;
      case 'FAILED':
        return TransactionStatus.FAILED;
      default:
        return TransactionStatus.PENDING;
    }
  }

  private mapPurchaseType(type: string): PurchaseType {
    switch (type.toUpperCase()) {
      case 'RENEW':
        return PurchaseType.RENEW;
      case 'CHANGE':
      case 'UPGRADE':
        return PurchaseType.UPGRADE;
      case 'ADDITIONAL':
        return PurchaseType.ADDITIONAL;
      default:
        return PurchaseType.NEW;
    }
  }

  private mapGatewayType(gateway: string): PaymentGatewayType | null {
    const normalized = gateway.toUpperCase();
    const gatewayTypes: Record<string, PaymentGatewayType> = {
      YOOKASSA: PaymentGatewayType.YOOKASSA,
      TELEGRAM_STARS: PaymentGatewayType.TELEGRAM_STARS,
      PLATEGA: PaymentGatewayType.PLATEGA,
      HELEKET: PaymentGatewayType.HELEKET,
      CRYPTOMUS: PaymentGatewayType.CRYPTOMUS,
      MULENPAY: PaymentGatewayType.MULENPAY,
      ANTILOPAY: PaymentGatewayType.ANTILOPAY,
      OVERPAY: PaymentGatewayType.OVERPAY,
      PAYPALYCH: PaymentGatewayType.PAYPALYCH,
      RIOPAY: PaymentGatewayType.RIOPAY,
      VALUTIX: PaymentGatewayType.VALUTIX,
      WATA: PaymentGatewayType.WATA,
      AURAPAY: PaymentGatewayType.AURAPAY,
      ROLLYPAY: PaymentGatewayType.ROLLYPAY,
      SEVERPAY: PaymentGatewayType.SEVERPAY,
      LAVA: PaymentGatewayType.LAVA,
      CRYPTOPAY: PaymentGatewayType.CRYPTOPAY,
    };
    return gatewayTypes[normalized] ?? null;
  }

  private mapCurrency(currency: string): Currency | null {
    const normalized = currency.toUpperCase();
    if (normalized in Currency) return normalized as Currency;
    return null;
  }

  private mapReferralRewardType(type: string): ReferralRewardType | null {
    switch (type.toUpperCase()) {
      case 'POINTS':
        return ReferralRewardType.POINTS;
      case 'DAYS':
      case 'EXTRA_DAYS':
        return ReferralRewardType.EXTRA_DAYS;
      default:
        return null;
    }
  }

  private isDirectReferral(level: string): boolean {
    const normalized = level.toUpperCase();
    return (
      normalized === 'FIRST' ||
      normalized === 'DIRECT' ||
      normalized === '1' ||
      normalized === 'LEVEL_1'
    );
  }

  private extractAmount(pricing: Record<string, unknown> | null): number | null {
    if (!pricing) return null;
    const value =
      pricing.final_amount ??
      pricing.amount ??
      pricing.total ??
      pricing.price ??
      pricing.original_amount;
    const amount =
      typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    return Number.isFinite(amount) && amount >= 0 ? amount : null;
  }

  private parseOptionalDate(value: string | null | undefined): Date | null {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
    );
  }
}
