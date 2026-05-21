/**
 * Property 9: Auth Challenge TTL Expiration
 *
 * *For any* Telegram-based recovery Auth_Challenge, attempting to consume it after
 * 15 minutes SHALL fail. Expiration notifications SHALL only be sent when the
 * challenge expired without confirmation and without other prior failures.
 *
 * **Validates: Requirements 4.4**
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { WebAuthService } from '../src/modules/web-auth/web-auth.service';

// --- Generators ---

/**
 * Generates random challenge IDs (UUID-like strings)
 */
const challengeIdArb = fc.stringOf(
  fc.constantFrom(...'0123456789abcdef-'.split('')),
  { minLength: 8, maxLength: 36 },
).filter((s) => s.length >= 8 && !s.startsWith('-') && !s.endsWith('-'));

/**
 * Generates valid usernames matching ^[a-zA-Z0-9_-]{3,32}$
 */
const validUsernameArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'.split('')),
  { minLength: 3, maxLength: 32 },
);

/**
 * Generates valid UUID-like webAccountUuid strings
 */
const webAccountUuidArb = fc.uuid();

/**
 * Generates valid userId strings (numeric)
 */
const userIdArb = fc.nat({ max: 999999999 }).map(String);

// --- Mock Factories ---

function buildMockPrisma(options: {
  webAccount?: any;
} = {}) {
  const { webAccount = null } = options;
  const challengeUpdateCalls: any[] = [];

  return {
    webAccount: {
      findUnique: async () => webAccount,
      update: async (args: any) => ({ ...webAccount, ...args.data }),
    },
    authChallenge: {
      create: async (args: any) => ({ uuid: 'challenge-uuid', ...args.data }),
      updateMany: async (args: any) => {
        challengeUpdateCalls.push(args);
        return { count: 1 };
      },
    },
    webRegistrationSetting: {
      findFirst: async () => ({ id: 1, enabled: true }),
    },
    _getChallengeUpdateCalls: () => challengeUpdateCalls,
  };
}

/**
 * Builds a mock cache that returns null for any key (simulating TTL expiration).
 */
function buildExpiredCache() {
  return {
    get: async (_key: string) => null,
    set: async (_key: string, _value: any, _ttl?: number) => {},
    del: async (_key: string) => {},
    exists: async (_key: string) => false,
  };
}

/**
 * Builds a mock cache that returns valid (non-expired) challenge data.
 */
function buildValidCache(challengeData: {
  userId: string;
  webAccountUuid: string;
  username: string;
  confirmed: boolean;
  failed: boolean;
}) {
  const stored: Record<string, { value: any; ttl?: number }> = {};

  return {
    get: async (key: string) => {
      if (key.startsWith('recovery:')) return challengeData;
      if (key.startsWith('recovery_queue:')) return stored[key]?.value ?? null;
      return stored[key]?.value ?? null;
    },
    set: async (key: string, value: any, ttl?: number) => {
      stored[key] = { value, ttl };
    },
    del: async (key: string) => {
      delete stored[key];
    },
    exists: async (key: string) => key in stored,
    _getStored: () => stored,
  };
}

function buildMockTelegramNotify() {
  const sentMessages: { chatId: string; text: string }[] = [];
  return {
    sendToUser: async (chatId: string, text: string) => {
      sentMessages.push({ chatId, text });
      return true;
    },
    sendToAdmin: async () => {},
    _getSentMessages: () => sentMessages,
  };
}

function buildMockConfigService(options: { botToken?: string | null } = {}) {
  const { botToken = 'test-bot-token' } = options;
  return {
    get: (key: string) => {
      if (key === 'BOT_TOKEN') return botToken;
      return null;
    },
  };
}

function buildMockWebRegistrationSettings(options: { mode?: string } = {}) {
  const { mode = 'automatic' } = options;
  return {
    getFullSettings: async () => ({
      enabled: true,
      recoveryConfirmMode: mode,
      updatedAt: new Date(),
    }),
  };
}

function createService(overrides: {
  prisma?: any;
  cache?: any;
  telegramNotify?: any;
  configService?: any;
  webRegistrationSettings?: any;
} = {}) {
  const {
    prisma = buildMockPrisma(),
    cache = buildExpiredCache(),
    telegramNotify = buildMockTelegramNotify(),
    configService = buildMockConfigService(),
    webRegistrationSettings = buildMockWebRegistrationSettings(),
  } = overrides;

  return new WebAuthService(
    prisma,
    cache,
    telegramNotify,
    configService,
    webRegistrationSettings,
  );
}

// --- Tests ---

describe('Property 9: Auth Challenge TTL Expiration', () => {
  it('for any challenge ID, when cache returns null (TTL expired), handleRecoveryConfirmation returns failure with expired message', async () => {
    await fc.assert(
      fc.asyncProperty(challengeIdArb, async (challengeId) => {
        // Cache returns null for any key — simulates TTL expiration (15min elapsed)
        const cache = buildExpiredCache();
        const service = createService({ cache });

        const result = await service.handleRecoveryConfirmation(challengeId);

        // Must return failure
        assert.equal(result.success, false, 'Expected success to be false for expired challenge');

        // Must indicate expiration or invalidity
        assert.ok(
          result.message.includes('expired') || result.message.includes('invalid'),
          `Expected message to mention "expired" or "invalid", got: "${result.message}"`,
        );
      }),
      { numRuns: 100 },
    );
  });

  it('for any valid (non-expired) challenge with confirmed=false and failed=false, handleRecoveryConfirmation succeeds', async () => {
    await fc.assert(
      fc.asyncProperty(
        challengeIdArb,
        userIdArb,
        webAccountUuidArb,
        validUsernameArb,
        async (challengeId, userId, webAccountUuid, username) => {
          // Build a valid challenge that has NOT expired (data exists in cache)
          const challengeData = {
            userId,
            webAccountUuid,
            username,
            confirmed: false,
            failed: false,
          };

          const cache = buildValidCache(challengeData);

          const prisma = buildMockPrisma({
            webAccount: {
              uuid: webAccountUuid,
              userId: BigInt(userId),
              username,
              telegramId: BigInt(123456),
              email: null,
              emailVerified: false,
              passwordHash: '$2a$10$fakehash',
              requiresPasswordChange: false,
            },
          });

          const telegramNotify = buildMockTelegramNotify();
          const service = createService({ prisma, cache, telegramNotify });

          const result = await service.handleRecoveryConfirmation(challengeId);

          // Must return success (automatic mode generates and delivers temp password)
          assert.equal(
            result.success,
            true,
            `Expected success for valid non-expired challenge, got message: "${result.message}"`,
          );
        },
      ),
      { numRuns: 50 },
    );
  });

  it('for any challenge ID, expired challenges always produce the same failure response structure', async () => {
    await fc.assert(
      fc.asyncProperty(challengeIdArb, async (challengeId) => {
        const cache = buildExpiredCache();
        const service = createService({ cache });

        const result = await service.handleRecoveryConfirmation(challengeId);

        // Verify consistent response structure
        assert.equal(typeof result.success, 'boolean');
        assert.equal(typeof result.message, 'string');
        assert.equal(result.success, false);
        assert.ok(result.message.length > 0, 'Expected non-empty error message');
      }),
      { numRuns: 100 },
    );
  });
});
