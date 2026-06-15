import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';

import { _resetProcessRoleCacheForTests } from '../src/common/runtime/process-role.util';
import { ExpiredProfileCleanupService } from '../src/modules/profile-sync/expired-profile-cleanup.service';

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

  it('selects only expired, profile-bearing subs with no in-flight DELETE job and enqueues a bounded batch', async () => {
    const findManyCalls: unknown[] = [];
    const createdJobs: unknown[] = [];
    const enqueued: string[] = [];
    const events: unknown[] = [];

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
    );

    const count = await service.runSweep();

    assert.equal(count, 2);
    // Selection guard: expired OR past-expiry, profile present, no live DELETE job, bounded.
    const where = (findManyCalls[0] as { readonly where: Record<string, unknown>; readonly take: number });
    assert.deepStrictEqual(where.where['remnawaveId'], { not: null });
    const orClause = where.where['OR'] as Array<Record<string, unknown>>;
    assert.equal(orClause.length, 2);
    assert.deepStrictEqual(orClause[0], { status: SubscriptionStatus.EXPIRED });
    const expiresClause = orClause[1]['expiresAt'] as { not: null; lt: Date };
    assert.equal(expiresClause.not, null);
    assert.ok(expiresClause.lt instanceof Date);
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

  it('is a no-op when no expired profile-bearing subscriptions exist', async () => {
    let createCalled = false;
    const service = new ExpiredProfileCleanupService(
      {
        subscription: { findMany: async () => [] },
        profileSyncJob: { create: async () => { createCalled = true; return { id: 'x' }; } },
      } as never,
      { enqueue: async () => undefined } as never,
      { info: () => undefined } as never,
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
    );

    await service.sweepExpiredProfiles();

    assert.equal(findManyCalled, false);
  });
});
