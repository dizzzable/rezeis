import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { BackupPlanClonerService } from '../src/modules/imports/services/backup-plan-cloner.service';
import { BulkPlanAssignmentService } from '../src/modules/imports/services/bulk-plan-assignment.service';
import { RemnashopImporterService } from '../src/modules/imports/services/remnashop-importer.service';
import { ThreeXuiImporterService } from '../src/modules/imports/services/threexui-importer.service';
import { AdminUserSubscriptionsController } from '../src/modules/users/controllers/admin-user-subscriptions.controller';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';
import { realTermHooks } from './helpers/term-model-hooks';
import { createPlan, termModelFixtures, type TermModelFixtures } from './helpers/term-model-fixtures';

/**
 * «НАЗНАЧИТЬ ПЛАН» AND «НАЗНАЧИТЬ ПЛАН ИМПОРТИРОВАННЫМ» KEEP THE IMPORT'S KEYS.
 *
 * On an installation the customers were moved to from ANOTHER panel, a backup
 * importer finds its row only by `planSnapshot.sourceSubscriptionId`. Both
 * plan writers used to replace the snapshot wholesale with the plan's, so the
 * next import of the same backup found nothing and created a second
 * subscription for every customer a plan had been assigned to — and a second
 * Remnawave profile once «Синхронизировать с панелью после импорта» ran. (R1's
 * probe `probe-w1-foreign-duplicate`, inverted.) The 3x-ui importer finds its
 * row by `importedFrom`, and duplicated the same way.
 *
 * Through the real controller, bulk assignment, cloner and importers, on a
 * real database; Remnawave is a double that holds none of the backup's
 * profiles — a different installation.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;

const TELEGRAM_BASE = 7_700_000_000 + (Date.now() % 1_000_000) * 50;
const DONOR_BASE = 700_000 + (Date.now() % 100_000);
const REQUEST = { headers: {}, ip: '10.0.0.9', socket: { remoteAddress: null } } as never;
/** The donor catalog's one plan; every donor subscription is on it. */
const DONOR_PLAN_ID = 9;

let prisma: PrismaService;
let fx: TermModelFixtures;
let adminId = '';
let donorPlanName = '';
let editor: AdminUserSubscriptionsController;
let bulk: BulkPlanAssignmentService;
const importRecords: string[] = [];
let donorSeq = 0;

interface Donor {
  readonly telegramId: number;
  readonly donorId: number;
  readonly user: Record<string, unknown>;
  readonly subscription: Record<string, unknown>;
}

function donor(): Donor {
  donorSeq += 1;
  const telegramId = TELEGRAM_BASE + donorSeq;
  const donorId = DONOR_BASE + donorSeq;
  const uuid = `${String(donorId).padStart(8, '0')}-2222-4000-8000-${String(donorSeq).padStart(12, '0')}`;
  return {
    telegramId,
    donorId,
    user: {
      id: donorId,
      telegram_id: telegramId,
      username: null,
      referral_code: null,
      name: null,
      role: 1,
      language: 'ru',
      personal_discount: 0,
      purchase_discount: 0,
      points: 0,
      is_blocked: false,
      is_bot_blocked: false,
      is_rules_accepted: true,
      is_trial_available: false,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    subscription: {
      id: donorId,
      user_remna_id: uuid,
      user_telegram_id: telegramId,
      status: 'ACTIVE',
      is_trial: false,
      traffic_limit: 50,
      device_limit: 2,
      traffic_limit_strategy: 'DAY',
      tag: 'DONOR_TAG',
      internal_squads: [],
      external_squad: null,
      expire_at: '2027-01-01T00:00:00Z',
      url: 'https://old-panel.example/sub',
      plan_snapshot: { id: DONOR_PLAN_ID, name: 'Donor Pro' },
      created_at: '2026-01-01T00:00:00Z',
    },
  };
}

/** A reachable panel that has none of the backup's profiles: a different installation. */
const FOREIGN_PANEL = {
  strictGetAllPanelUsers: async () => ({ kind: 'ok' as const, value: { users: [], total: 0, complete: true } }),
  getPanelUser: async () => null,
  strictGetPanelUserExpiry: async () => ({ kind: 'notFound' as const }),
  updatePanelUser: async () => ({}),
};

async function newImportRecord(sourceType: string): Promise<string> {
  const record = await prisma.importRecord.create({
    data: { filename: `${fx.prefix}-${sourceType}.json`, sourceType },
    select: { id: true },
  });
  importRecords.push(record.id);
  return record.id;
}

/** Imports `donors` from a Remnashop backup whose catalog holds the donor plan; returns the import record. */
async function remnashopImport(donors: readonly Donor[]): Promise<string> {
  const importRecordId = await newImportRecord('remnashop');
  const importer = new RemnashopImporterService(prisma, FOREIGN_PANEL as never);
  const summary = await importer.run({
    mode: 'import',
    createdBy: null,
    importRecordId,
    users: donors.map((d) => d.user),
    subscriptions: donors.map((d) => d.subscription),
    plans: [
      {
        id: DONOR_PLAN_ID,
        public_code: 'donor-pro',
        name: donorPlanName,
        description: null,
        tag: null,
        type: 'BOTH',
        availability: 'ALL',
        traffic_limit_strategy: 'MONTH',
        traffic_limit: 70,
        device_limit: 4,
        allowed_user_ids: [],
        internal_squads: [],
        external_squad: null,
        order_index: 0,
        is_active: true,
        is_trial: false,
      },
    ],
    planDurations: [{ id: 1, plan_id: DONOR_PLAN_ID, days: 30, order_index: 0 }],
    planPrices: [{ id: 1, plan_duration_id: 1, currency: 'RUB', price: '199' }],
  } as never);
  assert.deepEqual((summary as { errors: readonly string[] }).errors, []);
  return importRecordId;
}

async function userOf(d: Donor): Promise<string> {
  const user = await prisma.user.findFirstOrThrow({ where: { telegramId: BigInt(d.telegramId) }, select: { id: true } });
  return user.id;
}

async function subscriptionsOf(d: Donor) {
  return prisma.subscription.findMany({
    where: { userId: await userOf(d) },
    select: { id: true, remnawaveId: true, planSnapshot: true, status: true },
  });
}

async function soleSubscription(d: Donor) {
  const rows = await subscriptionsOf(d);
  assert.equal(rows.length, 1, `one subscription for donor ${d.donorId}, not ${rows.length}`);
  return { ...rows[0]!, snapshot: rows[0]!.planSnapshot as Record<string, unknown> };
}

/** The first import made a foreign-panel row: unlinked, found again only by the donor's id. */
async function assertForeignPanelRow(d: Donor): Promise<string> {
  const row = await soleSubscription(d);
  assert.equal(row.remnawaveId, null, 'fixture: a different installation — the row is left unlinked');
  assert.equal(row.snapshot['sourceSubscriptionId'], d.donorId);
  return row.id;
}

async function assignPlan(subscriptionId: string, planId: string): Promise<void> {
  await editor.updateSubscription(subscriptionId, { planId }, { id: adminId } as never, REQUEST);
}

run('the plan writers keep the import’s keys (PostgreSQL)', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    prisma = new PrismaService();
    await prisma.$connect();
    fx = termModelFixtures(prisma, `pwik-${process.pid}-${Date.now()}`);
    donorPlanName = `${fx.prefix} Donor Pro`;
    const admin = await prisma.adminUser.create({
      data: { login: `${fx.prefix}-admin`, loginNormalized: `${fx.prefix}-admin`, passwordHash: 'not-a-hash' },
      select: { id: true },
    });
    adminId = admin.id;
    const events = { info: () => undefined, warn: () => undefined, error: () => undefined, emit: () => undefined };
    editor = new AdminUserSubscriptionsController(
      prisma,
      {} as never,
      { enqueue: async () => undefined } as never,
      events as never,
      {} as never,
      {} as never,
      realTermHooks(prisma),
    );
    bulk = new BulkPlanAssignmentService(prisma, { enqueue: async () => undefined } as never, realTermHooks(prisma));
  });

  after(async () => {
    if (prisma === undefined) return;
    const users = await prisma.user.findMany({
      where: { telegramId: { gte: BigInt(TELEGRAM_BASE), lt: BigInt(TELEGRAM_BASE + 1_000) } },
      select: { id: true },
    });
    const ids = [...new Set([...users.map((u) => u.id), ...fx.users])];
    await prisma.adminAuditLog.deleteMany({ where: { adminUserId: adminId } }).catch(() => undefined);
    await prisma.profileSyncJob.deleteMany({ where: { subscription: { userId: { in: ids } } } }).catch(() => undefined);
    await prisma.trialClaim.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
    await removeDurableFixtures(prisma, ids).catch(() => undefined);
    await prisma.importRecord.deleteMany({ where: { id: { in: importRecords } } }).catch(() => undefined);
    await prisma.plan.deleteMany({ where: { OR: [{ id: { in: fx.plans } }, { name: { startsWith: fx.prefix } }] } }).catch(() => undefined);
    await prisma.adminUser.deleteMany({ where: { id: adminId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('K1 «Назначить план»: the next import of the same backup finds the row, and makes no second subscription', async () => {
    const donors = Array.from({ length: 6 }, donor);
    await remnashopImport(donors);
    const assignedId = await assertForeignPanelRow(donors[0]!);
    const plan = await createPlan(fx, { trafficLimit: 100, deviceLimit: 3 });
    await assignPlan(assignedId, plan);

    const second = await remnashopImport(donors);
    const assigned = await soleSubscription(donors[0]!);
    assert.equal(assigned.id, assignedId, 'the same row was found again');
    assert.deepEqual(
      { id: assigned.snapshot['id'], name: assigned.snapshot['name'] },
      { id: plan, name: plan },
      'and it is still on the plan the operator assigned',
    );
    assert.deepEqual(
      {
        importedFrom: assigned.snapshot['importedFrom'],
        sourceSubscriptionId: assigned.snapshot['sourceSubscriptionId'],
        importRecordId: assigned.snapshot['importRecordId'],
      },
      { importedFrom: 'remnashop', sourceSubscriptionId: donors[0]!.donorId, importRecordId: second },
    );
    for (const other of donors.slice(1)) await soleSubscription(other);
  });

  it('K2 «Назначить план импортированным»: every assigned customer is found again by the next import', async () => {
    const donors = Array.from({ length: 6 }, donor);
    const first = await remnashopImport(donors);
    for (const d of donors) await assertForeignPanelRow(d);
    const plan = await createPlan(fx, { trafficLimit: 100, deviceLimit: 3 });
    const result = await bulk.assignPlan({ planId: plan, importRecordId: first, createdBy: adminId });
    assert.equal(result.updated, donors.length, 'fixture: every imported row was assigned');

    await remnashopImport(donors);
    for (const d of donors) {
      const row = await soleSubscription(d);
      assert.deepEqual(
        { id: row.snapshot['id'], planId: row.snapshot['planId'], source: row.snapshot['sourceSubscriptionId'] },
        { id: plan, planId: plan, source: d.donorId },
      );
    }
  });

  it('K3 «Назначить план» after «Назначить план импортированным»: `planId` follows the new plan, not the old one', async () => {
    const donors = Array.from({ length: 6 }, donor);
    const first = await remnashopImport(donors);
    const rowId = await assertForeignPanelRow(donors[0]!);
    const planA = await createPlan(fx, { trafficLimit: 100, deviceLimit: 3 });
    const planB = await createPlan(fx, { trafficLimit: 200, deviceLimit: 5 });
    await bulk.assignPlan({ planId: planA, userIds: [await userOf(donors[0]!)], createdBy: adminId });
    await assignPlan(rowId, planB);
    const row = await soleSubscription(donors[0]!);
    assert.deepEqual(
      { id: row.snapshot['id'], planId: row.snapshot['planId'], record: row.snapshot['importRecordId'] },
      { id: planB, planId: planB, record: first },
      'a `planId` left at the old plan would count the row as still on it',
    );
  });

  it('K4 the plan cloner does not re-link a row «Назначить план» put on a plan, though it carries the import’s keys', async () => {
    const donors = Array.from({ length: 6 }, donor);
    const first = await remnashopImport(donors);
    const rowId = await assertForeignPanelRow(donors[0]!);
    const plan = await createPlan(fx, { trafficLimit: 100, deviceLimit: 3 });
    await assignPlan(rowId, plan);
    const cloner = new BackupPlanClonerService(prisma);
    const cloned = await cloner.clone({
      importRecordId: first,
      selectedSourcePlanIds: [],
      linkSubscriptions: true,
      createdBy: adminId,
    });
    assert.equal(cloned.errors.length, 0, cloned.errors.join('; '));
    const assigned = await soleSubscription(donors[0]!);
    assert.equal(assigned.snapshot['id'], plan, 'the operator’s plan stands');
    // The control: a row nobody put on a plan IS linked by the same run.
    const control = await soleSubscription(donors[1]!);
    assert.equal(typeof control.snapshot['planId'], 'string', 'the cloner linked the unassigned row');
    assert.notEqual(control.snapshot['planId'], plan);
  });

  it('K5 3x-ui: after «Назначить план» the next import finds the row by its `importedFrom`, and keeps the plan', async () => {
    const telegramId = TELEGRAM_BASE + 900 + (donorSeq += 1);
    const client = {
      email: `xui-${fx.prefix}-${donorSeq}`,
      uuid: `00000000-3333-4000-8000-${String(donorSeq).padStart(12, '0')}`,
      password: null,
      subId: `sub-${fx.prefix}-${donorSeq}`,
      tgId: telegramId,
      totalGb: 50 * 1024 ** 3,
      limitIp: 2,
      expiryTime: Date.parse('2027-01-01T00:00:00Z'),
      enable: true,
      comment: null,
      reset: 0,
      up: 0,
      down: 0,
      inboundRemark: 'inbound',
      inboundProtocol: 'vless',
      subscriptionUrl: `https://xui.example/sub/${donorSeq}`,
    };
    const importer = new ThreeXuiImporterService(prisma);
    const firstRecord = await newImportRecord('3xui');
    assert.deepEqual((await importer.run({ mode: 'import', createdBy: null, importRecordId: firstRecord, clients: [client] })).errors, []);
    const user = await prisma.user.findFirstOrThrow({ where: { telegramId: BigInt(telegramId) }, select: { id: true } });
    const [row] = await prisma.subscription.findMany({ where: { userId: user.id }, select: { id: true } });
    const plan = await createPlan(fx, { trafficLimit: 100, deviceLimit: 3 });
    await assignPlan(row!.id, plan);

    const secondRecord = await newImportRecord('3xui');
    assert.deepEqual((await importer.run({ mode: 'sync', createdBy: null, importRecordId: secondRecord, clients: [client] })).errors, []);
    const rows = await prisma.subscription.findMany({
      where: { userId: user.id, status: { not: SubscriptionStatus.DELETED } },
      select: { id: true, planSnapshot: true },
    });
    assert.equal(rows.length, 1, 'no second subscription');
    const snapshot = rows[0]!.planSnapshot as Record<string, unknown>;
    assert.deepEqual(
      { id: snapshot['id'], name: snapshot['name'], importedFrom: snapshot['importedFrom'], record: snapshot['importRecordId'] },
      { id: plan, name: plan, importedFrom: '3xui', record: secondRecord },
      'the plan stays, and the import’s own keys are refreshed',
    );
  });
});
