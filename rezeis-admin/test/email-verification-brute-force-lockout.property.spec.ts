/**
 * Property 13: Verification Brute-Force Lockout
 *
 * *For any* Auth_Challenge, the challenge SHALL be invalidated if and only if
 * incorrect code attempts reach exactly 5. No other system configuration SHALL
 * trigger invalidation before reaching 5 attempts — even if the correct code
 * is subsequently provided after 5 failures.
 *
 * **Validates: Requirements 5.4**
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { EmailVerificationService } from '../src/modules/linking/email-verification.service';

// ── Mock factories ───────────────────────────────────────────────────────────

function createMockCache(pendingEmail?: { email: string; code: string }) {
  const store: Record<string, { value: any; ttl?: number }> = {};
  if (pendingEmail) {
    store['email_verify_pending:test-uuid'] = { value: pendingEmail };
  }
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
    exists: async (key: string): Promise<boolean> => key in store,
  } as any;
}

function createMockPrisma(options: {
  challengeAttempts: number;
  challengeCode: string;
  challengeConsumed?: boolean;
}) {
  const { challengeAttempts, challengeCode, challengeConsumed = false } = options;

  const challenge = {
    uuid: 'challenge-uuid-1',
    type: 'email_verify',
    userId: BigInt(12345),
    code: challengeCode,
    attempts: challengeAttempts,
    consumed: challengeConsumed,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 min from now
    createdAt: new Date(),
  };

  const updatedWebAccounts: any[] = [];

  return {
    webAccount: {
      findUnique: async (_args: any) => {
        return { uuid: 'test-uuid', userId: BigInt(12345) };
      },
      findFirst: async (_args: any) => null,
      update: async (args: any) => {
        updatedWebAccounts.push(args);
        return { uuid: 'test-uuid', ...args.data };
      },
    },
    authChallenge: {
      findFirst: async (_args: any) => {
        if (challenge.consumed) return null;
        return { ...challenge };
      },
      update: async (args: any) => {
        if (args.data.attempts?.increment) {
          challenge.attempts += args.data.attempts.increment;
        }
        if (args.data.consumed !== undefined) {
          challenge.consumed = args.data.consumed;
        }
        return { ...challenge };
      },
    },
    _challenge: challenge,
    _updatedWebAccounts: updatedWebAccounts,
  } as any;
}

function createService(prisma: any, cache?: any): EmailVerificationService {
  return new EmailVerificationService(
    prisma,
    cache ?? createMockCache(),
    null as any, // emailService — not needed for verification
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Property 13: Verification Brute-Force Lockout', () => {
  it('for any challenge with attempts >= 5, verification fails with "Too many incorrect attempts"', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate attempts count >= 5 (already locked out)
        fc.integer({ min: 5, max: 100 }),
        // Generate any 6-digit code (even the correct one)
        fc.stringMatching(/^\d{6}$/),
        async (attempts, submittedCode) => {
          const correctCode = '123456';
          const prisma = createMockPrisma({
            challengeAttempts: attempts,
            challengeCode: correctCode,
          });
          const service = createService(prisma);

          const result = await service.verifyEmailCode({
            userId: 'test-uuid',
            code: submittedCode,
          });

          // Must fail regardless of whether the submitted code is correct
          assert.equal(
            result.success,
            false,
            `Expected failure for attempts=${attempts}, code="${submittedCode}"`,
          );
          assert.equal(
            result.verified,
            false,
            `Expected verified=false for attempts=${attempts}`,
          );
          assert.ok(
            result.message?.includes('Too many incorrect attempts'),
            `Expected "Too many incorrect attempts" message, got: "${result.message}"`,
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it('for any challenge with attempts < 5 and correct code, verification succeeds', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate attempts count < 5 (not yet locked out)
        fc.integer({ min: 0, max: 4 }),
        // Generate a valid 6-digit code to use as both the challenge code and submitted code
        fc.stringMatching(/^\d{6}$/),
        async (attempts, code) => {
          const prisma = createMockPrisma({
            challengeAttempts: attempts,
            challengeCode: code,
          });
          const cache = createMockCache({ email: 'user@example.com', code });
          const service = createService(prisma, cache);

          const result = await service.verifyEmailCode({
            userId: 'test-uuid',
            code,
          });

          // Must succeed when attempts < 5 and code is correct
          assert.equal(
            result.success,
            true,
            `Expected success for attempts=${attempts}, code="${code}"`,
          );
          assert.equal(
            result.verified,
            true,
            `Expected verified=true for attempts=${attempts}`,
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it('for any challenge with attempts < 5 and incorrect code, verification fails but does NOT invalidate until reaching 5', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate attempts count < 4 (so after one more wrong attempt, still < 5)
        fc.integer({ min: 0, max: 3 }),
        // Generate two different 6-digit codes (correct vs submitted)
        fc.stringMatching(/^\d{6}$/).filter((c) => c !== '000000'),
        async (attempts, correctCode) => {
          const wrongCode = '000000'; // guaranteed different from correctCode
          const prisma = createMockPrisma({
            challengeAttempts: attempts,
            challengeCode: correctCode,
          });
          const service = createService(prisma);

          const result = await service.verifyEmailCode({
            userId: 'test-uuid',
            code: wrongCode,
          });

          // Must fail (wrong code)
          assert.equal(result.success, false);
          assert.equal(result.verified, false);

          // Challenge should NOT be invalidated (consumed) since attempts < 5
          assert.equal(
            prisma._challenge.consumed,
            false,
            `Challenge should NOT be consumed at ${attempts + 1} attempts (< 5)`,
          );

          // Attempts should have been incremented by 1
          assert.equal(
            prisma._challenge.attempts,
            attempts + 1,
            `Expected attempts to be ${attempts + 1}, got ${prisma._challenge.attempts}`,
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it('challenge is invalidated at exactly 5 incorrect attempts (the 5th wrong attempt triggers lockout)', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate a valid 6-digit code for the challenge
        fc.stringMatching(/^\d{6}$/).filter((c) => c !== '000000'),
        async (correctCode) => {
          const wrongCode = '000000'; // guaranteed different
          // Start at 4 attempts — the next wrong attempt will be the 5th
          const prisma = createMockPrisma({
            challengeAttempts: 4,
            challengeCode: correctCode,
          });
          const service = createService(prisma);

          const result = await service.verifyEmailCode({
            userId: 'test-uuid',
            code: wrongCode,
          });

          // Must fail
          assert.equal(result.success, false);
          assert.equal(result.verified, false);

          // Challenge MUST be invalidated (consumed) at exactly 5 attempts
          assert.equal(
            prisma._challenge.consumed,
            true,
            'Challenge must be consumed (invalidated) at exactly 5 attempts',
          );
          assert.equal(
            prisma._challenge.attempts,
            5,
            `Expected attempts to be exactly 5, got ${prisma._challenge.attempts}`,
          );

          // Message must indicate lockout
          assert.ok(
            result.message?.includes('Too many incorrect attempts'),
            `Expected lockout message, got: "${result.message}"`,
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it('even the correct code is rejected after 5 failed attempts', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate a valid 6-digit code
        fc.stringMatching(/^\d{6}$/),
        // Generate attempts >= 5
        fc.integer({ min: 5, max: 50 }),
        async (code, attempts) => {
          const prisma = createMockPrisma({
            challengeAttempts: attempts,
            challengeCode: code,
          });
          const cache = createMockCache({ email: 'user@example.com', code });
          const service = createService(prisma, cache);

          // Submit the CORRECT code after lockout
          const result = await service.verifyEmailCode({
            userId: 'test-uuid',
            code,
          });

          // Must still fail — lockout is permanent for this challenge
          assert.equal(
            result.success,
            false,
            `Correct code must be rejected after ${attempts} failed attempts`,
          );
          assert.equal(result.verified, false);
          assert.ok(
            result.message?.includes('Too many incorrect attempts'),
            `Expected lockout message even with correct code, got: "${result.message}"`,
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
