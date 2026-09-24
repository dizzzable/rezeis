import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { BackupPlanClonerService } from '../src/modules/imports/services/backup-plan-cloner.service';
import { RemnashopImporterService } from '../src/modules/imports/services/remnashop-importer.service';
import { StealthnetImporterService } from '../src/modules/imports/services/stealthnet-importer.service';
import type { StealthnetReferralSyncService } from '../src/modules/imports/services/stealthnet-referral-sync.service';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';

/**
 * «Клонировать тарифы» ON A REAL DATABASE: what the clone links, and what it
 * reuses.
 *
 *  - STEALTHNET subscriptions are linked to the clone of their tariff. The
 *    catalog names a tariff by the hash of its CUID, and the link read the
 *    subscription's raw CUID as a number — `NaN` for every one, so none was
 *    ever linked (C1). The other donors' integer ids still link (C4).
 *  - A second clone of the same backup REUSES the plans the first one made. The
 *    reuse test could never pass (the name it compared was always free), so
 *    every run made «Имя2» of every plan (C2); a plan an operator hand-rolled
 *    under the same name that sells something else still gets the suffix
 *    (C3). A reused plan's references are the operator's and are not
 *    rewritten (C5).
 *
 * Through the real importers and the real cloner; Remnawave cannot be read.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;

const TELEGRAM_BASE = 7_800_000_000 + (Date.now() % 1_000_000) * 50;
const DONOR_BASE = 600_000 + (Date.now() % 100_000);
const GIB = 1024 ** 3;

let prisma: PrismaService;
let prefix = '';
let adminId = '';
let seq = 0;
const importRecords: string[] = [];

/** Remnawave cannot be read: every importer keeps the backup's own values. */
const PANEL_DOWN = {
  strictGetAllPanelUsers: async () => ({ kind: 'unavailable' as const, reason: 'down' }),
  getPanelUser: async () => null,
  strictGetPanelUserExpiry: async () => ({ kind: 'unavailable' as const, reason: 'down' }),
};

async function newImportRecord(sourceType: string): Promise<string> {
  const record = await prisma.importRecord.create({
    data: { filename: `${prefix}-${sourceType}.json`, sourceType },
    select: { id: true },
  });
  importRecords.push(record.id);
  return record.id;
}

function next(): number {
  seq += 1;
  return seq;
}

/** A STEALTHNET backup: `count` clients on one tariff named `tariffName`. */
async function stealthnetImport(tariffId: string, tariffName: string, count: number): Promise<{ record: string; telegramIds: number[] }> {
  const record = await newImportRecord('stealthnet');
  const telegramIds: number[] = [];
  const clients: Record<string, unknown>[] = [];
  const subscriptions: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i += 1) {
    const n = next();
    const telegramId = TELEGRAM_BASE + n;
    telegramIds.push(telegramId);
    const client = `client-${prefix}-${n}`;
    const uuid = `${String(DONOR_BASE + n).padStart(8, '0')}-4444-4000-8000-${String(n).padStart(12, '0')}`;
    clients.push({
      id: client,
      email: null,
      password_hash: null,
      role: 'user',
      remnawave_uuid: uuid,
      referral_code: null,
      referrer_id: null,
      balance: 0,
      preferred_lang: 'ru',
      preferred_currency: 'RUB',
      telegram_id: String(telegramId),
      telegram_username: null,
      is_blocked: false,
      block_reason: null,
      trial_used: false,
      current_tariff_id: tariffId,
      bot_id: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });
    subscriptions.push({
      id: `sub-${client}`,
      owner_id: client,
      remnawave_uuid: uuid,
      subscription_index: 0,
      tariff_id: tariffId,
      gift_status: null,
      gifted_to_client_id: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      expire_at: '2027-01-01T00:00:00Z',
      extra_devices: 0,
      extra_devices_monthly_price: 0,
    });
  }
  const importer = new StealthnetImporterService(
    prisma,
    PANEL_DOWN as never,
    {
      syncImport: async () => ({
        mappings: [],
        created: 0,
        existing: 0,
        skipped: 0,
        creditsCreated: 0,
        creditsExisting: 0,
        creditsSkipped: 0,
      }),
    } as unknown as StealthnetReferralSyncService,
    new PointsWalletService(),
  );
  const summary = await importer.run({
    mode: 'import',
    createdBy: null,
    importRecordId: record,
    clients,
    subscriptions,
    tariffs: [
      {
        id: tariffId,
        category_id: 'category-1',
        name: tariffName,
        description: null,
        duration_days: 30,
        internal_squad_uuids: [],
        traffic_limit_bytes: 50 * GIB,
        traffic_reset_mode: 'no_reset',
        device_limit: 2,
        price: 5,
        currency: 'RUB',
        sort_order: 0,
        included_devices: 2,
        max_extra_devices: 0,
        price_per_extra_device: 0,
      },
    ],
    tariffCategories: [{ id: 'category-1', name: 'Main', emoji_key: null, sort_order: 0 }],
    tariffPriceOptions: [],
    payments: [],
    referralCredits: [],
  } as never);
  assert.deepEqual((summary as { errors: readonly string[] }).errors, []);
  return { record, telegramIds };
}

/** A Remnashop backup with a catalog of `plans` and one subscription on each (by the plan's `id`). */
async function remnashopImport(
  plans: ReadonlyArray<{ readonly id: number; readonly name: string; readonly upgradeTo?: readonly number[] }>,
): Promise<{ record: string; telegramIds: number[] }> {
  const record = await newImportRecord('remnashop');
  const telegramIds: number[] = [];
  const users: Record<string, unknown>[] = [];
  const subscriptions: Record<string, unknown>[] = [];
  for (const plan of plans) {
    const n = next();
    const telegramId = TELEGRAM_BASE + n;
    telegramIds.push(telegramId);
    users.push({
      id: DONOR_BASE + n,
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
    });
    subscriptions.push({
      id: DONOR_BASE + n,
      user_remna_id: `${String(DONOR_BASE + n).padStart(8, '0')}-5555-4000-8000-${String(n).padStart(12, '0')}`,
      user_telegram_id: telegramId,
      status: 'ACTIVE',
      is_trial: false,
      traffic_limit: 70,
      device_limit: 4,
      traffic_limit_strategy: 'MONTH',
      tag: null,
      internal_squads: [],
      external_squad: null,
      expire_at: '2027-01-01T00:00:00Z',
      url: null,
      plan_snapshot: { id: plan.id, name: plan.name },
      created_at: '2026-01-01T00:00:00Z',
    });
  }
  const importer = new RemnashopImporterService(prisma, PANEL_DOWN as never);
  const summary = await importer.run({
    mode: 'import',
    createdBy: null,
    importRecordId: record,
    users,
    subscriptions,
    plans: plans.map((plan) => ({
      id: plan.id,
      public_code: `code-${plan.id}`,
      name: plan.name,
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
      upgrade_to_plan_ids: plan.upgradeTo ?? [],
    })),
    planDurations: plans.map((plan) => ({ id: plan.id, plan_id: plan.id, days: 30, order_index: 0 })),
    planPrices: plans.map((plan) => ({ id: plan.id, plan_duration_id: plan.id, currency: 'RUB', price: '199' })),
  } as never);
  assert.deepEqual((summary as { errors: readonly string[] }).errors, []);
  return { record, telegramIds };
}

async function snapshotsOf(telegramIds: readonly number[]): Promise<Array<Record<string, unknown>>> {
  const rows = await prisma.subscription.findMany({
    where: { user: { telegramId: { in: telegramIds.map((id) => BigInt(id)) } } },
    select: { planSnapshot: true },
  });
  return rows.map((row) => row.planSnapshot as Record<string, unknown>);
}

async function clone(record: string) {
  const result = await new BackupPlanClonerService(prisma).clone({
    importRecordId: record,
    selectedSourcePlanIds: [],
    linkSubscriptions: true,
    createdBy: adminId,
  });
  assert.deepEqual(result.errors, []);
  return result;
}

run('«Клонировать тарифы»: links and reuse (PostgreSQL)', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    prisma = new PrismaService();
    await prisma.$connect();
    prefix = `bpc-${process.pid}-${Date.now()}`;
    const admin = await prisma.adminUser.create({
      data: { login: `${prefix}-admin`, loginNormalized: `${prefix}-admin`, passwordHash: 'not-a-hash' },
      select: { id: true },
    });
    adminId = admin.id;
  });

  after(async () => {
    if (prisma === undefined) return;
    const users = await prisma.user.findMany({
      where: { telegramId: { gte: BigInt(TELEGRAM_BASE), lt: BigInt(TELEGRAM_BASE + 1_000) } },
      select: { id: true },
    });
    const ids = users.map((u) => u.id);
    await prisma.adminAuditLog.deleteMany({ where: { adminUserId: adminId } }).catch(() => undefined);
    await prisma.profileSyncJob.deleteMany({ where: { subscription: { userId: { in: ids } } } }).catch(() => undefined);
    await prisma.trialClaim.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
    await removeDurableFixtures(prisma, ids).catch(() => undefined);
    await prisma.importRecord.deleteMany({ where: { id: { in: importRecords } } }).catch(() => undefined);
    await prisma.plan.deleteMany({ where: { name: { startsWith: prefix } } }).catch(() => undefined);
    await prisma.adminUser.deleteMany({ where: { id: adminId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('C1 STEALTHNET subscriptions are linked to the clone of their tariff', async () => {
    const tariffName = `${prefix} Stealth Pro`;
    const { record, telegramIds } = await stealthnetImport(`tariff-${prefix}-pro`, tariffName, 2);
    const preview = await new BackupPlanClonerService(prisma).preview(record);
    assert.equal(preview.plans[0]?.subscriptionsCount, 2, 'the preview counts them');
    const result = await clone(record);
    assert.equal(result.plansCreated, 1);
    const plan = await prisma.plan.findUniqueOrThrow({ where: { name: tariffName }, select: { id: true } });
    for (const snapshot of await snapshotsOf(telegramIds)) {
      assert.deepEqual({ id: snapshot['id'], planId: snapshot['planId'], name: snapshot['name'] }, { id: plan.id, planId: plan.id, name: tariffName });
    }
    assert.equal(result.subscriptionsLinked >= 2, true);
  });

  it('C2 a second clone of the same backup reuses the plans the first one made: no «Имя2»', async () => {
    const name = `${prefix} Standard`;
    const { record, telegramIds } = await remnashopImport([{ id: 11, name }]);
    const first = await clone(record);
    assert.deepEqual([first.plansCreated, first.plansReused], [1, 0]);
    const plan = await prisma.plan.findUniqueOrThrow({ where: { name }, select: { id: true } });

    const preview = await new BackupPlanClonerService(prisma).preview(record);
    assert.deepEqual(
      { finalName: preview.plans[0]?.finalName, reuse: preview.plans[0]?.willReuseExisting },
      { finalName: name, reuse: true },
      'the preview says what the clone will do',
    );
    const second = await clone(record);
    assert.deepEqual([second.plansCreated, second.plansReused], [0, 1]);
    assert.equal(await prisma.plan.count({ where: { name: `${name}2` } }), 0, 'no «Имя2»');
    for (const snapshot of await snapshotsOf(telegramIds)) assert.equal(snapshot['id'], plan.id);
  });

  it('C3 a plan an operator made under the same name that sells something else keeps its name: the clone gets a suffix', async () => {
    const name = `${prefix} Basic`;
    await prisma.plan.create({
      data: { name, trafficLimit: 500, deviceLimit: 9, orderIndex: 700_000, internalSquads: [], trafficLimitStrategy: 'MONTH' },
    });
    const { record } = await remnashopImport([{ id: 12, name }]);
    const preview = await new BackupPlanClonerService(prisma).preview(record);
    assert.deepEqual(
      { finalName: preview.plans[0]?.finalName, reuse: preview.plans[0]?.willReuseExisting },
      { finalName: `${name}2`, reuse: false },
    );
    const result = await clone(record);
    assert.deepEqual([result.plansCreated, result.plansReused], [1, 0]);
    assert.equal(await prisma.plan.count({ where: { name: `${name}2` } }), 1);
  });

  it('C3b a deleted plan is never reused, even one that sells the same', async () => {
    const name = `${prefix} Retired`;
    const retired = await prisma.plan.create({
      data: {
        name,
        trafficLimit: 70,
        deviceLimit: 4,
        orderIndex: 700_001,
        internalSquads: [],
        trafficLimitStrategy: 'MONTH',
        deletedAt: new Date(),
      },
      select: { id: true },
    });
    const { record, telegramIds } = await remnashopImport([{ id: 14, name }]);
    const result = await clone(record);
    assert.deepEqual([result.plansCreated, result.plansReused], [1, 0]);
    const [snapshot] = await snapshotsOf(telegramIds);
    assert.notEqual(snapshot?.['planId'], retired.id, 'not linked to the deleted plan');
  });

  it('C4 the other donors’ integer plan ids still link', async () => {
    const name = `${prefix} Remna Link`;
    const { record, telegramIds } = await remnashopImport([{ id: 13, name }]);
    await clone(record);
    const plan = await prisma.plan.findUniqueOrThrow({ where: { name }, select: { id: true } });
    const [snapshot] = await snapshotsOf(telegramIds);
    assert.equal(snapshot?.['planId'], plan.id);
  });

  it('C5 a reused plan’s references are the operator’s: a second clone does not rewrite them', async () => {
    const upper = `${prefix} Upper`;
    const lower = `${prefix} Lower`;
    const { record } = await remnashopImport([
      { id: 21, name: lower, upgradeTo: [22] },
      { id: 22, name: upper },
    ]);
    await clone(record);
    const lowerPlan = await prisma.plan.findUniqueOrThrow({ where: { name: lower }, select: { id: true, upgradeToPlanIds: true } });
    const upperPlan = await prisma.plan.findUniqueOrThrow({ where: { name: upper }, select: { id: true } });
    assert.deepEqual(lowerPlan.upgradeToPlanIds, [upperPlan.id], 'fixture: the first clone translated the reference');
    // The operator removes the upgrade path.
    await prisma.plan.update({ where: { id: lowerPlan.id }, data: { upgradeToPlanIds: [] } });
    const second = await clone(record);
    assert.equal(second.plansReused, 2);
    const after = await prisma.plan.findUniqueOrThrow({ where: { id: lowerPlan.id }, select: { upgradeToPlanIds: true } });
    assert.deepEqual(after.upgradeToPlanIds, []);
  });
});
