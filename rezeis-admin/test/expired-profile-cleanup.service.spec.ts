import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';

import { _resetProcessRoleCacheForTests } from '../src/common/runtime/process-role.util';
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

  it('selects only profile-bearing subs expired past the grace cutoff with no in-flight DELETE job and enqueues a bounded batch', async () => {
    const findManyCalls: unknown[] = [];
    const createdJobs: unknown[] = [];
    const enqueued: string[] = [];
    const events: unknown[] = [];

    const before = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const service = new ExpiredProfileCleanupService(
      {
        subscription: {
          findMany: async (input: unknown) => {
            findManyCalls.push(input);
            return [
              { id: 'sub-1', userId: 'user-1', isTrial: true },
              { id: 'sub-2', userId: 'user-2', isTrial: false },
            ];
          },
          updateMany: async () => ({ count: 0 }),
        },
        profileSyncJob: {
          create: async (input: { readonly data: { readonly subscriptionId: string } }) => {
            createdJobs.push(input);
            return { id: `job-${input.data.subscriptionId}` };
          },
        },
      } as never,
      {
        enqueue: async (jobId: string) => { enqueued.push(jobId); },
      } as never,
      { info: (...args: unknown[]) => { events.push(args); } } as never,
      settingsMock({ deleteEnabled: true, graceDays: 3 }),
    );

    const count = await service.runSweep();
    const after = Date.now() - 3 * 24 * 60 * 60 * 1000;

    assert.equal(count, 2);
    // Selection guard: profile present, expired before the grace cutoff, no
    // live DELETE job, bounded.
    const where = (findManyCalls[0] as { readonly where: Record<string, unknown>; readonly take: number });
    assert.deepStrictEqual(where.where['remnawaveId'], { not: null });
    assert.equal(where.where['OR'], undefined);
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
    // A DELETE job created + enqueued per candidate.
    assert.deepStrictEqual(
      createdJobs.map((j) => (j as { data: { action: SyncAction; subscriptionId: string } }).data),
      [
        { subscriptionId: 'sub-1', action: SyncAction.DELETE, status: SyncJobStatus.PENDING, payload: { source: 'EXPIRED_PROFILE_CLEANUP' } } as never,
        { subscriptionId: 'sub-2', action: SyncAction.DELETE, status: SyncJobStatus.PENDING, payload: { source: 'EXPIRED_PROFILE_CLEANUP' } } as never,
      ],
    );
    assert.deepStrictEqual(enqueued, ['job-sub-1', 'job-sub-2']);
    assert.equal(events.length, 2);
  });

  it('soft-deletes already-detached expired rows (remnawaveId null, not DELETED) in bulk', async () => {
    const updateManyCalls: unknown[] = [];
    const before = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const service = new ExpiredProfileCleanupService(
      {
        subscription: {
          findMany: async () => [],
          updateMany: async (input: unknown) => {
            updateManyCalls.push(input);
            return { count: 4 };
          },
        },
      } as never,
      { enqueue: async () => undefined } as never,
      { info: () => undefined } as never,
      settingsMock({ deleteEnabled: true, graceDays: 3 }),
    );

    const count = await service.runSweep();
    const after = Date.now() - 3 * 24 * 60 * 60 * 1000;

    assert.equal(count, 4);
    assert.equal(updateManyCalls.length, 1);
    const call = updateManyCalls[0] as {
      readonly where: Record<string, unknown>;
      readonly data: Record<string, unknown>;
    };
    assert.equal(call.where['remnawaveId'], null);
    assert.deepStrictEqual(call.where['status'], { not: SubscriptionStatus.DELETED });
    const expiresClause = call.where['expiresAt'] as { not: null; lt: Date };
    assert.equal(expiresClause.not, null);
    assert.ok(expiresClause.lt.getTime() >= before && expiresClause.lt.getTime() <= after);
    assert.deepStrictEqual(call.data, { status: SubscriptionStatus.DELETED });
  });

  it('honours a wider grace window in the cutoff (graceDays=7)', async () => {
    const findManyCalls: unknown[] = [];
    const service = new ExpiredProfileCleanupService(
      { subscription: { findMany: async (i: unknown) => { findManyCalls.push(i); return []; }, updateMany: async () => ({ count: 0 }) } } as never,
      { enqueue: async () => undefined } as never,
      { info: () => undefined } as never,
      settingsMock({ deleteEnabled: true, graceDays: 7 }),
    );

    const lowerBound = Date.now() - 7 * 24 * 60 * 60 * 1000;
    await service.runSweep();
    const upperBound = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const where = (findManyCalls[0] as { readonly where: Record<string, unknown> });
    const expiresClause = where.where['expiresAt'] as { not: null; lt: Date };
    assert.ok(expiresClause.lt.getTime() >= lowerBound && expiresClause.lt.getTime() <= upperBound);
  });

  it('is a no-op (no panel call) when deletion is disabled in settings', async () => {
    let findManyCalled = false;
    const service = new ExpiredProfileCleanupService(
      { subscription: { findMany: async () => { findManyCalled = true; return []; } } } as never,
      { enqueue: async () => undefined } as never,
      { info: () => undefined } as never,
      settingsMock({ deleteEnabled: false }),
    );

    const count = await service.runSweep();

    assert.equal(count, 0);
    assert.equal(findManyCalled, false);
  });

  it('is a no-op when no expired profile-bearing subscriptions exist', async () => {
    let createCalled = false;
    const service = new ExpiredProfileCleanupService(
      {
        subscription: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
        profileSyncJob: { create: async () => { createCalled = true; return { id: 'x' }; } },
      } as never,
      { enqueue: async () => undefined } as never,
      { info: () => undefined } as never,
      settingsMock(),
    );

    const count = await service.runSweep();

    assert.equal(count, 0);
    assert.equal(createCalled, false);
  });

  it('does not run the sweep on the API process role', async () => {
    process.env['RUID_PROCESS_ROLE'] = 'api';
    _resetProcessRoleCacheForTests();

    let findManyCalled = false;
    const service = new ExpiredProfileCleanupService(
      { subscription: { findMany: async () => { findManyCalled = true; return []; } } } as never,
      { enqueue: async () => undefined } as never,
      { info: () => undefined } as never,
      settingsMock(),
    );

    await service.sweepExpiredProfiles();

    assert.equal(findManyCalled, false);
  });
});
