import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { SubscriptionStatus } from '@prisma/client';

import { _resetProcessRoleCacheForTests } from '../src/common/runtime/process-role.util';
import {
  IMPORT_SOURCES_THAT_LINK,
  PANEL_LINK_CHECK_KEYS,
  PANEL_LINK_CHECK_LOCK_TTL_SECONDS,
  PANEL_LINK_CHECK_RETRY_MS,
  PANEL_LINK_CHECK_WALK_BUDGET_MS,
  PANEL_LINK_CHECK_WALK_LIMIT,
  PanelLinkCheckService,
} from '../src/modules/profile-sync/panel-link-check.service';
import type {
  PanelLinkReconciliationReport,
  PanelLinkReconciliationRow,
} from '../src/modules/profile-sync/panel-link-reconciliation.service';
import type { PanelProfileComparisonOutcome } from '../src/modules/profile-sync/panel-profile-comparison.service';

/**
 * «Починка привязки к панели» without the button (owner's decision,
 * 24.09.2026): the check runs by itself — at worker boot, after every backup
 * import, once a day and an hour after a pass that could not finish — never two
 * at once, never on the API process, and keeps what it could not prove for
 * «Подписки» → «Инструменты».
 */

// ── The cache: Redis semantics, in memory ────────────────────────────────────

class FakeCache {
  public readonly store = new Map<string, unknown>();
  public readonly ttls = new Map<string, number | undefined>();
  public readonly claims: Array<{ key: string; ttl: number }> = [];
  public ready = true;
  public failWrites = false;
  private readonly pausedGets = new Map<string, { reached: () => void; released: Promise<void> }>();

  /**
   * Holds the NEXT `get` of `key` right after it has read the value, until
   * `release` — a read-then-write caught between its two halves, which is the
   * whole shape of a lost or resurrected request.
   */
  pauseNextGet(key: string): { readonly reached: Promise<void>; readonly release: () => void } {
    let reached!: () => void;
    let release!: () => void;
    const reachedPromise = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pausedGets.set(key, { reached, released });
    return { reached: reachedPromise, release };
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.ready) return null;
    const value = (this.store.has(key) ? structuredClone(this.store.get(key)) : null) as T | null;
    const pause = this.pausedGets.get(key);
    if (pause !== undefined) {
      this.pausedGets.delete(key);
      pause.reached();
      await pause.released;
    }
    return value;
  }
  async set(key: string, value: unknown, ttl?: number): Promise<void> {
    if (this.failWrites) throw new Error('Redis write failed');
    if (!this.ready) return;
    this.store.set(key, structuredClone(value));
    this.ttls.set(key, ttl);
  }
  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
  /** GET and DEL in one step, as `RawCacheService.take` runs them (MULTI): nothing lands in between. */
  async take<T>(key: string): Promise<T | null> {
    if (!this.ready) return null;
    const value = (this.store.has(key) ? structuredClone(this.store.get(key)) : null) as T | null;
    this.store.delete(key);
    return value;
  }
  async exists(key: string): Promise<boolean> {
    return this.ready && this.store.has(key);
  }
  async claimOnce(key: string, ttl: number): Promise<boolean> {
    this.claims.push({ key, ttl });
    if (!this.ready || this.store.has(key)) return false;
    this.store.set(key, '1');
    return true;
  }
}

// ── The walk and the comparison, canned ──────────────────────────────────────

function row(overrides: Partial<PanelLinkReconciliationRow>): PanelLinkReconciliationRow {
  return {
    subscriptionId: 'sub-x',
    userId: 'user-1',
    panelUsername: 'rz_user_sub',
    resolvedBy: 'shortUuid',
    outcome: 'unresolved',
    reasonCode: 'notFound',
    remnawaveId: null,
    storedRemnawaveId: null,
    panelId: null,
    duplicateOfSubscriptionId: null,
    otherSubscriptionId: null,
    otherUserId: null,
    holdsLiveIdentity: false,
    scanned: true,
    reason: 'panel did not resolve',
    ...overrides,
  };
}

function report(overrides: Partial<PanelLinkReconciliationReport> = {}): PanelLinkReconciliationReport {
  return {
    dryRun: false,
    scanned: 0,
    linked: 0,
    wouldLink: 0,
    repaired: [],
    unrepaired: [],
    hasMore: false,
    walkComplete: true,
    nextCursor: null,
    panelUnavailable: false,
    staleIdentityScanned: 0,
    duplicatePairs: 0,
    sharedIdentityPairs: 0,
    ...overrides,
  };
}

function comparisonOk(
  overrides: Partial<Extract<PanelProfileComparisonOutcome, { kind: 'ok' }>['result']> = {},
): PanelProfileComparisonOutcome {
  return {
    kind: 'ok',
    result: {
      comparedAt: '2026-09-24T12:00:00.000Z',
      readOutcome: 'complete',
      profilesRead: 10,
      profilesWithoutOwner: 1,
      autoLinked: 0,
      customers: [],
      truncated: false,
      links: [],
      ...overrides,
    },
  };
}

// ── The database: the population statements, users, subscriptions, audit ────

interface Db {
  population: Array<Record<string, unknown>>;
  users: Array<Record<string, unknown>>;
  subscriptions: Array<Record<string, unknown>>;
  audits: unknown[];
  failAudit: boolean;
}

function prismaFor(db: Db) {
  return {
    $queryRaw: async (query: { text?: string; values?: unknown[] }) => {
      const text = String(query.text ?? '');
      if (text.includes('count(*)')) {
        return [
          {
            total: db.population.length,
            nonNumeric: db.population.filter((entry) => entry['remnawaveId'] !== null).length,
          },
        ];
      }
      if (text.includes('ORDER BY "created_at" ASC')) {
        const values = query.values ?? [];
        const take = Number(values[values.length - 1]);
        return db.population.slice(0, take);
      }
      throw new Error(`unexpected raw query: ${text}`);
    },
    user: {
      findMany: async (args: { where: { id: { in: string[] } } }) =>
        db.users.filter((user) => args.where.id.in.includes(String(user['id']))),
    },
    subscription: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        const where = args.where as {
          userId?: { in: string[] };
          OR?: Array<{ remnawaveId?: { in: string[] }; remnawavePanelId?: { in: number[] } }>;
        };
        return db.subscriptions.filter((entry) => {
          if (entry['status'] === SubscriptionStatus.DELETED) return false;
          if (where.userId !== undefined) return where.userId.in.includes(String(entry['userId']));
          return (where.OR ?? []).some(
            (alt) =>
              (alt.remnawaveId !== undefined && alt.remnawaveId.in.includes(String(entry['remnawaveId']))) ||
              (alt.remnawavePanelId !== undefined &&
                alt.remnawavePanelId.in.includes(entry['remnawavePanelId'] as number)),
          );
        });
      },
    },
    adminAuditLog: {
      create: async (args: unknown) => {
        if (db.failAudit) throw new Error('audit table locked');
        db.audits.push(args);
        return {};
      },
    },
  };
}

interface Rig {
  readonly service: PanelLinkCheckService;
  readonly cache: FakeCache;
  readonly db: Db;
  readonly walks: unknown[];
  readonly events: Array<{ severity: string; message: string; metadata: Record<string, unknown> }>;
  walk: () => Promise<PanelLinkReconciliationReport>;
  compare: () => Promise<PanelProfileComparisonOutcome>;
  compares: number;
}

function rig(): Rig {
  const cache = new FakeCache();
  const db: Db = { population: [], users: [], subscriptions: [], audits: [], failAudit: false };
  const walks: unknown[] = [];
  const events: Rig['events'] = [];
  const state = {
    walk: async () => report(),
    compare: async () => comparisonOk(),
    compares: 0,
  };
  const reconciliation = {
    reconcile: async (options: unknown) => {
      walks.push(options);
      return state.walk();
    },
  };
  const comparison = {
    compare: async () => {
      state.compares += 1;
      return state.compare();
    },
  };
  const push = (severity: string) => (_type: string, _category: string, message: string, metadata: Record<string, unknown>) =>
    events.push({ severity, message, metadata });
  const service = new PanelLinkCheckService(
    prismaFor(db) as never,
    reconciliation as never,
    comparison as never,
    cache as never,
    { info: push('INFO'), warn: push('WARNING'), error: push('ERROR') } as never,
  );
  return Object.assign(state, { service, cache, db, walks, events }) as Rig;
}

function withRole(role: string | undefined): void {
  if (role === undefined) delete process.env.RUID_PROCESS_ROLE;
  else process.env.RUID_PROCESS_ROLE = role;
  _resetProcessRoleCacheForTests();
}

const savedRole = process.env.RUID_PROCESS_ROLE;
beforeEach(() => withRole('worker'));
afterEach(() => withRole(savedRole));

function state(cache: FakeCache): Record<string, unknown> {
  return (cache.store.get(PANEL_LINK_CHECK_KEYS.state) ?? {}) as Record<string, unknown>;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** The claims of the pass lock alone — a pass also leases the import requests. */
function lockClaims(cache: FakeCache): Array<{ key: string; ttl: number }> {
  return cache.claims.filter((claim) => claim.key === PANEL_LINK_CHECK_KEYS.lock);
}

/** The imports each «После импорта…» card named, card by card. */
function namedImports(test: Rig): string[][] {
  return test.events
    .filter((event) => event.metadata['reason'] === 'links_unproven_after_import')
    .map((event) => [...(event.metadata['importRecordIds'] as string[])].sort());
}

// ═════════════════════════════════════════════════════════════════════════════

describe('PanelLinkCheckService — worker only', () => {
  it('does nothing at boot on the API process', async () => {
    withRole('api');
    const test = rig();

    test.service.onApplicationBootstrap();
    await settle();

    assert.deepEqual(test.cache.claims, []);
    assert.deepEqual(test.walks, []);
  });

  it('starts a pass at worker boot without waiting for it', async () => {
    const test = rig();
    let release!: () => void;
    test.walk = () =>
      new Promise((resolve) => {
        release = () => resolve(report());
      });

    const returned = test.service.onApplicationBootstrap();
    assert.equal(returned, undefined, 'boot is not held up by the pass');
    await settle();
    assert.equal(test.walks.length, 1, 'the pass is under way');

    release();
    await settle();
    await settle();
    assert.equal(state(test.cache)['lastRunTrigger'], 'boot');
  });

  it('does not tick on the API process', async () => {
    withRole('api');
    const test = rig();

    assert.equal(await test.service.tick(), 'skipped');
    assert.deepEqual(test.cache.claims, []);
  });
});

describe('PanelLinkCheckService — when a pass is due', () => {
  const at = new Date('2026-09-24T12:00:00.000Z');

  it('runs the first pass there is no record of', async () => {
    const test = rig();

    assert.equal(await test.service.tick(at), 'ran');
    assert.equal(state(test.cache)['lastRunTrigger'], 'boot');
  });

  it('is idle while the last pass is recent and complete', async () => {
    const test = rig();
    test.cache.store.set(PANEL_LINK_CHECK_KEYS.state, {
      lastRunAt: new Date(at.getTime() - 60_000).toISOString(),
      lastRunTrigger: 'daily',
      lastRunOutcome: 'complete',
      nextRetryAt: null,
      walkCursor: null,
    });

    assert.equal(await test.service.tick(at), 'idle');
    assert.deepEqual(test.walks, []);
  });

  it('runs the retry once its hour has come, and not before', async () => {
    const test = rig();
    const retryAt = new Date(at.getTime() + 60_000);
    test.cache.store.set(PANEL_LINK_CHECK_KEYS.state, {
      lastRunAt: new Date(at.getTime() - 3_540_000).toISOString(),
      lastRunTrigger: 'daily',
      lastRunOutcome: 'incomplete',
      nextRetryAt: retryAt.toISOString(),
      walkCursor: 'sub-m',
    });

    assert.equal(await test.service.tick(at), 'idle');
    assert.equal(await test.service.tick(new Date(retryAt.getTime() + 1)), 'ran');
    assert.equal(state(test.cache)['lastRunTrigger'], 'retry');
    assert.deepEqual(
      (test.walks[0] as { startAfterId: string | null }).startAfterId,
      'sub-m',
      'the retry continues where the walk stopped',
    );
  });

  it('runs once a day', async () => {
    const test = rig();
    test.cache.store.set(PANEL_LINK_CHECK_KEYS.state, {
      lastRunAt: new Date(at.getTime() - 24 * 3_600_000).toISOString(),
      lastRunTrigger: 'boot',
      lastRunOutcome: 'complete',
      nextRetryAt: null,
      walkCursor: null,
    });

    assert.equal(await test.service.tick(at), 'ran');
    assert.equal(state(test.cache)['lastRunTrigger'], 'daily');
  });

  it('runs at once for a finished import, whatever the day clock says', async () => {
    const test = rig();
    test.cache.store.set(PANEL_LINK_CHECK_KEYS.state, {
      lastRunAt: new Date(at.getTime() - 60_000).toISOString(),
      lastRunTrigger: 'daily',
      lastRunOutcome: 'complete',
      nextRetryAt: null,
      walkCursor: null,
    });
    await test.service.requestAfterImport({ importRecordId: 'import-1', sourceType: 'remnashop' });

    assert.equal(await test.service.tick(at), 'ran');
    assert.equal(state(test.cache)['lastRunTrigger'], 'import');
    assert.equal(test.cache.store.has(PANEL_LINK_CHECK_KEYS.requests), false, 'the request is answered once');
  });
});

describe('PanelLinkCheckService — never two at once', () => {
  it('does nothing while another process holds the pass, and leaves the import requests for later', async () => {
    const test = rig();
    test.cache.store.set(PANEL_LINK_CHECK_KEYS.lock, '1');
    await test.service.requestAfterImport({ importRecordId: 'import-1', sourceType: 'altshop' });

    assert.equal(await test.service.run('import'), 'busy');
    assert.deepEqual(test.walks, []);
    assert.equal(test.cache.store.has(PANEL_LINK_CHECK_KEYS.requests), true);
  });

  it('takes the lock for the pass with a time-to-live, and gives it back after', async () => {
    const test = rig();

    await test.service.run('daily');

    assert.deepEqual(lockClaims(test.cache), [
      { key: PANEL_LINK_CHECK_KEYS.lock, ttl: PANEL_LINK_CHECK_LOCK_TTL_SECONDS },
    ]);
    assert.equal(test.cache.store.has(PANEL_LINK_CHECK_KEYS.lock), false);
  });

  it('gives the lock back when the pass throws', async () => {
    const test = rig();
    test.cache.failWrites = true;

    await assert.rejects(() => test.service.run('daily'), /Redis write failed/);
    assert.equal(test.cache.store.has(PANEL_LINK_CHECK_KEYS.lock), false);
  });

  it('answers a tick whose pass threw with failed, instead of an unhandled rejection', async () => {
    const test = rig();
    test.cache.failWrites = true;

    assert.equal(await test.service.tick(), 'failed');
    assert.equal(test.cache.store.has(PANEL_LINK_CHECK_KEYS.lock), false);
  });

  it('refuses a second pass in the same process while one runs', async () => {
    const test = rig();
    let release!: () => void;
    test.walk = () =>
      new Promise((resolve) => {
        release = () => resolve(report());
      });

    const first = test.service.run('daily');
    await settle();
    assert.equal(await test.service.run('daily'), 'busy');
    assert.equal(await test.service.tick(), 'busy');
    assert.equal(lockClaims(test.cache).length, 1, 'the second call does not even reach for the lock');
    release();
    assert.equal(await first, 'ran');
    assert.equal(test.walks.length, 1);
  });

  it('does not run without Redis: no lock can be taken', async () => {
    const test = rig();
    test.cache.ready = false;

    assert.equal(await test.service.run('daily'), 'busy');
    assert.deepEqual(test.walks, []);
  });
});

describe('PanelLinkCheckService — one pass', () => {
  it('walks for real, bounded, from where the last pass stopped, then compares', async () => {
    const test = rig();
    test.cache.store.set(PANEL_LINK_CHECK_KEYS.state, { walkCursor: 'sub-c', lastRunAt: null });

    await test.service.run('retry');

    assert.deepEqual(test.walks, [
      {
        dryRun: false,
        limit: PANEL_LINK_CHECK_WALK_LIMIT,
        budgetMs: PANEL_LINK_CHECK_WALK_BUDGET_MS,
        startAfterId: 'sub-c',
      },
    ]);
    assert.equal(test.compares, 1);
  });

  it('records a complete pass with no retry and the walk starting over next time', async () => {
    const test = rig();

    await test.service.run('daily');

    const saved = state(test.cache);
    assert.equal(saved['lastRunOutcome'], 'complete');
    assert.equal(saved['nextRetryAt'], null);
    assert.equal(saved['walkCursor'], null);
    assert.equal(typeof saved['lastRunAt'], 'string');
  });

  it('schedules the retry an hour later when Remnawave stopped answering, continuing from the walk\'s cursor', async () => {
    const test = rig();
    test.walk = async () => report({ panelUnavailable: true, hasMore: true, walkComplete: false, nextCursor: 'sub-b' });

    const before = Date.now();
    await test.service.run('daily');

    const saved = state(test.cache);
    assert.equal(saved['lastRunOutcome'], 'incomplete');
    assert.equal(saved['walkCursor'], 'sub-b');
    const retryAt = Date.parse(String(saved['nextRetryAt']));
    // "An hour later" is the owner's word, so the hour is written out here
    // rather than read back from the constant under test.
    assert.equal(PANEL_LINK_CHECK_RETRY_MS, 3_600_000);
    assert.ok(retryAt >= before + 3_600_000 && retryAt <= Date.now() + 3_600_000);
  });

  it('schedules the retry when the walk hit its cap', async () => {
    const test = rig();
    test.walk = async () => report({ hasMore: true, walkComplete: false, nextCursor: 'sub-z' });

    await test.service.run('daily');

    assert.equal(state(test.cache)['lastRunOutcome'], 'incomplete');
    assert.equal(state(test.cache)['walkCursor'], 'sub-z');
  });

  it('does not retry for the merge backlog alone: a walk that finished is complete', async () => {
    const test = rig();
    test.walk = async () => report({ hasMore: true, walkComplete: true, nextCursor: 'sub-z' });

    await test.service.run('daily');

    assert.equal(state(test.cache)['lastRunOutcome'], 'complete');
    assert.equal(state(test.cache)['walkCursor'], null);
  });

  it('schedules the retry when Remnawave\'s list could not be read, and keeps the last comparison', async () => {
    const test = rig();
    test.cache.store.set(PANEL_LINK_CHECK_KEYS.comparison, { comparedAt: 'earlier', customers: [] });
    test.compare = async () => ({ kind: 'unavailable', detail: 'unavailable' });

    await test.service.run('daily');

    assert.equal(state(test.cache)['lastRunOutcome'], 'incomplete');
    assert.equal((test.cache.store.get(PANEL_LINK_CHECK_KEYS.comparison) as { comparedAt: string }).comparedAt, 'earlier');
  });

  it('does not retry a list Remnawave serves only in part: that is its size, not an outage', async () => {
    const test = rig();
    test.compare = async () => comparisonOk({ readOutcome: 'partial' });

    await test.service.run('daily');

    assert.equal(state(test.cache)['lastRunOutcome'], 'complete');
  });

  it('still compares and records when the walk throws', async () => {
    const test = rig();
    test.walk = async () => {
      throw new Error('database gone');
    };

    await test.service.run('daily');

    assert.equal(test.compares, 1);
    assert.equal(state(test.cache)['lastRunOutcome'], 'incomplete');
  });

  it('keeps the comparison without the audit-only links', async () => {
    const test = rig();
    test.compare = async () =>
      comparisonOk({
        autoLinked: 1,
        customers: [{ userId: 'user-1', profiles: [] }],
        links: [
          {
            subscriptionId: 'sub-a',
            userId: 'user-1',
            previousRemnawaveId: null,
            previousPanelId: null,
            remnawaveId: '4711',
            panelId: 4711,
            panelUsername: 'rz_a',
            proof: 'reiwa_id',
          },
        ],
      });

    await test.service.run('daily');

    const kept = test.cache.store.get(PANEL_LINK_CHECK_KEYS.comparison) as Record<string, unknown>;
    assert.equal('links' in kept, false);
    assert.equal(kept['autoLinked'], 1);
  });
});

describe('PanelLinkCheckService — why each row was not proven', () => {
  it('keeps the verdict of every row the walk asked about, in the codes the list speaks', async () => {
    const test = rig();
    test.walk = async () =>
      report({
        scanned: 4,
        unrepaired: [
          row({ subscriptionId: 'sub-a', reasonCode: 'profileGone', remnawaveId: '4711' }),
          row({ subscriptionId: 'sub-b', reasonCode: 'raceLost' }),
          row({ subscriptionId: 'sub-c', reasonCode: 'ownedByOther', otherUserId: 'user-9', remnawaveId: '12' }),
          row({ subscriptionId: 'sub-d', reasonCode: 'noRoute', resolvedBy: 'username' }),
          // The live half a pair drags in: not scanned, not this list's row.
          row({ subscriptionId: 'sub-partner', reasonCode: 'duplicatePair', scanned: false }),
        ],
      });

    await test.service.run('daily');

    const verdicts = test.cache.store.get(PANEL_LINK_CHECK_KEYS.verdicts) as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(verdicts).sort(), ['sub-a', 'sub-b', 'sub-c', 'sub-d']);
    assert.equal(verdicts['sub-a']['reason'], 'profileUnreadable');
    assert.equal(verdicts['sub-a']['profileId'], '4711');
    assert.equal(verdicts['sub-a']['lookedUpBy'], 'shortUuid');
    assert.equal(verdicts['sub-b']['reason'], 'changedDuringCheck');
    assert.equal(verdicts['sub-c']['reason'], 'ownedByOther');
    assert.equal(verdicts['sub-c']['otherUserId'], 'user-9');
    assert.equal(verdicts['sub-d']['reason'], 'noRoute');
    assert.equal(verdicts['sub-d']['lookedUpBy'], null, 'nothing was looked up for a row with no route');
  });

  it('drops the verdict of a row that is linked now', async () => {
    const test = rig();
    test.cache.store.set(PANEL_LINK_CHECK_KEYS.verdicts, {
      'sub-a': { reason: 'notFound', checkedAt: '2026-09-23T00:00:00.000Z' },
      'sub-b': { reason: 'notFound', checkedAt: '2026-09-23T00:00:00.000Z' },
      'sub-keep': { reason: 'notFound', checkedAt: '2026-09-23T00:00:00.000Z' },
    });
    test.walk = async () => report({ linked: 1, repaired: [row({ subscriptionId: 'sub-a', outcome: 'linked', reasonCode: null })] });
    test.compare = async () =>
      comparisonOk({
        autoLinked: 1,
        links: [
          {
            subscriptionId: 'sub-b',
            userId: 'user-1',
            previousRemnawaveId: null,
            previousPanelId: null,
            remnawaveId: '4711',
            panelId: 4711,
            panelUsername: 'rz_b',
            proof: 'reiwa_id',
          },
        ],
      });

    await test.service.run('daily');

    const verdicts = test.cache.store.get(PANEL_LINK_CHECK_KEYS.verdicts) as Record<string, unknown>;
    assert.deepEqual(Object.keys(verdicts), ['sub-keep']);
  });
});

describe('PanelLinkCheckService — after a backup import', () => {
  it('records a request only for the importers that write links', async () => {
    const test = rig();

    for (const source of IMPORT_SOURCES_THAT_LINK) {
      assert.equal(await test.service.requestAfterImport({ importRecordId: `imp-${source}`, sourceType: source }), true);
    }
    assert.equal(await test.service.requestAfterImport({ importRecordId: 'imp-3xui', sourceType: '3xui' }), false);

    const pending = test.cache.store.get(PANEL_LINK_CHECK_KEYS.requests) as Array<{ sourceType: string }>;
    assert.deepEqual(
      pending.map((request) => request.sourceType).sort(),
      ['altshop', 'bedolaga', 'remnashop', 'remnawave', 'stealthnet'],
    );
  });

  it('never throws into the import when the request cannot be recorded', async () => {
    const test = rig();
    test.cache.failWrites = true;

    assert.equal(await test.service.requestAfterImport({ importRecordId: 'imp-1', sourceType: 'remnashop' }), false);
  });

  it('sends ONE card with what is left and where the list is', async () => {
    const test = rig();
    test.db.population = [
      { id: 'sub-a', userId: 'user-1', remnawaveId: null },
      { id: 'sub-b', userId: 'user-2', remnawaveId: '330f2b38-1f1e-4f6a-9f2b-0a1b2c3d4e5f' },
      { id: 'sub-c', userId: 'user-3', remnawaveId: '' },
    ];
    test.walk = async () => report({ linked: 2, repaired: [row({ subscriptionId: 'sub-x', outcome: 'linked', reasonCode: null })] });
    await test.service.requestAfterImport({ importRecordId: 'imp-1', sourceType: 'remnashop' });
    await test.service.requestAfterImport({ importRecordId: 'imp-2', sourceType: 'bedolaga' });

    await test.service.tick();

    assert.equal(test.events.length, 1, 'one card, not one per import nor one per row');
    const [card] = test.events;
    assert.equal(card.severity, 'WARNING');
    assert.equal(card.metadata['reason'], 'links_unproven_after_import');
    assert.equal(card.metadata['unprovenLinks'], 3);
    assert.equal(card.metadata['nonNumericLinks'], 2);
    assert.equal(card.metadata['linked'], 2);
    assert.deepEqual(card.metadata['importRecordIds'], ['imp-1', 'imp-2']);
    const note = String(card.metadata['note']);
    assert.match(note, /«Подписки» → «Инструменты» → «Подписки без привязки к Remnawave»/);
    assert.match(note, /Remnashop, Bedolaga/);
    assert.match(note, /: 3/);
    assert.match(note, /: 2\./);
    assert.doesNotMatch(note, /повторится через час/, 'the pass was complete');
  });

  it('says the check will come back when Remnawave did not answer everything', async () => {
    const test = rig();
    test.db.population = [{ id: 'sub-a', userId: 'user-1', remnawaveId: null }];
    test.walk = async () => report({ panelUnavailable: true, hasMore: true, walkComplete: false });
    await test.service.requestAfterImport({ importRecordId: 'imp-1', sourceType: 'altshop' });

    await test.service.tick();

    assert.match(String(test.events[0]?.metadata['note']), /повторится через час/);
  });

  it('sends no import card when nothing is left without a proven link', async () => {
    const test = rig();
    await test.service.requestAfterImport({ importRecordId: 'imp-1', sourceType: 'stealthnet' });

    await test.service.tick();

    assert.deepEqual(test.events, []);
  });

  it('sends no import card for a pass no import asked for', async () => {
    const test = rig();
    test.db.population = [{ id: 'sub-a', userId: 'user-1', remnawaveId: null }];

    await test.service.run('daily');

    assert.deepEqual(test.events, []);
  });
});

/**
 * THE REQUESTS AND THE LOCK ARE SHARED BY PROCESSES (review R2b-06). An import
 * records its request from whichever process ran it while the worker's pass
 * takes them, and a pass that outlives its lock's TTL finishes after the next
 * holder has taken it. A read-then-write of the request list lost one of two
 * requests, or put an answered one back; a plain `del` deleted the next
 * holder's lock.
 */
describe('PanelLinkCheckService — the requests and the lock under concurrency', () => {
  // Bounded: a lease that is never given back must fail these cases, not hang them.
  const bounded = { timeout: 10_000 };

  it('R2b-06: two imports finishing together — neither request is lost, the card names both', bounded, async () => {
    const test = rig();
    test.db.population = [{ id: 'sub-a', userId: 'user-1', remnawaveId: null }];

    const recorded = await Promise.all([
      test.service.requestAfterImport({ importRecordId: 'imp-1', sourceType: 'remnashop' }),
      test.service.requestAfterImport({ importRecordId: 'imp-2', sourceType: 'bedolaga' }),
    ]);
    await test.service.tick();

    assert.deepEqual(recorded, [true, true]);
    assert.deepEqual(namedImports(test), [['imp-1', 'imp-2']]);
  });

  it('R2b-06: a request taken while another import was recording its own is not answered twice', bounded, async () => {
    const test = rig();
    test.db.population = [{ id: 'sub-a', userId: 'user-1', remnawaveId: null }];
    await test.service.requestAfterImport({ importRecordId: 'imp-1', sourceType: 'remnashop' });

    // The second import has READ the list ([imp-1]) and stalls before writing it back.
    const stalled = test.cache.pauseNextGet(PANEL_LINK_CHECK_KEYS.requests);
    const second = test.service.requestAfterImport({ importRecordId: 'imp-2', sourceType: 'altshop' });
    await stalled.reached;
    // Meanwhile the worker's pass runs and takes whatever it may.
    const pass = test.service.run('daily');
    await settle();
    await settle();
    stalled.release();
    assert.equal(await second, true);
    await pass;
    // And the next pass answers whatever is left.
    await test.service.run('daily');

    const named = namedImports(test).flat().sort();
    assert.deepEqual(named, ['imp-1', 'imp-2'], 'each import is named on exactly one card');
    assert.equal(test.cache.store.has(PANEL_LINK_CHECK_KEYS.requests), false, 'nothing is left to answer again');
  });

  it('R2b-06: a pass that outlived its lock does not delete the next holder\'s', bounded, async (context) => {
    const test = rig();
    let clock = 5_000_000;
    context.mock.method(performance, 'now', () => clock);
    test.walk = async () => {
      // The pass runs past its lock's time-to-live: the key expires, and the
      // next worker's pass takes the lock.
      clock += (PANEL_LINK_CHECK_LOCK_TTL_SECONDS + 60) * 1000;
      test.cache.store.delete(PANEL_LINK_CHECK_KEYS.lock);
      assert.equal(await test.cache.claimOnce(PANEL_LINK_CHECK_KEYS.lock, PANEL_LINK_CHECK_LOCK_TTL_SECONDS), true);
      return report();
    };

    assert.equal(await test.service.run('daily'), 'ran');

    assert.equal(test.cache.store.has(PANEL_LINK_CHECK_KEYS.lock), true, "the next holder's lock stands");
  });

  it('R2b-06 control: a pass that finished inside its lock gives it back', bounded, async (context) => {
    const test = rig();
    let clock = 5_000_000;
    context.mock.method(performance, 'now', () => clock);
    test.walk = async () => {
      clock += (PANEL_LINK_CHECK_LOCK_TTL_SECONDS - 600) * 1000;
      return report();
    };

    await test.service.run('daily');

    assert.equal(test.cache.store.has(PANEL_LINK_CHECK_KEYS.lock), false);
  });
});

describe('PanelLinkCheckService — what it wrote is on record', () => {
  it('writes one audit row with every link, from the walk and from the comparison', async () => {
    const test = rig();
    test.walk = async () =>
      report({
        scanned: 3,
        linked: 1,
        repaired: [
          row({
            subscriptionId: 'sub-a',
            outcome: 'linked',
            reasonCode: null,
            remnawaveId: '5150',
            storedRemnawaveId: '330f2b38-1f1e-4f6a-9f2b-0a1b2c3d4e5f',
            panelId: 5150,
          }),
        ],
      });
    test.compare = async () =>
      comparisonOk({
        autoLinked: 1,
        links: [
          {
            subscriptionId: 'sub-b',
            userId: 'user-2',
            previousRemnawaveId: null,
            previousPanelId: null,
            remnawaveId: '4711',
            panelId: 4711,
            panelUsername: 'rz_b',
            proof: 'reiwa_id+subscription_id',
          },
        ],
      });

    await test.service.run('boot');

    assert.equal(test.db.audits.length, 1);
    const audit = test.db.audits[0] as { data: { action: string; metadata: Record<string, unknown> } };
    assert.equal(audit.data.action, 'subscriptions.panel_link_reconciled');
    assert.equal(audit.data.metadata['automatic'], true);
    assert.equal(audit.data.metadata['trigger'], 'boot');
    const links = audit.data.metadata['links'] as Array<Record<string, unknown>>;
    assert.deepEqual(
      links.map((link) => [link['subscriptionId'], link['remnawaveId'], link['storedRemnawaveId'], link['resolvedBy']]),
      [
        ['sub-a', '5150', '330f2b38-1f1e-4f6a-9f2b-0a1b2c3d4e5f', 'shortUuid'],
        ['sub-b', '4711', null, 'ownerMarker'],
      ],
    );
    assert.equal(test.events.length, 1);
    assert.equal(test.events[0].severity, 'INFO');
    assert.equal(test.events[0].metadata['linked'], 2);
  });

  it('writes no audit row and sends no card when nothing was linked', async () => {
    const test = rig();

    await test.service.run('daily');

    assert.deepEqual(test.db.audits, []);
    assert.deepEqual(test.events, []);
  });

  it('keeps the pass going when the audit row cannot be written', async () => {
    const test = rig();
    test.db.failAudit = true;
    test.walk = async () => report({ linked: 1, repaired: [row({ subscriptionId: 'sub-a', outcome: 'linked', reasonCode: null })] });

    assert.equal(await test.service.run('daily'), 'ran');
    assert.equal(state(test.cache)['lastRunOutcome'], 'complete');
  });
});

describe('PanelLinkCheckService — the lists', () => {
  it('lists every row without a proven link now, with the reason the last pass found', async () => {
    const test = rig();
    test.db.population = [
      { id: 'sub-a', userId: 'user-1', status: 'ACTIVE', createdAt: new Date('2026-01-01T00:00:00Z'), remnawaveId: null, planName: 'Год' },
      { id: 'sub-b', userId: 'user-2', status: 'EXPIRED', createdAt: new Date('2026-02-01T00:00:00Z'), remnawaveId: 'abc', planName: null },
    ];
    test.db.users = [{ id: 'user-1', name: 'Анна', telegramId: 555000111n }];
    test.cache.store.set(PANEL_LINK_CHECK_KEYS.verdicts, {
      'sub-a': {
        reason: 'duplicatePair',
        profileId: '5150',
        otherSubscriptionId: 'sub-z',
        otherUserId: null,
        lookedUpBy: 'shortUuid',
        checkedAt: '2026-09-24T10:00:00.000Z',
      },
      'sub-linked-since': { reason: 'notFound', checkedAt: '2026-09-24T10:00:00.000Z' },
    });

    const list = await test.service.listUnlinked();

    assert.equal(list.total, 2);
    assert.equal(list.truncated, false);
    assert.deepEqual(list.rows[0], {
      subscriptionId: 'sub-a',
      userId: 'user-1',
      userName: 'Анна',
      userTelegramId: '555000111',
      status: 'ACTIVE',
      planName: 'Год',
      createdAt: '2026-01-01T00:00:00.000Z',
      storedRemnawaveId: null,
      linkKind: 'empty',
      reason: 'duplicatePair',
      profileId: '5150',
      otherSubscriptionId: 'sub-z',
      otherUserId: null,
      lookedUpBy: 'shortUuid',
      checkedAt: '2026-09-24T10:00:00.000Z',
    });
    assert.equal(list.rows[1]?.reason, 'notCheckedYet');
    assert.equal(list.rows[1]?.linkKind, 'nonNumeric');
    assert.equal(list.rows[1]?.userName, null);
    assert.deepEqual(
      list.rows.map((entry) => entry.subscriptionId),
      ['sub-a', 'sub-b'],
      'a row linked since is not listed: the rows come from the database',
    );
  });

  it('shows the last comparison, re-checked against the database', async () => {
    const test = rig();
    test.cache.store.set(PANEL_LINK_CHECK_KEYS.comparison, {
      comparedAt: '2026-09-24T09:00:00.000Z',
      readOutcome: 'complete',
      profilesRead: 40,
      profilesWithoutOwner: 2,
      autoLinked: 0,
      truncated: false,
      customers: [
        {
          userId: 'user-1',
          profiles: [
            {
              profileId: '4711',
              username: 'rz_a',
              status: 'ACTIVE',
              createdAt: null,
              usedTrafficBytes: 5,
              subscriptionMarker: null,
              linkedBySubscriptionId: null,
              autoLink: 'severalSubscriptions',
              autoLinkedSubscriptionId: null,
              autoLinkedAt: null,
            },
          ],
        },
        { userId: 'user-gone', profiles: [] },
      ],
    });
    test.db.users = [{ id: 'user-1', name: 'Анна', telegramId: null }];
    test.db.subscriptions = [
      { id: 'sub-a', userId: 'user-1', status: 'ACTIVE', createdAt: new Date('2026-01-01T00:00:00Z'), remnawaveId: null, planSnapshot: { name: 'Год' } },
      { id: 'sub-b', userId: 'user-1', status: 'ACTIVE', createdAt: new Date('2026-02-01T00:00:00Z'), remnawaveId: '4711', planSnapshot: {} },
      { id: 'sub-c', userId: 'user-1', status: SubscriptionStatus.DELETED, createdAt: new Date('2026-03-01T00:00:00Z'), remnawaveId: null, planSnapshot: {} },
    ];

    const list = await test.service.listExtraProfiles();

    assert.equal(list.comparedAt, '2026-09-24T09:00:00.000Z');
    assert.equal(list.profilesWithoutOwner, 2);
    const [anna, gone] = list.customers;
    assert.equal(anna?.userExists, true);
    assert.equal(anna?.userName, 'Анна');
    assert.deepEqual(anna?.subscriptionsWithoutLink.map((entry) => entry.subscriptionId), ['sub-a']);
    assert.equal(anna?.subscriptionsWithoutLink[0]?.planName, 'Год');
    assert.equal(anna?.profiles[0]?.linkedNow, true, 'sub-b links it now');
    assert.equal(gone?.userExists, false);
  });

  it('answers with an empty comparison before the first one ran', async () => {
    const test = rig();

    const list = await test.service.listExtraProfiles();

    assert.equal(list.comparedAt, null);
    assert.deepEqual(list.customers, []);
  });

  it('says when the check last ran, whether it runs now, and when it runs next', async () => {
    const test = rig();
    test.cache.store.set(PANEL_LINK_CHECK_KEYS.state, {
      lastRunAt: '2026-09-24T10:00:00.000Z',
      lastRunTrigger: 'import',
      lastRunOutcome: 'complete',
      nextRetryAt: null,
      walkCursor: null,
    });

    const daily = await test.service.status();
    assert.deepEqual(daily, {
      lastRunAt: '2026-09-24T10:00:00.000Z',
      lastRunTrigger: 'import',
      lastRunOutcome: 'complete',
      nextRunAt: '2026-09-25T10:00:00.000Z',
      running: false,
    });

    test.cache.store.set(PANEL_LINK_CHECK_KEYS.lock, '1');
    test.cache.store.set(PANEL_LINK_CHECK_KEYS.state, {
      lastRunAt: '2026-09-24T10:00:00.000Z',
      lastRunTrigger: 'daily',
      lastRunOutcome: 'incomplete',
      nextRetryAt: '2026-09-24T11:00:00.000Z',
      walkCursor: 'sub-q',
    });
    const retry = await test.service.status();
    assert.equal(retry.nextRunAt, '2026-09-24T11:00:00.000Z');
    assert.equal(retry.running, true);
  });
});
