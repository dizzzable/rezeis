import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
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
import { loginPolicy } from '../../auth/utils/login-policy.util';
import { ImportSummary } from '../interfaces/import-summary.interface';
import {
  buildPanelLookup,
  panelSubscriptionState,
  reconcileMissingPanelStatus,
  resolvePanelProfile,
  type PanelLookup,
} from '../utils/remnawave-overlay.util';
import {
  AltshopPlan,
  AltshopPlanDuration,
  AltshopPlanPrice,
} from '../utils/altshop-backup-parser';

/**
 * Shape of an altshop user record as exported from the altshop PostgreSQL DB.
 * Matches the `users` table (SQLAlchemy model in `src/infrastructure/database/models/sql/user.py`).
 */
export interface AltshopUser {
  /** Auto-increment PK from altshop */
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
  /** Locale code */
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
 * Shape of an altshop subscription record.
 */
export interface AltshopSubscription {
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
  /** Traffic limit */
  readonly traffic_limit: number;
  /** Max devices */
  readonly device_limit: number;
  /** Traffic limit strategy */
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
  /** Device type */
  readonly device_type: string | null;
  /** ISO timestamp */
  readonly created_at: string;
}

/**
 * Shape of an altshop web-account record (cabinet login). The bcrypt
 * `password_hash` is intentionally NOT modelled — it is unusable by the rezeis
 * cabinet (scrypt(SHA256)), so imported accounts are claim-pending instead.
 */
export interface AltshopWebAccount {
  /** Owner's telegram_id (may be a synthetic negative id for web-only users). */
  readonly user_telegram_id: number;
  /** Cabinet login. */
  readonly username: string | null;
  /** Optional email. */
  readonly email: string | null;
}

/**
 * Shape of an altshop transaction record.
 */
export interface AltshopTransaction {
  /** Auto-increment PK */
  readonly id: number;
  /** Stable payment identifier (provider-facing) */
  readonly payment_id: string;
  /** Payer's telegram_id */
  readonly user_telegram_id: number;
  /** Status: PENDING, COMPLETED, CANCELED, REFUNDED, FAILED */
  readonly status: string;
  /** Purchase type: NEW, RENEW, CHANGE */
  readonly purchase_type: string;
  /** Gateway type */
  readonly gateway_type: string;
  /** Pricing breakdown (JSONB) */
  readonly pricing: Record<string, unknown> | null;
  /** Currency: USD, XTR, RUB */
  readonly currency: string;
  /** Frozen plan data */
  readonly plan_snapshot: Record<string, unknown> | null;
  /** Purchase channel: WEB, TELEGRAM */
  readonly channel: string | null;
  /** ISO timestamp */
  readonly created_at: string;
}

interface RunInput {
  readonly mode: 'import' | 'sync';
  readonly createdBy: string | null;
  /** Pre-allocated `ImportRecord.id` to update instead of creating new. */
  readonly importRecordId?: string | null;
  readonly users: readonly AltshopUser[];
  readonly subscriptions: readonly AltshopSubscription[];
  readonly transactions?: readonly AltshopTransaction[];
  readonly webAccounts?: readonly AltshopWebAccount[];
  /** See altshop-backup-parser.ts for shape. */
  readonly plans?: readonly AltshopPlan[];
  readonly planDurations?: readonly AltshopPlanDuration[];
  readonly planPrices?: readonly AltshopPlanPrice[];
}

/**
 * Importer for altshop (Python/SQLAlchemy) data.
 *
 * Expects JSON arrays: users + subscriptions + optional transactions
 * (exported from altshop's PostgreSQL database).
 *
 * Matching priority:
 *   1. telegram_id → match by telegramId
 *   2. No match → create new User (import mode only)
 *
 * After matching/creating a User:
 *   - Creates or updates Subscriptions linked by user_remna_id (Remnawave UUID)
 *   - Optionally imports transactions as historical records
 */
@Injectable()
export class AltshopImporterService {
  private readonly logger = new Logger(AltshopImporterService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
  ) {}

  public async run(input: RunInput): Promise<ImportSummary> {
    const { users, subscriptions, transactions, mode, createdBy, importRecordId, plans, planDurations, planPrices } = input;

    if (!users || users.length === 0) {
      throw new BadRequestException('No user records provided');
    }

    // Index web accounts by telegram_id (first one wins per user).
    const webAccountByTelegramId = new Map<number, AltshopWebAccount>();
    for (const wa of input.webAccounts ?? []) {
      if (!webAccountByTelegramId.has(wa.user_telegram_id)) {
        webAccountByTelegramId.set(wa.user_telegram_id, wa);
      }
    }

    // Index subscriptions by telegram_id
    const subsByTelegramId = new Map<number, AltshopSubscription[]>();
    for (const sub of subscriptions ?? []) {
      const existing = subsByTelegramId.get(sub.user_telegram_id) ?? [];
      existing.push(sub);
      subsByTelegramId.set(sub.user_telegram_id, existing);
    }

    // Live Remnawave snapshot for the read-only cross-check (scales past the
    // bulk ceiling via per-UUID fallback; fail-soft to backup if unreachable).
    const panelLookup = await buildPanelLookup(() => this.remnawaveApiService.getAllPanelUsers());

    // Index transactions by telegram_id
    const txsByTelegramId = new Map<number, AltshopTransaction[]>();
    for (const tx of transactions ?? []) {
      const existing = txsByTelegramId.get(tx.user_telegram_id) ?? [];
      existing.push(tx);
      txsByTelegramId.set(tx.user_telegram_id, existing);
    }

    const errors: string[] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let subscriptionsCreated = 0;
    let subscriptionsUpdated = 0;
    const createdUserIds: string[] = [];

    for (const altshopUser of users) {
      try {
        const userId = await this.matchOrCreateUser(altshopUser, mode);
        if (userId === null) {
          skipped += 1;
          continue;
        }

        const wasCreated = await this.wasJustCreated(userId);
        if (wasCreated) {
          created += 1;
          createdUserIds.push(userId);
        } else {
          updated += 1;
        }

        // Sync subscriptions for this user
        const userSubs = subsByTelegramId.get(altshopUser.telegram_id) ?? [];
        for (const sub of userSubs) {
          const subResult = await this.syncSubscription(userId, sub, panelLookup);
          if (subResult === 'created') subscriptionsCreated += 1;
          if (subResult === 'updated') subscriptionsUpdated += 1;
        }

        // Import transactions (historical, no dedup needed — just skip if exists)
        const userTxs = txsByTelegramId.get(altshopUser.telegram_id) ?? [];
        for (const tx of userTxs) {
          await this.importTransaction(userId, tx);
        }

        // Migrate the cabinet login as a claim-pending web account (import mode
        // only). The bcrypt hash is dropped — the user claims the account with
        // any password on first sign-in and is then forced to set a new one.
        if (mode === 'import') {
          const wa = webAccountByTelegramId.get(altshopUser.telegram_id);
          if (wa) {
            await this.upsertClaimPendingWebAccount(userId, wa);
          }
        }
      } catch (err) {
        const identifier = altshopUser.telegram_id || altshopUser.username || `id:${altshopUser.id}`;
        const message = `${identifier}: ${(err as Error).message}`;
        errors.push(message);
        this.logger.warn(`altshop importer row failed: ${message}`);
      }
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
      transactionsProcessed: (transactions ?? []).length,
      errors,
      rollback: { createdUserIds },
      // Catalog snapshot — drives the optional "Clone plans" post-import
      // step. Stored as-is; the cloner reads it back and adapts shapes
      // there. Total payload is small (a few KB even on real boxes).
      // Cast through JSON.parse(JSON.stringify(...)) to coerce
      // `Record<string, unknown>[]` rows into Prisma.InputJsonValue
      // without copy-pasting the typed altshop interfaces here.
      catalog: JSON.parse(JSON.stringify({
        plans: plans ?? [],
        planDurations: planDurations ?? [],
        planPrices: planPrices ?? [],
      })),
    };
    const errorMessage = errors.length === 0 ? null : errors.slice(0, 5).join('; ');

    // See remnawave-importer.service.ts for rationale.
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
            filename: `altshop-${mode}-${new Date().toISOString()}.json`,
            sourceType: 'altshop',
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
    altshopUser: AltshopUser,
    mode: 'import' | 'sync',
  ): Promise<string | null> {
    // Priority 1: telegram_id
    if (altshopUser.telegram_id > 0) {
      const user = await this.prismaService.user.findUnique({
        where: { telegramId: BigInt(altshopUser.telegram_id) },
        select: { id: true },
      });
      if (user) {
        await this.updateUserFields(user.id, altshopUser);
        return user.id;
      }
    }

    // No match — create (import mode only)
    if (mode === 'sync') {
      return null;
    }

    const newUser = await this.prismaService.user.create({
      data: {
        telegramId: altshopUser.telegram_id > 0 ? BigInt(altshopUser.telegram_id) : null,
        username: altshopUser.username || null,
        name: altshopUser.name || altshopUser.username || `altshop-${altshopUser.id}`,
        language: this.mapLocale(altshopUser.language),
        personalDiscount: altshopUser.personal_discount,
        purchaseDiscount: altshopUser.purchase_discount,
        points: altshopUser.points,
        isBlocked: altshopUser.is_blocked,
        isBotBlocked: altshopUser.is_bot_blocked,
        isRulesAccepted: altshopUser.is_rules_accepted,
      },
    });
    return newUser.id;
  }

  private async updateUserFields(userId: string, altshopUser: AltshopUser): Promise<void> {
    const data: Prisma.UserUpdateInput = {};
    if (altshopUser.username) data.username = altshopUser.username;
    if (altshopUser.name) data.name = altshopUser.name;
    if (altshopUser.personal_discount > 0) data.personalDiscount = altshopUser.personal_discount;
    if (altshopUser.purchase_discount > 0) data.purchaseDiscount = altshopUser.purchase_discount;
    if (altshopUser.points > 0) data.points = altshopUser.points;
    data.isBlocked = altshopUser.is_blocked;
    data.isBotBlocked = altshopUser.is_bot_blocked;
    if (Object.keys(data).length > 0) {
      await this.prismaService.user.update({ where: { id: userId }, data });
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
    sub: AltshopSubscription,
    panelLookup: PanelLookup,
  ): Promise<'created' | 'updated' | 'skipped'> {
    if (sub.user_remna_id) {
      const existing = await this.prismaService.subscription.findFirst({
        where: { remnawaveId: sub.user_remna_id },
        select: { id: true, userId: true },
      });

      // Remnawave is the truth: if the panel still has this profile, overlay
      // its FRESH state (active subscriptions become accurate). If it's gone,
      // keep the backup's own (stale) state as-is — the user re-buys via bot.
      const { panel, known } = await resolvePanelProfile(
        sub.user_remna_id,
        panelLookup,
        (uuid) => this.remnawaveApiService.getPanelUser(uuid),
      );
      const fresh = panel ? panelSubscriptionState(panel) : null;
      const status = fresh
        ? fresh.status
        : reconcileMissingPanelStatus(known, this.mapStatus(sub.status));
      const expiresAt = fresh ? fresh.expiresAt : sub.expire_at ? new Date(sub.expire_at) : null;
      const trafficLimit = fresh ? fresh.trafficLimit : sub.traffic_limit > 0 ? sub.traffic_limit : null;
      const deviceLimit = fresh ? fresh.deviceLimit : sub.device_limit;
      const internalSquads = fresh ? fresh.internalSquads : (sub.internal_squads ?? []);
      const externalSquad = fresh ? fresh.externalSquad : (sub.external_squad ?? null);
      const configUrl = fresh ? fresh.configUrl : (sub.url || null);

      const subscriptionData: Prisma.SubscriptionUpdateInput = {
        status,
        isTrial: sub.is_trial,
        trafficLimit,
        deviceLimit,
        configUrl,
        expiresAt,
        internalSquads,
        externalSquad,
        planSnapshot: {
          importedFrom: 'altshop',
          tag: sub.tag,
          trafficLimitStrategy: sub.traffic_limit_strategy,
          deviceType: sub.device_type,
          originalPlanSnapshot: sub.plan_snapshot as Prisma.InputJsonValue,
        },
      };

      if (existing) {
        await this.prismaService.subscription.update({
          where: { id: existing.id },
          data: subscriptionData,
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
          user: { connect: { id: userId } },
          remnawaveId: sub.user_remna_id,
          status,
          isTrial: sub.is_trial,
          trafficLimit,
          deviceLimit,
          configUrl,
          expiresAt,
          startedAt: sub.created_at ? new Date(sub.created_at) : new Date(),
          internalSquads,
          externalSquad,
          planSnapshot: {
            importedFrom: 'altshop',
            tag: sub.tag,
            trafficLimitStrategy: sub.traffic_limit_strategy,
            deviceType: sub.device_type,
            originalPlanSnapshot: sub.plan_snapshot as Prisma.InputJsonValue,
          },
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
      if (!user?.currentSubscriptionId) {
        await this.prismaService.user.update({
          where: { id: userId },
          data: { currentSubscriptionId: newSub.id },
        });
      }

      return 'created';
    }

    return 'skipped';
  }

  // ── Web account (claim-pending) ─────────────────────────────────────────────

  /**
   * Migrate an altshop cabinet login as a claim-pending `WebAccount`: login
   * (and email when present), NO password (the altshop bcrypt hash is unusable
   * by rezeis). On the user's first cabinet sign-in any submitted password is
   * adopted and a reset is forced. Skips when the user already has a web
   * account or the login is invalid / collides.
   */
  private async upsertClaimPendingWebAccount(userId: string, wa: AltshopWebAccount): Promise<void> {
    const existing = await this.prismaService.webAccount.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (existing) return; // don't clobber an existing web account

    const loginRaw = (wa.username ?? '').trim();
    if (!loginPolicy.isValidLogin(loginRaw)) return; // can't form a usable login
    const login = loginPolicy.sanitizeLogin(loginRaw);
    const loginNormalized = loginPolicy.normalizeLogin(loginRaw);
    const email = wa.email && wa.email.trim().length > 0 ? wa.email.trim() : null;
    const emailNormalized = email ? email.toLowerCase() : null;

    try {
      await this.prismaService.webAccount.create({
        data: {
          user: { connect: { id: userId } },
          login,
          loginNormalized,
          email,
          emailNormalized,
          passwordHash: null,
          passwordBootstrapPending: true,
          requiresPasswordChange: true,
        },
      });
    } catch (err) {
      // login/email unique collision across users — skip, not fatal.
      this.logger.debug(`altshop webAccount skipped for ${userId}: ${(err as Error).message}`);
    }
  }

  // ── Transaction import ────────────────────────────────────────────────────

  private async importTransaction(userId: string, tx: AltshopTransaction): Promise<void> {
    // Skip if transaction with this payment_id already exists
    const existing = await this.prismaService.transaction.findUnique({
      where: { paymentId: tx.payment_id },
      select: { id: true },
    });
    if (existing) return;

    const amount = this.extractAmount(tx.pricing);
    const gatewayType = this.mapGatewayType(tx.gateway_type);
    const currency = this.mapCurrency(tx.currency);

    // Skip if gateway or currency is not supported in our enum
    if (!gatewayType || !currency) return;

    await this.prismaService.transaction.create({
      data: {
        user: { connect: { id: userId } },
        paymentId: tx.payment_id,
        status: this.mapTransactionStatus(tx.status),
        purchaseType: this.mapPurchaseType(tx.purchase_type),
        gatewayType,
        amount,
        currency,
        channel: this.mapChannel(tx.channel),
        planSnapshot: {
          importedFrom: 'altshop',
          originalPricing: tx.pricing as Prisma.InputJsonValue,
          originalPlanSnapshot: tx.plan_snapshot as Prisma.InputJsonValue,
        },
        createdAt: tx.created_at ? new Date(tx.created_at) : new Date(),
      },
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private mapStatus(status: string): SubscriptionStatus {
    switch (status.toUpperCase()) {
      case 'ACTIVE': return SubscriptionStatus.ACTIVE;
      case 'DISABLED': return SubscriptionStatus.DISABLED;
      case 'LIMITED': return SubscriptionStatus.LIMITED;
      case 'EXPIRED': return SubscriptionStatus.EXPIRED;
      case 'DELETED': return SubscriptionStatus.DELETED;
      default: return SubscriptionStatus.ACTIVE;
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
      case 'COMPLETED': return TransactionStatus.COMPLETED;
      case 'PENDING': return TransactionStatus.PENDING;
      case 'CANCELED': return TransactionStatus.CANCELED;
      case 'REFUNDED': return TransactionStatus.CANCELED;
      case 'FAILED': return TransactionStatus.FAILED;
      default: return TransactionStatus.PENDING;
    }
  }

  private mapPurchaseType(type: string): PurchaseType {
    switch (type.toUpperCase()) {
      case 'NEW': return PurchaseType.NEW;
      case 'RENEW': return PurchaseType.RENEW;
      case 'CHANGE': return PurchaseType.UPGRADE;
      default: return PurchaseType.NEW;
    }
  }

  private mapGatewayType(gateway: string): PaymentGatewayType | null {
    const upper = gateway.toUpperCase();
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

  private mapChannel(channel: string | null): PurchaseChannel {
    if (!channel) return PurchaseChannel.TELEGRAM;
    return channel.toUpperCase() === 'WEB' ? PurchaseChannel.WEB : PurchaseChannel.TELEGRAM;
  }

  private extractAmount(pricing: Record<string, unknown> | null): number {
    if (!pricing) return 0;
    // altshop stores pricing as JSONB with various structures
    // Try common patterns
    if (typeof pricing.amount === 'number') return pricing.amount;
    if (typeof pricing.total === 'number') return pricing.total;
    if (typeof pricing.price === 'number') return pricing.price;
    return 0;
  }
}
