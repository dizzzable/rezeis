import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';

import { _resetProcessRoleCacheForTests } from '../src/common/runtime/process-role.util';
import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { ExpiredProfileCleanupService } from '../src/modules/profile-sync/expired-profile-cleanup.service';

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
 * Remnawave API mock. `getPanelUser` returns a panel user whose `expireAt` is
 * `expireOffsetMs` from now (negative = past). Pass `null` to simulate a
 * missing panel profile, or `'throw'` to simulate an unreachable panel.
 */
function remnawaveMock(behaviour: number | null | 'throw') {
  return {
    getPanelUser: async () => {
      if (behaviour === 'throw') throw new Error('panel unreachable');
      if (behaviour === null) return null;
      return {
        uuid: 'rw-uuid',
        expireAt: new Date(Date.now() + behaviour).toISOString(),
        subscriptionUrl: 'https://panel.example/sub/xyz',
        status: 'ACTIVE',
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
              { id: 'sub-1', userId: 'user-1', isTrial: true, remnawaveId: 'rw-1', expiresAt: expiresAt1 },
              { id: 'sub-2', userId: 'user-2', isTrial: false, remnawaveId: 'rw-2', expiresAt: expiresAt2 },
            ];
          },
          update: async () => ({}),
        },
      } as never,
      eventsMock(events),
      settingsMock({ deleteEnabled: true, graceDays: 3 }),
      // Panel confirms both are long expired (30 days ago) → delete proceeds.
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
      remnawaveMock('throw'),
      deletionMock(deletions),
    );

    const count = await service.runSweep();

    assert.equal(count, 0);
    assert.equal(deletions.length, 0);
    assert.equal(updates.length, 0);
  });

  it('deletes when the panel profile is already gone (getPanelUser returns null)', async () => {
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
      remnawaveMock(null),
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
