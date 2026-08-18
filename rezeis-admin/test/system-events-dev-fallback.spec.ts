import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { SystemEventsService } from '../src/common/services/system-events.service';
import { BotNotifierClient } from '../src/modules/notifications/services/bot-notifier.client';
import { ReiwaRelayQueueService } from '../src/modules/notifications/services/reiwa-relay-queue.service';

/**
 * Dev-fallback delivery guarantee
 * ───────────────────────────────
 * The "Доставка в Telegram" screen promises that when delivery is OFF or no
 * group Chat ID is set, system events still reach the operator's bot DM and
 * are "не потеряются". On the standard split deployment rezeis has NO bot
 * token (the token lives in reiwa), so it cannot call the Bot API directly —
 * the dev fallback MUST therefore be routed through the reiwa relay
 * (`BotNotifierClient`), not silently dropped.
 *
 * These tests pin that contract for the screenshot scenario (delivery off +
 * a manual Dev chat ID set) and for the fully-unconfigured case.
 *
 * They also pin WHICH relay carries it. Since the durable-delivery change the
 * firehose goes through `ReiwaRelayQueueService` (retried, and recorded when it
 * gives up) rather than the one-shot `BotNotifierClient` — with one deliberate
 * exception, `reiwa.relay_undelivered`, which must stay on the direct client or
 * a cabinet outage makes the alert about the outage generate another relay job
 * forever. Counting deliveries alone cannot tell those apart, so the stubs
 * below record the route as well as the payload.
 */

interface NotifierCalls {
  notifyDev: number;
  notifyDevDocument: number;
  notifyBroadcast: number;
  notifyBroadcastDocument: number;
  lastCaption: string | null;
  lastFilename: string | null;
  lastBroadcastTopicId: number | null;
  /** Relay events handed to the durable queue, in order. */
  queued: string[];
  /** Relay events sent straight down the one-shot client, in order. */
  direct: string[];
}

function buildService(opts: {
  readonly telegram: Record<string, unknown>;
}): { service: SystemEventsService; calls: NotifierCalls } {
  const calls: NotifierCalls = {
    notifyDev: 0,
    notifyDevDocument: 0,
    notifyBroadcast: 0,
    notifyBroadcastDocument: 0,
    lastCaption: null,
    lastFilename: null,
    lastBroadcastTopicId: null,
    queued: [],
    direct: [],
  };

  // Both routes land in the same counters on purpose: the counters answer
  // "did the operator get it", `queued`/`direct` answer "by which road".
  const record = (event: string, meta: Record<string, unknown>): void => {
    if (event === 'reiwa.dev.notify') calls.notifyDev += 1;
    else if (event === 'reiwa.dev.notify.document') {
      calls.notifyDevDocument += 1;
      calls.lastCaption = (meta['caption'] as string | undefined) ?? null;
      calls.lastFilename = (meta['filename'] as string | undefined) ?? null;
    } else if (event === 'reiwa.channel.broadcast') calls.notifyBroadcast += 1;
    else if (event === 'reiwa.channel.broadcast.document') {
      calls.notifyBroadcastDocument += 1;
      calls.lastCaption = (meta['caption'] as string | undefined) ?? null;
      calls.lastFilename = (meta['filename'] as string | undefined) ?? null;
      calls.lastBroadcastTopicId = (meta['topicThreadId'] as number | undefined) ?? null;
    }
  };

  const notifier = {
    deliverRelayEvent: async (event: string, meta: Record<string, unknown>) => {
      calls.direct.push(event);
      record(event, meta);
      return { status: 'unconfirmed', messageId: null, httpStatus: 204, detail: null };
    },
  };
  const relayQueue = {
    enqueue: async (event: string, meta: Record<string, unknown>) => {
      calls.queued.push(event);
      record(event, meta);
      return true;
    },
  };

  const prisma = {
    settings: {
      findFirst: async () => ({ systemNotifications: { telegram: opts.telegram } }),
    },
    adminAuditLog: { create: async () => ({}) },
  };

  const webhookConfiguration = { enabled: false, urls: [] };

  // Truthy http service so deliverTelegram does not early-return; its `.post`
  // must never be reached on the token-less dev-fallback path.
  const httpService = {
    post: () => {
      throw new Error('Bot API must not be called without a token');
    },
  };

  const moduleRef = {
    get: (token: unknown) => {
      if (token === BotNotifierClient) return notifier;
      if (token === ReiwaRelayQueueService) return relayQueue;
      throw new Error('not registered');
    },
  };

  const service = new SystemEventsService(
    prisma as never,
    webhookConfiguration as never,
    httpService as never,
    moduleRef as never,
  );
  return { service, calls };
}

/** Let the fire-and-forget delivery microtasks settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('SystemEventsService dev-fallback (no bot token)', () => {
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.BOT_TOKEN;
    delete process.env.BOT_TOKEN;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = savedToken;
  });

  it('delivers an ERROR via reiwa when delivery is OFF but a Dev chat ID is set', async () => {
    const { service, calls } = buildService({
      telegram: {
        enabled: false,
        chatId: null,
        devChatId: '813364774',
        errorReports: { mode: 'manual', telegramTxt: true },
      },
    });

    service.error('reiwa.error', 'SYSTEM', '[reiwa:bot] boom', { source: 'bot', stack: 'at x' });
    await flush();

    // The event is NOT dropped: it goes out as a document (card caption + .txt)
    // through the reiwa relay, exactly like the configured-group path.
    assert.equal(calls.notifyDevDocument, 1);
    assert.equal(calls.notifyDev, 0);
    assert.ok(calls.lastCaption?.includes('#EventError'));
    assert.ok(calls.lastFilename?.startsWith('error_'));
    // Durable road: retried, and recorded if it ever gives up.
    assert.deepStrictEqual(calls.queued, ['reiwa.dev.notify.document']);
    assert.deepStrictEqual(calls.direct, []);
  });

  it('delivers a non-error event via reiwa as an inline card (no document)', async () => {
    const { service, calls } = buildService({
      telegram: {
        enabled: false,
        chatId: null,
        devChatId: '813364774',
        errorReports: { mode: 'manual', telegramTxt: true },
      },
    });

    service.info('system.heartbeat', 'SYSTEM', 'tick');
    await flush();

    assert.equal(calls.notifyDev, 1);
    assert.equal(calls.notifyDevDocument, 0);
    assert.deepStrictEqual(calls.queued, ['reiwa.dev.notify']);
    assert.deepStrictEqual(calls.direct, []);
  });

  it('sends the relay-failure alert down the DIRECT client, never the queue', async () => {
    // The loop that would otherwise close: the relay processor reports an
    // exhausted job by emitting `reiwa.relay_undelivered`, `emit()` fans every
    // event out to Telegram, and a queued firehose turns that into a new relay
    // job — which exhausts, and alerts again, for as long as the cabinet is
    // down. One direct attempt terminates the chain after a single hop.
    const { service, calls } = buildService({
      telegram: {
        enabled: false,
        chatId: null,
        devChatId: '813364774',
        errorReports: { mode: 'manual', telegramTxt: false },
      },
    });

    service.warn('reiwa.relay_undelivered', 'SYSTEM', 'Reiwa relay did not deliver', {
      relayEvent: 'reiwa.user.notify',
      relayStatus: 'timeout',
    });
    await flush();

    assert.equal(calls.notifyDev, 1, 'the operator is still told');
    assert.deepStrictEqual(calls.queued, [], 'but not by a road that can re-enter itself');
    assert.deepStrictEqual(calls.direct, ['reiwa.dev.notify']);
  });

  it('still reaches the dev when NOTHING is configured (no chat, no Dev chat ID)', async () => {
    const { service, calls } = buildService({
      telegram: {
        enabled: false,
        chatId: null,
        devChatId: null,
        errorReports: { mode: 'manual', telegramTxt: true },
      },
    });

    service.error('reiwa.error', 'SYSTEM', '[reiwa:api] kaput', { source: 'api' });
    await flush();

    assert.equal(calls.notifyDevDocument, 1);
    assert.equal(calls.notifyDev, 0);
  });

  it('relays an ERROR document to the configured group topic without a local bot token', async () => {
    const { service, calls } = buildService({
      telegram: {
        enabled: true,
        chatId: '-1001234567890',
        errorTopicId: 77,
        errorReports: { mode: 'manual', telegramTxt: true },
      },
    });

    service.error('reiwa.error', 'SYSTEM', '[reiwa:web] boom', { source: 'web', stack: 'at x' });
    await flush();

    assert.equal(calls.notifyBroadcastDocument, 1);
    assert.equal(calls.notifyBroadcast, 0);
    assert.equal(calls.lastBroadcastTopicId, 77);
    assert.ok(calls.lastFilename?.startsWith('error_'));
    assert.ok(calls.lastCaption?.includes('#EventError'));
  });

  it('in "selected" mode does NOT deliver an unselected event — not even to the dev DM', async () => {
    const { service, calls } = buildService({
      telegram: {
        enabled: false,
        chatId: null,
        devChatId: '813364774',
        eventsMode: 'selected',
        events: ['payment.completed'],
        errorReports: { mode: 'manual', telegramTxt: true },
      },
    });

    // Not in the allow-list → must go nowhere on Telegram (panel still has it).
    service.info('system.heartbeat', 'SYSTEM', 'tick');
    await flush();
    assert.equal(calls.notifyDev, 0);
    assert.equal(calls.notifyDevDocument, 0);

    // A selected event still reaches the dev DM.
    service.info('payment.completed', 'PAYMENT', 'paid', { amount: '100' });
    await flush();
    assert.equal(calls.notifyDev, 1);
  });
});
