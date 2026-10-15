import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  Currency,
  PaymentGatewayType,
  Prisma,
  ProviderSubscription,
  ProviderSubscriptionStatus,
  PurchaseType,
  TransactionStatus,
} from '@prisma/client';
import { of } from 'rxjs';

import { PAYMENT_RECONCILIATION_JOB, PROVIDER_SUBSCRIPTION_SYNC_JOB } from '../src/modules/payments/constants/payment-reconciliation.constant';
import { PaymentProviderExecutionService } from '../src/modules/payments/services/payment-provider-execution.service';
import { PaymentWebhookIngressService } from '../src/modules/payments/services/payment-webhook-ingress.service';
import { PaymentWebhookNormalizerService } from '../src/modules/payments/services/payment-webhook-normalizer.service';
import { PaymentWebhookPayloadRedactionService } from '../src/modules/payments/services/payment-webhook-payload-redaction.service';
import { ProviderSubscriptionService } from '../src/modules/payments/services/provider-subscription.service';
import {
  aurapayPaidInvoiceId,
  aurapaySubscriptionRef,
  mapAurapaySubscriptionStatus,
  parseAurapaySubscription,
  readAurapayCallbackReferences,
  readAurapayDate,
} from '../src/modules/payments/utils/aurapay-subscription.util';
import { isAutopayApproved } from '../src/modules/payments/utils/gateway-autopay.util';
import { aurapayIntervalFor, aurapayPeriodForDays } from '../src/modules/payments/utils/provider-subscription-period.util';
import {
  AUTOPAY_NOT_AVAILABLE_CODE,
  PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY,
  resolveProviderSubscriptionTerms,
} from '../src/modules/payments/utils/provider-subscription-terms.util';

const DAY = 24 * 60 * 60 * 1000;
const SETTINGS = { apiKey: 'api-1', shopId: 'shop-1', secretKey: 'secret-2', savePaymentMethod: true };

/**
 * AuraPay's card subscriptions (the owner, 15.10.2026: «автоматические
 * списания есть ещё у … aurapay»), on the terms of docs.aurapay.tech API 1.2.1.
 */
describe('AuraPay subscription terms', () => {
  const base = {
    gatewayType: PaymentGatewayType.AURAPAY as PaymentGatewayType,
    currency: 'RUB',
    amount: new Prisma.Decimal('299'),
    durationDays: 30,
    discountSource: 'NONE' as const,
    planId: 'plan-1',
    subscriptionId: null,
  };

  it('repeats a month as AuraPay\'s month and a year as its year, and every other term in exact days', () => {
    assert.deepEqual(aurapayPeriodForDays(30), { unit: 'month', count: 1 });
    assert.deepEqual(aurapayPeriodForDays(365), { unit: 'year', count: 1 });
    // Six calendar months run past what a renewal stretches over: days, not months.
    assert.deepEqual(aurapayPeriodForDays(180), { unit: 'day', count: 180 });
    for (const days of [7, 14, 60, 90]) {
      assert.deepEqual(aurapayPeriodForDays(days), { unit: 'day', count: days }, String(days));
    }
    for (const days of [1, 31, 45, 120, 360, 730]) {
      assert.equal(aurapayPeriodForDays(days), null, String(days));
    }
    assert.equal(aurapayIntervalFor({ unit: 'week', count: 1 }), null);
    assert.equal(aurapayIntervalFor({ unit: 'day', count: 90 }), 'day');
  });

  it('is a provider subscription, and refuses what AuraPay would not charge', () => {
    assert.deepEqual(resolveProviderSubscriptionTerms(base), {
      terms: { unit: 'month', count: 1, amount: 299, durationDays: 30, planId: 'plan-1', subscriptionId: null },
    });
    const refusal = (overrides: Partial<typeof base>) => {
      const result = resolveProviderSubscriptionTerms({ ...base, ...overrides });
      return 'refusal' in result ? result.refusal : null;
    };
    assert.equal(refusal({ amount: new Prisma.Decimal('50000') }), null, '«до 50 000 ₽» includes it');
    assert.equal(refusal({ amount: new Prisma.Decimal('50001') }), 'AMOUNT');
    assert.equal(refusal({ amount: new Prisma.Decimal('299.50') }), 'AMOUNT');
    assert.equal(refusal({ durationDays: 45 }), 'DURATION');
    assert.equal(refusal({ discountSource: 'PURCHASE' as never }), 'DISCOUNT');
    assert.equal(refusal({ currency: 'USD' }), 'CURRENCY');
  });

  it('is approved by the one switch «Автоплатежи одобрены провайдером», off until turned on', () => {
    assert.equal(isAutopayApproved(PaymentGatewayType.AURAPAY, { savePaymentMethod: true }), true);
    assert.equal(isAutopayApproved(PaymentGatewayType.AURAPAY, { savePaymentMethod: false }), false);
    assert.equal(isAutopayApproved(PaymentGatewayType.AURAPAY, {}), false);
  });
});

describe('AuraPay callbacks and status', () => {
  const body = (value: unknown) => Buffer.from(JSON.stringify(value));

  it("tells a subscription's event from its invoice's callback, and an ordinary payment from both", () => {
    const event = readAurapayCallbackReferences(
      PaymentGatewayType.AURAPAY,
      body({ event: 'PAID', id: 'aura-sub', subscription_id: 'sub-p1', invoice_id: 'inv-2', status: 'ACTIVE' }),
    );
    assert.deepEqual(event, { subscriptionRef: 'sub-p1', event: 'PAID', invoiceId: 'inv-2', orderId: null, status: 'ACTIVE' });
    assert.equal(aurapayPaidInvoiceId(event!), 'inv-2');

    const invoice = readAurapayCallbackReferences(
      PaymentGatewayType.AURAPAY,
      body({ id: 'inv-3', order_id: 'aura-made-up', status: 'PAID', subscription_id: 'sub-p1', amount: '299.00' }),
    );
    assert.deepEqual(invoice, { subscriptionRef: 'sub-p1', event: null, invoiceId: 'inv-3', orderId: 'aura-made-up', status: 'PAID' });
    assert.equal(aurapayPaidInvoiceId(invoice!), 'inv-3');

    // Nothing paid: a failed attempt, a deactivation, an expired first invoice.
    for (const quiet of [
      { event: 'PAYMENT_ERROR', subscription_id: 'sub-p1', invoice_id: null },
      { event: 'DEACTIVATED', subscription_id: 'sub-p1', invoice_id: null, reason: 'user_change_status' },
      { id: 'inv-1', order_id: 'payment-1', status: 'EXPIRED', subscription_id: 'sub-p1' },
    ]) {
      const references = readAurapayCallbackReferences(PaymentGatewayType.AURAPAY, body(quiet));
      assert.ok(references !== null);
      assert.equal(aurapayPaidInvoiceId(references), null, JSON.stringify(quiet));
    }

    // An ordinary invoice has no subscription; another gateway is not AuraPay's.
    assert.equal(
      readAurapayCallbackReferences(PaymentGatewayType.AURAPAY, body({ id: 'inv-9', order_id: 'p-9', status: 'PAID', subscription_id: null })),
      null,
    );
    assert.equal(readAurapayCallbackReferences(PaymentGatewayType.ROLLYPAY, body({ subscription_id: 'sub-p1' })), null);
    assert.equal(readAurapayCallbackReferences(PaymentGatewayType.AURAPAY, Buffer.from('not json')), null);
  });

  it('reads the status in either case, and never an unknown word as a cancellation', () => {
    assert.equal(mapAurapaySubscriptionStatus('active', true), ProviderSubscriptionStatus.ACTIVE);
    assert.equal(mapAurapaySubscriptionStatus('ACTIVE', true), ProviderSubscriptionStatus.ACTIVE);
    assert.equal(mapAurapaySubscriptionStatus('new', false), ProviderSubscriptionStatus.PENDING);
    // The first payment in progress, and a failed charge being retried after it.
    assert.equal(mapAurapaySubscriptionStatus('waiting_payment', false), ProviderSubscriptionStatus.PENDING);
    assert.equal(mapAurapaySubscriptionStatus('waiting_payment', true), ProviderSubscriptionStatus.PAST_DUE);
    assert.equal(mapAurapaySubscriptionStatus('error', true), ProviderSubscriptionStatus.FAILED);
    assert.equal(mapAurapaySubscriptionStatus('deactivated', true), ProviderSubscriptionStatus.CANCELLED);
    assert.equal(mapAurapaySubscriptionStatus('suspended', true), null);
    assert.equal(mapAurapaySubscriptionStatus(null, false), null);
  });

  it("reads AuraPay's dates as Moscow time", () => {
    assert.equal(readAurapayDate('2026-10-11 12:00:00')?.toISOString(), '2026-10-11T09:00:00.000Z');
    assert.equal(readAurapayDate('2026-10-11T12:00:00Z')?.toISOString(), '2026-10-11T12:00:00.000Z');
    assert.equal(readAurapayDate(null), null);
    assert.equal(readAurapayDate('soon'), null);
    const state = parseAurapaySubscription({
      status: 'active',
      next_pay_at: '2026-11-11 12:00:00',
      activated_at: '2026-10-11 12:01:03',
    });
    assert.equal(state.status, ProviderSubscriptionStatus.ACTIVE);
    assert.equal(state.nextChargeAt?.toISOString(), '2026-11-11T09:00:00.000Z');
    assert.equal(state.activatedAt?.toISOString(), '2026-10-11T09:01:03.000Z');
  });

  it("verifies a subscription event's signature the way every AuraPay callback is signed", () => {
    const payload = {
      event: 'PAID',
      id: '0b7c2f4e-6a1d-4f3e-9c2b-5d8e1a7f3b90',
      subscription_id: 'sub-p1',
      shop_id: 'shop-1',
      invoice_id: 'inv-2',
      service: 'card',
      amount: '299.00',
      period: 1,
      interval: 'month',
      status: 'ACTIVE',
      next_pay_at: '2026-11-11 12:00:00',
      payer_details: '411111******1111',
      reason: null,
      created_at: '2026-09-11 12:00:00',
    };
    // «null при формировании строки заменяется пустой строкой», values sorted by key.
    const concatenated = Object.keys(payload)
      .sort()
      .map((key) => {
        const value = (payload as Record<string, unknown>)[key];
        return value === null ? '' : String(value);
      })
      .join('');
    const signature = createHmac('sha256', 'secret-2').update(concatenated).digest('hex');
    const normalizer = new PaymentWebhookNormalizerService();
    const check = (headerSignature: string) =>
      normalizer.verifyWebhookSignature({
        gatewayType: PaymentGatewayType.AURAPAY,
        rawBody: Buffer.from(JSON.stringify(payload)),
        headers: { 'x-signature': headerSignature },
        clientIp: null,
        gatewaySettings: SETTINGS,
      });
    assert.doesNotThrow(() => check(signature));
    assert.throws(() => check(signature.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'))));
  });
});

describe('AuraPay subscription checkout', () => {
  function checkout(
    settings: Record<string, unknown>,
    reply: { status: number; data: unknown } = {
      status: 200,
      data: {
        id: 'inv-1',
        order_id: 'payment-1',
        status: 'PENDING',
        subscription: { id: 'aura-sub', subscription_id: 'sub-payment-1', status: 'new' },
        payment_data: { url: 'https://pay.aurapay.tech/inv-1' },
      },
    },
    snapshot: Record<string, unknown> = {
      id: 'plan-1',
      [PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY]: {
        unit: 'day',
        count: 90,
        amount: 799,
        durationDays: 90,
        planId: 'plan-1',
        subscriptionId: null,
      },
    },
  ) {
    const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
    const cards: unknown[] = [];
    const service = new PaymentProviderExecutionService(
      {
        post: (url: string, payload: unknown, options: { headers: Record<string, string> }) => {
          calls.push({ url, body: payload as Record<string, unknown>, headers: options.headers });
          return of(reply);
        },
      } as never,
      { domain: 'https://user.example', botToken: 'bot' } as never,
      new PaymentWebhookPayloadRedactionService(),
      undefined,
      undefined,
      undefined,
      { warn: (...args: unknown[]) => cards.push(args) } as never,
    );
    const result = service.createCheckout({
      gateway: {
        id: 'gateway-1',
        type: PaymentGatewayType.AURAPAY,
        orderIndex: 1,
        currency: Currency.RUB,
        isActive: true,
        settings,
      } as never,
      transaction: {
        id: 'tx-1',
        paymentId: 'payment-1',
        userId: 'user-1',
        gatewayType: PaymentGatewayType.AURAPAY,
        currency: Currency.RUB,
        amount: new Prisma.Decimal('799'),
        purchaseType: PurchaseType.NEW,
        planSnapshot: snapshot,
      } as never,
      description: 'VPN 90 days',
      successUrl: 'https://reiwa.example/success',
      failUrl: 'https://reiwa.example/fail',
    });
    return { calls, cards, result };
  }

  it('signs the payer up for a card subscription under our own id, which becomes the checkout id', async () => {
    const { calls, result } = checkout(SETTINGS);
    const created = await result;
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://app.aurapay.tech/subscription/create');
    assert.equal(calls[0]?.headers['X-ApiKey'], 'api-1');
    assert.equal(calls[0]?.headers['X-ShopId'], 'shop-1');
    const sent = calls[0]!.body;
    assert.equal(sent.subscription_id, 'sub-payment-1');
    assert.equal(sent.subscription_id, aurapaySubscriptionRef('payment-1'));
    assert.equal(sent.order_id, 'payment-1');
    assert.equal(sent.amount, 799);
    assert.equal(sent.period, 90);
    assert.equal(sent.interval, 'day');
    assert.equal(sent.service, 'card');
    assert.equal(sent.success_url, 'https://reiwa.example/success');
    assert.equal(sent.fail_url, 'https://reiwa.example/fail');
    assert.match(String(sent.callback_url), /\/AURAPAY$/);
    // A per-payment address, never a customer's own.
    assert.match(String(sent.email), /^payment-1@/);
    assert.equal(sent.identifier, undefined);
    assert.equal(created.gatewayId, 'sub-payment-1');
    assert.equal(created.checkoutUrl, 'https://pay.aurapay.tech/inv-1');
    assert.equal((created.gatewayData as Record<string, unknown>).providerSubscriptionId, 'sub-payment-1');
  });

  it('signs nobody up once the operator has switched approval off', async () => {
    const { calls, result } = checkout({ ...SETTINGS, savePaymentMethod: false });
    await assert.rejects(result, (error: { getResponse?: () => unknown }) => {
      assert.equal((error.getResponse?.() as { code?: string }).code, AUTOPAY_NOT_AVAILABLE_CODE);
      return true;
    });
    assert.equal(calls.length, 0);
  });

  it("turns AuraPay's refusal into the ordinary payment for the buyer and one card for the operator", async () => {
    const refused = { status: 422, data: { error: 'Subscriptions are disabled for this shop', data: [] } };
    const first = checkout(SETTINGS, refused);
    await assert.rejects(first.result, (error: { getResponse?: () => unknown }) => {
      const response = error.getResponse?.() as { code?: string; reason?: string };
      assert.equal(response.code, AUTOPAY_NOT_AVAILABLE_CODE);
      assert.equal(response.reason, 'NOT_APPROVED');
      return true;
    });
    assert.equal(first.cards.length, 1);
  });

  it('keeps an ordinary AuraPay payment an invoice', async () => {
    const { calls, result } = checkout(SETTINGS, {
      status: 200,
      data: { id: 'inv-7', status: 'PENDING', payment_data: { url: 'https://pay.aurapay.tech/inv-7' } },
    }, { id: 'plan-1' });
    const created = await result;
    assert.equal(calls[0]?.url, 'https://app.aurapay.tech/invoice/create');
    assert.equal(created.gatewayId, 'inv-7');
  });
});

interface Harness {
  readonly service: ProviderSubscriptionService;
  readonly row: () => ProviderSubscription;
  readonly transactions: Array<Record<string, unknown>>;
  readonly items: Array<Record<string, unknown>>;
  readonly events: Array<{ providerEventId: string; paymentId: string }>;
  readonly jobs: Array<{ name: string; data: Record<string, unknown>; options: Record<string, unknown> }>;
  readonly cards: unknown[];
  readonly posts: Array<{ url: string; body: unknown }>;
  status(value: Record<string, unknown> | null): void;
  invoice(id: string, value: Record<string, unknown> | null): void;
  deliverFirst(subscriptionId: string): void;
  expiresAt(value: Date | null): void;
}

function harness(initial: Partial<ProviderSubscription> = {}): Harness {
  let row: ProviderSubscription = {
    id: 'ps-1',
    userId: 'user-1',
    gatewayType: PaymentGatewayType.AURAPAY,
    providerSubscriptionId: 'sub-payment-first',
    status: ProviderSubscriptionStatus.PENDING,
    providerStatus: null,
    subscriptionId: null,
    planId: 'plan-1',
    durationDays: 30,
    amount: new Prisma.Decimal('299'),
    listAmount: new Prisma.Decimal('299'),
    currency: Currency.RUB,
    intervalUnit: 'month',
    intervalCount: 1,
    firstTransactionId: 'tx-first',
    appliedChargeCount: 0,
    nextChargeAt: null,
    lastChargeAt: null,
    lastSyncedAt: null,
    cancelledAt: null,
    cancelledBy: null,
    providerRecurrentId: null,
    endsAt: null,
    plannedChargeCount: null,
    method: null,
    delayDays: null,
    delayGrantedAt: null,
    consentVersion: 'provider-subscription-v1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...initial,
  };
  let status: Record<string, unknown> | null = {};
  const invoices = new Map<string, Record<string, unknown> | null>();
  let subscriptionExpiresAt: Date | null = new Date(Date.now() + 2 * 60 * 1000);
  const transactions: Array<Record<string, unknown>> = [
    {
      id: 'tx-first',
      paymentId: 'payment-first',
      userId: 'user-1',
      status: TransactionStatus.PENDING,
      subscriptionId: null,
      fulfilledAt: null,
      idempotencyKey: null,
      gatewayData: null,
    },
  ];
  const items: Array<Record<string, unknown>> = [];
  const events: Array<{ providerEventId: string; paymentId: string; payloadHash: string }> = [];
  const jobs: Array<{ name: string; data: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const cards: unknown[] = [];
  const posts: Array<{ url: string; body: unknown }> = [];

  const findTransaction = (where: Record<string, unknown>) => {
    if (typeof where.id === 'string') return transactions.find((t) => t.id === where.id) ?? null;
    const key = where.userId_idempotencyKey as { userId: string; idempotencyKey: string } | undefined;
    return key === undefined
      ? null
      : (transactions.find((t) => t.userId === key.userId && t.idempotencyKey === key.idempotencyKey) ?? null);
  };
  const prisma = {
    paymentGateway: { findUnique: async () => ({ type: PaymentGatewayType.AURAPAY, settings: SETTINGS }) },
    transaction: { findUnique: async ({ where }: { where: Record<string, unknown> }) => findTransaction(where) },
    subscription: { findUnique: async () => ({ expiresAt: subscriptionExpiresAt }) },
    providerSubscription: {
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (where.id !== row.id) return { count: 0 };
        const applied = where.appliedChargeCount as { lt?: number } | number | undefined;
        if (typeof applied === 'object' && applied.lt !== undefined && !(row.appliedChargeCount < applied.lt)) {
          return { count: 0 };
        }
        row = { ...row, ...data } as ProviderSubscription;
        return { count: 1 };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        row = { ...row, ...data } as ProviderSubscription;
        return row;
      },
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        transaction: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            const created = { id: `tx-${transactions.length + 1}`, paymentId: `payment-${transactions.length + 1}`, ...data };
            transactions.push(created);
            return created;
          },
        },
        transactionItem: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            items.push(data);
            return data;
          },
        },
      }),
  };
  const inbox = {
    recordReceived: async ({ envelope }: { envelope: { providerEventId: string; paymentId: string; payloadHash: string } }) => {
      const existing = events.find((event) => event.providerEventId === envelope.providerEventId);
      if (existing !== undefined) {
        assert.equal(existing.payloadHash, envelope.payloadHash, 'the same charge is queued under the same body');
        return { event: { id: existing.providerEventId, paymentId: existing.paymentId }, duplicate: true };
      }
      events.push({ providerEventId: envelope.providerEventId, paymentId: envelope.paymentId, payloadHash: envelope.payloadHash });
      return {
        event: { id: envelope.providerEventId, paymentId: envelope.paymentId, gatewayType: PaymentGatewayType.AURAPAY },
        duplicate: false,
      };
    },
    markEnqueued: async () => undefined,
    markFailed: async () => undefined,
  };
  const queue = {
    add: async (name: string, data: Record<string, unknown>, options: Record<string, unknown>) => {
      jobs.push({ name, data, options });
    },
  };
  const http = {
    get: (url: string) => {
      assert.equal(url, 'https://app.aurapay.tech/subscription/status');
      return of(status === null ? { status: 404, data: { error: 'not found' } } : { status: 200, data: status });
    },
    post: (url: string, body: { id?: string }) => {
      posts.push({ url, body });
      if (url.endsWith('/invoice/status')) {
        const found = invoices.get(String(body.id));
        return of(found === undefined || found === null ? { status: 404, data: {} } : { status: 200, data: found });
      }
      return of({ status: 200, data: {} });
    },
  };
  const service = new ProviderSubscriptionService(
    prisma as never,
    http as never,
    inbox as never,
    queue as never,
    { warn: (...args: unknown[]) => cards.push(args) } as never,
  );
  return {
    service,
    row: () => row,
    transactions,
    items,
    events,
    jobs,
    cards,
    posts,
    status: (value) => {
      status = value;
    },
    invoice: (id, value) => {
      invoices.set(id, value);
    },
    deliverFirst: (subscriptionId) => {
      const first = transactions[0] as Record<string, unknown>;
      first.status = TransactionStatus.COMPLETED;
      first.fulfilledAt = new Date();
      first.subscriptionId = subscriptionId;
    },
    expiresAt: (value) => {
      subscriptionExpiresAt = value;
    },
  };
}

describe('ProviderSubscriptionService and AuraPay', () => {
  const nextPay = '2099-11-11 12:00:00';

  it('settles the first payment on the checkout once AuraPay says the subscription is active, once', async () => {
    const h = harness();
    h.status({ status: 'new', next_pay_at: null, activated_at: null });
    await h.service.syncRow(h.row());
    assert.equal(h.events.length, 0, 'nothing is paid while the first invoice is not');
    assert.equal(h.row().status, ProviderSubscriptionStatus.PENDING);

    h.status({ status: 'active', next_pay_at: nextPay, activated_at: '2026-10-15 12:00:00' });
    await h.service.syncRow(h.row());
    await h.service.syncRow(h.row());

    assert.deepEqual(
      h.events.map((event) => [event.providerEventId, event.paymentId]),
      [['subscription:sub-payment-first:charge:1', 'payment-first']],
    );
    assert.deepEqual(h.jobs.map((job) => job.name), [PAYMENT_RECONCILIATION_JOB]);
    assert.equal(h.row().appliedChargeCount, 1);
    assert.equal(h.row().status, ProviderSubscriptionStatus.ACTIVE);
    assert.equal(h.row().nextChargeAt?.toISOString(), '2099-11-11T09:00:00.000Z');
    assert.equal(h.transactions.length, 1);
  });

  it('turns a paid charge a callback names into one RENEW payment keyed by its invoice', async () => {
    const h = harness({ status: ProviderSubscriptionStatus.ACTIVE, appliedChargeCount: 1, subscriptionId: 'vpn-1' });
    h.status({ status: 'active', next_pay_at: nextPay, activated_at: '2026-09-15 12:00:00' });
    h.invoice('inv-2', { id: 'inv-2', order_id: 'aura-made-up-2', amount: 299, status: 'PAID' });

    await h.service.syncRow(h.row(), 'inv-2');
    // The event and the invoice callback of one charge, or a repeated one.
    await h.service.syncRow(h.row(), 'inv-2');

    assert.equal(h.transactions.length, 2);
    const renewal = h.transactions[1] as Record<string, unknown>;
    assert.equal(renewal.purchaseType, PurchaseType.RENEW);
    assert.equal(renewal.idempotencyKey, 'provider-subscription:ps-1:payment:inv-2');
    assert.equal(String(renewal.amount), '299');
    assert.equal(h.items.length, 1);
    assert.equal(h.items[0]?.subscriptionId, 'vpn-1');
    assert.deepEqual(
      h.events.map((event) => [event.providerEventId, event.paymentId]),
      [['subscription:sub-payment-first:payment:inv-2', 'payment-2']],
    );
    assert.equal(h.row().appliedChargeCount, 2);
    assert.ok(h.row().lastChargeAt !== null);
  });

  it("settles the first payment when the callback names the first invoice before the status says so", async () => {
    const h = harness();
    h.status({ status: 'waiting_payment', next_pay_at: null, activated_at: null });
    h.invoice('inv-1', { id: 'inv-1', order_id: 'payment-first', amount: 299, status: 'PAID' });

    await h.service.syncRow(h.row(), 'inv-1');

    assert.deepEqual(
      h.events.map((event) => event.providerEventId),
      ['subscription:sub-payment-first:charge:1'],
    );
    assert.equal(h.transactions.length, 1, 'the first payment is the checkout, not a renewal');
    assert.equal(h.row().appliedChargeCount, 1);
  });

  it('delivers nothing for an invoice that is not PAID, nor for one AuraPay does not know', async () => {
    const h = harness({ status: ProviderSubscriptionStatus.ACTIVE, appliedChargeCount: 1, subscriptionId: 'vpn-1' });
    h.status({ status: 'active', next_pay_at: nextPay, activated_at: '2026-09-15 12:00:00' });
    h.invoice('inv-r', { id: 'inv-r', order_id: 'aura-r', amount: 299, status: 'REFUNDED' });

    await h.service.syncRow(h.row(), 'inv-r');
    await h.service.syncRow(h.row(), 'inv-missing');

    assert.equal(h.transactions.length, 1);
    assert.equal(h.events.length, 0);
    assert.equal(h.row().appliedChargeCount, 1);
  });

  it('waits for the first delivery before renewing, and books its own look with the same invoice', async () => {
    const h = harness({ status: ProviderSubscriptionStatus.ACTIVE, appliedChargeCount: 1 });
    h.status({ status: 'active', next_pay_at: nextPay, activated_at: '2026-09-15 12:00:00' });
    h.invoice('inv-2', { id: 'inv-2', order_id: 'aura-made-up-2', amount: 299, status: 'PAID' });

    await h.service.syncRow(h.row(), 'inv-2');

    assert.equal(h.transactions.length, 1);
    const retry = h.jobs.find((job) => job.name === PROVIDER_SUBSCRIPTION_SYNC_JOB);
    assert.equal(retry?.options.delay, 60_000);
    assert.equal(retry?.data.providerChargeId, 'inv-2');
    assert.equal(retry?.data.providerSubscriptionId, 'sub-payment-first');

    h.deliverFirst('vpn-1');
    await h.service.syncRow(h.row(), 'inv-2');
    assert.equal(h.transactions.length, 2);
    assert.equal(h.items[0]?.subscriptionId, 'vpn-1');
    assert.equal(h.row().appliedChargeCount, 2);
  });

  it('reads a deactivation as a cancel by the provider, and a sign-up AuraPay does not know as nothing', async () => {
    const h = harness({ status: ProviderSubscriptionStatus.ACTIVE, appliedChargeCount: 1, subscriptionId: 'vpn-1' });
    h.status(null);
    await h.service.syncRow(h.row());
    assert.equal(h.row().status, ProviderSubscriptionStatus.ACTIVE);

    h.status({ status: 'deactivated', next_pay_at: null, activated_at: '2026-09-15 12:00:00' });
    await h.service.syncRow(h.row());
    assert.equal(h.row().status, ProviderSubscriptionStatus.CANCELLED);
    assert.ok(h.row().cancelledAt !== null);
    assert.equal(h.row().cancelledBy, 'PROVIDER');
  });

  it("tells the operator once when access ends long before AuraPay's next charge — a charge whose callback never came", async () => {
    const h = harness({
      status: ProviderSubscriptionStatus.ACTIVE,
      appliedChargeCount: 1,
      subscriptionId: 'vpn-1',
      lastChargeAt: new Date(Date.now() - 31 * DAY),
    });
    h.expiresAt(new Date(Date.now() + 2 * 60 * 60 * 1000));
    const far = new Date(Date.now() + 29 * DAY);
    const nextPayFar = `${far.toISOString().slice(0, 10)} ${far.toISOString().slice(11, 19)}`;
    h.status({ status: 'active', next_pay_at: nextPayFar, activated_at: '2026-09-15 12:00:00' });

    await h.service.syncRow(h.row());
    await h.service.syncRow(h.row());

    assert.equal(h.cards.length, 1);
    const [, , title, metadata] = h.cards[0] as [string, string, string, Record<string, unknown>];
    assert.match(title, /AuraPay/);
    assert.equal(metadata.reason, 'AURAPAY_CHARGE_NOT_DELIVERED');
    assert.equal(h.events.length, 0, 'nothing is delivered on a guess');
  });

  it('says nothing before the charge is due, nor right after one it delivered', async () => {
    // Before the charge: access reaches it.
    const before = harness({
      status: ProviderSubscriptionStatus.ACTIVE,
      appliedChargeCount: 1,
      subscriptionId: 'vpn-1',
      lastChargeAt: new Date(Date.now() - 29 * DAY),
    });
    before.expiresAt(new Date(Date.now() + 2 * 60 * 60 * 1000));
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    before.status({
      status: 'active',
      next_pay_at: `${soon.toISOString().slice(0, 10)} ${soon.toISOString().slice(11, 19)}`,
      activated_at: '2026-09-15 12:00:00',
    });
    await before.service.syncRow(before.row());
    assert.equal(before.cards.length, 0);

    // A charge just delivered: its renewal has not moved the access yet.
    const after = harness({ status: ProviderSubscriptionStatus.ACTIVE, appliedChargeCount: 1, subscriptionId: 'vpn-1' });
    after.expiresAt(new Date(Date.now() + 2 * 60 * 60 * 1000));
    const far = new Date(Date.now() + 29 * DAY);
    after.status({
      status: 'active',
      next_pay_at: `${far.toISOString().slice(0, 10)} ${far.toISOString().slice(11, 19)}`,
      activated_at: '2026-09-15 12:00:00',
    });
    after.invoice('inv-2', { id: 'inv-2', order_id: 'aura-2', amount: 299, status: 'PAID' });
    await after.service.syncRow(after.row(), 'inv-2');
    assert.equal(after.cards.length, 0);
  });
});

describe('AuraPay cancel', () => {
  function cancelWith(input: {
    readonly cancelStatus: number;
    readonly after: Record<string, unknown> | null;
    readonly createdAt?: Date;
  }) {
    const calls: string[] = [];
    const http = {
      post: (url: string, body: unknown) => {
        calls.push(`POST ${url} ${JSON.stringify(body)}`);
        return of({ status: input.cancelStatus, data: {} });
      },
      get: (url: string, options: { params: Record<string, unknown> }) => {
        calls.push(`GET ${url} ${JSON.stringify(options.params)}`);
        return of(input.after === null ? { status: 404, data: {} } : { status: 200, data: input.after });
      },
    };
    const service = new ProviderSubscriptionService({} as never, http as never, {} as never, {} as never);
    const run = (
      service as unknown as {
        cancelAtProvider(row: Record<string, unknown>, settings: unknown): Promise<void>;
      }
    ).cancelAtProvider(
      {
        gatewayType: PaymentGatewayType.AURAPAY,
        providerSubscriptionId: 'sub-payment-1',
        providerRecurrentId: null,
        firstTransactionId: 'tx-1',
        createdAt: input.createdAt ?? new Date(Date.now() - 2 * DAY),
      },
      SETTINGS,
    );
    return { calls, run };
  }

  it('counts a cancel only once the status read after it says deactivated', async () => {
    const done = cancelWith({ cancelStatus: 200, after: { status: 'deactivated', activated_at: '2026-09-15 12:00:00' } });
    await done.run;
    assert.deepEqual(done.calls, [
      'POST https://app.aurapay.tech/subscription/cancel {"subscription_id":"sub-payment-1"}',
      'GET https://app.aurapay.tech/subscription/status {"subscription_id":"sub-payment-1"}',
    ]);

    const stillOn = cancelWith({ cancelStatus: 200, after: { status: 'active', activated_at: '2026-09-15 12:00:00' } });
    await assert.rejects(stillOn.run, /did not stop/);
  });

  it('takes a sign-up whose first invoice can no longer be paid as cancelled, and one still payable as not', async () => {
    const lapsed = cancelWith({ cancelStatus: 409, after: { status: 'new', activated_at: null } });
    await lapsed.run;

    const payable = cancelWith({ cancelStatus: 409, after: { status: 'new', activated_at: null }, createdAt: new Date() });
    await assert.rejects(payable.run, /did not stop/);

    const gone = cancelWith({ cancelStatus: 404, after: null });
    await gone.run;

    const broken = cancelWith({ cancelStatus: 500, after: { status: 'active' } });
    await assert.rejects(broken.run, /HTTP 500/);
  });
});

describe('AuraPay callbacks at the webhook ingress', () => {
  function ingress(orderIsOurs: boolean) {
    const calls: unknown[] = [];
    const service = new PaymentWebhookIngressService(
      {
        paymentGateway: { findUnique: async () => ({ type: PaymentGatewayType.AURAPAY, settings: SETTINGS }) },
        transaction: {
          findUnique: async () => (orderIsOurs ? { id: 'tx-1' } : null),
        },
      } as never,
      {
        verifyWebhookSignature: () => {
          calls.push(['verify']);
        },
        normalizeWebhook: () => {
          calls.push(['normalize']);
          return {
            gatewayType: PaymentGatewayType.AURAPAY,
            paymentId: 'payment-1',
            providerEventId: 'inv-1',
            eventStatus: 'PAID',
            receivedAt: '2026-10-15T12:00:00.000Z',
            payloadHash: 'hash-1',
            rawPayload: {},
          };
        },
      } as never,
      {
        recordReceived: async () => ({
          duplicate: false,
          event: { id: 'event-row-1', paymentId: 'payment-1', gatewayType: PaymentGatewayType.AURAPAY },
        }),
        markEnqueued: async () => undefined,
      } as never,
      {} as never,
      {
        add: async (name: string) => {
          calls.push(['queue.add', name]);
          return { id: 'job-1' };
        },
      } as never,
      {
        enqueueSync: async (...args: unknown[]) => {
          calls.push(['enqueueSync', ...args]);
        },
      } as never,
      { info: () => undefined } as never,
    );
    return { calls, service };
  }
  const ingest = (service: PaymentWebhookIngressService, payload: unknown) =>
    service.ingestWebhook({
      gatewayType: PaymentGatewayType.AURAPAY,
      rawBody: Buffer.from(JSON.stringify(payload)),
      headers: {},
      clientIp: null,
      verifySignature: true,
    });

  it("routes a subscription's event to a look at it, with the invoice it says was paid", async () => {
    const { calls, service } = ingress(false);
    await ingest(service, { event: 'PAID', subscription_id: 'sub-payment-1', invoice_id: 'inv-2', status: 'ACTIVE' });
    assert.deepEqual(calls, [['verify'], ['enqueueSync', PaymentGatewayType.AURAPAY, 'sub-payment-1', 0, 'inv-2']]);
  });

  it("routes a later charge's invoice callback — an order AuraPay made up — the same way, and a failure with no invoice", async () => {
    const charge = ingress(false);
    await ingest(charge.service, { id: 'inv-3', order_id: 'aura-made-up', status: 'PAID', subscription_id: 'sub-payment-1' });
    assert.deepEqual(charge.calls, [['verify'], ['enqueueSync', PaymentGatewayType.AURAPAY, 'sub-payment-1', 0, 'inv-3']]);

    const failed = ingress(false);
    await ingest(failed.service, { event: 'PAYMENT_ERROR', subscription_id: 'sub-payment-1', invoice_id: null });
    assert.deepEqual(failed.calls, [['verify'], ['enqueueSync', PaymentGatewayType.AURAPAY, 'sub-payment-1', 0, null]]);
  });

  it("sends the first invoice — OUR order — down the payment pipeline, with the look queued after it", async () => {
    const { calls, service } = ingress(true);
    await ingest(service, { id: 'inv-1', order_id: 'payment-1', status: 'PAID', subscription_id: 'sub-payment-1' });
    assert.deepEqual(calls, [
      ['normalize'],
      ['queue.add', 'reconcile-payment'],
      ['enqueueSync', PaymentGatewayType.AURAPAY, 'sub-payment-1', 0, 'inv-1'],
    ]);
  });
});
