import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, NotFoundException } from '@nestjs/common';

import { EVENT_TYPES } from '../src/common/services/system-events.service';
import {
  PLAN_UPDATE_SOURCES,
  PlansAdminService,
} from '../src/modules/plans/services/plans-admin.service';
import { normalizeUpdatePlanInput } from '../src/modules/plans/services/plans-admin.normalizers';
import { PlansAdminValidators } from '../src/modules/plans/services/plans-admin.validators';
import type { PlanRecord } from '../src/modules/plans/utils/plan-record.util';
import { AdminUserManagementController } from '../src/modules/users/controllers/admin-user-management.controller';

/**
 * TWO OPERATOR WRITES ON THE USER CARD THAT BYPASSED THE RULES GUARDING THEM.
 *
 * ── 1. THE PLAN ALLOW-LIST HAD TWO WRITERS ───────────────────────────────────
 *
 * `Plan.allowedUserIds` decides who may buy an `availability: ALLOWED` plan
 * (`plan-catalog.service.ts` — `plan.allowedUserIds.includes(user.id)`). The
 * Plans-tab editor wrote it under `plans:edit`, inside a transaction, after
 * validating that every id names a real account, and left a `plans.updated`
 * audit row. The user card wrote the SAME COLUMN under `users:edit`, with no
 * transaction, no validation and NO AUDIT ROW — and its revoke was a
 * client-computed whole-array overwrite.
 *
 * Both halves mattered on their own. The shipped `operator` role holds
 * `users:edit` and only `plans:view` (`rbac.resources.ts`), so a role
 * DELIBERATELY denied plan editing could add or remove anybody from any
 * restricted plan; and because the only action name that records allow-list
 * movement was never written, nothing in the audit log said it had happened.
 * That pairing — the wrong permission plus the missing trail — is the same one
 * `partner-balance-surfaces.spec.ts` pins one module away, and the permission
 * half is asserted where that one asserts it, in
 * `test/admin-route-permission-gates.spec.ts`, so it survives a refactor of
 * these services.
 *
 * ── 2. THE POINTS FLOOR WAS CHECKED AGAINST A NUMBER FROM THE PAST ───────────
 *
 * `adjustPoints` read the user, computed `(user.points ?? 0) + delta` in JS,
 * refused a negative result, and then issued an UNCONDITIONAL
 * `{ points: { increment: delta } }`. `User.points` is a SHARED wallet — the
 * referral exchange spends it, quests credit it — so a subscriber spending
 * between the read and the write drove the column negative through a guard that
 * had already passed. The floor now rides in the `where` of the write itself,
 * `points >= -delta`, exactly as `spendPoints` and `applyBalanceAdjustment`
 * already spell the same invariant. It was also the only operator-facing points
 * mutation with no audit row and no system event; it now writes
 * `user.points.adjusted` and emits `user.points_adjusted`, both carrying the
 * balance before and after.
 *
 * ── WHAT THESE TESTS PROVE, AND WHAT THEY DO NOT ─────────────────────────────
 *
 * NOT SERIALISABILITY. A fake Prisma has no row locks and no snapshot
 * visibility: it cannot run two real transactions against one row, cannot show
 * the second blocking on the first's lock, and cannot show a predicate being
 * re-evaluated against the locked row. That guarantee is Postgres's, from
 * evaluating the `WHERE` of an `UPDATE` against the row it locks and holding
 * that lock until commit. What is asserted here is that the STATEMENT HANDED TO
 * THE DATABASE is the one with those properties — a relative change carrying
 * its own predicate, rather than an absolute value computed from an earlier
 * read — plus, where a test says so, that the statement still does the right
 * thing when the row changed underneath it between the caller's read and the
 * write. `interleave.beforeWrite` is how that second thing is expressed: it
 * mutates the held row at the moment the statement executes, which is a
 * faithful model of "somebody else committed in between" and NOT a model of
 * locking.
 *
 * Everything runs the REAL services and the REAL controller against a fake
 * Prisma that HOLDS ROWS, and asserts on those rows and on the arguments the
 * services handed the client. A double that only counts calls cannot tell
 * "nothing was written" from "the writer was never wired up", so each half
 * opens with a control proving this fake does record an audit row and an event
 * when one is actually written.
 *
 * Dates are relative. An absolute fixture date in this repo was live when
 * written and silently became an expired-subscription assertion months later.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const ADMIN = { id: 'admin-1' } as never;
const REQ = { headers: {}, ip: null, socket: { remoteAddress: null } } as never;

/** The customer every fixture addresses, by both identifiers that reach them. */
const SUBJECT_ID = 'cmsxo98e8006r01jgn33gtpbe';
const SUBJECT_TELEGRAM_ID = '1000';

/** Another account already on the allow-list, so a change is never the whole list. */
const BYSTANDER_ID = 'cmsxo98e8006r01jgn33gtpbf';

/** Opening points balance for every fixture. */
const OPENING_POINTS = 500;

interface UserRow {
  id: string;
  telegramId: bigint;
  name: string;
  points: number;
  createdAt: Date;
}

interface PlanRow {
  id: string;
  name: string;
  availability: string;
  allowedUserIds: string[];
}

interface EmittedEvent {
  type: string;
  category: string;
  message: string;
  metadata: unknown;
}

/** One delegate call, tagged with the transaction it ran inside (null = none). */
interface RecordedCall {
  op: string;
  tx: string | null;
}

/**
 * One write, kept WITH its arguments.
 *
 * A count of calls cannot tell a one-element membership change from a whole
 * array written back, nor a predicate that rides in the statement from one
 * checked in JS beforehand. Both are the difference between a write that
 * survives a concurrent one and a write that silently eats it, so the arguments
 * are what the tests assert on.
 */
interface RecordedWrite {
  op: string;
  where: Record<string, unknown>;
  data: Record<string, unknown>;
  tx: string | null;
}

/** One raw statement, kept with the SQL text and the bound values. */
interface RecordedRawWrite {
  sql: string;
  values: readonly unknown[];
  tx: string | null;
}

/** What a `plan` write may carry for the allow-list: relative, or the whole array. */
type PlanWriteData = {
  allowedUserIds?: string[] | { push?: string | string[]; set?: string[] };
};

/** What a `user` write may carry for the balance: relative, or an absolute total. */
type UserWriteData = {
  points?: number | { increment?: number; decrement?: number };
};

function snapshotArgs(value: object): Record<string, unknown> {
  return { ...value } as Record<string, unknown>;
}

/** Applies an allow-list write to a row the way Postgres would. */
function applyPlanData(row: PlanRow, data: PlanWriteData): void {
  const value = data.allowedUserIds;
  if (value === undefined) return;
  if (Array.isArray(value)) {
    // The whole-array overwrite. Modelled rather than rejected so that a
    // regression to it fails on the assertion that names it, with the array it
    // sent, instead of on an exception from this fake.
    row.allowedUserIds = [...value];
    return;
  }
  if (value.set !== undefined) {
    row.allowedUserIds = [...value.set];
    return;
  }
  if (value.push !== undefined) {
    row.allowedUserIds = [
      ...row.allowedUserIds,
      ...(Array.isArray(value.push) ? value.push : [value.push]),
    ];
  }
}

/** Applies a points write to a row the way Postgres would: absolute or relative. */
function applyUserData(row: UserRow, data: UserWriteData): void {
  if (typeof data.points === 'number') {
    row.points = data.points;
  } else if (data.points?.increment !== undefined) {
    row.points += data.points.increment;
  } else if (data.points?.decrement !== undefined) {
    row.points -= data.points.decrement;
  }
}

function makeUser(id: string, telegramId: bigint, points: number): UserRow {
  return {
    id,
    telegramId,
    name: id,
    points,
    createdAt: new Date(Date.now() - 90 * DAY_MS),
  };
}

function makePlan(
  id: string,
  name: string,
  availability: string,
  allowedUserIds: readonly string[],
): PlanRow {
  return { id, name, availability, allowedUserIds: [...allowedUserIds] };
}

function project(row: Record<string, unknown>, select?: Record<string, unknown>): unknown {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select)) {
    if (select[key]) out[key] = row[key];
  }
  return out;
}

/**
 * Fake Prisma holding real rows.
 *
 * `$transaction` is modelled the only way a fake honestly can: it snapshots the
 * mutable state, runs the callback, and restores the snapshot if the callback
 * throws. That is all-or-nothing and nothing more — it deliberately does NOT
 * pretend to model row locks or isolation levels.
 *
 * Every delegate call is tagged with the id of the enclosing transaction so a
 * test can assert WHICH calls shared one, instead of merely that `$transaction`
 * was mentioned.
 */
function makeDb(seed: { users?: UserRow[]; plans?: PlanRow[] }) {
  const users = [...(seed.users ?? [])];
  const plans = [...(seed.plans ?? [])];
  const auditLogs: Array<Record<string, unknown>> = [];
  const calls: RecordedCall[] = [];
  const writes: RecordedWrite[] = [];
  const rawWrites: RecordedRawWrite[] = [];
  // `guardMiss` makes a conditional write match nothing, which is the only
  // signal the database gives when its `where` refuses the row. It is how the
  // count-zero branch is reached without going through the arithmetic.
  const failures = { guardMiss: false };
  // Runs at the moment a conditional write executes — i.e. AFTER the caller has
  // done whatever reading it does and BEFORE the row is changed. That is where
  // another session's commit lands, and it is the only interleaving a fake can
  // stage honestly. See the caveat at the top of this file.
  const interleave: { beforeWrite?: () => void } = {};
  let currentTx: string | null = null;
  let txSeq = 0;

  function record(op: string): void {
    calls.push({ op, tx: currentTx });
  }

  const client = {
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> => {
      const id = `tx-${++txSeq}`;
      const outerTx = currentTx;
      currentTx = id;
      const userSnapshot = users.map((row) => ({ ...row }));
      const planSnapshot = plans.map((row) => ({ ...row, allowedUserIds: [...row.allowedUserIds] }));
      const auditLength = auditLogs.length;
      record('$transaction.begin');
      try {
        const out = await callback(client);
        record('$transaction.commit');
        return out;
      } catch (error: unknown) {
        users.splice(0, users.length, ...userSnapshot);
        plans.splice(0, plans.length, ...planSnapshot);
        auditLogs.length = auditLength;
        record('$transaction.rollback');
        throw error;
      } finally {
        currentTx = outerTx;
      }
    },
    /**
     * The revoke. Postgres applies `array_remove` to the row it locks; this
     * fake applies it to the row it holds, and refuses to guess at any other
     * statement — a shape change here should fail loudly rather than be
     * silently mis-modelled into a pass.
     */
    $executeRaw: async (
      strings: TemplateStringsArray,
      ...values: readonly unknown[]
    ): Promise<number> => {
      record('$executeRaw');
      const sql = strings.join(' ? ');
      rawWrites.push({ sql, values: [...values], tx: currentTx });
      assert.match(
        sql,
        /array_remove\(\s*"allowed_user_ids"/,
        'fake prisma: the only raw statement it models is the allow-list array_remove',
      );
      assert.match(sql, /= ANY\("allowed_user_ids"\)/, 'fake prisma: membership guard missing');
      assert.equal(values.length, 3, 'fake prisma: expected (removed, planId, guard)');
      const [removedUserId, planId, guardUserId] = values as [string, string, string];
      assert.equal(removedUserId, guardUserId, 'fake prisma: guard names a different user');
      interleave.beforeWrite?.();
      if (failures.guardMiss) return 0;
      const row = plans.find((plan) => plan.id === planId);
      if (row === undefined) return 0;
      if (!row.allowedUserIds.includes(removedUserId)) return 0;
      row.allowedUserIds = row.allowedUserIds.filter((id) => id !== removedUserId);
      return 1;
    },
    user: {
      findFirst: async (args: { where: { telegramId?: bigint } }) => {
        record('user.findFirst');
        return users.find((row) => row.telegramId === args.where.telegramId) ?? null;
      },
      findUnique: async (args: { where: { id?: string }; select?: Record<string, unknown> }) => {
        record('user.findUnique');
        const row = users.find((candidate) => candidate.id === args.where.id);
        return row ? project(row as unknown as Record<string, unknown>, args.select) : null;
      },
      findMany: async (args: {
        where: { id?: { in?: string[] } };
        select?: Record<string, unknown>;
      }) => {
        record('user.findMany');
        const wanted = args.where.id?.in ?? [];
        return users
          .filter((row) => wanted.includes(row.id))
          .map((row) => project(row as unknown as Record<string, unknown>, args.select));
      },
      /**
       * The conditional points write. Every clause of `where` — the floor
       * included — is applied as the filter that selects the rows to change, so
       * `count` is the caller's only signal, exactly as it is in Postgres.
       * There is no lock here and no isolation; see the caveat at the top.
       */
      updateMany: async (args: {
        where: { id?: string; points?: { gte?: number } };
        data: UserWriteData;
      }) => {
        record('user.updateMany');
        writes.push({
          op: 'user.updateMany',
          where: snapshotArgs(args.where),
          data: snapshotArgs(args.data),
          tx: currentTx,
        });
        interleave.beforeWrite?.();
        const matched = failures.guardMiss
          ? []
          : users.filter((row) => {
              if (args.where.id !== undefined && row.id !== args.where.id) return false;
              const floor = args.where.points?.gte;
              if (floor !== undefined && row.points < floor) return false;
              return true;
            });
        for (const row of matched) applyUserData(row, args.data);
        return { count: matched.length };
      },
    },
    plan: {
      findUnique: async (args: { where: { id?: string }; select?: Record<string, unknown> }) => {
        record('plan.findUnique');
        const row = plans.find((plan) => plan.id === args.where.id);
        if (row === undefined) return null;
        const projected = project(row as unknown as Record<string, unknown>, args.select) as
          Record<string, unknown>;
        // Arrays are copied out, so a caller that mutates what it read cannot
        // reach into the held row and make a lost update look like a success.
        if (Array.isArray(projected['allowedUserIds'])) {
          projected['allowedUserIds'] = [...(projected['allowedUserIds'] as string[])];
        }
        return projected;
      },
      /** Present so a regression to a whole-row overwrite is RECORDED, not thrown. */
      update: async (args: { where: { id: string }; data: PlanWriteData }) => {
        record('plan.update');
        writes.push({
          op: 'plan.update',
          where: snapshotArgs(args.where),
          data: snapshotArgs(args.data),
          tx: currentTx,
        });
        const row = plans.find((plan) => plan.id === args.where.id);
        if (!row) throw new Error('fake prisma: plan.update on a missing row');
        applyPlanData(row, args.data);
        return { ...row };
      },
      /** The grant. `NOT: { allowedUserIds: { has } }` is part of the filter. */
      updateMany: async (args: {
        where: { id?: string; NOT?: { allowedUserIds?: { has?: string } } };
        data: PlanWriteData;
      }) => {
        record('plan.updateMany');
        writes.push({
          op: 'plan.updateMany',
          where: snapshotArgs(args.where),
          data: snapshotArgs(args.data),
          tx: currentTx,
        });
        interleave.beforeWrite?.();
        const matched = failures.guardMiss
          ? []
          : plans.filter((row) => {
              if (args.where.id !== undefined && row.id !== args.where.id) return false;
              const absent = args.where.NOT?.allowedUserIds?.has;
              if (absent !== undefined && row.allowedUserIds.includes(absent)) return false;
              return true;
            });
        for (const row of matched) applyPlanData(row, args.data);
        return { count: matched.length };
      },
    },
    adminAuditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        record('adminAuditLog.create');
        auditLogs.push(args.data);
        return args.data;
      },
    },
  };

  const emitted: EmittedEvent[] = [];
  const events = {
    info: (type: string, category: string, message: string, metadata: unknown) =>
      emitted.push({ type, category, message, metadata }),
    warn: (type: string, category: string, message: string, metadata: unknown) =>
      emitted.push({ type, category, message, metadata }),
    error: () => undefined,
  };

  return {
    client,
    events,
    emitted,
    calls,
    writes,
    rawWrites,
    failures,
    interleave,
    state: { users, plans, auditLogs },
  };
}

function buildController(db: ReturnType<typeof makeDb>): AdminUserManagementController {
  const validators = new PlansAdminValidators(db.client as never, {} as never);
  const plansAdminService = new PlansAdminService(
    db.client as never,
    {} as never, // RemnawaveApiService
    {} as never, // PlanSnapshotSyncService
    validators,
    {} as never, // PlanSquadPropagationService
  );
  return new AdminUserManagementController(
    db.client as never,
    db.events as never,
    {} as never, // PartnerEarningsService
    {} as never, // ReferralManualAttachService
    {} as never, // ReferralQualificationService
    {} as never, // StealthnetReferralSyncService
    {} as never, // ReferralInviteLimitsService
    {} as never, // RemnawaveApiService
    {} as never, // UserNotificationsService
    {} as never, // RbacService
    {} as never, // UserDeletionService
    {} as never, // PartnersService
    plansAdminService,
    undefined as never,
    { listForUser: async () => [], clear: async () => undefined } as never, // DeviceIntelligenceService
  );
}

/** One restricted plan whose allow-list already holds the bystander. */
function seedAccess(
  options: { availability?: string; allowedUserIds?: readonly string[] } = {},
) {
  return makeDb({
    users: [
      makeUser(SUBJECT_ID, BigInt(SUBJECT_TELEGRAM_ID), OPENING_POINTS),
      makeUser(BYSTANDER_ID, 2000n, OPENING_POINTS),
    ],
    plans: [
      makePlan(
        'plan-restricted',
        'Inner Circle',
        options.availability ?? 'ALLOWED',
        options.allowedUserIds ?? [BYSTANDER_ID],
      ),
    ],
  });
}

function grant(db: ReturnType<typeof makeDb>, telegramId = SUBJECT_TELEGRAM_ID) {
  return buildController(db).grantPlanAccess(telegramId, 'plan-restricted', ADMIN, REQ);
}

function revoke(db: ReturnType<typeof makeDb>, telegramId = SUBJECT_TELEGRAM_ID) {
  return buildController(db).revokePlanAccess(telegramId, 'plan-restricted', ADMIN, REQ);
}

function adjustPoints(db: ReturnType<typeof makeDb>, delta: number) {
  return buildController(db).adjustPoints(SUBJECT_TELEGRAM_ID, { delta }, ADMIN, REQ);
}

function auditRow(db: ReturnType<typeof makeDb>, index = 0): Record<string, unknown> {
  const row = db.state.auditLogs[index];
  assert.ok(row, `expected an audit row at index ${index}`);
  return row;
}

function auditMetadata(db: ReturnType<typeof makeDb>, index = 0): Record<string, unknown> {
  return auditRow(db, index)['metadata'] as Record<string, unknown>;
}

/** The plan row as the fake holds it. */
function planRow(db: ReturnType<typeof makeDb>): PlanRow {
  const row = db.state.plans[0];
  assert.ok(row, 'expected the seeded plan to still exist');
  return row;
}

/** Every write the services sent to the `plan` delegate that touched the list. */
function allowListWrites(db: ReturnType<typeof makeDb>): RecordedWrite[] {
  return db.writes.filter((write) => 'allowedUserIds' in write.data);
}

/** Every write that touched `points`. */
function pointsWrites(db: ReturnType<typeof makeDb>): RecordedWrite[] {
  return db.writes.filter((write) => 'points' in write.data);
}

/** The one points write of an adjustment, or a failure naming what was sent instead. */
function solePointsWrite(db: ReturnType<typeof makeDb>): RecordedWrite {
  const written = pointsWrites(db);
  assert.equal(
    written.length,
    1,
    `expected exactly one points write, saw [${written.map((write) => write.op).join(', ')}]`,
  );
  return written[0]!;
}

/** The floor the write carried in its own `where`, or undefined if it carried none. */
function pointsFloor(write: RecordedWrite): number | undefined {
  const points = write.where['points'] as { gte?: number } | undefined;
  return typeof points?.gte === 'number' ? points.gte : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan allow-list
// ─────────────────────────────────────────────────────────────────────────────

describe('plan access — the fake records writes (control)', () => {
  // Without this, every "no audit row was written" assertion below could pass
  // simply because nothing in this fake is capable of recording one.
  it('a grant DOES move the row and produce an audit row through this fake', async () => {
    const db = seedAccess();

    await grant(db);

    assert.deepEqual(planRow(db).allowedUserIds, [BYSTANDER_ID, SUBJECT_ID]);
    assert.equal(db.state.auditLogs.length, 1);
    assert.equal(auditRow(db)['action'], 'plans.updated');
  });

  it('a revoke DOES move the row and produce an audit row through this fake', async () => {
    const db = seedAccess({ allowedUserIds: [BYSTANDER_ID, SUBJECT_ID] });

    await revoke(db);

    assert.deepEqual(planRow(db).allowedUserIds, [BYSTANDER_ID]);
    assert.equal(db.state.auditLogs.length, 1);
    assert.equal(auditRow(db)['action'], 'plans.updated');
  });
});

describe('the allow-list toggle leaves the trail the Plans tab leaves', () => {
  it('a grant writes one plans.updated row naming the user, the change and the source', async () => {
    const db = seedAccess();

    await grant(db);

    assert.equal(db.state.auditLogs.length, 1);
    assert.equal(auditRow(db)['action'], 'plans.updated');
    const metadata = auditMetadata(db);
    assert.equal(metadata['planId'], 'plan-restricted');
    assert.equal(metadata['name'], 'Inner Circle');
    assert.equal(metadata['source'], PLAN_UPDATE_SOURCES.USER_CARD_PLAN_ACCESS);
    assert.deepEqual(metadata['planAccess'], { userId: SUBJECT_ID, change: 'granted' });
  });

  it('a revoke writes one plans.updated row naming the user, the change and the source', async () => {
    const db = seedAccess({ allowedUserIds: [BYSTANDER_ID, SUBJECT_ID] });

    await revoke(db);

    assert.equal(db.state.auditLogs.length, 1);
    assert.equal(auditRow(db)['action'], 'plans.updated');
    const metadata = auditMetadata(db);
    assert.equal(metadata['source'], PLAN_UPDATE_SOURCES.USER_CARD_PLAN_ACCESS);
    assert.deepEqual(metadata['planAccess'], { userId: SUBJECT_ID, change: 'revoked' });
  });

  it('carries the allow-list before and after, derived from the row read back', async () => {
    const granted = seedAccess();
    await grant(granted);
    assert.deepEqual(auditMetadata(granted)['previousAllowedUserIds'], [BYSTANDER_ID]);
    assert.deepEqual(auditMetadata(granted)['newAllowedUserIds'], [BYSTANDER_ID, SUBJECT_ID]);
    assert.deepEqual(
      auditMetadata(granted)['newAllowedUserIds'],
      planRow(granted).allowedUserIds,
      'the audit row carries the list the database holds',
    );

    const revoked = seedAccess({ allowedUserIds: [BYSTANDER_ID, SUBJECT_ID] });
    await revoke(revoked);
    assert.deepEqual(auditMetadata(revoked)['newAllowedUserIds'], [BYSTANDER_ID]);
    assert.deepEqual(
      (auditMetadata(revoked)['previousAllowedUserIds'] as string[]).slice().sort(),
      [BYSTANDER_ID, SUBJECT_ID].slice().sort(),
    );
  });

  it('records the transaction that carries the write and the audit row together', async () => {
    const db = seedAccess();

    await grant(db);

    const inside = db.calls.filter((call) => call.tx !== null);
    const transactions = new Set(inside.map((call) => call.tx));
    assert.equal(transactions.size, 1, 'one transaction, not one per statement');
    assert.ok(
      inside.some((call) => call.op === 'plan.updateMany'),
      'the membership change ran inside it',
    );
    assert.ok(
      inside.some((call) => call.op === 'adminAuditLog.create'),
      'and so did the audit row — the inline code wrote neither in one',
    );
  });

  it('writes nothing and no audit row when the user is already on the list', async () => {
    const db = seedAccess({ allowedUserIds: [BYSTANDER_ID, SUBJECT_ID] });

    const body = await grant(db);

    assert.deepEqual(body, { granted: true }, 'still idempotent, as the inline code was');
    assert.deepEqual(planRow(db).allowedUserIds, [BYSTANDER_ID, SUBJECT_ID], 'no duplicate');
    assert.deepEqual(db.state.auditLogs, [], 'a write that changed no row is not a trail');
  });

  it('writes nothing and no audit row when the user is not on the list', async () => {
    const db = seedAccess();

    const body = await revoke(db);

    assert.deepEqual(body, { revoked: true });
    assert.deepEqual(planRow(db).allowedUserIds, [BYSTANDER_ID]);
    assert.deepEqual(db.state.auditLogs, []);
  });
});

/**
 * The properties that let a grant and a revoke compose instead of eating each
 * other. Every assertion here is about the STATEMENT the service hands the
 * database, or about the row that came back from it — not about isolation,
 * which no fake can demonstrate. See the caveat at the top of this file.
 */
describe('the membership change names one element, never the whole array', () => {
  it('sends a grant as a push, and puts "not already listed" in the same where', async () => {
    const db = seedAccess();

    await grant(db);

    const written = allowListWrites(db);
    assert.equal(written.length, 1, 'one write');
    assert.equal(written[0]!.op, 'plan.updateMany');
    assert.deepEqual(written[0]!.data['allowedUserIds'], { push: SUBJECT_ID });
    assert.equal(
      Array.isArray(written[0]!.data['allowedUserIds']),
      false,
      'a client-computed array is a lost update waiting for a second writer',
    );
    assert.equal(written[0]!.where['id'], 'plan-restricted');
    assert.deepEqual(written[0]!.where['NOT'], { allowedUserIds: { has: SUBJECT_ID } });
  });

  it('sends a revoke as array_remove of one id, binding no array at all', async () => {
    const db = seedAccess({ allowedUserIds: [BYSTANDER_ID, SUBJECT_ID] });

    await revoke(db);

    assert.deepEqual(
      allowListWrites(db),
      [],
      'no Prisma write carried an allow-list value — the removal is the statement',
    );
    assert.equal(db.rawWrites.length, 1);
    const raw = db.rawWrites[0]!;
    assert.match(raw.sql, /array_remove/);
    assert.deepEqual(raw.values, [SUBJECT_ID, 'plan-restricted', SUBJECT_ID]);
    assert.equal(
      raw.values.some((value) => Array.isArray(value)),
      false,
      'nothing an array-shaped value could overwrite',
    );
    assert.notEqual(raw.tx, null, 'and it ran inside the transaction');
  });

  it('never reaches for plan.update, the whole-row writer the inline code used', async () => {
    const granted = seedAccess();
    await grant(granted);
    const revoked = seedAccess({ allowedUserIds: [BYSTANDER_ID, SUBJECT_ID] });
    await revoke(revoked);

    for (const [label, db] of [
      ['grant', granted],
      ['revoke', revoked],
    ] as const) {
      assert.equal(
        db.calls.some((call) => call.op === 'plan.update'),
        false,
        `${label}: plan.update writes whichever columns the caller assembled`,
      );
    }
  });

  it('a grant landing between the read and the revoke statement is not discarded', async () => {
    // THE LOST UPDATE THIS CHANGE EXISTS FOR. The old revoke read the array,
    // filtered it here, and wrote the result back whole; anything committed in
    // between was overwritten. `beforeWrite` stages exactly that commit — it is
    // a model of another session's write landing first, NOT of locking.
    const db = seedAccess({ allowedUserIds: [BYSTANDER_ID, SUBJECT_ID] });
    const latecomer = 'cmsxo98e8006r01jgn33gtpbz';
    db.interleave.beforeWrite = () => {
      planRow(db).allowedUserIds.push(latecomer);
    };

    await revoke(db);

    assert.deepEqual(
      planRow(db).allowedUserIds,
      [BYSTANDER_ID, latecomer],
      'the revoke took its own id and left the concurrent grant standing',
    );
    assert.deepEqual(
      auditMetadata(db)['newAllowedUserIds'],
      [BYSTANDER_ID, latecomer],
      'and the audit row reports what the database actually holds',
    );
  });

  it('a revoke landing between the read and the grant statement is not undone', async () => {
    const db = seedAccess({ allowedUserIds: [BYSTANDER_ID] });
    db.interleave.beforeWrite = () => {
      const row = planRow(db);
      row.allowedUserIds = row.allowedUserIds.filter((id) => id !== BYSTANDER_ID);
    };

    await grant(db);

    assert.deepEqual(
      planRow(db).allowedUserIds,
      [SUBJECT_ID],
      'the grant added its own id and did not resurrect the concurrently removed one',
    );
  });

  it('reads nothing from the plan row inside the transaction before the write', async () => {
    // A guard evaluated in JS needs a read to evaluate against. There is none
    // before the write, so the membership test cannot live anywhere but in it.
    const db = seedAccess();

    await grant(db);

    const inside = db.calls.filter((call) => call.tx !== null).map((call) => call.op);
    const writeAt = inside.indexOf('plan.updateMany');
    assert.notEqual(writeAt, -1, 'the guarded write ran inside the transaction');
    assert.deepEqual(inside.slice(0, writeAt), ['$transaction.begin'], 'nothing is read before it');
  });
});

describe('a grant against a non-ALLOWED plan is refused, not written', () => {
  for (const availability of ['ALL', 'NEW', 'EXISTING', 'INVITED', 'TRIAL']) {
    it(`refuses ${availability} without touching the row`, async () => {
      const db = seedAccess({ availability, allowedUserIds: [] });

      await assert.rejects(() => grant(db), (error: unknown) => {
        assert.ok(error instanceof BadRequestException);
        assert.match(
          (error as Error).message,
          new RegExp(`^Plan availability is ${availability}: `),
        );
        return true;
      });

      assert.deepEqual(planRow(db).allowedUserIds, [], 'nothing written');
      assert.deepEqual(db.writes, [], 'no statement issued at all');
      assert.deepEqual(db.state.auditLogs, [], 'and no audit row');
    });
  }

  it('refuses a revoke on the same plans, for the same reason', async () => {
    const db = seedAccess({ availability: 'ALL', allowedUserIds: [SUBJECT_ID] });

    await assert.rejects(() => revoke(db), BadRequestException);

    assert.deepEqual(planRow(db).allowedUserIds, [SUBJECT_ID]);
    assert.deepEqual(db.rawWrites, []);
  });

  it('names the reason: the next Plans-tab save clears the column anyway', async () => {
    // The decision is REFUSE rather than WRITE, and this is why: the normaliser
    // the plan editor runs on every save empties `allowedUserIds` whenever the
    // availability is not ALLOWED. A grant written here would be reported as a
    // success, would gate nothing (the catalog only consults the list on the
    // ALLOWED branch), and would vanish the next time anybody edited the plan
    // for an unrelated reason. Exercised against the REAL normaliser so the
    // stated reason cannot quietly stop being true.
    const persisted = {
      name: 'Inner Circle',
      description: null,
      tag: null,
      icon: null,
      isActive: true,
      isArchived: false,
      archivedRenewMode: 'SELF_RENEW',
      type: 'BOTH',
      availability: 'ALL',
      trafficLimit: null,
      deviceLimit: 3,
      trafficLimitStrategy: 'NO_RESET',
      internalSquads: [],
      externalSquad: null,
      upgradeToPlanIds: [],
      replacementPlanIds: [],
      allowedUserIds: [SUBJECT_ID],
      trialSettings: null,
      durations: [],
      // Cast once: `PlanRecord` is the full row plus its `durations` relation,
      // and the normaliser reads only the fields spelled out above.
    } as unknown as PlanRecord;

    assert.deepEqual(
      normalizeUpdatePlanInput({}, persisted).allowedUserIds,
      [],
      'a save that changes nothing else still empties the list on a non-ALLOWED plan',
    );
    assert.deepEqual(
      normalizeUpdatePlanInput({}, { ...persisted, availability: 'ALLOWED' } as PlanRecord)
        .allowedUserIds,
      [SUBJECT_ID],
      'and keeps it on an ALLOWED one — so the refusal is about availability, not about saving',
    );
  });
});

describe('plan access — refusals and contracts are unchanged', () => {
  it('404s on an unknown plan, writing nothing', async () => {
    const db = seedAccess();

    await assert.rejects(
      () => buildController(db).grantPlanAccess(SUBJECT_TELEGRAM_ID, 'plan-nope', ADMIN, REQ),
      NotFoundException,
    );
    assert.deepEqual(db.writes, []);
    assert.deepEqual(db.state.auditLogs, []);
  });

  it('404s on an unknown user, writing nothing', async () => {
    const db = seedAccess();

    await assert.rejects(() => grant(db, '999999'), NotFoundException);
    assert.deepEqual(db.writes, []);
    assert.deepEqual(db.state.auditLogs, []);
  });

  it('refuses an id that names no account, the way the plan editor does', async () => {
    // The user card resolves the account first, so this is reachable only if the
    // row disappears underneath it — but it is the same validator the Plans tab
    // runs, and routing both through it is what "one writer" means.
    const db = seedAccess();
    const validators = new PlansAdminValidators(db.client as never, {} as never);

    await assert.rejects(
      () => validators.assertAllowedUsersExist(['cmsxo98e8006r01jgn33gtpzz']),
      (error: unknown) => {
        assert.ok(error instanceof BadRequestException);
        const body = (error as BadRequestException).getResponse() as Record<string, unknown>;
        assert.equal(body['code'], 'PLAN_ALLOWED_USERS_NOT_FOUND');
        return true;
      },
    );
  });

  it('answers both routes with the bodies they always answered with', async () => {
    const granted = seedAccess();
    assert.deepEqual(await grant(granted), { granted: true });

    const revoked = seedAccess({ allowedUserIds: [BYSTANDER_ID, SUBJECT_ID] });
    assert.deepEqual(await revoke(revoked), { revoked: true });
  });

  it('accepts a reiwa id in the same route parameter, as it always has', async () => {
    const db = seedAccess();

    await grant(db, SUBJECT_ID);

    assert.deepEqual(planRow(db).allowedUserIds, [BYSTANDER_ID, SUBJECT_ID]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Points
// ─────────────────────────────────────────────────────────────────────────────

describe('points — the fake records the write, the audit row and the event (control)', () => {
  it('an adjustment DOES produce all three through this fake', async () => {
    const db = seedAccess();

    await adjustPoints(db, 250);

    assert.equal(db.state.users[0]?.points, OPENING_POINTS + 250);
    assert.equal(db.state.auditLogs.length, 1);
    assert.equal(auditRow(db)['action'], 'user.points.adjusted');
    assert.equal(db.emitted.length, 1);
    assert.equal(db.emitted[0]?.type, EVENT_TYPES.USER_POINTS_ADJUSTED);
  });
});

describe('the points floor rides in the where of the write', () => {
  it('sends the adjustment as an increment, never as a precomputed total', async () => {
    for (const delta of [250, -250]) {
      const db = seedAccess();

      await adjustPoints(db, delta);

      const write = solePointsWrite(db);
      assert.deepEqual(
        write.data['points'],
        { increment: delta },
        `the database is told the delta ${delta} and computes the total itself`,
      );
      assert.notEqual(
        typeof write.data['points'],
        'number',
        'an absolute total is a lost update waiting for a second writer',
      );
      assert.equal(db.state.users[0]?.points, OPENING_POINTS + delta);
    }
  });

  it('carries points >= -delta in the where of that same statement', async () => {
    const db = seedAccess();

    await adjustPoints(db, -250);

    const write = solePointsWrite(db);
    assert.equal(write.op, 'user.updateMany');
    assert.equal(write.where['id'], SUBJECT_ID);
    assert.deepEqual(
      write.where['points'],
      { gte: 250 },
      'and refuses it unless the row still holds what is being taken',
    );
  });

  it('reads nothing from the user row before that write inside the transaction', async () => {
    // A guard evaluated in JS needs a read to evaluate against. The route
    // resolves the account BEFORE the transaction; inside it, nothing is read
    // before the write, so the floor cannot live anywhere but in the write.
    const db = seedAccess();

    await adjustPoints(db, -250);

    const inside = db.calls.filter((call) => call.tx !== null).map((call) => call.op);
    const writeAt = inside.indexOf('user.updateMany');
    assert.notEqual(writeAt, -1, 'the guarded write ran inside the transaction');
    assert.deepEqual(inside.slice(0, writeAt), ['$transaction.begin'], 'nothing is read before it');
  });

  it('never blocks a credit: the floor for a positive delta is negative', async () => {
    const db = makeDb({ users: [makeUser(SUBJECT_ID, BigInt(SUBJECT_TELEGRAM_ID), 0)] });

    await adjustPoints(db, 250);

    const floor = pointsFloor(solePointsWrite(db));
    assert.equal(floor, -250, 'the predicate is points >= -delta');
    assert.ok(floor !== undefined && floor <= 0, 'a floor no non-negative balance can fail');
    assert.equal(db.state.users[0]?.points, 250, 'an empty balance still takes a credit');
    assert.equal(auditMetadata(db)['previousPoints'], 0);
    assert.equal(auditMetadata(db)['newPoints'], 250);
  });

  it('allows a debit that lands exactly on zero', async () => {
    // The boundary is pinned as found: it was `newPoints < 0` evaluated in JS,
    // it is now `points >= -delta` evaluated by the database, and both allow
    // landing exactly on zero. `gte`, not `gt` — the whole balance may be taken,
    // one point more may not.
    const db = seedAccess();

    await adjustPoints(db, -OPENING_POINTS);

    assert.equal(db.state.users[0]?.points, 0);
    assert.equal(pointsFloor(solePointsWrite(db)), OPENING_POINTS);
    assert.equal(auditMetadata(db)['newPoints'], 0);
  });

  it('refuses a debit below zero, leaving the balance, the log and the stream alone', async () => {
    const db = seedAccess();

    await assert.rejects(() => adjustPoints(db, -(OPENING_POINTS + 1)), (error: unknown) => {
      assert.ok(error instanceof BadRequestException);
      assert.equal(
        (error as Error).message,
        'Resulting points would be below zero. Cannot go below zero.',
      );
      return true;
    });

    assert.equal(db.state.users[0]?.points, OPENING_POINTS, 'the balance must not move');
    assert.deepEqual(db.state.auditLogs, [], 'a refused adjustment leaves no audit row');
    assert.deepEqual(db.emitted, [], 'and emits no system event');
    assert.equal(
      pointsFloor(solePointsWrite(db)),
      OPENING_POINTS + 1,
      'the write asked the row to hold more than it does, and so matched nothing',
    );
  });

  it('refuses a write that matched no row, with no audit row and no event', async () => {
    // Zero rows is the only thing the database says when its `where` refuses.
    // Forced here so the translation into the refusal is tested on its own, with
    // a delta the arithmetic would happily allow.
    const db = seedAccess();
    db.failures.guardMiss = true;

    await assert.rejects(() => adjustPoints(db, -1), (error: unknown) => {
      assert.ok(error instanceof BadRequestException);
      assert.equal(
        (error as Error).message,
        'Resulting points would be below zero. Cannot go below zero.',
      );
      return true;
    });

    assert.equal(db.state.users[0]?.points, OPENING_POINTS);
    assert.deepEqual(db.state.auditLogs, []);
    assert.deepEqual(db.emitted, []);
  });

  it('a debit that lands after somebody else has spent the balance is refused', async () => {
    // THE FAILURE THE JS PRE-CHECK COULD NOT SEE. `-250` is affordable against
    // the 500 this route would have read; by the time the statement reaches the
    // row it holds 10, and the predicate travelling WITH the statement refuses
    // it. The old code checked 500, passed, and then issued an unconditional
    // increment that took the column to -240.
    //
    // Staged by moving the row at the moment the statement executes — a model
    // of another session's commit landing first, NOT of locking. What the fake
    // CANNOT show is where the row ends up afterwards: its `$transaction`
    // restores the snapshot it took on entry, so the interleaved write is rolled
    // back with everything else. Real Postgres would leave the other session's
    // 10 standing, because it was never part of this transaction. The refusal,
    // the floor the statement carried, and the absence of any trail are the
    // parts this fake can speak to.
    const db = seedAccess();
    db.interleave.beforeWrite = () => {
      const row = db.state.users[0];
      assert.ok(row);
      row.points = 10;
    };

    await assert.rejects(() => adjustPoints(db, -250), (error: unknown) => {
      assert.ok(error instanceof BadRequestException);
      assert.equal(
        (error as Error).message,
        'Resulting points would be below zero. Cannot go below zero.',
      );
      return true;
    });

    assert.equal(
      pointsFloor(solePointsWrite(db)),
      250,
      'the statement demanded 250 of a row that had 10 left, and matched nothing',
    );
    assert.deepEqual(db.state.auditLogs, [], 'no audit row for a debit that never happened');
    assert.deepEqual(db.emitted, [], 'and no system event');
  });
});

describe('the points adjustment leaves a trail', () => {
  it('writes one user.points.adjusted row carrying the balance before and after', async () => {
    const db = seedAccess();

    await adjustPoints(db, -250);

    assert.equal(db.state.auditLogs.length, 1);
    assert.equal(auditRow(db)['action'], 'user.points.adjusted');
    const metadata = auditMetadata(db);
    assert.equal(metadata['userId'], SUBJECT_ID);
    assert.equal(metadata['adjustment'], -250);
    assert.equal(metadata['previousPoints'], OPENING_POINTS);
    assert.equal(metadata['newPoints'], OPENING_POINTS - 250);
  });

  it('emits one user.points_adjusted event carrying the same figures', async () => {
    const db = seedAccess();

    await adjustPoints(db, -250);

    assert.deepEqual(db.emitted, [
      {
        type: EVENT_TYPES.USER_POINTS_ADJUSTED,
        category: 'USER',
        message: 'User points adjusted by -250',
        metadata: {
          userId: SUBJECT_ID,
          telegramId: SUBJECT_TELEGRAM_ID,
          adjustment: -250,
          previousPoints: OPENING_POINTS,
          newPoints: OPENING_POINTS - 250,
          adminId: 'admin-1',
        },
      },
    ]);
  });

  it('carries the write and the audit row in one transaction', async () => {
    const db = seedAccess();

    await adjustPoints(db, 250);

    const inside = db.calls.filter((call) => call.tx !== null);
    assert.equal(new Set(inside.map((call) => call.tx)).size, 1);
    assert.ok(inside.some((call) => call.op === 'user.updateMany'));
    assert.ok(inside.some((call) => call.op === 'adminAuditLog.create'));
  });

  it('reports the balance read back after the write, and derives previous from it', async () => {
    const db = seedAccess();

    await adjustPoints(db, -250);

    const stored = db.state.users[0]?.points;
    assert.equal(stored, OPENING_POINTS - 250);
    for (const [carrier, metadata] of [
      ['audit row', auditMetadata(db)],
      ['system event', db.emitted[0]?.metadata as Record<string, unknown>],
    ] as const) {
      assert.equal(
        metadata['newPoints'],
        stored,
        `the ${carrier} carries the balance the database holds`,
      );
      assert.equal(
        metadata['newPoints'],
        (metadata['previousPoints'] as number) + (metadata['adjustment'] as number),
        `the ${carrier}'s previous figure is this adjustment's own, by construction`,
      );
    }
  });

  it('sends only its own delta on a second adjustment, so the two sum', async () => {
    const db = seedAccess();

    await adjustPoints(db, 250);
    await adjustPoints(db, -100);

    assert.deepEqual(
      pointsWrites(db).map((write) => write.data['points']),
      [{ increment: 250 }, { increment: -100 }],
      'neither write carries the total the other left behind',
    );
    assert.equal(db.state.users[0]?.points, OPENING_POINTS + 150);
    assert.equal(auditMetadata(db, 0)['newPoints'], OPENING_POINTS + 250);
    assert.equal(auditMetadata(db, 1)['previousPoints'], OPENING_POINTS + 250);
    assert.equal(auditMetadata(db, 1)['newPoints'], OPENING_POINTS + 150);
  });

  it('still answers with the bare { points } body the panel reads', async () => {
    const db = seedAccess();

    const body = (await adjustPoints(db, 250)) as unknown as Record<string, unknown>;

    assert.deepEqual(Object.keys(body), ['points']);
    assert.equal(body['points'], OPENING_POINTS + 250);
  });

  it('404s on an unknown user without writing or emitting anything', async () => {
    const db = seedAccess();

    await assert.rejects(
      () => buildController(db).adjustPoints('999999', { delta: 250 }, ADMIN, REQ),
      NotFoundException,
    );
    assert.deepEqual(db.writes, []);
    assert.deepEqual(db.state.auditLogs, []);
    assert.deepEqual(db.emitted, []);
  });
});
