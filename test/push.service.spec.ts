import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, NotFoundException } from '@nestjs/common';

import { PushService } from '../src/modules/push/push.service';

// --- Mock Factories ---

interface MockPrismaOptions {
  webAccountExists?: boolean;
  existingSubscription?: { uuid: string; endpoint: string } | null;
  subscriptionCount?: number;
  subscriptions?: Array<{
    uuid: string;
    endpoint: string;
    p256dhKey: string;
    authKey: string;
  }>;
  deleteThrows?: boolean;
}

function buildMockPrisma(opts: MockPrismaOptions = {}) {
  const {
    webAccountExists = true,
    existingSubscription = null,
    subscriptionCount = 0,
    subscriptions = [],
    deleteThrows = false,
  } = opts;

  return {
    webAccount: {
      findUnique: async () => (webAccountExists ? { uuid: 'user-uuid' } : null),
    },
    pushSubscription: {
      findUnique: async ({ where }: { where: { endpoint?: string; uuid?: string } }) => {
        if (where.endpoint) return existingSubscription;
        // For unsubscribe by endpoint lookup
        return existingSubscription;
      },
      findMany: async () => subscriptions,
      count: async () => subscriptionCount,
      create: async ({ data }: { data: Record<string, unknown> }) => ({
        uuid: 'new-sub-uuid',
        ...data,
      }),
      update: async ({ where }: { where: { uuid: string } }) => ({
        uuid: where.uuid,
      }),
      delete: async () => {
        if (deleteThrows) throw new Error('DB error');
        return {};
      },
    },
  };
}

function buildMockConfig(vapidConfigured = false) {
  return {
    get: (key: string) => {
      if (!vapidConfigured) return undefined;
      // Generate real VAPID keys for tests that need them
      const config: Record<string, string> = {
        VAPID_PUBLIC_KEY: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkOs-N0y0p8-sqGZ7Ck',
        VAPID_PRIVATE_KEY: 'UUxI4O8-FbRouAevSmBQ6o18hgE4nSG3qwvJTfKc-ls',
        VAPID_SUBJECT: 'mailto:test@rezeis.com',
      };
      return config[key];
    },
  };
}

function createService(prismaOpts: MockPrismaOptions = {}, vapidConfigured = false): PushService {
  const mockPrisma = buildMockPrisma(prismaOpts);
  const mockConfig = buildMockConfig(vapidConfigured);
  return new PushService(mockPrisma as any, mockConfig as any);
}

// --- Tests ---

describe('PushService — subscribe', () => {
  it('creates a new push subscription when user exists and endpoint is new', async () => {
    const service = createService({
      webAccountExists: true,
      existingSubscription: null,
      subscriptionCount: 0,
    });

    const result = await service.subscribe({
      userId: 'user-uuid',
      subscription: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
        keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
      },
    });

    assert.ok(result.subscriptionId);
    assert.equal(typeof result.subscriptionId, 'string');
  });

  it('updates existing subscription if endpoint already exists', async () => {
    const service = createService({
      webAccountExists: true,
      existingSubscription: { uuid: 'existing-sub-uuid', endpoint: 'https://fcm.googleapis.com/fcm/send/abc123' },
    });

    const result = await service.subscribe({
      userId: 'user-uuid',
      subscription: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
        keys: { p256dh: 'new-p256dh-key', auth: 'new-auth-key' },
      },
    });

    assert.equal(result.subscriptionId, 'existing-sub-uuid');
  });

  it('throws NotFoundException if user does not exist', async () => {
    const service = createService({ webAccountExists: false });

    await assert.rejects(
      () =>
        service.subscribe({
          userId: 'nonexistent-uuid',
          subscription: {
            endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
            keys: { p256dh: 'key', auth: 'auth' },
          },
        }),
      (err: Error) => err instanceof NotFoundException,
    );
  });

  it('throws BadRequestException when max 5 subscriptions reached', async () => {
    const service = createService({
      webAccountExists: true,
      existingSubscription: null,
      subscriptionCount: 5,
    });

    await assert.rejects(
      () =>
        service.subscribe({
          userId: 'user-uuid',
          subscription: {
            endpoint: 'https://fcm.googleapis.com/fcm/send/new-device',
            keys: { p256dh: 'key', auth: 'auth' },
          },
        }),
      (err: Error) => err instanceof BadRequestException,
    );
  });
});

describe('PushService — send', () => {
  it('returns zeros when no subscriptions exist for user', async () => {
    const service = createService({ subscriptions: [] });

    const result = await service.send({
      userId: 'user-uuid',
      title: 'Test',
      body: 'Test body',
    });

    assert.deepEqual(result, { sent: 0, failed: 0, removed: 0 });
  });

  it('returns zeros when VAPID is not configured', async () => {
    const service = createService(
      {
        subscriptions: [
          { uuid: 'sub-1', endpoint: 'https://fcm.googleapis.com/fcm/send/device1', p256dhKey: 'key1', authKey: 'auth1' },
        ],
      },
      false, // VAPID not configured
    );

    const result = await service.send({
      userId: 'user-uuid',
      title: 'Test',
      body: 'Test body',
    });

    assert.deepEqual(result, { sent: 0, failed: 0, removed: 0 });
  });
});

describe('PushService — unsubscribe', () => {
  it('removes a push subscription successfully', async () => {
    const service = createService({
      existingSubscription: { uuid: 'sub-uuid-123', endpoint: 'https://fcm.googleapis.com/fcm/send/abc123' },
    });

    const result = await service.unsubscribe({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    });

    assert.equal(result.success, true);
    assert.ok(result.message.includes('removed'));
  });

  it('throws NotFoundException if subscription does not exist', async () => {
    const service = createService({ existingSubscription: null });

    await assert.rejects(
      () => service.unsubscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/nonexistent' }),
      (err: Error) => err instanceof NotFoundException,
    );
  });

  it('retains subscription data if cleanup fails', async () => {
    const service = createService({
      existingSubscription: { uuid: 'sub-uuid-123', endpoint: 'https://fcm.googleapis.com/fcm/send/abc123' },
      deleteThrows: true,
    });

    const result = await service.unsubscribe({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    });

    assert.equal(result.success, false);
    assert.ok(result.message.toLowerCase().includes('retained'));
  });
});
