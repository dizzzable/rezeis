/**
 * Property 5: Sign-In Correctness
 *
 * *For any* credentials submitted to the sign-in endpoint, the system SHALL return
 * a valid session if and only if the username exists AND the password hash matches.
 * On failure, the error message SHALL be identical regardless of whether the username
 * was wrong or the password was wrong.
 *
 * **Validates: Requirements 2.1, 2.2**
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
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

// --- Mock Prisma builders ---

/**
 * Builds a mock PrismaService where webAccount.findUnique returns a record
 * with a pre-computed bcrypt hash for the given username and password hash.
 */
function buildMockPrismaWithAccount(username: string, bcryptHash: string) {
  return {
    webAccount: {
      findUnique: async (args: any) => {
        if (args?.where?.username === username) {
          return {
            uuid: 'test-uuid-' + username,
            userId: BigInt(12345),
            username,
            passwordHash: bcryptHash,
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
  };
}

/**
 * Builds a mock PrismaService where webAccount.findUnique always returns null
 * (simulating a non-existent username).
 */
function buildMockPrismaNoAccount() {
  return {
    webAccount: {
      findUnique: async () => null,
    },
  };
}

const CLIENT_IP = '127.0.0.1';

describe('Property 5: Sign-In Correctness', () => {
  it('for any valid credentials (existing username + correct password hash), login() returns session data', async () => {
    await fc.assert(
      fc.asyncProperty(validUsernameArb, validSha256Arb, async (username, passwordHash) => {
        // Pre-compute the bcrypt hash that would be stored in the database
        const storedBcryptHash = await bcrypt.hash(passwordHash, 10);

        const mockPrisma = buildMockPrismaWithAccount(username, storedBcryptHash);
        const service = new WebAuthService(mockPrisma as any);

        const result = await service.login({ username, passwordHash }, CLIENT_IP);

        // Verify login returns the expected session data
        assert.ok(result.userId, 'Expected userId to be returned');
        assert.equal(typeof result.userId, 'string');
        assert.equal(typeof result.requiresPasswordChange, 'boolean');
        assert.equal(typeof result.telegramLinked, 'boolean');
        assert.equal(typeof result.emailVerified, 'boolean');
      }),
      { numRuns: 20 }, // Fewer runs due to bcrypt being CPU-intensive
    );
  });

  it('for any wrong password hash (existing username + incorrect password), login() throws UnauthorizedException', async () => {
    await fc.assert(
      fc.asyncProperty(
        validUsernameArb,
        validSha256Arb,
        validSha256Arb,
        async (username, correctHash, wrongHash) => {
          // Ensure the wrong hash is actually different from the correct one
          fc.pre(correctHash !== wrongHash);

          // Store the bcrypt of the correct hash
          const storedBcryptHash = await bcrypt.hash(correctHash, 10);

          const mockPrisma = buildMockPrismaWithAccount(username, storedBcryptHash);
          const service = new WebAuthService(mockPrisma as any);

          // Attempt login with the wrong password hash
          await assert.rejects(
            () => service.login({ username, passwordHash: wrongHash }, CLIENT_IP),
            (err: any) => {
              assert.ok(
                err instanceof UnauthorizedException,
                `Expected UnauthorizedException, got ${err.constructor.name}`,
              );
              return true;
            },
          );
        },
      ),
      { numRuns: 20 }, // Fewer runs due to bcrypt being CPU-intensive
    );
  });

  it('for any non-existent username, login() throws UnauthorizedException', async () => {
    await fc.assert(
      fc.asyncProperty(validUsernameArb, validSha256Arb, async (username, passwordHash) => {
        const mockPrisma = buildMockPrismaNoAccount();
        const service = new WebAuthService(mockPrisma as any);

        await assert.rejects(
          () => service.login({ username, passwordHash }, CLIENT_IP),
          (err: any) => {
            assert.ok(
              err instanceof UnauthorizedException,
              `Expected UnauthorizedException, got ${err.constructor.name}`,
            );
            return true;
          },
        );
      }),
      { numRuns: 100 },
    );
  });

  it('the error message is identical for wrong username vs wrong password (no information leakage)', async () => {
    await fc.assert(
      fc.asyncProperty(
        validUsernameArb,
        validUsernameArb,
        validSha256Arb,
        validSha256Arb,
        async (existingUsername, nonExistentUsername, correctHash, wrongHash) => {
          // Ensure the wrong hash differs from the correct one
          fc.pre(correctHash !== wrongHash);
          // Ensure the non-existent username differs from the existing one
          fc.pre(existingUsername !== nonExistentUsername);

          // Store the bcrypt of the correct hash for the existing user
          const storedBcryptHash = await bcrypt.hash(correctHash, 10);

          // Scenario 1: Wrong password (existing username, wrong hash)
          const mockPrismaWrongPassword = buildMockPrismaWithAccount(existingUsername, storedBcryptHash);
          const serviceWrongPassword = new WebAuthService(mockPrismaWrongPassword as any);

          let wrongPasswordMessage: string | undefined;
          try {
            await serviceWrongPassword.login(
              { username: existingUsername, passwordHash: wrongHash },
              CLIENT_IP,
            );
          } catch (err: any) {
            wrongPasswordMessage = err.message;
          }

          // Scenario 2: Wrong username (non-existent username)
          const mockPrismaWrongUsername = buildMockPrismaNoAccount();
          const serviceWrongUsername = new WebAuthService(mockPrismaWrongUsername as any);

          let wrongUsernameMessage: string | undefined;
          try {
            await serviceWrongUsername.login(
              { username: nonExistentUsername, passwordHash: wrongHash },
              CLIENT_IP,
            );
          } catch (err: any) {
            wrongUsernameMessage = err.message;
          }

          // Both must have thrown
          assert.ok(wrongPasswordMessage, 'Expected error for wrong password');
          assert.ok(wrongUsernameMessage, 'Expected error for wrong username');

          // Error messages must be identical (no information leakage)
          assert.equal(
            wrongPasswordMessage,
            wrongUsernameMessage,
            `Error messages must be identical. Wrong password: "${wrongPasswordMessage}" vs Wrong username: "${wrongUsernameMessage}"`,
          );
        },
      ),
      { numRuns: 20 }, // Fewer runs due to bcrypt being CPU-intensive
    );
  });
});
