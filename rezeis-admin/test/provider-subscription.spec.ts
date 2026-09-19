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
import { rollypayPeriodForDays } from '../src/modules/payments/utils/provider-subscription-period.util';
import {
  AUTOPAY_NOT_AVAILABLE_CODE,
  PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY,
  readProviderSubscriptionTerms,
  resolveProviderSubscriptionTerms,
} from '../src/modules/payments/utils/provider-subscription-terms.util';
import {
  isRollypayStopTaken,
  mapRollypaySubscriptionStatus,
  parseRollypayCharges,
  parseRollypayPlans,
  pickRollypayPlan,
  readRollypayPlanIds,
  readRollypayTerminalId,
  rollypayPaidCycles,
  rollypayPayerId,
} from '../src/modules/payments/utils/rollypay-subscription.util';

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
  /** The provider's answer: one body for every GET, or one per URL. */
  setProvider(state: Record<string, unknown> | ((url: string) => unknown)): void;
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
  let provider: Record<string, unknown> | ((url: string) => unknown) = {};
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
      findUnique: async () => ({
        type: row.gatewayType,
        settings:
          row.gatewayType === PaymentGatewayType.ROLLYPAY ? { apiKey: 'k-1' } : { merchantId: 'm-1', secret: 's-1' },
      }),
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
  const http = {
    get: (url: string) => of({ data: typeof provider === 'function' ? provider(url) : provider }),
  };
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

const KASSA = 'd290f1ee-6c54-4b01-90e6-d701748f0851';
const PLAN_MONTH_299 = '8f1c0b6e-2a44-4f0f-9d1b-6d2f9a3c7b10';
const PLAN_MONTH_CAP = '1a2b3c4d-0000-4000-8000-000000000001';
const PLAN_QUARTER_299 = '1a2b3c4d-0000-4000-8000-000000000002';
const PLAN_NOT_NAMED = '1a2b3c4d-0000-4000-8000-000000000003';

describe('RollyPay terms and tariffs', () => {
  it('offers only the periods its fixed tariffs count in days', () => {
    assert.deepEqual(rollypayPeriodForDays(30), { unit: 'month', count: 1 });
    assert.deepEqual(rollypayPeriodForDays(90), { unit: 'month', count: 3 });
    assert.deepEqual(rollypayPeriodForDays(180), { unit: 'month', count: 6 });
    assert.deepEqual(rollypayPeriodForDays(365), { unit: 'year', count: 1 });
    for (const days of [1, 7, 31, 60, 360]) assert.equal(rollypayPeriodForDays(days), null, `${days} days`);
    assert.deepEqual(
      resolveProviderSubscriptionTerms({
        gatewayType: PaymentGatewayType.ROLLYPAY,
        currency: 'RUB',
        amount: '299',
        durationDays: 90,
        discountSource: 'NONE',
        planId: 'plan-1',
        subscriptionId: null,
      }),
      { terms: { unit: 'month', count: 3, amount: 299, durationDays: 90, planId: 'plan-1', subscriptionId: null } },
    );
  });

  it('reads the operator ids leniently and the payer id stably', () => {
    assert.deepEqual(
      readRollypayPlanIds({
        subscriptionPlanIds: `${PLAN_MONTH_299.toUpperCase()}, ${PLAN_MONTH_CAP}\n junk;${PLAN_MONTH_299}`,
      }),
      [PLAN_MONTH_299, PLAN_MONTH_CAP],
    );
    assert.equal(readRollypayTerminalId({ terminalId: ` ${KASSA} ` }), KASSA);
    assert.equal(readRollypayTerminalId({ terminalId: 'kassa-1' }), null);
    const payer = rollypayPayerId('user-1');
    assert.match(payer, /^[a-z0-9]{32}$/);
    assert.equal(rollypayPayerId('user-1'), payer);
    assert.notEqual(rollypayPayerId('user-2'), payer);
  });

  it('picks the tariff that charges what the payer was shown, a fixed one before one with a cap', () => {
    const plans = parseRollypayPlans({
      items: [
        { id: PLAN_MONTH_CAP, interval: 'month', cap_amount_rub: '1000.00' },
        { id: PLAN_MONTH_299, interval: 'month', payer_amount_rub: '299.00', merchant_amount_rub: '290.00' },
        { id: PLAN_QUARTER_299, interval: 'quarter', payer_amount_rub: '299.00' },
        { id: PLAN_NOT_NAMED, interval: 'year', payer_amount_rub: '299.00' },
      ],
    });
    const named = [PLAN_MONTH_CAP, PLAN_MONTH_299, PLAN_QUARTER_299];
    const month = { unit: 'month', count: 1 } as const;
    assert.equal(pickRollypayPlan(plans, named, month, 299)?.id, PLAN_MONTH_299);
    assert.equal(pickRollypayPlan(plans, named, month, 399)?.id, PLAN_MONTH_CAP);
    assert.equal(pickRollypayPlan(plans, named, month, 1001), null);
    assert.equal(pickRollypayPlan(plans, named, { unit: 'month', count: 3 }, 299)?.id, PLAN_QUARTER_299);
    // RollyPay has the year tariff, but the operator did not name it.
    assert.equal(pickRollypayPlan(plans, named, { unit: 'year', count: 1 }, 299), null);
  });

  it('counts a cycle paid once, and never one under review or outside the books', () => {
    const paid = rollypayPaidCycles(
      parseRollypayCharges([
        { cycle_number: 3, status: 'payed', validation_status: 'accepted', payment_id: null },
        { cycle_number: 2, status: 'payed', validation_status: 'review', payment_id: 'pay_2' },
        { cycle_number: 1, status: 'fail', payment_id: null },
        { cycle_number: 1, status: 'payed', validation_status: 'accepted', payment_id: 'pay_1' },
        { cycle_number: 2, status: 'payed', validation_status: 'accepted', payment_id: 'pay_2b' },
      ]),
    );
    assert.deepEqual(
      paid.map((charge) => [charge.cycle, charge.paymentId]),
      [
        [1, 'pay_1'],
        [2, 'pay_2b'],
      ],
    );
  });

  it('reads both of its status fields, and keeps ours while a person or RollyPay still has to decide', () => {
    const map = (state: string | null, billingStatus: string | null, lastAttemptFailed = false) =>
      mapRollypaySubscriptionStatus({ state, billingStatus, lastAttemptFailed });
    assert.equal(map('new', 'consent_pending'), ProviderSubscriptionStatus.PENDING);
    assert.equal(map('active', 'enabled'), ProviderSubscriptionStatus.ACTIVE);
    assert.equal(map('active', 'enabled', true), ProviderSubscriptionStatus.PAST_DUE);
    assert.equal(map('active', 'review'), null);
    assert.equal(map('active', 'stop_pending'), null);
    assert.equal(map('active', 'pending'), null);
    assert.equal(map('stop', 'stopped'), ProviderSubscriptionStatus.CANCELLED);
    assert.equal(isRollypayStopTaken({ state: 'active', billing_status: 'stop_pending' }), true);
    assert.equal(isRollypayStopTaken({ state: 'active', billing_status: 'enabled' }), false);
  });
});

describe('RollyPay subscription checkout', () => {
  function checkout(input: {
    readonly settings?: Record<string, unknown>;
    readonly plans?: readonly Record<string, unknown>[];
    readonly created?: Record<string, unknown>;
  }) {
    const calls: Array<{
      method: string;
      url: string;
      body?: Record<string, unknown>;
      headers: Record<string, string>;
    }> = [];
    const service = new PaymentProviderExecutionService(
      {
        get: (url: string, config: { headers: Record<string, string> }) => {
          calls.push({ method: 'GET', url, headers: config.headers });
          return of({ data: { items: input.plans ?? [] } });
        },
        post: (url: string, body: unknown, config: { headers: Record<string, string> }) => {
          calls.push({ method: 'POST', url, body: body as Record<string, unknown>, headers: config.headers });
          return of({
            data: url.endsWith('/stop')
              ? { ok: true }
              : (input.created ?? {
                  id: 'rp-sub-1',
                  state: 'new',
                  billing_status: 'consent_pending',
                  payer_amount_rub: '299.00',
                  pay_url: 'https://pay.rollypay.io/pay/recurring/TOKEN',
                }),
          });
        },
      } as never,
      { domain: 'https://user.example', botToken: 'bot' } as never,
      new PaymentWebhookPayloadRedactionService(),
    );
    const result = service.createCheckout({
      gateway: {
        id: 'gateway-1',
        type: PaymentGatewayType.ROLLYPAY,
        orderIndex: 1,
        currency: Currency.RUB,
        isActive: true,
        settings: input.settings ?? {
          apiKey: 'k-1',
          signingSecret: 'sig-1',
          savePaymentMethod: 'true',
          terminalId: KASSA,
          subscriptionPlanIds: `${PLAN_MONTH_CAP} ${PLAN_MONTH_299}`,
        },
      } as never,
      transaction: {
        id: 'tx-1',
        paymentId: 'payment-1',
        userId: 'user-1',
        gatewayType: PaymentGatewayType.ROLLYPAY,
        currency: Currency.RUB,
        amount: new Prisma.Decimal('299'),
        purchaseType: PurchaseType.NEW,
        planSnapshot: {
          id: 'plan-1',
          [PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY]: {
            unit: 'month',
            count: 1,
            amount: 299,
            durationDays: 30,
            planId: 'plan-1',
            subscriptionId: null,
          },
        },
      } as never,
      description: 'VPN 30 days',
      successUrl: 'https://reiwa.example/success',
      failUrl: 'https://reiwa.example/fail',
    });
    return { calls, result };
  }

  it('signs the payer up on the named fixed tariff, once per checkout, and keeps the subscription as the checkout id', async () => {
    const { calls, result } = checkout({
      plans: [
        { id: PLAN_MONTH_CAP, interval: 'month', cap_amount_rub: '1000.00' },
        { id: PLAN_MONTH_299, interval: 'month', payer_amount_rub: '299.00' },
      ],
    });
    const created = await result;
    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.url}`),
      ['GET https://rollypay.io/api/v1/subscription-plans', 'POST https://rollypay.io/api/v1/subscriptions'],
    );
    assert.deepEqual(calls[1]?.body, {
      terminal_id: KASSA,
      plan_id: PLAN_MONTH_299,
      payer_id: rollypayPayerId('user-1'),
      merchant_subscription_ref: 'payment-1',
    });
    assert.equal(calls[1]?.headers['Idempotency-Key'], 'rezeis-tx-1');
    assert.equal(calls[1]?.headers['X-API-Key'], 'k-1');
    assert.notEqual(calls[0]?.headers['X-Nonce'], calls[1]?.headers['X-Nonce']);
    assert.equal(created.gatewayId, 'rp-sub-1');
    assert.equal(created.checkoutUrl, 'https://pay.rollypay.io/pay/recurring/TOKEN');
  });

  it('fixes the price on a tariff with a cap, and sends no payer id there', async () => {
    const { calls, result } = checkout({
      plans: [{ id: PLAN_MONTH_CAP, interval: 'month', cap_amount_rub: '1000.00' }],
    });
    await result;
    assert.deepEqual(calls[1]?.body, {
      terminal_id: KASSA,
      plan_id: PLAN_MONTH_CAP,
      amount: '299.00',
      merchant_subscription_ref: 'payment-1',
    });
  });

  it('refuses when no named tariff charges this sum every this period', async () => {
    const { calls, result } = checkout({
      plans: [{ id: PLAN_MONTH_299, interval: 'month', payer_amount_rub: '349.00' }],
    });
    await assert.rejects(result, (error: { getResponse?: () => unknown }) => {
      const response = error.getResponse?.() as { code?: string; reason?: string };
      assert.equal(response.code, AUTOPAY_NOT_AVAILABLE_CODE);
      assert.equal(response.reason, 'PLAN');
      return true;
    });
    assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
  });

  it('stops a sign-up whose charge would not be the price the payer was shown', async () => {
    const { calls, result } = checkout({
      plans: [{ id: PLAN_MONTH_CAP, interval: 'month', cap_amount_rub: '1000.00' }],
      created: { id: 'rp-sub-2', payer_amount_rub: '309.00', pay_url: 'https://pay.rollypay.io/pay/recurring/T2' },
    });
    await assert.rejects(result, (error: { getResponse?: () => unknown }) => {
      assert.equal((error.getResponse?.() as { reason?: string }).reason, 'PLAN');
      return true;
    });
    assert.equal(calls[calls.length - 1]?.url, 'https://rollypay.io/api/v1/subscriptions/rp-sub-2/stop');
  });

  it('signs nobody up without the kassa and a tariff named, however the switch is set', async () => {
    const { calls, result } = checkout({
      settings: { apiKey: 'k-1', signingSecret: 'sig-1', savePaymentMethod: 'true' },
    });
    await assert.rejects(result, (error: { getResponse?: () => unknown }) => {
      assert.equal((error.getResponse?.() as { reason?: string }).reason, 'NOT_APPROVED');
      return true;
    });
    assert.equal(calls.length, 0);
  });
});

describe('ProviderSubscriptionService.syncRow on RollyPay', () => {
  const nextCharge = new Date(Date.now() + 30 * DAY).toISOString();
  function rollypay(paymentStatus: string) {
    return (url: string): unknown => {
      if (url.endsWith('/subscriptions/rp-sub-1')) {
        return { state: 'active', billing_status: 'enabled', successful_cycles: 1, next_charge_at: nextCharge };
      }
      if (url.endsWith('/subscriptions/rp-sub-1/charges')) {
        return [
          {
            cycle_number: 1,
            status: 'payed',
            validation_status: 'accepted',
            payment_id: 'pay_1',
            actual_at: new Date().toISOString(),
          },
        ];
      }
      if (url.endsWith('/payments/pay_1')) {
        return { payment_id: 'pay_1', status: paymentStatus, subscription_id: 'rp-sub-1' };
      }
      throw new Error(`unexpected GET ${url}`);
    };
  }

  it('delivers a paid cycle once its payment is paid, on the checkout the payer confirmed', async () => {
    const h = harness({ gatewayType: PaymentGatewayType.ROLLYPAY, providerSubscriptionId: 'rp-sub-1' });
    h.setProvider(rollypay('paid'));

    await h.service.syncRow(h.row());

    assert.deepEqual(
      h.events.map((event) => [event.providerEventId, event.paymentId]),
      [['subscription:rp-sub-1:charge:1', 'payment-first']],
    );
    assert.equal(h.row().appliedChargeCount, 1);
    assert.equal(h.row().status, ProviderSubscriptionStatus.ACTIVE);
    assert.equal(h.row().providerStatus, 'active/enabled');
  });

  it('waits while the cycle is «payed» but its payment is not paid yet', async () => {
    const h = harness({ gatewayType: PaymentGatewayType.ROLLYPAY, providerSubscriptionId: 'rp-sub-1' });
    h.setProvider(rollypay('processing'));

    await h.service.syncRow(h.row());

    assert.equal(h.events.length, 0);
    assert.equal(h.row().appliedChargeCount, 0);
  });
});
