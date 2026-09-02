import 'reflect-metadata';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Currency, PaymentGatewayType, Prisma, PurchaseType, TransactionStatus } from '@prisma/client';

import { EVENT_TYPES, SystemEventsService } from '../src/common/services/system-events.service';
import { BotNotifierClient } from '../src/modules/notifications/services/bot-notifier.client';
import { ReiwaRelayQueueService } from '../src/modules/notifications/services/reiwa-relay-queue.service';
import { PaymentPendingExpiryService } from '../src/modules/payments/services/payment-pending-expiry.service';
import { PaymentReconciliationService } from '../src/modules/payments/services/payment-reconciliation.service';

/**
 * Underpaid invoices
 * ──────────────────
 * Cryptomus/Heleket `wrong_amount` and Pally `UNDERPAID` both mean the buyer
 * paid SHORT — the money is already ours — and the provider documents the
 * status as final, so the invoice can never complete. Neither matched any
 * branch of the status map: both fell through to the PENDING default, and the
 * pending-expiry sweep then cancelled the row on our own TTL emitting only the
 * routine abandoned-cart INFO event. A paid-but-short invoice and a checkout
 * nobody ever opened produced byte-identical operator output.
 *
 * These specs pin the two halves that fix it, which only work as a pair: the
 * row is flagged and an operator is ALERTED, and the sweep then leaves the
 * flagged row alone so the queue does not empty itself.
 */

interface EmittedEvent {
  readonly severity: 'INFO' | 'WARNING' | 'ERROR';
  readonly type: string;
  readonly category: string;
  readonly message: string;
  readonly metadata: Record<string, unknown>;
}

describe('reconciliation of a payment that arrived in the wrong amount', () => {
  it('Cryptomus wrong_amount: holds the row, flags it, and alerts an operator', async () => {
    const h = createReconciliation({
      gatewayType: PaymentGatewayType.CRYPTOMUS,
      eventStatus: 'wrong_amount',
      rawPayload: {
        uuid: 'invoice-1',
        status: 'wrong_amount',
        // What we asked for vs what the buyer actually sent.
        amount: '12.34',
        payment_amount: '6.40',
      },
    });

    await h.service.reconcileWebhookEvent('event-1');

    // Exactly one write, and it does NOT touch `status` — the row stays PENDING
    // rather than being completed on a partial payment or cancelled outright.
    assert.equal(h.updates.length, 1);
    assert.equal(h.updates[0].data.status, undefined);
    const gatewayData = h.updates[0].data.gatewayData as Record<string, unknown>;
    assert.equal(gatewayData.paymentNeedsManualReview, true);
    assert.equal(gatewayData.providerStatus, 'wrong_amount');
    // The amount the provider says arrived — the operator's evidence. Read
    // through the webhook normalizer's shared extraction now rather than a
    // root-key sweep, so the figure is a `Prisma.Decimal.toString()`: the value
    // is exact, the provider's trailing zero is not preserved. What that buys is
    // the shapes the sweep could not see at all (YooKassa's `object.amount`,
    // Overpay's kopecks) and the one it read wrongly (Antilopay's net-of-fee).
    assert.equal(gatewayData.notifiedAmount, '6.4');
    assert.equal(typeof gatewayData.amountMismatchAt, 'string');

    // The alert is the load-bearing half: without it the sweep exemption below
    // would just strand the row silently.
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].type, EVENT_TYPES.PAYMENT_AMOUNT_MISMATCH);
    assert.equal(h.events[0].type, 'payment.amount_mismatch');
    assert.equal(h.events[0].severity, 'WARNING');
    assert.equal(h.events[0].category, 'PAYMENT');
    assert.equal(h.events[0].metadata.needsManualReview, true);
    assert.equal(h.events[0].metadata.providerStatus, 'wrong_amount');
    assert.equal(h.events[0].metadata.notifiedAmount, '6.4');
    // Invoiced, for contrast with what actually arrived.
    assert.equal(h.events[0].metadata.amount, '12.34');
    assert.equal(h.events[0].metadata.paymentId, 'payment-1');

    // Nothing was fulfilled: a partial payment must not buy a full subscription.
    assert.deepStrictEqual(h.fulfillments, []);
    // The trial reservation is deliberately NOT released — the row is still
    // live and an operator owns it now. That is the cost the alert pays for.
    assert.deepStrictEqual(h.trialReleases, []);
    // The notification was delivered correctly, so it is acked, not failed —
    // throwing here would libel a legitimate webhook as broken.
    assert.deepStrictEqual(h.processed, ['event-1']);
    assert.deepStrictEqual(h.failed, []);
    assert.deepStrictEqual(h.opsAlerts, []);
  });

  it('Pally UNDERPAID: same treatment on the card rail', async () => {
    const h = createReconciliation({
      gatewayType: PaymentGatewayType.PAYPALYCH,
      eventStatus: 'UNDERPAID',
      // Pally posts a flat form body; the paid sum is `OutSum`.
      rawPayload: { InvId: 'payment-1', Status: 'UNDERPAID', OutSum: '7.50' },
    });

    await h.service.reconcileWebhookEvent('event-1');

    assert.equal(h.updates.length, 1);
    assert.equal(h.updates[0].data.status, undefined);
    const gatewayData = h.updates[0].data.gatewayData as Record<string, unknown>;
    assert.equal(gatewayData.paymentNeedsManualReview, true);
    assert.equal(gatewayData.providerStatus, 'UNDERPAID');
    assert.equal(gatewayData.notifiedAmount, '7.5');

    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].type, EVENT_TYPES.PAYMENT_AMOUNT_MISMATCH);
    assert.equal(h.events[0].severity, 'WARNING');
    assert.equal(h.events[0].metadata.needsManualReview, true);
    assert.equal(h.events[0].metadata.notifiedAmount, '7.5');

    assert.deepStrictEqual(h.fulfillments, []);
    assert.deepStrictEqual(h.processed, ['event-1']);
    assert.deepStrictEqual(h.failed, []);
  });

  it('an ordinary paid webhook is untouched by the mismatch branch', async () => {
    // The control: over-matching would divert good payments into the operator
    // queue and stop fulfilling them.
    const h = createReconciliation({
      gatewayType: PaymentGatewayType.CRYPTOMUS,
      eventStatus: 'paid',
      rawPayload: { uuid: 'invoice-1', status: 'paid', amount: '10.00', payment_amount: '10.00' },
    });

    await h.service.reconcileWebhookEvent('event-1');

    assert.equal(h.updates[0].data.status, TransactionStatus.COMPLETED);
    const gatewayData = h.updates[0].data.gatewayData as Record<string, unknown>;
    assert.equal(gatewayData.paymentNeedsManualReview, undefined);
    assert.deepStrictEqual(h.fulfillments, ['tx-1']);
    assert.deepStrictEqual(
      h.events.filter((event) => event.type === EVENT_TYPES.PAYMENT_AMOUNT_MISMATCH),
      [],
    );
  });
});

describe('pending-expiry sweep and the manual-review queue', () => {
  it('leaves a row flagged for manual review alone, and cancels an ordinary stale one', async () => {
    // Both rows are equally stale. Only the difference in `gatewayData` may
    // decide their fate: cancelling the flagged one would empty the operator's
    // queue behind their back and re-file a paid invoice as an abandoned cart.
    const h = createExpiry([
      {
        id: 'tx-underpaid',
        gatewayData: { providerStatus: 'wrong_amount', paymentNeedsManualReview: true },
      },
      { id: 'tx-abandoned', gatewayData: null },
    ]);

    await h.service.expireStalePending();

    assert.deepStrictEqual(h.cancelled, ['tx-abandoned']);
    // The trial reservation of the flagged row is held with it — deliberately,
    // because an operator is resolving the row by hand.
    assert.deepStrictEqual(h.releases, ['tx-abandoned']);
    // And no routine expiry event may claim the paid invoice went unpaid.
    assert.deepStrictEqual(
      h.events.map((event) => event.metadata.paymentId),
      ['pay-tx-abandoned'],
    );
    assert.equal(h.events[0].type, EVENT_TYPES.PAYMENT_EXPIRED);
  });

  it('does not exempt a row on a merely truthy leftover value', async () => {
    // The flag is the only thing standing between a stale row and cancellation,
    // so it must match strictly — an unrelated string must not strand a row
    // PENDING forever with its trial reservation held.
    const h = createExpiry([
      { id: 'tx-1', gatewayData: { paymentNeedsManualReview: 'no' } },
      { id: 'tx-2', gatewayData: { providerStatus: 'process' } },
    ]);

    await h.service.expireStalePending();

    assert.deepStrictEqual(h.cancelled, ['tx-1', 'tx-2']);
  });
});

describe('payment.amount_mismatch operator card', () => {
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.BOT_TOKEN;
    delete process.env.BOT_TOKEN;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = savedToken;
  });

  it('renders with a title instead of the raw machine message', async () => {
    // Registering the type in EVENT_TYPES is only half of it: a type missing
    // from the presentation registry falls through to `severityEmoji` + the raw
    // message, and the operator gets an untitled card.
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

    service.warn(EVENT_TYPES.PAYMENT_AMOUNT_MISMATCH, 'PAYMENT', 'raw machine message', {
      paymentId: 'payment-1',
      gatewayType: PaymentGatewayType.CRYPTOMUS,
      amount: '10.00',
      notifiedAmount: '6.40',
      currency: Currency.USD,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const text = cardText as string | null;
    assert.ok(text !== null, 'card text should be captured');
    assert.ok(text.includes('Событие: Оплачена неверная сумма!'));
    assert.ok(!text.includes('raw machine message'));
  });
});

interface ReconcileHarness {
  readonly service: PaymentReconciliationService;
  readonly updates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  readonly events: EmittedEvent[];
  readonly processed: string[];
  readonly failed: string[];
  readonly opsAlerts: unknown[];
  readonly fulfillments: string[];
  readonly trialReleases: string[];
}

function createReconciliation(input: {
  readonly gatewayType: PaymentGatewayType;
  readonly eventStatus: string;
  readonly rawPayload: Record<string, unknown>;
}): ReconcileHarness {
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
  const events: EmittedEvent[] = [];
  const processed: string[] = [];
  const failed: string[] = [];
  const opsAlerts: unknown[] = [];
  const fulfillments: string[] = [];
  const trialReleases: string[] = [];

  const transaction = {
    id: 'tx-1',
    paymentId: 'payment-1',
    userId: 'user-1',
    subscriptionId: null,
    fulfilledAt: null as Date | null,
    status: TransactionStatus.PENDING,
    isTest: false,
    purchaseType: PurchaseType.NEW,
    gatewayType: input.gatewayType,
    currency: Currency.USD,
    amount: new Prisma.Decimal('12.34'),
    gatewayId: null,
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
      // Fulfillment claim — matches only while the row is unfulfilled.
      updateMany: async () => ({ count: 1 }),
    },
    trialClaim: {
      updateMany: async (args: { where: Record<string, unknown> }) => {
        trialReleases.push(String(args.where['transactionId']));
        return { count: 1 };
      },
    },
  };

  const service = new PaymentReconciliationService(
    { ...client, $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client) } as never,
    {
      incrementReconciliationAttempts: async () => undefined,
      markProcessing: async () => undefined,
      markProcessed: async (eventId: string) => {
        processed.push(eventId);
      },
      markFailed: async (eventId: string) => {
        failed.push(eventId);
        return {};
      },
    } as never,
    {
      applyCompletedTransaction: async (tx: { id: string }) => {
        fulfillments.push(tx.id);
        return { syncJobs: [] };
      },
    } as never,
    {
      notifyWebhookFailed: async (alert: unknown) => {
        opsAlerts.push(alert);
      },
    } as never,
    { processPartnerEarning: async () => undefined } as never,
    { qualifyReferralAfterPurchase: async () => undefined } as never,
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
    { enqueueRegisterIncome: async () => undefined } as never,
    { recordFirstPurchase: async () => undefined } as never,
    { upsertFromYookassaPayment: async () => undefined } as never,
    // No gateway here is YooKassa, so the provider round-trip must never fire.
    {
      verifyCompletion: async () => {
        throw new Error('no provider verification on a non-YooKassa gateway');
      },
    } as never,
    { creditForTransactionBestEffort: async () => undefined, reverseForTransactionBestEffort: async () => undefined } as never,
  );

  return { service, updates, events, processed, failed, opsAlerts, fulfillments, trialReleases };
}

interface ExpiryHarness {
  readonly service: PaymentPendingExpiryService;
  readonly cancelled: string[];
  readonly releases: string[];
  readonly events: EmittedEvent[];
}

function createExpiry(
  rows: ReadonlyArray<{ readonly id: string; readonly gatewayData: Record<string, unknown> | null }>,
): ExpiryHarness {
  const cancelled: string[] = [];
  const releases: string[] = [];
  const events: EmittedEvent[] = [];

  // A crypto gateway takes the `local-ttl` path with no provider poll — the
  // same path every non-YooKassa gateway takes, and the one that used to cancel
  // these rows.
  const stale = rows.map((row) => ({
    id: row.id,
    paymentId: `pay-${row.id}`,
    userId: 'user-1',
    purchaseType: PurchaseType.NEW,
    gatewayType: PaymentGatewayType.CRYPTOMUS,
    gatewayId: 'invoice-1',
    gatewayData: row.gatewayData,
    amount: new Prisma.Decimal('10.00'),
    currency: Currency.USD,
  }));

  const client = {
    transaction: {
      findMany: async () => stale,
      updateMany: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        assert.equal(args.data['status'], TransactionStatus.CANCELED);
        cancelled.push(args.where.id);
        return { count: 1 };
      },
    },
    trialClaim: {
      updateMany: async (args: { where: Record<string, unknown> }) => {
        releases.push(String(args.where['transactionId']));
        return { count: 1 };
      },
    },
  };

  const service = new PaymentPendingExpiryService(
    { ...client, $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client) } as never,
    {
      info: (type: string, category: string, message: string, metadata?: Record<string, unknown>) => {
        events.push({ severity: 'INFO', type, category, message, metadata: metadata ?? {} });
      },
      warn: (type: string, category: string, message: string, metadata?: Record<string, unknown>) => {
        events.push({ severity: 'WARNING', type, category, message, metadata: metadata ?? {} });
      },
    } as never,
    {
      get: () => {
        throw new Error('no provider poll on a non-YooKassa gateway');
      },
    } as never,
    { applyCompletedTransaction: async () => ({ syncJobs: [] }) } as never,
    { enqueue: async () => undefined } as never,
    { runPostFulfillmentHooks: async () => undefined } as never,
  );

  return { service, cancelled, releases, events };
}
