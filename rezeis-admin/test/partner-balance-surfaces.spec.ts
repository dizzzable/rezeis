import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, NotFoundException } from '@nestjs/common';

import { AdminPartnersController } from '../src/modules/partners/controllers/admin-partners.controller';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import { PartnersService } from '../src/modules/partners/services/partners.service';
import { AdminUserManagementController } from '../src/modules/users/controllers/admin-user-management.controller';

/**
 * Partner balance adjustment, across both surfaces that can perform it.
 *
 * `POST /admin/partners/:partnerId/adjust-balance` (Partners tab) and
 * `POST /admin/users/:telegramId/partner/adjust-balance` (user-detail panel)
 * are the same operator act — money moving in a partner's ledger — and used to
 * be implemented twice. The user-detail copy was a bare, non-transactional
 * read-then-update; it wrote a DIFFERENT audit action
 * (`user.partner.balance.adjusted`) carrying no before/after balances, and it
 * emitted no system event at all. Two names for one act, one of them without
 * amounts, means the audit log cannot answer "who moved this balance and by
 * how much" in a single query.
 *
 * Both now route through `PartnersService`, which writes ONE action
 * (`partner.balance.adjusted`) and puts the origin in `metadata.source`, the
 * way `user.subscription.limits_changed` discriminates `operator_edit` from
 * `plan_assignment`.
 *
 * ── What the transaction here does and does not buy ──────────────────────────
 *
 * The tests below prove ALL-OR-NOTHING: the balance write and the audit row
 * share one transaction, and a failure anywhere in it leaves the balance
 * untouched and no audit row behind. The old inline code could move money and
 * then fail to record it.
 *
 * They also prove the SHAPE that lets two adjustments compose. The write handed
 * to the client is relative — `{ balance: { increment: amount } }`, never a
 * total this process computed — and the below-zero floor travels in the
 * `where` of that same statement, `balance >= -amount`, instead of being
 * checked in JS against an earlier read. Both are visible in the arguments the
 * service passes, and both are asserted below, as is the refusal that a zero
 * row count produces. `applyBalanceAdjustment` used to write an ABSOLUTE
 * `balance: newBalance` computed from a value read earlier in the same
 * transaction; under the default READ COMMITTED isolation that lost updates —
 * two adjustments both read 100, one wrote 150, the other overwrote with 50.
 *
 * What no test here proves, and none claims to, is SERIALISABILITY. A fake
 * Prisma has no row locks and no snapshot visibility: it cannot run two real
 * transactions against one row, cannot show the second blocking on the first's
 * lock, and cannot show the floor being re-evaluated against the locked row.
 * That guarantee belongs to Postgres — it evaluates the `WHERE` of an
 * `UPDATE` against the row it locks, and holds that lock until commit, which
 * is also what makes the post-write read-back of `newBalance` this
 * adjustment's own result. None of that is asserted below. What is asserted is
 * that the statement handed to the database is the one with those properties.
 *
 * Everything here runs the REAL services against a fake Prisma that holds rows,
 * and asserts on the rows. A double that only records calls cannot tell
 * "nothing was written" from "the writer was never wired up" — so the first
 * test is a control proving this fake does record an audit row and an event
 * when one is actually written.
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

/** The plain `Partner` columns, in schema order — the user-detail response shape. */
const PARTNER_SCALAR_KEYS = [
  'id',
  'userId',
  'balance',
  'totalEarned',
  'totalWithdrawn',
  'isActive',
  'useGlobalSettings',
  'accrualStrategy',
  'rewardType',
  'level1Percent',
  'level2Percent',
  'level3Percent',
  'level1FixedAmount',
  'level2FixedAmount',
  'level3FixedAmount',
  'createdAt',
  'updatedAt',
];

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
 * One write sent to the `partner` delegate, kept WITH its arguments.
 *
 * A count of calls cannot tell an increment from a precomputed total, nor a
 * guard that rides in the statement from one checked in JS beforehand. Both of
 * those are the difference between an adjustment that survives a concurrent
 * one and an adjustment that silently eats it, so the arguments are what the
 * tests assert on.
 */
interface RecordedWrite {
  op: string;
  where: Record<string, unknown>;
  data: Record<string, unknown>;
  tx: string | null;
}

/** What a `partner` write may carry: an absolute value or a relative one. */
type PartnerWriteData = {
  balance?: number | { increment?: number; decrement?: number };
  isActive?: boolean;
};

function snapshotArgs(value: object): Record<string, unknown> {
  return { ...value } as Record<string, unknown>;
}

/** Applies a write to a row the way Postgres would: absolute or relative. */
function applyPartnerData(row: PartnerRow, data: PartnerWriteData): void {
  if (typeof data.balance === 'number') {
    row.balance = data.balance;
  } else if (data.balance?.increment !== undefined) {
    row.balance += data.balance.increment;
  } else if (data.balance?.decrement !== undefined) {
    row.balance -= data.balance.decrement;
  }
  if (data.isActive !== undefined) row.isActive = data.isActive;
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

function makePartnerRow(id: string, userId: string, balance: number): PartnerRow {
  const bornAt = new Date(Date.now() - 60 * DAY_MS);
  return {
    id,
    userId,
    balance,
    totalEarned: 0,
    totalWithdrawn: 0,
    isActive: true,
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
function makeDb(seed: { users?: UserRow[]; partners?: PartnerRow[] }) {
  const users = [...(seed.users ?? [])];
  const partners = [...(seed.partners ?? [])];
  const auditLogs: Array<Record<string, unknown>> = [];
  const calls: RecordedCall[] = [];
  const writes: RecordedWrite[] = [];
  // `guardMiss` makes the conditional write match nothing, which is the only
  // signal the database gives when its `where` refuses the row. It is how the
  // count-zero branch is reached without going through the arithmetic.
  const failures = { auditWrite: false, guardMiss: false };
  let currentTx: string | null = null;
  let txSeq = 0;

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

  const client = {
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> => {
      const id = `tx-${++txSeq}`;
      const outerTx = currentTx;
      currentTx = id;
      const partnerSnapshot = partners.map((p) => ({ ...p }));
      const auditLength = auditLogs.length;
      record('$transaction.begin');
      try {
        const out = await callback(client);
        record('$transaction.commit');
        return out;
      } catch (error: unknown) {
        partners.splice(0, partners.length, ...partnerSnapshot);
        auditLogs.length = auditLength;
        record('$transaction.rollback');
        throw error;
      } finally {
        currentTx = outerTx;
      }
    },
    user: {
      findFirst: async (args: { where: { telegramId?: bigint } }) => {
        record('user.findFirst');
        return users.find((u) => u.telegramId === args.where.telegramId) ?? null;
      },
      findUnique: async (args: { where: { id?: string } }) => {
        record('user.findUnique');
        return users.find((u) => u.id === args.where.id) ?? null;
      },
    },
    partner: {
      findUnique: async (args: {
        where: { id?: string; userId?: string };
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
       * The conditional write. Every clause of `where` — the balance floor
       * included — is applied as the filter that selects the rows to change,
       * so `count` is the caller's only signal, exactly as it is in Postgres.
       * There is no lock here and no isolation; see the caveat at the top.
       */
      updateMany: async (args: {
        where: { id?: string; balance?: { gte?: number } };
        data: PartnerWriteData;
      }) => {
        record('partner.updateMany');
        writes.push({
          op: 'partner.updateMany',
          where: snapshotArgs(args.where),
          data: snapshotArgs(args.data),
          tx: currentTx,
        });
        const matched = failures.guardMiss
          ? []
          : partners.filter((row) => {
              if (args.where.id !== undefined && row.id !== args.where.id) return false;
              const floor = args.where.balance?.gte;
              if (floor !== undefined && row.balance < floor) return false;
              return true;
            });
        for (const row of matched) applyPartnerData(row, args.data);
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
    state: { users, partners, auditLogs },
  };
}

function buildPartnersTab(db: ReturnType<typeof makeDb>) {
  const partnersService = new PartnersService(
    db.client as never,
    db.events as never,
    NULL_NOTIFICATIONS as never,
  );
  return new AdminPartnersController(partnersService, {} as never, {} as never, {} as never);
}

function buildUserPanel(db: ReturnType<typeof makeDb>) {
  const partnersService = new PartnersService(
    db.client as never,
    db.events as never,
    NULL_NOTIFICATIONS as never,
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
    partnersService,
    {} as never, // PlansAdminService
    undefined as never,
    { listForUser: async () => [], clear: async () => undefined } as never, // DeviceIntelligenceService
    new PointsWalletService(),
    { listForUser: async () => ({ items: [], nextCursor: null }) } as never,
  );
}

/** One active partner, telegram id 1000, holding {@link OPENING_BALANCE}. */
function seedPartner(balance: number = OPENING_BALANCE) {
  return makeDb({
    users: [makeUser('u-partner', 1000n)],
    partners: [makePartnerRow('p1', 'u-partner', balance)],
  });
}

/** The Partners tab, driven through its controller method. */
function adjustViaTab(db: ReturnType<typeof makeDb>, amount: number, reason?: string) {
  return buildPartnersTab(db).adjustBalance('p1', { amount, reason }, ADMIN, REQ);
}

/** The user-detail panel, driven through its controller method. */
function adjustViaPanel(db: ReturnType<typeof makeDb>, amount: number, reason?: string) {
  return buildUserPanel(db).adjustPartnerBalance('1000', { amount, reason }, ADMIN, REQ);
}

function auditRow(db: ReturnType<typeof makeDb>, index = 0): Record<string, unknown> {
  const row = db.state.auditLogs[index];
  assert.ok(row, `expected an audit row at index ${index}`);
  return row;
}

function auditMetadata(db: ReturnType<typeof makeDb>, index = 0): Record<string, unknown> {
  return auditRow(db, index)['metadata'] as Record<string, unknown>;
}

function withoutSource(metadata: Record<string, unknown>): Record<string, unknown> {
  const { source: _source, ...rest } = metadata;
  return rest;
}

/** Every write the service sent to the `partner` delegate that touched the balance. */
function partnerWrites(db: ReturnType<typeof makeDb>): RecordedWrite[] {
  return db.writes.filter((write) => 'balance' in write.data);
}

/** The one balance write of an adjustment, or a failure naming what was sent instead. */
function soleBalanceWrite(db: ReturnType<typeof makeDb>): RecordedWrite {
  const writes = partnerWrites(db);
  assert.equal(
    writes.length,
    1,
    `expected exactly one balance write, saw [${writes.map((write) => write.op).join(', ')}]`,
  );
  return writes[0];
}

/** The floor the write carried in its own `where`, or undefined if it carried none. */
function guardFloor(write: RecordedWrite): number | undefined {
  const balance = write.where['balance'] as { gte?: number } | undefined;
  return typeof balance?.gte === 'number' ? balance.gte : undefined;
}

describe('partner balance — the fake records writes (control)', () => {
  // Without this, every "no audit row was written" and "no event was emitted"
  // assertion below could pass simply because nothing in this fake is capable
  // of recording either.
  it('an adjustment DOES produce an audit row and a system event through this fake', async () => {
    const db = seedPartner();

    await adjustViaTab(db, 2_500, 'goodwill');

    assert.equal(db.state.auditLogs.length, 1);
    assert.equal(auditRow(db)['action'], 'partner.balance.adjusted');
    assert.equal(db.emitted.length, 1);
    assert.equal(db.emitted[0]?.type, 'partner.balance_adjusted');
    assert.equal(db.state.partners[0]?.balance, OPENING_BALANCE + 2_500);
  });
});

describe('the two balance surfaces agree', () => {
  it('leave the same audit row and emit the same system event', async () => {
    const viaTab = seedPartner();
    await adjustViaTab(viaTab, 2_500, 'goodwill');

    const viaPanel = seedPartner();
    await adjustViaPanel(viaPanel, 2_500, 'goodwill');

    // Same system event, field for field.
    assert.deepEqual(viaPanel.emitted, viaTab.emitted, 'same operator act, same system event');
    assert.deepEqual(viaTab.emitted, [
      {
        type: 'partner.balance_adjusted',
        category: 'PARTNER',
        message: 'Partner balance adjusted by 2500',
        metadata: {
          partnerId: 'p1',
          adjustment: 2_500,
          previousBalance: OPENING_BALANCE,
          newBalance: OPENING_BALANCE + 2_500,
          adminId: 'admin-1',
          reason: 'goodwill',
        },
      },
    ]);

    // One audit action for both, same row shape, same values but the origin.
    assert.equal(viaPanel.state.auditLogs.length, 1);
    assert.equal(viaTab.state.auditLogs.length, 1);
    assert.deepEqual(
      Object.keys(auditRow(viaPanel)).sort(),
      Object.keys(auditRow(viaTab)).sort(),
    );
    assert.equal(auditRow(viaPanel)['action'], auditRow(viaTab)['action']);
    assert.equal(auditRow(viaTab)['action'], 'partner.balance.adjusted');
    assert.deepEqual(
      Object.keys(auditMetadata(viaPanel)).sort(),
      Object.keys(auditMetadata(viaTab)).sort(),
    );
    assert.deepEqual(
      withoutSource(auditMetadata(viaPanel)),
      withoutSource(auditMetadata(viaTab)),
    );

    // The origin is metadata, not part of the action name.
    assert.equal(auditMetadata(viaTab)['source'], 'partners_tab');
    assert.equal(auditMetadata(viaPanel)['source'], 'user_detail');

    // And the rows themselves land in the same place.
    assert.equal(viaPanel.state.partners[0]?.balance, viaTab.state.partners[0]?.balance);
    assert.equal(viaTab.state.partners[0]?.balance, OPENING_BALANCE + 2_500);
  });

  it('both record previousBalance and newBalance in the audit row', async () => {
    const viaTab = seedPartner();
    await adjustViaTab(viaTab, -2_500, 'chargeback');

    const viaPanel = seedPartner();
    await adjustViaPanel(viaPanel, -2_500, 'chargeback');

    for (const db of [viaTab, viaPanel]) {
      const metadata = auditMetadata(db);
      assert.equal(metadata['previousBalance'], OPENING_BALANCE);
      assert.equal(metadata['newBalance'], OPENING_BALANCE - 2_500);
      assert.equal(metadata['adjustment'], -2_500);
      assert.equal(metadata['partnerId'], 'p1');
      assert.equal(metadata['reason'], 'chargeback');
    }
  });

  it('neither writes the retired `user.partner.balance.adjusted` action', async () => {
    const viaTab = seedPartner();
    await adjustViaTab(viaTab, 100);

    const viaPanel = seedPartner();
    await adjustViaPanel(viaPanel, 100);

    assert.deepEqual(
      [...viaTab.state.auditLogs, ...viaPanel.state.auditLogs].map((row) => row['action']),
      ['partner.balance.adjusted', 'partner.balance.adjusted'],
    );
  });

  it('a null reason survives to both the audit row and the event', async () => {
    const viaPanel = seedPartner();
    await adjustViaPanel(viaPanel, 100);

    assert.equal(auditMetadata(viaPanel)['reason'], null);
    assert.equal((viaPanel.emitted[0]?.metadata as Record<string, unknown>)['reason'], null);
  });
});

describe('HTTP contracts are unchanged', () => {
  it('user-detail adjust-balance returns the bare Partner row, relations stripped', async () => {
    const db = seedPartner();

    const body = (await adjustViaPanel(db, 2_500)) as unknown as Record<string, unknown>;

    assert.deepEqual(Object.keys(body).sort(), [...PARTNER_SCALAR_KEYS].sort());
    assert.equal('user' in body, false);
    assert.equal('_count' in body, false);
    assert.equal(body['balance'], OPENING_BALANCE + 2_500);
    assert.equal(body['id'], 'p1');
  });

  it('Partners tab adjust-balance still returns the mapped PartnerInterface', async () => {
    const db = seedPartner();

    const body = await adjustViaTab(db, 2_500);

    assert.equal(body.id, 'p1');
    assert.equal(body.balance, OPENING_BALANCE + 2_500);
    assert.equal(body.referralsCount, 0);
    assert.equal(body.user.telegramId, '1000');
    assert.equal(typeof body.createdAt, 'string');
    assert.equal('_count' in (body as unknown as Record<string, unknown>), false);
  });

  it('the two response bodies are deliberately different shapes', async () => {
    const viaTab = seedPartner();
    const tabBody = (await adjustViaTab(viaTab, 100)) as unknown as Record<string, unknown>;

    const viaPanel = seedPartner();
    const panelBody = (await adjustViaPanel(viaPanel, 100)) as unknown as Record<string, unknown>;

    assert.equal('user' in tabBody, true, 'the Partners tab body carries the mapped user');
    assert.equal('user' in panelBody, false, 'the user-detail body never has');
    assert.notDeepEqual(Object.keys(tabBody).sort(), Object.keys(panelBody).sort());
  });

  it('user-detail adjust-balance still 404s when the user has no partner', async () => {
    const db = makeDb({ users: [makeUser('u-nopartner', 3000n)] });

    await assert.rejects(
      () => buildUserPanel(db).adjustPartnerBalance('3000', { amount: 100 }, ADMIN, REQ),
      NotFoundException,
    );
    assert.deepEqual(db.state.auditLogs, []);
    assert.deepEqual(db.emitted, []);
  });

  it('user-detail adjust-balance still 404s when the user does not exist', async () => {
    const db = makeDb({});

    await assert.rejects(
      () => buildUserPanel(db).adjustPartnerBalance('4000', { amount: 100 }, ADMIN, REQ),
      NotFoundException,
    );
    assert.deepEqual(db.state.auditLogs, []);
    assert.deepEqual(db.emitted, []);
  });

  it('Partners tab adjust-balance still 404s on an unknown partner id', async () => {
    const db = makeDb({});

    await assert.rejects(
      () => buildPartnersTab(db).adjustBalance('nope', { amount: 100 }, ADMIN, REQ),
      NotFoundException,
    );
    assert.deepEqual(db.state.auditLogs, []);
    assert.deepEqual(db.emitted, []);
  });
});

describe('signed amounts and the below-zero floor (pinned, not changed)', () => {
  it('a negative adjustment debits the balance on both surfaces', async () => {
    const viaTab = seedPartner();
    const tabBody = await adjustViaTab(viaTab, -2_500);

    const viaPanel = seedPartner();
    const panelBody = (await adjustViaPanel(viaPanel, -2_500)) as unknown as Record<string, unknown>;

    assert.equal(tabBody.balance, OPENING_BALANCE - 2_500);
    assert.equal(panelBody['balance'], OPENING_BALANCE - 2_500);
    assert.equal(viaTab.state.partners[0]?.balance, OPENING_BALANCE - 2_500);
    assert.equal(viaPanel.state.partners[0]?.balance, OPENING_BALANCE - 2_500);
  });

  // The boundary is pinned as found: it was `newBalance < 0` evaluated in JS,
  // it is now `balance >= -amount` evaluated by the database, and both allow
  // landing exactly on zero. The floor asserted below is `gte`, not `gt` —
  // the whole balance may be taken, one minor unit more may not.
  it('an adjustment that lands exactly on zero is allowed on both surfaces', async () => {
    const viaTab = seedPartner();
    await adjustViaTab(viaTab, -OPENING_BALANCE);

    const viaPanel = seedPartner();
    await adjustViaPanel(viaPanel, -OPENING_BALANCE);

    assert.equal(viaTab.state.partners[0]?.balance, 0);
    assert.equal(viaPanel.state.partners[0]?.balance, 0);
    assert.equal(auditMetadata(viaTab)['newBalance'], 0);
    assert.equal(auditMetadata(viaPanel)['newBalance'], 0);
    for (const db of [viaTab, viaPanel]) {
      assert.equal(
        guardFloor(soleBalanceWrite(db)),
        OPENING_BALANCE,
        'the floor is the entire balance, and the write still matched the row',
      );
    }
  });

  it('an adjustment that would drive the balance below zero is refused on both surfaces', async () => {
    const viaTab = seedPartner();
    await assert.rejects(() => adjustViaTab(viaTab, -(OPENING_BALANCE + 1)), (error: unknown) => {
      assert.ok(error instanceof BadRequestException);
      assert.equal((error as Error).message, 'Resulting balance would be negative');
      return true;
    });

    const viaPanel = seedPartner();
    await assert.rejects(
      () => adjustViaPanel(viaPanel, -(OPENING_BALANCE + 1)),
      (error: unknown) => {
        assert.ok(error instanceof BadRequestException);
        assert.equal((error as Error).message, 'Resulting balance would be negative');
        return true;
      },
    );

    for (const db of [viaTab, viaPanel]) {
      assert.equal(db.state.partners[0]?.balance, OPENING_BALANCE, 'the balance must not move');
      assert.deepEqual(db.state.auditLogs, [], 'a refused adjustment leaves no audit row');
      assert.deepEqual(db.emitted, [], 'and emits no system event');
      assert.equal(
        guardFloor(soleBalanceWrite(db)),
        OPENING_BALANCE + 1,
        'the write asked the row to hold more than it does, and so matched nothing',
      );
    }
  });
});

/**
 * The properties that let two adjustments compose instead of eating each
 * other. Every assertion here is about the STATEMENT the service hands the
 * database, or about the row that came back from it — not about isolation,
 * which no fake can demonstrate. See the caveat at the top of this file.
 */
describe('the balance write is relative and carries its own floor', () => {
  it('sends the adjustment as an increment, never as a precomputed total', async () => {
    for (const [label, run] of [
      ['partners tab', adjustViaTab],
      ['user detail', adjustViaPanel],
    ] as const) {
      for (const amount of [2_500, -2_500]) {
        const db = seedPartner();
        await run(db, amount);

        const write = soleBalanceWrite(db);
        assert.deepEqual(
          write.data['balance'],
          { increment: amount },
          `${label}: the database is told the delta ${amount} and computes the total itself`,
        );
        assert.notEqual(
          typeof write.data['balance'],
          'number',
          `${label}: an absolute total is a lost update waiting for a second writer`,
        );
        assert.equal(
          db.state.partners[0]?.balance,
          OPENING_BALANCE + amount,
          `${label}: and the row lands where the delta puts it`,
        );
      }
    }
  });

  it('sends only its own delta on a second adjustment, so the two writes sum', async () => {
    const db = seedPartner();

    await adjustViaTab(db, 2_500, 'first');
    await adjustViaPanel(db, -1_000, 'second');

    assert.deepEqual(
      partnerWrites(db).map((write) => write.data['balance']),
      [{ increment: 2_500 }, { increment: -1_000 }],
      'neither write carries the total the other left behind',
    );
    assert.equal(db.state.partners[0]?.balance, OPENING_BALANCE + 1_500);
    assert.equal(auditMetadata(db, 0)['newBalance'], OPENING_BALANCE + 2_500);
    assert.equal(auditMetadata(db, 1)['previousBalance'], OPENING_BALANCE + 2_500);
    assert.equal(auditMetadata(db, 1)['newBalance'], OPENING_BALANCE + 1_500);
  });

  it('carries the below-zero floor in the where of that same write statement', async () => {
    for (const [label, run] of [
      ['partners tab', adjustViaTab],
      ['user detail', adjustViaPanel],
    ] as const) {
      const db = seedPartner();
      await run(db, -2_500);

      const write = soleBalanceWrite(db);
      assert.equal(write.where['id'], 'p1', `${label}: the write is addressed at the row`);
      assert.deepEqual(
        write.where['balance'],
        { gte: 2_500 },
        `${label}: and refuses it unless it still holds what is being taken`,
      );
    }
  });

  it('reads nothing from the partner row before that write inside the transaction', async () => {
    // A guard evaluated in JS needs a read to evaluate against. There is none
    // before the write, so the floor cannot live anywhere but in the write.
    for (const [label, run] of [
      ['partners tab', adjustViaTab],
      ['user detail', adjustViaPanel],
    ] as const) {
      const db = seedPartner();
      await run(db, -2_500);

      const inside = db.calls.filter((call) => call.tx !== null).map((call) => call.op);
      const writeAt = inside.indexOf('partner.updateMany');
      assert.notEqual(writeAt, -1, `${label}: the guarded write ran inside the transaction`);
      assert.deepEqual(
        inside.slice(0, writeAt),
        ['$transaction.begin'],
        `${label}: nothing is read before it`,
      );
    }
  });

  it('never blocks a credit: the floor for a positive adjustment is negative', async () => {
    for (const [label, run] of [
      ['partners tab', adjustViaTab],
      ['user detail', adjustViaPanel],
    ] as const) {
      const db = seedPartner(0);
      await run(db, 2_500);

      const floor = guardFloor(soleBalanceWrite(db));
      assert.equal(floor, -2_500, `${label}: the predicate is balance >= -amount`);
      assert.ok(
        floor !== undefined && floor <= 0,
        `${label}: a floor at or below zero is one no non-negative balance can fail`,
      );
      assert.equal(
        db.state.partners[0]?.balance,
        2_500,
        `${label}: an empty balance still takes a credit`,
      );
      assert.equal(auditMetadata(db)['previousBalance'], 0);
      assert.equal(auditMetadata(db)['newBalance'], 2_500);
    }
  });

  it('refuses a write that matched no row, leaving no audit row and no event', async () => {
    // Zero rows is the only thing the database says when its `where` refuses.
    // Forced here so the translation into the refusal is tested on its own,
    // with an amount the arithmetic would happily allow.
    for (const [label, run] of [
      ['partners tab', adjustViaTab],
      ['user detail', adjustViaPanel],
    ] as const) {
      const db = seedPartner();
      db.failures.guardMiss = true;

      await assert.rejects(
        () => run(db, -100),
        (error: unknown) => {
          assert.ok(error instanceof BadRequestException, `${label}: refusal type`);
          assert.equal(
            (error as Error).message,
            'Resulting balance would be negative',
            `${label}: refusal wording`,
          );
          return true;
        },
      );

      assert.equal(
        db.state.partners[0]?.balance,
        OPENING_BALANCE,
        `${label}: the balance must not move`,
      );
      assert.deepEqual(db.state.auditLogs, [], `${label}: no audit row`);
      assert.deepEqual(db.emitted, [], `${label}: no system event`);
    }
  });

  it('reports the balance read back after the write, and derives previousBalance from it', async () => {
    for (const [label, run] of [
      ['partners tab', adjustViaTab],
      ['user detail', adjustViaPanel],
    ] as const) {
      const db = seedPartner();
      await run(db, -2_500);

      const stored = db.state.partners[0]?.balance;
      assert.equal(stored, OPENING_BALANCE - 2_500);
      for (const [carrier, metadata] of [
        ['audit row', auditMetadata(db)],
        ['system event', db.emitted[0]?.metadata as Record<string, unknown>],
      ] as const) {
        assert.equal(
          metadata['newBalance'],
          stored,
          `${label}: the ${carrier} carries the balance the database holds`,
        );
        assert.equal(
          metadata['previousBalance'],
          OPENING_BALANCE,
          `${label}: and a previousBalance derived from it, not read before the write`,
        );
      }

      const inside = db.calls.filter((call) => call.tx !== null).map((call) => call.op);
      assert.ok(
        inside.indexOf('partner.findUnique') > inside.indexOf('partner.updateMany'),
        `${label}: the row those numbers come from is read AFTER the write`,
      );
    }
  });
});

/**
 * All-or-nothing, and nothing more. See the caveat at the top of this file:
 * these tests do not claim to prove isolation from a concurrent lost update.
 */
describe('the adjustment is one transaction', () => {
  it('both surfaces read, write and audit inside a single transaction', async () => {
    for (const [label, run] of [
      ['partners tab', adjustViaTab],
      ['user detail', adjustViaPanel],
    ] as const) {
      const db = seedPartner();
      await run(db, 2_500);

      const begins = db.calls.filter((c) => c.op === '$transaction.begin');
      assert.equal(begins.length, 1, `${label}: exactly one transaction`);

      const inside = db.calls.filter((c) => c.tx !== null).map((c) => c.op);
      assert.deepEqual(
        inside,
        [
          '$transaction.begin',
          'partner.updateMany',
          'partner.findUnique',
          'adminAuditLog.create',
          '$transaction.commit',
        ],
        `${label}: the guarded write, the read-back and the audit row share one transaction`,
      );

      const txIds = new Set(db.calls.filter((c) => c.tx !== null).map((c) => c.tx));
      assert.equal(txIds.size, 1, `${label}: and it is the SAME transaction for all of them`);

      assert.equal(
        db.writes.some((write) => write.tx === null),
        false,
        `${label}: no balance write may happen outside a transaction`,
      );
    }
  });

  it('a failing audit write rolls the balance back on both surfaces', async () => {
    for (const [label, run] of [
      ['partners tab', adjustViaTab],
      ['user detail', adjustViaPanel],
    ] as const) {
      const db = seedPartner();
      db.failures.auditWrite = true;

      await assert.rejects(() => run(db, 2_500), /audit write refused/);

      assert.equal(
        db.state.partners[0]?.balance,
        OPENING_BALANCE,
        `${label}: money must not move when its audit row cannot be written`,
      );
      assert.deepEqual(db.state.auditLogs, [], `${label}: and no audit row survives`);
      assert.deepEqual(db.emitted, [], `${label}: and no system event is emitted`);
      assert.equal(
        db.calls.some((c) => c.op === '$transaction.rollback'),
        true,
        `${label}: the transaction rolled back`,
      );
    }
  });

  it('the user-detail surface resolves the partner by user id outside the transaction', async () => {
    // Not a defect — it resolves an id, never a balance. Nothing the write
    // depends on comes out of it: the write is relative and carries its own
    // floor. Pinned so that moving it becomes a deliberate act.
    const db = seedPartner();
    await adjustViaPanel(db, 100);

    const lookups = db.calls.filter((c) => c.op === 'partner.findUnique');
    assert.equal(lookups.length, 2);
    assert.equal(lookups[0]?.tx, null, 'the userId -> partnerId lookup');
    assert.notEqual(lookups[1]?.tx, null, 'the read-back that reports the written balance');
    assert.equal(
      db.writes.every((write) => write.tx !== null),
      true,
      'and nothing is written out there',
    );
  });
});
