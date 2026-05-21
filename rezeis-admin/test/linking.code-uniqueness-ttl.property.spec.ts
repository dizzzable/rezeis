import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { LinkingService } from '../src/modules/linking/linking.service';

/**
 * Property 7: Linking Code Uniqueness and TTL
 *
 * For any user requesting a Telegram linking code, the generated code SHALL be
 * unique across all active (non-expired) codes, and SHALL become invalid after
 * 10 minutes.
 *
 * **Validates: Requirements 3.1**
 */

// ─────────────────────────────────────────────────────────────────────────────
// Mock infrastructure
// ─────────────────────────────────────────────────────────────────────────────

interface CacheEntry {
  value: unknown;
  ttl?: number;
}

function createMockCache() {
  const store: Record<string, CacheEntry> = {};

  return {
    store,
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
    exists: async (key: string): Promise<boolean> => {
      return key in store;
    },
  };
}

function createMockPrisma(userUuids: string[]) {
  const accounts = userUuids.map((uuid, i) => ({
    uuid,
    userId: BigInt(i + 1),
    telegramId: null as bigint | null,
    telegramUsername: null as string | null,
  }));

  return {
    webAccount: {
      findUnique: async (args: { where: any; select?: any }) => {
        if (args.where.uuid) {
          return accounts.find((a) => a.uuid === args.where.uuid) ?? null;
        }
        if (args.where.telegramId !== undefined) {
          return accounts.find((a) => a.telegramId === args.where.telegramId) ?? null;
        }
        return null;
      },
      update: async (args: { where: any; data: any }) => {
        const account = accounts.find((a) => a.uuid === args.where.uuid);
        if (account) {
          if (args.data.telegramId !== undefined) account.telegramId = args.data.telegramId;
          if (args.data.telegramUsername !== undefined)
            account.telegramUsername = args.data.telegramUsername;
        }
        return account;
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Property tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 7: Linking Code Uniqueness and TTL', () => {
  const CODE_REGEX = /^[a-zA-Z0-9]{8}$/;

  describe('Generated codes are always 8 chars alphanumeric', () => {
    it('for any valid user, the generated code matches ^[a-zA-Z0-9]{8}$', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uuid(),
          async (userUuid) => {
            const mockCache = createMockCache();
            const mockPrisma = createMockPrisma([userUuid]);
            const service = new LinkingService(mockPrisma as any, mockCache as any);

            const result = await service.generateLinkingCode({ userId: userUuid });

            assert.equal(result.code.length, 8, `Code length should be 8, got ${result.code.length}`);
            assert.ok(
              CODE_REGEX.test(result.code),
              `Code "${result.code}" should match ^[a-zA-Z0-9]{8}$`,
            );
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  describe('Codes are unique across multiple generations', () => {
    it('for any sequence of code generations, all codes are distinct', async () => {
      // Generate between 2 and 10 codes for the same user and verify uniqueness
      await fc.assert(
        fc.asyncProperty(
          fc.uuid(),
          fc.integer({ min: 2, max: 10 }),
          async (userUuid, count) => {
            const mockCache = createMockCache();
            const mockPrisma = createMockPrisma([userUuid]);
            const service = new LinkingService(mockPrisma as any, mockCache as any);

            const codes: string[] = [];
            for (let i = 0; i < count; i++) {
              const result = await service.generateLinkingCode({ userId: userUuid });
              codes.push(result.code);
            }

            const uniqueCodes = new Set(codes);
            assert.equal(
              uniqueCodes.size,
              codes.length,
              `Expected ${codes.length} unique codes but got ${uniqueCodes.size}. Duplicates found.`,
            );
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('Expired codes (cache returns null) are rejected', () => {
    it('for any code that has expired (not in cache), verification fails', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.stringOf(
            fc.constantFrom(
              ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.split(''),
            ),
            { minLength: 8, maxLength: 8 },
          ),
          fc.integer({ min: 1, max: 999999999 }),
          async (expiredCode, telegramId) => {
            // Create a cache that does NOT contain the code (simulating expiration)
            const mockCache = createMockCache();
            const mockPrisma = createMockPrisma([]);
            const service = new LinkingService(mockPrisma as any, mockCache as any);

            const result = await service.verifyTelegramCode({
              code: expiredCode,
              telegramId,
            });

            assert.equal(
              result.success,
              false,
              `Expired code "${expiredCode}" should be rejected`,
            );
            assert.ok(
              result.message.includes('invalid or has expired'),
              `Error message should indicate code is invalid or expired, got: "${result.message}"`,
            );
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  describe('Codes are stored with 10-minute TTL', () => {
    it('for any generated code, the Redis TTL is exactly 600 seconds', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uuid(),
          async (userUuid) => {
            const mockCache = createMockCache();
            const mockPrisma = createMockPrisma([userUuid]);
            const service = new LinkingService(mockPrisma as any, mockCache as any);

            const result = await service.generateLinkingCode({ userId: userUuid });

            const entry = mockCache.store[`telegram_link:${result.code}`];
            assert.ok(entry, 'Code should be stored in cache');
            assert.equal(
              entry.ttl,
              600,
              `TTL should be 600 seconds (10 minutes), got ${entry.ttl}`,
            );
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});
