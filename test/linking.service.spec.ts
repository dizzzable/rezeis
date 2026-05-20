import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LinkingService } from '../src/modules/linking/linking.service';

/**
 * Unit tests for LinkingService.
 * Uses in-memory mocks for PrismaService and RawCacheService.
 */

interface MockCacheStore {
  [key: string]: { value: unknown; ttl?: number };
}

function createMockCache() {
  const store: MockCacheStore = {};

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

function createMockPrisma(options?: {
  webAccounts?: Array<{
    uuid: string;
    userId: bigint;
    telegramId: bigint | null;
    telegramUsername: string | null;
  }>;
}) {
  const accounts = options?.webAccounts ?? [];

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
          if (args.data.telegramUsername !== undefined) account.telegramUsername = args.data.telegramUsername;
        }
        return account;
      },
    },
  };
}

describe('LinkingService', () => {
  describe('generateLinkingCode', () => {
    it('generates an 8-char alphanumeric code for a valid user', async () => {
      const mockCache = createMockCache();
      const mockPrisma = createMockPrisma({
        webAccounts: [
          { uuid: 'user-uuid-1', userId: BigInt(1), telegramId: null, telegramUsername: null },
        ],
      });

      const service = new LinkingService(mockPrisma as any, mockCache as any);
      const result = await service.generateLinkingCode({ userId: 'user-uuid-1' });

      assert.ok(result.code, 'Code should be generated');
      assert.equal(result.code.length, 8, 'Code should be 8 characters');
      assert.match(result.code, /^[a-zA-Z0-9]{8}$/, 'Code should be alphanumeric');
      assert.ok(result.expiresAt, 'ExpiresAt should be set');

      // Verify code is stored in Redis
      const stored = await mockCache.get(`telegram_link:${result.code}`);
      assert.ok(stored, 'Code should be stored in Redis');
    });

    it('stores code in Redis with 10-minute TTL', async () => {
      const mockCache = createMockCache();
      const mockPrisma = createMockPrisma({
        webAccounts: [
          { uuid: 'user-uuid-1', userId: BigInt(1), telegramId: null, telegramUsername: null },
        ],
      });

      const service = new LinkingService(mockPrisma as any, mockCache as any);
      const result = await service.generateLinkingCode({ userId: 'user-uuid-1' });

      const entry = mockCache.store[`telegram_link:${result.code}`];
      assert.equal(entry.ttl, 600, 'TTL should be 600 seconds (10 minutes)');
    });

    it('throws NotFoundException when user does not exist', async () => {
      const mockCache = createMockCache();
      const mockPrisma = createMockPrisma({ webAccounts: [] });

      const service = new LinkingService(mockPrisma as any, mockCache as any);

      await assert.rejects(
        () => service.generateLinkingCode({ userId: 'nonexistent-uuid' }),
        (err: any) => {
          assert.equal(err.status, 404);
          return true;
        },
      );
    });

    it('throws ConflictException when user already has Telegram linked', async () => {
      const mockCache = createMockCache();
      const mockPrisma = createMockPrisma({
        webAccounts: [
          { uuid: 'user-uuid-1', userId: BigInt(1), telegramId: BigInt(999), telegramUsername: 'existing' },
        ],
      });

      const service = new LinkingService(mockPrisma as any, mockCache as any);

      await assert.rejects(
        () => service.generateLinkingCode({ userId: 'user-uuid-1' }),
        (err: any) => {
          assert.equal(err.status, 409);
          return true;
        },
      );
    });
  });

  describe('verifyTelegramCode', () => {
    it('returns failure when code does not exist in Redis', async () => {
      const mockCache = createMockCache();
      const mockPrisma = createMockPrisma({ webAccounts: [] });

      const service = new LinkingService(mockPrisma as any, mockCache as any);
      const result = await service.verifyTelegramCode({
        code: 'INVALID1',
        telegramId: 123456789,
      });

      assert.equal(result.success, false);
      assert.ok(result.message.includes('invalid or has expired'));
    });

    it('returns failure when Telegram account is already linked to another user', async () => {
      const mockCache = createMockCache();
      await mockCache.set('telegram_link:AbCd1234', {
        userId: 'user-uuid-1',
        webAccountUuid: 'user-uuid-1',
      });

      const mockPrisma = createMockPrisma({
        webAccounts: [
          { uuid: 'user-uuid-1', userId: BigInt(1), telegramId: null, telegramUsername: null },
          { uuid: 'user-uuid-2', userId: BigInt(2), telegramId: BigInt(123456789), telegramUsername: 'other' },
        ],
      });

      const service = new LinkingService(mockPrisma as any, mockCache as any);
      const result = await service.verifyTelegramCode({
        code: 'AbCd1234',
        telegramId: 123456789,
      });

      assert.equal(result.success, false);
      assert.ok(result.message.includes('already linked to another user'));
    });

    it('successfully links Telegram account when code is valid', async () => {
      const mockCache = createMockCache();
      await mockCache.set('telegram_link:AbCd1234', {
        userId: 'user-uuid-1',
        webAccountUuid: 'user-uuid-1',
      });

      const mockPrisma = createMockPrisma({
        webAccounts: [
          { uuid: 'user-uuid-1', userId: BigInt(1), telegramId: null, telegramUsername: null },
        ],
      });

      const service = new LinkingService(mockPrisma as any, mockCache as any);
      const result = await service.verifyTelegramCode({
        code: 'AbCd1234',
        telegramId: 123456789,
        telegramUsername: 'testuser',
      });

      assert.equal(result.success, true);
      assert.ok(result.message.includes('linked successfully'));
      assert.equal(result.telegramId, 123456789);
      assert.equal(result.telegramUsername, 'testuser');

      // Verify the code was consumed (deleted from Redis)
      const codeStillExists = await mockCache.exists('telegram_link:AbCd1234');
      assert.equal(codeStillExists, false, 'Code should be consumed after successful linking');
    });

    it('returns failure when target WebAccount does not exist', async () => {
      const mockCache = createMockCache();
      await mockCache.set('telegram_link:AbCd1234', {
        userId: 'nonexistent-uuid',
        webAccountUuid: 'nonexistent-uuid',
      });

      const mockPrisma = createMockPrisma({ webAccounts: [] });

      const service = new LinkingService(mockPrisma as any, mockCache as any);
      const result = await service.verifyTelegramCode({
        code: 'AbCd1234',
        telegramId: 123456789,
      });

      assert.equal(result.success, false);
      assert.ok(result.message.includes('not found'));
    });

    it('returns failure when user already has a different Telegram linked', async () => {
      const mockCache = createMockCache();
      await mockCache.set('telegram_link:AbCd1234', {
        userId: 'user-uuid-1',
        webAccountUuid: 'user-uuid-1',
      });

      const mockPrisma = createMockPrisma({
        webAccounts: [
          { uuid: 'user-uuid-1', userId: BigInt(1), telegramId: BigInt(999999), telegramUsername: 'existing' },
        ],
      });

      const service = new LinkingService(mockPrisma as any, mockCache as any);
      const result = await service.verifyTelegramCode({
        code: 'AbCd1234',
        telegramId: 123456789,
      });

      assert.equal(result.success, false);
      assert.ok(result.message.includes('different Telegram account is already linked'));
    });
  });

  describe('DTO validation', () => {
    it('TelegramVerifySchema accepts valid input', async () => {
      const { TelegramVerifySchema } = await import('../src/modules/linking/dto/telegram-verify.dto');
      const result = TelegramVerifySchema.safeParse({
        code: 'AbCd1234',
        telegramId: 123456789,
        telegramUsername: 'testuser',
      });
      assert.ok(result.success);
    });

    it('TelegramVerifySchema rejects code shorter than 8 chars', async () => {
      const { TelegramVerifySchema } = await import('../src/modules/linking/dto/telegram-verify.dto');
      const result = TelegramVerifySchema.safeParse({
        code: 'short',
        telegramId: 123456789,
      });
      assert.equal(result.success, false);
    });

    it('TelegramVerifySchema rejects non-alphanumeric code', async () => {
      const { TelegramVerifySchema } = await import('../src/modules/linking/dto/telegram-verify.dto');
      const result = TelegramVerifySchema.safeParse({
        code: 'Ab!d1234',
        telegramId: 123456789,
      });
      assert.equal(result.success, false);
    });

    it('TelegramVerifySchema rejects negative telegramId', async () => {
      const { TelegramVerifySchema } = await import('../src/modules/linking/dto/telegram-verify.dto');
      const result = TelegramVerifySchema.safeParse({
        code: 'AbCd1234',
        telegramId: -1,
      });
      assert.equal(result.success, false);
    });

    it('GenerateCodeSchema accepts valid UUID', async () => {
      const { GenerateCodeSchema } = await import('../src/modules/linking/dto/generate-code.dto');
      const result = GenerateCodeSchema.safeParse({
        userId: '550e8400-e29b-41d4-a716-446655440000',
      });
      assert.ok(result.success);
    });

    it('GenerateCodeSchema rejects invalid UUID', async () => {
      const { GenerateCodeSchema } = await import('../src/modules/linking/dto/generate-code.dto');
      const result = GenerateCodeSchema.safeParse({
        userId: 'not-a-uuid',
      });
      assert.equal(result.success, false);
    });
  });
});
