import { createHash, randomBytes, randomInt } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';
import { AuthChallenge, Prisma, WebAccount } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { EmailDeliveryException } from '../../email/errors/email-delivery.exception';

import { InternalUserRecord } from './internal-user.mappers';

// ── Constants ──────────────────────────────────────────────────────────────

export const EMAIL_VERIFY_CHALLENGE_PURPOSE = 'email_verify';
export const EMAIL_VERIFY_CHALLENGE_CHANNEL = 'email';
export const EMAIL_VERIFY_CHALLENGE_TTL_MINUTES: number = 15;
export const EMAIL_VERIFY_CHALLENGE_ATTEMPTS: number = 5;
export const EMAIL_VERIFY_CODE_LENGTH: number = 6;
export const EMAIL_VERIFY_TOKEN_BYTES: number = 32;

export interface EmailVerificationChallengeSecret {
  readonly code: string;
  readonly codeHash: string;
  readonly tokenHash: string;
}

/**
 * Slim shape of the Prisma transaction client used by the helpers below.
 * Avoids importing the giant `Prisma.TransactionClient` type just so we
 * can keep this file independent.
 */
export interface InternalUserTransactionClient {
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

// ── Web-account state guards ───────────────────────────────────────────────

export const WEB_ACCOUNT_LINK_PROMPT_SNOOZE_DAYS: number = 7;

export function createWebAccountLinkPromptSnoozeDate(now: Date = new Date(Date.now())): Date {
  const snoozeUntil = new Date(now);
  snoozeUntil.setUTCDate(snoozeUntil.getUTCDate() + WEB_ACCOUNT_LINK_PROMPT_SNOOZE_DAYS);
  return snoozeUntil;
}

export function isWebAccountLinkPromptActionable(webAccount: WebAccount): boolean {
  return (
    webAccount.requiresPasswordChange ||
    webAccount.credentialsBootstrappedAt === null ||
    webAccount.loginNormalized === null
  );
}

export function hasSnoozedLinkPromptUntilOrBeyond(
  webAccount: WebAccount,
  snoozeUntil: Date,
): boolean {
  if (webAccount.linkPromptSnoozeUntil === null) {
    return false;
  }
  return webAccount.linkPromptSnoozeUntil.getTime() >= snoozeUntil.getTime();
}

export function getRequiredActionableWebAccount(user: InternalUserRecord): WebAccount {
  if (user.webAccount === null) {
    throw new BadRequestException('webAccount must exist');
  }
  if (!isWebAccountLinkPromptActionable(user.webAccount)) {
    throw new BadRequestException('webAccount link prompt is not actionable');
  }
  return user.webAccount;
}

export function getRequiredEmailVerificationWebAccount(user: InternalUserRecord): WebAccount {
  if (user.webAccount === null) {
    throw new BadRequestException('webAccount must exist');
  }
  if (user.webAccount.emailVerifiedAt !== null) {
    throw new BadRequestException('webAccount email is already verified');
  }
  return user.webAccount;
}

export function getRequiredWebAccountEmail(webAccount: WebAccount): string {
  const email = webAccount.email ?? webAccount.emailNormalized;
  if (email === null) {
    throw new BadRequestException('webAccount email must exist');
  }
  return email;
}

// ── Challenge factory + persistence ────────────────────────────────────────

export function createEmailVerificationChallengeExpiry(now: Date): Date {
  const expiresAt = new Date(now);
  expiresAt.setUTCMinutes(expiresAt.getUTCMinutes() + EMAIL_VERIFY_CHALLENGE_TTL_MINUTES);
  return expiresAt;
}

export function createEmailVerificationChallengeSecret(): EmailVerificationChallengeSecret {
  const code = createNumericChallengeCode();
  const token = randomBytes(EMAIL_VERIFY_TOKEN_BYTES).toString('base64url');
  return {
    code,
    codeHash: createChallengeHash(code),
    tokenHash: createChallengeHash(token),
  };
}

export function createNumericChallengeCode(): string {
  const minimumValue = 10 ** (EMAIL_VERIFY_CODE_LENGTH - 1);
  const maximumValue = 10 ** EMAIL_VERIFY_CODE_LENGTH;
  const value = randomInt(minimumValue, maximumValue);
  return value.toString();
}

export function createChallengeHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function lockWebAccountRow(
  transactionClient: InternalUserTransactionClient,
  webAccountId: string,
): Promise<void> {
  await transactionClient.$queryRaw(
    Prisma.sql`SELECT id FROM "web_accounts" WHERE id = ${webAccountId} FOR UPDATE`,
  );
}

export async function revokePendingEmailVerificationChallenges(input: {
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

export async function createEmailVerificationChallenge(input: {
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

export async function getLatestActiveEmailVerificationCodeChallenge(input: {
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

export async function decrementEmailVerificationChallengeAttempts(input: {
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

export async function revokeIssuedEmailVerificationChallenge(input: {
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

// ── Error helpers ──────────────────────────────────────────────────────────

export function attachRevokeFailureContext(primaryError: unknown, _revokeError: unknown): unknown {
  if (primaryError instanceof Error) {
    const sanitizedRevokeFailure = 'ISSUED_CHALLENGE_REVOKE_FAILED';
    const errorWithContext = primaryError as Error & {
      revokeError?: unknown;
      suppressedErrors?: readonly unknown[];
    };
    errorWithContext.revokeError = sanitizedRevokeFailure;
    errorWithContext.suppressedErrors = [
      ...(errorWithContext.suppressedErrors ?? []),
      sanitizedRevokeFailure,
    ];
    return errorWithContext;
  }
  return primaryError;
}

export function shouldRevokeIssuedChallengeAfterDeliveryFailure(error: unknown): boolean {
  return error instanceof EmailDeliveryException && error.deliveryState === 'definitely-not-delivered';
}

export function isWebAccountLoginConflictError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }
  if (error.code !== 'P2002') {
    return false;
  }
  const target = error.meta?.target;
  return Array.isArray(target) && target.includes('loginNormalized');
}
