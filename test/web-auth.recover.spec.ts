import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ServiceUnavailableException } from '@nestjs/common';

import { WebAuthService } from '../src/modules/web-auth/web-auth.service';

// ─── Mock Factories ──────────────────────────────────────────────────────────

function buildMockPrisma(options: {
  webAccount?: {
    uuid: string;
    userId: bigint;
    username: string;
    telegramId: bigint | null;
    email: string | null;
    emailVerified: boolean;
  } | null;
  challengeCreated?: boolean;
} = {}) {
  const { webAccount = null } = options;

  let createdChallenge: any = null;
  let updatedWebAccount: any = null;
  const challengeUpdateCalls: any[] = [];

  return {
    webAccount: {
      findUnique: async () => webAccount,
      update: async (args: any) => {
        updatedWebAccount = args.data;
        return { ...webAccount, ...args.data };
      },
    },
    authChallenge: {
      create: async (args: any) => {
        createdChallenge = {
          uuid: 'challenge-uuid-123',
          ...args.data,
        };
        return createdChallenge;
      },
      updateMany: async (args: any) => {
        challengeUpdateCalls.push(args);
        return { count: 1 };
      },
    },
    webRegistrationSetting: {
      findFirst: async () => ({ id: 1, enabled: true }),
    },
    _getCreatedChallenge: () => createdChallenge,
    _getUpdatedWebAccount: () => updatedWebAccount,
    _getChallengeUpdateCalls: () => challengeUpdateCalls,
  };
}

function buildMockCache(options: {
  challengeData?: any;
} = {}) {
  const { challengeData = null } = options;
  const stored: Record<string, { value: any; ttl?: number }> = {};

  return {
    get: async (key: string) => {
      if (challengeData && key.startsWith('recovery:')) return challengeData;
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
    cache = buildMockCache(),
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WebAuthService — recover', () => {
  it('returns "none" method when username does not exist (no information leak)', async () => {
    const prisma = buildMockPrisma({ webAccount: null });
    const service = createService({ prisma });

    const result = await service.recover({ username: 'nonexistent' });

    assert.equal(result.method, 'none');
    assert.ok(result.message.length > 0);
  });

  it('returns "telegram" method when user has linked Telegram account', async () => {
    // Mock fetch for Telegram API call
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('{"ok":true}', { status: 200 }) as any;

    try {
      const prisma = buildMockPrisma({
        webAccount: {
          uuid: 'wa-uuid-1',
          userId: BigInt(12345),
          username: 'tg-user',
          telegramId: BigInt(987654),
          email: null,
          emailVerified: false,
        },
      });
      const service = createService({ prisma });

      const result = await service.recover({ username: 'tg-user' });

      assert.equal(result.method, 'telegram');
      assert.ok(result.challengeId);
      assert.ok(result.message.includes('Telegram'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('creates AuthChallenge in DB with type telegram_recovery', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('{"ok":true}', { status: 200 }) as any;

    try {
      const prisma = buildMockPrisma({
        webAccount: {
          uuid: 'wa-uuid-1',
          userId: BigInt(12345),
          username: 'tg-user',
          telegramId: BigInt(987654),
          email: null,
          emailVerified: false,
        },
      });
      const service = createService({ prisma });

      await service.recover({ username: 'tg-user' });

      const challenge = prisma._getCreatedChallenge();
      assert.ok(challenge);
      assert.equal(challenge.type, 'telegram_recovery');
      assert.equal(challenge.userId, BigInt(12345));
      assert.ok(challenge.expiresAt instanceof Date);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('stores challenge data in Redis with 15min TTL', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('{"ok":true}', { status: 200 }) as any;

    try {
      const prisma = buildMockPrisma({
        webAccount: {
          uuid: 'wa-uuid-1',
          userId: BigInt(12345),
          username: 'tg-user',
          telegramId: BigInt(987654),
          email: null,
          emailVerified: false,
        },
      });
      const cache = buildMockCache();
      const service = createService({ prisma, cache });

      await service.recover({ username: 'tg-user' });

      const stored = cache._getStored();
      const recoveryKey = Object.keys(stored).find((k) => k.startsWith('recovery:'));
      assert.ok(recoveryKey, 'Expected recovery key in Redis');
      assert.equal(stored[recoveryKey].ttl, 15 * 60);
      assert.equal(stored[recoveryKey].value.confirmed, false);
      assert.equal(stored[recoveryKey].value.failed, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns "email" method when no Telegram but email is linked and verified', async () => {
    const prisma = buildMockPrisma({
      webAccount: {
        uuid: 'wa-uuid-2',
        userId: BigInt(22222),
        username: 'email-user',
        telegramId: null,
        email: 'user@example.com',
        emailVerified: true,
      },
    });
    const service = createService({ prisma });

    const result = await service.recover({ username: 'email-user' });

    assert.equal(result.method, 'email');
    assert.ok(result.message.includes('email'));
  });

  it('returns "none" when no Telegram and email is not verified', async () => {
    const prisma = buildMockPrisma({
      webAccount: {
        uuid: 'wa-uuid-3',
        userId: BigInt(33333),
        username: 'no-method-user',
        telegramId: null,
        email: 'unverified@example.com',
        emailVerified: false,
      },
    });
    const service = createService({ prisma });

    const result = await service.recover({ username: 'no-method-user' });

    assert.equal(result.method, 'none');
    assert.ok(result.message.includes('No recovery method'));
  });

  it('returns "none" when no Telegram and no email at all', async () => {
    const prisma = buildMockPrisma({
      webAccount: {
        uuid: 'wa-uuid-4',
        userId: BigInt(44444),
        username: 'bare-user',
        telegramId: null,
        email: null,
        emailVerified: false,
      },
    });
    const service = createService({ prisma });

    const result = await service.recover({ username: 'bare-user' });

    assert.equal(result.method, 'none');
    assert.ok(result.message.includes('No recovery method'));
  });

  it('throws ServiceUnavailableException when BOT_TOKEN is not configured', async () => {
    const prisma = buildMockPrisma({
      webAccount: {
        uuid: 'wa-uuid-5',
        userId: BigInt(55555),
        username: 'tg-user-no-bot',
        telegramId: BigInt(111111),
        email: null,
        emailVerified: false,
      },
    });
    const configService = buildMockConfigService({ botToken: null });
    const service = createService({ prisma, configService });

    await assert.rejects(
      () => service.recover({ username: 'tg-user-no-bot' }),
      (err: any) => {
        assert.ok(err instanceof ServiceUnavailableException);
        return true;
      },
    );
  });
});

describe('WebAuthService — handleRecoveryConfirmation', () => {
  it('returns failure when challenge data is not found in Redis (expired)', async () => {
    const cache = buildMockCache({ challengeData: null });
    const service = createService({ cache });

    const result = await service.handleRecoveryConfirmation('expired-challenge-id');

    assert.equal(result.success, false);
    assert.ok(result.message.includes('expired'));
  });

  it('returns failure when challenge was already confirmed', async () => {
    const cache = buildMockCache({
      challengeData: {
        userId: '12345',
        webAccountUuid: 'wa-uuid-1',
        username: 'test-user',
        confirmed: true,
        failed: false,
      },
    });
    const service = createService({ cache });

    const result = await service.handleRecoveryConfirmation('already-confirmed-id');

    assert.equal(result.success, false);
    assert.ok(result.message.includes('already been confirmed'));
  });

  it('returns failure when challenge already failed', async () => {
    const cache = buildMockCache({
      challengeData: {
        userId: '12345',
        webAccountUuid: 'wa-uuid-1',
        username: 'test-user',
        confirmed: false,
        failed: true,
      },
    });
    const service = createService({ cache });

    const result = await service.handleRecoveryConfirmation('failed-challenge-id');

    assert.equal(result.success, false);
    assert.ok(result.message.includes('failed'));
  });

  it('in automatic mode: generates temp password and delivers via Telegram', async () => {
    const prisma = buildMockPrisma({
      webAccount: {
        uuid: 'wa-uuid-1',
        userId: BigInt(12345),
        username: 'test-user',
        telegramId: BigInt(987654),
        email: null,
        emailVerified: false,
      },
    });
    const cache = buildMockCache({
      challengeData: {
        userId: '12345',
        webAccountUuid: 'wa-uuid-1',
        username: 'test-user',
        confirmed: false,
        failed: false,
      },
    });
    const telegramNotify = buildMockTelegramNotify();
    const webRegistrationSettings = buildMockWebRegistrationSettings({ mode: 'automatic' });
    const service = createService({ prisma, cache, telegramNotify, webRegistrationSettings });

    const result = await service.handleRecoveryConfirmation('challenge-id-1');

    assert.equal(result.success, true);
    assert.ok(result.message.includes('temporary password'));

    // Verify password was updated
    const updatedAccount = prisma._getUpdatedWebAccount();
    assert.ok(updatedAccount);
    assert.equal(updatedAccount.requiresPasswordChange, true);
    assert.ok(updatedAccount.passwordHash.startsWith('$2'));

    // Verify Telegram message was sent
    const messages = telegramNotify._getSentMessages();
    assert.ok(messages.length > 0);
    assert.ok(messages[0].text.includes('Temporary Password'));
  });

  it('in automatic mode: marks challenge as consumed in DB', async () => {
    const prisma = buildMockPrisma({
      webAccount: {
        uuid: 'wa-uuid-1',
        userId: BigInt(12345),
        username: 'test-user',
        telegramId: BigInt(987654),
        email: null,
        emailVerified: false,
      },
    });
    const cache = buildMockCache({
      challengeData: {
        userId: '12345',
        webAccountUuid: 'wa-uuid-1',
        username: 'test-user',
        confirmed: false,
        failed: false,
      },
    });
    const service = createService({ prisma, cache });

    await service.handleRecoveryConfirmation('challenge-id-1');

    const updateCalls = prisma._getChallengeUpdateCalls();
    assert.ok(updateCalls.length > 0);
    assert.equal(updateCalls[0].where.uuid, 'challenge-id-1');
    assert.equal(updateCalls[0].data.consumed, true);
  });

  it('in manual mode: queues password generation and returns pending message', async () => {
    const prisma = buildMockPrisma({
      webAccount: {
        uuid: 'wa-uuid-1',
        userId: BigInt(12345),
        username: 'test-user',
        telegramId: BigInt(987654),
        email: null,
        emailVerified: false,
      },
    });
    const cache = buildMockCache({
      challengeData: {
        userId: '12345',
        webAccountUuid: 'wa-uuid-1',
        username: 'test-user',
        confirmed: false,
        failed: false,
      },
    });
    const webRegistrationSettings = buildMockWebRegistrationSettings({ mode: 'manual' });
    const service = createService({ prisma, cache, webRegistrationSettings });

    const result = await service.handleRecoveryConfirmation('challenge-id-manual');

    assert.equal(result.success, true);
    assert.ok(result.message.includes('approved'));

    // Verify queued in Redis
    const stored = cache._getStored();
    const queueKey = Object.keys(stored).find((k) => k.startsWith('recovery_queue:'));
    assert.ok(queueKey, 'Expected recovery_queue key in Redis');
    assert.ok(stored[queueKey].value.confirmedAt);
  });
});

describe('WebAuthService — handleAdminRecoveryConfirmation', () => {
  it('returns failure when no queued recovery exists', async () => {
    const cache = buildMockCache({ challengeData: null });
    // Override get to return null for recovery_queue keys too
    cache.get = async () => null;
    const service = createService({ cache });

    const result = await service.handleAdminRecoveryConfirmation('no-queue-id');

    assert.equal(result.success, false);
    assert.ok(result.message.includes('No queued recovery'));
  });

  it('generates and delivers temp password when queue data exists', async () => {
    const prisma = buildMockPrisma({
      webAccount: {
        uuid: 'wa-uuid-1',
        userId: BigInt(12345),
        username: 'test-user',
        telegramId: BigInt(987654),
        email: null,
        emailVerified: false,
      },
    });
    const telegramNotify = buildMockTelegramNotify();

    // Custom cache that returns queue data for recovery_queue keys
    const cache = {
      get: async (key: string) => {
        if (key.startsWith('recovery_queue:')) {
          return {
            userId: '12345',
            webAccountUuid: 'wa-uuid-1',
            username: 'test-user',
            confirmedAt: new Date().toISOString(),
          };
        }
        return null;
      },
      set: async () => {},
      del: async () => {},
      exists: async () => false,
    };

    const service = createService({ prisma, cache, telegramNotify });

    const result = await service.handleAdminRecoveryConfirmation('queued-challenge-id');

    assert.equal(result.success, true);
    assert.ok(result.message.includes('temporary password'));

    // Verify Telegram message was sent
    const messages = telegramNotify._getSentMessages();
    assert.ok(messages.length > 0);
  });
});

describe('WebAuthService — recover DTO validation', () => {
  it('accepts a valid username', async () => {
    const { RecoverSchema } = await import('../src/modules/web-auth/dto/recover.dto');
    const result = RecoverSchema.safeParse({ username: 'valid-user' });
    assert.ok(result.success);
  });

  it('rejects empty username', async () => {
    const { RecoverSchema } = await import('../src/modules/web-auth/dto/recover.dto');
    const result = RecoverSchema.safeParse({ username: '' });
    assert.equal(result.success, false);
  });

  it('rejects username exceeding 254 characters', async () => {
    const { RecoverSchema } = await import('../src/modules/web-auth/dto/recover.dto');
    const result = RecoverSchema.safeParse({ username: 'a'.repeat(255) });
    assert.equal(result.success, false);
  });
});
