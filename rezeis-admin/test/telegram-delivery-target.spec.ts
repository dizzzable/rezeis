import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveTelegramDeliveryTarget, isEventTelegramAllowed } from '../src/common/services/telegram-delivery-target.util';

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
});

describe('isEventTelegramAllowed', () => {
  it('allows everything in "all" mode', () => {
    assert.equal(isEventTelegramAllowed('payment.completed', { eventsMode: 'all', events: [] }), true);
    assert.equal(isEventTelegramAllowed('user.blocked', { eventsMode: 'all', events: ['x'] }), true);
  });

  it('in "selected" mode delivers only listed event types', () => {
    const filter = { eventsMode: 'selected' as const, events: ['payment.completed'] };
    assert.equal(isEventTelegramAllowed('payment.completed', filter), true);
    assert.equal(isEventTelegramAllowed('user.blocked', filter), false);
  });

  it('in "selected" mode with an empty list delivers nothing', () => {
    assert.equal(isEventTelegramAllowed('payment.completed', { eventsMode: 'selected', events: [] }), false);
  });

  it('always allows the manual delivery test regardless of mode', () => {
    assert.equal(isEventTelegramAllowed('settings.telegram.test', { eventsMode: 'selected', events: [] }), true);
  });
});
