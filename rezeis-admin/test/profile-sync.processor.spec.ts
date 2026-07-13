import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';

import { ProfileSyncProcessor } from '../src/modules/profile-sync/profile-sync.processor';

describe('ProfileSyncProcessor', () => {
  it('skips superseded work before marking it running or calling Remnawave', async () => {
    const updates: unknown[] = [];
    let upstreamCalled = false;
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-superseded',
            action: SyncAction.UPDATE,
            status: SyncJobStatus.PENDING,
            attempts: 0,
            supersededAt: new Date('2026-01-01T00:00:00.000Z'),
            subscription: { id: 'subscription-1' },
          }),
          update: async (input: unknown) => updates.push(input),
        },
      } as never,
      { updatePanelUser: async () => { upstreamCalled = true; } } as never,
      {} as never,
      { error: () => undefined, info: () => undefined } as never,
    );

    await processor.process({ data: { syncJobId: 'sync-job-superseded' } } as never);

    assert.equal(upstreamCalled, false);
    assert.deepEqual(updates, []);
  });

  it('skips upstream work when deletion supersedes the job between read and claim', async () => {
    let upstreamCalled = false;
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-race', action: SyncAction.UPDATE, status: SyncJobStatus.PENDING,
            attempts: 0, supersededAt: null, subscription: { id: 'subscription-1' },
          }),
          updateMany: async () => ({ count: 0 }),
        },
      } as never,
      { updatePanelUser: async () => { upstreamCalled = true; } } as never,
      {} as never,
      { error: () => undefined, info: () => undefined } as never,
    );

    await processor.process({ data: { syncJobId: 'sync-job-race' } } as never);

    assert.equal(upstreamCalled, false);
  });

  it('atomically reclaims a non-superseded FAILED job for BullMQ retry', async () => {
    const claims: unknown[] = [];
    let upstreamCalled = false;
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-retry', action: SyncAction.UPDATE, status: SyncJobStatus.FAILED,
            attempts: 1, supersededAt: null,
            subscription: {
              id: 'subscription-1', userId: 'user-1', remnawaveId: 'rem-user-1',
              trafficLimit: 2, deviceLimit: 3, internalSquads: [], externalSquad: null,
              expiresAt: new Date('2099-01-01T00:00:00.000Z'), planSnapshot: {},
            },
          }),
          updateMany: async (input: unknown) => {
            claims.push(input);
            const status = (input as { where: { status: unknown } }).where.status;
            return { count: Array.isArray((status as { in?: unknown[] }).in) && (status as { in: unknown[] }).in.includes(SyncJobStatus.FAILED) ? 1 : 0 };
          },
          update: async () => undefined,
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
          $queryRaw: async () => [{ status: SubscriptionStatus.ACTIVE }],
          profileSyncJob: {
            findMany: async () => [],
            create: async () => ({ id: 'unused-delete-job' }),
          },
        }),
      } as never,
      { updatePanelUser: async () => { upstreamCalled = true; } } as never,
      {
        generateProfileName: async () => ({ username: 'rz_subscription_1', description: 'retry profile' }),
        getContactInfo: async () => ({ email: null, telegramId: null }),
      } as never,
      { error: () => undefined, info: () => undefined } as never,
    );

    await processor.process({ data: { syncJobId: 'sync-job-retry' } } as never);

    assert.equal(upstreamCalled, true);
    assert.equal(claims.length, 2);
    assert.equal((claims[0] as { where: { status: { in: SyncJobStatus[] } } }).where.status.in.includes(SyncJobStatus.FAILED), true);
  });

  it('updates existing Remnawave profiles from current profile-sync rows', async () => {
    const profileSyncUpdates: unknown[] = [];
    const remnawaveUpdates: unknown[] = [];
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-1',
            action: SyncAction.UPDATE,
            status: SyncJobStatus.PENDING,
            attempts: 0,
            subscription: {
              id: 'subscription-1',
              userId: 'user-1',
              remnawaveId: 'rem-user-1',
              trafficLimit: 2,
              deviceLimit: 3,
              internalSquads: ['internal-a'],
              externalSquad: 'external-a',
              expiresAt: new Date('2099-01-01T00:00:00.000Z'),
              planSnapshot: { tag: 'premium', trafficLimitStrategy: 'MONTH' },
            },
          }),
          updateMany: async (input: unknown) => {
            profileSyncUpdates.push(input);
            return { count: 1 };
          },
          update: async (input: unknown) => { profileSyncUpdates.push(input); },
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
          $queryRaw: async () => [{ status: SubscriptionStatus.ACTIVE }],
          profileSyncJob: {
            findMany: async () => [],
            create: async () => ({ id: 'unused-delete-job' }),
          },
        }),
      } as never,
      {
        updatePanelUser: async (...args: unknown[]) => { remnawaveUpdates.push(args); },
      } as never,
      {
        generateProfileName: async () => ({ username: 'rz_subscription_1', description: 'profile description' }),
        getContactInfo: async () => ({ email: 'user@example.test', telegramId: 123n }),
      } as never,
      { error: () => undefined, info: () => undefined } as never,
    );

    await processor.process({ data: { syncJobId: 'sync-job-1' } } as never);

    assert.equal((profileSyncUpdates[0] as { readonly data: { readonly status: SyncJobStatus } }).data.status, SyncJobStatus.RUNNING);
    assert.equal((profileSyncUpdates[1] as { readonly data: { readonly status: SyncJobStatus } }).data.status, SyncJobStatus.COMPLETED);
    assert.deepStrictEqual(remnawaveUpdates, [[
      'rem-user-1',
      {
        telegramId: 123,
        email: 'user@example.test',
        description: 'profile description',
        tag: 'premium',
        expireAt: '2099-01-01T00:00:00.000Z',
        trafficLimitBytes: 2 * 1024 * 1024 * 1024,
        hwidDeviceLimit: 3,
        trafficLimitStrategy: 'MONTH',
        activeInternalSquads: ['internal-a'],
        externalSquadUuid: 'external-a',
      },
    ]]);
  });

  it('enqueues compensating DELETE work when UPDATE finishes after deletion', async () => {
    const enqueuedDeleteJobs: string[] = [];
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-update-delete', action: SyncAction.UPDATE, status: SyncJobStatus.PENDING,
            attempts: 0, supersededAt: null,
            subscription: {
              id: 'subscription-deleted', userId: 'user-1', remnawaveId: 'rem-user-update',
              trafficLimit: 1, deviceLimit: 1, internalSquads: [], externalSquad: null,
              expiresAt: new Date('2099-01-01T00:00:00.000Z'), planSnapshot: {},
            },
          }),
          updateMany: async () => ({ count: 1 }),
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
          $queryRaw: async () => [{ status: SubscriptionStatus.DELETED }],
          profileSyncJob: {
            findMany: async () => [],
            create: async () => ({ id: 'delete-job-update' }),
          },
        }),
      } as never,
      { updatePanelUser: async () => undefined } as never,
      {
        generateProfileName: async () => ({ username: 'rz_update', description: 'update' }),
        getContactInfo: async () => ({ email: null, telegramId: null }),
      } as never,
      { error: () => undefined, info: () => undefined } as never,
      { enqueue: async (jobId: string) => { enqueuedDeleteJobs.push(jobId); } } as never,
    );

    await processor.process({ data: { syncJobId: 'sync-job-update-delete' } } as never);

    assert.deepEqual(enqueuedDeleteJobs, ['delete-job-update']);
  });

  it('enqueues compensating DELETE work when TRAFFIC_RESET finishes after deletion', async () => {
    const enqueuedDeleteJobs: string[] = [];
    let resetCalled = false;
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-reset-delete', action: SyncAction.TRAFFIC_RESET, status: SyncJobStatus.PENDING,
            attempts: 0, supersededAt: null,
            subscription: {
              id: 'subscription-deleted', userId: 'user-1', remnawaveId: 'rem-user-reset',
              trafficLimit: 1, deviceLimit: 1, internalSquads: [], externalSquad: null,
              expiresAt: new Date('2099-01-01T00:00:00.000Z'), planSnapshot: {},
            },
          }),
          updateMany: async () => ({ count: 1 }),
          update: async () => undefined,
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
          $queryRaw: async () => [{ status: SubscriptionStatus.DELETED }],
          profileSyncJob: {
            findMany: async () => [],
            create: async () => ({ id: 'delete-job-reset' }),
          },
        }),
      } as never,
      { resetPanelUserTraffic: async () => { resetCalled = true; } } as never,
      {} as never,
      { error: () => undefined, info: () => undefined } as never,
      { enqueue: async (jobId: string) => { enqueuedDeleteJobs.push(jobId); } } as never,
    );

    await processor.process({ data: { syncJobId: 'sync-job-reset-delete' } } as never);

    assert.equal(resetCalled, true);
    assert.deepEqual(enqueuedDeleteJobs, ['delete-job-reset']);
  });

  it('creates missing Remnawave profiles and stores returned linkage metadata', async () => {
    const profileSyncUpdates: unknown[] = [];
    const subscriptionUpdates: unknown[] = [];
    const remnawaveCreates: unknown[] = [];
    const infoEvents: unknown[] = [];
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-1',
            action: SyncAction.CREATE,
            status: SyncJobStatus.PENDING,
            attempts: 0,
            subscription: {
              id: 'subscription-1',
              userId: 'user-1',
              remnawaveId: null,
              trafficLimit: 5,
              deviceLimit: -1,
              internalSquads: ['internal-b'],
              externalSquad: null,
              expiresAt: new Date('2099-02-01T00:00:00.000Z'),
              planSnapshot: { tag: 'trial', trafficLimitStrategy: 'NO_RESET' },
            },
          }),
          updateMany: async (input: unknown) => {
            profileSyncUpdates.push(input);
            return { count: 1 };
          },
          update: async (input: unknown) => { profileSyncUpdates.push(input); },
        },
        subscription: {
          update: async (input: unknown) => { subscriptionUpdates.push(input); },
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
          $queryRaw: async () => [{ status: SubscriptionStatus.ACTIVE }],
          subscription: {
            update: async (input: unknown) => { subscriptionUpdates.push(input); },
          },
          profileSyncJob: {
            findMany: async () => [],
            create: async () => ({ id: 'unused-delete-job' }),
          },
        }),
      } as never,
      {
        getPanelUserByUsername: async () => null,
        createPanelUser: async (input: unknown) => {
          remnawaveCreates.push(input);
          return { uuid: 'rem-user-created', subscriptionUrl: 'https://sub.example/created' };
        },
      } as never,
      {
        generateProfileName: async () => ({ username: 'rz_subscription_1', description: 'profile description' }),
        getContactInfo: async () => ({ email: null, telegramId: null }),
      } as never,
      { error: () => undefined, info: (...args: unknown[]) => { infoEvents.push(args); } } as never,
    );

    await processor.process({ data: { syncJobId: 'sync-job-1' } } as never);

    assert.equal((profileSyncUpdates[0] as { readonly data: { readonly status: SyncJobStatus } }).data.status, SyncJobStatus.RUNNING);
    assert.equal((profileSyncUpdates[1] as { readonly data: { readonly status: SyncJobStatus } }).data.status, SyncJobStatus.COMPLETED);
    assert.deepStrictEqual(remnawaveCreates, [{
      username: 'rz_subscription_1',
      telegramId: null,
      email: null,
      description: 'profile description',
      tag: 'trial',
      expireAt: '2099-02-01T00:00:00.000Z',
      trafficLimitBytes: 5 * 1024 * 1024 * 1024,
      hwidDeviceLimit: 0,
      trafficLimitStrategy: 'NO_RESET',
      activeInternalSquads: ['internal-b'],
      externalSquadUuid: null,
    }]);
    assert.deepStrictEqual(subscriptionUpdates, [{
      where: { id: 'subscription-1' },
      data: {
        remnawaveId: 'rem-user-created',
        configUrl: 'https://sub.example/created',
      },
    }]);
    assert.equal(infoEvents.length, 1);
  });

  it('creates durable DELETE work when CREATE finishes after subscription deletion', async () => {
    let deleteJobs = 0;
    let upstreamCreates = 0;
    const enqueuedDeleteJobs: string[] = [];
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-late-create', action: SyncAction.CREATE, status: SyncJobStatus.PENDING,
            attempts: 0, supersededAt: null,
            subscription: {
              id: 'subscription-deleted', userId: 'user-1', remnawaveId: null,
              trafficLimit: 1, deviceLimit: 1, internalSquads: [], externalSquad: null,
              expiresAt: new Date('2099-01-01T00:00:00.000Z'), planSnapshot: {},
            },
          }),
          updateMany: async () => ({ count: 1 }),
          update: async () => undefined,
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
          $queryRaw: async () => [{ id: 'subscription-deleted', status: SubscriptionStatus.DELETED, remnawaveId: null }],
          subscription: { update: async () => undefined },
          profileSyncJob: {
            findMany: async () => [],
            create: async () => { deleteJobs += 1; return { id: 'delete-job-late-create' }; },
          },
        }),
      } as never,
      {
        getPanelUserByUsername: async () => null,
        createPanelUser: async () => {
          upstreamCreates += 1;
          return { uuid: 'rem-user-late-create', subscriptionUrl: 'https://sub.example/late-create' };
        },
      } as never,
      {
        generateProfileName: async () => ({ username: 'rz_subscription_deleted', description: 'late profile' }),
        getContactInfo: async () => ({ email: null, telegramId: null }),
      } as never,
      { error: () => undefined, info: () => undefined } as never,
      { enqueue: async (jobId: string) => { enqueuedDeleteJobs.push(jobId); } } as never,
    );

    await processor.process({ data: { syncJobId: 'sync-job-late-create' } } as never);

    assert.equal(upstreamCreates, 1);
    assert.equal(deleteJobs, 1);
    assert.deepEqual(enqueuedDeleteJobs, ['delete-job-late-create']);
  });

  it('reuses existing panel profiles during CREATE retries instead of creating duplicates', async () => {
    let createCalled = false;
    const subscriptionUpdates: unknown[] = [];
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-1',
            action: SyncAction.CREATE,
            status: SyncJobStatus.PENDING,
            attempts: 0,
            subscription: {
              id: 'subscription-1',
              userId: 'user-1',
              remnawaveId: null,
              trafficLimit: null,
              deviceLimit: 0,
              internalSquads: [],
              externalSquad: null,
              expiresAt: new Date('2099-03-01T00:00:00.000Z'),
              planSnapshot: {},
            },
          }),
          updateMany: async () => ({ count: 1 }),
          update: async () => undefined,
        },
        subscription: {
          update: async (input: unknown) => { subscriptionUpdates.push(input); },
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
          $queryRaw: async () => [{ status: SubscriptionStatus.ACTIVE }],
          subscription: {
            update: async (input: unknown) => { subscriptionUpdates.push(input); },
          },
          profileSyncJob: {
            findMany: async () => [],
            create: async () => ({ id: 'unused-delete-job' }),
          },
        }),
      } as never,
      {
        getPanelUserByUsername: async (username: string) => {
          assert.equal(username, 'rz_subscription_1');
          return { uuid: 'rem-user-existing', subscriptionUrl: 'https://sub.example/existing' };
        },
        createPanelUser: async () => { createCalled = true; },
      } as never,
      {
        generateProfileName: async () => ({ username: 'rz_subscription_1', description: 'profile description' }),
        getContactInfo: async () => ({ email: null, telegramId: null }),
      } as never,
      { error: () => undefined, info: () => undefined } as never,
    );

    await processor.process({ data: { syncJobId: 'sync-job-1' } } as never);

    assert.equal(createCalled, false);
    assert.deepStrictEqual(subscriptionUpdates, [{
      where: { id: 'subscription-1' },
      data: {
        remnawaveId: 'rem-user-existing',
        configUrl: 'https://sub.example/existing',
      },
    }]);
  });

  it('does not clear a newer profile link when an older DELETE target completes', async () => {
    const subscriptionUpdates: unknown[] = [];
    const deletedTargets: string[] = [];
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-delete-old',
            action: SyncAction.DELETE,
            status: SyncJobStatus.PENDING,
            attempts: 0,
            payload: { targetRemnawaveId: 'rem-user-old' },
            subscription: {
              id: 'subscription-1',
              userId: 'user-1',
              remnawaveId: 'rem-user-new',
              trafficLimit: null,
              deviceLimit: 0,
              internalSquads: [],
              externalSquad: null,
              expiresAt: new Date('2020-01-01T00:00:00.000Z'),
              planSnapshot: {},
            },
          }),
          updateMany: async () => ({ count: 1 }),
          update: async (input: unknown) => { subscriptionUpdates.push(input); },
        },
        subscription: {
          updateMany: async (input: unknown) => { subscriptionUpdates.push(input); },
        },
      } as never,
      {
        deletePanelUser: async (uuid: string) => {
          deletedTargets.push(uuid);
          return { isDeleted: true };
        },
      } as never,
      {} as never,
      { error: () => undefined, info: () => undefined } as never,
    );

    await processor.process({ data: { syncJobId: 'sync-job-delete-old' } } as never);

    assert.deepEqual(deletedTargets, ['rem-user-old']);
    assert.deepEqual(subscriptionUpdates, [{
      where: { id: 'subscription-1', remnawaveId: 'rem-user-old' },
      data: { remnawaveId: null, status: SubscriptionStatus.DELETED },
    }]);
  });

  it('soft-deletes the row (status DELETED, nulls remnawaveId) on successful DELETE', async () => {
    const subscriptionUpdates: unknown[] = [];
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-1',
            action: SyncAction.DELETE,
            status: SyncJobStatus.PENDING,
            attempts: 0,
            subscription: {
              id: 'subscription-1',
              userId: 'user-1',
              remnawaveId: 'rem-user-1',
              trafficLimit: null,
              deviceLimit: 0,
              internalSquads: [],
              externalSquad: null,
              expiresAt: new Date('2020-01-01T00:00:00.000Z'),
              planSnapshot: {},
            },
          }),
          updateMany: async () => ({ count: 1 }),
          update: async () => undefined,
        },
        subscription: {
          updateMany: async (input: unknown) => { subscriptionUpdates.push(input); },
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
          $queryRaw: async () => [{ status: SubscriptionStatus.ACTIVE }],
          subscription: {
            update: async (input: unknown) => { subscriptionUpdates.push(input); },
          },
          profileSyncJob: {
            findMany: async () => [],
            create: async () => ({ id: 'unused-delete-job' }),
          },
        }),
      } as never,
      {
        deletePanelUser: async (uuid: string) => {
          assert.equal(uuid, 'rem-user-1');
          return { isDeleted: true };
        },
      } as never,
      {} as never,
      { error: () => undefined, info: () => undefined } as never,
    );

    await processor.process({ data: { syncJobId: 'sync-job-1' } } as never);

    assert.deepEqual(subscriptionUpdates, [{
      where: { id: 'subscription-1', remnawaveId: 'rem-user-1' },
      data: { remnawaveId: null, status: SubscriptionStatus.DELETED },
    }]);
  });

  it('fails the DELETE job for retry when the panel reports not-deleted', async () => {
    const subscriptionUpdates: unknown[] = [];
    const profileSyncUpdates: unknown[] = [];
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-1',
            action: SyncAction.DELETE,
            status: SyncJobStatus.PENDING,
            attempts: 0,
            subscription: {
              id: 'subscription-1',
              userId: 'user-1',
              remnawaveId: 'rem-user-1',
              trafficLimit: null,
              deviceLimit: 0,
              internalSquads: [],
              externalSquad: null,
              expiresAt: new Date('2020-01-01T00:00:00.000Z'),
              planSnapshot: {},
            },
          }),
          updateMany: async () => ({ count: 1 }),
          update: async (input: unknown) => { profileSyncUpdates.push(input); },
        },
        subscription: {
          update: async (input: unknown) => { subscriptionUpdates.push(input); },
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
          $queryRaw: async () => [{ status: SubscriptionStatus.ACTIVE }],
          subscription: {
            update: async (input: unknown) => { subscriptionUpdates.push(input); },
          },
          profileSyncJob: {
            findMany: async () => [],
            create: async () => ({ id: 'unused-delete-job' }),
          },
        }),
      } as never,
      {
        deletePanelUser: async () => ({ isDeleted: false }),
      } as never,
      {} as never,
      { error: () => undefined, info: () => undefined } as never,
    );

    await assert.rejects(
      () => processor.process({ data: { syncJobId: 'sync-job-1' } } as never),
      /Panel did not confirm deletion/,
    );

    assert.deepEqual(subscriptionUpdates, []);
    assert.deepEqual(profileSyncUpdates, [{
      where: { id: 'sync-job-1' },
      data: {
        status: SyncJobStatus.FAILED,
        lastError: "Panel did not confirm deletion of Remnawave profile 'rem-user-1'",
      },
    }]);
  });

  it('marks missing and already-completed jobs as no-ops', async () => {
    let updates = 0;
    const missingProcessor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => null,
          update: async () => { updates += 1; },
        },
      } as never,
      {} as never,
      {} as never,
      { error: () => undefined, info: () => undefined } as never,
    );
    const completedProcessor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({ id: 'sync-job-1', status: SyncJobStatus.COMPLETED }),
          update: async () => { updates += 1; },
        },
      } as never,
      {} as never,
      {} as never,
      { error: () => undefined, info: () => undefined } as never,
    );

    await missingProcessor.process({ data: { syncJobId: 'missing-job' } } as never);
    await completedProcessor.process({ data: { syncJobId: 'sync-job-1' } } as never);

    assert.equal(updates, 0);
  });
});
