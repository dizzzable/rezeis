import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { SubscriptionMutationsService } from '../../subscriptions/services/subscription-mutations.service';
import { AcceptInternalUserRulesDto } from '../dto/accept-internal-user-rules.dto';
import { CompleteWebAccountEmailVerificationDto } from '../dto/complete-web-account-email-verification.dto';
import { InternalBootstrapUserDto } from '../dto/internal-bootstrap-user.dto';
import { InternalByTelegramQueryDto } from '../dto/internal-by-telegram-query.dto';
import { InternalSurfaceSeenDto } from '../dto/internal-surface-seen.dto';
import { InternalUpdateLanguageDto } from '../dto/internal-update-language.dto';
import { IssueWebAccountEmailVerificationChallengeDto } from '../dto/issue-web-account-email-verification-challenge.dto';
import { InternalUserSessionQueryDto } from '../dto/internal-user-session-query.dto';
import { LinkedWebAccountSignInDto } from '../dto/linked-web-account-sign-in.dto';
import { SetWebAccountPasswordDto } from '../dto/set-web-account-password.dto';
import { SnoozeWebAccountLinkPromptDto } from '../dto/snooze-web-account-link-prompt.dto';
import { InternalWebAccountEmailVerificationChallengeInterface } from '../interfaces/internal-web-account-email-verification-challenge.interface';
import {
  InternalUserNotificationInterface,
  InternalUserTransactionInterface,
} from '../interfaces/internal-user-notification.interface';
import { InternalPartnerStatusInterface } from '../interfaces/internal-partner-status.interface';
import { InternalUserPlanInterface } from '../interfaces/internal-user-plan.interface';
import { InternalUserSessionInterface } from '../interfaces/internal-user-session.interface';
import { InternalUserSubscriptionInterface } from '../interfaces/internal-user-subscription.interface';
import { InternalUserEdgeService } from '../services/internal-user-edge.service';
import { InternalUserService } from '../services/internal-user.service';
import { requireUserReference } from '../utils/user-reference.util';

/**
 * Exposes internal user session and lookup endpoints for internal admin clients.
 */
@Controller('internal/user')
@UseGuards(InternalAdminAuthGuard)
export class InternalUserController {
  public constructor(
    private readonly internalUserService: InternalUserService,
    private readonly internalUserEdgeService: InternalUserEdgeService,
    private readonly subscriptionMutationsService: SubscriptionMutationsService,
  ) {}

  /**
   * Returns the resolved user session payload.
   */
  @Get('session')
  public async getSession(
    @Query() query: InternalUserSessionQueryDto,
  ): Promise<InternalUserSessionInterface> {
    return this.internalUserService.getSession(query);
  }

  /**
   * Authenticates a linked web account and returns the canonical user session payload.
   */
  @Post('web-account/sign-in')
  public async signInLinkedWebAccount(
    @Body() input: LinkedWebAccountSignInDto,
  ): Promise<InternalUserSessionInterface> {
    return this.internalUserService.signInLinkedWebAccount(input);
  }

  /**
   * Marks the resolved user's rules as accepted.
   */
  @Patch('session/rules-acceptance')
  public async acceptRules(
    @Query() query: AcceptInternalUserRulesDto,
  ): Promise<InternalUserSessionInterface> {
    return this.internalUserService.acceptRules(query);
  }

  /**
   * Records the resolved user's onboarding-tour state. Body `{ completed }`
   * — `true` marks the tour finished/skipped, `false` resets it so the
   * cabinet "replay tutorial" control re-triggers the tour.
   */
  @Patch('session/onboarding')
  public async setOnboarding(
    @Query() query: InternalUserSessionQueryDto,
    @Body() body: { completed?: boolean },
  ): Promise<InternalUserSessionInterface> {
    return this.internalUserService.setOnboardingCompleted(
      query.userId,
      body?.completed !== false,
    );
  }

  /**
   * Snoozes the resolved user's linked web-account prompt.
   */
  @Patch('session/web-account-link-prompt-snooze')
  public async snoozeWebAccountLinkPrompt(
    @Query() query: SnoozeWebAccountLinkPromptDto,
  ): Promise<InternalUserSessionInterface> {
    return this.internalUserService.snoozeWebAccountLinkPrompt(query);
  }

  /**
   * Sets the resolved user's linked web-account password through the internal handoff path.
   */
  @Patch('session/web-account-password')
  public async setWebAccountPassword(
    @Body() input: SetWebAccountPasswordDto,
  ): Promise<InternalUserSessionInterface> {
    return this.internalUserService.setWebAccountPassword(input);
  }

  /**
   * Creates or rotates the linked web-account email verification challenge.
   */
  @Patch('session/web-account-email-verification-challenge')
  public async issueWebAccountEmailVerificationChallenge(
    @Body() input: IssueWebAccountEmailVerificationChallengeDto,
  ): Promise<InternalWebAccountEmailVerificationChallengeInterface> {
    return this.internalUserService.issueWebAccountEmailVerificationChallenge(input);
  }

  /**
   * Consumes the latest actionable linked web-account email verification challenge.
   */
  @Patch('session/web-account-email-verification-completion')
  public async completeWebAccountEmailVerification(
    @Body() input: CompleteWebAccountEmailVerificationDto,
  ): Promise<InternalUserSessionInterface> {
    return this.internalUserService.completeWebAccountEmailVerification(input);
  }

  /**
   * Returns the public plans list.
   */
  @Get('plans')
  public async getPlans(): Promise<readonly InternalUserPlanInterface[]> {
    return this.internalUserService.getPlans();
  }

  /**
   * Returns the latest known subscription payload for the resolved user.
   */
  @Get('subscription')
  public async getSubscription(
    @Query() query: InternalUserSessionQueryDto,
  ): Promise<InternalUserSubscriptionInterface | null> {
    return this.internalUserService.getSubscription(query);
  }

  /**
   * Returns ALL subscriptions for the resolved user (for carousel display).
   */
  @Get('subscriptions')
  public async getAllSubscriptions(
    @Query() query: InternalUserSessionQueryDto,
  ): Promise<{ subscriptions: InternalUserSubscriptionInterface[] }> {
    return this.internalUserService.getAllSubscriptions(query);
  }

  /**
   * Returns the lightweight partner-status flag for the resolved user.
   * Used by reiwa to decide between the Referral / Partner bottom-nav tab.
   */
  @Get('partner-status')
  public async getPartnerStatus(
    @Query() query: InternalUserSessionQueryDto,
  ): Promise<InternalPartnerStatusInterface> {
    return this.internalUserService.getPartnerStatus(query);
  }

  // ── Edge endpoints (bot-side bootstrap, language, notifications, etc.) ──

  /**
   * Bot-side `/start` bootstrap: idempotent create-or-refresh by Telegram id.
   * Returns the canonical session payload so the bot can drive its first UI
   * pass without making a follow-up `GET /session` call.
   */
  @Post('bootstrap')
  public async bootstrap(
    @Body() body: InternalBootstrapUserDto,
  ): Promise<InternalUserSessionInterface> {
    return this.internalUserEdgeService.bootstrapByTelegram({
      telegramId: body.telegramId,
      username: body.username ?? null,
      name: body.name,
      language: body.language ?? null,
    });
  }

  /**
   * Lightweight existence probe used by reiwa-bot before bootstrap: when
   * the platform is in `REG_BLOCKED` / `INVITED` mode the bot must show
   * a banner to brand-new Telegram users without creating a `User` row.
   * Returns `{ exists: boolean }` keyed by `telegramId` (or `userId`),
   * never throws on missing user.
   */
  @Get('exists')
  public async userExists(
    @Query() query: InternalByTelegramQueryDto,
  ): Promise<{ exists: boolean }> {
    return this.internalUserEdgeService.userExists(requireUserReference(query));
  }

  /**
   * Updates the user's UI locale. Reiwa pushes this on every `/lang`
   * command so admin-side notifications match the user's choice.
   */
  @Patch('language')
  public async updateLanguage(
    @Body() body: InternalUpdateLanguageDto,
  ): Promise<InternalUserSessionInterface> {
    return this.internalUserEdgeService.updateLanguage(
      requireUserReference(body),
      body.language,
    );
  }

  /** Notifications feed used by the dashboard panel and the bot's activity command. */
  @Get('notifications')
  public async listNotifications(
    @Query() query: InternalByTelegramQueryDto,
  ): Promise<{ notifications: readonly InternalUserNotificationInterface[] }> {
    return this.internalUserEdgeService.listNotifications(requireUserReference(query));
  }

  @Get('notifications/unread-count')
  public async unreadCount(
    @Query() query: InternalByTelegramQueryDto,
  ): Promise<{ unread: number }> {
    return this.internalUserEdgeService.getUnreadCount(requireUserReference(query));
  }

  @Post('notifications/read-all')
  public async readAll(
    @Body() body: InternalByTelegramQueryDto,
  ): Promise<{ updated: number }> {
    return this.internalUserEdgeService.markAllRead(requireUserReference(body));
  }

  @Post('notifications/:notificationId/read')
  public async readOne(
    @Param('notificationId') notificationId: string,
    @Body() body: InternalByTelegramQueryDto,
  ): Promise<{ ok: true }> {
    return this.internalUserEdgeService.markOneRead(requireUserReference(body), notificationId);
  }

  /** Transaction history shown on the activity / settings page. */
  @Get('transactions')
  public async listTransactions(
    @Query() query: InternalByTelegramQueryDto,
  ): Promise<{ transactions: readonly InternalUserTransactionInterface[] }> {
    return this.internalUserEdgeService.listTransactions(requireUserReference(query));
  }

  // ── Trial ────────────────────────────────────────────────────────────────

  @Get('trial/eligibility')
  public async trialEligibility(
    @Query() query: InternalByTelegramQueryDto,
  ): Promise<{ eligible: boolean; reason: string | null }> {
    return this.internalUserEdgeService.getTrialEligibility(requireUserReference(query));
  }

  /**
   * Activates the trial plan for the resolved user. Returns a
   * structured `{ activated, reason? }` payload — never throws on
   * ineligible cases so the bot can render a friendly message.
   */
  @Post('trial')
  public async trialActivate(
    @Body() body: InternalByTelegramQueryDto,
  ): Promise<{ activated: boolean; subscriptionId?: string; reason?: string }> {
    return this.internalUserEdgeService.activateTrial(
      requireUserReference(body),
      (input) => this.subscriptionMutationsService.grantTrial(input),
    );
  }

  // ── Bot block flag ───────────────────────────────────────────────────────

  /**
   * Sets `User.isBotBlocked = true` for the user identified by Telegram
   * id. Called by reiwa-bot when Telegram returns 403 Forbidden during
   * a `/notify` delivery attempt — that means the user has either
   * blocked the bot or removed it from the chat. Persisting this flag
   * stops the notification fanout from re-attempting and lets admin
   * filter blocked users out of broadcasts (`broadcast-delivery.service`
   * already uses this flag).
   */
  @Post('bot-blocked')
  public async markBotBlocked(
    @Body() body: InternalByTelegramQueryDto,
  ): Promise<{ ok: true }> {
    await this.internalUserEdgeService.markBotBlocked(body.telegramId!);

    return { ok: true };
  }

  /**
   * Record the surface the user is currently using (called once per cabinet
   * session): tma / pwa / browser + form factor + os. Stamps the PWA-install
   * milestone once and refreshes the latest-seen snapshot for usage analytics.
   */
  @Post('surface-seen')
  public async recordSurfaceSeen(
    @Body() body: InternalSurfaceSeenDto,
  ): Promise<{ ok: true }> {
    await this.internalUserEdgeService.recordSurfaceSeen(requireUserReference(body), {
      surface: body.surface ?? 'browser',
      formFactor: body.formFactor ?? 'desktop',
      os: body.os ?? 'other',
    });
    return { ok: true };
  }
}