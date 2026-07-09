import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BroadcastAudience, BroadcastMessageStatus, BroadcastStatus } from '@prisma/client';

import { BroadcastDeliveryService } from '../src/modules/broadcast/services/broadcast-delivery.service';

/** Minimal BotNotifierClient stub. `messageId` is the value notifyUser resolves to. */
function botNotifier(
  messageId: number | null,
  calls?: unknown[],
  options?: { readonly isEnabled?: boolean; readonly broadcastCalls?: unknown[] },
): never {
  return {
    notifyUser: async (input: unknown) => {
      calls?.push(input);
      return messageId;
    },
    notifyBroadcast: async (input: unknown) => {
      options?.broadcastCalls?.push(input);
    },
    isEnabled: options?.isEnabled ?? true,
  } as never;
}

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
              select: {
                id: true,
                status: true,
                audience: true,
                audienceFilter: true,
                payload: true,
                promoCode: true,
              },
            });
            return {
              id: 'broadcast-1',
              status: BroadcastStatus.DRAFT,
              audience: BroadcastAudience.TRIAL,
              audienceFilter: null,
              payload: null,
              promoCode: null,
            };
          },
          updateMany: async (args: unknown) => {
            broadcastUpdates.push(args);
            return { count: 1 };
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
      { getDecryptedBotToken: async () => null } as never,
      botNotifier(null),
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

  it('posts once to the configured Telegram channel when staging, independent of recipient fanout', async () => {
    const broadcastCalls: unknown[] = [];
    const service = new BroadcastDeliveryService(
      {
        broadcast: {
          findUnique: async () => ({
            id: 'broadcast-1',
            status: BroadcastStatus.DRAFT,
            audience: BroadcastAudience.ALL,
            audienceFilter: null,
            payload: { text: 'Channel news', telegramChannelChatId: '-100123' },
            promoCode: null,
          }),
          updateMany: async () => ({ count: 1 }),
          update: async () => undefined,
        },
        user: {
          findMany: async () => [{ id: 'user-1' }],
        },
        broadcastMessage: {
          createMany: async () => undefined,
          findMany: async () => [{ id: 'message-1' }],
        },
      } as never,
      configService('bot-token'),
      { info: () => undefined } as never,
      { create: async () => 'evt' } as never,
      { getDecryptedBotToken: async () => null } as never,
      botNotifier(null, undefined, { isEnabled: true, broadcastCalls }),
    );

    await service.stageRecipients('broadcast-1');

    assert.equal(broadcastCalls.length, 1);
    const call = broadcastCalls[0] as { readonly chatId: string; readonly text: string };
    assert.equal(call.chatId, '-100123');
    assert.equal(call.text.includes('Channel news'), true);
  });

  it('skips the channel post silently when the reiwa relay is disabled', async () => {
    const broadcastCalls: unknown[] = [];
    const service = new BroadcastDeliveryService(
      {
        broadcast: {
          findUnique: async () => ({
            id: 'broadcast-1',
            status: BroadcastStatus.DRAFT,
            audience: BroadcastAudience.ALL,
            audienceFilter: null,
            payload: { text: 'Channel news', telegramChannelChatId: '-100123' },
            promoCode: null,
          }),
          updateMany: async () => ({ count: 1 }),
          update: async () => undefined,
        },
        user: { findMany: async () => [] },
        broadcastMessage: { createMany: async () => undefined, findMany: async () => [] },
      } as never,
      configService('bot-token'),
      { info: () => undefined } as never,
      { create: async () => 'evt' } as never,
      { getDecryptedBotToken: async () => null } as never,
      botNotifier(null, undefined, { isEnabled: false, broadcastCalls }),
    );

    await service.stageRecipients('broadcast-1');

    assert.equal(broadcastCalls.length, 0);
  });

  it('no-ops staging (no channel post, no rows) when the atomic claim is lost to a retry', async () => {
    const broadcastCalls: unknown[] = [];
    const createManyCalls: unknown[] = [];
    const service = new BroadcastDeliveryService(
      {
        broadcast: {
          findUnique: async () => ({
            id: 'broadcast-1',
            status: BroadcastStatus.DRAFT,
            audience: BroadcastAudience.ALL,
            audienceFilter: null,
            payload: { text: 'Channel news', telegramChannelChatId: '-100123' },
            promoCode: null,
          }),
          // Claim lost (another attempt already flipped DRAFT→PROCESSING).
          updateMany: async () => ({ count: 0 }),
          update: async () => undefined,
        },
        user: { findMany: async () => [{ id: 'user-1' }] },
        broadcastMessage: {
          createMany: async (args: unknown) => {
            createManyCalls.push(args);
          },
          findMany: async () => [{ id: 'message-1' }],
        },
      } as never,
      configService('bot-token'),
      { info: () => undefined } as never,
      { create: async () => 'evt' } as never,
      { getDecryptedBotToken: async () => null } as never,
      botNotifier(null, undefined, { isEnabled: true, broadcastCalls }),
    );

    assert.deepStrictEqual(await service.stageRecipients('broadcast-1'), []);
    // Neither a channel post nor recipient rows on a lost claim.
    assert.equal(broadcastCalls.length, 0);
    assert.equal(createManyCalls.length, 0);
  });

  it('marks the broadcast FAILED (never stuck PROCESSING) when staging throws after the claim', async () => {
    const broadcastUpdates: unknown[] = [];
    const service = new BroadcastDeliveryService(
      {
        broadcast: {
          findUnique: async () => ({
            id: 'broadcast-1',
            status: BroadcastStatus.DRAFT,
            audience: BroadcastAudience.ALL,
            audienceFilter: null,
            payload: { text: 'News' },
            promoCode: null,
          }),
          updateMany: async () => ({ count: 1 }),
          update: async (args: unknown) => {
            broadcastUpdates.push(args);
          },
        },
        // resolveRecipients throws → post-claim failure path.
        user: {
          findMany: async () => {
            throw new Error('db down');
          },
        },
        broadcastMessage: {
          createMany: async () => undefined,
          findMany: async () => [],
        },
      } as never,
      configService('bot-token'),
      { info: () => undefined } as never,
      { create: async () => 'evt' } as never,
      { getDecryptedBotToken: async () => null } as never,
      botNotifier(null, undefined, { isEnabled: false }),
    );

    assert.deepStrictEqual(await service.stageRecipients('broadcast-1'), []);
    // The catch path set a terminal FAILED status (no stuck PROCESSING).
    const failedWrite = broadcastUpdates.find((u) => {
      const data = (u as { data?: { status?: string } }).data;
      return data?.status === BroadcastStatus.FAILED;
    });
    assert.notEqual(failedWrite, undefined);
  });

  it('delivers text broadcasts via the reiwa bot and persists the returned message id', async () => {
    const fetchCalls: unknown[] = [];
    const messageUpdates: unknown[] = [];
    const broadcastUpdates: unknown[] = [];
    const createCalls: Array<{ skipTelegram?: boolean }> = [];
    const notifyCalls: unknown[] = [];
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
      { getDecryptedBotToken: async () => null } as never,
      botNotifier(777, notifyCalls),
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

    // Text goes through the reiwa bot (botNotifier), not a direct
    // api.telegram.org call. The feed create skips the fanout's Telegram leg.
    assert.equal(fetchCalls.length, 0);
    assert.equal(createCalls[0]?.skipTelegram, true);
    assert.equal(notifyCalls.length, 1);
    const messageUpdate = messageUpdates[0] as {
      readonly data: { readonly status: BroadcastMessageStatus; readonly telegramMessageId: bigint | null };
    };
    assert.equal(messageUpdate.data.status, BroadcastMessageStatus.SENT);
    // The bot-returned message id is persisted for later edit/delete.
    assert.equal(messageUpdate.data.telegramMessageId, 777n);
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
      { getDecryptedBotToken: async () => null } as never,
      botNotifier(888),
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

    // No direct Telegram call (no token), but the reiwa bot delivered it.
    assert.equal(fetchCalls.length, 0);
    assert.equal(createCalls.length, 1);
    const update = messageUpdates[0] as { readonly data: { readonly status: BroadcastMessageStatus } };
    assert.equal(update.data.status, BroadcastMessageStatus.SENT);
  });

  it('emails recipients with an address when emailEnabled is set, without affecting SENT/FAILED outcome', async () => {
    const messageUpdates: unknown[] = [];
    const emailCalls: unknown[] = [];
    const service = new BroadcastDeliveryService(
      {
        broadcast: {
          findUnique: async (args: { readonly select?: { readonly payload?: boolean } }) => {
            if (args.select?.payload) {
              return {
                id: 'broadcast-1',
                status: BroadcastStatus.PROCESSING,
                payload: { title: 'Hi', text: 'Hello user', mediaType: 'none', emailEnabled: true },
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
          findUnique: async () => ({ telegramId: null, email: '[email protected]' }),
        },
      } as never,
      configService('bot-token'),
      { info: () => undefined } as never,
      { create: async () => 'evt' } as never,
      { getDecryptedBotToken: async () => null } as never,
      botNotifier(null),
      undefined,
      {
        send: async (input: unknown) => {
          emailCalls.push(input);
        },
      } as never,
    );

    assert.deepStrictEqual(await service.deliverBatch('broadcast-1', ['message-1']), {
      sent: 1,
      failed: 0,
    });
    assert.equal(emailCalls.length, 1);
    const email = emailCalls[0] as { readonly to: string; readonly subject: string };
    assert.equal(email.to, '[email protected]');
    assert.equal(email.subject, 'Hi');
    const update = messageUpdates[0] as { readonly data: { readonly status: BroadcastMessageStatus } };
    assert.equal(update.data.status, BroadcastMessageStatus.SENT);
  });

  it('skips email delivery when emailEnabled is unset, even with an address on file', async () => {
    const emailCalls: unknown[] = [];
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
          update: async () => undefined,
          count: async () => 0,
        },
        user: {
          findUnique: async () => ({ telegramId: null, email: '[email protected]' }),
        },
      } as never,
      configService('bot-token'),
      { info: () => undefined } as never,
      { create: async () => 'evt' } as never,
      { getDecryptedBotToken: async () => null } as never,
      botNotifier(null),
      undefined,
      {
        send: async (input: unknown) => {
          emailCalls.push(input);
        },
      } as never,
    );

    await service.deliverBatch('broadcast-1', ['message-1']);
    assert.equal(emailCalls.length, 0);
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
      { getDecryptedBotToken: async () => null } as never,
      botNotifier(null),
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
    const notifyCalls: unknown[] = [];
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
      { getDecryptedBotToken: async () => null } as never,
      botNotifier(999, notifyCalls),
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

    // No Telegram at all for a web-only user — neither a direct call nor the
    // reiwa bot notify (the user has no telegramId).
    assert.equal(fetchCalls.length, 0);
    assert.equal(notifyCalls.length, 0);
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0]?.userId, 'web-user-1');
    assert.equal(createCalls[0]?.skipTelegram, true);
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
