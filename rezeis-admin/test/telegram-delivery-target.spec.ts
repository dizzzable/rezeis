import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { isErrorEvent } from '../src/common/services/error-report.util';
import { SystemEventsService } from '../src/common/services/system-events.service';
import { resolveTelegramDeliveryTarget, isEventTelegramAllowed } from '../src/common/services/telegram-delivery-target.util';
import { BotNotifierClient } from '../src/modules/notifications/services/bot-notifier.client';
import { ReiwaRelayQueueService } from '../src/modules/notifications/services/reiwa-relay-queue.service';

/**
 * System-events Telegram delivery fallback contract.
 *
 * When the operator HASN'T configured a separate group/topics, events must
 * still reach the dev via the same bot's DM (devChatId) — and ONLY the dev
 * (a bot DM is private). When nothing is configured, no Telegram delivery.
 */
const BASE = {
  enabled: false,
  chatId: null as string | null,
  devChatId: null as string | null,
  topicMap: {} as Record<string, number | null>,
  defaultTopicId: null as number | null,
  errorTopicId: null as number | null,
};

const EVENT = { type: 'payment.completed', category: 'PAYMENT' };

describe('resolveTelegramDeliveryTarget', () => {
  it('routes to the primary chat + per-category topic when configured', () => {
    const target = resolveTelegramDeliveryTarget(
      { ...BASE, enabled: true, chatId: '-100123', topicMap: { PAYMENT: 42 } },
      EVENT,
    );
    assert.deepEqual(target, { chatId: '-100123', topicId: 42, isDevFallback: false });
  });

  it('uses the default topic when no per-category override exists', () => {
    const target = resolveTelegramDeliveryTarget(
      { ...BASE, enabled: true, chatId: '-100123', defaultTopicId: 7 },
      EVENT,
    );
    assert.equal(target?.topicId, 7);
    assert.equal(target?.isDevFallback, false);
  });

  it('routes ERROR-severity events to the dedicated error topic, overriding category', () => {
    const target = resolveTelegramDeliveryTarget(
      { ...BASE, enabled: true, chatId: '-100123', topicMap: { PAYMENT: 42 }, errorTopicId: 99 },
      { type: 'payment.failed', category: 'PAYMENT', severity: 'ERROR' },
    );
    assert.equal(target?.topicId, 99);
  });

  it('keeps category routing for non-ERROR events even when an error topic is set', () => {
    const target = resolveTelegramDeliveryTarget(
      { ...BASE, enabled: true, chatId: '-100123', topicMap: { PAYMENT: 42 }, errorTopicId: 99 },
      { type: 'payment.completed', category: 'PAYMENT', severity: 'INFO' },
    );
    assert.equal(target?.topicId, 42);
  });

  it('falls back to the dev DM (no topic) when no primary chat is configured', () => {
    const target = resolveTelegramDeliveryTarget(
      { ...BASE, enabled: false, chatId: null, devChatId: '555000' },
      EVENT,
    );
    assert.deepEqual(target, { chatId: '555000', topicId: null, isDevFallback: true });
  });

  it('falls back to the dev DM when enabled but chatId is missing', () => {
    const target = resolveTelegramDeliveryTarget(
      { ...BASE, enabled: true, chatId: null, devChatId: '555000', defaultTopicId: 9 },
      EVENT,
    );
    // Dev fallback ignores topic routing — it's a firehose DM.
    assert.deepEqual(target, { chatId: '555000', topicId: null, isDevFallback: true });
  });

  it('returns null when neither a primary chat nor a dev chat is set', () => {
    assert.equal(resolveTelegramDeliveryTarget(BASE, EVENT), null);
  });

  it('routes a WARNING `client.error` to the error topic, where its incident card belongs', () => {
    // `ClientErrorsController` always raises `client.error` as WARNING, and the
    // card renderer draws it as an incident card with a `.txt` because of its
    // `.error` name. This router used to ask `severity === 'ERROR'` instead, so
    // that incident card landed in the SYSTEM topic.
    const target = resolveTelegramDeliveryTarget(
      { ...BASE, enabled: true, chatId: '-100123', topicMap: { SYSTEM: 3 }, errorTopicId: 7 },
      { type: 'client.error', severity: 'WARNING', category: 'SYSTEM' },
    );
    assert.equal(target?.topicId, 7);
  });

  it('files each way into an error report — and nothing else — in the error topic', () => {
    // Every row states its answer outright. This case used to compare the
    // router with `isErrorEvent`, which is now the router's own predicate, so
    // a wrong rule agreed with itself and passed. Written-down topics (and the
    // written-down card kind beside them) fail on a change to either side.
    const config = {
      ...BASE,
      enabled: true,
      chatId: '-100123',
      topicMap: { SYSTEM: 3, PAYMENT: 42 },
      errorTopicId: 7,
    };
    const table = [
      // The three ways in: ERROR severity, and an `.error` type at any severity.
      { type: 'client.error', severity: 'WARNING', category: 'SYSTEM', topic: 7, errorCard: true },
      { type: 'reiwa.error', severity: 'WARNING', category: 'SYSTEM', topic: 7, errorCard: true },
      { type: 'reiwa.error', severity: 'ERROR', category: 'SYSTEM', topic: 7, errorCard: true },
      { type: 'payment.failed', severity: 'ERROR', category: 'PAYMENT', topic: 7, errorCard: true },
      // And the near misses, which stay in their category's topic.
      { type: 'system.backup_completed', severity: 'WARNING', category: 'SYSTEM', topic: 3, errorCard: false },
      { type: 'payment.completed', severity: 'INFO', category: 'PAYMENT', topic: 42, errorCard: false },
      { type: 'system.error_rate', severity: 'WARNING', category: 'SYSTEM', topic: 3, errorCard: false },
      { type: 'client.errors', severity: 'WARNING', category: 'SYSTEM', topic: 3, errorCard: false },
      { type: 'system.dberror', severity: 'WARNING', category: 'SYSTEM', topic: 3, errorCard: false },
    ] as const;
    for (const row of table) {
      const label = `${row.type}@${row.severity}`;
      assert.equal(resolveTelegramDeliveryTarget(config, row)?.topicId, row.topic, `${label}: topic`);
      assert.equal(
        isErrorEvent({ severity: row.severity, kind: `event.${row.type}` }),
        row.errorCard,
        `${label}: card kind`,
      );
    }
  });
});

describe('an error report delivered by the real service', () => {
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.BOT_TOKEN;
    delete process.env.BOT_TOKEN;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = savedToken;
  });

  it('sends the `client.error` incident card and its `.txt` to the error topic', async () => {
    // End to end through `SystemEventsService.deliverTelegram` on the split
    // deployment (no local token → reiwa relay), because the defect was two
    // halves of that method disagreeing, not either helper alone.
    const relayed: Array<{ event: string; meta: Record<string, unknown> }> = [];
    const relayQueue = {
      enqueue: async (event: string, meta: Record<string, unknown>) => {
        relayed.push({ event, meta });
        return true;
      },
    };
    const service = new SystemEventsService(
      {
        settings: {
          findFirst: async () => ({
            systemNotifications: {
              telegram: {
                enabled: true,
                chatId: '-100123',
                topics: { SYSTEM: 3 },
                errorTopicId: 7,
              },
            },
          }),
        },
        adminAuditLog: { create: async () => ({}) },
      } as never,
      { enabled: false, urls: [] } as never,
      {
        post: () => {
          throw new Error('Bot API must not be called without a token');
        },
      } as never,
      {
        get: (token: unknown) => {
          if (token === ReiwaRelayQueueService) return relayQueue;
          if (token === BotNotifierClient) return { deliverRelayEvent: async () => ({ status: 'confirmed' }) };
          throw new Error('not registered');
        },
      } as never,
    );

    service.warn('client.error', 'SYSTEM', 'Cannot read properties of undefined', {
      source: 'panel',
      stack: 'TypeError: x\n    at y',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(relayed.length, 1, `expected one relayed card; got ${JSON.stringify(relayed)}`);
    assert.equal(relayed[0].event, 'reiwa.channel.broadcast.document', 'an incident card with its .txt');
    assert.equal(relayed[0].meta['topicThreadId'], 7);
  });
});

/**
 * The types the operator's page can draw a tick-box for. `payment.completed`
 * and `user.blocked` are registered; anything else passed below is not, which
 * is what routes it to the catch-all instead of the exact-match branch.
 */
const KNOWN = new Set(['payment.completed', 'user.blocked']);

describe('isEventTelegramAllowed', () => {
  it('allows everything in "all" mode', () => {
    assert.equal(isEventTelegramAllowed('payment.completed', { eventsMode: 'all', events: [], knownTypes: KNOWN }), true);
    assert.equal(isEventTelegramAllowed('user.blocked', { eventsMode: 'all', events: ['x'], knownTypes: KNOWN }), true);
  });

  it('in "selected" mode delivers only listed event types', () => {
    const filter = { eventsMode: 'selected' as const, events: ['payment.completed'], knownTypes: KNOWN };
    assert.equal(isEventTelegramAllowed('payment.completed', filter), true);
    assert.equal(isEventTelegramAllowed('user.blocked', filter), false);
  });

  it('in "selected" mode with an empty list delivers nothing', () => {
    assert.equal(isEventTelegramAllowed('payment.completed', { eventsMode: 'selected', events: [], knownTypes: KNOWN }), false);
  });

  it('always allows the manual delivery test regardless of mode', () => {
    assert.equal(isEventTelegramAllowed('settings.telegram.test', { eventsMode: 'selected', events: [], knownTypes: KNOWN }), true);
  });
});
