import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { SyncAction, SyncJobStatus } from '@prisma/client';

import { runBullMqEnqueueWithTimeout } from '../src/common/queue/bullmq-enqueue-options';
import { isBullMqJobAlreadyQueued } from '../src/common/queue/bullmq-duplicate-inspection';
import { _resetProcessRoleCacheForTests } from '../src/common/runtime/process-role.util';
import {
  PROFILE_SYNC_BACKOFF_MS,
  PROFILE_SYNC_JOB,
  PROFILE_SYNC_MAX_ATTEMPTS,
} from '../src/modules/profile-sync/profile-sync.constants';
import { ProfileSyncQueueService } from '../src/modules/profile-sync/profile-sync-queue.service';

describe('BullMQ duplicate inspection', () => {
  it('returns false promptly when duplicate inspection stalls', async () => {
    let inspectionStarted = false;
    const result = await isBullMqJobAlreadyQueued(
      { getJob: () => {
        inspectionStarted = true;
        return new Promise(() => undefined);
      } } as never,
      'profile-sync:secret-job',
      5,
    );

    assert.equal(result, false);
    assert.equal(inspectionStarted, true);
  });

  it('returns false for rejected duplicate inspection without surfacing raw details', async () => {
    const rawError = 'redis://admin:secret-password@queue.internal/0 payload payment_id=pay_secret';
    const result = await isBullMqJobAlreadyQueued(
      { getJob: async () => { throw new Error(rawError); } } as never,
      'profile-sync:secret-job',
      5,
    );

    assert.equal(result, false);
    assert.equal(JSON.stringify(result).includes('secret-password'), false);
    assert.equal(JSON.stringify(result).includes('redis://'), false);
  });

  it('returns false for synchronous duplicate inspection failures without surfacing raw details', async () => {
    const rawError = 'redis://admin:secret-password@queue.internal/0 payload payment_id=pay_secret';
    const result = await isBullMqJobAlreadyQueued(
      { getJob: () => { throw new Error(rawError); } } as never,
      'profile-sync:secret-job',
      5,
    );

    assert.equal(result, false);
    assert.equal(JSON.stringify(result).includes('secret-password'), false);
    assert.equal(JSON.stringify(result).includes('redis://'), false);
  });
});

describe('BullMQ enqueue timeout', () => {
  it('fails stalled enqueue operations with a sanitized bounded error', async () => {
    let enqueueStarted = false;

    await assert.rejects(
      runBullMqEnqueueWithTimeout(() => {
        enqueueStarted = true;
        return new Promise(() => undefined);
      }, 5),
      (error: unknown) => {
        const serialized = JSON.stringify(error);
        assert.equal(error instanceof Error, true);
        assert.equal((error as Error).name, 'BullMqEnqueueError');
        assert.equal(serialized.includes('profile-sync:secret-job'), false);
        assert.equal(serialized.includes('secret-password'), false);
        assert.equal(serialized.includes('redis://'), false);
        return true;
      },
    );

    assert.equal(enqueueStarted, true);
  });

  it('sanitizes rejected enqueue failures', async () => {
    const rawError = 'redis://admin:secret-password@queue.internal/0 payload subscription_id=sub_secret';

    await assert.rejects(
      runBullMqEnqueueWithTimeout(() => Promise.reject(new Error(rawError)), 5),
      (error: unknown) => {
        const serialized = JSON.stringify(error);
        assert.equal(error instanceof Error, true);
        assert.equal((error as Error).name, 'BullMqEnqueueError');
        assert.equal(serialized.includes('secret-password'), false);
        assert.equal(serialized.includes('redis://'), false);
        assert.equal(serialized.includes('sub_secret'), false);
        return true;
      },
    );
  });

  it('sanitizes synchronous enqueue failures', async () => {
    const rawError = 'redis://admin:secret-password@queue.internal/0 payload subscription_id=sub_secret';

    await assert.rejects(
      runBullMqEnqueueWithTimeout(() => { throw new Error(rawError); }, 5),
      (error: unknown) => {
        const serialized = JSON.stringify(error);
        assert.equal(error instanceof Error, true);
        assert.equal((error as Error).name, 'BullMqEnqueueError');
        assert.equal(serialized.includes('secret-password'), false);
        assert.equal(serialized.includes('redis://'), false);
        assert.equal(serialized.includes('sub_secret'), false);
        return true;
      },
    );
  });
});

describe('ProfileSyncQueueService', () => {
  const originalRole = process.env['RUID_PROCESS_ROLE'];

  afterEach(() => {
    if (originalRole === undefined) {
      delete process.env['RUID_PROCESS_ROLE'];
    } else {
      process.env['RUID_PROCESS_ROLE'] = originalRole;
    }
    _resetProcessRoleCacheForTests();
  });

  it('enqueues profile sync jobs with the current deterministic BullMQ contract', async () => {
    const addedJobs: unknown[] = [];
    const removedJobs: string[] = [];
    const service = new ProfileSyncQueueService(
      { profileSyncJob: { findMany: async () => [] } } as never,
      {
        remove: async (jobId: string) => { removedJobs.push(jobId); },
        add: async (...args: unknown[]) => { addedJobs.push(args); },
      } as never,
    );

    await service.enqueue('sync-job-1');

    assert.deepStrictEqual(removedJobs, []);
    assert.deepStrictEqual(addedJobs, [[
      PROFILE_SYNC_JOB,
      { syncJobId: 'sync-job-1' },
      {
        jobId: 'sync_sync-job-1',
        attempts: PROFILE_SYNC_MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: PROFILE_SYNC_BACKOFF_MS },
        removeOnComplete: 200,
        removeOnFail: 200,
      },
    ]]);
  });

  it('removes retained BullMQ jobs before force re-enqueueing', async () => {
    const addedJobs: unknown[] = [];
    const removedJobs: string[] = [];
    const service = new ProfileSyncQueueService(
      { profileSyncJob: { findMany: async () => [] } } as never,
      {
        remove: async (jobId: string) => { removedJobs.push(jobId); },
        add: async (...args: unknown[]) => { addedJobs.push(args); },
      } as never,
    );

    await service.enqueue('sync-job-1', true);

    assert.deepStrictEqual(removedJobs, ['sync_sync-job-1']);
    assert.equal(addedJobs.length, 1);
  });

  it('sweeps pending database rows into the queue', async () => {
    const findManyCalls: unknown[] = [];
    const addedJobs: unknown[] = [];
    const service = new ProfileSyncQueueService(
      {
        profileSyncJob: {
          findMany: async (input: unknown) => {
            findManyCalls.push(input);
            return [{ id: 'sync-job-1' }, { id: 'sync-job-2' }];
          },
        },
      } as never,
      {
        remove: async () => undefined,
        add: async (...args: unknown[]) => { addedJobs.push(args); },
      } as never,
    );

    const swept = await service.sweepPending();

    assert.equal(swept, 2);
    assert.deepStrictEqual(findManyCalls, [{
      where: { status: 'PENDING' },
      select: { id: true },
      take: 100,
      orderBy: { createdAt: 'asc' },
    }]);
    assert.deepStrictEqual(
      addedJobs.map((job) => (job as readonly unknown[])[1]),
      [{ syncJobId: 'sync-job-1' }, { syncJobId: 'sync-job-2' }],
    );
  });

  it('worker recovery resets all non-superseded FAILED rows, including DELETE and UPDATE', async () => {
    process.env['RUID_PROCESS_ROLE'] = 'worker';
    _resetProcessRoleCacheForTests();

    const findManyCalls: unknown[] = [];
    const updates: unknown[] = [];
    const addedJobs: unknown[] = [];
    const service = new ProfileSyncQueueService(
      {
        profileSyncJob: {
          findMany: async (input: unknown) => {
            findManyCalls.push(input);
            const status = (input as { where?: { status?: SyncJobStatus } }).where?.status;
            if (status === SyncJobStatus.FAILED) {
              return [{ id: 'failed-delete-job' }, { id: 'failed-update-job' }];
            }
            return [];
          },
          update: async (input: unknown) => { updates.push(input); },
        },
      } as never,
      {
        remove: async () => undefined,
        add: async (...args: unknown[]) => { addedJobs.push(args); },
      } as never,
    );

    await service.sweepAndRecover();

    assert.deepEqual(findManyCalls[1], {
      where: { status: SyncJobStatus.FAILED, supersededAt: null },
      select: { id: true },
      take: 50,
      orderBy: { createdAt: 'asc' },
    });
    assert.equal(updates.length, 2);
    assert.equal(addedJobs.length, 2);
  });

  it('does not recover superseded FAILED rows', async () => {
    process.env['RUID_PROCESS_ROLE'] = 'worker';
    _resetProcessRoleCacheForTests();
    const addedJobs: unknown[] = [];
    const service = new ProfileSyncQueueService(
      {
        profileSyncJob: {
          findMany: async (input: { readonly where?: { readonly status?: SyncJobStatus } }) =>
            input.where?.status === SyncJobStatus.PENDING ? [] : [],
          update: async () => { throw new Error('superseded row must not be updated'); },
        },
      } as never,
      { remove: async () => undefined, add: async (...args: unknown[]) => { addedJobs.push(args); } } as never,
    );

    await service.sweepAndRecover();
    assert.equal(addedJobs.length, 0);
  });

  it('recovers stale RUNNING jobs whose worker died (expired lease → PENDING + re-enqueue)', async () => {
    process.env['RUID_PROCESS_ROLE'] = 'worker';
    _resetProcessRoleCacheForTests();

    const findManyCalls: Array<{ where?: { status?: SyncJobStatus } }> = [];
    const reclaims: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
    const addedJobs: unknown[] = [];
    const service = new ProfileSyncQueueService(
      {
        profileSyncJob: {
          findMany: async (input: { where?: { status?: SyncJobStatus } }) => {
            findManyCalls.push(input);
            if (input.where?.status === SyncJobStatus.RUNNING) {
              return [{ id: 'stuck-running-job' }];
            }
            return [];
          },
          update: async () => undefined,
          updateMany: async (input: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            reclaims.push(input);
            return { count: 1 };
          },
        },
      } as never,
      {
        remove: async () => undefined,
        add: async (...args: unknown[]) => { addedJobs.push(args); },
      } as never,
    );

    await service.sweepAndRecover();

    // A stale-RUNNING query is issued with a startedAt cutoff and supersed-guard.
    const runningQuery = findManyCalls.find((c) => c.where?.status === SyncJobStatus.RUNNING);
    assert.notEqual(runningQuery, undefined);
    const stuckReset = reclaims.find((u) => u.where.id === 'stuck-running-job');
    assert.notEqual(stuckReset, undefined);
    assert.equal(stuckReset!.data.status, SyncJobStatus.PENDING);
    assert.equal(stuckReset!.where.status, SyncJobStatus.RUNNING);
    // Force re-enqueue removes the retained BullMQ job first.
    assert.equal(addedJobs.length, 1);
  });
});
