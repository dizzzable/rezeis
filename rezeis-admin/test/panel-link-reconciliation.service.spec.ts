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

/** A `subscriptions` row with every column the reconciliation reads set. */
function subscriptionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-fits',
    userId: 'user-1',
    status: SubscriptionStatus.ACTIVE,
    remnawaveId: null as string | null,
    remnawavePanelId: null as number | null,
    remnawavePanelUsername: 'rz_alice_sub',
    configUrl: 'https://sub.example.test/AAAshortAAA',
    ...overrides,
  };
}

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
      throw new Error(`unsupported where operator: ${JSON.stringify(condition)}`);
    }
    return row[field] === condition;
  });
}

interface PrismaHarness {
  readonly client: unknown;
  readonly table: Array<Record<string, unknown>>;
  readonly writes: unknown[];
  readonly transactions: number[];
  readonly rawLocks: unknown[];
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
  conflictProbe: () => Array<{ conflictId?: string | null }> = () => [],
): PrismaHarness {
  const table = rows;
  const writes: unknown[] = [];
  const transactions: number[] = [];
  const rawLocks: unknown[] = [];

  const subscription = {
    findMany: async (input: {
      where: Record<string, unknown>;
      take: number;
    }): Promise<Array<Record<string, unknown>>> =>
      table
        .filter((row) => matchesWhere(row, input.where))
        .sort((left, right) => String(left['id']).localeCompare(String(right['id'])))
        .slice(0, input.take)
        .map((row) => ({ ...row })),
    findFirst: async (input: { where: Record<string, unknown> }) => {
      const hit = table.find((row) => matchesWhere(row, input.where));
      return hit === undefined ? null : { id: hit['id'] };
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
        $queryRaw: async () => conflictProbe(),
        subscription,
      });
    },
  };

  return { client, table, writes, transactions, rawLocks };
}

interface PanelHarness {
  readonly api: unknown;
  readonly resolveCalls: unknown[];
  readonly profileCalls: unknown[];
}

/** The panel adapter, answering only the two calls a repair may make. */
function panelHarness(input: {
  resolve?: (selector: unknown) => {
    id: number;
    shortUuid: string | null;
    username: string | null;
    uuid: string | null;
  } | null;
  profile?: (identity: unknown) => { kind: string; user?: Record<string, unknown> };
}): PanelHarness {
  const resolveCalls: unknown[] = [];
  const profileCalls: unknown[] = [];
  return {
    resolveCalls,
    profileCalls,
    api: {
      resolvePanelIdentity: async (selector: unknown) => {
        resolveCalls.push(selector);
        return input.resolve === undefined
          ? { id: 5150, shortUuid: 'AAAshortAAA', username: 'rz_alice_sub', uuid: null }
          : input.resolve(selector);
      },
      getPanelUserOutcome: async (identity: unknown) => {
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
      [...report.repaired, ...report.unrepaired].map((row) => row.subscriptionId),
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
