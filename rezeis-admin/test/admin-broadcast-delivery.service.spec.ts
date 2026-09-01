import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BroadcastAudience, BroadcastMessageStatus, BroadcastStatus } from '@prisma/client';

import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { BroadcastDeliveryService } from '../src/modules/broadcast/services/broadcast-delivery.service';

/**
 * Minimal BotNotifierClient stub.
 *
 * `messageId` is what the reiwa bot echoed back, and it now decides the relay
 * STATUS as well: an id is the only evidence a Telegram message exists, so
 * `messageId !== null` is `confirmed` and a bare 2xx is `unconfirmed`. Pass
 * `relayStatus` to model the outcomes an id cannot express — a timeout, a
 * refused connection, a relay that was never configured.
 */
function botNotifier(
  messageId: number | null,
  calls?: unknown[],
  options?: {
    readonly isEnabled?: boolean;
    /**
     * Calls to the fire-and-forget `notifyBroadcast`. The channel post is a
     * `durable` relay event and must go through the queue, so on the paths
     * below this list staying EMPTY is the assertion, not a recording.
     */
    readonly broadcastCalls?: unknown[];
    readonly relayStatus?: string;
    /** Calls to `notifyDev`, which returns `Promise<void>` and drops its outcome. */
    readonly devNotifyCalls?: unknown[];
    /** Calls to `deliverRelayEvent`, the one entry point that reports an outcome. */
    readonly relayEventCalls?: Array<{ event: string; metadata: Record<string, unknown> }>;
    /** Status `deliverRelayEvent` answers with (default: a bodiless 204). */
    readonly devRelayStatus?: string;
  },
): never {
  const status = options?.relayStatus ?? (messageId !== null ? 'confirmed' : 'unconfirmed');
  return {
    notifyUser: async (input: unknown) => {
      calls?.push(input);
      return {
        status,
        messageId,
        httpStatus: status === 'confirmed' ? 200 : status === 'unconfirmed' ? 204 : null,
        detail: null,
      };
    },
    notifyBroadcast: async (input: unknown) => {
      options?.broadcastCalls?.push(input);
    },
    notifyDev: async (input: unknown) => {
      options?.devNotifyCalls?.push(input);
    },
    deliverRelayEvent: async (event: string, metadata: Record<string, unknown>) => {
      options?.relayEventCalls?.push({ event, metadata });
      const devStatus = options?.devRelayStatus ?? 'unconfirmed';
      return {
        status: devStatus,
        messageId: null,
        httpStatus: devStatus === 'unconfirmed' ? 204 : devStatus === 'confirmed' ? 200 : null,
        detail: devStatus === 'rejected' ? 'HTTP 400 Bad Request' : null,
      };
    },
    isEnabled: options?.isEnabled ?? true,
  } as never;
}

/**
 * Minimal ReiwaRelayQueueService stub.
 *
 * `enqueue` answers a boolean that means "accepted for durable delivery" and
 * never "delivered" — `false` is a job that Redis refused (the client's direct
 * fallback ran) or a relay that is not configured. Both are states the caller
 * has to be able to see, so the stub can produce either.
 */
function relayQueue(options?: {
  readonly enqueued?: Array<{ event: string; metadata: Record<string, unknown> }>;
  readonly isEnabled?: boolean;
  readonly accepted?: boolean;
}): never {
  return {
    isEnabled: options?.isEnabled ?? true,
    enqueue: async (event: string, metadata: Record<string, unknown>) => {
      options?.enqueued?.push({ event, metadata });
      return options?.accepted ?? true;
    },
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
      relayQueue(),
      // Promo gate dependency (position 8). Answers "usable" so these tests
      // exercise what they are about; the gate itself is covered separately.
      { checkPromoCodeDispatchable: async () => ({ ok: true }) } as never,
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
    // The staging progress event keeps `system.broadcast_sent`: splitting the
    // undelivered channel post off into its own type must not quietly move
    // this one too, or every subscriber to "broadcast sent" goes silent.
    const staging = eventCalls.find((args) =>
      JSON.stringify(args).includes('recipientCount'),
    ) as readonly unknown[] | undefined;
    // Staging raises BROADCAST_STARTED. It used to raise the very card the
    // finaliser raises — 📢 «Рассылка отправлена» — before a single message
    // had gone anywhere, so the operator was told a broadcast was sent twice
    // per broadcast and the first one was a lie.
    assert.equal(staging?.[0], EVENT_TYPES.BROADCAST_STARTED);
  });

  it('hands the channel post to the durable relay queue, never to a one-shot notifier call', async () => {
    // The operator-channel copy used to go out through
    // `BotNotifierClient.notifyBroadcast`, which made it the only producer of
    // `reiwa.channel.broadcast` — a `durable`, four-attempt event — that got
    // exactly one attempt, and the only one whose failure was unobservable
    // (the method returns `Promise<void>`; `deliver()` never throws).
    const broadcastCalls: unknown[] = [];
    const enqueued: Array<{ event: string; metadata: Record<string, unknown> }> = [];
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
      relayQueue({ enqueued }),
      // Promo gate dependency (position 8). Answers "usable" so these tests
      // exercise what they are about; the gate itself is covered separately.
      { checkPromoCodeDispatchable: async () => ({ ok: true }) } as never,
    );

    await service.stageRecipients('broadcast-1');

    assert.deepStrictEqual(
      broadcastCalls,
      [],
      'the channel post must not bypass the queue with a direct notifier call',
    );
    assert.equal(enqueued.length, 1, 'exactly one channel post per staged broadcast');
    const job = enqueued[0];
    assert.equal(job?.event, 'reiwa.channel.broadcast');
    assert.equal(job?.metadata['chatId'], '-100123');
    assert.equal(String(job?.metadata['text']).includes('Channel news'), true);
    // The stable key is what makes the retries safe: the queue derives its
    // `jobId` from it and the bot dedups replays on it, so no attempt of this
    // job can become a second post in the channel.
    assert.equal(job?.metadata['eventId'], 'broadcast-channel:broadcast-1');
  });

  it('records a channel post the queue would not accept, instead of losing it', async () => {
    // `enqueue` answers `false` when Redis refused the job (the client's single
    // direct fallback ran) or the relay is unconfigured. Nothing durable is
    // holding the post at that point, and the operator asked for it — so it
    // has to reach a surface they can see. The old code could not report this
    // at all: its `catch` was unreachable on a delivery failure.
    const events: Array<{ type: string; severity: string; message: string; metadata?: unknown }> = [];
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
      {
        info: (type: string, _c: string, message: string, metadata?: unknown) =>
          events.push({ type, severity: 'INFO', message, metadata }),
        warn: (type: string, _c: string, message: string, metadata?: unknown) =>
          events.push({ type, severity: 'WARNING', message, metadata }),
      } as never,
      { create: async () => 'evt' } as never,
      { getDecryptedBotToken: async () => null } as never,
      botNotifier(null, undefined, { isEnabled: true }),
      relayQueue({ accepted: false }),
      // Promo gate dependency (position 8). Answers "usable" so these tests
      // exercise what they are about; the gate itself is covered separately.
      { checkPromoCodeDispatchable: async () => ({ ok: true }) } as never,
    );

    await service.stageRecipients('broadcast-1');

    const warning = events.find((e) => e.severity === 'WARNING');
    assert.ok(
      warning,
      'a channel post that never entered durable delivery must raise an operator-visible event',
    );
    assert.equal(
      JSON.stringify(warning.metadata).includes('dropped'),
      true,
      `the event must say what happened; got ${JSON.stringify(warning)}`,
    );

    // …and under its own name. This warning used to be emitted as
    // `system.broadcast_sent`, whose card is presented as 📢 «Рассылка
    // отправлена» — a headline claiming the exact thing the body denies. Worse
    // than cosmetic: every tick-box, filter and automation rule watching for
    // "broadcast sent" fired here, in the middle of staging, on a failure.
    assert.equal(
      warning.type,
      EVENT_TYPES.BROADCAST_CHANNEL_POST_UNDELIVERED,
      'an undelivered channel post needs a type that says so',
    );
    assert.notEqual(
      warning.type,
      EVENT_TYPES.SYSTEM_BROADCAST_SENT,
      'a failure must not be filed under the success everyone subscribes to',
    );
  });

  it('never queues a channel post when the reiwa relay is disabled, and says so', async () => {
    const broadcastCalls: unknown[] = [];
    const enqueued: Array<{ event: string; metadata: Record<string, unknown> }> = [];
    const events: Array<{ type: string; severity: string; metadata?: unknown }> = [];
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
      {
        info: (type: string, _c: string, _m: string, metadata?: unknown) =>
          events.push({ type, severity: 'INFO', metadata }),
        warn: (type: string, _c: string, _m: string, metadata?: unknown) =>
          events.push({ type, severity: 'WARNING', metadata }),
      } as never,
      { create: async () => 'evt' } as never,
      { getDecryptedBotToken: async () => null } as never,
      botNotifier(null, undefined, { isEnabled: false, broadcastCalls }),
      relayQueue({ enqueued, isEnabled: false }),
      // Promo gate dependency (position 8). Answers "usable" so these tests
      // exercise what they are about; the gate itself is covered separately.
      { checkPromoCodeDispatchable: async () => ({ ok: true }) } as never,
    );

    await service.stageRecipients('broadcast-1');

    assert.deepStrictEqual(broadcastCalls, []);
    assert.deepStrictEqual(
      enqueued,
      [],
      'queuing against an unconfigured relay banks jobs that can only fail',
    );
    // Silent about the network, not about the operator: they set a channel id
    // on this broadcast and it is never going to be posted.
    const warning = events.find((e) => e.severity === 'WARNING');
    assert.ok(warning, 'a configured channel that cannot be reached must be reported');
    assert.equal(JSON.stringify(warning.metadata).includes('disabled'), true);
    assert.equal(warning.type, EVENT_TYPES.BROADCAST_CHANNEL_POST_UNDELIVERED);
  });

  it('no-ops staging (no channel post, no rows) when the atomic claim is lost to a retry', async () => {
    const broadcastCalls: unknown[] = [];
    const enqueued: Array<{ event: string; metadata: Record<string, unknown> }> = [];
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
      relayQueue({ enqueued }),
      // Promo gate dependency (position 8). Answers "usable" so these tests
      // exercise what they are about; the gate itself is covered separately.
      { checkPromoCodeDispatchable: async () => ({ ok: true }) } as never,
    );

    assert.deepStrictEqual(await service.stageRecipients('broadcast-1'), []);
    // Neither a channel post nor recipient rows on a lost claim. The claim is
    // what makes queuing the post safe: it is the guarantee that exactly one
    // job is ever enqueued for this broadcast.
    assert.equal(broadcastCalls.length, 0);
    assert.deepStrictEqual(enqueued, []);
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
      relayQueue(),
      // Promo gate dependency (position 8). Answers "usable" so these tests
      // exercise what they are about; the gate itself is covered separately.
      { checkPromoCodeDispatchable: async () => ({ ok: true }) } as never,
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
        // `deliverBatch` asks the feed which recipients already have their row
        // for this broadcast; nobody does on a first pass.
        userNotificationEvent: { findMany: async () => [] },
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
      relayQueue(),
      // Promo gate dependency (position 8). Answers "usable" so these tests
      // exercise what they are about; the gate itself is covered separately.
      { checkPromoCodeDispatchable: async () => ({ ok: true }) } as never,
    );

    await withFetch(async (input, init) => {
      fetchCalls.push({ input, init });
      return { ok: true, json: async () => ({}), text: async () => '' } as Response;
    }, async () => {
      assert.deepStrictEqual(await service.deliverBatch('broadcast-1', ['message-1']), {
        sent: 1,
        failed: 0,
        unresolved: 0,
        emailAttempted: 0,
        emailSent: 0,
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
        // `deliverBatch` asks the feed which recipients already have their row
        // for this broadcast; nobody does on a first pass.
        userNotificationEvent: { findMany: async () => [] },
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
      relayQueue(),
      // Promo gate dependency (position 8). Answers "usable" so these tests
      // exercise what they are about; the gate itself is covered separately.
      { checkPromoCodeDispatchable: async () => ({ ok: true }) } as never,
    );

    await withFetch(async (input, init) => {
      fetchCalls.push({ input, init });
      return { ok: true, json: async () => ({}), text: async () => '' } as Response;
    }, async () => {
      assert.deepStrictEqual(await service.deliverBatch('broadcast-1', ['message-1']), {
        sent: 1,
        failed: 0,
        unresolved: 0,
        emailAttempted: 0,
        emailSent: 0,
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
        // `deliverBatch` asks the feed which recipients already have their row
        // for this broadcast; nobody does on a first pass.
        userNotificationEvent: { findMany: async () => [] },
        user: {
          findUnique: async () => ({ telegramId: null, email: '[email protected]' }),
        },
      } as never,
      configService('bot-token'),
      { info: () => undefined } as never,
      { create: async () => 'evt' } as never,
      { getDecryptedBotToken: async () => null } as never,
      botNotifier(null),
      relayQueue(),
      // Promo gate dependency (position 8). Answers "usable" so these tests
      // exercise what they are about; the gate itself is covered separately.
      { checkPromoCodeDispatchable: async () => ({ ok: true }) } as never,
      undefined,
      {
        send: async (input: unknown) => {
          emailCalls.push(input);
        },
      } as never,
    );

    // The tally is the point: the channel had no counter of any kind, so an
    // operator could not tell one letter sent from none, and a broadcast with
    // SMTP switched off still reported completion.
    assert.deepStrictEqual(await service.deliverBatch('broadcast-1', ['message-1']), {
      sent: 1,
      failed: 0,
      unresolved: 0,
      emailAttempted: 1,
      emailSent: 1,
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
        // `deliverBatch` asks the feed which recipients already have their row
        // for this broadcast; nobody does on a first pass.
        userNotificationEvent: { findMany: async () => [] },
        user: {
          findUnique: async () => ({ telegramId: null, email: '[email protected]' }),
        },
      } as never,
      configService('bot-token'),
      { info: () => undefined } as never,
      { create: async () => 'evt' } as never,
      { getDecryptedBotToken: async () => null } as never,
      botNotifier(null),
      relayQueue(),
      // Promo gate dependency (position 8). Answers "usable" so these tests
      // exercise what they are about; the gate itself is covered separately.
      { checkPromoCodeDispatchable: async () => ({ ok: true }) } as never,
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
        // `deliverBatch` asks the feed which recipients already have their row
        // for this broadcast; nobody does on a first pass.
        userNotificationEvent: { findMany: async () => [] },
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
      relayQueue(),
      // Promo gate dependency (position 8). Answers "usable" so these tests
      // exercise what they are about; the gate itself is covered separately.
      { checkPromoCodeDispatchable: async () => ({ ok: true }) } as never,
    );

    await withFetch(async () => {
      throw new Error('telegram outage https://api.telegram.org/botbot-token/sendMessage chat 12345 secret');
    }, async () => {
      assert.deepStrictEqual(await service.deliverBatch('broadcast-1', ['message-1']), {
        sent: 0,
        failed: 1,
        unresolved: 0,
        emailAttempted: 0,
        emailSent: 0,
      });
    });

    const persisted = JSON.stringify(messageUpdates);
    assert.equal(persisted.includes('bot-token'), false);
    assert.equal(persisted.includes('12345'), false);
    assert.equal(persisted.includes('api.telegram.org'), false);
    assert.equal(persisted.includes('[telegram api url hidden]'), true);
    assert.equal(persisted.includes('[chat-id hidden]'), true);
  });

  it('marks FAILED when the media Telegram send fails, even though the feed row landed', async () => {
    const messageUpdates: Array<{ data: Record<string, unknown> }> = [];
    const service = new BroadcastDeliveryService(
      {
        broadcast: {
          findUnique: async (args: { readonly select?: { readonly payload?: boolean } }) => {
            if (args.select?.payload) {
              return {
                id: 'broadcast-1',
                status: BroadcastStatus.PROCESSING,
                payload: { text: 'Hello', mediaType: 'photo', mediaFileId: 'file-1' },
              };
            }
            return { status: BroadcastStatus.PROCESSING };
          },
          update: async () => undefined,
        },
        broadcastMessage: {
          findMany: async () => [{ id: 'message-1', userId: 'user-1' }],
          update: async (args: { data: Record<string, unknown> }) => {
            messageUpdates.push(args);
          },
          count: async () => 0,
        },
        // `deliverBatch` asks the feed which recipients already have their row
        // for this broadcast; nobody does on a first pass.
        userNotificationEvent: { findMany: async () => [] },
        user: {
          findUnique: async () => ({ telegramId: 12345n }),
        },
      } as never,
      configService('bot-token'),
      { info: () => undefined } as never,
      // Cabinet feed row succeeds → the message is a real in-app surface.
      { create: async () => 'event-1' } as never,
      { getDecryptedBotToken: async () => null } as never,
      botNotifier(null),
      relayQueue(),
      // Promo gate dependency (position 8). Answers "usable" so these tests
      // exercise what they are about; the gate itself is covered separately.
      { checkPromoCodeDispatchable: async () => ({ ok: true }) } as never,
    );

    // Media Telegram send fails.
    //
    // This used to be SENT-with-an-errorMessage: the cabinet feed row counted
    // as delivery, and the photo that never arrived was a footnote on a green
    // row. It is now FAILED. A Telegram delivery WAS attempted for this
    // recipient and did not happen, and an operator counting a media
    // broadcast's reach must not be handed a success for it. The feed row
    // still exists either way — what changed is which number they are given.
    await withFetch(async () => {
      throw new Error('telegram outage');
    }, async () => {
      assert.deepStrictEqual(await service.deliverBatch('broadcast-1', ['message-1']), {
        sent: 0,
        failed: 1,
        unresolved: 0,
        emailAttempted: 0,
        emailSent: 0,
      });
    });

    const sentRow = messageUpdates.find((u) => u.data.status === BroadcastMessageStatus.SENT);
    assert.equal(sentRow, undefined, 'an unproven Telegram attempt must not read as SENT');
    const failed = messageUpdates.find((u) => u.data.status === BroadcastMessageStatus.FAILED);
    assert.ok(failed, 'the attempted-and-unproven delivery is recorded as failed');
    assert.ok(
      typeof failed.data.errorMessage === 'string' &&
        (failed.data.errorMessage as string).length > 0,
      'with the media failure as the reason',
    );
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
        // `deliverBatch` asks the feed which recipients already have their row
        // for this broadcast; nobody does on a first pass.
        userNotificationEvent: { findMany: async () => [] },
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
      relayQueue(),
      // Promo gate dependency (position 8). Answers "usable" so these tests
      // exercise what they are about; the gate itself is covered separately.
      { checkPromoCodeDispatchable: async () => ({ ok: true }) } as never,
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
          unresolved: 0,
          emailAttempted: 0,
          emailSent: 0,
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

  // ═══════════════════════════════════════════════════════════════════════
  //  TEST SEND — the button reports what its attempts proved
  // ═══════════════════════════════════════════════════════════════════════

  it('reports the dev preview through the entry point that returns an outcome', async () => {
    const devNotifyCalls: unknown[] = [];
    const relayEventCalls: Array<{ event: string; metadata: Record<string, unknown> }> = [];
    const service = testSendService({
      devUsers: [],
      notifier: { devNotifyCalls, relayEventCalls, devRelayStatus: 'unconfirmed' },
    });

    assert.deepStrictEqual(await service.sendTestToDev('broadcast-1'), { ok: true });
    assert.deepStrictEqual(
      devNotifyCalls,
      [],
      '`notifyDev` returns Promise<void> — a button cannot report an outcome it never receives',
    );
    assert.equal(relayEventCalls.length, 1);
    assert.equal(relayEventCalls[0]?.event, 'reiwa.dev.notify');
    assert.equal(String(relayEventCalls[0]?.metadata['text']).includes('Preview body'), true);
  });

  it('does not report a test preview as sent when the dev relay refused it', async () => {
    // No DEV users, so the cabinet leg cannot rescue the answer: the relay is
    // the only surface, and it said no. `relayed = true` used to be set
    // unconditionally right after the call, so the operator saw `{ ok: true }`.
    const service = testSendService({
      devUsers: [],
      notifier: { devRelayStatus: 'rejected' },
    });

    assert.deepStrictEqual(await service.sendTestToDev('broadcast-1'), {
      ok: false,
      reason: 'relay-rejected',
    });
  });

  it('does not report a test preview as sent when every dev cabinet write failed', async () => {
    // The same lie on the other leg: the count that decided success was the
    // number of DEV rows FOUND, while each `create()` sits in a `catch` that
    // logs and moves on. Two DEV users and zero deliveries used to read as ok.
    const service = testSendService({
      devUsers: ['dev-1', 'dev-2'],
      relayEnabled: false,
      cabinetThrows: true,
    });

    assert.deepStrictEqual(await service.sendTestToDev('broadcast-1'), {
      ok: false,
      reason: 'cabinet-failed',
    });
  });

  it('still reports success when one surface delivered', async () => {
    // The point is not to make the button pessimistic. A refused relay with a
    // cabinet row that landed is a preview the dev can actually read.
    const service = testSendService({
      devUsers: ['dev-1'],
      notifier: { devRelayStatus: 'timeout' },
    });

    assert.deepStrictEqual(await service.sendTestToDev('broadcast-1'), { ok: true });
  });
});

/**
 * `sendTestToDev` harness. The draft has content, so the only things that vary
 * are what the two delivery surfaces answer.
 */
function testSendService(input: {
  readonly devUsers: readonly string[];
  readonly relayEnabled?: boolean;
  readonly cabinetThrows?: boolean;
  readonly notifier?: {
    readonly devNotifyCalls?: unknown[];
    readonly relayEventCalls?: Array<{ event: string; metadata: Record<string, unknown> }>;
    readonly devRelayStatus?: string;
  };
}): BroadcastDeliveryService {
  return new BroadcastDeliveryService(
    {
      broadcast: {
        findUnique: async () => ({ payload: { title: 'Preview', text: 'Preview body' } }),
      },
      user: {
        findMany: async () => input.devUsers.map((id) => ({ id })),
      },
    } as never,
    configService(null),
    { info: () => undefined, warn: () => undefined } as never,
    {
      create: async () => {
        if (input.cabinetThrows === true) throw new Error('cabinet down');
        return 'evt';
      },
    } as never,
    { getDecryptedBotToken: async () => null } as never,
    botNotifier(null, undefined, {
      isEnabled: input.relayEnabled ?? true,
      devNotifyCalls: input.notifier?.devNotifyCalls,
      relayEventCalls: input.notifier?.relayEventCalls,
      devRelayStatus: input.notifier?.devRelayStatus,
    }),
    relayQueue(),
      // Promo gate dependency (position 8). Answers "usable" so these tests
      // exercise what they are about; the gate itself is covered separately.
      { checkPromoCodeDispatchable: async () => ({ ok: true }) } as never,
  );
}

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
