import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  AddOnLifetime,
  Prisma,
  PurchaseType,
  SubscriptionStatus,
  SubscriptionTermStatus,
  TrafficLimitStrategy,
} from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { resolveAddOnRolloutFlags } from '../src/modules/add-on-entitlements/add-on-rollout.config';
import {
  nextRemnawaveReset,
  RESET_EXPIRY_MARGIN_MS,
  type ResetStrategy,
} from '../src/modules/add-on-entitlements/domain/reset-cycle-policy';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementCutoverService } from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import {
  PLAN_STRATEGY_UPDATE_CAUSE,
  PlanSnapshotSyncService,
} from '../src/modules/subscriptions/services/plan-snapshot-sync.service';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';

/**
 * A PLAN'S RESET RULE CHANGES MID-PERIOD (P6; the owner's rule of 24.09.2026),
 * against PostgreSQL: a live «до сброса» add-on ends at the first reset under
 * the NEW rule, never later than the date it was promised, and NO_RESET keeps
 * the date. Three paths change the rule for a subscription: a plan edit (with
 * the push to Remnawave queued at once), a plan change, a paid upgrade.
 *
 * The add-ons are sold under MONTH (the 1st at 00:20, UTC unless the case sets
 * «Часовой пояс Remnawave»), so a switch to DAY always has an earlier reset
 * (tonight's 00:05) and a switch back never a later one to move to.
 * Skipped without TEST_DATABASE_URL; listed in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `s4rule-${process.pid}-${Date.now()}`;
const DAY_MS = 86_400_000;
const GIB = 1024n * 1024n * 1024n;

let prisma: PrismaService;
let cutover: EntitlementCutoverService;
let terms: SubscriptionTermService;
let snapshots: PlanSnapshotSyncService;
let fulfilment: PaymentSubscriptionMutationService;
const created = { users: [] as string[], plans: [] as string[] };
let counter = 0;
const next = (): number => ++counter;
/** «Часовой пояс Remnawave» in the switches snapshot a payment reads. */
let paymentZone: string | undefined;
const inDays = (days: number): Date => new Date(Date.now() + days * DAY_MS);

interface Owner {
  readonly userId: string;
  readonly subscriptionId: string;
}

async function plan(strategy: TrafficLimitStrategy, upgradeTo: readonly string[] = []): Promise<string> {
  const id = `${prefix}-plan-${next()}`;
  await prisma.plan.create({
    data: {
      id,
      name: id,
      orderIndex: 920_000 + next(),
      trafficLimit: 100,
      deviceLimit: 3,
      internalSquads: [],
      externalSquad: null,
      trafficLimitStrategy: strategy,
      availability: 'ALL',
      upgradeToPlanIds: [...upgradeTo],
      durations: { create: [{ days: 30, prices: { create: [{ currency: 'RUB', price: '299' }] } }] },
    },
  });
  created.plans.push(id);
  return id;
}

/** A live subscription on `planId` (MONTH), in the model, holding one «до сброса» add-on of this cycle. */
async function subscriptionWithResetAddOn(planId: string): Promise<Owner & { readonly addOnId: string; readonly soldUntil: Date }> {
  const userId = `${prefix}-user-${next()}`;
  await prisma.user.create({ data: { id: userId, referralCode: `${userId}-ref`, name: userId } });
  created.users.push(userId);
  const panelId = 880_000 + next();
  const row = await prisma.subscription.create({
    data: {
      userId,
      status: SubscriptionStatus.ACTIVE,
      planSnapshot: {
        id: planId,
        name: planId,
        trafficLimit: 100,
        deviceLimit: 3,
        trafficLimitStrategy: 'MONTH',
        internalSquads: [],
        externalSquad: null,
        selectedDurationDays: 30,
      } as Prisma.InputJsonValue,
      trafficLimit: 100,
      deviceLimit: 3,
      internalSquads: [],
      externalSquad: null,
      remnawaveId: String(panelId),
      remnawavePanelId: panelId,
      createdAt: inDays(-10),
      startedAt: inDays(-10),
      expiresAt: inDays(60),
    },
    select: { id: true },
  });
  const entered = await prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, row.id));
  assert.equal(entered.outcome, 'CREATED', 'fixture: in the term model');
  await prisma.subscriptionTerm.updateMany({
    where: { subscriptionId: row.id, status: SubscriptionTermStatus.ACTIVE },
    data: { planId },
  });
  // Bought through the checkout's marker, «до сброса», and captured.
  const monthReset = nextRemnawaveReset({ strategy: 'MONTH', anchorAt: null }, new Date())!;
  const addOnId = `${prefix}-addon-${next()}`;
  await prisma.addOn.create({ data: { id: addOnId, name: addOnId, type: 'EXTRA_TRAFFIC', value: 50 } });
  const payment = await prisma.transaction.create({
    data: {
      paymentId: `${prefix}-pay-${next()}`,
      userId,
      subscriptionId: null,
      status: 'COMPLETED',
      purchaseType: 'ADDITIONAL',
      channel: 'WEB',
      gatewayType: 'YOOKASSA',
      currency: 'RUB',
      amount: new Prisma.Decimal('99'),
      planSnapshot: {
        snapshotSource: 'ADDON_PURCHASE',
        addOnId,
        addOnType: 'EXTRA_TRAFFIC',
        addOnValue: 50,
        name: 'Extra 50 GB',
        targetSubscriptionId: row.id,
        purchaseType: 'ADDITIONAL',
        contractVersion: 2,
        addOnRevision: 1,
        sourceLineKey: addOnId,
        lifetime: 'UNTIL_NEXT_RESET',
        quotedEndsBound: 'reset',
        quotedResetAt: monthReset.toISOString(),
        quotedCycleStartsAt: inDays(-40).toISOString(),
        quotedExpiresAt: new Date(monthReset.getTime() + RESET_EXPIRY_MARGIN_MS).toISOString(),
      } as Prisma.InputJsonValue,
    },
  });
  await fulfilment.applyCompletedTransaction(payment);
  const sold = await prisma.addOnEntitlement.findFirstOrThrow({ where: { sourceTransactionId: payment.id } });
  assert.equal(sold.lifetime, AddOnLifetime.UNTIL_NEXT_RESET, 'fixture: a «до сброса» add-on');
  return { userId, subscriptionId: row.id, addOnId, soldUntil: sold.expiresAt! };
}

async function liveAddOn(subscriptionId: string) {
  return prisma.addOnEntitlement.findFirstOrThrow({
    where: { subscriptionId, lifetime: AddOnLifetime.UNTIL_NEXT_RESET },
    include: { expiryEpoch: true },
  });
}

function nextReset(strategy: ResetStrategy, timeZone?: string): Date {
  return nextRemnawaveReset({ strategy, anchorAt: null, timeZone }, new Date())!;
}

/** The plan edit, as the Plans tab saves it: the row, then the subscribers' snapshots, in one transaction. */
async function editStrategy(planId: string, strategy: TrafficLimitStrategy) {
  return prisma.$transaction(async (tx) => {
    const edited = await tx.plan.update({ where: { id: planId }, data: { trafficLimitStrategy: strategy } });
    return snapshots.syncPlanSnapshotMetadata(tx, edited);
  });
}

run('a plan\'s reset rule changes mid-period (PostgreSQL)', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    prisma = new PrismaService();
    await prisma.$connect();
    terms = new SubscriptionTermService();
    const projection = new EffectiveProjectionService();
    cutover = new EntitlementCutoverService(prisma, terms, projection);
    snapshots = new PlanSnapshotSyncService(terms);
    const switches = {
      flags: async () =>
        resolveAddOnRolloutFlags({ durableAccounting: true, trafficResetExpiry: true }, {}, {
          remnawaveTimeZone: paymentZone,
        }),
    };
    fulfilment = new PaymentSubscriptionMutationService(
      prisma,
      { info: () => undefined, warn: () => undefined, error: () => undefined, emit: () => undefined } as never,
      new AddOnEntitlementService(),
      projection,
      terms,
      {} as never,
      cutover,
      switches as never,
    );
    await prisma.settings.upsert({ where: { id: 1 }, update: { addOnSettings: {} }, create: {} });
  });

  after(async () => {
    if (prisma === undefined) return;
    await prisma.settings.update({ where: { id: 1 }, data: { addOnSettings: {} } }).catch(() => undefined);
    await removeDurableFixtures(prisma, created.users).catch((error: unknown) => {
      console.error('reset rule cleanup failed', error);
    });
    await prisma.addOn.deleteMany({ where: { id: { startsWith: prefix } } }).catch(() => undefined);
    await prisma.plan.deleteMany({ where: { id: { in: created.plans } } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('a plan edit MONTH → DAY ends the add-on at tonight\'s DAY reset, the terms take DAY, and the push is queued', async () => {
    const planId = await plan(TrafficLimitStrategy.MONTH);
    const owner = await subscriptionWithResetAddOn(planId);

    const result = await editStrategy(planId, TrafficLimitStrategy.DAY);

    const dayReset = nextReset('DAY');
    const addOn = await liveAddOn(owner.subscriptionId);
    assert.equal(addOn.expiresAt?.toISOString(), new Date(dayReset.getTime() + RESET_EXPIRY_MARGIN_MS).toISOString());
    assert.equal(addOn.expiryEpoch?.plannedEndsAt.toISOString(), dayReset.toISOString(), 'bound to the DAY reset');
    assert.ok(addOn.expiresAt!.getTime() < owner.soldUntil.getTime(), 'earlier than promised');
    const active = await prisma.subscriptionTerm.findFirstOrThrow({
      where: { subscriptionId: owner.subscriptionId, status: SubscriptionTermStatus.ACTIVE },
    });
    assert.equal(active.trafficResetStrategy, 'DAY', 'new sales and the sweep follow what is pushed');
    assert.equal((active.planSnapshot as Record<string, unknown>)['trafficLimitStrategy'], 'DAY');
    const pushes = await prisma.profileSyncJob.findMany({
      where: { subscriptionId: owner.subscriptionId, cause: PLAN_STRATEGY_UPDATE_CAUSE },
    });
    assert.equal(pushes.length, 1, 'pushed at once, not with the next unrelated push');
    assert.equal(pushes[0]!.status, 'PENDING');
    assert.deepEqual(result.syncJobIds, [pushes[0]!.id]);
    assert.equal(result.strategyChanged, 1);
    const event = await prisma.addOnEntitlementEvent.findFirst({
      where: { entitlementId: addOn.id, reason: 'RESET_RULE_CHANGED' },
    });
    assert.ok(event, 'the move is recorded');
  });

  it('a plan edit MONTH → NO_RESET keeps the promised date', async () => {
    const planId = await plan(TrafficLimitStrategy.MONTH);
    const owner = await subscriptionWithResetAddOn(planId);

    await editStrategy(planId, TrafficLimitStrategy.NO_RESET);

    assert.equal((await liveAddOn(owner.subscriptionId)).expiresAt?.toISOString(), owner.soldUntil.toISOString());
    const active = await prisma.subscriptionTerm.findFirstOrThrow({
      where: { subscriptionId: owner.subscriptionId, status: SubscriptionTermStatus.ACTIVE },
    });
    assert.equal(active.trafficResetStrategy, 'NO_RESET');
  });

  it('a plan edit whose new rule resets LATER never moves the add-on later than promised', async () => {
    const planId = await plan(TrafficLimitStrategy.MONTH);
    const owner = await subscriptionWithResetAddOn(planId);
    // Sold under DAY this time: it ends at tonight's 00:05 (+30 min).
    await editStrategy(planId, TrafficLimitStrategy.DAY);
    const soldUnderDay = (await liveAddOn(owner.subscriptionId)).expiresAt!;

    await editStrategy(planId, TrafficLimitStrategy.MONTH);

    assert.equal((await liveAddOn(owner.subscriptionId)).expiresAt?.toISOString(), soldUnderDay.toISOString());
  });

  it('an edit that keeps the rule changes no term, moves no add-on and queues no push', async () => {
    const planId = await plan(TrafficLimitStrategy.MONTH);
    const owner = await subscriptionWithResetAddOn(planId);

    const result = await editStrategy(planId, TrafficLimitStrategy.MONTH);

    assert.equal(result.strategyChanged, 0);
    assert.deepEqual(result.syncJobIds, []);
    assert.equal((await liveAddOn(owner.subscriptionId)).expiresAt?.toISOString(), owner.soldUntil.toISOString());
  });

  it('computes the new reset in «Часовой пояс Remnawave», read through the edit\'s own transaction', async () => {
    await prisma.settings.update({ where: { id: 1 }, data: { addOnSettings: { remnawaveTimeZone: 'Europe/Moscow' } } });
    try {
      const planId = await plan(TrafficLimitStrategy.MONTH);
      const owner = await subscriptionWithResetAddOn(planId);

      await editStrategy(planId, TrafficLimitStrategy.DAY);

      const moscowReset = nextReset('DAY', 'Europe/Moscow');
      assert.match(moscowReset.toISOString(), /T21:05:00\.000Z$/);
      assert.equal(
        (await liveAddOn(owner.subscriptionId)).expiresAt?.toISOString(),
        new Date(moscowReset.getTime() + RESET_EXPIRY_MARGIN_MS).toISOString(),
      );
    } finally {
      await prisma.settings.update({ where: { id: 1 }, data: { addOnSettings: {} } });
    }
  });

  it('a plan change onto a DAY plan ends the add-on at the first DAY reset', async () => {
    const monthPlan = await plan(TrafficLimitStrategy.MONTH);
    const dayPlan = await plan(TrafficLimitStrategy.DAY);
    const owner = await subscriptionWithResetAddOn(monthPlan);
    const target = await prisma.plan.findUniqueOrThrow({ where: { id: dayPlan } });

    await prisma.$transaction((tx) =>
      terms.rotateForPlanChangeInTransaction(tx, {
        subscriptionId: owner.subscriptionId,
        plan: target,
        snapshotSource: 'ADMIN_PLAN_ASSIGNMENT_TERM',
        scheduledTerms: 'CANCEL_UNBOUND',
      }),
    );

    const dayReset = nextReset('DAY');
    assert.equal(
      (await liveAddOn(owner.subscriptionId)).expiresAt?.toISOString(),
      new Date(dayReset.getTime() + RESET_EXPIRY_MARGIN_MS).toISOString(),
    );
  });

  it('a paid upgrade onto a DAY plan ends the add-on at the first DAY reset, in the zone of its switches snapshot', async () => {
    const dayPlan = await plan(TrafficLimitStrategy.DAY);
    const monthPlan = await plan(TrafficLimitStrategy.MONTH, [dayPlan]);
    const owner = await subscriptionWithResetAddOn(monthPlan);
    const payment = await prisma.transaction.create({
      data: {
        paymentId: `${prefix}-pay-${next()}`,
        userId: owner.userId,
        subscriptionId: owner.subscriptionId,
        status: 'COMPLETED',
        purchaseType: PurchaseType.UPGRADE,
        channel: 'WEB',
        gatewayType: 'YOOKASSA',
        currency: 'RUB',
        amount: new Prisma.Decimal('299'),
        planSnapshot: { id: dayPlan, selectedDurationDays: 30 } as Prisma.InputJsonValue,
      },
    });

    paymentZone = 'Europe/Moscow';
    try {
      await fulfilment.applyCompletedTransaction(payment);
    } finally {
      paymentZone = undefined;
    }

    const dayReset = nextReset('DAY', 'Europe/Moscow');
    const addOn = await liveAddOn(owner.subscriptionId);
    assert.equal(addOn.expiresAt?.toISOString(), new Date(dayReset.getTime() + RESET_EXPIRY_MARGIN_MS).toISOString());
    const projection = await prisma.subscriptionEffectiveProjection.findUniqueOrThrow({
      where: { subscriptionId: owner.subscriptionId },
    });
    assert.equal(projection.activeTrafficContributionBytes, 50n * GIB, 'still counting until then');
  });
});
