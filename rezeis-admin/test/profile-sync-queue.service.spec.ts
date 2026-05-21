import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runBullMqEnqueueWithTimeout } from '../src/common/queue/bullmq-enqueue-options';
import { isBullMqJobAlreadyQueued } from '../src/common/queue/bullmq-duplicate-inspection';
import { ProfileSyncProcessor } from '../src/modules/payments/processors/profile-sync.processor';
import { ProfileSyncJobQueueService } from '../src/modules/payments/services/profile-sync-job-queue.service';

describe('BullMQ duplicate inspection', () => {
  it('returns false promptly when duplicate inspection stalls', async () => {
    let resolved = false;
    const startedAt = Date.now();
    const result = await isBullMqJobAlreadyQueued(
      { getJob: () => new Promise((resolve) => { setTimeout(() => { resolved = true; resolve({ id: 'profile-sync:secret-job' }); }, 50); }) } as never,
      'profile-sync:secret-job',
      5,
    );

    assert.equal(result, false);
    assert.equal(resolved, false);
    assert.ok(Date.now() - startedAt < 45);
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
    let resolved = false;
    const startedAt = Date.now();

    await assert.rejects(
      runBullMqEnqueueWithTimeout(() => new Promise((resolve) => { setTimeout(() => { resolved = true; resolve({ id: 'profile-sync:secret-job' }); }, 50); }), 5),
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

    assert.equal(resolved, false);
    assert.ok(Date.now() - startedAt < 45);
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

describe('ProfileSyncJobQueueService', () => {
  it('enqueues profile sync jobs with deterministic queue ids', async () => {
    const addedJobs: unknown[] = [];
    const service = new ProfileSyncJobQueueService(
      { profileSyncJob: { findUnique: async () => ({ id: 'sync-job-1' }) } } as never,
      { getJob: async () => null, add: async (...args: unknown[]) => { addedJobs.push(args); } } as never,
    );

    const result = await service.enqueueJob('sync-job-1');

    assert.equal(result.enqueued, true);
    assert.equal(result.queueJobId, 'profile-sync:sync-job-1');
    assert.deepStrictEqual(addedJobs, [[
      'process-profile-sync-job',
      { jobId: 'sync-job-1' },
      { jobId: 'profile-sync:sync-job-1', removeOnComplete: 100, removeOnFail: 100 },
    ]]);
  });

  it('does not enqueue duplicate queue jobs', async () => {
    let addCalled = false;
    const service = new ProfileSyncJobQueueService(
      { profileSyncJob: { findUnique: async () => ({ id: 'sync-job-1' }) } } as never,
      { getJob: async () => ({ id: 'profile-sync:sync-job-1' }), add: async () => { addCalled = true; } } as never,
    );

    const result = await service.enqueueJob('sync-job-1');

    assert.equal(result.enqueued, false);
    assert.equal(result.alreadyQueued, true);
    assert.equal(addCalled, false);
  });

  it('continues enqueueing with deterministic options when duplicate inspection fails', async () => {
    const additions: unknown[] = [];
    const service = new ProfileSyncJobQueueService(
      { profileSyncJob: { findUnique: async () => ({ id: 'sync-job-1' }) } } as never,
      {
        getJob: async () => { throw new Error('redis://admin:secret-password@queue.internal profile-sync payload'); },
        add: async (...args: unknown[]) => { additions.push(args); },
      } as never,
    );

    const result = await service.enqueueJob('sync-job-1');

    assert.equal(result.enqueued, true);
    assert.equal(result.alreadyQueued, false);
    assert.deepStrictEqual(additions, [[
      'process-profile-sync-job',
      { jobId: 'sync-job-1' },
      { jobId: 'profile-sync:sync-job-1', removeOnComplete: 100, removeOnFail: 100 },
    ]]);
  });

  it('fails stalled profile-sync enqueue with sanitized bounded error after preserving deterministic add arguments', async () => {
    const additions: unknown[] = [];
    const service = new ProfileSyncJobQueueService(
      { profileSyncJob: { findUnique: async () => ({ id: 'sync-job-1' }) } } as never,
      {
        getJob: async () => null,
        add: async (...args: unknown[]) => {
          additions.push(args);
          return new Promise((resolve) => { setTimeout(() => { resolve({ id: 'profile-sync:sync-job-1' }); }, 1_100); });
        },
      } as never,
    );

    await assert.rejects(service.enqueueJob('sync-job-1'), { name: 'BullMqEnqueueError' });
    assert.deepStrictEqual(additions, [[
      'process-profile-sync-job',
      { jobId: 'sync-job-1' },
      { jobId: 'profile-sync:sync-job-1', removeOnComplete: 100, removeOnFail: 100 },
    ]]);
  });
});

describe('ProfileSyncProcessor', () => {
  it('delegates queue payloads to processJobById', async () => {
    const processedJobIds: string[] = [];
    const processor = new ProfileSyncProcessor(
      { processJobById: async (jobId: string) => { processedJobIds.push(jobId); } } as never,
      { observe: async (_job: unknown, _descriptor: unknown, handler: () => Promise<void>) => handler(), recordSkipped: () => undefined } as never,
    );

    await processor.process({ name: 'process-profile-sync-job', data: { jobId: 'sync-job-1' } } as never);

    assert.deepStrictEqual(processedJobIds, ['sync-job-1']);
  });
});
