import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { Logger } from '@nestjs/common';
import {
  PaymentGatewayType,
  Prisma,
  ProviderSubscriptionStatus,
  PurchaseType,
  TransactionStatus,
} from '@prisma/client';
import { of, throwError } from 'rxjs';

import { PAYMENT_RECONCILIATION_JOB } from '../src/modules/payments/constants/payment-reconciliation.constant';
import { PaymentReconciliationService } from '../src/modules/payments/services/payment-reconciliation.service';
import { extractPlategaSubscriptionDispute } from '../src/modules/payments/services/payment-webhook-ingress.service';
import {
  PROVIDER_SUBSCRIPTION_DISPUTE,
  ProviderSubscriptionService,
  readProviderSubscriptionDispute,
  STRANDED_BY_REFUND,
  strandedReason,
} from '../src/modules/payments/services/provider-subscription.service';
import {
  autopayEndedByRefund,
  describeAutopayOutcome,
  NO_AUTOPAY,
  REFUND_CANCELLED_BY,
  refundEndsAutopay,
  UNKNOWN_AUTOPAY_GATEWAY,
} from '../src/modules/payments/utils/refund-autopay.util';

/**
 * «все возвраты, которые захочет пользователь, удаляют автосписания» — the
 * owner's rule: a refund ends the autopay (wave 6).
 *
 * A full refund of a NEW, ADDITIONAL or RENEW payment, or of an autopay charge,
 * used to leave the provider subscription live: the provider charged again
 * next period and the charge renewed — and revived — the refunded
 * subscription. Platega's chargebacks on a subscription charge went to `sync`,
 * which counts charges and never reverses one.
 *
 * These are the provider-subscription half, over an in-memory store that
 * honours the queries the service makes; the refund doors themselves are in
 * `payments-withheld-conversion.spec.ts`, and on PostgreSQL in
 * `provider-subscriptions-postgres.spec.ts`.
 */

afterEach(() => mock.restoreAll());

interface Row {
  id: string;
  userId: string | null;
  gatewayType: PaymentGatewayType;
  providerSubscriptionId: string;
  status: ProviderSubscriptionStatus;
  subscriptionId: string | null;
  firstTransactionId: string;
  planId: string;
  durationDays: number;
  amount: Prisma.Decimal;
  currency: string;
  appliedChargeCount: number;
  cancelledAt: Date | null;
  cancelledBy: string | null;
  createdAt: Date;
}

type Where = Record<string, unknown>;

function matches(record: Record<string, unknown>, where: Where | undefined): boolean {
  if (where === undefined) return true;
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return (condition as Where[]).some((branch) => matches(record, branch));
    const value = record[key];
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      const operators = condition as { in?: unknown[]; gte?: Date; not?: unknown };
      if (operators.in !== undefined) return operators.in.includes(value);
      if (operators.gte !== undefined) return value instanceof Date && value.getTime() >= operators.gte.getTime();
      // SQL's `<>`: a NULL is not unequal to anything; `{ field: null }` is how a query asks for it.
      if ('not' in operators) return value !== null && value !== operators.not;
      return true;
    }
    return value === condition;
  });
}

function row(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    userId: 'user-1',
    gatewayType: PaymentGatewayType.PLATEGA,
    providerSubscriptionId: `platega-${id}`,
    status: ProviderSubscriptionStatus.ACTIVE,
    subscriptionId: 'sub-1',
    firstTransactionId: `first-${id}`,
    planId: 'plan-1',
    durationDays: 30,
    amount: new Prisma.Decimal('299'),
    currency: 'RUB',
    appliedChargeCount: 1,
    cancelledAt: null,
    cancelledBy: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

function world(input: {
  readonly rows: Row[];
  readonly transactions?: Array<Record<string, unknown>>;
  readonly items?: Array<{ transactionId: string; subscriptionId: string }>;
  /** Provider subscription ids whose cancel the provider refuses. */
  readonly refuseCancel?: ReadonlySet<string>;
  /** What the provider's GET says, for the sync a chargeback starts with. */
  readonly chargesSuccess?: number;
  /** Runs as the provider is asked to cancel, before it answers: another door landing meanwhile. */
  readonly onCancel?: (providerSubscriptionId: string) => void;
  /** What switching off the user's ЮKassa saved-card autopay answers; no switch without it. */
  readonly savedCard?: { readonly switched: number; readonly busy: number } | Error;
}) {
  const rows = input.rows;
  const transactions = input.transactions ?? [];
  /** What the provider says of every subscription; a test changes it. */
  const provider = { status: 'ACTIVE', chargesSuccess: input.chargesSuccess ?? 1 };
  /** Reads of `providerSubscription.findMany` left to fail. */
  const faults = { findMany: 0 };
  /** What the inbox holds: the same notice again is a duplicate. */
  const inboxHolds = new Set<string>();
  const cancelCalls: string[] = [];
  const envelopes: Array<Record<string, unknown>> = [];
  const jobs: Array<{ name: string; data: unknown }> = [];
  const events: Array<{ type: string; metadata: Record<string, unknown> }> = [];
  const prisma = {
    providerSubscription: {
      findMany: async ({ where, select }: { where?: Where; select?: Record<string, boolean> }) => {
        if (faults.findMany > 0) {
          faults.findMany -= 1;
          throw new Error('the database is not answering');
        }
        return rows
          .filter((candidate) => matches(candidate as unknown as Record<string, unknown>, where))
          .map((candidate) =>
            select === undefined
              ? { ...candidate }
              : Object.fromEntries(Object.entries(candidate).filter(([key]) => select[key] === true)),
          );
      },
      findFirst: async ({ where }: { where: Where }) => {
        const found = rows.find((candidate) => matches(candidate as unknown as Record<string, unknown>, where));
        return found === undefined ? null : { ...found };
      },
      findUnique: async ({ where }: { where: Where }) => {
        const pair = where['gatewayType_providerSubscriptionId'] as
          | { gatewayType: string; providerSubscriptionId: string }
          | undefined;
        const found =
          pair === undefined
            ? rows.find((candidate) => candidate.id === where['id'])
            : rows.find(
                (candidate) =>
                  candidate.gatewayType === pair.gatewayType &&
                  candidate.providerSubscriptionId === pair.providerSubscriptionId,
              );
        return found === undefined ? null : { ...found };
      },
      updateMany: async ({ where, data }: { where: Where; data: Partial<Row> }) => {
        let count = 0;
        for (const candidate of rows) {
          if (matches(candidate as unknown as Record<string, unknown>, where)) {
            Object.assign(candidate, data);
            count += 1;
          }
        }
        return { count };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const found = rows.find((candidate) => candidate.id === where.id)!;
        Object.assign(found, data);
        return { ...found };
      },
    },
    transactionItem: {
      findMany: async ({ where }: { where: { transactionId: string } }) =>
        (input.items ?? []).filter((item) => item.transactionId === where.transactionId),
    },
    transaction: {
      findFirst: async ({ where }: { where: Where }) =>
        transactions.find((candidate) => matches(candidate, where)) ?? null,
      findUnique: async ({ where }: { where: { id?: string; userId_idempotencyKey?: { idempotencyKey: string } } }) =>
        transactions.find((candidate) =>
          where.userId_idempotencyKey === undefined
            ? candidate['id'] === where.id
            : candidate['idempotencyKey'] === where.userId_idempotencyKey.idempotencyKey,
        ) ?? null,
      // The sweep's look for trial conversions: none here.
      findMany: async () => [],
    },
    // What an autopay charge the sync finds is created with.
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        transaction: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            const created = { id: `tx-charge-${transactions.length + 1}`, paymentId: `payment-charge-${transactions.length + 1}`, ...data };
            transactions.push(created);
            return created;
          },
        },
        transactionItem: { create: async ({ data }: { data: Record<string, unknown> }) => data },
      }),
    // The subscriptions the sweep reads beside the rows: live and on their plan.
    subscription: {
      findMany: async () => [{ id: 'sub-1', status: 'ACTIVE', planSnapshot: { id: 'plan-1' }, isTrial: false }],
      findUnique: async () => ({ expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) }),
    },
    paymentGateway: {
      findUnique: async () => ({ type: PaymentGatewayType.PLATEGA, settings: { merchantId: 'm-1', secret: 's-1' } }),
    },
  };
  const http = {
    post: (url: string) => {
      cancelCalls.push(url);
      const asked = /\/subscription\/([^/]+)\/cancel/.exec(url)?.[1] ?? '';
      input.onCancel?.(asked);
      const refused = [...(input.refuseCancel ?? [])].some((id) => url.includes(`/subscription/${id}/cancel`));
      return refused ? throwError(() => new Error('provider unreachable')) : of({ data: { status: 'cancelled' } });
    },
    get: () =>
      of({ data: { status: provider.status, chargeMetrics: { chargesSuccess: provider.chargesSuccess } } }),
  };
  const inbox = {
    recordReceived: async ({ envelope }: { envelope: Record<string, unknown> }) => {
      const key = `${String(envelope['providerEventId'])}:${String(envelope['payloadHash'])}`;
      if (inboxHolds.has(key)) {
        return { event: { id: 'event-held', paymentId: envelope['paymentId'], gatewayType: envelope['gatewayType'] }, duplicate: true };
      }
      inboxHolds.add(key);
      envelopes.push(envelope);
      return {
        event: { id: `event-${envelopes.length}`, paymentId: envelope['paymentId'], gatewayType: envelope['gatewayType'] },
        duplicate: false,
      };
    },
    markEnqueued: async () => undefined,
    markFailed: async () => undefined,
  };
  const queue = {
    add: async (name: string, data: unknown) => {
      jobs.push({ name, data });
    },
  };
  const systemEvents = {
    warn: (type: string, _category: string, _message: string, metadata: Record<string, unknown> = {}) => {
      events.push({ type, metadata });
    },
  };
  const savedCardAsks: Array<Record<string, unknown>> = [];
  const savedMethods =
    input.savedCard === undefined
      ? undefined
      : {
          disableAutopayForRefund: async (ask: Record<string, unknown>) => {
            savedCardAsks.push(ask);
            if (input.savedCard instanceof Error) throw input.savedCard;
            return input.savedCard;
          },
        };
  const service = new ProviderSubscriptionService(
    prisma as never,
    http as never,
    inbox as never,
    queue as never,
    systemEvents as never,
    savedMethods as never,
  );
  return { service, prisma, rows, transactions, provider, faults, cancelCalls, envelopes, jobs, events, savedCardAsks };
}

const cancelUrl = (providerSubscriptionId: string) => `/subscription/${providerSubscriptionId}/cancel`;

describe('the refund policy', () => {
  it('ends the autopay on every refund, a partial one included (the owner, 23.09.2026)', () => {
    assert.equal(refundEndsAutopay({ full: true }), true);
    assert.equal(refundEndsAutopay({ full: false }), true);
  });

  it('tells the operator what happened to the autopay, and what to do when the provider could not be reached', () => {
    assert.equal(describeAutopayOutcome({ cancelled: [], failed: [] }), null);
    assert.equal(
      describeAutopayOutcome({ cancelled: [{ gatewayType: 'PLATEGA', providerSubscriptionId: 'a' }], failed: [] }),
      'Автосписание отменено: Platega.',
    );
    const failed = describeAutopayOutcome({
      cancelled: [],
      failed: [{ gatewayType: 'ROLLYPAY', providerSubscriptionId: 'b' }],
    });
    assert.match(String(failed), /Автосписание у RollyPay отменить не удалось/);
    assert.match(String(failed), /повторяет отмену каждые 10 минут/);
    assert.match(String(failed), /отмените подписку в личном кабинете провайдера/);
    // Rows the panel could not even read were not marked: nothing for the
    // sweep to retry, so the card does not promise it (R5 nit).
    const unread = describeAutopayOutcome({
      cancelled: [],
      failed: [{ gatewayType: UNKNOWN_AUTOPAY_GATEWAY, providerSubscriptionId: '' }],
    });
    assert.match(String(unread), /Проверить автосписания клиента не удалось/);
    assert.match(String(unread), /личном кабинете Platega или RollyPay/);
    assert.doesNotMatch(String(unread), /повторяет отмену/);
  });

  it('says one thing of the ЮKassa autopay: that it is off, or — winning over it — that switching it off failed (R6 m3)', () => {
    assert.equal(describeAutopayOutcome({ ...NO_AUTOPAY, savedCardAutopayOff: true }), 'Автосписание через ЮKassa выключено.');
    const both = describeAutopayOutcome({ ...NO_AUTOPAY, savedCardAutopayOff: true, savedCardAutopayFailed: true });
    assert.match(String(both), /^Автосписание через ЮKassa выключить не удалось: следующее продление может списать деньги\./);
    assert.match(String(both), /«Способах оплаты»/);
    assert.doesNotMatch(String(both), /выключено/, 'the card said both');
  });

  it('names the ЮKassa charges the switch could not stop, and a card sent before the provider finished (R6 m1, m4)', () => {
    const during = describeAutopayOutcome({ ...NO_AUTOPAY, yookassaChargesDuringRefund: ['pay-7'] });
    assert.equal(
      during,
      'Во время возврата уже шло автосписание через ЮKassa (платёж pay-7) — оно прошло и продлило подписку. ' +
        'Если его тоже нужно вернуть — «Вернуть» у этого платежа.',
    );
    const pending = describeAutopayOutcome({ ...NO_AUTOPAY, yookassaChargesPending: ['pay-8', 'pay-9'] });
    assert.match(String(pending), /платежи pay-8, pay-9\), начатые до возврата, ещё не завершились/);
    assert.match(String(pending), /эти платежи нужно будет вернуть отдельно/);
    const stopped = describeAutopayOutcome({ ...NO_AUTOPAY, providerCancelInterrupted: true });
    assert.match(String(stopped), /не успела завершиться до перезапуска панели/);
    assert.match(String(stopped), /повторяет её каждые 10 минут/);
  });
});

describe('a full refund ends the autopay (ProviderSubscriptionService.cancelForRefund)', () => {
  it('cancels every live autopay of the subscription the payment paid for, and the sign-up it started', async () => {
    mock.method(Logger.prototype, 'log', () => undefined);
    const bound = row('bound');
    // A new purchase's own sign-up, not bound to its subscription yet.
    const unbound = row('unbound', { subscriptionId: null, firstTransactionId: 'tx-new' });
    const elsewhere = row('elsewhere', { subscriptionId: 'sub-2' });
    const w = world({ rows: [bound, unbound, elsewhere] });

    const outcome = await w.service.cancelForRefund({
      id: 'tx-new',
      subscriptionId: 'sub-1',
      gatewayType: PaymentGatewayType.YOOKASSA,
      gatewayData: {},
      planSnapshot: {},
    });

    assert.equal(outcome.failed.length, 0);
    assert.deepEqual(
      outcome.cancelled.map((cancelled) => cancelled.providerSubscriptionId).sort(),
      ['platega-bound', 'platega-unbound'],
    );
    for (const cancelled of [bound, unbound]) {
      assert.equal(cancelled.status, ProviderSubscriptionStatus.CANCELLED);
      assert.equal(cancelled.cancelledBy, REFUND_CANCELLED_BY);
      assert.ok(w.cancelCalls.some((url) => url.endsWith(cancelUrl(cancelled.providerSubscriptionId))));
    }
    assert.equal(elsewhere.status, ProviderSubscriptionStatus.ACTIVE, 'another subscription keeps its autopay');
  });

  it('ends every autopay of the subscription an autopay charge renewed, through its line', async () => {
    mock.method(Logger.prototype, 'log', () => undefined);
    const autopay = row('renewing', { firstTransactionId: 'tx-first' });
    // Another autopay renewing the same subscription: only the charge's line names it.
    const another = row('another', { firstTransactionId: 'tx-other' });
    const w = world({ rows: [autopay, another], items: [{ transactionId: 'tx-charge-2', subscriptionId: 'sub-1' }] });

    const outcome = await w.service.cancelForRefund({
      id: 'tx-charge-2',
      subscriptionId: null,
      gatewayType: PaymentGatewayType.PLATEGA,
      gatewayData: {},
      planSnapshot: { snapshotSource: 'PROVIDER_SUBSCRIPTION_CHARGE', providerSubscriptionId: 'platega-renewing', chargeNumber: 2 },
    });

    assert.equal(outcome.cancelled.length, 2);
    assert.equal(autopay.status, ProviderSubscriptionStatus.CANCELLED);
    assert.equal(another.status, ProviderSubscriptionStatus.CANCELLED);
  });

  it('reports an autopay another door into the same refund ended moments ago, and not one ended long before', async () => {
    // The panel's own refund ends the autopay; the provider's notice of that
    // same refund comes seconds later with nothing left to cancel, and its card
    // still says the autopay is ended.
    const recent = row('recent', {
      status: ProviderSubscriptionStatus.CANCELLED,
      cancelledBy: REFUND_CANCELLED_BY,
      cancelledAt: new Date(Date.now() - 5 * 60 * 1000),
    });
    const old = row('old', {
      status: ProviderSubscriptionStatus.CANCELLED,
      cancelledBy: REFUND_CANCELLED_BY,
      cancelledAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    const w = world({ rows: [recent, old] });

    const outcome = await w.service.cancelForRefund({
      id: 'tx-refunded',
      subscriptionId: 'sub-1',
      gatewayType: PaymentGatewayType.YOOKASSA,
      gatewayData: {},
      planSnapshot: {},
    });

    assert.deepEqual(outcome.cancelled.map((cancelled) => cancelled.providerSubscriptionId), ['platega-recent']);
    assert.deepEqual(w.cancelCalls, [], 'nothing is asked of the provider twice');
  });

  it('tells a charge of an autopay a refund ended from any other charge', async () => {
    const charge = (providerSubscriptionId: string) => ({
      gatewayType: PaymentGatewayType.PLATEGA,
      planSnapshot: { snapshotSource: 'PROVIDER_SUBSCRIPTION_CHARGE', providerSubscriptionId, chargeNumber: 2 },
    });
    const client = {
      providerSubscription: {
        findUnique: async ({ where }: { where: { gatewayType_providerSubscriptionId: { providerSubscriptionId: string } } }) => {
          const id = where.gatewayType_providerSubscriptionId.providerSubscriptionId;
          if (id === 'ended') return { cancelledBy: REFUND_CANCELLED_BY };
          if (id === 'pending-cancel') return { cancelledBy: REFUND_CANCELLED_BY };
          if (id === 'customer-cancelled') return { cancelledBy: 'CUSTOMER' };
          return { cancelledBy: null };
        },
      },
    };

    assert.equal(await autopayEndedByRefund(client as never, charge('ended')), true);
    assert.equal(await autopayEndedByRefund(client as never, charge('pending-cancel')), true);
    assert.equal(await autopayEndedByRefund(client as never, charge('customer-cancelled')), false);
    assert.equal(await autopayEndedByRefund(client as never, charge('live')), false);
    // Not an autopay charge at all: a checkout of its own.
    assert.equal(await autopayEndedByRefund(client as never, { gatewayType: PaymentGatewayType.PLATEGA, planSnapshot: {} }), false);
  });

  it('ends only its own sign-up for a withheld payment: the converter’s autopay stands', async () => {
    mock.method(Logger.prototype, 'log', () => undefined);
    // Both on the trial subscription: the payment that converted it, and the
    // withheld one, which paid for nothing.
    const converter = row('converter', { firstTransactionId: 'tx-first' });
    const withheldOwn = row('withheld', { firstTransactionId: 'tx-second', status: ProviderSubscriptionStatus.PENDING });
    const w = world({ rows: [converter, withheldOwn] });

    await w.service.cancelForRefund({
      id: 'tx-second',
      subscriptionId: 'sub-1',
      gatewayType: PaymentGatewayType.PLATEGA,
      gatewayData: { conversionWithheldAt: '2026-09-01T10:00:00.000Z', trialConvertedByPaymentId: 'payment-first' },
      planSnapshot: { convertsTrial: true },
    });

    assert.equal(withheldOwn.status, ProviderSubscriptionStatus.CANCELLED);
    assert.equal(converter.status, ProviderSubscriptionStatus.ACTIVE);
    assert.equal(converter.cancelledBy, null);
  });

  it('never throws when the provider cannot be reached: reported, marked, and retried by the sweep', async () => {
    mock.method(Logger.prototype, 'error', () => undefined);
    mock.method(Logger.prototype, 'log', () => undefined);
    const autopay = row('down');
    const w = world({ rows: [autopay], refuseCancel: new Set(['platega-down']) });

    const outcome = await w.service.cancelForRefund({
      id: 'tx-refunded',
      subscriptionId: 'sub-1',
      gatewayType: PaymentGatewayType.YOOKASSA,
      gatewayData: {},
      planSnapshot: {},
    });

    assert.deepEqual(outcome.cancelled, []);
    assert.deepEqual(outcome.failed.map((failed) => failed.providerSubscriptionId), ['platega-down']);
    assert.equal(autopay.status, ProviderSubscriptionStatus.ACTIVE, 'the provider did not take it');
    assert.equal(autopay.cancelledBy, REFUND_CANCELLED_BY, 'but the row says a refund asked for it');

    // The next sweep tries again, and this time the provider answers.
    const reachable = world({ rows: [autopay] });
    assert.equal(await reachable.service.cancelStranded(), 1);
    assert.equal(autopay.status, ProviderSubscriptionStatus.CANCELLED);
    assert.equal(autopay.cancelledBy, REFUND_CANCELLED_BY);
  });

  it('files a refund’s pending cancel as stranded above every other reason', () => {
    assert.equal(
      strandedReason({ refundRequested: true, userDeleted: false, userBlocked: false, subscription: 'NOT_YET', planId: 'plan-1' }),
      STRANDED_BY_REFUND,
    );
    assert.equal(
      strandedReason({ userDeleted: false, userBlocked: false, subscription: 'NOT_YET', planId: 'plan-1' }),
      null,
    );
  });
});

describe('a Platega chargeback on a subscription charge', () => {
  const body = (value: unknown) => Buffer.from(JSON.stringify(value));

  it('is told apart from a charge and from a status callback', () => {
    assert.deepEqual(
      extractPlategaSubscriptionDispute(
        PaymentGatewayType.PLATEGA,
        body({ Id: 'pl-tx-9', SubscriptionId: 'sub-1', Amount: 299, Status: 'CHARGEBACKED' }),
      ),
      { providerPaymentId: 'pl-tx-9', providerStatus: 'CHARGEBACKED' },
    );
    assert.equal(
      extractPlategaSubscriptionDispute(
        PaymentGatewayType.PLATEGA,
        body({ Id: 'pl-tx-9', SubscriptionId: 'sub-1', Amount: 299, Status: 'CONFIRMED' }),
      ),
      null,
    );
    assert.equal(
      extractPlategaSubscriptionDispute(PaymentGatewayType.PLATEGA, body({ Id: 'sub-2', Status: 'SUBSCRIPTION_CANCELLED' })),
      null,
    );
    assert.equal(
      extractPlategaSubscriptionDispute(PaymentGatewayType.ROLLYPAY, body({ Id: 'x', Status: 'CHARGEBACKED' })),
      null,
    );
  });


  it('charged once: goes to the refund reversal as a notice for that charge’s payment', async () => {
    const autopay = row('one', { appliedChargeCount: 1, firstTransactionId: 'tx-first' });
    const first = {
      id: 'tx-first',
      paymentId: 'payment-first',
      gatewayType: PaymentGatewayType.PLATEGA,
      gatewayId: 'platega-one',
      status: TransactionStatus.COMPLETED,
      fulfilledAt: new Date('2026-09-01T00:05:00.000Z'),
      purchaseType: PurchaseType.NEW,
    };
    const w = world({ rows: [autopay], transactions: [first], chargesSuccess: 1 });

    await w.service.handleChargeback(PaymentGatewayType.PLATEGA, 'platega-one', {
      providerPaymentId: 'pl-tx-1',
      providerStatus: 'CHARGEBACKED',
    });

    assert.equal(w.envelopes.length, 1);
    assert.equal(w.envelopes[0]?.['paymentId'], 'payment-first');
    assert.equal(w.envelopes[0]?.['eventStatus'], 'CHARGEBACKED');
    assert.equal(w.envelopes[0]?.['providerEventId'], 'subscription:platega-one:dispute:pl-tx-1');
    assert.deepEqual(w.jobs.map((job) => job.name), [PAYMENT_RECONCILIATION_JOB]);
    // The reversal that notice runs ends the autopay; nothing is cancelled here.
    assert.equal(autopay.status, ProviderSubscriptionStatus.ACTIVE);
    assert.deepEqual(w.events, []);
  });

  it('naming one of our payments by its provider id: that payment', async () => {
    const autopay = row('named', { appliedChargeCount: 3 });
    const named = {
      id: 'tx-named',
      paymentId: 'payment-named',
      gatewayType: PaymentGatewayType.PLATEGA,
      gatewayId: 'pl-tx-7',
      status: TransactionStatus.COMPLETED,
      fulfilledAt: new Date('2026-09-01T00:05:00.000Z'),
    };
    const w = world({ rows: [autopay], transactions: [named], chargesSuccess: 3 });

    await w.service.handleChargeback(PaymentGatewayType.PLATEGA, 'platega-named', {
      providerPaymentId: 'pl-tx-7',
      providerStatus: 'CHARGEBACKED',
    });

    assert.equal(w.envelopes[0]?.['paymentId'], 'payment-named');
  });

  it('charged several times, naming none: nothing guessed — the autopay ends and the operator is told', async () => {
    mock.method(Logger.prototype, 'error', () => undefined);
    const autopay = row('many', { appliedChargeCount: 3 });
    const w = world({ rows: [autopay], chargesSuccess: 3 });

    await w.service.handleChargeback(PaymentGatewayType.PLATEGA, 'platega-many', {
      providerPaymentId: 'pl-tx-unknown',
      providerStatus: 'CHARGEBACKED',
    });

    assert.deepEqual(w.envelopes, [], 'no charge was picked at random');
    assert.equal(autopay.status, ProviderSubscriptionStatus.CANCELLED);
    assert.equal(autopay.cancelledBy, REFUND_CANCELLED_BY);
    assert.deepEqual(w.events.map((event) => event.type), ['payment.chargeback_unmatched']);
    assert.equal(w.events[0]?.metadata['chargeCount'], 3);
    assert.match(String(w.events[0]?.metadata['note']), /одного из 3 списаний/);
    assert.match(String(w.events[0]?.metadata['note']), /Автосписание отменено: Platega\./);
  });
});

describe('the chargeback handling, in wave 6b (R5)', () => {
  it('applies the charges the provider took before asking which one is disputed (H1)', async () => {
    // Charged twice by now, the second charge not seen yet: counted before the
    // match, the dispute cannot be pinned on the first payment by a count of one.
    mock.method(Logger.prototype, 'error', () => undefined);
    mock.method(Logger.prototype, 'warn', () => undefined);
    const autopay = row('late', { appliedChargeCount: 1, firstTransactionId: 'tx-first' });
    const first = {
      id: 'tx-first',
      paymentId: 'payment-first',
      gatewayType: PaymentGatewayType.PLATEGA,
      gatewayId: 'platega-late',
      status: TransactionStatus.COMPLETED,
      fulfilledAt: new Date('2026-09-01T00:05:00.000Z'),
    };
    const w = world({ rows: [autopay], transactions: [first], chargesSuccess: 2 });

    await w.service.handleChargeback(PaymentGatewayType.PLATEGA, 'platega-late', {
      providerPaymentId: 'pl-tx-unknown',
      providerStatus: 'CHARGEBACKED',
    });

    assert.equal(autopay.appliedChargeCount, 2, 'the charge the provider took was applied first');
    assert.deepEqual(
      w.envelopes.filter((envelope) => String(envelope['providerEventId']).includes(':dispute:')),
      [],
      'the dispute was pinned on the first payment',
    );
    assert.deepEqual(w.events.map((event) => event.type), ['payment.chargeback_unmatched']);
    assert.equal(w.events[0]?.metadata['chargeCount'], 2);
  });

  it('never takes the subscription\'s own id for the payment it disputes', async () => {
    // A Platega sign-up's checkout carries the subscription's id as its
    // provider id: a dispute naming the subscription must not reverse it.
    mock.method(Logger.prototype, 'error', () => undefined);
    const autopay = row('named-sub', { appliedChargeCount: 3, firstTransactionId: 'tx-first' });
    const first = {
      id: 'tx-first',
      paymentId: 'payment-first',
      gatewayType: PaymentGatewayType.PLATEGA,
      gatewayId: 'platega-named-sub',
      status: TransactionStatus.COMPLETED,
      fulfilledAt: new Date('2026-09-01T00:05:00.000Z'),
    };
    const w = world({ rows: [autopay], transactions: [first], chargesSuccess: 3 });

    await w.service.handleChargeback(PaymentGatewayType.PLATEGA, 'platega-named-sub', {
      providerPaymentId: 'platega-named-sub',
      providerStatus: 'CHARGEBACKED',
    });

    assert.deepEqual(w.envelopes, [], 'the first payment was reversed for a charge nobody named');
    assert.deepEqual(w.events.map((event) => event.type), ['payment.chargeback_unmatched']);
  });

  it('tells the operator once, however often the same dispute is handled (F5)', async () => {
    mock.method(Logger.prototype, 'error', () => undefined);
    mock.method(Logger.prototype, 'log', () => undefined);
    const autopay = row('told', { appliedChargeCount: 3 });
    const w = world({ rows: [autopay], chargesSuccess: 3 });
    const dispute = { providerPaymentId: 'pl-tx-unknown', providerStatus: 'CHARGEBACKED' };

    await w.service.handleChargeback(PaymentGatewayType.PLATEGA, 'platega-told', dispute);
    await w.service.handleChargeback(PaymentGatewayType.PLATEGA, 'platega-told', dispute);

    assert.equal(w.events.length, 1, `the operator got ${w.events.length} cards for one chargeback`);
    assert.match(String(w.events[0]?.metadata['note']), /Автосписание отменено: Platega\./);
  });

  it('tells nothing from a run that failed, and the run that retries it tells', async () => {
    mock.method(Logger.prototype, 'error', () => undefined);
    const autopay = row('retried', { appliedChargeCount: 3 });
    const w = world({ rows: [autopay], chargesSuccess: 3 });
    const dispute = { providerPaymentId: 'pl-tx-unknown', providerStatus: 'CHARGEBACKED' };
    w.faults.findMany = 1;

    await assert.rejects(w.service.handleChargeback(PaymentGatewayType.PLATEGA, 'platega-retried', dispute));
    assert.equal(w.events.length, 0, 'a card for a run that did not end the autopay');
    await w.service.handleChargeback(PaymentGatewayType.PLATEGA, 'platega-retried', dispute);

    assert.deepEqual(w.events.map((event) => event.type), ['payment.chargeback_unmatched']);
    assert.equal(autopay.status, ProviderSubscriptionStatus.CANCELLED);
  });

  it('switches off the saved-card autopay too — a chargeback is a refund — and the card says so (the owner, 23.09.2026)', async () => {
    mock.method(Logger.prototype, 'error', () => undefined);
    const autopay = row('card', { appliedChargeCount: 3 });
    const w = world({ rows: [autopay], chargesSuccess: 3, savedCard: { switched: 1, busy: 0 } });

    await w.service.handleChargeback(PaymentGatewayType.PLATEGA, 'platega-card', {
      providerPaymentId: 'pl-tx-unknown',
      providerStatus: 'CHARGEBACKED',
    });

    assert.deepEqual(w.savedCardAsks, [{ userId: 'user-1', providerSubscriptionId: 'platega-card' }]);
    assert.equal(w.events[0]?.metadata['savedCardAutopayOff'], true);
    assert.match(String(w.events[0]?.metadata['note']), /Автосписание через ЮKassa выключено\./);
  });

  it('says nothing of the ЮKassa autopay when there was none to switch off', async () => {
    mock.method(Logger.prototype, 'error', () => undefined);
    const autopay = row('nocard', { appliedChargeCount: 3 });
    const w = world({ rows: [autopay], chargesSuccess: 3, savedCard: { switched: 0, busy: 0 } });

    await w.service.handleChargeback(PaymentGatewayType.PLATEGA, 'platega-nocard', {
      providerPaymentId: 'pl-tx-unknown',
      providerStatus: 'CHARGEBACKED',
    });

    assert.equal(w.events[0]?.metadata['savedCardAutopayOff'], undefined);
    assert.doesNotMatch(String(w.events[0]?.metadata['note']), /ЮKassa/);
  });

  it('says a failed switch of the ЮKassa autopay, and what the customer can do', async () => {
    mock.method(Logger.prototype, 'error', () => undefined);
    const autopay = row('cardfail', { appliedChargeCount: 3 });
    const w = world({ rows: [autopay], chargesSuccess: 3, savedCard: new Error('the database is not answering') });

    await w.service.handleChargeback(PaymentGatewayType.PLATEGA, 'platega-cardfail', {
      providerPaymentId: 'pl-tx-unknown',
      providerStatus: 'CHARGEBACKED',
    });

    assert.equal(w.events[0]?.metadata['savedCardAutopayFailed'], true);
    assert.equal(w.events[0]?.metadata['savedCardAutopayOff'], undefined);
    assert.match(String(w.events[0]?.metadata['note']), /Автосписание через ЮKassa выключить не удалось/);
  });

  it('keys a dispute that names the subscription itself by its payload: two such are two events and two cards, a true repeat one (R6 m2)', async () => {
    mock.method(Logger.prototype, 'error', () => undefined);
    const autopay = row('self', { appliedChargeCount: 3 });
    const w = world({ rows: [autopay], chargesSuccess: 3 });
    const dispute = { providerPaymentId: 'platega-self', providerStatus: 'CHARGEBACKED' };
    const first = { Id: 'platega-self', SubscriptionId: 'platega-self', Status: 'CHARGEBACKED', ChargebackAt: '2026-10-01T10:00:00Z' };
    const second = { ...first, ChargebackAt: '2026-10-02T10:00:00Z' };

    await w.service.recordDispute(PaymentGatewayType.PLATEGA, 'platega-self', dispute, first);
    await w.service.recordDispute(PaymentGatewayType.PLATEGA, 'platega-self', dispute, second);
    const repeat = await w.service.recordDispute(PaymentGatewayType.PLATEGA, 'platega-self', dispute, second);

    assert.equal(repeat.duplicate, true);
    const keys = w.envelopes.map((envelope) => String(envelope['providerEventId']));
    assert.equal(new Set(keys).size, 2, `two disputes shared one inbox event: ${keys.join(', ')}`);
    assert.ok(keys.every((key) => !key.endsWith(':platega-self')), 'keyed by the subscription\'s own id');

    await w.service.handleChargeback(PaymentGatewayType.PLATEGA, 'platega-self', dispute);
    await w.service.handleChargeback(PaymentGatewayType.PLATEGA, 'platega-self', dispute);
    assert.equal(w.events.length, 2, 'the second dispute was taken for the first, told already');
  });

  it('tells every dispute that names no charge of the provider\'s: one cannot be told from the next', async () => {
    mock.method(Logger.prototype, 'error', () => undefined);
    const autopay = row('unnamed', { appliedChargeCount: 3 });
    const w = world({ rows: [autopay], chargesSuccess: 3 });
    const dispute = { providerPaymentId: null, providerStatus: 'CHARGEBACKED' };

    await w.service.handleChargeback(PaymentGatewayType.PLATEGA, 'platega-unnamed', dispute);
    await w.service.handleChargeback(PaymentGatewayType.PLATEGA, 'platega-unnamed', dispute);

    assert.equal(w.events.length, 2);
  });
});

describe('a Platega dispute is kept in the payment inbox until it is handled (R5 F6)', () => {
  const dispute = { providerPaymentId: 'pl-tx-9', providerStatus: 'CHARGEBACKED' };
  const body = { Id: 'pl-tx-9', SubscriptionId: 'platega-1', Amount: 299, Status: 'CHARGEBACKED' };

  it('is recorded under the dispute\'s own key and queued for reconciliation; Platega repeating it is one event', async () => {
    const w = world({ rows: [] });

    const recorded = await w.service.recordDispute(PaymentGatewayType.PLATEGA, 'platega-1', dispute, body);
    const again = await w.service.recordDispute(PaymentGatewayType.PLATEGA, 'platega-1', dispute, body);

    assert.equal(recorded.duplicate, false);
    assert.equal(again.duplicate, true);
    assert.equal(w.envelopes.length, 1);
    const envelope = w.envelopes[0]!;
    assert.equal(envelope['paymentId'], 'platega-1');
    assert.equal(envelope['providerEventId'], 'subscription:platega-1:dispute-callback:pl-tx-9');
    assert.equal(envelope['eventStatus'], 'CHARGEBACKED');
    assert.deepEqual((envelope['rawPayload'] as Record<string, unknown>)['body'], body);
    assert.deepEqual(w.jobs.map((job) => job.name), [PAYMENT_RECONCILIATION_JOB]);
    assert.deepEqual(readProviderSubscriptionDispute(envelope['rawPayload']), {
      providerSubscriptionId: 'platega-1',
      chargeback: dispute,
    });
  });

  it('is told from every other inbox event, and one that says it is a dispute and is not is refused', () => {
    assert.equal(readProviderSubscriptionDispute({ source: 'PROVIDER_SUBSCRIPTION', status: 'CONFIRMED' }), null);
    assert.equal(readProviderSubscriptionDispute({ event: 'refund.succeeded' }), null);
    assert.throws(() => readProviderSubscriptionDispute({ source: PROVIDER_SUBSCRIPTION_DISPUTE, status: 'CHARGEBACKED' }));
  });

  it('its reconciliation hands it to the chargeback handling; a Platega that does not answer leaves it FAILED for a retry', async () => {
    mock.method(Logger.prototype, 'error', () => undefined);
    const event = {
      id: 'event-dispute',
      gatewayType: PaymentGatewayType.PLATEGA,
      paymentId: 'platega-1',
      providerEventId: 'subscription:platega-1:dispute-callback:pl-tx-9',
      eventStatus: 'CHARGEBACKED',
      rawPayload: {
        source: PROVIDER_SUBSCRIPTION_DISPUTE,
        providerSubscriptionId: 'platega-1',
        providerPaymentId: 'pl-tx-9',
        status: 'CHARGEBACKED',
        body,
      },
    };
    const inbox = { processed: [] as string[], failed: [] as string[], alerts: [] as string[] };
    const handled: unknown[] = [];
    const platega = { answers: false };
    const reconciliation = new PaymentReconciliationService(
      { paymentWebhookEvent: { findUnique: async () => event } } as never,
      {
        incrementReconciliationAttempts: async () => undefined,
        markProcessing: async () => undefined,
        markProcessed: async (id: string) => {
          inbox.processed.push(id);
        },
        markFailed: async (id: string) => {
          inbox.failed.push(id);
          return { ...event, status: 'FAILED' };
        },
      } as never,
      {} as never,
      {
        notifyWebhookFailed: async (input: { readonly event: { readonly id: string } }) => {
          inbox.alerts.push(input.event.id);
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        handleChargeback: async (gatewayType: PaymentGatewayType, id: string, chargeback: unknown) => {
          if (!platega.answers) throw new Error('Platega did not answer');
          handled.push([gatewayType, id, chargeback]);
        },
      } as never,
    );

    await assert.rejects(reconciliation.reconcileWebhookEvent('event-dispute'), /Platega did not answer/);
    assert.deepEqual(inbox.failed, ['event-dispute'], 'kept FAILED: retried, counted, replayable');
    assert.deepEqual(inbox.alerts, ['event-dispute']);
    assert.deepEqual(inbox.processed, []);

    platega.answers = true;
    await reconciliation.reconcileWebhookEvent('event-dispute');

    assert.deepEqual(handled, [[PaymentGatewayType.PLATEGA, 'platega-1', dispute]]);
    assert.deepEqual(inbox.processed, ['event-dispute']);
  });
});

describe('a refund\'s mark outlives whoever finishes the cancel (R5 F1)', () => {
  it('the provider reporting the cancel the operator made in its dashboard: the mark stays, and a charge taken before it is withheld', async () => {
    mock.method(Logger.prototype, 'error', () => undefined);
    mock.method(Logger.prototype, 'log', () => undefined);
    const autopay = row('dashboard', { appliedChargeCount: 1 });
    const w = world({ rows: [autopay], refuseCancel: new Set(['platega-dashboard']) });

    const outcome = await w.service.cancelForRefund({
      id: 'tx-refunded',
      subscriptionId: 'sub-1',
      gatewayType: PaymentGatewayType.YOOKASSA,
      gatewayData: {},
      planSnapshot: {},
    });
    assert.deepEqual(outcome.failed.map((failed) => failed.providerSubscriptionId), ['platega-dashboard']);
    // The card told the operator to cancel at the provider, and they did; the
    // provider had charged the next period before that.
    w.provider.status = 'CANCELLED';
    w.provider.chargesSuccess = 2;

    await w.service.syncRow({ ...autopay } as never);

    assert.equal(autopay.status, ProviderSubscriptionStatus.CANCELLED);
    assert.ok(autopay.cancelledAt instanceof Date);
    assert.equal(autopay.cancelledBy, REFUND_CANCELLED_BY, `the refund's mark was written over with ${autopay.cancelledBy}`);
    const charge = w.transactions.find((candidate) => candidate['idempotencyKey'] === 'provider-subscription:dashboard:charge:2');
    assert.ok(charge, 'the charge the provider took was applied');
    assert.equal(await autopayEndedByRefund(w.prisma as never, charge as never), true, 'the charge would renew the refunded subscription');
  });

  it('a look that read the row before the refund marked it does not write over the mark', async () => {
    const autopay = row('stale', { cancelledBy: REFUND_CANCELLED_BY });
    const w = world({ rows: [autopay] });
    w.provider.status = 'CANCELLED';

    await w.service.syncRow({ ...autopay, cancelledBy: null } as never);

    assert.equal(autopay.status, ProviderSubscriptionStatus.CANCELLED);
    assert.equal(autopay.cancelledBy, REFUND_CANCELLED_BY);
  });

  it('the customer\'s «Отключить автосписание» on an autopay a refund is still cancelling: the mark stays', async () => {
    const marked = row('customer', { cancelledBy: REFUND_CANCELLED_BY });
    const plain = row('plain');
    const w = world({ rows: [marked, plain] });

    await w.service.cancelForCustomer('user-1', 'customer');
    await w.service.cancelForCustomer('user-1', 'plain');

    assert.equal(marked.status, ProviderSubscriptionStatus.CANCELLED);
    assert.equal(marked.cancelledBy, REFUND_CANCELLED_BY);
    assert.equal(plain.cancelledBy, 'CUSTOMER', 'any other cancel still says who made it');
    assert.ok(w.cancelCalls.some((url) => url.endsWith(cancelUrl('platega-customer'))));
  });
});

describe('one refund asks the provider once per autopay (R5 F2, F3, H3)', () => {
  it('a sign-up bound to the subscription it paid for is asked once, and a failure is counted once', async () => {
    mock.method(Logger.prototype, 'error', () => undefined);
    const own = row('own', { firstTransactionId: 'tx-refunded' });
    const w = world({ rows: [own], refuseCancel: new Set(['platega-own']) });

    const outcome = await w.service.cancelForRefund({
      id: 'tx-refunded',
      subscriptionId: 'sub-1',
      gatewayType: PaymentGatewayType.PLATEGA,
      gatewayData: {},
      planSnapshot: {},
    });

    assert.equal(w.cancelCalls.length, 1, `the provider was asked ${w.cancelCalls.length} times`);
    assert.deepEqual(outcome.failed.map((failed) => failed.providerSubscriptionId), ['platega-own']);
  });

  it('an autopay the other door cancelled while this one\'s request failed is reported cancelled, not failed', async () => {
    mock.method(Logger.prototype, 'error', () => undefined);
    const raced = row('raced');
    const w = world({
      rows: [raced],
      refuseCancel: new Set(['platega-raced']),
      onCancel: () => {
        // The panel's own refund landed its cancel while the notice's request failed.
        Object.assign(raced, {
          status: ProviderSubscriptionStatus.CANCELLED,
          cancelledBy: REFUND_CANCELLED_BY,
          cancelledAt: new Date(),
        });
      },
    });

    const outcome = await w.service.cancelForRefund({
      id: 'tx-refunded',
      subscriptionId: 'sub-1',
      gatewayType: PaymentGatewayType.YOOKASSA,
      gatewayData: {},
      planSnapshot: {},
    });

    assert.deepEqual(outcome.cancelled.map((cancelled) => cancelled.providerSubscriptionId), ['platega-raced']);
    assert.deepEqual(outcome.failed, [], 'the card said both: cancelled, and could not be cancelled');
  });

  it('never throws when its own reads fail: the card says the provider could not be asked', async () => {
    mock.method(Logger.prototype, 'error', () => undefined);
    const w = world({ rows: [row('unread')] });
    w.faults.findMany = 1;

    const outcome = await w.service.cancelForRefund({
      id: 'tx-refunded',
      subscriptionId: 'sub-1',
      gatewayType: PaymentGatewayType.YOOKASSA,
      gatewayData: {},
      planSnapshot: {},
    });

    assert.deepEqual(outcome.cancelled, []);
    assert.deepEqual(outcome.failed.map((failed) => failed.gatewayType), [UNKNOWN_AUTOPAY_GATEWAY]);
  });

  it('an operator\'s request marks every autopay the refund ends, and asks the provider nothing', async () => {
    const bound = row('bound');
    const unbound = row('unbound', { subscriptionId: null, firstTransactionId: 'tx-new' });
    const elsewhere = row('elsewhere', { subscriptionId: 'sub-2' });
    const w = world({ rows: [bound, unbound, elsewhere] });

    const marked = await w.service.markForRefund({
      id: 'tx-new',
      subscriptionId: 'sub-1',
      gatewayType: PaymentGatewayType.YOOKASSA,
      gatewayData: {},
      planSnapshot: {},
    });

    assert.deepEqual([...marked].sort(), ['bound', 'unbound']);
    for (const ended of [bound, unbound]) {
      assert.equal(ended.status, ProviderSubscriptionStatus.ACTIVE);
      assert.equal(ended.cancelledBy, REFUND_CANCELLED_BY);
    }
    assert.equal(elsewhere.cancelledBy, null);
    assert.deepEqual(w.cancelCalls, [], 'the request waited on the provider');
  });
});
