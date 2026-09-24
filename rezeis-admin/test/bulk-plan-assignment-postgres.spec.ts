import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Prisma, SubscriptionStatus, SubscriptionTermStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import {
  BULK_PLAN_ASSIGNMENT_TERM,
  BulkPlanAssignmentService,
} from '../src/modules/imports/services/bulk-plan-assignment.service';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';
import { realTermHooks } from './helpers/term-model-hooks';
import {
  activeTerm,
  at,
  createPlan,
  GIB,
  newUser,
  subscriptionInModel,
  termModelFixtures,
  type Limits,
  type TermModelFixtures,
} from './helpers/term-model-fixtures';

/**
 * THE BULK PLAN ASSIGNMENT OF IMPORTED SUBSCRIPTIONS, on PostgreSQL, through
 * the real service — the owner's decision of 24.09.2026: it carries through
 * `resolvePlanChangeLimitCarry` exactly as «Назначить план» does, and rotates
 * the term where one exists.
 *
 *   - A NEVER-ASSIGNED import records the donor's facts, not a plan's
 *     `trafficLimit`/`deviceLimit`: there is nothing to measure "above the
 *     plan" against, so it gets the plan's raw limits — normalising an import
 *     is the point.
 *   - A row assigned before and imported again is NOT re-planned: the
 *     assignment touches only imports never assigned, and never one bought or
 *     renewed in the panel (`BulkAssignmentVerdict`; its PostgreSQL case with
 *     a paid subscription beside the import is in
 *     `durable-disposal-postgres.spec.ts`).
 *   - An import the background cutover already brought into the model is
 *     rotated onto the plan. Without it the next recompute stood on the
 *     import's cutover term and mirrored the DONOR's limits back.
 *
 * Skipped without TEST_DATABASE_URL; list it in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;

let prisma: PrismaService;
let fx: TermModelFixtures;
let bulk: BulkPlanAssignmentService;
const projections = new EffectiveProjectionService();

/** What a donor import leaves: its own facts, and no plan limits at the top level. */
function neverAssignedSnapshot(): Record<string, unknown> {
  return {
    importedFrom: 'altshop',
    sourceSubscriptionId: `${fx.prefix}-donor-${fx.next()}`,
    tag: null,
    trafficLimitStrategy: 'NO_RESET',
    originalPlanSnapshot: { id: 'donor-plan', traffic_limit: 40, device_limit: 9 },
  };
}

/** A row assigned to `planId` before, then imported again: the Remnawave importer merges over it. */
function reimportedSnapshot(planId: string, plan: Limits): Record<string, unknown> {
  return {
    id: planId,
    planId,
    name: planId,
    trafficLimit: plan.trafficLimit,
    deviceLimit: plan.deviceLimit,
    trafficLimitStrategy: 'NO_RESET',
    internalSquads: [],
    externalSquad: null,
    importedFrom: 'remnawave',
  };
}

/** An imported subscription outside the term model. */
async function imported(snapshot: Record<string, unknown>, columns: Limits): Promise<{ userId: string; subscriptionId: string }> {
  const userId = await newUser(fx);
  const subscription = await prisma.subscription.create({
    data: {
      userId,
      status: SubscriptionStatus.ACTIVE,
      planSnapshot: snapshot as Prisma.InputJsonValue,
      trafficLimit: columns.trafficLimit,
      deviceLimit: columns.deviceLimit,
      internalSquads: [],
      externalSquad: null,
      remnawaveId: String(820_000 + fx.next()),
      createdAt: at(-30),
      expiresAt: at(15),
    },
    select: { id: true },
  });
  return { userId, subscriptionId: subscription.id };
}

async function columnsOf(subscriptionId: string): Promise<Limits & { snapshotId: unknown }> {
  const row = await prisma.subscription.findUniqueOrThrow({
    where: { id: subscriptionId },
    select: { trafficLimit: true, deviceLimit: true, planSnapshot: true },
  });
  return {
    trafficLimit: row.trafficLimit,
    deviceLimit: row.deviceLimit,
    snapshotId: (row.planSnapshot as Record<string, unknown>).id,
  };
}

const assign = (planId: string, userId: string, applyImmediately = false) =>
  bulk.assignPlan({ planId, userIds: [userId], createdBy: `${fx.prefix}-admin`, applyImmediately });

run('bulk plan assignment of imported subscriptions — PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    delete process.env.ADDON_ENTITLEMENT_SHADOW;
    prisma = new PrismaService();
    await prisma.$connect();
    fx = termModelFixtures(prisma, `d2bulk-${process.pid}-${Date.now()}`);
    bulk = new BulkPlanAssignmentService(prisma, { enqueue: async () => undefined } as never, realTermHooks(prisma));
  });

  after(async () => {
    if (prisma === undefined) return;
    await removeDurableFixtures(prisma, fx.users).catch(() => undefined);
    await prisma.plan.deleteMany({ where: { id: { in: fx.plans } } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it("a never-assigned import gets the plan's raw limits: there is no old plan to measure against", async () => {
    const b = await createPlan(fx, { trafficLimit: 500, deviceLimit: 5 });
    const owner = await imported(neverAssignedSnapshot(), { trafficLimit: 40, deviceLimit: 9 });

    const result = await assign(b, owner.userId);

    assert.equal(result.updated, 1);
    assert.deepEqual(await columnsOf(owner.subscriptionId), { trafficLimit: 500, deviceLimit: 5, snapshotId: b });
  });

  it('a row assigned before and imported again keeps its plan: only a never-assigned import is re-planned', async () => {
    // It used to be re-planned here (the import marker alone decided), which
    // is also how a paid subscription the Remnawave import had stamped got a
    // new plan. The rule now: really imported AND never assigned — this row's
    // snapshot names plan A (`BulkAssignmentVerdict`).
    const a = await createPlan(fx, { trafficLimit: 100, deviceLimit: 3 });
    const b = await createPlan(fx, { trafficLimit: 500, deviceLimit: 5 });
    // +50 GB and +2 devices above plan A.
    const owner = await imported(reimportedSnapshot(a, { trafficLimit: 100, deviceLimit: 3 }), {
      trafficLimit: 150,
      deviceLimit: 5,
    });

    const result = await assign(b, owner.userId);

    assert.equal(result.updated, 0);
    assert.equal(result.skippedAlreadyAssigned, 1);
    assert.deepEqual(await columnsOf(owner.subscriptionId), { trafficLimit: 150, deviceLimit: 5, snapshotId: a });
  });

  it('an import already in the term model is rotated onto the plan, and the next recompute keeps the plan', async () => {
    const b = await createPlan(fx, { trafficLimit: 500, deviceLimit: 5 });
    const snapshot = neverAssignedSnapshot();
    // The background cutover minted its term from the donor's 40 GB / 9 devices.
    const owner = await subscriptionInModel(fx, {
      planId: 'unused',
      plan: { trafficLimit: 40, deviceLimit: 9 },
      snapshot,
    });
    const cutoverTerm = await activeTerm(prisma, owner.subscriptionId);
    assert.equal(cutoverTerm.baseDeviceLimit, 9, 'self-check: the cutover term carries the donor limits');

    const result = await assign(b, owner.userId, true);

    assert.equal(result.updated, 1);
    assert.equal(result.syncJobsCreated, 1);
    const rotated = await activeTerm(prisma, owner.subscriptionId);
    assert.notEqual(rotated.id, cutoverTerm.id);
    assert.equal(rotated.planId, b);
    assert.equal((rotated.planSnapshot as { snapshotSource?: string }).snapshotSource, BULK_PLAN_ASSIGNMENT_TERM);
    assert.equal(
      (await prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: cutoverTerm.id } })).status,
      SubscriptionTermStatus.ENDED,
    );
    const job = await prisma.profileSyncJob.findFirstOrThrow({ where: { subscriptionId: owner.subscriptionId } });
    assert.equal(job.cause, 'PLAN_CHANGE');

    // Whatever triggers the next recompute, the plan stands — the donor's 9 would be the revert.
    const again = await prisma.$transaction((tx) =>
      projections.recomputeInTransaction(tx, { subscriptionId: owner.subscriptionId, mode: 'ACTIVE' }),
    );
    assert.equal(again.desiredDeviceLimit, 5);
    assert.equal(again.desiredTrafficLimitBytes, 500n * GIB);
    assert.deepEqual(await columnsOf(owner.subscriptionId), { trafficLimit: 500, deviceLimit: 5, snapshotId: b });
  });
});
