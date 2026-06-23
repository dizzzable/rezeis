import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import {
  PlanAvailability,
  PurchaseChannel,
  SubscriptionStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { PasswordHashService } from '../../auth/services/password-hash.service';
import { loginPolicy } from '../../auth/utils/login-policy.util';
import { EmailService } from '../../email/services/email.service';
import { PlanCatalogService } from '../../plans/services/plan-catalog.service';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import { AcceptInternalUserRulesDto } from '../dto/accept-internal-user-rules.dto';
import { CompleteWebAccountEmailVerificationDto } from '../dto/complete-web-account-email-verification.dto';
import { IssueWebAccountEmailVerificationChallengeDto } from '../dto/issue-web-account-email-verification-challenge.dto';
import { InternalUserSessionQueryDto } from '../dto/internal-user-session-query.dto';
import { LinkedWebAccountSignInDto } from '../dto/linked-web-account-sign-in.dto';
import { SetWebAccountPasswordDto } from '../dto/set-web-account-password.dto';
import { SnoozeWebAccountLinkPromptDto } from '../dto/snooze-web-account-link-prompt.dto';
import { InternalWebAccountEmailVerificationChallengeInterface } from '../interfaces/internal-web-account-email-verification-challenge.interface';
import { InternalPartnerStatusInterface } from '../interfaces/internal-partner-status.interface';
import { InternalUserPlanInterface } from '../interfaces/internal-user-plan.interface';
import { InternalUserSearchResultInterface } from '../interfaces/internal-user-search-result.interface';
import { InternalUserSessionInterface } from '../interfaces/internal-user-session.interface';
import { InternalUserSubscriptionInterface } from '../interfaces/internal-user-subscription.interface';

import {
  attachRevokeFailureContext,
  createChallengeHash,
  createEmailVerificationChallenge,
  createEmailVerificationChallengeExpiry,
  createEmailVerificationChallengeSecret,
  createWebAccountLinkPromptSnoozeDate,
  decrementEmailVerificationChallengeAttempts,
  getLatestActiveEmailVerificationCodeChallenge,
  getRequiredActionableWebAccount,
  getRequiredEmailVerificationWebAccount,
  getRequiredWebAccountEmail,
  hasSnoozedLinkPromptUntilOrBeyond,
  isWebAccountLoginConflictError,
  InternalUserTransactionClient,
  lockWebAccountRow,
  revokeIssuedEmailVerificationChallenge,
  revokePendingEmailVerificationChallenges,
  shouldRevokeIssuedChallengeAfterDeliveryFailure,
} from './internal-user.email-verification';
import {
  buildUserWhereUniqueInput,
  InternalUserIdentifier,
  normalizeLookupEmail,
  resolveInternalUserIdentifier,
} from './internal-user.identifiers';
import {
  collapseLegacyCatalogPrices,
  INTERNAL_USER_INCLUDE,
  InternalUserRecord,
  mapDateValue,
  mapInternalEmailVerificationChallenge,
  mapInternalUserSession,
  mapSubscriptionPlanSnapshot,
  selectCurrentSubscription,
} from './internal-user.mappers';

interface IssuedEmailVerificationChallenge {
  readonly challengeId: string;
  readonly challenge: InternalWebAccountEmailVerificationChallengeInterface;
  readonly code: string;
  readonly email: string;
  readonly expiresAt: Date;
}

/**
 * Live runtime fields overlaid from the Remnawave panel onto the local
 * `Subscription` snapshot at read time, so manual operator edits in the panel
 * surface in the bot + cabinet immediately. Each field is `undefined` when the
 * panel didn't report it (keep the local value); the panel is the source of
 * truth for the fields it does report.
 */
interface PanelSubscriptionOverlay {
  status?: SubscriptionStatus;
  /** Present → override expiry; absent → keep local. */
  expiresAt?: Date;
  /** GB; `null` = unlimited (panel reported 0 bytes); absent → keep local. */
  trafficLimit?: number | null;
  deviceLimit?: number;
}

const PANEL_SUBSCRIPTION_STATUS_MAP: Readonly<Record<string, SubscriptionStatus>> = {
  ACTIVE: SubscriptionStatus.ACTIVE,
  DISABLED: SubscriptionStatus.DISABLED,
  LIMITED: SubscriptionStatus.LIMITED,
  EXPIRED: SubscriptionStatus.EXPIRED,
};

/** Map a panel `status` string onto the local enum; `undefined` when unknown. */
function mapPanelSubscriptionStatus(raw: string | null): SubscriptionStatus | undefined {
  if (raw === null) return undefined;
  return PANEL_SUBSCRIPTION_STATUS_MAP[raw.trim().toUpperCase()];
}

/**
 * Handles internal user session reads and narrow writes for internal admin
 * clients. Helpers (mappers, identifier resolution, email-verification
 * challenge plumbing) live in sibling files so the surface of this class
 * stays focused on orchestration.
 */
@Injectable()
export class InternalUserService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly passwordHashService: PasswordHashService,
    private readonly emailService: EmailService,
    @Optional()
    private readonly planCatalogService?: PlanCatalogService,
    @Optional()
    private readonly remnawaveApiService?: RemnawaveApiService,
  ) {}

  /**
   * Returns the public plans available to internal admin clients.
   */
  public async getPlans(): Promise<readonly InternalUserPlanInterface[]> {
    if (this.planCatalogService !== undefined) {
      const catalogPlans = await this.planCatalogService.getCatalogPlans({
        channel: PurchaseChannel.WEB,
      });
      return catalogPlans.map((plan) => ({
        id: plan.id,
        orderIndex: plan.orderIndex,
        name: plan.name,
        description: plan.description,
        tag: plan.tag,
        icon: plan.icon,
        type: plan.type,
        trafficLimit: plan.trafficLimit,
        deviceLimit: plan.deviceLimit,
        durations: plan.durations.map((duration) => ({
          id: duration.id,
          days: duration.days,
          prices: collapseLegacyCatalogPrices(duration.prices),
        })),
      }));
    }
    const plans = await this.prismaService.plan.findMany({
      where: {
        isActive: true,
        isArchived: false,
        availability: PlanAvailability.ALL,
      },
      orderBy: {
        orderIndex: 'asc',
      },
      include: {
        durations: {
          include: {
            prices: {
              orderBy: {
                currency: 'asc',
              },
            },
          },
          orderBy: {
            days: 'asc',
          },
        },
      },
    });
    return plans.map((plan) => ({
      id: plan.id,
      orderIndex: plan.orderIndex,
      name: plan.name,
      description: plan.description,
      tag: plan.tag,
      icon: plan.icon,
      type: plan.type,
      trafficLimit: plan.trafficLimit,
      deviceLimit: plan.deviceLimit,
      durations: plan.durations.map((duration) => ({
        id: duration.id,
        days: duration.days,
        prices: duration.prices.map((price) => ({
          currency: price.currency,
          price: price.price.toString(),
        })),
      })),
    }));
  }

  /**
   * Returns the resolved current user session payload.
   */
  public async getSession(
    query: InternalUserSessionQueryDto,
  ): Promise<InternalUserSessionInterface> {
    const user = await this.getRequiredUser(query);
    return mapInternalUserSession(user);
  }

  /**
   * Verifies linked web-account credentials and returns the canonical user session payload.
   */
  public async signInLinkedWebAccount(
    input: LinkedWebAccountSignInDto,
  ): Promise<InternalUserSessionInterface> {
    if (!loginPolicy.isValidLogin(input.login)) {
      throw new UnauthorizedException('Invalid login or password');
    }
    const loginNormalized: string = loginPolicy.normalizeLogin(input.login);
    const webAccount = await this.prismaService.webAccount.findUnique({
      where: {
        loginNormalized,
      },
    });
    if (webAccount === null) {
      throw new UnauthorizedException('Invalid login or password');
    }
    if (webAccount.passwordHash === null) {
      throw new BadRequestException('webAccount password is not configured');
    }
    if (webAccount.requiresPasswordChange) {
      throw new BadRequestException('webAccount password change is required');
    }
    if (webAccount.emailVerifiedAt === null) {
      throw new BadRequestException('webAccount email is not verified');
    }
    const isPasswordValid: boolean = await this.passwordHashService.verifyPassword({
      plainTextPassword: input.password,
      passwordHash: webAccount.passwordHash,
    });
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid login or password');
    }
    const user = await this.getRequiredUserById(webAccount.userId);
    if (user.isBlocked) {
      throw new BadRequestException('User is blocked');
    }
    return mapInternalUserSession(user);
  }

  /**
   * Returns the aggregated session and current subscription payload from one resolved user snapshot.
   */
  public async getSearchResult(
    query: InternalUserSessionQueryDto,
  ): Promise<InternalUserSearchResultInterface> {
    const user = await this.getRequiredUser(query);
    const subscription = await this.getCurrentSubscription(user.id);
    return {
      session: mapInternalUserSession(user),
      subscription,
    };
  }

  /**
   * Marks the resolved user's rules as accepted and returns the refreshed session payload.
   */
  public async acceptRules(
    query: AcceptInternalUserRulesDto,
  ): Promise<InternalUserSessionInterface> {
    const userId = this.getRequiredUserId(query.userId);
    await this.prismaService.user.updateMany({
      where: {
        id: userId,
        isRulesAccepted: false,
      },
      data: {
        isRulesAccepted: true,
      },
    });
    const refreshedUser = await this.getRequiredUserById(userId);
    return mapInternalUserSession(refreshedUser);
  }

  /**
   * Records whether the resolved user has finished/skipped the cabinet
   * onboarding tour. `completed=false` resets it (so the tour replays from
   * the "replay tutorial" control). Returns the refreshed session payload.
   */
  public async setOnboardingCompleted(
    userId: string | undefined,
    completed: boolean,
  ): Promise<InternalUserSessionInterface> {
    const resolvedUserId = this.getRequiredUserId(userId);
    await this.prismaService.user.update({
      where: { id: resolvedUserId },
      data: { onboardingCompletedAt: completed ? new Date() : null },
    });
    const refreshedUser = await this.getRequiredUserById(resolvedUserId);
    return mapInternalUserSession(refreshedUser);
  }

  /**
   * Snoozes the resolved user's linked web-account prompt and returns the refreshed session payload.
   */
  public async snoozeWebAccountLinkPrompt(
    query: SnoozeWebAccountLinkPromptDto,
  ): Promise<InternalUserSessionInterface> {
    const userId = this.getRequiredUserId(query.userId);
    const currentUser = await this.getRequiredUserById(userId);
    const webAccount = getRequiredActionableWebAccount(currentUser);
    const snoozeUntil = createWebAccountLinkPromptSnoozeDate();
    if (hasSnoozedLinkPromptUntilOrBeyond(webAccount, snoozeUntil)) {
      return mapInternalUserSession(currentUser);
    }
    await this.prismaService.webAccount.updateMany({
      where: {
        userId,
        requiresPasswordChange: webAccount.requiresPasswordChange,
        credentialsBootstrappedAt: webAccount.credentialsBootstrappedAt,
        OR: [{ linkPromptSnoozeUntil: null }, { linkPromptSnoozeUntil: { lt: snoozeUntil } }],
      },
      data: {
        linkPromptSnoozeUntil: snoozeUntil,
      },
    });
    const refreshedUser = await this.getRequiredUserById(userId);
    return mapInternalUserSession(refreshedUser);
  }

  /**
   * Sets the resolved user's linked web-account password and returns the refreshed session payload.
   */
  public async setWebAccountPassword(
    input: SetWebAccountPasswordDto,
  ): Promise<InternalUserSessionInterface> {
    const userId = this.getRequiredUserId(input.userId);
    const currentUser = await this.getRequiredUserById(userId);
    const webAccount = getRequiredActionableWebAccount(currentUser);
    if (!loginPolicy.isValidLogin(input.login)) {
      throw new BadRequestException('webAccount login is invalid');
    }
    const login: string = loginPolicy.sanitizeLogin(input.login);
    const loginNormalized: string = loginPolicy.normalizeLogin(input.login);
    const passwordHash: string = await this.passwordHashService.hashPassword({
      plainTextPassword: input.password,
    });
    const credentialsBootstrappedAt: Date =
      webAccount.credentialsBootstrappedAt ?? new Date(Date.now());
    let updateResult: { readonly count: number };
    try {
      updateResult = await this.prismaService.webAccount.updateMany({
        where: {
          userId,
          requiresPasswordChange: webAccount.requiresPasswordChange,
          credentialsBootstrappedAt: webAccount.credentialsBootstrappedAt,
        },
        data: {
          login,
          loginNormalized,
          passwordHash,
          credentialsBootstrappedAt,
          requiresPasswordChange: false,
          temporaryPasswordExpiresAt: null,
          linkPromptSnoozeUntil: null,
        },
      });
    } catch (err: unknown) {
      if (isWebAccountLoginConflictError(err)) {
        throw new BadRequestException('webAccount login is already taken');
      }
      throw err;
    }
    if (updateResult.count === 0) {
      throw new BadRequestException('webAccount password handoff is not actionable');
    }
    const refreshedUser = await this.getRequiredUserById(userId);
    return mapInternalUserSession(refreshedUser);
  }

  /**
   * Creates or rotates the linked web-account email verification challenge and returns the narrow challenge state.
   */
  public async issueWebAccountEmailVerificationChallenge(
    input: IssueWebAccountEmailVerificationChallengeDto,
  ): Promise<InternalWebAccountEmailVerificationChallengeInterface> {
    const userId = this.getRequiredUserId(input.userId);
    const issuedChallenge = await this.prismaService.$transaction(
      async (transactionClient): Promise<IssuedEmailVerificationChallenge> => {
        const user = await transactionClient.user.findUnique({
          where: { id: userId },
          include: INTERNAL_USER_INCLUDE,
        });
        if (!user) {
          throw new NotFoundException('User not found');
        }
        const userWebAccount = getRequiredEmailVerificationWebAccount(user);
        await lockWebAccountRow(transactionClient as InternalUserTransactionClient, userWebAccount.id);
        const lockedWebAccount = await transactionClient.webAccount.findUnique({
          where: { id: userWebAccount.id },
        });
        if (lockedWebAccount === null) {
          throw new BadRequestException('webAccount must exist');
        }
        if (lockedWebAccount.emailVerifiedAt !== null) {
          throw new BadRequestException('webAccount email is already verified');
        }
        const now = new Date(Date.now());
        const expiresAt = createEmailVerificationChallengeExpiry(now);
        const challengeSecret = createEmailVerificationChallengeSecret();
        const email = getRequiredWebAccountEmail(lockedWebAccount);
        const transactionUserClient = transactionClient as InternalUserTransactionClient;
        await revokePendingEmailVerificationChallenges({
          transactionClient: transactionUserClient,
          webAccountId: lockedWebAccount.id,
          now,
        });
        const challenge = await createEmailVerificationChallenge({
          transactionClient: transactionUserClient,
          webAccountId: lockedWebAccount.id,
          email,
          expiresAt,
          challengeSecret,
        });
        return {
          challengeId: challenge.id,
          challenge: mapInternalEmailVerificationChallenge({
            webAccount: lockedWebAccount,
            challenge,
            email,
          }),
          code: challengeSecret.code,
          email,
          expiresAt,
        };
      },
    );
    try {
      await this.emailService.sendLinkedAccountVerificationCode({
        emailAddress: issuedChallenge.email,
        code: issuedChallenge.code,
        expiresAt: issuedChallenge.expiresAt,
      });
    } catch (err: unknown) {
      if (!shouldRevokeIssuedChallengeAfterDeliveryFailure(err)) {
        throw err;
      }
      try {
        await revokeIssuedEmailVerificationChallenge({
          prismaService: this.prismaService,
          challengeId: issuedChallenge.challengeId,
          revokedAt: new Date(Date.now()),
        });
      } catch (revokeErr: unknown) {
        throw attachRevokeFailureContext(err, revokeErr);
      }
      throw err;
    }
    return issuedChallenge.challenge;
  }

  /**
   * Consumes the latest actionable linked web-account email verification challenge and returns the refreshed session payload.
   */
  public async completeWebAccountEmailVerification(
    input: CompleteWebAccountEmailVerificationDto,
  ): Promise<InternalUserSessionInterface> {
    const userId = this.getRequiredUserId(input.userId);
    return this.prismaService.$transaction(
      async (transactionClient): Promise<InternalUserSessionInterface> => {
        const user = await transactionClient.user.findUnique({
          where: { id: userId },
          include: INTERNAL_USER_INCLUDE,
        });
        if (!user) {
          throw new NotFoundException('User not found');
        }
        const userWebAccount = getRequiredEmailVerificationWebAccount(user);
        const transactionUserClient = transactionClient as InternalUserTransactionClient;
        await lockWebAccountRow(transactionUserClient, userWebAccount.id);
        const lockedWebAccount = await transactionClient.webAccount.findUnique({
          where: { id: userWebAccount.id },
        });
        if (lockedWebAccount === null) {
          throw new BadRequestException('webAccount must exist');
        }
        if (lockedWebAccount.emailVerifiedAt !== null) {
          throw new BadRequestException('webAccount email is already verified');
        }
        const now = new Date(Date.now());
        const currentEmail = getRequiredWebAccountEmail(lockedWebAccount);
        const challenge = await getLatestActiveEmailVerificationCodeChallenge({
          transactionClient: transactionUserClient,
          webAccountId: lockedWebAccount.id,
          destination: currentEmail,
          now,
        });
        if (challenge === null) {
          throw new BadRequestException('active email verification challenge not found');
        }
        const codeHash = createChallengeHash(input.code);
        if (challenge.codeHash !== codeHash) {
          await decrementEmailVerificationChallengeAttempts({
            transactionClient: transactionUserClient,
            challenge,
            now,
          });
          throw new BadRequestException('invalid email verification code');
        }
        await transactionUserClient.authChallenge.update({
          where: { id: challenge.id },
          data: { consumedAt: now },
        });
        await transactionUserClient.webAccount.update({
          where: { id: lockedWebAccount.id },
          data: { emailVerifiedAt: now },
        });
        const refreshedUser = await transactionClient.user.findUnique({
          where: { id: userId },
          include: INTERNAL_USER_INCLUDE,
        });
        if (!refreshedUser) {
          throw new NotFoundException('User not found');
        }
        return mapInternalUserSession(refreshedUser);
      },
    );
  }

  /**
   * Returns the current subscription for the resolved user.
   */
  public async getSubscription(
    query: InternalUserSessionQueryDto,
  ): Promise<InternalUserSubscriptionInterface | null> {
    const user = await this.getRequiredUser(query);
    return this.getCurrentSubscription(user.id);
  }

  /**
   * Returns ALL non-deleted subscriptions for the resolved user.
   */
  public async getAllSubscriptions(
    query: InternalUserSessionQueryDto,
  ): Promise<{ subscriptions: InternalUserSubscriptionInterface[] }> {
    const user = await this.getRequiredUser(query);
    const subscriptions = await this.prismaService.subscription.findMany({
      where: {
        userId: user.id,
        status: { not: SubscriptionStatus.DELETED },
      },
      // Oldest first: the first subscription a user bought stays first in the
      // carousel; newly purchased subscriptions append to the end.
      orderBy: [{ createdAt: 'asc' }],
    });
    // Resolve each subscription's panel profile name + used traffic in
    // parallel so the carousel cards show the real profile name (not the
    // UUID) and a populated traffic bar — matching the single-subscription
    // path. Best-effort: failures resolve to nulls and the card degrades.
    const usages = await Promise.all(
      subscriptions.map((sub) => this.resolvePanelUsage(sub.remnawaveId)),
    );
    return {
      subscriptions: subscriptions.map((sub, i) => {
        const u = usages[i];
        const o = u.overlay;
        return {
          id: sub.id,
          status: o?.status ?? sub.status,
          isTrial: sub.isTrial,
          plan: mapSubscriptionPlanSnapshot(sub.planSnapshot),
          trafficLimit: o?.trafficLimit !== undefined ? o.trafficLimit : sub.trafficLimit,
          trafficUsed: u.trafficUsedGb,
          deviceLimit: o?.deviceLimit ?? sub.deviceLimit,
          userRemnaId: sub.remnawaveId,
          profileName: u.profileName,
          url: sub.configUrl,
          configUrl: sub.configUrl,
          startedAt: mapDateValue(sub.startedAt),
          expiresAt: mapDateValue(o?.expiresAt !== undefined ? o.expiresAt : sub.expiresAt),
          createdAt: sub.createdAt.toISOString(),
          updatedAt: sub.updatedAt.toISOString(),
        };
      }),
    };
  }

  /**
   * Returns the resolved user's lightweight partner status (active flag).
   */
  public async getPartnerStatus(
    query: InternalUserSessionQueryDto,
  ): Promise<InternalPartnerStatusInterface> {
    const user = await this.getRequiredUser(query);
    const partner = await this.prismaService.partner.findUnique({
      where: { userId: user.id },
      select: { isActive: true },
    });
    return { isActive: partner?.isActive === true };
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private async getCurrentSubscription(
    userId: string,
  ): Promise<InternalUserSubscriptionInterface | null> {
    const subscriptions = await this.prismaService.subscription.findMany({
      where: {
        userId,
        status: { not: SubscriptionStatus.DELETED },
      },
      orderBy: [{ createdAt: 'desc' }],
    });
    const subscription = selectCurrentSubscription(subscriptions);
    if (subscription === null) {
      return null;
    }
    const usage = await this.resolvePanelUsage(subscription.remnawaveId);
    const o = usage.overlay;
    return {
      id: subscription.id,
      status: o?.status ?? subscription.status,
      isTrial: subscription.isTrial,
      plan: mapSubscriptionPlanSnapshot(subscription.planSnapshot),
      trafficLimit: o?.trafficLimit !== undefined ? o.trafficLimit : subscription.trafficLimit,
      trafficUsed: usage.trafficUsedGb,
      deviceLimit: o?.deviceLimit ?? subscription.deviceLimit,
      userRemnaId: subscription.remnawaveId,
      profileName: usage.profileName,
      url: subscription.configUrl,
      configUrl: subscription.configUrl,
      startedAt: mapDateValue(subscription.startedAt),
      expiresAt: mapDateValue(
        o?.expiresAt !== undefined ? o.expiresAt : subscription.expiresAt,
      ),
      createdAt: subscription.createdAt.toISOString(),
      updatedAt: subscription.updatedAt.toISOString(),
    };
  }

  /**
   * Best-effort single-call fetch of a subscription's Remnawave profile
   * name and used traffic (converted to GB). Returns nulls when the panel
   * client is absent (worker context), the subscription has no upstream
   * profile, or the panel read fails — the SPA then shows the local data
   * and hides the bar instead of rendering a misleading 0%.
   */
  private async resolvePanelUsage(
    remnawaveId: string | null,
  ): Promise<{
    profileName: string | null;
    trafficUsedGb: number | null;
    overlay: PanelSubscriptionOverlay | null;
  }> {
    if (this.remnawaveApiService === undefined || remnawaveId === null) {
      return { profileName: null, trafficUsedGb: null, overlay: null };
    }
    const usage = await this.remnawaveApiService.getPanelUserUsage(remnawaveId);
    if (usage === null) {
      return { profileName: null, trafficUsedGb: null, overlay: null };
    }
    const trafficUsedGb =
      usage.usedTrafficBytes === null
        ? null
        : Math.round((usage.usedTrafficBytes / 1024 ** 3) * 100) / 100;

    // Overlay only the fields the panel actually reported (`undefined` = keep
    // the local snapshot). Defensive typeof guards so a partial payload (or a
    // test stub) never writes NaN / garbage. Panel is the source of truth.
    const overlay: PanelSubscriptionOverlay = {};
    const status = mapPanelSubscriptionStatus(
      typeof usage.status === 'string' ? usage.status : null,
    );
    if (status !== undefined) overlay.status = status;
    if (typeof usage.expireAt === 'string' && usage.expireAt.length > 0) {
      const parsed = new Date(usage.expireAt);
      if (!Number.isNaN(parsed.getTime())) overlay.expiresAt = parsed;
    }
    if (typeof usage.trafficLimitBytes === 'number' && Number.isFinite(usage.trafficLimitBytes)) {
      overlay.trafficLimit =
        usage.trafficLimitBytes <= 0
          ? null
          : Math.max(1, Math.round(usage.trafficLimitBytes / 1024 ** 3));
    }
    if (
      typeof usage.hwidDeviceLimit === 'number' &&
      Number.isFinite(usage.hwidDeviceLimit) &&
      usage.hwidDeviceLimit >= 0
    ) {
      overlay.deviceLimit = usage.hwidDeviceLimit;
    }
    return { profileName: usage.username, trafficUsedGb, overlay };
  }

  private async getRequiredUser(
    query: InternalUserSessionQueryDto,
  ): Promise<InternalUserRecord> {
    const identifier = resolveInternalUserIdentifier(query);
    const user = await this.findUserByIdentifier(identifier);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  private async getRequiredUserById(userId: string | undefined): Promise<InternalUserRecord> {
    const user = await this.prismaService.user.findUnique({
      where: { id: this.getRequiredUserId(userId) },
      include: INTERNAL_USER_INCLUDE,
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  private getRequiredUserId(userId: string | undefined): string {
    if (!userId) {
      throw new BadRequestException('userId must be provided');
    }
    return userId;
  }

  private async findUserByIdentifier(
    identifier: InternalUserIdentifier,
  ): Promise<InternalUserRecord | null> {
    if (identifier.type === 'email') {
      return this.findUserByEmail(identifier.value);
    }
    if (identifier.type === 'login') {
      return this.findUserByLogin(identifier.value);
    }
    return this.prismaService.user.findUnique({
      where: buildUserWhereUniqueInput(identifier),
      include: INTERNAL_USER_INCLUDE,
    });
  }

  private async findUserByEmail(email: string): Promise<InternalUserRecord | null> {
    const normalizedEmail = normalizeLookupEmail(email);
    const exactCaseUser = await this.prismaService.user.findUnique({
      where: { email: normalizedEmail },
      include: INTERNAL_USER_INCLUDE,
    });
    if (exactCaseUser !== null) {
      return exactCaseUser;
    }
    const caseInsensitiveUsers = await this.prismaService.user.findMany({
      where: {
        email: {
          equals: normalizedEmail,
          mode: 'insensitive',
        },
      },
      include: INTERNAL_USER_INCLUDE,
    });
    if (caseInsensitiveUsers.length > 1) {
      throw new BadRequestException('User email lookup is ambiguous');
    }
    const caseInsensitiveUser = caseInsensitiveUsers[0] ?? null;
    if (caseInsensitiveUser !== null) {
      return caseInsensitiveUser;
    }
    const webAccount = await this.prismaService.webAccount.findUnique({
      where: { emailNormalized: normalizedEmail },
    });
    if (webAccount === null) {
      return null;
    }
    return this.prismaService.user.findUnique({
      where: { id: webAccount.userId },
      include: INTERNAL_USER_INCLUDE,
    });
  }

  private async findUserByLogin(login: string): Promise<InternalUserRecord | null> {
    const normalizedLogin: string = loginPolicy.normalizeLogin(login);
    const webAccount = await this.prismaService.webAccount.findUnique({
      where: { loginNormalized: normalizedLogin },
    });
    if (webAccount === null) {
      return null;
    }
    return this.prismaService.user.findUnique({
      where: { id: webAccount.userId },
      include: INTERNAL_USER_INCLUDE,
    });
  }
}
