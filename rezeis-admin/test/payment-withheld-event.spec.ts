import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { of } from 'rxjs';

import {
  EVENT_TYPES,
  OPERATOR_ONLY_EVENT_TYPES,
  REGISTERED_EVENT_TYPES,
  SystemEventsService,
} from '../src/common/services/system-events.service';
import { isEventTelegramAllowed } from '../src/common/services/telegram-delivery-target.util';
import { RealtimeGateway } from '../src/modules/realtime/realtime.gateway';
import { BotNotifierClient } from '../src/modules/notifications/services/bot-notifier.client';
import { ReiwaRelayQueueService } from '../src/modules/notifications/services/reiwa-relay-queue.service';

/**
 * `payment.withheld` (R3-support-money N3): a trial's conversion received after
 * another payment had converted the trial, applied to nothing, due back to the
 * payer. It used to be raised as a WARNING `payment.completed` — the event the
 * payer's receipt, automation rules, outbound webhooks and the payer's open
 * cabinet all take for a completed sale.
 *
 * Operator-only: the audit log and the operator's card, and nothing that acts
 * for a customer or an integration — no realtime broadcast (automation rules
 * are dispatched from it), no hook (outbound webhooks, the email bridge, the
 * push dispatcher), no env webhook. Every "not reached" below is measured
 * against `payment.completed` through the same harness, which reaches all of
 * them: a harness that reached nothing would otherwise agree for ever.
 */

const WEBHOOK_URL = 'https://hooks.example.test/rezeis';

interface Reached {
  readonly persisted: string[];
  readonly realtime: string[];
  readonly hooks: string[];
  readonly webhook: string[];
  readonly cards: string[];
}

async function emitThrough(
  type: string,
  telegram: { readonly eventsMode: 'all' | 'selected'; readonly events: readonly string[] } = {
    eventsMode: 'all',
    events: [],
  },
): Promise<Reached> {
  const reached: Reached = { persisted: [], realtime: [], hooks: [], webhook: [], cards: [] };
  const settingsRow = {
    systemNotifications: {
      telegram: { enabled: false, chatId: null, devChatId: null, eventsMode: telegram.eventsMode, events: [...telegram.events] },
    },
  };
  // The dev firehose: with no token the card rides the relay, rendered here.
  const capture = (event: string, meta: Record<string, unknown>): void => {
    if (event === 'reiwa.dev.notify') reached.cards.push(meta['text'] as string);
  };
  const gateway = {
    broadcast: (event: { readonly type: string }) => {
      reached.realtime.push(event.type);
    },
  };
  const service = new SystemEventsService(
    {
      settings: { findFirst: async () => settingsRow },
      adminAuditLog: {
        create: async ({ data }: { data: { action: string } }) => {
          reached.persisted.push(data.action);
          return {};
        },
      },
    } as never,
    { enabled: true, urls: [WEBHOOK_URL] } as never,
    {
      post: (url: string) => {
        reached.webhook.push(url);
        return of({ status: 200, data: {} });
      },
    } as never,
    {
      get: (token: unknown) => {
        if (token === RealtimeGateway) return gateway;
        if (token === BotNotifierClient) {
          return {
            deliverRelayEvent: async (event: string, meta: Record<string, unknown>) => {
              capture(event, meta);
              return { status: 'unconfirmed', messageId: null, httpStatus: 204, detail: null };
            },
          };
        }
        if (token === ReiwaRelayQueueService) {
          return {
            enqueue: async (event: string, meta: Record<string, unknown>) => {
              capture(event, meta);
              return true;
            },
          };
        }
        throw new Error('not registered');
      },
    } as never,
  );
  service.registerHook((event) => {
    reached.hooks.push(event.type);
  });

  service.warn(type, 'PAYMENT', 'Платёж получен, но не применён: пробная подписка уже переведена', {
    userId: 'user-1',
    paymentId: 'payment-2',
    amount: '799',
    currency: 'RUB',
    gatewayType: 'PLATEGA',
    trialConvertedByPaymentId: 'payment-1',
    note: 'Верните деньги у платёжного провайдера (PLATEGA), затем отметьте это в панели: «Платежи» → «Транзакции» → этот платёж → «Отметить возврат».',
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  return reached;
}

describe('payment.withheld', () => {
  it('is a registered type of its own, and operator-only', () => {
    assert.equal(EVENT_TYPES.PAYMENT_WITHHELD, 'payment.withheld');
    assert.ok(REGISTERED_EVENT_TYPES.has('payment.withheld'));
    assert.ok(OPERATOR_ONLY_EVENT_TYPES.has('payment.withheld'));
    // The type every receipt, rule and integration treats as a sale is not.
    assert.equal(OPERATOR_ONLY_EVENT_TYPES.has('payment.completed'), false);
  });

  it('reaches the audit log and the operator card, and nothing a customer or an integration acts on', async () => {
    const control = await emitThrough('payment.completed');
    // The harness reaches every consumer, or the refusals below prove nothing.
    assert.deepEqual(control.persisted, ['event.payment.completed']);
    assert.deepEqual(control.realtime, ['payment.completed']);
    assert.deepEqual(control.hooks, ['payment.completed']);
    assert.deepEqual(control.webhook, [WEBHOOK_URL]);
    assert.equal(control.cards.length, 1);

    const withheld = await emitThrough('payment.withheld');

    assert.deepEqual(withheld.persisted, ['event.payment.withheld'], 'the audit log is one of the operator traces');
    assert.equal(withheld.cards.length, 1, 'the operator card is the other');
    assert.deepEqual(withheld.realtime, [], 'automation rules are dispatched from the realtime broadcast');
    assert.deepEqual(withheld.hooks, [], 'outbound webhooks and the email bridge are hooks');
    assert.deepEqual(withheld.webhook, [], 'the env webhook is an integration too');
  });

  it('is a card titled for what it is, carrying where to record the refund', async () => {
    const [card] = (await emitThrough('payment.withheld')).cards;

    assert.ok(card?.includes('Платёж получен, но не применён'), card);
    assert.ok(card?.includes('«Платежи» → «Транзакции» → этот платёж → «Отметить возврат»'), card);
  });

  it('keeps reaching an operator who ticked «Платёж получен», which is what it was raised as', async () => {
    const ticked = await emitThrough('payment.withheld', { eventsMode: 'selected', events: ['payment.completed'] });
    const own = await emitThrough('payment.withheld', { eventsMode: 'selected', events: ['payment.withheld'] });
    const neither = await emitThrough('payment.withheld', { eventsMode: 'selected', events: ['payment.failed'] });

    assert.equal(ticked.cards.length, 1);
    assert.equal(own.cards.length, 1);
    assert.equal(neither.cards.length, 0, 'a selection that has neither must not receive it');
  });

  it('does not widen «Платёж получен» the other way', () => {
    const knownTypes = REGISTERED_EVENT_TYPES;
    assert.equal(
      isEventTelegramAllowed('payment.completed', { eventsMode: 'selected', events: ['payment.withheld'], knownTypes }),
      false,
    );
  });
});

/**
 * `payment.withheld_refunded` (wave 4b): the refund of a withheld payment,
 * raised instead of `payment.refunded` / `payment.refund_partial` for it. No
 * sale was ever announced for the payment, so no rule, integration or refund
 * email may hear of its refund either.
 */
describe('payment.withheld_refunded', () => {
  it('is registered and operator-only, and the refund of a sale is not', () => {
    assert.equal(EVENT_TYPES.PAYMENT_WITHHELD_REFUNDED, 'payment.withheld_refunded');
    assert.ok(REGISTERED_EVENT_TYPES.has('payment.withheld_refunded'));
    assert.ok(OPERATOR_ONLY_EVENT_TYPES.has('payment.withheld_refunded'));
    assert.equal(OPERATOR_ONLY_EVENT_TYPES.has('payment.refunded'), false);
    assert.equal(OPERATOR_ONLY_EVENT_TYPES.has('payment.refund_partial'), false);
  });

  it('reaches the audit log and the operator card, and nothing a customer or an integration acts on', async () => {
    const control = await emitThrough('payment.refunded');
    assert.deepEqual(control.realtime, ['payment.refunded']);
    assert.deepEqual(control.hooks, ['payment.refunded']);
    assert.deepEqual(control.webhook, [WEBHOOK_URL]);

    const refunded = await emitThrough('payment.withheld_refunded');

    assert.deepEqual(refunded.persisted, ['event.payment.withheld_refunded']);
    assert.equal(refunded.cards.length, 1);
    assert.ok(refunded.cards[0]?.includes('Возврат неприменённого платежа'), refunded.cards[0]);
    assert.deepEqual(refunded.realtime, []);
    assert.deepEqual(refunded.hooks, []);
    assert.deepEqual(refunded.webhook, []);
  });

  it('reaches an operator who ticked the refund it used to be raised as, or the withheld payment itself', async () => {
    for (const ticked of ['payment.refunded', 'payment.refund_partial', 'payment.withheld', 'payment.withheld_refunded']) {
      const reached = await emitThrough('payment.withheld_refunded', { eventsMode: 'selected', events: [ticked] });
      assert.equal(reached.cards.length, 1, `ticking ${ticked}`);
    }
    const neither = await emitThrough('payment.withheld_refunded', { eventsMode: 'selected', events: ['payment.completed'] });
    assert.equal(neither.cards.length, 0);
    assert.equal(
      isEventTelegramAllowed('payment.refunded', {
        eventsMode: 'selected',
        events: ['payment.withheld_refunded'],
        knownTypes: REGISTERED_EVENT_TYPES,
      }),
      false,
      'ticking the withheld refund must not deliver every refund',
    );
  });
});
