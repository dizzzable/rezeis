import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  Currency,
  PaymentGatewayType,
  Prisma,
  ProviderSubscription,
  ProviderSubscriptionStatus,
  PurchaseChannel,
  PurchaseType,
  TransactionStatus,
} from '@prisma/client';
import { of } from 'rxjs';

import {
  PAYMENT_RECONCILIATION_JOB,
  PROVIDER_SUBSCRIPTION_SYNC_JOB,
} from '../src/modules/payments/constants/payment-reconciliation.constant';
import { PaymentProviderExecutionService } from '../src/modules/payments/services/payment-provider-execution.service';
import {
  PaymentWebhookIngressService,
  readAntilopayCallbackReferences,
} from '../src/modules/payments/services/payment-webhook-ingress.service';
import { PaymentWebhookPayloadRedactionService } from '../src/modules/payments/services/payment-webhook-payload-redaction.service';
import {
  keyedChargeKey,
  ProviderSubscriptionService,
} from '../src/modules/payments/services/provider-subscription.service';
import { PaymentReconciliationProcessor } from '../src/modules/payments/processors/payment-reconciliation.processor';
import {
  buildAntilopayRecurrent,
  mapAntilopayRecurrentStatus,
  parseAntilopayRecurrent,
  readAntilopayPaymentCount,
} from '../src/modules/payments/utils/antilopay-recurrent.util';
import { isAutopayApproved } from '../src/modules/payments/utils/gateway-autopay.util';
import { normalizeGatewaySettingsForStorage } from '../src/modules/payments/utils/payment-gateway-settings.util';
import {
  antilopayPeriodForDays,
  antilopayRecurrentTypeFor,
} from '../src/modules/payments/utils/provider-subscription-period.util';
import {
  AUTOPAY_NOT_AVAILABLE_CODE,
  PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY,
  readProviderSubscriptionTerms,
  resolveProviderSubscriptionTerms,
} from '../src/modules/payments/utils/provider-subscription-terms.util';

const KEY_PAIR = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const GATEWAY_SETTINGS = {
  projectIdentificator: 'project-1',
  secretId: 'secret-id-1',
  privateKey: KEY_PAIR.privateKey,
  publicKey: 'MFwwDQYJKoZI',
  savePaymentMethod: true,
};
const DAY = 24 * 60 * 60 * 1000;

describe('Antilopay periods', () => {
  it('offers a week, a month, a quarter and a year, and nothing else', () => {
    assert.deepEqual(antilopayPeriodForDays(7), { unit: 'week', count: 1 });
    assert.deepEqual(antilopayPeriodForDays(30), { unit: 'month', count: 1 });
    assert.deepEqual(antilopayPeriodForDays(90), { unit: 'month', count: 3 });
    assert.deepEqual(antilopayPeriodForDays(365), { unit: 'year', count: 1 });
    for (const days of [1, 14, 31, 60, 180, 360, 730]) assert.equal(antilopayPeriodForDays(days), null, String(days));
    assert.equal(antilopayRecurrentTypeFor({ unit: 'week', count: 1 }), 'WEEK');
    assert.equal(antilopayRecurrentTypeFor({ unit: 'month', count: 1 }), 'MONTH');
    assert.equal(antilopayRecurrentTypeFor({ unit: 'month', count: 3 }), 'QUARTER');
    assert.equal(antilopayRecurrentTypeFor({ unit: 'year', count: 1 }), 'YEAR');
    assert.equal(antilopayRecurrentTypeFor({ unit: 'day', count: 5 }), null);
  });
});

describe('Antilopay terms', () => {
  const base = {
    gatewayType: PaymentGatewayType.ANTILOPAY as PaymentGatewayType,
    currency: 'RUB',
    amount: new Prisma.Decimal('299.00000000'),
    durationDays: 30,
    discountSource: 'NONE' as const,
    planId: 'plan-1',
    subscriptionId: null,
  };

  it('carries the payer\'s method into the terms and back out of a snapshot', () => {
    for (const method of ['CARD', 'SBP'] as const) {
      const resolved = resolveProviderSubscriptionTerms({ ...base, method });
      assert.ok('terms' in resolved);
      assert.equal(resolved.terms.method, method);
      const snapshot = JSON.parse(JSON.stringify({ id: 'plan-1', [PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY]: resolved.terms }));
      assert.deepEqual(readProviderSubscriptionTerms(snapshot), resolved.terms);
    }
  });

  it('refuses a sign-up that names neither card nor SBP, and every purchase the provider cannot repeat', () => {
    const refusal = (overrides: Record<string, unknown>) => {
      const result = resolveProviderSubscriptionTerms({ ...base, method: 'CARD', ...overrides } as never);
      return 'refusal' in result ? result.refusal : null;
    };
    assert.equal(refusal({ method: undefined }), 'METHOD');
    assert.equal(refusal({ method: 'PAYPAL' }), 'METHOD');
    assert.equal(refusal({ durationDays: 45 }), 'DURATION');
    assert.equal(refusal({ durationDays: 180 }), 'DURATION');
    assert.equal(refusal({ amount: new Prisma.Decimal('299.90') }), 'AMOUNT');
    assert.equal(refusal({ discountSource: 'PURCHASE' }), 'DISCOUNT');
    assert.equal(refusal({ currency: 'USD' }), 'CURRENCY');
    assert.equal(refusal({}), null);
  });

  it('does not put a method on another gateway\'s terms', () => {
    const resolved = resolveProviderSubscriptionTerms({
      ...base,
      gatewayType: PaymentGatewayType.PLATEGA,
      method: 'SBP',
    });
    assert.ok('terms' in resolved);
    assert.equal('method' in resolved.terms, false);
  });
});

describe('Antilopay settings', () => {
  it('reads «Число списаний (вместе с первым)» as a whole number of at least 2, or not at all', () => {
    assert.equal(readAntilopayPaymentCount({ recurrentPaymentCount: 12 }), 12);
    assert.equal(readAntilopayPaymentCount({ recurrentPaymentCount: '6' }), 6);
    for (const value of [1, 0, -3, 2.5, 'x', '', null, undefined]) {
      assert.equal(readAntilopayPaymentCount({ recurrentPaymentCount: value }), null, String(value));
    }
    assert.equal(readAntilopayPaymentCount({}), null);
  });

  it('stores the switch and the count, refusing a count below 2', () => {
    const stored = normalizeGatewaySettingsForStorage(PaymentGatewayType.ANTILOPAY, {
      projectIdentificator: 'p',
      savePaymentMethod: 'true',
      recurrentPaymentCount: '12',
    }) as Record<string, unknown>;
    assert.equal(stored['savePaymentMethod'], true);
    assert.equal(stored['recurrentPaymentCount'], 12);
    for (const bad of ['1', 1, '0', 'twelve']) {
      assert.throws(
        () => normalizeGatewaySettingsForStorage(PaymentGatewayType.ANTILOPAY, { recurrentPaymentCount: bad }),
        /PAYMENT_GATEWAY_SETTINGS_INVALID/,
        String(bad),
      );
    }
  });

  it('is off until the operator approves it', () => {
    assert.equal(isAutopayApproved(PaymentGatewayType.ANTILOPAY, {}), false);
    assert.equal(isAutopayApproved(PaymentGatewayType.ANTILOPAY, { savePaymentMethod: false }), false);
    assert.equal(isAutopayApproved(PaymentGatewayType.ANTILOPAY, { savePaymentMethod: true }), true);
  });
});

describe('the recurrent Antilopay is asked for', () => {
  const month = { unit: 'month', count: 1 } as const;

  it('makes a card sign-up a PAYMENT_TEMPLATE on the card form, with no count by default', () => {
    const request = buildAntilopayRecurrent({ period: month, method: 'CARD', paymentCount: null });
    assert.deepEqual(request, {
      recurrent: { type: 'MONTH', category: 'PAYMENT_TEMPLATE' },
      preferMethods: ['CARD_RU'],
    });
  });

  it('makes an SBP sign-up a SUBSCRIPTION whose first charge is at activation', () => {
    const request = buildAntilopayRecurrent({ period: { unit: 'month', count: 3 }, method: 'SBP', paymentCount: null });
    assert.deepEqual(request, {
      recurrent: { type: 'QUARTER', category: 'SUBSCRIPTION', delay: 0, delay_type: 'QUARTER' },
      preferMethods: ['SBP'],
    });
  });

  it('sends payment_count only when the operator set one', () => {
    assert.equal(
      (buildAntilopayRecurrent({ period: month, method: 'CARD', paymentCount: 12 })?.recurrent as Record<string, unknown>)[
        'payment_count'
      ],
      12,
    );
    assert.equal(
      'payment_count' in (buildAntilopayRecurrent({ period: month, method: 'SBP', paymentCount: null })?.recurrent ?? {}),
      false,
    );
    assert.equal(buildAntilopayRecurrent({ period: { unit: 'day', count: 5 }, method: 'CARD', paymentCount: null }), null);
  });
});

describe('Antilopay checkout creation', () => {
  function terms(method: 'CARD' | 'SBP' | undefined, extra: Record<string, unknown> = {}) {
    return {
      unit: 'month',
      count: 1,
      amount: 299,
      durationDays: 30,
      planId: 'plan-1',
      subscriptionId: null,
      ...(method === undefined ? {} : { method }),
      ...extra,
    };
  }

  async function create(input: {
    readonly snapshot: Record<string, unknown>;
    readonly settings?: Record<string, unknown>;
    readonly answer?: Record<string, unknown>;
  }) {
    const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const service = new PaymentProviderExecutionService(
      {
        post: (url: string, body: string, options: { headers: Record<string, string> }) => {
          calls.push({ url, body, headers: options.headers });
          return of({
            data: input.answer ?? { code: 0, payment_id: 'APAY-1', payment_url: 'https://gate.antilopay.com/payment/APAY-1' },
          });
        },
      } as never,
      { domain: 'https://user.example', botToken: 'bot-token-1' } as never,
      new PaymentWebhookPayloadRedactionService(),
    );
    const result = service.createCheckout({
      gateway: {
        id: 'gw-1',
        type: PaymentGatewayType.ANTILOPAY,
        currency: Currency.RUB,
        isActive: true,
        orderIndex: 0,
        settings: input.settings ?? GATEWAY_SETTINGS,
      } as never,
      transaction: {
        id: 'tx-1',
        paymentId: 'payment-1',
        userId: 'user-1',
        gatewayType: PaymentGatewayType.ANTILOPAY,
        amount: new Prisma.Decimal('299'),
        currency: Currency.RUB,
        planSnapshot: input.snapshot,
        purchaseType: PurchaseType.NEW,
        channel: PurchaseChannel.WEB,
      } as never,
      description: 'Plan purchase',
      customerEmail: 'buyer@example.com',
    } as never);
    return { calls, result };
  }

  it('signs a card sign-up with the recurrent object and the card method', async () => {
    const { calls, result } = await create({
      snapshot: { [PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY]: terms('CARD') },
    }).then(async (created) => ({ calls: created.calls, result: await created.result }));
    assert.equal(result.gatewayId, 'APAY-1');
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0]?.body ?? '{}') as Record<string, unknown>;
    assert.deepEqual(body['recurrent'], { type: 'MONTH', category: 'PAYMENT_TEMPLATE' });
    assert.deepEqual(body['prefer_methods'], ['CARD_RU']);
    assert.equal(body['amount'], 299);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(calls[0]?.body ?? '');
    assert.equal(verifier.verify(createPublicKey(KEY_PAIR.publicKey), calls[0]?.headers['X-Apay-Sign'] ?? '', 'base64'), true);
  });

  it('signs an SBP sign-up as a subscription charged at activation, with the operator\'s count', async () => {
    const created = await create({
      snapshot: { [PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY]: terms('SBP') },
      settings: { ...GATEWAY_SETTINGS, recurrentPaymentCount: 12 },
    });
    await created.result;
    const body = JSON.parse(created.calls[0]?.body ?? '{}') as Record<string, unknown>;
    assert.deepEqual(body['recurrent'], {
      type: 'MONTH',
      category: 'SUBSCRIPTION',
      delay: 0,
      delay_type: 'MONTH',
      payment_count: 12,
    });
    assert.deepEqual(body['prefer_methods'], ['SBP']);
  });

  it('sends an ordinary payment no recurrent and no preferred method', async () => {
    const created = await create({ snapshot: { id: 'plan-1' } });
    await created.result;
    const body = JSON.parse(created.calls[0]?.body ?? '{}') as Record<string, unknown>;
    assert.equal('recurrent' in body, false);
    assert.equal('prefer_methods' in body, false);
  });

  it('signs nobody up once the operator has switched approval off, and asks Antilopay nothing', async () => {
    const created = await create({
      snapshot: { [PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY]: terms('CARD') },
      settings: { ...GATEWAY_SETTINGS, savePaymentMethod: false },
    });
    await assert.rejects(created.result, (error: { getResponse?: () => unknown }) => {
      assert.equal((error.getResponse?.() as { code?: string }).code, AUTOPAY_NOT_AVAILABLE_CODE);
      return true;
    });
    assert.equal(created.calls.length, 0);
  });

  it('refuses a sign-up with no method', async () => {
    const created = await create({ snapshot: { [PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY]: terms(undefined) } });
    await assert.rejects(created.result, (error: { getResponse?: () => unknown }) => {
      assert.equal((error.getResponse?.() as { reason?: string }).reason, 'METHOD');
      return true;
    });
    assert.equal(created.calls.length, 0);
  });

  it('turns error 30 into a refusal the cabinet answers with the ordinary payment, naming the cause', async () => {
    const created = await create({
      snapshot: { [PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY]: terms('CARD') },
      answer: { code: 30, error: 'No permission to create recurrent payments' },
    });
    await assert.rejects(created.result, (error: Error & { getResponse?: () => unknown }) => {
      const body = error.getResponse?.() as { code?: string; reason?: string };
      assert.equal(body.code, AUTOPAY_NOT_AVAILABLE_CODE);
      assert.equal(body.reason, 'NOT_APPROVED');
      // What the failed checkout's `failureReason` keeps: a bounded code, not a sentence.
      assert.equal(error.message, 'ANTILOPAY_RECURRENT_NOT_PERMITTED');
      return true;
    });
  });

  it('leaves error 30 on an ordinary payment as the provider\'s own error', async () => {
    const created = await create({
      snapshot: { id: 'plan-1' },
      answer: { code: 30, error: 'nope' },
    });
    await assert.rejects(created.result, /Antilopay error 30/);
  });
});

describe('parsing payment/recurrent/check', () => {
  const body = {
    code: 0,
    recurrent_id: 'rec-1',
    type: 'MONTH',
    count: '12',
    status: 'ACTIVE',
    start_date: '2026-09-01',
    next_payment_date: '2026-10-01',
    end_date: '2027-08-01',
    pay_method: 'CARD_RU',
    payments: [
      { payment_id: 'p-2', order_id: 'made-up', ctime: '2026-10-01 10:00:00.123456', status: 'SUCCESS', original_amount: 299 },
      { payment_id: 'p-1', order_id: 'ours', ctime: '2026-09-01 09:00:00.000001', status: 'SUCCESS', original_amount: 299 },
      { payment_id: 'p-x', ctime: '2026-09-15 09:00:00', status: 'FAIL' },
      { payment_id: 'p-3', ctime: '2026-11-01 10:00:00', status: 'REVERSED' },
      { payment_id: 'p-1', ctime: '2026-09-01 09:00:00', status: 'SUCCESS' },
    ],
  };

  it('reads the dates, the count and the taken payments oldest first, once each, keyed by payment_id', () => {
    const state = parseAntilopayRecurrent(body);
    assert.equal(state.status, ProviderSubscriptionStatus.ACTIVE);
    assert.equal(state.providerStatus, 'ACTIVE');
    assert.equal(state.plannedChargeCount, 12);
    assert.equal(state.nextChargeAt?.toISOString(), '2026-10-01T00:00:00.000Z');
    assert.equal(state.endsAt?.toISOString(), '2027-08-01T00:00:00.000Z');
    assert.deepEqual(
      state.charges.map((charge) => [charge.id, charge.providerStatus, charge.disputed]),
      [
        ['p-1', 'SUCCESS', false],
        ['p-2', 'SUCCESS', false],
        ['p-3', 'REVERSED', true],
      ],
    );
    assert.equal(state.charges[0]?.amount, '299');
  });

  it('maps every documented status, and reads an unknown one as nothing', () => {
    const expected: Record<string, ProviderSubscriptionStatus> = {
      CREATED: ProviderSubscriptionStatus.PENDING,
      WAIT_CONFIRM: ProviderSubscriptionStatus.PENDING,
      ACTIVE: ProviderSubscriptionStatus.ACTIVE,
      PROCESSING: ProviderSubscriptionStatus.ACTIVE,
      ACTIVE_FAILED: ProviderSubscriptionStatus.PAST_DUE,
      COMPLETE: ProviderSubscriptionStatus.CANCELLED,
      CANCEL: ProviderSubscriptionStatus.CANCELLED,
      PROVIDER_CANCEL: ProviderSubscriptionStatus.CANCELLED,
      ERROR: ProviderSubscriptionStatus.CANCELLED,
    };
    for (const [word, status] of Object.entries(expected)) assert.equal(mapAntilopayRecurrentStatus(word), status, word);
    assert.equal(mapAntilopayRecurrentStatus('SOMETHING_NEW'), null);
    assert.equal(mapAntilopayRecurrentStatus(null), null);
  });
});

describe('an Antilopay callback of a repeat-charge payment', () => {
  const body = (value: unknown) => Buffer.from(JSON.stringify(value));

  it('names its recurrent, its order and its payment', () => {
    assert.deepEqual(
      readAntilopayCallbackReferences(
        PaymentGatewayType.ANTILOPAY,
        body({ type: 'payment', payment_id: 'p-9', order_id: 'made-up', recurrent_id: 'rec-1', status: 'SUCCESS' }),
      ),
      { orderId: 'made-up', recurrentId: 'rec-1', paymentId: 'p-9' },
    );
  });

  it('is nothing for an ordinary payment, a refund, another gateway or a body that is not JSON', () => {
    assert.equal(
      readAntilopayCallbackReferences(PaymentGatewayType.ANTILOPAY, body({ type: 'payment', order_id: 'o-1', status: 'SUCCESS' })),
      null,
    );
    assert.equal(
      readAntilopayCallbackReferences(PaymentGatewayType.ANTILOPAY, body({ type: 'refund', recurrent_id: 'rec-1' })),
      null,
    );
    assert.equal(readAntilopayCallbackReferences(PaymentGatewayType.ROLLYPAY, body({ recurrent_id: 'rec-1' })), null);
    assert.equal(readAntilopayCallbackReferences(PaymentGatewayType.ANTILOPAY, Buffer.from('nope')), null);
  });
});

describe('the ingress of an Antilopay callback of a repeat-charge payment', () => {
  function ingress(ownedOrders: string[]) {
    const recurrentJobs: Array<{ recurrentId: string; orderId: string | null }> = [];
    const recorded: unknown[] = [];
    const queued: unknown[] = [];
    const service = new PaymentWebhookIngressService(
      {
        paymentGateway: { findUnique: async () => ({ type: PaymentGatewayType.ANTILOPAY, settings: GATEWAY_SETTINGS }) },
        transaction: {
          findUnique: async ({ where }: { where: { paymentId: string } }) =>
            ownedOrders.includes(where.paymentId) ? { id: 'tx-1' } : null,
        },
      } as never,
      {
        verifyWebhookSignature: () => undefined,
        normalizeWebhook: ({ rawBody }: { rawBody: Buffer }) => {
          const parsed = JSON.parse(rawBody.toString('utf8')) as Record<string, string>;
          return {
            gatewayType: PaymentGatewayType.ANTILOPAY,
            paymentId: parsed['order_id'],
            providerEventId: parsed['order_id'],
            eventStatus: parsed['status'],
          };
        },
      } as never,
      {
        recordReceived: async ({ envelope }: { envelope: unknown }) => {
          recorded.push(envelope);
          return { duplicate: false, event: { id: 'evt-1', paymentId: 'x', gatewayType: PaymentGatewayType.ANTILOPAY } };
        },
        markEnqueued: async () => undefined,
        markFailed: async () => undefined,
      } as never,
      {} as never,
      {
        add: async (name: string, data: unknown) => {
          queued.push({ name, data });
        },
      } as never,
      {
        enqueueRecurrentSync: async (_gateway: unknown, recurrentId: string, orderId: string | null = null) => {
          recurrentJobs.push({ recurrentId, orderId });
        },
      } as never,
      { info: () => undefined } as never,
    );
    return { service, recurrentJobs, recorded, queued };
  }
  const post = (service: PaymentWebhookIngressService, payload: Record<string, unknown>) =>
    service.ingestWebhook({
      gatewayType: PaymentGatewayType.ANTILOPAY,
      rawBody: Buffer.from(JSON.stringify(payload)),
      headers: {},
      clientIp: null,
      verifySignature: false,
    });

  it('treats a charge whose order is not ours as a trigger only', async () => {
    const h = ingress(['ours-1']);
    const result = await post(h.service, {
      type: 'payment',
      payment_id: 'p-2',
      order_id: 'made-up-by-antilopay',
      recurrent_id: 'rec-1',
      status: 'SUCCESS',
    });
    assert.equal(result.accepted, true);
    assert.deepEqual(h.recurrentJobs, [{ recurrentId: 'rec-1', orderId: null }]);
    assert.equal(h.recorded.length, 0, 'no payment of ours is looked for');
    assert.equal(h.queued.length, 0);
  });

  it('sends the first payment down the ordinary pipeline and queues the look after it', async () => {
    const h = ingress(['ours-1']);
    await post(h.service, {
      type: 'payment',
      payment_id: 'p-1',
      order_id: 'ours-1',
      recurrent_id: 'rec-1',
      status: 'SUCCESS',
    });
    assert.equal(h.recorded.length, 1);
    assert.equal(h.queued.length, 1);
    assert.deepEqual((h.queued[0] as { name: string }).name, PAYMENT_RECONCILIATION_JOB);
    assert.deepEqual(h.recurrentJobs, [{ recurrentId: 'rec-1', orderId: 'ours-1' }]);
  });

  it('leaves an ordinary payment of ours alone', async () => {
    const h = ingress(['ours-1']);
    await post(h.service, { type: 'payment', payment_id: 'p-1', order_id: 'ours-1', status: 'SUCCESS' });
    assert.equal(h.recorded.length, 1);
    assert.equal(h.recurrentJobs.length, 0);
  });
});

describe('the reconciliation worker', () => {
  it('hands a recurrent job to the Antilopay sync, with our order when the callback named one', async () => {
    const seen: unknown[] = [];
    const processor = new PaymentReconciliationProcessor(
      {} as never,
      {
        syncByRecurrent: async (...args: unknown[]) => {
          seen.push(args);
        },
      } as never,
    );
    await processor.process({
      name: PROVIDER_SUBSCRIPTION_SYNC_JOB,
      data: { gatewayType: PaymentGatewayType.ANTILOPAY, providerRecurrentId: 'rec-1', orderId: 'ours-1' },
    } as never);
    await processor.process({
      name: PROVIDER_SUBSCRIPTION_SYNC_JOB,
      data: { gatewayType: PaymentGatewayType.ANTILOPAY, providerRecurrentId: 'rec-2' },
    } as never);
    assert.deepEqual(seen, [
      [PaymentGatewayType.ANTILOPAY, 'rec-1', 'ours-1'],
      [PaymentGatewayType.ANTILOPAY, 'rec-2', null],
    ]);
  });
});

// ── the subscription itself ──────────────────────────────────────────────────

interface Tx {
  id: string;
  paymentId: string;
  userId: string;
  gatewayType: PaymentGatewayType;
  gatewayId: string | null;
  planSnapshot: Record<string, unknown>;
  status: TransactionStatus;
  fulfilledAt: Date | null;
  subscriptionId: string | null;
  idempotencyKey: string | null;
  purchaseType?: PurchaseType;
  currency?: Currency;
}

interface Post {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

function harness(initial: Partial<ProviderSubscription> = {}) {
  let row: ProviderSubscription = {
    id: 'ps-1',
    userId: 'user-1',
    gatewayType: PaymentGatewayType.ANTILOPAY,
    providerSubscriptionId: 'APAY-first',
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
    method: 'CARD',
    consentVersion: 'provider-subscription-v1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...initial,
  };
  const transactions: Tx[] = [
    {
      id: 'tx-first',
      paymentId: 'ours-1',
      userId: 'user-1',
      gatewayType: PaymentGatewayType.ANTILOPAY,
      gatewayId: 'APAY-first',
      planSnapshot: {},
      status: TransactionStatus.PENDING,
      fulfilledAt: null,
      subscriptionId: null,
      idempotencyKey: null,
    },
  ];
  const events: Array<{ providerEventId: string; paymentId: string; payloadHash: string; eventStatus: string | null }> = [];
  const jobs: Array<{ name: string; data: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const posts: Post[] = [];
  let answers: (post: Post) => Record<string, unknown> = () => ({ code: 0 });

  const findTransaction = (where: Record<string, unknown>): Tx | null => {
    if (typeof where['id'] === 'string') return transactions.find((t) => t.id === where['id']) ?? null;
    if (typeof where['paymentId'] === 'string') return transactions.find((t) => t.paymentId === where['paymentId']) ?? null;
    const key = where['userId_idempotencyKey'] as { userId: string; idempotencyKey: string } | undefined;
    return key === undefined
      ? null
      : (transactions.find((t) => t.userId === key.userId && t.idempotencyKey === key.idempotencyKey) ?? null);
  };
  const createTransaction = async ({ data }: { data: Record<string, unknown> }) => {
    const created = {
      id: `tx-${transactions.length + 1}`,
      paymentId: `payment-${transactions.length + 1}`,
      fulfilledAt: null,
      gatewayId: null,
      ...data,
    } as unknown as Tx;
    transactions.push(created);
    return created;
  };
  const prisma = {
    paymentGateway: {
      findUnique: async () => ({ type: PaymentGatewayType.ANTILOPAY, settings: GATEWAY_SETTINGS }),
    },
    transaction: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) => findTransaction(where),
      findFirst: async ({ where }: { where: { paymentId?: { in: string[] }; gatewayType?: string } }) =>
        transactions.find(
          (t) => where.paymentId?.in.includes(t.paymentId) === true && t.gatewayType === where.gatewayType,
        ) ?? null,
    },
    subscription: { findUnique: async () => ({ expiresAt: new Date(Date.now() + 2 * 60 * 1000) }) },
    plan: { findMany: async () => [{ id: 'plan-1', name: 'Base' }] },
    providerSubscription: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) => {
        if (typeof where['id'] === 'string') return where['id'] === row.id ? row : null;
        if (typeof where['firstTransactionId'] === 'string') return where['firstTransactionId'] === row.firstTransactionId ? row : null;
        const recurrent = where['gatewayType_providerRecurrentId'] as { providerRecurrentId: string } | undefined;
        if (recurrent !== undefined) return recurrent.providerRecurrentId === row.providerRecurrentId ? row : null;
        const sub = where['gatewayType_providerSubscriptionId'] as { providerSubscriptionId: string } | undefined;
        return sub !== undefined && sub.providerSubscriptionId === row.providerSubscriptionId ? row : null;
      },
      findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
        where.id === row.id && where.userId === row.userId ? row : null,
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        if ('providerRecurrentId' in where && where['providerRecurrentId'] === null) {
          return row.providerRecurrentId === null ? [row] : [];
        }
        if (where['userId'] !== undefined) return where['userId'] === row.userId ? [row] : [];
        const ids = (where['id'] as { in: string[] } | undefined)?.in;
        if (ids !== undefined) return ids.includes(row.id) ? [row] : [];
        return [];
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const ids = (where['id'] as { in?: string[] } | string | undefined);
        const matches = typeof ids === 'string' ? ids === row.id : ids?.in?.includes(row.id) === true;
        if (!matches) return { count: 0 };
        if ('providerRecurrentId' in where && where['providerRecurrentId'] === null && row.providerRecurrentId !== null) {
          return { count: 0 };
        }
        const lt = (where['appliedChargeCount'] as { lt?: number } | undefined)?.lt;
        if (lt !== undefined && !(row.appliedChargeCount < lt)) return { count: 0 };
        if ('OR' in where && row.cancelledBy === 'REFUND') return { count: 0 };
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
        transactionItem: { create: async ({ data }: { data: Record<string, unknown> }) => data },
      }),
  };
  const inbox = {
    recordReceived: async ({
      envelope,
    }: {
      envelope: { providerEventId: string; paymentId: string; payloadHash: string; eventStatus: string | null };
    }) => {
      const existing = events.find((event) => event.providerEventId === envelope.providerEventId);
      if (existing !== undefined && existing.payloadHash === envelope.payloadHash) {
        return { event: { id: existing.providerEventId, paymentId: existing.paymentId }, duplicate: true };
      }
      events.push(envelope);
      return {
        event: { id: envelope.providerEventId, paymentId: envelope.paymentId, gatewayType: PaymentGatewayType.ANTILOPAY },
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
    post: (url: string, body: string) => {
      const path = url.replace('https://lk.antilopay.com/api/v1/', '');
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const post = { path, body: parsed };
      posts.push(post);
      return of({ data: answers(post) });
    },
  };
  const service = new ProviderSubscriptionService(prisma as never, http as never, inbox as never, queue as never);
  return {
    service,
    row: () => row,
    transactions,
    events,
    jobs,
    posts,
    answer: (fn: (post: Post) => Record<string, unknown>) => {
      answers = fn;
    },
    deliverFirst: (subscriptionId = 'sub-1') => {
      const first = transactions[0] as Tx;
      first.status = TransactionStatus.COMPLETED;
      first.fulfilledAt = new Date();
      first.subscriptionId = subscriptionId;
    },
  };
}

function recurrentAnswer(overrides: Record<string, unknown> = {}, payments: Array<Record<string, unknown>> = []) {
  return {
    code: 0,
    recurrent_id: 'rec-1',
    type: 'MONTH',
    count: 12,
    status: 'ACTIVE',
    start_date: '2026-09-01',
    next_payment_date: '2026-10-01',
    end_date: '2027-08-01',
    payments,
    ...overrides,
  };
}
const payment = (id: string, ctime: string, status = 'SUCCESS', amount: number | null = 299) => ({
  payment_id: id,
  ctime,
  status,
  ...(amount === null ? {} : { original_amount: amount }),
});

describe('linking a sign-up to the recurrent Antilopay names', () => {
  it('links by OUR order when the first callback names both, then reads the recurrent', async () => {
    const h = harness();
    h.answer((post) =>
      post.path === 'payment/recurrent/check'
        ? recurrentAnswer({}, [payment('APAY-first', '2026-09-01 09:00:00')])
        : { code: 0 },
    );
    await h.service.syncByRecurrent(PaymentGatewayType.ANTILOPAY, 'rec-1', 'ours-1');
    assert.equal(h.row().providerRecurrentId, 'rec-1');
    assert.equal(h.row().status, ProviderSubscriptionStatus.ACTIVE);
    assert.deepEqual(h.posts.map((post) => post.path), ['payment/recurrent/check']);
    assert.equal(h.posts[0]?.body['recurrent_id'], 'rec-1');
  });

  it('finds the recurrent of a callback whose order is Antilopay\'s own by asking about the first payment', async () => {
    const h = harness();
    h.answer((post) => {
      if (post.path === 'payment/check') return { code: 0, order_id: post.body['order_id'], status: 'SUCCESS', recurrent_id: 'rec-9' };
      return recurrentAnswer({ recurrent_id: 'rec-9' }, [payment('APAY-first', '2026-09-01 09:00:00')]);
    });
    await h.service.syncByRecurrent(PaymentGatewayType.ANTILOPAY, 'rec-9', 'made-up-by-antilopay');
    assert.equal(h.row().providerRecurrentId, 'rec-9');
    assert.equal(h.posts[0]?.path, 'payment/check');
    assert.equal(h.posts[0]?.body['order_id'], 'ours-1');
  });

  it('ignores a recurrent that is none of ours, and settles nothing for it', async () => {
    const h = harness();
    // Our sign-up's first payment names ITS recurrent; the callback names another.
    h.answer((post) => ({ code: 0, order_id: post.body['order_id'], status: 'SUCCESS', recurrent_id: 'rec-ours' }));
    await h.service.syncByRecurrent(PaymentGatewayType.ANTILOPAY, 'rec-other', 'foreign-order');
    assert.equal(h.row().providerRecurrentId, 'rec-ours', 'what it learned about our own sign-up is kept');
    assert.equal(h.row().status, ProviderSubscriptionStatus.PENDING, 'but the foreign recurrent moved nothing');
    assert.equal(h.events.length, 0);
    assert.equal(
      h.posts.every((post) => post.path === 'payment/check' || post.path === 'payment/recurrent/check'),
      true,
    );
  });

  it('finds the sign-up by the orders Antilopay lists for the recurrent when its first payment names none yet', async () => {
    const h = harness();
    h.answer((post) => {
      // The first payment is still open at Antilopay and names no recurrent...
      if (post.path === 'payment/check') return { code: 0, order_id: post.body['order_id'], status: 'PENDING' };
      // ...but the recurrent lists the payment made for OUR order.
      return recurrentAnswer({ recurrent_id: 'rec-7' }, [
        { payment_id: 'APAY-first', order_id: 'ours-1', ctime: '2026-09-01 09:00:00', status: 'SUCCESS', original_amount: 299 },
      ]);
    });
    await h.service.syncByRecurrent(PaymentGatewayType.ANTILOPAY, 'rec-7', 'made-up-by-antilopay');
    assert.equal(h.row().providerRecurrentId, 'rec-7');
    assert.equal(h.row().status, ProviderSubscriptionStatus.ACTIVE);
    assert.equal(h.events.length, 1, 'its first charge was delivered to the checkout');
  });

  it('asks nothing more for a recurrent whose payments name none of our orders', async () => {
    const h = harness();
    h.answer((post) =>
      post.path === 'payment/check'
        ? { code: 0, order_id: post.body['order_id'], status: 'PENDING' }
        : recurrentAnswer({ recurrent_id: 'rec-x' }, [
            { payment_id: 'p-x', order_id: 'somebody-elses-order', ctime: '2026-09-01 09:00:00', status: 'SUCCESS' },
          ]),
    );
    await h.service.syncByRecurrent(PaymentGatewayType.ANTILOPAY, 'rec-x', 'foreign-order');
    assert.equal(h.row().providerRecurrentId, null);
    assert.equal(h.events.length, 0);
  });

  it('leaves a sign-up whose payer has not paid as it is', async () => {
    const h = harness();
    h.answer((post) => ({ code: 0, order_id: post.body['order_id'], status: 'PENDING' }));
    await h.service.sync(PaymentGatewayType.ANTILOPAY, 'APAY-first');
    assert.equal(h.row().status, ProviderSubscriptionStatus.PENDING);
    assert.equal(h.row().providerRecurrentId, null);
    assert.equal(h.posts.length, 1);
    assert.equal(h.posts[0]?.path, 'payment/check');
  });
});

describe('delivering Antilopay charges, each under its own payment id', () => {
  it('delivers the first charge to the checkout and each later one as its own renewal, once', async () => {
    const h = harness({ providerRecurrentId: 'rec-1', status: ProviderSubscriptionStatus.ACTIVE });
    h.deliverFirst();
    h.answer(() =>
      recurrentAnswer({}, [
        payment('APAY-first', '2026-09-01 09:00:00'),
        payment('APAY-second', '2026-10-01 09:00:00'),
      ]),
    );

    await h.service.sync(PaymentGatewayType.ANTILOPAY, 'APAY-first');

    assert.deepEqual(
      h.events.map((event) => event.providerEventId),
      ['subscription:APAY-first:payment:APAY-first', 'subscription:APAY-first:payment:APAY-second'],
    );
    const renewal = h.transactions.find((t) => t.idempotencyKey === keyedChargeKey('ps-1', 'APAY-second'));
    assert.ok(renewal, 'the second charge has its own RENEW payment, keyed by its payment id');
    assert.equal(renewal?.purchaseType, PurchaseType.RENEW);
    assert.equal((renewal?.planSnapshot as Record<string, unknown>)['providerChargeId'], 'APAY-second');
    assert.equal(h.row().appliedChargeCount, 2);
    assert.equal(h.row().subscriptionId, 'sub-1');
    assert.equal(h.row().nextChargeAt?.toISOString(), '2026-10-01T00:00:00.000Z');
    assert.equal(h.row().endsAt?.toISOString(), '2027-08-01T00:00:00.000Z');
    assert.equal(h.row().plannedChargeCount, 12);

    // A second look at the same list settles nothing again.
    const events = h.events.length;
    const transactions = h.transactions.length;
    await h.service.sync(PaymentGatewayType.ANTILOPAY, 'APAY-first');
    assert.equal(h.events.length, events);
    assert.equal(h.transactions.length, transactions);
  });

  it('never shifts a charge onto another key when the list changes shape between two looks', async () => {
    const h = harness({ providerRecurrentId: 'rec-1', status: ProviderSubscriptionStatus.ACTIVE });
    h.deliverFirst();
    // A payment that was pending, and a retry that failed, are not charges yet.
    h.answer(() =>
      recurrentAnswer({}, [
        payment('APAY-first', '2026-09-01 09:00:00'),
        payment('APAY-pending', '2026-10-01 09:00:00', 'PENDING'),
        payment('APAY-failed', '2026-10-01 09:05:00', 'FAIL'),
      ]),
    );
    await h.service.sync(PaymentGatewayType.ANTILOPAY, 'APAY-first');
    assert.equal(h.transactions.filter((t) => t.idempotencyKey !== null).length, 0);

    // Later the pending one succeeds and a third is taken: each is keyed by its own id.
    h.answer(() =>
      recurrentAnswer({}, [
        payment('APAY-first', '2026-09-01 09:00:00'),
        payment('APAY-pending', '2026-10-01 09:00:00'),
        payment('APAY-failed', '2026-10-01 09:05:00', 'FAIL'),
        payment('APAY-third', '2026-11-01 09:00:00'),
      ]),
    );
    await h.service.sync(PaymentGatewayType.ANTILOPAY, 'APAY-first');
    const keys = h.transactions.map((t) => t.idempotencyKey).filter((key) => key !== null);
    assert.deepEqual(keys, [keyedChargeKey('ps-1', 'APAY-pending'), keyedChargeKey('ps-1', 'APAY-third')]);
  });

  it('waits for the first delivery before it renews anything, and books its own look', async () => {
    const h = harness({ providerRecurrentId: 'rec-1', status: ProviderSubscriptionStatus.ACTIVE });
    h.answer(() =>
      recurrentAnswer({}, [payment('APAY-first', '2026-09-01 09:00:00'), payment('APAY-second', '2026-10-01 09:00:00')]),
    );
    await h.service.sync(PaymentGatewayType.ANTILOPAY, 'APAY-first');
    assert.equal(h.transactions.some((t) => t.idempotencyKey !== null), false);
    const later = h.jobs.find((job) => job.name === PROVIDER_SUBSCRIPTION_SYNC_JOB);
    assert.equal(later?.data['providerSubscriptionId'], 'APAY-first');
    assert.equal(later?.options['delay'], 60_000);
  });

  it('does not deliver a charge made after the account was deleted', async () => {
    const h = harness({ providerRecurrentId: 'rec-1', status: ProviderSubscriptionStatus.ACTIVE, userId: null });
    h.answer(() => recurrentAnswer({}, [payment('APAY-first', '2026-09-01 09:00:00')]));
    await h.service.sync(PaymentGatewayType.ANTILOPAY, 'APAY-first');
    assert.equal(h.events.length, 0);
  });
});

describe('the states an Antilopay recurrent goes through', () => {
  const look = async (status: string, initial: Partial<ProviderSubscription> = {}) => {
    const h = harness({ providerRecurrentId: 'rec-1', status: ProviderSubscriptionStatus.ACTIVE, ...initial });
    h.deliverFirst();
    h.answer(() => recurrentAnswer({ status }, [payment('APAY-first', '2026-09-01 09:00:00')]));
    await h.service.sync(PaymentGatewayType.ANTILOPAY, 'APAY-first');
    return h;
  };

  it('COMPLETE ends the autopay the way the provider ending it does, after delivering its last charge', async () => {
    const h = await look('COMPLETE');
    assert.equal(h.row().status, ProviderSubscriptionStatus.CANCELLED);
    assert.equal(h.row().cancelledBy, 'PROVIDER');
    assert.notEqual(h.row().cancelledAt, null);
    assert.equal(h.row().providerStatus, 'COMPLETE');
    assert.equal(h.events.length, 1, 'its charge was delivered before the end was recorded');
  });

  it('CANCEL, PROVIDER_CANCEL and ERROR end it too', async () => {
    for (const status of ['CANCEL', 'PROVIDER_CANCEL', 'ERROR']) {
      const h = await look(status);
      assert.equal(h.row().status, ProviderSubscriptionStatus.CANCELLED, status);
      assert.equal(h.row().cancelledBy, 'PROVIDER', status);
    }
  });

  it('keeps it live while charging, and calls a failed attempt past due', async () => {
    assert.equal((await look('ACTIVE')).row().status, ProviderSubscriptionStatus.ACTIVE);
    assert.equal((await look('PROCESSING')).row().status, ProviderSubscriptionStatus.ACTIVE);
    assert.equal((await look('ACTIVE_FAILED')).row().status, ProviderSubscriptionStatus.PAST_DUE);
    assert.equal(
      (await look('WAIT_CONFIRM', { status: ProviderSubscriptionStatus.PENDING })).row().status,
      ProviderSubscriptionStatus.PENDING,
    );
  });

  it('activates a sign-up whose payer has paid', async () => {
    const h = await look('ACTIVE', { status: ProviderSubscriptionStatus.PENDING });
    assert.equal(h.row().status, ProviderSubscriptionStatus.ACTIVE);
  });

  it('never reads a status it does not know as a cancellation', async () => {
    const h = await look('SOMETHING_NEW');
    assert.equal(h.row().status, ProviderSubscriptionStatus.ACTIVE);
    assert.equal(h.row().cancelledAt, null);
  });

  it('does not bring back a row the panel cancelled when Antilopay still says ACTIVE', async () => {
    const h = await look('ACTIVE', { status: ProviderSubscriptionStatus.CANCELLED, cancelledAt: new Date(), cancelledBy: 'CUSTOMER' });
    assert.equal(h.row().status, ProviderSubscriptionStatus.CANCELLED);
    // A charge it took anyway is still delivered: money taken is always delivered.
    assert.equal(h.events.length, 1);
  });
});

describe('a charge Antilopay gives back', () => {
  it('goes through the refund reversal when it was delivered', async () => {
    const h = harness({ providerRecurrentId: 'rec-1', status: ProviderSubscriptionStatus.ACTIVE });
    h.deliverFirst();
    h.answer(() => recurrentAnswer({}, [payment('APAY-first', '2026-09-01 09:00:00', 'CHARGEBACK')]));
    await h.service.sync(PaymentGatewayType.ANTILOPAY, 'APAY-first');
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0]?.eventStatus, 'CHARGEBACK');
    assert.equal(h.events[0]?.providerEventId, 'subscription:APAY-first:dispute:ours-1');
    assert.equal(h.transactions.some((t) => t.idempotencyKey !== null), false, 'a given-back charge is not delivered');
  });

  it('ends the autopay when it was never delivered, marked as a refund\'s', async () => {
    const h = harness({ providerRecurrentId: 'rec-1', status: ProviderSubscriptionStatus.ACTIVE });
    let cancelPosted = false;
    h.answer((post) => {
      if (post.path === 'payment/recurrent/cancel') cancelPosted = true;
      return post.path === 'payment/recurrent/check'
        ? recurrentAnswer({ status: cancelPosted ? 'CANCEL' : 'ACTIVE' }, [payment('APAY-first', '2026-09-01 09:00:00', 'REVERSED')])
        : { code: 0 };
    });
    await h.service.sync(PaymentGatewayType.ANTILOPAY, 'APAY-first');
    assert.equal(h.events.length, 0);
    assert.equal(h.row().status, ProviderSubscriptionStatus.CANCELLED, 'the look that cancelled it does not bring it back');
    assert.equal(h.row().cancelledBy, 'REFUND');
    assert.ok(h.posts.some((post) => post.path === 'payment/recurrent/cancel'));
  });
});

describe('cancelling an Antilopay autopay', () => {
  const cancel = async (
    initial: Partial<ProviderSubscription>,
    answer: (post: Post) => Record<string, unknown>,
  ) => {
    const h = harness({ status: ProviderSubscriptionStatus.ACTIVE, ...initial });
    h.answer(answer);
    const outcome = h.service.cancelForCustomer('user-1', 'ps-1');
    return { h, outcome };
  };

  it('counts the cancel only once the recurrent reads as ended', async () => {
    const { h, outcome } = await cancel({ providerRecurrentId: 'rec-1' }, (post) =>
      post.path === 'payment/recurrent/check' ? recurrentAnswer({ status: 'CANCEL' }) : { code: 0 },
    );
    await outcome;
    assert.deepEqual(h.posts.map((post) => post.path), ['payment/recurrent/cancel', 'payment/recurrent/check']);
    assert.deepEqual(h.posts[0]?.body, { project_identificator: 'project-1', recurrent_id: 'rec-1' });
    assert.equal(h.row().status, ProviderSubscriptionStatus.CANCELLED);
    assert.equal(h.row().cancelledBy, 'CUSTOMER');
  });

  it('does not count an answer of 0 that the recurrent contradicts', async () => {
    const { h, outcome } = await cancel({ providerRecurrentId: 'rec-1' }, (post) =>
      post.path === 'payment/recurrent/check' ? recurrentAnswer({ status: 'ACTIVE' }) : { code: 0 },
    );
    await assert.rejects(outcome, /did not cancel recurrent rec-1/);
    assert.equal(h.row().status, ProviderSubscriptionStatus.ACTIVE);
  });

  it('takes 28 («не активен») for a recurrent that has already ended', async () => {
    const { h, outcome } = await cancel({ providerRecurrentId: 'rec-1' }, (post) =>
      post.path === 'payment/recurrent/check'
        ? recurrentAnswer({ status: 'COMPLETE' })
        : { code: 28, error: 'Recurrent payment is not active' },
    );
    await outcome;
    assert.equal(h.row().status, ProviderSubscriptionStatus.CANCELLED);
  });

  it('cancels a sign-up nobody paid by its first payment once that payment is dead, and not before', async () => {
    const dead = await cancel({ providerRecurrentId: 'rec-1', status: ProviderSubscriptionStatus.PENDING }, (post) => {
      if (post.path === 'payment/recurrent/check') return recurrentAnswer({ status: 'CREATED' });
      if (post.path === 'payment/check') return { code: 0, order_id: 'ours-1', status: 'EXPIRED' };
      return { code: 28, error: 'not active' };
    });
    await dead.outcome;
    assert.equal(dead.h.row().status, ProviderSubscriptionStatus.CANCELLED);

    const open = await cancel({ providerRecurrentId: 'rec-1', status: ProviderSubscriptionStatus.PENDING }, (post) => {
      if (post.path === 'payment/recurrent/check') return recurrentAnswer({ status: 'CREATED' });
      if (post.path === 'payment/check') return { code: 0, order_id: 'ours-1', status: 'PENDING' };
      return { code: 28, error: 'not active' };
    });
    await assert.rejects(open.outcome, /did not cancel recurrent/);
    assert.equal(open.h.row().status, ProviderSubscriptionStatus.PENDING);
  });

  it('cancels by the initiating payment when the recurrent\'s id is not known yet', async () => {
    const { h, outcome } = await cancel({ status: ProviderSubscriptionStatus.PENDING }, (post) => {
      if (post.path === 'payment/check') return { code: 0, order_id: 'ours-1', status: 'CANCEL' };
      return { code: 28, error: 'not active' };
    });
    await outcome;
    const cancelCall = h.posts.find((post) => post.path === 'payment/recurrent/cancel');
    assert.deepEqual(cancelCall?.body, { project_identificator: 'project-1', transaction_id: 'APAY-first' });
    assert.equal(h.row().status, ProviderSubscriptionStatus.CANCELLED);
  });

  it('reports any other refusal, and leaves the row to the sweep', async () => {
    const { h, outcome } = await cancel({ providerRecurrentId: 'rec-1' }, () => ({ code: 22, error: 'IP not allowed' }));
    await assert.rejects(outcome, /error 22/);
    assert.equal(h.row().status, ProviderSubscriptionStatus.ACTIVE);
  });
});

describe('what the customer and the operator read', () => {
  it('lists the end of the plan of charges and the method beside the next date', async () => {
    const h = harness({
      status: ProviderSubscriptionStatus.ACTIVE,
      providerRecurrentId: 'rec-1',
      nextChargeAt: new Date(Date.now() + DAY),
      endsAt: new Date('2027-08-01T00:00:00.000Z'),
      plannedChargeCount: 12,
      method: 'SBP',
    });
    const [listed] = await h.service.listForUser('user-1');
    assert.equal(listed?.endsAt, '2027-08-01T00:00:00.000Z');
    assert.equal(listed?.plannedChargeCount, 12);
    assert.equal(listed?.method, 'SBP');
    assert.equal(listed?.gatewayType, PaymentGatewayType.ANTILOPAY);
  });
});
