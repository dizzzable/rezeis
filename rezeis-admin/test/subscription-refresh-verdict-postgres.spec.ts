import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import type { RemnawavePanelUser } from '../src/modules/remnawave/services/remnawave-api.service';
import { REMNAWAVE_LIMIT_DRIFT_CAUSE } from '../src/modules/remnawave/services/term-model-readback';
import { AdminUserSubscriptionsController } from '../src/modules/users/controllers/admin-user-subscriptions.controller';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';
import { realTermHooks } from './helpers/term-model-hooks';
import {
  at,
  buyAddOns,
  createPlan,
  newUser,
  subscriptionInModel,
  termModelFixtures,
  type Limits,
  type TermModelFixtures,
} from './helpers/term-model-fixtures';

/**
 * ↻ SAYS WHAT IT DID. For a subscription in the term model, the answer of
 * `POST /admin/users/subscriptions/:id/sync` carries the verdict the audit row
 * `user.sync.requested` records (`readback`): what became of the limits
 * Remnawave reported, whether its expiry was taken, and — when rezeis' own
 * limits are being sent back — which job sends them and what they are. A
 * subscription outside the model gets no `readback` key: the answer an older
 * card reads is unchanged.
 *
 * Through the real controller and the real rule (`term-model-readback.ts`);
 * only Remnawave and the queue are doubles. The rule itself is pinned in
 * `panel-readback-term-model-postgres` (P1–P4).
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;

const PLAN: Limits = { trafficLimit: 100, deviceLimit: 3 };
const GIB = 1024 ** 3;
const REQUEST = { headers: {}, ip: '10.0.0.9', socket: { remoteAddress: null } } as never;

let prisma: PrismaService;
let fx: TermModelFixtures;
let adminId = '';
/** Sync jobs ↻ handed to the queue. */
const enqueued: string[] = [];

interface Row {
  readonly userId: string;
  readonly subscriptionId: string;
  readonly panelId: number;
}

/** The profile as Remnawave answers for it; limits and expiry overridable. */
function profileOf(row: Row, overrides: Partial<RemnawavePanelUser> = {}): RemnawavePanelUser {
  return {
    uuid: String(row.panelId),
    username: `rverd-${row.panelId}`,
    status: 'ACTIVE',
    subscriptionUrl: `https://panel.example/sub/${row.panelId}`,
    telegramId: null,
    panelId: row.panelId,
    email: null,
    expireAt: at(25).toISOString(),
    createdAt: at(-10).toISOString(),
    lastTrafficResetAt: null,
    trafficLimitBytes: 300 * GIB,
    hwidDeviceLimit: 7,
    trafficLimitStrategy: 'NO_RESET',
    tag: null,
    description: `reiwa_id: ${row.userId}`,
    activeInternalSquads: [],
    externalSquadUuid: null,
    ...overrides,
  } as RemnawavePanelUser;
}

function refresher(answer: RemnawavePanelUser) {
  return new AdminUserSubscriptionsController(
    prisma,
    { getPanelUserOutcome: async () => ({ kind: 'ok', user: answer }) } as never,
    { enqueue: async (syncJobId: string) => void enqueued.push(syncJobId) } as never,
    { info: () => undefined, warn: () => undefined, error: () => undefined, emit: () => undefined } as never,
    {} as never,
    {} as never,
    realTermHooks(prisma),
  );
}

async function refresh(row: Row, answer: RemnawavePanelUser): Promise<Record<string, unknown>> {
  const result = await refresher(answer).syncSubscription(row.subscriptionId, { id: adminId } as never, REQUEST);
  assert.equal(result.synced, true);
  return result as Record<string, unknown>;
}

async function lastRefreshAudit(row: Row): Promise<Record<string, unknown>> {
  const entry = await prisma.adminAuditLog.findFirstOrThrow({
    where: {
      adminUserId: adminId,
      action: 'user.sync.requested',
      metadata: { path: ['subscriptionId'], equals: row.subscriptionId },
    },
    orderBy: { createdAt: 'desc' },
  });
  return entry.metadata as Record<string, unknown>;
}

async function putBacks(row: Row) {
  return prisma.profileSyncJob.findMany({
    where: { subscriptionId: row.subscriptionId, cause: REMNAWAVE_LIMIT_DRIFT_CAUSE },
  });
}

async function inModel(): Promise<Row> {
  const planId = await createPlan(fx, PLAN);
  return subscriptionInModel(fx, { planId, plan: PLAN });
}

run('↻ answers with the verdict it acted on (PostgreSQL)', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    prisma = new PrismaService();
    await prisma.$connect();
    fx = termModelFixtures(prisma, `rverd-${process.pid}-${Date.now()}`);
    const admin = await prisma.adminUser.create({
      data: { login: `${fx.prefix}-admin`, loginNormalized: `${fx.prefix}-admin`, passwordHash: 'not-a-hash' },
      select: { id: true },
    });
    adminId = admin.id;
  });

  beforeEach(() => {
    enqueued.length = 0;
  });

  after(async () => {
    if (prisma === undefined) return;
    await prisma.adminAuditLog.deleteMany({ where: { adminUserId: adminId } }).catch(() => undefined);
    await prisma.profileSyncJob
      .deleteMany({ where: { subscription: { userId: { in: fx.users } } } })
      .catch(() => undefined);
    await removeDurableFixtures(prisma, fx.users).catch(() => undefined);
    await prisma.plan.deleteMany({ where: { id: { in: fx.plans } } }).catch(() => undefined);
    await prisma.adminUser.deleteMany({ where: { id: adminId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('V1 other limits in Remnawave: the answer names the put-back, its job and the limits it sends — add-ons included', async () => {
    const row = await inModel();
    // +2 devices and +10 GB bought until the end of the term: the columns,
    // and so the push, carry 5 devices and 110 GB.
    await buyAddOns(fx, row, { devices: 2, trafficGb: 10 });
    const answer = await refresh(row, profileOf(row, { trafficLimitBytes: 100 * GIB, hwidDeviceLimit: 3 }));
    const jobs = await putBacks(row);
    assert.equal(jobs.length, 1);
    assert.deepEqual(answer['readback'], {
      panelLimits: 'PUT_BACK',
      expiryTaken: true,
      limitsPutBack: { syncJobId: jobs[0]!.id, trafficLimit: 110, deviceLimit: 5 },
    });
    assert.deepEqual(enqueued, [jobs[0]!.id], 'the job it names is the one queued');
    const audit = await lastRefreshAudit(row);
    assert.deepEqual(
      { panelLimits: audit['panelLimits'], expiryTaken: audit['expiryTaken'], job: audit['limitsPutBackSyncJobId'] },
      { panelLimits: 'PUT_BACK', expiryTaken: true, job: jobs[0]!.id },
      'and says what the audit row says',
    );
  });

  it('V2 a push of rezeis’ own still queued: the expiry is not taken, nothing is put back, and the answer says so', async () => {
    const row = await inModel();
    await prisma.profileSyncJob.create({
      data: {
        subscriptionId: row.subscriptionId,
        action: SyncAction.UPDATE,
        status: SyncJobStatus.PENDING,
        payload: { source: 'ADMIN_MUTATION' },
      },
    });
    const answer = await refresh(row, profileOf(row, { expireAt: at(5).toISOString() }));
    assert.deepEqual(answer['readback'], { panelLimits: 'OUTRANKED', expiryTaken: false, limitsPutBack: null });
    assert.equal('expiresAt' in (answer['refreshed'] as object), false);
    assert.equal((await putBacks(row)).length, 0);
  });

  it('V2b the same queued push, but Remnawave states the date the row already has: nothing was withheld, and the answer does not say so', async () => {
    const row = await inModel();
    await prisma.profileSyncJob.create({
      data: {
        subscriptionId: row.subscriptionId,
        action: SyncAction.UPDATE,
        status: SyncJobStatus.PENDING,
        payload: { source: 'ADMIN_MUTATION' },
      },
    });
    const stored = await prisma.subscription.findUniqueOrThrow({
      where: { id: row.subscriptionId },
      select: { expiresAt: true },
    });
    const answer = await refresh(row, profileOf(row, { expireAt: stored.expiresAt!.toISOString() }));
    assert.deepEqual(answer['readback'], { panelLimits: 'OUTRANKED', expiryTaken: true, limitsPutBack: null });
    // The audit row keeps the verdict itself: the read was outranked.
    assert.equal((await lastRefreshAudit(row))['expiryTaken'], false);
  });

  it('V2d a queued push, and Remnawave states no expiry at all: there was nothing to take, and nothing is said', async () => {
    const row = await inModel();
    await prisma.profileSyncJob.create({
      data: {
        subscriptionId: row.subscriptionId,
        action: SyncAction.UPDATE,
        status: SyncJobStatus.PENDING,
        payload: { source: 'ADMIN_MUTATION' },
      },
    });
    const answer = await refresh(row, profileOf(row, { expireAt: '' }));
    assert.deepEqual(answer['readback'], { panelLimits: 'OUTRANKED', expiryTaken: true, limitsPutBack: null });
  });

  it('V2c a lifetime row and a queued push: a date from Remnawave is one it did not take', async () => {
    const row = await inModel();
    await prisma.subscription.update({ where: { id: row.subscriptionId }, data: { expiresAt: null } });
    await prisma.profileSyncJob.create({
      data: {
        subscriptionId: row.subscriptionId,
        action: SyncAction.UPDATE,
        status: SyncJobStatus.PENDING,
        payload: { source: 'ADMIN_MUTATION' },
      },
    });
    const answer = await refresh(row, profileOf(row, { expireAt: at(30).toISOString() }));
    assert.deepEqual(answer['readback'], { panelLimits: 'OUTRANKED', expiryTaken: false, limitsPutBack: null });
  });

  it('V3 Remnawave holds what rezeis pushes: in step, nothing put back', async () => {
    const row = await inModel();
    const answer = await refresh(row, profileOf(row, { trafficLimitBytes: 100 * GIB, hwidDeviceLimit: 3 }));
    assert.deepEqual(answer['readback'], { panelLimits: 'IN_STEP', expiryTaken: true, limitsPutBack: null });
    assert.equal((await putBacks(row)).length, 0);
  });

  it('V4 a profile a second live subscription names: not put back, and the answer says why', async () => {
    const row = await inModel();
    const planId = await createPlan(fx, PLAN);
    const twinUser = await newUser(fx);
    await prisma.subscription.create({
      data: {
        userId: twinUser,
        status: SubscriptionStatus.ACTIVE,
        planSnapshot: { id: planId, name: planId },
        trafficLimit: PLAN.trafficLimit,
        deviceLimit: PLAN.deviceLimit,
        remnawaveId: String(row.panelId),
        remnawavePanelId: row.panelId,
      },
    });
    const answer = await refresh(row, profileOf(row));
    assert.deepEqual(answer['readback'], { panelLimits: 'SHARED_PROFILE', expiryTaken: true, limitsPutBack: null });
    assert.equal((await putBacks(row)).length, 0);
  });

  it('V5 a subscription outside the term model: no `readback` key, the answer is what it always was', async () => {
    const userId = await newUser(fx);
    const panelId = 830_000 + fx.next();
    const created = await prisma.subscription.create({
      data: {
        userId,
        status: SubscriptionStatus.ACTIVE,
        planSnapshot: { name: 'Outside' },
        trafficLimit: PLAN.trafficLimit,
        deviceLimit: PLAN.deviceLimit,
        remnawaveId: String(panelId),
        remnawavePanelId: panelId,
        expiresAt: at(20),
      },
      select: { id: true },
    });
    const row = { userId, subscriptionId: created.id, panelId };
    const answer = await refresh(row, profileOf(row));
    assert.equal('readback' in answer, false);
    assert.deepEqual(Object.keys(answer).sort(), ['panelReports', 'refreshed', 'synced']);
    assert.equal((answer['panelReports'] as { hwidDeviceLimit: number }).hwidDeviceLimit, 7);
  });
});
