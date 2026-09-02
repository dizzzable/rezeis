import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  Currency,
  PaymentGatewayType,
  Prisma,
  PurchaseType,
  TransactionStatus,
} from '@prisma/client';

import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { PaymentReconciliationService } from '../src/modules/payments/services/payment-reconciliation.service';

/**
 * The notified sum, compared against what we booked
 * ────────────────────────────────────────────────
 * The reconciler now reads the sum the provider reported — through the webhook
 * normalizer's own extraction, so ingress and reconciliation can never read one
 * payload two ways — and warns when it comes in SHORT of the booked amount.
 *
 * It ALERTS AND DOES NOT BLOCK, and every spec below asserts the fulfilment
 * still happens, because that is the part most likely to be "improved" into a
 * hold later. The reasoning: this is defence-in-depth, not an anti-forgery
 * control. What we charge is server-derived from a plan quote and entitlement
 * comes from `planSnapshot`, so a forger echoes the correct amount back for
 * free; the only thing the check can catch is an AUTHENTIC notification that
 * disagrees with our record. Against that narrow value, holding would strand a
 * real paying customer PENDING and exempt from the expiry sweep with their
 * trial reservation stuck RESERVED. Genuine underpayment is already blocked
 * ahead of this by `isAmountMismatchProviderStatus`, on the provider's own
 * `wrong_amount` / `UNDERPAID` / `locked` — a path these specs must leave alone.
 *
 * The rest of the file is the false positives. Each one is a real shape in this
 * codebase, and each would put a perfectly good payment on an operator's desk.
 */

interface EmittedEvent {
  readonly severity: 'INFO' | 'WARNING' | 'ERROR';
  readonly type: string;
  readonly category: string;
  readonly message: string;
  readonly metadata: Record<string, unknown>;
}

describe('a notified sum that falls short of the booked amount', () => {
  it('warns an operator AND fulfils the payment anyway', async () => {
    // Cryptomus says `paid` — a completion — while reporting that 6.40 of the
    // 12.34 we booked actually arrived. That disagreement is the whole target
    // of the check: an authentic notification that does not match our record.
    const h = createReconciliation({
      gatewayType: PaymentGatewayType.CRYPTOMUS,
      currency: Currency.USDT,
      amount: '12.34',
      eventStatus: 'paid',
      rawPayload: {
        uuid: 'invoice-1',
        order_id: 'payment-1',
        status: 'paid',
        amount: '12.34',
        payment_amount: '6.40',
        currency: 'USDT',
      },
    });

    await h.service.reconcileWebhookEvent('event-1');

    // The completion goes through untouched — no hold, no cancellation, no
    // withheld entitlement.
    assert.equal(h.updates.length, 1);
    assert.equal(h.updates[0].data.status, TransactionStatus.COMPLETED);
    assert.deepStrictEqual(h.fulfillments, ['tx-1']);
    assert.deepStrictEqual(h.processed, ['event-1']);
    assert.deepStrictEqual(h.failed, []);

    // The discrepancy is recorded on the row, in the SAME write as the status,
    // so the evidence and the completion it belongs to cannot come apart.
    const gatewayData = h.updates[0].data.gatewayData as Record<string, unknown>;
    assert.equal(gatewayData.notifiedAmount, '6.4');
    assert.equal(typeof gatewayData.notifiedAmountShortfallAt, 'string');
    // And emphatically NOT the flag that parks a row: `paymentNeedsManualReview`
    // is what exempts a transaction from `PaymentPendingExpiryService` and holds
    // its trial reservation. Writing it here would turn an alert into a hold.
    assert.equal(gatewayData.paymentNeedsManualReview, undefined);

    // One operator warning, on its OWN event type. Not the type a HELD payment
    // uses: the ops card renders `EVENT_PRESENTATION[type].title` rather than
    // the message passed at the call site, so sharing a type made a payment that
    // completed perfectly normally arrive titled «Оплачена неверная сумма»,
    // identical to money that is actually stuck, with a metadata line as the
    // only difference.
    assert.deepStrictEqual(
      h.events.filter((event) => event.type === EVENT_TYPES.PAYMENT_AMOUNT_MISMATCH),
      [],
    );
    const alerts = h.events.filter(
      (event) => event.type === EVENT_TYPES.PAYMENT_NOTIFIED_AMOUNT_SHORT,
    );
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].type, 'payment.notified_amount_short');
    assert.equal(alerts[0].severity, 'WARNING');
    assert.equal(alerts[0].category, 'PAYMENT');
    assert.equal(alerts[0].metadata.needsManualReview, false);
    assert.equal(alerts[0].metadata.notifiedAmount, '6.4');
    assert.equal(alerts[0].metadata.amount, '12.34');
    assert.equal(alerts[0].metadata.currency, Currency.USDT);
    assert.equal(alerts[0].metadata.providerStatus, 'paid');
    assert.equal(alerts[0].metadata.paymentId, 'payment-1');
  });

  it('says nothing when the notified sum matches, whatever the provider spelled it as', async () => {
    // The control. Over-matching here would put every good payment on an
    // operator's desk, which is the failure mode that makes an alert useless.
    const matched = createReconciliation({
      gatewayType: PaymentGatewayType.CRYPTOMUS,
      currency: Currency.USDT,
      amount: '12.34',
      eventStatus: 'paid',
      rawPayload: { uuid: 'inv-1', status: 'paid', payment_amount: '12.34', currency: 'USDT' },
    });

    await matched.service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(matched.alerts(), []);
    assert.equal(matched.gatewayData().notifiedAmount, undefined);
    assert.deepStrictEqual(matched.fulfillments, ['tx-1']);

    // Same number, the provider's own trailing zeros. Compared as
    // `Prisma.Decimal`, not as text — a string comparison would alert on every
    // gateway whose scale differs from ours by a digit.
    const padded = createReconciliation({
      gatewayType: PaymentGatewayType.CRYPTOMUS,
      currency: Currency.USDT,
      amount: '12.34',
      eventStatus: 'paid',
      rawPayload: { uuid: 'inv-2', status: 'paid', payment_amount: '12.3400', currency: 'USDT' },
    });

    await padded.service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(padded.alerts(), []);
    assert.deepStrictEqual(padded.fulfillments, ['tx-1']);
  });
});

describe('the false positives this check must never produce', () => {
  it('treats an overpayment as no discrepancy at all', async () => {
    // Cryptomus `paid_over` maps to COMPLETED on purpose — the buyer paid MORE
    // than invoiced and the money is ours — and its `payment_amount` therefore
    // legitimately exceeds what we booked. The crypto rails do this routinely
    // (round numbers, network fee covered), and Pally has `OVERPAID` for the
    // same thing on cards. A plain inequality would alert on every generous
    // customer, which on those gateways is most of the traffic.
    const h = createReconciliation({
      gatewayType: PaymentGatewayType.CRYPTOMUS,
      currency: Currency.USDT,
      amount: '12.34',
      eventStatus: 'paid_over',
      rawPayload: {
        uuid: 'invoice-2',
        status: 'paid_over',
        amount: '12.34',
        payment_amount: '15.00',
        currency: 'USDT',
      },
    });

    await h.service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(h.alerts(), []);
    assert.equal(h.gatewayData().notifiedAmount, undefined);
    assert.equal(h.updates[0].data.status, TransactionStatus.COMPLETED);
    assert.deepStrictEqual(h.fulfillments, ['tx-1']);
  });

  it('never compares a gateway whose signature does not cover the amount', async () => {
    // Platega authenticates with `X-MerchantId` + `X-Secret`: static headers
    // that prove the sender knows a secret and bind nothing in the body. The
    // sum could have been rewritten in flight without invalidating anything, so
    // neither a match nor a mismatch is evidence — comparing it only
    // manufactures noise, on this and the four other uncovered gateways.
    const h = createReconciliation({
      gatewayType: PaymentGatewayType.PLATEGA,
      currency: Currency.USD,
      amount: '12.34',
      eventStatus: 'CONFIRMED',
      rawPayload: {
        id: 'platega-event-1',
        payload: 'payment-1',
        status: 'CONFIRMED',
        amount: '1.00',
        currency: 'USD',
      },
    });

    await h.service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(h.alerts(), []);
    assert.equal(h.gatewayData().notifiedAmount, undefined);
    assert.deepStrictEqual(h.fulfillments, ['tx-1']);
  });

  it('does not trust a Pally currency just because the Pally amount is signed', async () => {
    // Coverage is per FIELD. Pally signs `md5(OutSum + ":" + InvId +
    // ":" + apiToken)`, which names the sum and the invoice id; `CurrencyIn`
    // rides in the same form body bound to nothing. A signed 6.40 beside a
    // ticker anyone could rewrite is not comparable to a booked sum — so this
    // shortfall, whose amount IS trustworthy, still says nothing.
    const h = createReconciliation({
      gatewayType: PaymentGatewayType.PAYPALYCH,
      currency: Currency.RUB,
      amount: '12.34',
      eventStatus: 'SUCCESS',
      rawPayload: { InvId: 'payment-1', Status: 'SUCCESS', OutSum: '6.40', CurrencyIn: 'RUB' },
    });

    await h.service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(h.alerts(), []);
    assert.equal(h.gatewayData().notifiedAmount, undefined);
    assert.deepStrictEqual(h.fulfillments, ['tx-1']);
  });

  it('does not read a sum denominated in another currency as a shortfall', async () => {
    // Nothing here converts, and several of these providers can settle in a coin
    // other than the one invoiced. 10 USDT against a 900 RUB booking is a unit
    // error, not an underpayment.
    const h = createReconciliation({
      gatewayType: PaymentGatewayType.CRYPTOMUS,
      currency: Currency.RUB,
      amount: '900.00',
      eventStatus: 'paid',
      rawPayload: { uuid: 'invoice-3', status: 'paid', payment_amount: '10.00', currency: 'USDT' },
    });

    await h.service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(h.alerts(), []);
    assert.deepStrictEqual(h.fulfillments, ['tx-1']);
  });

  it('compares nothing when the provider reports no amount — absent is not zero', async () => {
    // Antilopay reports no sum at all when `original_amount` is missing, and
    // that is deliberate: its `amount` is NET OF `fee`, so falling back to it
    // would make every honest payment look short by the commission. The body
    // below is exactly that shape — 965.00 net of a 35.00 fee against a
    // 1000.00 booking — and everything else lines up (Antilopay signs the whole
    // document, and `rub` upper-cases to the booked RUB), so a fallback or a
    // zero would fire here and nowhere else would stop it.
    const h = createReconciliation({
      gatewayType: PaymentGatewayType.ANTILOPAY,
      currency: Currency.RUB,
      amount: '1000.00',
      eventStatus: 'SUCCESS',
      rawPayload: {
        order_id: 'payment-1',
        status: 'SUCCESS',
        amount: '965.00',
        fee: '35.00',
        currency: 'rub',
      },
    });

    await h.service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(h.alerts(), []);
    assert.equal(h.gatewayData().notifiedAmount, undefined);
    assert.deepStrictEqual(h.fulfillments, ['tx-1']);
  });

  it('leaves the refund path untouched — a refunded sum is not a paid sum', async () => {
    // A refund notification reports what was GIVEN BACK, not what was paid
    // (YooKassa's `object` on a `refund.succeeded` is a Refund). Wata is the
    // sharp case: it signs its body, and it announces a completed refund with
    // the same `transactionStatus: "Paid"` as a sale, telling the two apart only
    // by `kind` — so this 5.00 is a covered, same-currency figure short of the
    // 1000.00 booking, and would alert if it were ever compared.
    //
    // Two independent things stop it: a refund status maps to CANCELED, so it
    // never reaches a COMPLETED-gated check, and a refund on a fulfilled row
    // returns into the reversal long before. The second is asserted here so the
    // gate is not quietly relied upon by the first alone. (Wata has since also
    // fallen outside `GROSS_REPORTING_GATEWAYS` — its plain `amount` may or may
    // not be net of commission and nobody has read the docs — so the refund gate
    // this spec exists for is now the third line of defence, not the last.)
    const h = createReconciliation({
      gatewayType: PaymentGatewayType.WATA,
      currency: Currency.RUB,
      amount: '1000.00',
      eventStatus: 'REFUNDED',
      transactionStatus: TransactionStatus.COMPLETED,
      fulfilledAt: new Date('2026-04-19T11:00:00.000Z'),
      rawPayload: {
        id: 'wata-refund-1',
        kind: 'REFUND',
        transactionStatus: 'Paid',
        amount: '5.00',
        currency: 'RUB',
      },
    });

    await h.service.reconcileWebhookEvent('event-1');

    // The reversal ran, which is what this event is for.
    assert.deepStrictEqual(h.reversals, ['tx-1']);
    assert.deepStrictEqual(h.processed, ['event-1']);
    // And nothing anywhere read the refunded sum as an underpayment.
    assert.deepStrictEqual(h.alerts(), []);
    for (const update of h.updates) {
      const gatewayData = (update.data.gatewayData ?? {}) as Record<string, unknown>;
      assert.equal(gatewayData.notifiedAmount, undefined);
      assert.equal(gatewayData.notifiedAmountShortfallAt, undefined);
    }
  });
});

describe('the manual-review hold reads the same extraction', () => {
  it('shows the operator the invoiced coin, not the payer_amount in theirs', async () => {
    // The hold path (`wrong_amount` and friends) used to sweep root keys in a
    // fixed order, and `payer_amount` sat second in it — the same money in the
    // PAYER's own coin, which pairs with `payer_currency` and not with ours. On
    // a body that omits `payment_amount` the operator was handed 0.00021 BTC as
    // the evidence for a 12.34 USDT invoice. Sharing the normalizer's
    // per-gateway extraction is what fixes it: Cryptomus reads
    // `payment_amount` then `amount`, and never the payer pair.
    const h = createReconciliation({
      gatewayType: PaymentGatewayType.CRYPTOMUS,
      currency: Currency.USDT,
      amount: '12.34',
      eventStatus: 'wrong_amount',
      rawPayload: {
        uuid: 'invoice-4',
        status: 'wrong_amount',
        amount: '12.34',
        payer_amount: '0.00021',
        payer_currency: 'BTC',
        currency: 'USDT',
      },
    });

    await h.service.reconcileWebhookEvent('event-1');

    assert.equal(h.gatewayData().notifiedAmount, '12.34');
    // The hold path is unchanged in every other respect: it still parks the row.
    assert.equal(h.gatewayData().paymentNeedsManualReview, true);
    assert.equal(h.alerts()[0].metadata.needsManualReview, true);
    assert.deepStrictEqual(h.fulfillments, []);
  });
});

interface ReconcileHarness {
  readonly service: PaymentReconciliationService;
  readonly updates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  readonly events: EmittedEvent[];
  readonly processed: string[];
  readonly failed: string[];
  readonly fulfillments: string[];
  readonly reversals: string[];
  readonly alerts: () => EmittedEvent[];
  readonly gatewayData: () => Record<string, unknown>;
}

function createReconciliation(input: {
  readonly gatewayType: PaymentGatewayType;
  readonly currency: Currency;
  readonly amount: string;
  readonly eventStatus: string;
  readonly rawPayload: Record<string, unknown>;
  readonly transactionStatus?: TransactionStatus;
  readonly fulfilledAt?: Date | null;
}): ReconcileHarness {
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
  const events: EmittedEvent[] = [];
  const processed: string[] = [];
  const failed: string[] = [];
  const fulfillments: string[] = [];
  const reversals: string[] = [];

  const transaction = {
    id: 'tx-1',
    paymentId: 'payment-1',
    userId: 'user-1',
    subscriptionId: null as string | null,
    fulfilledAt: input.fulfilledAt ?? null,
    status: input.transactionStatus ?? TransactionStatus.PENDING,
    isTest: false,
    purchaseType: PurchaseType.NEW,
    gatewayType: input.gatewayType,
    currency: input.currency,
    amount: new Prisma.Decimal(input.amount),
    gatewayId: null as string | null,
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
    // The refund ledger's `SELECT ... FOR UPDATE` row lock.
    $queryRaw: async () => [{ id: 'tx-1' }],
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
    { notifyWebhookFailed: async () => undefined } as never,
    {
      processPartnerEarning: async () => undefined,
      reverseEarningsForTransaction: async (transactionId: string) => {
        reversals.push(transactionId);
      },
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
    processed,
    failed,
    fulfillments,
    reversals,
    // Both cards this file can provoke: the informational shortfall note and the
    // hold. Asserting on the pair is what keeps "says nothing" specs honest — a
    // filter on one type alone would go quiet if the code emitted the other.
    alerts: () =>
      events.filter(
        (event) =>
          event.type === EVENT_TYPES.PAYMENT_NOTIFIED_AMOUNT_SHORT ||
          event.type === EVENT_TYPES.PAYMENT_AMOUNT_MISMATCH,
      ),
    gatewayData: () =>
      (updates[updates.length - 1]?.data.gatewayData ?? {}) as Record<string, unknown>,
  };
}
