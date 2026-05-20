/**
 * Property 4: Duplicate Username Immediate Check
 *
 * *For any* username that already exists in the system, the system SHALL immediately
 * check username availability (even if other form fields are invalid) and fail with
 * a ConflictException indicating the username is taken.
 *
 * **Validates: Requirements 1.2**
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConflictException } from '@nestjs/common';
import fc from 'fast-check';

import { WebAuthService } from '../src/modules/web-auth/web-auth.service';

// --- Generators ---

/**
 * Generates valid usernames matching ^[a-zA-Z0-9_-]{3,32}$
 */
const validUsernameArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'.split('')),
  { minLength: 3, maxLength: 32 },
);

/**
 * Generates valid SHA-256 hex strings (64 lowercase hex chars)
 */
const validSha256Arb = fc.stringOf(
  fc.constantFrom(...'0123456789abcdef'.split('')),
  { minLength: 64, maxLength: 64 },
);

// --- Mock Prisma builder ---

/**
 * Builds a mock PrismaService where webAccount.findUnique returns an existing record
 * (simulating a taken username) and webRegistrationSetting.findFirst returns enabled.
 */
function buildMockPrismaWithExistingUsername(username: string) {
  return {
    webRegistrationSetting: {
      findFirst: async () => ({ id: 1, enabled: true }),
    },
    webAccount: {
      findUnique: async (args: any) => {
        // Return an existing record when queried by username
        if (args?.where?.username === username) {
          return {
            uuid: 'existing-uuid-' + username,
            userId: BigInt(12345),
            username,
            passwordHash: '$2a$12$fakehashvalue',
            requiresPasswordChange: false,
            email: null,
            emailVerified: false,
            telegramId: null,
            telegramUsername: null,
          };
        }
        return null;
      },
    },
    $transaction: async (_fn: (tx: any) => Promise<any>) => {
      // Should never reach transaction if username is taken
      throw new Error('Transaction should not be called when username is taken');
    },
  };
}

describe('Property 4: Duplicate Username Immediate Check', () => {
  it('for any valid username that already exists, register() throws ConflictException immediately', async () => {
    await fc.assert(
      fc.asyncProperty(validUsernameArb, validSha256Arb, async (username, passwordHash) => {
        const mockPrisma = buildMockPrismaWithExistingUsername(username);
        const service = new WebAuthService(mockPrisma as any);

        // Attempting to register with an existing username must throw ConflictException
        await assert.rejects(
          () => service.register({ username, passwordHash }),
          (err: any) => {
            assert.ok(err instanceof ConflictException, `Expected ConflictException, got ${err.constructor.name}`);
            return true;
          },
        );
      }),
      { numRuns: 100 },
    );
  });

  it('the error message for duplicate username is generic and does not vary by username', async () => {
    await fc.assert(
      fc.asyncProperty(validUsernameArb, validUsernameArb, validSha256Arb, async (username1, username2, passwordHash) => {
        // Both usernames are "taken" — the error message must be identical
        const mockPrisma1 = buildMockPrismaWithExistingUsername(username1);
        const mockPrisma2 = buildMockPrismaWithExistingUsername(username2);

        const service1 = new WebAuthService(mockPrisma1 as any);
        const service2 = new WebAuthService(mockPrisma2 as any);

        let message1: string | undefined;
        let message2: string | undefined;

        try {
          await service1.register({ username: username1, passwordHash });
        } catch (err: any) {
          message1 = err.message;
        }

        try {
          await service2.register({ username: username2, passwordHash });
        } catch (err: any) {
          message2 = err.message;
        }

        assert.ok(message1, 'Expected error for username1');
        assert.ok(message2, 'Expected error for username2');
        assert.equal(
          message1,
          message2,
          `Error messages must be identical regardless of username. Got "${message1}" vs "${message2}"`,
        );
      }),
      { numRuns: 50 },
    );
  });

  it('the duplicate check happens before the transaction (no User/WebAccount creation attempted)', async () => {
    await fc.assert(
      fc.asyncProperty(validUsernameArb, validSha256Arb, async (username, passwordHash) => {
        let transactionCalled = false;

        const mockPrisma = {
          webRegistrationSetting: {
            findFirst: async () => ({ id: 1, enabled: true }),
          },
          webAccount: {
            findUnique: async () => ({
              uuid: 'existing-uuid',
              userId: BigInt(12345),
              username,
              passwordHash: '$2a$12$fakehashvalue',
            }),
          },
          $transaction: async () => {
            transactionCalled = true;
            throw new Error('Transaction should not be reached');
          },
        };

        const service = new WebAuthService(mockPrisma as any);

        try {
          await service.register({ username, passwordHash });
        } catch {
          // Expected to throw
        }

        assert.equal(
          transactionCalled,
          false,
          'Transaction must NOT be called when username already exists',
        );
      }),
      { numRuns: 100 },
    );
  });
});
