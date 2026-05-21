/**
 * Property 17: Registration Toggle Enforcement
 *
 * *For any* new registration API request received while the Registration_Toggle is disabled
 * (including when it defaults to disabled on fresh installations, during the initial setup
 * process before an admin has configured the toggle, or when the toggle state is ambiguous
 * or corrupted), the system SHALL respond with ForbiddenException (HTTP 403), reject silently
 * without additional logging, and block all registration attempts until an admin explicitly
 * enables the toggle.
 *
 * When the toggle is enabled, registration SHALL proceed normally.
 *
 * **Validates: Requirements 9.3, 9.5**
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ForbiddenException } from '@nestjs/common';
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

/**
 * Generates disabled toggle states: either { enabled: false } or null (missing/fresh install)
 */
const disabledToggleArb = fc.oneof(
  fc.constant({ id: 1, enabled: false }),
  fc.constant(null),
);

// --- Mock Factories ---

function buildMockCache() {
  return {
    get: async () => null,
    set: async () => {},
    del: async () => {},
    exists: async () => false,
  };
}

function buildMockTelegramNotify() {
  return {
    sendToUser: async () => true,
    sendToAdmin: async () => {},
  };
}

function buildMockConfigService() {
  return {
    get: () => null,
  };
}

function buildMockWebRegistrationSettings() {
  return {
    getFullSettings: async () => ({
      enabled: true,
      recoveryConfirmMode: 'automatic',
      updatedAt: new Date(),
    }),
  };
}

/**
 * Builds a mock PrismaService with configurable registration toggle state.
 * Tracks whether the transaction was called (it should NOT be called when toggle is disabled).
 */
function buildMockPrisma(options: {
  toggleResult: { id: number; enabled: boolean } | null;
}) {
  let transactionCalled = false;

  const txProxy = {
    user: {
      create: async (args: any) => ({
        id: 1,
        telegramId: args.data.telegramId,
        name: args.data.name,
        username: args.data.username,
        referralCode: args.data.referralCode,
        role: args.data.role,
        language: args.data.language,
      }),
    },
    webAccount: {
      create: async (args: any) => ({
        uuid: 'web-account-uuid-test',
        userId: args.data.userId,
        username: args.data.username,
        passwordHash: args.data.passwordHash,
      }),
    },
  };

  return {
    webRegistrationSetting: {
      findFirst: async () => options.toggleResult,
    },
    webAccount: {
      findUnique: async () => null, // username not taken
    },
    $transaction: async (fn: (tx: any) => Promise<any>) => {
      transactionCalled = true;
      return fn(txProxy);
    },
    _wasTransactionCalled: () => transactionCalled,
  };
}

function createService(prisma: any) {
  return new WebAuthService(
    prisma,
    buildMockCache(),
    buildMockTelegramNotify(),
    buildMockConfigService(),
    buildMockWebRegistrationSettings(),
  );
}

// --- Tests ---

describe('Property 17: Registration Toggle Enforcement', () => {
  it('for any valid registration input, when toggle is disabled (enabled=false), register() throws ForbiddenException', async () => {
    await fc.assert(
      fc.asyncProperty(validUsernameArb, validSha256Arb, async (username, passwordHash) => {
        const mockPrisma = buildMockPrisma({ toggleResult: { id: 1, enabled: false } });
        const service = createService(mockPrisma);

        await assert.rejects(
          () => service.register({ username, passwordHash }),
          (err: any) => {
            assert.ok(
              err instanceof ForbiddenException,
              `Expected ForbiddenException, got ${err.constructor.name}: ${err.message}`,
            );
            return true;
          },
        );

        // Transaction must NOT be called when toggle is disabled
        assert.equal(
          mockPrisma._wasTransactionCalled(),
          false,
          'Transaction must NOT be called when registration is disabled',
        );
      }),
      { numRuns: 100 },
    );
  });

  it('for any valid registration input, when toggle setting is missing (null/fresh install), register() throws ForbiddenException', async () => {
    await fc.assert(
      fc.asyncProperty(validUsernameArb, validSha256Arb, async (username, passwordHash) => {
        const mockPrisma = buildMockPrisma({ toggleResult: null });
        const service = createService(mockPrisma);

        await assert.rejects(
          () => service.register({ username, passwordHash }),
          (err: any) => {
            assert.ok(
              err instanceof ForbiddenException,
              `Expected ForbiddenException, got ${err.constructor.name}: ${err.message}`,
            );
            return true;
          },
        );

        // Transaction must NOT be called when setting is missing
        assert.equal(
          mockPrisma._wasTransactionCalled(),
          false,
          'Transaction must NOT be called when registration setting is missing (fresh install)',
        );
      }),
      { numRuns: 100 },
    );
  });

  it('for any disabled toggle state (false or null), the ForbiddenException is always thrown regardless of input', async () => {
    await fc.assert(
      fc.asyncProperty(
        validUsernameArb,
        validSha256Arb,
        disabledToggleArb,
        async (username, passwordHash, toggleResult) => {
          const mockPrisma = buildMockPrisma({ toggleResult });
          const service = createService(mockPrisma);

          await assert.rejects(
            () => service.register({ username, passwordHash }),
            (err: any) => {
              assert.ok(
                err instanceof ForbiddenException,
                `Expected ForbiddenException for toggle=${JSON.stringify(toggleResult)}, got ${err.constructor.name}`,
              );
              return true;
            },
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it('for any valid registration input, when toggle is enabled (enabled=true), register() proceeds successfully', async () => {
    await fc.assert(
      fc.asyncProperty(validUsernameArb, validSha256Arb, async (username, passwordHash) => {
        const mockPrisma = buildMockPrisma({ toggleResult: { id: 1, enabled: true } });
        const service = createService(mockPrisma);

        const result = await service.register({ username, passwordHash });

        // Registration should succeed
        assert.ok(result.userId, 'Expected userId to be returned');
        assert.ok(result.webAccountId, 'Expected webAccountId to be returned');

        // Transaction must be called when toggle is enabled
        assert.equal(
          mockPrisma._wasTransactionCalled(),
          true,
          'Transaction must be called when registration is enabled',
        );
      }),
      { numRuns: 50 },
    );
  });
});
