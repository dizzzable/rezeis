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
import { entitlementEndBound } from '../src/modules/add-on-entitlements/domain/add-on-lifetime';
import {
  nextRemnawaveReset,
  RESET_EXPIRY_MARGIN_MS,
  type ResetStrategy,
} from '../src/modules/add-on-entitlements/domain/reset-cycle-policy';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementBoundarySchedulerService } from '../src/modules/add-on-entitlements/services/entitlement-boundary-scheduler.service';
import { EntitlementCutoverService } from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import {
  followChangedResetRules,
  followResetRules,
  PLAN_STRATEGY_UPDATE_CAUSE,
} from '../src/modules/add-on-entitlements/services/reset-rule-follow';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { PlanSquadPropagationService } from '../src/modules/plans/services/plan-squad-propagation.service';
import { PlansAdminService } from '../src/modules/plans/services/plans-admin.service';
import { PlansAdminValidators } from '../src/modules/plans/services/plans-admin.validators';
import { PlanSnapshotSyncService } from '../src/modules/subscriptions/services/plan-snapshot-sync.service';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';

/**
 * A PLAN'S RESET RULE CHANGES MID-PERIOD (P6; the owner's rule of 24.09.2026),
 * against PostgreSQL: a live «до сброса» add-on ends at the first reset under
 * the NEW rule, never later than the date it was promised, and NO_RESET keeps
 * the date. Three paths change the rule for a subscription: a plan edit (with
 * the push to Remnawave at once), a plan change, a paid upgrade.
 *
 * THE PLAN EDIT commits the plan and every subscriber's snapshot in ONE short
 * transaction, then follows the rule subscriber by subscriber, each in a
 * transaction of its own, its push enqueued as soon as that commits
 * (`reset-rule-follow.ts`); what a crash leaves behind, the boundary
 * scheduler's sweep finishes (review R3a-01: the edit used to do it all in one
 * 5-second transaction, and a plan with some 1,000 subscribers could not have
 * its rule changed at all).
 *
 * AN ADD-ON THAT KEEPS ITS DATE lets go of the old rule's reset (review
 * R3a-02): bound to no reset, it ends by its date — nothing waits for a reset
 * Remnawave no longer runs, and no incident blames Remnawave for it.
 *
 * The add-ons are sold under MONTH (the 1st at 00:20, UTC unless the case sets
 * «Часовой пояс Remnawave») unless a case says DAY, so a switch to DAY always
 * has an earlier reset (tonight's 00:05) and a switch from DAY to MONTH never
 * an earlier one. Skipped without TEST_DATABASE_URL; listed in the PostgreSQL
 * job of ci.yml.
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
const created = { users: [] as string[], plans: [] as string[], admins: [] as string[] };
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

/** The marker of a paid «до сброса» add-on, quoted under `strategy`'s next reset (in UTC). */
function resetQuoteMarker(input: {
  readonly addOnId: string;
  readonly subscriptionId: string;
  readonly strategy: ResetStrategy;
}): Prisma.InputJsonValue {
  const reset = nextRemnawaveReset({ strategy: input.strategy, anchorAt: null }, new Date())!;
  return {
    snapshotSource: 'ADDON_PURCHASE',
    addOnId: input.addOnId,
    addOnType: 'EXTRA_TRAFFIC',
    addOnValue: 50,
    name: 'Extra 50 GB',
    targetSubscriptionId: input.subscriptionId,
    purchaseType: 'ADDITIONAL',
    contractVersion: 2,
    addOnRevision: 1,
    sourceLineKey: input.addOnId,
    lifetime: 'UNTIL_NEXT_RESET',
    quotedEndsBound: 'reset',
    quotedResetAt: reset.toISOString(),
    quotedCycleStartsAt: inDays(-40).toISOString(),
    quotedExpiresAt: new Date(reset.getTime() + RESET_EXPIRY_MARGIN_MS).toISOString(),
  } as Prisma.InputJsonValue;
}

/** A live subscription on `planId`, in the model, with no add-on yet. */
async function liveSubscription(planId: string, strategy: ResetStrategy = 'MONTH'): Promise<Owner> {
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
        trafficLimitStrategy: strategy,
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
  return { userId, subscriptionId: row.id };
}

/** An add-on «до сброса» sold under `strategy`'s next reset, drafted but not captured. */
async function resetAddOnPayment(owner: Owner, strategy: ResetStrategy) {
  const addOnId = `${prefix}-addon-${next()}`;
  await prisma.addOn.create({ data: { id: addOnId, name: addOnId, type: 'EXTRA_TRAFFIC', value: 50 } });
  return prisma.transaction.create({
    data: {
      paymentId: `${prefix}-pay-${next()}`,
      userId: owner.userId,
      subscriptionId: null,
      status: 'COMPLETED',
      purchaseType: 'ADDITIONAL',
      channel: 'WEB',
      gatewayType: 'YOOKASSA',
      currency: 'RUB',
      amount: new Prisma.Decimal('99'),
      planSnapshot: resetQuoteMarker({ addOnId, subscriptionId: owner.subscriptionId, strategy }),
    },
  });
}

/** A live subscription on `planId` holding one «до сброса» add-on of this cycle, sold under `strategy`. */
async function subscriptionWithResetAddOn(
  planId: string,
  strategy: ResetStrategy = 'MONTH',
): Promise<Owner & { readonly soldUntil: Date }> {
  const owner = await liveSubscription(planId, strategy);
  const payment = await resetAddOnPayment(owner, strategy);
  await fulfilment.applyCompletedTransaction(payment);
  const sold = await prisma.addOnEntitlement.findFirstOrThrow({ where: { sourceTransactionId: payment.id } });
  assert.equal(sold.lifetime, AddOnLifetime.UNTIL_NEXT_RESET, 'fixture: a «до сброса» add-on');
  assert.ok(sold.expiryEpochId !== null, 'fixture: bound to its reset');
  return { ...owner, soldUntil: sold.expiresAt! };
}

async function liveAddOn(subscriptionId: string) {
  return prisma.addOnEntitlement.findFirstOrThrow({
    where: { subscriptionId, lifetime: AddOnLifetime.UNTIL_NEXT_RESET },
    include: { expiryEpoch: true },
  });
}

async function activeStrategy(subscriptionId: string): Promise<string> {
  return (
    await prisma.subscriptionTerm.findFirstOrThrow({
      where: { subscriptionId, status: SubscriptionTermStatus.ACTIVE },
    })
  ).trafficResetStrategy;
}

async function strategyPushes(subscriptionId: string) {
  return prisma.profileSyncJob.findMany({ where: { subscriptionId, cause: PLAN_STRATEGY_UPDATE_CAUSE } });
}

function nextReset(strategy: ResetStrategy, timeZone?: string): Date {
  return nextRemnawaveReset({ strategy, anchorAt: null, timeZone }, new Date())!;
}

/** The edit's own transaction, as the Plans tab saves it: the row, then the subscribers' snapshots. */
function commitStrategyEdit(planId: string, strategy: TrafficLimitStrategy) {
  return prisma.$transaction(async (tx) => {
    const edited = await tx.plan.update({ where: { id: planId }, data: { trafficLimitStrategy: strategy } });
    return snapshots.syncPlanSnapshotMetadata(tx, edited);
  });
}

/** A profile-sync queue that records what it was handed. */
function recordingQueue() {
  const ids: string[] = [];
  return { ids, enqueue: async (syncJobId: string): Promise<void> => void ids.push(syncJobId) };
}

/** The plan edit whole: the commit, then the follow after it, as `PlansAdminService.updatePlan` runs it. */
async function editStrategy(planId: string, strategy: TrafficLimitStrategy) {
  const committed = await commitStrategyEdit(planId, strategy);
  const queue = recordingQueue();
  const follow = await followResetRules({ prisma, terms, enqueue: queue.enqueue }, committed.followSubscriptionIds, {
    correlationId: `plan-edit:${planId}`,
    push: 'always',
  });
  return { ...committed, follow, pushed: queue.ids };
}

/** The boundary scheduler, for its reset-rule sweep only. */
function sweeper(queue: { enqueue(syncJobId: string): Promise<void> }): EntitlementBoundarySchedulerService {
  return new EntitlementBoundarySchedulerService(
    prisma,
    {} as never,
    queue as never,
    {} as never,
    {} as never,
    terms,
  );
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
    snapshots = new PlanSnapshotSyncService();
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
    await prisma.adminAuditLog.deleteMany({ where: { adminUserId: { in: created.admins } } }).catch(() => undefined);
    await prisma.adminUser.deleteMany({ where: { id: { in: created.admins } } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('a plan edit MONTH → DAY ends the add-on at tonight\'s DAY reset, the terms take DAY, and the push goes out at once', async () => {
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
    const pushes = await strategyPushes(owner.subscriptionId);
    assert.equal(pushes.length, 1, 'pushed at once, not with the next unrelated push');
    assert.equal(pushes[0]!.status, 'PENDING');
    assert.deepEqual(result.pushed, [pushes[0]!.id], 'enqueued the moment its follow committed');
    assert.equal(result.strategyChanged, 1);
    assert.deepEqual(result.followSubscriptionIds, [owner.subscriptionId]);
    const event = await prisma.addOnEntitlementEvent.findFirst({
      where: { entitlementId: addOn.id, reason: 'RESET_RULE_CHANGED' },
    });
    assert.ok(event, 'the move is recorded');
  });

  it('a plan edit MONTH → NO_RESET keeps the promised date and lets go of the old reset (R3a-02)', async () => {
    const planId = await plan(TrafficLimitStrategy.MONTH);
    const owner = await subscriptionWithResetAddOn(planId);

    await editStrategy(planId, TrafficLimitStrategy.NO_RESET);

    const addOn = await liveAddOn(owner.subscriptionId);
    assert.equal(addOn.expiresAt?.toISOString(), owner.soldUntil.toISOString());
    assert.equal(addOn.expiryEpochId, null, 'NO_RESET: it ends at the promised date, bound to no reset');
    assert.equal(await activeStrategy(owner.subscriptionId), 'NO_RESET');
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

  it('a plan edit DAY → MONTH keeps the promised date and detaches it from the DAY reset: it ends BY ITS DATE (R3a-02)', async () => {
    const planId = await plan(TrafficLimitStrategy.DAY);
    const owner = await subscriptionWithResetAddOn(planId, 'DAY');
    const before = await liveAddOn(owner.subscriptionId);
    assert.equal(
      entitlementEndBound({ lifetime: before.lifetime, expiresAt: before.expiresAt, epochPlannedEndsAt: before.expiryEpoch!.plannedEndsAt }),
      'reset',
      'fixture: sold until tonight\'s DAY reset',
    );

    await editStrategy(planId, TrafficLimitStrategy.MONTH);

    const addOn = await liveAddOn(owner.subscriptionId);
    assert.equal(addOn.expiresAt?.toISOString(), owner.soldUntil.toISOString(), 'never later than promised');
    // Left bound to tonight's DAY reset, it was held past its date for a reset
    // Remnawave no longer runs for this profile, and six hours later one
    // incident told the operator to reset the counters by hand.
    assert.equal(addOn.expiryEpochId, null, 'no longer waits for the DAY reset');
    assert.equal(
      entitlementEndBound({ lifetime: addOn.lifetime, expiresAt: addOn.expiresAt, epochPlannedEndsAt: null }),
      null,
      'no bound named: the customer is shown its date',
    );
    const event = await prisma.addOnEntitlementEvent.findFirstOrThrow({
      where: { entitlementId: addOn.id, reason: 'RESET_RULE_CHANGED' },
    });
    const metadata = event.metadata as Record<string, unknown>;
    assert.equal(metadata['previousExpiryEpochId'], before.expiryEpochId, 'the event names the reset it left');
    assert.equal(metadata['endsBy'], 'DATE');

    // A second pass — the sweep racing the edit's own — changes nothing more.
    const again = await followResetRules({ prisma, terms }, [owner.subscriptionId], {
      correlationId: 'again',
      push: 'if-followed',
    });
    assert.equal(again.followed, 0);
    assert.equal(
      await prisma.addOnEntitlementEvent.count({ where: { entitlementId: addOn.id, reason: 'RESET_RULE_CHANGED' } }),
      1,
    );
  });

  it('an edit that keeps the rule changes no term, moves no add-on and queues no push', async () => {
    const planId = await plan(TrafficLimitStrategy.MONTH);
    const owner = await subscriptionWithResetAddOn(planId);

    const result = await editStrategy(planId, TrafficLimitStrategy.MONTH);

    assert.equal(result.strategyChanged, 0);
    assert.deepEqual(result.followSubscriptionIds, []);
    assert.deepEqual(result.pushed, []);
    assert.equal((await strategyPushes(owner.subscriptionId)).length, 0);
    const addOn = await liveAddOn(owner.subscriptionId);
    assert.equal(addOn.expiresAt?.toISOString(), owner.soldUntil.toISOString());
    assert.ok(addOn.expiryEpochId !== null, 'still bound to its own reset');
  });

  it('the mirror: display facts and the rule move, the four limit keys and the icon stay, every other key is kept', async () => {
    const planId = await plan(TrafficLimitStrategy.MONTH);
    const owner = await liveSubscription(planId);
    await prisma.subscription.update({
      where: { id: owner.subscriptionId },
      data: {
        planSnapshot: {
          id: planId,
          name: 'Old name',
          tag: null,
          type: 'TRAFFIC',
          icon: 'zap',
          trafficLimit: 256,
          deviceLimit: 1,
          internalSquads: ['99999999-9999-9999-9999-999999999999'],
          externalSquad: null,
          trafficLimitStrategy: 'MONTH',
          selectedDurationDays: 30,
          importedFrom: 'altshop',
        } as Prisma.InputJsonValue,
      },
    });
    await prisma.plan.update({
      where: { id: planId },
      data: { name: 'Starter', tag: 'popular', type: 'BOTH', trafficLimit: 1024, deviceLimit: 2, icon: 'star' },
    });

    await editStrategy(planId, TrafficLimitStrategy.WEEK);

    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: owner.subscriptionId } });
    assert.deepEqual(row.planSnapshot, {
      id: planId,
      // Mirrored.
      name: 'Starter',
      tag: 'popular',
      type: 'BOTH',
      trafficLimitStrategy: 'WEEK',
      // Frozen: what the plan gave THIS subscription, and the icon it was sold with.
      icon: 'zap',
      trafficLimit: 256,
      deviceLimit: 1,
      internalSquads: ['99999999-9999-9999-9999-999999999999'],
      externalSquad: null,
      // Nobody's to rewrite.
      selectedDurationDays: 30,
      importedFrom: 'altshop',
    });
  });

  it('computes the new reset in «Часовой пояс Remnawave», read once before the follow', async () => {
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

  it('a reset-rule edit on a plan with 1,500 subscribers commits in the default transaction; every one follows after it (R3a-01)', async () => {
    const N = 1_500;
    const planId = await plan(TrafficLimitStrategy.MONTH);
    const tag = `${prefix}-scale`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (id, referral_code, name, updated_at)
       SELECT '${tag}-u-' || g, '${tag}-r-' || g, 'u' || g, now() FROM generate_series(1, ${N}) g`,
    );
    for (let index = 1; index <= N; index += 1) created.users.push(`${tag}-u-${index}`);
    await prisma.$executeRawUnsafe(
      `INSERT INTO subscriptions (id, user_id, status, plan_snapshot, traffic_limit, device_limit, internal_squads,
                                  remnawave_id, remnawave_panel_id, created_at, started_at, expires_at, updated_at)
       SELECT '${tag}-s-' || g, '${tag}-u-' || g, 'ACTIVE',
              jsonb_build_object('id', '${planId}', 'name', '${planId}', 'trafficLimit', 100, 'deviceLimit', 3,
                                 'trafficLimitStrategy', 'MONTH', 'internalSquads', '[]'::jsonb, 'externalSquad', null),
              100, 3, '{}', (760000 + g)::text, 760000 + g, now() - interval '10 days', now() - interval '10 days',
              now() + interval '20 days', now()
       FROM generate_series(1, ${N}) g`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO subscription_terms (id, subscription_id, generation, plan_id, plan_snapshot, starts_at, ends_at, status,
                                       base_traffic_limit_bytes, base_device_limit, traffic_reset_strategy, reset_anchor_at, updated_at)
       SELECT '${tag}-t-' || g, '${tag}-s-' || g, 1, '${planId}',
              jsonb_build_object('id', '${planId}', 'trafficLimitStrategy', 'MONTH'),
              now() - interval '10 days', now() + interval '20 days', 'ACTIVE', 107374182400, 3, 'MONTH',
              now() - interval '10 days', now()
       FROM generate_series(1, ${N}) g`,
    );

    // The edit's own transaction, with Prisma's default 5-second timeout — the
    // one that rolled back with P2028 at this size.
    const startedAt = Date.now();
    const committed = await commitStrategyEdit(planId, TrafficLimitStrategy.DAY);
    const editMs = Date.now() - startedAt;
    assert.equal(committed.updated, N);
    assert.equal(committed.strategyChanged, N);
    const onDay = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM subscriptions WHERE id LIKE '${tag}-s-%' AND plan_snapshot->>'trafficLimitStrategy' = 'DAY'`,
    );
    assert.equal(onDay[0]!.n, N, 'every snapshot names the new rule once the edit commits');

    const queue = recordingQueue();
    const followStartedAt = Date.now();
    const summary = await followResetRules({ prisma, terms, enqueue: queue.enqueue }, committed.followSubscriptionIds, {
      correlationId: `plan-edit:${planId}`,
      push: 'always',
    });
    console.log(`[fx3a] ${N} subscribers: edit ${editMs} ms, follow ${Date.now() - followStartedAt} ms`);
    assert.deepEqual(summary, { followed: N, failed: 0, enqueued: N });
    const stillMonth = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM subscription_terms WHERE subscription_id LIKE '${tag}-s-%' AND traffic_reset_strategy = 'MONTH'`,
    );
    assert.equal(stillMonth[0]!.n, 0, 'every term took DAY');
    assert.equal(new Set(queue.ids).size, N, 'one push per subscriber, each enqueued');
  });

  it('a follow cut short is finished by the sweep: every subscriber follows, each pushed exactly once (R3a-01)', async () => {
    const planId = await plan(TrafficLimitStrategy.MONTH);
    const owners = [];
    for (let index = 0; index < 5; index += 1) owners.push(await subscriptionWithResetAddOn(planId));
    const committed = await commitStrategyEdit(planId, TrafficLimitStrategy.DAY);
    assert.equal(committed.followSubscriptionIds.length, 5);

    // The process dies after the first two subscribers.
    const first = recordingQueue();
    await followResetRules({ prisma, terms, enqueue: first.enqueue }, committed.followSubscriptionIds.slice(0, 2), {
      correlationId: `plan-edit:${planId}`,
      push: 'always',
    });
    const cutShort = await Promise.all(owners.map((owner) => activeStrategy(owner.subscriptionId)));
    assert.equal(cutShort.filter((strategy) => strategy === 'DAY').length, 2);
    assert.equal(cutShort.filter((strategy) => strategy === 'MONTH').length, 3);

    const resumed = recordingQueue();
    const sweep = await sweeper(resumed).followChangedResetRules();
    assert.ok(sweep.followed >= 3, `the sweep followed what was left (followed ${sweep.followed})`);

    const dayReset = nextReset('DAY');
    const allPushes: string[] = [];
    for (const owner of owners) {
      assert.equal(await activeStrategy(owner.subscriptionId), 'DAY');
      assert.equal(
        (await liveAddOn(owner.subscriptionId)).expiresAt?.toISOString(),
        new Date(dayReset.getTime() + RESET_EXPIRY_MARGIN_MS).toISOString(),
      );
      const pushes = await strategyPushes(owner.subscriptionId);
      assert.equal(pushes.length, 1, 'pushed once, whichever pass followed it');
      allPushes.push(pushes[0]!.id);
    }
    assert.deepEqual([...first.ids, ...resumed.ids.filter((id) => allPushes.includes(id))].sort(), [...allPushes].sort());

    // Nothing is left for a second sweep.
    const idle = recordingQueue();
    await sweeper(idle).followChangedResetRules();
    for (const owner of owners) assert.equal((await strategyPushes(owner.subscriptionId)).length, 1);
    assert.deepEqual(idle.ids.filter((id) => allPushes.includes(id)), []);
  });

  it('a live subscriber outside the term model is pushed too: the push is all a changed rule needs there (R3a-01)', async () => {
    const planId = await plan(TrafficLimitStrategy.MONTH);
    const userId = `${prefix}-user-${next()}`;
    await prisma.user.create({ data: { id: userId, referralCode: `${userId}-ref`, name: userId } });
    created.users.push(userId);
    const outside = await prisma.subscription.create({
      data: {
        userId,
        status: SubscriptionStatus.LIMITED,
        planSnapshot: { id: planId, name: planId, trafficLimitStrategy: 'MONTH' } as Prisma.InputJsonValue,
        trafficLimit: 100,
        deviceLimit: 3,
        remnawaveId: String(890_000 + next()),
        expiresAt: inDays(30),
      },
      select: { id: true },
    });

    const result = await editStrategy(planId, TrafficLimitStrategy.DAY);

    const pushes = await strategyPushes(outside.id);
    assert.equal(pushes.length, 1, 'no term to follow, and still pushed');
    assert.deepEqual(result.pushed, [pushes[0]!.id]);
    assert.equal(result.follow.followed, 0, 'nothing moved in the model');
  });

  it('one subscriber whose step fails holds up nobody; the sweep takes it up again (R3a-01)', async () => {
    const planId = await plan(TrafficLimitStrategy.MONTH);
    const owners = [
      await subscriptionWithResetAddOn(planId),
      await subscriptionWithResetAddOn(planId),
      await subscriptionWithResetAddOn(planId),
    ];
    const committed = await commitStrategyEdit(planId, TrafficLimitStrategy.DAY);
    const failing = owners[1]!.subscriptionId;
    const flaky = {
      followResetRuleInTransaction: async (
        tx: Prisma.TransactionClient,
        input: Parameters<SubscriptionTermService['followResetRuleInTransaction']>[1],
      ) => {
        if (input.subscriptionId === failing) throw new Error('simulated failure');
        return terms.followResetRuleInTransaction(tx, input);
      },
    };
    const warnings: string[] = [];

    const summary = await followResetRules(
      { prisma, terms: flaky, logger: { warn: (message) => void warnings.push(message) } },
      committed.followSubscriptionIds,
      { correlationId: `plan-edit:${planId}`, push: 'always' },
    );

    assert.deepEqual({ followed: summary.followed, failed: summary.failed }, { followed: 2, failed: 1 });
    assert.equal(await activeStrategy(failing), 'MONTH', 'its step rolled back whole');
    assert.equal((await strategyPushes(failing)).length, 0, '…its push with it');
    assert.equal(await activeStrategy(owners[2]!.subscriptionId), 'DAY', 'the one after it was not held up');
    assert.ok(warnings.some((message) => message.includes(failing)));

    await sweeper(recordingQueue()).followChangedResetRules();
    assert.equal(await activeStrategy(failing), 'DAY');
    assert.equal((await strategyPushes(failing)).length, 1);
  });

  it('«Тарифы» → «Редактировать тариф»: the edit returns, and its subscribers follow the new rule after the commit (R3a-01)', async () => {
    const planId = await plan(TrafficLimitStrategy.MONTH);
    const owner = await subscriptionWithResetAddOn(planId);
    const admin = await prisma.adminUser.create({
      data: { login: `${prefix}-admin`, loginNormalized: `${prefix}-admin`, passwordHash: 'not-a-real-hash' },
      select: { id: true },
    });
    created.admins.push(admin.id);
    const remnawave = { getInternalSquadOptions: async () => [], getExternalSquadOptions: async () => [] };
    const queue = recordingQueue();
    const plansAdmin = new PlansAdminService(
      prisma,
      remnawave as never,
      new PlanSnapshotSyncService(),
      new PlansAdminValidators(prisma, remnawave as never),
      new PlanSquadPropagationService(prisma, { enqueue: async () => undefined } as never),
      queue as never,
    );

    await plansAdmin.updatePlan(planId, { trafficLimitStrategy: 'DAY' } as never, {
      currentAdmin: { id: admin.id } as never,
      requestMetadata: { requestId: `${prefix}-req`, remoteAddress: '203.0.113.9', userAgent: 'fx3a' },
    });
    await plansAdmin.settleResetRuleFollows();

    assert.equal(await activeStrategy(owner.subscriptionId), 'DAY');
    const dayReset = nextReset('DAY');
    assert.equal(
      (await liveAddOn(owner.subscriptionId)).expiresAt?.toISOString(),
      new Date(dayReset.getTime() + RESET_EXPIRY_MARGIN_MS).toISOString(),
    );
    const pushes = await strategyPushes(owner.subscriptionId);
    assert.equal(pushes.length, 1);
    assert.deepEqual(queue.ids, [pushes[0]!.id], 'enqueued at once, not left for the five-minute sweep');
    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { adminUserId: admin.id, action: 'plans.updated' },
    });
    assert.deepEqual((audit.metadata as Record<string, unknown>)['resetRuleChange'], { subscriptions: 1 });
  });

  it('a capture after the rule changed binds the quote to the CURRENT rule: DAY quote, plan now MONTH → ends by its date, no card (R3a-02)', async () => {
    const planId = await plan(TrafficLimitStrategy.DAY);
    const owner = await liveSubscription(planId, 'DAY');
    const payment = await resetAddOnPayment(owner, 'DAY');
    const quote = payment.planSnapshot as Record<string, unknown>;
    // Checkout done under DAY; the operator switches the plan to MONTH before the money comes in.
    await editStrategy(planId, TrafficLimitStrategy.MONTH);
    const warnings: unknown[] = [];
    const recording = new PaymentSubscriptionMutationService(
      prisma,
      { info: () => undefined, warn: (...args: unknown[]) => void warnings.push(args), error: () => undefined, emit: () => undefined } as never,
      new AddOnEntitlementService(),
      new EffectiveProjectionService(),
      terms,
      {} as never,
      cutover,
      {
        flags: async () => resolveAddOnRolloutFlags({ durableAccounting: true, trafficResetExpiry: true }, {}, {}),
      } as never,
    );

    await recording.applyCompletedTransaction(payment);

    const addOn = await prisma.addOnEntitlement.findFirstOrThrow({ where: { sourceTransactionId: payment.id } });
    assert.equal(addOn.expiresAt?.toISOString(), quote['quotedExpiresAt'], 'the quoted date, never later');
    assert.equal(addOn.expiryEpochId, null, 'not bound to a DAY reset the MONTH rule never runs');
    assert.deepEqual(warnings, [], 'no «без привязки к сбросу» card: nothing went wrong');
  });

  it('a capture after the rule changed: MONTH quote, plan now DAY → ends at the first DAY reset, bound to it (R3a-02)', async () => {
    const planId = await plan(TrafficLimitStrategy.MONTH);
    const owner = await liveSubscription(planId, 'MONTH');
    const payment = await resetAddOnPayment(owner, 'MONTH');
    await editStrategy(planId, TrafficLimitStrategy.DAY);

    await fulfilment.applyCompletedTransaction(payment);

    const dayReset = nextReset('DAY');
    const addOn = await prisma.addOnEntitlement.findFirstOrThrow({
      where: { sourceTransactionId: payment.id },
      include: { expiryEpoch: true },
    });
    assert.equal(addOn.expiresAt?.toISOString(), new Date(dayReset.getTime() + RESET_EXPIRY_MARGIN_MS).toISOString());
    assert.equal(addOn.expiryEpoch?.plannedEndsAt.toISOString(), dayReset.toISOString());
  });

  it('an import re-snapshot that rewrites the reset rule of a row no plan owns is followed after the import', async () => {
    // An import's own row: its snapshot names the donor's rule and no plan,
    // and its term was minted with no plan either.
    const userId = `${prefix}-user-${next()}`;
    await prisma.user.create({ data: { id: userId, referralCode: `${userId}-ref`, name: userId } });
    created.users.push(userId);
    const panelId = 881_000 + next();
    const row = await prisma.subscription.create({
      data: {
        userId,
        status: SubscriptionStatus.ACTIVE,
        planSnapshot: {
          importedFrom: 'altshop',
          importRecordId: `${prefix}-import-1`,
          trafficLimit: 100,
          deviceLimit: 3,
          trafficLimitStrategy: 'MONTH',
        } as Prisma.InputJsonValue,
        trafficLimit: 100,
        deviceLimit: 3,
        remnawaveId: String(panelId),
        remnawavePanelId: panelId,
        createdAt: inDays(-10),
        startedAt: inDays(-10),
        expiresAt: inDays(60),
      },
      select: { id: true },
    });
    const entered = await prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, row.id));
    assert.equal(entered.outcome, 'CREATED');
    const owner = { userId, subscriptionId: row.id };
    const payment = await resetAddOnPayment(owner, 'MONTH');
    await fulfilment.applyCompletedTransaction(payment);
    assert.equal(await activeStrategy(owner.subscriptionId), 'MONTH', 'fixture: sold under the donor\'s MONTH');

    // The re-import writes the donor's new rule into the row, as `reimportPlanSnapshot` does on no plan.
    const stored = await prisma.subscription.findUniqueOrThrow({ where: { id: row.id }, select: { planSnapshot: true } });
    await prisma.subscription.update({
      where: { id: row.id },
      data: {
        planSnapshot: {
          ...(stored.planSnapshot as Record<string, unknown>),
          importRecordId: `${prefix}-import-2`,
          trafficLimitStrategy: 'DAY',
        } as Prisma.InputJsonValue,
      },
    });

    const queue = recordingQueue();
    const summary = await followChangedResetRules(
      { prisma, terms, enqueue: queue.enqueue },
      { limit: 100, correlationId: `import:${prefix}-import-2`, push: 'if-followed' },
    );

    assert.ok(summary.followed >= 1);
    assert.equal(await activeStrategy(owner.subscriptionId), 'DAY', 'the term follows the rule the snapshot names');
    const dayReset = nextReset('DAY');
    assert.equal(
      (await liveAddOn(owner.subscriptionId)).expiresAt?.toISOString(),
      new Date(dayReset.getTime() + RESET_EXPIRY_MARGIN_MS).toISOString(),
      'the «до сброса» add-on ends at the first DAY reset',
    );
    const pushes = await strategyPushes(owner.subscriptionId);
    assert.equal(pushes.length, 1);
    assert.ok(queue.ids.includes(pushes[0]!.id), 'pushed at once');
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
