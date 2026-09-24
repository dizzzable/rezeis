import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { AddOnType, Prisma, SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { DeviceReductionPlanService } from '../src/modules/add-on-entitlements/services/device-reduction-plan.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementBoundarySchedulerService } from '../src/modules/add-on-entitlements/services/entitlement-boundary-scheduler.service';
import { EntitlementBoundaryService } from '../src/modules/add-on-entitlements/services/entitlement-boundary.service';
import { EntitlementCutoverService } from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { RemnawaveWebhookService } from '../src/modules/remnawave/services/remnawave-webhook.service';
import { REMNAWAVE_LIMIT_DRIFT_CAUSE } from '../src/modules/remnawave/services/term-model-readback';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';
import {
  at,
  createPlan,
  DAY_MS,
  newUser,
  termModelFixtures,
  type Limits,
  type TermModelFixtures,
} from './helpers/term-model-fixtures';

/**
 * A Remnawave `user.*` webhook against a subscription IN the durable term
 * model, through the real reconcile, the real ledger fulfilment, the real
 * boundary sweep and the real device-reduction planner.
 *
 * In the model a subscription's limits are "own share + the add-ons the
 * projection recorded", and the own share is read back as the column less that
 * recorded share. So the webhook must not copy Remnawave's limits into such a
 * column: an event that predates the panel's own last push (the push late,
 * failing, or the event delivered late) is an OLD state, and taking it as the
 * customer's own put the device reduction below the plan (W1) or brought an
 * ended add-on back (W2). The decision (see `reconcileSubscriptionFromEvent`):
 *
 *  - limits: never taken from an event; a profile holding other limits than
 *    rezeis would push gets rezeis' own pushed back, unless the event is an
 *    echo of an older state (G1–G3); nothing is pushed for a profile two live
 *    rows name (D1, D2), one deleted in Remnawave (X1) or a row with no panel
 *    link (U1);
 *  - expiry: taken as before, unless the panel's own last push outranks the
 *    event (E1–E4, N1); the status follows the same rule (E1, and
 *    `remnawave-status-term-model-postgres`);
 *  - a subscription OUTSIDE the model: exactly as before (O1).
 *
 * Every flag is pinned in each case, so the rules hold whatever the defaults.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;

const FLAGS = [
  'ADDON_ENTITLEMENT_SHADOW',
  'ADDON_ENTITLEMENT_DIRECT_PURCHASE',
  'ADDON_DEVICE_CLEANUP_AUTO',
] as const;
/** The shipped target: stages 1, 2 and 6 ON. */
const STAGES_1_2_6: Readonly<Record<(typeof FLAGS)[number], 'true' | 'false'>> = {
  ADDON_ENTITLEMENT_SHADOW: 'true',
  ADDON_ENTITLEMENT_DIRECT_PURCHASE: 'true',
  ADDON_DEVICE_CLEANUP_AUTO: 'true',
};
const PLAN: Limits = { trafficLimit: 100, deviceLimit: 3 };
const GIB = 1024 ** 3;
/** A panel id range no other spec uses, so an event names only our rows. */
const PANEL_BASE = 1_700_000_000 + (Date.now() % 4_000_000) * 100;

let prisma: PrismaService;
let fx: TermModelFixtures;
let fulfilment: PaymentSubscriptionMutationService;
let scheduler: EntitlementBoundarySchedulerService;
const terms = new SubscriptionTermService();
const projections = new EffectiveProjectionService();
const addOnCatalog: string[] = [];
/** Devices the fake panel reports for the planner. */
let panelDevices = 0;
/** Plans the stage-6 executor was asked to run. */
const executedPlans: string[] = [];
/** Sync jobs the webhook handed to the queue. */
const enqueued: string[] = [];
let webhook: RemnawaveWebhookService;

type Owner = { readonly userId: string; readonly subscriptionId: string; readonly panelId: number };

async function withFlags<T>(flags: Readonly<Record<string, string>>, body: () => Promise<T>): Promise<T> {
  const previous = FLAGS.map((flag) => [flag, process.env[flag]] as const);
  for (const flag of FLAGS) process.env[flag] = flags[flag] ?? 'false';
  try {
    return await body();
  } finally {
    for (const [flag, value] of previous) {
      if (value === undefined) delete process.env[flag];
      else process.env[flag] = value;
    }
  }
}

/** A linked subscription on a 3 / 100 GB plan, as a panel-bought one looks. */
async function panelSubscription(
  planId: string,
  options: { readonly panelId?: number; readonly columns?: Limits } = {},
): Promise<Owner> {
  const userId = await newUser(fx);
  const panelId = options.panelId ?? PANEL_BASE + fx.next();
  const columns = options.columns ?? PLAN;
  const row = await prisma.subscription.create({
    data: {
      userId,
      status: SubscriptionStatus.ACTIVE,
      planSnapshot: {
        id: planId,
        name: planId,
        trafficLimit: PLAN.trafficLimit,
        deviceLimit: PLAN.deviceLimit,
        trafficLimitStrategy: 'NO_RESET',
        internalSquads: [],
        externalSquad: null,
      },
      trafficLimit: columns.trafficLimit,
      deviceLimit: columns.deviceLimit,
      internalSquads: [],
      externalSquad: null,
      remnawaveId: String(panelId),
      remnawavePanelId: panelId,
      createdAt: at(-10),
      startedAt: at(-10),
      expiresAt: at(20),
    },
    select: { id: true },
  });
  return { userId, subscriptionId: row.id, panelId };
}

async function enterModel(owner: Owner): Promise<void> {
  const cutover = new EntitlementCutoverService(prisma, terms, projections);
  const entered = await prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, owner.subscriptionId));
  assert.equal(entered.outcome, 'CREATED');
}

async function buyAddOn(owner: Owner, type: AddOnType, value: number): Promise<void> {
  const addOnId = `${fx.prefix}-addon-${fx.next()}`;
  await prisma.addOn.create({ data: { id: addOnId, name: addOnId, type, value, lifetime: 'UNTIL_SUBSCRIPTION_END' } });
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

/** Moves the newest ACTIVE add-on's end to just past now; returns a sweep instant after it. */
async function endLatestAddOn(owner: Owner): Promise<Date> {
  const latest = await prisma.addOnEntitlement.findFirstOrThrow({
    where: { subscriptionId: owner.subscriptionId, state: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
  });
  const endsAt = new Date(Math.max(Date.now(), latest.scheduledActivationAt.getTime()) + 1_000);
  await prisma.addOnEntitlement.update({ where: { id: latest.id }, data: { expiresAt: endsAt } });
  return new Date(endsAt.getTime() + 1_000);
}

/** A 3.x `user.*` webhook for this profile, stamped by the panel at `stampedAt`. */
async function panelEvent(
  owner: Owner,
  data: Record<string, unknown>,
  stampedAt: Date = new Date(),
  event = 'user.modified',
): Promise<void> {
  await (
    webhook as unknown as {
      reconcileSubscriptionFromEvent(event: string, payload: Record<string, unknown>): Promise<void>;
    }
  ).reconcileSubscriptionFromEvent(event, {
    scope: 'user',
    event,
    timestamp: stampedAt.toISOString(),
    data: { id: owner.panelId, ...data },
  });
}

/**
 * A push of the panel's own, in the state given. Created `createdAt` (a moment
 * before its completion by default), so the order of two pushes never rests on
 * two inserts landing in different milliseconds.
 */
async function pushOfOurs(
  owner: Owner,
  status: SyncJobStatus,
  completedAt: Date | null = null,
  createdAt: Date = completedAt === null ? new Date() : new Date(completedAt.getTime() - 1_000),
): Promise<string> {
  const job = await prisma.profileSyncJob.create({
    data: {
      subscriptionId: owner.subscriptionId,
      action: SyncAction.UPDATE,
      status,
      completedAt,
      createdAt,
      payload: { source: 'ADMIN_MUTATION' },
    },
    select: { id: true },
  });
  return job.id;
}

async function row(owner: Owner) {
  return prisma.subscription.findUniqueOrThrow({
    where: { id: owner.subscriptionId },
    select: { trafficLimit: true, deviceLimit: true, expiresAt: true, status: true, planSnapshot: true },
  });
}

/** The pushes the webhook queued to put the panel's limits back. */
async function putBacks(owner: Owner) {
  return prisma.profileSyncJob.findMany({
    where: { subscriptionId: owner.subscriptionId, cause: REMNAWAVE_LIMIT_DRIFT_CAUSE },
    orderBy: { createdAt: 'asc' },
  });
}

const ago = (ms: number): Date => new Date(Date.now() - ms);

run('a Remnawave webhook against a subscription in the term model (PostgreSQL)', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    prisma = new PrismaService();
    await prisma.$connect();
    fx = termModelFixtures(prisma, `rwtm-${process.pid}-${Date.now()}`);
    const events = { info: () => undefined, warn: () => undefined, error: () => undefined, emit: () => undefined };
    fulfilment = new PaymentSubscriptionMutationService(
      prisma,
      events as never,
      new AddOnEntitlementService(),
      projections,
      terms,
      {} as never,
    );
    const boundary = new EntitlementBoundaryService(prisma, new AddOnEntitlementService(), terms, projections);
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
        detectedVersion: '3.3.2',
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
    const queue = { enqueue: async (syncJobId: string) => void enqueued.push(syncJobId) };
    webhook = new RemnawaveWebhookService(
      prisma,
      { webhookSecret: null } as never,
      events as never,
      { getPanelUserUsage: async () => null } as never,
      { build: async () => ({}) } as never,
      { create: async () => undefined } as never,
      { get: () => queue } as never,
    );
  });

  beforeEach(() => {
    executedPlans.length = 0;
    enqueued.length = 0;
    panelDevices = 0;
  });

  after(async () => {
    if (prisma === undefined) return;
    await removeDurableFixtures(prisma, fx.users).catch(() => undefined);
    await prisma.addOn.deleteMany({ where: { id: { in: addOnCatalog } } }).catch(() => undefined);
    await prisma.plan.deleteMany({ where: { id: { in: fx.plans } } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('W1 an echo from before a +2 device purchase landed: stage 6 reduces to the plan (3), not below it', async () => {
    const plan = await createPlan(fx, PLAN);
    const owner = await panelSubscription(plan);
    await enterModel(owner);
    await withFlags(STAGES_1_2_6, async () => {
      await buyAddOn(owner, AddOnType.EXTRA_DEVICES, 2);
      assert.equal((await row(owner)).deviceLimit, 5, 'the purchase mirrored 5');
      // The purchase's push is still queued: the profile holds the old 3.
      await panelEvent(owner, { hwidDeviceLimit: 3, trafficLimitBytes: 100 * GIB });
      assert.equal((await row(owner)).deviceLimit, 5, 'the echo is not the customer’s limit');
      assert.equal((await putBacks(owner)).length, 0, 'the purchase’s own push carries the 5; nothing is added');
      panelDevices = 5;
      await scheduler.runDueBoundaries(await endLatestAddOn(owner));
    });
    const plans = await prisma.deviceReductionPlan.findMany({ where: { subscriptionId: owner.subscriptionId } });
    assert.equal(plans.length, 1, 'one reduction plan');
    assert.deepEqual(
      { planned: plans[0]!.desiredLimit, column: (await row(owner)).deviceLimit },
      { planned: 3, column: 3 },
      'the device reduction must stop at the plan the customer pays for',
    );
    // The sweep is shared with every other spec's rows, so only ours is asked about.
    assert.ok(executedPlans.includes(plans[0]!.id), 'stage 6 executed that plan');
  });

  it('W2 an echo from before a +10 GB add-on ended: the ended add-on does not come back', async () => {
    const plan = await createPlan(fx, PLAN);
    const owner = await panelSubscription(plan);
    await enterModel(owner);
    await withFlags(STAGES_1_2_6, async () => {
      await buyAddOn(owner, AddOnType.EXTRA_TRAFFIC, 10);
      assert.equal((await row(owner)).trafficLimit, 110);
      await scheduler.runDueBoundaries(await endLatestAddOn(owner));
      assert.equal((await row(owner)).trafficLimit, 100, 'the expiry mirrored 100');
      // The expiry's push is still queued: the profile holds 110.
      await panelEvent(owner, { trafficLimitBytes: 110 * GIB });
      await buyAddOn(owner, AddOnType.EXTRA_TRAFFIC, 5);
    });
    assert.equal((await row(owner)).trafficLimit, 105, 'the ended +10 GB must not return as own share');
  });

  it('G1 a limit set in Remnawave after our last push is put back: not taken, and pushed again', async () => {
    const plan = await createPlan(fx, PLAN);
    const owner = await panelSubscription(plan);
    await enterModel(owner);
    await pushOfOurs(owner, SyncJobStatus.COMPLETED, ago(60_000));
    const snapshotBefore = (await row(owner)).planSnapshot;
    const extended = at(25);
    await withFlags(STAGES_1_2_6, () =>
      panelEvent(owner, { hwidDeviceLimit: 7, trafficLimitBytes: 300 * GIB, expireAt: extended.toISOString() }, ago(10_000)),
    );
    const after = await row(owner);
    assert.deepEqual(
      { trafficLimit: after.trafficLimit, deviceLimit: after.deviceLimit },
      { trafficLimit: 100, deviceLimit: 3 },
      'the limits stay the panel’s',
    );
    assert.deepEqual(after.planSnapshot, snapshotBefore, 'and so does the snapshot');
    assert.equal(after.expiresAt?.getTime(), extended.getTime(), 'an expiry set in Remnawave is still taken');
    const jobs = await putBacks(owner);
    assert.equal(jobs.length, 1, 'one push of the panel’s own limits');
    assert.equal(jobs[0]!.action, SyncAction.UPDATE);
    assert.equal(jobs[0]!.status, SyncJobStatus.PENDING);
    assert.deepEqual(jobs[0]!.payload, { source: REMNAWAVE_LIMIT_DRIFT_CAUSE }, 'no status is pushed with it');
    assert.deepEqual(enqueued, [jobs[0]!.id], 'and it is queued at once');
  });

  it('G2 the echo of that push is not answered, and neither is a late copy of the edit', async () => {
    const plan = await createPlan(fx, PLAN);
    const owner = await panelSubscription(plan);
    await enterModel(owner);
    // Our put-back push landed and was recorded 5 s ago.
    await pushOfOurs(owner, SyncJobStatus.COMPLETED, ago(5_000));
    await withFlags(STAGES_1_2_6, async () => {
      // Its echo, stamped while it landed.
      await panelEvent(owner, { hwidDeviceLimit: 3, trafficLimitBytes: 100 * GIB }, ago(6_000));
      // The operator's edit it answered, delivered late.
      await panelEvent(owner, { hwidDeviceLimit: 7, trafficLimitBytes: 300 * GIB }, ago(8_000));
    });
    assert.equal((await putBacks(owner)).length, 0, 'nothing newer than our own push');
    assert.deepEqual(enqueued, []);
    // The operator sets it again in Remnawave: put back again, every time.
    await withFlags(STAGES_1_2_6, () => panelEvent(owner, { hwidDeviceLimit: 7 }, ago(2_000)));
    assert.equal((await putBacks(owner)).length, 1);
    assert.equal((await row(owner)).deviceLimit, 3);
  });

  it('G3 limits equal to what the panel pushes are in step, in the panel’s own encoding of unlimited', async () => {
    const plan = await createPlan(fx, PLAN);
    // Unlimited traffic (`null`) and devices as a plan stores them (`-1`),
    // and a finite zero of traffic: each goes out as `0`, and comes back so.
    const unlimited = await panelSubscription(plan, { columns: { trafficLimit: null, deviceLimit: -1 } });
    const zero = await panelSubscription(plan, { columns: { trafficLimit: 0, deviceLimit: 0 } });
    for (const owner of [unlimited, zero]) {
      await enterModel(owner);
      await withFlags(STAGES_1_2_6, () => panelEvent(owner, { hwidDeviceLimit: 0, trafficLimitBytes: 0 }));
      assert.equal((await putBacks(owner)).length, 0, 'in step: nothing to push');
    }
    assert.equal((await row(unlimited)).deviceLimit, -1, 'and nothing written');
    assert.equal((await row(zero)).trafficLimit, 0);
  });

  it('D1 a profile two live subscriptions name is not pushed for either', async () => {
    const plan = await createPlan(fx, PLAN);
    const first = await panelSubscription(plan);
    const second = await panelSubscription(plan, { panelId: first.panelId });
    await enterModel(first);
    await enterModel(second);
    await withFlags(STAGES_1_2_6, () => panelEvent(first, { hwidDeviceLimit: 7 }));
    for (const owner of [first, second]) {
      assert.equal((await putBacks(owner)).length, 0, 'a duplicate pair would push over each other forever');
      assert.equal((await row(owner)).deviceLimit, 3, 'and neither takes the limit');
    }
  });

  it('D2 a pair with one row outside the model: that one mirrors as before, the one in it keeps limits and snapshot', async () => {
    const plan = await createPlan(fx, PLAN);
    const inside = await panelSubscription(plan);
    const outside = await panelSubscription(plan, { panelId: inside.panelId });
    await enterModel(inside);
    const snapshotBefore = (await row(inside)).planSnapshot;
    await withFlags(STAGES_1_2_6, () => panelEvent(inside, { hwidDeviceLimit: 7, trafficLimitBytes: 300 * GIB }));
    const mirrored = await row(outside);
    assert.deepEqual({ trafficLimit: mirrored.trafficLimit, deviceLimit: mirrored.deviceLimit }, { trafficLimit: 300, deviceLimit: 7 });
    assert.equal((mirrored.planSnapshot as Record<string, unknown>)['deviceLimit'], 7);
    const kept = await row(inside);
    assert.deepEqual({ trafficLimit: kept.trafficLimit, deviceLimit: kept.deviceLimit }, { trafficLimit: 100, deviceLimit: 3 });
    assert.deepEqual(kept.planSnapshot, snapshotBefore, 'the snapshot pass leaves the row in the model alone');
    assert.equal((await putBacks(inside)).length, 0, 'two rows name the profile: nothing is pushed');
  });

  it('X1 a profile deleted in Remnawave is not pushed back into existence', async () => {
    const plan = await createPlan(fx, PLAN);
    const owner = await panelSubscription(plan);
    await enterModel(owner);
    // The last state of the profile, with other limits: an UPDATE for it would
    // find it gone and re-provision it through CREATE.
    await withFlags(STAGES_1_2_6, () => panelEvent(owner, { hwidDeviceLimit: 7 }, new Date(), 'user.deleted'));
    assert.equal((await putBacks(owner)).length, 0);
    assert.equal((await row(owner)).deviceLimit, 3, 'and the limit is not taken either');
  });

  it('U1 a row in the model with no panel link is not pushed for: an UPDATE without one would provision', async () => {
    const plan = await createPlan(fx, PLAN);
    const owner = await panelSubscription(plan);
    await prisma.subscription.update({ where: { id: owner.subscriptionId }, data: { remnawaveId: null } });
    await enterModel(owner);
    await withFlags(STAGES_1_2_6, () => panelEvent(owner, { hwidDeviceLimit: 7 }));
    assert.equal((await putBacks(owner)).length, 0);
    assert.equal((await row(owner)).deviceLimit, 3);
  });

  it('E1 while a push of ours is queued, neither the event’s earlier expiry nor its status is taken', async () => {
    const plan = await createPlan(fx, PLAN);
    const owner = await panelSubscription(plan);
    await enterModel(owner);
    const before = (await row(owner)).expiresAt;
    // An older push landed a minute ago; then a renewal (or bonus days) moved
    // the expiry, and ITS push has not landed. The latest push is what counts.
    await pushOfOurs(owner, SyncJobStatus.COMPLETED, ago(60_000));
    await pushOfOurs(owner, SyncJobStatus.PENDING);
    await withFlags(STAGES_1_2_6, () =>
      panelEvent(owner, { status: 'DISABLED', expireAt: at(5).toISOString(), hwidDeviceLimit: 9 }),
    );
    const after = await row(owner);
    assert.equal(after.expiresAt?.getTime(), before?.getTime(), 'the paid days are not rolled back');
    // The status follows the expiry (`remnawave-status-term-model-postgres`):
    // the queued push's own answer brings the fresh one — DISABLED included,
    // because that push sends no status of its own and the owner is not
    // blocked (S15 there).
    assert.equal(after.status, SubscriptionStatus.ACTIVE, 'nor is the status of a state our push replaces');
    assert.equal(after.deviceLimit, 3);
    assert.equal((await putBacks(owner)).length, 0, 'the queued push carries our state');
  });

  it('E2 an event stamped before our last push landed, delivered late, does not move the expiry', async () => {
    const plan = await createPlan(fx, PLAN);
    const owner = await panelSubscription(plan);
    await enterModel(owner);
    const before = (await row(owner)).expiresAt;
    await pushOfOurs(owner, SyncJobStatus.COMPLETED, ago(60_000));
    // An event that states only the expiry is decided the same way.
    await withFlags(STAGES_1_2_6, () =>
      panelEvent(owner, { expireAt: at(5).toISOString() }, ago(120_000), 'user.expiration'),
    );
    assert.equal((await row(owner)).expiresAt?.getTime(), before?.getTime());
  });

  it('E3 a push that failed long ago does not hold the expiry once a later one has landed', async () => {
    const plan = await createPlan(fx, PLAN);
    const owner = await panelSubscription(plan);
    await enterModel(owner);
    await pushOfOurs(owner, SyncJobStatus.FAILED, null, ago(3_600_000));
    await pushOfOurs(owner, SyncJobStatus.COMPLETED, ago(60_000));
    const moved = at(25);
    await withFlags(STAGES_1_2_6, () => panelEvent(owner, { expireAt: moved.toISOString() }, ago(10_000)));
    assert.equal((await row(owner)).expiresAt?.getTime(), moved.getTime());
  });

  it('E4 neither a superseded push nor a queued traffic reset holds anything back', async () => {
    const plan = await createPlan(fx, PLAN);
    const owner = await panelSubscription(plan);
    await enterModel(owner);
    await pushOfOurs(owner, SyncJobStatus.COMPLETED, ago(60_000));
    // Superseded: inert, it will never run. A traffic reset pushes no limits
    // and no expiry. Both are newer than the push that landed.
    await prisma.profileSyncJob.create({
      data: {
        subscriptionId: owner.subscriptionId,
        action: SyncAction.UPDATE,
        status: SyncJobStatus.PENDING,
        supersededAt: new Date(),
        payload: {},
      },
    });
    await prisma.profileSyncJob.create({
      data: {
        subscriptionId: owner.subscriptionId,
        action: SyncAction.TRAFFIC_RESET,
        status: SyncJobStatus.PENDING,
        payload: {},
      },
    });
    const moved = at(25);
    await withFlags(STAGES_1_2_6, () =>
      panelEvent(owner, { expireAt: moved.toISOString(), hwidDeviceLimit: 7 }, ago(10_000)),
    );
    assert.equal((await row(owner)).expiresAt?.getTime(), moved.getTime(), 'the expiry is taken');
    assert.equal((await putBacks(owner)).length, 1, 'and the limits are put back');
  });

  it('N1 a subscription rezeis never pushed takes the expiry as before', async () => {
    const plan = await createPlan(fx, PLAN);
    const owner = await panelSubscription(plan);
    await enterModel(owner);
    const moved = at(5);
    await withFlags(STAGES_1_2_6, () =>
      panelEvent(owner, { expireAt: moved.toISOString(), hwidDeviceLimit: 3, trafficLimitBytes: 100 * GIB }),
    );
    assert.equal((await row(owner)).expiresAt?.getTime(), moved.getTime());
    assert.equal((await putBacks(owner)).length, 0, 'its limits are in step');
  });

  it('O1 a subscription outside the model keeps today’s mirror: limits, snapshot and expiry taken, nothing pushed', async () => {
    const plan = await createPlan(fx, PLAN);
    const owner = await panelSubscription(plan);
    // No term, and a push of ours still queued: neither changes anything here.
    await pushOfOurs(owner, SyncJobStatus.PENDING);
    const moved = at(5);
    await withFlags(STAGES_1_2_6, () =>
      panelEvent(owner, { hwidDeviceLimit: 7, trafficLimitBytes: 300 * GIB, expireAt: moved.toISOString() }),
    );
    const after = await row(owner);
    assert.deepEqual(
      { trafficLimit: after.trafficLimit, deviceLimit: after.deviceLimit, expiresAt: after.expiresAt?.getTime() },
      { trafficLimit: 300, deviceLimit: 7, expiresAt: moved.getTime() },
    );
    const snapshot = after.planSnapshot as Record<string, unknown>;
    assert.deepEqual(
      { trafficLimit: snapshot['trafficLimit'], deviceLimit: snapshot['deviceLimit'] },
      { trafficLimit: 300, deviceLimit: 7 },
      'the snapshot moves with the columns, as before',
    );
    assert.equal((await putBacks(owner)).length, 0);
    assert.equal(
      await prisma.subscriptionTerm.count({ where: { subscriptionId: owner.subscriptionId } }),
      0,
      'still outside the model',
    );
  });
});
