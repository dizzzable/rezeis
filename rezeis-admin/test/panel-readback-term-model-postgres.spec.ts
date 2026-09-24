import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementCutoverService } from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { AltshopImporterService } from '../src/modules/imports/services/altshop-importer.service';
import { BedolagaImporterService } from '../src/modules/imports/services/bedolaga-importer.service';
import { RemnashopImporterService } from '../src/modules/imports/services/remnashop-importer.service';
import { RemnawaveImporterService } from '../src/modules/imports/services/remnawave-importer.service';
import { StealthnetImporterService } from '../src/modules/imports/services/stealthnet-importer.service';
import type { StealthnetReferralSyncService } from '../src/modules/imports/services/stealthnet-referral-sync.service';
import type { BedolagaBackupData } from '../src/modules/imports/utils/bedolaga-backup-parser';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import { ExpiredProfileCleanupService } from '../src/modules/profile-sync/expired-profile-cleanup.service';
import type { RemnawavePanelUser } from '../src/modules/remnawave/services/remnawave-api.service';
import { REMNAWAVE_LIMIT_DRIFT_CAUSE } from '../src/modules/remnawave/services/term-model-readback';
import { AdminUserSubscriptionsController } from '../src/modules/users/controllers/admin-user-subscriptions.controller';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';
import { realTermHooks } from './helpers/term-model-hooks';
import { at, createPlan, newUser, termModelFixtures, type Limits, type TermModelFixtures } from './helpers/term-model-fixtures';

/**
 * EVERY PATH THAT COPIES A REMNAWAVE PROFILE BACK ONTO AN EXISTING SUBSCRIPTION
 * follows the webhook's rule for a subscription in the term model
 * (`term-model-readback.ts`; the webhook itself: `remnawave-webhook-term-model-postgres`):
 * its limits are never taken — a profile holding other ones gets rezeis' own
 * pushed back — and its expiry is taken unless a push of rezeis' own is newer
 * than the read. A read made on request is timed BEFORE the request, so a push
 * that completes while the answer travels outranks it. Rows outside the model,
 * and rows being created, keep each writer's old behaviour.
 *
 * Through the real writers: «Импорт из Remnawave» (`RemnawaveImporterService`),
 * the ↻ refresh (`AdminUserSubscriptionsController.syncSubscription`), and the
 * four backup re-imports' panel overlay (Remnashop, Altshop, STEALTHNET,
 * Bedolaga). Only Remnawave itself is a double.
 *
 * Each case is named by the path it drives — IM the import, P the ↻ refresh,
 * CL the expired-profile cleanup, BR the backup re-imports — and a number.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;

const PLAN: Limits = { trafficLimit: 100, deviceLimit: 3 };
const GIB = 1024 ** 3;
/** A panel-id range no other spec uses, and a Telegram-id range per run. */
const PANEL_BASE = 1_900_000_000 + (Date.now() % 1_000_000) * 50;
const TELEGRAM_BASE = 7_100_000_000 + (Date.now() % 1_000_000) * 50;
const REQUEST = { headers: {}, ip: '10.0.0.9', socket: { remoteAddress: null } } as never;
/** How a profile made on 2.x is named: a uuid, here derived from its panel id. */
const uuidIdentity = (panelId: number): string => `${String(panelId).padStart(8, '0')}-0000-4000-8000-000000000000`;

let prisma: PrismaService;
let fx: TermModelFixtures;
const terms = new SubscriptionTermService();
const projections = new EffectiveProjectionService();
const importRecords: string[] = [];
let adminId = '';
/** Sync jobs the ↻ refresh handed to the queue. */
const enqueued: string[] = [];

interface Row {
  readonly userId: string;
  readonly subscriptionId: string;
  readonly panelId: number;
  /** The identity string the row stores — a uuid for the backup donors, `String(panelId)` otherwise. */
  readonly identity: string;
  readonly telegramId: bigint;
}

/** A linked subscription on a 3 / 100 GB plan whose snapshot records the plan's limits. */
async function linkedRow(
  planId: string,
  options: {
    readonly identity?: (panelId: number) => string;
    readonly panelId?: number;
    /** The same customer’s second row — the duplicate pair an old importer left. */
    readonly owner?: Row;
  } = {},
): Promise<Row> {
  const telegramId = options.owner?.telegramId ?? BigInt(TELEGRAM_BASE + fx.next());
  const userId = options.owner?.userId ?? (await newUser(fx, { telegramId }));
  const panelId = options.panelId ?? PANEL_BASE + fx.next();
  const identity = (options.identity ?? String)(panelId);
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
      trafficLimit: PLAN.trafficLimit,
      deviceLimit: PLAN.deviceLimit,
      internalSquads: [],
      externalSquad: null,
      remnawaveId: identity,
      remnawavePanelId: panelId,
      createdAt: at(-10),
      startedAt: at(-10),
      expiresAt: at(20),
    },
    select: { id: true },
  });
  return { userId, subscriptionId: row.id, panelId, identity, telegramId };
}

async function enterModel(row: Row): Promise<void> {
  const cutover = new EntitlementCutoverService(prisma, terms, projections);
  const entered = await prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, row.subscriptionId));
  assert.equal(entered.outcome, 'CREATED');
}

/** The profile as the panel answers for it: other limits (300 GB, 7 devices) and a later expiry. */
function profileOf(row: Row, overrides: Partial<RemnawavePanelUser> = {}): RemnawavePanelUser {
  return {
    uuid: row.identity,
    username: `rwrb-${row.panelId}`,
    status: 'ACTIVE',
    subscriptionUrl: `https://panel.example/sub/${row.panelId}`,
    telegramId: Number(row.telegramId),
    panelId: row.panelId,
    email: null,
    expireAt: at(25).toISOString(),
    createdAt: at(-10).toISOString(),
    lastTrafficResetAt: null,
    trafficLimitBytes: 300 * GIB,
    hwidDeviceLimit: 7,
    trafficLimitStrategy: 'NO_RESET',
    tag: null,
    // The owner marker: the importer matches the account by it and writes no
    // description back to the panel.
    description: `reiwa_id: ${row.userId}`,
    activeInternalSquads: [],
    externalSquadUuid: null,
    ...overrides,
  } as RemnawavePanelUser;
}

async function pushOfOurs(row: Row, status: SyncJobStatus, completedAt: Date | null = null): Promise<void> {
  await prisma.profileSyncJob.create({
    data: {
      subscriptionId: row.subscriptionId,
      action: SyncAction.UPDATE,
      status,
      completedAt,
      createdAt: completedAt === null ? new Date() : new Date(completedAt.getTime() - 1_000),
      payload: { source: 'ADMIN_MUTATION' },
    },
  });
}

async function state(row: Row) {
  return prisma.subscription.findUniqueOrThrow({
    where: { id: row.subscriptionId },
    select: { trafficLimit: true, deviceLimit: true, expiresAt: true, status: true, planSnapshot: true },
  });
}

async function putBacks(row: Row) {
  return prisma.profileSyncJob.findMany({
    where: { subscriptionId: row.subscriptionId, cause: REMNAWAVE_LIMIT_DRIFT_CAUSE },
  });
}

function assertPanelLimitsNotTaken(after: { trafficLimit: number | null; deviceLimit: number; planSnapshot: unknown }): void {
  assert.deepEqual(
    { trafficLimit: after.trafficLimit, deviceLimit: after.deviceLimit },
    { trafficLimit: 100, deviceLimit: 3 },
    'the panel’s 300 GB / 7 devices are not the customer’s own',
  );
  const snapshot = after.planSnapshot as Record<string, unknown>;
  assert.deepEqual({ t: snapshot['trafficLimit'], d: snapshot['deviceLimit'] }, { t: 100, d: 3 }, 'nor the snapshot’s');
}

async function newImportRecord(sourceType: string): Promise<string> {
  const record = await prisma.importRecord.create({
    data: { filename: `${fx.prefix}-${sourceType}.json`, sourceType },
    select: { id: true },
  });
  importRecords.push(record.id);
  return record.id;
}

/** A Remnawave double serving `profiles`; `onList` runs while the panel answers the bulk read. */
function panelDouble(profiles: readonly RemnawavePanelUser[], onList: () => Promise<void> = async () => undefined) {
  const byId = new Map(profiles.map((profile) => [profile.uuid, profile]));
  return {
    strictGetAllPanelUsers: async () => {
      await onList();
      return { kind: 'ok' as const, value: { users: [...profiles], total: profiles.length, complete: true } };
    },
    getPanelUser: async (id: string) => byId.get(id) ?? null,
    strictGetPanelUserExpiry: async (id: string) =>
      byId.has(id) ? { kind: 'ok' as const, value: null } : { kind: 'notFound' as const },
    updatePanelUser: async () => ({}),
  };
}

run('Remnawave read-backs onto a subscription in the term model (PostgreSQL)', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    prisma = new PrismaService();
    await prisma.$connect();
    fx = termModelFixtures(prisma, `rwrb-${process.pid}-${Date.now()}`);
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
    // The backup importers record a spent legacy trial for every donor account
    // that had none left; those rows hold the user.
    await prisma.trialClaim.deleteMany({ where: { userId: { in: fx.users } } }).catch(() => undefined);
    await removeDurableFixtures(prisma, fx.users).catch(() => undefined);
    await prisma.importRecord.deleteMany({ where: { id: { in: importRecords } } }).catch(() => undefined);
    await prisma.plan.deleteMany({ where: { id: { in: fx.plans } } }).catch(() => undefined);
    await prisma.adminUser.deleteMany({ where: { id: adminId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  // ── «Импорт из Remnawave» ──────────────────────────────────────────────────

  async function remnawaveImport(profiles: readonly RemnawavePanelUser[], onList?: () => Promise<void>) {
    const importer = new RemnawaveImporterService(prisma, panelDouble(profiles, onList) as never);
    const importRecordId = await newImportRecord('remnawave');
    const summary = await importer.run({ mode: 'sync', createdBy: null, importRecordId });
    assert.deepEqual(summary.errors, []);
    return summary;
  }

  it('IM1 the import takes status and expiry, not the limits, and puts the panel’s limits back', async () => {
    const plan = await createPlan(fx, PLAN);
    const row = await linkedRow(plan);
    await enterModel(row);
    const moved = at(25);
    await remnawaveImport([profileOf(row, { status: 'DISABLED', expireAt: moved.toISOString() })]);
    const after = await state(row);
    assertPanelLimitsNotTaken(after);
    assert.equal(after.expiresAt?.getTime(), moved.getTime(), 'the expiry is taken');
    assert.equal(after.status, SubscriptionStatus.DISABLED, 'the status is taken');
    const jobs = await putBacks(row);
    assert.equal(jobs.length, 1, 'one push of the panel’s own limits');
    assert.equal(jobs[0]!.status, SyncJobStatus.PENDING, 'left for the profile-sync sweep to queue');
    assert.deepEqual(jobs[0]!.payload, { source: REMNAWAVE_LIMIT_DRIFT_CAUSE });
  });

  it('IM2 while a push of ours is queued, the import takes neither the expiry nor the limits, and puts nothing back', async () => {
    const plan = await createPlan(fx, PLAN);
    const row = await linkedRow(plan);
    await enterModel(row);
    const before = (await state(row)).expiresAt;
    await pushOfOurs(row, SyncJobStatus.PENDING);
    await remnawaveImport([profileOf(row, { expireAt: at(5).toISOString() })]);
    const after = await state(row);
    assertPanelLimitsNotTaken(after);
    assert.equal(after.expiresAt?.getTime(), before?.getTime(), 'the paid days are not rolled back');
    assert.equal((await putBacks(row)).length, 0);
  });

  it('IM3 a push that lands while the panel answers outranks the read: the read is timed before the request', async () => {
    const plan = await createPlan(fx, PLAN);
    const row = await linkedRow(plan);
    await enterModel(row);
    const before = (await state(row)).expiresAt;
    await remnawaveImport([profileOf(row, { expireAt: at(5).toISOString() })], async () => {
      // The page walk is under way; a push of ours completes meanwhile.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await pushOfOurs(row, SyncJobStatus.COMPLETED, new Date());
    });
    assert.equal((await state(row)).expiresAt?.getTime(), before?.getTime());
    assert.equal((await putBacks(row)).length, 0);
  });

  it('IM4 a row outside the model is imported as before: limits, snapshot keys untouched, expiry taken, nothing pushed', async () => {
    const plan = await createPlan(fx, PLAN);
    const row = await linkedRow(plan);
    await pushOfOurs(row, SyncJobStatus.PENDING);
    const moved = at(5);
    await remnawaveImport([profileOf(row, { expireAt: moved.toISOString() })]);
    const after = await state(row);
    assert.deepEqual({ t: after.trafficLimit, d: after.deviceLimit }, { t: 300, d: 7 });
    assert.equal(after.expiresAt?.getTime(), moved.getTime());
    assert.equal((await putBacks(row)).length, 0);
  });

  it('IM5 a profile two live rows name: the import pushes nothing back', async () => {
    const plan = await createPlan(fx, PLAN);
    const first = await linkedRow(plan);
    const second = await linkedRow(plan, { panelId: first.panelId });
    await enterModel(first);
    await enterModel(second);
    await remnawaveImport([profileOf(first)]);
    assertPanelLimitsNotTaken(await state(first));
    assert.equal((await putBacks(first)).length + (await putBacks(second)).length, 0);
  });

  it('IM7 a DELETED row naming the profile too is no duplicate: the put-back still goes', async () => {
    const plan = await createPlan(fx, PLAN);
    const row = await linkedRow(plan);
    const retired = await linkedRow(plan, { panelId: row.panelId });
    await prisma.subscription.update({
      where: { id: retired.subscriptionId },
      data: { status: SubscriptionStatus.DELETED, createdAt: at(10) },
    });
    await enterModel(row);
    await remnawaveImport([profileOf(row)]);
    assertPanelLimitsNotTaken(await state(row));
    assert.equal((await putBacks(row)).length, 1);
  });

  it('IM6 a profile the panel reports deleted is not pushed back into existence', async () => {
    const plan = await createPlan(fx, PLAN);
    const row = await linkedRow(plan);
    await enterModel(row);
    await remnawaveImport([profileOf(row, { status: 'DELETED' })]);
    assertPanelLimitsNotTaken(await state(row));
    assert.equal((await putBacks(row)).length, 0);
  });

  // ── The ↻ refresh of one subscription ─────────────────────────────────────

  function refresher(answer: RemnawavePanelUser, during: () => Promise<void> = async () => undefined) {
    return new AdminUserSubscriptionsController(
      prisma,
      {
        getPanelUserOutcome: async () => {
          await during();
          return { kind: 'ok', user: answer };
        },
      } as never,
      { enqueue: async (syncJobId: string) => void enqueued.push(syncJobId) } as never,
      { info: () => undefined, warn: () => undefined, error: () => undefined, emit: () => undefined } as never,
      {} as never,
      {} as never,
      realTermHooks(prisma),
    );
  }

  async function lastRefreshAudit(row: Row): Promise<Record<string, unknown>> {
    const entry = await prisma.adminAuditLog.findFirstOrThrow({
      where: { adminUserId: adminId, action: 'user.sync.requested', metadata: { path: ['subscriptionId'], equals: row.subscriptionId } },
      orderBy: { createdAt: 'desc' },
    });
    return entry.metadata as Record<string, unknown>;
  }

  it('P1 ↻ takes the expiry, not the limits, and puts the panel’s limits back at once', async () => {
    const plan = await createPlan(fx, PLAN);
    const row = await linkedRow(plan);
    await enterModel(row);
    const moved = at(25);
    const answer = await refresher(profileOf(row, { expireAt: moved.toISOString() })).syncSubscription(
      row.subscriptionId,
      { id: adminId } as never,
      REQUEST,
    );
    assert.equal(answer.synced, true);
    const after = await state(row);
    assertPanelLimitsNotTaken(after);
    assert.equal(after.expiresAt?.getTime(), moved.getTime());
    const jobs = await putBacks(row);
    assert.equal(jobs.length, 1);
    assert.deepEqual(enqueued, [jobs[0]!.id], 'queued at once');
    const audit = await lastRefreshAudit(row);
    assert.equal(audit['panelLimits'], 'PUT_BACK');
    assert.equal(audit['expiryTaken'], true);
    assert.equal(audit['limitsPutBackSyncJobId'], jobs[0]!.id);
  });

  it('P2 ↻ does not roll the expiry back to a date a push landing meanwhile has already replaced', async () => {
    const plan = await createPlan(fx, PLAN);
    const row = await linkedRow(plan);
    await enterModel(row);
    const before = (await state(row)).expiresAt;
    const answer = await refresher(profileOf(row, { expireAt: at(5).toISOString() }), async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await pushOfOurs(row, SyncJobStatus.COMPLETED, new Date());
    }).syncSubscription(row.subscriptionId, { id: adminId } as never, REQUEST);
    assert.equal(answer.synced, true);
    assert.equal('expiresAt' in ((answer as { refreshed?: object }).refreshed ?? {}), false, 'and says it did not');
    assert.equal((await state(row)).expiresAt?.getTime(), before?.getTime());
    assert.equal((await putBacks(row)).length, 0);
    assert.deepEqual(enqueued, []);
    const audit = await lastRefreshAudit(row);
    assert.equal(audit['panelLimits'], 'OUTRANKED');
    assert.equal(audit['expiryTaken'], false);
  });

  it('P3 ↻ on a row outside the model: the expiry is taken as before, nothing is pushed', async () => {
    const plan = await createPlan(fx, PLAN);
    const row = await linkedRow(plan);
    await pushOfOurs(row, SyncJobStatus.PENDING);
    const moved = at(5);
    await refresher(profileOf(row, { expireAt: moved.toISOString() })).syncSubscription(
      row.subscriptionId,
      { id: adminId } as never,
      REQUEST,
    );
    const after = await state(row);
    assert.equal(after.expiresAt?.getTime(), moved.getTime());
    assert.deepEqual({ t: after.trafficLimit, d: after.deviceLimit }, { t: 100, d: 3 }, '↻ never took limits');
    assert.equal((await putBacks(row)).length, 0);
    assert.equal('panelLimits' in (await lastRefreshAudit(row)), false);
  });
  it('P4 ↻ on a profile a second live row names, by the identity this row stored: nothing is pushed back', async () => {
    // A profile made on 2.x: both rows store its uuid, the twin without the
    // numeric id beside it, and 3.x answers by the numeric id alone — so only
    // the identity the row itself stored finds the twin.
    const plan = await createPlan(fx, PLAN);
    const row = await linkedRow(plan, { identity: uuidIdentity });
    const twin = await linkedRow(plan, { identity: () => row.identity, owner: row });
    await prisma.subscription.update({ where: { id: twin.subscriptionId }, data: { remnawavePanelId: null } });
    await enterModel(row);
    const moved = at(25);
    const answer = await refresher(
      profileOf(row, { uuid: String(row.panelId), expireAt: moved.toISOString() }),
    ).syncSubscription(row.subscriptionId, { id: adminId } as never, REQUEST);
    assert.equal(answer.synced, true);
    assert.equal((await state(row)).expiresAt?.getTime(), moved.getTime(), 'the expiry is taken');
    assert.equal((await putBacks(row)).length + (await putBacks(twin)).length, 0);
    assert.deepEqual(enqueued, []);
    const audit = await lastRefreshAudit(row);
    assert.equal(audit['panelLimits'], 'SHARED_PROFILE');
    assert.match(String(audit['panelLimitsNote']), /merge the duplicates/);
  });

  // ── The expired-profile cleanup's self-heal ───────────────────────────────

  /** A row in the model (unless `outside`) that ended ten days ago: past the three-day grace. */
  async function endedRow(options: { readonly outside?: boolean } = {}): Promise<{ row: Row; ended: Date }> {
    const plan = await createPlan(fx, PLAN);
    const row = await linkedRow(plan);
    if (options.outside !== true) await enterModel(row);
    const ended = at(-10);
    await prisma.subscription.update({
      where: { id: row.subscriptionId },
      data: { expiresAt: ended, status: SubscriptionStatus.EXPIRED },
    });
    return { row, ended };
  }

  /**
   * The cleanup's pass over linked rows expired past a three-day grace, with a
   * panel that holds `panelExpireAt` for `row`'s profile and cannot be reached
   * for any other. `during` runs while the panel answers. Returns the rows it
   * asked to delete.
   */
  async function cleanupPass(row: Row, panelExpireAt: Date, during: () => Promise<void> = async () => undefined) {
    const deletions: string[] = [];
    const unreachable = { kind: 'network' as const, detail: 'not this case’s profile' };
    const cleanup = new ExpiredProfileCleanupService(
      prisma,
      { info: () => undefined, warn: () => undefined } as never,
      {} as never,
      {
        resolveUser: async () => unreachable,
        getUserById: async (userId: number) => {
          if (userId !== row.panelId) return unreachable;
          await during();
          return {
            kind: 'ok' as const,
            data: { response: { expireAt: panelExpireAt.toISOString(), subscriptionUrl: `https://panel.example/sub/${row.panelId}` } },
          };
        },
      } as never,
      {
        deleteExpiredIfUnchanged: async (input: { readonly subscriptionId: string }) => {
          deletions.push(input.subscriptionId);
          return { deleted: false };
        },
      } as never,
    );
    await (cleanup as unknown as { enqueueProfileDeletions(cutoff: Date): Promise<number> }).enqueueProfileDeletions(at(-3));
    return deletions;
  }

  it('CL1 the cleanup does not revive a row in the model to the date a push of ours is replacing', async () => {
    // Ended by rezeis (a refund, an operator's shortening); the push carrying
    // that end has not reached Remnawave, which still holds the old date.
    const { row, ended } = await endedRow();
    await pushOfOurs(row, SyncJobStatus.PENDING);
    const deletions = await cleanupPass(row, at(20));
    const after = await state(row);
    assert.equal(after.expiresAt?.getTime(), ended.getTime(), 'not healed to the old date');
    assert.equal(after.status, SubscriptionStatus.EXPIRED, 'not revived');
    assert.equal(deletions.includes(row.subscriptionId), false, 'and not deleted on that read either');
  });

  it('CL2 with nothing of ours pending, the cleanup heals a row in the model from the panel as before', async () => {
    const { row } = await endedRow();
    const extended = at(20);
    const deletions = await cleanupPass(row, extended);
    const after = await state(row);
    assert.equal(after.expiresAt?.getTime(), extended.getTime());
    assert.equal(after.status, SubscriptionStatus.ACTIVE);
    assert.equal(deletions.includes(row.subscriptionId), false);
  });

  it('CL3 a push that lands while the panel answers outranks the read: the cleanup is timed before it asks', async () => {
    const { row, ended } = await endedRow();
    await cleanupPass(row, at(20), async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await pushOfOurs(row, SyncJobStatus.COMPLETED, new Date());
    });
    assert.equal((await state(row)).expiresAt?.getTime(), ended.getTime());
  });

  it('CL4 a row outside the model is healed as before, a push of ours pending or not', async () => {
    const { row } = await endedRow({ outside: true });
    await pushOfOurs(row, SyncJobStatus.PENDING);
    const extended = at(20);
    await cleanupPass(row, extended);
    const after = await state(row);
    assert.equal(after.expiresAt?.getTime(), extended.getTime());
    assert.equal(after.status, SubscriptionStatus.ACTIVE);
  });

  // ── The backup re-imports' panel overlay ──────────────────────────────────

  type Backup = 'Remnashop' | 'Altshop' | 'STEALTHNET' | 'Bedolaga';
  const BACKUPS: readonly Backup[] = ['Remnashop', 'Altshop', 'STEALTHNET', 'Bedolaga'];

  /** A linked row named the way `backup` names profiles: Bedolaga by the panel id, the others by uuid. */
  function backupRow(backup: Backup, planId: string, twinOf?: Row): Promise<Row> {
    return linkedRow(planId, {
      ...(backup === 'Bedolaga' ? {} : { identity: uuidIdentity }),
      ...(twinOf === undefined ? {} : { panelId: twinOf.panelId, owner: twinOf }),
    });
  }

  function remnashopInput(row: Row, importRecordId: string) {
    const donorId = fx.next();
    return {
      mode: 'sync' as const,
      createdBy: null,
      importRecordId,
      users: [
        {
          id: donorId,
          telegram_id: Number(row.telegramId),
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
      ],
      subscriptions: [
        {
          id: donorId,
          user_remna_id: row.identity,
          user_telegram_id: Number(row.telegramId),
          status: 'ACTIVE',
          is_trial: false,
          traffic_limit: 50,
          device_limit: 2,
          traffic_limit_strategy: null,
          tag: null,
          internal_squads: [],
          external_squad: null,
          expire_at: '2027-01-01T00:00:00Z',
          url: 'https://old-panel.example/sub',
          plan_snapshot: null,
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
    };
  }

  function stealthnetInput(row: Row, importRecordId: string) {
    const client = `client-${fx.next()}`;
    return {
      mode: 'sync',
      createdBy: null,
      importRecordId,
      clients: [
        {
          id: client,
          email: null,
          password_hash: null,
          role: 'user',
          remnawave_uuid: row.identity,
          referral_code: null,
          referrer_id: null,
          balance: 0,
          preferred_lang: 'ru',
          preferred_currency: 'RUB',
          telegram_id: String(row.telegramId),
          telegram_username: null,
          is_blocked: false,
          block_reason: null,
          trial_used: false,
          current_tariff_id: null,
          bot_id: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
      subscriptions: [
        {
          id: `sub-${client}`,
          owner_id: client,
          remnawave_uuid: row.identity,
          subscription_index: 0,
          tariff_id: null,
          gift_status: null,
          gifted_to_client_id: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          expire_at: '2027-01-01T00:00:00Z',
          extra_devices: 0,
          extra_devices_monthly_price: 0,
        },
      ],
      tariffs: [],
      tariffCategories: [],
      tariffPriceOptions: [],
      payments: [],
      referralCredits: [],
    } as never;
  }

  function bedolagaData(row: Row): BedolagaBackupData {
    const donorId = fx.next();
    return {
      users: [
        {
          id: donorId,
          telegram_id: Number(row.telegramId),
          username: null,
          first_name: null,
          last_name: null,
          status: 'active',
          language: 'ru',
          balance_kopeks: 0,
          referred_by_id: null,
          referral_code: null,
          email: null,
          promo_group_id: null,
          promo_offer_discount_percent: 0,
          promo_offer_discount_expires_at: null,
          has_had_paid_subscription: true,
          remnawave_id: null,
          remnawave_uuid: null,
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      subscriptions: [
        {
          id: donorId,
          user_id: donorId,
          status: 'active',
          is_trial: false,
          start_date: '2026-01-01T00:00:00Z',
          end_date: '2027-01-01T00:00:00Z',
          traffic_limit_gb: 50,
          traffic_used_gb: 1,
          purchased_traffic_gb: 0,
          device_limit: 2,
          connected_squads: [],
          subscription_url: 'https://old-panel.example/sub',
          remnawave_id: row.panelId,
          remnawave_short_uuid: null,
          remnawave_uuid: null,
          tariff_id: null,
          autopay_enabled: false,
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      tariffs: [],
      promoGroups: [],
      userPromoGroups: [],
      transactions: [],
      promocodes: [],
      promocodeUses: [],
      referralEarnings: [],
      serverSquads: [],
      excludedDataIsComplete: true,
      sourceFormat: 'sql',
      excludedData: {
        pendingWithdrawals: 0,
        withdrawals: 0,
        coupons: 0,
        gifts: 0,
        wheelSpins: 0,
        contests: 0,
        temporaryAccess: 0,
        discountOffers: 0,
        tickets: 0,
      },
    } as unknown as BedolagaBackupData;
  }

  /**
   * Re-imports the donor account behind `row` from a `backup` backup, with
   * `panel` answering for Remnawave. Returns the run’s errors.
   */
  async function backupReimport(backup: Backup, row: Row, panel: object): Promise<readonly string[]> {
    switch (backup) {
      case 'Remnashop': {
        const importer = new RemnashopImporterService(prisma, panel as never);
        return (await importer.run(remnashopInput(row, await newImportRecord('remnashop')))).errors;
      }
      case 'Altshop': {
        const input = remnashopInput(row, await newImportRecord('altshop'));
        const importer = new AltshopImporterService(prisma, panel as never, new PointsWalletService());
        const subscriptions = input.subscriptions.map((subscription) => ({ ...subscription, device_type: null }));
        return (await importer.run({ ...input, subscriptions })).errors;
      }
      case 'STEALTHNET': {
        const importer = new StealthnetImporterService(
          prisma,
          panel as never,
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
        return (await importer.run(stealthnetInput(row, await newImportRecord('stealthnet')))).errors;
      }
      case 'Bedolaga': {
        const importer = new BedolagaImporterService(prisma, panel as never, new PointsWalletService());
        const importRecordId = await newImportRecord('bedolaga');
        return (await importer.run({ mode: 'sync', createdBy: null, importRecordId, data: bedolagaData(row) })).errors;
      }
    }
  }

  for (const backup of BACKUPS) {
    it(`BR1 ${backup}: a re-import onto a row in the model takes the overlaid expiry, not the limits, and puts them back`, async () => {
      const plan = await createPlan(fx, PLAN);
      const row = await backupRow(backup, plan);
      await enterModel(row);
      const moved = at(25);
      const errors = await backupReimport(backup, row, panelDouble([profileOf(row, { expireAt: moved.toISOString() })]));
      assert.deepEqual(errors, []);
      const after = await state(row);
      assert.deepEqual({ t: after.trafficLimit, d: after.deviceLimit }, { t: 100, d: 3 });
      assert.equal(after.expiresAt?.getTime(), moved.getTime(), 'the overlaid expiry is taken');
      assert.equal((await putBacks(row)).length, 1);
    });

    it(`BR7 ${backup}: a push that lands while the re-import reads the panel outranks the overlaid expiry`, async () => {
      const plan = await createPlan(fx, PLAN);
      const row = await backupRow(backup, plan);
      await enterModel(row);
      const before = (await state(row)).expiresAt;
      const panel = panelDouble([profileOf(row, { expireAt: at(5).toISOString() })], async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await pushOfOurs(row, SyncJobStatus.COMPLETED, new Date());
      });
      assert.deepEqual(await backupReimport(backup, row, panel), []);
      const after = await state(row);
      assert.deepEqual({ t: after.trafficLimit, d: after.deviceLimit }, { t: 100, d: 3 });
      assert.equal(after.expiresAt?.getTime(), before?.getTime(), 'the read is older than our push');
      assert.equal((await putBacks(row)).length, 0);
    });

    it(`BR8 ${backup}: a profile two live rows of the customer name gets nothing pushed back`, async () => {
      const plan = await createPlan(fx, PLAN);
      const first = await backupRow(backup, plan);
      const twin = await backupRow(backup, plan, first);
      await enterModel(first);
      await enterModel(twin);
      const moved = at(25);
      const errors = await backupReimport(backup, first, panelDouble([profileOf(first, { expireAt: moved.toISOString() })]));
      assert.deepEqual(errors, []);
      const rows = [await state(first), await state(twin)];
      assert.equal(
        rows.some((after) => after.expiresAt?.getTime() === moved.getTime()),
        true,
        'the re-import wrote the row it found',
      );
      for (const after of rows) assert.deepEqual({ t: after.trafficLimit, d: after.deviceLimit }, { t: 100, d: 3 });
      assert.equal((await putBacks(first)).length + (await putBacks(twin)).length, 0);
    });
  }

  it('BR2 a Remnashop re-import onto a row outside the model overlays the panel as before', async () => {
    const plan = await createPlan(fx, PLAN);
    const row = await backupRow('Remnashop', plan);
    assert.deepEqual(await backupReimport('Remnashop', row, panelDouble([profileOf(row)])), []);
    const after = await state(row);
    assert.deepEqual({ t: after.trafficLimit, d: after.deviceLimit }, { t: 300, d: 7 });
    assert.equal((await putBacks(row)).length, 0);
  });

  it('BR6 the backup donor’s own values, with no panel profile read, are written as before (not a Remnawave read-back)', async () => {
    const plan = await createPlan(fx, PLAN);
    const row = await backupRow('Remnashop', plan);
    await enterModel(row);
    // The panel cannot be read: the overlay falls back to the donor (50 GB / 2).
    await backupReimport('Remnashop', row, {
      strictGetAllPanelUsers: async () => ({ kind: 'unavailable' as const, reason: 'down' }),
      getPanelUser: async () => null,
      strictGetPanelUserExpiry: async () => ({ kind: 'unavailable' as const, reason: 'down' }),
    });
    const after = await state(row);
    assert.deepEqual({ t: after.trafficLimit, d: after.deviceLimit }, { t: 50, d: 2 });
    assert.equal((await putBacks(row)).length, 0);
  });
});
