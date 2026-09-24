import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Prisma, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { StrippedPlanSnapshotRepairService } from '../src/modules/imports/services/stripped-plan-snapshot-repair.service';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';
import { createPlan, newUser, termModelFixtures, type TermModelFixtures } from './helpers/term-model-fixtures';

/**
 * THE PLAN'S NAME COMES BACK to subscriptions an earlier backup re-import
 * stripped to `planId` — once, automatically, and presentation only (the
 * owner's decision of 24.09.2026).
 *
 * The re-import used to rebuild the snapshot from donor facts and carry
 * `planId` alone: a row the plan cloner or «Назначить план импортированным» had
 * linked came out with no `id` and no `name`, and «Назначить план
 * импортированным» skips it as assigned. The repair gives back `id`, `name`,
 * `type` and `icon` from `planId`'s plan, and nothing that reaches Remnawave
 * (tag, reset strategy) or that the renewal compares (the limits, the squads).
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;

let prisma: PrismaService;
let fx: TermModelFixtures;
let repair: StrippedPlanSnapshotRepairService;

/** A plan with a tag, icon and strategy of its own — unlike the donor's below. */
async function planWithLooks(): Promise<{ id: string; name: string }> {
  const id = await createPlan(fx, { trafficLimit: 100, deviceLimit: 3 });
  const plan = await prisma.plan.update({
    where: { id },
    data: { tag: 'PLAN_TAG', icon: 'star', trafficLimitStrategy: 'MONTH', type: 'TRAFFIC' },
    select: { id: true, name: true },
  });
  return plan;
}

/** What an old re-import left: `planId`, the donor's facts, and no `id` or `name`. */
function stripped(planId: string): Record<string, unknown> {
  return {
    importedFrom: 'remnashop',
    importRecordId: 'an-earlier-import',
    planId,
    sourceSubscriptionId: 41,
    tag: 'DONOR_TAG',
    trafficLimitStrategy: 'DAY',
    originalPlanSnapshot: { id: 9, name: 'Donor Pro' },
    trafficLimit: 50,
    deviceLimit: 2,
    internalSquads: ['donor-squad'],
    selectedDurationDays: 90,
  };
}

async function rowWith(snapshot: Record<string, unknown>): Promise<string> {
  const userId = await newUser(fx);
  const row = await prisma.subscription.create({
    data: {
      userId,
      status: SubscriptionStatus.ACTIVE,
      planSnapshot: snapshot as Prisma.InputJsonValue,
      trafficLimit: 50,
      deviceLimit: 2,
      internalSquads: ['donor-squad'],
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    },
    select: { id: true },
  });
  return row.id;
}

async function read(id: string) {
  const row = await prisma.subscription.findUniqueOrThrow({
    where: { id },
    select: { planSnapshot: true, trafficLimit: true, deviceLimit: true, internalSquads: true, updatedAt: true },
  });
  return { ...row, snapshot: row.planSnapshot as Record<string, unknown> };
}

run('restoring the plan on snapshots an earlier re-import stripped (PostgreSQL)', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    prisma = new PrismaService();
    await prisma.$connect();
    fx = termModelFixtures(prisma, `sprep-${process.pid}-${Date.now()}`);
    repair = new StrippedPlanSnapshotRepairService(prisma);
  });

  after(async () => {
    if (prisma === undefined) return;
    await removeDurableFixtures(prisma, fx.users).catch(() => undefined);
    await prisma.plan.deleteMany({ where: { id: { in: fx.plans } } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('R1 gives back id, name, type and icon from the plan — and nothing that reaches Remnawave or the renewal', async () => {
    const plan = await planWithLooks();
    const id = await rowWith(stripped(plan.id));
    await repair.restoreStrippedPlanSnapshots();
    const after = await read(id);
    assert.deepEqual(after.snapshot, {
      ...stripped(plan.id),
      id: plan.id,
      name: plan.name,
      type: 'TRAFFIC',
      icon: 'star',
    });
    assert.deepEqual(
      { t: after.trafficLimit, d: after.deviceLimit, s: after.internalSquads },
      { t: 50, d: 2, s: ['donor-squad'] },
      'the columns are not touched',
    );
    assert.ok(after.updatedAt.getTime() > Date.parse('2026-01-01T00:00:00Z'), 'the row says it changed');
  });

  it('R2 a row whose plan is gone — deleted, or never there — is left as it is', async () => {
    const plan = await planWithLooks();
    await prisma.plan.update({ where: { id: plan.id }, data: { deletedAt: new Date() } });
    const onDeleted = await rowWith(stripped(plan.id));
    const onMissing = await rowWith(stripped(`${fx.prefix}-no-such-plan`));
    await repair.restoreStrippedPlanSnapshots();
    assert.deepEqual((await read(onDeleted)).snapshot, stripped(plan.id));
    assert.deepEqual((await read(onMissing)).snapshot, stripped(`${fx.prefix}-no-such-plan`));
  });

  it('R3 a row that names its plan by `id` is left as it is, whatever `planId` says', async () => {
    const plan = await planWithLooks();
    const other = await planWithLooks();
    const snapshot = { id: other.id, name: 'Operator’s choice', planId: plan.id, tag: 'KEEP' };
    const id = await rowWith(snapshot);
    await repair.restoreStrippedPlanSnapshots();
    assert.deepEqual((await read(id)).snapshot, snapshot);
  });

  it('R4 safe to run twice: the second run finds nothing, and changes nothing', async () => {
    const plan = await planWithLooks();
    const id = await rowWith(stripped(plan.id));
    assert.ok((await repair.restoreStrippedPlanSnapshots()) >= 1);
    const once = await read(id);
    assert.equal(await repair.restoreStrippedPlanSnapshots(), 0);
    const twice = await read(id);
    assert.deepEqual(twice.snapshot, once.snapshot);
    assert.equal(twice.updatedAt.getTime(), once.updatedAt.getTime(), 'not even touched');
  });

  it('R5 two processes running it at once restore each row once between them', async () => {
    const plan = await planWithLooks();
    const ids = [await rowWith(stripped(plan.id)), await rowWith(stripped(plan.id)), await rowWith(stripped(plan.id))];
    const eligible = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS "count" FROM "subscriptions" AS s JOIN "plans" AS p ON p."id" = s."plan_snapshot"->>'planId'
      WHERE jsonb_typeof(s."plan_snapshot") = 'object' AND COALESCE(s."plan_snapshot"->>'id', '') = '' AND p."deleted_at" IS NULL
    `);
    const second = new StrippedPlanSnapshotRepairService(prisma);
    const [a, b] = await Promise.all([repair.restoreStrippedPlanSnapshots(), second.restoreStrippedPlanSnapshots()]);
    assert.equal(a + b, Number(eligible[0]!.count), 'each eligible row counted once');
    for (const id of ids) assert.equal((await read(id)).snapshot['id'], plan.id);
  });
});
