/**
 * Property 12: Expired Verification Code Rejection
 *
 * *For any* verification code, attempting to use it after 30 minutes SHALL fail
 * with an expiration error.
 *
 * **Validates: Requirements 5.3**
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { EmailVerificationService } from '../src/modules/linking/email-verification.service';

// ── Mock factories ───────────────────────────────────────────────────────────

function createMockCache() {
  return {
    get: async () => null,
    set: async () => {},
    del: async () => {},
  } as any;
}

/**
 * Creates a mock Prisma instance that returns a challenge with the given expiresAt.
 * The challenge has a valid code and is non-consumed with 0 attempts.
 */
function createMockPrisma(options: {
  expiresAt: Date;
  code: string;
  webAccountUserId?: bigint;
}) {
  const { expiresAt, code, webAccountUserId = BigInt(12345) } = options;

  const challenge = {
    uuid: 'challenge-expired-1',
    type: 'email_verify',
    userId: webAccountUserId,
    code,
    attempts: 0,
    consumed: false,
    expiresAt,
    createdAt: new Date(expiresAt.getTime() - 30 * 60 * 1000),
  };

  return {
    webAccount: {
      findUnique: async () => ({
        uuid: 'test-uuid-1234',
        userId: webAccountUserId,
      }),
    },
    authChallenge: {
      findFirst: async () => challenge,
      update: async (args: any) => {
        if (args.data.attempts?.increment) {
          challenge.attempts += args.data.attempts.increment;
        }
        if (args.data.consumed !== undefined) {
          challenge.consumed = args.data.consumed;
        }
        return challenge;
      },
    },
  } as any;
}

// ── Arbitraries ──────────────────────────────────────────────────────────────

/** Generates a valid 6-digit verification code string (000000–999999). */
const validCodeArb = fc
  .integer({ min: 0, max: 999999 })
  .map((n) => n.toString().padStart(6, '0'));

/**
 * Generates a duration in milliseconds representing time past expiration.
 * Range: 1ms to 365 days past the 30-minute TTL.
 */
const pastExpirationOffsetArb = fc.integer({ min: 1, max: 365 * 24 * 60 * 60 * 1000 });

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Property 12: Expired Verification Code Rejection', () => {
  it('for any valid code, verification fails with expiration message when challenge.expiresAt is in the past', async () => {
    await fc.assert(
      fc.asyncProperty(validCodeArb, pastExpirationOffsetArb, async (code, pastOffset) => {
        // Set expiresAt to some time in the past (expired)
        const expiresAt = new Date(Date.now() - pastOffset);

        const prisma = createMockPrisma({ expiresAt, code });
        const service = new EmailVerificationService(prisma, createMockCache(), null as any);

        const result = await service.verifyEmailCode({
          userId: 'test-uuid-1234',
          code, // Even the correct code should fail
        });

        // Verification must fail
        assert.equal(
          result.success,
          false,
          `Expected verification to fail for expired challenge (expired ${pastOffset}ms ago), but got success=true`,
        );

        assert.equal(
          result.verified,
          false,
          `Expected verified=false for expired challenge, but got verified=true`,
        );

        // Must contain an expiration-related message
        assert.ok(
          result.message?.toLowerCase().includes('expired'),
          `Expected expiration error message, got: "${result.message}"`,
        );
      }),
      { numRuns: 200 },
    );
  });

  it('for any valid code, verification fails when expiresAt is exactly now (boundary: past threshold)', async () => {
    await fc.assert(
      fc.asyncProperty(validCodeArb, async (code) => {
        // expiresAt is 1ms in the past — just barely expired
        const expiresAt = new Date(Date.now() - 1);

        const prisma = createMockPrisma({ expiresAt, code });
        const service = new EmailVerificationService(prisma, createMockCache(), null as any);

        const result = await service.verifyEmailCode({
          userId: 'test-uuid-1234',
          code,
        });

        assert.equal(
          result.success,
          false,
          'Expected verification to fail when challenge just expired (1ms ago)',
        );

        assert.equal(result.verified, false);

        assert.ok(
          result.message?.toLowerCase().includes('expired'),
          `Expected expiration error message, got: "${result.message}"`,
        );
      }),
      { numRuns: 100 },
    );
  });

  it('for any valid code, expired challenges never mark the email as verified', async () => {
    await fc.assert(
      fc.asyncProperty(validCodeArb, pastExpirationOffsetArb, async (code, pastOffset) => {
        const expiresAt = new Date(Date.now() - pastOffset);

        // Track if webAccount.update was called (it should NOT be for expired challenges)
        let webAccountUpdated = false;
        const prisma = createMockPrisma({ expiresAt, code });
        prisma.webAccount.update = async () => {
          webAccountUpdated = true;
          return {};
        };

        const service = new EmailVerificationService(prisma, createMockCache(), null as any);

        await service.verifyEmailCode({
          userId: 'test-uuid-1234',
          code,
        });

        assert.equal(
          webAccountUpdated,
          false,
          'WebAccount should NOT be updated when challenge is expired',
        );
      }),
      { numRuns: 200 },
    );
  });
});
