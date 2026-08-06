import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { of, throwError } from 'rxjs';

import { ServiceUnavailableException } from '@nestjs/common';

import {
  Prisma,
  SubscriptionStatus,
  SubscriptionTermStatus,
  SyncAction,
  SyncJobStatus,
  TrafficLimitStrategy,
} from '@prisma/client';

import { PROFILE_SYNC_MAX_ATTEMPTS } from '../src/modules/profile-sync/profile-sync.constants';
import {
  clampPanelUsername,
  PANEL_USERNAME_MAX_LENGTH,
  PANEL_USERNAME_MIN_LENGTH,
  ProfileSyncProcessor,
  SCHEMA_DRIFT_GRACE_MS,
} from '../src/modules/profile-sync/profile-sync.processor';
import {
  RemnawaveApiService,
  RemnawaveProfileNotFoundError,
} from '../src/modules/remnawave/services/remnawave-api.service';

/** Prisma mock for a DELETE job whose handler will throw, at a given attempt. */
function deleteJobPrismaMock(attempts: number, onUpdate: (input: unknown) => void) {
  return {
    profileSyncJob: {
      findUnique: async () => ({
        id: 'sync-job-x',
        action: SyncAction.DELETE,
        status: SyncJobStatus.PENDING,
        attempts,
        supersededAt: null,
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
      update: async (input: unknown) => { onUpdate(input); },
    },
    subscription: { update: async () => undefined },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
      $queryRaw: async () => [{ status: SubscriptionStatus.ACTIVE }],
      subscription: { update: async () => undefined },
      profileSyncJob: { findMany: async () => [], create: async () => ({ id: 'x' }) },
    }),
  };
}

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

    it('serializes UPDATE snapshot, claim, and panel write so an older worker cannot roll back a newer state', async () => {
      let currentTrafficLimit = 1;
      let panelTrafficLimit = 0;
      let releaseOldWrite!: () => void;
      const oldWriteReleased = new Promise<void>((resolve) => { releaseOldWrite = resolve; });
      let signalOldWrite!: () => void;
      const oldWriteStarted = new Promise<void>((resolve) => { signalOldWrite = resolve; });
      let signalNewWrite!: () => void;
      const newWriteStarted = new Promise<void>((resolve) => { signalNewWrite = resolve; });

      let lockTail = Promise.resolve();
      let lockHeld = false;
      const withAggregateLock = async <T>(callback: () => Promise<T>): Promise<T> => {
        const previous = lockTail;
        let release!: () => void;
        lockTail = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        lockHeld = true;
        try {
          return await callback();
        } finally {
          lockHeld = false;
          release();
        }
      };

      const makeJob = (id: string) => ({
        id,
        action: SyncAction.UPDATE,
        status: SyncJobStatus.PENDING,
        attempts: 0,
        supersededAt: null,
        aggregateKey: 'subscription-ordered',
        desiredRevision: null,
        createdAt: id === 'older' ? new Date('2026-01-01T00:00:00Z') : new Date('2026-01-02T00:00:00Z'),
        subscription: {
          id: 'subscription-ordered', userId: 'user-1', remnawaveId: 'rem-user-ordered',
          trafficLimit: currentTrafficLimit, deviceLimit: 1, internalSquads: [], externalSquad: null,
          expiresAt: new Date('2099-01-01T00:00:00Z'), planSnapshot: {},
        },
      });
      const tx = {
        $executeRaw: async () => 1,
        $queryRaw: async () => [{ status: SubscriptionStatus.ACTIVE }],
        profileSyncJob: {
          findUnique: async (input: { where: { id: string } }) => makeJob(input.where.id),
          findMany: async () => [],
          updateMany: async () => ({ count: 1 }),
          create: async () => ({ id: 'unused-delete' }),
        },
        subscriptionEffectiveProjection: { findUnique: async () => null },
        subscriptionTerm: { updateMany: async () => ({ count: 0 }) },
      };
      const prisma = {
        profileSyncJob: {
          findUnique: async (input: { where: { id: string } }) => makeJob(input.where.id),
          findMany: async () => [],
          updateMany: async () => ({ count: 1 }),
          update: async () => undefined,
        },
        $transaction: async (callback: (client: typeof tx) => Promise<unknown>) =>
          withAggregateLock(() => callback(tx)),
      };
      const processor = new ProfileSyncProcessor(
        prisma as never,
        {
          updatePanelUser: async (_uuid: string, input: { trafficLimitBytes: number }) => {
            const limitGb = input.trafficLimitBytes / (1024 ** 3);
            if (limitGb === 1) {
              signalOldWrite();
              await oldWriteReleased;
              panelTrafficLimit = 1;
            } else {
              signalNewWrite();
              panelTrafficLimit = limitGb;
            }
            return {};
          },
        } as never,
        {
          generateProfileName: async () => ({ username: 'rz_ordered', description: 'ordered' }),
          getContactInfo: async () => ({ email: null, telegramId: null }),
        } as never,
        { error: () => undefined, info: () => undefined } as never,
      );

      const older = processor.process({ data: { syncJobId: 'older' } } as never);
      await oldWriteStarted;
      const olderHeldFenceAcrossWrite = lockHeld;
      const producerAndNewer = (async () => {
        await withAggregateLock(async () => { currentTrafficLimit = 2; });
        await processor.process({ data: { syncJobId: 'newer' } } as never);
      })();

      if (olderHeldFenceAcrossWrite) {
        releaseOldWrite();
      } else {
        await newWriteStarted;
        releaseOldWrite();
      }
      await Promise.all([older, producerAndNewer]);

      assert.equal(panelTrafficLimit, 2, 'the panel must finish at the newest aggregate state');
    });

    it('updates existing Remnawave profiles from current profile-sync rows', async () => {
    const profileSyncUpdates: unknown[] = [];
    const remnawaveUpdates: unknown[] = [];
    const termAnchorUpdates: unknown[] = [];
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-1',
            action: SyncAction.UPDATE,
            status: SyncJobStatus.PENDING,
            attempts: 0,
            payload: { propagateStatus: true },
            subscription: {
              id: 'subscription-1',
              userId: 'user-1',
              remnawaveId: 'rem-user-1',
              trafficLimit: 2,
              deviceLimit: 3,
              internalSquads: ['internal-a'],
              externalSquad: 'external-a',
              status: SubscriptionStatus.DISABLED,
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
          subscriptionTerm: {
            updateMany: async (input: unknown) => {
              termAnchorUpdates.push(input);
              return { count: 1 };
            },
          },
          profileSyncJob: {
            findMany: async () => [],
            create: async () => ({ id: 'unused-delete-job' }),
          },
        }),
      } as never,
      {
        updatePanelUser: async (...args: unknown[]) => {
          remnawaveUpdates.push(args);
          return { createdAt: '2025-03-20T09:15:00.000Z' };
        },
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
        status: SubscriptionStatus.DISABLED,
        tag: 'premium',
        expireAt: '2099-01-01T00:00:00.000Z',
        trafficLimitBytes: 2 * 1024 * 1024 * 1024,
        hwidDeviceLimit: 3,
        trafficLimitStrategy: 'MONTH',
        activeInternalSquads: ['internal-a'],
        externalSquadUuid: 'external-a',
      },
    ]]);
    assert.deepStrictEqual(termAnchorUpdates, [{
      where: {
        subscriptionId: 'subscription-1',
        status: { in: [SubscriptionTermStatus.ACTIVE, SubscriptionTermStatus.SCHEDULED] },
        trafficResetStrategy: TrafficLimitStrategy.MONTH_ROLLING,
      },
      data: { resetAnchorAt: new Date('2025-03-20T09:15:00.000Z') },
    }]);
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
    const termAnchorUpdates: unknown[] = [];
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
          subscriptionTerm: {
            updateMany: async (input: unknown) => {
              termAnchorUpdates.push(input);
              return { count: 2 };
            },
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
          return {
            uuid: 'rem-user-created',
            subscriptionUrl: 'https://sub.example/created',
            createdAt: '2026-01-15T12:30:00.000Z',
          };
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
    assert.deepStrictEqual(termAnchorUpdates, [{
      where: {
        subscriptionId: 'subscription-1',
        status: { in: [SubscriptionTermStatus.ACTIVE, SubscriptionTermStatus.SCHEDULED] },
        trafficResetStrategy: TrafficLimitStrategy.MONTH_ROLLING,
      },
      data: { resetAnchorAt: new Date('2026-01-15T12:30:00.000Z') },
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
          updateMany: async (input: unknown) => {
            profileSyncUpdates.push(input);
            return { count: 1 };
          },
          update: async () => assert.fail('failure state must use guarded updateMany'),
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
    const failureUpdates = profileSyncUpdates.filter(
      (input) =>
        (input as { data?: { status?: SyncJobStatus } }).data?.status === SyncJobStatus.FAILED,
    );
    const failureWhere = (failureUpdates[0] as { where: { startedAt?: unknown } }).where;
    assert.ok(failureWhere.startedAt instanceof Date);
    assert.deepEqual(failureWhere, {
      id: 'sync-job-1',
      status: SyncJobStatus.RUNNING,
      supersededAt: null,
      startedAt: failureWhere.startedAt,
    });
    assert.deepEqual((failureUpdates[0] as { data: unknown }).data, {
      status: SyncJobStatus.FAILED,
      lastError: "Panel did not confirm deletion of Remnawave profile 'rem-user-1'",
      recoveryData: { classification: 'TERMINAL' },
    });
  });

  it('does NOT emit a SYSTEM error for a transient Remnawave outage (retryable, non-final attempt)', async () => {
    const errorEvents: unknown[] = [];
    const processor = new ProfileSyncProcessor(
      deleteJobPrismaMock(0, () => undefined) as never,
      { deletePanelUser: async () => { throw new ServiceUnavailableException('Remnawave integration is unavailable'); } } as never,
      {} as never,
      { error: (...a: unknown[]) => { errorEvents.push(a); }, info: () => undefined } as never,
    );
    await assert.rejects(() => processor.process({ data: { syncJobId: 'sync-job-x' } } as never));
    // Transient + not the final attempt → the failure stays in the logs, no operator alert.
    assert.equal(errorEvents.length, 0);
  });

  it('does NOT emit a SYSTEM error for a transient outage even on the FINAL attempt (sweep will recover)', async () => {
    const errorEvents: unknown[] = [];
    const processor = new ProfileSyncProcessor(
      deleteJobPrismaMock(4, () => undefined) as never, // attempt 5 = final
      { deletePanelUser: async () => { throw new ServiceUnavailableException('Remnawave integration is unavailable'); } } as never,
      {} as never,
      { error: (...a: unknown[]) => { errorEvents.push(a); }, info: () => undefined } as never,
    );
    await assert.rejects(() => processor.process({ data: { syncJobId: 'sync-job-x' } } as never));
    assert.equal(errorEvents.length, 0);
  });

  it('emits a single SYSTEM error for a genuine NON-transient failure on the final attempt', async () => {
    const errorEvents: unknown[] = [];
    const processor = new ProfileSyncProcessor(
      deleteJobPrismaMock(4, () => undefined) as never, // attempt 5 = final
      { deletePanelUser: async () => ({ isDeleted: false }) } as never, // → plain Error, non-transient
      {} as never,
      { error: (...a: unknown[]) => { errorEvents.push(a); }, info: () => undefined } as never,
    );
    await assert.rejects(() => processor.process({ data: { syncJobId: 'sync-job-x' } } as never));
    assert.equal(errorEvents.length, 1);
  });

  // ── Schema drift: retryable during a deploy, loud afterwards ──────────────
  //
  // Migrations run in the API container only (docker-entrypoint.sh is role-
  // gated and runs them before `exec`). The worker boots the same image with an
  // already-regenerated Prisma Client, so during the migration window a write
  // names columns the database does not have yet and Prisma raises P2022. The
  // message ("column ... does not exist") matches none of the transient
  // substrings, so classified TERMINAL all PROFILE_SYNC_MAX_ATTEMPTS retries
  // burn inside the same window (~75s of backoff) and the TRANSIENT-only
  // 5-minute recovery sweep never re-drives the row: a paid subscription keeps
  // `remnawaveId = NULL` forever. So drift must be TRANSIENT — but only while a
  // deploy is still plausible.
  //
  // Unconditionally TRANSIENT is the opposite failure. A migration that was
  // never written, or a column renamed without one, produces the identical
  // P2022 forever, and TRANSIENT means: `reportFailure` never reaches its
  // `classification === 'TERMINAL'` branch so no operator is ever paged;
  // payments-checkout requires TERMINAL to surface PROFILE_SYNC_FAILED so a paid
  // subscription sits at PROFILE_PENDING indefinitely; and the sweep re-enqueues
  // it every 5 minutes forever. A deploy window is minutes, drift is forever, so
  // the classification is bounded by the job's age (SCHEMA_DRIFT_GRACE_MS).
  //
  // Both sides of that boundary are pinned below. `attempts` deliberately is NOT
  // the bound: the sweep resets it to 0 on every recovery, so it can never grow
  // past PROFILE_SYNC_MAX_ATTEMPTS however long the drift lasts.

  /**
   * Runs a DELETE job whose panel call throws `error`; reports what was
   * recorded. `jobAgeMs` ages the row's `createdAt` — the anchor the drift
   * grace window is measured from.
   */
  async function classifyDeleteFailure(
    error: unknown,
    options: { attempts?: number; jobAgeMs?: number } = {},
  ): Promise<{ classification: unknown; errorEvents: unknown[] }> {
    const attempts = options.attempts ?? 0;
    const createdAt = new Date(Date.now() - (options.jobAgeMs ?? 0));
    const failureWrites: unknown[] = [];
    const errorEvents: unknown[] = [];
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-drift', action: SyncAction.DELETE, status: SyncJobStatus.PENDING,
            attempts, supersededAt: null, createdAt,
            subscription: {
              id: 'subscription-1', userId: 'user-1', remnawaveId: 'rem-user-1',
              trafficLimit: null, deviceLimit: 0, internalSquads: [], externalSquad: null,
              expiresAt: null, planSnapshot: {},
            },
          }),
          updateMany: async (input: unknown) => {
            if ((input as { data: { status?: SyncJobStatus } }).data.status === SyncJobStatus.FAILED) {
              failureWrites.push(input);
            }
            return { count: 1 };
          },
        },
      } as never,
      { deletePanelUser: async () => { throw error; } } as never,
      {} as never,
      { error: (...a: unknown[]) => { errorEvents.push(a); }, info: () => undefined } as never,
    );

    await assert.rejects(() => processor.process({ data: { syncJobId: 'sync-job-drift' } } as never));
    assert.equal(failureWrites.length, 1);
    return {
      classification: (failureWrites[0] as { data: { recoveryData?: { classification?: unknown } } })
        .data.recoveryData?.classification,
      errorEvents,
    };
  }

  it('classifies a deploy-window P2022 (column missing) as TRANSIENT, not a dead job', async () => {
    // The exact production path: persistProfileLink's select-less write names
    // `remnawave_id`/`config_url` columns the pre-migration database lacks.
    const schemaDrift = new Prisma.PrismaClientKnownRequestError(
      'The column `subscriptions.remnawave_id` does not exist in the current database.',
      { code: 'P2022', clientVersion: '7.9.0', meta: { column: 'subscriptions.remnawave_id' } },
    );
    const failureWrites: unknown[] = [];
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-drift-create', action: SyncAction.CREATE, status: SyncJobStatus.PENDING,
            attempts: 0, supersededAt: null, createdAt: new Date(),
            subscription: {
              id: 'subscription-1', userId: 'user-1', remnawaveId: null,
              trafficLimit: 1, deviceLimit: 1, internalSquads: [], externalSquad: null,
              expiresAt: new Date('2099-01-01T00:00:00.000Z'), planSnapshot: {},
            },
          }),
          updateMany: async (input: unknown) => {
            if ((input as { data: { status?: SyncJobStatus } }).data.status === SyncJobStatus.FAILED) {
              failureWrites.push(input);
            }
            return { count: 1 };
          },
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
          $queryRaw: async () => [{ status: SubscriptionStatus.ACTIVE }],
          subscription: { update: async () => { throw schemaDrift; } },
          profileSyncJob: { findMany: async () => [], create: async () => ({ id: 'unused-delete-job' }) },
        }),
      } as never,
      {
        getPanelUserByUsername: async () => null,
        createPanelUser: async () => ({
          uuid: 'rem-user-drift', subscriptionUrl: 'https://sub.example/drift',
        }),
      } as never,
      {
        generateProfileName: async () => ({ username: 'rz_subscription_1', description: 'drift' }),
        getContactInfo: async () => ({ email: null, telegramId: null }),
      } as never,
      { error: () => undefined, info: () => undefined } as never,
    );

    await assert.rejects(
      () => processor.process({ data: { syncJobId: 'sync-job-drift-create' } } as never),
      /does not exist in the current database/,
    );

    assert.equal(failureWrites.length, 1);
    // TERMINAL here means the 5-minute sweep skips the row forever and the paid
    // subscription never gets a `remnawaveId`, so checkout never reaches READY.
    assert.deepEqual(
      (failureWrites[0] as { data: { recoveryData: unknown } }).data.recoveryData,
      { classification: 'TRANSIENT' },
    );
  });

  it('classifies a P2021 (table missing) inside the deploy window as TRANSIENT', async () => {
    const { classification } = await classifyDeleteFailure(
      new Prisma.PrismaClientKnownRequestError(
        'The table `public.subscription_effective_projections` does not exist in the current database.',
        { code: 'P2021', clientVersion: '7.9.0' },
      ),
    );
    assert.equal(classification, 'TRANSIENT');
  });

  it('classifies a P1001 database-unreachable initialization error as TRANSIENT', async () => {
    // Connectivity codes arrive on `errorCode`, not `code` — a different class.
    const { classification } = await classifyDeleteFailure(
      new Prisma.PrismaClientInitializationError(
        "Can't reach database server at `rezeis-db:5432`",
        '7.9.0',
        'P1001',
      ),
    );
    assert.equal(classification, 'TRANSIENT');
  });

  it('keeps a database outage retryable however long it lasts (the bound is drift-only)', async () => {
    // The grace window exists to time-box "the schema disagrees", not "the
    // database is down". An unreachable database comes back and the job still
    // describes work that has not happened; aging it out would abandon it.
    const { classification, errorEvents } = await classifyDeleteFailure(
      new Prisma.PrismaClientInitializationError(
        "Can't reach database server at `rezeis-db:5432`",
        '7.9.0',
        'P1001',
      ),
      { attempts: 4, jobAgeMs: SCHEMA_DRIFT_GRACE_MS * 10 },
    );
    assert.equal(classification, 'TRANSIENT');
    assert.equal(errorEvents.length, 0);
  });

  it('does NOT page the operator for schema drift inside the deploy window', async () => {
    const { classification, errorEvents } = await classifyDeleteFailure(
      new Prisma.PrismaClientKnownRequestError(
        'The column `subscriptions.remnawave_id` does not exist in the current database.',
        { code: 'P2022', clientVersion: '7.9.0' },
      ),
      { attempts: 4 }, // attempt 5 = final
    );
    assert.equal(classification, 'TRANSIENT');
    assert.equal(errorEvents.length, 0);
  });

  it('flips schema drift to TERMINAL once the deploy window has passed', async () => {
    // This is what stops the 5-minute sweep re-enqueuing the row forever, and
    // what lets payments-checkout surface PROFILE_SYNC_FAILED instead of
    // leaving a paid subscription at PROFILE_PENDING indefinitely.
    const { classification } = await classifyDeleteFailure(
      new Prisma.PrismaClientKnownRequestError(
        'The column `subscriptions.remnawave_id` does not exist in the current database.',
        { code: 'P2022', clientVersion: '7.9.0' },
      ),
      { jobAgeMs: SCHEMA_DRIFT_GRACE_MS + 60_000 },
    );
    assert.equal(classification, 'TERMINAL');
  });

  it('pages the operator for schema drift on the final attempt past the deploy window', async () => {
    // The reachability chain this depends on: the sweep resets a TRANSIENT row
    // to attempts=0 and force re-enqueues with attempts=PROFILE_SYNC_MAX_ATTEMPTS,
    // so BullMQ walks the row back up to the final attempt inside every 5-minute
    // cycle. Once the row's age crosses the grace window, that final attempt is
    // classified TERMINAL and this is the branch it reaches.
    const { classification, errorEvents } = await classifyDeleteFailure(
      new Prisma.PrismaClientKnownRequestError(
        'The column `subscriptions.remnawave_id` does not exist in the current database.',
        { code: 'P2022', clientVersion: '7.9.0' },
      ),
      { attempts: 4, jobAgeMs: SCHEMA_DRIFT_GRACE_MS + 60_000 },
    );
    // Asserted before the classification so this pins the operator-visible
    // outcome itself, not just the mechanism that produces it.
    assert.equal(errorEvents.length, 1);
    assert.equal(classification, 'TERMINAL');
  });

  it('keeps an unrelated Prisma error code TERMINAL (the fix must not widen retries)', async () => {
    const { classification } = await classifyDeleteFailure(
      new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`remnawaveId`)',
        { code: 'P2002', clientVersion: '7.9.0' },
      ),
    );
    assert.equal(classification, 'TERMINAL');
  });

  it('does not let a late stale worker failure overwrite a job that already completed', async () => {
    const failureWrites: unknown[] = [];
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-late-failure', action: SyncAction.DELETE,
            status: SyncJobStatus.PENDING, attempts: 0, supersededAt: null,
            subscription: {
              id: 'subscription-1', userId: 'user-1', remnawaveId: 'rem-user-1',
              trafficLimit: null, deviceLimit: 0, internalSquads: [], externalSquad: null,
              expiresAt: null, planSnapshot: {},
            },
          }),
          updateMany: async (input: unknown) => {
            const data = (input as { data: { status?: SyncJobStatus } }).data;
            if (data.status === SyncJobStatus.FAILED) {
              failureWrites.push(input);
              return { count: 0 }; // another worker already committed COMPLETED
            }
            return { count: 1 };
          },
          update: async () => { throw new Error('failure path must be compare-and-set, never unconditional'); },
        },
      } as never,
      { deletePanelUser: async () => { throw new Error('late stale failure'); } } as never,
      {} as never,
      { error: () => undefined, info: () => undefined } as never,
    );

    await assert.rejects(
      () => processor.process({ data: { syncJobId: 'sync-job-late-failure' } } as never),
      /late stale failure/,
    );
    assert.equal(failureWrites.length, 1);
    const failureWhere = (failureWrites[0] as { where: { startedAt?: unknown } }).where;
    assert.ok(failureWhere.startedAt instanceof Date);
    assert.deepEqual(failureWhere, {
      id: 'sync-job-late-failure',
      status: SyncJobStatus.RUNNING,
      supersededAt: null,
      startedAt: failureWhere.startedAt,
    });
  });

  it('fences terminal completion to the lease acquired by this worker', async () => {
    const updates: unknown[] = [];
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-lease-fence', action: SyncAction.UPDATE, status: SyncJobStatus.PENDING,
            attempts: 0, supersededAt: null, startedAt: new Date('2026-01-01T00:00:00.000Z'),
            subscription: {
              id: 'subscription-1', userId: 'user-1', remnawaveId: 'rem-user-1',
              trafficLimit: 1, deviceLimit: 1, internalSquads: [], externalSquad: null,
              expiresAt: new Date('2099-01-01T00:00:00.000Z'), planSnapshot: {},
            },
          }),
          updateMany: async (input: unknown) => {
            updates.push(input);
            return { count: 1 };
          },
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
          $queryRaw: async () => [{ status: SubscriptionStatus.ACTIVE }],
          profileSyncJob: { findMany: async () => [], create: async () => ({ id: 'unused-delete' }) },
        }),
      } as never,
      { updatePanelUser: async () => undefined } as never,
      {
        generateProfileName: async () => ({ username: 'rz_lease', description: 'lease' }),
        getContactInfo: async () => ({ email: null, telegramId: null }),
      } as never,
      { error: () => undefined, info: () => undefined } as never,
    );

    await processor.process({ data: { syncJobId: 'sync-job-lease-fence' } } as never);

    const claim = updates[0] as { data: { startedAt: Date } };
    const completion = updates[1] as { where: { startedAt?: Date } };
    assert.ok(claim.data.startedAt instanceof Date);
    assert.deepEqual(completion.where.startedAt, claim.data.startedAt);
  });

  it('fences failure recording to the lease acquired by this worker', async () => {
    const updates: unknown[] = [];
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-failure-lease-fence', action: SyncAction.DELETE, status: SyncJobStatus.PENDING,
            attempts: 0, supersededAt: null, startedAt: new Date('2026-01-01T00:00:00.000Z'),
            subscription: {
              id: 'subscription-1', userId: 'user-1', remnawaveId: 'rem-user-1',
              trafficLimit: null, deviceLimit: 0, internalSquads: [], externalSquad: null,
              expiresAt: null, planSnapshot: {},
            },
          }),
          updateMany: async (input: unknown) => {
            updates.push(input);
            return { count: 1 };
          },
        },
      } as never,
      { deletePanelUser: async () => { throw new Error('lease-fenced failure'); } } as never,
      {} as never,
      { error: () => undefined, info: () => undefined } as never,
    );

    await assert.rejects(
      () => processor.process({ data: { syncJobId: 'sync-job-failure-lease-fence' } } as never),
      /lease-fenced failure/,
    );

    const claim = updates[0] as { data: { startedAt: Date } };
    const failure = updates[1] as { where: { startedAt?: Date } };
    assert.ok(claim.data.startedAt instanceof Date);
    assert.deepEqual(failure.where.startedAt, claim.data.startedAt);
  });


  it('re-provisions via CREATE when UPDATE hits a 404 (imported profile missing from the panel)', async () => {
    // Imported subscription: remnawaveId came from a donor dump but the profile
    // no longer exists in the connected panel. UPDATE → 404 must detach the
    // stale id and re-create the profile, not retry forever.
    let remnawaveIdCleared = false;
    let createCalled = false;
    const subscriptionUpdates: unknown[] = [];
    // findUnique returns the still-linked row until we clear the id, then the
    // detached row (remnawaveId: null) so handleCreate takes the create path.
    const makeSubscription = () => ({
      id: 'subscription-imported',
      userId: 'user-1',
      remnawaveId: remnawaveIdCleared ? null : 'rem-stale-uuid',
      trafficLimit: 10,
      deviceLimit: 2,
      internalSquads: ['internal-a'],
      externalSquad: null,
      status: SubscriptionStatus.ACTIVE,
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      planSnapshot: { tag: 'imported', trafficLimitStrategy: 'NO_RESET' },
    });
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-reprovision',
            action: SyncAction.UPDATE,
            status: SyncJobStatus.PENDING,
            attempts: 0,
            supersededAt: null,
            payload: { source: 'ADMIN_MUTATION' },
            subscription: makeSubscription(),
          }),
          updateMany: async () => ({ count: 1 }),
          update: async () => undefined,
        },
        subscription: {
          updateMany: async (input: unknown) => {
            subscriptionUpdates.push(input);
            remnawaveIdCleared = true;
            return { count: 1 };
          },
          update: async (input: unknown) => { subscriptionUpdates.push(input); },
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
          $queryRaw: async () => [{ status: SubscriptionStatus.ACTIVE }],
          subscription: { update: async (input: unknown) => { subscriptionUpdates.push(input); } },
          subscriptionTerm: { updateMany: async () => ({ count: 0 }) },
          profileSyncJob: { findMany: async () => [], create: async () => ({ id: 'unused-delete' }) },
        }),
      } as never,
      {
        updatePanelUser: async () => { throw new RemnawaveProfileNotFoundError('rem-stale-uuid'); },
        getPanelUserByUsername: async () => null,
        createPanelUser: async () => {
          createCalled = true;
          return {
            uuid: 'rem-fresh-uuid',
            subscriptionUrl: 'https://sub.example/fresh',
            createdAt: '2026-02-01T00:00:00.000Z',
          };
        },
      } as never,
      {
        generateProfileName: async () => ({ username: 'rz_subscription_imported', description: 'reprovision' }),
        getContactInfo: async () => ({ email: null, telegramId: null }),
      } as never,
      { error: () => undefined, info: () => undefined, warn: () => undefined } as never,
    );

    await processor.process({ data: { syncJobId: 'sync-job-reprovision' } } as never);

    assert.equal(createCalled, true, 'must re-provision the missing profile via createPanelUser');
    // The stale id was detached (fenced on the old uuid) before CREATE...
    assert.deepStrictEqual(subscriptionUpdates[0], {
      where: { id: 'subscription-imported', remnawaveId: 'rem-stale-uuid' },
      data: { remnawaveId: null, configUrl: null },
    });
    // ...and the fresh profile was linked back.
    assert.deepStrictEqual(subscriptionUpdates[1], {
      where: { id: 'subscription-imported' },
      data: { remnawaveId: 'rem-fresh-uuid', configUrl: 'https://sub.example/fresh' },
    });
  });

  it('does NOT re-provision on a transient panel outage during UPDATE (fails for retry)', async () => {
    // A ServiceUnavailableException (panel down) must NOT be treated as a
    // missing profile — the job fails and BullMQ retries; no CREATE.
    let createCalled = false;
    let idCleared = false;
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-outage',
            action: SyncAction.UPDATE,
            status: SyncJobStatus.PENDING,
            attempts: 0,
            supersededAt: null,
            payload: {},
            subscription: {
              id: 'subscription-1', userId: 'user-1', remnawaveId: 'rem-user-1',
              trafficLimit: 1, deviceLimit: 1, internalSquads: [], externalSquad: null,
              status: SubscriptionStatus.ACTIVE,
              expiresAt: new Date('2099-01-01T00:00:00.000Z'), planSnapshot: {},
            },
          }),
          updateMany: async () => ({ count: 1 }),
          update: async () => undefined,
        },
        subscription: {
          updateMany: async () => { idCleared = true; return { count: 1 }; },
        },
      } as never,
      {
        updatePanelUser: async () => { throw new ServiceUnavailableException('Remnawave integration is unavailable'); },
        getPanelUserByUsername: async () => null,
        createPanelUser: async () => { createCalled = true; return { uuid: 'x' }; },
      } as never,
      {
        generateProfileName: async () => ({ username: 'rz_subscription_1', description: 'x' }),
        getContactInfo: async () => ({ email: null, telegramId: null }),
      } as never,
      { error: () => undefined, info: () => undefined, warn: () => undefined } as never,
    );

    await assert.rejects(
      () => processor.process({ data: { syncJobId: 'sync-job-outage' } } as never),
      /unavailable/,
    );
    assert.equal(createCalled, false, 'transient outage must not trigger re-provision');
    assert.equal(idCleared, false, 'transient outage must not detach the profile id');
  });

  it('provisions via CREATE when an UPDATE job finds the subscription already unlinked (retry after a detached re-provision)', async () => {
    // Reachable when a prior 404 re-provision detached the stale id but its
    // follow-up CREATE failed transiently: the job stays action=UPDATE and
    // retries with remnawaveId already null. It must NOT silently complete
    // (which would strand the ACTIVE subscription with no profile) — it must
    // delegate to CREATE and re-link a fresh/reused profile.
    let createCalled = false;
    let updatePanelCalled = false;
    const subscriptionUpdates: unknown[] = [];
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-unlinked',
            action: SyncAction.UPDATE,
            status: SyncJobStatus.PENDING,
            attempts: 1,
            supersededAt: null,
            payload: { source: 'IMPORT_SYNC' },
            subscription: {
              id: 'subscription-unlinked', userId: 'user-1', remnawaveId: null,
              trafficLimit: 5, deviceLimit: 1, internalSquads: [], externalSquad: null,
              status: SubscriptionStatus.ACTIVE,
              expiresAt: new Date('2099-01-01T00:00:00.000Z'), planSnapshot: {},
            },
          }),
          updateMany: async () => ({ count: 1 }),
          update: async () => undefined,
        },
        subscription: {
          updateMany: async (input: unknown) => { subscriptionUpdates.push(input); return { count: 1 }; },
          update: async (input: unknown) => { subscriptionUpdates.push(input); },
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
          $queryRaw: async () => [{ status: SubscriptionStatus.ACTIVE }],
          subscription: { update: async (input: unknown) => { subscriptionUpdates.push(input); } },
          subscriptionTerm: { updateMany: async () => ({ count: 0 }) },
          profileSyncJob: { findMany: async () => [], create: async () => ({ id: 'unused-delete' }) },
        }),
      } as never,
      {
        updatePanelUser: async () => { updatePanelCalled = true; return { uuid: 'should-not-be-called' }; },
        getPanelUserByUsername: async () => null,
        createPanelUser: async () => {
          createCalled = true;
          return { uuid: 'rem-fresh', subscriptionUrl: 'https://sub/fresh', createdAt: '2026-02-01T00:00:00.000Z' };
        },
      } as never,
      {
        generateProfileName: async () => ({ username: 'rz_subscription_unlinked', description: 'x' }),
        getContactInfo: async () => ({ email: null, telegramId: null }),
      } as never,
      { error: () => undefined, info: () => undefined, warn: () => undefined } as never,
    );

    await processor.process({ data: { syncJobId: 'sync-job-unlinked' } } as never);

    assert.equal(updatePanelCalled, false, 'must not PATCH — there is no linked profile to update');
    assert.equal(createCalled, true, 'must provision the missing profile via createPanelUser');
    // The fresh profile was linked back to the previously-unlinked subscription.
    assert.deepStrictEqual(subscriptionUpdates[0], {
      where: { id: 'subscription-unlinked' },
      data: { remnawaveId: 'rem-fresh', configUrl: 'https://sub/fresh' },
    });
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

  // ══════════════════════════════════════════════════════════════════════════
  //  A malformed request must not become a permanently stuck paying customer
  // ══════════════════════════════════════════════════════════════════════════
  //
  // The amplifier these tests pin: the transport used to collapse EVERY panel
  // failure into `ServiceUnavailableException`; `classifyRecovery` reads that
  // as TRANSIENT; the 5-minute sweep resets every TRANSIENT-failed row to
  // PENDING/attempts=0 forever; and the operator alert in `reportFailure` only
  // fires for `isFinalAttempt && TERMINAL`. So one rejected field produced an
  // unprovisioned subscription that retried until the heat death of the queue
  // with nobody told.
  //
  // Every test below drives the REAL `RemnawaveApiService` over a fake axios
  // transport, so the classification is produced by the production chain
  // (HTTP status → adapter exception → classifyRecovery) rather than by a
  // stubbed error object that merely resembles one.

  interface PanelRequest {
    readonly method: string;
    readonly url: string;
    readonly data?: unknown;
  }

  /** A real adapter whose HTTP layer is driven by `respond`. */
  function realAdapter(
    respond: (request: PanelRequest) => { status: number; data?: unknown },
    captured: PanelRequest[] = [],
  ): RemnawaveApiService {
    return new RemnawaveApiService(
      {
        request: (config: PanelRequest) => {
          captured.push({ method: config.method, url: config.url, data: config.data });
          const outcome = respond(config);
          if (outcome.status >= 200 && outcome.status < 300) {
            return of({ data: outcome.data ?? {} });
          }
          return throwError(() => ({
            isAxiosError: true,
            response: { status: outcome.status, data: outcome.data ?? {} },
            message: `Request failed with status code ${outcome.status}`,
          }));
        },
      } as never,
      { host: 'remnawave', port: 3000, token: 'secret', webhookSecret: null, caddyToken: null, cookie: null },
    );
  }

  interface CreateRunResult {
    readonly failureWrites: unknown[];
    readonly completedWrites: unknown[];
    readonly errorEvents: unknown[];
    readonly requests: PanelRequest[];
    readonly linkWrites: unknown[];
  }

  /**
   * Runs one CREATE job end-to-end against `respond`. `attempts` is the number
   * of attempts ALREADY burnt, so `PROFILE_SYNC_MAX_ATTEMPTS - 1` makes this
   * the final attempt (the only one that may page an operator).
   */
  async function runCreate(options: {
    respond: (request: PanelRequest) => { status: number; data?: unknown };
    attempts?: number;
    username?: string;
    planSnapshot?: unknown;
    expectRejection?: boolean;
  }): Promise<CreateRunResult> {
    const failureWrites: unknown[] = [];
    const completedWrites: unknown[] = [];
    const errorEvents: unknown[] = [];
    const requests: PanelRequest[] = [];
    const linkWrites: unknown[] = [];
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-create',
            action: SyncAction.CREATE,
            status: SyncJobStatus.PENDING,
            attempts: options.attempts ?? 0,
            supersededAt: null,
            createdAt: new Date(),
            payload: {},
            subscription: {
              id: 'subscription-1',
              userId: 'user-1',
              remnawaveId: null,
              trafficLimit: 10,
              deviceLimit: 3,
              internalSquads: [],
              externalSquad: null,
              status: SubscriptionStatus.ACTIVE,
              expiresAt: new Date('2099-01-01T00:00:00.000Z'),
              planSnapshot: options.planSnapshot ?? {},
            },
          }),
          updateMany: async (input: unknown) => {
            const status = (input as { data: { status?: SyncJobStatus } }).data.status;
            if (status === SyncJobStatus.FAILED) failureWrites.push(input);
            if (status === SyncJobStatus.COMPLETED) completedWrites.push(input);
            return { count: 1 };
          },
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
          $queryRaw: async () => [{ status: SubscriptionStatus.ACTIVE }],
          subscription: { update: async (input: unknown) => { linkWrites.push(input); } },
          subscriptionTerm: { updateMany: async () => ({ count: 0 }) },
          profileSyncJob: { findMany: async () => [], create: async () => ({ id: 'unused-delete-job' }) },
        }),
      } as never,
      realAdapter(options.respond, requests),
      {
        generateProfileName: async () => ({
          username: options.username ?? 'rz_login_sub',
          description: 'name: Test\nreiwa_id: user-1',
        }),
        getContactInfo: async () => ({ email: null, telegramId: null }),
      } as never,
      {
        error: (...args: unknown[]) => { errorEvents.push(args); },
        info: () => undefined,
        warn: () => undefined,
      } as never,
    );

    const run = processor.process({ data: { syncJobId: 'sync-job-create' } } as never);
    if (options.expectRejection === false) {
      await run;
    } else {
      await assert.rejects(() => run);
    }
    return { failureWrites, completedWrites, errorEvents, requests, linkWrites };
  }

  function recordedClassification(failureWrites: unknown[]): unknown {
    assert.equal(failureWrites.length, 1);
    return (failureWrites[0] as { data: { recoveryData?: { classification?: unknown } } })
      .data.recoveryData?.classification;
  }

  it('classifies a rejected CREATE body (HTTP 400) as TERMINAL and pages the operator', async () => {
    // TRANSIENT here is the whole defect: the sweep would reset this row to
    // PENDING/attempts=0 every 5 minutes forever, checkout would keep saying
    // PROFILE_PENDING instead of PROFILE_SYNC_FAILED, and no alert would fire.
    const { failureWrites, errorEvents } = await runCreate({
      attempts: PROFILE_SYNC_MAX_ATTEMPTS - 1,
      respond: (request) =>
        request.url.startsWith('/api/users/by-username/')
          ? { status: 404 }
          : { status: 400, data: { message: 'trafficLimitStrategy must be a string' } },
    });

    assert.equal(recordedClassification(failureWrites), 'TERMINAL');
    assert.equal(errorEvents.length, 1, 'a permanent rejection must reach an operator');
  });

  it('keeps a panel restart (HTTP 503) on CREATE TRANSIENT and does not page anyone', async () => {
    // The other direction of the same fix: an outage must still be retried by
    // the sweep, and must not burn an operator alert.
    const { failureWrites, errorEvents } = await runCreate({
      attempts: PROFILE_SYNC_MAX_ATTEMPTS - 1,
      respond: (request) =>
        request.url.startsWith('/api/users/by-username/')
          ? { status: 503 }
          : { status: 503 },
    });

    assert.equal(recordedClassification(failureWrites), 'TRANSIENT');
    assert.equal(errorEvents.length, 0);
  });

  it('classifies a rejection by its TYPE, not by whether its text happens to contain "502"', async () => {
    // `classifyRecovery`'s last resort is a substring scan for
    // /timeout|temporar|econn|429|502|503|504|unavailable/ over the message.
    // A rejection message names the URL, and a Remnawave UUID is hex — so a
    // profile whose id merely STARTS with `502` would make a permanent 400 read
    // as TRANSIENT and drop straight back into the forever-retry, no-alert
    // hole. The `instanceof RemnawaveUpstreamRejectionError` arm is what makes
    // the classification depend on what happened rather than on how it reads.
    const transientLookingUuid = '50231111-4222-4333-8444-555566667777';
    assert.match(transientLookingUuid, /^[0-9a-f-]+$/, 'a plain hex UUID, nothing contrived');

    const failureWrites: unknown[] = [];
    const errorEvents: unknown[] = [];
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-hexy', action: SyncAction.DELETE, status: SyncJobStatus.PENDING,
            attempts: PROFILE_SYNC_MAX_ATTEMPTS - 1, supersededAt: null, createdAt: new Date(), payload: {},
            subscription: {
              id: 'subscription-1', userId: 'user-1', remnawaveId: transientLookingUuid,
              trafficLimit: null, deviceLimit: 0, internalSquads: [], externalSquad: null,
              status: SubscriptionStatus.ACTIVE, expiresAt: null, planSnapshot: {},
            },
          }),
          updateMany: async (input: unknown) => {
            if ((input as { data: { status?: SyncJobStatus } }).data.status === SyncJobStatus.FAILED) {
              failureWrites.push(input);
            }
            return { count: 1 };
          },
        },
      } as never,
      realAdapter(() => ({ status: 400, data: { message: 'uuid must be a valid UUID' } })),
      {} as never,
      {
        error: (...args: unknown[]) => { errorEvents.push(args); },
        info: () => undefined,
        warn: () => undefined,
      } as never,
    );

    await assert.rejects(() => processor.process({ data: { syncJobId: 'sync-job-hexy' } } as never));

    assert.equal(recordedClassification(failureWrites), 'TERMINAL');
    assert.equal(errorEvents.length, 1);
  });

  it('keeps a network-level CREATE failure TRANSIENT', async () => {
    const failureWrites: unknown[] = [];
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-net', action: SyncAction.CREATE, status: SyncJobStatus.PENDING,
            attempts: 0, supersededAt: null, createdAt: new Date(), payload: {},
            subscription: {
              id: 'subscription-1', userId: 'user-1', remnawaveId: null,
              trafficLimit: 1, deviceLimit: 1, internalSquads: [], externalSquad: null,
              status: SubscriptionStatus.ACTIVE,
              expiresAt: new Date('2099-01-01T00:00:00.000Z'), planSnapshot: {},
            },
          }),
          updateMany: async (input: unknown) => {
            if ((input as { data: { status?: SyncJobStatus } }).data.status === SyncJobStatus.FAILED) {
              failureWrites.push(input);
            }
            return { count: 1 };
          },
        },
      } as never,
      new RemnawaveApiService(
        {
          request: () =>
            throwError(() =>
              Object.assign(new Error('connect ECONNREFUSED 10.0.0.4:3000'), { isAxiosError: true }),
            ),
        } as never,
        { host: 'remnawave', port: 3000, token: 'secret', webhookSecret: null, caddyToken: null, cookie: null },
      ),
      {
        generateProfileName: async () => ({ username: 'rz_login_sub', description: 'reiwa_id: user-1' }),
        getContactInfo: async () => ({ email: null, telegramId: null }),
      } as never,
      { error: () => undefined, info: () => undefined, warn: () => undefined } as never,
    );

    await assert.rejects(() => processor.process({ data: { syncJobId: 'sync-job-net' } } as never));
    assert.equal(recordedClassification(failureWrites), 'TRANSIENT');
  });

  // ── Live 400 #1: a 3x-ui import has no `trafficLimitStrategy` ─────────────

  it('provisions a 3x-ui-imported subscription instead of sending trafficLimitStrategy: null', async () => {
    // `ThreeXuiImporterService` writes a plan snapshot with no
    // `trafficLimitStrategy` key and enqueues CREATE immediately;
    // `readOptionalString` turns the missing key into `null`, never
    // `undefined`. `null` is a validation failure on both 2.7.4 and 2.8.0, so
    // every such subscription used to 400 on provisioning.
    const { requests, failureWrites, completedWrites } = await runCreate({
      expectRejection: false,
      planSnapshot: {
        importedFrom: '3xui',
        email: 'imported@example.test',
        subId: 'sub-123',
        trafficResetDays: 0,
      },
      respond: (request) =>
        request.url.startsWith('/api/users/by-username/')
          ? { status: 404 }
          : {
              status: 200,
              data: { response: { uuid: 'rem-created', subscriptionUrl: 'https://sub/x', createdAt: '2026-01-01T00:00:00.000Z' } },
            },
    });

    const createBody = requests.find((r) => r.url === '/api/users')?.data as Record<string, unknown>;
    assert.ok(createBody !== undefined, 'CREATE must reach POST /api/users');
    assert.equal(
      'trafficLimitStrategy' in createBody,
      false,
      'a snapshot with no strategy must omit the field, not send null',
    );
    assert.equal(failureWrites.length, 0);
    assert.equal(completedWrites.length, 1);
  });

  // ── Live 400 #2: the generated username can exceed maxLength 36 ───────────

  it('keeps clampPanelUsername identity for every name that already fits', async () => {
    // This is the load-bearing property: the name is the crash-recovery
    // idempotency key (`getPanelUserByUsername`). Rewriting a legal name would
    // make every already-provisioned profile unfindable.
    for (const name of [
      'rz_a_sub',
      'rz_john_sub',
      'rz_john_sub_12',
      'abc',
      'a'.repeat(PANEL_USERNAME_MAX_LENGTH),
      `rz_${'x'.repeat(29)}_sub`.slice(0, PANEL_USERNAME_MAX_LENGTH),
    ]) {
      assert.equal(clampPanelUsername(name), name, `must not rewrite '${name}'`);
    }
  });

  it('clamps an over-long generated username into the 3–36 window, deterministically and injectively', async () => {
    const longLogin = `rz_${'averyveryverylonglogin'.repeat(2)}_sub`;
    assert.ok(longLogin.length > PANEL_USERNAME_MAX_LENGTH);

    const clamped = clampPanelUsername(longLogin);
    assert.equal(clamped.length, PANEL_USERNAME_MAX_LENGTH);
    assert.ok(clamped.length >= PANEL_USERNAME_MIN_LENGTH);
    assert.match(clamped, /^[A-Za-z0-9_-]+$/, 'panel usernames only allow [A-Za-z0-9_-]');
    assert.equal(clampPanelUsername(longLogin), clamped, 'the key must be stable across runs');

    // Truncation alone is non-injective: two logins sharing a long prefix
    // would collapse onto ONE panel profile and the CREATE path would hand
    // customer B customer A's subscription. The digest keeps them apart.
    const sibling = `${longLogin}2`;
    assert.notEqual(clampPanelUsername(sibling), clamped);
    assert.equal(clampPanelUsername(sibling).slice(0, 20), clamped.slice(0, 20));
  });

  it('looks the panel profile up under the SAME clamped name it creates', async () => {
    const { requests } = await runCreate({
      expectRejection: false,
      username: `rz_${'l'.repeat(40)}_sub`,
      respond: (request) =>
        request.url.startsWith('/api/users/by-username/')
          ? { status: 404 }
          : {
              status: 200,
              data: { response: { uuid: 'rem-created', subscriptionUrl: 'https://sub/x', createdAt: '2026-01-01T00:00:00.000Z' } },
            },
    });

    const lookup = requests.find((r) => r.url.startsWith('/api/users/by-username/'));
    const created = requests.find((r) => r.url === '/api/users');
    assert.ok(lookup !== undefined && created !== undefined);
    const lookedUpName = decodeURIComponent(lookup.url.replace('/api/users/by-username/', ''));
    const createdName = (created.data as Record<string, unknown>)['username'];
    assert.equal(lookedUpName, createdName, 'a lookup under a different name would re-create forever');
    assert.equal(String(createdName).length, PANEL_USERNAME_MAX_LENGTH);
  });

  // ── The collision hazard truncation introduces ────────────────────────────

  it('refuses to link a panel profile whose reiwa_id marker names a different user', async () => {
    const { failureWrites, linkWrites, errorEvents } = await runCreate({
      attempts: PROFILE_SYNC_MAX_ATTEMPTS - 1,
      respond: (request) =>
        request.url.startsWith('/api/users/by-username/')
          ? {
              status: 200,
              data: {
                response: {
                  uuid: 'rem-belongs-to-someone-else',
                  subscriptionUrl: 'https://sub/other',
                  createdAt: '2026-01-01T00:00:00.000Z',
                  description: 'name: Other\nreiwa_id: user-999',
                },
              },
            }
          : { status: 200, data: { response: { uuid: 'unreachable' } } },
    });

    assert.deepEqual(linkWrites, [], 'another customer\'s profile must never be linked');
    assert.equal(recordedClassification(failureWrites), 'TERMINAL');
    assert.equal(errorEvents.length, 1, 'a proven collision must page an operator, not go quiet');
  });

  it('still links a profile that carries this user\'s own marker (crash recovery)', async () => {
    const { linkWrites, failureWrites } = await runCreate({
      expectRejection: false,
      respond: (request) =>
        request.url.startsWith('/api/users/by-username/')
          ? {
              status: 200,
              data: {
                response: {
                  uuid: 'rem-mine',
                  subscriptionUrl: 'https://sub/mine',
                  createdAt: '2026-01-01T00:00:00.000Z',
                  description: 'name: Test\nreiwa_id: user-1',
                },
              },
            }
          : { status: 500 },
    });

    assert.equal(failureWrites.length, 0);
    assert.deepEqual(linkWrites, [
      { where: { id: 'subscription-1' }, data: { remnawaveId: 'rem-mine', configUrl: 'https://sub/mine' } },
    ]);
  });

  it('still links a marker-less profile (imported/legacy) exactly as before', async () => {
    // Indeterminate ownership keeps the previous behaviour on purpose —
    // failing those closed would strand every profile that predates the marker.
    const { linkWrites, failureWrites } = await runCreate({
      expectRejection: false,
      respond: (request) =>
        request.url.startsWith('/api/users/by-username/')
          ? {
              status: 200,
              data: {
                response: {
                  uuid: 'rem-legacy',
                  subscriptionUrl: 'https://sub/legacy',
                  createdAt: '2026-01-01T00:00:00.000Z',
                  description: 'imported from donor panel',
                },
              },
            }
          : { status: 500 },
    });

    assert.equal(failureWrites.length, 0);
    assert.deepEqual(linkWrites, [
      { where: { id: 'subscription-1' }, data: { remnawaveId: 'rem-legacy', configUrl: 'https://sub/legacy' } },
    ]);
  });

  // ── Live 400 #3: PATCH /api/users only accepts ACTIVE | DISABLED ──────────

  /** Runs one UPDATE job with `propagateStatus` against the real adapter. */
  async function runStatusUpdate(localStatus: SubscriptionStatus): Promise<{
    readonly body: Record<string, unknown>;
    readonly failureWrites: unknown[];
  }> {
    const failureWrites: unknown[] = [];
    const requests: PanelRequest[] = [];
    const job = {
      id: 'sync-job-status',
      action: SyncAction.UPDATE,
      status: SyncJobStatus.PENDING,
      attempts: 0,
      supersededAt: null,
      createdAt: new Date(),
      payload: { source: 'ADMIN_MUTATION', propagateStatus: true },
      subscription: {
        id: 'subscription-1',
        userId: 'user-1',
        remnawaveId: 'rem-user-1',
        trafficLimit: 5,
        deviceLimit: 2,
        internalSquads: [],
        externalSquad: null,
        status: localStatus,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        planSnapshot: { trafficLimitStrategy: 'MONTH' },
      },
    };
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => job,
          updateMany: async (input: unknown) => {
            if ((input as { data: { status?: SyncJobStatus } }).data.status === SyncJobStatus.FAILED) {
              failureWrites.push(input);
            }
            return { count: 1 };
          },
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
          $queryRaw: async () => [{ status: SubscriptionStatus.ACTIVE }],
          subscription: { update: async () => undefined },
          subscriptionTerm: { updateMany: async () => ({ count: 0 }) },
          profileSyncJob: { findMany: async () => [], create: async () => ({ id: 'unused' }) },
        }),
      } as never,
      realAdapter(
        () => ({ status: 200, data: { response: { uuid: 'rem-user-1', createdAt: '2026-01-01T00:00:00.000Z' } } }),
        requests,
      ),
      {
        generateProfileName: async () => ({ username: 'rz_login_sub', description: 'reiwa_id: user-1' }),
        getContactInfo: async () => ({ email: null, telegramId: null }),
      } as never,
      { error: () => undefined, info: () => undefined, warn: () => undefined } as never,
    );

    await processor.process({ data: { syncJobId: 'sync-job-status' } } as never);
    const patch = requests.find((r) => r.url === '/api/users');
    assert.ok(patch !== undefined, 'UPDATE must reach PATCH /api/users');
    return { body: patch.data as Record<string, unknown>, failureWrites };
  }

  it('propagates an explicit ACTIVE/DISABLED status unchanged', async () => {
    assert.equal((await runStatusUpdate(SubscriptionStatus.ACTIVE)).body['status'], 'ACTIVE');
    assert.equal((await runStatusUpdate(SubscriptionStatus.DISABLED)).body['status'], 'DISABLED');
  });

  for (const localStatus of [
    SubscriptionStatus.EXPIRED,
    SubscriptionStatus.LIMITED,
    SubscriptionStatus.DELETED,
  ]) {
    it(`sends no status at all when the local row reads ${localStatus}`, async () => {
      // The forwarded value is the DB column at PROCESSING time, not what the
      // operator submitted, and `AutoRenewService` flips rows to EXPIRED every
      // minute — so an admin toggle could reach the panel carrying a value its
      // `enum: ["ACTIVE","DISABLED"]` rejects. These states are DERIVED by
      // Remnawave itself (EXPIRED from the `expireAt` this same PATCH sends),
      // so there is nothing to assert; translating them to DISABLED would be a
      // write renewal never undoes, because renewal does not propagate status.
      const { body, failureWrites } = await runStatusUpdate(localStatus);
      assert.equal('status' in body, false);
      assert.equal(body['expireAt'], '2099-01-01T00:00:00.000Z', 'expiry still travels');
      assert.equal(failureWrites.length, 0);
    });
  }
});
