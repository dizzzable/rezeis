import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { _resetProcessRoleCacheForTests } from '../src/common/runtime/process-role.util';
import {
  ConnectSignalProbeService,
  type ConnectProbeStatus,
} from '../src/modules/connect-signal/services/connect-signal-probe.service';
import type { ProbeCandidateRow } from '../src/modules/connect-signal/connect-probe.sql';

/**
 * The probe's decisions, through its real `tick` / `runCycle` / `recheck`.
 *
 * The Prisma double tells the three statements apart by their text (the
 * candidate query, the backlog count, the settings read) and RECORDS every
 * write; `subscription.findMany` honours the fan-out `where`. The panel double
 * counts reads in flight. Which rows the candidate query picks, in which order,
 * with which backoff, is proven against PostgreSQL in
 * `connect-signal-postgres.spec.ts`.
 */

type Where = Record<string, unknown>;

function matches(where: Where | undefined, row: Record<string, unknown>): boolean {
  if (where === undefined) return true;
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'AND') return (condition as Where[]).every((part) => matches(part, row));
    if (key === 'OR') return (condition as Where[]).some((part) => matches(part, row));
    const value = row[key];
    if (condition !== null && typeof condition === 'object') {
      const operators = condition as Record<string, unknown>;
      if ('not' in operators) return value !== operators['not'];
      if ('in' in operators) return (operators['in'] as unknown[]).includes(value);
      throw new Error(`the double does not know ${JSON.stringify(condition)}`);
    }
    return value === condition;
  });
}

function candidate(id: string, overrides: Partial<ProbeCandidateRow> = {}): ProbeCandidateRow {
  return {
    id,
    userId: `user-${id}`,
    remnawaveId: String(100 + Number(id.replace(/\D/g, '') || 0)),
    remnawavePanelId: null,
    remnawavePanelUsername: null,
    configUrl: null,
    checkedAt: null,
    dueSoon: false,
    ...overrides,
  };
}

type Outcome =
  | { readonly kind: 'ok'; readonly user: { readonly userTraffic: unknown } }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unavailable' };

const NEVER = { usedTrafficBytes: 0, lifetimeUsedTrafficBytes: 0, onlineAt: null, firstConnectedAt: null };

function harness(options: {
  readonly candidates: readonly ProbeCandidateRow[];
  readonly read?: (remnawaveId: string) => Promise<Outcome>;
  readonly addressing?: 'id' | 'uuid' | 'unknown';
  readonly backlog?: number;
  readonly previousStatus?: ConnectProbeStatus | null;
  readonly failCandidateQuery?: boolean;
}) {
  const queries: Array<{ readonly sql: string; readonly values: readonly unknown[] }> = [];
  const executes: Array<{ readonly sql: string; readonly values: readonly unknown[] }> = [];
  const upserts: Array<{ readonly sql: string; readonly values: readonly unknown[] }> = [];
  const reads: string[] = [];
  const claims: Array<Record<string, unknown>> = [];
  const events: Array<{ readonly type: string; readonly metadata: Record<string, unknown> }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let stored: ConnectProbeStatus | null = options.previousStatus ?? null;
  const subscriptionRows = options.candidates.map((row) => ({
    id: row.id,
    remnawaveId: row.remnawaveId,
    remnawavePanelId: row.remnawavePanelId,
    status: 'ACTIVE',
  }));

  const prisma = {
    $queryRaw: async (query: { sql: string; values: unknown[] }) => {
      if (/AS "dueSoon"/.test(query.sql)) {
        queries.push({ sql: query.sql, values: query.values });
        if (options.failCandidateQuery === true) throw new Error('statement timeout');
        return options.candidates;
      }
      if (/AS "backlog"/.test(query.sql)) return [{ backlog: options.backlog ?? 0 }];
      if (/"connect_help_settings"/.test(query.sql)) return [{ settings: {} }];
      upserts.push({ sql: query.sql, values: query.values });
      return [];
    },
    $executeRaw: async (query: { sql: string; values: unknown[] }) => {
      executes.push({ sql: query.sql, values: query.values });
      return 1;
    },
    subscription: {
      findMany: async (args: { where?: Where }) =>
        subscriptionRows.filter((row) => matches(args.where, row)).map((row) => ({ id: row.id })),
      findFirst: async (args: { where: Where }) => {
        const row = options.candidates.find((c) => c.id === (args.where as { id: string }).id);
        return row === undefined ? null : { ...row };
      },
    },
    user: {
      updateMany: async (args: { where: Where; data: Record<string, unknown> }) => {
        claims.push({ where: args.where, data: args.data });
        return { count: 1 };
      },
      findUnique: async () => ({ telegramId: null, name: 'Anna', username: null }),
    },
  };
  const api = {
    getPanelShape: async () => ({ addressing: options.addressing ?? 'id' }),
    getPanelUserOutcome: async (identity: { remnawaveId: string }) => {
      reads.push(identity.remnawaveId);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await (options.read ?? (async () => ({ kind: 'ok', user: { userTraffic: NEVER } }) as Outcome))(
          identity.remnawaveId,
        );
      } finally {
        inFlight -= 1;
      }
    },
  };
  const cache = {
    get: async () => stored,
    set: async (_key: string, value: ConnectProbeStatus) => {
      stored = value;
    },
  };
  const systemEvents = {
    info: (type: string, _category: string, _message: string, metadata: Record<string, unknown>) => {
      events.push({ type, metadata });
    },
  };
  const service = new ConnectSignalProbeService(prisma as never, api as never, cache as never, systemEvents as never);
  return {
    service,
    queries,
    executes,
    upserts,
    reads,
    claims,
    events,
    maxInFlight: () => maxInFlight,
    status: () => stored,
  };
}

const isFailure = (call: { readonly sql: string }) => /"check_failures" \+ 1/.test(call.sql);
const isMissing = (call: { readonly sql: string }) => /"profile_missing_at"/.test(call.sql);
const isEvidence = (call: { readonly sql: string }) => /"connected_source"/.test(call.sql);
const isCheck = (call: { readonly sql: string }) =>
  !/"connected_source"/.test(call.sql) && /"checked_at"/.test(call.sql);

describe('the probe runs only where schedules run', () => {
  const role = process.env.RUID_PROCESS_ROLE;
  afterEach(() => {
    if (role === undefined) delete process.env.RUID_PROCESS_ROLE;
    else process.env.RUID_PROCESS_ROLE = role;
    _resetProcessRoleCacheForTests();
  });

  it('does nothing at all in the API process', async () => {
    process.env.RUID_PROCESS_ROLE = 'api';
    _resetProcessRoleCacheForTests();
    const h = harness({ candidates: [candidate('s1')] });

    await h.service.tick();

    assert.equal(h.queries.length, 0);
    assert.equal(h.reads.length, 0);
    assert.equal(h.status(), null);
  });

  it('runs a cycle in the worker', async () => {
    process.env.RUID_PROCESS_ROLE = 'worker';
    _resetProcessRoleCacheForTests();
    const h = harness({ candidates: [candidate('s1')] });

    await h.service.tick();

    assert.equal(h.queries.length, 1);
    assert.deepStrictEqual(h.reads, ['101']);
  });

  it('stands down while a cycle is still running', async () => {
    process.env.RUID_PROCESS_ROLE = 'worker';
    _resetProcessRoleCacheForTests();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      candidates: [candidate('s1')],
      read: async () => {
        await gate;
        return { kind: 'ok', user: { userTraffic: NEVER } };
      },
    });

    const first = h.service.tick();
    await new Promise((resolve) => setImmediate(resolve));
    await h.service.tick();
    release();
    await first;

    assert.equal(h.queries.length, 1, 'the overlapping tick did not start a second cycle');
  });
});

describe('one probe cycle', () => {
  it('asks for at most 100 candidates', async () => {
    const h = harness({ candidates: [] });

    await h.service.runCycle();

    // `Sql.sql` renders every bound value as `?`; the LIMIT is the last of them.
    assert.match(h.queries[0]!.sql, /LIMIT \?\s*$/);
    assert.equal(h.queries[0]!.values[h.queries[0]!.values.length - 1], 100);
  });

  it('keeps at most four reads in flight', async () => {
    const h = harness({
      candidates: Array.from({ length: 13 }, (_, i) => candidate(`s${i + 1}`)),
      read: async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return { kind: 'ok', user: { userTraffic: NEVER } };
      },
    });

    const result = await h.service.runCycle();

    assert.equal(h.reads.length, 13);
    assert.equal(h.maxInFlight(), 4);
    assert.equal(result.notConnected, 13);
  });

  it('records a check for "not connected" and evidence for "connected"', async () => {
    const h = harness({
      candidates: [candidate('s1'), candidate('s2')],
      read: async (id) =>
        id === '101'
          ? { kind: 'ok', user: { userTraffic: NEVER } }
          : {
              kind: 'ok',
              user: {
                userTraffic: { ...NEVER, lifetimeUsedTrafficBytes: 10, firstConnectedAt: '2026-09-01T00:00:00.000Z' },
              },
            },
    });

    const result = await h.service.runCycle();

    assert.deepStrictEqual(
      { connected: result.connected, notConnected: result.notConnected, failed: result.failed },
      { connected: 1, notConnected: 1, failed: 0 },
    );
    const evidence = h.upserts.filter(isEvidence);
    assert.equal(evidence.length, 1);
    assert.ok(evidence[0]!.values.includes('probe'));
    assert.ok(evidence[0]!.values.includes('s2'));
    assert.equal(h.upserts.filter(isCheck).length, 1);
    assert.equal(h.executes.length, 0, 'no failure, no missing');
  });

  it('counts an outage, stamps nothing, and backs off', async () => {
    const h = harness({ candidates: [candidate('s1')], read: async () => ({ kind: 'unavailable' }) });

    const result = await h.service.runCycle();

    assert.equal(result.failed, 1);
    assert.equal(h.upserts.length, 0, 'a failed read verifies nothing');
    assert.equal(h.executes.filter(isFailure).length, 1);
  });

  it('reads a row without a traffic block as unavailable, never as "not connected"', async () => {
    const h = harness({ candidates: [candidate('s1')], read: async () => ({ kind: 'ok', user: { userTraffic: null } }) });

    const result = await h.service.runCycle();

    assert.equal(result.failed, 1);
    assert.equal(result.notConnected, 0);
    assert.equal(h.upserts.length, 0);
    assert.equal(h.executes.filter(isFailure).length, 1);
  });

  it('records the panel’s own "no such profile", never as "not connected"', async () => {
    const h = harness({ candidates: [candidate('s1')], read: async () => ({ kind: 'missing' }) });

    const result = await h.service.runCycle();

    assert.equal(result.missing, 1);
    assert.equal(h.upserts.length, 0);
    assert.equal(h.executes.filter(isMissing).length, 1);
    assert.equal(h.executes.filter(isFailure).length, 0);
  });

  it('does not ask the panel about a profile it cannot name, and does not count it as an outage', async () => {
    const h = harness({
      addressing: 'id',
      candidates: [candidate('s1', { remnawaveId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' }), candidate('s2')],
    });

    const result = await h.service.runCycle();

    assert.deepStrictEqual(h.reads, ['102']);
    assert.equal(result.unaddressable, 1);
    assert.equal(result.failed, 0);
    assert.equal(h.executes.filter(isFailure).length, 1, 'it still backs off');
    assert.equal(h.status()?.lastOkAt !== null, true, 'a cycle of unnameable profiles is not a dead panel');
  });

  describe('the three-second deadline', () => {
    beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
    afterEach(() => mock.timers.reset());

    it('gives up on a read after three seconds and counts it as unavailable', async () => {
      let called: () => void = () => undefined;
      const readStarted = new Promise<void>((resolve) => {
        called = resolve;
      });
      const h = harness({
        candidates: [candidate('s1')],
        read: () => {
          called();
          return new Promise<Outcome>(() => undefined);
        },
      });

      const cycle = h.service.runCycle();
      let settled = false;
      void cycle.then(() => {
        settled = true;
      });
      // `setImmediate` is not faked: it lets the cycle run on without waiting
      // on a timer, and a cycle with no deadline fails here instead of hanging.
      const drain = async () => {
        for (let i = 0; i < 50 && !settled; i += 1) await new Promise((resolve) => setImmediate(resolve));
      };
      await readStarted;
      mock.timers.tick(2_999);
      await drain();
      assert.equal(settled, false, 'not before three seconds');
      assert.equal(h.executes.length, 0);
      mock.timers.tick(1);
      await drain();
      assert.equal(settled, true, 'the cycle moved on at three seconds');
      const result = await cycle;

      assert.equal(result.failed, 1);
      assert.equal(h.executes.filter(isFailure).length, 1);
      assert.equal(h.upserts.length, 0);
    });
  });

  it('announces a fresh first connection it found, and claims an old one silently', async () => {
    const fresh = new Date(Date.now() - 60 * 60_000).toISOString();
    const h = harness({
      candidates: [candidate('s1'), candidate('s2')],
      read: async (id) => ({
        kind: 'ok',
        user: {
          userTraffic: {
            ...NEVER,
            lifetimeUsedTrafficBytes: 1,
            firstConnectedAt: id === '101' ? fresh : '2026-03-01T00:00:00.000Z',
          },
        },
      }),
    });

    await h.service.runCycle();

    assert.equal(h.claims.length, 2);
    assert.deepStrictEqual(
      h.events.map((event) => event.metadata['userId']),
      ['user-s1'],
    );
    assert.equal(h.events[0]!.type, 'user.first_traffic');
  });
});

describe('the status the probe leaves for the API process', () => {
  it('mirrors the cycle and marks the first pass done once nothing was left untried', async () => {
    const h = harness({ candidates: [candidate('s1')], backlog: 0 });

    await h.service.runCycle(new Date('2026-09-19T12:00:00.000Z'));

    const status = h.status();
    assert.ok(status !== null);
    assert.equal(status.lastOkAt, '2026-09-19T12:00:00.000Z');
    assert.equal(status.failingSince, null);
    assert.equal(status.firstPassCompletedAt, '2026-09-19T12:00:00.000Z');
    assert.equal(status.notConnected, 1);
  });

  it('keeps the first pass open while untried subscriptions remain', async () => {
    const h = harness({ candidates: [candidate('s1')], backlog: 240 });

    await h.service.runCycle(new Date('2026-09-19T12:00:00.000Z'));

    assert.equal(h.status()?.firstPassCompletedAt, null);
    assert.equal(h.status()?.backlog, 240);
  });

  it('carries "failing since" across failed cycles and keeps the last success', async () => {
    const h = harness({
      candidates: [candidate('s1')],
      read: async () => ({ kind: 'unavailable' }),
      previousStatus: {
        lastCycleAt: '2026-09-19T11:00:00.000Z',
        lastOkAt: '2026-09-19T11:00:00.000Z',
        lastFailAt: null,
        lastReason: null,
        failingSince: null,
        firstPassCompletedAt: '2026-09-18T00:00:00.000Z',
        candidates: 1,
        connected: 0,
        notConnected: 1,
        missing: 0,
        failed: 0,
        unaddressable: 0,
        backlog: 0,
        durationMs: 5,
      },
    });

    await h.service.runCycle(new Date('2026-09-19T11:10:00.000Z'));
    await h.service.runCycle(new Date('2026-09-19T11:20:00.000Z'));

    const status = h.status();
    assert.equal(status?.lastOkAt, '2026-09-19T11:00:00.000Z');
    assert.equal(status?.failingSince, '2026-09-19T11:10:00.000Z');
    assert.equal(status?.lastFailAt, '2026-09-19T11:20:00.000Z');
    assert.equal(status?.firstPassCompletedAt, '2026-09-18T00:00:00.000Z');
  });

  it('mirrors a cycle that threw as a failure, then throws', async () => {
    const h = harness({ candidates: [], failCandidateQuery: true });

    await assert.rejects(h.service.runCycle(new Date('2026-09-19T12:00:00.000Z')), /statement timeout/);

    assert.equal(h.status()?.lastFailAt, '2026-09-19T12:00:00.000Z');
    assert.match(h.status()?.lastReason ?? '', /statement timeout/);
    assert.equal(h.status()?.lastOkAt, null);
  });
});

describe('recheck — the sender’s last look', () => {
  it('reads one subscription and writes what it proves', async () => {
    const h = harness({ candidates: [candidate('s1')], read: async () => ({ kind: 'ok', user: { userTraffic: NEVER } }) });

    assert.equal(await h.service.recheck('s1'), 'not_connected');
    assert.equal(h.upserts.filter(isCheck).length, 1);
  });

  it('answers "gone" for no live subscription with a profile, and reads nothing', async () => {
    const h = harness({ candidates: [candidate('s1')] });

    assert.equal(await h.service.recheck('nope'), 'gone');
    assert.deepStrictEqual(h.reads, []);
  });
});
