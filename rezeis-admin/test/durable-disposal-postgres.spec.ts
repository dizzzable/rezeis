import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { ConflictException } from '@nestjs/common';
import {
  EntitlementIncidentKind,
  EntitlementIncidentState,
  Prisma,
  SubscriptionStatus,
  SubscriptionTermStatus,
} from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementCutoverService } from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { BulkPlanAssignmentService } from '../src/modules/imports/services/bulk-plan-assignment.service';
import { PlanMigrationMoveService } from '../src/modules/plans/migrations/plan-migration-move.service';
import { DuplicateSubscriptionMergeService } from '../src/modules/profile-sync/duplicate-subscription-merge.service';
import { AdminUserSubscriptionsController } from '../src/modules/users/controllers/admin-user-subscriptions.controller';
import { UserDeletionService } from '../src/modules/users/services/user-deletion.service';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';
import { realTermHooks } from './helpers/term-model-hooks';

/**
 * WHAT GOES WITH A ROW, AND WHAT REFUSES — against PostgreSQL,
 * because the question is the foreign-key graph: every durable row is
 * `Restrict` on its subscription.
 *
 * A duplicate the importer minted gets its first term from the cutover; then
 * «Назначить план», «Назначить план импортированным» or a plan migration
 * rotates it — generation 2, and nobody paid. «Слияние подписок-дубликатов»
 * refused such a pair «resolved by hand» with no tool to do it, and the
 * ordinary user deletion hit the foreign key and refused naming nothing.
 *
 * Every plan change here goes through its REAL writer, so a renamed
 * `snapshotSource` fails this spec rather than quietly turning a no-money
 * chain into "money". Money — an add-on, a paid term, a reset period, a device
 * plan, an OPEN incident — still refuses both, and now by name.
 *
 * Runs only with TEST_DATABASE_URL; list it in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `d3disp-${process.pid}-${Date.now()}`;
const DAY_MS = 86_400_000;
const DEAD_UUID = '330f2b38-1f1e-4f6a-9f2b-0a1b2c3d4e5f';
const REQUEST = { headers: {}, ip: '10.0.0.9', socket: { remoteAddress: null } } as never;
const SILENT = { info: () => undefined, warn: () => undefined, error: () => undefined, emit: () => undefined };

let prisma: PrismaService;
let cutover: EntitlementCutoverService;
let adminId = '';
const users: string[] = [];
const plans: string[] = [];
const runs: string[] = [];
const importRecords: string[] = [];
let counter = 0;
const next = (): number => ++counter;
let panelSeq = 947_000;

async function createPlan(label: string): Promise<string> {
  const id = `${prefix}-plan-${label}-${next()}`;
  await prisma.plan.create({
    data: {
      id,
      name: id,
      orderIndex: 700_000 + next(),
      trafficLimit: 100,
      deviceLimit: 3,
      trafficLimitStrategy: 'NO_RESET',
      internalSquads: [],
      durations: { create: [{ days: 30, prices: { create: [{ currency: 'RUB', price: '199' }] } }] },
    },
  });
  plans.push(id);
  return id;
}

async function createUser(label: string): Promise<string> {
  const id = `${prefix}-user-${label}-${next()}`;
  await prisma.user.create({ data: { id, referralCode: id, name: id } });
  users.push(id);
  return id;
}

interface Pair {
  readonly userId: string;
  readonly survivorId: string;
  readonly duplicateId: string;
  readonly panelId: number;
}

/**
 * One pair as the 2.x → 3.x split leaves it, both halves cut over: the OLDER
 * row with a dead uuid, the NEWER one the importer minted with the live id.
 */
async function pair(label: string, duplicateSnapshot: Record<string, unknown>): Promise<Pair> {
  const userId = await createUser(label);
  panelSeq += 1;
  const panelId = panelSeq;
  const survivorId = `${prefix}-${label}-old`;
  const duplicateId = `${prefix}-${label}-new`;
  await prisma.subscription.create({
    data: {
      id: survivorId,
      userId,
      status: SubscriptionStatus.ACTIVE,
      planSnapshot: { id: 'plan-year', name: 'Годовой', trafficLimitStrategy: 'NO_RESET' },
      trafficLimit: 100,
      deviceLimit: 3,
      createdAt: new Date(Date.now() - 400 * DAY_MS),
      expiresAt: new Date(Date.now() + 20 * DAY_MS),
      remnawaveId: DEAD_UUID,
      remnawavePanelUsername: `${prefix}-${label}`,
      configUrl: `https://sub.example.test/OLD${label}`,
    },
  });
  await prisma.subscription.create({
    data: {
      id: duplicateId,
      userId,
      status: SubscriptionStatus.ACTIVE,
      planSnapshot: duplicateSnapshot as Prisma.InputJsonValue,
      trafficLimit: 100,
      deviceLimit: 3,
      createdAt: new Date(Date.now() - 2 * DAY_MS),
      expiresAt: new Date(Date.now() + 20 * DAY_MS),
      remnawaveId: String(panelId),
      remnawavePanelId: panelId,
      remnawavePanelUsername: `${prefix}-${label}`,
      configUrl: `https://sub.example.test/NEW${label}`,
    },
  });
  for (const id of [survivorId, duplicateId]) {
    const entered = await prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, id));
    assert.equal(entered.outcome, 'CREATED', 'fixture: both halves went through the cutover');
  }
  return { userId, survivorId, duplicateId, panelId };
}

const IMPORTED = { importedFrom: 'remnawave', trafficLimitStrategy: 'NO_RESET' };

/** «Пользователи» → подписка → «Назначить план», through the real route. */
async function assignPlan(subscriptionId: string, planId: string): Promise<void> {
  const editor = new AdminUserSubscriptionsController(
    prisma,
    { getPanelUserOutcome: async () => ({ kind: 'missing' }) } as never,
    { enqueue: async () => undefined } as never,
    SILENT as never,
    {} as never,
    {} as never,
    realTermHooks(prisma),
  );
  await editor.updateSubscription(subscriptionId, { planId }, { id: adminId } as never, REQUEST);
}

async function chainOf(subscriptionId: string): Promise<Array<[number, string, unknown]>> {
  const rows = await prisma.subscriptionTerm.findMany({
    where: { subscriptionId },
    orderBy: { generation: 'asc' },
    select: { generation: true, status: true, planSnapshot: true },
  });
  return rows.map((row) => [
    row.generation,
    row.status,
    (row.planSnapshot as Record<string, unknown> | null)?.['snapshotSource'] ?? null,
  ]);
}

function panelFor(panelId: number, userId: string) {
  return {
    resolveUser: async () => ({ kind: 'ok', data: { response: { id: panelId, shortUuid: null, username: null } } }),
    getUserById: async () => ({ kind: 'ok', data: { response: { description: `reiwa_id: ${userId}`, username: 'p' } } }),
  };
}

async function merge(target: Pair) {
  const report = await new DuplicateSubscriptionMergeService(
    prisma,
    panelFor(target.panelId, target.userId) as never,
    {} as never,
    SILENT as never,
  ).merge({
    dryRun: false,
    pairs: [{ survivorSubscriptionId: target.survivorId, duplicateSubscriptionId: target.duplicateId }],
  });
  return report.rows[0]!;
}

async function assertMergedAndEmptied(target: Pair, discarded: readonly string[]): Promise<void> {
  const row = await merge(target);
  assert.equal(row.outcome, 'merged', row.reason ?? '');
  assert.deepEqual(
    row.discardedCutoverRows.map((discard) => `${discard.model}=${discard.discarded}`),
    discarded,
  );
  assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId: target.duplicateId } }), 0);
  assert.equal(await prisma.subscriptionEffectiveProjection.count({ where: { subscriptionId: target.duplicateId } }), 0);
  const retired = await prisma.subscription.findUniqueOrThrow({ where: { id: target.duplicateId } });
  assert.equal(retired.status, SubscriptionStatus.DELETED);
  // The survivor keeps its own chain and takes the identity.
  assert.deepEqual(await chainOf(target.survivorId), [[1, 'ACTIVE', null]]);
  const survivor = await prisma.subscription.findUniqueOrThrow({ where: { id: target.survivorId } });
  assert.equal(survivor.remnawaveId, String(target.panelId));
}

async function incidentOn(subscriptionId: string, state: EntitlementIncidentState): Promise<void> {
  await prisma.entitlementIncident.create({
    data: {
      subscriptionId,
      kind: EntitlementIncidentKind.RECONCILIATION_REQUIRED,
      state,
      supportRef: `${prefix}-inc-${next()}`,
      summaryCode: 'CUTOVER_FAILED',
      ...(state === EntitlementIncidentState.OPEN ? {} : { acknowledgedBy: adminId, acknowledgedAt: new Date() }),
    },
  });
}

/** A paid renewal's queued term, as `scheduleRenewalTermInTransaction` writes it. */
async function paidRenewalTermOn(subscriptionId: string): Promise<void> {
  const tail = await prisma.subscriptionTerm.findFirstOrThrow({
    where: { subscriptionId },
    orderBy: { generation: 'desc' },
  });
  await prisma.subscriptionTerm.create({
    data: {
      subscriptionId,
      generation: tail.generation + 1,
      status: SubscriptionTermStatus.SCHEDULED,
      planSnapshot: { snapshotSource: 'RENEWAL_TERM' },
      startsAt: tail.endsAt!,
      endsAt: new Date(tail.endsAt!.getTime() + 30 * DAY_MS),
      baseTrafficLimitBytes: 100n * 1024n * 1024n * 1024n,
      baseDeviceLimit: 3,
      trafficResetStrategy: 'NO_RESET',
    },
  });
}

function deletion(): UserDeletionService {
  return new UserDeletionService(
    prisma,
    { getPanelShape: async () => ({ shape: 'id' as const }), deletePanelUser: async () => undefined } as never,
    new AddOnEntitlementService(),
    new SubscriptionTermService(),
  );
}

/** The ordinary deletion's refusal, as the SPA receives its `blockedBy`. */
async function refusedDeletion(userId: string): Promise<Record<string, unknown>> {
  let refusal: unknown = null;
  await assert.rejects(
    () => deletion().deleteUser(userId),
    (error: unknown) => {
      refusal = error;
      return error instanceof ConflictException;
    },
  );
  const body = (refusal as ConflictException).getResponse() as Record<string, unknown>;
  assert.equal(body['code'], 'USER_DELETE_PROTECTED_HISTORY');
  assert.ok(body['blockedBy'] !== undefined, 'the refusal names what refused it');
  return body['blockedBy'] as Record<string, unknown>;
}

run('what goes with a row and what refuses: merge and deletion (PostgreSQL)', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    delete process.env.ADDON_ENTITLEMENT_SHADOW;
    prisma = new PrismaService();
    await prisma.$connect();
    const terms = new SubscriptionTermService();
    const projections = new EffectiveProjectionService();
    cutover = new EntitlementCutoverService(prisma, terms, projections);
    const admin = await prisma.adminUser.create({
      data: { login: `${prefix}-admin`, loginNormalized: `${prefix}-admin`, passwordHash: 'x' },
      select: { id: true },
    });
    adminId = admin.id;
  });

  after(async () => {
    if (prisma === undefined) return;
    await prisma.planMigrationItem.deleteMany({ where: { runId: { in: runs } } }).catch(() => undefined);
    await prisma.planMigrationRun.deleteMany({ where: { id: { in: runs } } }).catch(() => undefined);
    await prisma.importRecord.deleteMany({ where: { id: { in: importRecords } } }).catch(() => undefined);
    await prisma.adminAuditLog.deleteMany({ where: { adminUserId: adminId } }).catch(() => undefined);
    await removeDurableFixtures(prisma, users).catch((error: unknown) => {
      console.error('durable disposal cleanup failed', error);
    });
    await prisma.plan.deleteMany({ where: { id: { in: plans } } }).catch(() => undefined);
    await prisma.adminUser.deleteMany({ where: { id: adminId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  describe('«Слияние подписок-дубликатов»', () => {
    it('merges a no-money duplicate after «Назначить план»: its rotated chain goes with it', async () => {
      const target = await pair('assign', IMPORTED);
      await assignPlan(target.duplicateId, await createPlan('assign'));
      assert.deepEqual(await chainOf(target.duplicateId), [
        [1, 'ENDED', null],
        [2, 'ACTIVE', 'ADMIN_PLAN_ASSIGNMENT_TERM'],
      ]);

      await assertMergedAndEmptied(target, ['SubscriptionEffectiveProjection=1', 'SubscriptionTerm=2']);
    });

    it('merges one after «Назначить план импортированным» (the bulk assignment)', async () => {
      // The survivor's snapshot names its plan under `id` only, as every
      // panel writer leaves it: that alone keeps it out of the assignment.
      const target = await pair('bulk', IMPORTED);
      const planId = await createPlan('bulk');
      const bulk = new BulkPlanAssignmentService(prisma, { enqueue: async () => undefined } as never, realTermHooks(prisma));
      const result = await bulk.assignPlan({ planId, userIds: [target.userId], createdBy: `${prefix}-admin` });
      assert.equal(result.updated, 1, 'fixture: the imported half was assigned, the survivor skipped');
      assert.equal(result.skippedAlreadyAssigned, 1);
      assert.deepEqual(await chainOf(target.duplicateId), [
        [1, 'ENDED', null],
        [2, 'ACTIVE', 'BULK_PLAN_ASSIGNMENT_TERM'],
      ]);

      await assertMergedAndEmptied(target, ['SubscriptionEffectiveProjection=1', 'SubscriptionTerm=2']);
    });

    it('merges one a plan migration moved', async () => {
      const source = await createPlan('from');
      const targetPlan = await createPlan('to');
      const target = await pair('migrated', {
        id: source,
        name: source,
        trafficLimit: 100,
        deviceLimit: 3,
        trafficLimitStrategy: 'NO_RESET',
        internalSquads: [],
        externalSquad: null,
        selectedDurationDays: 30,
      });
      const migration = await prisma.planMigrationRun.create({
        data: { sourcePlanId: source, status: 'RUNNING', createdByAdminId: adminId, totalItems: 1, startedAt: new Date() },
        select: { id: true },
      });
      runs.push(migration.id);
      const item = await prisma.planMigrationItem.create({
        data: { runId: migration.id, subscriptionId: target.duplicateId, fromPlanId: source, toPlanId: targetPlan },
        select: { id: true },
      });
      const move = new PlanMigrationMoveService(
        prisma,
        new SubscriptionTermService(),
        new EffectiveProjectionService(),
        { enqueue: async () => undefined } as never,
      );
      await move.processItem(
        {
          id: migration.id,
          sourcePlanId: source,
          createdByAdminId: adminId,
          requestId: null,
          ipAddress: null,
          userAgent: null,
        },
        item.id,
      );
      const moved = await prisma.planMigrationItem.findUniqueOrThrow({ where: { id: item.id } });
      assert.equal(moved.status, 'MOVED', moved.detail ?? moved.reason ?? '');
      assert.deepEqual(await chainOf(target.duplicateId), [
        [1, 'ENDED', null],
        [2, 'ACTIVE', 'PLAN_MIGRATION_TERM'],
      ]);

      await assertMergedAndEmptied(target, ['SubscriptionEffectiveProjection=1', 'SubscriptionTerm=2']);
    });

    it('takes a CLOSED incident with it, and refuses on an OPEN one — naming it', async () => {
      const closed = await pair('closed', IMPORTED);
      await assignPlan(closed.duplicateId, await createPlan('closed'));
      await incidentOn(closed.duplicateId, EntitlementIncidentState.ACKNOWLEDGED);
      await assertMergedAndEmptied(closed, [
        'SubscriptionEffectiveProjection=1',
        'SubscriptionTerm=2',
        'EntitlementIncident=1',
      ]);
      assert.equal(await prisma.entitlementIncident.count({ where: { subscriptionId: closed.duplicateId } }), 0);

      const open = await pair('open', IMPORTED);
      await incidentOn(open.duplicateId, EntitlementIncidentState.OPEN);
      const row = await merge(open);
      assert.equal(row.outcome, 'refused');
      assert.equal(row.refusal, 'entitlementHistoryOnDuplicate');
      assert.match(row.reason ?? '', /EntitlementIncident: 1 open/);
      assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId: open.duplicateId } }), 1);
    });

    it('refuses a duplicate holding a paid renewal term — money — naming it, and changes nothing', async () => {
      const target = await pair('paid', IMPORTED);
      await assignPlan(target.duplicateId, await createPlan('paid'));
      await paidRenewalTermOn(target.duplicateId);

      const row = await merge(target);

      assert.equal(row.outcome, 'refused');
      assert.match(row.reason ?? '', /SubscriptionTerm: 1 paid/);
      assert.doesNotMatch(row.reason ?? '', /SubscriptionEffectiveProjection/, 'only money is named');
      assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId: target.duplicateId } }), 3);
      const untouched = await prisma.subscription.findUniqueOrThrow({ where: { id: target.duplicateId } });
      assert.equal(untouched.status, SubscriptionStatus.ACTIVE);
    });
  });

  describe('«Назначить план импортированным» re-plans only the import', () => {
    it('leaves every subscription bought or renewed in the panel alone, and counts each by why', async () => {
      const userId = await createUser('owner');
      const planA = await createPlan('bought');
      const target = await createPlan('bulk-target');
      const record = await prisma.importRecord.create({
        data: { filename: `${prefix}.json`, sourceType: 'remnawave', status: 'COMMITTED' },
        select: { id: true },
      });
      importRecords.push(record.id);
      const boughtSnapshot = {
        id: planA,
        name: planA,
        trafficLimit: 100,
        deviceLimit: 3,
        trafficLimitStrategy: 'NO_RESET',
        internalSquads: [],
        externalSquad: null,
        selectedDurationDays: 30,
        snapshotSource: 'PAYMENT_COMPLETION',
      };
      const importSnapshot = { importedFrom: 'remnawave', importRecordId: record.id, trafficLimitStrategy: 'NO_RESET' };
      const subscriptionWith = async (label: string, planSnapshot: Record<string, unknown> | null): Promise<string> => {
        panelSeq += 1;
        const row = await prisma.subscription.create({
          data: {
            id: `${prefix}-${label}`,
            userId,
            status: SubscriptionStatus.ACTIVE,
            ...(planSnapshot === null ? {} : { planSnapshot: planSnapshot as Prisma.InputJsonValue }),
            trafficLimit: 77,
            deviceLimit: 7,
            remnawaveId: String(panelSeq),
            expiresAt: new Date(Date.now() + 20 * DAY_MS),
          },
          select: { id: true },
        });
        return row.id;
      };
      const payFor = async (subscriptionId: string | null, purchaseType: 'NEW' | 'RENEW'): Promise<string> => {
        const row = await prisma.transaction.create({
          data: {
            paymentId: `${prefix}-pay-${next()}`,
            userId,
            subscriptionId,
            status: 'COMPLETED',
            purchaseType,
            channel: 'WEB',
            gatewayType: 'YOOKASSA',
            currency: 'RUB',
            amount: new Prisma.Decimal('199'),
            planSnapshot: { id: planA, selectedDurationDays: 30 },
            fulfilledAt: new Date(Date.now() - DAY_MS),
          },
          select: { id: true },
        });
        return row.id;
      };

      // Bought here: its snapshot names the plan under `id`, as a payment writes it.
      const bought = await subscriptionWith('bought', boughtSnapshot);
      await payFor(bought, 'NEW');
      // Bought here, then matched by a Remnawave import that MERGED its marker in.
      const stamped = await subscriptionWith('stamped', { ...boughtSnapshot, importedFrom: 'remnawave', importRecordId: record.id });
      await payFor(stamped, 'NEW');
      // Imported, never assigned — then renewed here, which kept the import snapshot.
      const renewed = await subscriptionWith('renewed', importSnapshot);
      await payFor(renewed, 'RENEW');
      // Imported, never assigned — then renewed as a line of a combined renewal.
      const combined = await subscriptionWith('combined', importSnapshot);
      const parent = await payFor(null, 'RENEW');
      await prisma.transactionItem.create({
        data: {
          transactionId: parent,
          subscriptionId: combined,
          planId: planA,
          durationDays: 30,
          amount: new Prisma.Decimal('199'),
          currency: 'RUB',
          appliedAt: new Date(Date.now() - DAY_MS),
        },
      });
      // Not an import at all, and no plan either.
      const given = await subscriptionWith('given', null);
      // The only one this assignment is for.
      const fresh = await subscriptionWith('fresh', importSnapshot);
      const before = await prisma.subscription.findMany({
        where: { id: { in: [bought, stamped, renewed, combined, given] } },
        select: { id: true, planSnapshot: true, trafficLimit: true, deviceLimit: true },
        orderBy: { id: 'asc' },
      });

      const bulk = new BulkPlanAssignmentService(prisma, { enqueue: async () => undefined } as never, realTermHooks(prisma));
      const result = await bulk.assignPlan({ planId: target, importRecordId: record.id, createdBy: `${prefix}-admin` });

      assert.deepEqual(
        {
          updated: result.updated,
          skippedAlreadyAssigned: result.skippedAlreadyAssigned,
          skippedPurchasedHere: result.skippedPurchasedHere,
          skippedNotImported: result.skippedNotImported,
          skippedNoSubscription: result.skippedNoSubscription,
          errors: result.errors,
        },
        {
          updated: 1,
          skippedAlreadyAssigned: 2,
          skippedPurchasedHere: 2,
          skippedNotImported: 1,
          skippedNoSubscription: 0,
          errors: 0,
        },
      );
      const assigned = await prisma.subscription.findUniqueOrThrow({ where: { id: fresh } });
      assert.equal((assigned.planSnapshot as Record<string, unknown>)['id'], target);
      const after = await prisma.subscription.findMany({
        where: { id: { in: [bought, stamped, renewed, combined, given] } },
        select: { id: true, planSnapshot: true, trafficLimit: true, deviceLimit: true },
        orderBy: { id: 'asc' },
      });
      assert.deepEqual(after, before, 'nothing bought or renewed here, nor anything not imported, was touched');
    });
  });

  describe('the ordinary user deletion', () => {
    it('deletes an account whose subscription an operator assigned a plan to: nothing there is money', async () => {
      const target = await pair('delete', IMPORTED);
      await assignPlan(target.duplicateId, await createPlan('delete'));

      const summary = await deletion().deleteUser(target.userId);

      assert.equal(summary.mode, 'protected');
      assert.equal(await prisma.user.count({ where: { id: target.userId } }), 0);
      assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId: target.duplicateId } }), 0);
    });

    it('refuses on money in the model and NAMES it — a paid term, an open incident — discarding nothing', async () => {
      const target = await pair('named', IMPORTED);
      await paidRenewalTermOn(target.duplicateId);
      await incidentOn(target.survivorId, EntitlementIncidentState.OPEN);

      const blockedBy = await refusedDeletion(target.userId);

      assert.equal(blockedBy['transactions'], 0);
      assert.equal(blockedBy['paidTerms'], 1);
      assert.equal(blockedBy['openIncidents'], 1);
      assert.equal(blockedBy['addOnPurchases'], 0);
      assert.equal(await prisma.user.count({ where: { id: target.userId } }), 1);
      assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId: target.duplicateId } }), 2);
      assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId: target.survivorId } }), 1);
    });
  });
});
