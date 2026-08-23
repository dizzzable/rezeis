import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ArgumentsHost, ConflictException, HttpStatus } from '@nestjs/common';

import {
  AdminSafeExceptionFilter,
  SAFE_PRODUCT_CODES,
} from '../src/common/filters/admin-safe-exception.filter';
import { WebPushService } from '../src/modules/push/services/web-push.service';

/**
 * `POST /admin/push/subscribe` AND THE TWO DIFFERENT THINGS ITS 409 MEANT.
 *
 * `subscribeAdmin` writes in two steps — a `updateMany` scoped to
 * `{ adminId, endpoint }`, then a `create` — so that neither half can reach a
 * row the caller does not own. The global `@unique` on `endpoint` is what makes
 * the second half safe: a row belonging to somebody else turns the INSERT into
 * a unique violation instead of a second row aimed at the same browser.
 *
 * A unique violation is one of THREE things, and the ROW decides which:
 *
 *   1. our own concurrent request won the insert (two tabs) — not a conflict;
 *   2. another admin holds the endpoint — refused, and rightly so;
 *   3. the blocking row had ALREADY GONE by the time we read it back — an
 *      unsubscribe or a fanout prune landing in the same window.
 *
 * (3) used to answer with the SAME `ConflictException` as (2). Nothing on the
 * wire told them apart, so `web/src/lib/push.ts` — whose `isEndpointTaken`
 * mapped any 409 on this route to `endpoint-taken` — told the operator that
 * "this browser is registered to another administrator", left the toggle off,
 * and sent them looking for an administrator who does not exist. A retry would
 * simply have worked: the row that blocked the INSERT was already gone.
 *
 * The two now differ in BOTH directions:
 *
 *   • (3) is retried in place, bounded by
 *     `WebPushService.ADMIN_SUBSCRIBE_ATTEMPTS`, and normally succeeds on the
 *     next pass — the operator sees no error at all.
 *   • only if every attempt loses the same way does it refuse, and then with a
 *     product code the client can branch on. The code is meaningless unless the
 *     safe filter forwards it, so the allowlist entry is asserted here too.
 *   • (2) is untouched: same status, same anonymous sentence, no product code,
 *     and NO retry — retrying a genuinely held endpoint is the loop this design
 *     has to be unable to enter.
 *
 * ── HOW THIS FILE ASSERTS ────────────────────────────────────────────────────
 *
 * The fake below is an in-memory `admin_web_push_subscriptions` that enforces
 * the real unique constraint and RECORDS THE ARGUMENTS of every call. Nothing
 * here asserts a bare call count as evidence of behaviour: "the other admin's
 * row is unchanged" is asserted against the row, and against a control that
 * proves the same fake does record a mutation when one happens.
 *
 * Fixture timestamps are relative. An absolute date in this repo was live when
 * written and silently became something else months later.
 */

const ENDPOINT = 'https://push.example.test/admin-endpoint-race';

/** The genuine cross-admin refusal, verbatim. It must keep naming nobody. */
const HELD_BY_ANOTHER_ADMIN =
  'This browser subscription is already registered to another administrator';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The fake's own ceiling on INSERT attempts. It exists so that an UNBOUNDED
 * retry fails this suite instead of hanging it: `node:test` has no default
 * per-test timeout, so a service that looped for ever would stall the run
 * rather than report anything.
 */
const FAKE_INSERT_CEILING = 20;

interface AdminRow {
  id: string;
  adminId: string;
  endpoint: string;
  p256dhKey: string;
  authKey: string;
  userAgent: string | null;
  failureCount: number;
  createdAt: Date;
  lastSeenAt: Date;
}

/**
 * One operation against the in-memory admin table, with the arguments it was
 * handed. `namesTheCaller` records whether the operation identified an admin at
 * all — a mutation for which that is false reaches whichever row holds the
 * endpoint, which is the original defect this method was split in two to end.
 */
interface TableCall {
  readonly op: 'updateMany' | 'create' | 'findUnique' | 'findFirst';
  readonly args: Record<string, unknown>;
  readonly namesTheCaller: boolean;
  readonly mutates: boolean;
}

/** Stands in for `PrismaClientKnownRequestError` P2002; the service matches the code. */
class FakeUniqueConstraintError extends Error {
  public readonly code = 'P2002';

  public constructor() {
    super('Unique constraint failed on the fields: (`endpoint`)');
  }
}

function makeRow(input: {
  readonly id: string;
  readonly adminId: string;
  readonly p256dhKey?: string;
  readonly authKey?: string;
  readonly userAgent?: string | null;
  readonly failureCount?: number;
}): AdminRow {
  const seededAt = new Date(Date.now() - 3 * DAY_MS);
  return {
    id: input.id,
    adminId: input.adminId,
    endpoint: ENDPOINT,
    p256dhKey: input.p256dhKey ?? 'seeded-p256dh',
    authKey: input.authKey ?? 'seeded-auth',
    userAgent: input.userAgent ?? 'Seeded browser',
    failureCount: input.failureCount ?? 0,
    createdAt: seededAt,
    lastSeenAt: seededAt,
  };
}

/**
 * `blockerVanishes` is the whole point of this fake.
 *
 *   'never'  — the read-back sees the blocking row, which is the ordinary
 *              cross-admin case.
 *   'once'   — the FIRST read-back finds the row gone: the unsubscribe (or the
 *              fanout prune) lands exactly in the window the service is
 *              reading. Nothing re-takes the endpoint afterwards, so the retry
 *              inserts cleanly.
 *   'always' — pathological churn: something re-takes the endpoint before every
 *              INSERT and releases it before every read-back, so no attempt can
 *              ever settle. This is the case a bound has to survive.
 */
function makeAdminPushDb(input: {
  readonly rows?: readonly AdminRow[];
  readonly blockerVanishes?: 'never' | 'once' | 'always';
  /**
   * A row that appears in the window between the caller's scoped `updateMany`
   * finding nothing and its own INSERT. That window exists only for a two-step
   * write, which is why this cannot be seeded into `rows`.
   */
  readonly insertRaceWinner?: AdminRow;
} = {}) {
  const rows: AdminRow[] = (input.rows ?? []).map((row) => ({ ...row }));
  const calls: TableCall[] = [];
  const vanishMode = input.blockerVanishes ?? 'never';
  let vanishesLeft = vanishMode === 'never' ? 0 : vanishMode === 'once' ? 1 : Number.POSITIVE_INFINITY;
  let reseedBlocker = false;
  let raceWinnerInserted = false;
  let generated = 0;

  const rowFor = (endpoint: string): AdminRow | undefined =>
    rows.find((row) => row.endpoint === endpoint);

  const adminWebPushSubscription = {
    updateMany: async (args: {
      where: { adminId: string; endpoint: string };
      data: {
        p256dhKey: string;
        authKey: string;
        userAgent: string | null;
        failureCount: number;
        lastSeenAt: Date;
      };
    }): Promise<{ count: number }> => {
      calls.push({ op: 'updateMany', args, namesTheCaller: true, mutates: true });
      const matched = rows.filter(
        (row) => row.adminId === args.where.adminId && row.endpoint === args.where.endpoint,
      );
      for (const row of matched) {
        row.p256dhKey = args.data.p256dhKey;
        row.authKey = args.data.authKey;
        row.userAgent = args.data.userAgent;
        row.failureCount = args.data.failureCount;
        row.lastSeenAt = args.data.lastSeenAt;
      }
      return { count: matched.length };
    },

    create: async (args: {
      data: {
        adminId: string;
        endpoint: string;
        p256dhKey: string;
        authKey: string;
        userAgent: string | null;
      };
    }): Promise<{ id: string }> => {
      calls.push({ op: 'create', args, namesTheCaller: true, mutates: true });
      if (calls.filter((call) => call.op === 'create').length > FAKE_INSERT_CEILING) {
        throw new Error(
          `fake prisma: a ${FAKE_INSERT_CEILING + 1}th INSERT — subscribeAdmin is not bounded`,
        );
      }
      if (reseedBlocker) {
        reseedBlocker = false;
        rows.push(makeRow({ id: 'churn-blocker', adminId: 'admin-churn' }));
      }
      if (input.insertRaceWinner !== undefined && !raceWinnerInserted) {
        raceWinnerInserted = true;
        rows.push({ ...input.insertRaceWinner });
      }
      if (rowFor(args.data.endpoint) !== undefined) {
        throw new FakeUniqueConstraintError();
      }
      generated += 1;
      const now = new Date();
      rows.push({
        id: `inserted-row-${generated}`,
        adminId: args.data.adminId,
        endpoint: args.data.endpoint,
        p256dhKey: args.data.p256dhKey,
        authKey: args.data.authKey,
        userAgent: args.data.userAgent,
        failureCount: 0,
        createdAt: now,
        lastSeenAt: now,
      });
      return { id: `inserted-row-${generated}` };
    },

    findUnique: async (args: {
      where: { endpoint: string };
    }): Promise<{ id: string; adminId: string } | null> => {
      calls.push({ op: 'findUnique', args, namesTheCaller: false, mutates: false });
      const index = rows.findIndex((row) => row.endpoint === args.where.endpoint);
      if (index === -1) return null;
      if (vanishesLeft > 0) {
        vanishesLeft -= 1;
        // The unsubscribe (or the fanout prune) commits HERE, between the
        // failed INSERT and this read. The row the service is asking about no
        // longer exists by the time the question is answered.
        rows.splice(index, 1);
        reseedBlocker = vanishMode === 'always';
        return null;
      }
      const row = rows[index] as AdminRow;
      return { id: row.id, adminId: row.adminId };
    },

    findFirst: async (args: {
      where: { adminId: string; endpoint: string };
    }): Promise<{ id: string } | null> => {
      calls.push({ op: 'findFirst', args, namesTheCaller: true, mutates: false });
      const row = rows.find(
        (candidate) =>
          candidate.adminId === args.where.adminId && candidate.endpoint === args.where.endpoint,
      );
      return row === undefined ? null : { id: row.id };
    },
  };

  const service = new WebPushService(
    { adminWebPushSubscription } as never,
    { getDecryptedWebPushConfig: async () => null } as never,
  );

  return {
    service,
    rows,
    calls,
    insertData: (): readonly Record<string, unknown>[] =>
      calls.filter((call) => call.op === 'create').map((call) => call.args.data as Record<string, unknown>),
  };
}

const CALLER = {
  adminId: 'admin-a',
  endpoint: ENDPOINT,
  p256dhKey: 'caller-p256dh',
  authKey: 'caller-auth',
  userAgent: 'Admin A browser',
} as const;

/** Exactly the row `subscribeAdmin` must ask the database to insert. */
const EXPECTED_INSERT = {
  adminId: 'admin-a',
  endpoint: ENDPOINT,
  p256dhKey: 'caller-p256dh',
  authKey: 'caller-auth',
  userAgent: 'Admin A browser',
};

// ── Controls ─────────────────────────────────────────────────────────────────
//
// Every "nothing was written" assertion below reads the fake's rows and its
// recorded arguments. These two prove the fake is not inert: it records the
// INSERT it is handed, and it applies an update to a row it holds. Without
// them, "the other admin's row is unchanged" would pass just as happily
// against a double that records nothing at all.

describe('admin push subscribe — the fake records writes (controls)', () => {
  it('records the INSERT arguments and holds the row it created', async () => {
    const db = makeAdminPushDb();

    const result = await db.service.subscribeAdmin({ ...CALLER });

    assert.deepStrictEqual(db.insertData(), [EXPECTED_INSERT]);
    assert.deepStrictEqual(result, { id: 'inserted-row-1' });
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0]?.adminId, 'admin-a');
  });

  it('records an update applied to a row it already holds', async () => {
    const db = makeAdminPushDb({
      rows: [makeRow({ id: 'admin-a-row', adminId: 'admin-a', failureCount: 2 })],
    });

    await db.service.subscribeAdmin({ ...CALLER });

    const [row] = db.rows;
    assert.equal(db.rows.length, 1);
    assert.equal(row?.p256dhKey, 'caller-p256dh');
    assert.equal(row?.authKey, 'caller-auth');
    assert.equal(row?.failureCount, 0);
  });
});

// ── 1. The vanished blocker recovers ─────────────────────────────────────────

describe('admin push subscribe — a blocker that vanished mid-request', () => {
  it('subscribes the caller instead of refusing, and inserts the caller\'s own row', async () => {
    const db = makeAdminPushDb({
      rows: [makeRow({ id: 'departing-row', adminId: 'admin-b' })],
      blockerVanishes: 'once',
    });

    const result = await db.service.subscribeAdmin({ ...CALLER });

    // The outcome the operator gets: a subscription, not a lecture about an
    // administrator who no longer holds anything.
    assert.deepStrictEqual(result, { id: 'inserted-row-1' });

    // The row, and the arguments the second INSERT was handed. Both attempts
    // asked for the CALLER's row; neither ever named `admin-b`.
    assert.deepStrictEqual(db.insertData(), [EXPECTED_INSERT, EXPECTED_INSERT]);
    assert.equal(db.rows.length, 1);
    const [row] = db.rows;
    assert.equal(row?.adminId, 'admin-a');
    assert.equal(row?.endpoint, ENDPOINT);
    assert.equal(row?.p256dhKey, 'caller-p256dh');
    assert.equal(row?.authKey, 'caller-auth');
    assert.equal(row?.userAgent, 'Admin A browser');

    // The property, not the call sequence: no mutation reached a row without
    // naming its owner.
    assert.deepStrictEqual(
      db.calls.filter((call) => call.mutates && !call.namesTheCaller),
      [],
    );
  });

  it('gives up after a bounded number of attempts when nothing ever settles', async () => {
    const db = makeAdminPushDb({
      rows: [makeRow({ id: 'churn-blocker', adminId: 'admin-churn' })],
      blockerVanishes: 'always',
    });

    await assert.rejects(
      db.service.subscribeAdmin({ ...CALLER }),
      (error: unknown) => {
        assert.equal(error instanceof ConflictException, true);
        assert.equal(
          error instanceof ConflictException ? error.getStatus() : null,
          HttpStatus.CONFLICT,
        );
        const body = error instanceof ConflictException ? error.getResponse() : null;
        assert.deepStrictEqual(body, {
          code: WebPushService.ENDPOINT_RACE_UNSETTLED_CODE,
          message: WebPushService.ENDPOINT_RACE_UNSETTLED_MESSAGE,
        });
        // NOT the cross-admin sentence: this refusal is transient and says so.
        assert.notEqual(
          error instanceof Error ? error.message : null,
          HELD_BY_ANOTHER_ADMIN,
        );
        return true;
      },
    );

    // Bounded, and bounded by the declared budget rather than by luck.
    assert.equal(WebPushService.ADMIN_SUBSCRIBE_ATTEMPTS, 3);
    assert.equal(db.insertData().length, WebPushService.ADMIN_SUBSCRIBE_ATTEMPTS);
    assert.deepStrictEqual(db.insertData(), [
      EXPECTED_INSERT,
      EXPECTED_INSERT,
      EXPECTED_INSERT,
    ]);
  });

  it('carries its code and its whole sentence through the safe exception filter', () => {
    assert.equal(SAFE_PRODUCT_CODES.has(WebPushService.ENDPOINT_RACE_UNSETTLED_CODE), true);

    const captured = runFilter(
      new ConflictException({
        code: WebPushService.ENDPOINT_RACE_UNSETTLED_CODE,
        message: WebPushService.ENDPOINT_RACE_UNSETTLED_MESSAGE,
      }),
    );

    assert.equal(captured.statusCode, HttpStatus.CONFLICT);
    const body = captured.body as Record<string, unknown>;
    assert.equal(body.code, WebPushService.ENDPOINT_RACE_UNSETTLED_CODE);
    assert.equal(body.errorCode, WebPushService.ENDPOINT_RACE_UNSETTLED_CODE);
    // The sentence survives the pattern scrub. A message carrying any word the
    // scrub removes arrives as "Request failed" and the operator is told
    // nothing at all.
    assert.equal(body.message, WebPushService.ENDPOINT_RACE_UNSETTLED_MESSAGE);
    assert.notEqual(body.message, 'Request failed');
  });
});

// ── 2. The genuine cross-admin refusal is untouched ──────────────────────────

describe('admin push subscribe — an endpoint another admin really holds', () => {
  it('refuses with the same status and the same sentence, and names nobody', async () => {
    const db = makeAdminPushDb({
      rows: [makeRow({ id: 'admin-b-row', adminId: 'admin-b' })],
    });

    await assert.rejects(
      db.service.subscribeAdmin({ ...CALLER }),
      (error: unknown) => {
        assert.equal(error instanceof ConflictException, true);
        assert.equal(
          error instanceof ConflictException ? error.getStatus() : null,
          HttpStatus.CONFLICT,
        );
        assert.equal(error instanceof Error ? error.message : null, HELD_BY_ANOTHER_ADMIN);
        // Nest's plain-string body, unchanged: `{ statusCode, message, error }`
        // and NO product code. The absence is the assertion — a code here
        // would reach the SPA through the safe filter and start a branch that
        // is not this refusal's to have.
        const body = (
          error instanceof ConflictException ? error.getResponse() : null
        ) as Record<string, unknown>;
        assert.deepStrictEqual(body, {
          statusCode: HttpStatus.CONFLICT,
          message: HELD_BY_ANOTHER_ADMIN,
          error: 'Conflict',
        });
        assert.equal('code' in body, false);
        // Names nobody: neither the admin who holds the row nor the row.
        const said = JSON.stringify(body);
        assert.equal(said.includes('admin-b'), false);
        assert.equal(said.includes('admin-b-row'), false);
        return true;
      },
    );
  });

  it('leaves the other admin\'s row exactly as it was', async () => {
    const seeded = makeRow({
      id: 'admin-b-row',
      adminId: 'admin-b',
      p256dhKey: 'admin-b-p256dh',
      authKey: 'admin-b-auth',
      userAgent: 'Admin B browser',
      // Non-zero on purpose: resetting it revives rows the fanout was two
      // failures into evicting.
      failureCount: 2,
    });
    const db = makeAdminPushDb({ rows: [seeded] });

    await db.service.subscribeAdmin({ ...CALLER }).catch(() => undefined);

    assert.deepStrictEqual(db.rows, [seeded]);
  });

  it('does not retry — one INSERT, then the refusal', async () => {
    const db = makeAdminPushDb({
      rows: [makeRow({ id: 'admin-b-row', adminId: 'admin-b' })],
    });

    await db.service.subscribeAdmin({ ...CALLER }).catch(() => undefined);

    // The bound alone would not be enough. A retry loop that treated a PRESENT
    // foreign row as retryable would press the same refusal `ADMIN_SUBSCRIBE_
    // ATTEMPTS` times and take three round trips to say what one said before.
    assert.deepStrictEqual(db.insertData(), [EXPECTED_INSERT]);
  });
});

// ── 3. Our own concurrent insert is still not a conflict ─────────────────────

describe('admin push subscribe — an insert race lost to the caller themselves', () => {
  it('treats it as a re-subscribe, not a retry and not a conflict', async () => {
    const db = makeAdminPushDb({
      insertRaceWinner: makeRow({
        id: 'admin-a-second-tab',
        adminId: 'admin-a',
        p256dhKey: 'second-tab-p256dh',
        authKey: 'second-tab-auth',
      }),
    });

    const result = await db.service.subscribeAdmin({ ...CALLER });

    // The second tab's row, refreshed with the keys THIS tab sent — one row
    // for one browser, and the caller's latest keys on it.
    assert.deepStrictEqual(result, { id: 'admin-a-second-tab' });
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0]?.p256dhKey, 'caller-p256dh');
    assert.equal(db.rows[0]?.authKey, 'caller-auth');

    // Exactly one INSERT: a row the caller already owns is not a race to retry.
    assert.deepStrictEqual(db.insertData(), [EXPECTED_INSERT]);
  });
});

interface CapturedResponse {
  statusCode?: number;
  body?: unknown;
}

function runFilter(exception: unknown): CapturedResponse {
  const captured: CapturedResponse = {};
  const response = {
    status(statusCode: number) {
      captured.statusCode = statusCode;
      return response;
    },
    json(body: unknown) {
      captured.body = body;
      return response;
    },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ originalUrl: '/admin/push/subscribe', headers: {} }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  new AdminSafeExceptionFilter().catch(exception, host);
  return captured;
}
