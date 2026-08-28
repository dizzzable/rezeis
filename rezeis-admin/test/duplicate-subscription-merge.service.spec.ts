import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SubscriptionStatus } from '@prisma/client';

import { AdminDuplicateSubscriptionMergeController } from '../src/modules/profile-sync/duplicate-subscription-merge.controller';
import { DuplicateSubscriptionMergeService } from '../src/modules/profile-sync/duplicate-subscription-merge.service';
import { PanelLinkReconciliationService } from '../src/modules/profile-sync/panel-link-reconciliation.service';

/**
 * The duplicate-pair merge, tested against the four ways it could go wrong:
 * it touches the panel, it keeps the wrong half, it merges two rows that are
 * not a pair, or it leaves something referencing the row it retired.
 *
 * EVERY ASSERTION HAS A NON-EMPTY POSITIVE SIDE. A suite that only proved
 * "nothing was written" passes just as happily for a merge that reached no rows
 * at all, so each case also pins WHICH row survived, WHAT it holds afterwards,
 * and WHERE every referencing row landed.
 */

/** A live 2.x profile uuid, in the spelling a 3.x panel can no longer answer to. */
const DEAD_UUID = '330f2b38-1f1e-4f6a-9f2b-0a1b2c3d4e5f';
/** What the operator's plan is called. The cabinet, the bot and every invoice render it. */
const PLAN_NAME = 'Годовой Премиум';

/**
 * The OLDER half: the customer's real subscription. It carries the history and
 * the operator's plan, and it is bound to NOTHING — its uuid names a profile a
 * 3.x panel does not answer to.
 */
function survivorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-old-survivor',
    userId: 'user-1',
    status: SubscriptionStatus.ACTIVE,
    createdAt: new Date('2025-01-11T09:00:00.000Z'),
    remnawaveId: DEAD_UUID as string | null,
    remnawavePanelId: null as number | null,
    remnawavePanelUsername: 'rz_alice_sub',
    configUrl: 'https://sub.example.test/OLDshortOLD',
    planSnapshot: { id: 'plan-year', name: PLAN_NAME },
    ...overrides,
  };
}

/**
 * The NEWER half: the row the importer minted after the identity split. It
 * stores the current decimal identity and IS the row pointing at the live
 * profile — and its `planSnapshot` is exactly what the importer invents, with
 * no `name` in it at all.
 */
function duplicateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-new-duplicate',
    userId: 'user-1',
    status: SubscriptionStatus.ACTIVE,
    createdAt: new Date('2026-08-02T11:00:00.000Z'),
    remnawaveId: '5150' as string | null,
    remnawavePanelId: 5150 as number | null,
    remnawavePanelUsername: 'rz_alice_sub',
    configUrl: 'https://sub.example.test/AAAshortAAA',
    planSnapshot: { importedFrom: 'remnawave', tag: 'BULK' },
    ...overrides,
  };
}

/**
 * Evaluates a Prisma `where` against a plain row.
 *
 * The fake has to filter for itself, because these cases are about WHICH rows a
 * statement reaches. Unknown operators THROW rather than being ignored — a
 * silently-skipped condition is how a widened fence would sneak past this suite.
 */
function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, condition]) => {
    if (field === 'OR') {
      return (condition as Array<Record<string, unknown>>).some((alt) => matchesWhere(row, alt));
    }
    if (field === 'AND') {
      return (condition as Array<Record<string, unknown>>).every((alt) => matchesWhere(row, alt));
    }
    if (field === 'NOT') return !matchesWhere(row, condition as Record<string, unknown>);
    if (condition !== null && typeof condition === 'object' && !Array.isArray(condition)) {
      const operators = condition as Record<string, unknown>;
      if ('not' in operators) return row[field] !== operators['not'];
      if ('in' in operators) return (operators['in'] as unknown[]).includes(row[field]);
      if ('gt' in operators) return String(row[field]) > String(operators['gt']);
      // The stale-identity shape test, needed here because the convergence case
      // drives the REAL reconciliation sweep against this table rather than a
      // stub. A uuid always carries `-` and a decimal panel id never does.
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
 * The asymmetry is the point, and it is the same one the reconciliation suite
 * relies on: a statement with no `ORDER BY` gets whichever row the storage
 * engine reached first, so a probe that lost its ordering must be able to name
 * the WRONG row here. A fake that sorted regardless could never fail for one —
 * and "the oldest row survives across a whole cluster" is exactly a claim about
 * ordering.
 *
 * Unknown directions THROW, for the same reason `matchesWhere` throws on an
 * unknown operator.
 */
function applyOrderBy(
  rows: Array<Record<string, unknown>>,
  orderBy: unknown,
): Array<Record<string, unknown>> {
  if (orderBy === undefined || orderBy === null) return rows;
  const terms = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, unknown>>;
  // `Array.prototype.sort` is stable, so rows equal on every term keep table order.
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

/** One recorded statement: which model, what it matched, what it wrote, in which transaction. */
interface RecordedWrite {
  readonly model: string;
  readonly where: Record<string, unknown>;
  readonly data: Record<string, unknown>;
  /** `null` when the statement ran OUTSIDE any transaction. */
  readonly tx: number | null;
  readonly matched: number;
}

const TABLE_NAMES = [
  'subscription',
  'transaction',
  'transactionItem',
  'promocodeActivation',
  'referralPointsExchange',
  'trialClaim',
  'subscriptionTerm',
  'addOnEntitlement',
  'subscriptionEffectiveProjection',
  'deviceReductionPlan',
  'entitlementIncident',
  'profileSyncJob',
  'user',
] as const;
type TableName = (typeof TABLE_NAMES)[number];

interface PrismaHarness {
  readonly client: unknown;
  readonly tables: Record<TableName, Array<Record<string, unknown>>>;
  readonly writes: RecordedWrite[];
  readonly transactions: number[];
  readonly rawLocks: unknown[];
  /**
   * Every READ statement, as `model.method`, in order.
   *
   * Counted rather than merely observed: "this pass does not issue a query per
   * row" is a claim about how many statements ran, and a spy that only recorded
   * THAT one ran could not tell a constant number of queries from an N+1.
   */
  readonly queries: string[];
  subscription(id: string): Record<string, unknown>;
  /**
   * Runs when the merge takes the profile advisory lock — which is INSIDE the
   * transaction, AFTER every pre-flight check and BEFORE the first statement.
   *
   * Not an arbitrary hook point: it is where the window actually is.
   * `pg_advisory_xact_lock` BLOCKS until whoever holds the profile key commits,
   * and that key is shared with `persistProfileLink` and the reconciliation
   * sweep's `writeLink` — so "checked, then waited an unbounded time, then
   * wrote" is the ordinary shape of a contended merge, not the unlucky one.
   * Everything another transaction commits during that wait is invisible to
   * every check that already ran.
   */
  onLock: (() => void) | null;
  /** The narrower window: after one statement of the merge and before the next. */
  afterWrite: ((write: RecordedWrite) => void) | null;
  /**
   * Commits a change the way ANOTHER transaction would — it SURVIVES this
   * merge's rollback.
   *
   * Without it a mid-flight insert would vanish along with the merge that
   * refused because of it, and every "nothing was orphaned" assertion below
   * would pass just as happily for a service with no guard at all: the row
   * would be gone either way. Rolling back therefore restores the snapshot and
   * then RE-APPLIES each external change, which is what really happens when one
   * transaction rolls back and another has already committed.
   */
  commitExternally(apply: () => void): void;
}

/**
 * The UNIQUE columns a merge writes, as `prisma/schema.prisma` declares them.
 *
 * Modelled rather than assumed away, because two of the failures this suite
 * makes claims about ARE these constraints: moving the duplicate's trial claim
 * onto a survivor that gained one of its own, and repointing
 * `users.current_subscription_id` at a subscription another user already names.
 * A fake that let both through could not tell a service that prevents them from
 * one that merely never met them.
 */
const UNIQUE_COLUMNS: Partial<Record<TableName, readonly string[]>> = {
  trialClaim: ['subscriptionId'],
  user: ['currentSubscriptionId'],
};

/** The shape Prisma raises, because the report is supposed to carry `P2002` back. */
function uniqueViolation(model: TableName, column: string, value: unknown): Error {
  const error = new Error(
    `Unique constraint failed on the fields: (\`${column}\`)`,
  ) as Error & { code: string; meta: Record<string, unknown> };
  error.name = 'PrismaClientKnownRequestError';
  error.code = 'P2002';
  error.meta = { modelName: model, target: [column], value };
  return error;
}

/**
 * A Prisma stand-in over mutable tables, with real rollback.
 *
 * ROLLBACK IS SIMULATED ON PURPOSE. The merge throws inside the transaction
 * when a fence loses, and relies on Prisma to undo the statements that already
 * ran. A fake that kept them would make the "nothing was written" assertion
 * pass for a service that had no rollback at all.
 *
 * `profileSyncJob` HAS NO `create`. That absence is part of the test: the only
 * way a panel DELETE ever happens is a `ProfileSyncJob` row with
 * `action: DELETE`, so a merge that grew one would die here with "not a
 * function" instead of quietly arming a deletion against a live profile.
 */
function prismaHarness(seed: Partial<Record<TableName, Array<Record<string, unknown>>>>): PrismaHarness {
  const tables = Object.fromEntries(
    TABLE_NAMES.map((name) => [name, seed[name] ?? []]),
  ) as Record<TableName, Array<Record<string, unknown>>>;
  const writes: RecordedWrite[] = [];
  const transactions: number[] = [];
  const rawLocks: unknown[] = [];
  const queries: string[] = [];
  /** What another transaction committed while this one was open. */
  let external: Array<() => void> = [];
  // THE TWO CLIENTS RECORD DIFFERENTLY, AND THAT IS THE POINT. Prisma's
  // interactive-transaction client holds its own connection: a statement issued
  // through the BASE client while a transaction happens to be open is not part
  // of it and does not roll back with it. A fake that shared one recorder
  // between them would report a statement that escaped the transaction as
  // though it were inside — which is exactly the defect the one-transaction
  // case exists to catch, so the two are built separately.
  const modelFor = (name: TableName, txOf: () => number | null) => ({
    count: async (input: { where: Record<string, unknown> }): Promise<number> =>
      tables[name].filter((row) => matchesWhere(row, input.where)).length,
    findMany: async (input: {
      where: Record<string, unknown>;
      select?: Record<string, boolean>;
      orderBy?: unknown;
      take?: number;
    }): Promise<Array<Record<string, unknown>>> => {
      queries.push(`${name}.findMany`);
      const ordered = applyOrderBy(
        tables[name].filter((row) => matchesWhere(row, input.where)),
        input.orderBy,
      );
      return (input.take === undefined ? ordered : ordered.slice(0, input.take)).map((row) =>
        input.select === undefined
          ? { ...row }
          : Object.fromEntries(Object.keys(input.select).map((key) => [key, row[key]])),
      );
    },
    // Ordered the way the caller asked, and TABLE ORDER when it did not ask —
    // see `applyOrderBy`. Used by the reconciliation sweep's holder probe, which
    // is what picks a cluster's merge partner.
    findFirst: async (input: {
      where: Record<string, unknown>;
      select?: Record<string, boolean>;
      orderBy?: unknown;
    }): Promise<Record<string, unknown> | null> => {
      queries.push(`${name}.findFirst`);
      const hit = applyOrderBy(
        tables[name].filter((row) => matchesWhere(row, input.where)),
        input.orderBy,
      )[0];
      if (hit === undefined) return null;
      return input.select === undefined
        ? { ...hit }
        : Object.fromEntries(Object.keys(input.select).map((key) => [key, hit[key]]));
    },
    /**
     * The aggregate the shared-identity arm asks its ONE question with.
     *
     * `having` is EVALUATED, not tolerated. `{ <field>: { _count: { gt: n } } }`
     * is the only shape implemented and anything else throws — an arm that lost
     * its `having` would otherwise report every identity in the table as shared
     * and every row as somebody's duplicate.
     */
    groupBy: async (input: {
      by: string[];
      where: Record<string, unknown>;
      having?: Record<string, unknown>;
      orderBy?: unknown;
      take?: number;
    }): Promise<Array<Record<string, unknown>>> => {
      queries.push(`${name}.groupBy`);
      const buckets = new Map<string, { key: Record<string, unknown>; count: number }>();
      for (const row of tables[name].filter((candidate) => matchesWhere(candidate, input.where))) {
        const key = Object.fromEntries(input.by.map((field) => [field, row[field]]));
        const hash = JSON.stringify(input.by.map((field) => row[field]));
        const bucket = buckets.get(hash) ?? { key, count: 0 };
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
    updateMany: async (input: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }> => {
      const matched = tables[name].filter((row) => matchesWhere(row, input.where));
      // THE CONSTRAINT IS CHECKED BEFORE THE STATEMENT IS RECORDED. A statement
      // that raised `P2002` never took effect, and the write log is replayed
      // elsewhere as though every entry in it applied — an entry for a statement
      // the database rejected would make that replay describe a state that never
      // existed.
      for (const column of UNIQUE_COLUMNS[name] ?? []) {
        // A statement that matches NOTHING cannot violate anything, which is not
        // a nicety: the merge issues both of these writes unconditionally, and
        // `trialClaim` moving zero claims onto a survivor that already holds one
        // is the ordinary, correct shape of a pair where only the survivor has
        // a claim.
        if (matched.length === 0) continue;
        if (!(column in input.data)) continue;
        const value = input.data[column];
        if (value === null || value === undefined) continue;
        if (matched.length > 1) throw uniqueViolation(name, column, value);
        const holder = tables[name].find(
          (row) => row[column] === value && !matched.includes(row),
        );
        if (holder !== undefined) throw uniqueViolation(name, column, value);
      }
      const write: RecordedWrite = {
        model: name,
        where: input.where,
        data: input.data,
        tx: txOf(),
        matched: matched.length,
      };
      writes.push(write);
      matched.forEach((row) => Object.assign(row, input.data));
      harness.afterWrite?.(write);
      return { count: matched.length };
    },
  });

  /** The base client. Every statement it carries ran OUTSIDE any transaction. */
  const baseModels = Object.fromEntries(TABLE_NAMES.map((name) => [name, modelFor(name, () => null)]));

  const snapshot = (): Record<TableName, Array<Record<string, unknown>>> =>
    Object.fromEntries(
      TABLE_NAMES.map((name) => [name, tables[name].map((row) => ({ ...row }))]),
    ) as Record<TableName, Array<Record<string, unknown>>>;

  const client = {
    ...baseModels,
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      const id = transactions.length;
      transactions.push(id);
      const before = snapshot();
      external = [];
      const txModels = Object.fromEntries(
        TABLE_NAMES.map((name) => [name, modelFor(name, () => id)]),
      );
      try {
        return await callback({
          ...txModels,
          $executeRaw: async (...args: unknown[]) => {
            rawLocks.push(args);
            // The advisory lock is the window. See `PrismaHarness.onLock`.
            harness.onLock?.();
            return 1;
          },
        });
      } catch (err: unknown) {
        for (const name of TABLE_NAMES) tables[name].splice(0, tables[name].length, ...before[name]);
        // ANOTHER TRANSACTION'S COMMIT SURVIVES OUR ROLLBACK. Restoring the
        // snapshot alone would also erase whatever it wrote, and then "no row
        // was orphaned onto the retired duplicate" would be true of a service
        // that refused AND of a service that never looked — because the row
        // would be gone either way.
        for (const apply of external) apply();
        throw err;
      }
    },
  };

  const harness: PrismaHarness = {
    client,
    tables,
    writes,
    transactions,
    rawLocks,
    queries,
    onLock: null,
    afterWrite: null,
    commitExternally(apply: () => void) {
      apply();
      external.push(apply);
    },
    subscription(id: string) {
      const row = tables.subscription.find((candidate) => candidate['id'] === id);
      assert.ok(row !== undefined, `the fake table has no subscription ${id}`);
      return row;
    },
  };
  return harness;
}

interface PanelHarness {
  readonly api: unknown;
  readonly calls: string[];
  readonly resolveCalls: unknown[];
}

/**
 * The panel client, answering only the two READS a merge may perform.
 *
 * THE ABSENCE OF EVERY OTHER METHOD IS PART OF THE TEST. `deleteUser`,
 * `createUser` and `updateUser` are not stubbed, so a merge that grew a panel
 * MUTATION dies here with "not a function" rather than quietly changing a live
 * panel. `calls` pins the same property positively, by exact list.
 *
 * There is no version method either, and that is deliberate: the merge never
 * asked the panel its era, and neither does the reconciliation sweep any more,
 * so a build that reintroduced the probe fails here rather than passing.
 *
 * The two callbacks keep the shapes the cases already speak — `null` for "the
 * panel does not know this key", `{ kind: 'missing' }` for a profile that is
 * gone — and this function translates them into the outcomes the client
 * actually returns.
 */
function panelHarness(
  input: {
    resolve?: (selector: Record<string, unknown>) => {
      id: number;
      shortUuid: string | null;
      username: string | null;
    } | null;
    profile?: () => { kind: string; user?: Record<string, unknown> };
  } = {},
): PanelHarness {
  const calls: string[] = [];
  const resolveCalls: unknown[] = [];
  const notFound = {
    kind: 'rejected' as const,
    status: 404,
    code: 'A025',
    detail: 'User not found',
    retryAfterMs: null,
  };
  return {
    calls,
    resolveCalls,
    api: {
      resolveUser: async (selector: Record<string, unknown>) => {
        calls.push('resolveUser');
        resolveCalls.push(selector);
        // Both halves of the canonical pair name ONE profile: the old row's
        // short UUID still resolves (the panel has no duplicates), and so does
        // the importer-written one.
        const resolved =
          input.resolve === undefined
            ? { id: 5150, shortUuid: 'AAAshortAAA', username: 'rz_alice_sub' }
            : input.resolve(selector);
        return resolved === null
          ? notFound
          : { kind: 'ok', drifted: false, data: { response: resolved } };
      },
      getUserById: async () => {
        calls.push('getUserById');
        const answer =
          input.profile === undefined
            ? { kind: 'ok', user: { description: 'reiwa_id: user-1', username: 'rz_alice_sub' } }
            : input.profile();
        if (answer.kind === 'ok') {
          return { kind: 'ok', drifted: false, data: { response: answer.user } };
        }
        return answer.kind === 'missing' ? notFound : { kind: 'network', detail: 'ECONNREFUSED' };
      },
    },
  };
}

const SILENT_EVENTS = { info: () => undefined, warn: () => undefined, error: () => undefined };

interface RecordedEvent {
  readonly severity: 'INFO' | 'WARNING' | 'ERROR';
  readonly message: string;
  readonly metadata: Record<string, unknown> | undefined;
}

/**
 * The system-event feed, kept rather than dropped.
 *
 * The SEVERITY is asserted on, not only the text: a batch that stopped and a
 * batch that finished having refused everything produce similar counts, and the
 * one thing that separates them in an operator's feed is that one is an ERROR.
 */
function recordingEvents(): { sink: RecordedEvent[]; api: unknown } {
  const sink: RecordedEvent[] = [];
  const push =
    (severity: RecordedEvent['severity']) =>
    (_type: string, _category: string, message: string, metadata?: Record<string, unknown>) => {
      sink.push({ severity, message, metadata });
    };
  return { sink, api: { info: push('INFO'), warn: push('WARNING'), error: push('ERROR') } };
}

/** Discovery is stubbed by default: these cases drive the merge by explicit pair. */
function reconciliationStub(
  unrepaired: Array<Record<string, unknown>> = [],
  extra: Record<string, unknown> = {},
) {
  return {
    calls: [] as unknown[],
    reconcile(options: unknown) {
      this.calls.push(options);
      return Promise.resolve({
        dryRun: true,
        unrepaired,
        repaired: [],
        hasMore: false,
        nextCursor: null,
        panelEra: '3.x',
        ...extra,
      });
    },
  };
}

function service(
  prisma: PrismaHarness,
  panel: PanelHarness,
  reconciliation: unknown = reconciliationStub(),
  events: unknown = SILENT_EVENTS,
): DuplicateSubscriptionMergeService {
  return new DuplicateSubscriptionMergeService(
    prisma.client as never,
    panel.api as never,
    reconciliation as never,
    events as never,
  );
}

const CANONICAL_PAIR = [
  { survivorSubscriptionId: 'sub-old-survivor', duplicateSubscriptionId: 'sub-new-duplicate' },
];

/**
 * The production gate, asked of the table rather than of the code.
 *
 * `SubscriptionDeletionService.deleteSubscription` creates its
 * `SyncAction.DELETE` job inside `if (current.remnawaveId !== null)`, and
 * `ProfileSyncProcessor.handleDelete` turns that job into `deletePanelUser`. On
 * a 3.x panel even a dead 2.x uuid reaches the LIVE profile, because
 * `panelUserAddress` falls back to the short UUID recovered from `config_url`.
 * So a retired row that still names a profile is a loaded gun for the next
 * manual delete, and the set of such rows must be EMPTY after any merge.
 */
function retiredRowsStillNamingAProfile(prisma: PrismaHarness): Array<Record<string, unknown>> {
  return prisma.tables.subscription.filter(
    (row) => row['status'] === SubscriptionStatus.DELETED && row['remnawaveId'] !== null,
  );
}

/**
 * Rows of `table` whose `column` names a subscription that is `DELETED`.
 *
 * THE ORPHAN, STATED AS THE SET IT IS. `BLOCKING_RELATIONS` says a term, an
 * add-on entitlement or a projection left naming a retired subscription is worse
 * than a refused merge, because nothing downstream ever joins through the
 * retired row again — so this set has to be EMPTY after every outcome, merged or
 * refused. A count of statements cannot say that: the harm is a row that exists,
 * not a write that happened.
 */
function orphanedOnRetiredRows(
  prisma: PrismaHarness,
  table: TableName,
  column: string,
): Array<Record<string, unknown>> {
  const retired = new Set(
    prisma.tables.subscription
      .filter((row) => row['status'] === SubscriptionStatus.DELETED)
      .map((row) => row['id']),
  );
  return prisma.tables[table].filter((row) => retired.has(row[column]));
}

describe('DuplicateSubscriptionMergeService — the merge', () => {
  it('moves the live identity onto the OLDER row and retires the newer duplicate', async () => {
    const prisma = prismaHarness({ subscription: [survivorRow(), duplicateRow()] });
    const panel = panelHarness();

    const report = await service(prisma, panel).merge({ dryRun: false, pairs: CANONICAL_PAIR });

    assert.equal(report.merged, 1);
    assert.equal(report.refused, 0);
    const row = report.rows[0];
    assert.equal(row.outcome, 'merged');
    assert.equal(row.survivorSubscriptionId, 'sub-old-survivor');
    assert.equal(row.duplicateSubscriptionId, 'sub-new-duplicate');
    assert.equal(row.remnawaveId, '5150');
    assert.equal(row.remnawavePanelId, 5150);
    // The undo values: where the identity came from, and what the survivor held.
    assert.equal(row.survivorPreviousRemnawaveId, DEAD_UUID);
    assert.equal(row.duplicatePreviousRemnawaveId, '5150');

    // The survivor is bound to the live profile and is still live.
    const survivor = prisma.subscription('sub-old-survivor');
    assert.equal(survivor['remnawaveId'], '5150');
    assert.equal(survivor['remnawavePanelId'], 5150);
    assert.equal(survivor['configUrl'], 'https://sub.example.test/AAAshortAAA');
    assert.equal(survivor['status'], SubscriptionStatus.ACTIVE);

    // The duplicate is retired AND names nothing.
    const duplicate = prisma.subscription('sub-new-duplicate');
    assert.equal(duplicate['status'], SubscriptionStatus.DELETED);
    assert.equal(duplicate['remnawaveId'], null);
    assert.equal(duplicate['remnawavePanelId'], null);
    assert.equal(duplicate['remnawavePanelUsername'], null);
    assert.equal(duplicate['configUrl'], null);

    // Exactly one LIVE row holds the identity. Two would be the state that lets
    // one subscription delete the other's service.
    const live = prisma.tables.subscription.filter(
      (candidate) =>
        candidate['status'] !== SubscriptionStatus.DELETED && candidate['remnawaveId'] === '5150',
    );
    assert.deepEqual(
      live.map((candidate) => candidate['id']),
      ['sub-old-survivor'],
    );
  });

  it('retires the duplicate with its identity cleared in the SAME statement, so no panel DELETE job can ever be created', async () => {
    // THE MOST IMPORTANT CASE IN THIS FILE. The DELETE job that reaches
    // `deletePanelUser` is created only for a row whose `remnawaveId` is not
    // null. A duplicate retired while still holding one is a panel deletion
    // waiting for the next operator to press delete — and on a 3.x panel the
    // dead uuid resolves through `config_url` to the LIVE profile, so the
    // wrong-looking half is just as dangerous as the right-looking one.
    const prisma = prismaHarness({ subscription: [survivorRow(), duplicateRow()] });
    const panel = panelHarness();

    const report = await service(prisma, panel).merge({ dryRun: false, pairs: CANONICAL_PAIR });
    assert.equal(report.merged, 1, 'the merge must actually have run for this to prove anything');

    // 1. No statement ever retires a row without clearing its identity in the
    //    same `data`. This is what fails if the two are split apart.
    const retirements = prisma.writes.filter(
      (write) => write.model === 'subscription' && write.data['status'] === SubscriptionStatus.DELETED,
    );
    assert.equal(retirements.length, 1, 'exactly one row is retired by a merge');
    assert.deepEqual(retirements[0].data, {
      remnawaveId: null,
      remnawavePanelId: null,
      remnawavePanelUsername: null,
      configUrl: null,
      status: SubscriptionStatus.DELETED,
    });
    assert.equal(retirements[0].matched, 1, 'the retirement reached the duplicate row');

    // 2. The resulting table carries no retired row that still names a profile.
    assert.deepEqual(
      retiredRowsStillNamingAProfile(prisma).map((row) => row['id']),
      [],
      'a DELETED row holding an identity is exactly what makes deleteSubscription enqueue a ' +
        'panel DELETE against a live profile',
    );

    // 3. The duplicate is retired BEFORE the survivor claims the identity, so
    //    there is never a moment — even a rolled-back one — with two live rows
    //    on one profile.
    const subscriptionWrites = prisma.writes.filter((write) => write.model === 'subscription');
    assert.equal(subscriptionWrites[0].where['id'], 'sub-new-duplicate');
    assert.equal(subscriptionWrites[1].where['id'], 'sub-old-survivor');
    assert.equal(subscriptionWrites[1].data['remnawaveId'], '5150');

    // 4. REPLAYED STATEMENT BY STATEMENT, not merely inspected at the end.
    //    The requirement is that the identity is gone BEFORE — or in the same
    //    statement as — the retirement, and a final-state check cannot tell
    //    that apart from clearing it one statement too late. This walks the
    //    write log and asserts the forbidden state never exists at any step.
    const replay = new Map<string, { status: unknown; remnawaveId: unknown }>(
      [survivorRow(), duplicateRow()].map((row) => [
        row.id,
        { status: row.status, remnawaveId: row.remnawaveId },
      ]),
    );
    for (const write of subscriptionWrites) {
      const state = replay.get(write.where['id'] as string);
      assert.ok(state !== undefined, 'a merge only ever writes to the two rows of the pair');
      if ('status' in write.data) state.status = write.data['status'];
      if ('remnawaveId' in write.data) state.remnawaveId = write.data['remnawaveId'];
      for (const [id, seen] of replay) {
        assert.ok(
          !(seen.status === SubscriptionStatus.DELETED && seen.remnawaveId !== null),
          `after the statement writing ${String(write.where['id'])}, subscription ${id} was ` +
            'DELETED while still naming a panel profile — for that instant, deleteSubscription ' +
            'would have enqueued a panel DELETE against a live profile',
        );
      }
    }
  });

  it('makes no panel mutation: two reads, and the mutating methods are not even present', async () => {
    const prisma = prismaHarness({ subscription: [survivorRow(), duplicateRow()] });
    const panel = panelHarness();

    const report = await service(prisma, panel).merge({ dryRun: false, pairs: CANONICAL_PAIR });

    assert.equal(report.merged, 1, 'a merge that did nothing proves nothing about the panel');
    assert.deepEqual(
      panel.calls,
      ['resolveUser', 'resolveUser', 'getUserById'],
      'one resolve per half plus one ownership read — no create, no update, no delete',
    );
    // The two resolves are independent: each half goes through its OWN route.
    assert.deepEqual(panel.resolveCalls, [
      { shortUuid: 'OLDshortOLD' },
      { shortUuid: 'AAAshortAAA' },
    ]);
  });

  it('does the whole merge in ONE transaction, with no statement outside it', async () => {
    const prisma = prismaHarness({
      subscription: [survivorRow(), duplicateRow()],
      transaction: [{ id: 'tx-1', subscriptionId: 'sub-new-duplicate' }],
    });
    const panel = panelHarness();

    const report = await service(prisma, panel).merge({ dryRun: false, pairs: CANONICAL_PAIR });

    assert.equal(report.merged, 1);
    assert.ok(prisma.writes.length >= 3, 'the merge must have written something');
    assert.equal(prisma.transactions.length, 1, 'a merge is one transaction, not several');
    assert.deepEqual(
      prisma.writes.filter((write) => write.tx === null).map((write) => write.model),
      [],
      'no statement of a merge may run outside the transaction — one that does is not rolled back ' +
        'when a later fence loses, and leaves a half-merged pair behind',
    );
    assert.deepEqual(
      [...new Set(prisma.writes.map((write) => write.tx))],
      [0],
      'every statement of a merge belongs to the SAME transaction',
    );
    assert.equal(prisma.rawLocks.length, 1, 'the advisory lock is taken before anything is written');
  });

  it('never writes planSnapshot, so the operator plan name survives the merge', async () => {
    const prisma = prismaHarness({ subscription: [survivorRow(), duplicateRow()] });
    const panel = panelHarness();

    const report = await service(prisma, panel).merge({ dryRun: false, pairs: CANONICAL_PAIR });

    assert.equal(report.merged, 1);
    assert.deepEqual(
      prisma.subscription('sub-old-survivor')['planSnapshot'],
      { id: 'plan-year', name: PLAN_NAME },
      "the survivor keeps the operator's plan; the importer's nameless snapshot must not land on it",
    );
    // The direction-complete half: not merely "the value is unchanged", but "no
    // statement mentioned the column at all". Prisma writes a `Json` column
    // WHOLESALE, so a write that mentioned it would have replaced it entirely.
    const touched = prisma.writes.filter((write) => 'planSnapshot' in write.data);
    assert.deepEqual(touched, [], 'planSnapshot must never appear in a merge write');
  });
});

describe('DuplicateSubscriptionMergeService — which half survives', () => {
  it('keeps the OLDER row, the one carrying the history', async () => {
    // The polarity of this defect is backwards from instinct: the older row
    // looks broken (it stores a dead uuid) and is the one worth keeping, and
    // the newer row looks right and is the disposable one.
    const prisma = prismaHarness({
      subscription: [survivorRow(), duplicateRow()],
      transaction: [
        { id: 'txn-paid-2025', subscriptionId: 'sub-old-survivor' },
        { id: 'txn-paid-2026', subscriptionId: 'sub-new-duplicate' },
      ],
    });
    const panel = panelHarness();

    const report = await service(prisma, panel).merge({ dryRun: false, pairs: CANONICAL_PAIR });

    assert.equal(report.merged, 1);
    assert.equal(report.rows[0].survivorSubscriptionId, 'sub-old-survivor');
    // The older row is still live and still carries its own history...
    assert.equal(prisma.subscription('sub-old-survivor')['status'], SubscriptionStatus.ACTIVE);
    assert.equal(
      (prisma.subscription('sub-old-survivor')['planSnapshot'] as Record<string, unknown>)['name'],
      PLAN_NAME,
    );
    // ...and the newer one is the one that went away.
    assert.equal(prisma.subscription('sub-new-duplicate')['status'], SubscriptionStatus.DELETED);
    // Both payments now hang off the survivor: the history did not split.
    assert.deepEqual(
      prisma.tables.transaction.map((row) => row['subscriptionId']),
      ['sub-old-survivor', 'sub-old-survivor'],
    );
  });

  it('refuses when the caller nominates the NEWER row as the survivor', async () => {
    const prisma = prismaHarness({ subscription: [survivorRow(), duplicateRow()] });
    const panel = panelHarness();

    const report = await service(prisma, panel).merge({
      dryRun: false,
      pairs: [
        // Backwards on purpose.
        { survivorSubscriptionId: 'sub-new-duplicate', duplicateSubscriptionId: 'sub-old-survivor' },
      ],
    });

    assert.equal(report.merged, 0);
    assert.equal(report.refused, 1);
    assert.equal(report.rows[0].refusal, 'survivorNotOlder');
    assert.match(report.rows[0].reason ?? '', /is the NEWER row/);
    assert.deepEqual(prisma.writes, [], 'a backwards merge writes nothing at all');
    assert.equal(prisma.subscription('sub-old-survivor')['status'], SubscriptionStatus.ACTIVE);
  });

  it('refuses a pair created at the same instant rather than guessing', async () => {
    const stamp = new Date('2026-03-03T03:03:03.000Z');
    const prisma = prismaHarness({
      subscription: [survivorRow({ createdAt: stamp }), duplicateRow({ createdAt: stamp })],
    });
    const panel = panelHarness();

    const report = await service(prisma, panel).merge({ dryRun: false, pairs: CANONICAL_PAIR });

    assert.equal(report.rows[0].refusal, 'survivorNotOlder');
    assert.match(report.rows[0].reason ?? '', /same instant/);
    assert.deepEqual(prisma.writes, []);
  });
});

describe('DuplicateSubscriptionMergeService — re-verification', () => {
  it('refuses two subscriptions belonging to DIFFERENT customers', async () => {
    const prisma = prismaHarness({
      subscription: [survivorRow(), duplicateRow({ userId: 'user-9' })],
      transaction: [{ id: 'txn-theirs', subscriptionId: 'sub-new-duplicate' }],
    });
    const panel = panelHarness();

    const report = await service(prisma, panel).merge({ dryRun: false, pairs: CANONICAL_PAIR });

    assert.equal(report.merged, 0);
    assert.equal(report.rows[0].refusal, 'differentCustomers');
    assert.match(report.rows[0].reason ?? '', /customer user-1 and sub-new-duplicate to customer user-9/);
    assert.deepEqual(prisma.writes, [], 'one customer must never receive another payments');
    assert.equal(
      prisma.tables.transaction[0]['subscriptionId'],
      'sub-new-duplicate',
      "the other customer's payment stays where it is",
    );
    // Refused before the panel was troubled at all.
    assert.deepEqual(panel.calls, []);
  });

  it('refuses two rows that resolve to DIFFERENT panel profiles', async () => {
    const prisma = prismaHarness({ subscription: [survivorRow(), duplicateRow()] });
    const panel = panelHarness({
      resolve: (selector) =>
        selector['shortUuid'] === 'OLDshortOLD'
          ? { id: 4040, shortUuid: 'OLDshortOLD', username: 'rz_alice_sub' }
          : { id: 5150, shortUuid: 'AAAshortAAA', username: 'rz_alice_sub' },
    });

    const report = await service(prisma, panel).merge({ dryRun: false, pairs: CANONICAL_PAIR });

    assert.equal(report.merged, 0);
    assert.equal(report.rows[0].refusal, 'differentPanelProfiles');
    assert.match(report.rows[0].reason ?? '', /panel profile 4040 and sub-new-duplicate resolves to panel profile 5150/);
    assert.deepEqual(prisma.writes, [], 'two real subscriptions are not a duplicate pair');
    // Both halves were asked, and the ownership read was never reached.
    assert.deepEqual(panel.calls, ['resolveUser', 'resolveUser']);
  });

  it('refuses a profile carrying another customer reiwa_id marker', async () => {
    const prisma = prismaHarness({ subscription: [survivorRow(), duplicateRow()] });
    const panel = panelHarness({
      profile: () => ({
        kind: 'ok',
        user: { description: 'name: Mallory\nreiwa_id: user-999', username: 'rz_alice_sub' },
      }),
    });

    const report = await service(prisma, panel).merge({ dryRun: false, pairs: CANONICAL_PAIR });

    assert.equal(report.rows[0].refusal, 'notOwned');
    assert.match(report.rows[0].reason ?? '', /owned by reiwa_id user-999, not user-1/);
    assert.deepEqual(prisma.writes, []);
  });

  it('refuses when a row is already retired', async () => {
    const prisma = prismaHarness({
      subscription: [
        survivorRow(),
        duplicateRow({ status: SubscriptionStatus.DELETED, remnawaveId: null }),
      ],
    });
    const panel = panelHarness();

    const report = await service(prisma, panel).merge({ dryRun: false, pairs: CANONICAL_PAIR });

    assert.equal(report.rows[0].refusal, 'alreadyRetired');
    assert.deepEqual(prisma.writes, []);
    assert.deepEqual(panel.calls, [], 'a retired half is not worth a panel round-trip');
  });

  it('refuses when neither row is bound to the profile they resolve to', async () => {
    const prisma = prismaHarness({
      subscription: [
        survivorRow(),
        // Resolves to 5150 by its short UUID but stores a different identity.
        duplicateRow({ remnawaveId: '9090', remnawavePanelId: 9090 }),
      ],
    });
    const panel = panelHarness();

    const report = await service(prisma, panel).merge({ dryRun: false, pairs: CANONICAL_PAIR });

    assert.equal(report.rows[0].refusal, 'neitherHoldsIdentity');
    assert.deepEqual(prisma.writes, []);
  });

  it('refuses a subscription id that names no row', async () => {
    const prisma = prismaHarness({ subscription: [survivorRow()] });
    const panel = panelHarness();

    const report = await service(prisma, panel).merge({ dryRun: false, pairs: CANONICAL_PAIR });

    assert.equal(report.rows[0].refusal, 'duplicateMissing');
    assert.deepEqual(prisma.writes, []);
  });
});

describe('DuplicateSubscriptionMergeService — reattachment', () => {
  it('follows the survivor with every relation that referenced the duplicate', async () => {
    const prisma = prismaHarness({
      subscription: [survivorRow(), duplicateRow()],
      transaction: [
        { id: 'txn-1', subscriptionId: 'sub-new-duplicate' },
        { id: 'txn-2', subscriptionId: 'sub-new-duplicate' },
        { id: 'txn-other', subscriptionId: 'sub-unrelated' },
      ],
      transactionItem: [{ id: 'item-1', subscriptionId: 'sub-new-duplicate' }],
      promocodeActivation: [{ id: 'promo-1', targetSubscriptionId: 'sub-new-duplicate' }],
      referralPointsExchange: [{ id: 'rpe-1', targetSubscriptionId: 'sub-new-duplicate' }],
      trialClaim: [{ id: 'claim-1', subscriptionId: 'sub-new-duplicate' }],
      user: [{ id: 'user-1', currentSubscriptionId: 'sub-new-duplicate' }],
      profileSyncJob: [
        { id: 'job-pending', subscriptionId: 'sub-new-duplicate', status: 'PENDING', supersededAt: null, cause: null },
        { id: 'job-done', subscriptionId: 'sub-new-duplicate', status: 'COMPLETED', supersededAt: null, cause: null },
      ],
    });
    const panel = panelHarness();

    const report = await service(prisma, panel).merge({ dryRun: false, pairs: CANONICAL_PAIR });

    assert.equal(report.merged, 1);
    // The enumeration is complete and reported relation by relation.
    assert.deepEqual(
      report.rows[0].reattached.map((moved) => `${moved.relation}=${moved.moved}`),
      [
        'transactions=2',
        'transactionItems=1',
        'promocodeActivations=1',
        'referralPointsExchanges=1',
        'trialClaim=1',
        'currentSubscriptionOf=1',
        'syncJobs=0',
      ],
    );

    // Each one actually landed on the survivor — and the unrelated row did not.
    assert.deepEqual(
      prisma.tables.transaction.map((row) => row['subscriptionId']),
      ['sub-old-survivor', 'sub-old-survivor', 'sub-unrelated'],
    );
    assert.equal(prisma.tables.transactionItem[0]['subscriptionId'], 'sub-old-survivor');
    assert.equal(prisma.tables.promocodeActivation[0]['targetSubscriptionId'], 'sub-old-survivor');
    assert.equal(prisma.tables.referralPointsExchange[0]['targetSubscriptionId'], 'sub-old-survivor');
    assert.equal(prisma.tables.trialClaim[0]['subscriptionId'], 'sub-old-survivor');
    assert.equal(prisma.tables.user[0]['currentSubscriptionId'], 'sub-old-survivor');

    // Sync jobs STAY on the retired row — but the non-terminal one is defused.
    assert.equal(report.rows[0].supersededSyncJobs, 1);
    assert.deepEqual(
      prisma.tables.profileSyncJob.map((row) => row['subscriptionId']),
      ['sub-new-duplicate', 'sub-new-duplicate'],
    );
    assert.equal(prisma.tables.profileSyncJob[0]['status'], 'COMPLETED');
    assert.notEqual(
      prisma.tables.profileSyncJob[0]['supersededAt'],
      null,
      'a PENDING DELETE job on the retired row names the LIVE profile in its payload; ' +
        'claimSyncJob only refuses it once supersededAt is set',
    );
    assert.equal(
      prisma.tables.profileSyncJob[1]['supersededAt'],
      null,
      'a COMPLETED job is history and is left alone',
    );
  });

  it('leaves the current-subscription pointer alone when it does not name the duplicate', async () => {
    const prisma = prismaHarness({
      subscription: [survivorRow(), duplicateRow()],
      user: [{ id: 'user-1', currentSubscriptionId: 'sub-old-survivor' }],
    });
    const panel = panelHarness();

    const report = await service(prisma, panel).merge({ dryRun: false, pairs: CANONICAL_PAIR });

    assert.equal(report.merged, 1);
    const pointer = report.rows[0].reattached.find((m) => m.relation === 'currentSubscriptionOf');
    assert.equal(pointer?.moved, 0);
    assert.equal(prisma.tables.user[0]['currentSubscriptionId'], 'sub-old-survivor');
  });
});

describe('DuplicateSubscriptionMergeService — refusals that protect data', () => {
  it('refuses when the duplicate carries entitlement-lifecycle history', async () => {
    const prisma = prismaHarness({
      subscription: [survivorRow(), duplicateRow()],
      subscriptionTerm: [{ id: 'term-1', subscriptionId: 'sub-new-duplicate' }],
      addOnEntitlement: [{ id: 'ent-1', subscriptionId: 'sub-new-duplicate' }],
    });
    const panel = panelHarness();

    const report = await service(prisma, panel).merge({ dryRun: false, pairs: CANONICAL_PAIR });

    assert.equal(report.merged, 0);
    assert.equal(report.rows[0].refusal, 'entitlementHistoryOnDuplicate');
    assert.match(report.rows[0].reason ?? '', /SubscriptionTerm: 1/);
    assert.match(report.rows[0].reason ?? '', /AddOnEntitlement: 1/);
    assert.deepEqual(prisma.writes, []);
  });

  it('refuses when BOTH rows hold a trial claim, because the column is unique', async () => {
    const prisma = prismaHarness({
      subscription: [survivorRow(), duplicateRow()],
      trialClaim: [
        { id: 'claim-old', subscriptionId: 'sub-old-survivor' },
        { id: 'claim-new', subscriptionId: 'sub-new-duplicate' },
      ],
    });
    const panel = panelHarness();

    const report = await service(prisma, panel).merge({ dryRun: false, pairs: CANONICAL_PAIR });

    assert.equal(report.rows[0].refusal, 'trialClaimOnBoth');
    assert.deepEqual(prisma.writes, []);
    assert.deepEqual(
      prisma.tables.trialClaim.map((row) => row['subscriptionId']),
      ['sub-old-survivor', 'sub-new-duplicate'],
      'neither claim moved',
    );
  });

  it('merges when only the SURVIVOR holds a trial claim', async () => {
    // The other side of the unique-column rule: a suite that only proved the
    // refusal would pass for an implementation that refused every trial row.
    const prisma = prismaHarness({
      subscription: [survivorRow(), duplicateRow()],
      trialClaim: [{ id: 'claim-old', subscriptionId: 'sub-old-survivor' }],
    });
    const panel = panelHarness();

    const report = await service(prisma, panel).merge({ dryRun: false, pairs: CANONICAL_PAIR });

    assert.equal(report.merged, 1);
    assert.equal(prisma.tables.trialClaim[0]['subscriptionId'], 'sub-old-survivor');
  });

  it('refuses while a sync job for the duplicate is RUNNING', async () => {
    const prisma = prismaHarness({
      subscription: [survivorRow(), duplicateRow()],
      profileSyncJob: [
        { id: 'job-live', subscriptionId: 'sub-new-duplicate', status: 'RUNNING', supersededAt: null },
      ],
    });
    const panel = panelHarness();

    const report = await service(prisma, panel).merge({ dryRun: false, pairs: CANONICAL_PAIR });

    assert.equal(report.rows[0].refusal, 'syncJobRunning');
    assert.deepEqual(prisma.writes, []);
    assert.equal(prisma.subscription('sub-new-duplicate')['status'], SubscriptionStatus.ACTIVE);
  });

  it('rolls the whole merge back when a row moves under it', async () => {
    const prisma = prismaHarness({
      subscription: [survivorRow(), duplicateRow()],
      transaction: [{ id: 'txn-1', subscriptionId: 'sub-new-duplicate' }],
    });
    const panel = panelHarness({
      // The last thing before the transaction opens. Moving the survivor's
      // identity here is the same race a concurrent link repair would cause.
      profile: () => {
        prisma.subscription('sub-old-survivor')['remnawaveId'] = 'somebody-else-got-here-first';
        return { kind: 'ok', user: { description: 'reiwa_id: user-1', username: 'rz_alice_sub' } };
      },
    });

    const report = await service(prisma, panel).merge({ dryRun: false, pairs: CANONICAL_PAIR });

    assert.equal(report.merged, 0);
    assert.equal(report.rows[0].refusal, 'raceLost');
    // The duplicate had ALREADY been retired inside the transaction before the
    // survivor's fence lost. A service without a rollback would leave the
    // customer with no live subscription at all.
    assert.equal(prisma.subscription('sub-new-duplicate')['status'], SubscriptionStatus.ACTIVE);
    assert.equal(prisma.subscription('sub-new-duplicate')['remnawaveId'], '5150');
    assert.equal(prisma.tables.transaction[0]['subscriptionId'], 'sub-new-duplicate');
  });
});

describe('DuplicateSubscriptionMergeService — dry run', () => {
  it('previews without writing, and reports what every relation would move', async () => {
    const prisma = prismaHarness({
      subscription: [survivorRow(), duplicateRow()],
      transaction: [{ id: 'txn-1', subscriptionId: 'sub-new-duplicate' }],
      trialClaim: [{ id: 'claim-1', subscriptionId: 'sub-new-duplicate' }],
      user: [{ id: 'user-1', currentSubscriptionId: 'sub-new-duplicate' }],
      profileSyncJob: [
        { id: 'job-pending', subscriptionId: 'sub-new-duplicate', status: 'PENDING', supersededAt: null },
      ],
    });
    const panel = panelHarness();

    const report = await service(prisma, panel).merge({ dryRun: true, pairs: CANONICAL_PAIR });

    assert.equal(report.dryRun, true);
    assert.equal(report.wouldMerge, 1);
    assert.equal(report.merged, 0);
    const row = report.rows[0];
    assert.equal(row.outcome, 'wouldMerge');
    assert.equal(row.remnawaveId, '5150');
    assert.deepEqual(
      row.reattached.map((moved) => `${moved.relation}=${moved.moved}`),
      [
        'transactions=1',
        'transactionItems=0',
        'promocodeActivations=0',
        'referralPointsExchanges=0',
        'trialClaim=1',
        'currentSubscriptionOf=1',
        'syncJobs=0',
      ],
      'the preview counts the same relations the write moves',
    );
    assert.equal(row.supersededSyncJobs, 1);

    // Nothing at all was written.
    assert.deepEqual(prisma.writes, []);
    assert.equal(prisma.transactions.length, 0);
    assert.equal(prisma.subscription('sub-new-duplicate')['status'], SubscriptionStatus.ACTIVE);
    assert.equal(prisma.subscription('sub-old-survivor')['remnawaveId'], DEAD_UUID);
    assert.equal(prisma.tables.transaction[0]['subscriptionId'], 'sub-new-duplicate');
  });

  it('previews when dryRun arrives as the STRING "false"', async () => {
    // `?flag=false` has coerced to `true` in this repository before. The rule is
    // `dryRun !== false` — the boolean — so every other value previews.
    const prisma = prismaHarness({ subscription: [survivorRow(), duplicateRow()] });
    const panel = panelHarness();

    const report = await service(prisma, panel).merge({
      dryRun: 'false' as unknown as boolean,
      pairs: CANONICAL_PAIR,
    });

    assert.equal(report.dryRun, true, 'the reported flag must be the BOOLEAN true, not the string');
    assert.equal(report.wouldMerge, 1, 'the pair was still examined — this is a preview, not a skip');
    assert.deepEqual(prisma.writes, []);
    assert.equal(prisma.subscription('sub-new-duplicate')['status'], SubscriptionStatus.ACTIVE);
  });

  it('previews for every other falsy-but-not-false value too', async () => {
    for (const value of [0, '', null, undefined]) {
      const prisma = prismaHarness({ subscription: [survivorRow(), duplicateRow()] });
      const panel = panelHarness();

      const report = await service(prisma, panel).merge({
        dryRun: value as unknown as boolean,
        pairs: CANONICAL_PAIR,
      });

      assert.equal(report.dryRun, true, `dryRun: ${JSON.stringify(value)} must preview`);
      assert.equal(report.wouldMerge, 1);
      assert.deepEqual(prisma.writes, [], `dryRun: ${JSON.stringify(value)} must write nothing`);
    }
  });

  it('writes only on the boolean false', async () => {
    const prisma = prismaHarness({ subscription: [survivorRow(), duplicateRow()] });
    const panel = panelHarness();

    const report = await service(prisma, panel).merge({ dryRun: false, pairs: CANONICAL_PAIR });

    assert.equal(report.dryRun, false);
    assert.equal(report.merged, 1);
    assert.ok(prisma.writes.length > 0);
  });
});

describe('DuplicateSubscriptionMergeService — batch discovery', () => {
  it('finds pairs through the diagnosis sweep and reports each one once', async () => {
    // The sweep emits TWO rows per pair — the scanned half and its partner.
    const reconciliation = reconciliationStub(
      [
        {
          subscriptionId: 'sub-old-survivor',
          outcome: 'duplicatePair',
          duplicateOfSubscriptionId: 'sub-new-duplicate',
          holdsLiveIdentity: false,
        },
        {
          subscriptionId: 'sub-new-duplicate',
          outcome: 'duplicatePair',
          duplicateOfSubscriptionId: 'sub-old-survivor',
          holdsLiveIdentity: true,
        },
        // Not a pair, and must not become one.
        {
          subscriptionId: 'sub-conflict',
          outcome: 'conflict',
          duplicateOfSubscriptionId: null,
          holdsLiveIdentity: false,
        },
      ],
      { hasMore: true, nextCursor: 'sub-zzz' },
    );
    const prisma = prismaHarness({ subscription: [survivorRow(), duplicateRow()] });
    const panel = panelHarness();

    const report = await service(prisma, panel, reconciliation).merge({ dryRun: true });

    assert.equal(report.pairsExamined, 1, 'two emitted rows are ONE pair, not two');
    assert.equal(report.wouldMerge, 1);
    assert.equal(report.rows[0].survivorSubscriptionId, 'sub-old-survivor');
    assert.equal(report.rows[0].duplicateSubscriptionId, 'sub-new-duplicate');
    // Paging is passed straight through so an operator can resume.
    assert.equal(report.hasMore, true);
    assert.equal(report.nextCursor, 'sub-zzz');
    assert.equal(report.panelEra, '3.x');
    // Discovery previews; it never writes.
    assert.deepEqual((reconciliation.calls[0] as { dryRun: boolean }).dryRun, true);
    assert.deepEqual(prisma.writes, []);
  });

  it('does not advance the cursor past a pair it found and did not touch', async () => {
    // Discovery scans ROWS and the run merges PAIRS, capped separately. When the
    // sweep hands back more pairs than `limit`, reporting the sweep's own cursor
    // would send the operator on past pairs nobody looked at — a silent skip in
    // a report whose whole job is to end silence.
    const reconciliation = reconciliationStub(
      [
        {
          subscriptionId: 'sub-old-survivor',
          outcome: 'duplicatePair',
          duplicateOfSubscriptionId: 'sub-new-duplicate',
          holdsLiveIdentity: false,
        },
        {
          subscriptionId: 'sub-old-b',
          outcome: 'duplicatePair',
          duplicateOfSubscriptionId: 'sub-new-b',
          holdsLiveIdentity: false,
        },
      ],
      { hasMore: false, nextCursor: 'sub-far-past-both' },
    );
    const prisma = prismaHarness({
      subscription: [
        survivorRow(),
        duplicateRow(),
        survivorRow({ id: 'sub-old-b', configUrl: 'https://sub.example.test/BBBshortBBB' }),
        duplicateRow({ id: 'sub-new-b', configUrl: 'https://sub.example.test/CCCshortCCC' }),
      ],
    });
    const panel = panelHarness();

    const report = await service(prisma, panel, reconciliation).merge({
      dryRun: true,
      limit: 1,
      startAfterId: 'sub-where-we-started',
    });

    assert.equal(report.pairsExamined, 1, 'the cap is on pairs, and it was applied');
    assert.equal(report.rows[0].survivorSubscriptionId, 'sub-old-survivor');
    assert.equal(report.hasMore, true, 'a pair was found and left alone; the operator must run again');
    assert.equal(
      report.nextCursor,
      'sub-where-we-started',
      'the cursor stays where this run started, so the untouched pair is inside the next window',
    );
  });

  it('reports the sweep own cursor when it merged everything the sweep found', async () => {
    // The other half of the rule: a run that drained what it was given must
    // advance, or the operator walks the same window forever.
    const reconciliation = reconciliationStub(
      [
        {
          subscriptionId: 'sub-old-survivor',
          outcome: 'duplicatePair',
          duplicateOfSubscriptionId: 'sub-new-duplicate',
          holdsLiveIdentity: false,
        },
      ],
      { hasMore: true, nextCursor: 'sub-resume-here' },
    );
    const prisma = prismaHarness({ subscription: [survivorRow(), duplicateRow()] });
    const panel = panelHarness();

    const report = await service(prisma, panel, reconciliation).merge({
      dryRun: true,
      limit: 5,
      startAfterId: 'sub-where-we-started',
    });

    assert.equal(report.pairsExamined, 1);
    assert.equal(report.nextCursor, 'sub-resume-here');
    assert.equal(report.hasMore, true, 'the sweep itself had more rows to scan');
  });

  it('derives the survivor itself, even when the sweep names the halves the other way round', async () => {
    // The sweep emits the scanned half first, and on a 3.x panel that is the
    // STALE row — but nothing guarantees the order, and the merge must not
    // depend on it.
    const reconciliation = reconciliationStub([
      {
        subscriptionId: 'sub-new-duplicate',
        outcome: 'duplicatePair',
        duplicateOfSubscriptionId: 'sub-old-survivor',
        holdsLiveIdentity: true,
      },
      {
        subscriptionId: 'sub-old-survivor',
        outcome: 'duplicatePair',
        duplicateOfSubscriptionId: 'sub-new-duplicate',
        holdsLiveIdentity: false,
      },
    ]);
    const prisma = prismaHarness({ subscription: [survivorRow(), duplicateRow()] });
    const panel = panelHarness();

    const report = await service(prisma, panel, reconciliation).merge({ dryRun: false });

    assert.equal(report.merged, 1);
    assert.equal(
      report.rows[0].survivorSubscriptionId,
      'sub-old-survivor',
      'createdAt decides which half survives, never the order the sweep listed them in',
    );
    assert.equal(prisma.subscription('sub-new-duplicate')['status'], SubscriptionStatus.DELETED);
    assert.deepEqual(retiredRowsStillNamingAProfile(prisma), []);
  });
});

/**
 * A CLUSTER OF THREE LIVE ROWS ON ONE PANEL PROFILE, DRIVEN TO CONVERGENCE.
 *
 * THE REAL SWEEP, NOT `reconciliationStub`. Every other discovery case hands
 * the merge a pair list and asks what it does with it. This one asks the
 * opposite question — whether the sweep can still SEE the cluster after a merge
 * has already run on it — and a stub cannot answer that, because a stub returns
 * the same pairs whatever the table holds.
 *
 * WHY THE SECOND ROUND USED TO FIND NOTHING. The sweep selects on "is this link
 * BROKEN?": `remnawave_id IS NULL`, or uuid-shaped on a proven 3.x panel. The
 * first merge makes the survivor take the duplicate's decimal identity — so
 * afterwards the survivor holds a well-formed decimal and so does the third
 * row. Neither is broken. Both are LIVE on one profile. The cluster is invisible
 * to a question about brokenness, and only a question about SHARING can see it.
 *
 * WHAT CONVERGENCE MEANS HERE, stated as rows: exactly ONE live row is left, it
 * is the OLDEST of the three, it holds the identity, and it still carries the
 * operator's plan. Not "the report says converged".
 */
describe('DuplicateSubscriptionMergeService — a cluster of three converges', () => {
  /**
   * Creation instants as offsets from one anchor taken when this file loads.
   *
   * No calendar literal: the only thing these three rows have to say about time
   * is which came FIRST, and that is the rule the survivor is derived from.
   */
  const MINUTE_MS = 60_000;
  const CLOCK_ANCHOR = Date.now();
  const minutesAgo = (minutes: number): Date => new Date(CLOCK_ANCHOR - minutes * MINUTE_MS);

  /**
   * The three rows, oldest first.
   *
   * `sub-1-original` is the customer's real subscription, linked in the 2.x era
   * and holding a uuid the 3.x panel cannot answer to. The other two are what
   * the importer minted: it could not match the original (its
   * `remnawave_panel_id` was never recorded, and the uuid it stores is not the
   * decimal the panel now reports), so it created a row — twice.
   */
  const cluster = () => [
    {
      id: 'sub-1-original',
      userId: 'user-1',
      status: SubscriptionStatus.ACTIVE,
      createdAt: minutesAgo(900),
      remnawaveId: DEAD_UUID as string | null,
      remnawavePanelId: null as number | null,
      remnawavePanelUsername: 'rz_alice_sub',
      configUrl: 'https://sub.example.test/OLDshortOLD',
      planSnapshot: { id: 'plan-year', name: PLAN_NAME },
    },
    {
      id: 'sub-2-minted',
      userId: 'user-1',
      status: SubscriptionStatus.ACTIVE,
      createdAt: minutesAgo(600),
      remnawaveId: '5150' as string | null,
      remnawavePanelId: 5150 as number | null,
      remnawavePanelUsername: 'rz_alice_sub',
      configUrl: 'https://sub.example.test/AAAshortAAA',
      planSnapshot: { importedFrom: 'remnawave', tag: 'BULK' },
    },
    {
      id: 'sub-3-minted-again',
      userId: 'user-1',
      status: SubscriptionStatus.ACTIVE,
      createdAt: minutesAgo(300),
      remnawaveId: '5150' as string | null,
      remnawavePanelId: 5150 as number | null,
      remnawavePanelUsername: 'rz_alice_sub',
      configUrl: 'https://sub.example.test/BBBshortBBB',
      planSnapshot: { importedFrom: 'remnawave', tag: 'BULK' },
    },
  ];

  /** The real sweep, wired to the same fake table the merge writes through. */
  const sweep = (prisma: PrismaHarness, panel: PanelHarness): PanelLinkReconciliationService =>
    new PanelLinkReconciliationService(
      prisma.client as never,
      panel.api as never,
      SILENT_EVENTS as never,
    );

  /** Every row still live, oldest first — the state convergence is judged on. */
  const liveRows = (prisma: PrismaHarness): string[] =>
    prisma.tables.subscription
      .filter((row) => row['status'] !== SubscriptionStatus.DELETED)
      .map((row) => String(row['id']));

  it('still sees the remaining duplicate after the first merge, and a second merge finishes it', async () => {
    const prisma = prismaHarness({ subscription: cluster() });
    const panel = panelHarness();
    const merger = service(prisma, panel, sweep(prisma, panel));

    // ── ROUND ONE ────────────────────────────────────────────────────────────
    const first = await merger.merge({ dryRun: false });

    assert.equal(first.merged, 1, 'the sweep found the broken half and its holder');
    const firstMerged = first.rows.find((row) => row.outcome === 'merged');
    assert.ok(firstMerged !== undefined);
    assert.equal(
      firstMerged.survivorSubscriptionId,
      'sub-1-original',
      'the oldest row survives the first merge',
    );
    assert.equal(firstMerged.duplicateSubscriptionId, 'sub-2-minted');
    // THE SECOND PAIR OF ROUND ONE IS REFUSED, AND THAT IS REPORTED RATHER THAN
    // ENGINEERED AWAY. Both routes see this cluster: the walk names the stale
    // half and its oldest holder, and the two holders are a shared pair of their
    // own. Merging the first retires a row the second one names, so the second
    // refuses `alreadyRetired` — visibly, in the operator's report. Suppressing
    // every pair whose members appear in another would be tidier and would let a
    // permanently-refused pair starve the ones behind it forever, which is the
    // silence this whole family of code exists to end.
    assert.equal(first.pairsExamined, 2);
    const firstRefused = first.rows.find((row) => row.outcome === 'refused');
    assert.ok(firstRefused !== undefined);
    assert.equal(firstRefused.refusal, 'alreadyRetired');
    assert.deepEqual(
      liveRows(prisma),
      ['sub-1-original', 'sub-3-minted-again'],
      'one duplicate is retired and one is still live on the same profile',
    );
    // THE STATE THE OLD SELECTION COULD NOT SEE, pinned as columns rather than
    // inferred: two live rows, both holding a perfectly well-formed decimal.
    assert.equal(prisma.subscription('sub-1-original')['remnawaveId'], '5150');
    assert.equal(prisma.subscription('sub-3-minted-again')['remnawaveId'], '5150');

    // ── ROUND TWO ────────────────────────────────────────────────────────────
    const second = await merger.merge({ dryRun: false });

    assert.equal(
      second.pairsExamined,
      1,
      'the sweep must still see the cluster once every identity in it is well formed',
    );
    assert.equal(second.merged, 1);
    const secondMerged = second.rows.find((row) => row.outcome === 'merged');
    assert.ok(secondMerged !== undefined);
    assert.equal(
      secondMerged.survivorSubscriptionId,
      'sub-1-original',
      'the OLDEST row of the whole cluster survives, not merely the older of each pair',
    );
    assert.equal(secondMerged.duplicateSubscriptionId, 'sub-3-minted-again');

    // ── CONVERGED ────────────────────────────────────────────────────────────
    assert.deepEqual(liveRows(prisma), ['sub-1-original'], 'one profile, one live row');
    const survivor = prisma.subscription('sub-1-original');
    assert.equal(survivor['remnawaveId'], '5150');
    assert.equal(survivor['remnawavePanelId'], 5150);
    assert.deepEqual(
      survivor['planSnapshot'],
      { id: 'plan-year', name: PLAN_NAME },
      "the customer's plan survived both merges",
    );
    // No retired row may still name a profile: a `DELETED` row holding an
    // identity is what turns the next manual delete into a panel DELETE.
    assert.deepEqual(retiredRowsStillNamingAProfile(prisma), []);

    // ── A THIRD ROUND HAS NOTHING LEFT ───────────────────────────────────────
    const third = await merger.merge({ dryRun: false });
    assert.equal(third.pairsExamined, 0, 'a converged cluster is not re-merged forever');
  });

  it('costs the panel nothing to see a cluster whose identities are already well formed', async () => {
    // The post-merge state on its own: two live rows, one identity, nothing
    // broken. Seeing this is a comparison of two LOCAL rows, so the sweep has no
    // reason to resolve anything — and `resolveUser` appearing here
    // would mean the new arm was routed through the panel-facing repair path.
    const prisma = prismaHarness({
      subscription: [
        {
          id: 'sub-1-original',
          userId: 'user-1',
          status: SubscriptionStatus.ACTIVE,
          createdAt: minutesAgo(900),
          remnawaveId: '5150' as string | null,
          remnawavePanelId: 5150 as number | null,
          remnawavePanelUsername: 'rz_alice_sub',
          configUrl: 'https://sub.example.test/OLDshortOLD',
          planSnapshot: { id: 'plan-year', name: PLAN_NAME },
        },
        {
          id: 'sub-3-minted-again',
          userId: 'user-1',
          status: SubscriptionStatus.ACTIVE,
          createdAt: minutesAgo(300),
          remnawaveId: '5150' as string | null,
          remnawavePanelId: 5150 as number | null,
          remnawavePanelUsername: 'rz_alice_sub',
          configUrl: 'https://sub.example.test/BBBshortBBB',
          planSnapshot: { importedFrom: 'remnawave', tag: 'BULK' },
        },
      ],
    });
    const panel = panelHarness();

    const report = await sweep(prisma, panel).reconcile({ dryRun: true });

    assert.equal(report.duplicatePairs, 1, 'the pair is seen');
    assert.deepEqual(
      panel.calls,
      [],
      'the panel is not asked anything at all; the pair is a local fact',
    );
    // The positive control for that empty-ish list: the adapter DOES answer
    // resolves, so "no resolve happened" is a fact about the sweep and not about
    // a stub that would have thrown.
    assert.equal(panel.resolveCalls.length, 0);
    // And the database side of the same claim, as the statement list rather than
    // as a count of some spy's calls: one page of the walk's selection (which
    // drains at once — neither row is broken), one aggregate per identity angle,
    // one `IN` lookup for the members. No probe per row.
    assert.deepEqual(prisma.queries, [
      'subscription.findMany',
      'subscription.groupBy',
      'subscription.groupBy',
      'subscription.findMany',
    ]);
  });
});

/**
 * WHICH HALF IS BOUND TO THE LIVE PANEL PROFILE — stated by the report.
 *
 * Until this field existed the SPA worked the answer out for itself from the
 * four `previous` columns, which meant a SECOND copy of `namesProfile` and of
 * its two-spellings rule living in a different repository. The polarity of that
 * rule is what stands between an operator and a panel DELETE against a paying
 * customer, so these cases pin three separate things:
 *
 *   1. The answer is REPORTED, and it is reported for the half that really
 *      holds it — which on this defect's pair is the newer, wrong-looking one.
 *   2. It comes from `namesProfile` and not from a fresh comparison. Proven by
 *      the spellings a re-derivation gets wrong: a numeric panel id stored as a
 *      DECIMAL STRING in `remnawave_id`, and one stored only in
 *      `remnawave_panel_id`. A hand-rolled `row.remnawaveId === remnawaveId`
 *      calls both of those unbound.
 *   3. "Nobody asked" and "we asked and the answer is no" are different values.
 *      A refusal raised before the panel round-trip reports `null`; a refusal
 *      raised after it reports `false`. Collapsing the first into the second is
 *      this report telling an operator a row is unbound when it never looked.
 */
describe('DuplicateSubscriptionMergeService — which half holds the live identity', () => {

  it('names the DUPLICATE as the bound half on the pair this defect produces', async () => {
    const prisma = prismaHarness({ subscription: [survivorRow(), duplicateRow()] });

    const report = await service(prisma, panelHarness()).merge({
      dryRun: true,
      pairs: CANONICAL_PAIR,
    });

    assert.equal(report.rows[0].outcome, 'wouldMerge');
    assert.equal(
      report.rows[0].duplicateHoldsLiveIdentity,
      true,
      'the newer, wrong-looking row is the one pointing at the live profile',
    );
    assert.equal(report.rows[0].survivorHoldsLiveIdentity, false);
  });

  it('names the SURVIVOR when the sweep already moved the identity onto it', async () => {
    // Not an error state: the reconciliation repair reaches this half first
    // often enough, and a report hard-coded to "the duplicate" would send the
    // operator at the wrong row every time it happens.
    const prisma = prismaHarness({
      subscription: [
        survivorRow({ remnawaveId: '5150', remnawavePanelId: 5150 }),
        duplicateRow({ remnawaveId: null, remnawavePanelId: null }),
      ],
    });

    const report = await service(prisma, panelHarness()).merge({
      dryRun: true,
      pairs: CANONICAL_PAIR,
    });

    assert.equal(report.rows[0].outcome, 'wouldMerge');
    assert.equal(report.rows[0].survivorHoldsLiveIdentity, true);
    assert.equal(report.rows[0].duplicateHoldsLiveIdentity, false);
  });

  it('reads a numeric panel id stored in remnawaveId with NO supplementary column', async () => {
    // The half the importer wrote before `remnawave_panel_id` was recorded at
    // all: the profile is named only by the decimal in `remnawave_id`, so
    // `namesProfile`'s second clause — `row.remnawaveId === String(panelId)` —
    // is the only one that can recognise it. A report that compared the stored
    // id against the resolved one alone would call this row unbound while the
    // merge itself treats it as the identity source, and the two halves of one
    // report would then disagree about which row is live.
    const prisma = prismaHarness({
      subscription: [
        survivorRow(),
        duplicateRow({ remnawaveId: '5150', remnawavePanelId: null }),
      ],
    });

    const report = await service(prisma, panelHarness()).merge({
      dryRun: true,
      pairs: CANONICAL_PAIR,
    });

    assert.equal(
      report.rows[0].outcome,
      'wouldMerge',
      'the merge itself accepts this spelling — the report must agree with it',
    );
    assert.equal(report.rows[0].remnawaveId, '5150');
    assert.equal(report.rows[0].duplicateHoldsLiveIdentity, true);
    assert.equal(report.rows[0].survivorHoldsLiveIdentity, false);
  });

  it('reads a numeric panel id stored only in remnawavePanelId', async () => {
    // The other spelling of the same profile, and the other clause of the rule.
    const prisma = prismaHarness({
      subscription: [
        survivorRow(),
        duplicateRow({ remnawaveId: null, remnawavePanelId: 5150 }),
      ],
    });

    const report = await service(prisma, panelHarness()).merge({
      dryRun: true,
      pairs: CANONICAL_PAIR,
    });

    assert.equal(report.rows[0].outcome, 'wouldMerge');
    assert.equal(report.rows[0].duplicateHoldsLiveIdentity, true);
    assert.equal(report.rows[0].survivorHoldsLiveIdentity, false);
  });

  it('reports null — not false — when no panel profile was ever resolved', async () => {
    // `survivorUnresolved` is raised before either round-trip. Nothing was
    // asked of the panel, so nothing may be claimed about either half: `false`
    // here is this report saying "not bound" about a row it never checked, and
    // "not bound" is the sentence that points at the destructive action.
    const prisma = prismaHarness({
      subscription: [
        survivorRow({ configUrl: null, remnawavePanelUsername: '' }),
        duplicateRow(),
      ],
    });

    const report = await service(prisma, panelHarness()).merge({
      dryRun: true,
      pairs: CANONICAL_PAIR,
    });

    assert.equal(report.rows[0].refusal, 'survivorUnresolved');
    assert.equal(report.rows[0].survivorHoldsLiveIdentity, null);
    assert.equal(report.rows[0].duplicateHoldsLiveIdentity, null);
  });

  it('reports null on a refusal raised before either row was even loaded', async () => {
    const prisma = prismaHarness({
      subscription: [survivorRow({ userId: 'user-1' }), duplicateRow({ userId: 'user-2' })],
    });

    const report = await service(prisma, panelHarness()).merge({
      dryRun: true,
      pairs: CANONICAL_PAIR,
    });

    assert.equal(report.rows[0].refusal, 'differentCustomers');
    assert.equal(report.rows[0].survivorHoldsLiveIdentity, null);
    assert.equal(report.rows[0].duplicateHoldsLiveIdentity, null);
  });

  it('reports false on BOTH once the profile was resolved and neither half held it', async () => {
    // The direction-complete half of the case above. Here the panel WAS asked,
    // and "neither" is a real finding an operator acts on — repair the link
    // first — rather than an absence of information.
    const prisma = prismaHarness({
      subscription: [
        survivorRow(),
        duplicateRow({ remnawaveId: '11111111-2222-4333-8444-555555555555', remnawavePanelId: null }),
      ],
    });

    const report = await service(prisma, panelHarness()).merge({
      dryRun: true,
      pairs: CANONICAL_PAIR,
    });

    assert.equal(report.rows[0].refusal, 'neitherHoldsIdentity');
    assert.equal(report.rows[0].survivorHoldsLiveIdentity, false);
    assert.equal(report.rows[0].duplicateHoldsLiveIdentity, false);
    assert.notEqual(
      report.rows[0].survivorHoldsLiveIdentity,
      null,
      'the panel was asked, so this is an answer and not a silence',
    );
  });

  it('reports the PRE-merge holder on a row it actually merged', async () => {
    // After the write the survivor holds the identity by definition, so an
    // "after" answer would be the constant `survivor` on every merged row and
    // would tell nobody anything. The undo needs where it CAME FROM, which is
    // the same instant the four `previous` columns describe.
    const prisma = prismaHarness({ subscription: [survivorRow(), duplicateRow()] });

    const report = await service(prisma, panelHarness()).merge({
      dryRun: false,
      pairs: CANONICAL_PAIR,
    });

    assert.equal(report.rows[0].outcome, 'merged');
    assert.equal(report.rows[0].duplicateHoldsLiveIdentity, true);
    assert.equal(report.rows[0].survivorHoldsLiveIdentity, false);
    // ...and the write really did land, so this is the pre-merge answer and
    // not a stale read of an unwritten row.
    assert.equal(prisma.subscription('sub-old-survivor')['remnawaveId'], '5150');
    assert.equal(prisma.subscription('sub-new-duplicate')['remnawaveId'], null);
  });
});

/**
 * THE WINDOW BETWEEN THE CHECK AND THE WRITE.
 *
 * Three of this service's refusals are decided by counting rows on OTHER tables
 * — `subscription_terms` and its four relatives, `trial_claims`,
 * `profile_sync_jobs` — and neither fenced `updateMany` inside the transaction
 * mentions any of them: they fence on `remnawaveId` and `status`. So a
 * pre-flight check on its own leaves a window, and the largest part of that
 * window is the wait on `pg_advisory_xact_lock`, whose key is shared with
 * `persistProfileLink` and the reconciliation sweep's `writeLink`.
 *
 * WHAT ESCAPES THROUGH IT IS NOT A MISSED REFUSAL, IT IS AN ORPHAN. A term, an
 * add-on entitlement or a projection created on the duplicate in that window is
 * left naming a row the merge has just marked `DELETED` — invisible to every
 * join that goes through the surviving subscription, and `BLOCKING_RELATIONS`
 * says in as many words that this is the one outcome worse than a refusal. A
 * trial claim created on the SURVIVOR in that window turns the duplicate's own
 * claim into a `P2002` on the UNIQUE `trial_claims.subscription_id`, which is
 * not a `MergeRaceError`.
 *
 * EVERY CASE HERE INJECTS AT THE ADVISORY LOCK — after every pre-flight check
 * has passed, before the first statement — through `commitExternally`, so the
 * injected row SURVIVES the rollback the way another transaction's commit
 * really would. Without that survival each "nothing was orphaned" assertion
 * below would pass for a service with no guard at all: the row would be gone
 * either way.
 */
describe('DuplicateSubscriptionMergeService — conditions that change under the merge', () => {
  it('the injection point is live: a merge whose window carries a harmless change still merges', async () => {
    // THE INERTNESS CONTROL for every case below. `onLock` fires inside the
    // transaction, and a hook that silently never ran — or that broke the merge
    // for reasons of its own — would make "refused, and nothing was orphaned"
    // pass without any guard being involved. So the same hook, on the same
    // harness, carrying a change no guard cares about, must still produce a
    // complete merge with all of its writes.
    const prisma = prismaHarness({
      subscription: [survivorRow(), duplicateRow()],
      transaction: [{ id: 'txn-1', subscriptionId: 'sub-new-duplicate' }],
    });
    let fired = 0;
    prisma.onLock = () => {
      fired += 1;
      prisma.commitExternally(() => {
        prisma.tables.transaction.push({ id: 'txn-mid-flight', subscriptionId: 'sub-unrelated' });
      });
    };

    const report = await service(prisma, panelHarness()).merge({
      dryRun: false,
      pairs: CANONICAL_PAIR,
    });

    assert.equal(fired, 1, 'the hook must actually run, or it proves nothing about the cases below');
    assert.equal(report.merged, 1);
    assert.ok(
      prisma.writes.length >= 3,
      'the fake records every statement, so an empty log below really does mean none ran',
    );
    assert.equal(prisma.subscription('sub-new-duplicate')['status'], SubscriptionStatus.DELETED);
    assert.equal(prisma.tables.transaction[0]['subscriptionId'], 'sub-old-survivor');
    assert.ok(
      prisma.tables.transaction.some((row) => row['id'] === 'txn-mid-flight'),
      'and the externally committed row is still there after a merge that COMMITTED',
    );
  });

  it('refuses a SubscriptionTerm created on the duplicate inside the window, orphaning nothing', async () => {
    const prisma = prismaHarness({ subscription: [survivorRow(), duplicateRow()] });
    prisma.onLock = () => {
      prisma.commitExternally(() => {
        prisma.tables.subscriptionTerm.push({
          id: 'term-mid-flight',
          subscriptionId: 'sub-new-duplicate',
        });
      });
    };

    const report = await service(prisma, panelHarness()).merge({
      dryRun: false,
      pairs: CANONICAL_PAIR,
    });

    // The transaction WAS entered, so the pre-flight check passed and this is
    // the in-transaction assertion firing rather than the outside one.
    assert.equal(prisma.rawLocks.length, 1, 'the merge got as far as taking the advisory lock');
    assert.equal(prisma.transactions.length, 1);
    assert.equal(report.merged, 0);
    assert.equal(report.rows[0].refusal, 'entitlementHistoryOnDuplicate');
    assert.match(report.rows[0].reason ?? '', /SubscriptionTerm: 1/);
    assert.deepEqual(prisma.writes, [], 'the guard runs before the first statement');
    // ZERO ORPHANS, stated as the property and not as a count: the term is still
    // there, and the row it names is still LIVE.
    assert.deepEqual(
      prisma.tables.subscriptionTerm.map((row) => row['id']),
      ['term-mid-flight'],
      'the concurrent transaction committed, so its row must outlive our rollback',
    );
    assert.deepEqual(
      orphanedOnRetiredRows(prisma, 'subscriptionTerm', 'subscriptionId'),
      [],
      'an entitlement-lifecycle row naming a DELETED subscription is the outcome ' +
        'BLOCKING_RELATIONS calls worse than a refusal',
    );
    assert.equal(prisma.subscription('sub-new-duplicate')['status'], SubscriptionStatus.ACTIVE);
    assert.equal(prisma.subscription('sub-new-duplicate')['remnawaveId'], '5150');
    assert.equal(prisma.subscription('sub-old-survivor')['remnawaveId'], DEAD_UUID);
    assert.deepEqual(retiredRowsStillNamingAProfile(prisma), []);
  });

  it('refuses a TrialClaim created on the survivor inside the window, instead of raising P2002', async () => {
    const prisma = prismaHarness({
      subscription: [survivorRow(), duplicateRow()],
      trialClaim: [{ id: 'claim-duplicate', subscriptionId: 'sub-new-duplicate' }],
    });
    prisma.onLock = () => {
      prisma.commitExternally(() => {
        prisma.tables.trialClaim.push({ id: 'claim-mid-flight', subscriptionId: 'sub-old-survivor' });
      });
    };

    const report = await service(prisma, panelHarness()).merge({
      dryRun: false,
      pairs: CANONICAL_PAIR,
    });

    assert.equal(prisma.rawLocks.length, 1);
    assert.equal(report.merged, 0);
    assert.equal(
      report.rows[0].refusal,
      'trialClaimOnBoth',
      'a named refusal, not the P2002 the move would otherwise have raised',
    );
    assert.deepEqual(prisma.writes, [], 'the guard runs before the trialClaim move');
    // Both claims still name the row they named, and neither subscription moved.
    assert.deepEqual(
      prisma.tables.trialClaim.map((row) => `${String(row['id'])}=${String(row['subscriptionId'])}`),
      ['claim-duplicate=sub-new-duplicate', 'claim-mid-flight=sub-old-survivor'],
    );
    assert.equal(prisma.subscription('sub-new-duplicate')['status'], SubscriptionStatus.ACTIVE);
    assert.deepEqual(orphanedOnRetiredRows(prisma, 'trialClaim', 'subscriptionId'), []);
  });

  it('refuses a PENDING job claimed into RUNNING inside the window', async () => {
    const prisma = prismaHarness({
      subscription: [survivorRow(), duplicateRow()],
      profileSyncJob: [
        {
          id: 'job-pending',
          subscriptionId: 'sub-new-duplicate',
          status: 'PENDING',
          supersededAt: null,
          cause: null,
        },
      ],
    });
    prisma.onLock = () => {
      // `claimSyncJob` flips PENDING → RUNNING in one `updateMany`. After it the
      // supersede step's `status: { in: [PENDING, FAILED] }` no longer matches
      // the job, so without this guard it would be neither superseded nor
      // refused — a claimed worker left acting on a profile that just changed
      // hands.
      prisma.commitExternally(() => {
        const job = prisma.tables.profileSyncJob.find((row) => row['id'] === 'job-pending');
        assert.ok(job !== undefined, 'the fixture job must exist');
        job['status'] = 'RUNNING';
      });
    };

    const report = await service(prisma, panelHarness()).merge({
      dryRun: false,
      pairs: CANONICAL_PAIR,
    });

    assert.equal(prisma.rawLocks.length, 1);
    assert.equal(report.rows[0].refusal, 'syncJobRunning');
    assert.match(report.rows[0].reason ?? '', /1 sync job\(s\)/);
    assert.deepEqual(prisma.writes, []);
    assert.equal(prisma.tables.profileSyncJob[0]['status'], 'RUNNING');
    assert.equal(
      prisma.tables.profileSyncJob[0]['supersededAt'],
      null,
      'a claimed job cannot be recalled by marking it superseded, which is why the pair is refused',
    );
    assert.equal(prisma.subscription('sub-new-duplicate')['status'], SubscriptionStatus.ACTIVE);
  });

  it('refuses an AddOnEntitlement created after the LAST statement, which only the drain check can see', async () => {
    const prisma = prismaHarness({ subscription: [survivorRow(), duplicateRow()] });
    // Injected after the sync-job supersede — the last write a merge makes — so
    // the pre-flight check and the in-transaction guard have both already run
    // and passed. Only a question asked AFTER the statements can see it.
    prisma.afterWrite = (write) => {
      if (write.model !== 'profileSyncJob') return;
      prisma.commitExternally(() => {
        prisma.tables.addOnEntitlement.push({
          id: 'ent-mid-flight',
          subscriptionId: 'sub-new-duplicate',
        });
      });
    };

    const report = await service(prisma, panelHarness()).merge({
      dryRun: false,
      pairs: CANONICAL_PAIR,
    });

    assert.equal(report.merged, 0);
    assert.equal(report.rows[0].refusal, 'raceLost');
    assert.match(report.rows[0].reason ?? '', /AddOnEntitlement: 1/);
    assert.match(report.rows[0].reason ?? '', /orphaned on a DELETED row/);
    // WHAT MAKES THIS CASE DIFFERENT from the three above: the statements DID
    // run, and were then rolled back. Asserting only "nothing changed" would not
    // distinguish it from a pair refused before the transaction opened.
    assert.ok(
      prisma.writes.some(
        (write) =>
          write.model === 'subscription' && write.data['status'] === SubscriptionStatus.DELETED,
      ),
      'the retirement statement ran before the drain check refused',
    );
    assert.equal(
      prisma.subscription('sub-new-duplicate')['status'],
      SubscriptionStatus.ACTIVE,
      'and was rolled back',
    );
    assert.equal(prisma.subscription('sub-new-duplicate')['remnawaveId'], '5150');
    assert.equal(prisma.subscription('sub-old-survivor')['remnawaveId'], DEAD_UUID);
    assert.deepEqual(
      prisma.tables.addOnEntitlement.map((row) => row['id']),
      ['ent-mid-flight'],
    );
    assert.deepEqual(orphanedOnRetiredRows(prisma, 'addOnEntitlement', 'subscriptionId'), []);
    assert.deepEqual(retiredRowsStillNamingAProfile(prisma), []);
  });
});

/**
 * A BATCH IS NOT ATOMIC, AND A THROW USED TO DESTROY THE AUDIT FOR EVERYTHING
 * BEFORE IT.
 *
 * Each pair is its own transaction, so a failure on pair `n` leaves `1..n-1`
 * COMMITTED — with the duplicates' identity columns already NULL, which makes
 * the run's `adminAuditLog` row the last surviving record of what they held. The
 * controller writes that row AFTER `merge()` returns, so a throw escaping
 * `merge()` skipped it and left every merge in the batch unrecorded.
 */
describe('DuplicateSubscriptionMergeService — a batch that stops', () => {
  /** Three pairs, one customer, each half with its own resolvable short UUID. */
  function threePairs(): Array<Record<string, unknown>> {
    return ['a', 'b', 'c'].flatMap((tag) => [
      survivorRow({ id: `sub-old-${tag}`, configUrl: `https://sub.example.test/OLD${tag}` }),
      duplicateRow({ id: `sub-new-${tag}`, configUrl: `https://sub.example.test/NEW${tag}` }),
    ]);
  }

  function threePairDiscovery() {
    return reconciliationStub(
      ['a', 'b', 'c'].map((tag) => ({
        subscriptionId: `sub-old-${tag}`,
        outcome: 'duplicatePair',
        duplicateOfSubscriptionId: `sub-new-${tag}`,
        holdsLiveIdentity: false,
      })),
      { hasMore: false, nextCursor: 'sub-far-past-all-three' },
    );
  }

  it('records the pairs that merged, names the one that failed, and says the batch stopped', async () => {
    // Pair 2 fails on a REAL constraint, not a stubbed throw:
    // `users.current_subscription_id` is globally UNIQUE, and the repoint moves
    // this customer's pointer onto `sub-old-b`, which another user already
    // names. That is one of the three throws this defect is about.
    const prisma = prismaHarness({
      subscription: threePairs(),
      transaction: [{ id: 'txn-a', subscriptionId: 'sub-new-a' }],
      user: [
        { id: 'user-1', currentSubscriptionId: 'sub-new-b' },
        { id: 'user-squatter', currentSubscriptionId: 'sub-old-b' },
      ],
    });
    const events = recordingEvents();

    const report = await service(prisma, panelHarness(), threePairDiscovery(), events.api).merge({
      dryRun: false,
      startAfterId: 'sub-window-start',
    });

    // 1. PAIR ONE COMMITTED AND IS IN THE REPORT. That is the whole point: the
    //    controller builds the audit row from this report, after this returns.
    assert.equal(report.merged, 1);
    assert.equal(report.rows[0].outcome, 'merged');
    assert.equal(report.rows[0].survivorSubscriptionId, 'sub-old-a');
    assert.equal(
      report.rows[0].duplicatePreviousRemnawaveId,
      '5150',
      'the undo value survives in the report even though the row no longer holds it',
    );
    assert.equal(prisma.subscription('sub-new-a')['status'], SubscriptionStatus.DELETED);
    assert.equal(prisma.subscription('sub-new-a')['remnawaveId'], null);
    assert.equal(prisma.subscription('sub-old-a')['remnawaveId'], '5150');
    assert.equal(prisma.tables.transaction[0]['subscriptionId'], 'sub-old-a');

    // 2. PAIR TWO FAILED, WAS ROLLED BACK WHOLE, AND IS NAMED.
    assert.equal(report.rows.length, 2, 'nothing after the failure was examined');
    assert.equal(report.rows[1].outcome, 'refused');
    assert.equal(report.rows[1].refusal, 'raceLost');
    assert.equal(report.rows[1].survivorSubscriptionId, 'sub-old-b');
    assert.match(report.rows[1].reason ?? '', /P2002/);
    assert.match(report.rows[1].reason ?? '', /THE BATCH STOPPED HERE/);
    assert.equal(prisma.subscription('sub-new-b')['status'], SubscriptionStatus.ACTIVE);
    assert.equal(prisma.subscription('sub-old-b')['remnawaveId'], DEAD_UUID);
    assert.equal(prisma.tables.user[0]['currentSubscriptionId'], 'sub-new-b', 'the repoint undone');

    // 3. PAIR THREE WAS NEVER TOUCHED.
    assert.equal(prisma.subscription('sub-new-c')['status'], SubscriptionStatus.ACTIVE);
    assert.equal(prisma.subscription('sub-old-c')['remnawaveId'], DEAD_UUID);

    // 4. THE OPERATOR IS TOLD, in a field and not only in prose.
    assert.notEqual(report.stoppedEarly, null, 'a stopped batch must say so');
    assert.equal(report.stoppedEarly?.survivorSubscriptionId, 'sub-old-b');
    assert.equal(report.stoppedEarly?.duplicateSubscriptionId, 'sub-new-b');
    assert.equal(report.stoppedEarly?.pairsCompleted, 1);
    assert.equal(report.stoppedEarly?.errorName, 'PrismaClientKnownRequestError');
    assert.equal(report.stoppedEarly?.errorCode, 'P2002');

    // 5. AND TOLD TO COME BACK, without being sent past the pair that failed.
    assert.equal(report.hasMore, true);
    assert.equal(
      report.nextCursor,
      'sub-window-start',
      'the sweep own cursor would resume beyond two pairs nobody merged',
    );

    // 6. THE FEED SAYS IT TOO, at ERROR rather than INFO.
    const errors = events.sink.filter((event) => event.severity === 'ERROR');
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /the batch STOPPED at pair sub-old-b\/sub-new-b/);
    assert.match(errors[0].message, /P2002/);
    assert.deepEqual(
      events.sink.filter((event) => event.severity === 'INFO'),
      [],
      'a run that stopped must not also report itself as a routine summary',
    );
  });

  it('emits the plain INFO summary and a null stop when every pair was examined', async () => {
    // The direction-complete half: a suite that only proved the stop would pass
    // for an implementation that called every run stopped.
    const prisma = prismaHarness({
      subscription: threePairs(),
      user: [{ id: 'user-1', currentSubscriptionId: 'sub-new-b' }],
    });
    const events = recordingEvents();

    const report = await service(prisma, panelHarness(), threePairDiscovery(), events.api).merge({
      dryRun: false,
      startAfterId: 'sub-window-start',
    });

    assert.equal(report.merged, 3);
    assert.equal(report.stoppedEarly, null);
    assert.equal(report.hasMore, false);
    assert.equal(
      report.nextCursor,
      'sub-far-past-all-three',
      'a run that drained what it was given must advance, or the operator walks one window forever',
    );
    assert.deepEqual(
      events.sink.map((event) => event.severity),
      ['INFO'],
    );
    assert.match(events.sink[0].message, /merged 3 of 3 pairs/);
  });

  it('converts the trial-claim P2002 the guard cannot pre-empt into a stop, not a thrown batch', async () => {
    // The guard at step 0 catches a claim that appeared before the first
    // statement. One that appears BETWEEN two statements is past every check,
    // and `trialClaim.updateMany` then raises `P2002` on the UNIQUE
    // `trial_claims.subscription_id` — not a `MergeRaceError`, so it escapes
    // `writeMerge`. This is also the control proving the fake really does
    // enforce that constraint, which is what the guard case above relies on.
    const prisma = prismaHarness({
      subscription: [survivorRow(), duplicateRow()],
      trialClaim: [{ id: 'claim-duplicate', subscriptionId: 'sub-new-duplicate' }],
    });
    prisma.afterWrite = (write) => {
      if (write.model !== 'subscription') return;
      if (write.data['status'] !== SubscriptionStatus.DELETED) return;
      prisma.commitExternally(() => {
        prisma.tables.trialClaim.push({ id: 'claim-mid-flight', subscriptionId: 'sub-old-survivor' });
      });
    };

    const report = await service(prisma, panelHarness()).merge({
      dryRun: false,
      pairs: CANONICAL_PAIR,
    });

    assert.equal(report.merged, 0);
    assert.equal(report.rows[0].refusal, 'raceLost');
    assert.equal(report.stoppedEarly?.errorCode, 'P2002');
    assert.match(report.stoppedEarly?.message ?? '', /subscriptionId/);
    // Rolled back whole: the duplicate is live again and still holds its identity.
    assert.equal(prisma.subscription('sub-new-duplicate')['status'], SubscriptionStatus.ACTIVE);
    assert.equal(prisma.subscription('sub-new-duplicate')['remnawaveId'], '5150');
    assert.deepEqual(
      prisma.tables.trialClaim.map((row) => String(row['subscriptionId'])),
      ['sub-new-duplicate', 'sub-old-survivor'],
      'neither claim moved',
    );
    assert.deepEqual(orphanedOnRetiredRows(prisma, 'trialClaim', 'subscriptionId'), []);
  });
});

/**
 * THE USERNAME RESOLVE ROUTE, which no other fixture in this file reaches.
 *
 * `routeOf` prefers the subscription short UUID recovered from `config_url` and
 * falls back to `remnawave_panel_username`. Every other case here carries a
 * resolvable URL, so the fallback — the only route a 2.x-era row that was never
 * given a subscription URL has — was untested.
 */
describe('DuplicateSubscriptionMergeService — the username resolve route', () => {
  /**
   * Two path segments and no `/sub/` prefix, so `panelShortUuidFromConfigUrl`
   * finds nothing that is profile material and `routeOf` falls through.
   */
  const NO_SHORT_UUID = 'https://panel.example.test/dashboard/users';

  const usernamePanel = () =>
    panelHarness({
      resolve: (selector) =>
        selector['username'] === 'rz_alice_sub'
          ? { id: 5150, shortUuid: 'AAAshortAAA', username: 'rz_alice_sub' }
          : null,
    });

  it('resolves each half by its stored panel username when neither carries a short UUID', async () => {
    const prisma = prismaHarness({
      subscription: [
        survivorRow({ configUrl: NO_SHORT_UUID }),
        duplicateRow({ configUrl: NO_SHORT_UUID }),
      ],
    });
    const panel = usernamePanel();

    const report = await service(prisma, panel).merge({ dryRun: false, pairs: CANONICAL_PAIR });

    assert.deepEqual(
      panel.resolveCalls,
      [{ username: 'rz_alice_sub' }, { username: 'rz_alice_sub' }],
      'both halves went down the username route, and neither by a short UUID',
    );
    assert.equal(report.merged, 1);
    assert.equal(prisma.subscription('sub-old-survivor')['remnawaveId'], '5150');
    assert.equal(prisma.subscription('sub-old-survivor')['remnawavePanelId'], 5150);
    assert.equal(prisma.subscription('sub-new-duplicate')['status'], SubscriptionStatus.DELETED);
    assert.deepEqual(retiredRowsStillNamingAProfile(prisma), []);
  });

  it('asks two DIFFERENT questions on the short UUID route and the SAME question twice on the username one', async () => {
    // THE LIMIT, ASSERTED RATHER THAN DESCRIBED. `differentPanelProfiles` is
    // decided by comparing two resolves, and it is only an independent check
    // while the two resolves use different KEYS. A duplicate pair carries the
    // SAME `remnawave_panel_username` on both halves by construction —
    // `RemnawaveImporterService` writes it off the panel row both were built
    // from — so on the fallback route the comparison is one selector resolved
    // twice and cannot fail however the panel answers.
    const byShortUuid = prismaHarness({ subscription: [survivorRow(), duplicateRow()] });
    const shortUuidPanel = panelHarness();
    const shortUuidReport = await service(byShortUuid, shortUuidPanel).merge({
      dryRun: true,
      pairs: CANONICAL_PAIR,
    });
    assert.equal(shortUuidReport.wouldMerge, 1);
    assert.equal(shortUuidPanel.resolveCalls.length, 2);
    assert.notDeepEqual(
      shortUuidPanel.resolveCalls[0],
      shortUuidPanel.resolveCalls[1],
      'two independent keys: a panel that named two profiles for them would be caught',
    );

    const byUsername = prismaHarness({
      subscription: [
        survivorRow({ configUrl: NO_SHORT_UUID }),
        duplicateRow({ configUrl: NO_SHORT_UUID }),
      ],
    });
    const namePanel = usernamePanel();
    const usernameReport = await service(byUsername, namePanel).merge({
      dryRun: true,
      pairs: CANONICAL_PAIR,
    });
    assert.equal(usernameReport.wouldMerge, 1);
    assert.equal(namePanel.resolveCalls.length, 2);
    assert.deepEqual(
      namePanel.resolveCalls[0],
      namePanel.resolveCalls[1],
      'ONE key resolved twice — which is the limit the code comment now states rather than ' +
        'claiming the resolves are always independent',
    );
  });

  it('still refuses on the username route when the profile marker names another customer', async () => {
    // What the fallback route does NOT weaken. The comparison is vacuous there,
    // but the ownership read is not derived from the username at all, and it is
    // what stands between this merge and somebody else's profile.
    const prisma = prismaHarness({
      subscription: [
        survivorRow({ configUrl: NO_SHORT_UUID }),
        duplicateRow({ configUrl: NO_SHORT_UUID }),
      ],
    });
    const panel = panelHarness({
      resolve: () => ({ id: 5150, shortUuid: null, username: 'rz_alice_sub' }),
      profile: () => ({
        kind: 'ok',
        user: { description: 'name: Mallory\nreiwa_id: user-999', username: 'rz_alice_sub' },
      }),
    });

    const report = await service(prisma, panel).merge({ dryRun: false, pairs: CANONICAL_PAIR });

    assert.equal(report.rows[0].refusal, 'notOwned');
    assert.deepEqual(panel.resolveCalls, [
      { username: 'rz_alice_sub' },
      { username: 'rz_alice_sub' },
    ]);
    assert.deepEqual(prisma.writes, []);
    assert.equal(prisma.subscription('sub-new-duplicate')['status'], SubscriptionStatus.ACTIVE);
  });

  it('reports the mixed pair honestly: one half by short UUID, the other by name', async () => {
    // Independence where it really exists — the survivor lost its URL and the
    // duplicate did not, so the two keys are genuinely different and the
    // comparison has something to compare.
    const prisma = prismaHarness({
      subscription: [survivorRow({ configUrl: NO_SHORT_UUID }), duplicateRow()],
    });
    const panel = panelHarness({
      resolve: () => ({ id: 5150, shortUuid: 'AAAshortAAA', username: 'rz_alice_sub' }),
    });

    const report = await service(prisma, panel).merge({ dryRun: true, pairs: CANONICAL_PAIR });

    assert.equal(report.wouldMerge, 1);
    assert.deepEqual(panel.resolveCalls, [
      { username: 'rz_alice_sub' },
      { shortUuid: 'AAAshortAAA' },
    ]);
  });
});

describe('AdminDuplicateSubscriptionMergeController', () => {
  function controllerHarness(report: Record<string, unknown>) {
    const received: unknown[] = [];
    const audits: unknown[] = [];
    const controller = new AdminDuplicateSubscriptionMergeController(
      {
        merge: async (options: unknown) => {
          received.push(options);
          return report;
        },
      } as never,
      { adminAuditLog: { create: async (input: unknown) => audits.push(input) } } as never,
    );
    return { controller, received, audits };
  }

  const MERGED_REPORT = {
    dryRun: false,
    pairsExamined: 1,
    merged: 1,
    wouldMerge: 0,
    refused: 0,
    stoppedEarly: null as Record<string, unknown> | null,
    hasMore: false,
    nextCursor: null as string | null,
    panelEra: '3.x',
    rows: [
      {
        survivorSubscriptionId: 'sub-old-survivor',
        duplicateSubscriptionId: 'sub-new-duplicate',
        userId: 'user-1',
        outcome: 'merged',
        refusal: null,
        reason: null,
        remnawaveId: '5150',
        remnawavePanelId: 5150,
        panelUsername: 'rz_alice_sub',
        configUrl: 'https://sub.example.test/AAAshortAAA',
        survivorPreviousRemnawaveId: DEAD_UUID,
        survivorPreviousPanelId: null,
        duplicatePreviousRemnawaveId: '5150',
        duplicatePreviousPanelId: 5150,
        survivorHoldsLiveIdentity: false,
        duplicateHoldsLiveIdentity: true,
        reattached: [{ relation: 'transactions', model: 'Transaction', column: 'subscription_id', moved: 2 }],
        supersededSyncJobs: 1,
      },
    ],
  };

  const REQUEST = { headers: {}, ip: '10.0.0.1' } as never;
  const ADMIN = { id: 'admin-1' } as never;

  it('reads the STRING "false" as a dry run', async () => {
    const harness = controllerHarness({ ...MERGED_REPORT, dryRun: true, merged: 0, wouldMerge: 1 });

    await harness.controller.mergeDuplicateSubscriptions(
      { dryRun: 'false', pairs: [{ survivorSubscriptionId: 'a', duplicateSubscriptionId: 'b' }] },
      ADMIN,
      REQUEST,
    );

    assert.equal(
      (harness.received[0] as { dryRun: boolean }).dryRun,
      true,
      'a string off a form or a query string must never be read as a request to write',
    );
    // The pair still reached the service: this is a preview, not a rejection.
    assert.deepEqual((harness.received[0] as { pairs: unknown }).pairs, [
      { survivorSubscriptionId: 'a', duplicateSubscriptionId: 'b' },
    ]);
    assert.deepEqual(harness.audits, [], 'a dry run is never audited');
  });

  it('passes the boolean false through and audits the run', async () => {
    const harness = controllerHarness(MERGED_REPORT);

    await harness.controller.mergeDuplicateSubscriptions({ dryRun: false }, ADMIN, REQUEST);

    assert.equal((harness.received[0] as { dryRun: boolean }).dryRun, false);
    assert.equal(harness.audits.length, 1);
    const audit = harness.audits[0] as { data: { action: string; metadata: Record<string, unknown> } };
    assert.equal(audit.data.action, 'subscriptions.duplicate_pair_merged');
    const pairs = audit.data.metadata['pairs'] as Array<Record<string, unknown>>;
    // Enough to undo by hand: both ids, whose they were, and — the half that
    // exists nowhere else any more — what each row held BEFORE the merge.
    assert.equal(pairs[0]['survivorSubscriptionId'], 'sub-old-survivor');
    assert.equal(pairs[0]['duplicateSubscriptionId'], 'sub-new-duplicate');
    assert.equal(pairs[0]['userId'], 'user-1');
    assert.equal(pairs[0]['survivorPreviousRemnawaveId'], DEAD_UUID);
    assert.equal(pairs[0]['duplicatePreviousRemnawaveId'], '5150');
    // The four columns above say what each row STORED; these two say which of
    // those stored values the panel answered to. Putting the identity back on
    // the half that was never bound to it is not an undo.
    assert.equal(pairs[0]['survivorHoldsLiveIdentity'], false);
    assert.equal(pairs[0]['duplicateHoldsLiveIdentity'], true);
    assert.deepEqual(pairs[0]['reattached'], [
      { relation: 'transactions', model: 'Transaction', column: 'subscription_id', moved: 2 },
    ]);
  });

  it('audits a real run that merged NOTHING, unlike the sweep next door', async () => {
    // The reconciliation controller gates its audit on `linked > 0`, which is
    // right for a repair that may legitimately find nothing. A merge run that
    // refused four pairs is exactly the run somebody needs to read later.
    const harness = controllerHarness({
      ...MERGED_REPORT,
      merged: 0,
      refused: 1,
      rows: [{ ...MERGED_REPORT.rows[0], outcome: 'refused', refusal: 'differentCustomers' }],
    });

    await harness.controller.mergeDuplicateSubscriptions({ dryRun: false }, ADMIN, REQUEST);

    assert.equal(harness.audits.length, 1, 'a real run is always audited, merged or not');
    const audit = harness.audits[0] as { data: { metadata: Record<string, unknown> } };
    const pairs = audit.data.metadata['pairs'] as Array<Record<string, unknown>>;
    assert.equal(pairs[0]['refusal'], 'differentCustomers');
  });

  it('audits a run that STOPPED, so the pairs that committed are still recorded', async () => {
    // The failure this guards is not a wrong metadata field: it is the audit row
    // NOT EXISTING. A throw on pair 2 leaves pair 1 committed with its identity
    // columns already NULL, and this row is the only place its previous values
    // survive — so the service reports the stop rather than throwing, and this is
    // what proves the controller still writes the row when it does.
    const harness = controllerHarness({
      ...MERGED_REPORT,
      pairsExamined: 2,
      merged: 1,
      refused: 1,
      hasMore: true,
      nextCursor: 'sub-window-start',
      stoppedEarly: {
        survivorSubscriptionId: 'sub-old-b',
        duplicateSubscriptionId: 'sub-new-b',
        pairsCompleted: 1,
        errorName: 'PrismaClientKnownRequestError',
        errorCode: 'P2002',
        message: 'Unique constraint failed on the fields: (`currentSubscriptionId`)',
      },
      rows: [
        MERGED_REPORT.rows[0],
        {
          ...MERGED_REPORT.rows[0],
          survivorSubscriptionId: 'sub-old-b',
          duplicateSubscriptionId: 'sub-new-b',
          outcome: 'refused',
          refusal: 'raceLost',
        },
      ],
    });

    await harness.controller.mergeDuplicateSubscriptions({ dryRun: false }, ADMIN, REQUEST);

    assert.equal(harness.audits.length, 1, 'the run that stopped is exactly the run that must be audited');
    const audit = harness.audits[0] as { data: { metadata: Record<string, unknown> } };
    const pairs = audit.data.metadata['pairs'] as Array<Record<string, unknown>>;
    assert.equal(pairs.length, 2, 'the committed pair and the one that failed');
    // The committed pair's undo values are what exists nowhere else any more.
    assert.equal(pairs[0]['survivorPreviousRemnawaveId'], DEAD_UUID);
    assert.equal(pairs[0]['duplicatePreviousRemnawaveId'], '5150');
    assert.equal(pairs[1]['refusal'], 'raceLost');
    // And the operator is told the batch broke off, on which pair and why.
    const stop = audit.data.metadata['stoppedEarly'] as Record<string, unknown>;
    assert.equal(stop['survivorSubscriptionId'], 'sub-old-b');
    assert.equal(stop['duplicateSubscriptionId'], 'sub-new-b');
    assert.equal(stop['pairsCompleted'], 1);
    assert.equal(stop['errorCode'], 'P2002');
    assert.equal(
      audit.data.metadata['nextCursor'],
      'sub-window-start',
      'the cursor recorded must be the one that re-reads the window, not one past it',
    );
  });

  it('records stoppedEarly as null on a run that reached the end of its pairs', async () => {
    // The direction-complete half: an audit that always said "stopped" would be
    // as useless as one that never did.
    const harness = controllerHarness(MERGED_REPORT);

    await harness.controller.mergeDuplicateSubscriptions({ dryRun: false }, ADMIN, REQUEST);

    const audit = harness.audits[0] as { data: { metadata: Record<string, unknown> } };
    assert.equal(audit.data.metadata['stoppedEarly'], null);
    assert.equal(audit.data.metadata['merged'], 1);
  });

  it('drops malformed pair entries instead of coercing them', async () => {
    const harness = controllerHarness({ ...MERGED_REPORT, dryRun: true });

    await harness.controller.mergeDuplicateSubscriptions(
      {
        dryRun: true,
        pairs: [
          { survivorSubscriptionId: 'a', duplicateSubscriptionId: 'b' },
          { survivorSubscriptionId: 'c' },
          { survivorSubscriptionId: '', duplicateSubscriptionId: 'd' },
          'not-an-object',
          null,
        ],
      },
      ADMIN,
      REQUEST,
    );

    assert.deepEqual((harness.received[0] as { pairs: unknown }).pairs, [
      { survivorSubscriptionId: 'a', duplicateSubscriptionId: 'b' },
    ]);
  });
});
