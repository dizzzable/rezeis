import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AdminBulkUsersController } from '../src/modules/users/controllers/admin-bulk-users.controller';
import { AdminUserManagementController } from '../src/modules/users/controllers/admin-user-management.controller';
import { BulkUserOperationsService } from '../src/modules/users/services/bulk-user-operations.service';
import { UserBlockService } from '../src/modules/users/services/user-block.service';

/**
 * The operator trail behind a bulk user operation.
 *
 * Deleting ONE account from the user card wrote a `user.deleted` audit row and
 * a system event. Deleting a THOUSAND from the bulk toolbar wrote system events
 * only — `bulk-user-operations.service.ts` contained no `adminAuditLog` write
 * at all, and `admin-bulk-users.controller.ts` added none. The deletion itself
 * was already converged (both call `UserDeletionService.deleteUser`); only the
 * operator record diverged. `operator` holds `users:bulk_operations`, so the
 * question "who deleted this account" had an answer for one deletion and no
 * answer for a thousand.
 *
 * ── The granularity, and why ─────────────────────────────────────────────────
 *
 * ONE ROW PER AFFECTED USER, under the SAME action name the single-user route
 * writes, with the origin in `metadata.source`.
 *
 * The question is asked about ONE user. `AdminAuditLog` has no entity columns —
 * the subject lives in `metadata` — so the per-user answer is
 *
 *   SELECT ... WHERE action = 'user.deleted' AND metadata->>'userId' = $1
 *
 * and it has to find the bulk deletion too, or it answers "nobody" about an
 * account a bulk click removed. One row naming the whole set would answer
 * "which click did this" cheaply and the per-user question not at all without a
 * second, differently-shaped query unioned in — and a reader that has to
 * remember to union a second shape is a reader that will eventually forget.
 * `metadata.batchId` recovers the grouping without the second shape.
 *
 * The cost is bounded by `MAX_BATCH` and already precedented in the same file:
 * a bulk run already emits one system event per affected user.
 *
 * A skipped row and a failed row leave NO audit row. The log records what was
 * DONE; what was attempted is in the response body and the summary event.
 *
 * ── What is asserted ─────────────────────────────────────────────────────────
 *
 * The REAL service behind the REAL controller, against a fake Prisma that HOLDS
 * rows, asserting on the rows and on the exact `data` handed to the database.
 * The first test is a control proving this fake records an audit row when one
 * is written, so every zero below is a real zero.
 *
 * Dates are relative. An absolute fixture date in this repo was live when
 * written and silently became an expired-subscription assertion months later.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const ADMIN = { id: 'admin-7' } as never;
const REQ = {
  headers: { 'x-request-id': 'req-42', 'user-agent': 'panel/1.0' },
  ip: '10.0.0.9',
  socket: { remoteAddress: '10.0.0.9' },
} as never;

interface UserRow {
  id: string;
  telegramId: bigint | null;
  email: string | null;
  isBlocked: boolean;
  webAccount: null;
  subscriptions: readonly never[];
  createdAt: Date;
  /** Absent until a run sets it, so "unchanged" and "set to X" stay distinguishable. */
  language?: string;
  maxSubscriptions?: number;
}

interface EmittedEvent {
  type: string;
  metadata: Record<string, unknown>;
}

function makeUser(id: string, telegramId: bigint, isBlocked = false): UserRow {
  return {
    id,
    telegramId,
    email: `${id}@example.test`,
    isBlocked,
    // Both are part of the projection `UserBlockService.loadUser` asks for.
    // The fake ignores `select`, so it has to carry every field the real
    // client would return — an absent array here would be a fixture gap that
    // reads as a crash in the service.
    webAccount: null,
    subscriptions: [],
    createdAt: new Date(Date.now() - 30 * DAY_MS),
  };
}

/** Evaluates the one `where` shape `resolveUser` builds, plus the plain lookups. */
function matches(row: UserRow, where: Record<string, unknown>): boolean {
  const or = where['OR'] as Array<Record<string, unknown>> | undefined;
  if (or !== undefined) return or.some((clause) => matches(row, clause));
  if ('id' in where) return row.id === where['id'];
  if ('telegramId' in where) return row.telegramId === where['telegramId'];
  if ('email' in where) {
    const email = where['email'] as { equals?: string };
    return row.email !== null && row.email === email.equals;
  }
  if ('webAccount' in where) return false;
  return false;
}

/**
 * Fake Prisma holding real rows.
 *
 * `adminAuditLog.create` keeps the WHOLE `data` object. A call counter cannot
 * tell a row that names its subject from one that does not, and "who deleted
 * user X" is answered out of `metadata`, so `metadata` is what the tests read.
 */
function makeDb(seed: UserRow[]) {
  const users = [...seed];
  const auditLogs: Array<Record<string, unknown>> = [];
  /** ids handed to the deletion boundary, whether or not it then threw. */
  const deletionAttempts: string[] = [];
  /** Users the deletion boundary refuses — a partially failing run. */
  const undeletable = new Set<string>();

  const client = {
    user: {
      findFirst: async (args: { where: Record<string, unknown> }) =>
        users.find((u) => matches(u, args.where)) ?? null,
      findUnique: async (args: { where: Record<string, unknown> }) =>
        users.find((u) => matches(u, args.where)) ?? null,
      update: async (args: {
        where: { id: string };
        data: { isBlocked?: boolean; language?: string; maxSubscriptions?: number };
      }) => {
        const row = users.find((u) => u.id === args.where.id);
        if (!row) throw new Error('fake prisma: user.update on a missing row');
        if (args.data.isBlocked !== undefined) row.isBlocked = args.data.isBlocked;
        if (args.data.language !== undefined) row.language = args.data.language;
        if (args.data.maxSubscriptions !== undefined) {
          row.maxSubscriptions = args.data.maxSubscriptions;
        }
        return row;
      },
    },
    adminAuditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        auditLogs.push(args.data);
        return args.data;
      },
    },
  };

  const emitted: EmittedEvent[] = [];
  const events = {
    info: (type: string, _category: string, _message: string, metadata: Record<string, unknown>) =>
      emitted.push({ type, metadata }),
    warn: (type: string, _category: string, _message: string, metadata: Record<string, unknown>) =>
      emitted.push({ type, metadata }),
    error: () => undefined,
  };

  const userDeletion = {
    deleteUser: async (userId: string) => {
      deletionAttempts.push(userId);
      if (undeletable.has(userId)) {
        throw new Error(`deletion refused for ${userId}`);
      }
      const index = users.findIndex((u) => u.id === userId);
      if (index >= 0) users.splice(index, 1);
    },
  };

  return {
    client,
    events,
    emitted,
    userDeletion,
    undeletable,
    deletionAttempts,
    state: { users, auditLogs },
  };
}

type Db = ReturnType<typeof makeDb>;

function buildBulk(db: Db): AdminBulkUsersController {
  return new AdminBulkUsersController(
    new BulkUserOperationsService(
      db.client as never,
      db.events as never,
      db.userDeletion as never,
      buildBlockService(db),
      // Grants everything: these specs are about what the bulk actions DO, not
      // about who may run them. The permission split has its own spec.
      { hasPermission: async () => true } as never,
    ),
  );
}

function buildUserCard(db: Db): AdminUserManagementController {
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
    db.userDeletion as never,
    {} as never, // PartnersService
    {} as never, // PlansAdminService
    buildBlockService(db),
    { listForUser: async () => [], clear: async () => undefined } as never, // DeviceIntelligenceService
  );
}

/**
 * The REAL block service over the same fake client, not a stub.
 *
 * These tests assert that `is_blocked` actually moved, and the write moved
 * behind this service. A stub would make every one of them pass while nothing
 * was blocked at all — which is precisely the defect the service was extracted
 * to fix, reintroduced in the fixture.
 *
 * The VPN and identity halves stay absent: no fixture user has a subscription
 * or a panel link, and what these tests are about is the operator trail.
 */
function buildBlockService(db: Db): UserBlockService {
  return new UserBlockService(db.client as never, {
    captureFromUser: async () => ({ identities: 0, devices: 0 }),
    releaseCascadeForUser: async () => 0,
  } as never);
}

/** Three users, telegram ids 101/102/103, none blocked. */
function seedThree(): Db {
  return makeDb([makeUser('u-1', 101n), makeUser('u-2', 102n), makeUser('u-3', 103n)]);
}

function runBulk(db: Db, action: string, userIds: readonly string[], payload?: Record<string, unknown>) {
  return buildBulk(db).bulk({ action, userIds, payload } as never, ADMIN, REQ);
}

function auditRows(db: Db, action?: string): Array<Record<string, unknown>> {
  return db.state.auditLogs.filter((row) => action === undefined || row['action'] === action);
}

function metadataOf(row: Record<string, unknown>): Record<string, unknown> {
  return row['metadata'] as Record<string, unknown>;
}

/**
 * The query an operator actually runs: one action name, one subject id, no
 * knowledge of which screen performed it.
 *
 *   WHERE action = $action AND metadata->>'userId' = $userId
 */
function whoDid(
  logs: ReadonlyArray<Record<string, unknown>>,
  action: string,
  userId: string,
): Array<{ actor: unknown; source: unknown }> {
  return logs
    .filter((row) => row['action'] === action && metadataOf(row)['userId'] === userId)
    .map((row) => ({
      actor: ((row['adminUser'] as { connect?: { id?: string } } | undefined)?.connect ?? {}).id,
      source: metadataOf(row)['source'],
    }));
}

describe('bulk audit — the fake records audit rows (control)', () => {
  // Without this, every "the bulk run wrote no audit row" assertion below could
  // pass simply because nothing in this fake is capable of recording one.
  it('a single-user delete from the user card DOES produce an audit row through this fake', async () => {
    const db = seedThree();

    await buildUserCard(db).deleteUser('101', ADMIN, REQ);

    assert.equal(db.state.auditLogs.length, 1);
    assert.equal(auditRows(db)[0]['action'], 'user.deleted');
    assert.equal(metadataOf(auditRows(db)[0])['userId'], 'u-1');
    assert.deepEqual(auditRows(db)[0]['adminUser'], { connect: { id: 'admin-7' } });
    assert.deepEqual(
      db.state.users.map((u) => u.id),
      ['u-2', 'u-3'],
      'and the row really is gone',
    );
  });
});

describe('a bulk delete answers "who deleted user X" for each user', () => {
  it('leaves one audit row per deleted user', async () => {
    const db = seedThree();

    const result = await runBulk(db, 'delete', ['u-1', 'u-2', 'u-3']);

    assert.equal(result.succeeded, 3);
    assert.deepEqual(db.state.users, [], 'all three are gone');
    assert.equal(auditRows(db, 'user.deleted').length, 3, 'one row per user, not one per click');
    assert.deepEqual(
      auditRows(db, 'user.deleted').map((row) => metadataOf(row)['userId']),
      ['u-1', 'u-2', 'u-3'],
      'and each row names the user it removed',
    );
  });

  it('answers the per-user question for every one of them, from one query shape', async () => {
    const db = seedThree();

    await runBulk(db, 'delete', ['u-1', 'u-2', 'u-3']);

    for (const userId of ['u-1', 'u-2', 'u-3']) {
      assert.deepEqual(
        whoDid(db.state.auditLogs, 'user.deleted', userId),
        [{ actor: 'admin-7', source: 'bulk' }],
        `"who deleted ${userId}" has exactly one answer`,
      );
    }
  });

  it('the same query finds card deletions and bulk deletions alike', async () => {
    // One action name for one act, the origin in `metadata.source`. A reader
    // that has to union a second action name is a reader that will forget.
    const viaCard = seedThree();
    await buildUserCard(viaCard).deleteUser('101', ADMIN, REQ);

    const viaBulk = seedThree();
    await runBulk(viaBulk, 'delete', ['u-1']);

    const combined = [...viaCard.state.auditLogs, ...viaBulk.state.auditLogs];
    assert.deepEqual(
      combined.map((row) => row['action']),
      ['user.deleted', 'user.deleted'],
    );
    assert.deepEqual(whoDid(combined, 'user.deleted', 'u-1'), [
      { actor: 'admin-7', source: 'user_detail' },
      { actor: 'admin-7', source: 'bulk' },
    ]);
  });

  it('hands the database the same row shape the card writes, plus the batch', async () => {
    const db = seedThree();

    await runBulk(db, 'delete', ['u-1']);

    const row = auditRows(db, 'user.deleted')[0];
    const metadata = metadataOf(row);
    const batchId = metadata['batchId'];
    assert.equal(typeof batchId, 'string');
    assert.ok((batchId as string).length > 0, 'a batch id groups the rows of one click');
    assert.deepEqual(row, {
      action: 'user.deleted',
      ipAddress: '10.0.0.9',
      userAgent: 'panel/1.0',
      metadata: {
        requestId: 'req-42',
        source: 'bulk',
        batchId,
        userId: 'u-1',
        telegramId: '101',
      },
      adminUser: { connect: { id: 'admin-7' } },
    });
  });

  it('groups one click under one batch id, and two clicks under two', async () => {
    const db = seedThree();

    await runBulk(db, 'delete', ['u-1', 'u-2']);
    await runBulk(db, 'delete', ['u-3']);

    const batches = auditRows(db, 'user.deleted').map((row) => metadataOf(row)['batchId']);
    assert.equal(batches[0], batches[1], 'one click, one batch');
    assert.notEqual(batches[2], batches[0], 'a second click is a second batch');
    assert.equal(
      db.emitted.filter((e) => e.type === 'system.bulk_users_executed')[0]?.metadata['batchId'],
      batches[0],
      'and the run summary carries the same id, so the two streams join',
    );
  });
});

describe('block and unblock leave the same trail as the card does', () => {
  it('writes user.blocked per blocked user, under the card action name', async () => {
    const db = seedThree();

    await runBulk(db, 'block', ['u-1', 'u-2']);

    assert.deepEqual(
      db.state.users.map((u) => u.isBlocked),
      [true, true, false],
    );
    assert.deepEqual(
      auditRows(db, 'user.blocked').map((row) => metadataOf(row)['userId']),
      ['u-1', 'u-2'],
    );
    assert.deepEqual(whoDid(db.state.auditLogs, 'user.blocked', 'u-2'), [
      { actor: 'admin-7', source: 'bulk' },
    ]);
  });

  it('writes user.unblocked per unblocked user', async () => {
    const db = makeDb([makeUser('u-1', 101n, true), makeUser('u-2', 102n, true)]);

    await runBulk(db, 'unblock', ['u-1', 'u-2']);

    assert.deepEqual(
      db.state.users.map((u) => u.isBlocked),
      [false, false],
    );
    assert.deepEqual(
      auditRows(db, 'user.unblocked').map((row) => metadataOf(row)['userId']),
      ['u-1', 'u-2'],
    );
  });

  it('block from the card and block from the toolbar share one action name', async () => {
    const viaCard = seedThree();
    await buildUserCard(viaCard).blockUser('101', ADMIN, REQ);

    const viaBulk = seedThree();
    await runBulk(viaBulk, 'block', ['u-1']);

    assert.equal(viaCard.state.auditLogs[0]['action'], viaBulk.state.auditLogs[0]['action']);
    assert.equal(viaBulk.state.auditLogs[0]['action'], 'user.blocked');
    assert.equal(metadataOf(viaCard.state.auditLogs[0])['source'], 'user_detail');
    assert.equal(metadataOf(viaBulk.state.auditLogs[0])['source'], 'bulk');
    assert.equal(metadataOf(viaCard.state.auditLogs[0])['userId'], 'u-1');
    assert.equal(metadataOf(viaBulk.state.auditLogs[0])['userId'], 'u-1');
  });
});

describe('a partially failing run records what it did, and only that', () => {
  it('audits the two deletions that landed and not the one that threw', async () => {
    const db = seedThree();
    db.undeletable.add('u-2');

    const result = await runBulk(db, 'delete', ['u-1', 'u-2', 'u-3']);

    assert.equal(result.succeeded, 2);
    assert.equal(result.failed, 1);
    assert.deepEqual(
      result.items.map((item) => item.status),
      ['ok', 'error', 'ok'],
    );
    assert.deepEqual(
      db.deletionAttempts,
      ['u-1', 'u-2', 'u-3'],
      'the run carried on past the failure',
    );

    assert.deepEqual(
      auditRows(db, 'user.deleted').map((row) => metadataOf(row)['userId']),
      ['u-1', 'u-3'],
      'the trail names what was done, not what was attempted',
    );
    assert.deepEqual(whoDid(db.state.auditLogs, 'user.deleted', 'u-1'), [
      { actor: 'admin-7', source: 'bulk' },
    ]);
    assert.deepEqual(
      whoDid(db.state.auditLogs, 'user.deleted', 'u-2'),
      [],
      'the user who survived has no deletion row',
    );
    assert.deepEqual(
      db.state.users.map((u) => u.id),
      ['u-2'],
      'and really did survive',
    );

    // The run itself is still summarised, so the failure is not silent.
    const summary = db.emitted.filter((e) => e.type === 'system.bulk_users_executed');
    assert.equal(summary.length, 1);
    assert.equal(summary[0].metadata['succeeded'], 2);
    assert.equal(summary[0].metadata['failed'], 1);
  });

  it('writes no row for a token that resolves to nobody', async () => {
    const db = makeDb([makeUser('u-2', 102n)]);

    const result = await runBulk(db, 'block', ['u-2', 'u-missing']);

    assert.equal(result.succeeded, 1);
    assert.equal(result.skipped, 1, 'u-missing resolves to nobody');
    assert.deepEqual(
      auditRows(db, 'user.blocked').map((row) => metadataOf(row)['userId']),
      ['u-2'],
      'a token nobody answers to is not an act and leaves no row',
    );
  });

  it('re-runs the cascade for an account that is already blocked', async () => {
    // This used to answer "skipped — Already blocked", on the reading that a
    // second block is a no-op. It is not: `block()` writes the flag FIRST, so
    // an unreachable panel cannot lose it, and only THEN captures identities,
    // devices and the address before pushing the VPN state. Any of those can
    // throw — leaving an account that is flagged with nothing listed, an ACTIVE
    // panel profile and live connections.
    //
    // The operator's obvious move is to re-run the batch, and the skip made
    // that impossible: a half-executed ban could only be finished from the user
    // card. Re-running is safe — the flag write is idempotent, a duplicate
    // blocklist entry reports as a duplicate, and a second sync job supersedes
    // the first.
    const db = makeDb([makeUser('u-1', 101n, true)]);

    const result = await runBulk(db, 'block', ['u-1']);

    assert.equal(result.succeeded, 1);
    assert.equal(result.skipped, 0);
    assert.deepEqual(
      auditRows(db, 'user.blocked').map((row) => metadataOf(row)['userId']),
      ['u-1'],
    );
  });

  it('writes nothing at all for an empty selection', async () => {
    const db = seedThree();

    const result = await runBulk(db, 'delete', []);

    assert.equal(result.total, 0);
    assert.deepEqual(db.state.auditLogs, []);
    assert.deepEqual(db.state.users.length, 3);
  });
});

/**
 * The two parametric actions. They wrote NO audit row at all until 2026-08-23:
 * an operator could change the language or the subscription cap of a hundred
 * accounts from the toolbar and leave nothing behind, while the same change
 * made from the user card was logged. The control block at the top proves this
 * fake is capable of recording rows, so the zero these specs replace was real.
 *
 * They share the action name `user.profile.updated` with the card deliberately
 * — see the BULK_AUDIT_ACTION docblock. What follows pins the SHAPE that makes
 * one query answer "who changed this user", not merely that some row exists.
 */
describe('a bulk profile edit leaves the same trail as the card does', () => {
  it('writes one user.profile.updated per user, with the changes array and the new value', async () => {
    const db = seedThree();

    const result = await runBulk(db, 'set_language', ['u-1', 'u-2'], { language: 'en' });

    assert.equal(result.succeeded, 2);
    assert.deepEqual(
      db.state.users.map((u) => u.language ?? null),
      ['EN', 'EN', null],
      'the two selected rows really changed, and the unselected one did not',
    );

    const rows = auditRows(db, 'user.profile.updated');
    assert.equal(rows.length, 2, 'one row per user, not one per click');
    assert.deepEqual(
      rows.map((row) => metadataOf(row)['userId']),
      ['u-1', 'u-2'],
      'and each row names the user it changed',
    );
    assert.deepEqual(
      metadataOf(rows[0])['changes'],
      ['language'],
      'the same key the user card writes',
    );
    assert.equal(
      metadataOf(rows[0])['language'],
      'EN',
      'and the value it became: a row naming only the field answers half the question',
    );
    assert.equal(metadataOf(rows[0])['source'], 'bulk');
  });

  it('writes the same action name for a subscription-cap change, naming the new cap', async () => {
    const db = seedThree();

    const result = await runBulk(db, 'set_max_subscriptions', ['u-2'], { maxSubscriptions: 7 });

    assert.equal(result.succeeded, 1);
    assert.deepEqual(
      db.state.users.map((u) => u.maxSubscriptions ?? null),
      [null, 7, null],
      'only the selected row moved',
    );

    const rows = auditRows(db, 'user.profile.updated');
    assert.equal(rows.length, 1);
    assert.equal(metadataOf(rows[0])['userId'], 'u-2');
    assert.deepEqual(metadataOf(rows[0])['changes'], ['maxSubscriptions']);
    assert.equal(metadataOf(rows[0])['maxSubscriptions'], 7);
  });

  it('answers the per-user question from the same query shape the card answers', async () => {
    const db = seedThree();

    await runBulk(db, 'set_language', ['u-3'], { language: 'ru' });

    assert.deepEqual(
      whoDid(db.state.auditLogs, 'user.profile.updated', 'u-3'),
      [{ actor: 'admin-7', source: 'bulk' }],
      'action name plus metadata.userId, with no knowledge of which screen did it',
    );
  });

  it('writes nothing for a row the run refused on an invalid payload', async () => {
    const db = seedThree();

    const result = await runBulk(db, 'set_language', ['u-1'], { language: 'x' });

    assert.equal(result.succeeded, 0);
    assert.equal(db.state.users[0].language, undefined, 'and the row is untouched');
    assert.equal(
      db.state.auditLogs.length,
      0,
      'the log records what was DONE, and a refused row did nothing',
    );
  });

  it('groups one click under one batch id, as every other bulk action does', async () => {
    const db = seedThree();

    await runBulk(db, 'set_max_subscriptions', ['u-1', 'u-2', 'u-3'], { maxSubscriptions: 3 });

    const batches = new Set(
      auditRows(db, 'user.profile.updated').map((row) => metadataOf(row)['batchId']),
    );
    assert.equal(batches.size, 1, 'three rows, one batch');
    assert.ok([...batches][0], 'and the batch id is not empty');
  });
});
