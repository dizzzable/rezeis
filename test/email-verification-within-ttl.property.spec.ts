/**
 * Property 11: Email Verification Within TTL
 *
 * *For any* valid verification code entered within 30 minutes of generation,
 * the email SHALL be marked as verified on the Web_Account. When an incorrect
 * verification code is entered, the system SHALL explicitly prevent email
 * verification from completing.
 *
 * **Validates: Requirements 5.2**
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { EmailVerificationService } from '../src/modules/linking/email-verification.service';

// ── Arbitraries ──────────────────────────────────────────────────────────────

/** Generate a valid 6-digit verification code (000000–999999). */
const arbVerificationCode = fc
  .integer({ min: 0, max: 999999 })
  .map((n) => n.toString().padStart(6, '0'));

/** Generate a future expiresAt within TTL (1 second to 30 minutes from now). */
const arbFutureExpiresAt = fc
  .integer({ min: 1_000, max: 30 * 60 * 1000 })
  .map((ms) => new Date(Date.now() + ms));

/** Generate a valid user UUID. */
const arbUserId = fc.uuid();

/** Generate a normalized email address. */
const arbEmail = fc
  .tuple(
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
      minLength: 1,
      maxLength: 10,
    }),
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), {
      minLength: 2,
      maxLength: 8,
    }),
  )
  .map(([local, domain]) => `${local}@${domain}.com`);

// ── Mock Factories ───────────────────────────────────────────────────────────

function createMockCache(_pendingEmail?: string, _pendingCode?: string) {
  const store: Record<string, { value: any; ttl?: number }> = {};

  return {
    get: async <T>(key: string): Promise<T | null> => {
      const entry = store[key];
      return entry ? (entry.value as T) : null;
    },
    set: async (key: string, value: unknown, ttlSeconds?: number): Promise<void> => {
      store[key] = { value, ttl: ttlSeconds };
    },
    del: async (key: string): Promise<void> => {
      delete store[key];
    },
    _store: store,
    _preload(userId: string, email: string, code: string) {
      store[`email_verify_pending:${userId}`] = {
        value: { email, code },
      };
    },
  } as any;
}

function createMockPrisma(options: {
  userId: string;
  webAccountUserId?: bigint;
  challenge: {
    uuid: string;
    code: string;
    attempts: number;
    consumed: boolean;
    expiresAt: Date;
  };
}) {
  const { userId, webAccountUserId = BigInt(12345), challenge } = options;

  const updatedWebAccounts: any[] = [];
  const updatedChallenges: any[] = [];

  const challengeRecord = {
    uuid: challenge.uuid,
    type: 'email_verify',
    userId: webAccountUserId,
    code: challenge.code,
    attempts: challenge.attempts,
    consumed: challenge.consumed,
    expiresAt: challenge.expiresAt,
    createdAt: new Date(challenge.expiresAt.getTime() - 30 * 60 * 1000),
  };

  return {
    webAccount: {
      findUnique: async (args: any) => {
        if (args.where?.uuid === userId) {
          return { uuid: userId, userId: webAccountUserId };
        }
        return null;
      },
      findFirst: async () => null,
      update: async (args: any) => {
        updatedWebAccounts.push(args);
        return { uuid: userId, ...args.data };
      },
    },
    authChallenge: {
      findFirst: async (args: any) => {
        if (
          args.where.userId === webAccountUserId &&
          args.where.type === 'email_verify' &&
          args.where.consumed === false &&
          !challengeRecord.consumed
        ) {
          return { ...challengeRecord };
        }
        return null;
      },
      update: async (args: any) => {
        if (args.where.uuid === challengeRecord.uuid) {
          if (args.data.attempts?.increment) {
            challengeRecord.attempts += args.data.attempts.increment;
          }
          if (args.data.consumed !== undefined) {
            challengeRecord.consumed = args.data.consumed;
          }
          updatedChallenges.push(args);
          return { ...challengeRecord };
        }
        return null;
      },
    },
    _updatedWebAccounts: updatedWebAccounts,
    _updatedChallenges: updatedChallenges,
    _challengeRecord: challengeRecord,
  } as any;
}

function createService(prisma: any, cache: any): EmailVerificationService {
  return new EmailVerificationService(
    prisma,
    cache,
    null as any, // emailService — not needed for verification
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Property 11: Email Verification Within TTL', () => {
  it('for any valid code entered within TTL, email SHALL be marked as verified on the WebAccount', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbVerificationCode,
        arbFutureExpiresAt,
        arbUserId,
        arbEmail,
        async (code, expiresAt, userId, email) => {
          const prisma = createMockPrisma({
            userId,
            challenge: {
              uuid: 'challenge-uuid-1',
              code,
              attempts: 0,
              consumed: false,
              expiresAt,
            },
          });

          const cache = createMockCache();
          cache._preload(userId, email, code);

          const service = createService(prisma, cache);

          const result = await service.verifyEmailCode({ userId, code });

          // Verification must succeed
          assert.equal(
            result.success,
            true,
            `Expected success=true for valid code within TTL, got: ${JSON.stringify(result)}`,
          );
          assert.equal(
            result.verified,
            true,
            `Expected verified=true for valid code within TTL, got: ${JSON.stringify(result)}`,
          );

          // WebAccount must be updated with email verified
          assert.equal(
            prisma._updatedWebAccounts.length,
            1,
            'Expected exactly one WebAccount update',
          );
          assert.equal(
            prisma._updatedWebAccounts[0].data.emailVerified,
            true,
            'Expected emailVerified to be set to true',
          );
          assert.equal(
            prisma._updatedWebAccounts[0].data.email,
            email,
            'Expected email to be set on WebAccount',
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it('for any incorrect code entered within TTL, email verification SHALL be explicitly prevented', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbVerificationCode,
        arbFutureExpiresAt,
        arbUserId,
        arbEmail,
        async (correctCode, expiresAt, userId, email) => {
          // Generate a code that differs from the correct one
          const wrongCode =
            correctCode === '000000'
              ? '000001'
              : (parseInt(correctCode, 10) - 1).toString().padStart(6, '0');

          const prisma = createMockPrisma({
            userId,
            challenge: {
              uuid: 'challenge-uuid-1',
              code: correctCode,
              attempts: 0,
              consumed: false,
              expiresAt,
            },
          });

          const cache = createMockCache();
          cache._preload(userId, email, correctCode);

          const service = createService(prisma, cache);

          const result = await service.verifyEmailCode({ userId, code: wrongCode });

          // Verification must fail
          assert.equal(
            result.success,
            false,
            `Expected success=false for incorrect code, got: ${JSON.stringify(result)}`,
          );
          assert.equal(
            result.verified,
            false,
            `Expected verified=false for incorrect code, got: ${JSON.stringify(result)}`,
          );

          // WebAccount must NOT be updated (email not verified)
          assert.equal(
            prisma._updatedWebAccounts.length,
            0,
            'Expected no WebAccount update when incorrect code is provided',
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it('for any valid code with prior attempts (< 5) within TTL, verification still succeeds', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbVerificationCode,
        arbFutureExpiresAt,
        arbUserId,
        arbEmail,
        fc.integer({ min: 1, max: 4 }), // prior attempts (1-4)
        async (code, expiresAt, userId, email, priorAttempts) => {
          const prisma = createMockPrisma({
            userId,
            challenge: {
              uuid: 'challenge-uuid-1',
              code,
              attempts: priorAttempts,
              consumed: false,
              expiresAt,
            },
          });

          const cache = createMockCache();
          cache._preload(userId, email, code);

          const service = createService(prisma, cache);

          const result = await service.verifyEmailCode({ userId, code });

          // Verification must succeed even with prior failed attempts
          assert.equal(
            result.success,
            true,
            `Expected success=true for valid code with ${priorAttempts} prior attempts, got: ${JSON.stringify(result)}`,
          );
          assert.equal(
            result.verified,
            true,
            `Expected verified=true for valid code with ${priorAttempts} prior attempts, got: ${JSON.stringify(result)}`,
          );

          // WebAccount must be updated
          assert.equal(
            prisma._updatedWebAccounts.length,
            1,
            'Expected WebAccount to be updated with verified email',
          );
          assert.equal(prisma._updatedWebAccounts[0].data.emailVerified, true);
        },
      ),
      { numRuns: 100 },
    );
  });
});
