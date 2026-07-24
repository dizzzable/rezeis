import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { SyncJobStatus } from '@prisma/client';

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
  const originalLegacyRecovery = process.env['PROFILE_SYNC_RECOVER_LEGACY_FAILED'];

  afterEach(() => {
    if (originalRole === undefined) {
      delete process.env['RUID_PROCESS_ROLE'];
    } else {
      process.env['RUID_PROCESS_ROLE'] = originalRole;
    }
    if (originalLegacyRecovery === undefined) {
      delete process.env['PROFILE_SYNC_RECOVER_LEGACY_FAILED'];
    } else {
      process.env['PROFILE_SYNC_RECOVER_LEGACY_FAILED'] = originalLegacyRecovery;
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
      where: { status: 'PENDING', supersededAt: null },
      select: { id: true },
      take: 100,
      orderBy: { createdAt: 'asc' },
    }]);
    assert.deepStrictEqual(
      addedJobs.map((job) => (job as readonly unknown[])[1]),
      [{ syncJobId: 'sync-job-1' }, { syncJobId: 'sync-job-2' }],
    );
  });

  it('worker recovery resets only transient non-superseded FAILED rows, including DELETE and UPDATE', async () => {
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
          updateMany: async (input: unknown) => {
            updates.push(input);
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

    assert.deepEqual(findManyCalls[1], {
      where: {
        status: SyncJobStatus.FAILED,
        supersededAt: null,
        recoveryData: { path: ['classification'], equals: 'TRANSIENT' },
      },
      select: { id: true },
      take: 50,
      orderBy: { createdAt: 'asc' },
    });
    assert.equal(updates.length, 2);
    assert.deepEqual(
      updates.map((input) => (input as { where: unknown }).where),
      [
        {
          id: 'failed-delete-job',
          status: SyncJobStatus.FAILED,
          supersededAt: null,
          recoveryData: { path: ['classification'], equals: 'TRANSIENT' },
        },
        {
          id: 'failed-update-job',
          status: SyncJobStatus.FAILED,
          supersededAt: null,
          recoveryData: { path: ['classification'], equals: 'TRANSIENT' },
        },
      ],
    );
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
              return [{ id: 'stuck-running-job', startedAt: new Date('2026-01-01T00:00:00.000Z') }];
            }
            return [];
          },
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

    const runningQuery = findManyCalls.find((c) => c.where?.status === SyncJobStatus.RUNNING);
    assert.notEqual(runningQuery, undefined);
    const stuckReset = reclaims.find((u) => u.where.id === 'stuck-running-job');
    assert.notEqual(stuckReset, undefined);
    assert.equal(stuckReset!.data.status, SyncJobStatus.PENDING);
    assert.equal(stuckReset!.where.status, SyncJobStatus.RUNNING);
    assert.deepEqual(stuckReset!.where.startedAt, new Date('2026-01-01T00:00:00.000Z'));
    assert.equal(addedJobs.length, 1);
  });

  it('reclaims legacy FAILED rows with empty recoveryData only after the recovery rollout is enabled', async () => {
    process.env['RUID_PROCESS_ROLE'] = 'worker';
    process.env['PROFILE_SYNC_RECOVER_LEGACY_FAILED'] = 'true';
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
            return status === SyncJobStatus.FAILED ? [{ id: 'legacy-failed-job' }] : [];
          },
          updateMany: async (input: unknown) => {
            updates.push(input);
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

    const failedQuery = findManyCalls.find(
      (input) => (input as { where?: { status?: SyncJobStatus } }).where?.status === SyncJobStatus.FAILED,
    ) as { where: Record<string, unknown> } | undefined;
    assert.deepEqual(failedQuery?.where, {
      status: SyncJobStatus.FAILED,
      supersededAt: null,
      OR: [
        { recoveryData: { path: ['classification'], equals: 'TRANSIENT' } },
        { recoveryData: { equals: {} } },
      ],
    });
    assert.deepEqual((updates[0] as { where: unknown }).where, {
      id: 'legacy-failed-job',
      status: SyncJobStatus.FAILED,
      supersededAt: null,
      OR: [
        { recoveryData: { path: ['classification'], equals: 'TRANSIENT' } },
        { recoveryData: { equals: {} } },
      ],
    });
    assert.equal(addedJobs.length, 1);
  });

  it('does not recover legacy FAILED rows with empty recoveryData while the rollout is disabled', async () => {
    process.env['RUID_PROCESS_ROLE'] = 'worker';
    delete process.env['PROFILE_SYNC_RECOVER_LEGACY_FAILED'];
    _resetProcessRoleCacheForTests();

    const failedQueries: unknown[] = [];
    const service = new ProfileSyncQueueService(
      {
        profileSyncJob: {
          findMany: async (input: unknown) => {
            if ((input as { where?: { status?: SyncJobStatus } }).where?.status === SyncJobStatus.FAILED) {
              failedQueries.push(input);
            }
            return [];
          },
        },
      } as never,
      { remove: async () => undefined, add: async () => undefined } as never,
    );

    await service.sweepAndRecover();

    assert.deepEqual((failedQueries[0] as { where: unknown }).where, {
      status: SyncJobStatus.FAILED,
      supersededAt: null,
      recoveryData: { path: ['classification'], equals: 'TRANSIENT' },
    });
  });

  it('does not enqueue a stale RUNNING row when the lease was already replaced', async () => {
    process.env['RUID_PROCESS_ROLE'] = 'worker';
    _resetProcessRoleCacheForTests();

    const addedJobs: unknown[] = [];
    const service = new ProfileSyncQueueService(
      {
        profileSyncJob: {
          findMany: async (input: { where?: { status?: SyncJobStatus } }) =>
            input.where?.status === SyncJobStatus.RUNNING ? [{ id: 'replaced-running-job' }] : [],
          updateMany: async () => ({ count: 0 }),
        },
      } as never,
      {
        remove: async () => undefined,
        add: async (...args: unknown[]) => { addedJobs.push(args); },
      } as never,
    );

    await service.sweepAndRecover();

    assert.equal(addedJobs.length, 0);
  });
});
