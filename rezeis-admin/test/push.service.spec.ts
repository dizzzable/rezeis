import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, describe, it } from 'node:test';

import { BadRequestException, HttpStatus, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { WebPushSubscription } from '@prisma/client';
import * as webpush from 'web-push';

import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { InternalPushController } from '../src/modules/push/internal-push.controller';
import { WebPushService } from '../src/modules/push/services/web-push.service';

const requireWebPush = createRequire(__filename);
const mutableWebPush = requireWebPush('web-push') as typeof webpush;
const originalSendNotification = mutableWebPush.sendNotification;

afterEach(() => {
  setWebPushSendNotification(originalSendNotification);
  clearVapidEnv();
});

describe('InternalPushController', () => {
  it('exposes current internal push route contracts and guard', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalPushController), 'internal/push');
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, InternalPushController), [
      InternalAdminAuthGuard,
    ]);
    assert.deepStrictEqual(route('getPublicKey'), {
      path: 'public-key',
      method: RequestMethod.GET,
      httpCode: undefined,
    });
    assert.deepStrictEqual(route('subscribe'), {
      path: 'subscribe',
      method: RequestMethod.POST,
      httpCode: HttpStatus.OK,
    });
    assert.deepStrictEqual(route('unsubscribe'), {
      path: 'unsubscribe',
      method: RequestMethod.POST,
      httpCode: HttpStatus.OK,
    });
  });

  it('delegates public key, subscribe, and unsubscribe to WebPushService', async () => {
    const calls: unknown[] = [];
    const webPushService = {
      getPublicKey: () => 'public-key-1',
      subscribe: async (input: unknown) => {
        calls.push(['subscribe', input]);
        return { id: 'subscription-1' };
      },
      unsubscribe: async (input: unknown) => {
        calls.push(['unsubscribe', input]);
      },
    } as unknown as WebPushService;
    const controller = new InternalPushController(webPushService);

    assert.deepStrictEqual(controller.getPublicKey(), { publicKey: 'public-key-1' });
    assert.deepStrictEqual(
      await controller.subscribe({
        userId: 'user-1',
        userAgent: 'Mozilla/5.0',
        subscription: {
          endpoint: 'https://push.example.test/subscription-1',
          keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
        },
      }),
      { success: true },
    );
    assert.deepStrictEqual(
      await controller.unsubscribe({
        userId: 'user-1',
        endpoint: 'https://push.example.test/subscription-1',
      }),
      { success: true },
    );

    assert.deepStrictEqual(calls, [
      [
        'subscribe',
        {
          userId: 'user-1',
          endpoint: 'https://push.example.test/subscription-1',
          p256dhKey: 'p256dh-key',
          authKey: 'auth-key',
          userAgent: 'Mozilla/5.0',
        },
      ],
      ['unsubscribe', { userId: 'user-1', endpoint: 'https://push.example.test/subscription-1' }],
    ]);
  });

  it('rejects invalid subscribe and unsubscribe payloads before service calls', async () => {
    const calls: unknown[] = [];
    const controller = new InternalPushController({
      getPublicKey: () => '',
      subscribe: async (input: unknown) => {
        calls.push(['subscribe', input]);
      },
      unsubscribe: async (input: unknown) => {
        calls.push(['unsubscribe', input]);
      },
    } as unknown as WebPushService);

    await assert.rejects(
      controller.subscribe({
        userId: 'user-1',
        subscription: { endpoint: 'https://push.example.test/subscription-1', keys: {} },
      }),
      (error: unknown) => {
        assert.equal(error instanceof BadRequestException, true);
        assert.equal((error as Error).message, 'Invalid subscribe payload');
        return true;
      },
    );
    await assert.rejects(
      controller.unsubscribe({ userId: 'user-1' }),
      (error: unknown) => {
        assert.equal(error instanceof BadRequestException, true);
        assert.equal((error as Error).message, 'Invalid unsubscribe payload');
        return true;
      },
    );

    assert.deepStrictEqual(calls, []);
  });
});

describe('WebPushService', () => {
  it('returns the configured public key exactly as the SPA expects it', () => {
    process.env.VAPID_PUBLIC_KEY = '  public-key-1  ';
    const { service } = createService();

    assert.equal(service.getPublicKey(), 'public-key-1');
  });

  it('upserts browser subscriptions by endpoint and resets failure state on refresh', async () => {
    const { service, state } = createService({ upsertResult: { id: 'subscription-1' } });

    const result = await service.subscribe({
      userId: 'user-1',
      endpoint: 'https://push.example.test/subscription-1',
      p256dhKey: 'p256dh-key',
      authKey: 'auth-key',
      userAgent: 'Mozilla/5.0',
    });

    assert.deepStrictEqual(result, { id: 'subscription-1' });
    assert.equal(state.upsertCalls.length, 1);
    assert.deepStrictEqual(state.upsertCalls[0], {
      where: { endpoint: 'https://push.example.test/subscription-1' },
      create: {
        userId: 'user-1',
        endpoint: 'https://push.example.test/subscription-1',
        p256dhKey: 'p256dh-key',
        authKey: 'auth-key',
        userAgent: 'Mozilla/5.0',
      },
      update: {
        userId: 'user-1',
        p256dhKey: 'p256dh-key',
        authKey: 'auth-key',
        userAgent: 'Mozilla/5.0',
        failureCount: 0,
        lastSeenAt: state.upsertCalls[0]?.update.lastSeenAt,
      },
      select: { id: true },
    });
    assert.equal(state.upsertCalls[0]?.update.lastSeenAt instanceof Date, true);
  });

  it('deletes only the current user subscription endpoint on unsubscribe', async () => {
    const { service, state } = createService();

    await service.unsubscribe({
      userId: 'user-1',
      endpoint: 'https://push.example.test/subscription-1',
    });

    assert.deepStrictEqual(state.deleteManyCalls, [
      { where: { userId: 'user-1', endpoint: 'https://push.example.test/subscription-1' } },
    ]);
  });

  it('does not query subscriptions or call providers when VAPID is disabled', async () => {
    const { service, state } = createService({
      subscriptions: [createSubscription({ id: 'subscription-1' })],
    });
    const providerCalls: unknown[] = [];
    setWebPushSendNotification(async (...args) => {
      providerCalls.push(args);
      return {} as webpush.SendResult;
    });

    await service.sendToUser({ userId: 'user-1', title: 'Hello', body: 'World' });

    assert.deepStrictEqual(state.findManyCalls, []);
    assert.deepStrictEqual(providerCalls, []);
  });

  it('sends current notification payloads and refreshes subscription health on success', async () => {
    const providerCalls: unknown[] = [];
    const { service, state } = createService({
      subscriptions: [createSubscription({ id: 'subscription-1' })],
    });
    enableWebPush(service);
    setWebPushSendNotification(async (...args) => {
      providerCalls.push(args);
      return {} as webpush.SendResult;
    });

    await service.sendToUser({ userId: 'user-1', title: 'Hello', body: 'World', url: '/notifications' });

    assert.deepStrictEqual(state.findManyCalls, [{ where: { userId: 'user-1' } }]);
    assert.equal(providerCalls.length, 1);
    assert.deepStrictEqual(providerCalls[0], [
      {
        endpoint: 'https://push.example.test/subscription-1',
        keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
      },
      JSON.stringify({ title: 'Hello', body: 'World', url: '/notifications' }),
      { TTL: 60 },
    ]);
    assert.equal(state.updateCalls.length, 1);
    assert.deepStrictEqual(state.updateCalls[0], {
      where: { id: 'subscription-1' },
      data: { failureCount: 0, lastSeenAt: state.updateCalls[0]?.data.lastSeenAt },
    });
    assert.equal(state.updateCalls[0]?.data.lastSeenAt instanceof Date, true);
  });

  it('deletes permanently gone subscriptions after provider 404 or 410 responses', async () => {
    const { service, state } = createService({
      subscriptions: [createSubscription({ id: 'subscription-dead' })],
    });
    enableWebPush(service);
    setWebPushSendNotification(async () => {
      throw { statusCode: 410 };
    });

    await service.sendToUser({ userId: 'user-1', title: 'Hello', body: 'World' });

    assert.deepStrictEqual(state.deleteCalls, [{ where: { id: 'subscription-dead' } }]);
    assert.deepStrictEqual(state.updateCalls, []);
  });

  it('increments transient failure counts and evicts after the current threshold', async () => {
    const { service, state } = createService({
      subscriptions: [
        createSubscription({ id: 'subscription-retry', failureCount: 1 }),
        createSubscription({ id: 'subscription-evict', failureCount: 2 }),
      ],
    });
    enableWebPush(service);
    setWebPushSendNotification(async () => {
      throw { statusCode: 503 };
    });

    await service.sendToUser({ userId: 'user-1', title: 'Hello', body: 'World' });

    assert.deepStrictEqual(state.updateCalls, [
      { where: { id: 'subscription-retry' }, data: { failureCount: 2 } },
    ]);
    assert.deepStrictEqual(state.deleteCalls, [{ where: { id: 'subscription-evict' } }]);
  });
});

function route(methodName: keyof InternalPushController): {
  readonly path: string | undefined;
  readonly method: RequestMethod | undefined;
  readonly httpCode: number | undefined;
} {
  const method = InternalPushController.prototype[methodName] as object;
  return {
    path: Reflect.getMetadata(PATH_METADATA, method) as string | undefined,
    method: Reflect.getMetadata(METHOD_METADATA, method) as RequestMethod | undefined,
    httpCode: Reflect.getMetadata(HTTP_CODE_METADATA, method) as number | undefined,
  };
}

function createService(input: {
  readonly upsertResult?: { readonly id: string };
  readonly subscriptions?: readonly WebPushSubscription[];
} = {}): {
  readonly service: WebPushService;
  readonly state: {
    readonly upsertCalls: UpsertCall[];
    readonly deleteManyCalls: unknown[];
    readonly findManyCalls: unknown[];
    readonly updateCalls: UpdateCall[];
    readonly deleteCalls: unknown[];
  };
} {
  const state = {
    upsertCalls: [] as UpsertCall[],
    deleteManyCalls: [] as unknown[],
    findManyCalls: [] as unknown[],
    updateCalls: [] as UpdateCall[],
    deleteCalls: [] as unknown[],
  };
  const prisma = {
    webPushSubscription: {
      upsert: async (args: UpsertCall) => {
        state.upsertCalls.push(args);
        return input.upsertResult ?? { id: 'subscription-1' };
      },
      deleteMany: async (args: unknown) => {
        state.deleteManyCalls.push(args);
        return { count: 1 };
      },
      findMany: async (args: unknown) => {
        state.findManyCalls.push(args);
        return [...(input.subscriptions ?? [])];
      },
      update: async (args: UpdateCall) => {
        state.updateCalls.push(args);
        return createSubscription({ id: args.where.id, failureCount: args.data.failureCount ?? 0 });
      },
      delete: async (args: unknown) => {
        state.deleteCalls.push(args);
        return createSubscription({ id: 'deleted-subscription' });
      },
    },
  };
  return { service: new WebPushService(prisma as never), state };
}

interface UpsertCall {
  readonly where: { readonly endpoint: string };
  readonly create: {
    readonly userId: string;
    readonly endpoint: string;
    readonly p256dhKey: string;
    readonly authKey: string;
    readonly userAgent: string | null;
  };
  readonly update: {
    readonly userId: string;
    readonly p256dhKey: string;
    readonly authKey: string;
    readonly userAgent: string | null;
    readonly failureCount: number;
    readonly lastSeenAt: Date;
  };
  readonly select: { readonly id: true };
}

interface UpdateCall {
  readonly where: { readonly id: string };
  readonly data: { readonly failureCount: number; readonly lastSeenAt?: Date };
}

function createSubscription(input: {
  readonly id: string;
  readonly userId?: string;
  readonly endpoint?: string;
  readonly p256dhKey?: string;
  readonly authKey?: string;
  readonly userAgent?: string | null;
  readonly failureCount?: number;
}): WebPushSubscription {
  return {
    id: input.id,
    userId: input.userId ?? 'user-1',
    endpoint: input.endpoint ?? `https://push.example.test/${input.id}`,
    p256dhKey: input.p256dhKey ?? 'p256dh-key',
    authKey: input.authKey ?? 'auth-key',
    userAgent: input.userAgent ?? null,
    failureCount: input.failureCount ?? 0,
    createdAt: new Date('2026-04-20T10:00:00.000Z'),
    lastSeenAt: new Date('2026-04-20T10:00:00.000Z'),
  };
}

function enableWebPush(service: WebPushService): void {
  (service as unknown as { vapidConfigured: boolean }).vapidConfigured = true;
}

function setWebPushSendNotification(next: typeof webpush.sendNotification): void {
  mutableWebPush.sendNotification = next;
}

function clearVapidEnv(): void {
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_CONTACT_EMAIL;
}
