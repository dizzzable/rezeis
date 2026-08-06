import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { of, throwError } from 'rxjs';

import { SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';

import { _resetProcessRoleCacheForTests } from '../src/common/runtime/process-role.util';
import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { ExpiredProfileCleanupService } from '../src/modules/profile-sync/expired-profile-cleanup.service';
import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';

/** Settings mock factory — defaults to deletion ON with a 3-day grace. */
function settingsMock(policy: { deleteEnabled?: boolean; graceDays?: number } = {}) {
  return {
    getRemnawaveCleanupSettings: async () => ({
      deleteEnabled: policy.deleteEnabled ?? true,
      graceDays: policy.graceDays ?? 3,
    }),
  } as never;
}

/** SystemEventsService mock — records `info` calls. */
function eventsMock(sink: Array<readonly unknown[]> = []) {
  return { info: (...args: unknown[]) => { sink.push(args); } } as never;
}

/**
 * Remnawave API mock, speaking the STRICT outcome union the sweep now reads.
 *
 * It deliberately does NOT stub `getPanelUser`: that method swallows every
 * failure into `null`, so a stub that throws could exercise a branch the real
 * adapter cannot reach. The sweep must consume outcome KINDS, and only a
 * `notFound` may be read as "the profile is gone".
 *
 * A number is an `ok` whose `expireAt` is that many ms from now (negative =
 * past). Otherwise pass the outcome kind to simulate.
 */
function remnawaveMock(behaviour: number | 'notFound' | 'unavailable' | 'invalidContract') {
  return {
    strictGetPanelUserExpiry: async () => {
      if (behaviour === 'notFound') return { kind: 'notFound' as const };
      if (behaviour === 'unavailable') {
        return { kind: 'unavailable' as const, retryAfterMs: null };
      }
      if (behaviour === 'invalidContract') {
        return { kind: 'invalidContract' as const, details: 'user missing expireAt' };
      }
      return {
        kind: 'ok' as const,
        value: {
          expireAtMs: Date.now() + behaviour,
          subscriptionUrl: 'https://panel.example/sub/xyz',
        },
        detectedVersion: null,
      };
    },
  } as never;
}

type DeletionInput = {
  readonly subscriptionId: string;
  readonly expectedExpiresAt: Date;
  readonly expectedRemnawaveId: string | null;
  readonly cutoff: Date;
};

/**
 * SubscriptionDeletionService mock. The cleanup sweep now routes every
 * deletion (profile-bearing and already-detached) through
 * `deleteExpiredIfUnchanged`, which owns DELETE-job creation + enqueue.
 * `decide` maps a candidate id → whether it was deleted.
 */
function deletionMock(
  calls: DeletionInput[],
  decide: (input: DeletionInput) => boolean = () => true,
) {
  return {
    deleteExpiredIfUnchanged: async (input: DeletionInput) => {
      calls.push(input);
      const deleted = decide(input);
      return { deleted, syncJobId: deleted ? `job-${input.subscriptionId}` : null };
    },
  } as never;
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe('ExpiredProfileCleanupService', () => {
  const originalRole = process.env['RUID_PROCESS_ROLE'];

  afterEach(() => {
    if (originalRole === undefined) {
      delete process.env['RUID_PROCESS_ROLE'];
    } else {
      process.env['RUID_PROCESS_ROLE'] = originalRole;
    }
    _resetProcessRoleCacheForTests();
  });

  it('selects profile-bearing subs expired past the grace cutoff with no in-flight DELETE job and deletes a bounded batch (panel confirms expired)', async () => {
    const findManyCalls: Array<{ readonly where: Record<string, unknown>; readonly take?: number }> = [];
    const deletions: DeletionInput[] = [];
    const events: Array<readonly unknown[]> = [];

    const expiresAt1 = new Date(Date.now() - 30 * DAY_MS);
    const expiresAt2 = new Date(Date.now() - 40 * DAY_MS);
    const before = Date.now() - 3 * DAY_MS;
    const service = new ExpiredProfileCleanupService(
      {
        subscription: {
          findMany: async (input: { where: Record<string, unknown>; take?: number }) => {
            findManyCalls.push(input);
            // Profile-bearing selection (`remnawaveId: { not: null }`); the
            // detached selection (`remnawaveId: null`) returns nothing here.
            if (input.where['remnawaveId'] === null) return [];
            return [
              { id: 'sub-1', userId: 'user-1', isTrial: false, remnawaveId: 'rw-1', expiresAt: expiresAt1 },
              { id: 'sub-2', userId: 'user-2', isTrial: true, remnawaveId: 'rw-2', expiresAt: expiresAt2 },
            ];
          },
        },
      } as never,
      eventsMock(events),
      settingsMock({ deleteEnabled: true, graceDays: 3 }),
      remnawaveMock(-30 * DAY_MS),
      deletionMock(deletions),
    );
    const count = await service.runSweep();
    const after = Date.now() - 3 * DAY_MS;

    assert.equal(count, 2);
    // Selection guard: profile present, expired before the grace cutoff, no
    // live DELETE job, bounded.
    const where = findManyCalls[0] as { readonly where: Record<string, unknown>; readonly take?: number };
    assert.deepStrictEqual(where.where['remnawaveId'], { not: null });
    const expiresClause = where.where['expiresAt'] as { not: null; lt: Date };
    assert.equal(expiresClause.not, null);
    assert.ok(expiresClause.lt instanceof Date);
    // Cutoff ≈ now - graceDays; allow for the few ms elapsed during the call.
    assert.ok(expiresClause.lt.getTime() >= before && expiresClause.lt.getTime() <= after);
    assert.deepStrictEqual(where.where['syncJobs'], {
      none: {
        action: SyncAction.DELETE,
        status: { in: [SyncJobStatus.PENDING, SyncJobStatus.RUNNING] },
      },
    });
    assert.equal(where.take, 100);
    // Every candidate is retired through the single lifecycle-closing path,
    // pinned to its own panel profile + guarded by its expected expiry.
    assert.equal(deletions.length, 2);
    assert.deepStrictEqual(
      deletions.map((d) => ({ subscriptionId: d.subscriptionId, expectedRemnawaveId: d.expectedRemnawaveId })),
      [
        { subscriptionId: 'sub-1', expectedRemnawaveId: 'rw-1' },
        { subscriptionId: 'sub-2', expectedRemnawaveId: 'rw-2' },
      ],
    );
    assert.equal(deletions[0]?.expectedExpiresAt.getTime(), expiresAt1.getTime());
    assert.equal(deletions[1]?.expectedExpiresAt.getTime(), expiresAt2.getTime());
    assert.ok(deletions[0]?.cutoff instanceof Date);
    // The deletion service owns subscription.deleted publication after its
    // transaction commits; the cleanup coordinator must not emit a duplicate.
    assert.equal(events.length, 0);
  });

  it('SELF-HEALS a stale local expiry instead of deleting when the panel says the subscription is still valid', async () => {
    const deletions: DeletionInput[] = [];
    const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
    const events: Array<readonly unknown[]> = [];

    const service = new ExpiredProfileCleanupService(
      {
        subscription: {
          findMany: async (input: { where: Record<string, unknown> }) => {
            if (input.where['remnawaveId'] === null) return [];
            return [
              {
                id: 'sub-live',
                userId: 'user-1',
                isTrial: false,
                remnawaveId: 'rw-live',
                expiresAt: new Date(Date.now() - 30 * DAY_MS),
              },
            ];
          },
          update: async (input: { where: unknown; data: Record<string, unknown> }) => {
            updates.push(input);
            return {};
          },
        },
      } as never,
      eventsMock(events),
      settingsMock({ deleteEnabled: true, graceDays: 3 }),
      // Panel says the profile is valid for another 20 days → must NOT delete.
      remnawaveMock(20 * DAY_MS),
      deletionMock(deletions),
    );

    const count = await service.runSweep();

    // No deletion routed through the lifecycle service.
    assert.equal(count, 0);
    assert.equal(deletions.length, 0);
    // Local expiry self-healed from the panel + status revived to ACTIVE.
    assert.equal(updates.length, 1);
    assert.deepStrictEqual(updates[0]?.where, { id: 'sub-live' });
    assert.ok(updates[0]?.data['expiresAt'] instanceof Date);
    assert.ok((updates[0]?.data['expiresAt'] as Date).getTime() > Date.now());
    assert.equal(updates[0]?.data['status'], SubscriptionStatus.ACTIVE);
    assert.equal(updates[0]?.data['configUrl'], 'https://panel.example/sub/xyz');
    // A SUBSCRIPTION_SYNCED self-heal event is emitted.
    assert.equal(events.length, 1);
    assert.equal(events[0]?.[0], EVENT_TYPES.SUBSCRIPTION_SYNCED);
  });

  it('DEFERS deletion (no delete, no self-heal) when the panel is unreachable', async () => {
    const deletions: DeletionInput[] = [];
    const updates: unknown[] = [];

    const service = new ExpiredProfileCleanupService(
      {
        subscription: {
          findMany: async (input: { where: Record<string, unknown> }) => {
            if (input.where['remnawaveId'] === null) return [];
            return [
              {
                id: 'sub-x',
                userId: 'user-1',
                isTrial: false,
                remnawaveId: 'rw-x',
                expiresAt: new Date(Date.now() - 30 * DAY_MS),
              },
            ];
          },
          update: async (input: unknown) => { updates.push(input); return {}; },
        },
      } as never,
      eventsMock(),
      settingsMock({ deleteEnabled: true, graceDays: 3 }),
      remnawaveMock('unavailable'),
      deletionMock(deletions),
    );

    const count = await service.runSweep();

    assert.equal(count, 0);
    assert.equal(deletions.length, 0);
    assert.equal(updates.length, 0);
  });

  it('defers instead of deleting when the panel answers 2xx with an unreadable expiry', async () => {
    // `invalidContract` is the outcome for a 2xx whose `expireAt` is missing or
    // unparseable, and for a terminal 400/401/403 — e.g. addressing a 3.x panel
    // with a 2.x uuid. None of those prove the profile is gone, so none may
    // delete. Distinct from `unavailable`: this one never retries itself.
    const deletions: DeletionInput[] = [];
    const updates: unknown[] = [];

    const service = new ExpiredProfileCleanupService(
      {
        subscription: {
          findMany: async (input: { where: Record<string, unknown> }) => {
            if (input.where['remnawaveId'] === null) return [];
            return [
              {
                id: 'sub-garbled',
                userId: 'user-1',
                isTrial: false,
                remnawaveId: 'rw-garbled',
                expiresAt: new Date(Date.now() - 30 * DAY_MS),
              },
            ];
          },
          update: async (input: unknown) => { updates.push(input); return {}; },
        },
      } as never,
      eventsMock(),
      settingsMock({ deleteEnabled: true, graceDays: 3 }),
      remnawaveMock('invalidContract'),
      deletionMock(deletions),
    );

    const count = await service.runSweep();

    assert.equal(count, 0);
    assert.equal(deletions.length, 0);
    assert.equal(updates.length, 0);
  });

  it('deletes only when the panel confirms the profile is gone (notFound)', async () => {
    const deletions: DeletionInput[] = [];

    const service = new ExpiredProfileCleanupService(
      {
        subscription: {
          findMany: async (input: { where: Record<string, unknown> }) => {
            if (input.where['remnawaveId'] === null) return [];
            return [
              {
                id: 'sub-gone',
                userId: 'user-1',
                isTrial: false,
                remnawaveId: 'rw-gone',
                expiresAt: new Date(Date.now() - 30 * DAY_MS),
              },
            ];
          },
          update: async () => ({}),
        },
      } as never,
      eventsMock(),
      settingsMock({ deleteEnabled: true, graceDays: 3 }),
      remnawaveMock('notFound'),
      deletionMock(deletions),
    );

    const count = await service.runSweep();

    assert.equal(count, 1);
    assert.equal(deletions.length, 1);
    assert.equal(deletions[0]?.subscriptionId, 'sub-gone');
    assert.equal(deletions[0]?.expectedRemnawaveId, 'rw-gone');
  });

  it('soft-deletes already-detached expired rows (remnawaveId null, not DELETED) via the lifecycle service', async () => {
    const deletions: DeletionInput[] = [];
    const detachedFindWhere: Array<Record<string, unknown>> = [];
    const before = Date.now() - 3 * DAY_MS;
    const expiresAt = new Date(Date.now() - 10 * DAY_MS);

    const service = new ExpiredProfileCleanupService(
      {
        subscription: {
          findMany: async (input: { where: Record<string, unknown> }) => {
            if (input.where['remnawaveId'] === null) {
              detachedFindWhere.push(input.where);
              return [
                { id: 'detached-1', expiresAt },
                { id: 'detached-2', expiresAt },
              ];
            }
            return [];
          },
          update: async () => ({}),
        },
      } as never,
      eventsMock(),
      settingsMock({ deleteEnabled: true, graceDays: 3 }),
      remnawaveMock(-30 * DAY_MS),
      deletionMock(deletions),
    );

    const count = await service.runSweep();
    const after = Date.now() - 3 * DAY_MS;

    assert.equal(count, 2);
    assert.equal(deletions.length, 2);
    assert.deepStrictEqual(
      deletions.map((d) => ({ subscriptionId: d.subscriptionId, expectedRemnawaveId: d.expectedRemnawaveId })),
      [
        { subscriptionId: 'detached-1', expectedRemnawaveId: null },
        { subscriptionId: 'detached-2', expectedRemnawaveId: null },
      ],
    );
    // Detached selection guard.
    const where = detachedFindWhere[0] as Record<string, unknown>;
    assert.equal(where['remnawaveId'], null);
    assert.deepStrictEqual(where['status'], { not: SubscriptionStatus.DELETED });
    const expiresClause = where['expiresAt'] as { not: null; lt: Date };
    assert.equal(expiresClause.not, null);
    assert.ok(expiresClause.lt.getTime() >= before && expiresClause.lt.getTime() <= after);
  });

  it('honours a wider grace window in the cutoff (graceDays=7)', async () => {
    const findManyCalls: Array<{ readonly where: Record<string, unknown> }> = [];
    const service = new ExpiredProfileCleanupService(
      {
        subscription: {
          findMany: async (input: { where: Record<string, unknown> }) => {
            findManyCalls.push(input);
            return [];
          },
          update: async () => ({}),
        },
      } as never,
      eventsMock(),
      settingsMock({ deleteEnabled: true, graceDays: 7 }),
      remnawaveMock(-30 * DAY_MS),
      deletionMock([]),
    );

    const lowerBound = Date.now() - 7 * DAY_MS;
    await service.runSweep();
    const upperBound = Date.now() - 7 * DAY_MS;

    const where = findManyCalls[0] as { readonly where: Record<string, unknown> };
    const expiresClause = where.where['expiresAt'] as { not: null; lt: Date };
    assert.ok(expiresClause.lt.getTime() >= lowerBound && expiresClause.lt.getTime() <= upperBound);
  });

  it('is a no-op (no panel/db call) when deletion is disabled in settings', async () => {
    let findManyCalled = false;
    const deletions: DeletionInput[] = [];
    const service = new ExpiredProfileCleanupService(
      { subscription: { findMany: async () => { findManyCalled = true; return []; } } } as never,
      eventsMock(),
      settingsMock({ deleteEnabled: false }),
      remnawaveMock(-30 * DAY_MS),
      deletionMock(deletions),
    );

    const count = await service.runSweep();

    assert.equal(count, 0);
    assert.equal(findManyCalled, false);
    assert.equal(deletions.length, 0);
  });

  it('is a no-op when no expired subscriptions exist', async () => {
    const deletions: DeletionInput[] = [];
    const service = new ExpiredProfileCleanupService(
      { subscription: { findMany: async () => [], update: async () => ({}) } } as never,
      eventsMock(),
      settingsMock(),
      remnawaveMock(-30 * DAY_MS),
      deletionMock(deletions),
    );

    const count = await service.runSweep();

    assert.equal(count, 0);
    assert.equal(deletions.length, 0);
  });

  it('does not run the sweep on the API process role', async () => {
    process.env['RUID_PROCESS_ROLE'] = 'api';
    _resetProcessRoleCacheForTests();

    let findManyCalled = false;
    const service = new ExpiredProfileCleanupService(
      { subscription: { findMany: async () => { findManyCalled = true; return []; } } } as never,
      eventsMock(),
      settingsMock(),
      remnawaveMock(-30 * DAY_MS),
      deletionMock([]),
    );

    await service.sweepExpiredProfiles();

    assert.equal(findManyCalled, false);
  });
});

/**
 * `notFound` is the ONE non-`ok` outcome that deletes, so it is the branch a
 * misread 404 turns into data loss — and the `remnawaveMock` above cannot see
 * that, because the mapping from an HTTP answer to an outcome kind IS the thing
 * at stake. Everything here is the production wiring instead: the REAL
 * `RemnawaveApiService` over a panel that answers with real HTTP, handed to the
 * REAL sweep.
 *
 * The scenario is a Traefik/nginx redeploy — for its duration every request gets
 * a bare 404, from a process that has never heard of Remnawave. The sweep runs
 * every 30 minutes over CLEANUP_BATCH = 100 candidates and routes each one into
 * `deleteExpiredIfUnchanged`, which terminates entitlements, closes terms, sets
 * `status = DELETED` and enqueues a panel DELETE. The population that destroys
 * is exactly the one the panel re-check exists to protect: subscriptions renewed
 * on the panel whose local `expiresAt` is stale.
 */
describe('ExpiredProfileCleanupService — a 404 deletes only when the PANEL sent it', () => {
  const PANEL_CONFIG = {
    host: 'remnawave',
    port: 3000,
    token: 'secret',
    webhookSecret: null,
    caddyToken: null,
    cookie: null,
  } as const;

  /** The REAL adapter over a panel whose `/api/users/{uuid}` answers `reply`. */
  function panelApi(reply: () => unknown) {
    const reads: string[] = [];
    const service = new RemnawaveApiService(
      {
        request: (input: { url: string }) => {
          reads.push(input.url);
          return reply();
        },
      } as never,
      PANEL_CONFIG as never,
    );
    return { service, reads };
  }

  function httpError(status: number, data?: unknown) {
    return throwError(() => ({
      isAxiosError: true,
      response: { status, headers: {}, data },
      message: `HTTP ${status}`,
    }));
  }

  /**
   * The sweep over ONE candidate: expired 30 days ago by the local date, which
   * is the stale side of the story the panel re-check exists to settle.
   */
  function sweepOver(api: RemnawaveApiService) {
    const deletions: DeletionInput[] = [];
    const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
    const service = new ExpiredProfileCleanupService(
      {
        subscription: {
          findMany: async (input: { where: Record<string, unknown> }) => {
            if (input.where['remnawaveId'] === null) return [];
            return [
              {
                id: 'sub-renewed',
                userId: 'user-1',
                isTrial: false,
                remnawaveId: 'rw-renewed',
                expiresAt: new Date(Date.now() - 30 * DAY_MS),
              },
            ];
          },
          update: async (input: { where: unknown; data: Record<string, unknown> }) => {
            updates.push(input);
            return {};
          },
        },
      } as never,
      eventsMock(),
      settingsMock({ deleteEnabled: true, graceDays: 3 }),
      api as never,
      deletionMock(deletions),
    );
    return { service, deletions, updates };
  }

  const PROXY_404: ReadonlyArray<readonly [string, unknown]> = [
    ['an nginx HTML error page', '<html><head><title>404 Not Found</title></head></html>'],
    ['an empty body', ''],
    ['no body at all', undefined],
    ['a gateway JSON body with no panel error code', { message: '404 page not found' }],
  ];

  for (const [label, data] of PROXY_404) {
    it(`DEFERS on a bare 404 (${label}) — a host outage must not retire live subscriptions`, async () => {
      const { service: api, reads } = panelApi(() => httpError(404, data));
      const { service, deletions, updates } = sweepOver(api);

      const count = await service.runSweep();

      assert.equal(reads.length, 1, 'the panel re-check must actually have run');
      assert.equal(count, 0);
      assert.equal(
        deletions.length,
        0,
        'a proxy answering 404 for everything is an outage, not a missing profile',
      );
      assert.equal(updates.length, 0, 'and nothing is self-healed off an answer we do not have');
    });
  }

  it('still DELETES when the panel itself says the user is gone (404 + A025)', async () => {
    const { service: api } = panelApi(() =>
      httpError(404, { errorCode: 'A025', message: 'User not found' }),
    );
    const { service, deletions } = sweepOver(api);

    const count = await service.runSweep();

    assert.equal(count, 1, 'a genuine "the profile is gone" must still be cleaned up');
    assert.equal(deletions.length, 1);
    assert.equal(deletions[0]?.subscriptionId, 'sub-renewed');
    assert.equal(deletions[0]?.expectedRemnawaveId, 'rw-renewed');
  });

  it('self-heals instead of deleting when the panel serves a live expiry (unchanged)', async () => {
    // The other end of the same wiring: a real 2.8.0 answer still reaches the
    // sweep as `ok`, so the guard cannot have turned the sweep into a no-op.
    const renewedTo = new Date(Date.now() + 20 * DAY_MS);
    const { service: api } = panelApi(() =>
      of({
        data: {
          response: {
            expireAt: renewedTo.toISOString(),
            subscriptionUrl: 'https://panel.example/sub/xyz',
          },
          version: '2.8.0',
        },
      }),
    );
    const { service, deletions, updates } = sweepOver(api);

    const count = await service.runSweep();

    assert.equal(count, 0);
    assert.equal(deletions.length, 0);
    assert.equal(updates.length, 1);
    assert.equal((updates[0]?.data['expiresAt'] as Date).getTime(), renewedTo.getTime());
    assert.equal(updates[0]?.data['status'], SubscriptionStatus.ACTIVE);
  });
});
