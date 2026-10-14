import 'reflect-metadata';

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  Currency,
  PaymentGatewayType,
  PaymentWebhookLifecycleStatus,
  Prisma,
  ProviderSubscription,
  ProviderSubscriptionStatus,
  PurchaseChannel,
  PurchaseType,
  TransactionStatus,
} from '@prisma/client';
import { of } from 'rxjs';

import { PROVIDER_SUBSCRIPTION_SYNC_JOB } from '../src/modules/payments/constants/payment-reconciliation.constant';
import { AntilopayStatusService } from '../src/modules/payments/services/antilopay-status.service';
import { PaymentPendingExpiryService } from '../src/modules/payments/services/payment-pending-expiry.service';
import { PaymentReconciliationService } from '../src/modules/payments/services/payment-reconciliation.service';
import {
  CHARGE_GRACE_MS,
  chargeCoverDays,
  delayEndsAtOf,
  keyedChargeKey,
  ProviderSubscriptionService,
} from '../src/modules/payments/services/provider-subscription.service';
import { DELAY_GRANT_KEY, delayGrantMetadata, isDelayGrant, readDelayGrant } from '../src/modules/payments/utils/antilopay-delay-grant.util';
import { PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY } from '../src/modules/payments/utils/provider-subscription-terms.util';
import { executeGatewayDataWrites } from './helpers/gateway-data-write-double';

const DAY = 24 * 60 * 60 * 1000;
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
  autopayCardApproved: true,
  autopaySbpApproved: true,
};

type Tx = Record<string, unknown> & { id: string; paymentId: string };
type Item = Record<string, unknown> & { id: string; transactionId: string };

interface WorldOptions {
  readonly row?: Partial<ProviderSubscription>;
  readonly first?: Partial<Tx>;
  readonly items?: readonly Partial<Item>[];
  readonly purchaseType?: PurchaseType;
  readonly subscriptionExpiresAt?: Date | null;
}

/**
 * One delayed Antilopay SBP sign-up over one in-memory store: the real
 * provider-subscription service, the real reconciliation worker and the real
 * expiry sweep, the way the panel runs them. Payments, lines, the row and the
 * inbox live here; a database transaction that throws is rolled back.
 */
function world(options: WorldOptions = {}) {
  const terms = {
    unit: 'month',
    count: 1,
    amount: 299,
    durationDays: 30,
    planId: 'plan-1',
    subscriptionId: options.row?.subscriptionId ?? null,
    method: 'SBP',
    delay: { count: 7, unit: 'DAY', days: 7 },
  };
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
    providerRecurrentId: 'rec-1',
    endsAt: null,
    plannedChargeCount: null,
    method: 'SBP',
    delayDays: 7,
    delayGrantedAt: null,
    consentVersion: 'provider-subscription-v1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...options.row,
  };
  const transactions: Tx[] = [
    {
      id: 'tx-first',
      paymentId: 'ours-1',
      userId: 'user-1',
      gatewayType: PaymentGatewayType.ANTILOPAY,
      gatewayId: 'APAY-first',
      purchaseType: options.purchaseType ?? PurchaseType.NEW,
      channel: PurchaseChannel.WEB,
      currency: Currency.RUB,
      amount: new Prisma.Decimal('299'),
      paymentAsset: null,
      planSnapshot: {
        id: 'plan-1',
        name: 'Base',
        selectedDurationDays: 30,
        [PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY]: terms,
      },
      gatewayData: { provider: 'ANTILOPAY' },
      status: TransactionStatus.PENDING,
      fulfilledAt: null,
      subscriptionId: null,
      idempotencyKey: null,
      deviceTypes: [],
      createdAt: new Date(Date.now() - 5 * 60 * 1000),
      updatedAt: new Date(Date.now() - 5 * 60 * 1000),
      ...options.first,
    },
  ];
  const items: Item[] = (options.items ?? []).map((item, index) => ({
    id: `item-${index + 1}`,
    transactionId: 'tx-first',
    subscriptionId: 'sub-1',
    planId: 'plan-1',
    durationDays: 30,
    amount: new Prisma.Decimal('299'),
    currency: Currency.RUB,
    appliedAt: null,
    planSnapshot: { id: 'plan-1', snapshotSource: 'RENEWAL_DRAFT', selectedDurationDays: 30, amount: '299.00' },
    ...item,
  }));
  const events: Array<{ providerEventId: string; paymentId: string; payloadHash: string; eventStatus: string | null; rawPayload: unknown }> = [];
  const received: string[] = [];
  const jobs: Array<{ name: string; data: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const writes = { transactionUpdates: 0, itemUpdates: 0, rowTouches: 0 };
  const cards: Array<{ type: string; message: string; metadata: Record<string, unknown> }> = [];
  const hooks = { partner: 0, referral: 0, cashback: 0, moyNalog: 0, adConversion: 0 };
  const fulfilled: Array<{ amount: string; selectedDurationDays: unknown; items: Array<{ durationDays: unknown; amount: string; snapshot: unknown }>; gatewayData: unknown }> = [];
  const webhookEvents = new Map<string, Record<string, unknown>>();
  const inboxLog = { processed: [] as string[], failed: [] as string[] };
  let answers: (path: string, body: Record<string, unknown>) => Record<string, unknown> = () => ({ code: 0 });

  const byId = (id: unknown): Tx | undefined => transactions.find((candidate) => candidate.id === id);
  const matchRow = (where: Record<string, unknown>): boolean => {
    if (where['id'] !== undefined && where['id'] !== row.id) return false;
    if ('delayGrantedAt' in where && where['delayGrantedAt'] === null && row.delayGrantedAt !== null) return false;
    if ('providerRecurrentId' in where && where['providerRecurrentId'] === null && row.providerRecurrentId !== null) return false;
    if ('subscriptionId' in where && where['subscriptionId'] === null && row.subscriptionId !== null) return false;
    if (typeof where['appliedChargeCount'] === 'number' && row.appliedChargeCount !== where['appliedChargeCount']) return false;
    const lt = (where['appliedChargeCount'] as { lt?: number } | undefined)?.lt;
    if (lt !== undefined && !(row.appliedChargeCount < lt)) return false;
    if ('OR' in where && row.cancelledBy === 'REFUND') return false;
    return true;
  };

  const prisma: Record<string, unknown> = {
    paymentGateway: { findUnique: async () => ({ type: PaymentGatewayType.ANTILOPAY, settings: GATEWAY_SETTINGS }) },
    paymentWebhookEvent: {
      findUnique: async ({ where }: { where: { id: string } }) => webhookEvents.get(where.id) ?? null,
    },
    transaction: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) => {
        if (typeof where['id'] === 'string') return byId(where['id']) ?? null;
        if (typeof where['paymentId'] === 'string') return transactions.find((t) => t.paymentId === where['paymentId']) ?? null;
        const key = where['userId_idempotencyKey'] as { userId: string; idempotencyKey: string } | undefined;
        return key === undefined
          ? null
          : (transactions.find((t) => t.userId === key.userId && t.idempotencyKey === key.idempotencyKey) ?? null);
      },
      findFirst: async () => null,
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const tx = byId(where['id']);
        if (tx === undefined) return { count: 0 };
        if ('fulfilledAt' in where) {
          const fence = where['fulfilledAt'] as Date | null;
          const stamp = tx['fulfilledAt'] as Date | null;
          const holds = fence === null ? stamp === null : stamp?.getTime() === fence.getTime();
          if (!holds) return { count: 0 };
        }
        if (where['status'] !== undefined && tx['status'] !== where['status']) return { count: 0 };
        Object.assign(tx, data);
        return { count: 1 };
      },
      update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        writes.transactionUpdates += 1;
        const tx = byId(where['id']);
        assert.ok(tx, `no transaction ${String(where['id'])}`);
        Object.assign(tx, data);
        return { ...tx };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const created = {
          id: `tx-${transactions.length + 1}`,
          paymentId: `payment-${transactions.length + 1}`,
          fulfilledAt: null,
          gatewayId: null,
          ...data,
        } as unknown as Tx;
        transactions.push(created);
        return created;
      },
    },
    transactionItem: {
      findMany: async ({ where }: { where: { transactionId: string } }) => items.filter((item) => item.transactionId === where.transactionId),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        writes.itemUpdates += 1;
        const item = items.find((candidate) => candidate.id === where.id);
        assert.ok(item);
        Object.assign(item, data);
        return item;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => data,
    },
    subscription: {
      findUnique: async () => ({ expiresAt: options.subscriptionExpiresAt ?? null }),
    },
    plan: { findMany: async () => [{ id: 'plan-1', name: 'Base' }] },
    trialClaim: { updateMany: async () => ({ count: 0 }) },
    providerSubscription: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) => {
        if (typeof where['id'] === 'string') return where['id'] === row.id ? row : null;
        if (typeof where['firstTransactionId'] === 'string') return where['firstTransactionId'] === row.firstTransactionId ? row : null;
        const recurrent = where['gatewayType_providerRecurrentId'] as { providerRecurrentId: string } | undefined;
        if (recurrent !== undefined) return recurrent.providerRecurrentId === row.providerRecurrentId ? row : null;
        const sub = where['gatewayType_providerSubscriptionId'] as { providerSubscriptionId: string } | undefined;
        return sub !== undefined && sub.providerSubscriptionId === row.providerSubscriptionId ? row : null;
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const ids = (where['id'] as { in: string[] } | undefined)?.in;
        if (ids !== undefined) return ids.includes(row.id) ? [row] : [];
        if (where['userId'] !== undefined) return where['userId'] === row.userId ? [row] : [];
        return [];
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        writes.rowTouches += 1;
        const idWhere = where['id'] as { in?: string[] } | string | undefined;
        if (typeof idWhere === 'object' && idWhere.in !== undefined && !idWhere.in.includes(row.id)) return { count: 0 };
        if (!matchRow(typeof idWhere === 'object' ? { ...where, id: undefined } : where)) return { count: 0 };
        if (typeof where['firstTransactionId'] === 'string' && where['firstTransactionId'] !== row.firstTransactionId) return { count: 0 };
        row = { ...row, ...data } as ProviderSubscription;
        return { count: 1 };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        writes.rowTouches += 1;
        row = { ...row, ...data } as ProviderSubscription;
        return row;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        row = { ...row, ...data } as ProviderSubscription;
        return row;
      },
    },
    $executeRaw: executeGatewayDataWrites({
      currentGatewayData: (id) => byId(id)?.['gatewayData'],
      update: async ({ where, data }) => Object.assign(byId(where.id)!, data),
      updateMany: async ({ where, data }) => {
        const tx = byId(where.id);
        if (tx === undefined || (where.status !== undefined && tx['status'] !== where.status)) return { count: 0 };
        Object.assign(tx, data);
        return { count: 1 };
      },
    }),
  };
  // A database transaction: what it wrote is undone when it throws.
  prisma['$transaction'] = async (callback: (db: unknown) => Promise<unknown>) => {
    const saved = {
      row,
      transactions: transactions.map((t) => ({ ...t })),
      items: items.map((i) => ({ ...i })),
    };
    try {
      return await callback(prisma);
    } catch (error) {
      row = saved.row;
      transactions.forEach((t, index) => {
        for (const key of Object.keys(t)) delete t[key];
        Object.assign(t, saved.transactions[index]);
      });
      items.forEach((i, index) => {
        for (const key of Object.keys(i)) delete i[key];
        Object.assign(i, saved.items[index]);
      });
      throw error;
    }
  };

  const inbox = {
    recordReceived: async ({
      envelope,
    }: {
      envelope: { providerEventId: string; paymentId: string; payloadHash: string; eventStatus: string | null; rawPayload: unknown };
    }) => {
      received.push(envelope.providerEventId);
      const existing = events.find((event) => event.providerEventId === envelope.providerEventId);
      if (existing !== undefined && existing.payloadHash === envelope.payloadHash) {
        return { event: { id: existing.providerEventId, paymentId: existing.paymentId }, duplicate: true };
      }
      events.push(envelope);
      webhookEvents.set(envelope.providerEventId, {
        id: envelope.providerEventId,
        gatewayType: PaymentGatewayType.ANTILOPAY,
        paymentId: envelope.paymentId,
        providerEventId: envelope.providerEventId,
        eventStatus: envelope.eventStatus,
        rawPayload: envelope.rawPayload,
        status: PaymentWebhookLifecycleStatus.ENQUEUED,
        receivedAt: new Date(),
        replayCount: 0,
        reconciliationAttempts: 0,
      });
      return {
        event: { id: envelope.providerEventId, paymentId: envelope.paymentId, gatewayType: PaymentGatewayType.ANTILOPAY },
        duplicate: false,
      };
    },
    markEnqueued: async () => undefined,
    markFailed: async () => undefined,
  };
  const queue = {
    add: async (name: string, data: Record<string, unknown>, jobOptions: Record<string, unknown>) => {
      jobs.push({ name, data, options: jobOptions });
    },
  };
  const http = {
    post: (url: string, body: string) => {
      const path = url.replace('https://lk.antilopay.com/api/v1/', '');
      const parsed = JSON.parse(body) as Record<string, unknown>;
      posts.push({ path, body: parsed });
      return of({ data: answers(path, parsed) });
    },
  };
  const systemEvents = {
    warn: (type: string, _category: string, message: string, metadata: Record<string, unknown> = {}) => {
      cards.push({ type, message, metadata });
    },
    info: () => undefined,
  };
  const service = new ProviderSubscriptionService(prisma as never, http as never, inbox as never, queue as never, systemEvents as never);

  // The real reconciliation worker; the post-payment hooks are spies, and the
  // fulfilment records what it was handed and delivers it.
  const mutation = {
    applyCompletedTransaction: async (transaction: Tx) => {
      const lines = items.filter((item) => item.transactionId === transaction.id);
      fulfilled.push({
        amount: (transaction['amount'] as Prisma.Decimal).toString(),
        selectedDurationDays: (transaction['planSnapshot'] as Record<string, unknown>)['selectedDurationDays'],
        items: lines.map((line) => ({
          durationDays: line['durationDays'],
          amount: (line['amount'] as Prisma.Decimal).toString(),
          snapshot: line['planSnapshot'],
        })),
        gatewayData: transaction['gatewayData'],
      });
      const live = byId(transaction.id)!;
      live['subscriptionId'] = lines.length > 0 ? null : 'sub-new';
      live['status'] = TransactionStatus.COMPLETED;
      if (lines.length === 0 && row.firstTransactionId === live.id && row.subscriptionId === null) {
        row = { ...row, subscriptionId: 'sub-new' };
      }
      return { syncJobs: [] };
    },
  };
  const reconciliation = new PaymentReconciliationService(
    prisma as never,
    {
      incrementReconciliationAttempts: async () => undefined,
      markProcessing: async () => undefined,
      markProcessed: async (id: string) => {
        inboxLog.processed.push(id);
      },
      markFailed: async (id: string) => {
        inboxLog.failed.push(id);
        return { id };
      },
    } as never,
    mutation as never,
    { notifyWebhookFailed: async () => undefined } as never,
    {
      processPartnerEarning: async () => {
        hooks.partner += 1;
      },
    } as never,
    {
      qualifyReferralAfterPurchase: async () => {
        hooks.referral += 1;
        return null;
      },
    } as never,
    { enqueue: async () => undefined } as never,
    { info: () => undefined, warn: () => undefined, error: () => undefined, emit: () => undefined } as never,
    {
      enqueueRegisterIncome: async () => {
        hooks.moyNalog += 1;
      },
    } as never,
    {
      recordFirstPurchase: async () => {
        hooks.adConversion += 1;
      },
    } as never,
    { upsertFromYookassaPayment: async () => undefined } as never,
    { verifyCompletion: async () => ({ outcome: 'CONFIRMED' }) } as never,
    {
      creditForTransactionBestEffort: async () => {
        hooks.cashback += 1;
        return null;
      },
    } as never,
    { create: async () => 'notification-1' } as never,
    service,
  );
  const reconcile = async (providerEventId: string) => {
    await reconciliation.reconcileWebhookEvent(providerEventId);
  };

  return {
    service,
    reconciliation,
    prisma,
    reconcile,
    row: () => row,
    tx: (id = 'tx-first') => byId(id)!,
    transactions,
    items,
    events,
    received,
    jobs,
    posts,
    writes,
    cards,
    hooks,
    fulfilled,
    inboxLog,
    webhookEvents,
    answer: (fn: (path: string, body: Record<string, unknown>) => Record<string, unknown>) => {
      answers = fn;
    },
    /** What Antilopay says of the recurrent; `payments` are the ones money moved for. */
    recurrent: (overrides: Record<string, unknown> = {}, payments: Array<Record<string, unknown>> = []) => {
      answers = (path) =>
        path === 'payment/recurrent/check'
          ? {
              code: 0,
              recurrent_id: 'rec-1',
              type: 'MONTH',
              count: 12,
              status: 'ACTIVE',
              start_date: '2026-10-14',
              next_payment_date: null,
              end_date: '2027-09-21',
              payments,
              ...overrides,
            }
          : { code: 0 };
    },
    look: () => service.sync(PaymentGatewayType.ANTILOPAY, 'APAY-first'),
    /** The checkout is fulfilled the way the reconciliation does it. */
    deliverFirst: (subscriptionId = 'sub-new') => {
      const live = byId('tx-first')!;
      live['status'] = TransactionStatus.COMPLETED;
      live['fulfilledAt'] = new Date();
      live['subscriptionId'] = subscriptionId;
      row = { ...row, subscriptionId };
    },
  };
}

const charge = (id: string, ctime: string, orderId: string | null = null, amount: number | null = 299) => ({
  payment_id: id,
  ctime,
  status: 'SUCCESS',
  ...(orderId === null ? {} : { order_id: orderId }),
  ...(amount === null ? {} : { original_amount: amount }),
});

describe('the plan granted while the first SBP charge waits', () => {
  it('is given the moment the subscription is active: the checkout becomes a free grant of the delay, once', async () => {
    const w = world();
    w.recurrent({ status: 'ACTIVE', next_payment_date: null });
    await w.look();

    const tx = w.tx();
    assert.equal((tx['amount'] as Prisma.Decimal).toString(), '0');
    assert.equal((tx['planSnapshot'] as Record<string, unknown>)['selectedDurationDays'], 7);
    // The terms the autopay was signed up on are still there: they name the subscription the grant creates.
    assert.ok(((tx['planSnapshot'] as Record<string, unknown>)[PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY] as Record<string, unknown>)['delay']);
    const mark = readDelayGrant(tx['gatewayData']);
    assert.ok(mark);
    assert.equal(mark.delayDays, 7);
    assert.equal(mark.days, 7, 'no first charge date named: exactly the delay');
    assert.equal(mark.originalAmount, '299');
    assert.equal(mark.providerSubscriptionId, 'APAY-first');
    assert.equal((tx['gatewayData'] as Record<string, unknown>)['provider'], 'ANTILOPAY', 'what was there is kept');

    assert.ok(w.row().delayGrantedAt instanceof Date);
    assert.equal(w.row().status, ProviderSubscriptionStatus.ACTIVE);
    assert.deepEqual(w.events.map((event) => [event.providerEventId, event.eventStatus, event.paymentId]), [
      ['subscription:APAY-first:delay-grant', 'CONFIRMED', 'ours-1'],
    ]);
    assert.equal(w.jobs.filter((job) => job.name !== PROVIDER_SUBSCRIPTION_SYNC_JOB).length, 1, 'its settlement is queued');
  });

  it('is given once however often the subscription is seen active: a callback every three minutes, the sweep, the payer\'s return', async () => {
    const w = world();
    w.recurrent();
    await w.look();
    const claimedAt = w.row().delayGrantedAt;
    const updates = w.writes.transactionUpdates;
    for (let look = 0; look < 6; look += 1) await w.look();
    await Promise.all([w.look(), w.look(), w.look()]);
    assert.equal(w.row().delayGrantedAt?.getTime(), claimedAt?.getTime(), 'the claim is taken once');
    assert.equal(w.writes.transactionUpdates, updates, 'the checkout is rewritten once');
    assert.equal(w.events.length, 1, 'and its settlement is in the inbox once');
    assert.ok(w.received.length >= 2, 'it is offered again while it waits for the worker, and recognised');
  });

  it('is given once when two workers look at the same moment', async () => {
    const w = world();
    w.recurrent();
    await Promise.all([w.look(), w.look()]);
    assert.equal(w.writes.transactionUpdates, 1);
    assert.equal(w.events.length, 1);
    assert.equal(readDelayGrant(w.tx()['gatewayData'])?.days, 7);
  });

  it('is not asked for again once it is fulfilled', async () => {
    const w = world();
    w.recurrent();
    await w.look();
    await w.reconcile('subscription:APAY-first:delay-grant');
    assert.equal(w.tx()['status'], TransactionStatus.COMPLETED);
    assert.ok(w.tx()['fulfilledAt'] instanceof Date);
    const offered = w.received.length;
    await w.look();
    await w.look();
    assert.equal(w.received.length, offered, 'a fulfilled grant is not settled again');
  });

  it('is fulfilled by the ordinary pipeline as a free term of the delay\'s days, with no money hook run', async () => {
    const w = world();
    w.recurrent();
    await w.look();
    await w.reconcile('subscription:APAY-first:delay-grant');
    assert.equal(w.fulfilled.length, 1);
    assert.equal(w.fulfilled[0]?.amount, '0');
    assert.equal(w.fulfilled[0]?.selectedDurationDays, 7);
    assert.ok(isDelayGrant(w.fulfilled[0]?.gatewayData), 'the fulfilment sees the mark');
    assert.deepEqual(w.hooks, { partner: 0, referral: 0, cashback: 0, moyNalog: 0, adConversion: 0 });
    assert.equal(w.row().subscriptionId, 'sub-new', 'the grant created the subscription the later charges renew');
    assert.deepEqual(w.inboxLog.failed, []);
  });

  it('is the only checkout that skips the hooks: a paid one still runs them', async () => {
    const w = world({ row: { delayDays: null } });
    w.tx()['planSnapshot'] = { id: 'plan-1', name: 'Base', selectedDurationDays: 30 };
    w.webhookEvents.set('paid-1', {
      id: 'paid-1',
      gatewayType: PaymentGatewayType.ANTILOPAY,
      paymentId: 'ours-1',
      providerEventId: 'paid-1',
      eventStatus: 'SUCCESS',
      rawPayload: { status: 'SUCCESS' },
      status: PaymentWebhookLifecycleStatus.ENQUEUED,
      receivedAt: new Date(),
      replayCount: 0,
      reconciliationAttempts: 0,
    });
    await w.reconcile('paid-1');
    assert.equal(w.fulfilled[0]?.amount, '299');
    assert.equal(w.fulfilled[0]?.selectedDurationDays, 30);
    assert.ok(w.hooks.partner + w.hooks.referral + w.hooks.cashback + w.hooks.moyNalog + w.hooks.adConversion > 0);
  });

  it('is told apart on the operator\'s card: a flag, the days and a note that no money was taken', async () => {
    const w = world();
    w.recurrent();
    await w.look();
    const metadata = delayGrantMetadata(w.tx()['gatewayData']);
    assert.equal(metadata['delayGrant'], true);
    assert.equal(metadata['delayGrantDays'], 7);
    assert.match(String(metadata['note']), /денег не списано/);
    assert.match(String(metadata['note']), /299 ₽/);
    assert.deepEqual(delayGrantMetadata({ provider: 'ANTILOPAY' }), {});
    assert.deepEqual(delayGrantMetadata(null), {});
  });
});

describe('when the plan is not granted', () => {
  it('waits for the payer: a subscription that is not active yet gives nothing', async () => {
    for (const status of ['CREATED', 'WAIT_CONFIRM']) {
      const w = world();
      w.recurrent({ status });
      await w.look();
      assert.equal(w.row().delayGrantedAt, null, status);
      assert.equal((w.tx()['amount'] as Prisma.Decimal).toString(), '299', status);
      assert.equal(w.events.length, 0, status);
      assert.equal(readDelayGrant(w.tx()['gatewayData']), null, status);
    }
  });

  it('gives nothing for a subscription that ended without ever being seen active, and nothing for one nobody can be given to', async () => {
    for (const status of ['CANCEL', 'PROVIDER_CANCEL', 'ERROR', 'COMPLETE']) {
      const w = world();
      w.recurrent({ status });
      await w.look();
      assert.equal(w.row().delayGrantedAt, null, status);
      assert.equal(w.events.length, 0, status);
    }
    const deleted = world({ row: { userId: null } });
    deleted.recurrent();
    await deleted.look();
    assert.equal(deleted.row().delayGrantedAt, null, 'the account is deleted');
    const refunded = world({ row: { cancelledBy: 'REFUND' } });
    refunded.recurrent();
    await refunded.look();
    assert.equal(refunded.row().delayGrantedAt, null, 'a refund asked for it to end');
  });

  it('gives the plan to a subscription whose first charge already failed: it was active, and money is owed', async () => {
    const w = world();
    w.recurrent({ status: 'ACTIVE_FAILED' });
    await w.look();
    assert.ok(w.row().delayGrantedAt instanceof Date);
    assert.equal(w.row().status, ProviderSubscriptionStatus.PAST_DUE);
  });

  it('gives nothing to a subscription that has no delay, and rewrites nothing of it', async () => {
    const w = world({ row: { delayDays: null } });
    w.recurrent();
    await w.look();
    assert.equal(w.row().delayGrantedAt, null);
    assert.equal(w.writes.transactionUpdates, 0);
    assert.equal(w.events.filter((event) => event.providerEventId.endsWith('delay-grant')).length, 0);
  });

  it('keeps what the customer got when they cancel during the delay: nothing is taken back, and nothing is asked for', async () => {
    const w = world();
    w.recurrent();
    await w.look();
    await w.reconcile('subscription:APAY-first:delay-grant');
    // The payer cancels at Antilopay before the first charge.
    w.recurrent({ status: 'CANCEL' });
    await w.look();
    assert.equal(w.row().status, ProviderSubscriptionStatus.CANCELLED);
    assert.equal(w.tx()['status'], TransactionStatus.COMPLETED);
    assert.equal((w.tx()['amount'] as Prisma.Decimal).toString(), '0');
    assert.equal(w.events.length, 1, 'no refund notice, no further settlement');
  });
});

describe('the checkout\'s own fate does not end or confuse the subscription', () => {
  it('is still granted when the checkout expired, and the grant revives it', async () => {
    for (const lapsed of [TransactionStatus.CANCELED, TransactionStatus.FAILED]) {
      const w = world({ first: { status: lapsed } });
      w.recurrent();
      await w.look();
      assert.ok(w.row().delayGrantedAt instanceof Date, lapsed);
      assert.equal(w.tx()['status'], lapsed, 'the rewrite does not decide its status');
      await w.reconcile('subscription:APAY-first:delay-grant');
      assert.equal(w.tx()['status'], TransactionStatus.COMPLETED, `${lapsed} is revived by the grant's settlement`);
      assert.ok(w.tx()['fulfilledAt'] instanceof Date);
      assert.equal(w.fulfilled.length, 1);
      assert.equal(w.fulfilled[0]?.amount, '0');
    }
  });

  it('is not touched by the expiry sweep: the sweep cancels the checkout and never reads or writes the sign-up', async () => {
    const w = world({ first: { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) } });
    // Every call the sweep makes to the sign-up's table, inside a transaction or out of it.
    const touched: string[] = [];
    const table = w.prisma['providerSubscription'] as Record<string, (...args: unknown[]) => unknown>;
    for (const name of Object.keys(table)) {
      const original = table[name] as (...args: unknown[]) => unknown;
      table[name] = (...args: unknown[]) => {
        touched.push(name);
        return original(...args);
      };
    }
    const prismaWithWatch = { ...w.prisma };
    prismaWithWatch['transaction'] = {
      ...(w.prisma['transaction'] as Record<string, unknown>),
      findMany: async () => w.transactions.filter((t) => t['status'] === TransactionStatus.PENDING),
    };
    const expiry = new PaymentPendingExpiryService(
      prismaWithWatch as never,
      { info: () => undefined, warn: () => undefined } as never,
      { get: () => of({ status: 200, data: {} }) } as never,
      {} as never,
      { enqueue: async () => undefined } as never,
      w.reconciliation,
      // Antilopay says our order is still open: the sweep cancels it on its own clock.
      { verdictBeforeExpiry: async () => 'local-ttl' } as never,
    );
    await expiry.expireStalePending();
    assert.equal(w.tx()['status'], TransactionStatus.CANCELED, 'the checkout lapsed');
    assert.deepEqual(touched, [], 'and the sign-up was not read or written');
    assert.equal(w.row().status, ProviderSubscriptionStatus.PENDING);

    // The payer subscribes after the checkout lapsed: the look grants, and the settlement revives it.
    w.recurrent();
    await w.look();
    assert.ok(touched.length > 0, 'the spy sees the sign-up when something does read it');
    await w.reconcile('subscription:APAY-first:delay-grant');
    assert.equal(w.tx()['status'], TransactionStatus.COMPLETED);
    assert.equal(w.fulfilled[0]?.amount, '0');
    assert.equal(w.row().status, ProviderSubscriptionStatus.ACTIVE);
  });

  it('is granted by Antilopay calling the payment of OUR order paid, too, before anything is fulfilled', async () => {
    const w = world();
    w.webhookEvents.set('apay-paid', {
      id: 'apay-paid',
      gatewayType: PaymentGatewayType.ANTILOPAY,
      paymentId: 'ours-1',
      providerEventId: 'apay-paid',
      eventStatus: 'SUCCESS',
      rawPayload: { status: 'SUCCESS', order_id: 'ours-1' },
      status: PaymentWebhookLifecycleStatus.ENQUEUED,
      receivedAt: new Date(),
      replayCount: 0,
      reconciliationAttempts: 0,
    });
    await w.reconcile('apay-paid');
    assert.equal(w.fulfilled.length, 1);
    assert.equal(w.fulfilled[0]?.amount, '0', 'a payment that moved no money is not a paid term');
    assert.equal(w.fulfilled[0]?.selectedDurationDays, 7);
    assert.ok(isDelayGrant(w.fulfilled[0]?.gatewayData));
    assert.deepEqual(w.hooks, { partner: 0, referral: 0, cashback: 0, moyNalog: 0, adConversion: 0 });
    assert.ok(w.row().delayGrantedAt instanceof Date);

    // The look that follows finds the claim taken and the checkout fulfilled.
    w.recurrent();
    const touched = w.writes.transactionUpdates;
    await w.look();
    assert.equal(w.writes.transactionUpdates, touched);
    assert.equal(w.events.length, 0, 'nothing is settled twice');
    assert.equal(w.fulfilled.length, 1);
  });

  it('holds the fulfilment back, and fails the notice for a retry, when the sign-up cannot be found', async () => {
    const w = world({ first: { gatewayId: '__CHECKOUT_PROVIDER_CREATE__:ours-1' } });
    // A row the panel does not hold: the prepare step cannot make one from a placeholder.
    (w.prisma['providerSubscription'] as Record<string, unknown>)['findUnique'] = async () => null;
    w.webhookEvents.set('apay-paid', {
      id: 'apay-paid',
      gatewayType: PaymentGatewayType.ANTILOPAY,
      paymentId: 'ours-1',
      providerEventId: 'apay-paid',
      eventStatus: 'SUCCESS',
      rawPayload: { status: 'SUCCESS' },
      status: PaymentWebhookLifecycleStatus.ENQUEUED,
      receivedAt: new Date(),
      replayCount: 0,
      reconciliationAttempts: 0,
    });
    await assert.rejects(w.reconcile('apay-paid'), /no sign-up to grant/);
    assert.equal(w.fulfilled.length, 0, 'a full term is never delivered for it');
    assert.deepEqual(w.inboxLog.failed, ['apay-paid']);
  });

  it('does not rewrite a checkout that was already fulfilled in full, and takes back the claim it made', async () => {
    const w = world();
    // The ordinary pipeline fulfilled it before the grant could.
    const tx = w.tx();
    tx['status'] = TransactionStatus.COMPLETED;
    tx['fulfilledAt'] = new Date();
    w.recurrent();
    await w.look();
    assert.equal((w.tx()['amount'] as Prisma.Decimal).toString(), '299');
    assert.equal(readDelayGrant(w.tx()['gatewayData']), null);
    assert.equal(w.events.length, 0);
    // Marked as used afterwards, so nothing tries again and the customer is counted.
    assert.ok(w.row().delayGrantedAt instanceof Date);
  });
});

describe('the charges after the delay', () => {
  it('renews the granted plan, as the first renewal and not as the checkout, whenever it comes', async () => {
    for (const days of [1, 3, 7, 30]) {
      const w = world();
      w.recurrent({ next_payment_date: null }, []);
      await w.look();
      await w.reconcile('subscription:APAY-first:delay-grant');
      const when = new Date(Date.now() + days * DAY).toISOString().replace('T', ' ').slice(0, 19);
      w.recurrent({ next_payment_date: '2026-11-21' }, [charge('APAY-sched', when, 'made-up-by-antilopay')]);
      await w.look();
      const renewal = w.transactions.find((t) => t['idempotencyKey'] === keyedChargeKey('ps-1', 'APAY-sched'));
      assert.ok(renewal, `a charge ${days} days after the start has its own RENEW payment`);
      assert.equal(renewal['purchaseType'], PurchaseType.RENEW);
      assert.equal((renewal['amount'] as Prisma.Decimal).toString(), '299', 'the real sum');
      assert.equal(w.tx()['idempotencyKey'], null, 'the grant stays the checkout');
      assert.equal((w.tx()['amount'] as Prisma.Decimal).toString(), '0');
      assert.equal(w.row().appliedChargeCount, 1);
      assert.deepEqual(
        w.events.map((event) => event.providerEventId),
        ['subscription:APAY-first:delay-grant', 'subscription:APAY-first:payment:APAY-sched'],
      );
    }
  });

  it('does not take the start of the subscription for a charge', async () => {
    const w = world();
    w.recurrent({}, [charge('APAY-first', '2026-10-14 09:00:00', 'ours-1')]);
    await w.look();
    await w.reconcile('subscription:APAY-first:delay-grant');
    await w.look();
    assert.equal(w.row().appliedChargeCount, 0, 'no charge was made yet');
    assert.deepEqual(w.events.map((event) => event.providerEventId), ['subscription:APAY-first:delay-grant']);
    assert.equal(w.transactions.length, 1);
  });

  it('waits for the grant to be delivered before it renews anything, and books its own look', async () => {
    const w = world();
    w.recurrent({}, [charge('APAY-sched', '2026-10-21 09:00:00', 'made-up-by-antilopay')]);
    await w.look();
    assert.equal(w.transactions.some((t) => t['idempotencyKey'] !== null), false);
    const later = w.jobs.find((job) => job.name === PROVIDER_SUBSCRIPTION_SYNC_JOB);
    assert.equal(later?.options['delay'], 60_000);
    // Money taken means the sign-up was active: the grant is given first.
    assert.ok(w.row().delayGrantedAt instanceof Date);
  });
});

describe('the days that are granted', () => {
  it('are the delay, or the delay stretched to reach the first charge and a day\'s grace, by at most three', () => {
    const now = new Date('2026-10-14T15:00:00Z');
    assert.equal(chargeCoverDays({ durationDays: 7, expiresAt: null, nextChargeAt: null, now }), 7);
    // The first charge is on the 21st at midnight UTC: 7 days from 15:00 on the 14th ends before it plus a day.
    assert.equal(chargeCoverDays({ durationDays: 7, expiresAt: null, nextChargeAt: new Date('2026-10-21T00:00:00Z'), now }), 8);
    assert.equal(chargeCoverDays({ durationDays: 7, expiresAt: null, nextChargeAt: new Date('2026-10-30T00:00:00Z'), now }), 10);
    assert.equal(CHARGE_GRACE_MS, DAY);
  });

  it('are written into the checkout the same on the term and the mark', async () => {
    const w = world();
    const next = new Date(Date.now() + 9 * DAY).toISOString().slice(0, 10);
    w.recurrent({ next_payment_date: next });
    await w.look();
    const mark = readDelayGrant(w.tx()['gatewayData']);
    assert.ok(mark);
    assert.ok(mark.days >= 7 && mark.days <= 10, String(mark.days));
    assert.equal((w.tx()['planSnapshot'] as Record<string, unknown>)['selectedDurationDays'], mark.days);
  });

  it('start from the end of what a renewing customer still holds', async () => {
    const expiresAt = new Date(Date.now() + 20 * DAY);
    const w = world({ purchaseType: PurchaseType.RENEW, row: { subscriptionId: 'sub-1' }, subscriptionExpiresAt: expiresAt });
    const next = new Date(Date.now() + 9 * DAY).toISOString().slice(0, 10);
    w.recurrent({ next_payment_date: next });
    await w.look();
    assert.equal(readDelayGrant(w.tx()['gatewayData'])?.days, 7, 'their term already reaches past the first charge');
  });
});

describe('a renewal signed up with a delay', () => {
  it('has its line rewritten with the checkout: the days and the sum the fulfilment checks the line\'s snapshot against', async () => {
    const w = world({ purchaseType: PurchaseType.RENEW, row: { subscriptionId: 'sub-1' }, items: [{}, { id: 'item-2', subscriptionId: 'sub-2' }] });
    w.recurrent({ next_payment_date: null });
    await w.look();
    assert.equal(w.items.length, 2);
    for (const item of w.items) {
      assert.equal(item['durationDays'], 7);
      assert.equal((item['amount'] as Prisma.Decimal).toString(), '0');
      const snapshot = item['planSnapshot'] as Record<string, unknown>;
      assert.equal(snapshot['selectedDurationDays'], 7, 'the line\'s snapshot agrees with the line');
      assert.equal(snapshot['amount'], '0');
      assert.equal(snapshot['snapshotSource'], 'RENEWAL_DRAFT');
      assert.equal(snapshot['id'], 'plan-1', 'the plan it was drafted for');
    }
    assert.equal(w.writes.itemUpdates, 2);
  });

  it('leaves a line that was applied alone, and takes back the claim', async () => {
    const w = world({ purchaseType: PurchaseType.RENEW, items: [{ appliedAt: new Date() }] });
    w.recurrent();
    await w.look();
    assert.equal(w.items[0]?.['durationDays'], 30);
    assert.equal((w.tx()['amount'] as Prisma.Decimal).toString(), '299');
  });
});

describe('the autopay list', () => {
  it('names the end of the delay while the plan is granted and nothing was charged', async () => {
    const w = world();
    w.recurrent({ next_payment_date: '2026-10-21' });
    await w.look();
    await w.reconcile('subscription:APAY-first:delay-grant');
    const [listed] = await w.service.listForOperator('user-1');
    assert.equal(listed?.delayEndsAt, '2026-10-21T00:00:00.000Z', 'the provider\'s date for the first charge');
    assert.equal(listed?.status, ProviderSubscriptionStatus.ACTIVE);
    assert.equal(listed?.method, 'SBP');
  });

  it('falls back to the days that were granted when Antilopay names no date, and ends with the first charge', () => {
    const grantedAt = new Date('2026-10-14T10:00:00Z');
    const base = { delayDays: 7, delayGrantedAt: grantedAt, appliedChargeCount: 0, nextChargeAt: null };
    assert.equal(delayEndsAtOf(base)?.toISOString(), '2026-10-21T10:00:00.000Z');
    assert.equal(delayEndsAtOf({ ...base, nextChargeAt: new Date('2026-10-22T00:00:00Z') })?.toISOString(), '2026-10-22T00:00:00.000Z');
    assert.equal(delayEndsAtOf({ ...base, appliedChargeCount: 1 }), null, 'the first charge came');
    assert.equal(delayEndsAtOf({ ...base, delayGrantedAt: null }), null, 'not granted yet');
    assert.equal(delayEndsAtOf({ ...base, delayDays: null }), null, 'no delay');
    assert.equal(delayEndsAtOf({ ...base, delayDays: 0 }), null);
  });
});

describe('the look the payer\'s return asks for', () => {
  it('queues one look per half minute for a delayed checkout, under a job id BullMQ takes', async () => {
    const w = world();
    const checkout = w.tx();
    const at = new Date('2026-10-14T12:00:10Z');
    await w.service.pokeDelayedSignUp(checkout as never, at);
    await w.service.pokeDelayedSignUp(checkout as never, new Date(at.getTime() + 5_000));
    await w.service.pokeDelayedSignUp(checkout as never, new Date(at.getTime() + 40_000));
    const pokes = w.jobs.filter((job) => job.name === PROVIDER_SUBSCRIPTION_SYNC_JOB);
    assert.equal(pokes.length, 3);
    assert.deepEqual(pokes[0]?.data, { gatewayType: PaymentGatewayType.ANTILOPAY, providerSubscriptionId: 'APAY-first' });
    const ids = pokes.map((job) => String(job.options['jobId']));
    assert.equal(ids[0], ids[1], 'the same half minute is the same job');
    assert.notEqual(ids[0], ids[2]);
    // Built with `toBullMqJobId`: no colon for BullMQ to refuse.
    for (const id of ids) assert.equal(id.includes(':'), false, id);
  });

  it('queues nothing for a payment that is no delayed sign-up, or one with no provider handle yet', async () => {
    const w = world();
    await w.service.pokeDelayedSignUp({ id: 'tx-plain', gatewayId: 'APAY-x', planSnapshot: { id: 'plan-1' } } as never);
    await w.service.pokeDelayedSignUp({ ...w.tx(), gatewayId: null } as never);
    await w.service.pokeDelayedSignUp({ ...w.tx(), gatewayId: '__CHECKOUT_PROVIDER_CREATE__:ours-1' } as never);
    assert.equal(w.jobs.length, 0);
  });
});

describe('the daily re-check of completed Antilopay payments', () => {
  it('asks about a paid payment and leaves the free grant alone: Antilopay was never paid for it', async () => {
    const asked: string[] = [];
    const completed = [
      { id: 'tx-paid', paymentId: 'paid-1', createdAt: new Date(), gatewayData: {}, fulfilledAt: new Date() },
      {
        id: 'tx-grant',
        paymentId: 'grant-1',
        createdAt: new Date(),
        gatewayData: { [DELAY_GRANT_KEY]: { providerSubscriptionId: 'APAY-1', delayDays: 7, days: 7, originalAmount: '299', at: 'now' } },
        fulfilledAt: new Date(),
      },
    ];
    const prisma = {
      paymentGateway: { findUnique: async () => ({ settings: GATEWAY_SETTINGS }) },
      transaction: { findMany: async () => completed },
      $executeRaw: async () => 1,
    };
    const status = new AntilopayStatusService(
      prisma as never,
      {
        post: (_url: string, body: string) => {
          const parsed = JSON.parse(body) as { order_id: string };
          asked.push(parsed.order_id);
          return of({ data: { code: 0, order_id: parsed.order_id, status: 'SUCCESS' } });
        },
      } as never,
      {} as never,
      {} as never,
      { add: async () => undefined } as never,
    );
    const read = await status.recheckCompletedPayments(new Date(), { throttleMs: 0 });
    assert.equal(read, 1);
    assert.deepEqual(asked, ['paid-1']);
  });
});
