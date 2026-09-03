import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  Currency,
  ImportStatus,
  Locale,
  PaymentGatewayType,
  PointsLedgerSource,
  Prisma,
  PurchaseChannel,
  PurchaseType,
  ReferralInviteSource,
  SubscriptionStatus,
  TransactionStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { clampDiscountPercent } from '../../../common/utils/discount.util';
import { PointsWalletService } from '../../points/services/points-wallet.service';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import { ImportSummary } from '../interfaces/import-summary.interface';
import {
  buildPanelLookup,
  panelSubscriptionState,
  reconcileMissingPanelStatus,
  resolvePanelProfile,
  type PanelAbsenceProbe,
  type PanelLookup,
} from '../utils/remnawave-overlay.util';
import {
  BedolagaBackupData,
  BedolagaPromoGroup,
  BedolagaPromocode,
  BedolagaSubscription,
  BedolagaTariff,
  BedolagaTransaction,
  BedolagaUser,
} from '../utils/bedolaga-backup-parser';

/**
 * Importer for Bedolaga (BEDOLAGA-DEV/remnawave-bedolaga-telegram-bot) backups.
 *
 * ── What lands where ──────────────────────────────────────────────────────
 *
 *   users             → User (+ points for the leftover wallet balance)
 *   subscriptions     → Subscription, overlaid with LIVE panel state
 *   tariffs           → `result.catalog`, for the optional clone-plans step
 *   transactions      → Transaction (historical; never triggers fulfilment)
 *   users.referred_by → Referral edge
 *   referral_earnings → ReferralReward (already issued, for the standing)
 *   promo groups      → User.personalDiscount, flattened
 *   promocodes        → Promocode + PromocodeAction, unspent ones only
 *
 * ── Two things this importer refuses to guess ─────────────────────────────
 *
 * 1. WHICH PANEL PROFILE a subscription belongs to. Bedolaga stores the
 *    panel's numeric id in one of two columns depending on a setting the
 *    operator chose (`users.remnawave_id` in single-tariff mode,
 *    `subscriptions.remnawave_id` in multi-tariff), and its old
 *    `remnawave_uuid` is dead weight on any 3.x panel. We read both id
 *    columns, never the uuid, and hand the result to the shared overlay —
 *    which alone may decide a profile is gone, and only on a proven 404.
 *
 * 2. WHAT A DEBT IS WORTH. A Bedolaga balance can be negative on purpose
 *    (their own account merge preserves it). Points cannot be negative, so a
 *    debt is reported to the operator rather than quietly forgiven by being
 *    clamped to zero.
 */
@Injectable()
export class BedolagaImporterService {
  private readonly logger = new Logger(BedolagaImporterService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
    private readonly pointsWallet: PointsWalletService,
  ) {}

  public async run(input: RunInput): Promise<ImportSummary> {
    const { mode, createdBy, importRecordId, data } = input;
    if (data.users.length === 0) {
      throw new BadRequestException('Bedolaga backup contains no user records');
    }

    const index = buildIndex(data);
    const conversion: BalanceConversion = {
      enabled: input.balanceToPoints?.enabled ?? true,
      rate:
        input.balanceToPoints?.rate !== undefined &&
        Number.isFinite(input.balanceToPoints.rate) &&
        input.balanceToPoints.rate > 0
          ? input.balanceToPoints.rate
          : 1,
    };

    // The live panel is the truth about who is still connected. Read once.
    const panelLookup = await buildPanelLookup(() =>
      this.remnawaveApiService.strictGetAllPanelUsers(),
    );

    const errors: string[] = [];
    const createdUserIds: string[] = [];
    /** Bedolaga user id → our user id, for the referral pass afterwards. */
    const ourUserIds = new Map<number, string>();
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let subscriptionsCreated = 0;
    let subscriptionsUpdated = 0;
    let transactionsCreated = 0;
    let pointsGranted = 0;
    let discountsApplied = 0;
    /** People whose wallet was in the red — an operator decision, not ours. */
    const debtors: Array<{ readonly telegramId: number | null; readonly kopeks: number }> = [];

    for (const donor of data.users) {
      const identifier = donor.telegram_id ?? donor.email ?? `bedolaga-${donor.id}`;
      try {
        const userId = await this.matchOrCreateUser(donor, mode);
        if (userId === null) {
          skipped += 1;
          continue;
        }
        ourUserIds.set(donor.id, userId);

        if (await this.wasJustCreated(userId)) {
          created += 1;
          createdUserIds.push(userId);
        } else {
          updated += 1;
        }

        if (await this.applyPromoGroupDiscount(userId, donor, index.promoGroupsByUser)) {
          discountsApplied += 1;
        }

        if (donor.balance_kopeks < 0) {
          debtors.push({ telegramId: donor.telegram_id, kopeks: donor.balance_kopeks });
        }
        const granted = await this.creditBalance(userId, donor, conversion);
        pointsGranted += granted;

        for (const sub of index.subscriptionsByUser.get(donor.id) ?? []) {
          const outcome = await this.syncSubscription({
            userId,
            donor,
            sub,
            tariff: sub.tariff_id === null ? undefined : index.tariffsById.get(sub.tariff_id),
            panelLookup,
            importRecordId: importRecordId ?? null,
          });
          if (outcome === 'created') subscriptionsCreated += 1;
          else if (outcome === 'updated') subscriptionsUpdated += 1;
        }

        for (const transaction of index.transactionsByUser.get(donor.id) ?? []) {
          if (await this.importTransaction(userId, transaction)) transactionsCreated += 1;
        }
      } catch (err) {
        const message = `${identifier}: ${(err as Error).message}`;
        errors.push(message);
        this.logger.warn(`bedolaga importer row failed: ${message}`);
      }
    }

    // Both ends of a referral edge have to exist before the edge can, so this
    // runs after the user pass rather than inside it.
    const referrals = await this.importReferrals(data, ourUserIds, errors);
    const promocodes = await this.importPromocodes(data, errors);

    const finalStatus = errors.length === 0 ? ImportStatus.COMMITTED : ImportStatus.FAILED;
    const resultPayload: Prisma.InputJsonValue = {
      mode,
      sourceFormat: data.sourceFormat,
      fetched: data.users.length,
      created,
      updated,
      skipped,
      subscriptionsCreated,
      subscriptionsUpdated,
      transactionsProcessed: data.transactions.length,
      transactionsCreated,
      pointsGranted,
      discountsApplied,
      bedolagaReferrals: referrals,
      bedolagaPromocodes: promocodes,
      // Every one of these is either an obligation somebody is owed or a
      // decision only the operator can make. Counted so they are settled by
      // hand instead of disappearing with the old bot.
      notImported: {
        ...data.excludedData,
        usersInDebt: debtors.length,
        debtKopeks: debtors.reduce((sum, row) => sum + Math.abs(row.kopeks), 0),
      },
      errors,
      rollback: { createdUserIds, hasMatchedWrites: updated > 0 },
      catalog: JSON.parse(
        JSON.stringify({
          plans: data.tariffs.map((tariff) => mapTariffToPlanRow(tariff)),
          planDurations: deriveDurations(data.tariffs),
          planPrices: derivePrices(data.tariffs),
          addOns: [],
        }),
      ),
    };

    const errorMessage = errors.length === 0 ? null : errors.slice(0, 5).join('; ');
    const recordData = {
      status: finalStatus,
      recordsTotal: data.users.length,
      recordsOk: created + updated,
      recordsFailed: errors.length,
      result: resultPayload,
      errorMessage,
      committedAt: new Date(),
    };

    const importRecord = importRecordId
      ? await this.prismaService.importRecord.update({
          where: { id: importRecordId },
          data: recordData,
        })
      : await this.prismaService.importRecord.create({
          data: {
            ...recordData,
            filename: `bedolaga-${mode}-${new Date().toISOString()}.tar.gz`,
            sourceType: 'bedolaga',
            createdBy,
          },
        });

    return {
      importRecordId: importRecord.id,
      fetched: data.users.length,
      created,
      updated,
      skipped,
      subscriptionsCreated,
      subscriptionsUpdated,
      errors,
    };
  }

  // ── Users ─────────────────────────────────────────────────────────────────

  /**
   * Telegram first, then email, then nothing.
   *
   * Bedolaga's own primary key is an autoincrement integer, which is not an
   * identity across two systems: re-importing would mint a second copy of
   * everybody. A row with neither handle is skipped and counted rather than
   * guessed at.
   */
  private async matchOrCreateUser(
    donor: BedolagaUser,
    mode: 'import' | 'sync',
  ): Promise<string | null> {
    const telegramId = toTelegramId(donor.telegram_id);
    if (telegramId !== null) {
      const existing = await this.prismaService.user.findUnique({
        where: { telegramId },
        select: { id: true },
      });
      if (existing) {
        await this.updateUserFields(existing.id, donor);
        return existing.id;
      }
    }

    const email = normalizeEmail(donor.email);
    if (email !== null) {
      const existing = await this.prismaService.user.findUnique({
        where: { email },
        select: { id: true },
      });
      if (existing) {
        await this.updateUserFields(existing.id, donor);
        return existing.id;
      }
    }

    if (mode === 'sync') return null;
    if (telegramId === null && email === null) return null;

    const user = await this.prismaService.user.create({
      data: {
        telegramId,
        email,
        username: donor.username,
        name: displayName(donor),
        language: mapLocale(donor.language),
        isBlocked: donor.status !== 'active',
      },
    });
    return user.id;
  }

  private async updateUserFields(userId: string, donor: BedolagaUser): Promise<void> {
    const data: Prisma.UserUpdateInput = { isBlocked: donor.status !== 'active' };
    if (donor.username !== null) data.username = donor.username;
    const email = normalizeEmail(donor.email);
    if (email !== null) data.email = email;
    try {
      await this.prismaService.user.update({ where: { id: userId }, data });
    } catch (err) {
      // An email already owned by somebody else is the common collision when
      // two imports overlap. The rest of this person's state is still useful.
      this.logger.debug(`updateUserFields skipped for ${userId}: ${(err as Error).message}`);
    }
  }

  private async wasJustCreated(userId: string): Promise<boolean> {
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
      select: { createdAt: true },
    });
    if (!user) return false;
    return Date.now() - user.createdAt.getTime() < 5000;
  }

  /**
   * A promo group flattened into one personal discount.
   *
   * Bedolaga's promo group is a bundle of three percentages (servers, traffic,
   * devices) plus a per-period table; we have one number. The server discount
   * is the one that moves the price of a subscription, so it is the one that
   * carries over — the rest is reported through the catalog rather than
   * silently averaged into something nobody chose.
   *
   * NEVER LOWERS an existing discount. A re-import must not take away a rate
   * an operator granted here after the first run; a migration is allowed to be
   * generous and is not allowed to be a surprise.
   */
  private async applyPromoGroupDiscount(
    userId: string,
    donor: BedolagaUser,
    groupsByUser: ReadonlyMap<number, BedolagaPromoGroup>,
  ): Promise<boolean> {
    const group = groupsByUser.get(donor.id);
    const fromGroup = group?.server_discount_percent ?? 0;
    // A live one-shot offer is a promise too, and the bigger of the two is the
    // one the person would have seen at checkout.
    const percent = clampDiscountPercent(Math.max(fromGroup, donor.promo_offer_discount_percent));
    if (percent <= 0) return false;

    const applied = await this.prismaService.user.updateMany({
      where: { id: userId, personalDiscount: { lt: percent } },
      data: { personalDiscount: percent },
    });
    return applied.count > 0;
  }

  /**
   * The leftover wallet, as loyalty points.
   *
   * Idempotent twice: one ledger key per person, and a conditional write that
   * only fires while they still hold zero points — so a re-import never
   * double-credits and never overwrites points earned here since.
   *
   * A `deleted` account is skipped: Bedolaga itself zeroes that balance the
   * moment such a person comes back, so importing it would hand out money the
   * donor had already written off.
   */
  private async creditBalance(
    userId: string,
    donor: BedolagaUser,
    conversion: BalanceConversion,
  ): Promise<number> {
    if (!conversion.enabled) return 0;
    if (donor.status === 'deleted') return 0;
    const points = balanceToPoints(donor.balance_kopeks / 100, conversion.rate);
    if (points <= 0) return 0;

    const credited = await this.prismaService.$transaction((tx) =>
      this.pointsWallet.apply(tx, {
        userId,
        delta: points,
        source: PointsLedgerSource.IMPORT,
        referenceKey: `bedolaga-balance:${userId}`,
        expectedBalance: 0,
        details: {
          importer: 'bedolaga',
          sourceUserId: donor.id,
          balanceKopeks: donor.balance_kopeks,
          rate: conversion.rate,
        },
      }),
    );
    return credited.applied ? points : 0;
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────

  /**
   * The strict half of a per-profile absence check.
   *
   * `strictGetPanelUserExpiry` rather than the wide read: all this needs is
   * 404-versus-anything-else, and the wide parser fails closed on fields this
   * importer never looks at — one unrelated contract drift would turn every
   * confirmation into `invalidContract` and switch the expiry half of the
   * overlay off for a whole run.
   */
  private panelAbsenceProbe(): PanelAbsenceProbe {
    return {
      confirmAbsence: (id) => this.remnawaveApiService.strictGetPanelUserExpiry(id),
      onUnconfirmed: (id, reason) =>
        this.logger.warn(
          `Bedolaga import: panel state for ${id} is unconfirmed (${reason}) — keeping the subscription live instead of expiring it`,
        ),
    };
  }

  private async syncSubscription(input: {
    readonly userId: string;
    readonly donor: BedolagaUser;
    readonly sub: BedolagaSubscription;
    readonly tariff: BedolagaTariff | undefined;
    readonly panelLookup: PanelLookup;
    readonly importRecordId: string | null;
  }): Promise<'created' | 'updated' | 'skipped'> {
    const { userId, donor, sub, tariff, panelLookup, importRecordId } = input;

    // An unpaid trial draft is not a subscription: Bedolaga's own menus and
    // its "has this person used their trial" check both skip it.
    if (sub.status === 'pending' && sub.is_trial) return 'skipped';

    // The panel's numeric id, from whichever column the operator's sales mode
    // put it in. `remnawave_uuid` is deliberately not consulted: on a 3.x
    // panel it resolves to nothing, and sent as an id it yields a 400 that a
    // careless reader would mistake for "no such user" and duplicate a
    // profile on.
    const panelId = sub.remnawave_id ?? donor.remnawave_id;
    if (panelId === null) return 'skipped';
    const anchor = String(panelId);

    const existing = await this.prismaService.subscription.findFirst({
      where: { remnawaveId: anchor },
      select: { id: true, userId: true },
    });
    // A profile that already belongs to somebody else here is a refusal, not a
    // rebind: silently moving a live subscription between two customers is the
    // one mistake an import cannot apologise for afterwards.
    if (existing !== null && existing.userId !== userId) {
      throw new Error(
        `panel profile ${anchor} already belongs to another user here (subscription ${existing.id})`,
      );
    }

    const tariffSquads = tariff ? [...tariff.allowed_squads] : [];
    const backupSquads = sub.connected_squads.length > 0 ? [...sub.connected_squads] : tariffSquads;
    // Zero means unlimited on both sides of the fence — but ours says so with
    // null, and theirs with a zero that reads exactly like "no quota at all".
    const backupTraffic = sub.traffic_limit_gb > 0 ? sub.traffic_limit_gb : null;

    const planSnapshot: Prisma.InputJsonValue = {
      importedFrom: 'bedolaga',
      ...(importRecordId ? { importRecordId } : {}),
      sourceSubscriptionId: sub.id,
      sourceTariffId: sub.tariff_id,
      // Same shape the other importers emit, so the plan cloner's
      // `extractSourcePlanId()` walks all of them the same way.
      originalPlanSnapshot: tariff
        ? {
            id: tariff.id,
            name: tariff.name,
            traffic_limit_gb: tariff.traffic_limit_gb,
            device_limit: tariff.device_limit,
            period_prices: tariff.period_prices,
          }
        : null,
      tariffName: tariff?.name ?? null,
      // Bedolaga tops traffic up per purchase with its own 30-day expiry; we
      // have no home for an expiring top-up, so it is folded into the limit
      // and recorded here so nobody later wonders where the extra came from.
      purchasedTrafficGb: sub.purchased_traffic_gb,
      autopayEnabled: sub.autopay_enabled,
      backupExpireAt: sub.end_date,
      backupTrafficUsedGb: sub.traffic_used_gb,
    };

    const { panel, known } = await resolvePanelProfile(
      anchor,
      panelLookup,
      (id) => this.remnawaveApiService.getPanelUser(id),
      this.panelAbsenceProbe(),
    );

    const shared = panel
      ? (() => {
          const fresh = panelSubscriptionState(panel);
          const panelDevices = fresh.deviceLimit ?? 0;
          return {
            status: fresh.status,
            isTrial: sub.is_trial,
            trafficLimit: fresh.trafficLimit,
            deviceLimit: panelDevices > 0 ? panelDevices : sub.device_limit,
            internalSquads: fresh.internalSquads.length > 0 ? fresh.internalSquads : backupSquads,
            externalSquad: fresh.externalSquad,
            configUrl: fresh.configUrl,
            expiresAt: fresh.expiresAt,
            planSnapshot,
          };
        })()
      : {
          status: reconcileMissingPanelStatus(known, mapSubscriptionStatus(sub.status)),
          isTrial: sub.is_trial,
          trafficLimit: withTopUp(backupTraffic, sub.purchased_traffic_gb),
          deviceLimit: sub.device_limit,
          internalSquads: backupSquads,
          externalSquad: tariff?.external_squad_uuid ?? null,
          configUrl: sub.subscription_url,
          expiresAt: toDate(sub.end_date),
          planSnapshot,
        };

    if (existing !== null) {
      await this.prismaService.subscription.update({ where: { id: existing.id }, data: shared });
      return 'updated';
    }

    const createdSub = await this.prismaService.subscription.create({
      data: {
        ...shared,
        user: { connect: { id: userId } },
        remnawaveId: anchor,
        remnawavePanelId: panelId,
        startedAt: toDate(sub.start_date) ?? new Date(),
      },
    });

    const owner = await this.prismaService.user.findUnique({
      where: { id: userId },
      select: { currentSubscriptionId: true },
    });
    if (!owner?.currentSubscriptionId) {
      await this.prismaService.user.update({
        where: { id: userId },
        data: { currentSubscriptionId: createdSub.id },
      });
    }
    return 'created';
  }

  // ── Transactions ──────────────────────────────────────────────────────────

  /**
   * One historical payment.
   *
   * Written with `fulfilledAt` untouched so nothing downstream mistakes it for
   * a purchase to act on: this is the record of what somebody paid the OLD
   * bot, kept so an operator opening the card can see who they are dealing
   * with.
   */
  private async importTransaction(
    userId: string,
    donor: BedolagaTransaction,
  ): Promise<boolean> {
    // Only real money coming IN. A `subscription_payment` is the person
    // spending a balance we have already carried over as points; importing it
    // as a payment would count the same money twice in every revenue figure.
    if (donor.type !== 'deposit') return false;
    if (!donor.is_completed) return false;

    const gatewayType = mapGatewayType(donor.payment_method);
    if (gatewayType === null) return false;

    // Their sign convention is inconsistent by type, so the direction comes
    // from `type` above and only the magnitude from the amount.
    const kopeks = Math.abs(donor.amount_kopeks);
    if (kopeks <= 0) return false;

    const paymentId = `bedolaga:${donor.id}`;
    const existing = await this.prismaService.transaction.findUnique({
      where: { paymentId },
      select: { id: true },
    });
    if (existing) return false;

    try {
      await this.prismaService.transaction.create({
        data: {
          user: { connect: { id: userId } },
          paymentId,
          status: TransactionStatus.COMPLETED,
          purchaseType: PurchaseType.NEW,
          gatewayType,
          gatewayId: donor.external_id ?? undefined,
          amount: new Prisma.Decimal(kopeks).dividedBy(100),
          currency: Currency.RUB,
          channel: PurchaseChannel.TELEGRAM,
          planSnapshot: {
            importedFrom: 'bedolaga',
            sourceTransactionId: donor.id,
            sourceType: donor.type,
            sourcePaymentMethod: donor.payment_method,
            description: donor.description,
          } satisfies Prisma.InputJsonValue,
          createdAt: toDate(donor.created_at) ?? new Date(),
        },
      });
      return true;
    } catch (err) {
      this.logger.debug(
        `Transaction import skipped for bedolaga:${donor.id}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  // ── Referrals ─────────────────────────────────────────────────────────────

  /**
   * Who brought whom, and what they earned for it.
   *
   * The edge is the part that matters: without it a partner's whole downline
   * disappears and they start again from nothing. The earnings come across as
   * already-issued rewards so their standing reads the same, keyed on the
   * donor's own row id so a re-import cannot duplicate one.
   */
  private async importReferrals(
    data: BedolagaBackupData,
    ourUserIds: ReadonlyMap<number, string>,
    errors: string[],
  ): Promise<{ readonly edges: number; readonly rewards: number }> {
    let edges = 0;
    let rewards = 0;

    for (const donor of data.users) {
      if (donor.referred_by_id === null) continue;
      const referredId = ourUserIds.get(donor.id);
      const referrerId = ourUserIds.get(donor.referred_by_id);
      if (referredId === undefined || referrerId === undefined) continue;
      // Bedolaga has no guard against it; ours would be a self-edge nobody can
      // ever qualify.
      if (referredId === referrerId) continue;

      try {
        // `referredId` is unique: one referrer per person, forever. An
        // existing edge is somebody's earlier answer and is left alone.
        const existing = await this.prismaService.referral.findUnique({
          where: { referredId },
          select: { id: true },
        });
        if (existing === null) {
          await this.prismaService.referral.create({
            data: {
              referrerId,
              referredId,
              level: 1,
              inviteSource: ReferralInviteSource.UNKNOWN,
              createdAt: toDate(donor.created_at) ?? new Date(),
            },
          });
          edges += 1;
        }
      } catch (err) {
        errors.push(`referral edge for bedolaga user ${donor.id}: ${(err as Error).message}`);
      }
    }

    for (const earning of data.referralEarnings) {
      const earnerId = ourUserIds.get(earning.user_id);
      const referredId = ourUserIds.get(earning.referral_id);
      if (earnerId === undefined || referredId === undefined) continue;
      // A money reward is in kopeks and our `amount` is read per type, so only
      // the day-denominated ones carry a number that means the same thing on
      // both sides. Money earnings arrive as points instead, at the same rate
      // the wallet used, so the two halves of a migration agree.
      const amount =
        earning.reward_type === 'days'
          ? earning.days_granted
          : Math.round(earning.amount_kopeks / 100);
      if (amount <= 0) continue;

      try {
        const edge = await this.prismaService.referral.findUnique({
          where: { referredId },
          select: { id: true },
        });
        if (edge === null) continue;
        await this.prismaService.referralReward.create({
          data: {
            referralId: edge.id,
            userId: earnerId,
            type: earning.reward_type === 'days' ? 'EXTRA_DAYS' : 'POINTS',
            amount,
            isIssued: true,
            issuedAt: toDate(earning.created_at) ?? new Date(),
            sourceKey: `bedolaga-earning:${earning.id}`,
            createdAt: toDate(earning.created_at) ?? new Date(),
          },
        });
        rewards += 1;
      } catch (err) {
        // The unique `sourceKey` is what makes a re-import a no-op here.
        this.logger.debug(
          `referral reward skipped for bedolaga earning ${earning.id}: ${(err as Error).message}`,
        );
      }
    }

    return { edges, rewards };
  }

  // ── Promocodes ────────────────────────────────────────────────────────────

  /**
   * Codes that were handed out and never spent.
   *
   * These are bearer instruments: people forwarded them, printed them, pinned
   * them in chats. The code STRING therefore comes across unchanged — a
   * migration that reissues them under new strings destroys every copy already
   * in somebody's hands, and the operator finds out from complaints.
   *
   * Only unspent, live codes are imported; a code with its uses exhausted or
   * its window closed is history, and history does not need to work.
   */
  private async importPromocodes(
    data: BedolagaBackupData,
    errors: string[],
  ): Promise<{ readonly created: number; readonly skipped: number }> {
    let createdCount = 0;
    let skippedCount = 0;
    const now = Date.now();

    for (const donor of data.promocodes) {
      if (!isSpendable(donor, now)) {
        skippedCount += 1;
        continue;
      }
      const action = promocodeAction(donor);
      if (action === null) {
        skippedCount += 1;
        continue;
      }

      try {
        const existing = await this.prismaService.promocode.findUnique({
          where: { code: donor.code },
          select: { id: true },
        });
        if (existing !== null) {
          skippedCount += 1;
          continue;
        }
        await this.prismaService.promocode.create({
          data: {
            code: donor.code,
            isActive: true,
            rewardType: action.type,
            reward: action.value,
            // What is LEFT, not what it started with — the uses already spent
            // are spent. Zero means unlimited on their side and null on ours,
            // and reading it as "nothing left" would turn a code an operator
            // handed to a whole channel into a single-use one.
            maxActivations: remainingUses(donor),
            expiresAt: toDate(donor.valid_until),
            actions: { create: [{ type: action.type, value: action.value }] },
          },
        });
        createdCount += 1;
      } catch (err) {
        errors.push(`promocode ${donor.code}: ${(err as Error).message}`);
      }
    }

    return { created: createdCount, skipped: skippedCount };
  }
}

// ── Inputs ───────────────────────────────────────────────────────────────────

interface RunInput {
  readonly mode: 'import' | 'sync';
  readonly createdBy: string | null;
  /** Pre-allocated `ImportRecord.id` to update instead of creating a new one. */
  readonly importRecordId?: string | null;
  readonly data: BedolagaBackupData;
  /**
   * Carry the leftover wallet over as loyalty points. Enabled at 1:1 by
   * default, matching every other migration this panel has done.
   */
  readonly balanceToPoints?: { readonly enabled: boolean; readonly rate: number };
}

interface BalanceConversion {
  readonly enabled: boolean;
  readonly rate: number;
}

interface BackupIndex {
  readonly subscriptionsByUser: ReadonlyMap<number, BedolagaSubscription[]>;
  readonly transactionsByUser: ReadonlyMap<number, BedolagaTransaction[]>;
  readonly tariffsById: ReadonlyMap<number, BedolagaTariff>;
  /** The one group whose discount a person actually gets. */
  readonly promoGroupsByUser: ReadonlyMap<number, BedolagaPromoGroup>;
}

function buildIndex(data: BedolagaBackupData): BackupIndex {
  const subscriptionsByUser = new Map<number, BedolagaSubscription[]>();
  for (const sub of data.subscriptions) {
    const list = subscriptionsByUser.get(sub.user_id) ?? [];
    list.push(sub);
    subscriptionsByUser.set(sub.user_id, list);
  }

  const transactionsByUser = new Map<number, BedolagaTransaction[]>();
  for (const transaction of data.transactions) {
    const list = transactionsByUser.get(transaction.user_id) ?? [];
    list.push(transaction);
    transactionsByUser.set(transaction.user_id, list);
  }

  const tariffsById = new Map<number, BedolagaTariff>();
  for (const tariff of data.tariffs) tariffsById.set(tariff.id, tariff);

  const groupsById = new Map<number, BedolagaPromoGroup>();
  for (const group of data.promoGroups) groupsById.set(group.id, group);

  // The effective group is the HIGHEST-PRIORITY membership, not the column on
  // the user — that one is only a fallback, and reading it instead would give
  // a long-standing customer the default group's discount.
  const promoGroupsByUser = new Map<number, BedolagaPromoGroup>();
  for (const membership of data.userPromoGroups) {
    const group = groupsById.get(membership.promo_group_id);
    if (group === undefined) continue;
    const current = promoGroupsByUser.get(membership.user_id);
    if (current === undefined || group.priority > current.priority) {
      promoGroupsByUser.set(membership.user_id, group);
    }
  }
  for (const user of data.users) {
    if (promoGroupsByUser.has(user.id)) continue;
    if (user.promo_group_id === null) continue;
    const group = groupsById.get(user.promo_group_id);
    if (group !== undefined) promoGroupsByUser.set(user.id, group);
  }

  return { subscriptionsByUser, transactionsByUser, tariffsById, promoGroupsByUser };
}

// ── Pure mapping helpers ─────────────────────────────────────────────────────

/**
 * A leftover wallet, in major units, as loyalty points.
 *
 * The same arithmetic the STEALTHNET migration used, deliberately: two
 * migrations that convert money differently are two answers to one question,
 * and the operator would have to explain both.
 */
export function balanceToPoints(balanceMajor: number, rate: number): number {
  if (!Number.isFinite(balanceMajor) || balanceMajor <= 0) return 0;
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  const minor = Math.round(balanceMajor * 100 + 1e-8);
  if (minor <= 0) return 0;
  return Math.round((minor * rate) / 100 + 1e-8);
}

export function toTelegramId(raw: number | null): bigint | null {
  if (raw === null || !Number.isFinite(raw) || raw <= 0) return null;
  return BigInt(Math.trunc(raw));
}

function normalizeEmail(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function displayName(donor: BedolagaUser): string {
  const parts = [donor.first_name, donor.last_name].filter(
    (part): part is string => part !== null && part.trim().length > 0,
  );
  if (parts.length > 0) return parts.join(' ').trim();
  return donor.username ?? donor.email ?? `bedolaga-${donor.id}`;
}

function mapLocale(language: string | null): Locale {
  if (language === null) return Locale.RU;
  const upper = language.trim().toUpperCase();
  return upper in Locale ? (upper as Locale) : Locale.RU;
}

/**
 * Their six statuses onto our five.
 *
 * `limited` is the panel's word for "over the traffic quota but still a
 * customer", which is exactly our LIMITED; `pending` only ever reaches here on
 * a non-trial row, where it means a purchase that never completed.
 */
export function mapSubscriptionStatus(status: string): SubscriptionStatus {
  switch (status) {
    case 'active':
    case 'trial':
      return SubscriptionStatus.ACTIVE;
    case 'limited':
      return SubscriptionStatus.LIMITED;
    case 'disabled':
      return SubscriptionStatus.DISABLED;
    case 'expired':
    case 'pending':
      return SubscriptionStatus.EXPIRED;
    default:
      return SubscriptionStatus.EXPIRED;
  }
}

/** Unlimited stays unlimited; a top-up only ever adds to a finite quota. */
function withTopUp(limitGb: number | null, purchasedGb: number): number | null {
  if (limitGb === null) return null;
  return purchasedGb > 0 ? limitGb + purchasedGb : limitGb;
}

/**
 * Bedolaga's `payment_method` onto a gateway we know.
 *
 * `balance` and `manual` are deliberately absent: they are not a provider
 * charging a card, they are the bot moving its own numbers, and a ledger that
 * counted them as revenue would double every figure it feeds.
 */
export function mapGatewayType(method: string | null): PaymentGatewayType | null {
  if (method === null) return null;
  const key = method.trim().toUpperCase().replace(/[-\s]/g, '_');
  const known: Record<string, PaymentGatewayType> = {
    YOOKASSA: PaymentGatewayType.YOOKASSA,
    TELEGRAM_STARS: PaymentGatewayType.TELEGRAM_STARS,
    STARS: PaymentGatewayType.TELEGRAM_STARS,
    CRYPTOBOT: PaymentGatewayType.CRYPTOMUS,
    CRYPTOMUS: PaymentGatewayType.CRYPTOMUS,
    HELEKET: PaymentGatewayType.HELEKET,
    MULENPAY: PaymentGatewayType.MULENPAY,
    PLATEGA: PaymentGatewayType.PLATEGA,
    ANTILOPAY: PaymentGatewayType.ANTILOPAY,
    OVERPAY: PaymentGatewayType.OVERPAY,
    PAL24: PaymentGatewayType.PAYPALYCH,
    PAYPALYCH: PaymentGatewayType.PAYPALYCH,
    RIOPAY: PaymentGatewayType.RIOPAY,
  };
  return known[key] ?? null;
}

/**
 * How many more times a code may be spent, in our vocabulary.
 *
 * `null` is unlimited here; `max_uses = 0` is unlimited there.
 */
export function remainingUses(donor: BedolagaPromocode): number | null {
  if (donor.max_uses <= 0) return null;
  return Math.max(donor.max_uses - donor.current_uses, 1);
}

/** Live, unspent, and inside its window. */
export function isSpendable(donor: BedolagaPromocode, now: number): boolean {
  if (!donor.is_active) return false;
  if (donor.code.trim().length === 0) return false;
  if (donor.max_uses > 0 && donor.current_uses >= donor.max_uses) return false;
  if (donor.valid_until !== null && new Date(donor.valid_until).getTime() <= now) return false;
  return true;
}

/**
 * What one of their promocodes actually does, in our vocabulary.
 *
 * ⚠ The `discount` type overloads two columns and reads nothing like it looks:
 * `balance_bonus_kopeks` holds a PERCENT and `subscription_days` holds HOURS.
 * Taken at face value a 50 % coupon becomes fifty kopecks — or, read the other
 * way round, fifty roubles becomes a 5000 % discount.
 *
 * `balance` has no home: we carry money as points, and a code that mints
 * points is not something this panel has. Reported as skipped rather than
 * turned into something else.
 */
export function promocodeAction(
  donor: BedolagaPromocode,
): { readonly type: 'DURATION' | 'TRAFFIC' | 'PURCHASE_DISCOUNT'; readonly value: number } | null {
  switch (donor.type) {
    case 'subscription_days':
    case 'balance_and_days':
      return donor.subscription_days > 0
        ? { type: 'DURATION', value: donor.subscription_days }
        : null;
    case 'discount': {
      const percent = clampDiscountPercent(donor.balance_bonus_kopeks);
      return percent > 0 ? { type: 'PURCHASE_DISCOUNT', value: percent } : null;
    }
    default:
      return donor.traffic_gb > 0 ? { type: 'TRAFFIC', value: donor.traffic_gb } : null;
  }
}

function toDate(raw: string | null): Date | null {
  if (raw === null) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Their tariff in the shape the plan cloner already knows how to read. */
function mapTariffToPlanRow(tariff: BedolagaTariff): Record<string, unknown> {
  return {
    id: tariff.id,
    name: tariff.name,
    description: tariff.description,
    // Zero means unlimited on both sides of this hand-off: their column says
    // so, and the cloner writes `> 0 ? value : null` when it creates the plan.
    traffic_limit: tariff.traffic_limit_gb,
    device_limit: tariff.device_limit,
    internal_squads: [...tariff.allowed_squads],
    external_squad: tariff.external_squad_uuid,
    is_active: tariff.is_active,
    order_index: tariff.display_order,
  };
}

/**
 * A synthetic duration id, and why it has to be a NUMBER.
 *
 * Bedolaga has no duration rows — a tariff carries a `{days: kopeks}` table —
 * so the id is invented here to join a price to its period. The plan cloner
 * reads both sides with `Number(...)`, so anything else (`"12:30"`, say)
 * arrives as NaN on both and every price silently loses its duration.
 */
function durationId(tariffId: number, days: number): number {
  return tariffId * 100_000 + days;
}

/** One duration per period their price table names. */
function deriveDurations(tariffs: readonly BedolagaTariff[]): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const tariff of tariffs) {
    for (const days of Object.keys(tariff.period_prices)) {
      const parsed = Number.parseInt(days, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) continue;
      rows.push({ id: durationId(tariff.id, parsed), plan_id: tariff.id, days: parsed });
    }
  }
  return rows;
}

/** Kopeks to major units — the cloner writes prices, not coins. */
function derivePrices(tariffs: readonly BedolagaTariff[]): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const tariff of tariffs) {
    for (const [days, kopeks] of Object.entries(tariff.period_prices)) {
      const parsed = Number.parseInt(days, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) continue;
      rows.push({
        id: durationId(tariff.id, parsed),
        plan_duration_id: durationId(tariff.id, parsed),
        currency: 'RUB',
        price: (kopeks / 100).toFixed(2),
      });
    }
  }
  return rows;
}
