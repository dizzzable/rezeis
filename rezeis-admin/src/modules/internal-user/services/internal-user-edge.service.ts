import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Locale, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { InternalBootstrapUserInput } from '../interfaces/internal-user-bootstrap.interface';
import {
  InternalUserNotificationInterface,
  InternalUserTransactionInterface,
} from '../interfaces/internal-user-notification.interface';
import { InternalUserSessionInterface } from '../interfaces/internal-user-session.interface';
import { buildUserReferenceWhere } from '../utils/user-reference.util';
import { mapInternalUserSession, INTERNAL_USER_INCLUDE } from './internal-user.mappers';
import { readTrialSettings } from '../../plans/utils/trial-settings.util';

/**
 * InternalUserEdgeService
 * ────────────────────────
 * User-edge specific operations consumed by reiwa over the
 * `/api/internal/user/...` surface that go beyond the read-only session
 * lookup served by `InternalUserService`.
 *
 *  - Bot-side bootstrap (idempotent create-or-refresh by `telegramId`).
 *  - Locale change (PATCH `/language`).
 *  - User notifications feed (list / unread-count / read-all / read-one).
 *  - Transaction history feed (list).
 *  - HWID device list/revoke proxied through the user resolver so reiwa
 *    can keep operating with `telegramId` end-to-end (the underlying
 *    `RemnawaveApiService` is reached via the existing devices controller).
 *
 * Kept as its own injectable so `InternalUserService` stays focused on
 * session / web-account flows.
 */
@Injectable()
export class InternalUserEdgeService {
  private readonly logger = new Logger(InternalUserEdgeService.name);

  public constructor(private readonly prismaService: PrismaService) {}

  // ── Bootstrap / language ─────────────────────────────────────────────────

  /**
   * Idempotent create-or-refresh of a Telegram user.
   *
   * Identity model
   *   The canonical `reiwa_id` lives on `User.id` (CUID) and is generated
   *   automatically on first contact. `telegramId` is just one of the
   *   identity fields the user may carry — a user can exist without it
   *   (web-only sign-up) and a user can later link Telegram via the
   *   `link/telegram/generate` flow.
   *
   *   This method specifically handles the *Telegram-first* path:
   *     - Look up by `telegramId` (`@unique` on the `User` table).
   *     - If found, refresh `username` / `name` / `language` from the
   *       latest payload so the user's profile mirrors the live Telegram
   *       value without operator intervention.
   *     - If not found, create a brand-new `User` row. Prisma fills in
   *       `id` from `@default(cuid())`, so the caller does not need to
   *       supply it. That CUID becomes the user's permanent reiwa_id.
   *
   * Returns the canonical session payload so the caller can drive its
   * first UI pass (welcome message, subscription card) without a
   * follow-up `GET /session` call.
   */
  public async bootstrapByTelegram(
    input: InternalBootstrapUserInput,
  ): Promise<InternalUserSessionInterface> {
    const telegramIdBig = this.parseTelegramId(input.telegramId);
    const language = this.parseLocale(input.language);
    const data: Prisma.UserCreateInput = {
      telegramId: telegramIdBig,
      name: input.name,
      username: input.username ?? null,
      ...(language !== null ? { language } : {}),
    };
    const user = await this.prismaService.user.upsert({
      where: { telegramId: telegramIdBig },
      create: data,
      update: {
        name: input.name,
        username: input.username ?? null,
        ...(language !== null ? { language } : {}),
      },
      include: INTERNAL_USER_INCLUDE,
    });
    return mapInternalUserSession(user);
  }

  public async updateLanguage(
    telegramId: string,
    language: string,
  ): Promise<InternalUserSessionInterface> {
    const telegramIdBig = this.parseTelegramId(telegramId);
    const locale = this.parseLocale(language);
    if (locale === null) {
      throw new BadRequestException(`Unsupported language: "${language}"`);
    }
    const user = await this.prismaService.user.update({
      where: { telegramId: telegramIdBig },
      data: { language: locale },
      include: INTERNAL_USER_INCLUDE,
    });
    return mapInternalUserSession(user);
  }

  // ── Notifications ────────────────────────────────────────────────────────

  public async listNotifications(
    telegramId: string,
  ): Promise<{ notifications: readonly InternalUserNotificationInterface[] }> {
    const userId = await this.resolveUserId(telegramId);
    const events = await this.prismaService.userNotificationEvent.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return {
      notifications: events.map((event): InternalUserNotificationInterface => ({
        id: event.id,
        type: event.type,
        payload:
          event.payload !== null && typeof event.payload === 'object' && !Array.isArray(event.payload)
            ? (event.payload as Record<string, unknown>)
            : {},
        readAt: event.readAt?.toISOString() ?? null,
        createdAt: event.createdAt.toISOString(),
      })),
    };
  }

  public async getUnreadCount(telegramId: string): Promise<{ unread: number }> {
    const userId = await this.resolveUserId(telegramId);
    const unread = await this.prismaService.userNotificationEvent.count({
      where: { userId, readAt: null },
    });
    return { unread };
  }

  public async markAllRead(telegramId: string): Promise<{ updated: number }> {
    const userId = await this.resolveUserId(telegramId);
    const result = await this.prismaService.userNotificationEvent.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }

  public async markOneRead(
    telegramId: string,
    notificationId: string,
  ): Promise<{ ok: true }> {
    const userId = await this.resolveUserId(telegramId);
    const event = await this.prismaService.userNotificationEvent.findUnique({
      where: { id: notificationId },
      select: { id: true, userId: true },
    });
    if (event === null || event.userId !== userId) {
      throw new NotFoundException('Notification not found');
    }
    await this.prismaService.userNotificationEvent.update({
      where: { id: notificationId },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }

  // ── Transactions ─────────────────────────────────────────────────────────

  public async listTransactions(
    telegramId: string,
  ): Promise<{ transactions: readonly InternalUserTransactionInterface[] }> {
    const userId = await this.resolveUserId(telegramId);
    const transactions = await this.prismaService.transaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return {
      transactions: transactions.map((transaction): InternalUserTransactionInterface => ({
        id: transaction.id,
        paymentId: transaction.paymentId,
        status: transaction.status,
        purchaseType: transaction.purchaseType,
        channel: transaction.channel,
        gatewayType: transaction.gatewayType,
        currency: transaction.currency,
        amount: transaction.amount.toString(),
        createdAt: transaction.createdAt.toISOString(),
        updatedAt: transaction.updatedAt.toISOString(),
      })),
    };
  }

  // ── Trial ────────────────────────────────────────────────────────────────

  public async getTrialEligibility(
    telegramId: string,
  ): Promise<{ eligible: boolean; reason: string | null }> {
    const userId = await this.resolveUserId(telegramId);
    const eligibility = await this.computeTrialEligibility(userId);
    return { eligible: eligibility.eligible, reason: eligibility.reason };
  }

  /**
   * Activates a trial subscription on behalf of the resolved Telegram
   * user. The call is delegated to the existing
   * `SubscriptionMutationsService.grantTrial`, which:
   *   - guards via `TrialGrant` (one trial per user, lifetime),
   *   - creates the local `Subscription` row with `isTrial=true`,
   *   - enqueues a Remnawave profile-sync job so the connect URL is
   *     filled in once the upstream profile is created.
   *
   * Returns `{ subscriptionId, status }`. We surface a structured error
   * (rather than throwing) when the user is ineligible so the bot can
   * render a friendly message without crashing the conversation.
   */
  public async activateTrial(
    telegramId: string,
    grantTrial: (input: { userId: string; planId: string; durationDays: number }) => Promise<{ subscriptionId: string }>,
  ): Promise<{ activated: boolean; subscriptionId?: string; reason?: string }> {
    const userId = await this.resolveUserId(telegramId);
    const eligibility = await this.computeTrialEligibility(userId);
    if (!eligibility.eligible) {
      return { activated: false, reason: eligibility.reason ?? 'INELIGIBLE' };
    }
    const trialPlan = await this.prismaService.plan.findFirst({
      where: { availability: 'TRIAL', isActive: true, isArchived: false },
      include: { durations: { take: 1, orderBy: { days: 'asc' } } },
    });
    if (trialPlan === null || trialPlan.durations.length === 0) {
      return { activated: false, reason: 'TRIAL_NOT_CONFIGURED' };
    }
    const result = await grantTrial({
      userId,
      planId: trialPlan.id,
      durationDays: trialPlan.durations[0].days,
    });
    return { activated: true, subscriptionId: result.subscriptionId };
  }

  // ── Devices (telegram-id wrappers around the existing devices service) ──

  public async resolveUserIdForDevices(telegramId: string): Promise<string> {
    return this.resolveUserId(telegramId);
  }

  // ── Internal trial helpers ───────────────────────────────────────────

  /**
   * Trial eligibility, honouring the trial plan's `trialSettings`:
   *   • `maxClaims`         — a user may claim the trial up to N times
   *                           (counted by their `isTrial` subscriptions,
   *                           including deleted ones — a consumed trial
   *                           always counts).
   *   • `availabilityScope` — `INVITED` restricts the trial to users who
   *                           registered via a referral/partner link.
   * The "no active subscription" guard remains so a user can't stack a
   * trial on top of a running plan.
   */
  private async computeTrialEligibility(
    userId: string,
  ): Promise<{ eligible: boolean; reason: string | null }> {
    const trialPlan = await this.prismaService.plan.findFirst({
      where: { availability: 'TRIAL', isActive: true, isArchived: false },
      select: { id: true, trialSettings: true },
    });
    if (trialPlan === null) {
      return { eligible: false, reason: 'TRIAL_NOT_CONFIGURED' };
    }
    const settings = readTrialSettings(trialPlan.trialSettings);

    const [trialClaims, activeSubscriptions] = await Promise.all([
      this.prismaService.subscription.count({
        where: { userId, isTrial: true },
      }),
      this.prismaService.subscription.count({
        where: { userId, status: { in: ['ACTIVE', 'LIMITED'] } },
      }),
    ]);

    if (trialClaims >= settings.maxClaims) {
      return { eligible: false, reason: 'TRIAL_ALREADY_USED' };
    }
    if (activeSubscriptions > 0) {
      return { eligible: false, reason: 'ALREADY_HAS_SUBSCRIPTION' };
    }
    if (settings.availabilityScope === 'INVITED') {
      const invitedEdge = await this.prismaService.referral.findUnique({
        where: { referredId: userId },
        select: { id: true },
      });
      if (invitedEdge === null) {
        return { eligible: false, reason: 'TRIAL_INVITED_ONLY' };
      }
    }
    return { eligible: true, reason: null };
  }

  // ── Bot block flag ──────────────────────────────────────────────────────

  /**
   * Idempotently marks the user as having blocked the bot. Used by
   * reiwa when Telegram returns 403 on a `/notify` delivery — saves
   * future attempts and feeds the broadcast `where` filter that
   * already excludes blocked users.
   */
  public async markBotBlocked(telegramId: string): Promise<void> {
    const telegramIdBig = this.parseTelegramId(telegramId);
    await this.prismaService.user.updateMany({
      where: { telegramId: telegramIdBig, isBotBlocked: false },
      data: { isBotBlocked: true },
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async resolveUserId(telegramId: string): Promise<string> {
    const user = await this.prismaService.user.findUnique({
      where: buildUserReferenceWhere(telegramId),
      select: { id: true },
    });
    if (user === null) {
      throw new NotFoundException(`User not found for reference=${telegramId}`);
    }
    return user.id;
  }

  private parseTelegramId(telegramId: string): bigint {
    if (!/^\d{1,19}$/.test(telegramId)) {
      throw new BadRequestException('telegramId must be a positive numeric string up to 19 digits');
    }
    try {
      return BigInt(telegramId);
    } catch {
      throw new BadRequestException(`telegramId is not a valid bigint: ${telegramId}`);
    }
  }

  private parseLocale(value: string | null | undefined): Locale | null {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return null;
    }
    const upper = value.trim().toUpperCase();
    const candidates: readonly Locale[] = Object.values(Locale);
    const match = candidates.find((c) => c === upper);
    if (match !== undefined) {
      return match;
    }
    if (this.logger.warn) {
      this.logger.warn(`Ignoring unknown locale "${value}" — keeping the existing one`);
    }
    return null;
  }
}
