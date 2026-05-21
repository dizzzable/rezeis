import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { Job } from 'bullmq';

import { jobMetricsRegistry } from '../src/common/metrics/job-metrics.registry';
import { JobObservabilityService } from '../src/common/observability/job-observability.service';
import { MetricsService } from '../src/modules/metrics/metrics.service';
import { PROFILE_SYNC_JOB, PROFILE_SYNC_QUEUE } from '../src/modules/payments/constants/profile-sync-queue.constant';
import { ProfileSyncProcessor } from '../src/modules/payments/processors/profile-sync.processor';

describe('JobObservabilityService', () => {
  beforeEach(() => {
    jobMetricsRegistry.resetForTests();
  });

  it('logs completed jobs without raw job ids or payload values and records metrics', async () => {
    const service = createJobObservabilityService();
    const job = createJob({
      id: 'notification-event:user_secret@example.test:token-secret-value',
      data: { eventId: 'evt_secret_provider_token_123' },
      name: 'deliver-notification-event',
    });

    await service.observe(job, { queueName: 'notification-delivery', jobName: 'deliver-notification-event' }, async () => undefined);

    const logs = JSON.stringify(service.logEntries);
    assert.match(logs, /Worker job started/);
    assert.match(logs, /Worker job completed/);
    assert.match(logs, /"jobIdPresent":true/);
    assert.doesNotMatch(logs, /user_secret@example\.test/);
    assert.doesNotMatch(logs, /evt_secret_provider_token_123/);
    assert.doesNotMatch(logs, /token-secret-value/);

    const metrics = new MetricsService().renderPrometheusText();
    assert.match(metrics, /rezeis_admin_worker_jobs_total\{queue="notification-delivery",jobName="deliver-notification-event",status="completed"\} 1/);
    assert.doesNotMatch(metrics, /evt_secret_provider_token_123/);
    assert.doesNotMatch(metrics, /user_secret@example\.test/);
  });

  it('logs failed jobs with generic error type and without raw error messages', async () => {
    const service = createJobObservabilityService();
    const job = createJob({
      id: 'profile-sync:job-secret-provider-token',
      data: { jobId: 'profile-secret-token-123' },
      name: PROFILE_SYNC_JOB,
    });

    await assert.rejects(
      () =>
        service.observe(job, { queueName: PROFILE_SYNC_QUEUE, jobName: PROFILE_SYNC_JOB }, async () => {
          throw new Error('postgres://admin:secret@db.internal raw provider token leaked');
        }),
      /raw provider token/u,
    );

    const logs = JSON.stringify(service.logEntries);
    assert.match(logs, /Worker job failed/);
    assert.match(logs, /"errorType":"Error"/);
    assert.doesNotMatch(logs, /postgres:\/\//);
    assert.doesNotMatch(logs, /secret@db\.internal/);
    assert.doesNotMatch(logs, /profile-secret-token-123/);

    const metrics = new MetricsService().renderPrometheusText();
    assert.match(metrics, /rezeis_admin_worker_jobs_total\{queue="profile-sync",jobName="process-profile-sync-job",status="failed"\} 1/);
  });

  it('records skipped jobs without logging raw unexpected job names', () => {
    const service = createJobObservabilityService();
    const job = createJob({
      id: 'raw-job-id-token-secret',
      data: { userId: 'user_secret@example.test' },
      name: 'unexpected-job-name-with-secret-token',
    });

    service.recordSkipped(job, { queueName: PROFILE_SYNC_QUEUE, jobName: PROFILE_SYNC_JOB });

    const logs = JSON.stringify(service.logEntries);
    assert.match(logs, /Worker job skipped/);
    assert.match(logs, /"actualJobName":"hidden"/);
    assert.doesNotMatch(logs, /unexpected-job-name-with-secret-token/);
    assert.doesNotMatch(logs, /raw-job-id-token-secret/);
    assert.doesNotMatch(logs, /user_secret@example\.test/);
  });
});

describe('ProfileSyncProcessor job observability wiring', () => {
  it('wraps valid jobs and records skipped unexpected jobs without changing payload semantics', async () => {
    const processedJobIds: string[] = [];
    const observedJobs: string[] = [];
    const skippedJobs: string[] = [];
    const executor = {
      processJobById: async (jobId: string) => {
        processedJobIds.push(jobId);
      },
    };
    const observability = {
      observe: async (job: Job, _descriptor: unknown, handler: () => Promise<void>) => {
        observedJobs.push(job.name);
        await handler();
      },
      recordSkipped: (job: Job) => {
        skippedJobs.push(job.name);
      },
    };
    const processor = new ProfileSyncProcessor(executor as never, observability as never);

    await processor.process(createJob({ name: PROFILE_SYNC_JOB, data: { jobId: 'profile-sync-job-id' } }));
    await processor.process(createJob({ name: 'unexpected-profile-sync-job', data: { jobId: 'ignored' } }));

    assert.deepEqual(processedJobIds, ['profile-sync-job-id']);
    assert.deepEqual(observedJobs, [PROFILE_SYNC_JOB]);
    assert.deepEqual(skippedJobs, ['unexpected-profile-sync-job']);
  });
});

function createJobObservabilityService(): JobObservabilityService & { readonly logEntries: unknown[] } {
  const service = new JobObservabilityService() as JobObservabilityService & { logEntries: unknown[] };
  const writableService = service as unknown as {
    logger: { log: (entry: unknown) => void; warn: (entry: unknown) => void };
    logEntries: unknown[];
  };
  writableService.logEntries = [];
  writableService.logger = {
    log: (entry: unknown) => writableService.logEntries.push(entry),
    warn: (entry: unknown) => writableService.logEntries.push(entry),
  };
  return service;
}

function createJob(params: { readonly id?: string; readonly name: string; readonly data?: unknown }): Job {
  return {
    id: params.id,
    name: params.name,
    data: params.data ?? {},
    attemptsMade: 1,
  } as Job;
}
