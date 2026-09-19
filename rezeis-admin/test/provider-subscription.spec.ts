import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Currency,
  PaymentGatewayType,
  Prisma,
  ProviderSubscription,
  ProviderSubscriptionStatus,
  PurchaseChannel,
  PurchaseType,
  SubscriptionStatus,
  TransactionStatus,
} from '@prisma/client';
import { of } from 'rxjs';

import { PAYMENT_RECONCILIATION_JOB, PROVIDER_SUBSCRIPTION_SYNC_JOB } from '../src/modules/payments/constants/payment-reconciliation.constant';
import { PaymentProviderExecutionService } from '../src/modules/payments/services/payment-provider-execution.service';
import { extractPlategaSubscriptionId } from '../src/modules/payments/services/payment-webhook-ingress.service';
import { PaymentWebhookPayloadRedactionService } from '../src/modules/payments/services/payment-webhook-payload-redaction.service';
import {
  chargeCoverDays,
  mapPlategaSubscriptionStatus,
  parsePlategaSubscription,
  ProviderSubscriptionService,
  strandedReason,
} from '../src/modules/payments/services/provider-subscription.service';
import { PLATEGA_PROVIDER_CHOICE } from '../src/modules/payments/utils/payment-gateway-settings.util';
import {
  AUTOPAY_NOT_AVAILABLE_CODE,
  PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY,
  readProviderSubscriptionTerms,
  resolveProviderSubscriptionTerms,
} from '../src/modules/payments/utils/provider-subscription-terms.util';

const DAY = 24 * 60 * 60 * 1000;

describe('resolveProviderSubscriptionTerms', () => {
  const base = {
    gatewayType: PaymentGatewayType.PLATEGA as PaymentGatewayType,
    currency: 'RUB',
    amount: new Prisma.Decimal('299.00000000'),
    durationDays: 30,
    discountSource: 'NONE' as const,
    planId: 'plan-1',
    subscriptionId: null,
  };

  it('turns a whole-rouble monthly price into the period and sum the provider repeats', () => {
    assert.deepEqual(resolveProviderSubscriptionTerms(base), {
      terms: { unit: 'month', count: 1, amount: 299, durationDays: 30, planId: 'plan-1', subscriptionId: null },
    });
    // A personal discount is permanent, so repeating it is what the payer was shown.
    assert.ok('terms' in resolveProviderSubscriptionTerms({ ...base, discountSource: 'PERSONAL' }));
  });

  it('refuses whatever the provider would charge wrongly on the next period', () => {
    const refusal = (overrides: Partial<typeof base>) => {
      const result = resolveProviderSubscriptionTerms({ ...base, ...overrides });
      return 'refusal' in result ? result.refusal : null;
    };
    assert.equal(refusal({ discountSource: 'PURCHASE' as never }), 'DISCOUNT');
    assert.equal(refusal({ amount: new Prisma.Decimal('299.90') }), 'AMOUNT');
    assert.equal(refusal({ durationDays: 45 }), 'DURATION');
    assert.equal(refusal({ currency: 'USD' }), 'CURRENCY');
    assert.equal(refusal({ gatewayType: PaymentGatewayType.YOOKASSA }), 'GATEWAY');
  });

  it('reads back only a complete set of terms from a snapshot', () => {
    const resolved = resolveProviderSubscriptionTerms(base);
    assert.ok('terms' in resolved);
    const snapshot = JSON.parse(JSON.stringify({ id: 'plan-1', [PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY]: resolved.terms }));
    assert.deepEqual(readProviderSubscriptionTerms(snapshot), resolved.terms);
    assert.equal(readProviderSubscriptionTerms({ id: 'plan-1' }), null);
    assert.equal(
      readProviderSubscriptionTerms({ [PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY]: { ...resolved.terms, amount: 299.5 } }),
      null,
    );
  });
});

describe('extractPlategaSubscriptionId', () => {
  const body = (value: unknown) => Buffer.from(JSON.stringify(value));

  it('finds the subscription in a charge callback and in a status callback', () => {
    assert.equal(
      extractPlategaSubscriptionId(
        PaymentGatewayType.PLATEGA,
        body({ Id: 'tx-9', SubscriptionId: 'sub-1', Amount: 299, Status: 'CONFIRMED', NextChargeAt: '2026-10-19T10:00:00Z' }),
      ),
      'sub-1',
    );
    assert.equal(
      extractPlategaSubscriptionId(PaymentGatewayType.PLATEGA, body({ Id: 'sub-2', Status: 'SUBSCRIPTION_CANCELLED' })),
      'sub-2',
    );
  });

  it('leaves a payment callback, and every other gateway, to the payment pipeline', () => {
    assert.equal(
      extractPlategaSubscriptionId(PaymentGatewayType.PLATEGA, body({ id: 'tx-1', status: 'CONFIRMED', payload: 'p-1' })),
      null,
    );
    assert.equal(
      extractPlategaSubscriptionId(PaymentGatewayType.PLATEGA, body({ id: 'tx-1', status: 'CONFIRMED', subscriptionId: null })),
      null,
    );
    assert.equal(extractPlategaSubscriptionId(PaymentGatewayType.PLATEGA, Buffer.from('not json')), null);
    assert.equal(
      extractPlategaSubscriptionId(PaymentGatewayType.YOOKASSA, body({ SubscriptionId: 'sub-1' })),
      null,
    );
  });
});

describe('parsePlategaSubscription', () => {
  it('reads the documented GET body with its own keys', () => {
    const state = parsePlategaSubscription({
      id: 'sub-1',
      status: 'Active',
      intervalUnit: 'Month',
      nextChargeAt: '2026-10-19T10:00:00Z',
      lastChargeAt: '2026-09-19T10:00:00Z',
      chargeMetrics: { chargesTotal: 2, chargesSuccess: 1, chargesFailed: 1, totalAmount: 299 },
    });
    assert.equal(state.status, ProviderSubscriptionStatus.ACTIVE);
    assert.equal(state.providerStatus, 'Active');
    assert.equal(state.chargesSuccess, 1);
    assert.equal(state.nextChargeAt?.toISOString(), '2026-10-19T10:00:00.000Z');
  });

  it('never reads an unknown status word as a cancellation', () => {
    assert.equal(mapPlategaSubscriptionStatus('SUBSCRIPTION_PAST_DUE'), ProviderSubscriptionStatus.PAST_DUE);
    assert.equal(mapPlategaSubscriptionStatus('Cancelled'), ProviderSubscriptionStatus.CANCELLED);
    assert.equal(mapPlategaSubscriptionStatus('Suspended'), null);
    assert.equal(mapPlategaSubscriptionStatus('4'), null);
    assert.equal(parsePlategaSubscription({ status: 'Active', chargeMetrics: { chargesSuccess: -1 } }).chargesSuccess, null);
  });
});

describe('chargeCoverDays', () => {
  const now = new Date('2026-10-19T10:00:00Z');

  it('buys the plan term when it already reaches past the next charge', () => {
    assert.equal(
      chargeCoverDays({
        durationDays: 30,
        expiresAt: new Date(now.getTime() + DAY),
        nextChargeAt: new Date(now.getTime() + 30 * DAY),
        now,
      }),
      30,
    );
  });

  it('stretches the term so access never lapses before the next charge lands', () => {
    // Expired a day ago, the provider charges again in 31 days.
    assert.equal(
      chargeCoverDays({
        durationDays: 30,
        expiresAt: new Date(now.getTime() - DAY),
        nextChargeAt: new Date(now.getTime() + 31 * DAY),
        now,
      }),
      32,
    );
    // Capped: a far-off provider date is not a reason to give a month away.
    assert.equal(
      chargeCoverDays({ durationDays: 30, expiresAt: null, nextChargeAt: new Date(now.getTime() + 60 * DAY), now }),
      33,
    );
  });
});

describe('Platega subscription checkout', () => {
  function checkout(settings: Record<string, unknown>) {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const service = new PaymentProviderExecutionService(
      {
        post: (url: string, body: unknown) => {
          calls.push({ url, body: body as Record<string, unknown> });
          return of({ data: { transactionId: 'sub-1', redirect: 'https://pay.platega.example/sub-1', status: 'PENDING' } });
        },
      } as never,
      { domain: 'https://user.example', botToken: 'bot' } as never,
      new PaymentWebhookPayloadRedactionService(),
    );
    const result = service.createCheckout({
      gateway: {
        id: 'gateway-1',
        type: PaymentGatewayType.PLATEGA,
        orderIndex: 1,
        currency: Currency.RUB,
        isActive: true,
        settings,
      } as never,
      transaction: {
        id: 'tx-1',
        paymentId: 'payment-1',
        userId: 'user-1',
        gatewayType: PaymentGatewayType.PLATEGA,
        currency: Currency.RUB,
        amount: new Prisma.Decimal('299'),
        purchaseType: PurchaseType.NEW,
        planSnapshot: {
          id: 'plan-1',
          [PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY]: {
            unit: 'month',
            count: 3,
            amount: 299,
            durationDays: 90,
            planId: 'plan-1',
            subscriptionId: null,
          },
        },
      } as never,
      description: 'VPN 90 days',
      successUrl: 'https://reiwa.example/success',
      failUrl: 'https://reiwa.example/fail',
    });
    return { calls, result };
  }

  it('creates the subscription as its own method and keeps its id as the checkout id', async () => {
    // Whatever rail one-off payments use (here the payer's choice on v2), a
    // subscription is `paymentMethod: 6` on v1.
    const { calls, result } = checkout({
      merchantId: 'm-1',
      secret: 's-1',
      paymentMethod: PLATEGA_PROVIDER_CHOICE,
      savePaymentMethod: true,
    });
    const created = await result;
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://app.platega.io/transaction/process');
    assert.deepEqual(calls[0]?.body, {
      paymentMethod: 6,
      paymentDetails: { amount: 299, currency: Currency.RUB, interval: 3, intervalCount: 3 },
      description: 'VPN 90 days',
      payload: 'payment-1',
      return: 'https://reiwa.example/success',
      failedUrl: 'https://reiwa.example/fail',
    });
    assert.equal(created.gatewayId, 'sub-1');
    assert.equal(created.checkoutUrl, 'https://pay.platega.example/sub-1');
  });

  it('signs nobody up once the operator has switched approval off', async () => {
    const { calls, result } = checkout({ merchantId: 'm-1', secret: 's-1', savePaymentMethod: false });
    await assert.rejects(result, (error: { getResponse?: () => unknown }) => {
      assert.equal((error.getResponse?.() as { code?: string }).code, AUTOPAY_NOT_AVAILABLE_CODE);
      return true;
    });
    assert.equal(calls.length, 0);
  });
});

interface Harness {
  readonly service: ProviderSubscriptionService;
  readonly row: () => ProviderSubscription;
  readonly transactions: Array<Record<string, unknown>>;
  readonly items: Array<Record<string, unknown>>;
  readonly events: Array<{ providerEventId: string; paymentId: string }>;
  readonly jobs: Array<{ name: string; data: Record<string, unknown>; options: Record<string, unknown> }>;
  setProvider(state: Record<string, unknown>): void;
  deliverFirst(subscriptionId: string): void;
}

function harness(initial: Partial<ProviderSubscription> = {}): Harness {
  let row: ProviderSubscription = {
    id: 'ps-1',
    userId: 'user-1',
    gatewayType: PaymentGatewayType.PLATEGA,
    providerSubscriptionId: 'sub-1',
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
    consentVersion: 'provider-subscription-v1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...initial,
  };
  let provider: Record<string, unknown> = {};
  const transactions: Array<Record<string, unknown>> = [
    {
      id: 'tx-first',
      paymentId: 'payment-first',
      userId: 'user-1',
      status: TransactionStatus.PENDING,
      subscriptionId: null,
      fulfilledAt: null,
      idempotencyKey: null,
    },
  ];
  const items: Array<Record<string, unknown>> = [];
  const events: Array<{ providerEventId: string; paymentId: string; payloadHash: string }> = [];
  const jobs: Array<{ name: string; data: Record<string, unknown>; options: Record<string, unknown> }> = [];

  const findTransaction = (where: Record<string, unknown>) => {
    if (typeof where.id === 'string') return transactions.find((t) => t.id === where.id) ?? null;
    const key = where.userId_idempotencyKey as { userId: string; idempotencyKey: string } | undefined;
    return key === undefined
      ? null
      : (transactions.find((t) => t.userId === key.userId && t.idempotencyKey === key.idempotencyKey) ?? null);
  };
  const createTransaction = async ({ data }: { data: Record<string, unknown> }) => {
    const created = { id: `tx-${transactions.length + 1}`, paymentId: `payment-${transactions.length + 1}`, ...data };
    transactions.push(created);
    return created;
  };
  const prisma = {
    paymentGateway: {
      findUnique: async () => ({ type: PaymentGatewayType.PLATEGA, settings: { merchantId: 'm-1', secret: 's-1' } }),
    },
    transaction: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) => findTransaction(where),
    },
    subscription: {
      findUnique: async () => ({ expiresAt: new Date(Date.now() + 2 * 60 * 1000) }),
    },
    providerSubscription: {
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (where.id !== row.id || where.appliedChargeCount !== row.appliedChargeCount) return { count: 0 };
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
        transaction: { create: createTransaction },
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
      if (existing !== undefined && existing.payloadHash === envelope.payloadHash) {
        return { event: { id: existing.providerEventId, paymentId: existing.paymentId }, duplicate: true };
      }
      events.push({ providerEventId: envelope.providerEventId, paymentId: envelope.paymentId, payloadHash: envelope.payloadHash });
      return {
        event: { id: envelope.providerEventId, paymentId: envelope.paymentId, gatewayType: PaymentGatewayType.PLATEGA },
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
  const http = { get: () => of({ data: provider }) };
  const service = new ProviderSubscriptionService(prisma as never, http as never, inbox as never, queue as never);
  return {
    service,
    row: () => row,
    transactions,
    items,
    events,
    jobs,
    setProvider: (state) => {
      provider = state;
    },
    deliverFirst: (subscriptionId) => {
      const first = transactions[0] as Record<string, unknown>;
      first.status = TransactionStatus.COMPLETED;
      first.fulfilledAt = new Date();
      first.subscriptionId = subscriptionId;
    },
  };
}

describe('ProviderSubscriptionService.syncRow', () => {
  const nextCharge = new Date(Date.now() + 30 * DAY).toISOString();

  it('settles the first charge on the checkout the payer confirmed, once', async () => {
    const h = harness();
    h.setProvider({ status: 'Active', nextChargeAt: nextCharge, chargeMetrics: { chargesSuccess: 1 } });

    await h.service.syncRow(h.row());
    await h.service.syncRow(h.row());

    assert.deepEqual(
      h.events.map((event) => [event.providerEventId, event.paymentId]),
      [['subscription:sub-1:charge:1', 'payment-first']],
    );
    assert.deepEqual(h.jobs.map((job) => job.name), [PAYMENT_RECONCILIATION_JOB]);
    assert.equal(h.row().appliedChargeCount, 1);
    assert.equal(h.row().status, ProviderSubscriptionStatus.ACTIVE);
    assert.equal(h.transactions.length, 1);
  });

  it('turns a later charge into one RENEW payment at the sum the payer agreed to', async () => {
    const h = harness({ status: ProviderSubscriptionStatus.ACTIVE, appliedChargeCount: 1, subscriptionId: 'vpn-1' });
    h.setProvider({ status: 'Active', nextChargeAt: nextCharge, chargeMetrics: { chargesSuccess: 2 } });

    await h.service.syncRow(h.row());
    await h.service.syncRow(h.row());

    assert.equal(h.transactions.length, 2);
    const renewal = h.transactions[1] as Record<string, unknown>;
    assert.equal(renewal.purchaseType, PurchaseType.RENEW);
    assert.equal(renewal.channel, PurchaseChannel.WEB);
    assert.equal(renewal.idempotencyKey, 'provider-subscription:ps-1:charge:2');
    assert.equal(String(renewal.amount), '299');
    assert.equal(h.items.length, 1);
    assert.equal(h.items[0]?.subscriptionId, 'vpn-1');
    // The access that ends in two minutes is carried past the next charge.
    assert.equal(h.items[0]?.durationDays, 31);
    assert.deepEqual(
      h.events.map((event) => [event.providerEventId, event.paymentId]),
      [['subscription:sub-1:charge:2', 'payment-2']],
    );
    assert.equal(h.row().appliedChargeCount, 2);
  });

  it('waits for the first delivery before renewing, and books its own next look', async () => {
    const h = harness();
    h.setProvider({ status: 'Active', nextChargeAt: nextCharge, chargeMetrics: { chargesSuccess: 2 } });

    await h.service.syncRow(h.row());

    assert.equal(h.row().appliedChargeCount, 1);
    assert.equal(h.transactions.length, 1);
    const retry = h.jobs.find((job) => job.name === PROVIDER_SUBSCRIPTION_SYNC_JOB);
    assert.equal(retry?.options.delay, 60_000);

    h.deliverFirst('vpn-1');
    await h.service.syncRow(h.row());
    assert.equal(h.row().appliedChargeCount, 2);
    assert.equal(h.row().subscriptionId, 'vpn-1');
    assert.equal(h.items[0]?.subscriptionId, 'vpn-1');
  });

  it('keeps a cancellation the panel made even while the provider still says Active', async () => {
    const h = harness({
      status: ProviderSubscriptionStatus.CANCELLED,
      appliedChargeCount: 1,
      subscriptionId: 'vpn-1',
      cancelledAt: new Date(),
      cancelledBy: 'CUSTOMER',
    });
    h.setProvider({ status: 'Active', nextChargeAt: nextCharge, chargeMetrics: { chargesSuccess: 1 } });

    await h.service.syncRow(h.row());

    assert.equal(h.row().status, ProviderSubscriptionStatus.CANCELLED);
    assert.equal(h.row().cancelledBy, 'CUSTOMER');
  });

  it('stops charging for access the panel no longer gives, and only then', () => {
    const live = { status: SubscriptionStatus.ACTIVE, planId: 'plan-1' };
    const reason = (overrides: Partial<Parameters<typeof strandedReason>[0]>) =>
      strandedReason({ userDeleted: false, userBlocked: false, subscription: live, planId: 'plan-1', ...overrides });
    assert.equal(reason({}), null);
    // A new purchase whose first charge has not delivered yet has no subscription to check.
    assert.equal(reason({ subscription: 'NOT_YET' }), null);
    // A lapsed or disabled subscription is renewed by the next charge, not abandoned.
    assert.equal(reason({ subscription: { status: SubscriptionStatus.EXPIRED, planId: 'plan-1' } }), null);
    assert.equal(reason({ userDeleted: true }), 'account deleted');
    assert.equal(reason({ userBlocked: true }), 'account blocked');
    assert.equal(reason({ subscription: 'MISSING' }), 'subscription deleted');
    assert.equal(reason({ subscription: { status: SubscriptionStatus.DELETED, planId: 'plan-1' } }), 'subscription deleted');
    assert.equal(
      reason({ subscription: { status: SubscriptionStatus.ACTIVE, planId: 'plan-2' } }),
      'subscription moved to another plan',
    );
  });

  it('counts who still pays a list price the operator has changed, not a personal discount', async () => {
    const live = (planId: string, amount: string, listAmount: string | null, status: ProviderSubscriptionStatus = ProviderSubscriptionStatus.ACTIVE) => ({
      gatewayType: PaymentGatewayType.PLATEGA,
      status,
      planId,
      durationDays: 30,
      currency: Currency.RUB,
      amount: new Prisma.Decimal(amount),
      listAmount: listAmount === null ? null : new Prisma.Decimal(listAmount),
    });
    const service = new ProviderSubscriptionService(
      {
        providerSubscription: {
          findMany: async () => [
            live('plan-1', '299', '299'),
            // A personal discount lowers the charge, not the list price: current.
            live('plan-1', '249', '299'),
            // Signed up at 249 before the price went to 299.
            live('plan-1', '249', '249'),
            live('plan-1', '249', '249', ProviderSubscriptionStatus.PAST_DUE),
            // The term is no longer sold at all.
            live('plan-gone', '99', '99'),
            // Unknown at sign-up: not counted either way.
            live('plan-1', '199', null),
          ],
        },
        planDuration: {
          findMany: async () => [
            { planId: 'plan-1', days: 30, prices: [{ currency: Currency.RUB, price: new Prisma.Decimal('299.00000000') }] },
          ],
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    assert.deepEqual(await service.summary(), [
      { gatewayType: PaymentGatewayType.PLATEGA, active: 5, pastDue: 1, onOldPrice: 3 },
    ]);
  });

  it('records a cancellation the payer made from the provider email', async () => {
    const h = harness({ status: ProviderSubscriptionStatus.ACTIVE, appliedChargeCount: 1, subscriptionId: 'vpn-1' });
    h.setProvider({ status: 'Cancelled', chargeMetrics: { chargesSuccess: 1 } });

    await h.service.syncRow(h.row());

    assert.equal(h.row().status, ProviderSubscriptionStatus.CANCELLED);
    assert.equal(h.row().cancelledBy, 'PROVIDER');
  });
});
