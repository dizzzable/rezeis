import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ImportStatus, Locale, Prisma, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { ImportSummary } from '../interfaces/import-summary.interface';

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

interface RunInput {
  readonly mode: 'import' | 'sync';
  readonly createdBy: string | null;
  readonly users: readonly RemnashopUser[];
  readonly subscriptions: readonly RemnashopSubscription[];
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

  public constructor(private readonly prismaService: PrismaService) {}

  public async run(input: RunInput): Promise<ImportSummary> {
    const { users, subscriptions, mode, createdBy } = input;

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

    const errors: string[] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let subscriptionsCreated = 0;
    let subscriptionsUpdated = 0;

    for (const remnashopUser of users) {
      try {
        const userId = await this.matchOrCreateUser(remnashopUser, mode);
        if (userId === null) {
          skipped += 1;
          continue;
        }

        const wasCreated = await this.wasJustCreated(userId);
        if (wasCreated) {
          created += 1;
        } else {
          updated += 1;
        }

        // Sync subscriptions for this user
        const userSubs = subsByTelegramId.get(remnashopUser.telegram_id) ?? [];
        for (const sub of userSubs) {
          const subResult = await this.syncSubscription(userId, sub);
          if (subResult === 'created') subscriptionsCreated += 1;
          if (subResult === 'updated') subscriptionsUpdated += 1;
        }
      } catch (err) {
        const identifier = remnashopUser.telegram_id || remnashopUser.username || `id:${remnashopUser.id}`;
        const message = `${identifier}: ${(err as Error).message}`;
        errors.push(message);
        this.logger.warn(`remnashop importer row failed: ${message}`);
      }
    }

    const importRecord = await this.prismaService.importRecord.create({
      data: {
        filename: `remnashop-${mode}-${new Date().toISOString()}.json`,
        sourceType: 'remnashop',
        status: errors.length === 0 ? ImportStatus.COMMITTED : ImportStatus.FAILED,
        recordsTotal: users.length,
        recordsOk: created + updated,
        recordsFailed: errors.length,
        result: {
          mode,
          fetched: users.length,
          created,
          updated,
          skipped,
          subscriptionsCreated,
          subscriptionsUpdated,
          errors,
        },
        errorMessage: errors.length === 0 ? null : errors.slice(0, 5).join('; '),
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
  ): Promise<string | null> {
    // Priority 1: telegram_id
    if (remnashopUser.telegram_id > 0) {
      const user = await this.prismaService.user.findUnique({
        where: { telegramId: BigInt(remnashopUser.telegram_id) },
        select: { id: true },
      });
      if (user) {
        await this.updateUserFields(user.id, remnashopUser);
        return user.id;
      }
    }

    // No match — create (import mode only)
    if (mode === 'sync') {
      return null;
    }

    const newUser = await this.prismaService.user.create({
      data: {
        telegramId: remnashopUser.telegram_id > 0 ? BigInt(remnashopUser.telegram_id) : null,
        username: remnashopUser.username || null,
        name: remnashopUser.name || remnashopUser.username || `remnashop-${remnashopUser.id}`,
        language: this.mapLocale(remnashopUser.language),
        personalDiscount: remnashopUser.personal_discount,
        purchaseDiscount: remnashopUser.purchase_discount,
        points: remnashopUser.points,
        isBlocked: remnashopUser.is_blocked,
        isBotBlocked: remnashopUser.is_bot_blocked,
        isRulesAccepted: remnashopUser.is_rules_accepted,
      },
    });
    return newUser.id;
  }

  private async updateUserFields(userId: string, remnashopUser: RemnashopUser): Promise<void> {
    const data: Prisma.UserUpdateInput = {};
    if (remnashopUser.username) data.username = remnashopUser.username;
    if (remnashopUser.name) data.name = remnashopUser.name;
    if (remnashopUser.personal_discount > 0) data.personalDiscount = remnashopUser.personal_discount;
    if (remnashopUser.purchase_discount > 0) data.purchaseDiscount = remnashopUser.purchase_discount;
    if (remnashopUser.points > 0) data.points = remnashopUser.points;
    data.isBlocked = remnashopUser.is_blocked;
    data.isBotBlocked = remnashopUser.is_bot_blocked;
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
    sub: RemnashopSubscription,
  ): Promise<'created' | 'updated' | 'skipped'> {
    // If subscription has a Remnawave UUID, use it as the unique key
    if (sub.user_remna_id) {
      const existing = await this.prismaService.subscription.findFirst({
        where: { remnawaveId: sub.user_remna_id },
        select: { id: true, userId: true },
      });

      const status = this.mapStatus(sub.status);
      const expiresAt = sub.expire_at ? new Date(sub.expire_at) : null;

      const subscriptionData: Prisma.SubscriptionUpdateInput = {
        status,
        isTrial: sub.is_trial,
        trafficLimit: sub.traffic_limit > 0 ? sub.traffic_limit : null,
        deviceLimit: sub.device_limit,
        configUrl: sub.url || null,
        expiresAt,
        internalSquads: sub.internal_squads ?? [],
        externalSquad: sub.external_squad ?? null,
        planSnapshot: {
          importedFrom: 'remnashop',
          tag: sub.tag,
          trafficLimitStrategy: sub.traffic_limit_strategy,
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
          trafficLimit: sub.traffic_limit > 0 ? sub.traffic_limit : null,
          deviceLimit: sub.device_limit,
          configUrl: sub.url || null,
          expiresAt,
          startedAt: sub.created_at ? new Date(sub.created_at) : new Date(),
          internalSquads: sub.internal_squads ?? [],
          externalSquad: sub.external_squad ?? null,
          planSnapshot: {
            importedFrom: 'remnashop',
            tag: sub.tag,
            trafficLimitStrategy: sub.traffic_limit_strategy,
            originalPlanSnapshot: sub.plan_snapshot as Prisma.InputJsonValue,
          },
        },
      });

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
}
