import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  AddOnType,
  Currency,
  ImportStatus,
  Locale,
  PaymentGatewayType,
  Prisma,
  PurchaseChannel,
  PurchaseType,
  SubscriptionStatus,
  TransactionStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import { ImportSummary } from '../interfaces/import-summary.interface';
import {
  buildPanelLookup,
  panelSubscriptionState,
  reconcileMissingPanelStatus,
  resolvePanelProfile,
  type PanelLookup,
} from '../utils/remnawave-overlay.util';
import {
  StealthnetClient,
  StealthnetPayment,
  StealthnetSubscription,
  StealthnetTariff,
  StealthnetTariffCategory,
  StealthnetTariffPriceOption,
} from '../utils/stealthnet-backup-parser';

interface RunInput {
  readonly mode: 'import' | 'sync';
  readonly createdBy: string | null;
  /** Pre-allocated `ImportRecord.id` to update instead of creating new. */
  readonly importRecordId?: string | null;
  readonly clients: readonly StealthnetClient[];
  readonly subscriptions: readonly StealthnetSubscription[];
  readonly tariffs: readonly StealthnetTariff[];
  readonly tariffCategories: readonly StealthnetTariffCategory[];
  readonly tariffPriceOptions: readonly StealthnetTariffPriceOption[];
  readonly payments: readonly StealthnetPayment[];
  /**
   * Optional migration goodwill: convert each imported user's leftover
   * STEALTHNET wallet balance into loyalty points. Applied only on user
   * CREATE (idempotent across re-runs). Defaults to enabled at a 1:1 rate.
   */
  readonly balanceToPoints?: { readonly enabled: boolean; readonly rate: number };
}

/** Normalized balance→points conversion config resolved once per run. */
interface BalanceToPointsConfig {
  readonly enabled: boolean;
  readonly rate: number;
}

/**
 * Importer for STEALTHNET (https://github.com/systemmaster1200-eng/remnawave-STEALTHNET-Bot)
 * pg_dump backups.
 *
 * STEALTHNET data lands in our schema like so:
 *   • clients                  → User (+ optional WebAccount when `email + password_hash` are set)
 *   • secondary_subscriptions  → Subscription (one per remnawave UUID)
 *   • tariffs / tariff_*       → kept in `result.catalog` for the optional clone-plans step
 *   • payments                 → Transaction (historical, idempotent on `paymentId`)
 *
 * Matching priority for users:
 *   1. `telegram_id` → User.telegramId
 *   2. `email`       → User.email (only when present and unique on our side)
 *   3. No match      → create new User (import mode only); for web-only users
 *      we additionally provision a WebAccount with the imported password hash
 *      so the user can sign in via reiwa exactly as before.
 *
 * Skip behaviour:
 *   • A row with neither telegram_id NOR email is skipped (we have no
 *     stable way to identify it; STEALTHNET ids are not reused).
 *   • A row whose match resolves to an existing User is updated in place
 *     and counted as `updated`.
 *
 * Subscriptions are written exactly like altshop's: indexed by
 * `remnawave_uuid`, idempotent on re-run, with `planSnapshot.importedFrom
 * = 'stealthnet'` so the Plan Cloner can find them later.
 */
@Injectable()
export class StealthnetImporterService {
  private readonly logger = new Logger(StealthnetImporterService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
  ) {}

  public async run(input: RunInput): Promise<ImportSummary> {
    const {
      mode,
      createdBy,
      importRecordId,
      clients,
      subscriptions,
      tariffs,
      tariffCategories,
      tariffPriceOptions,
      payments,
    } = input;

    if (clients.length === 0) {
      throw new BadRequestException('STEALTHNET backup contains no client records');
    }

    // ── Index inputs once for O(1) joins ────────────────────────────────────
    const subsByOwner = new Map<string, StealthnetSubscription[]>();
    for (const sub of subscriptions) {
      const list = subsByOwner.get(sub.owner_id) ?? [];
      list.push(sub);
      subsByOwner.set(sub.owner_id, list);
    }

    const paymentsByClient = new Map<string, StealthnetPayment[]>();
    for (const payment of payments) {
      const list = paymentsByClient.get(payment.client_id) ?? [];
      list.push(payment);
      paymentsByClient.set(payment.client_id, list);
    }

    const tariffById = new Map<string, StealthnetTariff>();
    for (const tariff of tariffs) tariffById.set(tariff.id, tariff);

    // Cross-check every backup subscription against the LIVE Remnawave panel:
    // profiles the panel still has get refreshed from it (the truth), profiles
    // it no longer has become EXPIRED. Scales past the bulk ceiling via a
    // targeted per-UUID fallback; fail-soft to backup values if unreachable.
    const panelLookup = await buildPanelLookup(() => this.remnawaveApiService.getAllPanelUsers());

    const errors: string[] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let subscriptionsCreated = 0;
    let subscriptionsUpdated = 0;
    let transactionsCreated = 0;
    const createdUserIds: string[] = [];

    // Resolve the balance→points conversion once. Default: enabled at 1:1 so
    // callers that omit the option keep the migration-friendly behaviour.
    const pointsConversion: BalanceToPointsConfig = {
      enabled: input.balanceToPoints?.enabled ?? true,
      rate:
        input.balanceToPoints?.rate !== undefined &&
        Number.isFinite(input.balanceToPoints.rate) &&
        input.balanceToPoints.rate > 0
          ? input.balanceToPoints.rate
          : 1,
    };
    let pointsGranted = 0;

    for (const client of clients) {
      const identifier = client.telegram_id ?? client.email ?? client.id;
      try {
        const userId = await this.matchOrCreateUser(client, mode);
        if (userId === null) {
          skipped += 1;
          continue;
        }

        const wasJustCreated = await this.wasJustCreated(userId);
        if (wasJustCreated) {
          created += 1;
          createdUserIds.push(userId);
        } else {
          updated += 1;
        }

        // Migration goodwill: carry the user's leftover STEALTHNET wallet
        // balance over as loyalty points so they don't lose money when the
        // owner switches panels. Idempotent: credited only while the user
        // still has 0 points (guarded `updateMany`), so a re-import never
        // double-credits and already-earned points are never overwritten.
        // This covers both freshly-created users AND ones matched to an
        // existing account (e.g. re-import after a prior run).
        if (pointsConversion.enabled) {
          const points = balanceToPoints(client.balance, pointsConversion.rate);
          if (points > 0) {
            const credited = await this.prismaService.user.updateMany({
              where: { id: userId, points: 0 },
              data: { points },
            });
            if (credited.count > 0) pointsGranted += points;
          }
        }

        // Subscriptions
        const userSubs = subsByOwner.get(client.id) ?? [];
        for (const sub of userSubs) {
          const result = await this.syncSubscription(userId, sub, tariffById, panelLookup);
          if (result === 'created') subscriptionsCreated += 1;
          else if (result === 'updated') subscriptionsUpdated += 1;
        }

        // Payments → Transactions (historical)
        const userPayments = paymentsByClient.get(client.id) ?? [];
        for (const payment of userPayments) {
          const created = await this.importPayment(userId, payment, tariffById);
          if (created) transactionsCreated += 1;
        }
      } catch (err) {
        const message = `${identifier}: ${(err as Error).message}`;
        errors.push(message);
        this.logger.warn(`stealthnet importer row failed: ${message}`);
      }
    }

    // Ensure sellable EXTRA_DEVICES catalog rows exist for any observed
    // STEALTHNET extra-device prices (tariff price_per_extra_device or
    // subscription-level monthly extras). Idempotent by name.
    const derivedAddOns = deriveExtraDeviceAddOns(tariffs, subscriptions);
    let addOnsCreated = 0;
    try {
      addOnsCreated = await this.ensureExtraDeviceAddOns(derivedAddOns);
    } catch (err) {
      const message = `extra-device add-ons: ${(err as Error).message}`;
      errors.push(message);
      this.logger.warn(message);
    }

    const finalStatus = errors.length === 0 ? ImportStatus.COMMITTED : ImportStatus.FAILED;
    const resultPayload: Prisma.InputJsonValue = {
      mode,
      fetched: clients.length,
      created,
      updated,
      skipped,
      subscriptionsCreated,
      subscriptionsUpdated,
      transactionsProcessed: payments.length,
      transactionsCreated,
      pointsGranted,
      addOnsCreated,
      errors,
      rollback: { createdUserIds },
      // Catalog snapshot — reused by BackupPlanClonerService for the
      // optional second-step clone. We pre-translate STEALTHNET rows
      // into the same shape altshop emits so the cloner doesn't need
      // a third source-specific branch.
      catalog: JSON.parse(
        JSON.stringify({
          plans: tariffs.map((t) => mapTariffToPlanRow(t, tariffCategories)),
          planDurations: deriveDurations(tariffs, tariffPriceOptions),
          planPrices: derivePrices(tariffs, tariffPriceOptions),
          // STEALTHNET does not have a separate add_ons table — extra
          // devices are tariff/subscription fields. Surface a synthetic
          // EXTRA_DEVICES catalog so clone/operator can recreate pricing.
          addOns: derivedAddOns,
        }),
      ),
    };
    const errorMessage = errors.length === 0 ? null : errors.slice(0, 5).join('; ');

    const importRecord = importRecordId
      ? await this.prismaService.importRecord.update({
          where: { id: importRecordId },
          data: {
            status: finalStatus,
            recordsTotal: clients.length,
            recordsOk: created + updated,
            recordsFailed: errors.length,
            result: resultPayload,
            errorMessage,
            committedAt: new Date(),
          },
        })
      : await this.prismaService.importRecord.create({
          data: {
            filename: `stealthnet-${mode}-${new Date().toISOString()}.sql`,
            sourceType: 'stealthnet',
            status: finalStatus,
            recordsTotal: clients.length,
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
      fetched: clients.length,
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
    client: StealthnetClient,
    mode: 'import' | 'sync',
  ): Promise<string | null> {
    // Priority 1: telegram_id
    const telegramId = parseTelegramId(client.telegram_id);
    if (telegramId !== null) {
      const existing = await this.prismaService.user.findUnique({
        where: { telegramId },
        select: { id: true },
      });
      if (existing) {
        await this.updateUserFields(existing.id, client);
        await this.upsertWebAccountIfNeeded(existing.id, client);
        return existing.id;
      }
    }

    // Priority 2: email
    if (client.email) {
      const existing = await this.prismaService.user.findUnique({
        where: { email: client.email.toLowerCase() },
        select: { id: true },
      });
      if (existing) {
        await this.updateUserFields(existing.id, client);
        await this.upsertWebAccountIfNeeded(existing.id, client);
        return existing.id;
      }
    }

    // Sync mode — never creates new users.
    if (mode === 'sync') return null;

    // No telegram and no email → we cannot pin this user to anything
    // useful. STEALTHNET ids are not reusable across systems, and
    // re-running the import would create duplicates. Skip explicitly.
    if (telegramId === null && !client.email) return null;

    const newUser = await this.prismaService.user.create({
      data: {
        telegramId,
        username: client.telegram_username ?? null,
        email: client.email ? client.email.toLowerCase() : null,
        name: client.telegram_username ?? client.email ?? `stealthnet-${client.id.slice(0, 8)}`,
        language: this.mapLocale(client.preferred_lang),
        isBlocked: client.is_blocked,
      },
    });
    await this.upsertWebAccountIfNeeded(newUser.id, client);
    return newUser.id;
  }

  private async updateUserFields(userId: string, client: StealthnetClient): Promise<void> {
    const data: Prisma.UserUpdateInput = {};
    if (client.telegram_username) data.username = client.telegram_username;
    if (client.email) data.email = client.email.toLowerCase();
    data.isBlocked = client.is_blocked;
    if (Object.keys(data).length > 0) {
      try {
        await this.prismaService.user.update({ where: { id: userId }, data });
      } catch (err) {
        // Email collisions are common when multiple imports overlap —
        // log and move on, the rest of the user state is still useful.
        this.logger.debug(`updateUserFields skipped for ${userId}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * STEALTHNET supports email-only customers (no telegram). For those
   * we provision a WebAccount carrying the imported password hash so
   * they can keep signing into reiwa with their existing creds. When
   * the user has neither email nor password, this is a no-op.
   */
  private async upsertWebAccountIfNeeded(
    userId: string,
    client: StealthnetClient,
  ): Promise<void> {
    if (!client.email || !client.password_hash) return;
    const normalizedEmail = client.email.toLowerCase();
    const existing = await this.prismaService.webAccount.findUnique({
      where: { userId },
      select: { id: true, passwordHash: true },
    });
    if (existing) {
      // Don't clobber a hash the operator may have rotated since last import.
      if (existing.passwordHash) return;
      await this.prismaService.webAccount.update({
        where: { userId },
        data: {
          email: normalizedEmail,
          emailNormalized: normalizedEmail,
          passwordHash: client.password_hash,
          credentialsBootstrappedAt: new Date(),
        },
      });
      return;
    }
    try {
      await this.prismaService.webAccount.create({
        data: {
          userId,
          login: normalizedEmail,
          loginNormalized: normalizedEmail,
          email: normalizedEmail,
          emailNormalized: normalizedEmail,
          passwordHash: client.password_hash,
          credentialsBootstrappedAt: new Date(),
        },
      });
    } catch (err) {
      // Unique constraints may collide if another user already owns
      // this email/login normalised — log and skip.
      this.logger.debug(`webAccount create skipped for ${userId}: ${(err as Error).message}`);
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

  // ── Subscription sync ─────────────────────────────────────────────────────

  private async syncSubscription(
    userId: string,
    sub: StealthnetSubscription,
    tariffById: ReadonlyMap<string, StealthnetTariff>,
    panelLookup: PanelLookup,
  ): Promise<'created' | 'updated' | 'skipped'> {
    if (!sub.remnawave_uuid) return 'skipped';

    const existing = await this.prismaService.subscription.findFirst({
      where: { remnawaveId: sub.remnawave_uuid },
      select: { id: true, userId: true },
    });

    const tariff = sub.tariff_id ? tariffById.get(sub.tariff_id) : undefined;
    const tariffSquads = tariff?.internal_squad_uuids ? [...tariff.internal_squad_uuids] : [];

    const baseDevices =
      tariff?.device_limit ??
      (tariff?.included_devices && tariff.included_devices > 0 ? tariff.included_devices : 0);
    const extraDevices = Math.max(0, sub.extra_devices ?? 0);
    const backupDeviceLimit = baseDevices + extraDevices;

    const planSnapshot: Prisma.InputJsonValue = {
      importedFrom: 'stealthnet',
      sourceSubscriptionId: sub.id,
      sourceTariffId: sub.tariff_id,
      // Mirror altshop's `originalPlanSnapshot.id` shape so the Plan
      // Cloner's `extractSourcePlanId()` walks both seamlessly.
      originalPlanSnapshot: tariff
        ? {
            id: tariff.id,
            name: tariff.name,
            duration_days: tariff.duration_days,
            included_devices: tariff.included_devices,
            max_extra_devices: tariff.max_extra_devices,
            price_per_extra_device: tariff.price_per_extra_device,
          }
        : null,
      tariffName: tariff?.name ?? null,
      currency: tariff?.currency ?? null,
      durationDays: tariff?.duration_days ?? null,
      // STEALTHNET "extra devices" are per-subscription, not a separate
      // entitlement table — surface them for clone/analytics + device sum.
      extraDevices,
      extraDevicesMonthlyPrice: sub.extra_devices_monthly_price ?? 0,
      backupExpireAt: sub.expire_at,
    };

    // Remnawave is the source of truth. If the panel still has this profile,
    // overlay its FRESH state (active subscriptions become accurate). If it's
    // gone from the panel, the subscription is no longer live → EXPIRED, kept
    // locally so the user can re-buy through the bot.
    const { panel, known } = await resolvePanelProfile(
      sub.remnawave_uuid,
      panelLookup,
      (uuid) => this.remnawaveApiService.getPanelUser(uuid),
    );
    const backupExpiresAt = parseOptionalDate(sub.expire_at);
    const dataShared = panel
      ? (() => {
          const fresh = panelSubscriptionState(panel);
          // Prefer panel device limit; if panel reports 0/null but the dump
          // has included+extra devices, keep the higher backup sum so the
          // operator does not lose paid extra slots during import.
          const panelDevices = fresh.deviceLimit ?? 0;
          const deviceLimit =
            panelDevices > 0 ? Math.max(panelDevices, backupDeviceLimit) : backupDeviceLimit || panelDevices;
          return {
            status: fresh.status,
            isTrial: false,
            trafficLimit: fresh.trafficLimit,
            deviceLimit,
            internalSquads: fresh.internalSquads.length > 0 ? fresh.internalSquads : tariffSquads,
            externalSquad: fresh.externalSquad,
            configUrl: fresh.configUrl,
            expiresAt: fresh.expiresAt ?? backupExpiresAt,
            planSnapshot,
          };
        })()
      : {
          status: reconcileMissingPanelStatus(known, SubscriptionStatus.ACTIVE),
          isTrial: false,
          trafficLimit:
            tariff?.traffic_limit_bytes && tariff.traffic_limit_bytes > 0
              ? Math.max(1, Math.round(Number(tariff.traffic_limit_bytes) / 1024 ** 3))
              : null,
          deviceLimit: backupDeviceLimit,
          internalSquads: tariffSquads,
          expiresAt: backupExpiresAt,
          planSnapshot,
        };

    if (existing) {
      await this.prismaService.subscription.update({
        where: { id: existing.id },
        data: dataShared,
      });
      if (existing.userId !== userId) {
        await this.prismaService.subscription.update({
          where: { id: existing.id },
          data: { user: { connect: { id: userId } } },
        });
      }
      return 'updated';
    }

    const newSub = await this.prismaService.subscription.create({
      data: {
        ...dataShared,
        user: { connect: { id: userId } },
        remnawaveId: sub.remnawave_uuid,
        startedAt: sub.created_at ? new Date(sub.created_at) : new Date(),
      },
    });

    // No ProfileSyncJob: the import READS from Remnawave (the truth) and must
    // never push the backup's possibly-stale state back, which would clobber
    // live profiles. Expired/gone profiles are intentionally not re-provisioned
    // — the user re-buys through the bot to get a fresh subscription.

    // Fill in `currentSubscriptionId` if the user has none yet —
    // otherwise leave the operator's existing pick alone.
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
      select: { currentSubscriptionId: true },
    });
    if (!user?.currentSubscriptionId) {
      await this.prismaService.user.update({
        where: { id: userId },
        data: { currentSubscriptionId: newSub.id },
      });
    }

    return 'created';
  }

  // ── Payment → Transaction ────────────────────────────────────────────────

  private async importPayment(
    userId: string,
    payment: StealthnetPayment,
    tariffById: ReadonlyMap<string, StealthnetTariff>,
  ): Promise<boolean> {
    // Idempotency: STEALTHNET's order_id is the most stable provider
    // identifier. Skip if we already have a Transaction for it.
    const existing = await this.prismaService.transaction.findUnique({
      where: { paymentId: payment.order_id },
      select: { id: true },
    });
    if (existing) return false;

    const gatewayType = this.mapGatewayType(payment.provider);
    const currency = this.mapCurrency(payment.currency);
    if (!gatewayType || !currency) return false;

    const tariff = payment.tariff_id ? tariffById.get(payment.tariff_id) : undefined;

    try {
      await this.prismaService.transaction.create({
        data: {
          user: { connect: { id: userId } },
          paymentId: payment.order_id,
          status: this.mapTransactionStatus(payment.status),
          purchaseType: PurchaseType.NEW,
          gatewayType,
          gatewayId: payment.external_id ?? undefined,
          gatewayData: payment.metadata ? safeParseJson(payment.metadata) : undefined,
          amount: payment.amount,
          currency,
          channel: PurchaseChannel.WEB,
          planSnapshot: {
            importedFrom: 'stealthnet',
            sourcePaymentId: payment.id,
            sourceTariffId: payment.tariff_id,
            tariffName: tariff?.name ?? null,
            durationDays: tariff?.duration_days ?? null,
          } satisfies Prisma.InputJsonValue,
          createdAt: payment.created_at ? new Date(payment.created_at) : new Date(),
        },
      });
      return true;
    } catch (err) {
      this.logger.debug(`Transaction import skipped for payment ${payment.id}: ${(err as Error).message}`);
      return false;
    }
  }

  // ── Mapping helpers ───────────────────────────────────────────────────────

  private mapLocale(locale: string | null): Locale {
    if (!locale) return Locale.EN;
    const upper = locale.toUpperCase();
    if (upper in Locale) return upper as Locale;
    return Locale.EN;
  }

  private mapTransactionStatus(status: string): TransactionStatus {
    switch (status.toUpperCase()) {
      case 'PAID':
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

  private mapGatewayType(gateway: string | null): PaymentGatewayType | null {
    if (!gateway) return null;
    const upper = gateway.toUpperCase().replace(/[-\s]/g, '_');
    const validGateways: Record<string, PaymentGatewayType> = {
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
    };
    // STEALTHNET-specific spellings — admin grants and similar internal
    // operations are intentionally not mapped (they don't represent
    // real provider charges so they don't belong in our Transaction
    // ledger). Returning null here makes `importPayment` silently skip.
    return validGateways[upper] ?? null;
  }

  private mapCurrency(currency: string): Currency | null {
    const upper = currency.toUpperCase();
    const validCurrencies: Record<string, Currency> = {
      USD: Currency.USD,
      RUB: Currency.RUB,
      USDT: Currency.USDT,
      XTR: Currency.XTR,
      TON: Currency.TON,
      BTC: Currency.BTC,
      ETH: Currency.ETH,
    };
    return validCurrencies[upper] ?? null;
  }

  /**
   * Create missing EXTRA_DEVICES catalog items (+ prices) for STEALTHNET
   * extra-device unit prices. Existing names are left alone (idempotent).
   */
  private async ensureExtraDeviceAddOns(
    rows: ReadonlyArray<Record<string, unknown>>,
  ): Promise<number> {
    let created = 0;
    for (const row of rows) {
      const name = typeof row.name === 'string' ? row.name : null;
      if (!name) continue;
      const existing = await this.prismaService.addOn.findFirst({
        where: { name },
        select: { id: true },
      });
      if (existing) continue;
      const currencyRaw =
        Array.isArray(row.prices) &&
        row.prices[0] &&
        typeof (row.prices[0] as { currency?: string }).currency === 'string'
          ? (row.prices[0] as { currency: string }).currency
          : 'RUB';
      const priceRaw =
        Array.isArray(row.prices) &&
        row.prices[0] &&
        typeof (row.prices[0] as { price?: number }).price === 'number'
          ? (row.prices[0] as { price: number }).price
          : 0;
      const currency = this.mapCurrency(currencyRaw) ?? Currency.RUB;
      await this.prismaService.addOn.create({
        data: {
          name,
          description:
            typeof row.description === 'string'
              ? row.description
              : 'Imported from STEALTHNET extra-device pricing',
          type: AddOnType.EXTRA_DEVICES,
          value: 1,
          isActive: true,
          orderIndex: typeof row.order_index === 'number' ? row.order_index : 0,
          prices: {
            create: [{ currency, price: priceRaw }],
          },
        },
      });
      created += 1;
    }
    return created;
  }
}

// ── Module-level helpers ────────────────────────────────────────────────────
//
// Pure functions with no DI; kept here rather than in `utils/` because
// they only make sense in the shape of the catalog payload that the
// importer emits.

/**
 * Converts a leftover STEALTHNET wallet balance into loyalty points.
 *
 * STEALTHNET stores balance as major currency units (double, e.g. RUB).
 * Fractional coppers/kopecks are first rounded half-up to 2 decimals so
 * float dust (`10.005`, `19.999999`) does not strand or invent value,
 * then `major * rate` is rounded half-up to whole points.
 *
 * Rate = points per 1 major unit (default 1:1). Never negative.
 * Credited once per migrated user (guarded by `points = 0` updateMany).
 */
export function balanceToPoints(balance: number, rate: number): number {
  if (!Number.isFinite(balance) || balance <= 0) return 0;
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  // Integer kopecks (half-up). Small epsilon kills IEEE dust on *100
  // (e.g. 1.005 * 100 → 100.4999… without epsilon).
  const kopecks = Math.round(balance * 100 + 1e-8);
  if (kopecks <= 0) return 0;
  // points = (kopecks/100) * rate, half-up via integer arithmetic.
  return Math.round((kopecks * rate) / 100 + 1e-8);
}

/**
 * STEALTHNET's `telegram_id` is stored as text (the schema column
 * type is `text`). We coerce it to bigint, matching our schema, and
 * filter out empty/zero values which would otherwise collide with
 * the `User.telegramId @unique` constraint.
 */
function parseTelegramId(raw: string | null): bigint | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '0') return null;
  try {
    const n = BigInt(trimmed);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

/**
 * Translate a STEALTHNET tariff row into the same shape altshop's
 * cataloging emits. The cloner reads
 * `result.catalog.plans[].id/name/internal_squads/...` directly so the
 * field names matter.
 */
function parseOptionalDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Build synthetic EXTRA_DEVICES add-on rows from tariff
 * `price_per_extra_device` and any observed subscription extras.
 * Rezeis stores paid extras as catalog add-ons + entitlements; STEALTHNET
 * only stores counters — cloning recreates the sellable unit.
 */
function deriveExtraDeviceAddOns(
  tariffs: readonly StealthnetTariff[],
  subscriptions: readonly StealthnetSubscription[],
): ReadonlyArray<Record<string, unknown>> {
  const prices = new Map<string, { currency: string; price: number }>();
  for (const t of tariffs) {
    if (t.price_per_extra_device > 0) {
      const currency = (t.currency || 'rub').toUpperCase();
      prices.set(`${currency}:${t.price_per_extra_device}`, {
        currency,
        price: t.price_per_extra_device,
      });
    }
  }
  for (const s of subscriptions) {
    if (s.extra_devices > 0 && s.extra_devices_monthly_price > 0) {
      // Subscription-level monthly price is in major units of the shop
      // default (RUB in this dump). Use RUB unless tariffs say otherwise.
      const currency = 'RUB';
      const key = `${currency}:${s.extra_devices_monthly_price}`;
      if (!prices.has(key)) {
        prices.set(key, { currency, price: s.extra_devices_monthly_price });
      }
    }
  }
  return Array.from(prices.values()).map((p, index) => ({
    id: stableHashId(`extra-device-${p.currency}-${p.price}`),
    name: `Extra device (${p.price} ${p.currency}/mo)`,
    description: 'Imported from STEALTHNET tariff/subscription extra-device pricing',
    type: 'EXTRA_DEVICES',
    value: 1,
    is_active: true,
    order_index: index,
    lifetime: 'UNTIL_SUBSCRIPTION_END',
    prices: [{ currency: p.currency, price: p.price }],
    source: 'stealthnet',
  }));
}

function mapTariffToPlanRow(
  tariff: StealthnetTariff,
  categories: readonly StealthnetTariffCategory[],
): Record<string, unknown> {
  // Source IDs in altshop's catalog are integers, not CUIDs. We hash
  // STEALTHNET CUIDs into stable integers so the cloner's internal
  // `Map<number, string>` works without changes.
  const sortIndex = categories.findIndex((c) => c.id === tariff.category_id);
  const deviceLimit =
    tariff.device_limit !== null && tariff.device_limit !== undefined && tariff.device_limit > 0
      ? tariff.device_limit
      : tariff.included_devices > 0
        ? tariff.included_devices
        : 0;
  return {
    id: stableHashId(tariff.id),
    order_index: tariff.sort_order,
    is_active: true,
    is_archived: false,
    type: 'BOTH',
    availability: 'ALL',
    archived_renew_mode: null,
    name: tariff.name,
    description: tariff.description,
    tag: null,
    device_limit: deviceLimit,
    included_devices: tariff.included_devices,
    max_extra_devices: tariff.max_extra_devices,
    price_per_extra_device: tariff.price_per_extra_device,
    traffic_limit:
      tariff.traffic_limit_bytes && tariff.traffic_limit_bytes > 0
        ? Number(tariff.traffic_limit_bytes)
        : 0,
    traffic_limit_strategy: mapResetMode(tariff.traffic_reset_mode),
    replacement_plan_ids: [],
    upgrade_to_plan_ids: [],
    allowed_user_ids: [],
    internal_squads: tariff.internal_squad_uuids,
    external_squad: null,
    _sourceCategorySortIndex: sortIndex,
  };
}

function deriveDurations(
  tariffs: readonly StealthnetTariff[],
  options: readonly StealthnetTariffPriceOption[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  // Each tariff's base `(duration_days, price)` becomes the canonical
  // duration. Additional price options are layered on top with
  // synthetic ids so the cloner can reference them as PlanPrice rows.
  for (const tariff of tariffs) {
    const planId = stableHashId(tariff.id);
    const baseDurationId = stableHashId(`${tariff.id}#base`);
    // STEALTHNET stores the baseline `(duration_days, price)` on the tariff
    // row AND frequently repeats it as a `tariff_price_options` row. Emit the
    // base once and skip any option that repeats an already-emitted day-count,
    // so the catalog snapshot never carries duplicate durations.
    const seenDays = new Set<number>([tariff.duration_days]);
    out.push({ id: baseDurationId, plan_id: planId, days: tariff.duration_days });
    for (const opt of options.filter((o) => o.tariff_id === tariff.id)) {
      if (seenDays.has(opt.duration_days)) continue;
      seenDays.add(opt.duration_days);
      out.push({ id: stableHashId(opt.id), plan_id: planId, days: opt.duration_days });
    }
  }
  return out;
}

function derivePrices(
  tariffs: readonly StealthnetTariff[],
  options: readonly StealthnetTariffPriceOption[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const tariff of tariffs) {
    const baseDurationId = stableHashId(`${tariff.id}#base`);
    // Mirror deriveDurations' dedupe so every price points at a duration that
    // actually exists (options repeating the base day-count are skipped).
    const seenDays = new Set<number>([tariff.duration_days]);
    out.push({
      id: stableHashId(`${tariff.id}#base-price`),
      plan_duration_id: baseDurationId,
      currency: tariff.currency.toUpperCase(),
      price: String(tariff.price),
    });
    for (const opt of options.filter((o) => o.tariff_id === tariff.id)) {
      if (seenDays.has(opt.duration_days)) continue;
      seenDays.add(opt.duration_days);
      out.push({
        id: stableHashId(`${opt.id}#price`),
        plan_duration_id: stableHashId(opt.id),
        currency: tariff.currency.toUpperCase(),
        price: String(opt.price),
      });
    }
  }
  return out;
}

function mapResetMode(mode: string): string {
  switch (mode.toLowerCase()) {
    case 'monthly':
    case 'monthly_rolling':
      return 'MONTH';
    case 'weekly':
    case 'weekly_rolling':
      return 'WEEK';
    case 'daily':
    case 'daily_rolling':
      return 'DAY';
    case 'no_reset':
    default:
      return 'NO_RESET';
  }
}

/**
 * Deterministic 31-bit hash of a CUID-like string. Used to fabricate
 * integer source-plan ids that the cloner's catalog expects. Two
 * CUIDs colliding would degrade the user experience (clone preview
 * shows the wrong subscription count) but never corrupts data — the
 * cloner identifies real plans through the catalog payload, never
 * through these synthetic ids beyond Map lookups.
 */
function stableHashId(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function safeParseJson(value: string): Prisma.InputJsonValue | undefined {
  try {
    return JSON.parse(value) as Prisma.InputJsonValue;
  } catch {
    return undefined;
  }
}
