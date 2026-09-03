import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  Currency,
  ImportStatus,
  Locale,
  PartnerAccrualStrategy,
  PartnerRewardType,
  PaymentGatewayType,
  PointsLedgerSource,
  Prisma,
  PurchaseChannel,
  PurchaseType,
  ReferralInviteSource,
  ReferralRewardType,
  SubscriptionStatus,
  TransactionStatus,
  TrialClaimSource,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { PointsWalletService } from '../../points/services/points-wallet.service';
import { loginPolicy } from '../../auth/utils/login-policy.util';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import {
  lockTrialClaimUser,
  recordConsumedLegacyTrialAvailability,
  recordConsumedTrialSubscription,
} from '../../subscriptions/services/trial-claim-ledger.util';
import { ImportSummary } from '../interfaces/import-summary.interface';
import {
  buildPanelLookup,
  isLivePanelStatus,
  panelSubscriptionState,
  reconcileMissingPanelStatus,
  resolvePanelProfile,
  type PanelAbsenceProbe,
  type PanelLookup,
} from '../utils/remnawave-overlay.util';
import {
  decidePanelRelationship,
  panelRelationshipReport,
  type PanelIdentitySample,
  type PanelRelationship,
  type PanelWriteOutcome,
} from '../utils/panel-relationship.util';
import type {
  AltshopPlan,
  AltshopPlanDuration,
  AltshopPlanPrice,
} from '../utils/altshop-backup-parser';

export interface AltshopUser {
  readonly id: number;
  readonly telegram_id: number;
  readonly username: string | null;
  readonly referral_code: string | null;
  readonly name: string | null;
  readonly role: number;
  readonly language: string | null;
  readonly personal_discount: number;
  readonly purchase_discount: number;
  readonly points: number;
  readonly is_blocked: boolean;
  readonly is_bot_blocked: boolean;
  readonly is_rules_accepted: boolean;
  readonly is_trial_available: boolean;
  readonly max_subscriptions?: number;
  readonly referral_invite_settings?: Record<string, unknown> | null;
  readonly partner_balance_currency_override?: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface AltshopSubscription {
  readonly id: number;
  readonly user_remna_id: string | null;
  readonly user_telegram_id: number;
  readonly status: string;
  readonly is_trial: boolean;
  readonly traffic_limit: number;
  readonly device_limit: number;
  readonly traffic_limit_strategy: string | null;
  readonly tag: string | null;
  readonly internal_squads: string[];
  readonly external_squad: string | null;
  readonly expire_at: string | null;
  readonly url: string | null;
  readonly plan_snapshot: Record<string, unknown> | null;
  readonly device_type: string | null;
  readonly created_at: string;
}

export interface AltshopWebAccount {
  readonly user_telegram_id: number;
  readonly username: string | null;
  readonly email: string | null;
}

/** Historical checkout imported for audit only — it never triggers fulfillment. */
export interface AltshopTransaction {
  readonly id: number;
  readonly payment_id: string | null;
  readonly user_telegram_id: number;
  readonly status: string;
  readonly is_test?: boolean;
  readonly purchase_type: string;
  readonly gateway_type: string;
  readonly pricing: Record<string, unknown> | null;
  readonly currency: string;
  readonly payment_asset?: string | null;
  readonly device_types?: string[] | null;
  readonly renew_items?: Record<string, unknown>[] | null;
  readonly plan_snapshot: Record<string, unknown> | null;
  readonly channel: string | null;
  readonly created_at: string;
}

export interface AltshopReferral {
  readonly id: number;
  readonly referrer_telegram_id: number;
  readonly referred_telegram_id: number;
  readonly level: number | string;
  readonly invite_source?: string | null;
  readonly qualified_at?: string | null;
  readonly qualified_transaction_id?: number | null;
  readonly qualified_purchase_channel?: string | null;
  readonly created_at: string;
}

/** Historical reward only: it must not credit points or extra days a second time. */
export interface AltshopReferralReward {
  readonly id: number;
  readonly referral_id: number;
  readonly user_telegram_id: number;
  readonly type: string;
  readonly amount: number;
  readonly is_issued: boolean;
  readonly created_at: string;
}

export interface AltshopPartner {
  readonly id: number;
  readonly user_telegram_id: number;
  readonly balance: number;
  readonly total_earned: number;
  readonly total_withdrawn: number;
  readonly is_active: boolean;
  readonly individual_settings: Record<string, unknown> | null;
  readonly created_at: string;
}

export interface AltshopPartnerReferral {
  readonly id: number;
  readonly partner_id: number;
  readonly parent_partner_id: number | null;
  readonly referral_telegram_id: number;
  readonly level: number;
  readonly created_at: string;
}

export interface AltshopPartnerTransaction {
  readonly id: number;
  readonly partner_id: number;
  readonly referral_telegram_id: number;
  readonly level: number;
  readonly payment_amount: number;
  readonly percent: number | string;
  readonly earned_amount: number;
  readonly source_transaction_id: number | null;
  readonly description: string | null;
  readonly created_at: string;
}

/** Counts of source tables intentionally excluded from automatic import. */
export interface AltshopExcludedDataSummary {
  readonly settings: number;
  readonly paymentGateways: number;
  readonly referralInvites: number;
  readonly promocodes: number;
  readonly promocodeActivations: number;
  readonly partnerWithdrawals: number;
  readonly broadcasts: number;
  readonly broadcastMessages: number;
}

interface RunInput {
  readonly mode: 'import' | 'sync';
  readonly createdBy: string | null;
  readonly importRecordId?: string | null;
  readonly users: readonly AltshopUser[];
  readonly subscriptions: readonly AltshopSubscription[];
  readonly transactions?: readonly AltshopTransaction[];
  readonly webAccounts?: readonly AltshopWebAccount[];
  readonly referrals?: readonly AltshopReferral[];
  readonly referralRewards?: readonly AltshopReferralReward[];
  readonly partners?: readonly AltshopPartner[];
  readonly partnerReferrals?: readonly AltshopPartnerReferral[];
  readonly partnerTransactions?: readonly AltshopPartnerTransaction[];
  readonly excludedData?: AltshopExcludedDataSummary;
  readonly plans?: readonly AltshopPlan[];
  readonly planDurations?: readonly AltshopPlanDuration[];
  readonly planPrices?: readonly AltshopPlanPrice[];
}

type SubscriptionOutcome =
  | 'created'
  | 'updated'
  | 'skipped'
  | 'owner-mismatch'
  | 'panel-owner-mismatch';

@Injectable()
export class AltshopImporterService {
  private readonly logger = new Logger(AltshopImporterService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
    private readonly pointsWallet: PointsWalletService,
  ) {}

  public async run(input: RunInput): Promise<ImportSummary> {
    const {
      users,
      subscriptions,
      transactions = [],
      referrals = [],
      referralRewards = [],
      partners = [],
      partnerReferrals = [],
      partnerTransactions = [],
      mode,
      createdBy,
      importRecordId,
      plans,
      planDurations,
      planPrices,
    } = input;
    if (users.length === 0) throw new BadRequestException('No user records provided');

    const webAccountByTelegramId = firstByKey(input.webAccounts ?? [], (row) => row.user_telegram_id);
    const subscriptionsByTelegramId = groupBy(subscriptions, (row) => row.user_telegram_id);
    const transactionsByTelegramId = groupBy(transactions, (row) => row.user_telegram_id);
    const panelLookup = await buildPanelLookup(() =>
      this.remnawaveApiService.strictGetAllPanelUsers(),
    );

    // …and only if it is the panel these customers were actually on. On a
    // different installation the backup's identifiers name no profile here, the
    // overlay below reads that as "the panel proves it is gone", and every live
    // subscription in the file is written EXPIRED on a run that reports
    // success. Decided once — see `panel-relationship.util`.
    const panelVerdict = await decidePanelRelationship({
      samples: subscriptions.reduce<PanelIdentitySample[]>((acc, row) => {
        const anchor = nonEmpty(row.user_remna_id);
        if (anchor) {
          acc.push({
            anchor,
            telegramId: isPositiveTelegramId(row.user_telegram_id) ? row.user_telegram_id : null,
          });
        }
        return acc;
      }, []),
      lookup: panelLookup,
      resolve: (anchor) =>
        resolvePanelProfile(
          anchor,
          panelLookup,
          (uuid) => this.remnawaveApiService.getPanelUser(uuid),
          this.panelAbsenceProbe(),
        ),
    });
    this.logger.log(
      `Altshop import: panel relationship = ${panelVerdict.relationship} (${panelVerdict.reason})`,
    );
    /** Subscriptions left unlinked on purpose, for the sync to provision. */
    let panelProfilesToCreate = 0;

    const errors: string[] = [];
    const createdUserIds: string[] = [];
    const userIdsByTelegramId = new Map<number, string>();
    const transactionIdsBySourceId = new Map<number, string>();
    const counts = {
      created: 0,
      updated: 0,
      skipped: 0,
      subscriptionsCreated: 0,
      subscriptionsUpdated: 0,
      transactionsCreated: 0,
      transactionsExisting: 0,
      transactionsSkipped: 0,
    };
    const conflicts = {
      missingStableIdentity: 0,
      subscriptionOwnerMismatch: 0,
      panelOwnerMismatch: 0,
      nonDirectReferral: 0,
      referralConflict: 0,
      referralRewardSkipped: 0,
      partnerAttribution: 0,
      partnerSkipped: 0,
      partnerReferralConflict: 0,
      partnerTransactionSkipped: 0,
    };

    for (const sourceUser of users) {
      try {
        const user = await this.matchOrCreateUser(
          sourceUser,
          webAccountByTelegramId.get(sourceUser.telegram_id),
          mode,
        );
        if (!user) {
          counts.skipped += 1;
          conflicts.missingStableIdentity += 1;
          continue;
        }
        if (user.created) {
          counts.created += 1;
          createdUserIds.push(user.id);
        } else {
          counts.updated += 1;
        }
        if (isPositiveTelegramId(sourceUser.telegram_id)) {
          userIdsByTelegramId.set(sourceUser.telegram_id, user.id);
        }

        for (const subscription of subscriptionsByTelegramId.get(sourceUser.telegram_id) ?? []) {
          const result = await this.syncSubscription(
            user.id,
            sourceUser.telegram_id,
            subscription,
            panelLookup,
            panelVerdict.relationship,
            importRecordId ?? null,
          );
          const outcome = result.outcome;
          if (outcome === 'created') counts.subscriptionsCreated += 1;
          if (outcome === 'updated') counts.subscriptionsUpdated += 1;
          if (outcome === 'owner-mismatch') conflicts.subscriptionOwnerMismatch += 1;
          if (outcome === 'panel-owner-mismatch') conflicts.panelOwnerMismatch += 1;
          if (result.leftUnlinked) panelProfilesToCreate += 1;
        }

        if (sourceUser.is_trial_available === false) {
          await this.prismaService.$transaction(async (tx) => {
            await lockTrialClaimUser(tx, user.id);
            await recordConsumedLegacyTrialAvailability(tx, {
              userId: user.id,
              consumedAt: this.parseOptionalDate(sourceUser.created_at) ?? new Date(),
            });
          });
        }

        for (const transaction of transactionsByTelegramId.get(sourceUser.telegram_id) ?? []) {
          const result = await this.importTransaction(user.id, transaction);
          if (result.id) transactionIdsBySourceId.set(transaction.id, result.id);
          if (result.outcome === 'created') counts.transactionsCreated += 1;
          else if (result.outcome === 'existing') counts.transactionsExisting += 1;
          else counts.transactionsSkipped += 1;
        }

        if (mode === 'import') {
          const account = webAccountByTelegramId.get(sourceUser.telegram_id);
          if (account) await this.upsertClaimPendingWebAccount(user.id, account);
        }
      } catch (error) {
        const message = (error as Error).message;
        if (errors.length < 50) errors.push(`user row failed: ${message}`);
        this.logger.warn(`AltShop import user row failed: ${message}`);
      }
    }

    let referralResult = { created: 0, existing: 0, rewardsCreated: 0, rewardsExisting: 0 };
    try {
      referralResult = await this.importReferrals({
        referrals,
        referralRewards,
        partnerReferralTelegramIds: new Set(partnerReferrals.map((row) => row.referral_telegram_id)),
        userIdsByTelegramId,
        transactionIdsBySourceId,
        conflicts,
      });
    } catch (error) {
      this.recordStageFailure(errors, 'referral history', error);
    }
    let partnerResult = {
      created: 0,
      existing: 0,
      referralsCreated: 0,
      referralsExisting: 0,
      transactionsCreated: 0,
      transactionsExisting: 0,
    };
    try {
      partnerResult = await this.importPartnerData({
        partners,
        partnerReferrals,
        partnerTransactions,
        userIdsByTelegramId,
        transactionIdsBySourceId,
        conflicts,
      });
    } catch (error) {
      this.recordStageFailure(errors, 'partner history', error);
    }

    const finalStatus = errors.length === 0 ? ImportStatus.COMMITTED : ImportStatus.FAILED;
    const result: Prisma.InputJsonValue = {
      mode,
      fetched: users.length,
      ...counts,
      transactionsProcessed: transactions.length,
      referralsProcessed: referrals.length,
      referralsCreated: referralResult.created,
      referralsExisting: referralResult.existing,
      referralRewardsProcessed: referralRewards.length,
      referralRewardsCreated: referralResult.rewardsCreated,
      referralRewardsExisting: referralResult.rewardsExisting,
      partnersProcessed: partners.length,
      partnersCreated: partnerResult.created,
      partnersExisting: partnerResult.existing,
      partnerReferralsProcessed: partnerReferrals.length,
      partnerReferralsCreated: partnerResult.referralsCreated,
      partnerReferralsExisting: partnerResult.referralsExisting,
      partnerTransactionsProcessed: partnerTransactions.length,
      partnerTransactionsCreated: partnerResult.transactionsCreated,
      partnerTransactionsExisting: partnerResult.transactionsExisting,
      conflicts,
      // Which panel these customers turned out to be on. Surfaced rather than
      // logged: on a `different` verdict every migrated subscription gets a NEW
      // connection link, and the operator has to hear that from the import.
      panelRelationship: panelRelationshipReport(panelVerdict, panelProfilesToCreate),
      excludedData: jsonInput(input.excludedData ?? emptyExcludedData()),
      errors,
      // Matched users may receive historical rows. We intentionally block
      // rollback for such a run: no pre-import snapshot exists to restore
      // their previous state, and pretending that a partial delete is an undo
      // would leave silent accounting history behind.
      rollback: { createdUserIds, hasMatchedWrites: counts.updated > 0 },
      catalog: jsonInput({
        plans: plans ?? [],
        planDurations: planDurations ?? [],
        planPrices: planPrices ?? [],
      }),
    };
    const errorMessage = errors.length === 0 ? null : errors.slice(0, 5).join('; ');
    const recordData = {
      status: finalStatus,
      recordsTotal: users.length,
      recordsOk: counts.created + counts.updated,
      recordsFailed: errors.length,
      result,
      errorMessage,
      committedAt: new Date(),
    };
    const importRecord = importRecordId
      ? await this.prismaService.importRecord.update({ where: { id: importRecordId }, data: recordData })
      : await this.prismaService.importRecord.create({
          data: {
            ...recordData,
            filename: `altshop-${mode}-${new Date().toISOString()}.json`,
            sourceType: 'altshop',
            createdBy,
          },
        });

    return {
      importRecordId: importRecord.id,
      fetched: users.length,
      created: counts.created,
      updated: counts.updated,
      skipped: counts.skipped,
      subscriptionsCreated: counts.subscriptionsCreated,
      subscriptionsUpdated: counts.subscriptionsUpdated,
      errors,
    };
  }

  private async matchOrCreateUser(
    source: AltshopUser,
    webAccount: AltshopWebAccount | undefined,
    mode: 'import' | 'sync',
  ): Promise<{ id: string; created: boolean } | null> {
    if (isPositiveTelegramId(source.telegram_id)) {
      const existing = await this.prismaService.user.findUnique({
        where: { telegramId: BigInt(source.telegram_id) },
        select: { id: true },
      });
      if (existing) {
        await this.updateSafeUserIdentity(existing.id, source);
        return { id: existing.id, created: false };
      }
    } else {
      const identity = await this.resolveWebIdentity(webAccount);
      if (!identity.hasStableIdentity || identity.conflict) return null;
      if (identity.userId) return { id: identity.userId, created: false };
    }

    if (mode === 'sync') return null;
    // The row is created holding zero and the donor balance is credited
    // through the wallet in the same transaction, so the imported user starts
    // with a ledger that sums to the column like everybody else's.
    const points = nonNegativeInt(source.points);
    const created = await this.prismaService.$transaction(async (tx) => {
      const row = await tx.user.create({
        data: {
          telegramId: isPositiveTelegramId(source.telegram_id) ? BigInt(source.telegram_id) : null,
          username: nonEmpty(source.username),
          name: nonEmpty(source.name) ?? nonEmpty(source.username) ?? `altshop-${source.id}`,
          language: this.mapLocale(source.language),
          personalDiscount: nonNegativeInt(source.personal_discount),
          purchaseDiscount: nonNegativeInt(source.purchase_discount),
          points: 0,
          isBlocked: source.is_blocked === true,
          isBotBlocked: source.is_bot_blocked === true,
          isRulesAccepted: source.is_rules_accepted !== false,
          maxSubscriptions: normaliseMaxSubscriptions(source.max_subscriptions),
          partnerBalanceCurrencyOverride: this.mapCurrency(source.partner_balance_currency_override ?? ''),
          referralInviteSettings: source.referral_invite_settings
            ? jsonInput(source.referral_invite_settings)
            : undefined,
        },
        select: { id: true },
      });
      if (points > 0) {
        const credited = await this.pointsWallet.apply(tx, {
          userId: row.id,
          delta: points,
          source: PointsLedgerSource.IMPORT,
          referenceKey: `altshop-user:${row.id}`,
          details: { importer: 'altshop', altshopUserId: String(source.id) },
        });
        if (!credited.applied) {
          throw new Error(
            `Altshop import: donor points of user ${String(source.id)} were not credited (${credited.reason})`,
          );
        }
      }
      return row;
    });
    return { id: created.id, created: true };
  }

  /** Existing accounts retain financial, access and subscription settings. */
  private async updateSafeUserIdentity(userId: string, source: AltshopUser): Promise<void> {
    const data: Prisma.UserUpdateInput = {};
    // `nonEmpty` already trims and collapses blank/absent donor values to null,
    // so its result is what we want to store — re-reading `source` afterwards
    // only re-opens the question of whether the field was there at all.
    const username = nonEmpty(source.username);
    const name = nonEmpty(source.name);
    if (username !== null) data.username = username;
    if (name !== null) data.name = name;
    if (Object.keys(data).length > 0) {
      await this.prismaService.user.update({ where: { id: userId }, data });
    }
  }

  /**
   * The strict half of a per-UUID miss confirmation (see
   * {@link resolvePanelProfile}). `strictGetPanelUserExpiry` rather than
   * `strictGetPanelUser`: all we need from it is 404-vs-everything-else, and
   * the wide parser fails closed on nine fields this importer never reads
   * (`tag` shape, squad encoding, `trafficLimitStrategy`), so one unrelated
   * contract drift would turn EVERY confirmation into `invalidContract` and
   * quietly switch off the expiry half of the overlay for whole runs.
   */
  private panelAbsenceProbe(): PanelAbsenceProbe {
    return {
      confirmAbsence: (uuid) => this.remnawaveApiService.strictGetPanelUserExpiry(uuid),
      onUnconfirmed: (uuid, reason) =>
        this.logger.warn(
          `Altshop import: panel state for ${uuid} is unconfirmed (${reason}) — keeping the backup value instead of expiring it`,
        ),
    };
  }

  private async syncSubscription(
    userId: string,
    expectedTelegramId: number,
    source: AltshopSubscription,
    panelLookup: PanelLookup,
    panelRelationship: PanelRelationship,
    importRecordId: string | null,
  ): Promise<PanelWriteOutcome<SubscriptionOutcome>> {
    const remnawaveId = nonEmpty(source.user_remna_id);
    if (!remnawaveId) return { outcome: 'skipped', leftUnlinked: false };
    /** The run proved these identities are not this panel's. */
    const foreignPanel = panelRelationship === 'different';

    // On a FOREIGN panel the backup's identifier names no profile here, so it
    // is not a key: the durable one across re-runs is the stamp this importer
    // itself wrote. Keying on the identifier anyway would find nothing on the
    // second run and mint a duplicate subscription — and, once the sync ran, a
    // duplicate panel profile beside it.
    const existing = foreignPanel
      ? await this.prismaService.subscription.findFirst({
          where: { userId, planSnapshot: { path: ['sourceSubscriptionId'], equals: source.id } },
          select: { id: true, userId: true, planSnapshot: true, remnawaveId: true },
        })
      : await this.prismaService.subscription.findFirst({
          where: { remnawaveId },
          select: { id: true, userId: true, planSnapshot: true, remnawaveId: true },
        });

    // A foreign panel is asked nothing: every answer it could give is about
    // somebody else's profile, and the one the overlay acts on — "no such
    // user" — becomes EXPIRED written over a paying customer. A row a previous
    // run already migrated carries the id the sync wrote back when it created
    // the profile, and THAT id is this panel's.
    const linkedHere = existing?.remnawaveId ?? null;
    const panelAnchor = foreignPanel ? linkedHere : remnawaveId;
    const { panel, known } =
      panelAnchor === null
        ? { panel: null, known: false }
        : await resolvePanelProfile(
            panelAnchor,
            panelLookup,
            (uuid) => this.remnawaveApiService.getPanelUser(uuid),
            this.panelAbsenceProbe(),
          );
    if (
      panel &&
      panel.telegramId !== null &&
      (!isPositiveTelegramId(expectedTelegramId) || panel.telegramId !== expectedTelegramId)
    ) return { outcome: 'panel-owner-mismatch', leftUnlinked: false };
    if (existing && existing.userId !== userId) {
      return { outcome: 'owner-mismatch', leftUnlinked: false };
    }

    const fresh = panel ? panelSubscriptionState(panel) : null;
    const status = fresh
      ? fresh.status
      : reconcileMissingPanelStatus(known, this.mapStatus(source.status));
    // Squad uuids and the connection link belong to the panel that issued them.
    // On a DIFFERENT panel the uuids name nothing, so pushing them would fail
    // the profile CREATE outright, and the link is a dead address the customer
    // would be shown as though it worked — a new row starts empty and
    // "Назначить план всем" plus the sync fill both in. An UPDATE on a foreign
    // panel writes neither, because by then the columns hold what this panel
    // itself reported and a re-import must not wipe a working link.
    const panelOwned = fresh
      ? {
          configUrl: fresh.configUrl,
          internalSquads: fresh.internalSquads,
          externalSquad: fresh.externalSquad,
        }
      : foreignPanel
        ? { configUrl: null, internalSquads: [], externalSquad: null }
        : {
            configUrl: nonEmpty(source.url),
            internalSquads: stringArray(source.internal_squads),
            externalSquad: nonEmpty(source.external_squad),
          };
    const subscriptionData: Prisma.SubscriptionUpdateInput = {
      status,
      isTrial: source.is_trial === true,
      trafficLimit: fresh ? fresh.trafficLimit : positiveNumberOrNull(source.traffic_limit),
      deviceLimit: fresh ? fresh.deviceLimit : nonNegativeInt(source.device_limit),
      expiresAt: fresh ? fresh.expiresAt : this.parseOptionalDate(source.expire_at),
      planSnapshot: this.buildSubscriptionPlanSnapshot(source, importRecordId, existing?.planSnapshot),
      ...(foreignPanel && !fresh ? {} : panelOwned),
    };
    if (existing) {
      if (source.is_trial === true) {
        await this.prismaService.$transaction(async (tx) => {
          await lockTrialClaimUser(tx, userId);
          await tx.subscription.update({ where: { id: existing.id }, data: subscriptionData });
          await recordConsumedTrialSubscription(tx, {
            userId,
            planId: null,
            subscriptionId: existing.id,
            source: TrialClaimSource.LEGACY,
            consumedAt: this.parseOptionalDate(source.created_at) ?? new Date(),
          });
        });
      } else {
        await this.prismaService.subscription.update({ where: { id: existing.id }, data: subscriptionData });
      }
      return { outcome: 'updated', leftUnlinked: foreignPanel && linkedHere === null };
    }
    const createData: Prisma.SubscriptionCreateInput = {
        user: { connect: { id: userId } },
        // Left NULL on a foreign panel, and that is the whole mechanism:
        // `enqueuePostImportSync` reads an unlinked subscription as
        // `SyncAction.CREATE`, so the operator's "синхронизировать с панелью"
        // provisions a fresh profile instead of updating one that is not there.
        remnawaveId: foreignPanel ? null : remnawaveId,
        status,
        isTrial: source.is_trial === true,
        trafficLimit: fresh ? fresh.trafficLimit : positiveNumberOrNull(source.traffic_limit),
        deviceLimit: fresh ? fresh.deviceLimit : nonNegativeInt(source.device_limit),
        expiresAt: fresh ? fresh.expiresAt : this.parseOptionalDate(source.expire_at),
        planSnapshot: this.buildSubscriptionPlanSnapshot(source, importRecordId),
        startedAt: this.parseOptionalDate(source.created_at) ?? new Date(),
        ...panelOwned,
    };
    const created = source.is_trial === true
      ? await this.prismaService.$transaction(async (tx) => {
          await lockTrialClaimUser(tx, userId);
          const subscription = await tx.subscription.create({ data: createData });
          await recordConsumedTrialSubscription(tx, {
            userId,
            planId: null,
            subscriptionId: subscription.id,
            source: TrialClaimSource.LEGACY,
            consumedAt: this.parseOptionalDate(source.created_at) ?? new Date(),
          });
          return subscription;
        })
      : await this.prismaService.subscription.create({ data: createData });
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
      select: { currentSubscriptionId: true },
    });
    if (!user?.currentSubscriptionId && isLivePanelStatus(status)) {
      await this.prismaService.user.update({
        where: { id: userId },
        data: { currentSubscriptionId: created.id },
      });
    }
    return { outcome: 'created', leftUnlinked: foreignPanel };
  }

  private async upsertClaimPendingWebAccount(userId: string, source: AltshopWebAccount): Promise<void> {
    const current = await this.prismaService.webAccount.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (current) return;
    const loginRaw = nonEmpty(source.username);
    if (!loginRaw || !loginPolicy.isValidLogin(loginRaw)) return;
    const login = loginPolicy.sanitizeLogin(loginRaw);
    const email = nonEmpty(source.email);
    try {
      await this.prismaService.webAccount.create({
        data: {
          user: { connect: { id: userId } },
          login,
          loginNormalized: loginPolicy.normalizeLogin(loginRaw),
          email,
          emailNormalized: email?.toLowerCase() ?? null,
          passwordHash: null,
          passwordBootstrapPending: true,
          requiresPasswordChange: true,
        },
      });
    } catch (error) {
      // Existing login/email belongs to another account. Never disclose or overwrite it.
      this.logger.debug(`AltShop claim-pending web account skipped: ${(error as Error).name}`);
    }
  }

  private async importTransaction(
    userId: string,
    source: AltshopTransaction,
  ): Promise<{ outcome: 'created' | 'existing' | 'skipped'; id?: string }> {
    if (!Number.isSafeInteger(source.id) || source.id <= 0) return { outcome: 'skipped' };
    const paymentId = `altshop:${source.id}`;
    const existing = await this.prismaService.transaction.findUnique({
      where: { paymentId },
      select: { id: true },
    });
    if (existing) return { outcome: 'existing', id: existing.id };
    const gatewayType = this.mapGatewayType(source.gateway_type);
    const currency = this.mapCurrency(source.currency);
    const amount = this.extractAmount(source.pricing);
    if (!gatewayType || !currency || amount === null) return { outcome: 'skipped' };
    const created = await this.prismaService.transaction.create({
      data: {
        user: { connect: { id: userId } },
        paymentId,
        status: this.mapTransactionStatus(source.status),
        purchaseType: this.mapPurchaseType(source.purchase_type),
        gatewayType,
        amount,
        currency,
        channel: this.mapChannel(source.channel),
        paymentAsset: nonEmpty(source.payment_asset),
        deviceTypes: stringArray(source.device_types),
        planSnapshot: jsonInput({
          importedFrom: 'altshop',
          sourceTransactionId: source.id,
          sourcePaymentId: source.payment_id,
          sourceIsTest: source.is_test === true,
          originalPricing: source.pricing,
          originalPlanSnapshot: source.plan_snapshot,
          originalRenewItems: source.renew_items ?? [],
        }),
        createdAt: this.parseOptionalDate(source.created_at) ?? new Date(),
      },
    });
    return { outcome: 'created', id: created.id };
  }

  private async importReferrals(input: {
    readonly referrals: readonly AltshopReferral[];
    readonly referralRewards: readonly AltshopReferralReward[];
    readonly partnerReferralTelegramIds: ReadonlySet<number>;
    readonly userIdsByTelegramId: ReadonlyMap<number, string>;
    readonly transactionIdsBySourceId: ReadonlyMap<number, string>;
    readonly conflicts: {
      nonDirectReferral: number;
      referralConflict: number;
      referralRewardSkipped: number;
      partnerAttribution: number;
    };
  }): Promise<{ created: number; existing: number; rewardsCreated: number; rewardsExisting: number }> {
    const referralIds = new Map<number, { id: string; referrerId: string }>();
    let created = 0;
    let existing = 0;
    for (const source of input.referrals) {
      if (!this.isDirectReferral(source.level)) {
        input.conflicts.nonDirectReferral += 1;
        continue;
      }
      const referrerId = input.userIdsByTelegramId.get(source.referrer_telegram_id);
      const referredId = input.userIdsByTelegramId.get(source.referred_telegram_id);
      if (!referrerId || !referredId || referrerId === referredId) {
        input.conflicts.referralConflict += 1;
        continue;
      }
      if (input.partnerReferralTelegramIds.has(source.referred_telegram_id)) {
        input.conflicts.partnerAttribution += 1;
        continue;
      }
      const partnerReferral = await this.prismaService.partnerReferral.findFirst({
        where: { referralUserId: referredId },
        select: { id: true },
      });
      if (partnerReferral) {
        input.conflicts.partnerAttribution += 1;
        continue;
      }
      const stored = await this.prismaService.referral.findUnique({
        where: { referredId },
        select: { id: true, referrerId: true },
      });
      if (stored) {
        if (stored.referrerId === referrerId) {
          existing += 1;
          referralIds.set(source.id, stored);
        } else input.conflicts.referralConflict += 1;
        continue;
      }
      try {
        const qualifiedTransactionId = source.qualified_transaction_id
          ? input.transactionIdsBySourceId.get(source.qualified_transaction_id)
          : undefined;
        const row = await this.prismaService.referral.create({
          data: {
            referrerId,
            referredId,
            level: 1,
            inviteSource: this.mapReferralSource(source.invite_source),
            qualifiedAt: this.parseOptionalDate(source.qualified_at),
            qualifiedTransactionId,
            qualifiedPurchaseChannel: this.mapOptionalChannel(source.qualified_purchase_channel),
            ...(this.parseOptionalDate(source.created_at)
              ? { createdAt: this.parseOptionalDate(source.created_at)! }
              : {}),
          },
          select: { id: true, referrerId: true },
        });
        created += 1;
        referralIds.set(source.id, row);
      } catch (error) {
        if (!this.isUniqueConstraintError(error)) throw error;
        const concurrent = await this.prismaService.referral.findUnique({
          where: { referredId },
          select: { id: true, referrerId: true },
        });
        if (concurrent?.referrerId === referrerId) {
          existing += 1;
          referralIds.set(source.id, concurrent);
        } else input.conflicts.referralConflict += 1;
      }
    }

    let rewardsCreated = 0;
    let rewardsExisting = 0;
    for (const source of input.referralRewards) {
      if (!Number.isSafeInteger(source.id) || source.id <= 0) {
        input.conflicts.referralRewardSkipped += 1;
        continue;
      }
      const sourceKey = `altshop:referral-reward:${source.id}`;
      if (await this.prismaService.referralReward.findUnique({ where: { sourceKey }, select: { id: true } })) {
        rewardsExisting += 1;
        continue;
      }
      const referral = referralIds.get(source.referral_id);
      const userId = input.userIdsByTelegramId.get(source.user_telegram_id);
      const type = this.mapReferralRewardType(source.type);
      if (!referral || userId !== referral.referrerId || !type || !positiveInt(source.amount)) {
        input.conflicts.referralRewardSkipped += 1;
        continue;
      }
      const createdAt = this.parseOptionalDate(source.created_at) ?? new Date();
      try {
        await this.prismaService.referralReward.create({
          data: {
            referralId: referral.id,
            userId: referral.referrerId,
            type,
            amount: Math.trunc(source.amount),
            isIssued: source.is_issued === true,
            issuedAt: source.is_issued === true ? createdAt : null,
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

  private async importPartnerData(input: {
    readonly partners: readonly AltshopPartner[];
    readonly partnerReferrals: readonly AltshopPartnerReferral[];
    readonly partnerTransactions: readonly AltshopPartnerTransaction[];
    readonly userIdsByTelegramId: ReadonlyMap<number, string>;
    readonly transactionIdsBySourceId: ReadonlyMap<number, string>;
    readonly conflicts: { partnerSkipped: number; partnerReferralConflict: number; partnerTransactionSkipped: number };
  }): Promise<{
    created: number;
    existing: number;
    referralsCreated: number;
    referralsExisting: number;
    transactionsCreated: number;
    transactionsExisting: number;
  }> {
    const partnerIdsBySourceId = new Map<number, string>();
    let created = 0;
    let existing = 0;
    for (const source of input.partners) {
      const userId = input.userIdsByTelegramId.get(source.user_telegram_id);
      if (!Number.isSafeInteger(source.id) || source.id <= 0 || !userId) {
        input.conflicts.partnerSkipped += 1;
        continue;
      }
      const current = await this.prismaService.partner.findUnique({
        where: { userId },
        select: { id: true },
      });
      if (current) {
        existing += 1;
        partnerIdsBySourceId.set(source.id, current.id);
        continue;
      }
      const settings = isPlainObject(source.individual_settings) ? source.individual_settings : {};
      const row = await this.prismaService.partner.create({
        data: {
          userId,
          balance: nonNegativeInt(source.balance),
          totalEarned: nonNegativeInt(source.total_earned),
          totalWithdrawn: nonNegativeInt(source.total_withdrawn),
          isActive: source.is_active !== false,
          useGlobalSettings: settings.use_global_settings !== false,
          accrualStrategy: this.mapPartnerAccrualStrategy(settings.accrual_strategy),
          rewardType: this.mapPartnerRewardType(settings.reward_type),
          level1Percent: this.decimalOrNull(settings.level1_percent),
          level2Percent: this.decimalOrNull(settings.level2_percent),
          level3Percent: this.decimalOrNull(settings.level3_percent),
          level1FixedAmount: nonNegativeIntOrNull(settings.level1_fixed_amount),
          level2FixedAmount: nonNegativeIntOrNull(settings.level2_fixed_amount),
          level3FixedAmount: nonNegativeIntOrNull(settings.level3_fixed_amount),
          ...(this.parseOptionalDate(source.created_at)
            ? { createdAt: this.parseOptionalDate(source.created_at)! }
            : {}),
        },
        select: { id: true },
      });
      created += 1;
      partnerIdsBySourceId.set(source.id, row.id);
    }

    let referralsCreated = 0;
    let referralsExisting = 0;
    for (const source of input.partnerReferrals) {
      const partnerId = partnerIdsBySourceId.get(source.partner_id);
      const referralUserId = input.userIdsByTelegramId.get(source.referral_telegram_id);
      if (!partnerId || !referralUserId || !this.isPartnerLevel(source.level)) {
        input.conflicts.partnerReferralConflict += 1;
        continue;
      }
      const existingRow = await this.prismaService.partnerReferral.findUnique({
        where: { partnerId_referralUserId: { partnerId, referralUserId } },
        select: { id: true, parentPartnerId: true, level: true },
      });
      const parentPartnerId = source.parent_partner_id
        ? partnerIdsBySourceId.get(source.parent_partner_id) ?? null
        : null;
      if (existingRow) {
        if (existingRow.parentPartnerId !== parentPartnerId || existingRow.level !== source.level) {
          input.conflicts.partnerReferralConflict += 1;
        } else referralsExisting += 1;
        continue;
      }
      try {
        await this.prismaService.partnerReferral.create({
          data: {
            partnerId,
            referralUserId,
            parentPartnerId,
            level: source.level,
            ...(this.parseOptionalDate(source.created_at)
              ? { createdAt: this.parseOptionalDate(source.created_at)! }
              : {}),
          },
        });
        referralsCreated += 1;
      } catch (error) {
        if (this.isUniqueConstraintError(error)) referralsExisting += 1;
        else throw error;
      }
    }

    let transactionsCreated = 0;
    let transactionsExisting = 0;
    for (const source of input.partnerTransactions) {
      if (!Number.isSafeInteger(source.id) || source.id <= 0) {
        input.conflicts.partnerTransactionSkipped += 1;
        continue;
      }
      const sourceKey = `altshop:partner-transaction:${source.id}`;
      const existingRow = await this.prismaService.partnerTransaction.findUnique({
        where: { sourceKey },
        select: { id: true },
      });
      if (existingRow) {
        transactionsExisting += 1;
        continue;
      }
      const partnerId = partnerIdsBySourceId.get(source.partner_id);
      const referralUserId = input.userIdsByTelegramId.get(source.referral_telegram_id);
      const percent = this.decimalOrNull(source.percent);
      if (!partnerId || !referralUserId || !this.isPartnerLevel(source.level) || percent === null) {
        input.conflicts.partnerTransactionSkipped += 1;
        continue;
      }
      try {
        await this.prismaService.partnerTransaction.create({
          data: {
            partnerId,
            referralUserId,
            level: source.level,
            paymentAmount: nonNegativeInt(source.payment_amount),
            percent,
            earnedAmount: nonNegativeInt(source.earned_amount),
            sourceTransactionId: source.source_transaction_id
              ? input.transactionIdsBySourceId.get(source.source_transaction_id) ?? null
              : null,
            description: nonEmpty(source.description),
            sourceKey,
            createdAt: this.parseOptionalDate(source.created_at) ?? new Date(),
          },
        });
        transactionsCreated += 1;
      } catch (error) {
        if (this.isUniqueConstraintError(error)) transactionsExisting += 1;
        else throw error;
      }
    }
    return { created, existing, referralsCreated, referralsExisting, transactionsCreated, transactionsExisting };
  }

  private buildSubscriptionPlanSnapshot(
    source: AltshopSubscription,
    importRecordId: string | null,
    existingSnapshot?: Prisma.JsonValue,
  ): Prisma.InputJsonValue {
    const planId =
      isPlainObject(existingSnapshot) && typeof existingSnapshot.planId === 'string'
        ? existingSnapshot.planId
        : undefined;
    return jsonInput({
      importedFrom: 'altshop',
      // Durable link back to the import (bulk plan re-assignment targets this
      // instead of a fragile created-at time window). See BulkPlanAssignmentService.
      ...(importRecordId ? { importRecordId } : {}),
      ...(planId ? { planId } : {}),
      // The donor's own row id. On a panel that never issued these identifiers
      // it is the ONLY key a second import can find this row by — without it a
      // re-run mints a duplicate subscription for every customer.
      sourceSubscriptionId: source.id,
      tag: source.tag,
      trafficLimitStrategy: source.traffic_limit_strategy,
      deviceType: source.device_type,
      originalPlanSnapshot: source.plan_snapshot,
    });
  }

  private async resolveWebIdentity(source: AltshopWebAccount | undefined): Promise<{
    userId: string | null;
    hasStableIdentity: boolean;
    conflict: boolean;
  }> {
    if (!source) return { userId: null, hasStableIdentity: false, conflict: false };
    const login = nonEmpty(source.username);
    const email = nonEmpty(source.email)?.toLowerCase();
    const loginNormalized = login && loginPolicy.isValidLogin(login)
      ? loginPolicy.normalizeLogin(login)
      : null;
    if (!loginNormalized && !email) {
      return { userId: null, hasStableIdentity: false, conflict: false };
    }
    const [byLogin, byEmail] = await Promise.all([
      loginNormalized
        ? this.prismaService.webAccount.findFirst({
          where: { loginNormalized },
          select: { userId: true },
        })
        : null,
      email
        ? this.prismaService.webAccount.findFirst({
          where: { emailNormalized: email },
          select: { userId: true },
        })
        : null,
    ]);
    if (byLogin && byEmail && byLogin.userId !== byEmail.userId) {
      return { userId: null, hasStableIdentity: true, conflict: true };
    }
    return {
      userId: byLogin?.userId ?? byEmail?.userId ?? null,
      hasStableIdentity: true,
      conflict: false,
    };
  }

  private mapStatus(status: string): SubscriptionStatus {
    switch (status.toUpperCase()) {
      case 'ACTIVE': return SubscriptionStatus.ACTIVE;
      case 'DISABLED': return SubscriptionStatus.DISABLED;
      case 'LIMITED': return SubscriptionStatus.LIMITED;
      case 'EXPIRED': return SubscriptionStatus.EXPIRED;
      case 'DELETED': return SubscriptionStatus.DELETED;
      default: return SubscriptionStatus.EXPIRED;
    }
  }

  private mapLocale(value: string | null): Locale {
    const normalized = (value ?? '').toUpperCase();
    return normalized in Locale ? (normalized as Locale) : Locale.EN;
  }

  private mapTransactionStatus(value: string): TransactionStatus {
    switch (value.toUpperCase()) {
      case 'COMPLETED': return TransactionStatus.COMPLETED;
      case 'CANCELED':
      case 'CANCELLED':
      case 'REFUNDED': return TransactionStatus.CANCELED;
      case 'FAILED': return TransactionStatus.FAILED;
      default: return TransactionStatus.PENDING;
    }
  }

  private mapPurchaseType(value: string): PurchaseType {
    switch (value.toUpperCase()) {
      case 'RENEW': return PurchaseType.RENEW;
      case 'CHANGE':
      case 'UPGRADE': return PurchaseType.UPGRADE;
      case 'ADDITIONAL': return PurchaseType.ADDITIONAL;
      default: return PurchaseType.NEW;
    }
  }

  private mapGatewayType(value: string): PaymentGatewayType | null {
    const lookup: Record<string, PaymentGatewayType> = {
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
    return lookup[value.toUpperCase()] ?? null;
  }

  private mapCurrency(value: string): Currency | null {
    const normalized = value.toUpperCase();
    return normalized in Currency ? (normalized as Currency) : null;
  }

  private mapChannel(value: string | null): PurchaseChannel {
    return value?.toUpperCase() === 'WEB' ? PurchaseChannel.WEB : PurchaseChannel.TELEGRAM;
  }

  private mapOptionalChannel(value: string | null | undefined): PurchaseChannel | null {
    if (!value) return null;
    return this.mapChannel(value);
  }

  private mapReferralSource(value: string | null | undefined): ReferralInviteSource {
    return value?.toUpperCase() === 'BOT'
      ? ReferralInviteSource.BOT
      : value?.toUpperCase() === 'WEB'
        ? ReferralInviteSource.WEB
        : ReferralInviteSource.UNKNOWN;
  }

  private mapReferralRewardType(value: string): ReferralRewardType | null {
    if (value.toUpperCase() === 'POINTS') return ReferralRewardType.POINTS;
    if (['DAYS', 'EXTRA_DAYS'].includes(value.toUpperCase())) return ReferralRewardType.EXTRA_DAYS;
    return null;
  }

  private mapPartnerAccrualStrategy(value: unknown): PartnerAccrualStrategy {
    return value === 'ONCE_PER_USER'
      ? PartnerAccrualStrategy.ONCE_PER_USER
      : PartnerAccrualStrategy.ON_EACH_PAYMENT;
  }

  private mapPartnerRewardType(value: unknown): PartnerRewardType {
    return value === 'FIXED' ? PartnerRewardType.FIXED : PartnerRewardType.PERCENT;
  }

  private isDirectReferral(value: number | string): boolean {
    return value === 1 || ['1', 'DIRECT', 'FIRST', 'LEVEL_1'].includes(String(value).toUpperCase());
  }

  private isPartnerLevel(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 1 && value <= 3;
  }

  private extractAmount(pricing: Record<string, unknown> | null): number | null {
    if (!pricing) return null;
    const value = pricing.final_amount ?? pricing.amount ?? pricing.total ?? pricing.price ?? pricing.original_amount;
    const amount = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    return Number.isFinite(amount) && amount >= 0 ? amount : null;
  }

  private decimalOrNull(value: unknown): string | null {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed.toFixed(2) : null;
  }

  private parseOptionalDate(value: string | null | undefined): Date | null {
    if (!value) return null;
    const result = new Date(value);
    return Number.isNaN(result.getTime()) ? null : result;
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
  }

  private recordStageFailure(errors: string[], stage: string, error: unknown): void {
    const message = `${stage} failed: ${(error as Error).message}`;
    if (errors.length < 50) errors.push(message);
    this.logger.error(`AltShop import ${message}`);
  }
}

function groupBy<T>(rows: readonly T[], key: (row: T) => number): Map<number, T[]> {
  const result = new Map<number, T[]>();
  for (const row of rows) result.set(key(row), [...(result.get(key(row)) ?? []), row]);
  return result;
}

function firstByKey<T>(rows: readonly T[], key: (row: T) => number): Map<number, T> {
  const result = new Map<number, T>();
  for (const row of rows) if (!result.has(key(row))) result.set(key(row), row);
  return result;
}

function emptyExcludedData(): AltshopExcludedDataSummary {
  return { settings: 0, paymentGateways: 0, referralInvites: 0, promocodes: 0, promocodeActivations: 0, partnerWithdrawals: 0, broadcasts: 0, broadcastMessages: 0 };
}

function isPositiveTelegramId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function nonNegativeIntOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

function positiveInt(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function normaliseMaxSubscriptions(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(50, Math.max(1, Math.trunc(value))) : 1;
}

function positiveNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
