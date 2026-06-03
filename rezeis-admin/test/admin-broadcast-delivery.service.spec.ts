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
                isBotBlocked: false,
                telegramId: { not: null },
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

  it('delivers text broadcasts through Telegram and finalizes completed batches', async () => {
    const fetchCalls: unknown[] = [];
    const messageUpdates: unknown[] = [];
    const broadcastUpdates: unknown[] = [];
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
          findMany: async (args: unknown) => {
            assert.deepStrictEqual(args, {
              where: { id: { in: ['message-1'] }, status: BroadcastMessageStatus.PENDING },
              select: { id: true, userId: true },
            });
            return [{ id: 'message-1', userId: 'user-1' }];
          },
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
          findUnique: async (args: unknown) => {
            assert.deepStrictEqual(args, {
              where: { id: 'user-1' },
              select: { telegramId: true },
            });
            return { telegramId: 12345n };
          },
        },
      } as never,
      configService('bot-token'),
      { info: () => undefined } as never,
    );

    await withFetch(async (input, init) => {
      fetchCalls.push({ input, init });
      return {
        ok: true,
        json: async () => ({ result: { message_id: 42 } }),
        text: async () => '',
      } as Response;
    }, async () => {
      assert.deepStrictEqual(await service.deliverBatch('broadcast-1', ['message-1']), {
        sent: 1,
        failed: 0,
      });
    });

    assert.equal((fetchCalls[0] as { readonly input: string }).input, 'https://api.telegram.org/botbot-token/sendMessage');
    assert.deepStrictEqual(
      JSON.parse((fetchCalls[0] as { readonly init: { readonly body: string } }).init.body),
      { chat_id: '12345', text: 'Hello user', parse_mode: 'HTML' },
    );
    const messageUpdate = messageUpdates[0] as {
      readonly data: { readonly status: BroadcastMessageStatus; readonly telegramMessageId: bigint };
    };
    assert.equal(messageUpdate.data.status, BroadcastMessageStatus.SENT);
    assert.equal(messageUpdate.data.telegramMessageId, 42n);
    assert.equal(JSON.stringify(broadcastUpdates).includes(BroadcastStatus.COMPLETED), true);
  });

  it('marks the batch failed and finalizes when BOT_TOKEN is missing', async () => {
    const updateManyCalls: unknown[] = [];
    const broadcastUpdates: unknown[] = [];
    const service = new BroadcastDeliveryService(
      {
        broadcast: {
          findUnique: async () => ({ status: BroadcastStatus.PROCESSING }),
          update: async (args: unknown) => {
            broadcastUpdates.push(args);
          },
        },
        broadcastMessage: {
          updateMany: async (args: unknown) => {
            updateManyCalls.push(args);
          },
          count: async (args: { readonly where: { readonly status: BroadcastMessageStatus } }) => {
            if (args.where.status === BroadcastMessageStatus.PENDING) return 0;
            if (args.where.status === BroadcastMessageStatus.FAILED) return 2;
            return 0;
          },
        },
      } as never,
      configService(null),
      { info: () => undefined } as never,
    );

    assert.deepStrictEqual(await service.deliverBatch('broadcast-1', ['message-1', 'message-2']), {
      sent: 0,
      failed: 2,
    });
    assert.deepStrictEqual(updateManyCalls, [
      {
        where: { id: { in: ['message-1', 'message-2'] } },
        data: {
          status: BroadcastMessageStatus.FAILED,
          errorMessage: 'BOT_TOKEN not configured',
        },
      },
    ]);
    assert.equal(JSON.stringify(broadcastUpdates).includes('failedCount'), true);
  });

  it('sanitizes Telegram provider failures before persisting message errors', async () => {
    const messageUpdates: unknown[] = [];
    const service = new BroadcastDeliveryService(
      {
        broadcast: {
          findUnique: async (args: { readonly select?: { readonly payload?: boolean } }) => {
            if (args.select?.payload) {
              return {
                id: 'broadcast-1',
                status: BroadcastStatus.PROCESSING,
                payload: { text: 'Hello user', mediaType: 'none' },
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
