import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, NotFoundException } from '@nestjs/common';

import { AdminPartnersController } from '../src/modules/partners/controllers/admin-partners.controller';
import { PartnersService } from '../src/modules/partners/services/partners.service';

/**
 * Partner withdrawals: the debit that opens one, and the transition that
 * closes one. Both are money, and both used to decide with a value read
 * earlier in the same transaction.
 *
 * `createWithdrawalRequest` debits the partner immediately (the altshop
 * pattern: the money leaves at request time and comes back only on rejection).
 * Its write was already relative — `{ balance: { decrement: amount } }` — but
 * the sufficiency guard was `if (partner.balance < input.amount)` evaluated in
 * JS against a `findUnique` taken a few lines earlier. A relative write cannot
 * lose an update, but it also cannot refuse one: two requests that both read
 * 10 000 and both ask for 10 000 both pass the JS check, and Postgres happily
 * applies both decrements in lock order, leaving -10 000. The floor now travels
 * in the `where` of that same statement — `balance >= amount` — so the row the
 * database locks is the row the predicate is evaluated against.
 *
 * `processWithdrawalWithBalanceMutation` (behind `approveWithdrawal` and
 * `rejectWithdrawal`) had the same shape one level up: it read the withdrawal,
 * checked `status === PENDING` in JS, then moved money and only then wrote the
 * new status. Two approvals of one withdrawal both saw PENDING, so
 * `totalWithdrawn` was incremented twice for a single payout; two rejections
 * credited the balance twice, minting money that was only ever debited once.
 * The status transition is now the conditional write itself —
 * `updateMany({ where: { id, status: PENDING }, data: { status: next, ... } })`
 * — and `count === 0` is the refusal, meaning somebody else already moved it.
 *
 * ── What these tests prove, and what they cannot ─────────────────────────────
 *
 * They prove the SHAPE of the statement handed to the database: that the
 * sufficiency floor and the from-status ride in the `where` of the very write
 * that performs the debit and the transition, that nothing is read from the
 * guarded row before that write inside the transaction, that a zero row count
 * becomes the existing refusal, and that a refusal leaves no withdrawal row,
 * no audit row, no event and no moved money behind.
 *
 * They do NOT prove SERIALISABILITY, and no test name below claims to. A fake
 * Prisma has no row locks and no snapshot visibility: it cannot run two real
 * transactions against one row, cannot show the second blocking on the first's
 * lock, and cannot show a predicate being re-evaluated against a locked row.
 * That guarantee is Postgres': it evaluates the `WHERE` of an `UPDATE` against
 * the row it locks and holds the lock until commit. All that is asserted here
 * is that the statement we hand it is the one with those properties. Same
 * caveat, same reasoning as `partner-balance-surfaces.spec.ts`, which pins the
 * matching guard on `applyBalanceAdjustment`.
 *
 * This is a sibling of that file rather than an extension of it because the
 * two pin different acts through different surfaces: that file is about ONE
 * adjustment reached from two operator screens and needs the user-detail
 * controller, this one is about TWO withdrawal statements and needs a
 * `partnerWithdrawal` delegate that file has no use for. Keeping them apart
 * keeps each header honest about what its own tests cover.
 *
 * `createWithdrawalRequest` is driven through `PartnersService` directly. The
 * only caller in front of it is the internal (bot/miniapp) controller, which
 * resolves a telegram id and applies an invited-only gate — neither touches
 * the debit, which is the service's own boundary. Approval and rejection are
 * driven through `AdminPartnersController`, which is where an operator's
 * double-click actually arrives.
 *
 * Everything runs the REAL service against a fake Prisma that holds rows and
 * is asserted on rows. A double that only counts calls cannot tell "nothing
 * was written" from "the writer was never wired up", so the first describe is
 * a control proving this fake does record withdrawal rows, audit rows and
 * events when they are actually written — and the refusal tests re-prove it on
 * the very same fake instance that just recorded zero.
 *
 * Dates are relative. An absolute fixture date in this repo was live when
 * written and silently became an expired-subscription assertion months later.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const NULL_NOTIFICATIONS = {
  notifyEarning: async () => undefined,
  notifyWithdrawalApproved: async () => undefined,
  notifyWithdrawalRejected: async () => undefined,
};

const ADMIN = { id: 'admin-1' } as never;
const REQ = { headers: {}, ip: null, socket: { remoteAddress: null } } as never;

/** Starting balance for every fixture, in minor units. */
const OPENING_BALANCE = 10_000;

/** The payout coordinates every fixture request carries. */
const METHOD = 'card';
const REQUISITES = '4111111111111111';

interface UserRow {
  id: string;
  telegramId: bigint;
  name: string;
  username: string;
  createdAt: Date;
}

interface PartnerRow {
  id: string;
  userId: string;
  balance: number;
  totalEarned: number;
  totalWithdrawn: number;
  isActive: boolean;
  useGlobalSettings: boolean;
  accrualStrategy: string;
  rewardType: string;
  level1Percent: null;
  level2Percent: null;
  level3Percent: null;
  level1FixedAmount: null;
  level2FixedAmount: null;
  level3FixedAmount: null;
  createdAt: Date;
  updatedAt: Date;
}

interface WithdrawalRow {
  id: string;
  partnerId: string;
  amount: number;
  status: string;
  method: string;
  requisites: string;
  adminComment: string | null;
  processedBy: string | null;
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
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
 * One write sent to a delegate, kept WITH its arguments.
 *
 * A count of calls cannot tell a guard that rides in the statement from one
 * checked in JS beforehand, nor an increment from a precomputed total. Those
 * are exactly the difference between a debit that refuses a concurrent twin
 * and one that silently goes negative, so the arguments are what is asserted.
 */
interface RecordedWrite {
  op: string;
  where: Record<string, unknown>;
  data: Record<string, unknown>;
  tx: string | null;
}

type NumericWrite = number | { increment?: number; decrement?: number };

type PartnerWriteData = {
  balance?: NumericWrite;
  totalWithdrawn?: NumericWrite;
  totalEarned?: NumericWrite;
  isActive?: boolean;
};

type WithdrawalWriteData = {
  status?: string;
  adminComment?: string | null;
  processedBy?: string | null;
  processedAt?: Date | null;
};

type PartnerWhere = {
  id?: string;
  userId?: string;
  isActive?: boolean;
  balance?: { gte?: number };
};

type WithdrawalWhere = {
  id?: string;
  status?: string;
};

function snapshotArgs(value: object | undefined): Record<string, unknown> {
  return { ...(value ?? {}) } as Record<string, unknown>;
}

/** Applies one numeric field the way Postgres would: absolute or relative. */
function applyNumeric(current: number, value: NumericWrite): number {
  if (typeof value === 'number') return value;
  if (value.increment !== undefined) return current + value.increment;
  if (value.decrement !== undefined) return current - value.decrement;
  return current;
}

function applyPartnerData(row: PartnerRow, data: PartnerWriteData): void {
  if (data.balance !== undefined) row.balance = applyNumeric(row.balance, data.balance);
  if (data.totalWithdrawn !== undefined) {
    row.totalWithdrawn = applyNumeric(row.totalWithdrawn, data.totalWithdrawn);
  }
  if (data.totalEarned !== undefined) {
    row.totalEarned = applyNumeric(row.totalEarned, data.totalEarned);
  }
  if (data.isActive !== undefined) row.isActive = data.isActive;
  row.updatedAt = new Date();
}

/**
 * Only the keys actually present in `data` are written — the way Prisma leaves
 * a column alone when its key is absent. "Keep whatever comment is already
 * there" is expressed by omitting the key, so the fake has to honour that.
 */
function applyWithdrawalData(row: WithdrawalRow, data: WithdrawalWriteData): void {
  if (data.status !== undefined) row.status = data.status;
  if (data.adminComment !== undefined) row.adminComment = data.adminComment;
  if (data.processedBy !== undefined) row.processedBy = data.processedBy;
  if (data.processedAt !== undefined) row.processedAt = data.processedAt;
  row.updatedAt = new Date();
}

function partnerMatches(row: PartnerRow, where: PartnerWhere): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.userId !== undefined && row.userId !== where.userId) return false;
  if (where.isActive !== undefined && row.isActive !== where.isActive) return false;
  const floor = where.balance?.gte;
  if (floor !== undefined && row.balance < floor) return false;
  return true;
}

function withdrawalMatches(row: WithdrawalRow, where: WithdrawalWhere): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.status !== undefined && row.status !== where.status) return false;
  return true;
}

function makeUser(id: string, telegramId: bigint): UserRow {
  return {
    id,
    telegramId,
    name: id,
    username: id,
    createdAt: new Date(Date.now() - 90 * DAY_MS),
  };
}

function makePartnerRow(
  id: string,
  userId: string,
  balance: number,
  isActive = true,
): PartnerRow {
  const bornAt = new Date(Date.now() - 60 * DAY_MS);
  return {
    id,
    userId,
    balance,
    totalEarned: 0,
    totalWithdrawn: 0,
    isActive,
    useGlobalSettings: true,
    accrualStrategy: 'ON_EACH_PAYMENT',
    rewardType: 'PERCENT',
    level1Percent: null,
    level2Percent: null,
    level3Percent: null,
    level1FixedAmount: null,
    level2FixedAmount: null,
    level3FixedAmount: null,
    createdAt: bornAt,
    updatedAt: bornAt,
  };
}

function makeWithdrawalRow(
  id: string,
  partnerId: string,
  amount: number,
  status = 'PENDING',
  adminComment: string | null = null,
): WithdrawalRow {
  const bornAt = new Date(Date.now() - 2 * DAY_MS);
  return {
    id,
    partnerId,
    amount,
    status,
    method: METHOD,
    requisites: REQUISITES,
    adminComment,
    processedBy: null,
    processedAt: null,
    createdAt: bornAt,
    updatedAt: bornAt,
  };
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
 * test can assert WHICH calls shared one and in what order, rather than merely
 * that `$transaction` was mentioned.
 */
function makeDb(seedRows: {
  users?: UserRow[];
  partners?: PartnerRow[];
  withdrawals?: WithdrawalRow[];
}) {
  const users = [...(seedRows.users ?? [])];
  const partners = [...(seedRows.partners ?? [])];
  const withdrawals = [...(seedRows.withdrawals ?? [])];
  const auditLogs: Array<Record<string, unknown>> = [];
  const calls: RecordedCall[] = [];
  const writes: RecordedWrite[] = [];
  // `guardMiss` makes a conditional write match nothing, which is the only
  // signal the database gives when its `where` refuses the row. It is how the
  // count-zero branch is reached without going through the arithmetic.
  const failures = {
    auditWrite: false,
    partnerGuardMiss: false,
    withdrawalGuardMiss: false,
  };
  let currentTx: string | null = null;
  let txSeq = 0;
  let idSeq = 0;

  function record(op: string): void {
    calls.push({ op, tx: currentTx });
  }

  function decoratePartner(
    row: PartnerRow,
    args: { include?: Record<string, unknown>; select?: Record<string, unknown> },
  ): unknown {
    if (args.select) return project(row as unknown as Record<string, unknown>, args.select);
    const base: Record<string, unknown> = { ...row };
    if (args.include?.['user']) {
      const user = users.find((u) => u.id === row.userId);
      base['user'] = user
        ? {
            id: user.id,
            name: user.name,
            username: user.username,
            telegramId: user.telegramId,
            createdAt: user.createdAt,
          }
        : null;
    }
    if (args.include?.['_count']) {
      base['_count'] = { referrals: 0 };
    }
    return base;
  }

  function decorateWithdrawal(
    row: WithdrawalRow,
    args: { include?: Record<string, unknown>; select?: Record<string, unknown> },
  ): unknown {
    if (args.select) return project(row as unknown as Record<string, unknown>, args.select);
    const base: Record<string, unknown> = { ...row };
    if (args.include?.['partner']) {
      const partner = partners.find((p) => p.id === row.partnerId);
      const user = partner ? users.find((u) => u.id === partner.userId) : undefined;
      base['partner'] = partner
        ? {
            id: partner.id,
            isActive: partner.isActive,
            user: user
              ? {
                  id: user.id,
                  name: user.name,
                  username: user.username,
                  telegramId: user.telegramId,
                }
              : null,
          }
        : null;
    }
    return base;
  }

  const client = {
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> => {
      const id = `tx-${++txSeq}`;
      const outerTx = currentTx;
      currentTx = id;
      const partnerSnapshot = partners.map((p) => ({ ...p }));
      const withdrawalSnapshot = withdrawals.map((w) => ({ ...w }));
      const auditLength = auditLogs.length;
      record('$transaction.begin');
      try {
        const out = await callback(client);
        record('$transaction.commit');
        return out;
      } catch (error: unknown) {
        partners.splice(0, partners.length, ...partnerSnapshot);
        withdrawals.splice(0, withdrawals.length, ...withdrawalSnapshot);
        auditLogs.length = auditLength;
        record('$transaction.rollback');
        throw error;
      } finally {
        currentTx = outerTx;
      }
    },
    user: {
      findUnique: async (args: { where: { id?: string } }) => {
        record('user.findUnique');
        return users.find((u) => u.id === args.where.id) ?? null;
      },
    },
    partner: {
      findUnique: async (args: {
        where: PartnerWhere;
        include?: Record<string, unknown>;
        select?: Record<string, unknown>;
      }) => {
        record('partner.findUnique');
        const row = partners.find((p) =>
          args.where.id !== undefined ? p.id === args.where.id : p.userId === args.where.userId,
        );
        return row ? decoratePartner(row, args) : null;
      },
      update: async (args: {
        where: { id: string };
        data: PartnerWriteData;
        include?: Record<string, unknown>;
        select?: Record<string, unknown>;
      }) => {
        record('partner.update');
        writes.push({
          op: 'partner.update',
          where: snapshotArgs(args.where),
          data: snapshotArgs(args.data),
          tx: currentTx,
        });
        const row = partners.find((p) => p.id === args.where.id);
        if (!row) throw new Error('fake prisma: partner.update on a missing row');
        applyPartnerData(row, args.data);
        return decoratePartner(row, args);
      },
      /**
       * The conditional write. Every clause of `where` — the sufficiency floor
       * and the active flag included — is applied as the filter that selects
       * the rows to change, so `count` is the caller's only signal, exactly as
       * it is in Postgres. There is no lock here and no isolation; see the
       * caveat at the top.
       */
      updateMany: async (args: { where: PartnerWhere; data: PartnerWriteData }) => {
        record('partner.updateMany');
        writes.push({
          op: 'partner.updateMany',
          where: snapshotArgs(args.where),
          data: snapshotArgs(args.data),
          tx: currentTx,
        });
        const matched = failures.partnerGuardMiss
          ? []
          : partners.filter((row) => partnerMatches(row, args.where));
        for (const row of matched) applyPartnerData(row, args.data);
        return { count: matched.length };
      },
    },
    partnerWithdrawal: {
      findUnique: async (args: {
        where: WithdrawalWhere;
        include?: Record<string, unknown>;
        select?: Record<string, unknown>;
      }) => {
        record('partnerWithdrawal.findUnique');
        const row = withdrawals.find((w) => w.id === args.where.id);
        return row ? decorateWithdrawal(row, args) : null;
      },
      create: async (args: {
        data: {
          partnerId: string;
          amount: number;
          status: string;
          method: string;
          requisites: string;
        };
        include?: Record<string, unknown>;
      }) => {
        record('partnerWithdrawal.create');
        writes.push({
          op: 'partnerWithdrawal.create',
          where: {},
          data: snapshotArgs(args.data),
          tx: currentTx,
        });
        const now = new Date();
        const row: WithdrawalRow = {
          id: `w-new-${++idSeq}`,
          partnerId: args.data.partnerId,
          amount: args.data.amount,
          status: args.data.status,
          method: args.data.method,
          requisites: args.data.requisites,
          adminComment: null,
          processedBy: null,
          processedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        withdrawals.push(row);
        return decorateWithdrawal(row, args);
      },
      update: async (args: {
        where: { id: string };
        data: WithdrawalWriteData;
        include?: Record<string, unknown>;
      }) => {
        record('partnerWithdrawal.update');
        writes.push({
          op: 'partnerWithdrawal.update',
          where: snapshotArgs(args.where),
          data: snapshotArgs(args.data),
          tx: currentTx,
        });
        const row = withdrawals.find((w) => w.id === args.where.id);
        if (!row) throw new Error('fake prisma: partnerWithdrawal.update on a missing row');
        applyWithdrawalData(row, args.data);
        return decorateWithdrawal(row, args);
      },
      /** The conditional status transition; see `partner.updateMany` above. */
      updateMany: async (args: { where: WithdrawalWhere; data: WithdrawalWriteData }) => {
        record('partnerWithdrawal.updateMany');
        writes.push({
          op: 'partnerWithdrawal.updateMany',
          where: snapshotArgs(args.where),
          data: snapshotArgs(args.data),
          tx: currentTx,
        });
        const matched = failures.withdrawalGuardMiss
          ? []
          : withdrawals.filter((row) => withdrawalMatches(row, args.where));
        for (const row of matched) applyWithdrawalData(row, args.data);
        return { count: matched.length };
      },
    },
    adminAuditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        record('adminAuditLog.create');
        if (failures.auditWrite) throw new Error('fake prisma: audit write refused');
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
    failures,
    state: { users, partners, withdrawals, auditLogs },
  };
}

type Db = ReturnType<typeof makeDb>;

function buildService(db: Db): PartnersService {
  return new PartnersService(db.client as never, db.events as never, NULL_NOTIFICATIONS as never);
}

function buildAdminTab(db: Db): AdminPartnersController {
  return new AdminPartnersController(buildService(db), {} as never, {} as never, {} as never);
}

/** One active partner `p1` holding {@link OPENING_BALANCE}, plus any withdrawals. */
function seed(
  options: { balance?: number; isActive?: boolean; withdrawals?: WithdrawalRow[] } = {},
) {
  return makeDb({
    users: [makeUser('u-partner', 1000n)],
    partners: [
      makePartnerRow(
        'p1',
        'u-partner',
        options.balance ?? OPENING_BALANCE,
        options.isActive ?? true,
      ),
    ],
    withdrawals: options.withdrawals ?? [],
  });
}

/** A partner with one PENDING withdrawal `w1` — the shape an operator approves. */
function seedPending(amount: number, balance = OPENING_BALANCE) {
  return seed({ balance, withdrawals: [makeWithdrawalRow('w1', 'p1', amount)] });
}

function requestWithdrawal(db: Db, amount: number, partnerId = 'p1') {
  return buildService(db).createWithdrawalRequest({
    partnerId,
    amount,
    method: METHOD,
    requisites: REQUISITES,
  });
}

function approve(db: Db, withdrawalId = 'w1', adminComment?: string) {
  return buildAdminTab(db).approve(withdrawalId, { adminComment }, ADMIN, REQ);
}

function reject(db: Db, withdrawalId = 'w1', adminComment?: string) {
  return buildAdminTab(db).reject(withdrawalId, { adminComment }, ADMIN, REQ);
}

function bulkApprove(db: Db, withdrawalIds: string[], adminComment?: string) {
  return buildAdminTab(db).bulkApproveWithdrawals({ withdrawalIds, adminComment }, ADMIN, REQ);
}

function partnerRow(db: Db): PartnerRow {
  const row = db.state.partners[0];
  assert.ok(row, 'expected the seeded partner row');
  return row;
}

function withdrawalRow(db: Db, id = 'w1'): WithdrawalRow {
  const row = db.state.withdrawals.find((w) => w.id === id);
  assert.ok(row, `expected a withdrawal row ${id}`);
  return row;
}

/** Every write that touched the partner's balance, with its arguments. */
function balanceWrites(db: Db): RecordedWrite[] {
  return db.writes.filter((write) => 'balance' in write.data);
}

/** Every write that touched `totalWithdrawn`, with its arguments. */
function totalWithdrawnWrites(db: Db): RecordedWrite[] {
  return db.writes.filter((write) => 'totalWithdrawn' in write.data);
}

/** Every write that moved an existing withdrawal's status, with its arguments. */
function statusWrites(db: Db): RecordedWrite[] {
  return db.writes.filter(
    (write) => 'status' in write.data && write.op !== 'partnerWithdrawal.create',
  );
}

function soleWrite(writes: RecordedWrite[], label: string): RecordedWrite {
  assert.equal(
    writes.length,
    1,
    `expected exactly one ${label}, saw [${writes.map((w) => w.op).join(', ')}]`,
  );
  return writes[0];
}

/** The delegate calls that ran inside a transaction, in order. */
function insideTx(db: Db): string[] {
  return db.calls.filter((call) => call.tx !== null).map((call) => call.op);
}

function auditRow(db: Db, index = 0): Record<string, unknown> {
  const row = db.state.auditLogs[index];
  assert.ok(row, `expected an audit row at index ${index}`);
  return row;
}

function expectRefusal(message: string) {
  return (error: unknown): true => {
    assert.ok(
      error instanceof BadRequestException,
      `expected BadRequestException, got ${String(error)}`,
    );
    assert.equal((error as Error).message, message);
    return true;
  };
}

function expectNotFound(message: string) {
  return (error: unknown): true => {
    assert.ok(
      error instanceof NotFoundException,
      `expected NotFoundException, got ${String(error)}`,
    );
    assert.equal((error as Error).message, message);
    return true;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Control: the fake can record, so every zero below is a real zero
// ─────────────────────────────────────────────────────────────────────────────

describe('partner withdrawals — the fake records rows (control)', () => {
  it('a legal request DOES create a withdrawal row, move the balance and emit an event', async () => {
    const db = seed();

    const body = await requestWithdrawal(db, 2_500);

    assert.equal(db.state.withdrawals.length, 1);
    assert.equal(db.state.withdrawals[0]?.status, 'PENDING');
    assert.equal(db.state.withdrawals[0]?.amount, 2_500);
    assert.equal(partnerRow(db).balance, OPENING_BALANCE - 2_500);
    assert.equal(body.status, 'PENDING');
    assert.equal(body.partnerId, 'p1');
    assert.deepEqual(
      db.emitted.map((e) => e.type),
      ['partner.withdrawal_requested'],
    );
  });

  it('a legal approval DOES write an audit row and emit an event through this fake', async () => {
    const db = seedPending(2_500);

    await approve(db);

    assert.equal(db.state.auditLogs.length, 1);
    assert.equal(auditRow(db)['action'], 'partner.withdrawal.approved');
    assert.deepEqual(
      db.emitted.map((e) => e.type),
      ['partner.withdrawal_approved'],
    );
    assert.equal(withdrawalRow(db).status, 'COMPLETED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  A — createWithdrawalRequest: observable behaviour, pinned as found
// ─────────────────────────────────────────────────────────────────────────────

describe('a withdrawal request debits the balance (pinned, not changed)', () => {
  it('a request for exactly the available balance succeeds and lands on zero', async () => {
    const db = seed();

    const body = await requestWithdrawal(db, OPENING_BALANCE);

    assert.equal(partnerRow(db).balance, 0, 'the whole balance may be taken');
    assert.equal(db.state.withdrawals.length, 1);
    assert.equal(withdrawalRow(db, 'w-new-1').amount, OPENING_BALANCE);
    assert.equal(withdrawalRow(db, 'w-new-1').status, 'PENDING');
    assert.equal(body.amount, OPENING_BALANCE);
  });

  it('a request for one minor unit more than the balance is refused, and writes nothing', async () => {
    const db = seed();

    await assert.rejects(
      () => requestWithdrawal(db, OPENING_BALANCE + 1),
      expectRefusal('Insufficient partner balance'),
    );

    assert.equal(partnerRow(db).balance, OPENING_BALANCE, 'the balance must not move');
    assert.deepEqual(db.state.withdrawals, [], 'and no withdrawal row may be left behind');
    assert.deepEqual(db.emitted, [], 'and no system event is emitted');

    // The zero above is a real zero: the SAME fake instance records a row when
    // one is actually written.
    await requestWithdrawal(db, 1);
    assert.equal(db.state.withdrawals.length, 1, 'this fake does record withdrawal rows');
    assert.equal(partnerRow(db).balance, OPENING_BALANCE - 1);
  });

  it('a request against an unknown partner is a 404 and writes nothing', async () => {
    const db = seed();

    await assert.rejects(
      () => requestWithdrawal(db, 100, 'nope'),
      expectNotFound('Partner not found'),
    );

    assert.deepEqual(db.state.withdrawals, []);
    assert.equal(partnerRow(db).balance, OPENING_BALANCE);
    assert.deepEqual(db.emitted, []);
  });

  it('a request from an inactive partner is refused before the balance is considered', async () => {
    const db = seed({ isActive: false });

    await assert.rejects(
      () => requestWithdrawal(db, 100),
      expectRefusal('Partner is not active'),
    );

    assert.equal(partnerRow(db).balance, OPENING_BALANCE);
    assert.deepEqual(db.state.withdrawals, []);
  });

  it('an inactive partner short of the amount is still told it is inactive', async () => {
    // The two refusals are ordered: `isActive` was checked before the balance,
    // and that order is part of what the caller sees.
    const db = seed({ balance: 10, isActive: false });

    await assert.rejects(
      () => requestWithdrawal(db, 5_000),
      expectRefusal('Partner is not active'),
    );
  });

  it('a non-positive amount is refused before any transaction opens', async () => {
    for (const amount of [0, -1]) {
      const db = seed();

      await assert.rejects(
        () => requestWithdrawal(db, amount),
        expectRefusal('Withdrawal amount must be positive'),
      );

      assert.equal(partnerRow(db).balance, OPENING_BALANCE);
      assert.deepEqual(db.state.withdrawals, []);
      assert.deepEqual(
        db.calls.filter((c) => c.op === '$transaction.begin'),
        [],
        'the amount check is cheap and runs first',
      );
    }
  });

  it('sends the debit as a relative decrement, never as a precomputed total', async () => {
    const db = seed();

    await requestWithdrawal(db, 2_500);

    const write = soleWrite(balanceWrites(db), 'balance write');
    assert.deepEqual(
      write.data['balance'],
      { decrement: 2_500 },
      'the database is told the delta and computes the total itself',
    );
    assert.notEqual(
      typeof write.data['balance'],
      'number',
      'an absolute total is a lost update waiting for a second writer',
    );
  });

  it('two successive requests each send only their own delta, so the debits sum', async () => {
    const db = seed();

    await requestWithdrawal(db, 2_500);
    await requestWithdrawal(db, 1_000);

    assert.deepEqual(
      balanceWrites(db).map((w) => w.data['balance']),
      [{ decrement: 2_500 }, { decrement: 1_000 }],
    );
    assert.equal(partnerRow(db).balance, OPENING_BALANCE - 3_500);
    assert.equal(db.state.withdrawals.length, 2);
  });

  it('the emitted event carries the amount, the method and the new withdrawal id', async () => {
    const db = seed();

    const body = await requestWithdrawal(db, 2_500);

    assert.deepEqual(db.emitted, [
      {
        type: 'partner.withdrawal_requested',
        category: 'PARTNER',
        message: 'Partner requested 2500 withdrawal',
        metadata: {
          withdrawalId: body.id,
          partnerId: 'p1',
          amount: 2_500,
          method: METHOD,
        },
      },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  A — the statement shape that makes the debit safe to run twice at once
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every assertion here is about the STATEMENT handed to the database, never
 * about isolation, which no fake can demonstrate. See the caveat at the top.
 */
describe('the withdrawal debit carries its own sufficiency floor', () => {
  it('sends the floor in the where of the same statement that decrements', async () => {
    const db = seed();

    await requestWithdrawal(db, 2_500);

    const write = soleWrite(balanceWrites(db), 'balance write');
    assert.equal(
      write.op,
      'partner.updateMany',
      'a conditional write is the only kind whose refusal the caller can see',
    );
    assert.equal(write.where['id'], 'p1', 'the write is addressed at the row');
    assert.deepEqual(
      write.where['balance'],
      { gte: 2_500 },
      'and refuses the row unless it still holds what is being taken',
    );
    assert.deepEqual(write.data['balance'], { decrement: 2_500 });
  });

  it('uses gte, so a request for the entire balance still matches the row', async () => {
    const db = seed();

    await requestWithdrawal(db, OPENING_BALANCE);

    const write = soleWrite(balanceWrites(db), 'balance write');
    assert.deepEqual(
      write.where['balance'],
      { gte: OPENING_BALANCE },
      'the floor is the entire balance, and the write still matched',
    );
    assert.equal(partnerRow(db).balance, 0);
  });

  it('carries the active flag in that same where', async () => {
    const db = seed();

    await requestWithdrawal(db, 2_500);

    const write = soleWrite(balanceWrites(db), 'balance write');
    assert.equal(
      write.where['isActive'],
      true,
      'a partner deactivated a moment ago must not be debited by an in-flight request',
    );
  });

  it('reads nothing from the partner row before that write inside the transaction', async () => {
    // A guard evaluated in JS needs a read to evaluate against. There is none
    // before the write, so the floor cannot live anywhere but in the write.
    const db = seed();

    await requestWithdrawal(db, 2_500);

    const inside = insideTx(db);
    const writeAt = inside.indexOf('partner.updateMany');
    assert.notEqual(writeAt, -1, 'the guarded debit ran inside the transaction');
    assert.deepEqual(inside.slice(0, writeAt), ['$transaction.begin'], 'nothing is read before it');
  });

  it('debits before it creates, so a refused debit can leave no withdrawal row', async () => {
    const db = seed();

    await requestWithdrawal(db, 2_500);

    assert.deepEqual(insideTx(db), [
      '$transaction.begin',
      'partner.updateMany',
      'partnerWithdrawal.create',
      '$transaction.commit',
    ]);
  });

  it('refuses a debit that matched no row, leaving no withdrawal row and no event', async () => {
    // Zero rows is the only thing the database says when its `where` refuses.
    // Forced here so the translation into the refusal is tested on its own,
    // with an amount the arithmetic would happily allow.
    const db = seed();
    db.failures.partnerGuardMiss = true;

    await assert.rejects(
      () => requestWithdrawal(db, 100),
      expectRefusal('Insufficient partner balance'),
    );

    assert.equal(partnerRow(db).balance, OPENING_BALANCE, 'the balance must not move');
    assert.deepEqual(db.state.withdrawals, [], 'no withdrawal row');
    assert.deepEqual(db.emitted, [], 'no system event');

    // Real zeros: with the guard no longer missing, the same fake records both.
    db.failures.partnerGuardMiss = false;
    await requestWithdrawal(db, 100);
    assert.equal(db.state.withdrawals.length, 1);
    assert.equal(db.emitted.length, 1);
  });

  it('never issues an unconditional partner.update for the debit', async () => {
    const db = seed();

    await requestWithdrawal(db, 2_500);

    assert.equal(
      db.writes.some((w) => w.op === 'partner.update'),
      false,
      'an unconditional update cannot refuse, whatever was checked beforehand',
    );
    assert.equal(
      db.writes.every((w) => w.tx !== null),
      true,
      'and nothing is written outside the transaction',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  B — approve / reject: observable behaviour, pinned as found
// ─────────────────────────────────────────────────────────────────────────────

describe('processing a withdrawal (pinned, not changed)', () => {
  it('approval marks it COMPLETED and increments totalWithdrawn once', async () => {
    const db = seedPending(2_500);

    const body = await approve(db);

    const row = withdrawalRow(db);
    assert.equal(row.status, 'COMPLETED');
    assert.equal(row.processedBy, 'admin-1');
    assert.ok(row.processedAt instanceof Date);
    assert.equal(partnerRow(db).totalWithdrawn, 2_500);
    assert.equal(partnerRow(db).balance, OPENING_BALANCE, 'approval does not touch the balance');
    assert.equal(body.status, 'COMPLETED');
    assert.equal(body.processedBy, 'admin-1');
  });

  it('rejection marks it REJECTED and restores the balance once', async () => {
    const db = seedPending(2_500);

    const body = await reject(db, 'w1', 'bad requisites');

    const row = withdrawalRow(db);
    assert.equal(row.status, 'REJECTED');
    assert.equal(row.adminComment, 'bad requisites');
    assert.equal(partnerRow(db).balance, OPENING_BALANCE + 2_500);
    assert.equal(partnerRow(db).totalWithdrawn, 0, 'a rejected payout was never paid out');
    assert.equal(body.status, 'REJECTED');
  });

  it('approving an already-COMPLETED withdrawal is refused and moves nothing', async () => {
    const db = seed({ withdrawals: [makeWithdrawalRow('w1', 'p1', 2_500, 'COMPLETED')] });

    await assert.rejects(
      () => approve(db),
      expectRefusal('Only pending withdrawals can be processed'),
    );

    assert.equal(partnerRow(db).totalWithdrawn, 0);
    assert.equal(partnerRow(db).balance, OPENING_BALANCE);
    assert.deepEqual(db.state.auditLogs, []);
    assert.deepEqual(db.emitted, []);
  });

  it('rejecting an already-REJECTED withdrawal is refused and credits nothing', async () => {
    const db = seed({ withdrawals: [makeWithdrawalRow('w1', 'p1', 2_500, 'REJECTED')] });

    await assert.rejects(
      () => reject(db),
      expectRefusal('Only pending withdrawals can be processed'),
    );

    assert.equal(partnerRow(db).balance, OPENING_BALANCE, 'a second credit would mint money');
    assert.deepEqual(db.state.auditLogs, []);
    assert.deepEqual(db.emitted, []);
  });

  it('an unknown withdrawal id is a 404 on both paths', async () => {
    for (const run of [approve, reject]) {
      const db = seedPending(2_500);

      await assert.rejects(
        () => run(db, 'missing'),
        expectNotFound('Withdrawal not found'),
      );

      assert.equal(withdrawalRow(db).status, 'PENDING', 'the untouched one stays pending');
      assert.deepEqual(db.state.auditLogs, []);
      assert.deepEqual(db.emitted, []);
    }
  });

  it('an omitted adminComment leaves the one already on the row', async () => {
    const db = seed({
      withdrawals: [makeWithdrawalRow('w1', 'p1', 2_500, 'PENDING', 'operator note')],
    });

    const body = await approve(db);

    assert.equal(withdrawalRow(db).adminComment, 'operator note');
    assert.equal(body.adminComment, 'operator note');
  });

  it('a supplied adminComment replaces it', async () => {
    const db = seed({
      withdrawals: [makeWithdrawalRow('w1', 'p1', 2_500, 'PENDING', 'operator note')],
    });

    const body = await approve(db, 'w1', 'paid out by hand');

    assert.equal(withdrawalRow(db).adminComment, 'paid out by hand');
    assert.equal(body.adminComment, 'paid out by hand');
  });

  it('the audit row and event carry the withdrawal, the partner and the amount', async () => {
    const db = seedPending(2_500);

    await approve(db);

    assert.equal(auditRow(db)['action'], 'partner.withdrawal.approved');
    const metadata = auditRow(db)['metadata'] as Record<string, unknown>;
    assert.equal(metadata['withdrawalId'], 'w1');
    assert.equal(metadata['partnerId'], 'p1');
    assert.equal(metadata['amount'], 2_500);
    assert.deepEqual(db.emitted, [
      {
        type: 'partner.withdrawal_approved',
        category: 'PARTNER',
        message: 'Withdrawal completed',
        metadata: {
          withdrawalId: 'w1',
          partnerId: 'p1',
          userId: 'u-partner',
          amount: 2_500,
          status: 'COMPLETED',
          adminId: 'admin-1',
        },
      },
    ]);
  });

  it('a failing audit write rolls the money back', async () => {
    const db = seedPending(2_500);
    db.failures.auditWrite = true;

    await assert.rejects(() => approve(db), /audit write refused/);

    assert.equal(partnerRow(db).totalWithdrawn, 0, 'a payout with no audit row did not happen');
    assert.equal(withdrawalRow(db).status, 'PENDING', 'and the withdrawal is still claimable');
    assert.deepEqual(db.state.auditLogs, []);
    assert.deepEqual(db.emitted, []);
    assert.equal(
      db.calls.some((c) => c.op === '$transaction.rollback'),
      true,
    );
  });

  it('bulk approve reports per-id failures without halting the batch', async () => {
    const db = seed({
      withdrawals: [
        makeWithdrawalRow('w1', 'p1', 1_000),
        makeWithdrawalRow('w2', 'p1', 2_000, 'COMPLETED'),
        makeWithdrawalRow('w3', 'p1', 3_000),
      ],
    });

    const outcome = await bulkApprove(db, ['w1', 'w2', 'w3'], 'batch');

    assert.equal(outcome.approved, 2);
    assert.equal(outcome.failed, 1);
    assert.deepEqual(outcome.errors, [
      { id: 'w2', error: 'Only pending withdrawals can be processed' },
    ]);
    assert.equal(withdrawalRow(db, 'w1').status, 'COMPLETED');
    assert.equal(withdrawalRow(db, 'w3').status, 'COMPLETED');
    assert.equal(
      partnerRow(db).totalWithdrawn,
      4_000,
      'only the two it actually transitioned were counted as paid',
    );
  });

  it('the same id twice in one batch is counted once', async () => {
    const db = seedPending(2_500);

    const outcome = await bulkApprove(db, ['w1', 'w1']);

    assert.equal(outcome.approved, 1);
    assert.equal(outcome.failed, 1);
    assert.deepEqual(outcome.errors, [
      { id: 'w1', error: 'Only pending withdrawals can be processed' },
    ]);
    assert.equal(partnerRow(db).totalWithdrawn, 2_500, 'one payout, counted once');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  B — the statement shape that makes the transition safe to run twice at once
// ─────────────────────────────────────────────────────────────────────────────

/** Same caveat as A: these assert the statement, not isolation. */
describe('the withdrawal transition asserts and performs in one statement', () => {
  it('moves it out of PENDING in the very statement that requires it to be PENDING', async () => {
    for (const [label, run, next] of [
      ['approve', approve, 'COMPLETED'],
      ['reject', reject, 'REJECTED'],
    ] as const) {
      const db = seedPending(2_500);

      await run(db, 'w1');

      const write = soleWrite(statusWrites(db), `${label}: status write`);
      assert.equal(
        write.op,
        'partnerWithdrawal.updateMany',
        `${label}: a conditional write is the only kind whose refusal the caller can see`,
      );
      assert.equal(write.where['id'], 'w1', `${label}: addressed at the row`);
      assert.equal(
        write.where['status'],
        'PENDING',
        `${label}: the from-state is the filter, not an earlier JS check`,
      );
      assert.equal(write.data['status'], next, `${label}: and the to-state is the write`);
      assert.equal(write.data['processedBy'], 'admin-1');
      assert.ok(write.data['processedAt'] instanceof Date);
    }
  });

  it('reads nothing from the withdrawal row before that transition inside the transaction', async () => {
    for (const [label, run] of [
      ['approve', approve],
      ['reject', reject],
    ] as const) {
      const db = seedPending(2_500);

      await run(db, 'w1');

      const inside = insideTx(db);
      const at = inside.indexOf('partnerWithdrawal.updateMany');
      assert.notEqual(at, -1, `${label}: the transition ran inside the transaction`);
      assert.deepEqual(
        inside.slice(0, at),
        ['$transaction.begin'],
        `${label}: a status read before it is a check the transition would have to trust`,
      );
    }
  });

  it('transitions before it moves money, so no payout precedes its claim', async () => {
    for (const [label, run] of [
      ['approve', approve],
      ['reject', reject],
    ] as const) {
      const db = seedPending(2_500);

      await run(db, 'w1');

      const inside = insideTx(db);
      const moneyAt = inside.indexOf('partner.update');
      const claimAt = inside.indexOf('partnerWithdrawal.updateMany');
      assert.notEqual(moneyAt, -1, `${label}: money moved`);
      // Asserted before the comparison: a missing transition indexes to -1,
      // which would satisfy `< moneyAt` and make this test vacuously green.
      assert.notEqual(claimAt, -1, `${label}: the conditional transition was issued`);
      assert.ok(claimAt < moneyAt, `${label}: the claim is staked before the money moves`);
    }
  });

  it('a transition that matched no row is refused, and increments nothing', async () => {
    // Zero rows is the only thing the database says when its `where` refuses —
    // here, that somebody else already moved this withdrawal out of PENDING.
    for (const [label, run] of [
      ['approve', approve],
      ['reject', reject],
    ] as const) {
      const db = seedPending(2_500);
      db.failures.withdrawalGuardMiss = true;

      await assert.rejects(
        () => run(db, 'w1'),
        expectRefusal('Only pending withdrawals can be processed'),
      );

      assert.equal(partnerRow(db).totalWithdrawn, 0, `${label}: nothing was paid out`);
      assert.equal(partnerRow(db).balance, OPENING_BALANCE, `${label}: nothing was credited`);
      assert.deepEqual(db.state.auditLogs, [], `${label}: no audit row`);
      assert.deepEqual(db.emitted, [], `${label}: no system event`);
      assert.deepEqual(
        totalWithdrawnWrites(db),
        [],
        `${label}: the increment was never even issued`,
      );

      // Real zeros: with the guard no longer missing, the same fake records all
      // three.
      db.failures.withdrawalGuardMiss = false;
      await run(db, 'w1');
      assert.equal(db.state.auditLogs.length, 1, `${label}: this fake does record audit rows`);
      assert.equal(db.emitted.length, 1, `${label}: and events`);
      assert.notEqual(withdrawalRow(db).status, 'PENDING', `${label}: and the transition`);
    }
  });

  it('totalWithdrawn moves exactly once even when the approval is attempted twice', async () => {
    const db = seedPending(2_500);

    await approve(db);
    await assert.rejects(
      () => approve(db),
      expectRefusal('Only pending withdrawals can be processed'),
    );

    const write = soleWrite(totalWithdrawnWrites(db), 'totalWithdrawn write');
    assert.deepEqual(write.data['totalWithdrawn'], { increment: 2_500 });
    assert.equal(partnerRow(db).totalWithdrawn, 2_500, 'one payout, counted once');
    assert.equal(db.state.auditLogs.length, 1, 'and audited once');
    assert.equal(db.emitted.length, 1, 'and announced once');
  });

  it('the balance credit on rejection moves exactly once for the same reason', async () => {
    const db = seedPending(2_500);

    await reject(db);
    await assert.rejects(
      () => reject(db),
      expectRefusal('Only pending withdrawals can be processed'),
    );

    const write = soleWrite(balanceWrites(db), 'balance write');
    assert.deepEqual(write.data['balance'], { increment: 2_500 });
    assert.equal(partnerRow(db).balance, OPENING_BALANCE + 2_500);
  });

  it('never issues an unconditional partnerWithdrawal.update for the transition', async () => {
    for (const run of [approve, reject]) {
      const db = seedPending(2_500);

      await run(db, 'w1');

      assert.equal(
        db.writes.some((w) => w.op === 'partnerWithdrawal.update'),
        false,
        'an unconditional update cannot refuse, whatever was checked beforehand',
      );
      assert.equal(
        db.writes.every((w) => w.tx !== null),
        true,
      );
    }
  });
});
