import { createHash, randomBytes, randomInt } from 'node:crypto';

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AuthChallenge,
  PlanAvailability,
  PlanType,
  Prisma,
  PrismaClientKnownRequestError,
  Subscription,
  SubscriptionStatus,
  User,
  WebAccount,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { PasswordHashService } from '../../auth/services/password-hash.service';
import { loginPolicy } from '../../auth/utils/login-policy.util';
import { EmailDeliveryException } from '../../email/errors/email-delivery.exception';
import { EmailService } from '../../email/services/email.service';
import { AcceptInternalUserRulesDto } from '../dto/accept-internal-user-rules.dto';
import { CompleteWebAccountEmailVerificationDto } from '../dto/complete-web-account-email-verification.dto';
import { IssueWebAccountEmailVerificationChallengeDto } from '../dto/issue-web-account-email-verification-challenge.dto';
import { InternalUserSessionQueryDto } from '../dto/internal-user-session-query.dto';
import { SetWebAccountPasswordDto } from '../dto/set-web-account-password.dto';
import { SnoozeWebAccountLinkPromptDto } from '../dto/snooze-web-account-link-prompt.dto';
import { InternalWebAccountEmailVerificationChallengeInterface } from '../interfaces/internal-web-account-email-verification-challenge.interface';
import { InternalUserPlanInterface } from '../interfaces/internal-user-plan.interface';
import { InternalUserSearchResultInterface } from '../interfaces/internal-user-search-result.interface';
import { InternalUserSessionInterface } from '../interfaces/internal-user-session.interface';
import { InternalUserSubscriptionInterface } from '../interfaces/internal-user-subscription.interface';

interface InternalUserIdentifier {
  readonly type: 'userId' | 'telegramId' | 'email' | 'login';
  readonly value: string;
}

type InternalUserRecord = User & { readonly webAccount: WebAccount | null };

const INTERNAL_USER_INCLUDE = {
  webAccount: true,
} as const;

const WEB_ACCOUNT_LINK_PROMPT_SNOOZE_DAYS: number = 7;
const EMAIL_VERIFY_CHALLENGE_PURPOSE = 'email_verify';
const EMAIL_VERIFY_CHALLENGE_CHANNEL = 'email';
const EMAIL_VERIFY_CHALLENGE_TTL_MINUTES: number = 15;
const EMAIL_VERIFY_CHALLENGE_ATTEMPTS: number = 5;
const EMAIL_VERIFY_CODE_LENGTH: number = 6;
const EMAIL_VERIFY_TOKEN_BYTES: number = 32;

/**
 * Handles internal user session reads and narrow writes for internal admin clients.
 */
@Injectable()
export class InternalUserService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly passwordHashService: PasswordHashService,
    private readonly emailService: EmailService,
  ) {}

  /**
   * Returns the public plans available to internal admin clients.
   */
  public async getPlans(): Promise<readonly InternalUserPlanInterface[]> {
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
          where: {
            id: userId,
          },
          include: INTERNAL_USER_INCLUDE,
        });
        if (!user) {
          throw new NotFoundException('User not found');
        }
        const userWebAccount = getRequiredEmailVerificationWebAccount(user);
        await lockWebAccountRow(transactionClient as InternalUserTransactionClient, userWebAccount.id);
        const lockedWebAccount = await transactionClient.webAccount.findUnique({
          where: {
            id: userWebAccount.id,
          },
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
          where: {
            id: userId,
          },
          include: INTERNAL_USER_INCLUDE,
        });
        if (!user) {
          throw new NotFoundException('User not found');
        }
        const userWebAccount = getRequiredEmailVerificationWebAccount(user);
        const transactionUserClient = transactionClient as InternalUserTransactionClient;
        await lockWebAccountRow(transactionUserClient, userWebAccount.id);
        const lockedWebAccount = await transactionClient.webAccount.findUnique({
          where: {
            id: userWebAccount.id,
          },
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
          where: {
            id: challenge.id,
          },
          data: {
            consumedAt: now,
          },
        });
        await transactionUserClient.webAccount.update({
          where: {
            id: lockedWebAccount.id,
          },
          data: {
            emailVerifiedAt: now,
          },
        });
        const refreshedUser = await transactionClient.user.findUnique({
          where: {
            id: userId,
          },
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

  private async getCurrentSubscription(
    userId: string,
  ): Promise<InternalUserSubscriptionInterface | null> {
    const subscriptions = await this.prismaService.subscription.findMany({
      where: {
        userId,
        status: {
          not: SubscriptionStatus.DELETED,
        },
      },
      orderBy: [{ createdAt: 'desc' }],
    });
    const subscription = selectCurrentSubscription(subscriptions);
    if (subscription === null) {
      return null;
    }
    return {
      id: subscription.id,
      status: subscription.status,
      isTrial: subscription.isTrial,
      plan: mapSubscriptionPlanSnapshot(subscription.planSnapshot),
      trafficLimit: subscription.trafficLimit,
      deviceLimit: subscription.deviceLimit,
      configUrl: subscription.configUrl,
      startedAt: mapDateValue(subscription.startedAt),
      expiresAt: mapDateValue(subscription.expiresAt),
      createdAt: subscription.createdAt.toISOString(),
      updatedAt: subscription.updatedAt.toISOString(),
    };
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
      where: {
        id: this.getRequiredUserId(userId),
      },
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
      where: {
        email: normalizedEmail,
      },
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
      where: {
        emailNormalized: normalizedEmail,
      },
    });
    if (webAccount === null) {
      return null;
    }
    return this.prismaService.user.findUnique({
      where: {
        id: webAccount.userId,
      },
      include: INTERNAL_USER_INCLUDE,
    });
  }

  private async findUserByLogin(login: string): Promise<InternalUserRecord | null> {
    const normalizedLogin: string = loginPolicy.normalizeLogin(login);
    const webAccount = await this.prismaService.webAccount.findUnique({
      where: {
        loginNormalized: normalizedLogin,
      },
    });
    if (webAccount === null) {
      return null;
    }
    return this.prismaService.user.findUnique({
      where: {
        id: webAccount.userId,
      },
      include: INTERNAL_USER_INCLUDE,
    });
  }
}

interface EmailVerificationChallengeSecret {
  readonly code: string;
  readonly codeHash: string;
  readonly tokenHash: string;
}

interface IssuedEmailVerificationChallenge {
  readonly challengeId: string;
  readonly challenge: InternalWebAccountEmailVerificationChallengeInterface;
  readonly code: string;
  readonly email: string;
  readonly expiresAt: Date;
}

interface MapInternalEmailVerificationChallengeInput {
  readonly webAccount: WebAccount;
  readonly challenge: AuthChallenge;
  readonly email: string;
}

interface InternalUserTransactionClient {
  readonly authChallenge: {
    findFirst: (...args: readonly unknown[]) => Promise<AuthChallenge | null>;
    create: (...args: readonly unknown[]) => Promise<AuthChallenge>;
    update: (...args: readonly unknown[]) => Promise<AuthChallenge>;
    updateMany: (...args: readonly unknown[]) => Promise<{ readonly count: number }>;
  };
  readonly user: PrismaService['user'];
  readonly webAccount: PrismaService['webAccount'];
  readonly $queryRaw: (...args: readonly unknown[]) => Promise<unknown>;
}

function resolveInternalUserIdentifier(
  query: InternalUserSessionQueryDto,
): InternalUserIdentifier {
  const identifiers: InternalUserIdentifier[] = [];
  if (query.userId) {
    identifiers.push({ type: 'userId', value: query.userId });
  }
  if (query.telegramId) {
    identifiers.push({ type: 'telegramId', value: query.telegramId });
  }
  if (query.email) {
    identifiers.push({ type: 'email', value: query.email });
  }
  if (query.login) {
    identifiers.push({ type: 'login', value: query.login });
  }
  if (identifiers.length !== 1) {
    throw new BadRequestException(
      'Exactly one identifier must be provided: userId, telegramId, email, or login',
    );
  }
  return identifiers[0];
}

function buildUserWhereUniqueInput(identifier: InternalUserIdentifier): Prisma.UserWhereUniqueInput {
  if (identifier.type === 'userId') {
    return { id: identifier.value };
  }
  if (identifier.type === 'telegramId') {
    return { telegramId: BigInt(identifier.value) };
  }
  return { email: identifier.value };
}

function normalizeLookupEmail(email: string): string {
  return email.trim().toLowerCase();
}

function createWebAccountLinkPromptSnoozeDate(now: Date = new Date(Date.now())): Date {
  const snoozeUntil = new Date(now);
  snoozeUntil.setUTCDate(snoozeUntil.getUTCDate() + WEB_ACCOUNT_LINK_PROMPT_SNOOZE_DAYS);
  return snoozeUntil;
}

function getRequiredActionableWebAccount(user: InternalUserRecord): WebAccount {
  if (user.webAccount === null) {
    throw new BadRequestException('webAccount must exist');
  }
  if (!isWebAccountLinkPromptActionable(user.webAccount)) {
    throw new BadRequestException('webAccount link prompt is not actionable');
  }
  return user.webAccount;
}

function getRequiredEmailVerificationWebAccount(user: InternalUserRecord): WebAccount {
  if (user.webAccount === null) {
    throw new BadRequestException('webAccount must exist');
  }
  if (user.webAccount.emailVerifiedAt !== null) {
    throw new BadRequestException('webAccount email is already verified');
  }
  return user.webAccount;
}

function getRequiredWebAccountEmail(webAccount: WebAccount): string {
  const email = webAccount.email ?? webAccount.emailNormalized;
  if (email === null) {
    throw new BadRequestException('webAccount email must exist');
  }
  return email;
}

function isWebAccountLinkPromptActionable(webAccount: WebAccount): boolean {
  return (
    webAccount.requiresPasswordChange ||
    webAccount.credentialsBootstrappedAt === null ||
    webAccount.loginNormalized === null
  );
}

function hasSnoozedLinkPromptUntilOrBeyond(webAccount: WebAccount, snoozeUntil: Date): boolean {
  if (webAccount.linkPromptSnoozeUntil === null) {
    return false;
  }
  return webAccount.linkPromptSnoozeUntil.getTime() >= snoozeUntil.getTime();
}

function createEmailVerificationChallengeExpiry(now: Date): Date {
  const expiresAt = new Date(now);
  expiresAt.setUTCMinutes(expiresAt.getUTCMinutes() + EMAIL_VERIFY_CHALLENGE_TTL_MINUTES);
  return expiresAt;
}

function createEmailVerificationChallengeSecret(): EmailVerificationChallengeSecret {
  const code = createNumericChallengeCode();
  const token = randomBytes(EMAIL_VERIFY_TOKEN_BYTES).toString('base64url');
  return {
    code,
    codeHash: createChallengeHash(code),
    tokenHash: createChallengeHash(token),
  };
}

function createNumericChallengeCode(): string {
  const minimumValue = 10 ** (EMAIL_VERIFY_CODE_LENGTH - 1);
  const maximumValue = 10 ** EMAIL_VERIFY_CODE_LENGTH;
  const value = randomInt(minimumValue, maximumValue);
  return value.toString();
}

function createChallengeHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function lockWebAccountRow(
  transactionClient: InternalUserTransactionClient,
  webAccountId: string,
): Promise<void> {
  await transactionClient.$queryRaw(
    Prisma.sql`SELECT id FROM "WebAccount" WHERE id = ${webAccountId} FOR UPDATE`,
  );
}

async function revokePendingEmailVerificationChallenges(input: {
  readonly transactionClient: InternalUserTransactionClient;
  readonly webAccountId: string;
  readonly now: Date;
}): Promise<void> {
  await input.transactionClient.authChallenge.updateMany({
    where: {
      webAccountId: input.webAccountId,
      purpose: EMAIL_VERIFY_CHALLENGE_PURPOSE,
      channel: EMAIL_VERIFY_CHALLENGE_CHANNEL,
      consumedAt: null,
      expiresAt: {
        gt: input.now,
      },
    },
    data: {
      consumedAt: input.now,
    },
  });
}

async function createEmailVerificationChallenge(input: {
  readonly transactionClient: InternalUserTransactionClient;
  readonly webAccountId: string;
  readonly email: string;
  readonly expiresAt: Date;
  readonly challengeSecret: EmailVerificationChallengeSecret;
}): Promise<AuthChallenge> {
  return input.transactionClient.authChallenge.create({
    data: {
      webAccountId: input.webAccountId,
      purpose: EMAIL_VERIFY_CHALLENGE_PURPOSE,
      channel: EMAIL_VERIFY_CHALLENGE_CHANNEL,
      destination: input.email,
      codeHash: input.challengeSecret.codeHash,
      tokenHash: input.challengeSecret.tokenHash,
      expiresAt: input.expiresAt,
      attemptsLeft: EMAIL_VERIFY_CHALLENGE_ATTEMPTS,
    },
  });
}

async function getLatestActiveEmailVerificationCodeChallenge(input: {
  readonly transactionClient: InternalUserTransactionClient;
  readonly webAccountId: string;
  readonly destination: string;
  readonly now: Date;
}): Promise<AuthChallenge | null> {
  return input.transactionClient.authChallenge.findFirst({
    where: {
      webAccountId: input.webAccountId,
      destination: input.destination,
      purpose: EMAIL_VERIFY_CHALLENGE_PURPOSE,
      channel: EMAIL_VERIFY_CHALLENGE_CHANNEL,
      consumedAt: null,
      expiresAt: {
        gt: input.now,
      },
      attemptsLeft: {
        gt: 0,
      },
      codeHash: {
        not: null,
      },
    },
    orderBy: [{ createdAt: 'desc' }],
  });
}

async function decrementEmailVerificationChallengeAttempts(input: {
  readonly transactionClient: InternalUserTransactionClient;
  readonly challenge: AuthChallenge;
  readonly now: Date;
}): Promise<void> {
  const attemptsLeft = Math.max(input.challenge.attemptsLeft - 1, 0);
  await input.transactionClient.authChallenge.update({
    where: {
      id: input.challenge.id,
    },
    data: {
      attemptsLeft,
      consumedAt: attemptsLeft === 0 ? input.now : null,
    },
  });
}

async function revokeIssuedEmailVerificationChallenge(input: {
  readonly prismaService: PrismaService;
  readonly challengeId: string;
  readonly revokedAt: Date;
}): Promise<void> {
  await input.prismaService.authChallenge.updateMany({
    where: {
      id: input.challengeId,
      consumedAt: null,
    },
    data: {
      consumedAt: input.revokedAt,
    },
  });
}

function attachRevokeFailureContext(primaryError: unknown, revokeError: unknown): unknown {
  if (primaryError instanceof Error) {
    const errorWithContext = primaryError as Error & {
      revokeError?: unknown;
      suppressedErrors?: readonly unknown[];
    };
    errorWithContext.revokeError = revokeError;
    errorWithContext.suppressedErrors = [...(errorWithContext.suppressedErrors ?? []), revokeError];
    return errorWithContext;
  }
  return primaryError;
}

function shouldRevokeIssuedChallengeAfterDeliveryFailure(error: unknown): boolean {
  return error instanceof EmailDeliveryException && error.deliveryState === 'definitely-not-delivered';
}

function isWebAccountLoginConflictError(error: unknown): boolean {
  if (!(error instanceof PrismaClientKnownRequestError)) {
    return false;
  }
  if (error.code !== 'P2002') {
    return false;
  }
  const target = error.meta?.target;
  return Array.isArray(target) && target.includes('loginNormalized');
}

function mapInternalUserSession(
  user: InternalUserRecord,
): InternalUserSessionInterface {
  return {
    id: user.id,
    telegramId: user.telegramId?.toString() ?? null,
    username: user.username,
    name: user.name,
    email: user.email,
    role: user.role,
    language: user.language,
    personalDiscount: user.personalDiscount,
    purchaseDiscount: user.purchaseDiscount,
    points: user.points,
    maxSubscriptions: user.maxSubscriptions,
    isBlocked: user.isBlocked,
    isBotBlocked: user.isBotBlocked,
    isRulesAccepted: user.isRulesAccepted,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    webAccount: user.webAccount === null ? null : {
      id: user.webAccount.id,
      login: user.webAccount.login,
      loginNormalized: user.webAccount.loginNormalized,
      email: user.webAccount.email,
      emailNormalized: user.webAccount.emailNormalized,
      emailVerifiedAt: mapDateValue(user.webAccount.emailVerifiedAt),
      requiresPasswordChange: user.webAccount.requiresPasswordChange,
      linkPromptSnoozeUntil: mapDateValue(user.webAccount.linkPromptSnoozeUntil),
      credentialsBootstrappedAt: mapDateValue(user.webAccount.credentialsBootstrappedAt),
      createdAt: user.webAccount.createdAt.toISOString(),
      updatedAt: user.webAccount.updatedAt.toISOString(),
    },
  };
}

function mapInternalEmailVerificationChallenge(
  input: MapInternalEmailVerificationChallengeInput,
): InternalWebAccountEmailVerificationChallengeInterface {
  return {
    webAccountId: input.webAccount.id,
    email: input.email,
    challengeExpiresAt: input.challenge.expiresAt.toISOString(),
  };
}

function mapDateValue(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function selectCurrentSubscription(
  subscriptions: readonly Subscription[],
): Subscription | null {
  if (subscriptions.length === 0) {
    return null;
  }
  const now = new Date();
  const rankedSubscriptions = subscriptions
    .map((subscription) => ({
      subscription,
      rank: getSubscriptionRank(subscription, now),
    }))
    .sort((left, right) => {
      if (left.rank !== right.rank) {
        return left.rank - right.rank;
      }
      return right.subscription.createdAt.getTime() - left.subscription.createdAt.getTime();
    });
  return rankedSubscriptions[0]?.subscription ?? null;
}

function getSubscriptionRank(subscription: Subscription, now: Date): number {
  if (isCurrentSubscription(subscription, now)) {
    return 0;
  }
  if (isUpcomingSubscription(subscription, now)) {
    return 1;
  }
  if (hasFutureExpiry(subscription, now)) {
    return 2;
  }
  return 3;
}

function isCurrentSubscription(subscription: Subscription, now: Date): boolean {
  const isEnabledStatus =
    subscription.status === SubscriptionStatus.ACTIVE ||
    subscription.status === SubscriptionStatus.LIMITED;
  if (!isEnabledStatus) {
    return false;
  }
  if (subscription.startedAt !== null && subscription.startedAt.getTime() > now.getTime()) {
    return false;
  }
  return !isExpiredSubscription(subscription, now);
}

function isUpcomingSubscription(subscription: Subscription, now: Date): boolean {
  if (subscription.startedAt === null) {
    return false;
  }
  return subscription.startedAt.getTime() > now.getTime() && !isExpiredSubscription(subscription, now);
}

function hasFutureExpiry(subscription: Subscription, now: Date): boolean {
  if (subscription.expiresAt === null) {
    return false;
  }
  return subscription.expiresAt.getTime() > now.getTime();
}

function isExpiredSubscription(subscription: Subscription, now: Date): boolean {
  if (subscription.expiresAt === null) {
    return false;
  }
  return subscription.expiresAt.getTime() <= now.getTime();
}

function mapSubscriptionPlanSnapshot(
  planSnapshot: Prisma.JsonValue,
): { readonly name: string | null; readonly type: PlanType | null } | null {
  if (!isJsonObject(planSnapshot)) {
    return null;
  }
  return {
    name: readOptionalString(planSnapshot, 'name'),
    type: readOptionalPlanType(planSnapshot, 'type'),
  };
}

function isJsonObject(value: Prisma.JsonValue): value is Prisma.JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalString(
  value: Prisma.JsonObject,
  propertyName: string,
): string | null {
  const propertyValue = value[propertyName];
  return typeof propertyValue === 'string' ? propertyValue : null;
}

function readOptionalPlanType(
  value: Prisma.JsonObject,
  propertyName: string,
): PlanType | null {
  const propertyValue = value[propertyName];
  if (typeof propertyValue !== 'string') {
    return null;
  }
  return isPlanType(propertyValue) ? propertyValue : null;
}

function isPlanType(value: string): value is PlanType {
  return Object.values(PlanType).includes(value as PlanType);
}
