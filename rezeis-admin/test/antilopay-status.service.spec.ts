import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import { PaymentGatewayType, TransactionStatus } from '@prisma/client';
import { of, throwError } from 'rxjs';

import { PAYMENT_RECONCILIATION_JOB } from '../src/modules/payments/constants/payment-reconciliation.constant';
import {
  ANTILOPAY_COMPLETED_WINDOW_MS,
  ANTILOPAY_FIRST_CHECK_AFTER_MS,
  ANTILOPAY_GIVE_UP_AFTER_MS,
  ANTILOPAY_RECHECK_EVERY_MS,
  AntilopayStatusService,
} from '../src/modules/payments/services/antilopay-status.service';
import { PaymentPendingExpiryService } from '../src/modules/payments/services/payment-pending-expiry.service';
import { PaymentWebhookNormalizerService } from '../src/modules/payments/services/payment-webhook-normalizer.service';
import {
  classifyAntilopayPaymentStatus,
  toAntilopayPrivateKeyPem,
} from '../src/modules/payments/utils/antilopay-api.util';
import {
  isRefundProviderStatus,
  mapProviderStatusToTransactionStatus,
} from '../src/modules/payments/services/payment-reconciliation.service';
import { executeGatewayDataWrites } from './helpers/gateway-data-write-double';

const KEY_PAIR = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const SETTINGS = {
  projectIdentificator: 'project-1',
  secretId: 'secret-id-1',
  privateKey: KEY_PAIR.privateKey,
};

const NOW = new Date('2026-09-29T12:00:00.000Z');
const MINUTE = 60 * 1000;

interface Row {
  id: string;
  paymentId: string;
  createdAt: Date;
  gatewayData: Record<string, unknown> | null;
  status: TransactionStatus;
}

function row(overrides: Partial<Row> & { readonly ageMinutes?: number } = {}): Row {
  const { ageMinutes, ...rest } = overrides;
  return {
    id: 'tx-1',
    paymentId: 'pay-1',
    createdAt: new Date(NOW.getTime() - (ageMinutes ?? 10) * MINUTE),
    gatewayData: null,
    status: TransactionStatus.PENDING,
    ...rest,
  };
}

type Reply = { readonly data: unknown } | Error;

function checkReply(orderId: string, status: string, extra: Record<string, unknown> = {}): Reply {
  return {
    data: {
      code: 0,
      payment_id: `APAY-${orderId}`,
      order_id: orderId,
      amount: 990,
      original_amount: 1000,
      fee: 10,
      status,
      currency: 'RUB',
      ...extra,
    },
  };
}

interface Harness {
  readonly service: AntilopayStatusService;
  readonly posts: Array<{ url: string; body: string; headers: Record<string, string> }>;
  readonly recorded: Array<Record<string, unknown>>;
  readonly queued: Array<{ name: string; data: Record<string, unknown> }>;
  readonly failed: string[];
  readonly rows: Row[];
  readonly findManyArgs: Array<Record<string, unknown>>;
}

function createHarness(input: {
  readonly rows: Row[];
  readonly answer: (orderId: string) => Reply;
  readonly duplicateEvents?: boolean;
  readonly gateway?: boolean;
  readonly queueFails?: boolean;
}): Harness {
  const posts: Harness['posts'] = [];
  const recorded: Harness['recorded'] = [];
  const queued: Harness['queued'] = [];
  const failed: string[] = [];
  const findManyArgs: Array<Record<string, unknown>> = [];
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
        findManyArgs.push(args);
        const where = args['where'] as { status?: TransactionStatus; id?: { gt: string } };
        return input.rows
          .filter((candidate) => where.status === undefined || candidate.status === where.status)
          .filter((candidate) => where.id === undefined || candidate.id > where.id.gt)
          .sort((a, b) => a.id.localeCompare(b.id));
      },
      updateMany: async (args: { where: { id: string; status?: string }; data: { gatewayData: Record<string, unknown> } }) => {
        const target = rowById(args.where.id);
        if (args.where.status !== undefined && target.status !== args.where.status) return { count: 0 };
        target.gatewayData = args.data.gatewayData;
        return { count: 1 };
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
    post: (url: string, body: string, options: { headers: Record<string, string> }) => {
      posts.push({ url, body, headers: options.headers });
      const parsed = JSON.parse(body) as { order_id: string };
      const reply = input.answer(parsed.order_id);
      return reply instanceof Error ? throwError(() => reply) : of(reply);
    },
  };
  const seen = new Set<string>();
  const inbox = {
    recordReceived: async ({ envelope }: { envelope: Record<string, unknown> }) => {
      const key = `${String(envelope['providerEventId'])}:${String(envelope['payloadHash'])}`;
      if (input.duplicateEvents === true || seen.has(key)) {
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
    markFailed: async (id: string) => {
      failed.push(id);
    },
  };
  const queue = {
    add: async (name: string, data: Record<string, unknown>) => {
      if (input.queueFails === true) throw new Error('redis is down');
      queued.push({ name, data });
    },
  };
  const service = new AntilopayStatusService(
    prisma as never,
    http as never,
    new PaymentWebhookNormalizerService(),
    inbox as never,
    queue as never,
  );
  return { service, posts, recorded, queued, failed, rows: input.rows, findManyArgs };
}

describe('Antilopay payment/check', () => {
  it('signs the exact body it posts and asks by our own payment id', async () => {
    const h = createHarness({ rows: [row()], answer: (id) => checkReply(id, 'PENDING') });
    const check = await h.service.checkPayment(SETTINGS, 'pay-1');

    assert.equal(check.kind, 'FOUND');
    assert.equal(h.posts.length, 1);
    assert.equal(h.posts[0]?.url, 'https://lk.antilopay.com/api/v1/payment/check');
    assert.deepEqual(JSON.parse(h.posts[0]?.body ?? '{}'), { project_identificator: 'project-1', order_id: 'pay-1' });
    assert.equal(h.posts[0]?.headers['X-Apay-Secret-Id'], 'secret-id-1');
    assert.equal(h.posts[0]?.headers['X-Apay-Sign-Version'], '1');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(h.posts[0]?.body ?? '');
    assert.equal(verifier.verify(createPublicKey(KEY_PAIR.publicKey), h.posts[0]?.headers['X-Apay-Sign'] ?? '', 'base64'), true);
  });

  it('reads code 8 as a payment that was never created, and any other refusal as a failure', async () => {
    const h = createHarness({
      rows: [row()],
      answer: (id) => (id === 'missing' ? { data: { code: 8, error: 'Payment not found' } } : { data: { code: 22, error: 'IP not allowed' } }),
    });
    assert.deepEqual(await h.service.checkPayment(SETTINGS, 'missing'), { kind: 'NOT_FOUND' });
    await assert.rejects(h.service.checkPayment(SETTINGS, 'pay-1'), /error 22/);
  });

  it('refuses an answer about a different order', async () => {
    const h = createHarness({ rows: [row()], answer: () => checkReply('somebody-else', 'SUCCESS') });
    await assert.rejects(h.service.checkPayment(SETTINGS, 'pay-1'), /answered for order somebody-else/);
  });

  it('sorts the documented statuses by what the panel does about them', () => {
    assert.equal(classifyAntilopayPaymentStatus('SUCCESS'), 'PAID');
    assert.equal(classifyAntilopayPaymentStatus('pending'), 'OPEN');
    for (const dead of ['FAIL', 'CANCEL', 'EXPIRED']) assert.equal(classifyAntilopayPaymentStatus(dead), 'DEAD');
    for (const reversed of ['CHARGEBACK', 'REVERSED']) assert.equal(classifyAntilopayPaymentStatus(reversed), 'REVERSED');
    assert.equal(classifyAntilopayPaymentStatus('SOMETHING_NEW'), 'UNKNOWN');
    assert.equal(classifyAntilopayPaymentStatus(null), 'UNKNOWN');
  });

  it('accepts the key in the shapes an operator pastes', () => {
    const body = KEY_PAIR.privateKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    for (const shape of [body, `${body}\n`, KEY_PAIR.privateKey]) {
      assert.match(toAntilopayPrivateKeyPem(shape), /^-----BEGIN RSA PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END RSA PRIVATE KEY-----\n$/);
    }
  });
});

describe('Antilopay pending payments whose callback never came', () => {
  it('hands a paid one to the reconciliation as the notice a callback would have been', async () => {
    const h = createHarness({ rows: [row()], answer: (id) => checkReply(id, 'SUCCESS', { recurrent_id: 'rec-1' }) });

    const asked = await h.service.checkOpenPayments(NOW);

    assert.equal(asked, 1);
    assert.equal(h.recorded.length, 1);
    const envelope = h.recorded[0] as Record<string, any>;
    assert.equal(envelope.gatewayType, PaymentGatewayType.ANTILOPAY);
    assert.equal(envelope.paymentId, 'pay-1');
    assert.equal(envelope.eventStatus, 'SUCCESS');
    assert.equal(envelope.providerEventId, 'antilopay-check:pay-1:SUCCESS');
    assert.equal(envelope.rawPayload.source, 'ANTILOPAY_PAYMENT_CHECK');
    assert.equal('code' in envelope.rawPayload, false);
    // The sum is the one invoiced, never the one net of the fee.
    assert.equal(envelope.notifiedAmount.value.toString(), '1000');
    assert.equal(envelope.notifiedAmount.signatureCovered, true);
    assert.equal(h.queued.length, 1);
    assert.equal(h.queued[0]?.name, PAYMENT_RECONCILIATION_JOB);
    assert.equal(h.queued[0]?.data['paymentId'], 'pay-1');
    assert.equal(h.rows[0]?.gatewayData?.['antilopayStatus'], 'SUCCESS');
  });

  it('asks only about open payments old enough, and not twice within the re-check interval', async () => {
    const h = createHarness({ rows: [row()], answer: (id) => checkReply(id, 'PENDING') });

    await h.service.checkOpenPayments(NOW);
    const where = h.findManyArgs[0]?.['where'] as { createdAt: { lt: Date; gte: Date }; status: string; gatewayType: string };
    assert.equal(where.status, TransactionStatus.PENDING);
    assert.equal(where.gatewayType, PaymentGatewayType.ANTILOPAY);
    assert.equal(where.createdAt.lt.getTime(), NOW.getTime() - ANTILOPAY_FIRST_CHECK_AFTER_MS);

    assert.equal(h.posts.length, 1);
    assert.equal(h.recorded.length, 0, 'an open payment changes nothing');
    assert.equal(h.rows[0]?.gatewayData?.['antilopayStatus'], 'PENDING');

    await h.service.checkOpenPayments(new Date(NOW.getTime() + ANTILOPAY_RECHECK_EVERY_MS - 1000));
    assert.equal(h.posts.length, 1, 'asked again too soon');
    await h.service.checkOpenPayments(new Date(NOW.getTime() + ANTILOPAY_RECHECK_EVERY_MS + 1000));
    assert.equal(h.posts.length, 2);
  });

  it('applies FAIL, CANCEL and EXPIRED as the callback would', async () => {
    for (const status of ['FAIL', 'CANCEL', 'EXPIRED']) {
      const h = createHarness({ rows: [row()], answer: (id) => checkReply(id, status) });
      await h.service.checkOpenPayments(NOW);
      assert.equal(h.queued.length, 1, status);
      assert.equal((h.recorded[0] as Record<string, unknown>)['eventStatus'], status);
    }
  });

  it('logs and leaves alone a status it does not know', async () => {
    const h = createHarness({ rows: [row()], answer: (id) => checkReply(id, 'SOMETHING_NEW') });
    await h.service.checkOpenPayments(NOW);
    assert.equal(h.queued.length, 0);
    assert.equal(h.rows[0]?.gatewayData?.['antilopayStatus'], 'SOMETHING_NEW');
  });

  it('does not queue a payment Antilopay never created', async () => {
    const h = createHarness({ rows: [row()], answer: () => ({ data: { code: 8, error: 'Payment not found' } }) });
    await h.service.checkOpenPayments(NOW);
    assert.equal(h.queued.length, 0);
    assert.equal(h.rows[0]?.gatewayData?.['antilopayStatus'], 'NOT_FOUND');
  });

  it('settles a notice once: the same answer again is the same notice', async () => {
    const h = createHarness({ rows: [row()], answer: (id) => checkReply(id, 'SUCCESS') });
    await h.service.checkOpenPayments(NOW);
    // The row is still PENDING (the worker has not run) and its stamp is old.
    await h.service.checkOpenPayments(new Date(NOW.getTime() + 10 * MINUTE));
    assert.equal(h.posts.length, 2);
    assert.equal(h.recorded.length, 1);
    assert.equal(h.queued.length, 1);
  });

  it('stops after three failures in a row, and reads nothing without the gateway', async () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((id) => row({ id: `tx-${id}`, paymentId: `pay-${id}` }));
    const failing = createHarness({ rows, answer: () => new Error('timeout of 10000ms exceeded') });
    assert.equal(await failing.service.checkOpenPayments(NOW), 0);
    assert.equal(failing.posts.length, 3);

    const none = createHarness({ rows, answer: (id) => checkReply(id, 'SUCCESS'), gateway: false });
    assert.equal(await none.service.checkOpenPayments(NOW), 0);
    assert.equal(none.posts.length, 0);
  });

  it('marks the notice FAILED when the queue refuses it, so the auto-retry owns it', async () => {
    const h = createHarness({ rows: [row()], answer: (id) => checkReply(id, 'SUCCESS'), queueFails: true });
    await h.service.checkOpenPayments(NOW);
    assert.equal(h.failed.length, 1);
  });
});

describe('Antilopay: the check before the expiry sweep cancels a payment', () => {
  const ask = (status: string | Error | 'NOT_FOUND', ageMinutes = 31) => {
    const answer = (id: string): Reply =>
      status instanceof Error
        ? status
        : status === 'NOT_FOUND'
          ? { data: { code: 8, error: 'Payment not found' } }
          : checkReply(id, status);
    const h = createHarness({ rows: [row({ ageMinutes })], answer });
    return { h, run: () => h.service.verdictBeforeExpiry(h.rows[0] as never, NOW) };
  };

  it('keeps a paid payment and hands it over instead of cancelling it', async () => {
    const { h, run } = ask('SUCCESS');
    assert.equal(await run(), 'keep');
    assert.equal(h.queued.length, 1);
  });

  it('keeps a reversed payment for the refund path', async () => {
    for (const status of ['REVERSED', 'CHARGEBACK']) {
      const { h, run } = ask(status);
      assert.equal(await run(), 'keep', status);
      assert.equal(h.queued.length, 1, status);
    }
  });

  it('calls a dead one provider-terminal, and an open or unknown one a local timeout', async () => {
    for (const status of ['FAIL', 'CANCEL', 'EXPIRED']) assert.equal(await ask(status).run(), 'provider-terminal', status);
    for (const status of ['PENDING', 'NOT_FOUND', 'SOMETHING_NEW']) assert.equal(await ask(status).run(), 'local-ttl', status);
  });

  it('waits for Antilopay while the row is young and gives up on our own clock after that', async () => {
    assert.equal(await ask(new Error('connect ETIMEDOUT'), 31).run(), 'keep');
    assert.equal(await ask(new Error('connect ETIMEDOUT'), ANTILOPAY_GIVE_UP_AFTER_MS / MINUTE + 1).run(), 'local-ttl');
  });

  it('is asked by the real expiry sweep, and a paid row is not cancelled', async () => {
    for (const [status, cancelled] of [
      ['SUCCESS', false],
      ['PENDING', true],
    ] as const) {
      const h = createHarness({ rows: [row({ ageMinutes: 31 })], answer: (id) => checkReply(id, status) });
      const cancels: unknown[] = [];
      const expiryPrisma = {
        transaction: {
          findMany: async () => [
            {
              id: 'tx-1',
              paymentId: 'pay-1',
              userId: 'user-1',
              purchaseType: 'NEW',
              gatewayType: PaymentGatewayType.ANTILOPAY,
              gatewayId: null,
              gatewayData: null,
              planSnapshot: {},
              amount: { toString: () => '1000' },
              currency: 'RUB',
              createdAt: h.rows[0]?.createdAt,
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
        h.service,
      );
      await expiry.expireStalePending();
      assert.equal(cancels.length > 0, cancelled, status);
    }
  });
});

describe('Antilopay: the daily re-check of completed payments', () => {
  const completed = (id: string, extra: Partial<Row> = {}): Row =>
    row({ id: `tx-${id}`, paymentId: `pay-${id}`, status: TransactionStatus.COMPLETED, ageMinutes: 60 * 24 * 3, ...extra });

  it('hands a REVERSED or CHARGEBACK payment to the refund path, and nothing else', async () => {
    const statuses: Record<string, string> = {
      'pay-a': 'SUCCESS',
      'pay-b': 'REVERSED',
      'pay-c': 'CHARGEBACK',
      'pay-d': 'PENDING',
    };
    const h = createHarness({
      rows: ['a', 'b', 'c', 'd'].map((id) => completed(id)),
      answer: (id) => checkReply(id, statuses[id] ?? 'SUCCESS'),
    });

    const asked = await h.service.recheckCompletedPayments(NOW, { throttleMs: 0 });

    assert.equal(asked, 4);
    assert.deepEqual(
      h.recorded.map((envelope) => [envelope['paymentId'], envelope['eventStatus']]),
      [
        ['pay-b', 'REVERSED'],
        ['pay-c', 'CHARGEBACK'],
      ],
    );
    assert.equal(h.queued.length, 2);
    const where = h.findManyArgs[0]?.['where'] as { createdAt: { gte: Date }; status: string };
    assert.equal(where.status, TransactionStatus.COMPLETED);
    assert.equal(where.createdAt.gte.getTime(), NOW.getTime() - ANTILOPAY_COMPLETED_WINDOW_MS);
  });

  it('does not ask about the charges of an autopay, which Antilopay knows under another id', async () => {
    const h = createHarness({
      rows: [completed('a'), completed('b', { gatewayData: { snapshotSource: 'PROVIDER_SUBSCRIPTION_CHARGE' } })],
      answer: (id) => checkReply(id, 'SUCCESS'),
    });
    assert.equal(await h.service.recheckCompletedPayments(NOW, { throttleMs: 0 }), 1);
    assert.deepEqual(h.posts.map((post) => JSON.parse(post.body).order_id), ['pay-a']);
  });

  it('treats a payment Antilopay has no record of as nothing to do', async () => {
    const h = createHarness({ rows: [completed('a')], answer: () => ({ data: { code: 8, error: 'Payment not found' } }) });
    assert.equal(await h.service.recheckCompletedPayments(NOW, { throttleMs: 0 }), 1);
    assert.equal(h.queued.length, 0);
  });

  it('reads the rows a page at a time and stops when Antilopay stops answering', async () => {
    const many = Array.from({ length: 5 }, (_, index) => completed(String(index)));
    const h = createHarness({ rows: many, answer: () => new Error('connect ECONNRESET') });
    assert.equal(await h.service.recheckCompletedPayments(NOW, { throttleMs: 0 }), 0);
    assert.equal(h.posts.length, 3);
  });
});

describe('Antilopay statuses in the existing reconciliation', () => {
  it('reverses a completed payment on REVERSED and CHARGEBACK, and cancels an open one on a dead status', () => {
    assert.equal(isRefundProviderStatus('REVERSED'), true);
    assert.equal(isRefundProviderStatus('CHARGEBACK'), true);
    assert.equal(isRefundProviderStatus('SUCCESS'), false);
    assert.equal(mapProviderStatusToTransactionStatus('SUCCESS'), TransactionStatus.COMPLETED);
    for (const dead of ['FAIL', 'CANCEL', 'EXPIRED']) {
      assert.equal(mapProviderStatusToTransactionStatus(dead), TransactionStatus.CANCELED, dead);
    }
    assert.equal(mapProviderStatusToTransactionStatus('PENDING'), TransactionStatus.PENDING);
  });
});
