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
import { AutomationEventBridgeService } from '../src/modules/automations/automation-event-bridge.service';
import { USER_EVENT_WHITELIST } from '../src/modules/realtime/interfaces/user-realtime-event.interface';
import { RealtimeGateway } from '../src/modules/realtime/realtime.gateway';
import { UserRealtimeService } from '../src/modules/realtime/services/user-realtime.service';
import { BotNotifierClient } from '../src/modules/notifications/services/bot-notifier.client';
import { ReiwaRelayQueueService } from '../src/modules/notifications/services/reiwa-relay-queue.service';

/**
 * `payment.withheld`: a trial's conversion received after
 * another payment had converted the trial, applied to nothing, due back to the
 * payer. It used to be raised as a WARNING `payment.completed` — the event the
 * payer's receipt, automation rules, outbound webhooks and the payer's open
 * cabinet all take for a completed sale.
 *
 * Operator-only: the audit log, the operator's card, and the admin panel's
 * own realtime stream — so an open «Платежи» page shows it as it shows any
 * payment — and nothing that acts for a customer or an
 * integration: the automation rules and the payer's projection ride on that
 * same broadcast and skip it, and no hook (outbound webhooks, the email
 * bridge, the push dispatcher) or env webhook gets it. Both riders are the
 * real services here, wired onto the broadcast the way the app wires them,
 * with a rule on `payment.*` and a payer listening. Every "not reached" below
 * is measured against `payment.completed` through the same harness, which
 * reaches all of them: a harness that reached nothing would otherwise agree
 * for ever.
 */

const WEBHOOK_URL = 'https://hooks.example.test/rezeis';

interface Reached {
  readonly persisted: string[];
  /** The admin sockets: the original broadcast. */
  readonly realtime: string[];
  /** Rule runs the automation bridge queued for a rule on `payment.*`. */
  readonly automations: string[];
  /** Events the payer's projection delivered to a listening payer. */
  readonly payer: string[];
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
  const reached: Reached = { persisted: [], realtime: [], automations: [], payer: [], hooks: [], webhook: [], cards: [] };
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
  // The two consumers riding on the admin broadcast, wrapped around it as the
  // app wraps them: the automation rules and the payer's open cabinet.
  const riders = {
    get: (token: unknown) => {
      if (token === RealtimeGateway) return gateway;
      throw new Error('not registered');
    },
  };
  const bridge = new AutomationEventBridgeService(
    riders as never,
    { automationRule: { findMany: async () => [{ id: 'every-payment', triggerSpec: 'payment.*' }] } } as never,
    {
      enqueueExecution: async (input: { readonly trigger: string }) => {
        reached.automations.push(input.trigger);
      },
    } as never,
  );
  bridge.onModuleInit();
  const payer = new UserRealtimeService(riders as never);
  const unsubscribe = payer.subscribe({
    userId: 'user-1',
    telegramId: null,
    handler: (event) => {
      reached.payer.push(event.type);
    },
  });
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
  unsubscribe();
  return reached;
}

/** What reaches the customer-facing and machine consumers; each must be empty for an operator-only type. */
function actedOn(reached: Reached): Record<string, readonly string[]> {
  return {
    automations: reached.automations,
    payer: reached.payer,
    hooks: reached.hooks,
    webhook: reached.webhook,
  };
}

const NOTHING_ACTED_ON = { automations: [], payer: [], hooks: [], webhook: [] };

describe('payment.withheld', () => {
  it('is a registered type of its own, and operator-only', () => {
    assert.equal(EVENT_TYPES.PAYMENT_WITHHELD, 'payment.withheld');
    assert.ok(REGISTERED_EVENT_TYPES.has('payment.withheld'));
    assert.ok(OPERATOR_ONLY_EVENT_TYPES.has('payment.withheld'));
    // The type every receipt, rule and integration treats as a sale is not.
    assert.equal(OPERATOR_ONLY_EVENT_TYPES.has('payment.completed'), false);
  });

  it('reaches the audit log, the operator card and the admin panel live, and nothing a customer or an integration acts on', async () => {
    const control = await emitThrough('payment.completed');
    // The harness reaches every consumer, or the refusals below prove nothing.
    assert.deepEqual(control.persisted, ['event.payment.completed']);
    assert.deepEqual(control.realtime, ['payment.completed']);
    assert.deepEqual(control.automations, ['event:payment.completed']);
    assert.deepEqual(control.payer, ['payment.completed']);
    assert.deepEqual(control.hooks, ['payment.completed']);
    assert.deepEqual(control.webhook, [WEBHOOK_URL]);
    assert.equal(control.cards.length, 1);

    const withheld = await emitThrough('payment.withheld');

    assert.deepEqual(withheld.persisted, ['event.payment.withheld'], 'the audit log is one of the operator traces');
    assert.equal(withheld.cards.length, 1, 'the operator card is the other');
    assert.deepEqual(withheld.realtime, ['payment.withheld'], 'an open «Платежи» page refreshes on it like on any payment');
    assert.deepEqual(actedOn(withheld), NOTHING_ACTED_ON, 'a rule on payment.*, the payer, a hook or the env webhook heard it');
  });

  it('never reaches a payer, whatever the payer projection comes to list', async () => {
    // The payer's projection lists the types a cabinet hears; this one is not
    // among them today. Were it added, the operator-only rule still holds.
    const whitelist = USER_EVENT_WHITELIST as Record<string, unknown>;
    whitelist['payment.withheld'] = USER_EVENT_WHITELIST['payment.completed'];
    try {
      const withheld = await emitThrough('payment.withheld');
      assert.deepEqual(withheld.payer, []);
    } finally {
      delete whitelist['payment.withheld'];
    }
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
 * `payment.withheld_refunded`: the refund of a withheld payment,
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

  it('reaches the audit log, the operator card and the admin panel live, and nothing a customer or an integration acts on', async () => {
    const control = await emitThrough('payment.refunded');
    assert.deepEqual(control.realtime, ['payment.refunded']);
    assert.deepEqual(control.automations, ['event:payment.refunded']);
    assert.deepEqual(control.hooks, ['payment.refunded']);
    assert.deepEqual(control.webhook, [WEBHOOK_URL]);

    const refunded = await emitThrough('payment.withheld_refunded');

    assert.deepEqual(refunded.persisted, ['event.payment.withheld_refunded']);
    assert.equal(refunded.cards.length, 1);
    assert.ok(refunded.cards[0]?.includes('Возврат неприменённого платежа'), refunded.cards[0]);
    assert.deepEqual(refunded.realtime, ['payment.withheld_refunded']);
    assert.deepEqual(actedOn(refunded), NOTHING_ACTED_ON);
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

/**
 * `payment.chargeback_unmatched`: a chargeback on an autopay
 * charged several times that names none of our payments, so nothing was
 * reversed and an operator has to find the charge. Money a human settles, like
 * `payment.withheld`: operator-only. And a new type, so a saved `selected`
 * list never ticked it: it reaches whoever ticked the refund cards.
 */
describe('payment.chargeback_unmatched', () => {
  it('is registered and operator-only', () => {
    assert.equal(EVENT_TYPES.PAYMENT_CHARGEBACK_UNMATCHED, 'payment.chargeback_unmatched');
    assert.ok(REGISTERED_EVENT_TYPES.has('payment.chargeback_unmatched'));
    assert.ok(OPERATOR_ONLY_EVENT_TYPES.has('payment.chargeback_unmatched'));
  });

  it('reaches the audit log, the operator card and the admin panel live, and nothing an integration acts on', async () => {
    const told = await emitThrough('payment.chargeback_unmatched');

    assert.deepEqual(told.persisted, ['event.payment.chargeback_unmatched']);
    assert.equal(told.cards.length, 1);
    assert.ok(told.cards[0]?.includes('Оспорено списание по автоплатежу'), told.cards[0]);
    assert.deepEqual(told.realtime, ['payment.chargeback_unmatched']);
    assert.deepEqual(actedOn(told), NOTHING_ACTED_ON);
  });

  it('reaches an operator who ticked the refund cards, and not one who ticked neither', async () => {
    for (const ticked of ['payment.refunded', 'payment.refund_partial', 'payment.chargeback_unmatched']) {
      const reached = await emitThrough('payment.chargeback_unmatched', { eventsMode: 'selected', events: [ticked] });
      assert.equal(reached.cards.length, 1, `ticking ${ticked}`);
    }
    const neither = await emitThrough('payment.chargeback_unmatched', {
      eventsMode: 'selected',
      events: ['payment.completed', 'payment.failed'],
    });
    assert.equal(neither.cards.length, 0);
    assert.equal(
      isEventTelegramAllowed('payment.refunded', {
        eventsMode: 'selected',
        events: ['payment.chargeback_unmatched'],
        knownTypes: REGISTERED_EVENT_TYPES,
      }),
      false,
      'ticking the unmatched chargeback must not deliver every refund',
    );
  });
});

/**
 * `payment.autopay_stopped_by_operator`: an operator ended a
 * customer's autopay from the user's card, without a refund. Operator-only:
 * the customer's own switch is `payment.method_autopay_updated`, and a rule or
 * a letter bound to that would tell the customer they did it. A new type, so
 * it reaches whoever ticked the customer's switch.
 */
describe('payment.autopay_stopped_by_operator', () => {
  it('is registered and operator-only, and the customer’s own switch is not', () => {
    assert.equal(EVENT_TYPES.PAYMENT_AUTOPAY_STOPPED_BY_OPERATOR, 'payment.autopay_stopped_by_operator');
    assert.ok(REGISTERED_EVENT_TYPES.has('payment.autopay_stopped_by_operator'));
    assert.ok(OPERATOR_ONLY_EVENT_TYPES.has('payment.autopay_stopped_by_operator'));
    assert.equal(OPERATOR_ONLY_EVENT_TYPES.has('payment.method_autopay_updated'), false);
  });

  it('reaches the audit log, the operator card and the admin panel live, and nothing a customer or an integration acts on', async () => {
    const control = await emitThrough('payment.method_autopay_updated');
    assert.deepEqual(control.automations, ['event:payment.method_autopay_updated']);
    assert.deepEqual(control.hooks, ['payment.method_autopay_updated']);

    const stopped = await emitThrough('payment.autopay_stopped_by_operator');

    assert.deepEqual(stopped.persisted, ['event.payment.autopay_stopped_by_operator']);
    assert.equal(stopped.cards.length, 1);
    assert.ok(stopped.cards[0]?.includes('Автосписание отключено в панели'), stopped.cards[0]);
    assert.deepEqual(stopped.realtime, ['payment.autopay_stopped_by_operator']);
    assert.deepEqual(actedOn(stopped), NOTHING_ACTED_ON);
  });

  it('reaches an operator who ticked the customer’s autopay switch, and not the other way', async () => {
    for (const ticked of ['payment.method_autopay_updated', 'payment.autopay_stopped_by_operator']) {
      const reached = await emitThrough('payment.autopay_stopped_by_operator', { eventsMode: 'selected', events: [ticked] });
      assert.equal(reached.cards.length, 1, `ticking ${ticked}`);
    }
    const neither = await emitThrough('payment.autopay_stopped_by_operator', {
      eventsMode: 'selected',
      events: ['payment.refunded'],
    });
    assert.equal(neither.cards.length, 0);
    assert.equal(
      isEventTelegramAllowed('payment.method_autopay_updated', {
        eventsMode: 'selected',
        events: ['payment.autopay_stopped_by_operator'],
        knownTypes: REGISTERED_EVENT_TYPES,
      }),
      false,
    );
  });
});
