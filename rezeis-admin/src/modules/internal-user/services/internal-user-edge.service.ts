import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Locale, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  EVENT_TYPES,
  SystemEventsService,
} from '../../../common/services/system-events.service';
import { AccessModeGuard } from '../../settings/services/access-mode-guard.service';
import { SettingsService } from '../../settings/services/settings.service';
import { ReferralManualAttachService } from '../../referrals/services/referral-manual-attach.service';
import { InternalBootstrapUserInput } from '../interfaces/internal-user-bootstrap.interface';
import {
  InternalUserAddOnEntitlementInterface,
  InternalUserNotificationInterface,
  InternalUserTransactionInterface,
} from '../interfaces/internal-user-notification.interface';
import { InternalUserSessionInterface } from '../interfaces/internal-user-session.interface';
import { buildUserReferenceWhere } from '../utils/user-reference.util';
import { mapInternalUserSession, INTERNAL_USER_INCLUDE } from './internal-user.mappers';
import { evaluateTrialClaim, readTrialSettings, TRIAL_CLAIM_LIMIT_MESSAGE } from '../../plans/utils/trial-settings.util';
import { isInvitedUser } from '../../plans/utils/trial-invite.util';

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

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly settingsService: SettingsService,
    private readonly accessModeGuard: AccessModeGuard,
    private readonly systemEventsService: SystemEventsService,
    private readonly referralManualAttachService: ReferralManualAttachService,
  ) {}

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

    // Two-layer enforcement (Property 2): the bot already short-circuits
    // a brand-new user under REG_BLOCKED / RESTRICTED, but a direct
    // internal call would otherwise create a User row and bypass the
    // platform mode. We re-check here against the Settings row.
    //
    // Rule: the gate applies only to BRAND-NEW users. An existing user
    // continuing to interact with the bot (refreshing name / username)
    // proceeds even in REG_BLOCKED so they don't get locked out of their
    // own account.
    const existing = await this.prismaService.user.findUnique({
      where: { telegramId: telegramIdBig },
      select: { id: true },
    });
    if (existing === null) {
      const policy = await this.settingsService.getInternalPlatformPolicy();
      // A `ref_<code>` deep-link IS the Telegram-side invite: treat it exactly
      // like the web register flow does (`WebAuthService.register`), otherwise
      // INVITED mode rejects a legitimately-invited bot sign-up with
      // INVITE_REQUIRED before the user row is even created — and the bot
      // swallows the bootstrap error, so the user just sees a plain menu.
      const hasInviteCode =
        typeof input.referralCode === 'string' && input.referralCode.trim().length > 0;
      const rejection = this.accessModeGuard.evaluate({
        gate: 'register',
        mode: policy.accessMode,
        hasInvite: hasInviteCode,
      });
      if (rejection !== null) {
        throw rejection.status === 503
          ? new ServiceUnavailableException({ code: rejection.code, message: rejection.message })
          : new ForbiddenException({ code: rejection.code, message: rejection.message });
      }
      // Under INVITED, admission requires a real single-use `ReferralInvite`.
      // A permanent sharing code (reiwa_id / username / telegramId) resolves to
      // a referrer for ATTRIBUTION purposes, but accepting it here would make
      // the mode decorative: every existing user would hold an unlimited,
      // never-expiring pass, and the invite TTL / slot caps would constrain
      // nothing. Attribution and admission are deliberately different keys.
      if (policy.accessMode === 'INVITED' && hasInviteCode) {
        const referrer = await this.resolveReferrer(input.referralCode!.trim());
        if (referrer === null || referrer.inviteId === undefined) {
          throw new ForbiddenException({
            code: 'INVITE_REQUIRED',
            message: 'Referral code is invalid or has expired',
          });
        }
      }
    }

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

    // Emit a registration event ONLY for a brand-new user (first /start).
    // `existing === null` was resolved before the upsert, so this fires once
    // per Telegram-first sign-up. Previously `USER_REGISTERED` was defined but
    // never emitted — the bot created the row silently and operators/devs got
    // no "new user registered" notification.
    if (existing === null) {
      this.systemEventsService.info(
        EVENT_TYPES.USER_REGISTERED,
        'USER',
        `New user registered via Telegram bot: ${input.name || input.username || input.telegramId}`,
        {
          reiwaId: user.id,
          telegramId: telegramIdBig.toString(),
          username: input.username ?? null,
          name: input.name || null,
          source: 'telegram_bot',
        },
      );

      // Bind the inviting user from a `ref_<token>` bot deep-link — ONLY on a
      // brand-new bootstrap, mirroring the web register flow. Previously the
      // bot's referral links (`t.me/<bot>?start=ref_<token>`) silently did
      // nothing: `ref_` was never parsed and `referralCode` never reached
      // here, so the referrer never got the reward. Best-effort: a bad /
      // duplicate / self referral must never fail the /start bootstrap.
      if (typeof input.referralCode === 'string' && input.referralCode.trim().length > 0) {
        await this.consumeReferralCode(user.id, input.referralCode);
      }
    }

    return mapInternalUserSession(user);
  }

  /**
   * Resolves a referral code to a referrer and attaches the new user as their
   * referral. Silently no-ops on self-referral, unknown codes, or an
   * already-attributed user — bootstrap must never fail because of a bad or
   * duplicate referral deep-link. Mirrors `WebAuthService.consumeReferralCode`.
   */
  private async consumeReferralCode(newUserId: string, rawCode: string): Promise<void> {
    try {
      const code = rawCode.trim();
      if (code.length === 0) {
        return;
      }
      const referrer = await this.resolveReferrer(code);
      if (referrer === null || referrer.id === newUserId) {
        return;
      }
      // A `ReferralInvite` is single-use. Claim it FIRST with a conditional
      // update guarded on `consumedAt: null` — two concurrent sign-ups both
      // read the invite as unconsumed, so stamping after the attach would let
      // both attribute it (duplicate referral + duplicate reward for the
      // inviter; the attach service's guard keys on the *referred* user, which
      // differs). `count === 0` means another sign-up won the race.
      const inviteId = referrer.inviteId;
      const claimedAt = new Date();
      if (inviteId !== undefined) {
        const claimed = await this.prismaService.referralInvite.updateMany({
          where: { id: inviteId, consumedAt: null },
          data: { consumedAt: claimedAt },
        });
        if (claimed.count === 0) {
          return;
        }
      }
      try {
        await this.referralManualAttachService.attachReferrerManually({
          userId: newUserId,
          referrerId: referrer.id,
        });
      } catch (attachError: unknown) {
        if (inviteId !== undefined) {
          await this.releaseInviteClaimBestEffort(inviteId, claimedAt, newUserId);
        }
        throw attachError;
      }
    } catch (error: unknown) {
      // Duplicate attribution / self-referral throw BadRequest — expected,
      // must not break the bootstrap response.
      this.logger.warn(
        `Bot referral consume skipped for user ${newUserId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Releases a single-use invite claim after a failed attach, so a genuine
   * invite isn't burned by a sign-up that never got attributed.
   *
   * Two guards make this safe:
   *  - the release is fenced on OUR claim timestamp, so it can never reopen an
   *    invite that a concurrent sign-up has since claimed;
   *  - `attachReferrerManually` is not atomic (it creates the `Referral` edge
   *    first, then replays partner/referral side-effects, any of which can
   *    throw). If the edge already exists the invite really was spent — keep it
   *    consumed, or a second user could redeem it and the inviter would be paid
   *    twice for one invite.
   */
  private async releaseInviteClaimBestEffort(
    inviteId: string,
    claimedAt: Date,
    newUserId: string,
  ): Promise<void> {
    try {
      const attributed = await this.prismaService.referral.findUnique({
        where: { referredId: newUserId },
        select: { id: true },
      });
      if (attributed !== null) {
        return;
      }
      await this.prismaService.referralInvite.updateMany({
        where: { id: inviteId, consumedAt: claimedAt },
        data: { consumedAt: null },
      });
    } catch (error: unknown) {
      this.logger.warn(
        `Failed to release referral invite claim ${inviteId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Resolves a referral code into a referrer `User`. Accepts the canonical
   * reiwa_id (CUID), a numeric telegramId, a username, or the user's
   * `referralCode` (all shared by the cabinet's own `ref_<code>` links), and —
   * when none of those match — a bot-issued `ReferralInvite.token`. For an
   * invite token the `inviteId` is returned too so the caller can stamp
   * `consumedAt`. Returns `null` when nothing matches. Mirrors
   * `WebAuthService.resolveReferrer` so the bot and web paths behave alike.
   */
  private async resolveReferrer(
    code: string,
  ): Promise<{ id: string; inviteId?: string } | null> {
    // Invite tokens are matched FIRST. They live in the narrower namespace
    // (server-generated base64url), whereas `User.username` is user-controlled
    // and re-synced from Telegram on every /start — checking users first would
    // let someone set their @username to a live invite token and hijack every
    // sign-up made through that link (the invite would also never be spent).
    const invite = await this.prismaService.referralInvite.findFirst({
      where: {
        token: code,
        revokedAt: null,
        consumedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { id: true, inviterId: true },
    });
    if (invite !== null) {
      // Confirm the inviter still exists and is not banned — same check the web
      // path performs, so the two surfaces cannot disagree about who may invite.
      const inviter = await this.prismaService.user.findFirst({
        where: { id: invite.inviterId, isBlocked: false },
        select: { id: true },
      });
      return inviter === null ? null : { id: inviter.id, inviteId: invite.id };
    }
    const orConditions: Prisma.UserWhereInput[] = [
      { id: code },
      { username: code },
      { referralCode: code },
    ];
    if (/^\d{1,19}$/.test(code)) {
      orConditions.push({ telegramId: BigInt(code) });
    }
    const user = await this.prismaService.user.findFirst({
      // A blocked user must stop earning referrals: they keep their link, but it
      // no longer attributes anyone.
      where: { isBlocked: false, OR: orConditions },
      select: { id: true },
    });
    return user === null ? null : { id: user.id };
  }

  public async updateLanguage(
    reference: string,
    language: string,
  ): Promise<InternalUserSessionInterface> {
    const locale = this.parseLocale(language);
    if (locale === null) {
      throw new BadRequestException(`Unsupported language: "${language}"`);
    }
    try {
      const user = await this.prismaService.user.update({
        where: buildUserReferenceWhere(reference),
        data: { language: locale },
        include: INTERNAL_USER_INCLUDE,
      });
      return mapInternalUserSession(user);
    } catch (err: unknown) {
      // The reiwa locale-detect middleware fires this for every new user on
      // their first message — before `/start` bootstrap creates the row, and
      // for users gated out by REG_BLOCKED / RESTRICTED who never get a row.
      // Treat "no such user" as a clean 404 (the bot already swallows it and
      // re-syncs the locale on the next bootstrap) instead of a noisy 500.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new NotFoundException('User not found');
      }
      throw err;
    }
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
        title: readTransactionTitle(transaction.planSnapshot),
        createdAt: transaction.createdAt.toISOString(),
        updatedAt: transaction.updatedAt.toISOString(),
      })),
    };
  }

  /**
   * User-facing "My add-ons" history: every durable add-on entitlement across
   * the user's own subscriptions (own data only, resolved from the identity).
   * Read-only + user-safe projection; naturally empty until the entitlement
   * ledger is populated (direct-purchase / renewal add-on rollout).
   */
  public async listAddOnEntitlements(
    telegramId: string,
  ): Promise<{ entitlements: readonly InternalUserAddOnEntitlementInterface[] }> {
    const userId = await this.resolveUserId(telegramId);
    const subscriptions = await this.prismaService.subscription.findMany({
      where: { userId },
      select: { id: true },
    });
    if (subscriptions.length === 0) {
      return { entitlements: [] };
    }
    const subscriptionIds = subscriptions.map((subscription) => subscription.id);
    const liveStates = ['ACTIVE', 'EXPIRING'] as const;
    const liveRows = await this.prismaService.addOnEntitlement.findMany({
      where: {
        subscriptionId: { in: subscriptionIds },
        state: { in: [...liveStates] },
      },
      orderBy: { purchasedAt: 'desc' },
    });
    const terminalTake = Math.max(0, 100 - liveRows.length);
    const terminalRows = terminalTake === 0
      ? []
      : await this.prismaService.addOnEntitlement.findMany({
          where: {
            subscriptionId: { in: subscriptionIds },
            state: { notIn: [...liveStates] },
          },
          orderBy: { purchasedAt: 'desc' },
          take: terminalTake,
        });
    const rows = [...liveRows, ...terminalRows].sort(
      (left, right) => right.purchasedAt.getTime() - left.purchasedAt.getTime(),
    );
    return {
      entitlements: rows.map((entitlement): InternalUserAddOnEntitlementInterface => ({
        id: entitlement.id,
        subscriptionId: entitlement.subscriptionId,
        addOnId: entitlement.addOnId,
        receiptName: entitlement.receiptName,
        type: entitlement.type,
        valuePerUnit: entitlement.valuePerUnit,
        quantity: entitlement.quantity,
        lifetime: entitlement.lifetime,
        state: entitlement.state,
        currency: entitlement.currency,
        totalAmount: entitlement.totalAmount.toString(),
        purchasedAt: entitlement.purchasedAt.toISOString(),
        activatedAt: entitlement.activatedAt === null ? null : entitlement.activatedAt.toISOString(),
        expiresAt: entitlement.expiresAt === null ? null : entitlement.expiresAt.toISOString(),
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
      // Logged: a refusal used to be invisible on both sides — the client showed
      // one generic sentence for every cause, and nothing reached the log, so
      // "the offer is shown but activating fails" could not be diagnosed at all.
      this.logger.log(
        `trial activation refused for user ${userId}: ${eligibility.reason ?? 'INELIGIBLE'}`,
      );
      return { activated: false, reason: eligibility.reason ?? 'INELIGIBLE' };
    }
    const trialPlan = await this.prismaService.plan.findFirst({
      where: { availability: 'TRIAL', isActive: true, isArchived: false },
      // Must match the ordering eligibility uses, or the two can answer about
      // different plans when several TRIAL plans are active.
      orderBy: [{ orderIndex: 'asc' }, { id: 'asc' }],
      include: { durations: { take: 1, orderBy: { days: 'asc' } } },
    });
    if (trialPlan === null || (trialPlan.durations[0]?.days ?? 0) <= 0) {
      this.logger.warn(`trial activation refused for user ${userId}: TRIAL_NOT_CONFIGURED`);
      return { activated: false, reason: 'TRIAL_NOT_CONFIGURED' };
    }
    try {
      const result = await grantTrial({
        userId,
        planId: trialPlan.id,
        durationDays: trialPlan.durations[0].days,
      });
      return { activated: true, subscriptionId: result.subscriptionId };
    } catch (error: unknown) {
      // `grantTrial` enforces the claim limit by throwing. Propagating that as a
      // bare 400 gave the cabinet nothing to act on, so it kept offering a retry
      // that could never succeed. Return it as a reason instead.
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes(TRIAL_CLAIM_LIMIT_MESSAGE)) {
        this.logger.log(`trial activation refused for user ${userId}: TRIAL_ALREADY_USED (grant guard)`);
        return { activated: false, reason: 'TRIAL_ALREADY_USED' };
      }
      throw error;
    }
  }

  // ── Devices (telegram-id wrappers around the existing devices service) ──

  public async resolveUserIdForDevices(telegramId: string): Promise<string> {
    return this.resolveUserId(telegramId);
  }

  // ── Internal trial helpers ───────────────────────────────────────────

  /**
   * Trial eligibility for the FREE grant path, honouring the trial plan's
   * `trialSettings`:
   *   • `maxClaims`         — a user may claim the trial up to N times
   *                           (counted by their `isTrial` subscriptions,
   *                           including deleted ones — a consumed trial
   *                           always counts).
   *   • `availabilityScope` — `INVITED` restricts the trial to users who
   *                           registered via a referral or partner link.
   * The "no active subscription" guard is free-grant specific (a paid
   * trial flows through the normal purchase pipeline and respects the
   * multi-subscription capacity instead).
   *
   * Note: a trial plan with `free: false` is NOT claimable for free — it
   * must be purchased through the payment pipeline like any NEW plan.
   */
  private async computeTrialEligibility(
    userId: string,
  ): Promise<{ eligible: boolean; reason: string | null }> {
    // The duration matters here, not only at activation: the grant needs a
    // duration row (`durations[0].days`), so a trial plan without one is not
    // configured. Checking it only on activation meant eligibility could answer
    // "yes", the cabinet showed the offer, and the button then failed every
    // single time with no way for the user to make progress.
    // Deliberately the same `orderBy` and the same duration row that activation
    // reads. Both lookups used to be unordered `findFirst`s with different
    // shapes, so with more than one active TRIAL plan (a remnashop import can
    // create them; the admin API's uniqueness check is a raced `findFirst`) they
    // could resolve to different rows — eligibility saying yes about one plan
    // while activation refused about another, which is the same "offer shown,
    // button always fails" divergence this method exists to prevent.
    //
    // `days` is checked, not just the row's existence: the grant copies it
    // straight into the expiry, and imported durations are not validated, so a
    // `days: 0` row would burn the user's one lifetime claim on a subscription
    // that expires the instant it is created.
    const trialPlan = await this.prismaService.plan.findFirst({
      where: { availability: 'TRIAL', isActive: true, isArchived: false },
      orderBy: [{ orderIndex: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        trialSettings: true,
        durations: { take: 1, orderBy: { days: 'asc' }, select: { days: true } },
      },
    });
    if (trialPlan === null || (trialPlan.durations[0]?.days ?? 0) <= 0) {
      return { eligible: false, reason: 'TRIAL_NOT_CONFIGURED' };
    }
    const settings = readTrialSettings(trialPlan.trialSettings);
    if (!settings.free) {
      // Paid trial — not grantable for free; the user must purchase it.
      return { eligible: false, reason: 'TRIAL_REQUIRES_PAYMENT' };
    }

    const [trialClaims, activeSubscriptions, invited, userRow] = await Promise.all([
      this.prismaService.subscription.count({
        where: { userId, isTrial: true },
      }),
      this.prismaService.subscription.count({
        where: { userId, status: { in: ['ACTIVE', 'LIMITED'] } },
      }),
      settings.availabilityScope === 'INVITED'
        ? isInvitedUser(this.prismaService, userId)
        : Promise.resolve(true),
      this.prismaService.user.findUnique({
        where: { id: userId },
        select: { telegramId: true },
      }),
    ]);

    if (activeSubscriptions > 0) {
      return { eligible: false, reason: 'ALREADY_HAS_SUBSCRIPTION' };
    }
    const claim = evaluateTrialClaim(settings, {
      priorTrialClaims: trialClaims,
      isInvited: invited,
      hasTelegram: userRow?.telegramId !== null && userRow?.telegramId !== undefined,
    });
    if (!claim.allowed) {
      return { eligible: false, reason: claim.reason };
    }
    return { eligible: true, reason: null };
  }

  // ── Bot block flag ──────────────────────────────────────────────────────

  /**
   * Lightweight existence probe used before `bootstrapByTelegram` to
   * tell reiwa-bot whether a Telegram user is brand-new (no `User` row
   * yet) or returning. Used by the platform `INVITED` / `REG_BLOCKED`
   * gate so the bot can show a mode banner instead of creating a User.
   */
  public async userExists(reference: string): Promise<{ exists: boolean }> {
    const user = await this.prismaService.user.findUnique({
      where: buildUserReferenceWhere(reference),
      select: { id: true },
    });
    return { exists: user !== null };
  }

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

  // ── Usage-surface tracking ────────────────────────────────────────────────

  /**
   * Record the surface the user is currently using (called once per cabinet
   * session): `surface` (tma/pwa/browser), `formFactor` (mobile/tablet/desktop)
   * and `os`. Refreshes the latest-seen snapshot + `lastSeenAt`, and stamps
   * `pwaInstalledAt` once the first time the surface is an installed PWA.
   * Idempotent and cheap. Unknown values are clamped server-side.
   */
  public async recordSurfaceSeen(
    reference: string,
    input: { surface: string; formFactor: string; os: string },
  ): Promise<void> {
    const surface = normalizeSurface(input.surface);
    const formFactor = normalizeFormFactor(input.formFactor);
    const os = normalizeOs(input.os);
    const now = new Date();
    try {
      // Refresh the latest-seen surface snapshot on every report.
      await this.prismaService.user.update({
        where: buildUserReferenceWhere(reference),
        data: { lastSurface: surface, lastFormFactor: formFactor, lastOs: os, lastSeenAt: now },
      });
      // Stamp the first-install instant only when the surface is an installed
      // PWA and it isn't set yet — keeps the milestone stable without a
      // read-modify-write race.
      if (surface === 'pwa') {
        await this.prismaService.user.updateMany({
          where: { ...buildUserReferenceWhere(reference), pwaInstalledAt: null },
          data: { pwaInstalledAt: now },
        });
      }
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new NotFoundException('User not found');
      }
      throw err;
    }
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

/** Clamp a client-reported usage surface to a known value. */
function normalizeSurface(surface: string): string {
  const value = (surface ?? '').trim().toLowerCase();
  return value === 'tma' || value === 'pwa' || value === 'browser' ? value : 'browser';
}

/** Clamp a client-reported form factor to a known value. */
function normalizeFormFactor(formFactor: string): string {
  const value = (formFactor ?? '').trim().toLowerCase();
  return value === 'mobile' || value === 'tablet' || value === 'desktop' ? value : 'desktop';
}

/** Clamp a client-reported OS to a known value. */
function normalizeOs(os: string): string {
  const value = (os ?? '').trim().toLowerCase();
  return ['ios', 'android', 'windows', 'macos', 'linux'].includes(value) ? value : 'other';
}

/**
 * Derives a human-readable transaction title from its `planSnapshot`. Both the
 * add-on purchase marker and the plan-purchase snapshot carry a `name`, so a
 * single read covers add-on top-ups ("Extra 50GB") and plan purchases alike.
 * Combined-renewal drafts (no `name`) return `null` → the client uses a
 * purchase-type / gateway fallback.
 */
function readTransactionTitle(planSnapshot: Prisma.JsonValue): string | null {
  if (
    typeof planSnapshot !== 'object' ||
    planSnapshot === null ||
    Array.isArray(planSnapshot)
  ) {
    return null;
  }
  const name = (planSnapshot as Record<string, unknown>)['name'];
  return typeof name === 'string' && name.length > 0 ? name : null;
}
