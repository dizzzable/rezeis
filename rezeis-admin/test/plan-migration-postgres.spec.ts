import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { ConflictException, NotFoundException } from '@nestjs/common';
import { PaymentGatewayType, Prisma } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { GIB_BYTES } from '../src/modules/add-on-entitlements/domain/cutover-baseline';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { OPERATOR_LIMIT_SOURCE } from '../src/modules/anti-fraud/detectors/sharing-detectors';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { MIGRATION_SUBJECT_SELECT } from '../src/modules/plans/migrations/plan-migration-facts.util';
import { PlanMigrationMoveService } from '../src/modules/plans/migrations/plan-migration-move.service';
import { PlanMigrationQueryService } from '../src/modules/plans/migrations/plan-migration-query.service';
import { PlanMigrationRunnerService } from '../src/modules/plans/migrations/plan-migration-runner.service';
import { PlanCatalogService } from '../src/modules/plans/services/plan-catalog.service';
import { PricingService } from '../src/modules/plans/services/pricing.service';
import { SubscriptionQuoteService } from '../src/modules/subscriptions/services/subscription-quote.service';
import { SubscriptionRenewalService } from '../src/modules/subscriptions/services/subscription-renewal.service';

/**
 * MOVING SUBSCRIPTIONS OFF A PLAN, against a real PostgreSQL.
 *
 * What only an engine can prove: the row locks and their order (a renewal and a
 * move of one subscription serialize; a deadlock is retried, not recorded as a
 * failure), the recheck under the lock, the JSON-path predicate, the partial
 * unique index behind 409, the term CHECK constraint, the device-limit
 * provenance trigger, and that what the preview promised is what the database
 * holds afterwards.
 *
 * Skipped without TEST_DATABASE_URL, like every live spec; CI's PostgreSQL job
 * must list this file (`.github/workflows/ci.yml`). Every row carries this run's
 * prefix and is removed in `after`; the payment gateways it switches are
 * restored to what they were.
 */
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `pmig-${process.pid}-${Date.now()}`;
const DAY_MS = 24 * 60 * 60 * 1000;

const SQ_A = '0a000000-0000-4000-8000-000000000001';
const SQ_B = '0a000000-0000-4000-8000-000000000002';
const SQ_C = '0a000000-0000-4000-8000-000000000003';
const EXT_P = '0e000000-0000-4000-8000-000000000001';
const EXT_Q = '0e000000-0000-4000-8000-000000000002';

let prisma: PrismaService;
let terms: SubscriptionTermService;
let projections: EffectiveProjectionService;
let move: PlanMigrationMoveService;
let runner: PlanMigrationRunnerService;
let query: PlanMigrationQueryService;
let adminId: string;
let gatewaysBefore: Array<{ type: PaymentGatewayType; isActive: boolean; currency: string }> = [];
let createdGateway = false;

const ticks: string[] = [];
const enqueuedSync: Array<{ readonly id: string; readonly force: boolean }> = [];
const moveWarnings: string[] = [];

const created = { plans: [] as string[], users: [] as string[], admins: [] as string[] };
let counter = 0;
const next = (): number => ++counter;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function lockWaiters(): Promise<number> {
  const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM pg_stat_activity
     WHERE datname = current_database() AND wait_event_type = 'Lock'`;
  return row?.n ?? 0;
}

async function waitForLockWaiters(expected: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if ((await lockWaiters()) >= expected) return;
    await sleep(25);
  }
  throw new Error(`expected ${expected} backend(s) waiting on a lock`);
}

async function createPlan(label: string, data: Partial<Prisma.PlanUncheckedCreateInput> = {}): Promise<string> {
  const id = `${prefix}-plan-${label}`;
  await prisma.plan.create({
    data: {
      id,
      name: `${prefix} ${label}`,
      orderIndex: 100_000 + next(),
      trafficLimit: 100,
      deviceLimit: 5,
      trafficLimitStrategy: 'MONTH',
      internalSquads: [SQ_A, SQ_B],
      externalSquad: EXT_P,
      durations: {
        create: [
          { days: 30, prices: { create: [{ currency: 'RUB', price: '199' }] } },
          { days: 90, prices: { create: [{ currency: 'RUB', price: '499' }] } },
        ],
      },
      ...data,
    },
  });
  created.plans.push(id);
  return id;
}

async function createUser(label: string, data: Partial<Prisma.UserUncheckedCreateInput> = {}): Promise<string> {
  const id = `${prefix}-user-${label}`;
  await prisma.user.create({ data: { id, referralCode: `${id}-ref`, name: label, ...data } });
  created.users.push(id);
  return id;
}

/** The snapshot a purchase of the plan writes, plus the keys a move must keep. */
async function purchaseSnapshot(planId: string, extra: Record<string, unknown> = {}): Promise<Prisma.InputJsonObject> {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    tag: plan.tag,
    type: plan.type,
    icon: plan.icon,
    trafficLimit: plan.trafficLimit,
    deviceLimit: plan.deviceLimit,
    trafficLimitStrategy: plan.trafficLimitStrategy,
    internalSquads: plan.internalSquads,
    externalSquad: plan.externalSquad,
    selectedDurationDays: 90,
    purchaseType: 'NEW',
    amount: '499',
    currency: 'RUB',
    gatewayType: 'YOOKASSA',
    snapshotSource: 'PAYMENT_COMPLETION',
    ...extra,
  } as Prisma.InputJsonObject;
}

/** A subscription whose columns equal what the plan gave it, linked and ACTIVE unless told otherwise. */
async function createSubscription(
  userId: string,
  planId: string,
  overrides: Partial<Prisma.SubscriptionUncheckedCreateInput> = {},
  snapshotExtra: Record<string, unknown> = {},
): Promise<string> {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
  const row = await prisma.subscription.create({
    data: {
      userId,
      status: 'ACTIVE',
      planSnapshot: await purchaseSnapshot(planId, snapshotExtra),
      trafficLimit: plan.trafficLimit,
      deviceLimit: plan.deviceLimit,
      internalSquads: plan.internalSquads,
      externalSquad: plan.externalSquad,
      remnawaveId: `${prefix}-rw-${next()}`,
      startedAt: new Date(Date.now() - 10 * DAY_MS),
      expiresAt: new Date(Date.now() + 20 * DAY_MS),
      ...overrides,
    },
    select: { id: true },
  });
  return row.id;
}

async function drain(runId: string): Promise<void> {
  for (let tick = 0; tick < 40; tick += 1) {
    const current = await prisma.planMigrationRun.findUniqueOrThrow({ where: { id: runId } });
    if (current.status === 'COMPLETED') return;
    await runner.processTick(runId);
  }
  throw new Error(`run ${runId} did not complete`);
}

async function itemOf(runId: string, subscriptionId: string) {
  return prisma.planMigrationItem.findUniqueOrThrow({
    where: { runId_subscriptionId: { runId, subscriptionId } },
  });
}

function snapshotOf(row: { planSnapshot: Prisma.JsonValue }): Record<string, unknown> {
  return row.planSnapshot as Record<string, unknown>;
}

const CONTEXT = () => ({
  currentAdmin: { id: adminId } as never,
  requestMetadata: { requestId: `${prefix}-req`, remoteAddress: '203.0.113.7', userAgent: 'plan-migration-postgres' },
});

run('plan migration on PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '8';
    prisma = new PrismaService();
    await prisma.$connect();

    terms = new SubscriptionTermService();
    projections = new EffectiveProjectionService();
    const syncQueue = {
      enqueue: async (id: string, force = false) => {
        enqueuedSync.push({ id, force });
      },
    };
    move = new PlanMigrationMoveService(prisma, terms, projections, syncQueue as never);
    const logger = (move as unknown as { logger: { warn: (message: string) => void } }).logger;
    const originalWarn = logger.warn.bind(logger);
    logger.warn = (message: string) => {
      moveWarnings.push(message);
      originalWarn(message);
    };
    const queue = {
      add: async (_name: string, data: { runId: string }) => {
        ticks.push(data.runId);
        return {};
      },
    };
    runner = new PlanMigrationRunnerService(prisma, move, syncQueue as never, queue as never);
    query = new PlanMigrationQueryService(prisma);

    const admin = await prisma.adminUser.create({
      data: { login: `${prefix}-admin`, loginNormalized: `${prefix}-admin`, passwordHash: 'not-a-real-hash' },
      select: { id: true },
    });
    adminId = admin.id;

    // One active RUB gateway and nothing else, so "priced" means one thing.
    gatewaysBefore = (await prisma.paymentGateway.findMany({ select: { type: true, isActive: true, currency: true } })).map(
      (row) => ({ type: row.type, isActive: row.isActive, currency: row.currency }),
    );
    await prisma.paymentGateway.updateMany({ data: { isActive: false } });
    const yookassa = gatewaysBefore.find((row) => row.type === PaymentGatewayType.YOOKASSA);
    if (yookassa === undefined) {
      await prisma.paymentGateway.create({ data: { type: PaymentGatewayType.YOOKASSA, currency: 'RUB', isActive: true } });
      createdGateway = true;
    } else {
      await prisma.paymentGateway.update({
        where: { type: PaymentGatewayType.YOOKASSA },
        data: { isActive: true, currency: 'RUB' },
      });
    }
  });

  after(async () => {
    if (prisma === undefined) return;
    const users = created.users;
    const subscriptionIds = (
      await prisma.subscription.findMany({ where: { userId: { in: users } }, select: { id: true } })
    ).map((row) => row.id);
    await prisma.planMigrationRun.deleteMany({ where: { sourcePlanId: { in: created.plans } } });
    await prisma.addOnEntitlementEvent.deleteMany({ where: { entitlement: { subscriptionId: { in: subscriptionIds } } } });
    await prisma.addOnEntitlement.deleteMany({ where: { subscriptionId: { in: subscriptionIds } } });
    await prisma.subscriptionEffectiveProjection.deleteMany({ where: { subscriptionId: { in: subscriptionIds } } });
    await prisma.subscriptionTerm.deleteMany({ where: { subscriptionId: { in: subscriptionIds } } });
    await prisma.transaction.deleteMany({ where: { userId: { in: users } } });
    await prisma.subscription.deleteMany({ where: { userId: { in: users } } });
    await prisma.adminAuditLog.deleteMany({ where: { adminUserId: { in: [adminId, ...created.admins] } } });
    await prisma.plan.deleteMany({ where: { id: { in: created.plans } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: [adminId, ...created.admins] } } });
    if (createdGateway) {
      await prisma.paymentGateway.deleteMany({ where: { type: PaymentGatewayType.YOOKASSA } });
    }
    for (const gateway of gatewaysBefore) {
      await prisma.paymentGateway.update({
        where: { type: gateway.type },
        data: { isActive: gateway.isActive, currency: gateway.currency as never },
      });
    }
    await prisma.$disconnect();
  });

  it('keeps individual limits, gives inherited ones Q’s values, clears the trial flag and keeps the duration — as the preview said', async () => {
    const planP = await createPlan('keep-p', { trafficLimit: 100, deviceLimit: 5 });
    const planQ = await createPlan('keep-q', {
      trafficLimit: 50,
      deviceLimit: 2,
      internalSquads: [SQ_C],
      externalSquad: EXT_Q,
      trafficLimitStrategy: 'WEEK',
      tag: 'Q_TAG',
    });
    const user = await createUser('keep');
    const inherited = await createSubscription(user, planP, { isTrial: true }, { importRecordId: 'imp-9' });
    const individual = await createSubscription(user, planP, { deviceLimit: 7, internalSquads: [SQ_B] });
    const unknown = await createSubscription(user, planP, { planSnapshot: { id: planP } });

    const assignment = { groups: [{ targetPlanId: planQ, subscriptionIds: [inherited, individual, unknown] }] };
    const preview = await query.preview(planP, assignment);
    const { runId, totalItems } = await runner.startRun(planP, assignment, CONTEXT());
    assert.equal(totalItems, 3);
    await drain(runId);

    for (const row of preview.rows) {
      const stored = await prisma.subscription.findUniqueOrThrow({ where: { id: row.subscriptionId } });
      assert.deepEqual(
        {
          trafficLimit: stored.trafficLimit,
          deviceLimit: stored.deviceLimit,
          internalSquads: stored.internalSquads,
          externalSquad: stored.externalSquad,
          isTrial: stored.isTrial,
        },
        row.after,
        `the database must hold what the preview showed for ${row.subscriptionId}`,
      );
      assert.equal((await itemOf(runId, row.subscriptionId)).status, 'MOVED');
    }

    const inheritedRow = await prisma.subscription.findUniqueOrThrow({ where: { id: inherited } });
    assert.equal(inheritedRow.trafficLimit, 50);
    assert.equal(inheritedRow.deviceLimit, 2);
    assert.deepEqual(inheritedRow.internalSquads, [SQ_C]);
    assert.equal(inheritedRow.externalSquad, EXT_Q);
    assert.equal(inheritedRow.isTrial, false, 'a trial moved onto a regular plan is a regular subscription');
    const snapshot = snapshotOf(inheritedRow);
    assert.equal(snapshot['id'], planQ);
    assert.equal(snapshot['selectedDurationDays'], 90, 'the renewal duration must survive the move');
    assert.equal(snapshot['importRecordId'], 'imp-9');
    assert.equal(snapshot['trafficLimitStrategy'], 'WEEK');
    assert.equal(snapshot['tag'], 'Q_TAG');

    const individualRow = await prisma.subscription.findUniqueOrThrow({ where: { id: individual } });
    assert.equal(individualRow.deviceLimit, 7, 'an operator-set device limit is kept');
    assert.deepEqual(individualRow.internalSquads, [SQ_B], 'operator-set squads are kept');
    assert.equal(individualRow.trafficLimit, 50);
    assert.equal(individualRow.externalSquad, EXT_Q);
    // Kept keys keep what P gave in the snapshot, so column <> snapshot and they stay individual.
    assert.equal(snapshotOf(individualRow)['deviceLimit'], 5, 'a kept key keeps its old snapshot value');
    assert.deepEqual(snapshotOf(individualRow)['internalSquads'], [SQ_A, SQ_B]);
    assert.equal(snapshotOf(individualRow)['trafficLimit'], 50, 'a moved key records Q');
    assert.deepEqual(preview.rows.find((row) => row.subscriptionId === individual)?.kept, ['deviceLimit', 'squads']);

    const unknownRow = await prisma.subscription.findUniqueOrThrow({ where: { id: unknown } });
    assert.equal(unknownRow.trafficLimit, 50, 'an UNKNOWN field takes Q’s value');
    assert.equal(unknownRow.deviceLimit, 2);

    // 5 → 2 devices is a reduction the trigger stamps, attributed to the operator.
    const [stamp] = await prisma.$queryRaw<Array<{ by: string | null; before: number | null }>>`
      SELECT "device_limit_reduction_by" AS "by", "device_limit_before_reduction" AS "before"
        FROM "subscriptions" WHERE "id" = ${inherited}`;
    assert.equal(stamp?.by, OPERATOR_LIMIT_SOURCE);
    assert.equal(stamp?.before, 5);

    const audit = await prisma.adminAuditLog.findMany({
      where: { metadata: { path: ['planMigrationRunId'], equals: runId } },
      orderBy: { createdAt: 'asc' },
    });
    const movedRows = audit.filter((row) => row.action === 'user.subscription.plan_migrated');
    assert.equal(movedRows.length, 3, 'one plan_migrated row per subscription');
    const individualLimits = audit.find(
      (row) =>
        row.action === 'user.subscription.limits_changed' &&
        (row.metadata as Record<string, unknown>)['subscriptionId'] === individual,
    );
    assert.ok(individualLimits, 'the limits row exists');
    const limitsMetadata = individualLimits.metadata as Record<string, unknown>;
    assert.equal(limitsMetadata['source'], 'plan_migration');
    assert.deepEqual(Object.keys(limitsMetadata['changes'] as object).sort(), ['externalSquad', 'trafficLimit']);
    assert.equal(individualLimits.adminUserId, adminId);
  });

  it('skips a subscription that left the plan between the request and the move', async () => {
    const planP = await createPlan('left-p');
    const planQ = await createPlan('left-q', { trafficLimit: 10 });
    const planR = await createPlan('left-r', { trafficLimit: 20 });
    const user = await createUser('left');
    const subscription = await createSubscription(user, planP);

    const { runId } = await runner.startRun(
      planP,
      { groups: [{ targetPlanId: planQ, subscriptionIds: [subscription] }] },
      CONTEXT(),
    );
    // Renewed onto R (or reassigned in the editor) before the worker got to it.
    await prisma.subscription.update({
      where: { id: subscription },
      data: { planSnapshot: await purchaseSnapshot(planR), trafficLimit: 20 },
    });
    await drain(runId);

    const item = await itemOf(runId, subscription);
    assert.equal(item.status, 'SKIPPED');
    assert.equal(item.reason, 'NOT_ON_SOURCE_PLAN');
    assert.equal(item.movedAt, null);
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription } });
    assert.equal(snapshotOf(row)['id'], planR, 'the row is left exactly where it went');
    assert.equal(row.trafficLimit, 20);
    assert.deepEqual((await query.getRun(planP, runId)).totals.skippedByReason, { NOT_ON_SOURCE_PLAN: 1 });
  });

  it('moves EXPIRED and DISABLED rows locally, and pushes exactly one UPDATE for a linked ACTIVE row', async () => {
    const planP = await createPlan('push-p');
    const planQ = await createPlan('push-q', { trafficLimit: 30, deviceLimit: 1 });
    const user = await createUser('push');
    const expired = await createSubscription(user, planP, { status: 'EXPIRED', expiresAt: new Date(Date.now() - DAY_MS) });
    const disabled = await createSubscription(user, planP, { status: 'DISABLED' });
    const unlinked = await createSubscription(user, planP, { remnawaveId: null });
    const active = await createSubscription(user, planP);
    const limited = await createSubscription(user, planP, { status: 'LIMITED' });

    const { runId, totalItems } = await runner.startRun(planP, { restTargetPlanId: planQ }, CONTEXT());
    assert.equal(totalItems, 5, '"the rest" covers every subscription on the plan, resolved at request time');
    await drain(runId);

    for (const local of [expired, disabled, unlinked]) {
      const item = await itemOf(runId, local);
      assert.equal(item.status, 'MOVED', local);
      assert.equal(item.syncJobId, null, 'no push now for a row that is not live and linked');
      assert.equal(await prisma.profileSyncJob.count({ where: { subscriptionId: local } }), 0);
      const row = await prisma.subscription.findUniqueOrThrow({ where: { id: local } });
      assert.equal(snapshotOf(row)['id'], planQ);
      assert.equal(row.trafficLimit, 30);
    }
    const expiredRow = await prisma.subscription.findUniqueOrThrow({ where: { id: expired } });
    assert.equal(expiredRow.status, 'EXPIRED', 'the status is never changed by a move');

    for (const live of [active, limited]) {
      const item = await itemOf(runId, live);
      const jobs = await prisma.profileSyncJob.findMany({ where: { subscriptionId: live } });
      assert.equal(jobs.length, 1, 'exactly one job');
      const [job] = jobs;
      assert.equal(job?.action, 'UPDATE');
      assert.equal(job?.status, 'PENDING');
      assert.equal(item.syncJobId, job?.id);
      assert.deepEqual(job?.payload, {
        source: 'PLAN_MIGRATION',
        planMigrationRunId: runId,
        planMigrationItemId: item.id,
        fromPlanId: planP,
        toPlanId: planQ,
        propagateStatus: false,
      });
      assert.equal(job?.aggregateKey, null, 'no projection, no versioned fields');
      assert.ok(enqueuedSync.some((entry) => entry.id === job?.id), 'enqueued after the commit');
    }

    const view = await query.getRun(planP, runId);
    assert.equal(view.status, 'COMPLETED');
    assert.deepEqual(view.totals, { total: 5, pending: 0, moved: 5, skipped: 0, failed: 0, skippedByReason: {} });
    assert.deepEqual(view.sync, { total: 2, pending: 2, completed: 0, failed: 0 });
    assert.equal(view.finished, false, 'not finished while a push is pending');
  });

  it('rotates an ACTIVE term onto Q with the same end, keeps the add-on and pushes a versioned job', async () => {
    const planP = await createPlan('term-p', { trafficLimit: 100, deviceLimit: 3 });
    const planQ = await createPlan('term-q', { trafficLimit: 40, deviceLimit: 1 });
    const user = await createUser('term');
    const expiresAt = new Date(Math.floor((Date.now() + 15 * DAY_MS) / 1000) * 1000);
    const subscription = await createSubscription(user, planP, { expiresAt });

    const oldTerm = await prisma.$transaction((tx) =>
      terms.createScheduledInTransaction(tx, {
        subscriptionId: subscription,
        planId: planP,
        planSnapshot: { id: planP },
        startsAt: new Date(Date.now() - 15 * DAY_MS),
        endsAt: expiresAt,
        baseTrafficLimitBytes: 100n * GIB_BYTES,
        baseDeviceLimit: 3,
        trafficResetStrategy: 'MONTH',
        resetAnchorAt: null,
      }),
    );
    await prisma.$transaction((tx) => terms.activateInTransaction(tx, oldTerm.id));
    const addOnPayment = await prisma.transaction.create({
      data: {
        userId: user,
        subscriptionId: subscription,
        status: 'COMPLETED',
        purchaseType: 'ADDITIONAL',
        gatewayType: 'YOOKASSA',
        currency: 'RUB',
        amount: new Prisma.Decimal('50'),
        planSnapshot: {},
      },
    });
    const entitlement = await prisma.addOnEntitlement.create({
      data: {
        subscriptionId: subscription,
        termId: oldTerm.id,
        sourceTransactionId: addOnPayment.id,
        sourceLineKey: 'devices-2',
        catalogRevision: 1,
        receiptName: '+2 devices',
        type: 'EXTRA_DEVICES',
        valuePerUnit: 2,
        quantity: 1,
        totalValue: 2n,
        lifetime: 'UNTIL_SUBSCRIPTION_END',
        applicabilitySnapshot: {},
        unitAmount: new Prisma.Decimal('50'),
        totalAmount: new Prisma.Decimal('50'),
        currency: 'RUB',
        purchasedAt: new Date(Date.now() - DAY_MS),
        scheduledActivationAt: new Date(Date.now() - DAY_MS),
        activatedAt: new Date(Date.now() - DAY_MS),
        expiresAt,
        state: 'ACTIVE',
      },
    });
    // As the add-on's fulfilment leaves it: projection recorded, columns mirrored.
    const seeded = await prisma.$transaction((tx) =>
      projections.recomputeInTransaction(tx, { subscriptionId: subscription, mode: 'ACTIVE' }),
    );
    assert.equal(seeded.desiredDeviceLimit, 5);
    await prisma.subscription.update({ where: { id: subscription }, data: { deviceLimit: 5 } });

    const assignment = { groups: [{ targetPlanId: planQ, subscriptionIds: [subscription] }] };
    const preview = await query.preview(planP, assignment);
    assert.equal(preview.rows[0]?.after.deviceLimit, 3, 'the preview keeps the add-on share: Q 1 + 2');
    const { runId } = await runner.startRun(planP, assignment, CONTEXT());
    await drain(runId);

    const termRows = await prisma.subscriptionTerm.findMany({
      where: { subscriptionId: subscription },
      orderBy: { generation: 'asc' },
    });
    assert.equal(termRows.length, 2);
    assert.equal(termRows[0]?.status, 'ENDED');
    const newTerm = termRows[1];
    assert.equal(newTerm?.status, 'ACTIVE');
    assert.equal(newTerm?.planId, planQ);
    assert.equal(newTerm?.endsAt?.getTime(), expiresAt.getTime(), 'the Q term ends where the subscription does');
    assert.equal(newTerm?.baseDeviceLimit, 1);
    assert.equal(newTerm?.baseTrafficLimitBytes, 40n * GIB_BYTES);

    const keptAddOn = await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: entitlement.id } });
    assert.equal(keptAddOn.state, 'ACTIVE', 'the paid add-on stays valid');

    const projection = await prisma.subscriptionEffectiveProjection.findUniqueOrThrow({
      where: { subscriptionId: subscription },
    });
    assert.equal(projection.baselineTermId, newTerm?.id);
    assert.equal(projection.desiredDeviceLimit, 3);
    assert.equal(projection.activeDeviceContribution, 2);

    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription } });
    assert.equal(row.deviceLimit, 3, 'column = projection desired');
    assert.equal(row.trafficLimit, 40);
    assert.equal(row.expiresAt?.getTime(), expiresAt.getTime(), 'expiry is never changed');
    assert.equal(snapshotOf(row)['deviceLimit'], 1, 'the snapshot carries Q alone');

    const [job] = await prisma.profileSyncJob.findMany({ where: { subscriptionId: subscription } });
    assert.equal(job?.aggregateKey, subscription);
    assert.equal(job?.desiredRevision, projection.desiredRevision);
    assert.equal(job?.cause, 'PLAN_MIGRATION');
    assert.equal((job?.payload as Record<string, unknown>)['planMigrationRunId'], runId);
  });

  it('rotates the ACTIVE term of an already expired subscription without breaking the term CHECK', async () => {
    const planP = await createPlan('expired-term-p');
    const planQ = await createPlan('expired-term-q', { trafficLimit: 25 });
    const user = await createUser('expired-term');
    const expiresAt = new Date(Math.floor((Date.now() - 2 * DAY_MS) / 1000) * 1000);
    const subscription = await createSubscription(user, planP, { status: 'EXPIRED', expiresAt });
    const oldTerm = await prisma.$transaction((tx) =>
      terms.createScheduledInTransaction(tx, {
        subscriptionId: subscription,
        planId: planP,
        planSnapshot: { id: planP },
        startsAt: new Date(expiresAt.getTime() - 30 * DAY_MS),
        endsAt: expiresAt,
        baseTrafficLimitBytes: 100n * GIB_BYTES,
        baseDeviceLimit: 5,
        trafficResetStrategy: 'MONTH',
        resetAnchorAt: null,
      }),
    );
    await prisma.$transaction((tx) => terms.activateInTransaction(tx, oldTerm.id));

    const { runId } = await runner.startRun(
      planP,
      { groups: [{ targetPlanId: planQ, subscriptionIds: [subscription] }] },
      CONTEXT(),
    );
    await drain(runId);

    assert.equal((await itemOf(runId, subscription)).status, 'MOVED');
    const active = await prisma.subscriptionTerm.findFirstOrThrow({ where: { subscriptionId: subscription, status: 'ACTIVE' } });
    assert.equal(active.planId, planQ);
    assert.equal(active.endsAt?.getTime(), expiresAt.getTime());
    assert.ok(active.startsAt.getTime() < expiresAt.getTime());
    assert.equal(await prisma.profileSyncJob.count({ where: { subscriptionId: subscription } }), 0);
  });

  it('skips a subscription whose paid SCHEDULED term would undo the move, and says so in the list and the preview', async () => {
    const planP = await createPlan('sched-p');
    const planQ = await createPlan('sched-q');
    const planR = await createPlan('sched-r');
    const user = await createUser('sched');
    const onP = await createSubscription(user, planP);
    await prisma.$transaction((tx) =>
      terms.createScheduledInTransaction(tx, {
        subscriptionId: onP,
        planId: planP,
        planSnapshot: { id: planP },
        startsAt: new Date(Date.now() + 20 * DAY_MS),
        endsAt: new Date(Date.now() + 50 * DAY_MS),
        baseTrafficLimitBytes: 100n * GIB_BYTES,
        baseDeviceLimit: 5,
        trafficResetStrategy: 'MONTH',
        resetAnchorAt: null,
      }),
    );
    // The second shape: an ACTIVE term plus a scheduled one on ANOTHER plan.
    const activeWithOther = await createSubscription(user, planP);
    const current = await prisma.$transaction((tx) =>
      terms.createScheduledInTransaction(tx, {
        subscriptionId: activeWithOther,
        planId: planP,
        planSnapshot: { id: planP },
        startsAt: new Date(Date.now() - 10 * DAY_MS),
        endsAt: new Date(Date.now() + 20 * DAY_MS),
        baseTrafficLimitBytes: 100n * GIB_BYTES,
        baseDeviceLimit: 5,
        trafficResetStrategy: 'MONTH',
        resetAnchorAt: null,
      }),
    );
    await prisma.$transaction((tx) => terms.activateInTransaction(tx, current.id));
    await prisma.$transaction((tx) =>
      terms.createScheduledInTransaction(tx, {
        subscriptionId: activeWithOther,
        planId: planR,
        planSnapshot: { id: planR },
        startsAt: new Date(Date.now() + 20 * DAY_MS),
        endsAt: new Date(Date.now() + 50 * DAY_MS),
        baseTrafficLimitBytes: 100n * GIB_BYTES,
        baseDeviceLimit: 5,
        trafficResetStrategy: 'MONTH',
        resetAnchorAt: null,
      }),
    );

    const listed = await query.listSubscriptions(planP, {});
    for (const id of [onP, activeWithOther]) {
      assert.equal(listed.items.find((item) => item.subscriptionId === id)?.flags.scheduledTermOnPlan, true, id);
    }
    const preview = await query.preview(planP, { restTargetPlanId: planQ });
    assert.deepEqual(
      preview.rows.map((row) => row.willSkip),
      ['SCHEDULED_TERM', 'SCHEDULED_TERM'],
    );

    const { runId } = await runner.startRun(planP, { restTargetPlanId: planQ }, CONTEXT());
    await drain(runId);
    for (const id of [onP, activeWithOther]) {
      const item = await itemOf(runId, id);
      assert.equal(item.status, 'SKIPPED');
      assert.equal(item.reason, 'SCHEDULED_TERM');
      const row = await prisma.subscription.findUniqueOrThrow({ where: { id } });
      assert.equal(snapshotOf(row)['id'], planP);
    }
    assert.deepEqual((await query.getRun(planP, runId)).totals.skippedByReason, { SCHEDULED_TERM: 2 });
  });

  it('serializes with a renewal fulfilment holding the row first: the renewal lands, then the move', async () => {
    const { planP, planQ, user, subscription, payment, originalExpiry } = await renewalFixture('ren-first');
    const { runId } = await runner.startRun(
      planP,
      { groups: [{ targetPlanId: planQ, subscriptionIds: [subscription] }] },
      CONTEXT(),
    );

    const gate = deferred();
    const holding = deferred();
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "subscriptions" WHERE "id" = ${subscription} FOR UPDATE`;
        holding.resolve();
        await gate.promise;
      },
      { timeout: 30_000 },
    );
    await holding.promise;
    const renewal = psm().applyCompletedTransaction(payment);
    await waitForLockWaiters(1);
    const moving = runner.processTick(runId);
    await waitForLockWaiters(2);
    gate.resolve();
    await holder;
    await Promise.all([renewal, moving]);
    await drain(runId);

    const item = await itemOf(runId, subscription);
    assert.equal(item.status, 'MOVED', 'the move waited for the renewal and then moved the renewed row');
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription } });
    assert.equal(snapshotOf(row)['id'], planQ);
    assert.equal(row.trafficLimit, 30);
    assert.equal(row.expiresAt?.getTime(), originalExpiry.getTime() + 30 * DAY_MS, 'the renewal extended once');
    assert.equal(row.status, 'ACTIVE');
    void user;
  });

  it('serializes with a renewal fulfilment for P arriving second: both finish, and the row stays on Q, extended once', async () => {
    const { planP, planQ, subscription, payment, originalExpiry } = await renewalFixture('ren-second');
    const { runId } = await runner.startRun(
      planP,
      { groups: [{ targetPlanId: planQ, subscriptionIds: [subscription] }] },
      CONTEXT(),
    );

    const gate = deferred();
    const holding = deferred();
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "subscriptions" WHERE "id" = ${subscription} FOR UPDATE`;
        holding.resolve();
        await gate.promise;
      },
      { timeout: 30_000 },
    );
    await holding.promise;
    const moving = runner.processTick(runId);
    await waitForLockWaiters(1);
    const renewal = psm().applyCompletedTransaction(payment);
    await waitForLockWaiters(2);
    gate.resolve();
    await holder;
    const [renewalResult] = await Promise.allSettled([renewal, moving]);
    assert.equal(renewalResult.status, 'fulfilled', 'the renewal must not be refused by the move');
    await drain(runId);

    const item = await itemOf(runId, subscription);
    assert.equal(item.status, 'MOVED');
    assert.ok(item.movedAt !== null);
    const fulfilled = await prisma.transaction.findUniqueOrThrow({ where: { id: payment.id } });
    assert.ok(fulfilled.fulfilledAt !== null);
    assert.ok(item.movedAt >= payment.createdAt, 'the guard in fulfilment reads moved_at >= created_at');

    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription } });
    assert.equal(row.expiresAt?.getTime(), originalExpiry.getTime() + 30 * DAY_MS, 'the renewal extended once');
    // The payment for P was created before the move and fulfilled after it, so
    // fulfilment's late-renewal guard (`payment-renewal-plan-migration-guard.util.ts`)
    // extends the subscription on the plan it is on NOW. Only the end state of
    // THIS interleaving is asserted here; the guard's own cases are its spec's.
    const snapshot = snapshotOf(row);
    assert.equal(snapshot['id'], planQ, 'a renewal for P that lands after the move must not put the row back on P');
    assert.equal(row.trafficLimit, 30, 'Q’s limits stay');
    assert.equal(row.deviceLimit, 2);
    assert.equal(snapshot['trafficLimit'], 30);
    assert.equal(row.status, 'ACTIVE');
  });

  it('answers the plan’s open run as current, and nothing once it is finished or the plan is gone', async () => {
    const planP = await createPlan('current-p');
    const planQ = await createPlan('current-q', { trafficLimit: 8 });
    const user = await createUser('current');
    await createSubscription(user, planP);
    assert.deepEqual(await query.getCurrentRun(planP), { runId: null }, 'no run yet');

    const { runId } = await runner.startRun(planP, { restTargetPlanId: planQ }, CONTEXT());
    assert.equal((await prisma.planMigrationRun.findUniqueOrThrow({ where: { id: runId } })).status, 'QUEUED');
    assert.deepEqual(await query.getCurrentRun(planP), { runId }, 'a QUEUED run is current');
    await prisma.planMigrationRun.update({ where: { id: runId }, data: { status: 'RUNNING', startedAt: new Date() } });
    assert.deepEqual(await query.getCurrentRun(planP), { runId }, 'a RUNNING run is current');

    await drain(runId);
    assert.equal((await prisma.planMigrationRun.findUniqueOrThrow({ where: { id: runId } })).status, 'COMPLETED');
    assert.deepEqual(await query.getCurrentRun(planP), { runId: null }, 'a COMPLETED run is not current');
    assert.deepEqual(await query.getCurrentRun(planQ), { runId: null }, 'a target has no run of its own');

    // A missing or deleted plan answers null, never 404 — even with a run open.
    assert.deepEqual(await query.getCurrentRun(`${prefix}-no-such-plan`), { runId: null });
    const planR = await createPlan('current-r');
    await createSubscription(user, planR);
    const open = await runner.startRun(planR, { restTargetPlanId: planQ }, CONTEXT());
    assert.deepEqual(await query.getCurrentRun(planR), { runId: open.runId });
    await prisma.plan.update({ where: { id: planR }, data: { deletedAt: new Date() } });
    assert.deepEqual(await query.getCurrentRun(planR), { runId: null }, 'a deleted plan answers null');
    await drain(open.runId);
  });

  it('runs a deadlocked move again instead of recording it as failed', async () => {
    const planP = await createPlan('dead-p');
    const planQ = await createPlan('dead-q', { trafficLimit: 12 });
    const user = await createUser('dead');
    const subscription = await createSubscription(user, planP);
    const { runId } = await runner.startRun(
      planP,
      { groups: [{ targetPlanId: planQ, subscriptionIds: [subscription] }] },
      CONTEXT(),
    );

    moveWarnings.length = 0;
    const gate = deferred();
    const holding = deferred();
    // Holds the subscription, then — once the move holds the plans FOR SHARE and
    // waits for the subscription — asks for the source plan FOR UPDATE: a cycle.
    const other = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "subscriptions" WHERE "id" = ${subscription} FOR UPDATE`;
        holding.resolve();
        await gate.promise;
        await tx.$queryRaw`SELECT "id" FROM "plans" WHERE "id" = ${planP} FOR UPDATE`;
      },
      { timeout: 30_000 },
    );
    await holding.promise;
    const moving = runner.processTick(runId);
    await waitForLockWaiters(1);
    gate.resolve();
    await Promise.allSettled([other, moving]);
    await drain(runId);

    const item = await itemOf(runId, subscription);
    assert.equal(item.status, 'MOVED', `the deadlock must be retried, got ${item.status} ${item.reason} ${item.detail}`);
    assert.ok(
      moveWarnings.some((message) => message.includes('lost a lock conflict')),
      'the move was the deadlock victim and ran again',
    );
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription } });
    assert.equal(snapshotOf(row)['id'], planQ);
    assert.equal(row.trafficLimit, 12);
  });

  it('moves twins on one panel profile together, and fails both when they are sent to different plans', async () => {
    const planP = await createPlan('twin-p');
    const planQ = await createPlan('twin-q', { trafficLimit: 11 });
    const planQ2 = await createPlan('twin-q2', { trafficLimit: 22 });
    const user = await createUser('twin');
    const profile = `${prefix}-shared-profile`;
    const selected = await createSubscription(user, planP, { remnawaveId: profile });
    const pulledIn = await createSubscription(user, planP, { remnawaveId: profile });
    const conflictProfile = `${prefix}-conflict-profile`;
    const toQ = await createSubscription(user, planP, { remnawaveId: conflictProfile });
    const toQ2 = await createSubscription(user, planP, { remnawaveId: conflictProfile });

    const listed = await query.listSubscriptions(planP, {});
    assert.equal(listed.items.find((item) => item.subscriptionId === selected)?.flags.sharedPanelProfile, true);

    const assignment = {
      groups: [
        { targetPlanId: planQ, subscriptionIds: [selected, toQ] },
        { targetPlanId: planQ2, subscriptionIds: [toQ2] },
      ],
    };
    const preview = await query.preview(planP, assignment);
    assert.equal(preview.rows.find((row) => row.subscriptionId === pulledIn)?.targetPlanId, planQ);
    assert.equal(preview.rows.find((row) => row.subscriptionId === toQ)?.willSkip, 'SHARED_PROFILE_TARGET_CONFLICT');

    const { runId, totalItems } = await runner.startRun(planP, assignment, CONTEXT());
    assert.equal(totalItems, 4, 'the unselected twin is added to the run');
    await drain(runId);

    const added = await itemOf(runId, pulledIn);
    assert.equal(added.origin, 'SHARED_PROFILE');
    assert.equal(added.toPlanId, planQ);
    assert.equal(added.status, 'MOVED');
    assert.equal((await itemOf(runId, selected)).status, 'MOVED');
    for (const id of [toQ, toQ2]) {
      const item = await itemOf(runId, id);
      assert.equal(item.status, 'FAILED');
      assert.equal(item.reason, 'SHARED_PROFILE_TARGET_CONFLICT');
      const row = await prisma.subscription.findUniqueOrThrow({ where: { id } });
      assert.equal(snapshotOf(row)['id'], planP);
    }

    // Retrying cannot move one of them: the conflict is re-checked under the lock.
    await runner.retry(planP, runId, 'failed', CONTEXT());
    await drain(runId);
    assert.equal((await itemOf(runId, toQ)).reason, 'SHARED_PROFILE_TARGET_CONFLICT');
    assert.equal((await itemOf(runId, toQ2)).status, 'FAILED');

    const view = await query.getRun(planP, runId);
    assert.deepEqual(
      view.problems.map((problem) => [problem.kind, problem.reason]).sort(),
      [
        ['MOVE_FAILED', 'SHARED_PROFILE_TARGET_CONFLICT'],
        ['MOVE_FAILED', 'SHARED_PROFILE_TARGET_CONFLICT'],
      ],
    );
  });

  it('lists the plan’s subscriptions in expiry order with search, cursor and flags', async () => {
    const planP = await createPlan('list-p');
    const planOther = await createPlan('list-other');
    const alice = await createUser('list-alice', { username: 'alice_vpn', email: `${prefix}-alice@example.com`, telegramId: BigInt(700_000 + next()) });
    const bob = await createUser('list-bob');
    const later = await createSubscription(alice, planP, { expiresAt: new Date(Date.now() + 10 * DAY_MS) });
    const sooner = await createSubscription(bob, planP, { expiresAt: new Date(Date.now() + 5 * DAY_MS) });
    const never = await createSubscription(bob, planP, { expiresAt: null });
    const imported = await createSubscription(bob, planOther, {}, { id: 'legacy-id', planId: planP });
    await createSubscription(bob, planP, { status: 'DELETED' });
    await createSubscription(bob, planOther);
    await prisma.transaction.create({
      data: {
        userId: bob,
        subscriptionId: sooner,
        status: 'PENDING',
        purchaseType: 'RENEW',
        gatewayType: 'YOOKASSA',
        currency: 'RUB',
        amount: new Prisma.Decimal('199'),
        planSnapshot: { id: planP, selectedDurationDays: 30 },
      },
    });
    // A renewal priced for ANOTHER plan — the replacement an archived plan
    // renews onto, or a plan the subscriber chose — is in flight all the same,
    // and the fulfilment guard keeps it on the new plan all the same.
    await prisma.transaction.create({
      data: {
        userId: alice,
        subscriptionId: later,
        status: 'PENDING',
        purchaseType: 'RENEW',
        gatewayType: 'YOOKASSA',
        currency: 'RUB',
        amount: new Prisma.Decimal('299'),
        planSnapshot: { id: planOther, selectedDurationDays: 30 },
      },
    });

    const first = await query.listSubscriptions(planP, { limit: 2 });
    assert.equal(first.total, 4, 'id OR planId, never DELETED');
    assert.equal(first.matched, 4);
    const second = await query.listSubscriptions(planP, { limit: 2, cursor: first.nextCursor ?? undefined });
    const importedExpiry = (await prisma.subscription.findUniqueOrThrow({ where: { id: imported } })).expiresAt;
    assert.ok(importedExpiry !== null);
    assert.deepEqual(
      [...first.items, ...second.items].map((item) => item.subscriptionId),
      [imported, later, sooner, never].filter((id) => id !== undefined),
      'expiresAt DESC NULLS LAST, then id',
    );
    assert.equal(second.nextCursor, null);
    const soonerItem = second.items.find((item) => item.subscriptionId === sooner);
    assert.equal(soonerItem?.flags.pendingRenewalForPlan, true);
    assert.equal(soonerItem?.user?.name, 'list-bob');
    const allItems = [...first.items, ...second.items];
    assert.equal(
      allItems.find((item) => item.subscriptionId === later)?.flags.pendingRenewalForPlan,
      true,
      'a renewal priced for another plan is in flight too',
    );
    assert.equal(allItems.find((item) => item.subscriptionId === never)?.flags.pendingRenewalForPlan, false);

    const byUsername = await query.listSubscriptions(planP, { search: '@ALICE_vpn' });
    assert.deepEqual(byUsername.items.map((item) => item.subscriptionId), [later]);
    assert.equal(byUsername.total, 4);
    assert.equal(byUsername.matched, 1);
    const aliceRow = await prisma.user.findUniqueOrThrow({ where: { id: alice } });
    const byTelegram = await query.listSubscriptions(planP, { search: aliceRow.telegramId?.toString() });
    assert.deepEqual(byTelegram.items.map((item) => item.subscriptionId), [later]);
    const byEmail = await query.listSubscriptions(planP, { search: 'ALICE@example' });
    assert.deepEqual(byEmail.items.map((item) => item.subscriptionId), [later]);
    const bySubscription = await query.listSubscriptions(planP, { search: never.slice(-10).toUpperCase() });
    assert.ok(bySubscription.items.some((item) => item.subscriptionId === never));

    await prisma.plan.update({ where: { id: planOther }, data: { deletedAt: new Date() } });
    await assert.rejects(() => query.listSubscriptions(planOther, {}), NotFoundException);
  });

  it('agrees with the real renewal about which targets cannot renew a moved subscription', async () => {
    const planP = await createPlan('renew-p');
    const offSale = await createPlan('renew-offsale', { isActive: false });
    const targets = {
      priced: await createPlan('renew-priced'),
      noDurations: await createPlan('renew-nodur', { durations: { create: [] } }),
      unpayable: await createPlan('renew-usd', {
        durations: { create: [{ days: 30, prices: { create: [{ currency: 'USD', price: '3' }] } }] },
      }),
      replacedByNothing: await createPlan('renew-orphan', {
        isArchived: true,
        archivedRenewMode: 'REPLACE_ON_RENEW',
        replacementPlanIds: [offSale],
      }),
    };
    const catalog = new PlanCatalogService(prisma, new PricingService(), {
      loadConfig: async () => ({ enabled: false, percent: 0, defaultCurrency: 'RUB' }),
    } as never);
    const renewal = new SubscriptionRenewalService(prisma, new SubscriptionQuoteService(prisma, catalog, new PricingService()), {} as never);

    for (const [label, targetPlanId] of Object.entries(targets)) {
      const user = await createUser(`renew-${label}`);
      const subscription = await createSubscription(user, planP);
      const assignment = { groups: [{ targetPlanId, subscriptionIds: [subscription] }] };
      const preview = await query.preview(planP, assignment);
      const warned = preview.rows[0]?.warnings.includes('TARGET_NOT_RENEWABLE') ?? false;
      assert.equal(preview.summary?.[0]?.warnings.TARGET_NOT_RENEWABLE, warned ? 1 : 0);

      const { runId } = await runner.startRun(planP, assignment, CONTEXT());
      await drain(runId);
      const options = await renewal.getRenewalOptions({ identity: { userId: user }, subscriptionIds: [subscription] });
      const [option] = options.items;
      const renewable = option !== undefined && option.renewable && !option.requiresPlanSelection;
      assert.equal(warned, !renewable, `${label}: preview TARGET_NOT_RENEWABLE=${warned}, renewal renewable=${renewable}`);
      assert.equal(label === 'priced', renewable, `${label} renewability`);
    }
  });

  it('refuses a second open run with 409, reopens a finished one on retry, and re-drives failed pushes', async () => {
    const planP = await createPlan('retry-p');
    const planQ = await createPlan('retry-q', { trafficLimit: 9 });
    const user = await createUser('retry');
    const first = await createSubscription(user, planP);
    const second = await createSubscription(user, planP);

    const opened = await runner.startRun(planP, { groups: [{ targetPlanId: planQ, subscriptionIds: [first] }] }, CONTEXT());
    await assert.rejects(
      () => runner.startRun(planP, { groups: [{ targetPlanId: planQ, subscriptionIds: [second] }] }, CONTEXT()),
      (error: unknown) =>
        error instanceof ConflictException &&
        (error.getResponse() as { code?: string }).code === 'MIGRATION_ALREADY_RUNNING',
    );
    // The database's half: a second open run for the plan cannot be inserted.
    await assert.rejects(() =>
      prisma.planMigrationRun.create({ data: { sourcePlanId: planP, status: 'RUNNING' } }),
    );

    // The target disappears before the worker runs: FAILED, and the row stays.
    await prisma.plan.update({ where: { id: planQ }, data: { deletedAt: new Date() } });
    await drain(opened.runId);
    let item = await itemOf(opened.runId, first);
    assert.equal(item.status, 'FAILED');
    assert.equal(item.reason, 'TARGET_DELETED');

    // Another run of the plan is open → reopening the finished one is 409.
    await prisma.plan.update({ where: { id: planQ }, data: { deletedAt: null } });
    const blocking = await runner.startRun(planP, { groups: [{ targetPlanId: planQ, subscriptionIds: [second] }] }, CONTEXT());
    await assert.rejects(
      () => runner.retry(planP, opened.runId, 'failed', CONTEXT()),
      (error: unknown) => error instanceof ConflictException,
    );
    await drain(blocking.runId);

    ticks.length = 0;
    assert.deepEqual(await runner.retry(planP, opened.runId, 'failed', CONTEXT()), { runId: opened.runId });
    assert.equal((await prisma.planMigrationRun.findUniqueOrThrow({ where: { id: opened.runId } })).status, 'QUEUED');
    assert.deepEqual(ticks, [opened.runId], 'the reopened run is enqueued');
    await drain(opened.runId);
    item = await itemOf(opened.runId, first);
    assert.equal(item.status, 'MOVED');

    // A push that failed with a secret in its error.
    assert.ok(item.syncJobId !== null);
    await prisma.profileSyncJob.update({
      where: { id: item.syncJobId },
      data: {
        status: 'FAILED',
        attempts: 5,
        lastError: 'Remnawave refused https://panel.example.com/api/users/77?x=1 token=abc123secret A039 Update user error',
      },
    });
    const failedView = await query.getRun(planP, opened.runId);
    assert.deepEqual(failedView.sync, { total: 1, pending: 0, completed: 0, failed: 1 });
    assert.equal(failedView.finished, true);
    const syncProblem = failedView.problems.find((problem) => problem.kind === 'SYNC_FAILED');
    assert.equal(syncProblem?.reason, 'SYNC_FAILED');
    assert.equal(syncProblem?.subscriptionId, first);
    assert.ok(syncProblem?.detail?.includes('A039'), syncProblem?.detail ?? '');
    assert.equal(syncProblem?.detail?.includes('panel.example.com'), false);
    assert.equal(syncProblem?.detail?.includes('abc123secret'), false);

    enqueuedSync.length = 0;
    await runner.retry(planP, opened.runId, 'sync', CONTEXT());
    const redriven = await prisma.profileSyncJob.findUniqueOrThrow({ where: { id: item.syncJobId } });
    assert.equal(redriven.status, 'PENDING');
    assert.equal(redriven.attempts, 0);
    assert.deepEqual(enqueuedSync, [{ id: item.syncJobId, force: true }]);
    assert.equal((await query.getRun(planP, opened.runId)).finished, false);
  });

  it('answers the request-level refusals with their codes', async () => {
    const planP = await createPlan('refuse-p');
    const trial = await createPlan('refuse-trial', { availability: 'TRIAL' });
    const gone = await createPlan('refuse-gone', { deletedAt: new Date() });
    const cases: Array<[unknown, string]> = [
      [{ groups: [] }, 'EMPTY_ASSIGNMENT'],
      [{ groups: [{ targetPlanId: planP, subscriptionIds: ['x'] }] }, 'TARGET_IS_SOURCE'],
      [{ restTargetPlanId: gone }, 'TARGET_NOT_FOUND'],
      [{ restTargetPlanId: `${prefix}-missing` }, 'TARGET_NOT_FOUND'],
      [{ restTargetPlanId: trial }, 'TARGET_IS_TRIAL'],
      [{ groups: [{ targetPlanId: trial, subscriptionIds: ['a', 'a'] }] }, 'DUPLICATE_SUBSCRIPTION'],
      [{ groups: [{ targetPlanId: trial, subscriptionIds: Array.from({ length: 5001 }, (_, i) => `id-${i}`) }] }, 'TOO_MANY_IDS'],
    ];
    for (const [body, code] of cases) {
      for (const call of [() => query.preview(planP, body as never), () => runner.startRun(planP, body as never, CONTEXT())]) {
        await assert.rejects(call, (error: unknown) => {
          const response = (error as { getResponse?: () => unknown }).getResponse?.() as { code?: string } | undefined;
          return response?.code === code;
        }, code);
      }
    }
    const unknownIdPreview = await query.preview(planP, {
      groups: [{ targetPlanId: (await createPlan('refuse-q')), subscriptionIds: [`${prefix}-no-such-subscription`] }],
    });
    assert.equal(unknownIdPreview.rows[0]?.willSkip, 'NOT_ON_SOURCE_PLAN', 'an id not on the plan is a row, not a 400');
    assert.equal(await prisma.planMigrationRun.count({ where: { sourcePlanId: planP } }), 0, 'nothing was written');
  });

  it('counts superseded jobs as completed and retriable failures as pending, and retries only real failures', async () => {
    const planP = await createPlan('sync-p');
    const planQ = await createPlan('sync-q', { trafficLimit: 7 });
    const user = await createUser('sync');
    const supersededPending = await createSubscription(user, planP);
    const supersededFailed = await createSubscription(user, planP);
    const retriable = await createSubscription(user, planP);
    const exhausted = await createSubscription(user, planP);
    const { runId } = await runner.startRun(planP, { restTargetPlanId: planQ }, CONTEXT());
    await drain(runId);
    const jobOf = async (subscriptionId: string): Promise<string> => {
      const item = await itemOf(runId, subscriptionId);
      assert.ok(item.syncJobId !== null, subscriptionId);
      return item.syncJobId;
    };
    const jobs = {
      supersededPending: await jobOf(supersededPending),
      supersededFailed: await jobOf(supersededFailed),
      retriable: await jobOf(retriable),
      exhausted: await jobOf(exhausted),
    };
    // As `SubscriptionDeletionService` leaves them: superseded, status untouched.
    await prisma.$executeRaw`UPDATE "profile_sync_jobs" SET "superseded_at" = now() WHERE "id" = ${jobs.supersededPending}`;
    await prisma.$executeRaw`UPDATE "profile_sync_jobs" SET "status" = 'FAILED', "attempts" = 5, "superseded_at" = now() WHERE "id" = ${jobs.supersededFailed}`;
    // BullMQ retries this one in 5 s: attempts left, touched just now.
    await prisma.$executeRaw`UPDATE "profile_sync_jobs" SET "status" = 'FAILED', "attempts" = 1, "last_error" = 'panel busy', "updated_at" = now() WHERE "id" = ${jobs.retriable}`;
    await prisma.$executeRaw`UPDATE "profile_sync_jobs" SET "status" = 'FAILED', "attempts" = 5, "last_error" = 'A039 Update user error', "updated_at" = now() WHERE "id" = ${jobs.exhausted}`;

    const live = await query.getRun(planP, runId);
    assert.equal(live.status, 'COMPLETED');
    assert.deepEqual(live.sync, { total: 4, pending: 1, completed: 2, failed: 1 });
    assert.equal(live.finished, false, 'a failure BullMQ is about to retry is still pending');
    assert.deepEqual(
      live.problems.filter((problem) => problem.kind === 'SYNC_FAILED').map((problem) => problem.subscriptionId),
      [exhausted],
    );

    // The retriable job's BullMQ entry is lost: once its window lapses it is a failure.
    await prisma.$executeRaw`UPDATE "profile_sync_jobs" SET "updated_at" = now() - interval '10 minutes' WHERE "id" = ${jobs.retriable}`;
    const settled = await query.getRun(planP, runId);
    assert.deepEqual(settled.sync, { total: 4, pending: 0, completed: 2, failed: 2 });
    assert.equal(settled.finished, true, 'superseded jobs never keep a run open');
    assert.deepEqual(
      settled.problems.filter((problem) => problem.kind === 'SYNC_FAILED').map((problem) => problem.subscriptionId).sort(),
      [exhausted, retriable].sort(),
    );

    enqueuedSync.length = 0;
    await runner.retry(planP, runId, 'sync', CONTEXT());
    assert.deepEqual(
      enqueuedSync.map((entry) => entry.id).sort(),
      [jobs.exhausted, jobs.retriable].sort(),
      'retry re-drives exactly the jobs the counts call failed',
    );
    const untouched = await prisma.profileSyncJob.findMany({
      where: { id: { in: [jobs.supersededPending, jobs.supersededFailed] } },
      orderBy: { id: 'asc' },
      select: { id: true, status: true, supersededAt: true },
    });
    assert.ok(untouched.every((job) => job.supersededAt !== null));
    assert.deepEqual(
      untouched.map((job) => [job.id, job.status]).sort(),
      [
        [jobs.supersededFailed, 'FAILED'],
        [jobs.supersededPending, 'PENDING'],
      ].sort(),
    );
    const redriven = await query.getRun(planP, runId);
    assert.deepEqual(redriven.sync, { total: 4, pending: 2, completed: 2, failed: 0 });
  });

  it('moves twins on one panel profile only together: a twin held back by a scheduled term holds back the other', async () => {
    const planP = await createPlan('twin-blocked-p');
    const planQ = await createPlan('twin-blocked-q', { trafficLimit: 13 });
    const user = await createUser('twin-blocked');
    const profile = `${prefix}-blocked-profile`;
    const movable = await createSubscription(user, planP, { remnawaveId: profile });
    const heldBack = await createSubscription(user, planP, { remnawaveId: profile });
    await prisma.$transaction((tx) =>
      terms.createScheduledInTransaction(tx, {
        subscriptionId: heldBack,
        planId: planP,
        planSnapshot: { id: planP },
        startsAt: new Date(Date.now() + 20 * DAY_MS),
        endsAt: new Date(Date.now() + 50 * DAY_MS),
        baseTrafficLimitBytes: 100n * GIB_BYTES,
        baseDeviceLimit: 5,
        trafficResetStrategy: 'MONTH',
        resetAnchorAt: null,
      }),
    );

    const assignment = { groups: [{ targetPlanId: planQ, subscriptionIds: [movable] }] };
    const preview = await query.preview(planP, assignment);
    assert.equal(preview.rows.find((row) => row.subscriptionId === heldBack)?.willSkip, 'SCHEDULED_TERM');
    assert.equal(
      preview.rows.find((row) => row.subscriptionId === movable)?.willSkip,
      'SHARED_PROFILE_TWIN_BLOCKED',
      'the preview says what the run will do',
    );

    const { runId, totalItems } = await runner.startRun(planP, assignment, CONTEXT());
    assert.equal(totalItems, 2, 'the unselected twin is part of the run');
    await drain(runId);

    const blocker = await itemOf(runId, heldBack);
    assert.equal(blocker.status, 'SKIPPED');
    assert.equal(blocker.reason, 'SCHEDULED_TERM');
    const blocked = await itemOf(runId, movable);
    assert.equal(blocked.status, 'SKIPPED', 'neither twin moves');
    assert.equal(blocked.reason, 'SHARED_PROFILE_TWIN_BLOCKED');
    assert.ok(blocked.detail?.includes(heldBack) && blocked.detail.includes('SCHEDULED_TERM'), blocked.detail ?? '');
    for (const id of [movable, heldBack]) {
      const row = await prisma.subscription.findUniqueOrThrow({ where: { id } });
      assert.equal(snapshotOf(row)['id'], planP, `${id} stays on P with its twin`);
      assert.equal(row.trafficLimit, 100);
      assert.equal(await prisma.profileSyncJob.count({ where: { subscriptionId: id } }), 0, 'nothing reaches the shared profile');
    }
    assert.deepEqual((await query.getRun(planP, runId)).totals.skippedByReason, {
      SCHEDULED_TERM: 1,
      SHARED_PROFILE_TWIN_BLOCKED: 1,
    });
  });

  it('holds a twin back as FAILED behind a twin that failed, and a retry moves the pair together', async () => {
    const planP = await createPlan('twin-failed-p');
    const planQ = await createPlan('twin-failed-q', { trafficLimit: 21 });
    const user = await createUser('twin-failed');
    const profile = `${prefix}-failed-profile`;
    const first = await createSubscription(user, planP, { remnawaveId: profile });
    const second = await createSubscription(user, planP, { remnawaveId: profile });
    const { runId } = await runner.startRun(planP, { restTargetPlanId: planQ }, CONTEXT());
    // An earlier attempt of one twin failed (as `recordFailure` leaves it) while the other waited.
    await prisma.planMigrationItem.update({
      where: { runId_subscriptionId: { runId, subscriptionId: second } },
      data: { status: 'FAILED', reason: 'INTERNAL_ERROR', detail: 'Database error P2010.' },
    });
    await drain(runId);

    const held = await itemOf(runId, first);
    assert.equal(held.status, 'FAILED', 'held back behind a retryable failure, so retryable itself');
    assert.equal(held.reason, 'SHARED_PROFILE_TWIN_BLOCKED');
    assert.ok(held.detail?.includes(second) && held.detail.includes('INTERNAL_ERROR'), held.detail ?? '');
    assert.equal(snapshotOf(await prisma.subscription.findUniqueOrThrow({ where: { id: first } }))['id'], planP);

    await runner.retry(planP, runId, 'failed', CONTEXT());
    await drain(runId);
    for (const id of [first, second]) {
      const item = await itemOf(runId, id);
      assert.equal(item.status, 'MOVED', id);
      const row = await prisma.subscription.findUniqueOrThrow({ where: { id } });
      assert.equal(snapshotOf(row)['id'], planQ);
      assert.equal(row.trafficLimit, 21);
    }
    const [a, b] = await Promise.all([itemOf(runId, first), itemOf(runId, second)]);
    assert.ok(a.movedAt !== null && b.movedAt !== null);
  });

  it('computes the preview summary on the first page only, and a later page reads only its own rows', async () => {
    const planP = await createPlan('page-p');
    const planQ = await createPlan('page-q', { trafficLimit: 6 });
    const ann = await createUser('page-ann', { username: 'ann_page' });
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) ids.push(await createSubscription(ann, planP));
    ids.sort();

    const subjectReads: number[] = [];
    const counting = new Proxy(prisma, {
      get(target, property) {
        const value = Reflect.get(target, property) as unknown;
        if (property === 'subscription') {
          const delegate = value as Record<string, unknown>;
          return new Proxy(delegate, {
            get(inner, key) {
              const member = Reflect.get(inner, key) as unknown;
              if (key === 'findMany' && typeof member === 'function') {
                return (args: { select?: unknown; where?: { id?: { in?: unknown[] } } }) => {
                  if (args?.select === MIGRATION_SUBJECT_SELECT) subjectReads.push(args.where?.id?.in?.length ?? -1);
                  return (member as (a: unknown) => unknown).call(inner, args);
                };
              }
              return typeof member === 'function' ? (member as (...a: unknown[]) => unknown).bind(inner) : member;
            },
          });
        }
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const pagedQuery = new PlanMigrationQueryService(counting as never);
    const request = { restTargetPlanId: planQ, limit: 2 };

    const first = await pagedQuery.preview(planP, request);
    assert.ok(first.summary !== null, 'the first page carries the summary');
    assert.equal(first.summary[0]?.count, 5);
    assert.deepEqual(first.rows.map((row) => row.subscriptionId), ids.slice(0, 2));
    assert.equal(first.rows[0]?.user?.username, 'ann_page', 'rows carry the user');
    assert.deepEqual(subjectReads, [5], 'the first page reads every row, for the summary');

    subjectReads.length = 0;
    const second = await pagedQuery.preview(planP, { ...request, cursor: first.nextCursor });
    assert.equal(second.summary, null, 'a later page carries no summary');
    assert.deepEqual(second.rows.map((row) => row.subscriptionId), ids.slice(2, 4));
    assert.deepEqual(subjectReads, [2], 'a later page reads only its own rows');

    const third = await pagedQuery.preview(planP, { ...request, cursor: second.nextCursor });
    assert.deepEqual(third.rows.map((row) => row.subscriptionId), ids.slice(4));
    assert.equal(third.nextCursor, null);
  });

  it('audits the moves a retry causes under the retrying admin, and records each retry', async () => {
    const planP = await createPlan('actor-p');
    const planQ = await createPlan('actor-q', { trafficLimit: 4 });
    const user = await createUser('actor');
    const subscription = await createSubscription(user, planP);
    const { runId } = await runner.startRun(
      planP,
      { groups: [{ targetPlanId: planQ, subscriptionIds: [subscription] }] },
      CONTEXT(),
    );
    await prisma.plan.update({ where: { id: planQ }, data: { deletedAt: new Date() } });
    await drain(runId);
    assert.equal((await itemOf(runId, subscription)).reason, 'TARGET_DELETED');
    await prisma.plan.update({ where: { id: planQ }, data: { deletedAt: null } });

    const operatorB = await prisma.adminUser.create({
      data: { login: `${prefix}-admin-b`, loginNormalized: `${prefix}-admin-b`, passwordHash: 'not-a-real-hash' },
      select: { id: true },
    });
    created.admins.push(operatorB.id);
    const asB = {
      currentAdmin: { id: operatorB.id } as never,
      requestMetadata: { requestId: `${prefix}-retry-b`, remoteAddress: '198.51.100.23', userAgent: 'operator-b' },
    };
    await runner.retry(planP, runId, 'failed', asB);
    await drain(runId);
    const item = await itemOf(runId, subscription);
    assert.equal(item.status, 'MOVED');
    assert.equal(item.actorAdminId, operatorB.id);

    const moved = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: 'user.subscription.plan_migrated', metadata: { path: ['planMigrationItemId'], equals: item.id } },
    });
    assert.equal(moved.adminUserId, operatorB.id, 'the move a retry caused names the retrying admin, not the run creator');
    assert.equal(moved.ipAddress, '198.51.100.23');
    assert.equal(moved.userAgent, 'operator-b');
    assert.equal((moved.metadata as Record<string, unknown>)['requestId'], `${prefix}-retry-b`);
    const limits = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: 'user.subscription.limits_changed', metadata: { path: ['subscriptionId'], equals: subscription } },
    });
    assert.equal(limits.adminUserId, operatorB.id);

    await runner.retry(planP, runId, 'sync', asB);
    const retries = await prisma.adminAuditLog.findMany({
      where: { action: 'plans.migration.retried', metadata: { path: ['planMigrationRunId'], equals: runId } },
      orderBy: { createdAt: 'asc' },
    });
    assert.deepEqual(
      retries.map((row) => {
        const metadata = row.metadata as Record<string, unknown>;
        return [row.adminUserId, metadata['scope'], metadata['itemsReset'] ?? metadata['syncJobsReset'], row.ipAddress];
      }),
      [
        [operatorB.id, 'failed', 1, '198.51.100.23'],
        [operatorB.id, 'sync', 0, '198.51.100.23'],
      ],
    );
    const started = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: 'plans.migration.started', metadata: { path: ['planMigrationRunId'], equals: runId } },
    });
    assert.equal(started.adminUserId, adminId, 'the run itself stays the creator’s');
  });

  /** A subscription on P with a paid RENEW for P waiting to be fulfilled. */
  async function renewalFixture(label: string) {
    const planP = await createPlan(`${label}-p`, { trafficLimit: 100, deviceLimit: 5 });
    const planQ = await createPlan(`${label}-q`, { trafficLimit: 30, deviceLimit: 2 });
    const user = await createUser(label);
    const originalExpiry = new Date(Math.floor((Date.now() + 5 * DAY_MS) / 1000) * 1000);
    const subscription = await createSubscription(user, planP, { expiresAt: originalExpiry });
    const payment = await prisma.transaction.create({
      data: {
        userId: user,
        subscriptionId: subscription,
        status: 'COMPLETED',
        purchaseType: 'RENEW',
        gatewayType: 'YOOKASSA',
        currency: 'RUB',
        amount: new Prisma.Decimal('199'),
        planSnapshot: { id: planP, selectedDurationDays: 30, purchaseType: 'RENEW' },
      },
    });
    return { planP, planQ, user, subscription, payment, originalExpiry };
  }

  function psm(): PaymentSubscriptionMutationService {
    return new PaymentSubscriptionMutationService(
      prisma,
      { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
      new AddOnEntitlementService(),
      new EffectiveProjectionService(),
      new SubscriptionTermService(),
      {} as never,
    );
  }
});
