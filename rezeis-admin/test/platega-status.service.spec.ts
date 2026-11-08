import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PaymentGatewayType, TransactionStatus } from '@prisma/client';
import { of, throwError } from 'rxjs';

import { PAYMENT_RECONCILIATION_JOB } from '../src/modules/payments/constants/payment-reconciliation.constant';
import { PaymentPendingExpiryService } from '../src/modules/payments/services/payment-pending-expiry.service';
import { mapProviderStatusToTransactionStatus } from '../src/modules/payments/services/payment-reconciliation.service';
import { PaymentWebhookNormalizerService } from '../src/modules/payments/services/payment-webhook-normalizer.service';
import {
  classifyPlategaPaymentStatus,
  PLATEGA_FIRST_CHECK_AFTER_MS,
  PLATEGA_GIVE_UP_AFTER_MS,
  PLATEGA_LAPSED_WINDOW_MS,
  PLATEGA_PAYMENT_CHECK_SOURCE,
  PLATEGA_RECHECK_EVERY_MS,
  PlategaStatusService,
} from '../src/modules/payments/services/platega-status.service';
import { PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY } from '../src/modules/payments/utils/provider-subscription-terms.util';
import { executeGatewayDataWrites } from './helpers/gateway-data-write-double';

/**
 * Platega's callbacks to an operator's panel failed on 05.11.2026 and two paid
 * payments were cancelled as abandoned. These pin the answer: the panel asks
 * Platega itself (`GET /transaction/{id}`) and settles what it hears through
 * the inbox, as a callback would have been.
 */

const SETTINGS = { merchantId: 'merchant-1', secret: 'secret-1' };
const NOW = new Date('2026-11-08T12:00:00.000Z');
const MINUTE = 60 * 1000;

interface Row {
  id: string;
  paymentId: string;
  createdAt: Date;
  gatewayId: string | null;
  gatewayData: Record<string, unknown> | null;
  planSnapshot: Record<string, unknown>;
  status: TransactionStatus;
  fulfilledAt: Date | null;
}

function row(overrides: Partial<Row> & { readonly ageMinutes?: number } = {}): Row {
  const { ageMinutes, ...rest } = overrides;
  return {
    id: 'tx-1',
    paymentId: 'pay-1',
    createdAt: new Date(NOW.getTime() - (ageMinutes ?? 10) * MINUTE),
    gatewayId: 'pl-1',
    gatewayData: null,
    planSnapshot: { id: 'plan-1' },
    status: TransactionStatus.PENDING,
    fulfilledAt: null,
    ...rest,
  };
}

type Reply = { readonly status: number; readonly data: unknown } | Error;

/** Platega's `GET /transaction/{id}` answer, as its documentation shows it. */
function answer(providerId: string, paymentId: string, status: string, extra: Record<string, unknown> = {}): Reply {
  return {
    status: 200,
    data: {
      id: providerId,
      status,
      paymentDetails: { amount: 814, currency: 'RUB' },
      merchantName: 'Demo Merchant',
      paymentMethod: 'SBPQR',
      expiresIn: '00:15:00',
      payload: paymentId,
      ...extra,
    },
  };
}

function createHarness(input: {
  readonly rows: Row[];
  readonly reply: (providerId: string) => Reply;
  readonly gateway?: boolean;
}) {
  const gets: Array<{ url: string; headers: Record<string, string>; timeout?: number }> = [];
  const recorded: Array<Record<string, unknown>> = [];
  const queued: Array<{ name: string; data: Record<string, unknown> }> = [];
  const rowById = (id: string): Row => {
    const found = input.rows.find((candidate) => candidate.id === id);
    if (found === undefined) throw new Error(`no row ${id}`);
    return found;
  };
  const prisma = {
    paymentGateway: {
      findUnique: async () => (input.gateway === false ? null : { settings: SETTINGS }),
    },
    transaction: {
      findMany: async (args: Record<string, unknown>) => {
        const where = args['where'] as {
          status?: TransactionStatus;
          gatewayType?: PaymentGatewayType;
          fulfilledAt?: null;
          createdAt?: { lt?: Date; gte?: Date };
          id?: { gt: string };
        };
        assert.equal(where.gatewayType, PaymentGatewayType.PLATEGA);
        return input.rows
          .filter((candidate) => where.status === undefined || candidate.status === where.status)
          .filter((candidate) => where.fulfilledAt === undefined || candidate.fulfilledAt === null)
          .filter((candidate) => candidate.gatewayId !== null)
          .filter((candidate) => where.createdAt?.lt === undefined || candidate.createdAt < where.createdAt.lt)
          .filter((candidate) => where.createdAt?.gte === undefined || candidate.createdAt >= where.createdAt.gte)
          .filter((candidate) => where.id === undefined || candidate.id > where.id.gt)
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, typeof args['take'] === 'number' ? args['take'] : undefined);
      },
    },
    $executeRaw: executeGatewayDataWrites({
      currentGatewayData: (id) => rowById(id).gatewayData,
      update: async (args) => {
        rowById(args.where.id).gatewayData = args.data.gatewayData;
      },
      updateMany: async (args) => {
        const target = rowById(args.where.id);
        if (args.where.status !== undefined && target.status !== args.where.status) return { count: 0 };
        target.gatewayData = args.data.gatewayData;
        return { count: 1 };
      },
    }),
  };
  const http = {
    get: (url: string, options: { headers: Record<string, string>; timeout?: number }) => {
      gets.push({ url, headers: options.headers, timeout: options.timeout });
      const reply = input.reply(decodeURIComponent(url.slice(url.lastIndexOf('/') + 1)));
      return reply instanceof Error ? throwError(() => reply) : of(reply);
    },
  };
  const seen = new Set<string>();
  const inbox = {
    recordReceived: async ({ envelope }: { envelope: Record<string, unknown> }) => {
      const key = `${String(envelope['providerEventId'])}:${String(envelope['payloadHash'])}`;
      if (seen.has(key)) {
        return { duplicate: true, event: { id: 'evt-dup', paymentId: envelope['paymentId'], gatewayType: envelope['gatewayType'] } };
      }
      seen.add(key);
      recorded.push(envelope);
      return {
        duplicate: false,
        event: { id: `evt-${recorded.length}`, paymentId: envelope['paymentId'], gatewayType: envelope['gatewayType'] },
      };
    },
    markEnqueued: async () => undefined,
    markFailed: async () => undefined,
  };
  const queue = {
    add: async (name: string, data: Record<string, unknown>) => {
      queued.push({ name, data });
    },
  };
  const service = new PlategaStatusService(
    prisma as never,
    http as never,
    new PaymentWebhookNormalizerService(),
    inbox as never,
    queue as never,
  );
  return { service, gets, recorded, queued, rows: input.rows };
}

const signUpSnapshot = {
  id: 'plan-1',
  [PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY]: {
    unit: 'month',
    count: 1,
    amount: 299,
    durationDays: 30,
    planId: 'plan-1',
    subscriptionId: null,
  },
};

describe('Platega GET /transaction/{id}', () => {
  it('asks by Platega’s own id with the merchant headers, and ends the request in good time', async () => {
    const h = createHarness({ rows: [], reply: (id) => answer(id, 'pay-1', 'PENDING') });

    const check = await h.service.checkPayment(SETTINGS as never, 'pl-1', 'pay-1');

    assert.deepStrictEqual(h.gets, [
      {
        url: 'https://app.platega.io/transaction/pl-1',
        headers: { 'X-MerchantId': 'merchant-1', 'X-Secret': 'secret-1' },
        timeout: 15_000,
      },
    ]);
    assert.equal(check.kind, 'FOUND');
    assert.deepStrictEqual(check.kind === 'FOUND' ? check.payload : null, {
      id: 'pl-1',
      amount: 814,
      currency: 'RUB',
      status: 'PENDING',
      paymentMethod: 'SBPQR',
      payload: 'pay-1',
    });
  });

  it('calls a 404 «no such payment», and every other refusal an error', async () => {
    const missing = createHarness({ rows: [], reply: () => ({ status: 404, data: {} }) });
    assert.deepStrictEqual(await missing.service.checkPayment(SETTINGS as never, 'pl-1', 'pay-1'), { kind: 'NOT_FOUND' });

    const refused = createHarness({ rows: [], reply: () => ({ status: 401, data: {} }) });
    await assert.rejects(refused.service.checkPayment(SETTINGS as never, 'pl-1', 'pay-1'), /HTTP 401/);
  });

  it('refuses an answer about another payment, or about a payment that is not this one of ours', async () => {
    const otherId = createHarness({ rows: [], reply: () => answer('pl-2', 'pay-1', 'CONFIRMED') });
    await assert.rejects(otherId.service.checkPayment(SETTINGS as never, 'pl-1', 'pay-1'), /answered for pl-2/);

    const otherPayload = createHarness({ rows: [], reply: (id) => answer(id, 'pay-2', 'CONFIRMED') });
    await assert.rejects(otherPayload.service.checkPayment(SETTINGS as never, 'pl-1', 'pay-1'), /another payment/);
  });

  it('reads Platega’s words as the panel’s, as the reconciliation maps them', () => {
    assert.equal(classifyPlategaPaymentStatus('PENDING'), 'OPEN');
    assert.equal(classifyPlategaPaymentStatus('CONFIRMED'), 'PAID');
    assert.equal(classifyPlategaPaymentStatus('CANCELED'), 'DEAD');
    assert.equal(classifyPlategaPaymentStatus('CHARGEBACKED'), 'REVERSED');
    assert.equal(classifyPlategaPaymentStatus('DISPUTED'), 'UNKNOWN');
    assert.equal(classifyPlategaPaymentStatus('PARTIALLY_REFUNDED'), 'UNKNOWN');
    assert.equal(mapProviderStatusToTransactionStatus('CONFIRMED'), TransactionStatus.COMPLETED);
    assert.equal(mapProviderStatusToTransactionStatus('CANCELED'), TransactionStatus.CANCELED);
  });
});

describe('Platega: the five-minute check of open payments', () => {
  it('hands a confirmed payment to the reconciliation as the callback that never came', async () => {
    const h = createHarness({ rows: [row()], reply: (id) => answer(id, 'pay-1', 'CONFIRMED') });

    assert.equal(await h.service.checkOpenPayments(NOW), 1);

    assert.equal(h.recorded.length, 1);
    const envelope = h.recorded[0] ?? {};
    assert.equal(envelope['gatewayType'], PaymentGatewayType.PLATEGA);
    assert.equal(envelope['paymentId'], 'pay-1');
    assert.equal(envelope['eventStatus'], 'CONFIRMED');
    assert.equal(envelope['providerEventId'], 'platega-check:pay-1:CONFIRMED');
    assert.equal((envelope['rawPayload'] as Record<string, unknown>)['source'], PLATEGA_PAYMENT_CHECK_SOURCE);
    assert.deepStrictEqual(h.queued, [
      { name: PAYMENT_RECONCILIATION_JOB, data: { eventId: 'evt-1', paymentId: 'pay-1', gatewayType: PaymentGatewayType.PLATEGA } },
    ]);
    assert.equal(h.rows[0]?.gatewayData?.['plategaStatus'], 'CONFIRMED');
  });

  it('only stamps a payment still open there, and asks again five minutes later, not sooner', async () => {
    const h = createHarness({ rows: [row()], reply: (id) => answer(id, 'pay-1', 'PENDING') });

    await h.service.checkOpenPayments(NOW);
    await h.service.checkOpenPayments(new Date(NOW.getTime() + PLATEGA_RECHECK_EVERY_MS - 1));
    await h.service.checkOpenPayments(new Date(NOW.getTime() + PLATEGA_RECHECK_EVERY_MS));

    assert.equal(h.gets.length, 2);
    assert.equal(h.recorded.length, 0);
    assert.equal(h.rows[0]?.gatewayData?.['plategaStatus'], 'PENDING');
  });

  it('asks nothing about a payment younger than its callback, a sign-up, or a placeholder id', async () => {
    const h = createHarness({
      rows: [
        row({ id: 'tx-young', ageMinutes: PLATEGA_FIRST_CHECK_AFTER_MS / MINUTE - 1 }),
        row({ id: 'tx-signup', planSnapshot: signUpSnapshot }),
        row({ id: 'tx-claim', gatewayId: '__RENEWAL_PROVIDER_CREATE__:x' }),
        row({ id: 'tx-none', gatewayId: null }),
      ],
      reply: (id) => answer(id, 'pay-1', 'CONFIRMED'),
    });

    assert.equal(await h.service.checkOpenPayments(NOW), 0);
    assert.equal(h.gets.length, 0);
  });

  it('settles nothing twice: the same answer again is the same notice', async () => {
    const h = createHarness({ rows: [row()], reply: (id) => answer(id, 'pay-1', 'CONFIRMED') });

    await h.service.checkOpenPayments(NOW);
    await h.service.checkOpenPayments(new Date(NOW.getTime() + PLATEGA_RECHECK_EVERY_MS));

    assert.equal(h.gets.length, 2);
    assert.equal(h.queued.length, 1);
  });

  it('stops after three failures in a row: Platega is not answering', async () => {
    const h = createHarness({
      rows: ['a', 'b', 'c', 'd', 'e'].map((id) => row({ id: `tx-${id}`, paymentId: `pay-${id}`, gatewayId: `pl-${id}` })),
      reply: () => new Error('The SSL connection could not be established'),
    });

    assert.equal(await h.service.checkOpenPayments(NOW), 0);
    assert.equal(h.gets.length, 3);
  });
});

describe('Platega: the question before the expiry sweep cancels', () => {
  const stale = (overrides: Partial<Row> & { readonly ageMinutes?: number } = {}) => row({ ageMinutes: 31, ...overrides });

  it('keeps a confirmed payment and hands it over; cancels on Platega’s word a dead one', async () => {
    const paid = createHarness({ rows: [stale()], reply: (id) => answer(id, 'pay-1', 'CONFIRMED') });
    assert.equal(await paid.service.verdictBeforeExpiry(paid.rows[0] as never, NOW), 'keep');
    assert.equal(paid.queued.length, 1);

    const dead = createHarness({ rows: [stale()], reply: (id) => answer(id, 'pay-1', 'CANCELED') });
    assert.equal(await dead.service.verdictBeforeExpiry(dead.rows[0] as never, NOW), 'provider-terminal');
  });

  it('keeps one Platega calls open, or cannot be asked about, until the give-up age — then our clock', async () => {
    const giveUpMinutes = PLATEGA_GIVE_UP_AFTER_MS / MINUTE;
    for (const reply of [(id: string) => answer(id, 'pay-1', 'PENDING'), () => new Error('timeout of 15000ms exceeded')]) {
      const young = createHarness({ rows: [stale({ ageMinutes: giveUpMinutes - 1 })], reply });
      assert.equal(await young.service.verdictBeforeExpiry(young.rows[0] as never, NOW), 'keep');

      const old = createHarness({ rows: [stale({ ageMinutes: giveUpMinutes })], reply });
      assert.equal(await old.service.verdictBeforeExpiry(old.rows[0] as never, NOW), 'local-ttl');
    }
  });

  it('leaves a sign-up to our clock without asking: its id is the subscription’s', async () => {
    const h = createHarness({ rows: [stale({ planSnapshot: signUpSnapshot })], reply: (id) => answer(id, 'pay-1', 'CONFIRMED') });
    assert.equal(await h.service.verdictBeforeExpiry(h.rows[0] as never, NOW), 'local-ttl');
    assert.equal(h.gets.length, 0);
  });

  it('opens a breaker after three failed checks: the rows behind do not each wait out a timeout', async () => {
    const h = createHarness({
      rows: ['a', 'b', 'c', 'd'].map((id) => stale({ id: `tx-${id}`, paymentId: `pay-${id}`, gatewayId: `pl-${id}` })),
      reply: () => new Error('connect ETIMEDOUT'),
    });
    for (const target of h.rows) await h.service.verdictBeforeExpiry(target as never, NOW);
    assert.equal(h.gets.length, 3);
  });

  it('is what the expiry sweep follows for a Platega payment', async () => {
    for (const [status, cancelled] of [
      ['CONFIRMED', false],
      ['PENDING', false],
      ['CANCELED', true],
    ] as const) {
      // The sweep reads the clock itself: the row is 31 minutes old by THAT
      // clock, not by the fixed NOW the other cases pass in.
      const h = createHarness({
        rows: [stale({ createdAt: new Date(Date.now() - 31 * MINUTE) })],
        reply: (id) => answer(id, 'pay-1', status),
      });
      const cancels: unknown[] = [];
      const expiryPrisma = {
        transaction: {
          findMany: async () => [
            {
              ...h.rows[0],
              userId: 'user-1',
              purchaseType: 'NEW',
              gatewayType: PaymentGatewayType.PLATEGA,
              amount: { toString: () => '814' },
              currency: 'RUB',
            },
          ],
          updateMany: async (args: unknown) => {
            cancels.push(args);
            return { count: 1 };
          },
        },
        trialClaim: { updateMany: async () => ({ count: 0 }) },
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(expiryPrisma),
      };
      const expiry = new PaymentPendingExpiryService(
        expiryPrisma as never,
        { info: () => undefined, warn: () => undefined } as never,
        { get: () => { throw new Error('no YooKassa poll'); } } as never,
        {} as never,
        {} as never,
        {} as never,
        undefined,
        h.service,
      );
      await expiry.expireStalePending();
      assert.equal(cancels.length > 0, cancelled, status);
    }
  });
});

describe('Platega: the hourly look at payments cancelled on our own clock', () => {
  const lapsed = (overrides: Partial<Row> & { readonly ageMinutes?: number } = {}) =>
    row({ status: TransactionStatus.CANCELED, ageMinutes: 3 * 24 * 60, ...overrides });

  it('revives a payment Platega confirms — the lost callbacks of 05.11.2026 — and asks about it no more', async () => {
    const h = createHarness({ rows: [lapsed()], reply: (id) => answer(id, 'pay-1', 'CONFIRMED') });

    assert.equal(await h.service.checkLapsedPayments(NOW, { throttleMs: 0 }), 1);
    assert.equal(h.queued.length, 1);
    assert.equal(h.recorded[0]?.['eventStatus'], 'CONFIRMED');
    assert.equal(h.rows[0]?.gatewayData?.['plategaStatus'], 'CONFIRMED');

    assert.equal(await h.service.checkLapsedPayments(new Date(NOW.getTime() + 2 * 60 * MINUTE), { throttleMs: 0 }), 0);
  });

  it('hands over nothing Platega calls dead, charged back or unknown, and stops asking once it names an end', async () => {
    const statuses: Record<string, string> = { 'pl-a': 'CANCELED', 'pl-b': 'CHARGEBACKED', 'pl-c': 'PENDING' };
    const h = createHarness({
      rows: ['a', 'b', 'c'].map((id) => lapsed({ id: `tx-${id}`, paymentId: `pay-${id}`, gatewayId: `pl-${id}` })),
      reply: (providerId) => answer(providerId, providerId.replace('pl-', 'pay-'), statuses[providerId] ?? 'PENDING'),
    });

    assert.equal(await h.service.checkLapsedPayments(NOW, { throttleMs: 0 }), 3);
    assert.equal(h.queued.length, 0);

    // An hour on, only the one Platega still called open is asked about again.
    assert.equal(await h.service.checkLapsedPayments(new Date(NOW.getTime() + 60 * MINUTE), { throttleMs: 0 }), 1);
    assert.equal(h.gets[h.gets.length - 1]?.url, 'https://app.platega.io/transaction/pl-c');
  });

  it('looks only at payments never completed, within the window, that are not sign-ups', async () => {
    const h = createHarness({
      rows: [
        lapsed({ id: 'tx-refunded', fulfilledAt: new Date(NOW.getTime() - 3 * 24 * 60 * MINUTE) }),
        lapsed({ id: 'tx-old', ageMinutes: PLATEGA_LAPSED_WINDOW_MS / MINUTE + 1 }),
        lapsed({ id: 'tx-signup', planSnapshot: signUpSnapshot }),
        lapsed({ id: 'tx-charge', gatewayData: { snapshotSource: 'PROVIDER_SUBSCRIPTION_CHARGE' } }),
        row({ id: 'tx-open' }),
      ],
      reply: (id) => answer(id, 'pay-1', 'CONFIRMED'),
    });

    assert.equal(await h.service.checkLapsedPayments(NOW, { throttleMs: 0 }), 0);
    assert.equal(h.gets.length, 0);
  });

  it('asks nothing when Platega is not set up', async () => {
    const h = createHarness({ rows: [lapsed()], reply: (id) => answer(id, 'pay-1', 'CONFIRMED'), gateway: false });
    assert.equal(await h.service.checkLapsedPayments(NOW, { throttleMs: 0 }), 0);
    assert.equal(await h.service.checkOpenPayments(NOW), 0);
  });
});
