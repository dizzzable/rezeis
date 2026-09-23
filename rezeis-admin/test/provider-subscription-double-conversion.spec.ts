import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  Currency,
  PaymentGatewayType,
  PlanAvailability,
  PlanType,
  ProviderSubscription,
  ProviderSubscriptionStatus,
  PurchaseChannel,
  PurchaseType,
  SubscriptionStatus,
  TransactionStatus,
} from '@prisma/client';
import { of } from 'rxjs';

import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { PaymentsTransactionsService } from '../src/modules/payments/services/payments-transactions.service';
import { ProviderSubscriptionService } from '../src/modules/payments/services/provider-subscription.service';
import { readProviderSubscriptionTerms } from '../src/modules/payments/utils/provider-subscription-terms.util';
import { describeGatewayDataStatement } from '../src/modules/payments/utils/transaction-gateway-data.util';
import { PricingService } from '../src/modules/plans/services/pricing.service';
import { SubscriptionQuoteService } from '../src/modules/subscriptions/services/subscription-quote.service';

/**
 * A trial converts once.
 *
 * The money review (R-money F1) found two provider sign-ups on one trial both
 * admitted: the checkout guard counted ACTIVE rows only, so a second
 * «для автоматического списания» started while the first still waited for its
 * payer. Confirmed together, each first charge converted the trial — the second
 * restarting the term the first had paid for — and both kept renewing it.
 *
 * Closed twice over: a conversion sign-up is refused while another one for the
 * same trial waits; and fulfilment does not restart the term of a trial another
 * payment converted first. That payment is withheld — received, settled, applied
 * to nothing, the operator told once to refund it (R2-support-money M1: it used
 * to fail the notification instead, and a default install told nobody). A trial
 * that stopped being one without a payment (a plan migration) is converted as
 * it always was.
 */

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-09-01T10:00:00.000Z');

function plan(id: string, prices: Array<[number, string]>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    orderIndex: 1,
    name: id,
    description: null,
    tag: null,
    isActive: true,
    deletedAt: null,
    isArchived: false,
    archivedRenewMode: 'SELF_RENEW',
    type: PlanType.BOTH,
    availability: PlanAvailability.ALL,
    trafficLimit: 1024,
    deviceLimit: 1,
    trafficLimitStrategy: 'NO_RESET',
    internalSquads: [],
    externalSquad: null,
    upgradeToPlanIds: [],
    replacementPlanIds: [],
    allowedUserIds: [],
    trialSettings: {},
    createdAt: new Date(T0),
    updatedAt: new Date(T0),
    durations: prices.map(([days, price]) => ({
      id: `${id}-${days}`,
      planId: id,
      days,
      prices: [{ id: `${id}-${days}-rub`, planDurationId: `${id}-${days}`, currency: Currency.RUB, price: { toString: () => price } }],
    })),
    ...extra,
  };
}

function selected(select: Record<string, boolean> | undefined, row: Record<string, unknown>): Record<string, unknown> {
  if (select === undefined) return row;
  return Object.fromEntries(Object.entries(row).filter(([key]) => select[key] === true));
}

/** Prisma's `where` for the shapes these services use: equality, `in`, `not`, `gt`. */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      const condition = value as { in?: unknown[]; not?: unknown; gt?: Date };
      if (condition.in !== undefined) return condition.in.includes(row[key]);
      if ('not' in condition) return row[key] !== condition.not;
      if (condition.gt !== undefined) return (row[key] as Date).getTime() > condition.gt.getTime();
      throw new Error(`unsupported where clause on ${key}: ${JSON.stringify(value)}`);
    }
    return row[key] === value;
  });
}

/** The buyer holds `trial-sub` (a trial) — or, with `paidSource`, `trial-sub` is already a paid subscription on plan-a. */
function world(options: { readonly paidSource?: boolean } = {}) {
  const subscriptions: Array<Record<string, unknown>> = [
    {
      id: 'trial-sub',
      userId: 'user-1',
      status: SubscriptionStatus.ACTIVE,
      isTrial: options.paidSource !== true,
      planSnapshot: { id: options.paidSource === true ? 'plan-a' : 'trial-plan' },
      createdAt: new Date(T0),
      expiresAt: new Date(T0 + 40 * DAY),
    },
  ];
  const plans = [
    plan('trial-plan', [[3, '0']], { availability: PlanAvailability.TRIAL }),
    plan('plan-a', [[30, '199']], { upgradeToPlanIds: ['plan-b'] }),
    plan('plan-b', [[30, '299'], [90, '799']]),
  ];
  const transactions: Array<Record<string, unknown>> = [];
  const rows: ProviderSubscription[] = [];
  const createTransaction = (data: Record<string, unknown>) => {
    const row = {
      id: `tx-${transactions.length + 1}`,
      paymentId: `payment-${transactions.length + 1}`,
      gatewayId: null,
      fulfilledAt: null,
      idempotencyKey: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    };
    transactions.push(row);
    return row;
  };
  const prisma: Record<string, unknown> = {
    settings: { findFirst: async () => ({ multiSubscriptionSettings: null }) },
    user: {
      findUnique: async () => ({ id: 'user-1', maxSubscriptions: 1, purchaseDiscount: 0, personalDiscount: 0, pendingDiscounts: [] }),
    },
    subscription: {
      findMany: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) =>
        subscriptions.filter((row) => matches(row, where)).map((row) => selected(select, row)),
      findFirst: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
        const found = subscriptions.find((row) => matches(row, where));
        return found === undefined ? null : selected(select, found);
      },
    },
    plan: {
      findMany: async ({ where }: { where?: Record<string, unknown> } = {}) =>
        plans.filter((row) => {
          const ids = (where?.id as { in?: string[] } | undefined)?.in;
          return ids === undefined || ids.includes(row.id as string);
        }),
      findUnique: async ({ where }: { where: { id: string } }) => plans.find((row) => row.id === where.id) ?? null,
    },
    paymentGateway: {
      findMany: async () => [{ id: 'gw-1', type: PaymentGatewayType.PLATEGA, currency: Currency.RUB, isActive: true, orderIndex: 1 }],
    },
    planDuration: { findMany: async () => [] },
    transaction: {
      findMany: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) =>
        transactions.filter((row) => matches(row, where)).map((row) => selected(select, row)),
      create: async ({ data }: { data: Record<string, unknown> }) => createTransaction(data),
    },
    providerSubscription: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `ps-${rows.length + 1}`,
          appliedChargeCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        } as unknown as ProviderSubscription;
        rows.push(row);
        return row;
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((row) => matches(row as unknown as Record<string, unknown>, where)) ?? null,
    },
  };
  const catalog = {
    getCatalogPlans: async () =>
      plans.filter((row) => row.availability !== PlanAvailability.TRIAL).map((row) => ({ id: row.id })),
  };
  const quote = new SubscriptionQuoteService(prisma as never, catalog as never, new PricingService());
  const drafts = new PaymentsTransactionsService(prisma as never, quote);
  const service = new ProviderSubscriptionService(prisma as never, { get: () => of({ data: {} }) } as never, {} as never, {} as never);

  /** An ordinary card payment of the same UPGRADE: the draft alone. */
  const payOnce = async (durationDays: number) => {
    const draft = await drafts.createCheckoutDraft({
      userId: 'user-1',
      purchaseType: PurchaseType.UPGRADE,
      sourceSubscriptionId: 'trial-sub',
      planId: 'plan-b',
      durationDays,
      gatewayType: PaymentGatewayType.PLATEGA,
      channel: PurchaseChannel.WEB,
    });
    return transactions.find((row) => row.paymentId === draft.paymentId)!;
  };

  /**
   * What `PaymentsCheckoutService.checkout` does for «для автоматического
   * списания» on a conversion, in its order: the draft, the guard (with the
   * option the checkout passes for an UPGRADE), the stored link for a re-tap,
   * else the provider's subscription, recorded.
   */
  const signUp = async (durationDays: number) => {
    const draft = await drafts.createCheckoutDraft(
      {
        userId: 'user-1',
        purchaseType: PurchaseType.UPGRADE,
        sourceSubscriptionId: 'trial-sub',
        planId: 'plan-b',
        durationDays,
        gatewayType: PaymentGatewayType.PLATEGA,
        channel: PurchaseChannel.WEB,
      },
      { providerSubscription: true },
    );
    const transaction = transactions.find((row) => row.paymentId === draft.paymentId)!;
    await service.assertNoLiveSubscriptionFor(readProviderSubscriptionTerms(transaction.planSnapshot)?.subscriptionId ?? null, {
      pendingOtherThan: transaction.id as string,
    });
    if (transaction.gatewayId !== null) return transaction;
    transaction.gatewayId = `platega-${transaction.id}`;
    await service.recordCheckout(transaction as never);
    return transaction;
  };
  return { service, transactions, rows, signUp, payOnce };
}

function refusalReason(error: unknown): unknown {
  assert.ok(error instanceof BadRequestException);
  assert.equal((error.getResponse() as { code?: unknown }).code, 'AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE');
  return (error.getResponse() as { reason?: unknown }).reason;
}

describe('a second sign-up converting the same trial', () => {
  it('is refused while the first still waits for its payer', async () => {
    const w = world();
    await w.signUp(30);

    await assert.rejects(w.signUp(90), (error: unknown) => refusalReason(error) === 'PENDING_SIGN_UP');
    assert.deepEqual(w.rows.map((row) => row.subscriptionId), ['trial-sub']);
  });

  it('lets the payer open the same sign-up again', async () => {
    const w = world();
    const first = await w.signUp(30);

    const again = await w.signUp(30);

    assert.equal(again.paymentId, first.paymentId);
    assert.equal(w.rows.length, 1);
  });

  it('is let through once the first sign-up has outlived its checkout', async () => {
    const w = world();
    await w.signUp(30);
    // Its checkout expired half an hour ago: a payer who walked away is not held.
    (w.rows[0] as unknown as { createdAt: Date }).createdAt = new Date(Date.now() - 31 * 60 * 1000);

    await w.signUp(90);

    assert.equal(w.rows.length, 2);
  });

  it('is refused while the first is live', async () => {
    const w = world();
    await w.signUp(30);
    (w.rows[0] as unknown as { status: ProviderSubscriptionStatus }).status = ProviderSubscriptionStatus.ACTIVE;

    await assert.rejects(w.signUp(90), (error: unknown) => refusalReason(error) === 'ALREADY_ACTIVE');
  });

  it("marks a conversion on its draft — autopay or a card — and not a change of a paid plan", async () => {
    const withAutopay = await world().signUp(30);
    assert.equal((withAutopay.planSnapshot as Record<string, unknown>).convertsTrial, true);

    const byCard = await world().payOnce(30);
    assert.equal((byCard.planSnapshot as Record<string, unknown>).convertsTrial, true);

    const paidPlanChange = await world({ paidSource: true }).payOnce(30);
    assert.equal((paidPlanChange.planSnapshot as Record<string, unknown>).convertsTrial, undefined);
  });
});

describe('fulfilling a conversion', () => {
  interface Upgrade {
    readonly paymentId: string;
    readonly gatewayData?: Record<string, unknown>;
  }

  interface RaisedEvent {
    readonly severity: string;
    readonly type: string;
    readonly message: string;
    readonly metadata: Record<string, unknown>;
  }

  function fulfilment(options: {
    readonly isTrial: boolean;
    readonly convertsTrial: boolean;
    /** Other UPGRADE payments on this subscription, COMPLETED and fulfilled, oldest first. */
    readonly otherUpgrades?: readonly Upgrade[];
    readonly gatewayType?: PaymentGatewayType;
    readonly amount?: string;
    /** This payment's own `gatewayData`, as an earlier run may have left it. */
    readonly gatewayData?: Record<string, unknown>;
  }) {
    const writes: Array<Record<string, unknown>> = [];
    const locks: string[] = [];
    const events: RaisedEvent[] = [];
    const converterQueries: Array<Record<string, unknown>> = [];
    const subscription = {
      id: 'trial-sub',
      userId: 'user-1',
      status: SubscriptionStatus.ACTIVE,
      isTrial: options.isTrial,
      remnawaveId: 'rw-1',
      expiresAt: new Date(T0 + 40 * DAY),
      planSnapshot: { id: options.isTrial ? 'trial-plan' : 'plan-b' },
    };
    const tx = {
      $queryRaw: async (query: { readonly sql?: string }) => {
        const sql = String(query?.sql ?? query).replace(/\s+/g, ' ');
        assert.match(sql, /FROM "subscriptions"/);
        assert.match(sql, /\bFOR\s+UPDATE\b/i);
        locks.push('subscriptions');
        return [{ id: subscription.id }];
      },
      $executeRaw: async (statement: unknown) => {
        const described = describeGatewayDataStatement(statement);
        assert.ok(described, 'gatewayData is written through writeTransactionGatewayData');
        writes.push({ gatewayData: { transactionId: described.transactionId, ...described.merge } });
        return 1;
      },
      subscription: {
        findUnique: async () => ({ ...subscription }),
        update: async ({ data }: { data: Record<string, unknown> }) => {
          writes.push({ subscription: data });
          return { ...subscription, ...data };
        },
      },
      profileSyncJob: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          writes.push({ syncJob: data });
          return { id: 'job-1', ...data };
        },
      },
      transaction: {
        update: async ({ data }: { data: Record<string, unknown> }) => {
          writes.push({ transaction: data });
          return data;
        },
        findMany: async ({ where }: { where: Record<string, unknown> }) => {
          converterQueries.push(where);
          return (options.otherUpgrades ?? []).map((upgrade) => ({
            paymentId: upgrade.paymentId,
            gatewayData: upgrade.gatewayData ?? {},
          }));
        },
        findUnique: async () => ({ gatewayData: options.gatewayData ?? {} }),
      },
    };
    const purchasedPlan = {
      id: 'plan-b',
      name: 'plan-b',
      description: null,
      tag: null,
      type: PlanType.BOTH,
      icon: null,
      availability: PlanAvailability.ALL,
      trafficLimit: 1024,
      deviceLimit: 1,
      trafficLimitStrategy: 'NO_RESET',
      internalSquads: [],
      externalSquad: null,
    };
    const record = (severity: string) => (type: string, _category: string, message: string, metadata: Record<string, unknown> = {}) => {
      events.push({ severity, type, message, metadata });
    };
    const service = new PaymentSubscriptionMutationService(
      {
        $transaction: async (run: (client: unknown) => unknown) => run(tx),
        transactionItem: { findMany: async () => [] },
        plan: { findUnique: async () => purchasedPlan },
      } as never,
      { info: record('INFO'), warn: record('WARNING'), error: record('ERROR') } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const transaction = {
      id: 'tx-2',
      paymentId: 'payment-2',
      userId: 'user-1',
      subscriptionId: 'trial-sub',
      purchaseType: PurchaseType.UPGRADE,
      gatewayType: options.gatewayType ?? PaymentGatewayType.PLATEGA,
      channel: PurchaseChannel.WEB,
      amount: options.amount ?? '799',
      currency: Currency.RUB,
      planSnapshot: {
        id: 'plan-b',
        selectedDurationDays: 90,
        ...(options.convertsTrial ? { convertsTrial: true } : {}),
      },
    };
    const upgrade = (
      service as unknown as {
        upgradeSubscriptionFromPayment(input: {
          transaction: unknown;
          purchasedPlan: unknown;
          selectedDurationDays: number;
        }): Promise<Record<string, unknown>>;
      }
    ).upgradeSubscriptionFromPayment.bind(service);
    const run = () => upgrade({ transaction, purchasedPlan, selectedDurationDays: 90 });
    const complete = () => service.applyCompletedTransaction(transaction as never);
    return { run, complete, writes, locks, events, converterQueries };
  }

  const FIRST_PAYMENT: Upgrade = { paymentId: 'payment-1' };

  it('withholds one whose trial another payment converted first: settled and marked, the subscription untouched', async () => {
    const f = fulfilment({ isTrial: false, convertsTrial: true, otherUpgrades: [FIRST_PAYMENT] });

    const outcome = await f.run();

    assert.deepEqual(outcome, {
      kind: 'WITHHELD',
      subscriptionId: 'trial-sub',
      convertedByPaymentId: 'payment-1',
      announce: true,
    });
    assert.deepEqual(f.locks, ['subscriptions']);
    assert.deepEqual(f.converterQueries, [
      {
        subscriptionId: 'trial-sub',
        purchaseType: PurchaseType.UPGRADE,
        status: TransactionStatus.COMPLETED,
        fulfilledAt: { not: null },
        id: { not: 'tx-2' },
      },
    ]);
    // Nothing of the subscription: no plan, no term, no profile sync.
    assert.equal(f.writes.some((write) => 'subscription' in write || 'syncJob' in write), false);
    const mark = f.writes.find((write) => 'gatewayData' in write)?.gatewayData as Record<string, unknown>;
    assert.equal(mark.transactionId, 'tx-2');
    assert.equal(typeof mark.conversionWithheldAt, 'string');
    assert.equal(mark.trialConvertedByPaymentId, 'payment-1');
    const settled = f.writes.find((write) => 'transaction' in write)?.transaction as Record<string, unknown>;
    assert.equal(settled.status, TransactionStatus.COMPLETED);
    assert.ok(settled.fulfilledAt instanceof Date, 'the payment is settled, not left unfulfilled');
  });

  it('tells the operator once, naming both payments, the amount and the gateway, and to refund it at the provider', async () => {
    const f = fulfilment({ isTrial: false, convertsTrial: true, otherUpgrades: [FIRST_PAYMENT] });

    const result = await f.complete();

    assert.deepEqual(result, { syncJobs: [] });
    assert.equal(f.events.length, 1, JSON.stringify(f.events));
    const [event] = f.events;
    assert.equal(event?.severity, 'WARNING');
    // Its own, operator-only type: `payment.completed` is a receipt, a sale to
    // rules and integrations, and a toast to the payer.
    assert.equal(event?.type, 'payment.withheld');
    assert.equal(f.events.some((raised) => raised.type === 'payment.completed'), false);
    assert.equal(event?.metadata.paymentId, 'payment-2');
    assert.equal(event?.metadata.userId, 'user-1');
    assert.equal(event?.metadata.amount, '799');
    assert.equal(event?.metadata.gatewayType, PaymentGatewayType.PLATEGA);
    assert.equal(event?.metadata.trialConvertedByPaymentId, 'payment-1');
    assert.equal(event?.metadata.needsManualReview, true);
    assert.match(String(event?.metadata.note), /payment-1/);
    assert.match(String(event?.metadata.note), /Верните деньги у платёжного провайдера \(PLATEGA\)/);
    // Where to record it, in the panel's own words.
    assert.ok(
      String(event?.metadata.note).includes('«Платежи» → «Транзакции» → этот платёж → «Отметить возврат»'),
      String(event?.metadata.note),
    );
  });

  it('says nothing more for a payment an earlier run already withheld', async () => {
    const f = fulfilment({
      isTrial: false,
      convertsTrial: true,
      otherUpgrades: [FIRST_PAYMENT],
      gatewayData: { conversionWithheldAt: '2026-09-23T10:00:00.000Z', trialConvertedByPaymentId: 'payment-1' },
    });

    const result = await f.complete();

    assert.deepEqual(result, { syncJobs: [] });
    assert.deepEqual(f.events, []);
    assert.equal(f.writes.some((write) => 'gatewayData' in write), false, 'the first mark is kept');
  });

  it('says there is nothing to refund when nothing was charged', async () => {
    const f = fulfilment({ isTrial: false, convertsTrial: true, otherUpgrades: [FIRST_PAYMENT], amount: '0' });

    await f.complete();

    assert.equal(f.events[0]?.metadata.needsManualReview, false);
    assert.match(String(f.events[0]?.metadata.note), /возвращать нечего/);
  });

  it('applies a conversion whose trial a plan migration made regular — no payment converted it — as before', async () => {
    const f = fulfilment({ isTrial: false, convertsTrial: true, otherUpgrades: [] });

    const outcome = await f.run();

    assert.equal(outcome.kind, 'APPLIED');
    const written = f.writes.find((write) => 'subscription' in write)?.subscription as Record<string, unknown>;
    assert.equal((written.planSnapshot as Record<string, unknown>).id, 'plan-b');
    assert.equal(
      Math.round(((written.expiresAt as Date).getTime() - Date.now()) / DAY),
      90,
      'the payer gets the term they paid for',
    );
    assert.ok(f.writes.some((write) => 'syncJob' in write));
    assert.equal(f.writes.some((write) => 'gatewayData' in write), false);
  });

  it('does not count a withheld conversion as the payment that converted the trial', async () => {
    const f = fulfilment({
      isTrial: false,
      convertsTrial: true,
      otherUpgrades: [{ paymentId: 'payment-0', gatewayData: { conversionWithheldAt: '2026-09-23T09:00:00.000Z' } }],
    });

    const outcome = await f.run();

    assert.equal(outcome.kind, 'APPLIED');
  });

  it('refuses a partner-balance conversion instead, so its path puts the balance back', async () => {
    const f = fulfilment({
      isTrial: false,
      convertsTrial: true,
      otherUpgrades: [FIRST_PAYMENT],
      gatewayType: PaymentGatewayType.PARTNER_BALANCE,
    });

    await assert.rejects(f.run(), (error: unknown) => {
      assert.ok(error instanceof ConflictException);
      assert.equal(error.message, 'TRIAL_ALREADY_CONVERTED');
      return true;
    });
    assert.deepEqual(f.writes, []);
  });

  it('converts a trial that is still one, reading it under the row lock', async () => {
    const f = fulfilment({ isTrial: true, convertsTrial: true });

    await f.run();

    assert.deepEqual(f.locks, ['subscriptions']);
    const written = f.writes.find((write) => 'subscription' in write)?.subscription as Record<string, unknown>;
    assert.equal(written.isTrial, false);
    assert.equal(
      Math.round(((written.expiresAt as Date).getTime() - Date.now()) / DAY),
      90,
      'the conversion buys a whole term from payment',
    );
  });

  it('applies a change of a paid plan as it always has', async () => {
    const f = fulfilment({ isTrial: false, convertsTrial: false, otherUpgrades: [FIRST_PAYMENT] });

    await f.run();

    assert.deepEqual(f.locks, []);
    assert.deepEqual(f.converterQueries, []);
    assert.ok(f.writes.some((write) => 'subscription' in write));
  });
});
