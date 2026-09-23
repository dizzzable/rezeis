import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';
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

import { PROVIDER_SUBSCRIPTION_SYNC_JOB } from '../src/modules/payments/constants/payment-reconciliation.constant';
import { CreateTransactionDraftDto } from '../src/modules/payments/dto/create-transaction-draft.dto';
import { PaymentsTransactionsService } from '../src/modules/payments/services/payments-transactions.service';
import { ProviderSubscriptionService } from '../src/modules/payments/services/provider-subscription.service';
import { PricingService } from '../src/modules/plans/services/pricing.service';
import { SubscriptionQuoteService } from '../src/modules/subscriptions/services/subscription-quote.service';

/**
 * Which VPN subscription a provider subscription (Platega, RollyPay) renews.
 *
 * The real quote, draft and provider-subscription services over one in-memory
 * store, because the defect lived in the hand-off between them: the quote
 * selects the buyer's LATEST subscription whatever the purchase type, the
 * checkout draft recorded it on a NEW or ADDITIONAL payment too, and the row
 * made from that checkout fell back to it. Such a row renewed the OLD
 * subscription while the new one lapsed after its first term, or was cancelled
 * by the sweep as "moved to another plan" — and the checkout guard refused a
 * second autopay on the old subscription instead of the new one.
 *
 * And which renewal may be one at all: a renewal onto another plan leaves the
 * subscription on its old plan until the new plan's term begins, and the sweep
 * cancelled it as moved. It is refused upfront.
 */

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-09-01T10:00:00.000Z');

interface SubscriptionRow {
  id: string;
  userId: string;
  status: SubscriptionStatus;
  isTrial: boolean;
  planSnapshot: Record<string, unknown>;
  createdAt: Date;
  expiresAt: Date | null;
}

function plan(id: string, price: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
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
    durations: [
      {
        id: `${id}-30`,
        planId: id,
        days: 30,
        prices: [{ id: `${id}-rub`, planDurationId: `${id}-30`, currency: Currency.RUB, price: { toString: () => price } }],
      },
    ],
    ...extra,
  };
}

function subscription(id: string, planId: string | null, extra: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id,
    userId: 'user-1',
    status: SubscriptionStatus.ACTIVE,
    isTrial: false,
    planSnapshot: planId === null ? {} : { id: planId },
    createdAt: new Date(T0),
    expiresAt: new Date(T0 + 40 * DAY),
    ...extra,
  };
}

/** Only the fields a `select` asks for, as Prisma returns them. */
function selected<T extends Record<string, unknown>>(select: Record<string, boolean> | undefined, row: T): Record<string, unknown> {
  if (select === undefined) return row;
  return Object.fromEntries(Object.entries(row).filter(([key]) => select[key] === true));
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const condition = value as { in?: unknown[]; not?: unknown };
      if (condition.in !== undefined) return condition.in.includes(row[key]);
      if ('not' in condition) return row[key] !== condition.not;
    }
    return row[key] === value;
  });
}

function world(options: {
  readonly subscriptions: SubscriptionRow[];
  readonly plans: Array<Record<string, unknown>>;
  readonly maxSubscriptions?: number;
  readonly multiSubscription?: boolean;
}) {
  const subscriptions = options.subscriptions;
  const plans = options.plans;
  const transactions: Array<Record<string, unknown>> = [];
  const items: Array<Record<string, unknown>> = [];
  const rows: ProviderSubscription[] = [];
  const jobs: Array<{ name: string; data: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const events: Array<{ providerEventId: string; paymentId: string; payloadHash: string }> = [];
  const posts: string[] = [];
  let provider: Record<string, unknown> = {};
  let clock = T0 + 20 * DAY;
  const tick = () => new Date((clock += 1000));

  const prisma: Record<string, unknown> = {
    settings: {
      findFirst: async () => ({
        multiSubscriptionSettings: options.multiSubscription === true ? { enabled: true, defaultMaxSubscriptions: 5 } : null,
      }),
    },
    user: {
      findUnique: async () => ({
        id: 'user-1',
        maxSubscriptions: options.maxSubscriptions ?? 1,
        purchaseDiscount: 0,
        personalDiscount: 0,
        pendingDiscounts: [],
      }),
    },
    subscription: {
      findMany: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) =>
        subscriptions
          .filter((row) => matches(row as unknown as Record<string, unknown>, where))
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
          .map((row) => selected(select, row as unknown as Record<string, unknown>)),
      findFirst: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
        const found = subscriptions.find((row) => matches(row as unknown as Record<string, unknown>, where));
        return found === undefined ? null : selected(select, found as unknown as Record<string, unknown>);
      },
      findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
        const found = subscriptions.find((row) => row.id === where.id);
        return found === undefined ? null : selected(select, found as unknown as Record<string, unknown>);
      },
    },
    plan: {
      findMany: async ({ where }: { where?: Record<string, unknown> } = {}) =>
        plans.filter((row) => {
          if (where === undefined) return true;
          const ids = (where.id as { in?: string[] } | undefined)?.in;
          if (ids !== undefined && !ids.includes(row.id as string)) return false;
          if (where.isActive === true && row.isActive !== true) return false;
          if (where.isArchived === false && row.isArchived === true) return false;
          if ('deletedAt' in where && where.deletedAt === null && row.deletedAt !== null) return false;
          const availability = where.availability as { not?: unknown } | undefined;
          if (availability?.not !== undefined && row.availability === availability.not) return false;
          return true;
        }),
      findUnique: async ({ where }: { where: { id: string } }) => plans.find((row) => row.id === where.id) ?? null,
    },
    paymentGateway: {
      findMany: async () => [{ id: 'gw-1', type: PaymentGatewayType.PLATEGA, currency: Currency.RUB, isActive: true, orderIndex: 1 }],
      findUnique: async () => ({ type: PaymentGatewayType.PLATEGA, settings: { merchantId: 'm-1', secret: 's-1' } }),
    },
    planDuration: { findMany: async () => [] },
    // A paid trial's quota: nothing spent, nothing reserved.
    trialClaim: {
      aggregate: async () => ({ _sum: { units: 0 } }),
      findMany: async () => [],
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'claim-1', ...data }),
    },
    // `lockTrialClaimUser`: the buyer's row, locked.
    $queryRaw: async () => [{ id: 'user-1' }],
    transaction: {
      findMany: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) =>
        transactions.filter((row) => matches(row, where)).map((row) => selected(select, row)),
      findUnique: async ({ where }: { where: Record<string, unknown> }) => {
        if (typeof where.id === 'string') return transactions.find((row) => row.id === where.id) ?? null;
        const key = where.userId_idempotencyKey as { userId: string; idempotencyKey: string } | undefined;
        return key === undefined
          ? null
          : (transactions.find((row) => row.userId === key.userId && row.idempotencyKey === key.idempotencyKey) ?? null);
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        transactions.find((row) => matches(row, where)) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => createTransaction(data),
    },
    providerSubscription: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `ps-${rows.length + 1}`,
          providerStatus: null,
          listAmount: null,
          appliedChargeCount: 0,
          nextChargeAt: null,
          lastChargeAt: null,
          lastSyncedAt: null,
          cancelledAt: null,
          cancelledBy: null,
          createdAt: tick(),
          updatedAt: new Date(clock),
          ...data,
        } as unknown as ProviderSubscription;
        rows.push(row);
        return row;
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        rows
          .filter((row) => matches(row as unknown as Record<string, unknown>, where))
          .map((row) => ({ ...row, user: row.userId === null ? null : { isBlocked: false } })),
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((row) => matches(row as unknown as Record<string, unknown>, where)) ?? null,
      findUnique: async () => null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const index = rows.findIndex((row) => row.id === where.id);
        rows[index] = { ...rows[index]!, ...data } as ProviderSubscription;
        return rows[index];
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const index = rows.findIndex((row) => matches(row as unknown as Record<string, unknown>, where));
        if (index < 0) return { count: 0 };
        rows[index] = { ...rows[index]!, ...data } as ProviderSubscription;
        return { count: 1 };
      },
    },
  };
  prisma.$transaction = async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({
      ...prisma,
      transactionItem: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          items.push(data);
          return data;
        },
      },
    });

  function createTransaction(data: Record<string, unknown>): Record<string, unknown> {
    const row = {
      id: `tx-${transactions.length + 1}`,
      paymentId: `payment-${transactions.length + 1}`,
      gatewayId: null,
      fulfilledAt: null,
      idempotencyKey: null,
      createdAt: tick(),
      updatedAt: new Date(clock),
      ...data,
    };
    transactions.push(row);
    return row;
  }

  // On sale, trials included: the quote decides which trial a buyer may take.
  const catalog = {
    getCatalogPlans: async () =>
      plans.filter((row) => row.isActive === true && row.isArchived !== true).map((row) => ({ id: row.id })),
  };
  const quote = new SubscriptionQuoteService(prisma as never, catalog as never, new PricingService());
  const drafts = new PaymentsTransactionsService(prisma as never, quote);
  const inbox = {
    recordReceived: async ({ envelope }: { envelope: { providerEventId: string; paymentId: string; payloadHash: string } }) => {
      const existing = events.find((event) => event.providerEventId === envelope.providerEventId);
      if (existing !== undefined && existing.payloadHash === envelope.payloadHash) {
        return { event: { id: existing.providerEventId, paymentId: existing.paymentId }, duplicate: true };
      }
      events.push(envelope);
      return { event: { id: envelope.providerEventId, paymentId: envelope.paymentId, gatewayType: PaymentGatewayType.PLATEGA }, duplicate: false };
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
    get: () => of({ data: provider }),
    post: (url: string) => {
      posts.push(url);
      return of({ data: { status: 'cancelled' } });
    },
  };
  const service = new ProviderSubscriptionService(prisma as never, http as never, inbox as never, queue as never);

  return {
    service,
    subscriptions,
    transactions,
    items,
    rows,
    jobs,
    posts,
    row: (index = 0) => rows[index]!,
    setProvider: (state: Record<string, unknown>) => {
      provider = state;
    },
    /** What the checkout does: the draft, then the provider's subscription, recorded. */
    checkout: async (input: CreateTransactionDraftDto, providerSubscription = true) => {
      const draft = await drafts.createCheckoutDraft(input, { providerSubscription });
      const transaction = transactions.find((row) => row.paymentId === draft.paymentId)!;
      if (providerSubscription) {
        transaction.gatewayId = `platega-${transaction.id}`;
        await service.recordCheckout(transaction as never);
      }
      return transaction;
    },
    /** The reconciliation worker has claimed the first charge: paid, fulfilment still running. */
    claimFirst: (row: ProviderSubscription) => {
      const first = transactions.find((transaction) => transaction.id === row.firstTransactionId)!;
      first.status = TransactionStatus.COMPLETED;
      first.fulfilledAt = tick();
    },
    /** Fulfilment of a NEW or ADDITIONAL first charge: the subscription it creates, written onto the payment. */
    deliverFirst: (row: ProviderSubscription, created: string, planId: string) => {
      const first = transactions.find((transaction) => transaction.id === row.firstTransactionId)!;
      const now = tick();
      subscriptions.push(subscription(created, planId, { createdAt: now, expiresAt: new Date(now.getTime() + 30 * DAY) }));
      first.status = TransactionStatus.COMPLETED;
      first.fulfilledAt = now;
      first.subscriptionId = created;
    },
    sweep: () => service.cancelStranded(),
  };
}

const chargesSoFar = (count: number) => ({
  status: 'Active',
  nextChargeAt: new Date(T0 + 60 * DAY).toISOString(),
  chargeMetrics: { chargesSuccess: count },
});

function purchase(purchaseType: PurchaseType, planId: string, sourceSubscriptionId?: string): CreateTransactionDraftDto {
  return {
    userId: 'user-1',
    purchaseType,
    planId,
    durationDays: 30,
    gatewayType: PaymentGatewayType.PLATEGA,
    channel: PurchaseChannel.WEB,
    ...(sourceSubscriptionId === undefined ? {} : { sourceSubscriptionId }),
  };
}

describe("a new purchase's provider subscription names only the subscription it creates", () => {
  const besideAnother = (oldPlan: string) =>
    world({
      subscriptions: [subscription('old-sub', oldPlan)],
      plans: [plan('plan-a', '199'), plan('plan-b', '299')],
      multiSubscription: true,
    });

  it('records none on an ADDITIONAL beside another subscription, and neither does its checkout', async () => {
    const w = besideAnother('plan-a');

    const checkout = await w.checkout(purchase(PurchaseType.ADDITIONAL, 'plan-b'));

    assert.equal(checkout.subscriptionId, null);
    assert.equal(
      ((checkout.planSnapshot as Record<string, unknown>).providerSubscription as { subscriptionId: unknown }).subscriptionId,
      null,
    );
    assert.equal(w.row().subscriptionId, null);
  });

  it('survives the sweep beside a subscription on another plan, before its first charge and after', async () => {
    const w = besideAnother('plan-a');
    await w.checkout(purchase(PurchaseType.ADDITIONAL, 'plan-b'));

    assert.equal(await w.sweep(), 0);

    w.setProvider(chargesSoFar(1));
    await w.service.syncRow(w.row());
    w.deliverFirst(w.row(), 'new-sub', 'plan-b');
    await w.service.syncRow(w.row());

    assert.equal(w.row().subscriptionId, 'new-sub');
    assert.equal(await w.sweep(), 0);
    assert.deepEqual(w.posts, []);
    assert.equal(w.row().status, ProviderSubscriptionStatus.ACTIVE);
  });

  it('renews the new subscription with charge 2 beside one on the same plan, never the old one', async () => {
    const w = besideAnother('plan-a');
    await w.checkout(purchase(PurchaseType.ADDITIONAL, 'plan-a'));
    w.setProvider(chargesSoFar(1));
    await w.service.syncRow(w.row());
    w.deliverFirst(w.row(), 'new-sub', 'plan-a');

    w.setProvider(chargesSoFar(2));
    await w.service.syncRow(w.row());

    assert.deepEqual(
      w.items.map((item) => [item.subscriptionId, item.planId]),
      [['new-sub', 'plan-a']],
    );
    assert.equal(w.row().subscriptionId, 'new-sub');
  });

  it('binds a NEW by a returning customer whose latest subscription expired to the one it creates', async () => {
    const w = world({
      subscriptions: [subscription('old-sub', 'plan-a', { status: SubscriptionStatus.EXPIRED, expiresAt: new Date(T0 - DAY) })],
      plans: [plan('plan-a', '199')],
      maxSubscriptions: 2,
    });

    const checkout = await w.checkout(purchase(PurchaseType.NEW, 'plan-a'));
    assert.equal(checkout.subscriptionId, null);
    w.setProvider(chargesSoFar(1));
    await w.service.syncRow(w.row());
    w.deliverFirst(w.row(), 'new-sub', 'plan-a');
    w.setProvider(chargesSoFar(2));
    await w.service.syncRow(w.row());

    assert.equal(w.row().subscriptionId, 'new-sub');
    assert.deepEqual(w.items.map((item) => item.subscriptionId), ['new-sub']);
  });

  it('hands a returning buyer the same checkout when the same NEW is asked for again', async () => {
    // Its draft names no subscription, and the draft it is looked up by must
    // not either — or every retry made a new payment, and with autopay a new
    // sign-up at the provider.
    const w = world({
      subscriptions: [subscription('old-sub', 'plan-a', { status: SubscriptionStatus.EXPIRED, expiresAt: new Date(T0 - DAY) })],
      plans: [plan('plan-a', '199')],
      maxSubscriptions: 2,
    });

    const first = await w.checkout(purchase(PurchaseType.NEW, 'plan-a'), false);
    const again = await w.checkout(purchase(PurchaseType.NEW, 'plan-a'), false);

    assert.equal(again.paymentId, first.paymentId);
    assert.equal(w.transactions.length, 1);
  });

  it('records no subscription on a paid trial bought beside another one', async () => {
    const w = world({
      subscriptions: [subscription('old-sub', 'plan-a')],
      plans: [
        plan('plan-a', '199'),
        plan('trial-paid', '49', { availability: PlanAvailability.TRIAL, trialSettings: { free: false, maxClaims: 1 } }),
      ],
      multiSubscription: true,
    });

    const checkout = await w.checkout(purchase(PurchaseType.ADDITIONAL, 'trial-paid'), false);

    assert.equal((checkout.planSnapshot as Record<string, unknown>).availability, PlanAvailability.TRIAL);
    assert.equal(checkout.subscriptionId, null);
  });

  it('moves the checkout guard onto the new subscription', async () => {
    const w = besideAnother('plan-a');
    await w.checkout(purchase(PurchaseType.ADDITIONAL, 'plan-a'));
    w.setProvider(chargesSoFar(1));
    await w.service.syncRow(w.row());
    w.deliverFirst(w.row(), 'new-sub', 'plan-a');
    await w.service.syncRow(w.row());

    // A second autopay on the subscription this one renews would charge twice a period.
    await assert.rejects(w.service.assertNoLiveSubscriptionFor('new-sub'), (error: unknown) => {
      assert.ok(error instanceof BadRequestException);
      assert.equal((error.getResponse() as { reason?: unknown }).reason, 'ALREADY_ACTIVE');
      return true;
    });
    // The old subscription renews nothing through it, so it may have one of its own.
    await w.service.assertNoLiveSubscriptionFor('old-sub');
  });

  it("names no subscription while the first charge's fulfilment is still running", async () => {
    const w = besideAnother('plan-a');
    await w.checkout(purchase(PurchaseType.ADDITIONAL, 'plan-a'));
    w.setProvider(chargesSoFar(1));
    await w.service.syncRow(w.row());

    w.claimFirst(w.row());
    await w.service.syncRow(w.row());
    assert.equal(w.row().subscriptionId, null);

    w.deliverFirst(w.row(), 'new-sub', 'plan-a');
    await w.service.syncRow(w.row());
    assert.equal(w.row().subscriptionId, 'new-sub');
  });

  it('renews nothing with charge 2 until the first has made the subscription', async () => {
    const w = besideAnother('plan-a');
    await w.checkout(purchase(PurchaseType.ADDITIONAL, 'plan-a'));
    w.setProvider(chargesSoFar(2));

    await w.service.syncRow(w.row());

    // It waits, and books its own look, rather than renew a subscription it has not got.
    assert.deepEqual(w.items, []);
    assert.deepEqual(
      w.jobs.filter((job) => job.name === PROVIDER_SUBSCRIPTION_SYNC_JOB).map((job) => job.options.delay),
      [60_000],
    );
    assert.equal(w.row().subscriptionId, null);
  });

  it('records a checkout that still names the latest subscription unbound all the same', async () => {
    // What a draft made before this fix looks like: an ADDITIONAL carrying the
    // buyer's latest subscription.
    const w = besideAnother('plan-a');
    w.transactions.push({
      id: 'tx-older',
      paymentId: 'payment-older',
      userId: 'user-1',
      subscriptionId: 'old-sub',
      status: TransactionStatus.PENDING,
      purchaseType: PurchaseType.ADDITIONAL,
      gatewayType: PaymentGatewayType.PLATEGA,
      gatewayId: 'platega-older',
      currency: Currency.RUB,
      planSnapshot: {
        id: 'plan-b',
        providerSubscription: { unit: 'month', count: 1, amount: 299, durationDays: 30, planId: 'plan-b', subscriptionId: null },
      },
    });

    await w.service.recordCheckout(w.transactions[0] as never);

    assert.equal(w.row().subscriptionId, null);
  });

  it("still records a renewal and a trial's conversion on the subscription they act on", async () => {
    const renewal = besideAnother('plan-a');
    await renewal.checkout(purchase(PurchaseType.RENEW, 'plan-a', 'old-sub'));
    assert.equal(renewal.row().subscriptionId, 'old-sub');

    const conversion = world({
      subscriptions: [subscription('trial-sub', 'trial-plan', { isTrial: true })],
      plans: [plan('trial-plan', '0', { availability: PlanAvailability.TRIAL }), plan('plan-b', '299')],
    });
    const checkout = await conversion.checkout(purchase(PurchaseType.UPGRADE, 'plan-b', 'trial-sub'));
    assert.equal(checkout.subscriptionId, 'trial-sub');
    assert.equal(conversion.row().subscriptionId, 'trial-sub');
  });
});

describe('a renewal onto another plan', () => {
  // An archived plan that is replaced on renewal: every renewal is onto its replacement.
  const archived = () =>
    world({
      subscriptions: [subscription('sub-1', 'old-plan')],
      plans: [
        plan('old-plan', '199', { isArchived: true, archivedRenewMode: 'REPLACE_ON_RENEW', replacementPlanIds: ['new-plan'] }),
        plan('new-plan', '299'),
      ],
    });

  it('is refused a provider subscription before anything is written', async () => {
    const w = archived();

    await assert.rejects(w.checkout(purchase(PurchaseType.RENEW, 'new-plan', 'sub-1')), (error: unknown) => {
      assert.ok(error instanceof BadRequestException);
      assert.deepEqual(
        [(error.getResponse() as { code?: unknown }).code, (error.getResponse() as { reason?: unknown }).reason],
        ['AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE', 'PLAN_CHANGE'],
      );
      return true;
    });
    assert.deepEqual(w.transactions, []);
    assert.deepEqual(w.rows, []);
  });

  it('is still paid the ordinary way', async () => {
    const w = archived();

    const checkout = await w.checkout(purchase(PurchaseType.RENEW, 'new-plan', 'sub-1'), false);

    assert.equal(checkout.purchaseType, PurchaseType.RENEW);
    assert.equal((checkout.planSnapshot as Record<string, unknown>).providerSubscription, undefined);
  });

  it('leaves a renewal onto the plan the subscription is on a provider subscription', async () => {
    const w = world({ subscriptions: [subscription('sub-1', 'plan-a')], plans: [plan('plan-a', '199')] });

    await w.checkout(purchase(PurchaseType.RENEW, 'plan-a', 'sub-1'));

    assert.equal(w.row().subscriptionId, 'sub-1');
    assert.equal(w.row().planId, 'plan-a');
  });

  it('does not refuse one whose subscription names no plan to compare with', async () => {
    // An imported subscription: the sweep has no plan to compare either.
    const w = world({ subscriptions: [subscription('sub-1', null)], plans: [plan('plan-a', '199')] });

    await w.checkout(purchase(PurchaseType.RENEW, 'plan-a', 'sub-1'));

    assert.equal(w.row().planId, 'plan-a');
  });
});
