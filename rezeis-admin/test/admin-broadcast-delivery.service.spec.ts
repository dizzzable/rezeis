import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BroadcastAudience, BroadcastMessageStatus, BroadcastStatus } from '@prisma/client';

import { BroadcastDeliveryService } from '../src/modules/broadcast/services/broadcast-delivery.service';

describe('BroadcastDeliveryService', () => {
  it('stages current audience recipients and transitions draft broadcasts to processing', async () => {
    const createManyCalls: unknown[] = [];
    const broadcastUpdates: unknown[] = [];
    const eventCalls: unknown[] = [];
    const service = new BroadcastDeliveryService(
      {
        broadcast: {
          findUnique: async (args: unknown) => {
            assert.deepStrictEqual(args, {
              where: { id: 'broadcast-1' },
              select: { id: true, status: true, audience: true },
            });
            return {
              id: 'broadcast-1',
              status: BroadcastStatus.DRAFT,
              audience: BroadcastAudience.TRIAL,
            };
          },
          update: async (args: unknown) => {
            broadcastUpdates.push(args);
          },
        },
        user: {
          findMany: async (args: unknown) => {
            assert.deepStrictEqual(args, {
              where: {
                isBlocked: false,
                subscriptions: { some: { isTrial: true, status: 'ACTIVE' } },
              },
              select: { id: true },
            });
            return [{ id: 'user-1' }, { id: 'user-2' }];
          },
        },
        broadcastMessage: {
          createMany: async (args: unknown) => {
            createManyCalls.push(args);
          },
          findMany: async (args: unknown) => {
            assert.deepStrictEqual(args, {
              where: { broadcastId: 'broadcast-1', status: BroadcastMessageStatus.PENDING },
              select: { id: true },
              orderBy: { createdAt: 'asc' },
            });
            return [{ id: 'message-1' }, { id: 'message-2' }];
          },
        },
      } as never,
      configService('bot-token'),
      { info: (...args: unknown[]) => eventCalls.push(args) } as never,
      { create: async () => 'evt' } as never,
    );

    assert.deepStrictEqual(await service.stageRecipients('broadcast-1'), ['message-1', 'message-2']);
    assert.deepStrictEqual(createManyCalls, [
      {
        data: [
          { broadcastId: 'broadcast-1', userId: 'user-1', status: BroadcastMessageStatus.PENDING },
          { broadcastId: 'broadcast-1', userId: 'user-2', status: BroadcastMessageStatus.PENDING },
        ],
      },
    ]);
    assert.equal(JSON.stringify(broadcastUpdates).includes(BroadcastStatus.PROCESSING), true);
    assert.equal(JSON.stringify(eventCalls).includes('recipientCount'), true);
  });

  it('delivers text broadcasts via the notification fanout (no direct Telegram send)', async () => {
    const fetchCalls: unknown[] = [];
    const messageUpdates: unknown[] = [];
    const broadcastUpdates: unknown[] = [];
    const createCalls: Array<{ skipTelegram?: boolean }> = [];
    const service = new BroadcastDeliveryService(
      {
        broadcast: {
          findUnique: async (args: { readonly select?: { readonly payload?: boolean } }) => {
            if (args.select?.payload) {
              return {
                id: 'broadcast-1',
                status: BroadcastStatus.PROCESSING,
                payload: { text: 'Hello user', mediaType: 'none', parseMode: 'HTML' },
              };
            }
            return { status: BroadcastStatus.PROCESSING };
          },
          update: async (args: unknown) => {
            broadcastUpdates.push(args);
          },
        },
        broadcastMessage: {
          findMany: async () => [{ id: 'message-1', userId: 'user-1' }],
          update: async (args: unknown) => {
            messageUpdates.push(args);
          },
          count: async (args: { readonly where: { readonly status: BroadcastMessageStatus } }) => {
            if (args.where.status === BroadcastMessageStatus.PENDING) return 0;
            if (args.where.status === BroadcastMessageStatus.SENT) return 1;
            return 0;
          },
        },
        user: {
          findUnique: async () => ({ telegramId: 12345n }),
        },
      } as never,
      configService('bot-token'),
      { info: () => undefined } as never,
      {
        create: async (input: { skipTelegram?: boolean }) => {
          createCalls.push(input);
          return 'evt';
        },
      } as never,
    );

    await withFetch(async (input, init) => {
      fetchCalls.push({ input, init });
      return { ok: true, json: async () => ({}), text: async () => '' } as Response;
    }, async () => {
      assert.deepStrictEqual(await service.deliverBatch('broadcast-1', ['message-1']), {
        sent: 1,
        failed: 0,
      });
    });

    // Text broadcasts go through the reiwa bot via the fanout — no direct
    // api.telegram.org call from rezeis-admin, and skipTelegram is false so the
    // fanout itself sends the Telegram message.
    assert.equal(fetchCalls.length, 0);
    assert.equal(createCalls[0]?.skipTelegram, false);
    const messageUpdate = messageUpdates[0] as {
      readonly data: { readonly status: BroadcastMessageStatus };
    };
    assert.equal(messageUpdate.data.status, BroadcastMessageStatus.SENT);
    assert.equal(JSON.stringify(broadcastUpdates).includes(BroadcastStatus.COMPLETED), true);
  });

  it('delivers text broadcasts even when BOT_TOKEN is missing (via the reiwa bot)', async () => {
    const messageUpdates: unknown[] = [];
    const createCalls: Array<{ skipTelegram?: boolean }> = [];
    const fetchCalls: unknown[] = [];
    const service = new BroadcastDeliveryService(
      {
        broadcast: {
          findUnique: async (args: { readonly select?: { readonly payload?: boolean } }) => {
            if (args.select?.payload) {
              return {
                id: 'broadcast-1',
                status: BroadcastStatus.PROCESSING,
                payload: { text: 'Important news', mediaType: 'none' },
              };
            }
            return { status: BroadcastStatus.PROCESSING };
          },
          update: async () => undefined,
        },
        broadcastMessage: {
          findMany: async () => [{ id: 'message-1', userId: 'user-1' }],
          update: async (args: unknown) => {
            messageUpdates.push(args);
          },
          count: async (args: { readonly where: { readonly status: BroadcastMessageStatus } }) => {
            if (args.where.status === BroadcastMessageStatus.PENDING) return 0;
            if (args.where.status === BroadcastMessageStatus.SENT) return 1;
            return 0;
          },
        },
        user: {
          findUnique: async () => ({ telegramId: 12345n }),
        },
      } as never,
      configService(null),
      { info: () => undefined } as never,
      {
        create: async (input: { skipTelegram?: boolean }) => {
          createCalls.push(input);
          return 'evt';
        },
      } as never,
    );

    await withFetch(async (input, init) => {
      fetchCalls.push({ input, init });
      return { ok: true, json: async () => ({}), text: async () => '' } as Response;
    }, async () => {
      assert.deepStrictEqual(await service.deliverBatch('broadcast-1', ['message-1']), {
        sent: 1,
        failed: 0,
      });
    });

    // No direct Telegram call (no token), but the fanout delivered it.
    assert.equal(fetchCalls.length, 0);
    assert.equal(createCalls.length, 1);
    const update = messageUpdates[0] as { readonly data: { readonly status: BroadcastMessageStatus } };
    assert.equal(update.data.status, BroadcastMessageStatus.SENT);
  });

  it('sanitizes Telegram provider failures on the media path before persisting errors', async () => {
    const messageUpdates: unknown[] = [];
    const service = new BroadcastDeliveryService(
      {
        broadcast: {
          findUnique: async (args: { readonly select?: { readonly payload?: boolean } }) => {
            if (args.select?.payload) {
              return {
                id: 'broadcast-1',
                status: BroadcastStatus.PROCESSING,
                payload: { text: 'Hello user', mediaType: 'photo', mediaFileId: 'file-1' },
              };
            }
            return { status: BroadcastStatus.PROCESSING };
          },
          update: async () => undefined,
        },
        broadcastMessage: {
          findMany: async () => [{ id: 'message-1', userId: 'user-1' }],
          update: async (args: unknown) => {
            messageUpdates.push(args);
          },
          count: async () => 0,
        },
        user: {
          findUnique: async () => ({ telegramId: 12345n }),
        },
      } as never,
      configService('bot-token'),
      { info: () => undefined } as never,
      // Feed write fails too, so the message is FAILED with the (sanitized)
      // media Telegram error rather than SENT via the feed fallback.
      { create: async () => { throw new Error('feed down'); } } as never,
    );

    await withFetch(async () => {
      throw new Error('telegram outage https://api.telegram.org/botbot-token/sendMessage chat 12345 secret');
    }, async () => {
      assert.deepStrictEqual(await service.deliverBatch('broadcast-1', ['message-1']), {
        sent: 0,
        failed: 1,
      });
    });

    const persisted = JSON.stringify(messageUpdates);
    assert.equal(persisted.includes('bot-token'), false);
    assert.equal(persisted.includes('12345'), false);
    assert.equal(persisted.includes('api.telegram.org'), false);
    assert.equal(persisted.includes('[telegram api url hidden]'), true);
    assert.equal(persisted.includes('[chat-id hidden]'), true);
  });

  it('delivers to web-only users via the cabinet feed without Telegram', async () => {
    const messageUpdates: unknown[] = [];
    const createCalls: Array<{ userId: string; skipTelegram?: boolean }> = [];
    const fetchCalls: unknown[] = [];
    const service = new BroadcastDeliveryService(
      {
        broadcast: {
          findUnique: async (args: { readonly select?: { readonly payload?: boolean } }) => {
            if (args.select?.payload) {
              return {
                id: 'broadcast-1',
                status: BroadcastStatus.PROCESSING,
                payload: { text: 'News for everyone', mediaType: 'none' },
              };
            }
            return { status: BroadcastStatus.PROCESSING };
          },
          update: async () => undefined,
        },
        broadcastMessage: {
          findMany: async () => [{ id: 'message-1', userId: 'web-user-1' }],
          update: async (args: unknown) => {
            messageUpdates.push(args);
          },
          count: async (args: { readonly where: { readonly status: BroadcastMessageStatus } }) => {
            if (args.where.status === BroadcastMessageStatus.PENDING) return 0;
            if (args.where.status === BroadcastMessageStatus.SENT) return 1;
            return 0;
          },
        },
        user: {
          // Web-only user: no Telegram.
          findUnique: async () => ({ telegramId: null }),
        },
      } as never,
      configService('bot-token'),
      { info: () => undefined } as never,
      {
        create: async (input: { userId: string; skipTelegram?: boolean }) => {
          createCalls.push(input);
          return 'evt-1';
        },
      } as never,
    );

    await withFetch(
      async (input, init) => {
        fetchCalls.push({ input, init });
        return { ok: true, json: async () => ({}), text: async () => '' } as Response;
      },
      async () => {
        assert.deepStrictEqual(await service.deliverBatch('broadcast-1', ['message-1']), {
          sent: 1,
          failed: 0,
        });
      },
    );

    // No Telegram call for a web-only user.
    assert.equal(fetchCalls.length, 0);
    // Cabinet feed + web-push + (text) reiwa-Telegram via the fanout.
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0]?.userId, 'web-user-1');
    assert.equal(createCalls[0]?.skipTelegram, false);
    // Message marked SENT via the feed channel.
    const update = messageUpdates[0] as { readonly data: { readonly status: BroadcastMessageStatus } };
    assert.equal(update.data.status, BroadcastMessageStatus.SENT);
  });
});

function configService(botToken: string | null): never {
  return {
    get: (key: string) => (key === 'BOT_TOKEN' ? botToken : undefined),
  } as never;
}

async function withFetch(
  fetchImpl: typeof fetch,
  callback: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}
