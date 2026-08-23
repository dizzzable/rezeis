import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SubscriptionStatus } from '@prisma/client';

import { PanelLinkReconciliationService } from '../src/modules/profile-sync/panel-link-reconciliation.service';

/**
 * The damaged-row repair, tested against the two things that can go wrong with
 * it: it repairs a row it should not have touched, or it stays quiet about a row
 * it could not repair.
 *
 * EVERY ASSERTION HERE HAS A NON-EMPTY POSITIVE SIDE. A suite that only checks
 * "nothing was written" passes just as happily when the selection matched
 * nothing at all, and a repair that silently scans zero rows is the exact
 * failure this whole feature exists to end. So each case also pins WHICH row was
 * reached and WHAT was concluded about it.
 */

/** A live 2.x profile uuid, in the spelling a 3.x panel can no longer answer to. */
const DEAD_UUID = '330f2b38-1f1e-4f6a-9f2b-0a1b2c3d4e5f';

/**
 * Creation instants, as offsets from ONE anchor taken when this file loads.
 *
 * No calendar date appears: a literal date in a fixture ages, and the only thing
 * these rows have to say about time is which of them came FIRST — which is the
 * rule the holder probe orders by and the rule the merge derives its survivor
 * from.
 */
const MINUTE_MS = 60_000;
const CLOCK_ANCHOR = Date.now();
const minutesAgo = (minutes: number): Date => new Date(CLOCK_ANCHOR - minutes * MINUTE_MS);

/** A `subscriptions` row with every column the reconciliation reads set. */
function subscriptionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-fits',
    userId: 'user-1',
    status: SubscriptionStatus.ACTIVE,
    createdAt: minutesAgo(600),
    remnawaveId: null as string | null,
    remnawavePanelId: null as number | null,
    remnawavePanelUsername: 'rz_alice_sub',
    configUrl: 'https://sub.example.test/AAAshortAAA',
    ...overrides,
  };
}

/**
 * The three answers `RemnawaveApiService.getPanelShape()` can give about which
 * era of the panel API is answering.
 *
 * `'unknown'` is not a fourth era — it is the value version detection returns
 * for EVERY failure (401, timeout, DNS, an unconfigured token, a panel
 * mid-restart), which is why it gets a case of its own below rather than being
 * folded into either real era.
 */
const ERA_2X = {
  version: '2.8.1',
  addressing: 'uuid',
  connectionsApi: 'ip-control',
  userLookups: { byTelegramId: true, byEmail: true },
  usersStream: true,
};
const ERA_3X = {
  version: '3.3.2',
  addressing: 'id',
  connectionsApi: 'connections',
  userLookups: { byTelegramId: false, byEmail: false },
  usersStream: true,
};
const ERA_UNKNOWN = {
  version: null,
  addressing: 'unknown',
  connectionsApi: 'unknown',
  userLookups: { byTelegramId: true, byEmail: true },
  usersStream: false,
};

/**
 * Evaluates a Prisma `where` against a plain row.
 *
 * The fake DB has to do the filtering itself, because these cases are entirely
 * about WHICH rows the selection reaches. A `findMany` that answered a fixed
 * list would pass identically for a selection that had lost half its predicates.
 * Unknown operators THROW rather than being ignored — a silently-skipped
 * condition is how a widened filter would sneak past this suite.
 */
function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, condition]) => {
    if (field === 'OR') {
      return (condition as Array<Record<string, unknown>>).some((alt) => matchesWhere(row, alt));
    }
    if (field === 'AND') {
      return (condition as Array<Record<string, unknown>>).every((alt) => matchesWhere(row, alt));
    }
    if (field === 'NOT') {
      return !matchesWhere(row, condition as Record<string, unknown>);
    }
    if (condition !== null && typeof condition === 'object' && !Array.isArray(condition)) {
      const operators = condition as Record<string, unknown>;
      if ('not' in operators) return row[field] !== operators['not'];
      if ('gt' in operators) return String(row[field]) > String(operators['gt']);
      if ('in' in operators) return (operators['in'] as unknown[]).includes(row[field]);
      // The stale-identity shape test. A uuid always carries `-` and a decimal
      // panel id never does, so this one operator is the whole of the second
      // population's predicate — it is implemented rather than tolerated so a
      // selection that dropped it fails here instead of quietly widening.
      if ('contains' in operators) {
        const value = row[field];
        return typeof value === 'string' && value.includes(String(operators['contains']));
      }
      throw new Error(`unsupported where operator: ${JSON.stringify(condition)}`);
    }
    return row[field] === condition;
  });
}

/**
 * Sorts by a Prisma `orderBy`, or leaves the rows EXACTLY as the table holds
 * them when there is none.
 *
 * That asymmetry is the whole point of implementing it. A `findFirst` with no
 * `orderBy` gets whichever row the storage engine reached first, and this fake
 * reproduces that by handing back whichever row the array holds first — so a
 * probe that lost its ordering fails by naming the wrong row. A stub that sorted
 * regardless would make an unordered probe look deterministic and could never
 * fail for one.
 *
 * Unknown directions THROW rather than being ignored, for the same reason
 * `matchesWhere` throws on an unknown operator.
 */
function applyOrderBy(
  rows: Array<Record<string, unknown>>,
  orderBy: unknown,
): Array<Record<string, unknown>> {
  if (orderBy === undefined || orderBy === null) return rows;
  const terms = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, unknown>>;
  // `Array.prototype.sort` is stable, so rows equal on every term keep the order
  // the table holds them in — the same thing an equal-keyed SQL sort may do.
  return [...rows].sort((left, right) => {
    for (const term of terms) {
      for (const [field, direction] of Object.entries(term)) {
        if (direction !== 'asc' && direction !== 'desc') {
          throw new Error(`unsupported orderBy direction: ${JSON.stringify(direction)}`);
        }
        const rawLeft = left[field];
        const rawRight = right[field];
        const a = rawLeft instanceof Date ? rawLeft.getTime() : rawLeft;
        const b = rawRight instanceof Date ? rawRight.getTime() : rawRight;
        const cmp =
          typeof a === 'number' && typeof b === 'number'
            ? Math.sign(a - b)
            : String(a) === String(b)
              ? 0
              : String(a) < String(b)
                ? -1
                : 1;
        if (cmp !== 0) return direction === 'asc' ? cmp : -cmp;
      }
    }
    return 0;
  });
}

/** The SQL spellings of the columns the raw holder probe may order by. */
const SQL_COLUMN_TO_FIELD: Record<string, string> = {
  created_at: 'createdAt',
  id: 'id',
};

/**
 * Sorts the way the STATEMENT says to, or leaves the rows in table order when
 * the statement does not say.
 *
 * The write path's holder probe is raw SQL, so there is no `orderBy` object to
 * hand this fake — the ordering lives in the query text, and reading it back out
 * is the same assertion the rest of this suite makes about a `where`: what
 * matters is the exact query handed to Prisma. A probe that ignored the clause
 * would answer identically for an ordered and an unordered statement and could
 * never tell them apart.
 */
function orderedBySqlClause(
  rows: Array<Record<string, unknown>>,
  sql: string,
): Array<Record<string, unknown>> {
  const clause = /ORDER\s+BY\s+([\s\S]*?)\s+LIMIT/i.exec(sql);
  if (clause === null) return rows;
  const terms = (clause[1] ?? '').split(',').map((term) => {
    const parts = term.trim().replace(/"/g, '').split(/\s+/);
    const column = parts[0] ?? '';
    const direction = (parts[1] ?? 'ASC').toUpperCase() === 'DESC' ? 'desc' : 'asc';
    return { [SQL_COLUMN_TO_FIELD[column] ?? column]: direction };
  });
  return applyOrderBy(rows, terms);
}

interface PrismaHarness {
  readonly client: unknown;
  readonly table: Array<Record<string, unknown>>;
  readonly writes: unknown[];
  readonly transactions: number[];
  readonly rawLocks: unknown[];
  /** Every `$queryRaw` statement, so the exact SQL can be asserted on. */
  readonly rawQueries: unknown[];
  /**
   * Every READ statement, as `subscription.<method>`, in order.
   *
   * COUNTED, not merely observed. "This arm does not issue a query per row" is a
   * claim about how many statements ran, and a spy recording only THAT one ran
   * cannot tell a constant number of queries from an N+1 — which is the whole
   * risk of asking a live subscriptions table whether any two of its rows share
   * an identity.
   */
  readonly queries: string[];
}

/**
 * A Prisma stand-in over a mutable table.
 *
 * `updateMany` APPLIES what it matches, so a fence that stopped fencing does
 * not merely report a different count — it visibly overwrites the row, and the
 * table can be asserted on afterwards.
 */
function prismaHarness(
  rows: Array<Record<string, unknown>>,
  // The STATEMENT is handed to the probe, not just the fact that one ran, so a
  // case about the write path's `ORDER BY` can answer the way that statement
  // asks. A probe that ignores it — which is every existing one — is unaffected.
  conflictProbe: (query: unknown) => Array<Record<string, unknown>> = () => [],
): PrismaHarness {
  const table = rows;
  const writes: unknown[] = [];
  const transactions: number[] = [];
  const rawLocks: unknown[] = [];
  const rawQueries: unknown[] = [];
  const queries: string[] = [];

  const subscription = {
    // ORDERED THE WAY THE CALLER ASKED, and by `id` when it did not ask — which
    // is what the paged walk asks for anyway. The shared-identity members query
    // orders by `created_at`, and "the OLDEST row of a cluster survives" is a
    // claim about exactly that clause, so a query that lost it must be able to
    // hand back the wrong anchor here.
    findMany: async (input: {
      where: Record<string, unknown>;
      take: number;
      orderBy?: unknown;
    }): Promise<Array<Record<string, unknown>>> => {
      queries.push('subscription.findMany');
      return applyOrderBy(
        table.filter((row) => matchesWhere(row, input.where)),
        input.orderBy ?? { id: 'asc' },
      )
        .slice(0, input.take)
        .map((row) => ({ ...row }));
    },
    /**
     * The aggregate the shared-identity arm asks its ONE question with.
     *
     * `having` is EVALUATED, not tolerated: `{ <field>: { _count: { gt: n } } }`
     * is the only shape implemented and anything else THROWS. An arm that lost
     * its `having` would otherwise report every identity in the table as shared
     * and every row as somebody's duplicate — and would pass a suite whose fake
     * ignored the clause.
     */
    groupBy: async (input: {
      by: string[];
      where: Record<string, unknown>;
      having?: Record<string, unknown>;
      orderBy?: unknown;
      take?: number;
    }): Promise<Array<Record<string, unknown>>> => {
      queries.push('subscription.groupBy');
      const buckets = new Map<string, { key: Record<string, unknown>; count: number }>();
      for (const row of table.filter((candidate) => matchesWhere(candidate, input.where))) {
        const hash = JSON.stringify(input.by.map((field) => row[field]));
        const bucket = buckets.get(hash) ?? {
          key: Object.fromEntries(input.by.map((field) => [field, row[field]])),
          count: 0,
        };
        bucket.count += 1;
        buckets.set(hash, bucket);
      }
      let groups = [...buckets.values()];
      for (const [field, condition] of Object.entries(input.having ?? {})) {
        const aggregate = (condition as Record<string, unknown>)['_count'];
        const gt = (aggregate as Record<string, unknown> | undefined)?.['gt'];
        if (typeof gt !== 'number') {
          throw new Error(`unsupported having on ${field}: ${JSON.stringify(condition)}`);
        }
        groups = groups.filter((group) => group.count > gt);
      }
      const ordered = applyOrderBy(
        groups.map((group) => group.key),
        input.orderBy,
      );
      return input.take === undefined ? ordered : ordered.slice(0, input.take);
    },
    // Answers with the columns the caller SELECTED, not just the id: the
    // duplicate-pair diagnosis is a comparison of the holder's `userId` against
    // the scanned row's, and a stub that could only return an id would make
    // that comparison untestable — and, worse, would pass for a service that
    // never asked the question.
    // ORDERED THE WAY THE CALLER ASKED, and in TABLE ORDER when it did not ask.
    // The `find(...)` this used to be was deterministic by array order and could
    // therefore never fail for an unordered probe, which is exactly the defect a
    // cluster of three live rows on one profile exposes — see `applyOrderBy`.
    findFirst: async (input: { where: Record<string, unknown>; orderBy?: unknown }) => {
      queries.push('subscription.findFirst');
      const hit = applyOrderBy(
        table.filter((row) => matchesWhere(row, input.where)),
        input.orderBy,
      )[0];
      return hit === undefined
        ? null
        : {
            id: hit['id'],
            userId: hit['userId'],
            remnawaveId: hit['remnawaveId'],
            remnawavePanelId: hit['remnawavePanelId'],
            remnawavePanelUsername: hit['remnawavePanelUsername'],
          };
    },
    updateMany: async (input: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      writes.push(input);
      const matched = table.filter((row) => matchesWhere(row, input.where));
      matched.forEach((row) => Object.assign(row, input.data));
      return { count: matched.length };
    },
  };

  const client = {
    subscription,
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      transactions.push(transactions.length);
      return callback({
        $executeRaw: async (...args: unknown[]) => {
          rawLocks.push(args);
          return 1;
        },
        $queryRaw: async (query: unknown) => {
          rawQueries.push(query);
          return conflictProbe(query);
        },
        subscription,
      });
    },
  };

  return { client, table, writes, transactions, rawLocks, rawQueries, queries };
}

/**
 * The write path's holder probe, answered against the fake table by reading the
 * very statement the service handed Prisma.
 *
 * `LIMIT 1` with no `ORDER BY` is answered in TABLE ORDER, which is what
 * Postgres is entitled to do, so a probe that lost its ordering names the wrong
 * row here rather than passing because the fake sorted on its behalf.
 */
function holdersFromSql(
  rows: Array<Record<string, unknown>>,
  query: unknown,
  scannedId: string,
  panelId: number,
): Array<Record<string, unknown>> {
  const text = String((query as { text?: unknown }).text ?? '');
  const candidates = rows.filter(
    (row) =>
      row['id'] !== scannedId &&
      row['status'] !== SubscriptionStatus.DELETED &&
      (row['remnawaveId'] === String(panelId) || row['remnawavePanelId'] === panelId),
  );
  const first = orderedBySqlClause(candidates, text)[0];
  return first === undefined
    ? []
    : [
        {
          conflictId: first['id'],
          conflictUserId: first['userId'],
          conflictRemnawaveId: first['remnawaveId'],
          conflictPanelId: first['remnawavePanelId'],
          conflictPanelUsername: first['remnawavePanelUsername'],
        },
      ];
}

interface PanelHarness {
  readonly api: unknown;
  readonly resolveCalls: unknown[];
  readonly profileCalls: unknown[];
  /** Every adapter method the sweep invoked, in order. */
  readonly calls: string[];
}

/**
 * The panel adapter, answering only the three calls a repair may make.
 *
 * THE ABSENCE OF EVERY OTHER METHOD IS PART OF THE TEST. `createPanelUser`,
 * `deletePanelUser` and `updatePanelUser` are not stubbed, so a sweep that grew
 * a panel MUTATION would die here with "not a function" rather than quietly
 * changing a live panel. `calls` pins the same property positively.
 */
function panelHarness(input: {
  resolve?: (selector: unknown) => {
    id: number;
    shortUuid: string | null;
    username: string | null;
    uuid: string | null;
  } | null;
  profile?: (identity: unknown) => { kind: string; user?: Record<string, unknown> };
  shape?: () => Record<string, unknown>;
}): PanelHarness {
  const resolveCalls: unknown[] = [];
  const profileCalls: unknown[] = [];
  const calls: string[] = [];
  return {
    resolveCalls,
    profileCalls,
    calls,
    api: {
      // Defaults to 2.x, the era in which a uuid-shaped identity is CORRECT.
      // Every pre-existing case therefore keeps describing the panel it was
      // written against, and the stale population has to be switched on by a
      // case that means to test it.
      getPanelShape: async () => {
        calls.push('getPanelShape');
        return input.shape === undefined ? ERA_2X : input.shape();
      },
      resolvePanelIdentity: async (selector: unknown) => {
        calls.push('resolvePanelIdentity');
        resolveCalls.push(selector);
        return input.resolve === undefined
          ? { id: 5150, shortUuid: 'AAAshortAAA', username: 'rz_alice_sub', uuid: null }
          : input.resolve(selector);
      },
      getPanelUserOutcome: async (identity: unknown) => {
        calls.push('getPanelUserOutcome');
        profileCalls.push(identity);
        return input.profile === undefined
          ? { kind: 'ok', user: { description: 'reiwa_id: user-1', username: 'rz_alice_sub' } }
          : input.profile(identity);
      },
    },
  };
}

const SILENT_EVENTS = { info: () => undefined, warn: () => undefined, error: () => undefined };

function service(prisma: PrismaHarness, panel: PanelHarness): PanelLinkReconciliationService {
  return new PanelLinkReconciliationService(
    prisma.client as never,
    panel.api as never,
    SILENT_EVENTS as never,
  );
}

/** Every row the report mentions, repaired or not, in the order it reports them. */
function reportedIds(report: {
  repaired: ReadonlyArray<{ subscriptionId: string }>;
  unrepaired: ReadonlyArray<{ subscriptionId: string }>;
}): string[] {
  return [...report.repaired, ...report.unrepaired].map((row) => row.subscriptionId);
}

describe('PanelLinkReconciliationService — selection', () => {
  it('reaches only rows carrying the signature persistProfileLink left behind', async () => {
    // Four decoys, each missing exactly one half of the signature, plus the one
    // real casualty. A selection that dropped any predicate picks up its decoy.
    const prisma = prismaHarness([
      subscriptionRow({ id: 'sub-a-fits' }),
      subscriptionRow({ id: 'sub-b-retired', status: SubscriptionStatus.DELETED }),
      subscriptionRow({ id: 'sub-c-already-linked', remnawaveId: 'rem-existing', remnawavePanelId: 77 }),
      subscriptionRow({ id: 'sub-d-never-provisioned', remnawavePanelUsername: null }),
      subscriptionRow({ id: 'sub-e-no-config-url', configUrl: null }),
    ]);
    const panel = panelHarness({});

    const report = await service(prisma, panel).reconcile({ dryRun: true });

    assert.deepEqual(
      reportedIds(report),
      ['sub-a-fits'],
      'only the row with a panel username AND a config URL AND no identity may be touched',
    );
    assert.equal(report.scanned, 1);
    assert.equal(report.wouldLink, 1);
    // The panel is asked about that row and about nothing else: a widened
    // selection is also an unasked-for round-trip per decoy.
    assert.equal(panel.resolveCalls.length, 1);
  });

  it('prefers the config URL short UUID and never falls back to the name after it fails', async () => {
    const prisma = prismaHarness([
      subscriptionRow({ id: 'sub-a-short-uuid', configUrl: 'https://sub.example.test/AAAshortAAA' }),
      subscriptionRow({
        id: 'sub-b-no-short-uuid',
        userId: 'user-2',
        remnawavePanelUsername: 'rz_bob_sub',
        // Two path segments and no `/sub/` prefix: nothing here is profile
        // material, so the name is the only route left.
        configUrl: 'https://panel.example.test/dashboard/users',
      }),
    ]);
    const panel = panelHarness({
      // Both resolves fail, so a fallback would show up as a second call.
      resolve: () => null,
    });

    const report = await service(prisma, panel).reconcile({ dryRun: true });

    assert.deepEqual(panel.resolveCalls, [
      { shortUuid: 'AAAshortAAA' },
      { username: 'rz_bob_sub' },
    ]);
    assert.equal(report.unrepaired.length, 2, 'both rows must be reported, not skipped');
  });
});

describe('PanelLinkReconciliationService — panel era', () => {
  it('leaves uuid-shaped identities alone on a 2.x panel, where they are correct', async () => {
    // The whole second population, on the era that issued it. Every one of
    // these rows is HEALTHY here: 2.x keys users by uuid, so a uuid in
    // `remnawave_id` is the right value and rewriting it would strand the row.
    const prisma = prismaHarness([
      subscriptionRow({ id: 'sub-a-missing-identity' }),
      subscriptionRow({ id: 'sub-b-uuid-is-correct', remnawaveId: DEAD_UUID }),
      subscriptionRow({
        id: 'sub-c-uuid-no-username',
        remnawaveId: DEAD_UUID,
        remnawavePanelUsername: null,
      }),
    ]);
    const panel = panelHarness({ shape: () => ERA_2X });

    const report = await service(prisma, panel).reconcile({ dryRun: false });

    assert.deepEqual(
      reportedIds(report),
      ['sub-a-missing-identity'],
      'on 2.x only the missing-identity population exists',
    );
    assert.equal(report.panelEra, '2.x');
    assert.equal(report.staleIdentityScanned, 0);
    assert.equal(report.scanned, 1);
    // The positive half: the sweep did work, it just did not touch these rows.
    assert.equal(report.linked, 1);
    assert.equal(prisma.table[1]['remnawaveId'], DEAD_UUID, 'a 2.x uuid must survive untouched');
    assert.equal(prisma.table[2]['remnawaveId'], DEAD_UUID);
  });

  it('selects the stale uuid on a 3.x panel and rewrites it to the identity the panel reports', async () => {
    const prisma = prismaHarness([
      subscriptionRow({ id: 'sub-a-stale', remnawaveId: DEAD_UUID }),
    ]);
    const panel = panelHarness({ shape: () => ERA_3X });

    const report = await service(prisma, panel).reconcile({ dryRun: false });

    assert.equal(report.panelEra, '3.x');
    assert.equal(report.staleIdentityScanned, 1);
    assert.equal(report.linked, 1);
    const row = report.repaired[0];
    assert.equal(row.subscriptionId, 'sub-a-stale');
    assert.equal(row.storedRemnawaveId, DEAD_UUID, 'the operator must see the dead uuid');
    assert.equal(row.remnawaveId, '5150');
    assert.equal(row.holdsLiveIdentity, true, 'the write bound this row to the live profile');
    assert.equal(prisma.table[0]['remnawaveId'], '5150');
    assert.equal(prisma.table[0]['remnawavePanelId'], 5150);
    // Reads only. A sweep that ever created, renamed or deleted a panel profile
    // would show up right here.
    assert.deepEqual(panel.calls, [
      'getPanelShape',
      'resolvePanelIdentity',
      'getPanelUserOutcome',
    ]);
  });

  it('never selects a decimal identity on a 3.x panel — that row is healthy', async () => {
    const prisma = prismaHarness([
      // A different profile from the one the stale row resolves to, so this
      // case tests the SHAPE predicate and not the conflict probe.
      subscriptionRow({ id: 'sub-a-healthy-3x', remnawaveId: '7777', remnawavePanelId: 7777 }),
      subscriptionRow({ id: 'sub-b-stale', remnawaveId: DEAD_UUID }),
    ]);
    const panel = panelHarness({ shape: () => ERA_3X });

    const report = await service(prisma, panel).reconcile({ dryRun: true });

    assert.deepEqual(
      reportedIds(report),
      ['sub-b-stale'],
      'a decimal identity is exactly what a 3.x panel issues; it is not stale',
    );
    assert.equal(report.staleIdentityScanned, 1);
    assert.equal(report.wouldLink, 1, 'the stale row is still previewed as repairable');
  });

  it('leaves the stale population out when the panel will not say which era it is', async () => {
    const prisma = prismaHarness([
      subscriptionRow({ id: 'sub-a-missing-identity' }),
      subscriptionRow({ id: 'sub-b-uuid-unknown-era', remnawaveId: DEAD_UUID }),
    ]);
    const panel = panelHarness({ shape: () => ERA_UNKNOWN });

    const report = await service(prisma, panel).reconcile({ dryRun: false });

    assert.equal(report.panelEra, null, 'an unread era must be reported as unread, not guessed');
    assert.deepEqual(reportedIds(report), ['sub-a-missing-identity']);
    assert.equal(report.staleIdentityScanned, 0);
    assert.equal(report.linked, 1, 'the first population is unaffected by an unknown era');
    assert.equal(
      prisma.table[1]['remnawaveId'],
      DEAD_UUID,
      'a uuid must not be rewritten on a panel whose era was never established',
    );
  });

  it('leaves the stale population out when the era probe throws outright', async () => {
    const prisma = prismaHarness([
      subscriptionRow({ id: 'sub-a-missing-identity' }),
      subscriptionRow({ id: 'sub-b-uuid-unread-era', remnawaveId: DEAD_UUID }),
    ]);
    const panel = panelHarness({
      shape: () => {
        throw new Error('panel unreachable');
      },
    });

    const report = await service(prisma, panel).reconcile({ dryRun: false });

    assert.equal(report.panelEra, null);
    assert.deepEqual(reportedIds(report), ['sub-a-missing-identity']);
    assert.equal(report.linked, 1);
    assert.equal(prisma.table[1]['remnawaveId'], DEAD_UUID);
  });
});

describe('PanelLinkReconciliationService — stale rows that cannot be repaired', () => {
  it('names a stale row with no resolve route instead of skipping it silently', async () => {
    const prisma = prismaHarness([
      subscriptionRow({ id: 'sub-a-repairable', remnawaveId: DEAD_UUID }),
      subscriptionRow({
        id: 'sub-b-no-route',
        remnawaveId: DEAD_UUID,
        remnawavePanelUsername: null,
        configUrl: null,
      }),
    ]);
    const panel = panelHarness({ shape: () => ERA_3X });

    const report = await service(prisma, panel).reconcile({ dryRun: false });

    // The run is NOT a total failure — the other row was repaired — so this
    // cannot be satisfied by an implementation that simply broke.
    assert.equal(report.linked, 1);
    assert.equal(report.staleIdentityScanned, 2);
    assert.equal(report.unrepaired.length, 1);
    const stranded = report.unrepaired[0];
    assert.equal(stranded.subscriptionId, 'sub-b-no-route');
    assert.equal(stranded.outcome, 'staleIdentity');
    assert.equal(stranded.storedRemnawaveId, DEAD_UUID);
    assert.equal(stranded.holdsLiveIdentity, false);
    assert.match(stranded.reason ?? '', /no resolve route at all/);
    // It costs the panel nothing: one resolve for the repairable row, none for
    // the row there was no way to ask about.
    assert.equal(panel.resolveCalls.length, 1);
    assert.equal(prisma.table[1]['remnawaveId'], DEAD_UUID, 'nothing may be written for it');
  });

  it('refuses to invent a repair when the panel answers with the identity the row already holds', async () => {
    const prisma = prismaHarness([
      subscriptionRow({ id: 'sub-a-panel-disagrees', remnawaveId: DEAD_UUID }),
    ]);
    const panel = panelHarness({
      shape: () => ERA_3X,
      // A panel that reports a uuid for the profile, against the era probe.
      resolve: () => ({
        id: 5150,
        shortUuid: 'AAAshortAAA',
        username: 'rz_alice_sub',
        uuid: DEAD_UUID,
      }),
    });

    const report = await service(prisma, panel).reconcile({ dryRun: false });

    assert.equal(report.linked, 0);
    assert.equal(report.unrepaired.length, 1);
    const row = report.unrepaired[0];
    assert.equal(row.outcome, 'staleIdentity');
    assert.equal(row.storedRemnawaveId, DEAD_UUID);
    assert.equal(row.remnawaveId, DEAD_UUID);
    assert.equal(row.holdsLiveIdentity, true, 'the row already names the profile the panel reports');
    assert.match(row.reason ?? '', /nothing to rewrite/);
    assert.deepEqual(prisma.writes, []);
    // No ownership round-trip either: there is no adoption to prove when
    // nothing changes.
    assert.deepEqual(panel.profileCalls, []);
  });
});

describe('PanelLinkReconciliationService — duplicate pair', () => {
  it('reports both halves and flags the one bound to the live panel profile', async () => {
    // The production shape, with the polarity that catches operators out: the
    // OLDER row carries the history and a dead uuid, the NEWER duplicate the
    // importer minted carries the live decimal.
    const prisma = prismaHarness([
      subscriptionRow({ id: 'sub-a-original', remnawaveId: DEAD_UUID }),
      subscriptionRow({
        id: 'sub-z-duplicate',
        remnawaveId: '5150',
        remnawavePanelId: 5150,
      }),
    ]);
    const panel = panelHarness({ shape: () => ERA_3X });

    const report = await service(prisma, panel).reconcile({ dryRun: true });

    assert.equal(report.duplicatePairs, 1);
    assert.equal(report.scanned, 1, 'only the stale half is scanned; the holder is looked up');
    assert.deepEqual(report.repaired, [], 'a pair is never reported as repairable');
    assert.equal(report.unrepaired.length, 2, 'both halves must appear');

    const [scannedHalf, liveHalf] = report.unrepaired;
    assert.equal(scannedHalf.subscriptionId, 'sub-a-original');
    assert.equal(scannedHalf.outcome, 'duplicatePair');
    assert.equal(scannedHalf.duplicateOfSubscriptionId, 'sub-z-duplicate');
    assert.equal(scannedHalf.storedRemnawaveId, DEAD_UUID);
    assert.equal(
      scannedHalf.holdsLiveIdentity,
      false,
      'the older, legitimate-looking row is bound to nothing',
    );

    assert.equal(liveHalf.subscriptionId, 'sub-z-duplicate');
    assert.equal(liveHalf.outcome, 'duplicatePair');
    assert.equal(liveHalf.duplicateOfSubscriptionId, 'sub-a-original');
    assert.equal(liveHalf.storedRemnawaveId, '5150');
    assert.equal(
      liveHalf.holdsLiveIdentity,
      true,
      'the newer, wrong-looking row is the one holding the live profile — deleting it ' +
        "would fire a panel DELETE against a paying customer's profile",
    );
    assert.match(liveHalf.reason ?? '', /must NOT be deleted/);

    // Diagnosis only. Neither half is touched.
    assert.deepEqual(prisma.writes, []);
    assert.equal(prisma.table[0]['remnawaveId'], DEAD_UUID);
    assert.equal(prisma.table[1]['remnawaveId'], '5150');
  });

  it('calls a collision between two DIFFERENT customers a conflict, never a pair', async () => {
    const prisma = prismaHarness([
      subscriptionRow({ id: 'sub-a-mine', userId: 'user-1', remnawaveId: DEAD_UUID }),
      subscriptionRow({
        id: 'sub-z-somebody-else',
        userId: 'user-9',
        remnawaveId: '5150',
        remnawavePanelId: 5150,
      }),
    ]);
    const panel = panelHarness({ shape: () => ERA_3X });

    const report = await service(prisma, panel).reconcile({ dryRun: true });

    assert.equal(report.duplicatePairs, 0, 'two customers on one profile is not a duplicate pair');
    assert.equal(report.unrepaired.length, 1, 'no partner row is emitted for a genuine collision');
    const row = report.unrepaired[0];
    assert.equal(row.subscriptionId, 'sub-a-mine');
    assert.equal(row.outcome, 'conflict');
    assert.equal(row.duplicateOfSubscriptionId, null);
    assert.match(row.reason ?? '', /DIFFERENT customer \(user-9, not user-1\)/);
    assert.match(row.reason ?? '', /sub-z-somebody-else/);
    assert.deepEqual(prisma.writes, []);
  });

  it('diagnoses the pair on a real run too, and still writes nothing for it', async () => {
    // The write path asks the same question through its own raw probe, under
    // the advisory lock. A dry run that classified a pair while a real run
    // linked over it would be the worst of both.
    const prisma = prismaHarness(
      [subscriptionRow({ id: 'sub-a-original', remnawaveId: DEAD_UUID })],
      () => [
        {
          conflictId: 'sub-z-duplicate',
          conflictUserId: 'user-1',
          conflictRemnawaveId: '5150',
          conflictPanelId: 5150,
          conflictPanelUsername: 'rz_alice_sub',
        },
      ],
    );
    const panel = panelHarness({ shape: () => ERA_3X });

    const report = await service(prisma, panel).reconcile({ dryRun: false });

    assert.equal(report.duplicatePairs, 1);
    assert.equal(report.linked, 0);
    assert.equal(report.unrepaired.length, 2);
    assert.equal(report.unrepaired[0].outcome, 'duplicatePair');
    assert.equal(report.unrepaired[0].duplicateOfSubscriptionId, 'sub-z-duplicate');
    assert.equal(report.unrepaired[1].subscriptionId, 'sub-z-duplicate');
    assert.equal(report.unrepaired[1].holdsLiveIdentity, true);
    assert.equal(prisma.rawLocks.length, 1, 'the advisory lock is taken before the probe');
    assert.deepEqual(prisma.writes, [], 'a diagnosed pair is never merged by this sweep');
    assert.equal(prisma.table[0]['remnawaveId'], DEAD_UUID);
  });
});

/**
 * WHICH HOLDER A CLUSTER OF THREE NAMES.
 *
 * Three live rows on one panel profile is reachable, not a curiosity:
 * `RemnawaveImporterService` cannot match a 2.x-era row whose
 * `remnawave_panel_id` was never recorded, so every sync after the upgrade mints
 * ANOTHER subscription for the same profile. The holder probe then has more than
 * one row to choose from.
 *
 * IT IS NOT A REPORTING DETAIL. `DuplicateSubscriptionMergeService.discoverPairs`
 * runs this sweep in dry-run and takes `duplicateOfSubscriptionId` as the pair's
 * other half, so whichever row this probe names is the row a real merge retires.
 * The merge's own survivor rule is deterministic; this was the non-determinism
 * upstream of it.
 *
 * ASSERTED BY THE EXPECTED PARTNER, BY NAME. "Two runs agree" would pass for a
 * fake that happens to be stable while the production statement is not. The
 * claim is the stronger one: the OLDEST live holder is named — the same rule the
 * merge derives its survivor from and the one the fixed importer converges on
 * (`orderBy: { createdAt: 'asc' }`). Both tables below are seeded NEWEST FIRST
 * so that an unordered probe returns the wrong row.
 */
describe('PanelLinkReconciliationService — which holder a cluster of three names', () => {
  /** Newest holder first, oldest holder second, the stale scanned row last. */
  function cluster(): Array<Record<string, unknown>> {
    return [
      subscriptionRow({
        id: 'sub-y-newest-holder',
        remnawaveId: '5150',
        remnawavePanelId: 5150,
        createdAt: minutesAgo(5),
      }),
      subscriptionRow({
        id: 'sub-z-older-holder',
        remnawaveId: '5150',
        remnawavePanelId: 5150,
        createdAt: minutesAgo(90),
      }),
      subscriptionRow({
        id: 'sub-a-stale',
        remnawaveId: DEAD_UUID,
        createdAt: minutesAgo(900),
      }),
    ];
  }

  it('names the OLDEST live holder on the dry run, not the row the table happens to hold first', async () => {
    const prisma = prismaHarness(cluster());
    const panel = panelHarness({ shape: () => ERA_3X });

    const report = await service(prisma, panel).reconcile({ dryRun: true });

    // The positive side first: exactly one row was scanned, and it was diagnosed
    // — an assertion about WHICH partner was named proves nothing if the sweep
    // reached no rows at all.
    assert.equal(report.scanned, 1);
    // TWO pairs, and the count is the point of the whole cluster. The walk
    // reaches the stale row and names its holder; the two HOLDERS are a pair of
    // their own — both live, both storing '5150' — and no predicate over one row
    // at a time can see them. The first four rows below are the walk's pair; the
    // last two are the arm that reads stored identities.
    assert.equal(report.duplicatePairs, 2);
    assert.equal(report.sharedIdentityPairs, 1);
    assert.equal(report.unrepaired.length, 4);
    const [scanned, partner] = report.unrepaired;
    assert.equal(scanned.subscriptionId, 'sub-a-stale');
    assert.equal(scanned.outcome, 'duplicatePair');
    assert.equal(
      scanned.duplicateOfSubscriptionId,
      'sub-z-older-holder',
      'the OLDEST live holder is the canonical one — the row a merge would keep. ' +
        'sub-y-newest-holder is first in the table, so an unordered probe names it instead',
    );
    assert.match(scanned.reason ?? '', /sub-z-older-holder/);
    assert.equal(partner.subscriptionId, 'sub-z-older-holder');
    assert.equal(partner.holdsLiveIdentity, true);
    // The shared pair, anchored on the OLDER of the two holders — the row a
    // merge keeps — even though the table holds the newer one first.
    const [sharedOlder, sharedNewer] = report.unrepaired.slice(2);
    assert.equal(sharedOlder.subscriptionId, 'sub-z-older-holder');
    assert.equal(sharedOlder.duplicateOfSubscriptionId, 'sub-y-newest-holder');
    assert.equal(sharedNewer.subscriptionId, 'sub-y-newest-holder');
    assert.equal(sharedNewer.duplicateOfSubscriptionId, 'sub-z-older-holder');
    assert.equal(sharedOlder.resolvedBy, 'storedIdentity');
    assert.equal(sharedNewer.resolvedBy, 'storedIdentity');
    assert.equal(
      sharedOlder.holdsLiveIdentity && sharedNewer.holdsLiveIdentity,
      true,
      'both halves STORE the identity, so neither is the safe one to delete',
    );
    assert.deepEqual(prisma.writes, [], 'a diagnosis writes nothing');
  });

  it('names the same holder on the write path, whose raw probe carries the same order', async () => {
    // The write path asks through raw SQL under the advisory lock, so its
    // ordering lives in the statement text rather than in an `orderBy` object.
    // A dry run naming one holder while a real run named another would make the
    // preview an operator approves a different operation from the one they get.
    const rows = cluster();
    const prisma = prismaHarness(rows, (query) =>
      holdersFromSql(rows, query, 'sub-a-stale', 5150),
    );
    const panel = panelHarness({ shape: () => ERA_3X });

    const report = await service(prisma, panel).reconcile({ dryRun: false });

    assert.equal(prisma.rawLocks.length, 1, 'the probe ran under the advisory lock');
    // The walk's pair plus the two holders' own, exactly as on the dry run —
    // which is the property this case exists to pin.
    assert.equal(report.duplicatePairs, 2);
    assert.equal(report.sharedIdentityPairs, 1);
    assert.equal(report.linked, 0);
    assert.equal(report.unrepaired.length, 4);
    assert.equal(report.unrepaired[0].duplicateOfSubscriptionId, 'sub-z-older-holder');
    assert.equal(report.unrepaired[1].subscriptionId, 'sub-z-older-holder');
    assert.equal(report.unrepaired[1].holdsLiveIdentity, true);
    // AND THE STATEMENT ITSELF, because that is the thing that has to carry the
    // order into a real database — the fake only honours what the text says.
    assert.equal(prisma.rawQueries.length, 1);
    assert.match(
      String((prisma.rawQueries[0] as { text?: unknown }).text ?? ''),
      /ORDER\s+BY\s+"created_at"\s+ASC,\s+"id"\s+ASC\s+LIMIT\s+1/,
      'the write-path probe must order the same two columns, the same way, as the dry run',
    );
    assert.deepEqual(prisma.writes, [], 'a diagnosed pair is never linked over');
    assert.equal(prisma.table[2]['remnawaveId'], DEAD_UUID, 'and the stale row is left alone');
  });

  it('falls back to the id when two holders were created at the same instant', async () => {
    // `createdAt` alone is not a total order, and the merge REFUSES a pair whose
    // halves share an instant rather than guessing — but the report still has to
    // name the same pair every time it runs, or an operator re-reading it sees a
    // different cluster.
    const sameInstant = minutesAgo(90);
    const rows = [
      subscriptionRow({
        id: 'sub-z-later-id',
        remnawaveId: '5150',
        remnawavePanelId: 5150,
        createdAt: sameInstant,
      }),
      subscriptionRow({
        id: 'sub-b-earlier-id',
        remnawaveId: '5150',
        remnawavePanelId: 5150,
        createdAt: sameInstant,
      }),
      subscriptionRow({ id: 'sub-a-stale', remnawaveId: DEAD_UUID, createdAt: minutesAgo(900) }),
    ];
    const prisma = prismaHarness(rows);
    const panel = panelHarness({ shape: () => ERA_3X });

    const report = await service(prisma, panel).reconcile({ dryRun: true });

    assert.equal(report.duplicatePairs, 2);
    assert.equal(
      report.unrepaired[0].duplicateOfSubscriptionId,
      'sub-b-earlier-id',
      'the id settles the tie, and it is the LOWER one — the table holds the other first',
    );
    // The same tiebreak, on the arm that reads stored identities: `created_at`
    // is not a total order there either, and the anchor a pair is built on has
    // to be the same row every run or the operator's preview drifts.
    assert.equal(report.sharedIdentityPairs, 1);
    assert.equal(report.unrepaired[2].subscriptionId, 'sub-b-earlier-id');
    assert.equal(report.unrepaired[2].duplicateOfSubscriptionId, 'sub-z-later-id');
  });
});

/**
 * THE DUPLICATE WHOSE IDENTITY IS ALREADY WELL FORMED.
 *
 * The other selection asks "is THIS link broken?", which is a predicate over one
 * row and therefore cannot notice that a DIFFERENT row holds the same identity.
 * The moment both halves of a cluster carry a valid identity the cluster goes
 * invisible — and that is the state a merge LEAVES BEHIND, because the survivor
 * takes the duplicate's identity.
 *
 * WHAT COUNTS AS IDENTITY IS THE WHOLE RISK. Two immutable columns say "one
 * profile": `remnawave_id` and `remnawave_panel_id`. `remnawave_panel_username`
 * does NOT, and the cases below spend as much effort proving it is excluded as
 * proving the two real ones are included — panel usernames are deterministic, so
 * a deleted profile frees its name for the next one, and a pair built on a name
 * can be a live row and a dead row rather than two halves of one customer.
 */
describe('PanelLinkReconciliationService — duplicates that already name their profile', () => {
  /** Two live rows of ONE customer, both storing the identity the panel issued. */
  function sharedPair(): Array<Record<string, unknown>> {
    return [
      subscriptionRow({
        id: 'sub-p-newer-half',
        remnawaveId: '5150',
        remnawavePanelId: 5150,
        createdAt: minutesAgo(100),
      }),
      subscriptionRow({
        id: 'sub-q-older-half',
        remnawaveId: '5150',
        remnawavePanelId: 5150,
        createdAt: minutesAgo(800),
      }),
    ];
  }

  it('names two live rows that store one identity, anchored on the older one', async () => {
    const prisma = prismaHarness(sharedPair());
    const panel = panelHarness({ shape: () => ERA_3X });

    const report = await service(prisma, panel).reconcile({ dryRun: true });

    assert.equal(report.scanned, 0, 'neither row is broken, so the walk selects nothing');
    assert.equal(report.sharedIdentityPairs, 1);
    assert.equal(report.duplicatePairs, 1);
    assert.equal(report.unrepaired.length, 2);
    const [older, newer] = report.unrepaired;
    assert.equal(
      older.subscriptionId,
      'sub-q-older-half',
      'the OLDER row anchors the pair even though the table holds the newer one first',
    );
    assert.equal(older.duplicateOfSubscriptionId, 'sub-p-newer-half');
    assert.equal(newer.subscriptionId, 'sub-p-newer-half');
    assert.equal(newer.duplicateOfSubscriptionId, 'sub-q-older-half');
    assert.equal(older.outcome, 'duplicatePair');
    assert.equal(newer.outcome, 'duplicatePair');
    assert.equal(older.resolvedBy, 'storedIdentity', 'nothing was resolved; nothing needed to be');
    assert.equal(older.remnawaveId, '5150');
    assert.equal(older.storedRemnawaveId, '5150');
    assert.equal(older.panelId, 5150);
    // BOTH halves are bound. That is the difference from the pair a broken link
    // produces, and it is the fact that stops an operator deleting the
    // wrong-looking one — here there is no wrong-looking one.
    assert.equal(older.holdsLiveIdentity, true);
    assert.equal(newer.holdsLiveIdentity, true);
    assert.match(older.reason ?? '', /BOTH halves are bound/);
    assert.match(older.reason ?? '', /sub-q-older-half is the OLDER row/);
    // The panel is asked which ERA it is and nothing else: this pair is a
    // comparison of two local rows.
    assert.deepEqual(panel.calls, ['getPanelShape']);
  });

  it('anchors EVERY pair of a three-row cluster on the one oldest row', async () => {
    // "The oldest row survives" has to hold across the WHOLE cluster, not merely
    // within each pair. Pairing neighbours — (oldest, middle) and (middle,
    // newest) — would also merge eventually, but the middle row would survive
    // its own pair and the cluster would converge on it for a round, with the
    // report naming a row the operator should not keep. Every pair therefore has
    // the cluster's oldest row as one half.
    const prisma = prismaHarness([
      subscriptionRow({
        id: 'sub-m-middle',
        remnawaveId: '5150',
        remnawavePanelId: 5150,
        createdAt: minutesAgo(500),
      }),
      subscriptionRow({
        id: 'sub-n-newest',
        remnawaveId: '5150',
        remnawavePanelId: 5150,
        createdAt: minutesAgo(100),
      }),
      subscriptionRow({
        id: 'sub-o-oldest',
        remnawaveId: '5150',
        remnawavePanelId: 5150,
        createdAt: minutesAgo(900),
      }),
    ]);
    const panel = panelHarness({ shape: () => ERA_3X });

    const report = await service(prisma, panel).reconcile({ dryRun: true });

    assert.equal(report.sharedIdentityPairs, 2, 'three rows on one profile are two merges');
    // Each pair as an unordered set of ids, so this asserts the PAIRING and not
    // the order the two halves happen to be emitted in.
    const pairs = report.unrepaired
      .filter((row) => row.subscriptionId < String(row.duplicateOfSubscriptionId))
      .map((row) => `${row.subscriptionId}+${row.duplicateOfSubscriptionId}`)
      .sort();
    assert.deepEqual(pairs, ['sub-m-middle+sub-o-oldest', 'sub-n-newest+sub-o-oldest']);
    assert.equal(
      report.unrepaired.filter(
        (row) => row.subscriptionId === 'sub-o-oldest' && row.duplicateOfSubscriptionId !== null,
      ).length,
      2,
      'the oldest row is a half of BOTH pairs — it is what the whole cluster converges on',
    );
    assert.deepEqual(prisma.writes, [], 'and naming two merges still writes nothing');
  });

  it('does not pair two rows that share only a panel username', async () => {
    // THE DETERMINISTIC-USERNAME TRAP. `clampPanelUsername` makes the name a
    // function of the customer, so a profile that was deleted frees its name and
    // the NEXT profile provisioned for that customer inherits it. These two rows
    // carry one name and one config URL and TWO different profiles; merging them
    // would move a live subscription's history onto a dead row.
    const prisma = prismaHarness([
      subscriptionRow({
        id: 'sub-r-name-twin-a',
        remnawaveId: '7001',
        remnawavePanelId: 7001,
        remnawavePanelUsername: 'rz_bob_sub',
        configUrl: 'https://sub.example.test/SAMEshortSAME',
        createdAt: minutesAgo(700),
      }),
      subscriptionRow({
        id: 'sub-s-name-twin-b',
        remnawaveId: '7002',
        remnawavePanelId: 7002,
        remnawavePanelUsername: 'rz_bob_sub',
        configUrl: 'https://sub.example.test/SAMEshortSAME',
        createdAt: minutesAgo(200),
      }),
      ...sharedPair(),
    ]);
    const panel = panelHarness({ shape: () => ERA_3X });

    const report = await service(prisma, panel).reconcile({ dryRun: true });

    // The positive half, and it is what makes the negative half mean anything:
    // the arm DID run and DID find the real pair in the same table.
    assert.equal(report.sharedIdentityPairs, 1);
    assert.deepEqual(
      report.unrepaired.map((row) => row.subscriptionId).sort(),
      ['sub-p-newer-half', 'sub-q-older-half'],
      'a shared name and a shared config URL are not a shared identity',
    );
  });

  it('does not pair two rows of DIFFERENT customers that store one identity', async () => {
    // A genuine collision, not this defect's pair. `describeCollision` records
    // why: nothing ties two Users together, so "one customer the importer split
    // in two" and "two customers" are indistinguishable — and a merge moves
    // payments and referral spends between the two rows.
    const prisma = prismaHarness([
      subscriptionRow({
        id: 'sub-t-alice',
        userId: 'user-1',
        remnawaveId: '8000',
        remnawavePanelId: 8000,
        createdAt: minutesAgo(700),
      }),
      subscriptionRow({
        id: 'sub-u-mallory',
        userId: 'user-2',
        remnawaveId: '8000',
        remnawavePanelId: 8000,
        createdAt: minutesAgo(200),
      }),
      ...sharedPair(),
    ]);
    const panel = panelHarness({ shape: () => ERA_3X });

    const report = await service(prisma, panel).reconcile({ dryRun: true });

    assert.equal(report.sharedIdentityPairs, 1);
    assert.deepEqual(
      report.unrepaired.map((row) => row.subscriptionId).sort(),
      ['sub-p-newer-half', 'sub-q-older-half'],
      'two customers on one profile is a collision, and this arm claims no pair for it',
    );
  });

  it('does not treat rows with no identity at all as a group', async () => {
    // `remnawave_panel_id` carries no unique constraint and both columns are
    // nullable, so a grouping that included nulls would put every unprovisioned
    // row in one bucket and call the whole lot duplicates of each other.
    const unprovisioned = (id: string, minutes: number) =>
      subscriptionRow({
        id,
        remnawaveId: null,
        remnawavePanelId: null,
        // Neither route recorded, so the missing-identity arm does not select it
        // either — this case is about the grouping and nothing else.
        remnawavePanelUsername: null,
        configUrl: null,
        createdAt: minutesAgo(minutes),
      });
    const prisma = prismaHarness([
      unprovisioned('sub-v-blank-a', 500),
      unprovisioned('sub-w-blank-b', 400),
      unprovisioned('sub-x-blank-c', 300),
      ...sharedPair(),
    ]);
    const panel = panelHarness({ shape: () => ERA_3X });

    const report = await service(prisma, panel).reconcile({ dryRun: true });

    assert.equal(report.sharedIdentityPairs, 1);
    assert.deepEqual(
      report.unrepaired.map((row) => row.subscriptionId).sort(),
      ['sub-p-newer-half', 'sub-q-older-half'],
      'three rows sharing NULL share nothing',
    );
  });

  it('pairs two spellings of one profile through the numeric panel id when the panel cannot resolve', async () => {
    // The second angle, on its own. The older row was linked in the 2.x era and
    // its short UUID no longer resolves, so the WALK can only report it
    // unresolved — but both rows recorded panel id 5150, and a numeric panel id
    // names one profile forever.
    const prisma = prismaHarness([
      subscriptionRow({
        id: 'sub-a-two-x-era',
        remnawaveId: DEAD_UUID,
        remnawavePanelId: 5150,
        configUrl: 'https://sub.example.test/GONEshortGONE',
        createdAt: minutesAgo(900),
      }),
      subscriptionRow({
        id: 'sub-b-minted',
        remnawaveId: '5150',
        remnawavePanelId: 5150,
        createdAt: minutesAgo(100),
      }),
    ]);
    const panel = panelHarness({
      shape: () => ERA_3X,
      resolve: () => null,
    });

    const report = await service(prisma, panel).reconcile({ dryRun: true });

    // The walk did look and did fail — the positive control for the claim that
    // the pair below came from the panel id and not from a resolve.
    assert.equal(report.scanned, 1);
    assert.equal(report.unrepaired[0].subscriptionId, 'sub-a-two-x-era');
    assert.equal(report.unrepaired[0].outcome, 'unresolved');
    assert.equal(report.sharedIdentityPairs, 1);
    const [older, newer] = report.unrepaired.slice(1);
    assert.equal(older.subscriptionId, 'sub-a-two-x-era');
    assert.equal(older.duplicateOfSubscriptionId, 'sub-b-minted');
    assert.equal(newer.subscriptionId, 'sub-b-minted');
    assert.equal(
      older.storedRemnawaveId,
      DEAD_UUID,
      'the operator still sees the dead uuid this half holds',
    );
    assert.equal(
      older.remnawaveId,
      '5150',
      'the profile is spelled the way a 3.x panel spells it, which is the era this arm ran on',
    );
  });

  it('reports a pair the walk already named exactly once', async () => {
    // Both routes can see the same two rows: the walk resolves the stale half
    // onto profile 5150 and finds the holder, and the numeric angle sees the two
    // recorded panel ids. Reporting one pair as two is exactly the kind of
    // report an operator acts on twice.
    const prisma = prismaHarness([
      subscriptionRow({
        id: 'sub-a-stale-with-panel-id',
        remnawaveId: DEAD_UUID,
        remnawavePanelId: 5150,
        createdAt: minutesAgo(900),
      }),
      subscriptionRow({
        id: 'sub-b-holder',
        remnawaveId: '5150',
        remnawavePanelId: 5150,
        createdAt: minutesAgo(100),
      }),
    ]);
    const panel = panelHarness({ shape: () => ERA_3X });

    const report = await service(prisma, panel).reconcile({ dryRun: true });

    assert.equal(report.duplicatePairs, 1, 'one pair, however many routes can see it');
    assert.equal(report.sharedIdentityPairs, 0, 'the walk named it first');
    assert.equal(report.unrepaired.length, 2);
    assert.equal(report.unrepaired[0].subscriptionId, 'sub-a-stale-with-panel-id');
    assert.equal(report.unrepaired[0].resolvedBy, 'shortUuid');
    assert.equal(report.unrepaired[1].subscriptionId, 'sub-b-holder');
  });

  it('leaves the shared-identity arm out on a 2.x panel, where duplicates are not this defect', async () => {
    // The gate, and the fixture is chosen so that an UNGATED arm would fire: two
    // live rows of one customer recording the same numeric panel id. The numeric
    // angle has no era-relative shape test to exclude them, so only the gate
    // stands between this sweep and a merge nomination on a panel whose
    // duplicates this feature has not explained.
    const prisma = prismaHarness([
      subscriptionRow({ id: 'sub-a-missing-identity' }),
      subscriptionRow({
        id: 'sub-b-two-x-half',
        remnawaveId: DEAD_UUID,
        remnawavePanelId: 5150,
        createdAt: minutesAgo(800),
      }),
      subscriptionRow({
        id: 'sub-c-two-x-half',
        remnawaveId: '4f0d1c22-7a3e-4d55-9c81-2b6e7f8a9d10',
        remnawavePanelId: 5150,
        createdAt: minutesAgo(100),
      }),
    ]);
    const panel = panelHarness({ shape: () => ERA_2X });

    const report = await service(prisma, panel).reconcile({ dryRun: false });

    assert.equal(report.panelEra, '2.x');
    assert.equal(report.sharedIdentityPairs, 0);
    assert.equal(report.duplicatePairs, 0);
    assert.deepEqual(
      reportedIds(report),
      ['sub-a-missing-identity'],
      'a 2.x sweep reports the missing-identity population and nothing else',
    );
    // The arm did not merely find nothing — it never ran. A `groupBy` here would
    // mean the gate had moved from the caller into the query.
    assert.equal(
      prisma.queries.filter((query) => query === 'subscription.groupBy').length,
      0,
    );
    // The positive control: this sweep DID work, so "found no pair" is a fact
    // about the era and not about a run that reached no rows.
    assert.equal(report.linked, 1);
    assert.equal(prisma.table[1]['remnawaveId'], DEAD_UUID, 'a 2.x uuid survives untouched');
  });

  it('leaves the shared-identity arm out when the panel will not say which era it is', async () => {
    // `'unknown'` is what version detection returns for an unreachable panel, an
    // expired token and an unparseable body alike. FAIL CLOSED: an unread panel
    // must never be the thing that WIDENS what this sweep proposes to merge.
    const prisma = prismaHarness([
      subscriptionRow({ id: 'sub-a-missing-identity' }),
      ...sharedPair(),
    ]);
    const panel = panelHarness({ shape: () => ERA_UNKNOWN });

    const report = await service(prisma, panel).reconcile({ dryRun: false });

    assert.equal(report.panelEra, null, 'an unread era is reported as unread, not guessed');
    assert.equal(report.sharedIdentityPairs, 0);
    assert.equal(report.duplicatePairs, 0);
    assert.equal(
      prisma.queries.filter((query) => query === 'subscription.groupBy').length,
      0,
      'the arm did not run at all',
    );
    assert.equal(report.linked, 1, 'the first population is unaffected by an unknown era');
    assert.equal(prisma.table[1]['remnawaveId'], '5150', 'and the pair is left exactly as it was');
    assert.equal(prisma.table[2]['remnawaveId'], '5150');
  });

  it('writes nothing for a pair it names, even on a real run', async () => {
    // Detection must not be a write. The repairable row is the INERTNESS
    // CONTROL: without it "no write happened" would pass just as happily for a
    // harness that records no writes at all, or for a sweep that reached no rows.
    const prisma = prismaHarness([
      subscriptionRow({ id: 'sub-a-repairable' }),
      subscriptionRow({
        id: 'sub-p-newer-half',
        remnawaveId: '9001',
        remnawavePanelId: 9001,
        createdAt: minutesAgo(100),
      }),
      subscriptionRow({
        id: 'sub-q-older-half',
        remnawaveId: '9001',
        remnawavePanelId: 9001,
        createdAt: minutesAgo(800),
      }),
    ]);
    const panel = panelHarness({ shape: () => ERA_3X });

    const report = await service(prisma, panel).reconcile({ dryRun: false });

    assert.equal(report.sharedIdentityPairs, 1, 'the pair was named');
    // THE CONTROL: exactly one write happened on this run, and it is the
    // repairable row's — so the fake does record writes, and the sweep does
    // perform them.
    assert.equal(prisma.writes.length, 1);
    assert.equal(
      (prisma.writes[0] as { where: Record<string, unknown> }).where['id'],
      'sub-a-repairable',
    );
    assert.equal(report.linked, 1);
    assert.equal(prisma.table[0]['remnawaveId'], '5150');
    // And the pair is untouched, asserted on the ROWS rather than on the count.
    assert.equal(prisma.table[1]['remnawaveId'], '9001');
    assert.equal(prisma.table[1]['status'], SubscriptionStatus.ACTIVE);
    assert.equal(prisma.table[2]['remnawaveId'], '9001');
    assert.equal(prisma.table[2]['status'], SubscriptionStatus.ACTIVE);
  });

  it('costs the same number of queries whatever the table holds', async () => {
    // THE N+1 THIS ARM MUST NOT BE. It runs over a live subscriptions table, so
    // "which rows share an identity" has to be answered by aggregates rather
    // than by a probe per row or a self-join. Two tables, one three times the
    // size of the other, and the STATEMENT LIST has to be identical.
    const cluster = (user: string, identity: string, panelId: number) => [
      subscriptionRow({
        id: `sub-${identity}-old`,
        userId: user,
        remnawaveId: identity,
        remnawavePanelId: panelId,
        createdAt: minutesAgo(900),
      }),
      subscriptionRow({
        id: `sub-${identity}-new`,
        userId: user,
        remnawaveId: identity,
        remnawavePanelId: panelId,
        createdAt: minutesAgo(100),
      }),
    ];
    const small = prismaHarness([
      ...cluster('user-1', '6001', 6001),
      ...cluster('user-2', '6002', 6002),
    ]);
    const large = prismaHarness([
      ...cluster('user-1', '6001', 6001),
      ...cluster('user-2', '6002', 6002),
      ...cluster('user-3', '6003', 6003),
      ...cluster('user-4', '6004', 6004),
      ...cluster('user-5', '6005', 6005),
      ...cluster('user-6', '6006', 6006),
    ]);

    const smallReport = await service(small, panelHarness({ shape: () => ERA_3X })).reconcile({
      dryRun: true,
    });
    const largeReport = await service(large, panelHarness({ shape: () => ERA_3X })).reconcile({
      dryRun: true,
    });

    // The positive side: the bigger table really did produce more work, so the
    // equal query counts below are not two runs that both did nothing.
    assert.equal(smallReport.sharedIdentityPairs, 2);
    assert.equal(largeReport.sharedIdentityPairs, 6);
    assert.equal(large.table.length, small.table.length * 3);
    // THE STATEMENTS THEMSELVES, in order, not a count of some spy's calls:
    // one page of the walk's selection (which drains immediately — none of these
    // rows is broken), one aggregate per identity angle, one `IN` lookup for the
    // members those aggregates named.
    assert.deepEqual(small.queries, [
      'subscription.findMany',
      'subscription.groupBy',
      'subscription.groupBy',
      'subscription.findMany',
    ]);
    assert.deepEqual(large.queries, small.queries, 'three times the rows, the same statements');
    // And explicitly NOT a probe per row: `findFirst` is the per-row question
    // the walk asks, and this arm must never ask it.
    assert.equal(large.queries.filter((query) => query === 'subscription.findFirst').length, 0);
  });

  it('skips the member lookup entirely when nothing is shared', async () => {
    // The healthy database, which is the case this arm must cost the least in.
    const prisma = prismaHarness([
      subscriptionRow({ id: 'sub-a-solo', remnawaveId: '4001', remnawavePanelId: 4001 }),
      subscriptionRow({ id: 'sub-b-solo', remnawaveId: '4002', remnawavePanelId: 4002 }),
    ]);
    const panel = panelHarness({ shape: () => ERA_3X });

    const report = await service(prisma, panel).reconcile({ dryRun: true });

    assert.equal(report.sharedIdentityPairs, 0);
    assert.deepEqual(prisma.queries, [
      'subscription.findMany',
      'subscription.groupBy',
      'subscription.groupBy',
    ]);
  });
});

describe('PanelLinkReconciliationService — ownership', () => {
  it('refuses a profile carrying another user reiwa_id marker', async () => {
    const prisma = prismaHarness([subscriptionRow()]);
    const panel = panelHarness({
      profile: () => ({
        kind: 'ok',
        user: { description: 'name: Mallory\nreiwa_id: user-999', username: 'rz_alice_sub' },
      }),
    });

    const report = await service(prisma, panel).reconcile({ dryRun: false });

    assert.equal(report.linked, 0);
    assert.equal(report.unrepaired.length, 1);
    const refused = report.unrepaired[0];
    assert.equal(refused.subscriptionId, 'sub-fits');
    assert.equal(refused.outcome, 'notOwned');
    assert.match(refused.reason ?? '', /owned by reiwa_id user-999, not user-1/);
    // Nothing was written, and the row still has no identity.
    assert.deepEqual(prisma.writes, []);
    assert.equal(prisma.table[0]['remnawaveId'], null);
  });

  it('links a profile whose marker names this subscription owner', async () => {
    // The other half of the ownership assertion: a suite that only proves the
    // refusal would pass for an implementation that refuses everything.
    const prisma = prismaHarness([subscriptionRow()]);
    const panel = panelHarness({});

    const report = await service(prisma, panel).reconcile({ dryRun: false });

    assert.equal(report.linked, 1);
    assert.equal(report.repaired[0].outcome, 'linked');
    assert.equal(report.repaired[0].storedRemnawaveId, null, 'this row held no identity at all');
    assert.equal(report.repaired[0].holdsLiveIdentity, true);
    assert.equal(prisma.table[0]['remnawaveId'], '5150');
    assert.equal(prisma.table[0]['remnawavePanelId'], 5150);
  });
});

describe('PanelLinkReconciliationService — exclusivity', () => {
  it('takes the profile advisory lock and refuses a link another subscription holds', async () => {
    const prisma = prismaHarness([subscriptionRow()], () => [{ conflictId: 'sub-holder' }]);
    const panel = panelHarness({});

    const report = await service(prisma, panel).reconcile({ dryRun: false });

    assert.equal(report.linked, 0);
    assert.equal(report.unrepaired.length, 1);
    assert.equal(report.unrepaired[0].outcome, 'conflict');
    assert.match(report.unrepaired[0].reason ?? '', /sub-holder/);
    assert.equal(prisma.rawLocks.length, 1, 'the advisory lock is taken before the probe');
    assert.deepEqual(prisma.writes, []);
    assert.equal(prisma.table[0]['remnawaveId'], null);
  });

  it('does not overwrite a row a concurrent CREATE linked during the panel round-trip', async () => {
    const prisma = prismaHarness([subscriptionRow()]);
    const panel = panelHarness({
      // The interleaving, at the exact point it happens in production: the row
      // was NULL when the sweep selected it, and a CREATE links it while the
      // sweep is still talking to the panel.
      profile: () => {
        prisma.table[0]['remnawaveId'] = 'rem-created-concurrently';
        prisma.table[0]['remnawavePanelId'] = 4242;
        return {
          kind: 'ok',
          user: { description: 'reiwa_id: user-1', username: 'rz_alice_sub' },
        };
      },
    });

    const report = await service(prisma, panel).reconcile({ dryRun: false });

    // The CREATE's link survives untouched — asserted FIRST because it is the
    // harm, and a count-only assertion would report the same failure without
    // ever saying that a live profile had been detached.
    assert.equal(
      prisma.table[0]['remnawaveId'],
      'rem-created-concurrently',
      'the concurrent CREATE link must survive the repair',
    );
    assert.equal(prisma.table[0]['remnawavePanelId'], 4242);
    assert.equal(report.linked, 0);
    assert.equal(report.unrepaired.length, 1);
    assert.equal(report.unrepaired[0].outcome, 'raceLost');
    assert.equal(report.unrepaired[0].holdsLiveIdentity, false);
  });

  it('does not overwrite a stale row whose identity moved during the panel round-trip', async () => {
    // The same fence, on the other population. Here the row held a uuid when it
    // was selected and something re-linked it since, so the compare-and-swap
    // must miss rather than clobber whatever landed.
    const prisma = prismaHarness([
      subscriptionRow({ id: 'sub-a-stale', remnawaveId: DEAD_UUID }),
    ]);
    const panel = panelHarness({
      shape: () => ERA_3X,
      profile: () => {
        prisma.table[0]['remnawaveId'] = '9001';
        prisma.table[0]['remnawavePanelId'] = 9001;
        return {
          kind: 'ok',
          user: { description: 'reiwa_id: user-1', username: 'rz_alice_sub' },
        };
      },
    });

    const report = await service(prisma, panel).reconcile({ dryRun: false });

    assert.equal(prisma.table[0]['remnawaveId'], '9001', 'the newer link must survive');
    assert.equal(prisma.table[0]['remnawavePanelId'], 9001);
    assert.equal(report.linked, 0);
    assert.equal(report.unrepaired.length, 1);
    assert.equal(report.unrepaired[0].outcome, 'raceLost');
    assert.equal(report.unrepaired[0].storedRemnawaveId, DEAD_UUID);
  });
});

describe('PanelLinkReconciliationService — dry run', () => {
  it('writes nothing while still reporting what it would link', async () => {
    const prisma = prismaHarness([subscriptionRow()]);
    const panel = panelHarness({});

    const report = await service(prisma, panel).reconcile({});

    // The silence assertions come first, so a dry run that wrote says exactly
    // that instead of reporting a count. They are NOT the whole test: on their
    // own they would pass for a sweep that reached no rows at all, which is why
    // the positive half below pins the row it previewed.
    assert.deepEqual(prisma.writes, [], 'a dry run must not call updateMany');
    assert.deepEqual(prisma.transactions, [], 'a dry run must not open a write transaction');
    assert.deepEqual(prisma.rawLocks, [], 'a dry run must not take the advisory lock');
    assert.equal(prisma.table[0]['remnawaveId'], null);
    assert.equal(report.dryRun, true);
    assert.equal(report.wouldLink, 1, 'the preview must find the repairable row');
    assert.equal(report.linked, 0);
    assert.equal(report.repaired[0].outcome, 'wouldLink');
    assert.equal(report.repaired[0].remnawaveId, '5150');
    assert.equal(
      report.repaired[0].holdsLiveIdentity,
      false,
      'a preview wrote nothing, so the row is still bound to nothing',
    );
  });

  it('treats anything other than an explicit false as a dry run', async () => {
    const prisma = prismaHarness([subscriptionRow()]);
    const panel = panelHarness({});

    const report = await service(prisma, panel).reconcile({
      dryRun: 'false' as unknown as boolean,
    });

    assert.deepEqual(prisma.writes, []);
    assert.equal(report.dryRun, true);
    assert.equal(report.wouldLink, 1);
  });
});

describe('PanelLinkReconciliationService — reporting', () => {
  it('names every row it could not resolve instead of skipping it', async () => {
    const prisma = prismaHarness([
      subscriptionRow({ id: 'sub-a-resolvable' }),
      subscriptionRow({
        id: 'sub-b-orphan',
        userId: 'user-7',
        remnawavePanelUsername: 'rz_carol_sub',
        configUrl: 'https://sub.example.test/GONEGONEGONE',
      }),
    ]);
    const panel = panelHarness({
      resolve: (selector) =>
        (selector as { shortUuid?: string }).shortUuid === 'GONEGONEGONE'
          ? null
          : { id: 5150, shortUuid: 'AAAshortAAA', username: 'rz_alice_sub', uuid: null },
    });

    const report = await service(prisma, panel).reconcile({ dryRun: false });

    // The run is NOT a total failure — one row was repaired — so the reporting
    // assertion cannot be satisfied by an implementation that simply broke.
    assert.equal(report.linked, 1);
    assert.equal(report.scanned, 2);
    assert.equal(report.unrepaired.length, 1);
    const orphan = report.unrepaired[0];
    assert.equal(orphan.subscriptionId, 'sub-b-orphan');
    assert.equal(orphan.userId, 'user-7');
    assert.equal(orphan.panelUsername, 'rz_carol_sub');
    assert.equal(orphan.resolvedBy, 'shortUuid');
    assert.equal(orphan.outcome, 'unresolved');
    assert.match(orphan.reason ?? '', /GONEGONEGONE/);
  });

  it('reports a profile the panel resolved but could not read back as unresolved, not as missing data', async () => {
    const prisma = prismaHarness([subscriptionRow()]);
    const panel = panelHarness({ profile: () => ({ kind: 'unavailable' }) });

    const report = await service(prisma, panel).reconcile({ dryRun: false });

    assert.equal(report.linked, 0);
    assert.equal(report.unrepaired.length, 1);
    assert.equal(report.unrepaired[0].outcome, 'unresolved');
    assert.equal(report.unrepaired[0].remnawaveId, '5150');
    assert.deepEqual(prisma.writes, [], 'an unverified profile must never be linked');
  });

  it('does not claim more work remains once a multi-chunk walk has drained the selection', async () => {
    // `hasMore` is what tells the operator to run again. Latched once and never
    // cleared, it sends them round a loop that reports zero repairable rows
    // forever — the same "reported something that is not true" failure mode as
    // the job that completed having written nothing.
    const prisma = prismaHarness([
      subscriptionRow({ id: 'sub-a' }),
      subscriptionRow({ id: 'sub-b' }),
      subscriptionRow({ id: 'sub-c' }),
    ]);
    const panel = panelHarness({});

    const report = await service(prisma, panel).reconcile({ dryRun: true, chunkSize: 1 });

    assert.equal(report.scanned, 3, 'the walk must reach every row across its chunks');
    assert.equal(report.hasMore, false, 'nothing is left, so nothing may be promised');
  });

  it('walks the widened union one row at a time without looping or skipping', async () => {
    // Both populations interleaved by id, one row per chunk. The cursor is what
    // makes this terminate: advanced per ROW, it steps past rows a dry run left
    // in the selection, and a walk that stopped advancing would re-read the
    // first row until it hit the row cap.
    const prisma = prismaHarness([
      subscriptionRow({ id: 'sub-a-missing' }),
      subscriptionRow({ id: 'sub-b-stale', remnawaveId: DEAD_UUID }),
      subscriptionRow({ id: 'sub-c-missing' }),
      subscriptionRow({ id: 'sub-d-stale', remnawaveId: DEAD_UUID }),
    ]);
    const panel = panelHarness({ shape: () => ERA_3X });

    const report = await service(prisma, panel).reconcile({ dryRun: true, chunkSize: 1 });

    assert.deepEqual(
      reportedIds(report),
      ['sub-a-missing', 'sub-b-stale', 'sub-c-missing', 'sub-d-stale'],
      'every row exactly once, in id order, across both populations',
    );
    assert.equal(report.scanned, 4);
    assert.equal(report.staleIdentityScanned, 2);
    assert.equal(report.hasMore, false);
    assert.equal(report.nextCursor, 'sub-d-stale');
  });

  it('stops at the row cap and hands back a cursor to continue from', async () => {
    const prisma = prismaHarness([
      subscriptionRow({ id: 'sub-a' }),
      subscriptionRow({ id: 'sub-b' }),
      subscriptionRow({ id: 'sub-c' }),
    ]);
    const panel = panelHarness({});

    const report = await service(prisma, panel).reconcile({ dryRun: true, limit: 2, chunkSize: 1 });

    assert.equal(report.scanned, 2);
    assert.equal(report.hasMore, true);
    assert.equal(report.nextCursor, 'sub-b');
    assert.deepEqual(report.repaired.map((row) => row.subscriptionId), ['sub-a', 'sub-b']);
  });
});

describe('PanelLinkReconciliationService — stored identity spelling', () => {
  it('stores the uuid a 2.x panel returns rather than the numeric id', async () => {
    const prisma = prismaHarness([subscriptionRow()]);
    const panel = panelHarness({
      resolve: () => ({
        id: 5150,
        shortUuid: 'AAAshortAAA',
        username: 'rz_alice_sub',
        uuid: '330f2b38-1f1e-4f6a-9f2b-0a1b2c3d4e5f',
      }),
    });

    const report = await service(prisma, panel).reconcile({ dryRun: false });

    assert.equal(report.linked, 1);
    assert.equal(prisma.table[0]['remnawaveId'], '330f2b38-1f1e-4f6a-9f2b-0a1b2c3d4e5f');
    assert.equal(prisma.table[0]['remnawavePanelId'], 5150);
    // The profile read-back is addressed by that same uuid — a numeric probe
    // would 400 on a 2.x panel.
    assert.deepEqual(panel.profileCalls, [
      {
        remnawaveId: '330f2b38-1f1e-4f6a-9f2b-0a1b2c3d4e5f',
        panelId: 5150,
        panelUsername: null,
      },
    ]);
  });
});
