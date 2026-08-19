import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { of, throwError } from 'rxjs';

import { SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';

import { _resetProcessRoleCacheForTests } from '../src/common/runtime/process-role.util';
import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { ExpiredProfileCleanupService } from '../src/modules/profile-sync/expired-profile-cleanup.service';
import {
  panelUserAddress,
  type StoredPanelIdentity,
} from '../src/modules/remnawave/services/panel-user-address';
import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';

/**
 * A candidate row as Prisma returns it once the sweep's select asks for the
 * panel identity.
 *
 * `remnawavePanelId` and `remnawavePanelUsername` are populated by DEFAULT
 * because that is the production shape — 2.x and 3.x alike carry a numeric id
 * and a username on every user row, so both are recorded when a profile is
 * linked. A fake that omitted them would make an unaddressable profile look
 * identical to an addressable one, in the one sweep that deletes.
 */
function candidate(patch: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    userId: 'user-1',
    isTrial: false,
    remnawaveId: 'rw-1',
    remnawavePanelId: 4711,
    remnawavePanelUsername: 'rz_alice_sub',
    expiresAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    ...patch,
  };
}

/** Settings mock factory — defaults to deletion ON with a 3-day grace. */
function settingsMock(policy: { deleteEnabled?: boolean; graceDays?: number } = {}) {
  return {
    getRemnawaveCleanupSettings: async () => ({
      deleteEnabled: policy.deleteEnabled ?? true,
      graceDays: policy.graceDays ?? 3,
    }),
  } as never;
}

/**
 * SystemEventsService mock — records `info` calls, and `warn` calls into a
 * SEPARATE sink so a test that asserts on the info stream cannot be satisfied
 * by a warning, or vice versa.
 */
function eventsMock(
  sink: Array<readonly unknown[]> = [],
  warnSink: Array<readonly unknown[]> = [],
) {
  return {
    info: (...args: unknown[]) => { sink.push(args); },
    warn: (...args: unknown[]) => { warnSink.push(args); },
  } as never;
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
function remnawaveMock(
  behaviour: number | 'notFound' | 'unavailable' | 'invalidContract',
  refs: unknown[] = [],
) {
  return {
    strictGetPanelUserExpiry: async (ref: unknown) => {
      refs.push(ref);
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
    const findManyCalls: Array<{
      readonly where: Record<string, unknown>;
      readonly select?: Record<string, unknown>;
      readonly take?: number;
    }> = [];
    const deletions: DeletionInput[] = [];
    const events: Array<readonly unknown[]> = [];

    const expiresAt1 = new Date(Date.now() - 30 * DAY_MS);
    const expiresAt2 = new Date(Date.now() - 40 * DAY_MS);
    const before = Date.now() - 3 * DAY_MS;
    const service = new ExpiredProfileCleanupService(
      {
        subscription: {
          findMany: async (input: {
            where: Record<string, unknown>;
            select?: Record<string, unknown>;
            take?: number;
          }) => {
            findManyCalls.push(input);
            // Profile-bearing selection (`remnawaveId: { not: null }`); the
            // detached selection (`remnawaveId: null`) returns nothing here.
            if (input.where['remnawaveId'] === null) return [];
            return [
              candidate({ id: 'sub-1', remnawaveId: 'rw-1', expiresAt: expiresAt1 }),
              candidate({
                id: 'sub-2',
                userId: 'user-2',
                isTrial: true,
                remnawaveId: 'rw-2',
                expiresAt: expiresAt2,
              }),
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
    const where = findManyCalls[0] as {
      readonly where: Record<string, unknown>;
      readonly select?: Record<string, unknown>;
      readonly take?: number;
    };
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
    // The identity columns are selected, not just `remnawaveId`. Omitting them
    // leaves a 2.x-created profile on an upgraded 3.x panel unaddressable, and
    // an unaddressable profile defers every sweep and is never retired.
    assert.equal(where.select?.['remnawavePanelId'], true);
    assert.equal(where.select?.['remnawavePanelUsername'], true);
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
            return [candidate({ id: 'sub-live', remnawaveId: 'rw-live' })];
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
            return [candidate({ id: 'sub-x', remnawaveId: 'rw-x' })];
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
            return [candidate({ id: 'sub-garbled', remnawaveId: 'rw-garbled' })];
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
            return [candidate({ id: 'sub-gone', remnawaveId: 'rw-gone' })];
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

  it('re-checks by the recorded numeric id when the stored id is a stale 2.x uuid, but fences the delete on the column', async () => {
    // The upgraded-panel case, and the one where getting it wrong is worst: an
    // unaddressable profile answers `unavailable`, so this subscription would
    // defer every sweep and never be retired. The numeric id is what finds it.
    //
    // The second half is the invariant that must NOT move with it.
    // `expectedRemnawaveId` is a compare-and-swap against the COLUMN, not an
    // address — it is what refuses the delete when a re-provision relinked the
    // row between the panel read and now. So it stays the stale uuid even
    // though the panel was asked at 8123.
    const staleUuid = '330f2b38-1362-46ab-b5c0-dea32167eff9';
    const deletions: DeletionInput[] = [];
    const panelRefs: unknown[] = [];

    const service = new ExpiredProfileCleanupService(
      {
        subscription: {
          findMany: async (input: { where: Record<string, unknown> }) => {
            if (input.where['remnawaveId'] === null) return [];
            return [
              candidate({ id: 'sub-upgraded', remnawaveId: staleUuid, remnawavePanelId: 8123 }),
            ];
          },
          update: async () => ({}),
        },
      } as never,
      eventsMock(),
      settingsMock({ deleteEnabled: true, graceDays: 3 }),
      remnawaveMock(-30 * DAY_MS, panelRefs),
      deletionMock(deletions),
    );

    const count = await service.runSweep();

    assert.equal(count, 1);
    assert.deepStrictEqual(panelRefs, [
      { remnawaveId: staleUuid, panelId: 8123, panelUsername: 'rz_alice_sub' },
    ]);
    assert.deepStrictEqual(panelUserAddress(panelRefs[0] as StoredPanelIdentity, 'id'), {
      kind: 'ready',
      segment: '8123',
    });
    assert.equal(deletions.length, 1);
    assert.equal(deletions[0]?.expectedRemnawaveId, staleUuid);
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

  it('refuses to soft-delete an expired row whose panel link was LOST, and says so', async () => {
    // "Detached" and "link lost" look identical from `remnawaveId` alone, and
    // they are opposites. A detached row has no panel profile; a link-lost row
    // has a LIVE one it can no longer name — the decoder used to cast an
    // undecoded panel body, so on 3.x `uuid` and `id` arrived undefined (Prisma
    // leaves undefined columns alone) while the panel username and the
    // subscription URL, passed as arguments, landed.
    //
    // Soft-deleting the second kind wrote `status = DELETED` with no revocation
    // at all: the profile kept serving a customer who had stopped paying, and
    // the row left the cabinet, this sweep AND the panel-link repair (which
    // selects `status <> DELETED`) in one step. Nothing downstream could
    // notice, and the sweep counted it as a success.
    const deletions: DeletionInput[] = [];
    const warned: Array<readonly unknown[]> = [];
    const expiresAt = new Date(Date.now() - 10 * DAY_MS);

    const service = new ExpiredProfileCleanupService(
      {
        subscription: {
          findMany: async (input: { where: Record<string, unknown> }) => {
            if (input.where['remnawaveId'] !== null) return [];
            return [
              // Genuinely detached: nothing upstream, safe to retire.
              {
                id: 'detached-1',
                expiresAt,
                remnawavePanelUsername: null,
                configUrl: null,
              },
              // Link lost: the profile is alive under this exact username.
              {
                id: 'lost-link-1',
                expiresAt,
                remnawavePanelUsername: 'rz_erin_1',
                configUrl: 'https://sub.example.test/api/sub/eee',
              },
              {
                id: 'lost-link-2',
                expiresAt,
                remnawavePanelUsername: 'rz_erin_2',
                configUrl: 'https://sub.example.test/api/sub/fff',
              },
            ];
          },
          update: async () => ({}),
        },
      } as never,
      eventsMock([], warned),
      settingsMock({ deleteEnabled: true, graceDays: 3 }),
      remnawaveMock(-30 * DAY_MS),
      deletionMock(deletions),
    );

    const count = await service.runSweep();

    // The observable outcome: which rows reached the destructive service at
    // all. Asserted as the exact list, not as a count — a count of 1 would also
    // pass if the sweep retired a link-lost row and skipped the detached one.
    assert.deepStrictEqual(deletions.map((d) => d.subscriptionId), ['detached-1']);
    assert.equal(count, 1);

    // And the two survivors are reported, with a number an operator can act on.
    assert.equal(warned.length, 1);
    assert.equal(warned[0]?.[0], EVENT_TYPES.SYSTEM_REMNAWAVE_SYNC);
    assert.deepStrictEqual(warned[0]?.[3], { subscriptions: 2 });
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
  } as const;

  /** The REAL adapter over a panel whose `/api/users/{uuid}` answers `reply`. */
  /**
   * `reads` counts PROFILE reads only.
   *
   * The adapter now asks the panel for its own version before it builds any
   * user-scoped path — Remnawave 2.x addresses users by uuid and 3.x by numeric
   * id, and the path cannot be built without knowing which. Those probes
   * (`/api/system/stats/recap`, `/api/system/metadata`) are cached per adapter
   * instance, but they still show up here, and counting them would turn "the
   * re-check ran exactly once" into an assertion about the version probe.
   */
  function panelApi(reply: () => unknown) {
    const reads: string[] = [];
    const allRequests: string[] = [];
    const service = new RemnawaveApiService(
      {
        request: (input: { url: string }) => {
          allRequests.push(input.url);
          if (!input.url.startsWith('/api/system/')) reads.push(input.url);
          return reply();
        },
      } as never,
      PANEL_CONFIG as never,
    );
    return { service, reads, allRequests };
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
            return [candidate({ id: 'sub-renewed', remnawaveId: 'rw-renewed' })];
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
