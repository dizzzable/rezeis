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

import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { resolveNotificationCategory, resolveTerminalRouteFor } from '../src/modules/bot-map/services/notification-target-resolver';
import {
  AUTOPAY_FIRST_CHARGE_FAILED_NEW_NOTICE_TYPE,
  AUTOPAY_FIRST_CHARGE_FAILED_NOTICE_TYPE,
  DEFAULT_NOTIFICATION_TEMPLATES,
} from '../src/modules/notifications/catalog/default-templates.catalog';
import { isSubscriberMailableType } from '../src/modules/notifications/utils/notification-toggle.util';
import { PROVIDER_SUBSCRIPTION_SYNC_JOB } from '../src/modules/payments/constants/payment-reconciliation.constant';
import { AntilopayStatusService } from '../src/modules/payments/services/antilopay-status.service';
import { PaymentPendingExpiryService } from '../src/modules/payments/services/payment-pending-expiry.service';
import { PaymentReconciliationService } from '../src/modules/payments/services/payment-reconciliation.service';
import {
  AUTOPAY_FIRST_CHARGE_FAILED,
  keyedChargeKey,
  ProviderSubscriptionService,
  SIGN_UP_CONFIRMED_KEY,
  UNPAID_SIGN_UP_KEY,
} from '../src/modules/payments/services/provider-subscription.service';
import { isDelayedCheckout } from '../src/modules/payments/utils/antilopay-delay-grant.util';
import { type AntilopayCharge, assignAntilopayChargeRoles } from '../src/modules/payments/utils/antilopay-recurrent.util';
import {
  isChargeDeliveredCheckout,
  PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY,
  readProviderSubscriptionTerms,
  resolveProviderSubscriptionTerms,
} from '../src/modules/payments/utils/provider-subscription-terms.util';
import { executeGatewayDataWrites } from './helpers/gateway-data-write-double';

/**
 * The operator's complaint of 18.10.2026: customers who signed up for automatic
 * charging over SBP at Antilopay got the plan, and kept it when Antilopay never
 * took a payment. Antilopay calls the payment of OUR order paid when the payer
 * confirms the subscription in their bank, and no money moves with it («Нельзя
 * сделать возврат у начала подписки…»): the money is in a separate payment the
 * subscription makes, at activation, or after the delay. The owner's rules:
 * the plan comes with that charge and only with it, the delay gives no access
 * («Без доступа на время отсрочки»), and a first charge that does not come is
 * told to the customer and to the operator («Клиенту и оператору»).
 *
 * The real provider-subscription service, the real reconciliation worker and
 * the real expiry sweep, over one in-memory store, as the panel runs them.
 */

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

interface WorldOptions {
  readonly row?: Partial<ProviderSubscription>;
  readonly first?: Partial<Tx>;
  readonly purchaseType?: PurchaseType;
  /** The delay the sign-up was made with, in days; none by default. */
  readonly delayDays?: number;
  /** A draft made before 18.10.2026: its terms carry no `deliversOnCharge`. */
  readonly legacy?: boolean;
}

function world(options: WorldOptions = {}) {
  const terms = {
    unit: 'month',
    count: 1,
    amount: 299,
    durationDays: 30,
    planId: 'plan-1',
    subscriptionId: options.row?.subscriptionId ?? null,
    method: 'SBP',
    ...(options.delayDays === undefined ? {} : { delay: { count: options.delayDays, unit: 'DAY', days: options.delayDays } }),
    ...(options.legacy === true ? {} : { deliversOnCharge: true }),
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
    delayDays: options.delayDays ?? null,
    delayGrantedAt: null,
    consentVersion: 'provider-subscription-v1',
    createdAt: new Date('2026-10-18T09:00:00.000Z'),
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
  const events: Array<{ providerEventId: string; paymentId: string; payloadHash: string; eventStatus: string | null; rawPayload: unknown }> = [];
  const jobs: Array<{ name: string; data: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const cards: Array<{ type: string; message: string; metadata: Record<string, unknown> }> = [];
  const notices: Array<{ userId: string; type: string; payload: Record<string, unknown> }> = [];
  const fulfilled: Array<{ amount: string; selectedDurationDays: unknown }> = [];
  const webhookEvents = new Map<string, Record<string, unknown>>();
  const inboxLog = { processed: [] as string[], failed: [] as string[] };
  let answers: (path: string, body: Record<string, unknown>) => Record<string, unknown> = () => ({ code: 0 });

  const byId = (id: unknown): Tx | undefined => transactions.find((candidate) => candidate.id === id);

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
      findMany: async () => transactions.filter((t) => t['status'] === TransactionStatus.PENDING),
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
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => data,
    },
    subscription: { findUnique: async () => ({ expiresAt: null }) },
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
        const idWhere = where['id'] as { in?: string[] } | string | undefined;
        if (typeof idWhere === 'object' && idWhere.in !== undefined && !idWhere.in.includes(row.id)) return { count: 0 };
        if (typeof idWhere === 'string' && idWhere !== row.id) return { count: 0 };
        if ('delayGrantedAt' in where && where['delayGrantedAt'] === null && row.delayGrantedAt !== null) return { count: 0 };
        if ('subscriptionId' in where && where['subscriptionId'] === null && row.subscriptionId !== null) return { count: 0 };
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
  prisma['$transaction'] = async (callback: (db: unknown) => Promise<unknown>) => callback(prisma);

  const inbox = {
    recordReceived: async ({
      envelope,
    }: {
      envelope: { providerEventId: string; paymentId: string; payloadHash: string; eventStatus: string | null; rawPayload: unknown };
    }) => {
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
      return of({ data: answers(path, JSON.parse(body) as Record<string, unknown>) });
    },
  };
  const systemEvents = {
    warn: (type: string, _category: string, message: string, metadata: Record<string, unknown> = {}) => {
      cards.push({ type, message, metadata });
    },
    info: (type: string, _category: string, message: string, metadata: Record<string, unknown> = {}) => {
      cards.push({ type, message, metadata });
    },
  };
  const userNotifications = {
    create: async (input: { userId: string; type: string; payload: Record<string, unknown> }) => {
      notices.push(input);
      return 'notice-1';
    },
  };
  const service = new ProviderSubscriptionService(
    prisma as never,
    http as never,
    inbox as never,
    queue as never,
    systemEvents as never,
    undefined,
    userNotifications as never,
  );
  const mutation = {
    applyCompletedTransaction: async (transaction: Tx) => {
      fulfilled.push({
        amount: (transaction['amount'] as Prisma.Decimal).toString(),
        selectedDurationDays: (transaction['planSnapshot'] as Record<string, unknown>)['selectedDurationDays'],
      });
      const live = byId(transaction.id)!;
      live['subscriptionId'] = 'sub-new';
      live['status'] = TransactionStatus.COMPLETED;
      if (row.firstTransactionId === live.id && row.subscriptionId === null) row = { ...row, subscriptionId: 'sub-new' };
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
    { processPartnerEarning: async () => undefined } as never,
    { qualifyReferralAfterPurchase: async () => null } as never,
    { enqueue: async () => undefined } as never,
    { info: () => undefined, warn: () => undefined, error: () => undefined, emit: () => undefined } as never,
    { enqueueRegisterIncome: async () => undefined } as never,
    { recordFirstPurchase: async () => undefined } as never,
    { upsertFromYookassaPayment: async () => undefined } as never,
    { verifyCompletion: async () => ({ outcome: 'CONFIRMED' }) } as never,
    { creditForTransactionBestEffort: async () => null } as never,
    { create: async () => 'notification-1' } as never,
    service,
  );

  return {
    service,
    reconciliation,
    prisma,
    row: () => row,
    tx: (id = 'tx-first') => byId(id)!,
    transactions,
    events,
    jobs,
    cards,
    notices,
    fulfilled,
    inboxLog,
    webhookEvents,
    reconcile: (providerEventId: string) => reconciliation.reconcileWebhookEvent(providerEventId),
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
              start_date: '2026-10-18',
              next_payment_date: null,
              end_date: '2027-09-18',
              payments,
              ...overrides,
            }
          : { code: 0 };
    },
    look: () => service.sync(PaymentGatewayType.ANTILOPAY, 'APAY-first'),
    /** A notice for OUR order, as Antilopay's callback (or the status sweep) puts it in the inbox. */
    ourOrderPaid: (id = 'apay-paid', source: string | null = null) => {
      webhookEvents.set(id, {
        id,
        gatewayType: PaymentGatewayType.ANTILOPAY,
        paymentId: 'ours-1',
        providerEventId: id,
        eventStatus: 'SUCCESS',
        rawPayload: {
          type: 'payment',
          status: 'SUCCESS',
          order_id: 'ours-1',
          payment_id: 'APAY-first',
          recurrent_id: 'rec-1',
          ...(source === null ? {} : { source }),
        },
        status: PaymentWebhookLifecycleStatus.ENQUEUED,
        receivedAt: new Date(),
        replayCount: 0,
        reconciliationAttempts: 0,
      });
      return reconciliation.reconcileWebhookEvent(id);
    },
    /** The settlement the look queued for a charge, run by the worker. */
    settle: async (chargeId: string) => reconciliation.reconcileWebhookEvent(`subscription:APAY-first:payment:${chargeId}`),
  };
}

/** One payment of the recurrent: the start is our order, a charge is Antilopay's own. */
const start = (ctime = '2026-10-18 09:00:00') => ({
  payment_id: 'APAY-first',
  order_id: 'ours-1',
  ctime,
  status: 'SUCCESS',
  original_amount: 299,
});
const charge = (id: string, ctime: string, status = 'SUCCESS') => ({
  payment_id: id,
  order_id: `antilopay-${id}`,
  ctime,
  status,
  original_amount: 299,
});

const gatewayDataOf = (tx: Tx): Record<string, unknown> => tx['gatewayData'] as Record<string, unknown>;

describe('the terms of an SBP sign-up since 18.10.2026', () => {
  const base = {
    gatewayType: PaymentGatewayType.ANTILOPAY,
    currency: 'RUB',
    amount: new Prisma.Decimal('299'),
    durationDays: 30,
    discountSource: 'NONE' as const,
    planId: 'plan-1',
    subscriptionId: null,
  };

  it('say the plan comes with the first charge, and carry it out of the snapshot and back', () => {
    const resolved = resolveProviderSubscriptionTerms({ ...base, method: 'SBP' });
    assert.ok('terms' in resolved);
    assert.equal(resolved.terms.deliversOnCharge, true);
    const snapshot = JSON.parse(JSON.stringify({ [PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY]: resolved.terms }));
    assert.equal(readProviderSubscriptionTerms(snapshot)?.deliversOnCharge, true);
    assert.equal(isChargeDeliveredCheckout({ gatewayType: PaymentGatewayType.ANTILOPAY, planSnapshot: snapshot }), true);
  });

  it('say nothing of it for a card, whose first payment on the form is the money', () => {
    const card = resolveProviderSubscriptionTerms({ ...base, method: 'CARD' });
    assert.ok('terms' in card);
    assert.equal('deliversOnCharge' in card.terms, false);
  });

  it('do not make a delayed draft the grant any more; one made before still is', () => {
    const delayed = (deliversOnCharge: boolean) => ({
      gatewayType: PaymentGatewayType.ANTILOPAY,
      planSnapshot: {
        [PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY]: {
          unit: 'month',
          count: 1,
          amount: 299,
          durationDays: 30,
          planId: 'plan-1',
          subscriptionId: null,
          method: 'SBP',
          delay: { count: 7, unit: 'DAY', days: 7 },
          ...(deliversOnCharge ? { deliversOnCharge: true } : {}),
        },
      },
    });
    assert.equal(isDelayedCheckout(delayed(true)), false);
    assert.equal(isDelayedCheckout(delayed(false)), true);
  });
});

describe('which charge delivers a sign-up made since 18.10.2026', () => {
  const at = (iso: string) => new Date(iso);
  const listed = (id: string, iso: string, orderId: string | null = null, disputed = false): AntilopayCharge => ({
    id,
    orderId,
    at: at(iso),
    providerStatus: disputed ? 'CHARGEBACK' : 'SUCCESS',
    disputed,
    amount: '299',
    refunds: [],
  });
  const roles = (charges: AntilopayCharge[], firstDelivered = false) =>
    Object.fromEntries(
      assignAntilopayChargeRoles({
        charges,
        providerSubscriptionId: 'APAY-first',
        firstOrderId: 'ours-1',
        method: 'SBP',
        signedUpAt: at('2026-10-18T09:00:00Z'),
        firstDelivered,
        deliversOnCharge: true,
      }),
    );

  it('never the start, even when it is the only payment listed', () => {
    assert.deepEqual(roles([listed('APAY-first', '2026-10-18T09:00:00Z', 'ours-1')]), { 'APAY-first': 'START' });
  });

  it('the earliest charge, however long after the start it came, and every later one renews', () => {
    assert.deepEqual(
      roles([
        listed('APAY-first', '2026-10-18T09:00:00Z', 'ours-1'),
        // A failed attempt at activation, through on a later one, days after.
        listed('APAY-retry', '2026-10-23T09:00:00Z'),
        listed('APAY-next', '2026-11-23T09:00:00Z'),
      ]),
      { 'APAY-first': 'START', 'APAY-retry': 'FIRST', 'APAY-next': 'RENEW' },
    );
  });

  it('keeps a first charge given back as the first: the next one never takes its place', () => {
    assert.deepEqual(
      roles([listed('APAY-first', '2026-10-18T09:00:00Z', 'ours-1'), listed('APAY-one', '2026-10-18T09:01:00Z', null, true), listed('APAY-two', '2026-11-18T09:00:00Z')], true),
      { 'APAY-first': 'START', 'APAY-one': 'FIRST', 'APAY-two': 'RENEW' },
    );
  });
});

describe('an SBP sign-up is delivered by its first charge, never by its start', () => {
  it('holds Antilopay calling OUR order paid: nothing fulfilled, the moment kept, the subscription looked at', async () => {
    const w = world();
    await w.ourOrderPaid();

    assert.equal(w.tx()['status'], TransactionStatus.PENDING, 'the start moved no money');
    assert.equal(w.fulfilled.length, 0);
    assert.equal(typeof gatewayDataOf(w.tx())[SIGN_UP_CONFIRMED_KEY], 'string');
    assert.deepEqual(w.inboxLog.processed, ['apay-paid'], 'the notice is settled, not failed');
    const looks = w.jobs.filter((job) => job.name === PROVIDER_SUBSCRIPTION_SYNC_JOB);
    assert.deepEqual(looks.map((job) => [job.data['providerSubscriptionId'], job.options['delay'] ?? 0]), [
      ['APAY-first', 0],
      ['APAY-first', 3 * 60 * 1000],
    ]);
  });

  it('holds the status sweep\'s check of OUR order the same way', async () => {
    const w = world();
    await w.ourOrderPaid('antilopay-check:ours-1:SUCCESS', 'ANTILOPAY_PAYMENT_CHECK');
    assert.equal(w.tx()['status'], TransactionStatus.PENDING);
    assert.equal(w.fulfilled.length, 0);
  });

  it('gives nothing for the start alone, however often it is looked at', async () => {
    const w = world();
    w.recurrent({ status: 'ACTIVE' }, [start()]);
    await w.look();
    await w.look();
    assert.equal(w.events.length, 0, 'nothing is settled for the start');
    assert.equal(w.tx()['status'], TransactionStatus.PENDING);
    assert.equal(w.notices.length, 0);
  });

  it('delivers the plan with the charge made at activation, once', async () => {
    const w = world();
    await w.ourOrderPaid();
    w.recurrent({ status: 'ACTIVE', next_payment_date: '2026-11-18' }, [start(), charge('APAY-activation', '2026-10-18 09:00:20')]);
    await w.look();
    assert.deepEqual(w.events.map((event) => [event.providerEventId, event.paymentId]), [
      ['subscription:APAY-first:payment:APAY-activation', 'ours-1'],
    ]);
    await w.settle('APAY-activation');
    assert.equal(w.tx()['status'], TransactionStatus.COMPLETED);
    assert.deepEqual(w.fulfilled, [{ amount: '299', selectedDurationDays: 30 }], 'the full term, for the money');
    assert.equal(w.transactions.some((t) => t.idempotencyKey !== null), false, 'and no renewal for the same money');
    await w.look();
    assert.equal(w.fulfilled.length, 1);
  });

  it('pays for the waited term with a first charge that went through days later, and renews with the next', async () => {
    const w = world();
    w.recurrent({ status: 'ACTIVE' }, [start(), charge('APAY-retry', '2026-10-23 09:00:00')]);
    await w.look();
    await w.settle('APAY-retry');
    assert.equal(w.fulfilled.length, 1);
    assert.equal(w.transactions.some((t) => t.idempotencyKey !== null), false);

    w.recurrent({ status: 'ACTIVE' }, [start(), charge('APAY-retry', '2026-10-23 09:00:00'), charge('APAY-next', '2026-11-23 09:00:00')]);
    await w.look();
    const renewal = w.transactions.find((t) => t.idempotencyKey === keyedChargeKey('ps-1', 'APAY-next'));
    assert.ok(renewal, 'the next charge renews under its own id');
  });

  it('revives a checkout that lapsed while it waited, as any late payment', async () => {
    const w = world({ first: { status: TransactionStatus.CANCELED } });
    w.recurrent({ status: 'ACTIVE' }, [start(), charge('APAY-activation', '2026-10-18 09:05:00')]);
    await w.look();
    await w.settle('APAY-activation');
    assert.equal(w.tx()['status'], TransactionStatus.COMPLETED);
    assert.equal(w.fulfilled.length, 1);
  });

  it('keeps the rules a sign-up drafted before 18.10.2026 was made with', async () => {
    const w = world({ legacy: true });
    await w.ourOrderPaid();
    assert.equal(w.fulfilled.length, 1, 'such a sign-up was delivered by its start');
  });
});

describe('the delay of the first charge gives no access («Без доступа на время отсрочки»)', () => {
  it('gives nothing while the delay runs, and the full plan with the first charge after it', async () => {
    const w = world({ delayDays: 7 });
    await w.ourOrderPaid();
    w.recurrent({ status: 'ACTIVE', next_payment_date: '2026-10-25' }, [start()]);
    await w.look();
    assert.equal(w.row().delayGrantedAt, null, 'no grant');
    assert.equal((w.tx()['amount'] as Prisma.Decimal).toString(), '299', 'the checkout is not rewritten');
    assert.equal(w.events.length, 0);
    assert.equal(w.fulfilled.length, 0);

    w.recurrent({ status: 'ACTIVE', next_payment_date: '2026-11-25' }, [start(), charge('APAY-after-delay', '2026-10-25 09:00:00')]);
    await w.look();
    await w.settle('APAY-after-delay');
    assert.deepEqual(w.fulfilled, [{ amount: '299', selectedDurationDays: 30 }]);
  });

  it('still grants a sign-up drafted before, as it was promised', async () => {
    const w = world({ delayDays: 7, legacy: true });
    w.recurrent({ status: 'ACTIVE' }, [start()]);
    await w.look();
    assert.ok(w.row().delayGrantedAt instanceof Date);
  });
});

describe('when the first charge does not come', () => {
  it('tells the customer and the operator once, and fails the waiting checkout', async () => {
    const w = world();
    await w.ourOrderPaid();
    w.recurrent({ status: 'ACTIVE_FAILED' }, [start(), charge('APAY-activation', '2026-10-18 09:00:20', 'FAIL')]);
    await w.look();

    assert.equal(w.row().status, ProviderSubscriptionStatus.PAST_DUE);
    const tx = w.tx();
    assert.equal(tx['status'], TransactionStatus.FAILED);
    assert.equal(gatewayDataOf(tx)['failureReason'], AUTOPAY_FIRST_CHARGE_FAILED);
    assert.ok(gatewayDataOf(tx)[UNPAID_SIGN_UP_KEY]);
    assert.equal(w.fulfilled.length, 0);

    assert.deepEqual(w.notices, [
      { userId: 'user-1', type: AUTOPAY_FIRST_CHARGE_FAILED_NEW_NOTICE_TYPE, payload: { plan: 'Base', amount: '299', paymentId: 'ours-1' } },
    ]);
    const failed = w.cards.filter((card) => card.type === EVENT_TYPES.PAYMENT_FAILED);
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.metadata['planName'], 'Base');
    assert.equal(failed[0]?.metadata['userId'], 'user-1');
    assert.equal(failed[0]?.metadata['autopayFirstChargeFailed'], true);

    for (let look = 0; look < 3; look += 1) await w.look();
    await Promise.all([w.look(), w.look()]);
    assert.equal(w.notices.length, 1, 'told once');
    assert.equal(w.cards.filter((card) => card.type === EVENT_TYPES.PAYMENT_FAILED).length, 1);
  });

  it('offers a renewal to a customer whose subscription it was to renew', async () => {
    const w = world({ purchaseType: PurchaseType.RENEW, row: { subscriptionId: 'sub-1' } });
    w.recurrent({ status: 'ERROR' }, [start()]);
    await w.look();
    assert.deepEqual(w.notices.map((notice) => [notice.type, notice.payload['subscriptionId']]), [
      [AUTOPAY_FIRST_CHARGE_FAILED_NOTICE_TYPE, 'sub-1'],
    ]);
  });

  it('tells them when the subscription ended at the bank after the payer confirmed it', async () => {
    const w = world();
    w.recurrent({ status: 'PROVIDER_CANCEL' }, [start()]);
    await w.look();
    assert.equal(w.row().cancelledBy, 'PROVIDER');
    assert.equal(w.notices.length, 1);
  });

  it('says nothing when the customer turned it off themselves', async () => {
    const w = world({ row: { status: ProviderSubscriptionStatus.CANCELLED, cancelledAt: new Date(), cancelledBy: 'CUSTOMER' } });
    w.recurrent({ status: 'CANCEL' }, [start()]);
    await w.look();
    assert.equal(w.notices.length, 0);
    assert.equal(w.cards.length, 0);
  });

  it('says nothing of a sign-up the payer never confirmed', async () => {
    const w = world();
    w.recurrent({ status: 'CANCEL' }, []);
    await w.look();
    assert.equal(w.notices.length, 0);
    assert.equal(w.tx()['status'], TransactionStatus.PENDING);
  });

  it('says nothing about a renewal charge that failed after the plan was delivered', async () => {
    const w = world({ first: { status: TransactionStatus.COMPLETED, fulfilledAt: new Date(), subscriptionId: 'sub-new' } });
    w.recurrent({ status: 'ACTIVE_FAILED' }, [start(), charge('APAY-activation', '2026-10-18 09:00:20')]);
    await w.look();
    assert.equal(w.notices.length, 0);
  });

  it('delivers the plan all the same when Antilopay takes the charge on a later attempt', async () => {
    const w = world();
    w.recurrent({ status: 'ACTIVE_FAILED' }, [start()]);
    await w.look();
    assert.equal(w.tx()['status'], TransactionStatus.FAILED);
    w.recurrent({ status: 'ACTIVE' }, [start(), charge('APAY-retry', '2026-10-19 09:00:00')]);
    await w.look();
    await w.settle('APAY-retry');
    assert.equal(w.tx()['status'], TransactionStatus.COMPLETED);
    assert.equal(w.fulfilled.length, 1);
  });

  it('is said with a template the operator edits, and a button where the customer can pay', () => {
    const renew = DEFAULT_NOTIFICATION_TEMPLATES.find((template) => template.type === AUTOPAY_FIRST_CHARGE_FAILED_NOTICE_TYPE);
    const fresh = DEFAULT_NOTIFICATION_TEMPLATES.find((template) => template.type === AUTOPAY_FIRST_CHARGE_FAILED_NEW_NOTICE_TYPE);
    assert.ok(renew && fresh);
    assert.equal(renew.title, '⚠️ Автосписание не прошло');
    assert.match(renew.body, /\{\{amount\}\} ₽/);
    assert.match(renew.body, /«\{\{plan\}\}» не продлена/);
    assert.match(fresh.body, /не оформлена/);
    assert.deepEqual(renew.buttons?.map((button) => [button.labelRu, button.target]), [
      ['🔄 Продлить подписку', '/renew'],
      ['🏠 Главное меню', 'menu:main'],
    ]);
    assert.equal(fresh.buttons?.[0]?.target, '/plans');
    assert.equal(resolveTerminalRouteFor(AUTOPAY_FIRST_CHARGE_FAILED_NOTICE_TYPE), '/renew');
    assert.equal(resolveTerminalRouteFor(AUTOPAY_FIRST_CHARGE_FAILED_NEW_NOTICE_TYPE), '/plans');
    assert.equal(resolveNotificationCategory(AUTOPAY_FIRST_CHARGE_FAILED_NEW_NOTICE_TYPE), 'expires');
    // About the customer's own purchase: it reaches a customer with no Telegram too.
    assert.equal(isSubscriberMailableType(AUTOPAY_FIRST_CHARGE_FAILED_NOTICE_TYPE), true);
    assert.equal(isSubscriberMailableType(AUTOPAY_FIRST_CHARGE_FAILED_NEW_NOTICE_TYPE), true);
  });
});

describe('the payment page while the first charge is awaited', () => {
  it('says nothing before the payer confirmed, awaits the charge after, and says when it did not come', async () => {
    const w = world();
    assert.equal(await w.service.describeSignUpForPayer(w.tx() as never), null);

    await w.ourOrderPaid();
    w.recurrent({ status: 'ACTIVE', next_payment_date: '2026-10-25' }, [start()]);
    await w.look();
    assert.deepEqual(await w.service.describeSignUpForPayer(w.tx() as never), {
      state: 'AWAITING_FIRST_CHARGE',
      firstChargeAt: '2026-10-25T00:00:00.000Z',
    });

    w.recurrent({ status: 'ACTIVE_FAILED' }, [start()]);
    await w.look();
    assert.deepEqual(await w.service.describeSignUpForPayer(w.tx() as never), { state: 'FIRST_CHARGE_FAILED', firstChargeAt: null });
  });

  it('says nothing once the plan is delivered, nor for a sign-up drafted before', async () => {
    const w = world();
    w.recurrent({ status: 'ACTIVE' }, [start(), charge('APAY-activation', '2026-10-18 09:00:20')]);
    await w.look();
    await w.settle('APAY-activation');
    assert.equal(await w.service.describeSignUpForPayer(w.tx() as never), null);
    const legacy = world({ legacy: true });
    await legacy.ourOrderPaid();
    assert.equal(await legacy.service.describeSignUpForPayer(legacy.tx() as never), null);
  });
});

describe('the expiry sweep and a sign-up awaiting its first charge', () => {
  const statusService = (planSnapshot: unknown) => {
    const service = new AntilopayStatusService(
      { paymentGateway: { findUnique: async () => ({ settings: GATEWAY_SETTINGS }) }, $executeRaw: async () => 1 } as never,
      { post: (_url: string, body: string) => of({ data: { code: 0, order_id: (JSON.parse(body) as { order_id: string }).order_id, status: 'SUCCESS' } }) } as never,
      {
        normalizeWebhook: () => ({
          gatewayType: PaymentGatewayType.ANTILOPAY,
          paymentId: 'ours-1',
          providerEventId: 'x',
          eventStatus: 'SUCCESS',
          receivedAt: new Date().toISOString(),
          payloadHash: 'h',
          rawPayload: {},
        }),
      } as never,
      { recordReceived: async () => ({ duplicate: true }) } as never,
      { add: async () => undefined } as never,
    );
    return service.verdictBeforeExpiry({
      id: 'tx-first',
      paymentId: 'ours-1',
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      gatewayData: {},
      planSnapshot: planSnapshot as Prisma.JsonValue,
    });
  };

  it('is not kept pending for as long as the delay lasts: Antilopay\'s «paid» start is no payment', async () => {
    const marked = world().tx()['planSnapshot'];
    const legacy = world({ legacy: true }).tx()['planSnapshot'];
    assert.equal(await statusService(marked), 'awaiting-charge');
    assert.equal(await statusService(legacy), 'keep');
  });

  it('closes the checkout without «Платёж истёк», and the first charge revives it', async () => {
    const w = world({ delayDays: 7, first: { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) } });
    const expiry = new PaymentPendingExpiryService(
      w.prisma as never,
      {
        info: (type: string) => w.cards.push({ type, message: '', metadata: {} }),
        warn: () => undefined,
      } as never,
      { get: () => of({ status: 200, data: {} }) } as never,
      {} as never,
      { enqueue: async () => undefined } as never,
      w.reconciliation,
      { verdictBeforeExpiry: async () => 'awaiting-charge' } as never,
    );
    await expiry.expireStalePending();
    assert.equal(w.tx()['status'], TransactionStatus.CANCELED);
    assert.equal(w.cards.some((card) => card.type === EVENT_TYPES.PAYMENT_EXPIRED), false);

    w.recurrent({ status: 'ACTIVE' }, [start(), charge('APAY-after-delay', new Date(Date.now() + 7 * DAY).toISOString().replace('T', ' ').slice(0, 19))]);
    await w.look();
    await w.settle('APAY-after-delay');
    assert.equal(w.tx()['status'], TransactionStatus.COMPLETED);
    assert.equal(w.fulfilled.length, 1);
  });
});
