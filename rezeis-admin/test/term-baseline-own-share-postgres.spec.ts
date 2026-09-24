import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { AddOnType, Prisma, SubscriptionStatus, SubscriptionTermStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { DeviceReductionPlanService } from '../src/modules/add-on-entitlements/services/device-reduction-plan.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementBoundarySchedulerService } from '../src/modules/add-on-entitlements/services/entitlement-boundary-scheduler.service';
import { EntitlementBoundaryService } from '../src/modules/add-on-entitlements/services/entitlement-boundary.service';
import { EntitlementCutoverService } from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { AdminUserSubscriptionsController } from '../src/modules/users/controllers/admin-user-subscriptions.controller';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';
import { realTermHooks } from './helpers/term-model-hooks';
import {
  activeTerm,
  at,
  createPlan,
  DAY_MS,
  newUser,
  termModelFixtures,
  type Limits,
  type TermModelFixtures,
} from './helpers/term-model-fixtures';

/**
 * WHAT A SUBSCRIPTION IN THE TERM MODEL IS ENTITLED TO BEFORE ADD-ONS: its own
 * share of its columns, whoever wrote them (24.09.2026) — on
 * PostgreSQL, through the real renewal, the real Users-page route, the real
 * checkout fulfilment and the real boundary sweep.
 *
 * The defect: the projection took the term's base — frozen when the term was
 * minted — for every field that read as the plan's (INHERITED) or could not
 * be read (UNDECIDABLE: an import's snapshot carries no limit keys). So a write
 * outside the ledger was undone at the next recompute, mirrored and pushed:
 *
 *  - B1: a never-assigned import at 200 / 5 on a 100 / 3 plan renewed into a
 *    term minted from the plan and was cut to 100 / 3 when that term started;
 *  - B2: an operator's raise on an import came back down at the next purchase
 *    or expiry; an operator's cut of a grandfathered raise came back up;
 *  - rollback: a legacy add-on bought with the flags set back to off was lost
 *    at the next recompute;
 *  - with stage 6 on, the device reduction then deleted down to the wrong
 *    limit.
 *
 * And the three rules for a backward move of `expiresAt`.
 *
 * Skipped without TEST_DATABASE_URL; list it in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const FLAGS = [
  'ADDON_ENTITLEMENT_SHADOW',
  'ADDON_ENTITLEMENT_DIRECT_PURCHASE',
  'ADDON_DEVICE_CLEANUP_AUTO',
] as const;
const STAGES_1_2_6 = ['ADDON_ENTITLEMENT_SHADOW', 'ADDON_ENTITLEMENT_DIRECT_PURCHASE', 'ADDON_DEVICE_CLEANUP_AUTO'] as const;
const PLAN: Limits = { trafficLimit: 100, deviceLimit: 3 };
const REQUEST = { headers: {}, ip: '10.0.0.10', socket: { remoteAddress: null } } as never;

let prisma: PrismaService;
let fx: TermModelFixtures;
let fulfilment: PaymentSubscriptionMutationService;
let boundary: EntitlementBoundaryService;
let scheduler: EntitlementBoundarySchedulerService;
let editor: AdminUserSubscriptionsController;
let adminId = '';
const terms = new SubscriptionTermService();
const projections = new EffectiveProjectionService();
const addOnCatalog: string[] = [];
/** The devices the stubbed panel lists for the device reduction, per call. */
let panelDevices: number = 0;
const executedPlans: string[] = [];

type Owner = { readonly userId: string; readonly subscriptionId: string };

async function withFlags<T>(flags: readonly string[], body: () => Promise<T>): Promise<T> {
  const previous = FLAGS.map((flag) => [flag, process.env[flag]] as const);
  // A stage not named is OFF, spelled out: unset is ON for stages 1, 2 and 6
  // since the 24.09.2026 flip.
  for (const flag of FLAGS) process.env[flag] = 'false';
  for (const flag of flags) process.env[flag] = 'true';
  try {
    return await body();
  } finally {
    for (const [flag, value] of previous) {
      if (value === undefined) delete process.env[flag];
      else process.env[flag] = value;
    }
  }
}

/**
 * An imported row as every importer leaves it: the snapshot names the plan but
 * records no limits (UNDECIDABLE), and the columns are the donor's.
 */
async function importedSubscription(planId: string, columns: Limits, expiresAt: Date = at(20)): Promise<Owner> {
  const userId = await newUser(fx);
  const panelId = 850_000 + fx.next();
  const subscription = await prisma.subscription.create({
    data: {
      userId,
      status: SubscriptionStatus.ACTIVE,
      planSnapshot: { id: planId, trafficLimitStrategy: 'NO_RESET' } as Prisma.InputJsonValue,
      trafficLimit: columns.trafficLimit,
      deviceLimit: columns.deviceLimit,
      internalSquads: [],
      externalSquad: null,
      remnawaveId: String(panelId),
      remnawavePanelId: panelId,
      createdAt: at(-10),
      startedAt: at(-10),
      expiresAt,
    },
    select: { id: true },
  });
  return { userId, subscriptionId: subscription.id };
}

/** What the background cutover does: the first term, minted from the columns. */
async function enterModel(owner: Owner): Promise<void> {
  const cutover = new EntitlementCutoverService(prisma, terms, projections);
  const entered = await prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, owner.subscriptionId));
  assert.equal(entered.outcome, 'CREATED');
}

async function renew(owner: Owner, planId: string): Promise<void> {
  const transaction = await prisma.transaction.create({
    data: {
      paymentId: `${fx.prefix}-pay-${fx.next()}`,
      userId: owner.userId,
      subscriptionId: owner.subscriptionId,
      status: 'COMPLETED',
      purchaseType: 'RENEW',
      channel: 'WEB',
      gatewayType: 'PLATEGA',
      currency: 'RUB',
      amount: new Prisma.Decimal('299'),
      planSnapshot: { id: planId, selectedDurationDays: 30 } as Prisma.InputJsonValue,
    },
  });
  await fulfilment.applyCompletedTransaction(transaction);
}

/** An add-on bought through the real checkout fulfilment: the ledger with stage 2 on, the legacy increment without. */
async function buyAddOn(owner: Owner, type: AddOnType, value: number): Promise<void> {
  const addOnId = `${fx.prefix}-addon-${fx.next()}`;
  await prisma.addOn.create({
    data: { id: addOnId, name: addOnId, type, value, lifetime: 'UNTIL_SUBSCRIPTION_END' },
  });
  addOnCatalog.push(addOnId);
  const transaction = await prisma.transaction.create({
    data: {
      paymentId: `${fx.prefix}-pay-${fx.next()}`,
      userId: owner.userId,
      subscriptionId: null,
      status: 'COMPLETED',
      purchaseType: 'ADDITIONAL',
      channel: 'WEB',
      gatewayType: 'PLATEGA',
      currency: 'RUB',
      amount: new Prisma.Decimal('99'),
      planSnapshot: {
        snapshotSource: 'ADDON_PURCHASE',
        addOnId,
        addOnType: type,
        addOnValue: value,
        name: addOnId,
        targetSubscriptionId: owner.subscriptionId,
        purchaseType: 'ADDITIONAL',
        gatewayType: 'PLATEGA',
        amount: '99',
        currency: 'RUB',
        contractVersion: 1,
        addOnRevision: 1,
        lifetime: 'UNTIL_SUBSCRIPTION_END',
        sourceLineKey: addOnId,
      } as Prisma.InputJsonValue,
    },
  });
  await fulfilment.applyCompletedTransaction(transaction);
}

/** The add-on bought last ends a moment from now; the sweep a moment later expires it. */
async function endLatestAddOn(owner: Owner): Promise<Date> {
  const latest = await prisma.addOnEntitlement.findFirstOrThrow({
    where: { subscriptionId: owner.subscriptionId, state: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
  });
  const endsAt = new Date(Math.max(Date.now(), latest.scheduledActivationAt.getTime()) + 1_000);
  await prisma.addOnEntitlement.update({ where: { id: latest.id }, data: { expiresAt: endsAt } });
  return new Date(endsAt.getTime() + 1_000);
}

const patch = (owner: Owner, body: Record<string, unknown>) =>
  editor.updateSubscription(owner.subscriptionId, body, { id: adminId } as never, REQUEST);

async function limits(owner: Owner): Promise<Limits> {
  const row = await prisma.subscription.findUniqueOrThrow({
    where: { id: owner.subscriptionId },
    select: { trafficLimit: true, deviceLimit: true },
  });
  return { trafficLimit: row.trafficLimit, deviceLimit: row.deviceLimit };
}

async function desired(owner: Owner): Promise<Limits> {
  const row = await prisma.subscriptionEffectiveProjection.findUniqueOrThrow({
    where: { subscriptionId: owner.subscriptionId },
  });
  return {
    trafficLimit: row.desiredTrafficLimitBytes === null ? null : Number(row.desiredTrafficLimitBytes / (1024n ** 3n)),
    deviceLimit: row.desiredDeviceLimit ?? 0,
  };
}

run('the baseline is the subscription’s own share of its columns — PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    for (const flag of FLAGS) process.env[flag] = 'false';
    prisma = new PrismaService();
    await prisma.$connect();
    fx = termModelFixtures(prisma, `d2own-${process.pid}-${Date.now()}`);
    const events = { info: () => undefined, warn: () => undefined, error: () => undefined, emit: () => undefined };
    fulfilment = new PaymentSubscriptionMutationService(
      prisma,
      events as never,
      new AddOnEntitlementService(),
      projections,
      terms,
      {} as never,
    );
    boundary = new EntitlementBoundaryService(prisma, new AddOnEntitlementService(), terms, projections);
    // The real planner against a panel that lists `panelDevices` devices, and
    // an executor that only records what it was asked to run.
    const panel = {
      strictListUserDevices: async () => ({
        kind: 'ok' as const,
        value: {
          devices: Array.from({ length: panelDevices }, (_, index) => ({
            hwid: `${fx.prefix}-hwid-${index}`,
            createdAt: new Date(Date.now() - (panelDevices - index) * DAY_MS).toISOString(),
          })),
          total: panelDevices,
        },
        detectedVersion: '2.8.0',
      }),
    };
    scheduler = new EntitlementBoundarySchedulerService(
      prisma,
      boundary,
      { enqueue: async () => undefined } as never,
      new DeviceReductionPlanService(prisma, panel as never),
      {
        executePlan: async (planId: string) => {
          executedPlans.push(planId);
          return { status: 'APPLIED', deleted: 0 };
        },
      } as never,
      terms,
    );
    editor = new AdminUserSubscriptionsController(
      prisma,
      {} as never,
      { enqueue: async () => undefined } as never,
      events as never,
      {} as never,
      {} as never,
      realTermHooks(prisma),
    );
    const admin = await prisma.adminUser.create({
      data: { login: `${fx.prefix}-admin`, loginNormalized: `${fx.prefix}-admin`, passwordHash: 'not-a-hash' },
      select: { id: true },
    });
    adminId = admin.id;
  });

  after(async () => {
    if (prisma === undefined) return;
    await prisma.adminAuditLog.deleteMany({ where: { adminUserId: adminId } }).catch(() => undefined);
    await removeDurableFixtures(prisma, fx.users).catch(() => undefined);
    await prisma.addOn.deleteMany({ where: { id: { in: addOnCatalog } } }).catch(() => undefined);
    await prisma.plan.deleteMany({ where: { id: { in: fx.plans } } }).catch(() => undefined);
    await prisma.adminUser.deleteMany({ where: { id: adminId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('B1: a never-assigned import keeps its own limits when its first renewal term starts — flags on, and after a rollback', async () => {
    const plan = await createPlan(fx, PLAN);

    // Stage 1 on: the renewal brings the row into the model, the term starts.
    const on = await importedSubscription(plan, { trafficLimit: 200, deviceLimit: 5 }, at(1));
    await withFlags(STAGES_1_2_6, () => renew(on, plan));
    const queued = await prisma.subscriptionTerm.findFirstOrThrow({
      where: { subscriptionId: on.subscriptionId, status: SubscriptionTermStatus.SCHEDULED },
    });
    assert.equal(queued.baseDeviceLimit, 3, 'the renewal’s term is minted from the plan');
    await withFlags(STAGES_1_2_6, () => boundary.activateDueScheduledTerm(on.subscriptionId, new Date(queued.startsAt.getTime() + 1_000)));
    assert.deepEqual(await limits(on), { trafficLimit: 200, deviceLimit: 5 }, 'the column path keeps them, so must the model');
    assert.deepEqual(await desired(on), { trafficLimit: 200, deviceLimit: 5 }, 'and the panel is sent the same');

    // Rollback: every flag back off, the term stays. The next renewal's term
    // starts the same way.
    await withFlags([], () => renew(on, plan));
    const next = await prisma.subscriptionTerm.findFirstOrThrow({
      where: { subscriptionId: on.subscriptionId, status: SubscriptionTermStatus.SCHEDULED },
    });
    await withFlags([], () => boundary.activateDueScheduledTerm(on.subscriptionId, new Date(next.startsAt.getTime() + 1_000)));
    assert.deepEqual(await limits(on), { trafficLimit: 200, deviceLimit: 5 });
  });

  it('B2: an operator’s raise on an import survives the next purchase and the add-on’s expiry', async () => {
    const plan = await createPlan(fx, PLAN);
    const owner = await importedSubscription(plan, PLAN);
    await enterModel(owner);

    await withFlags(STAGES_1_2_6, async () => {
      await patch(owner, { deviceLimit: 5 });
      await buyAddOn(owner, AddOnType.EXTRA_TRAFFIC, 10);
      assert.deepEqual(await limits(owner), { trafficLimit: 110, deviceLimit: 5 }, 'the purchase took the raise back');

      const sweepAt = await endLatestAddOn(owner);
      await scheduler.runDueBoundaries(sweepAt);
    });
    assert.deepEqual(await limits(owner), { trafficLimit: 100, deviceLimit: 5 }, 'the expiry took the raise back');
  });

  it('B2: an operator’s cut of a grandfathered raise stays cut', async () => {
    const plan = await createPlan(fx, PLAN);
    // The plan's snapshot says 3; the columns hold a grandfathered +2, so the
    // cutover mints the term's base at 5.
    const userId = await newUser(fx);
    const row = await prisma.subscription.create({
      data: {
        userId,
        status: SubscriptionStatus.ACTIVE,
        planSnapshot: { id: plan, name: plan, trafficLimit: 100, deviceLimit: 3, internalSquads: [], externalSquad: null },
        trafficLimit: 100,
        deviceLimit: 5,
        internalSquads: [],
        externalSquad: null,
        remnawaveId: `${fx.prefix}-rw-${fx.next()}`,
        createdAt: at(-10),
        startedAt: at(-10),
        expiresAt: at(20),
      },
      select: { id: true },
    });
    const owner = { userId, subscriptionId: row.id };
    await enterModel(owner);
    assert.equal((await activeTerm(prisma, owner.subscriptionId)).baseDeviceLimit, 5);

    await withFlags(STAGES_1_2_6, async () => {
      await patch(owner, { deviceLimit: 3 });
      await buyAddOn(owner, AddOnType.EXTRA_TRAFFIC, 10);
      assert.equal((await limits(owner)).deviceLimit, 3, 'the purchase gave the cut raise back');
      await scheduler.runDueBoundaries(await endLatestAddOn(owner));
    });
    assert.equal((await limits(owner)).deviceLimit, 3, 'the expiry gave the cut raise back');
  });

  it('rollback: a legacy add-on bought with the flags off is not lost at the next recompute', async () => {
    const plan = await createPlan(fx, PLAN);
    const owner = await importedSubscription(plan, PLAN);
    await enterModel(owner);
    // Bought while stage 2 was on: a dated add-on, live.
    await withFlags(STAGES_1_2_6, () => buyAddOn(owner, AddOnType.EXTRA_TRAFFIC, 10));

    // Rolled back: the next add-on is the legacy permanent increment.
    await withFlags([], () => buyAddOn(owner, AddOnType.EXTRA_DEVICES, 2));
    assert.deepEqual(await limits(owner), { trafficLimit: 110, deviceLimit: 5 });
    assert.equal(
      await prisma.addOnEntitlement.count({ where: { subscriptionId: owner.subscriptionId, type: AddOnType.EXTRA_DEVICES } }),
      0,
      'the legacy increment has no ledger row',
    );

    // The dated add-on ends: the recompute keeps what the customer paid for.
    await withFlags([], async () => scheduler.runDueBoundaries(await endLatestAddOn(owner)));
    assert.deepEqual(await limits(owner), { trafficLimit: 100, deviceLimit: 5 }, 'the paid +2 devices were lost');
  });

  it('stage 6: the device reduction after an add-on’s expiry stops at the operator’s raise, not at the old base', async () => {
    const plan = await createPlan(fx, PLAN);
    const owner = await importedSubscription(plan, PLAN);
    await enterModel(owner);

    await withFlags(STAGES_1_2_6, async () => {
      await patch(owner, { deviceLimit: 5 });
      await buyAddOn(owner, AddOnType.EXTRA_DEVICES, 1);
      assert.equal((await limits(owner)).deviceLimit, 6);
      // Six devices connected when the add-on runs out.
      panelDevices = 6;
      await scheduler.runDueBoundaries(await endLatestAddOn(owner));
    });

    const plans = await prisma.deviceReductionPlan.findMany({ where: { subscriptionId: owner.subscriptionId } });
    assert.equal(plans.length, 1, 'no reduction was planned');
    assert.equal(plans[0]!.desiredLimit, 5, 'the reduction would delete down to the old base');
    assert.equal((plans[0]!.selectedDevices as unknown[]).length, 1, 'one device over, not three');
    assert.ok(executedPlans.includes(plans[0]!.id), 'stage 6 runs the plan');
    assert.equal((await limits(owner)).deviceLimit, 5);
  });

  describe('a backward move of the expiry, and the add-ons sold «until the end of the subscription»', () => {
    async function withLiveAddOn(): Promise<{ owner: Owner; addOnId: string }> {
      const plan = await createPlan(fx, PLAN);
      const owner = await importedSubscription(plan, PLAN, at(20));
      await enterModel(owner);
      await withFlags(STAGES_1_2_6, () => buyAddOn(owner, AddOnType.EXTRA_TRAFFIC, 10));
      const addOn = await prisma.addOnEntitlement.findFirstOrThrow({ where: { subscriptionId: owner.subscriptionId } });
      const row = await prisma.subscription.findUniqueOrThrow({ where: { id: owner.subscriptionId } });
      assert.equal(addOn.expiresAt?.getTime(), row.expiresAt?.getTime(), 'sold until the end of the subscription');
      return { owner, addOnId: addOn.id };
    }

    it('a move that stays in the future re-times them: they end with the subscription, later', async () => {
      const { owner, addOnId } = await withLiveAddOn();
      const earlier = at(5);

      await patch(owner, { expiresAt: earlier.toISOString() });
      await scheduler.runDueBoundaries(new Date());

      const addOn = await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: addOnId } });
      assert.equal(addOn.state, 'ACTIVE', 'a subscription still running keeps its add-on');
      assert.equal(addOn.expiresAt?.getTime(), earlier.getTime(), 'it ends where the subscription now does');
    });

    it('a move into the past ends them, and a later extension does not bring them back', async () => {
      const { owner, addOnId } = await withLiveAddOn();

      await patch(owner, { expiresAt: new Date(Date.now() - 60_000).toISOString() });
      // Bought a moment ago, the add-on can end no earlier than a second after
      // its own start (`add_on_entitlements_boundary_check`); the sweep runs
      // after that.
      await scheduler.runDueBoundaries(new Date(Date.now() + 5_000));
      assert.equal((await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: addOnId } })).state, 'EXPIRED');
      assert.equal((await limits(owner)).trafficLimit, 100);

      await patch(owner, { expiresAt: at(30).toISOString() });
      assert.equal(
        (await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: addOnId } })).state,
        'EXPIRED',
        'an ended add-on stays ended',
      );
      assert.equal((await limits(owner)).trafficLimit, 100);
    });

    it('a later extension of a subscription still running carries them along: none is stranded', async () => {
      const { owner, addOnId } = await withLiveAddOn();

      await patch(owner, { expiresAt: at(5).toISOString() });
      const later = at(40);
      await patch(owner, { expiresAt: later.toISOString() });
      await scheduler.runDueBoundaries(at(10));

      const addOn = await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: addOnId } });
      assert.equal(addOn.state, 'ACTIVE', 'stranded at the shortened end, it expired with the subscription still running');
      assert.equal(addOn.expiresAt?.getTime(), later.getTime());
      assert.equal((await limits(owner)).trafficLimit, 110);
    });
  });
});
