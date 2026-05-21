/**
 * Property 3: Registration Creates Account
 *
 * *For any* valid username and valid password (passing validation from Property 1),
 * when the registration toggle is enabled and the username is not taken,
 * registration SHALL create a new Web_Account and associated User record.
 *
 * **Validates: Requirements 1.1**
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';
import * as bcrypt from 'bcryptjs';

import { WebAuthService } from '../src/modules/web-auth/web-auth.service';

// --- Generators ---

/**
 * Generates valid usernames matching ^[a-zA-Z0-9_-]{3,32}$
 */
const validUsernameArb = fc
  .stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'.split('')), {
    minLength: 3,
    maxLength: 32,
  });

/**
 * Generates valid SHA-256 hex strings (64 lowercase hex chars)
 */
const validSha256Arb = fc
  .stringOf(fc.constantFrom(...'0123456789abcdef'.split('')), {
    minLength: 64,
    maxLength: 64,
  });

// --- Mock Prisma builder ---

function buildMockPrisma() {
  let createdUser: any = null;
  let createdWebAccount: any = null;
  let transactionCalled = false;

  const txProxy = {
    user: {
      create: async (args: any) => {
        createdUser = {
          id: 1,
          telegramId: args.data.telegramId,
          name: args.data.name,
          username: args.data.username,
          referralCode: args.data.referralCode,
          role: args.data.role,
          language: args.data.language,
        };
        return createdUser;
      },
    },
    webAccount: {
      create: async (args: any) => {
        createdWebAccount = {
          uuid: 'web-account-uuid-' + args.data.username,
          userId: args.data.userId,
          username: args.data.username,
          passwordHash: args.data.passwordHash,
        };
        return createdWebAccount;
      },
    },
  };

  return {
    webRegistrationSetting: {
      findFirst: async () => ({ id: 1, enabled: true }),
    },
    webAccount: {
      findUnique: async () => null, // username not taken
    },
    $transaction: async (fn: (tx: any) => Promise<any>) => {
      transactionCalled = true;
      return fn(txProxy);
    },
    _getCreatedUser: () => createdUser,
    _getCreatedWebAccount: () => createdWebAccount,
    _wasTransactionCalled: () => transactionCalled,
  };
}

describe('Property 3: Registration Creates Account', () => {
  it('for any valid username and SHA-256 hash, register() creates both User and WebAccount in a transaction and returns {userId, webAccountId}', async () => {
    await fc.assert(
      fc.asyncProperty(validUsernameArb, validSha256Arb, async (username, passwordHash) => {
        const mockPrisma = buildMockPrisma();
        const service = new WebAuthService(mockPrisma as any);

        const result = await service.register({ username, passwordHash });

        // Verify register returns {userId, webAccountId}
        assert.ok(result.userId, 'Expected userId to be returned');
        assert.ok(result.webAccountId, 'Expected webAccountId to be returned');
        assert.equal(typeof result.userId, 'string');
        assert.equal(typeof result.webAccountId, 'string');

        // Verify the transaction was used (both records created atomically)
        assert.ok(mockPrisma._wasTransactionCalled(), 'Expected $transaction to be called');

        // Verify User record was created
        const createdUser = mockPrisma._getCreatedUser();
        assert.ok(createdUser, 'Expected User record to be created');
        assert.equal(createdUser.username, username);

        // Verify WebAccount record was created
        const createdWebAccount = mockPrisma._getCreatedWebAccount();
        assert.ok(createdWebAccount, 'Expected WebAccount record to be created');
        assert.equal(createdWebAccount.username, username);

        // Verify WebAccount references the User (userId links to user's telegramId)
        assert.equal(createdWebAccount.userId, createdUser.telegramId);
      }),
      { numRuns: 100 },
    );
  });

  it('for any valid registration input, the password is bcrypt-hashed (not stored as plain SHA-256)', async () => {
    await fc.assert(
      fc.asyncProperty(validUsernameArb, validSha256Arb, async (username, passwordHash) => {
        const mockPrisma = buildMockPrisma();
        const service = new WebAuthService(mockPrisma as any);

        await service.register({ username, passwordHash });

        const createdWebAccount = mockPrisma._getCreatedWebAccount();
        assert.ok(createdWebAccount, 'Expected WebAccount to be created');

        // The stored hash must NOT be the raw SHA-256 input
        assert.notEqual(createdWebAccount.passwordHash, passwordHash,
          'Password must not be stored as plain SHA-256 hash');

        // The stored hash must be a valid bcrypt hash (starts with $2a$ or $2b$)
        assert.ok(
          createdWebAccount.passwordHash.startsWith('$2'),
          `Expected bcrypt hash, got: ${createdWebAccount.passwordHash.substring(0, 10)}...`,
        );

        // The bcrypt hash must verify against the original SHA-256 input
        const matches = await bcrypt.compare(passwordHash, createdWebAccount.passwordHash);
        assert.ok(matches, 'bcrypt.compare must verify the stored hash against the original SHA-256 input');
      }),
      { numRuns: 20 }, // Fewer runs due to bcrypt being CPU-intensive
    );
  });
});
