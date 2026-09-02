import 'reflect-metadata';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  Currency,
  PaymentGatewayType,
  Prisma,
  PurchaseType,
  TransactionStatus,
} from '@prisma/client';

import { EVENT_TYPES, SystemEventsService } from '../src/common/services/system-events.service';
import { BotNotifierClient } from '../src/modules/notifications/services/bot-notifier.client';
import { ReiwaRelayQueueService } from '../src/modules/notifications/services/reiwa-relay-queue.service';
import { PaymentReconciliationService } from '../src/modules/payments/services/payment-reconciliation.service';

/**
 * The shortfall NOTE, told apart from the shortfall HOLD
 * ─────────────────────────────────────────────────────
 * Two different things can be said about a sum that does not match, and an
 * operator has to be able to tell them apart without opening the card:
 *
 *   - `payment.amount_mismatch` — the money arrived short or frozen, the
 *     entitlement is WITHHELD, the row is parked and somebody must settle it.
 *   - `payment.notified_amount_short` — the payment completed and the customer
 *     has what they paid for; the provider's own figure merely disagrees with
 *     our record and somebody should find out why.
 *
 * They shared a type at first, and that does not work: `formatTelegramMessage`
 * renders `EVENT_PRESENTATION[type].title`, not the message passed at the call
 * site, so the second arrived on the operator's desk as «⚠️ Оплачена неверная
 * сумма» — visually identical to money that is actually stuck, separated only by
 * a `needsManualReview: false` line in the metadata.
 *
 * The rest of this file is the two ways the comparison behind that note fires
 * when nothing is wrong: eight-decimal dust, and a provider whose reported sum
 * might be net of its own commission.
 */

interface EmittedEvent {
  readonly severity: 'INFO' | 'WARNING' | 'ERROR';
  readonly type: string;
  readonly category: string;
  readonly message: string;
  readonly metadata: Record<string, unknown>;
}

describe('an informational shortfall does not borrow the blocking event type', () => {
  it('emits its own type, and never the one a held payment uses', async () => {
    const h = createReconciliation({
      gatewayType: PaymentGatewayType.CRYPTOMUS,
      currency: Currency.USDT,
      amount: '12.34',
      eventStatus: 'paid',
      rawPayload: { uuid: 'inv-1', status: 'paid', payment_amount: '6.40', currency: 'USDT' },
    });

    await h.service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(
      h.events.map((event) => event.type),
      [EVENT_TYPES.PAYMENT_NOTIFIED_AMOUNT_SHORT],
    );
    assert.equal(h.events[0].type, 'payment.notified_amount_short');
    assert.notEqual(EVENT_TYPES.PAYMENT_NOTIFIED_AMOUNT_SHORT, EVENT_TYPES.PAYMENT_AMOUNT_MISMATCH);
    assert.equal(h.events[0].metadata.needsManualReview, false);

    // The note is a note: the payment went through and nothing was parked.
    assert.deepStrictEqual(h.fulfillments, ['tx-1']);
    assert.equal(h.gatewayData().paymentNeedsManualReview, undefined);
  });
});

describe('the two shortfall cards an operator sees', () => {
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.BOT_TOKEN;
    delete process.env.BOT_TOKEN;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = savedToken;
  });

  it('render as visibly different events, not as the same one twice', async () => {
    // Registering the type in `EVENT_TYPES` is only half of it: a type missing
    // from `EVENT_PRESENTATION` falls back to `severityEmoji` + the raw message,
    // which is how a machine-readable message reaches an operator untitled.
    const held = await renderCard(EVENT_TYPES.PAYMENT_AMOUNT_MISMATCH, {
      needsManualReview: true,
    });
    const note = await renderCard(EVENT_TYPES.PAYMENT_NOTIFIED_AMOUNT_SHORT, {
      needsManualReview: false,
    });

    assert.ok(held.includes('Событие: Оплачена неверная сумма!'));
    assert.ok(note.includes('Событие: Платёж проведён, но сумма в уведомлении меньше!'));
    // Neither falls through to the raw message, and neither wears the other's
    // title — the failure that made the two indistinguishable at a glance.
    assert.ok(!note.includes('raw machine message'));
    assert.ok(!note.includes('Оплачена неверная сумма'));
    assert.ok(!held.includes('Платёж проведён'));
    // Different lead emoji too, so the distinction survives a glance at the
    // notification list without reading the title at all.
    assert.ok(note.includes('ℹ️'));
    assert.ok(held.includes('⚠️'));
  });
});

describe('the shortfall comparison on eight-decimal money', () => {
  it('says nothing about a dust difference the provider itself calls paid', async () => {
    // `Transaction.amount` is `Decimal(20, 8)` and the crypto rails settle in
    // eight places, so an exact `lessThan` fires on 0.00000001 — an alert on a
    // payment nothing is wrong with, on a status the provider itself reports as
    // `paid`. That is the noise that teaches an operator to skip the card.
    const h = createReconciliation({
      gatewayType: PaymentGatewayType.CRYPTOMUS,
      currency: Currency.USDT,
      amount: '12.34000000',
      eventStatus: 'paid',
      rawPayload: {
        uuid: 'inv-2',
        status: 'paid',
        payment_amount: '12.33999999',
        currency: 'USDT',
      },
    });

    await h.service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(h.events, []);
    assert.equal(h.gatewayData().notifiedAmount, undefined);
    assert.equal(h.gatewayData().notifiedAmountShortfallAt, undefined);
    // The payment is untouched in every other respect.
    assert.equal(h.gatewayData().providerStatus, 'paid');
    assert.deepStrictEqual(h.fulfillments, ['tx-1']);
  });

  it('still reports a difference that is actually a difference', async () => {
    // The tolerance must not become "never alerts": one kopeck past it and the
    // note fires, so the check keeps the value it was added for.
    const h = createReconciliation({
      gatewayType: PaymentGatewayType.CRYPTOMUS,
      currency: Currency.USDT,
      amount: '12.34000000',
      eventStatus: 'paid',
      rawPayload: {
        uuid: 'inv-3',
        status: 'paid',
        payment_amount: '12.33000000',
        currency: 'USDT',
      },
    });

    await h.service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(
      h.events.map((event) => event.type),
      [EVENT_TYPES.PAYMENT_NOTIFIED_AMOUNT_SHORT],
    );
    assert.equal(h.events[0].metadata.notifiedAmount, '12.33');
    assert.equal(h.events[0].metadata.amount, '12.34');
  });
});

describe('gateways whose reported sum may be net of commission', () => {
  it('does not compare one whose field definition has not been read', async () => {
    // Antilopay's `amount` turned out to be net of `fee`, which would have made
    // every honest payment through it look short by the commission and alerted
    // on all of them. Wata reports a plain `amount` that nobody has checked
    // against its documentation, so it is outside the compared set until
    // somebody does — one gateway alerting on every single payment would cost
    // the check its credibility on all of them at once.
    const h = createReconciliation({
      gatewayType: PaymentGatewayType.WATA,
      currency: Currency.RUB,
      amount: '1000.00',
      eventStatus: 'Paid',
      rawPayload: {
        orderId: 'payment-1',
        transactionStatus: 'Paid',
        amount: '965.00',
        currency: 'RUB',
      },
    });

    await h.service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(h.events, []);
    assert.equal(h.gatewayData().notifiedAmount, undefined);
    // And the payment itself is completed and fulfilled as normal — being
    // outside the compared set changes nothing else about it.
    assert.equal(h.updates[0].data.status, TransactionStatus.COMPLETED);
    assert.deepStrictEqual(h.fulfillments, ['tx-1']);
  });

  it('still compares the ones that have been read', async () => {
    // The counterpart: Antilopay is IN the set, on `original_amount` — the sum
    // recorded at creation, the field the net-of-fee discovery moved it to.
    const h = createReconciliation({
      gatewayType: PaymentGatewayType.ANTILOPAY,
      currency: Currency.RUB,
      amount: '1000.00',
      eventStatus: 'SUCCESS',
      rawPayload: {
        order_id: 'payment-1',
        status: 'SUCCESS',
        original_amount: '900.00',
        amount: '865.00',
        fee: '35.00',
        currency: 'rub',
      },
    });

    await h.service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(
      h.events.map((event) => event.type),
      [EVENT_TYPES.PAYMENT_NOTIFIED_AMOUNT_SHORT],
    );
    // Read from `original_amount`, not from the net `amount` beside it.
    assert.equal(h.events[0].metadata.notifiedAmount, '900');
  });
});

async function renderCard(
  type: string,
  metadata: Record<string, unknown>,
): Promise<string> {
  let cardText: string | null = null;
  // The dev firehose rides the durable relay queue now. This suite only wants
  // the rendered card, so capture it off whichever road carries it — the
  // routing itself is `system-events-dev-fallback.spec.ts`'s subject.
  const capture = (event: string, meta: Record<string, unknown>): void => {
    if (event === 'reiwa.dev.notify') cardText = meta['text'] as string;
  };
  const notifier = {
    deliverRelayEvent: async (event: string, meta: Record<string, unknown>) => {
      capture(event, meta);
      return { status: 'unconfirmed', messageId: null, httpStatus: 204, detail: null };
    },
  };
  const relayQueue = {
    enqueue: async (event: string, meta: Record<string, unknown>) => {
      capture(event, meta);
      return true;
    },
  };
  const service = new SystemEventsService(
    {
      settings: {
        findFirst: async () => ({
          systemNotifications: { telegram: { enabled: false, chatId: null, devChatId: null } },
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
        if (token === BotNotifierClient) return notifier;
        if (token === ReiwaRelayQueueService) return relayQueue;
        throw new Error('not registered');
      },
    } as never,
  );

  service.warn(type, 'PAYMENT', 'raw machine message', {
    paymentId: 'payment-1',
    gatewayType: PaymentGatewayType.CRYPTOMUS,
    amount: '12.34',
    notifiedAmount: '6.40',
    currency: Currency.USDT,
    ...metadata,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const text = cardText as string | null;
  assert.ok(text !== null, `card text should be captured for ${type}`);
  return text;
}

interface ReconcileHarness {
  readonly service: PaymentReconciliationService;
  readonly updates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  readonly events: EmittedEvent[];
  readonly fulfillments: string[];
  readonly gatewayData: () => Record<string, unknown>;
}

function createReconciliation(input: {
  readonly gatewayType: PaymentGatewayType;
  readonly currency: Currency;
  readonly amount: string;
  readonly eventStatus: string;
  readonly rawPayload: Record<string, unknown>;
}): ReconcileHarness {
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
  const events: EmittedEvent[] = [];
  const fulfillments: string[] = [];

  const transaction = {
    id: 'tx-1',
    paymentId: 'payment-1',
    userId: 'user-1',
    subscriptionId: null as string | null,
    fulfilledAt: null as Date | null,
    status: TransactionStatus.PENDING,
    isTest: false,
    purchaseType: PurchaseType.NEW,
    gatewayType: input.gatewayType,
    currency: input.currency,
    amount: new Prisma.Decimal(input.amount),
    gatewayId: 'provider-invoice-1' as string | null,
    gatewayData: null as Record<string, unknown> | null,
    createdAt: new Date('2026-04-19T12:00:00.000Z'),
    updatedAt: new Date('2026-04-19T12:00:00.000Z'),
  };

  const client = {
    paymentWebhookEvent: {
      findUnique: async () => ({
        id: 'event-1',
        gatewayType: input.gatewayType,
        paymentId: 'payment-1',
        eventStatus: input.eventStatus,
        rawPayload: input.rawPayload,
      }),
    },
    transaction: {
      findUnique: async () => transaction,
      findFirst: async () => null,
      count: async () => 0,
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push(args);
        return transaction;
      },
      // Fulfilment claim — matches only while the row is unfulfilled.
      updateMany: async () => ({ count: 1 }),
    },
    trialClaim: { updateMany: async () => ({ count: 0 }) },
    $queryRaw: async () => [{ id: 'tx-1' }],
  };

  const service = new PaymentReconciliationService(
    { ...client, $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client) } as never,
    {
      incrementReconciliationAttempts: async () => undefined,
      markProcessing: async () => undefined,
      markProcessed: async () => undefined,
      markFailed: async () => ({}),
    } as never,
    {
      applyCompletedTransaction: async (tx: { id: string }) => {
        fulfillments.push(tx.id);
        return { syncJobs: [] };
      },
    } as never,
    { notifyWebhookFailed: async () => undefined } as never,
    {
      processPartnerEarning: async () => undefined,
      reverseEarningsForTransaction: async () => undefined,
    } as never,
    {
      qualifyReferralAfterPurchase: async () => undefined,
      reverseQualificationForTransaction: async () => undefined,
    } as never,
    { enqueue: async () => undefined } as never,
    {
      info: (type: string, category: string, message: string, metadata?: Record<string, unknown>) => {
        events.push({ severity: 'INFO', type, category, message, metadata: metadata ?? {} });
      },
      warn: (type: string, category: string, message: string, metadata?: Record<string, unknown>) => {
        events.push({ severity: 'WARNING', type, category, message, metadata: metadata ?? {} });
      },
      error: (type: string, category: string, message: string, metadata?: Record<string, unknown>) => {
        events.push({ severity: 'ERROR', type, category, message, metadata: metadata ?? {} });
      },
    } as never,
    {
      enqueueRegisterIncome: async () => undefined,
      enqueueCancelIncome: async () => undefined,
    } as never,
    { recordFirstPurchase: async () => undefined, revertConversion: async () => undefined } as never,
    { upsertFromYookassaPayment: async () => undefined } as never,
    // No gateway here is YooKassa, so the provider round-trip must never fire.
    {
      verifyCompletion: async () => {
        throw new Error('no provider verification on a non-YooKassa gateway');
      },
    } as never,
    { creditForTransactionBestEffort: async () => undefined, reverseForTransactionBestEffort: async () => undefined } as never,
    { create: async () => 'event-1' } as never,
  );

  return {
    service,
    updates,
    events,
    fulfillments,
    gatewayData: () =>
      (updates[updates.length - 1]?.data.gatewayData ?? {}) as Record<string, unknown>,
  };
}
