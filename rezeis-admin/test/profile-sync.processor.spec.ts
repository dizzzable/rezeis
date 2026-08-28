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
import { PanelCommandExecutor } from '../src/modules/remnawave/services/panel-command.executor';
import { AxiosPanelTransport } from '../src/modules/remnawave/services/panel-transport';
import { PanelUsersClient } from '../src/modules/remnawave/services/panel-users.client';

/**
 * A user row as `PanelUsersClient` hands one back.
 *
 * Every field the processor reads is present by DEFAULT, because the panel
 * sends them all: a fixture that omitted `id` or `username` would make a row
 * the processor now refuses look identical to one it accepts, and the tests
 * about that refusal would pass for the wrong reason.
 */
function panelRow(patch: Record<string, unknown> = {}) {
  return {
    id: 4711,
    username: 'rz_panel_user',
    description: null,
    subscriptionUrl: 'https://sub.example/panel',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    trafficLimitBytes: 0,
    hwidDeviceLimit: null,
    ...patch,
  };
}

/** A successful user route answer, envelope included. */
function panelOk(patch: Record<string, unknown> = {}) {
  return { kind: 'ok' as const, drifted: false, data: { response: panelRow(patch) } };
}

/** The panel's own "no such user" — the ONE refusal that means a gone profile. */
function panelMissing() {
  return {
    kind: 'rejected' as const,
    status: 404,
    code: 'A063',
    detail: 'User with specified params not found',
    retryAfterMs: null,
  };
}

/** A refusal the panel actually sent, with whatever status it chose. */
function panelRejected(status: number, code: string | null = null, detail: string | null = null) {
  return { kind: 'rejected' as const, status, code, detail, retryAfterMs: null };
}

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
          remnawaveId: '4711',
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
    subscription: { findMany: async () => [], update: async () => undefined },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
      // The advisory lock the exclusivity guard takes before the row lock.
      $executeRaw: async () => 1,
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
      { updateUser: async () => { upstreamCalled = true; return panelOk(); } } as never,
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
      { updateUser: async () => { upstreamCalled = true; return panelOk(); } } as never,
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
              id: 'subscription-1', userId: 'user-1', remnawaveId: '4711',
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
          // The advisory lock the exclusivity guard takes before the row lock.
          $executeRaw: async () => 1,
          $queryRaw: async () => [{ status: SubscriptionStatus.ACTIVE }],
          // Every successful PATCH now carries the panel's `createdAt`, so the
          // MONTH_ROLLING anchor stamp runs.
          subscriptionTerm: { updateMany: async () => ({ count: 0 }) },
          profileSyncJob: {
            findMany: async () => [],
            create: async () => ({ id: 'unused-delete-job' }),
          },
        }),
      } as never,
      { updateUser: async () => { upstreamCalled = true; return panelOk(); } } as never,
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
          id: 'subscription-ordered', userId: 'user-1', remnawaveId: '4712',
          remnawavePanelId: 4712, remnawavePanelUsername: 'rz_ordered', configUrl: null,
          trafficLimit: currentTrafficLimit, deviceLimit: 1, internalSquads: [], externalSquad: null,
          expiresAt: new Date('2099-01-01T00:00:00Z'), planSnapshot: {},
        },
      });
      const tx = {
        // The advisory lock the exclusivity guard takes before the row lock.
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
          updateUser: async (body: { trafficLimitBytes: number }) => {
            const limitGb = body.trafficLimitBytes / (1024 ** 3);
            if (limitGb === 1) {
              signalOldWrite();
              await oldWriteReleased;
              panelTrafficLimit = 1;
            } else {
              signalNewWrite();
              panelTrafficLimit = limitGb;
            }
            return panelOk({ id: 4712, username: 'rz_ordered' });
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
              remnawaveId: '4711',
              remnawavePanelId: 4711,
              remnawavePanelUsername: 'rz_subscription_1',
              configUrl: null,
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
          // The advisory lock the exclusivity guard takes before the row lock.
          $executeRaw: async () => 1,
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
        updateUser: async (body: unknown) => {
          remnawaveUpdates.push(body);
          return panelOk({
            username: 'rz_subscription_1',
            createdAt: new Date('2025-03-20T09:15:00.000Z'),
          });
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
    // ONE BODY, IDENTITY INCLUDED. `PATCH /api/users` carries the target in
    // the body as the numeric `id` the route declares — there is no path
    // segment and no separate identity argument to get out of step with it.
    assert.deepStrictEqual(remnawaveUpdates, [{
      id: 4711,
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
    }]);
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
              id: 'subscription-deleted', userId: 'user-1', remnawaveId: '4713',
              remnawavePanelId: 4713, remnawavePanelUsername: 'rz_update', configUrl: null,
              trafficLimit: 1, deviceLimit: 1, internalSquads: [], externalSquad: null,
              expiresAt: new Date('2099-01-01T00:00:00.000Z'), planSnapshot: {},
            },
          }),
          updateMany: async () => ({ count: 1 }),
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
          // The advisory lock the exclusivity guard takes before the row lock.
          $executeRaw: async () => 1,
          $queryRaw: async () => [{ status: SubscriptionStatus.DELETED }],
          profileSyncJob: {
            findMany: async () => [],
            create: async () => ({ id: 'delete-job-update' }),
          },
        }),
      } as never,
      { updateUser: async () => panelOk({ id: 4713, username: 'rz_update' }) } as never,
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
              id: 'subscription-deleted', userId: 'user-1', remnawaveId: '4714',
              remnawavePanelId: 4714, remnawavePanelUsername: 'rz_reset', configUrl: null,
              trafficLimit: 1, deviceLimit: 1, internalSquads: [], externalSquad: null,
              expiresAt: new Date('2099-01-01T00:00:00.000Z'), planSnapshot: {},
            },
          }),
          updateMany: async () => ({ count: 1 }),
          update: async () => undefined,
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
          // The advisory lock the exclusivity guard takes before the row lock.
          $executeRaw: async () => 1,
          $queryRaw: async () => [{ status: SubscriptionStatus.DELETED }],
          profileSyncJob: {
            findMany: async () => [],
            create: async () => ({ id: 'delete-job-reset' }),
          },
        }),
      } as never,
      {
        resetTraffic: async () => {
          resetCalled = true;
          return panelOk({ id: 4714 });
        },
      } as never,
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
          // The advisory lock the exclusivity guard takes before the row lock.
          $executeRaw: async () => 1,
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
        getUserByUsername: async () => panelMissing(),
        createUser: async (body: unknown) => {
          remnawaveCreates.push(body);
          return panelOk({
            // The numeric id IS the identity on this panel; the row carries no
            // uuid at all. A fixture without it would let the persistence path
            // look correct while recording nothing.
            id: 4471,
            username: 'rz_subscription_1',
            subscriptionUrl: 'https://sub.example/created',
            createdAt: new Date('2026-01-15T12:30:00.000Z'),
          });
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
        // The panel's own numeric id, in decimal — the spelling every user
        // route answers to and the one `remnawaveId` now stores.
        remnawaveId: '4471',
        remnawavePanelId: 4471,
        remnawavePanelUsername: 'rz_subscription_1',
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
          // The advisory lock the exclusivity guard takes before the row lock.
          $executeRaw: async () => 1,
          $queryRaw: async () => [{ id: 'subscription-deleted', status: SubscriptionStatus.DELETED, remnawaveId: null }],
          subscription: { update: async () => undefined },
          profileSyncJob: {
            findMany: async () => [],
            create: async () => { deleteJobs += 1; return { id: 'delete-job-late-create' }; },
          },
        }),
      } as never,
      {
        getUserByUsername: async () => panelMissing(),
        createUser: async () => {
          upstreamCreates += 1;
          return panelOk({
            id: 4716,
            username: 'rz_subscription_deleted',
            subscriptionUrl: 'https://sub.example/late-create',
          });
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
          // Nobody else is on the profile this retry adopts.
          findFirst: async () => null,
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
          // The advisory lock the exclusivity guard takes before the row lock.
          $executeRaw: async () => 1,
          $queryRaw: async () => [{ status: SubscriptionStatus.ACTIVE }],
          subscription: {
            update: async (input: unknown) => { subscriptionUpdates.push(input); },
          },
          // The adopted panel row carries a `createdAt`, so the MONTH_ROLLING
          // anchor stamp runs on the adopt path too.
          subscriptionTerm: { updateMany: async () => ({ count: 0 }) },
          profileSyncJob: {
            findMany: async () => [],
            create: async () => ({ id: 'unused-delete-job' }),
          },
        }),
      } as never,
      {
        getUserByUsername: async (username: string) => {
          assert.equal(username, 'rz_subscription_1');
          return panelOk({
            id: 902,
            username: 'rz_subscription_1',
            subscriptionUrl: 'https://sub.example/existing',
          });
        },
        createUser: async () => {
          createCalled = true;
          return panelOk();
        },
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
        remnawaveId: '902',
        // Reusing a profile records its identity just as fully as creating one:
        // this is the CREATE-retry path, and a profile linked here without its
        // numeric id would be exactly as unreachable to every later job.
        remnawavePanelId: 902,
        remnawavePanelUsername: 'rz_subscription_1',
        configUrl: 'https://sub.example/existing',
      },
    }]);
  });

  /**
   * A DELETE job whose payload carries the full identity recorded at enqueue
   * time, against a row that may since have moved on. `claimants` is what the
   * live-username lookup finds.
   */
  function deleteWithRecordedName(
    claimants: ReadonlyArray<{ id: string; remnawaveId: string | null }>,
    rowRemnawaveId: string | null,
  ) {
    const deletedTargets: unknown[] = [];
    const queries: unknown[] = [];
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-delete-stale',
            action: SyncAction.DELETE,
            status: SyncJobStatus.PENDING,
            attempts: 0,
            payload: {
              // A DECIMAL, not a uuid: a uuid-shaped target is refused outright
              // by the stale-panel-link guard, so it would make every case here
              // pass without the claimant search ever running.
              targetRemnawaveId: '4471',
              targetRemnawavePanelId: 4471,
              targetRemnawavePanelUsername: 'rz_bob_sub',
            },
            subscription: {
              id: 'subscription-1',
              userId: 'user-1',
              remnawaveId: rowRemnawaveId,
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
          findMany: async (input: unknown) => { queries.push(input); return claimants; },
          updateMany: async () => ({ count: 1 }),
        },
      } as never,
      {
        deleteUser: async (userId: number) => {
          deletedTargets.push(userId);
          return { kind: 'ok', drifted: false, data: undefined };
        },
      } as never,
      {} as never,
      { error: () => undefined, info: () => undefined } as never,
    );
    return { processor, deletedTargets, queries };
  }

  it('skips a DELETE whose subscription went ACTIVE again before the job ran', async () => {
    // The expired-profile sweep enqueues for EXPIRED rows and does NOT mark
    // them DELETED — the processor does that after the panel confirms. So a
    // renewal landing between the sweep and the worker leaves a queued DELETE
    // pointed at a profile its own subscription is now ACTIVE on. Running it
    // takes the service of a customer who has just paid, and retires their
    // subscription on the way out.
    const deletedTargets: unknown[] = [];
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-delete-renewed',
            action: SyncAction.DELETE,
            status: SyncJobStatus.PENDING,
            attempts: 0,
            payload: { targetRemnawaveId: '4711' },
            subscription: {
              id: 'subscription-1',
              userId: 'user-1',
              remnawaveId: '4711',
              status: SubscriptionStatus.ACTIVE,
              trafficLimit: null,
              deviceLimit: 0,
              internalSquads: [],
              externalSquad: null,
              expiresAt: new Date('2099-01-01T00:00:00.000Z'),
              planSnapshot: {},
            },
          }),
          updateMany: async () => ({ count: 1 }),
          update: async () => undefined,
        },
        subscription: {
          findMany: async () => [],
          updateMany: async () => undefined,
        },
      } as never,
      {
        deleteUser: async (userId: number) => {
          deletedTargets.push(userId);
          return { kind: 'ok', drifted: false, data: undefined };
        },
      } as never,
      {} as never,
      { error: () => undefined, info: () => undefined } as never,
    );

    await processor.process({ data: { syncJobId: 'sync-job-delete-renewed' } } as never);
    assert.deepEqual(deletedTargets, [], 'a renewed subscription keeps its panel profile');
  });

  it('refuses a DELETE whose panel username now belongs to a LIVE subscription', async () => {
    // The destructive case, and it needs no exotic state: panel usernames are
    // deterministic, so a profile that was deleted and re-provisioned carries
    // the SAME name, and a DELETE job outlives the row it was written for. Here
    // the row has moved on to a different profile while another live row
    // answers to the recorded name — deleting would take that one.
    const { processor, deletedTargets } = deleteWithRecordedName(
      [{ id: 'subscription-1', remnawaveId: '9999' }],
      '9999',
    );
    await assert.rejects(
      () => processor.process({ data: { syncJobId: 'sync-job-delete-stale' } } as never),
      /Refusing to delete/,
    );
    assert.deepEqual(deletedTargets, [], 'nothing may reach the panel once the name has moved');
  });

  it('deletes normally when the name still belongs to the doomed profile', async () => {
    // The ordinary path, and the one a too-eager guard would break: this job
    // runs BEFORE `status = DELETED` is written, so the doomed subscription is
    // always among the live rows holding that name. It is recognised by still
    // holding the target identity.
    const { processor, deletedTargets, queries } = deleteWithRecordedName(
      [{ id: 'subscription-1', remnawaveId: '4471' }],
      '4471',
    );
    await processor.process({ data: { syncJobId: 'sync-job-delete-stale' } } as never);
    assert.equal(deletedTargets.length, 1);
    // Asked about the recorded name, not about the row's current one.
    // The username is now one arm of an OR — the claimant check also asks the
    // two immutable angles, because a missing username used to mean "nobody
    // else holds this profile" and that is what let a delete destroy a live one.
    const where = (queries[0] as { where: { OR?: ReadonlyArray<Record<string, unknown>> } }).where;
    assert.ok(
      (where.OR ?? []).some((arm) => arm['remnawavePanelUsername'] === 'rz_bob_sub'),
      "the recorded name is no longer among the angles the claimant check asks about",
    );
  });

  it('does not clear a newer profile link when an older DELETE target completes', async () => {
    const subscriptionUpdates: unknown[] = [];
    const deletedTargets: unknown[] = [];
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-delete-old',
            action: SyncAction.DELETE,
            status: SyncJobStatus.PENDING,
            attempts: 0,
            payload: { targetRemnawaveId: '4718' },
            subscription: {
              id: 'subscription-1',
              userId: 'user-1',
              remnawaveId: '4719',
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
          findMany: async () => [],
          // ZERO, faithfully: the row points at profile 4719 and the fence
          // names 4718, so nothing matches — which is the CORRECT outcome here
          // and must not be reported as a divergence.
          updateMany: async (input: unknown) => { subscriptionUpdates.push(input); return { count: 0 }; },
        },
      } as never,
      {
        deleteUser: async (userId: number) => {
          deletedTargets.push(userId);
          return { kind: 'ok', drifted: false, data: undefined };
        },
        resolveUser: async () => {
          throw new Error('a decimal target addresses the panel directly, never through a resolve');
        },
      } as never,
      {} as never,
      { error: () => undefined, info: () => undefined } as never,
    );

    await processor.process({ data: { syncJobId: 'sync-job-delete-old' } } as never);

    // The stale target travels ALONE — no panelId, no panelUsername, so the
    // only thing that can be addressed is the target string itself. Those
    // columns describe whatever profile the row points at NOW, which is a
    // different one; attaching them would let the address fall back onto the
    // CURRENT profile and delete it in place of the stale one.
    assert.deepEqual(deletedTargets, [4718]);
    assert.deepEqual(subscriptionUpdates, [{
      // Two-angled, and with only ONE arm: no numeric id was ever recorded for
      // the stale target, and `remnawavePanelId: null` would match every row
      // that has none.
      where: { id: 'subscription-1', OR: [{ remnawaveId: '4718' }] },
      // The supplementary columns detach with the id they describe: a numeric
      // id left behind would let a later re-provision inherit the DELETED
      // profile's identity and address the corpse.
      data: {
        remnawaveId: null,
        remnawavePanelId: null,
        remnawavePanelUsername: null,
        status: SubscriptionStatus.DELETED,
      },
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
              remnawaveId: '4711',
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
          findMany: async () => [],
          updateMany: async (input: unknown) => { subscriptionUpdates.push(input); return { count: 1 }; },
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
          // The advisory lock the exclusivity guard takes before the row lock.
          $executeRaw: async () => 1,
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
        deleteUser: async (userId: number) => {
          // The stored identity IS the numeric id, so the delete addresses it
          // directly — no resolve, no username, no second chance to land on
          // somebody else's profile.
          assert.equal(userId, 4711);
          return { kind: 'ok', drifted: false, data: undefined };
        },
      } as never,
      {} as never,
      { error: () => undefined, info: () => undefined } as never,
    );

    await processor.process({ data: { syncJobId: 'sync-job-1' } } as never);

    assert.deepEqual(subscriptionUpdates, [{
      // One profile answers to two names across the eras, so the fence asks
      // about both. This fixture row never recorded a numeric id, so the
      // numeric arm is OMITTED rather than compared against null.
      where: { id: 'subscription-1', OR: [{ remnawaveId: '4711' }] },
      // The supplementary columns detach with the id they describe: a numeric
      // id left behind would let a later re-provision inherit the DELETED
      // profile's identity and address the corpse.
      data: {
        remnawaveId: null,
        remnawavePanelId: null,
        remnawavePanelUsername: null,
        status: SubscriptionStatus.DELETED,
      },
    }]);
  });

  it('fails the DELETE job for retry when the panel refuses the deletion', async () => {
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
              remnawaveId: '4711',
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
          findMany: async () => [],
          update: async (input: unknown) => { subscriptionUpdates.push(input); },
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
          // The advisory lock the exclusivity guard takes before the row lock.
          $executeRaw: async () => 1,
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
        // A refusal the PANEL sent, with no `USER_NOT_FOUND` envelope. The
        // `isDeleted: false` flag this test used to feed is gone with 2.x: the
        // contract declares no response body for this route and 3.x answers
        // `204`, so a `2xx` is the whole of the confirmation. What can still
        // fail is the request itself, and that must fail the JOB rather than be
        // read as a deletion that happened.
        deleteUser: async () => panelRejected(409, 'A099', 'user is locked'),
      } as never,
      {} as never,
      { error: () => undefined, info: () => undefined } as never,
    );

    await assert.rejects(
      () => processor.process({ data: { syncJobId: 'sync-job-1' } } as never),
      /HTTP 409/,
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
      lastError:
        "Deleting Remnawave profile '4711' for subscription subscription-1: " +
        'HTTP 409 A099: user is locked',
      // The panel READ the request and refused it. Re-sending identical bytes
      // every five minutes cannot change that, so the row must not be handed
      // to the recovery sweep as though it might heal on its own.
      recoveryData: { classification: 'TERMINAL' },
    });
  });

  it('does NOT emit a SYSTEM error for a transient Remnawave outage (retryable, non-final attempt)', async () => {
    const errorEvents: unknown[] = [];
    const processor = new ProfileSyncProcessor(
      deleteJobPrismaMock(0, () => undefined) as never,
      { deleteUser: async () => ({ kind: 'network', detail: 'ECONNREFUSED' }) } as never,
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
      { deleteUser: async () => ({ kind: 'network', detail: 'ECONNREFUSED' }) } as never,
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
      // The panel answered and refused → a plain Error, non-transient.
      { deleteUser: async () => panelRejected(400, 'A001', 'bad request') } as never,
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
        subscription: { findMany: async () => [] },
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-drift', action: SyncAction.DELETE, status: SyncJobStatus.PENDING,
            attempts, supersededAt: null, createdAt,
            subscription: {
              id: 'subscription-1', userId: 'user-1', remnawaveId: '4711',
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
      { deleteUser: async () => { throw error; } } as never,
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
          // The advisory lock the exclusivity guard takes before the row lock.
          $executeRaw: async () => 1,
          $queryRaw: async () => [{ status: SubscriptionStatus.ACTIVE }],
          subscription: { update: async () => { throw schemaDrift; } },
          profileSyncJob: { findMany: async () => [], create: async () => ({ id: 'unused-delete-job' }) },
        }),
      } as never,
      {
        getUserByUsername: async () => panelMissing(),
        createUser: async () =>
          panelOk({ id: 4722, username: 'rz_subscription_1', subscriptionUrl: 'https://sub.example/drift' }),
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

  it('classifies a deploy-window P2010/42703 (raw query, column missing) as TRANSIENT', async () => {
    // The RAW-query half of the same deploy window, and the half the drift
    // handling could not see. A `$queryRaw` never reaches Prisma's P2022
    // translation — every raw failure arrives as the single code P2010 with the
    // driver's SQLSTATE in `meta.code`. This processor runs raw SQL naming
    // `remnawave_id` / `remnawave_panel_id` (the `FOR UPDATE` lock in
    // `persistProfileLink` and its exclusivity probe), and so does
    // `subscription-deletion.service`. Unclassified, the row was written
    // TERMINAL with no grace window at all and the recovery sweep — which
    // re-drives only TRANSIENT rows — discarded it permanently.
    const { classification, errorEvents } = await classifyDeleteFailure(
      new Prisma.PrismaClientKnownRequestError(
        'Raw query failed. Code: `42703`. Message: `column "remnawave_panel_id" does not exist`',
        {
          code: 'P2010',
          clientVersion: '7.9.0',
          meta: { code: '42703', message: 'column "remnawave_panel_id" does not exist' },
        },
      ),
      { attempts: PROFILE_SYNC_MAX_ATTEMPTS - 1 },
    );
    assert.equal(classification, 'TRANSIENT');
    assert.deepEqual(errorEvents, [], 'a deploy window must not page anybody');
  });

  it('classifies a P2010/42P01 (raw query, table missing) as TRANSIENT inside the window', async () => {
    const { classification } = await classifyDeleteFailure(
      new Prisma.PrismaClientKnownRequestError('Raw query failed. Code: `42P01`.', {
        code: 'P2010',
        clientVersion: '7.9.0',
        meta: { code: '42P01', message: 'relation "subscriptions" does not exist' },
      }),
    );
    assert.equal(classification, 'TRANSIENT');
  });

  it('flips a P2010/42703 to TERMINAL once the deploy window has passed', async () => {
    const { classification } = await classifyDeleteFailure(
      new Prisma.PrismaClientKnownRequestError('Raw query failed. Code: `42703`.', {
        code: 'P2010',
        clientVersion: '7.9.0',
        meta: { code: '42703', message: 'column "remnawave_panel_id" does not exist' },
      }),
      { jobAgeMs: SCHEMA_DRIFT_GRACE_MS + 60_000 },
    );
    assert.equal(classification, 'TERMINAL');
  });

  it('keeps every OTHER raw-query failure TERMINAL (P2010 must not be widened wholesale)', async () => {
    // P2010 is not a schema code — it is "the raw query failed", full stop, and
    // it also carries genuine permanent defects: a constraint violation, a
    // syntax error, a bad cast. Treating the whole code as drift would hand
    // those a 30-minute retry loop and then silence, which is the exact hole
    // the classification exists to close. The SQLSTATE is what separates them.
    for (const sqlState of ['23505', '42601', '22P02']) {
      const { classification } = await classifyDeleteFailure(
        new Prisma.PrismaClientKnownRequestError(`Raw query failed. Code: \`${sqlState}\`.`, {
          code: 'P2010',
          clientVersion: '7.9.0',
          meta: { code: sqlState, message: 'permanent defect' },
        }),
      );
      assert.equal(classification, 'TERMINAL', `SQLSTATE ${sqlState} must stay TERMINAL`);
    }
  });

  it('keeps a P2010 whose SQLSTATE is missing TERMINAL rather than guessing drift', async () => {
    const { classification } = await classifyDeleteFailure(
      new Prisma.PrismaClientKnownRequestError('Raw query failed.', {
        code: 'P2010',
        clientVersion: '7.9.0',
      }),
    );
    assert.equal(classification, 'TERMINAL');
  });

  it('does not let a late stale worker failure overwrite a job that already completed', async () => {
    const failureWrites: unknown[] = [];
    const processor = new ProfileSyncProcessor(
      {
        subscription: { findMany: async () => [] },
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-late-failure', action: SyncAction.DELETE,
            status: SyncJobStatus.PENDING, attempts: 0, supersededAt: null,
            subscription: {
              id: 'subscription-1', userId: 'user-1', remnawaveId: '4711',
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
      { deleteUser: async () => { throw new Error('late stale failure'); } } as never,
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
              id: 'subscription-1', userId: 'user-1', remnawaveId: '4711',
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
          // The advisory lock the exclusivity guard takes before the row lock.
          $executeRaw: async () => 1,
          $queryRaw: async () => [{ status: SubscriptionStatus.ACTIVE }],
          subscriptionTerm: { updateMany: async () => ({ count: 0 }) },
          profileSyncJob: { findMany: async () => [], create: async () => ({ id: 'unused-delete' }) },
        }),
      } as never,
      { updateUser: async () => panelOk() } as never,
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
        subscription: { findMany: async () => [] },
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-failure-lease-fence', action: SyncAction.DELETE, status: SyncJobStatus.PENDING,
            attempts: 0, supersededAt: null, startedAt: new Date('2026-01-01T00:00:00.000Z'),
            subscription: {
              id: 'subscription-1', userId: 'user-1', remnawaveId: '4711',
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
      { deleteUser: async () => { throw new Error('lease-fenced failure'); } } as never,
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
      // A donor dump's identity, with the numeric id the panel reported the
      // last time anything read this row. The PATCH is therefore addressed
      // directly, which is the only kind of route whose 404 may be read as
      // "this profile is gone".
      remnawaveId: remnawaveIdCleared ? null : 'rem-stale-uuid',
      remnawavePanelId: remnawaveIdCleared ? null : 5149,
      remnawavePanelUsername: 'rz_subscription_imported',
      configUrl: null,
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
          // The advisory lock the exclusivity guard takes before the row lock.
          $executeRaw: async () => 1,
          $queryRaw: async () => [{ status: SubscriptionStatus.ACTIVE }],
          subscription: { update: async (input: unknown) => { subscriptionUpdates.push(input); } },
          subscriptionTerm: { updateMany: async () => ({ count: 0 }) },
          profileSyncJob: { findMany: async () => [], create: async () => ({ id: 'unused-delete' }) },
        }),
      } as never,
      {
        resolveUser: async () => {
          assert.fail('the recorded numeric id addresses the PATCH; nothing may re-resolve it');
        },
        // The identity-addressed PATCH is what discovers the absence, and it is
        // the ONLY kind of route whose 404 may be read that way: a resolve is
        // keyed on a mutable attribute, so its 404 is satisfied by an operator
        // renaming a live profile.
        updateUser: async () => panelMissing(),
        getUserByUsername: async () => panelMissing(),
        createUser: async () => {
          createCalled = true;
          return panelOk({
            id: 5150,
            username: 'rz_subscription_imported',
            subscriptionUrl: 'https://sub.example/fresh',
            createdAt: new Date('2026-02-01T00:00:00.000Z'),
          });
        },
      } as never,
      {
        generateProfileName: async () => ({ username: 'rz_subscription_imported', description: 'reprovision' }),
        getContactInfo: async () => ({ email: null, telegramId: null }),
      } as never,
      { error: () => undefined, info: () => undefined, warn: () => undefined } as never,
    );

    await processor.process({ data: { syncJobId: 'sync-job-reprovision' } } as never);

    assert.equal(createCalled, true, 'must re-provision the missing profile via CREATE');
    // The stale id was detached (fenced on the old uuid) before CREATE...
    assert.deepStrictEqual(subscriptionUpdates[0], {
      where: { id: 'subscription-imported', remnawaveId: 'rem-stale-uuid' },
      // The two supplementary columns are detached with the id they describe.
      // A numeric id left behind would let the follow-up CREATE's first write
      // address the profile the panel just said does not exist.
      data: {
        remnawaveId: null,
        remnawavePanelId: null,
        remnawavePanelUsername: null,
        configUrl: null,
      },
    });
    // ...and the fresh profile was linked back, under the identity this panel
    // actually answers to.
    assert.deepStrictEqual(subscriptionUpdates[1], {
      where: { id: 'subscription-imported' },
      data: {
        remnawaveId: '5150',
        remnawavePanelId: 5150,
        remnawavePanelUsername: 'rz_subscription_imported',
        configUrl: 'https://sub.example/fresh',
      },
    });
  });

  it('does NOT re-provision when the RESOLVE cannot find the recorded username', async () => {
    // The one 404 that must never be read as "the profile is gone".
    // `POST /api/users/resolve` is keyed on a MUTABLE attribute, so `A063`
    // there means "no user carries that username right now" — which an
    // operator who renamed a perfectly live profile satisfies. Re-provisioning
    // on it mints a SECOND live profile for one paying customer and detaches
    // the row from the first, and nothing afterwards looks at the original
    // again.
    let createCalled = false;
    let idCleared = false;
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-renamed', action: SyncAction.UPDATE, status: SyncJobStatus.PENDING,
            attempts: 0, supersededAt: null, payload: {},
            subscription: {
              // No numeric id was ever recorded, so the panel username is the
              // only address this row has.
              id: 'subscription-1', userId: 'user-1', remnawaveId: 'rem-donor-uuid',
              remnawavePanelId: null, remnawavePanelUsername: 'rz_subscription_1', configUrl: null,
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
        resolveUser: async () => panelMissing(),
        getUserByUsername: async () => panelMissing(),
        createUser: async () => { createCalled = true; return panelOk(); },
      } as never,
      {
        generateProfileName: async () => ({ username: 'rz_subscription_1', description: 'x' }),
        getContactInfo: async () => ({ email: null, telegramId: null }),
      } as never,
      { error: () => undefined, info: () => undefined, warn: () => undefined } as never,
    );

    await assert.rejects(
      () => processor.process({ data: { syncJobId: 'sync-job-renamed' } } as never),
      (err: Error) =>
        err instanceof ServiceUnavailableException && /renamed profile answers the same way/.test(err.message),
    );
    assert.equal(createCalled, false, 'an unresolvable name must not mint a second profile');
    assert.equal(idCleared, false, 'and must not detach the row from the one it has');
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
              id: 'subscription-1', userId: 'user-1', remnawaveId: '4711',
              remnawavePanelId: 4711, remnawavePanelUsername: 'rz_subscription_1', configUrl: null,
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
        // Nothing was heard back. That is NOT "the profile is gone", and reading
        // it as one would detach a live subscription during a blip.
        updateUser: async () => ({ kind: 'network', detail: 'ECONNREFUSED' }),
        getUserByUsername: async () => panelMissing(),
        createUser: async () => { createCalled = true; return panelOk(); },
      } as never,
      {
        generateProfileName: async () => ({ username: 'rz_subscription_1', description: 'x' }),
        getContactInfo: async () => ({ email: null, telegramId: null }),
      } as never,
      { error: () => undefined, info: () => undefined, warn: () => undefined } as never,
    );

    await assert.rejects(
      () => processor.process({ data: { syncJobId: 'sync-job-outage' } } as never),
      (err: Error) => err instanceof ServiceUnavailableException,
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
          // The advisory lock the exclusivity guard takes before the row lock.
          $executeRaw: async () => 1,
          $queryRaw: async () => [{ status: SubscriptionStatus.ACTIVE }],
          subscription: { update: async (input: unknown) => { subscriptionUpdates.push(input); } },
          subscriptionTerm: { updateMany: async () => ({ count: 0 }) },
          profileSyncJob: { findMany: async () => [], create: async () => ({ id: 'unused-delete' }) },
        }),
      } as never,
      {
        updateUser: async () => { updatePanelCalled = true; return panelOk(); },
        getUserByUsername: async () => panelMissing(),
        createUser: async () => {
          createCalled = true;
          return panelOk({
            id: 7788,
            username: 'rz_subscription_unlinked',
            subscriptionUrl: 'https://sub/fresh',
            createdAt: new Date('2026-02-01T00:00:00.000Z'),
          });
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
    assert.equal(createCalled, true, 'must provision the missing profile via CREATE');
    // The fresh profile was linked back to the previously-unlinked subscription.
    assert.deepStrictEqual(subscriptionUpdates[0], {
      where: { id: 'subscription-unlinked' },
      data: {
        remnawaveId: '7788',
        remnawavePanelId: 7788,
        remnawavePanelUsername: 'rz_subscription_unlinked',
        configUrl: 'https://sub/fresh',
      },
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
  // Every test below drives the REAL client stack — transport, executor and
  // `PanelUsersClient` — over a fake axios, so the classification is produced
  // by the production chain (HTTP status → outcome → `readPanelFailure` →
  // `classifyRecovery`) rather than by a stubbed object that merely resembles
  // one.

  interface PanelRequest {
    readonly method: string;
    readonly url: string;
    readonly data?: unknown;
  }

  /** A real client whose HTTP layer is driven by `respond`. */
  function realClient(
    respond: (request: PanelRequest) => { status: number; data?: unknown },
    captured: PanelRequest[] = [],
  ): PanelUsersClient {
    return new PanelUsersClient(
      new PanelCommandExecutor(
        new AxiosPanelTransport(
          {
            request: (config: PanelRequest) => {
              captured.push({ method: config.method, url: config.url, data: config.data });
              const outcome = respond(config);
              if (outcome.status >= 200 && outcome.status < 300) {
                return of({ data: outcome.data ?? {} });
              }
              return throwError(() => ({
                isAxiosError: true,
                response: { status: outcome.status, headers: {}, data: outcome.data ?? {} },
                message: `Request failed with status code ${outcome.status}`,
              }));
            },
          } as never,
          { host: 'remnawave', port: 3000, token: 'secret' },
        ),
      ),
    );
  }

  /**
   * The panel's own "no such user" answer to a `by-username` lookup.
   *
   * A BARE 404 WOULD NOT DO, and that is the point of spelling the envelope
   * out: `readPanelFailure` reads a 404 with no `A025`/`A063` as a gateway
   * answer and defers, because that is what a reverse proxy returns for every
   * request while it has no healthy backend. Only the panel's own envelope
   * means the profile is absent and the CREATE may mint one.
   */
  const USER_NOT_FOUND = {
    status: 404,
    data: { errorCode: 'A063', message: 'User with specified params not found' },
  } as const;

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
    /** The subscription the adopt path finds already live on the profile. */
    profileHolder?: { id: string; userId: string };
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
        subscription: {
          // The exclusivity lookup on the adopt path: "is another live
          // subscription already on this panel profile?"
          findFirst: async () => options.profileHolder ?? null,
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
          // The advisory lock the exclusivity guard takes before the row lock.
          $executeRaw: async () => 1,
          $queryRaw: async () => [{ status: SubscriptionStatus.ACTIVE }],
          subscription: { update: async (input: unknown) => { linkWrites.push(input); } },
          subscriptionTerm: { updateMany: async () => ({ count: 0 }) },
          profileSyncJob: { findMany: async () => [], create: async () => ({ id: 'unused-delete-job' }) },
        }),
      } as never,
      realClient(options.respond, requests),
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
          ? USER_NOT_FOUND
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
    // A refusal message names the profile, and a numeric panel id is decimal —
    // so a profile whose id merely CONTAINS `502` would make a permanent 400
    // read as TRANSIENT and drop straight back into the forever-retry,
    // no-alert hole. What keeps the classification honest is that a refusal is
    // built as a plain `Error` and an outage as a `ServiceUnavailableException`
    // — the CLASS decides, never the prose.
    const transientLookingId = '50231111';
    assert.match(transientLookingId, /^\d+$/, 'an ordinary panel id, nothing contrived');

    const failureWrites: unknown[] = [];
    const errorEvents: unknown[] = [];
    const processor = new ProfileSyncProcessor(
      {
        subscription: { findMany: async () => [] },
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-hexy', action: SyncAction.DELETE, status: SyncJobStatus.PENDING,
            attempts: PROFILE_SYNC_MAX_ATTEMPTS - 1, supersededAt: null, createdAt: new Date(), payload: {},
            subscription: {
              id: 'subscription-1', userId: 'user-1', remnawaveId: transientLookingId,
              trafficLimit: null, deviceLimit: 0, internalSquads: [], externalSquad: null,
              // DELETED, which is the state a sweep-enqueued DELETE actually
              // runs against: `SubscriptionDeletionService.deleteSubscription`
              // writes `status = DELETED` in the SAME transaction that creates
              // the job, and every producer goes through it. A row still LIVE on
              // its target — ACTIVE, but equally EXPIRED inside its grace
              // window, DISABLED or LIMITED — is the one shape `handleDelete`
              // refuses outright (something moved the row after the job was
              // written), so those would never reach the classification this
              // test is about.
              status: SubscriptionStatus.DELETED, expiresAt: null, planSnapshot: {},
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
      realClient(() => ({ status: 400, data: { message: 'id must be a number' } })),
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
      new PanelUsersClient(
        new PanelCommandExecutor(
          new AxiosPanelTransport(
            {
              request: () =>
                throwError(() =>
                  Object.assign(new Error('connect ECONNREFUSED 10.0.0.4:3000'), {
                    isAxiosError: true,
                  }),
                ),
            } as never,
            { host: 'remnawave', port: 3000, token: 'secret' },
          ),
        ),
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
          ? USER_NOT_FOUND
          : {
              status: 200,
              data: {
                response: {
                  id: 6001,
                  username: 'rz_login_sub',
                  subscriptionUrl: 'https://sub/x',
                  createdAt: '2026-01-01T00:00:00.000Z',
                },
              },
            },
    });

    const createBody = requests.find((r) => r.url === '/api/users/')?.data as Record<string, unknown>;
    assert.ok(createBody !== undefined, 'CREATE must reach POST /api/users/');
    // THE FIELD IS PRESENT AND IT IS THE CONTRACT'S OWN DEFAULT, not `null`.
    // The processor omits it, and the executor sends what the schema PARSED —
    // so the vendor's `.default(NO_RESET)` reaches the wire instead of the
    // `null` that used to 400 every 3x-ui import. What must never appear here
    // is the null itself.
    assert.notEqual(createBody['trafficLimitStrategy'], null);
    assert.equal(createBody['trafficLimitStrategy'], 'NO_RESET');
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
          ? USER_NOT_FOUND
          : {
              status: 200,
              data: {
                response: {
                  id: 6001,
                  username: 'rz_login_sub',
                  subscriptionUrl: 'https://sub/x',
                  createdAt: '2026-01-01T00:00:00.000Z',
                },
              },
            },
    });

    const lookup = requests.find((r) => r.url.startsWith('/api/users/by-username/'));
    const created = requests.find((r) => r.url === '/api/users/');
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
                  id: 6002,
                  username: 'rz_login_sub',
                  subscriptionUrl: 'https://sub/other',
                  createdAt: '2026-01-01T00:00:00.000Z',
                  description: 'name: Other\nreiwa_id: user-999',
                },
              },
            }
          : { status: 200, data: { response: { id: 6003, username: 'unreachable' } } },
    });

    assert.deepEqual(linkWrites, [], 'another customer\'s profile must never be linked');
    assert.equal(recordedClassification(failureWrites), 'TERMINAL');
    assert.equal(errorEvents.length, 1, 'a proven collision must page an operator, not go quiet');
  });

  it('refuses to adopt a profile another live subscription is already on', async () => {
    // The ownership marker says WHOSE profile it is. It says nothing about
    // which of that user's subscriptions holds it, so a user with two
    // subscriptions whose generated names collide would pass ownership and
    // land both rows on one panel profile. From then on the two write each
    // other's limits and expiry through it, and the first delete takes the
    // other's service down. `remnawaveId` has no unique constraint to catch
    // this in the database.
    const { linkWrites, failureWrites } = await runCreate({
      expectRejection: true,
      profileHolder: { id: 'subscription-2', userId: 'user-1' },
      respond: (request) =>
        request.url.startsWith('/api/users/by-username/')
          ? {
              status: 200,
              data: {
                response: {
                  id: 1203,
                  username: 'rz_subscription_1',
                  subscriptionUrl: 'https://sub/taken',
                  createdAt: '2026-01-01T00:00:00.000Z',
                  description: 'name: Test\nreiwa_id: user-1',
                },
              },
            }
          : { status: 500 },
    });

    assert.deepEqual(linkWrites, [], 'the second row must never be written onto the same profile');
    assert.equal(failureWrites.length, 1, 'the job fails so somebody resolves the double-link');
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
                  // The numeric id AND the username: without them the fixture
                  // would prove the link is written but not that the identity
                  // every later job addresses by is recorded with it.
                  id: 1201,
                  username: 'rz_subscription_1',
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
      {
        where: { id: 'subscription-1' },
        data: {
          remnawaveId: '1201',
          remnawavePanelId: 1201,
          remnawavePanelUsername: 'rz_subscription_1',
          configUrl: 'https://sub/mine',
        },
      },
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
                  id: 1202,
                  username: 'rz_subscription_1',
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
      {
        where: { id: 'subscription-1' },
        data: {
          remnawaveId: '1202',
          remnawavePanelId: 1202,
          remnawavePanelUsername: 'rz_subscription_1',
          configUrl: 'https://sub/legacy',
        },
      },
    ]);
  });

  // ── Live 400 #3: PATCH /api/users only accepts ACTIVE | DISABLED ──────────

  /**
   * Runs one UPDATE job with `propagateStatus` against the real adapter.
   *
   * `options` carries the two things a caller may vary beyond the local
   * status: whether the job asked for the status to be propagated at all, and
   * whether the OWNER is blocked. Both default to what every pre-existing
   * case here assumed, so those cases keep asserting what they were written
   * to assert.
   */
  async function runStatusUpdate(
    localStatus: SubscriptionStatus,
    options: {
      readonly isBlocked?: boolean;
      readonly propagateStatus?: boolean;
      /** `USER_UNBLOCK` for the job an unblock queues; anything else otherwise. */
      readonly source?: string;
    } = {},
  ): Promise<{
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
      payload: {
        source: options.source ?? 'ADMIN_MUTATION',
        propagateStatus: options.propagateStatus ?? true,
      },
      subscription: {
        id: 'subscription-1',
        userId: 'user-1',
        user: { isBlocked: options.isBlocked ?? false },
        remnawaveId: '4711',
        remnawavePanelId: 4711,
        remnawavePanelUsername: 'rz_login_sub',
        configUrl: null,
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
          // The advisory lock the exclusivity guard takes before the row lock.
          $executeRaw: async () => 1,
          $queryRaw: async () => [{ status: SubscriptionStatus.ACTIVE }],
          subscription: { update: async () => undefined },
          subscriptionTerm: { updateMany: async () => ({ count: 0 }) },
          profileSyncJob: { findMany: async () => [], create: async () => ({ id: 'unused' }) },
        }),
      } as never,
      realClient(
        () => ({
          status: 200,
          data: {
            response: { id: 4711, username: 'rz_login_sub', createdAt: '2026-01-01T00:00:00.000Z' },
          },
        }),
        requests,
      ),
      {
        generateProfileName: async () => ({ username: 'rz_login_sub', description: 'reiwa_id: user-1' }),
        getContactInfo: async () => ({ email: null, telegramId: null }),
      } as never,
      { error: () => undefined, info: () => undefined, warn: () => undefined } as never,
    );

    await processor.process({ data: { syncJobId: 'sync-job-status' } } as never);
    const patch = requests.find((r) => r.url === '/api/users/');
    assert.ok(patch !== undefined, 'UPDATE must reach PATCH /api/users');
    return { body: patch.data as Record<string, unknown>, failureWrites };
  }

  it('propagates an explicit ACTIVE/DISABLED status unchanged', async () => {
    assert.equal((await runStatusUpdate(SubscriptionStatus.ACTIVE)).body['status'], 'ACTIVE');
    assert.equal((await runStatusUpdate(SubscriptionStatus.DISABLED)).body['status'], 'DISABLED');
  });

  // ── A blocked owner overrides every one of the rules above ──────────────
  //
  // This is the ONLY thing in the product that switches the VPN itself off.
  // The flag, the identity blocklist and the session refusal all govern our
  // own surfaces; a provisioned profile keeps carrying traffic regardless of
  // what the cabinet decides, so a ban that stops here stops at the part the
  // customer cares least about.

  it('forces DISABLED for a blocked owner whose subscription is ACTIVE', async () => {
    const { body } = await runStatusUpdate(SubscriptionStatus.ACTIVE, { isBlocked: true });
    assert.equal(body['status'], 'DISABLED');
  });

  it('forces DISABLED even when the job never asked for a status', async () => {
    // The load-bearing case, and the reason this is derived from the column
    // rather than from the job payload. Renewal deliberately propagates NO
    // status (see `payment-reconciliation.service.ts`), so a banned customer
    // whose card charges successfully would otherwise be handed their VPN
    // back by their own auto-payment.
    const { body } = await runStatusUpdate(SubscriptionStatus.ACTIVE, {
      isBlocked: true,
      propagateStatus: false,
    });
    assert.equal(body['status'], 'DISABLED');
  });

  it('forces DISABLED for a local status that normally propagates nothing', async () => {
    // EXPIRED sends no status at all for an unblocked owner — Remnawave
    // derives it. A blocked owner still gets an explicit DISABLED, because
    // expiry is a state the panel can decide it has left (a renewal moves
    // `expireAt`) and a ban is not.
    const { body } = await runStatusUpdate(SubscriptionStatus.EXPIRED, { isBlocked: true });
    assert.equal(body['status'], 'DISABLED');
  });

  it('leaves an unblocked owner alone — the control for all three above', async () => {
    // Without this, an override that fired for everybody would satisfy every
    // assertion above, and the first customer to renew would be cut off.
    const { body } = await runStatusUpdate(SubscriptionStatus.ACTIVE, {
      isBlocked: false,
      propagateStatus: false,
    });
    assert.equal('status' in body, false);
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
      // The contract PARSES `expireAt` into a `Date` before the request goes
      // out, and axios serialises that back to the same ISO string. Asserted on
      // the instant rather than on the representation.
      assert.equal(
        new Date(body['expireAt'] as string | Date).toISOString(),
        '2099-01-01T00:00:00.000Z',
        'expiry still travels',
      );
      assert.equal(failureWrites.length, 0);
    });
  }

  describe('an unblock undoes the status the block wrote', () => {
    it('restores ACTIVE for a subscription that expired while the customer was blocked', async () => {
      // THE case, and it left a paying customer without a tunnel.
      //
      // The block forces DISABLED whatever the local status says. If the
      // subscription then expires before an operator clears the account,
      // `toPanelStatus(EXPIRED)` is `null` — correct as a default, because
      // mapping EXPIRED onto DISABLED would be a write nothing undoes — and null
      // OMITS the field. So the unblock pushed every other column and left the
      // profile disabled, and renewal deliberately propagates no status of its
      // own, so nothing ever asserted it again.
      //
      // ACTIVE is the restoration, not a guess: Remnawave derives expiry from
      // `expireAt`, which this same PATCH carries. An expired subscription is an
      // ACTIVE profile with a past `expireAt` — exactly what it was before the
      // block wrote over it.
      const { body } = await runStatusUpdate(SubscriptionStatus.EXPIRED, {
        isBlocked: false,
        source: 'USER_UNBLOCK',
      });

      assert.equal(body.status, 'ACTIVE');
    });

    it('leaves a locally DISABLED subscription disabled', async () => {
      // The restoration must not override a status the operator meant. DISABLED
      // maps cleanly, so the unblock asserts it rather than reaching for ACTIVE.
      const { body } = await runStatusUpdate(SubscriptionStatus.DISABLED, {
        isBlocked: false,
        source: 'USER_UNBLOCK',
      });

      assert.equal(body.status, 'DISABLED');
    });

    it('still omits the status for an expired subscription on an ordinary sync', async () => {
      // The narrow scope of the change: only the job an unblock queues restores.
      // Every other caller keeps the behaviour the comment above `toPanelStatus`
      // argues for.
      const { body } = await runStatusUpdate(SubscriptionStatus.EXPIRED, {
        isBlocked: false,
        source: 'ADMIN_MUTATION',
      });

      assert.equal('status' in body, false);
    });

    it('keeps a blocked owner DISABLED even on an unblock-shaped job', async () => {
      // The flag is read at execution time and outranks everything, so a stale
      // unblock job that runs after a re-block cannot re-enable the profile.
      const { body } = await runStatusUpdate(SubscriptionStatus.EXPIRED, {
        isBlocked: true,
        source: 'USER_UNBLOCK',
      });

      assert.equal(body.status, 'DISABLED');
    });
  });

});

describe('ProfileSyncProcessor — recording the panel identity of rows that already exist', () => {
  /**
   * The two supplementary columns are written by exactly two other places, and
   * BOTH refuse unless `remnawaveId` is null — they provision, they do not
   * update. So without a back-fill on an ordinary read, every subscription that
   * already existed keeps them NULL for its whole life, and on the day the
   * panel is upgraded to 3.x it becomes unaddressable: DELETE jobs retry
   * forever, the expiry sweep defers forever, and deleting a user leaves the
   * panel profile running. These pin the read that fills them.
   */
  function build(row: Record<string, unknown>, panelUser: Record<string, unknown>) {
    const subscriptionWrites: unknown[] = [];
    const subscription = {
      id: 'subscription-1',
      userId: 'user-1',
      remnawaveId: '4711',
      remnawavePanelId: null,
      remnawavePanelUsername: null,
      configUrl: null,
      trafficLimit: 2,
      deviceLimit: 3,
      internalSquads: [],
      externalSquad: null,
      status: SubscriptionStatus.ACTIVE,
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      planSnapshot: {},
      ...row,
    };
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-1',
            action: SyncAction.UPDATE,
            status: SyncJobStatus.PENDING,
            attempts: 0,
            payload: {},
            subscription,
          }),
          updateMany: async () => ({ count: 1 }),
          update: async () => undefined,
        },
        subscription: {
          updateMany: async (input: unknown) => {
            subscriptionWrites.push(input);
            return { count: 1 };
          },
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
          // The advisory lock the exclusivity guard takes before the row lock.
          $executeRaw: async () => 1,
          $queryRaw: async () => [{ status: SubscriptionStatus.ACTIVE }],
          subscriptionTerm: { updateMany: async () => ({ count: 1 }) },
          profileSyncJob: { findMany: async () => [], create: async () => ({ id: 'x' }) },
        }),
      } as never,
      { updateUser: async () => ({ kind: 'ok', drifted: false, data: { response: panelUser } }) } as never,
      {
        generateProfileName: async () => ({ username: 'rz_bob_1', description: 'd' }),
        getContactInfo: async () => ({ email: null, telegramId: null }),
      } as never,
      { error: () => undefined, info: () => undefined, warn: () => undefined } as never,
    );
    return { processor, subscriptionWrites };
  }

  it('records the numeric id and the panel username from an ordinary UPDATE', async () => {
    const { processor, subscriptionWrites } = build(
      {},
      { id: 4471, username: 'rz_bob_1', createdAt: null },
    );

    await processor.process({ data: { syncJobId: 'sync-job-1' } } as never);

    assert.deepStrictEqual(subscriptionWrites, [{
      // Fenced on the id we addressed by: a re-provision that landed while this
      // job ran must not have the PREVIOUS profile's identity written over it.
      where: { id: 'subscription-1', remnawaveId: '4711' },
      data: { remnawavePanelId: 4471, remnawavePanelUsername: 'rz_bob_1' },
    }]);
  });

  it('writes nothing when both columns are already recorded', async () => {
    // Otherwise this would be an extra UPDATE on every sync job forever.
    const { processor, subscriptionWrites } = build(
      { remnawavePanelId: 4471, remnawavePanelUsername: 'rz_bob_1' },
      { id: 4471, username: 'rz_bob_1', createdAt: null },
    );

    await processor.process({ data: { syncJobId: 'sync-job-1' } } as never);

    assert.deepStrictEqual(subscriptionWrites, []);
  });

  it('fills only the column that is missing', async () => {
    const { processor, subscriptionWrites } = build(
      { remnawavePanelId: 4471 },
      { id: 4471, username: 'rz_bob_1', createdAt: null },
    );

    await processor.process({ data: { syncJobId: 'sync-job-1' } } as never);

    assert.deepStrictEqual(
      (subscriptionWrites[0] as { data: unknown }).data,
      { remnawavePanelUsername: 'rz_bob_1' },
    );
  });

  it('does not invent a username from a panel row that carries none', async () => {
    // A drifted body is handed back RAW, so `username` can arrive empty — and
    // an empty username resolves to "which user is called nothing?".
    const { processor, subscriptionWrites } = build(
      {},
      { id: 4471, username: '', createdAt: null },
    );

    await processor.process({ data: { syncJobId: 'sync-job-1' } } as never);

    assert.deepStrictEqual(
      (subscriptionWrites[0] as { data: unknown }).data,
      { remnawavePanelId: 4471 },
    );
  });
});

/**
 * Adversarial pass over the live-state safeguards: every case here destroys a
 * paying customer's panel profile (and usually retires their subscription) on
 * the build these tests were written against.
 */
describe('ProfileSyncProcessor — live state must survive the safeguards', () => {
  /** The panel-profile row a CREATE finds when it looks the name up. */
  interface AdoptablePanelUser {
    readonly id: number;
    readonly username: string;
    readonly description: string | null;
    readonly subscriptionUrl: string;
    readonly createdAt: string | null;
  }

  /**
   * A subscription row as the database holds it, matched against a Prisma
   * `where` for real instead of returned unconditionally — otherwise the test
   * proves only that SOME query was issued, not that the query asks the right
   * question.
   */
  interface StoredRow {
    readonly id: string;
    readonly userId: string;
    readonly status: SubscriptionStatus;
    readonly remnawaveId: string | null;
    readonly remnawavePanelId: number | null;
    readonly remnawavePanelUsername: string | null;
  }

  function matchesWhere(row: StoredRow, where: Record<string, unknown>): boolean {
    for (const [key, condition] of Object.entries(where)) {
      if (key === 'OR') {
        const arms = condition as Array<Record<string, unknown>>;
        if (!arms.some((arm) => matchesWhere(row, arm))) return false;
        continue;
      }
      const actual = (row as unknown as Record<string, unknown>)[key];
      if (condition !== null && typeof condition === 'object') {
        const spec = condition as { not?: unknown };
        if ('not' in spec) {
          if (spec.not === null ? actual === null : actual === spec.not) return false;
          continue;
        }
        return false;
      }
      if (actual !== condition) return false;
    }
    return true;
  }

  function createProcessor(options: {
    readonly subscription: Partial<StoredRow>;
    readonly existingPanelUser: AdoptablePanelUser | null;
    readonly otherRows?: readonly StoredRow[];
    readonly lockedStatus?: SubscriptionStatus;
    readonly conflictOnProbe?: string;
  }) {
    const deleteJobPayloads: unknown[] = [];
    const linkWrites: unknown[] = [];
    let creates = 0;
    const row: StoredRow = {
      id: 'subscription-1',
      userId: 'user-1',
      status: SubscriptionStatus.ACTIVE,
      remnawaveId: null,
      remnawavePanelId: null,
      remnawavePanelUsername: null,
      ...options.subscription,
    };
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-create',
            action: SyncAction.CREATE,
            status: SyncJobStatus.PENDING,
            attempts: 0,
            supersededAt: null,
            createdAt: new Date(),
            payload: {},
            subscription: {
              ...row,
              trafficLimit: 10,
              deviceLimit: 3,
              internalSquads: [],
              externalSquad: null,
              expiresAt: new Date('2099-01-01T00:00:00.000Z'),
              planSnapshot: {},
            },
          }),
          updateMany: async () => ({ count: 1 }),
          update: async () => undefined,
        },
        subscription: {
          findFirst: async (input: unknown) => {
            const where = (input as { where: Record<string, unknown> }).where;
            return (
              (options.otherRows ?? []).find((candidate) => matchesWhere(candidate, where)) ?? null
            );
          },
          update: async () => undefined,
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
          // The advisory lock the exclusivity guard takes before the row lock.
          $executeRaw: async () => 1,
          $queryRaw: async (query: { readonly strings?: readonly string[] }) => {
            // Discriminated by WHAT THE STATEMENT ASKS FOR, not by how many ran
            // before it. The previous version counted calls — "1 = advisory
            // lock, 2 = status read, 3 = conflict probe" — so moving the
            // advisory lock to `$executeRaw` (it returns `void`, which Prisma's
            // query path cannot deserialize) shifted the probe from third to
            // second, and the fake answered a status row to a conflict probe.
            // The test went green while asserting nothing. Content matching
            // cannot be knocked out of step by reordering.
            const text = (query?.strings ?? []).join('');
            if (text.includes('FOR UPDATE')) {
              return [{ status: options.lockedStatus ?? row.status }];
            }
            // The exclusivity probe. No rows = nobody else holds this identity.
            return options.conflictOnProbe === undefined
              ? []
              : [{ conflictId: options.conflictOnProbe }];
          },
          subscription: {
            update: async (input: unknown) => {
              linkWrites.push(input);
            },
          },
          subscriptionTerm: { updateMany: async () => ({ count: 0 }) },
          profileSyncJob: {
            findMany: async () => [],
            create: async (input: unknown) => {
              deleteJobPayloads.push((input as { data: { payload: unknown } }).data.payload);
              return { id: 'compensating-delete-job' };
            },
          },
        }),
      } as never,
      {
        getUserByUsername: async () =>
          options.existingPanelUser === null
            ? {
                kind: 'rejected',
                status: 404,
                code: 'A063',
                detail: 'User with specified params not found',
                retryAfterMs: null,
              }
            : { kind: 'ok', drifted: false, data: { response: options.existingPanelUser } },
        createUser: async () => {
          creates += 1;
          return {
            kind: 'ok',
            drifted: false,
            data: {
              response: {
                id: 9001,
                username: 'rz_john_sub',
                subscriptionUrl: 'https://sub.example/fresh',
                createdAt: new Date('2026-01-15T12:30:00.000Z'),
              },
            },
          };
        },
      } as never,
      {
        generateProfileName: async () => ({
          username: 'rz_john_sub',
          description: 'name: John\nreiwa_id: user-1',
        }),
        getContactInfo: async () => ({ email: null, telegramId: null }),
      } as never,
      { error: () => undefined, info: () => undefined, warn: () => undefined } as never,
      { enqueue: async () => undefined } as never,
    );
    return {
      run: () => processor.process({ data: { syncJobId: 'sync-job-create' } } as never),
      deleteJobPayloads,
      linkWrites,
      panelCreates: () => creates,
    };
  }

  for (const liveStatus of [
    SubscriptionStatus.EXPIRED,
    SubscriptionStatus.DISABLED,
    SubscriptionStatus.LIMITED,
  ]) {
    it(`does NOT schedule a compensating DELETE for a ${liveStatus} subscription it just provisioned`, async () => {
      // The compensating DELETE exists for one thing: a CREATE that finished
      // after its subscription was DELETED. Firing it for every status that is
      // merely not ACTIVE covers three LIVE ones. EXPIRED inside the grace
      // window is renewable and still shown, DISABLED is a reversible admin
      // pause, LIMITED is derived from the traffic counter — and a CREATE
      // legitimately runs in each (the importer and the bulk plan assignment
      // enqueue one regardless of status, `handleUpdate` re-provisions through
      // CREATE after a genuine 404, and `AutoRenewService` walks rows into
      // EXPIRED every minute). The job then deleted the profile that had just
      // been minted AND wrote `status = DELETED`, which no renewal path undoes:
      // the customer's subscription is gone, mid-grace or mid-pause.
      const created = createProcessor({
        subscription: { status: liveStatus },
        existingPanelUser: null,
        lockedStatus: liveStatus,
      });

      await created.run();

      assert.equal(created.panelCreates(), 1, 'the profile is still provisioned');
      assert.deepEqual(
        created.deleteJobPayloads,
        [],
        `a ${liveStatus} subscription must keep the profile it was just given`,
      );
    });
  }

  it('still schedules the compensating DELETE when the row really was retired', async () => {
    const created = createProcessor({
      subscription: { status: SubscriptionStatus.ACTIVE },
      existingPanelUser: null,
      lockedStatus: SubscriptionStatus.DELETED,
    });

    await created.run();

    assert.equal(created.deleteJobPayloads.length, 1);
    assert.deepEqual(created.deleteJobPayloads[0], {
      source: 'CREATE_COMPLETED_AFTER_DELETE',
      targetRemnawaveId: '9001',
      targetRemnawavePanelId: 9001,
      targetRemnawavePanelUsername: 'rz_john_sub',
    });
  });

  it('refuses to adopt a profile whose live holder recorded it under the OTHER era identity', async () => {
    // The 2.7.4 + 3.2.1 single-build case, and the one that makes the
    // exclusivity check inert for the whole pre-upgrade population.
    // `parsePanelUserRow` keys a 3.x row by its numeric id, because a 3.x row
    // has no uuid to give — while every subscription provisioned or imported
    // before the upgrade still stores the 2.x uuid in `remnawaveId`. Comparing
    // only that column compares a decimal against a uuid, matches nothing, and
    // waves the adoption through: two rows land on one panel profile, overwrite
    // each other's limits and expiry, and the first DELETE takes the other's
    // service.
    const created = createProcessor({
      subscription: { id: 'subscription-1', userId: 'user-1' },
      existingPanelUser: {
        id: 4471,
        username: 'rz_john_sub',
        description: 'name: John\nreiwa_id: user-1',
        subscriptionUrl: 'https://sub.example/adopted',
        createdAt: null,
      },
      otherRows: [
        {
          id: 'subscription-paying',
          userId: 'user-1',
          status: SubscriptionStatus.ACTIVE,
          // Provisioned before the operator upgraded — the panel's own
          // migration dropped this uuid, so the row can only be recognised by
          // the two supplementary columns beside it.
          remnawaveId: 'd7a1f0c2-9b3e-4d5a-8f61-0c2b9e3d5a8f',
          remnawavePanelId: 4471,
          remnawavePanelUsername: 'rz_john_sub',
        },
      ],
    });

    await assert.rejects(created.run(), /already\s+live on it/);
    assert.deepEqual(created.linkWrites, [], 'nothing may be linked once a live row holds it');
  });

  it('refuses the link when a concurrent CREATE won the race during the panel round-trip', async () => {
    // The exclusivity check reads before the panel call and writes after it, so
    // two CREATE jobs that resolve to the same profile both read "free" and
    // both write the link. The re-check inside the transaction — under the
    // advisory lock that serialises writers of this identity — is what turns a
    // silent double-link into a loud, retryable refusal.
    const created = createProcessor({
      subscription: {},
      existingPanelUser: null,
      conflictOnProbe: 'subscription-winner',
    });

    await assert.rejects(created.run(), /subscription-winner was linked to it first/);
    assert.deepEqual(created.linkWrites, [], 'the loser must not overwrite the winner');
  });

  /** A DELETE job carrying the identity recorded at enqueue time. */
  function deleteProcessor(options: {
    readonly rowStatus: SubscriptionStatus;
    readonly rowRemnawaveId: string | null;
    readonly claimants: ReadonlyArray<{ id: string; remnawaveId: string | null }>;
  }) {
    const deletedTargets: unknown[] = [];
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-delete',
            action: SyncAction.DELETE,
            status: SyncJobStatus.PENDING,
            attempts: 0,
            supersededAt: null,
            createdAt: new Date(),
            payload: {
              targetRemnawaveId: '4471',
              targetRemnawavePanelId: 4471,
              targetRemnawavePanelUsername: 'rz_john_sub',
            },
            subscription: {
              id: 'subscription-1',
              userId: 'user-1',
              status: options.rowStatus,
              remnawaveId: options.rowRemnawaveId,
              remnawavePanelId: 4471,
              remnawavePanelUsername: 'rz_john_sub',
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
          findMany: async () => options.claimants,
          updateMany: async () => ({ count: 1 }),
        },
      } as never,
      {
        deleteUser: async (userId: number) => {
          deletedTargets.push(userId);
          return { kind: 'ok', drifted: false, data: undefined };
        },
      } as never,
      {} as never,
      { error: () => undefined, info: () => undefined, warn: () => undefined } as never,
    );
    return {
      run: () => processor.process({ data: { syncJobId: 'sync-job-delete' } } as never),
      deletedTargets,
    };
  }

  for (const liveStatus of [
    SubscriptionStatus.EXPIRED,
    SubscriptionStatus.DISABLED,
    SubscriptionStatus.LIMITED,
  ]) {
    it(`skips a DELETE whose subscription is ${liveStatus} on the very profile it targets`, async () => {
      // Every producer of a DELETE job writes `status = DELETED` in the same
      // transaction that creates it, so a row that is NOT retired and still
      // holds the target has moved since — an admin extension, a renewal, a
      // self-heal from the panel's own expiry. Naming only ACTIVE left three
      // doors into the same loss: the panel profile is destroyed and the row is
      // stamped DELETED, which nothing undoes.
      const deletion = deleteProcessor({
        rowStatus: liveStatus,
        rowRemnawaveId: '4471',
        claimants: [],
      });

      await deletion.run();

      assert.deepEqual(deletion.deletedTargets, [], `a ${liveStatus} row keeps its panel profile`);
    });
  }

  it('refuses a DELETE when a SECOND live subscription sits on the very same profile', async () => {
    // `remnawaveId` carries no unique constraint, so "whoever holds the target
    // must be the doomed row" is an assumption, not a fact — and the CREATE
    // path's refusal is exactly what has to hold it up. Once a second row has
    // adopted the same profile, excusing every holder of the target excused the
    // ADOPTER: the panel profile a live, often just-paid subscription is
    // sitting on was deleted, and its row was not even repaired afterwards —
    // the closing write fences on the doomed row's id, so the survivor is left
    // pointing at a profile that no longer exists.
    const deletion = deleteProcessor({
      rowStatus: SubscriptionStatus.DELETED,
      rowRemnawaveId: '4471',
      claimants: [
        { id: 'subscription-1', remnawaveId: '4471' },
        { id: 'subscription-adopter', remnawaveId: '4471' },
      ],
    });

    await assert.rejects(deletion.run(), /Refusing to delete/);
    assert.deepEqual(deletion.deletedTargets, [], 'nothing may reach the panel');
  });

  it('still deletes when the doomed row is the only one holding the target', async () => {
    const deletion = deleteProcessor({
      rowStatus: SubscriptionStatus.DELETED,
      rowRemnawaveId: '4471',
      claimants: [{ id: 'subscription-1', remnawaveId: '4471' }],
    });

    await deletion.run();

    assert.deepEqual(deletion.deletedTargets, [4471]);
  });
});

/**
 * A failure raised BEFORE the lease is taken. The whole point is that it must
 * be classified and recorded exactly like a post-claim one.
 */
describe('ProfileSyncProcessor — a failure before the claim is still a failure', () => {
  function runPreClaimFailure(options: {
    readonly error: unknown;
    readonly attempts?: number;
    readonly jobAgeMs?: number;
    readonly anchorMissing?: boolean;
  }) {
    const writes: Array<{ where: unknown; data: Record<string, unknown> }> = [];
    const errorEvents: unknown[] = [];
    let lookups = 0;
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async (input: unknown) => {
            lookups += 1;
            // The first read is `loadSyncJob` — the one that names the columns
            // migration 20260810120000 adds, and the one that blows up. The
            // second is the recovery re-read, which deliberately projects only
            // columns that predate every migration in flight.
            if (lookups === 1) throw options.error;
            assert.deepEqual((input as { select: unknown }).select, {
              createdAt: true,
              attempts: true,
              action: true,
              subscriptionId: true,
            });
            if (options.anchorMissing === true) return null;
            return {
              createdAt: new Date(Date.now() - (options.jobAgeMs ?? 0)),
              attempts: options.attempts ?? 0,
              action: SyncAction.CREATE,
              subscriptionId: 'subscription-1',
            };
          },
          updateMany: async (input: unknown) => {
            writes.push(input as { where: unknown; data: Record<string, unknown> });
            return { count: 1 };
          },
        },
      } as never,
      {} as never,
      {} as never,
      {
        error: (...args: unknown[]) => { errorEvents.push(args); },
        info: () => undefined,
        warn: () => undefined,
      } as never,
    );
    return {
      run: () => processor.process({ data: { syncJobId: 'sync-job-drift' } } as never),
      writes,
      errorEvents,
    };
  }

  const schemaDrift = (): unknown =>
    new Prisma.PrismaClientKnownRequestError(
      'The column `subscriptions.remnawave_panel_id` does not exist in the current database.',
      {
        code: 'P2022',
        clientVersion: '7.9.0',
        meta: { column: 'subscriptions.remnawave_panel_id' },
      },
    );

  it('records a P2022 raised by the pre-claim read instead of leaving the row PENDING', async () => {
    // `loadSyncJob` runs BEFORE the try/catch that classifies, and it selects
    // the two columns this patch's migration adds — so for the length of every
    // deploy window the worker's regenerated Client names columns the database
    // has not grown yet, on the one path where the drift handling could not
    // reach it. The row stayed `PENDING, attempts = 0` while BullMQ burned its
    // retries and retained the exhausted job under the same `jobId`; the
    // pending sweep's plain re-add was then deduplicated against that retained
    // job and the row became unreachable FOREVER — it did not recover even once
    // the migration landed. Checkout answered PROFILE_PENDING indefinitely
    // (PROFILE_SYNC_FAILED needs `FAILED` + `TERMINAL`) and nobody was paged.
    const attempt = runPreClaimFailure({ error: schemaDrift() });

    await assert.rejects(attempt.run(), /remnawave_panel_id/);

    assert.equal(attempt.writes.length, 1, 'the failure must be persisted');
    const write = attempt.writes[0]!;
    assert.deepEqual(write.where, {
      id: 'sync-job-drift',
      // NOT fenced on RUNNING: nothing was ever claimed.
      status: { in: [SyncJobStatus.PENDING, SyncJobStatus.FAILED] },
      supersededAt: null,
    });
    assert.equal(write.data.status, SyncJobStatus.FAILED);
    assert.equal(write.data.attempts, 1);
    assert.deepEqual(write.data.recoveryData, { classification: 'TRANSIENT' });
    assert.deepEqual(attempt.errorEvents, [], 'a deploy window must not page anybody');
  });

  it('pages the operator when the pre-claim failure is final and genuinely terminal', async () => {
    const attempt = runPreClaimFailure({
      error: schemaDrift(),
      attempts: PROFILE_SYNC_MAX_ATTEMPTS - 1,
      jobAgeMs: SCHEMA_DRIFT_GRACE_MS + 60_000,
    });

    await assert.rejects(attempt.run());

    assert.deepEqual(attempt.writes[0]!.data.recoveryData, { classification: 'TERMINAL' });
    assert.equal(attempt.errorEvents.length, 1);
  });

  it('never lets the recovery write replace the original error', async () => {
    // The row is gone, so there is nothing to record — but the caller must
    // still see what actually failed, and BullMQ must still retry.
    const attempt = runPreClaimFailure({ error: schemaDrift(), anchorMissing: true });

    await assert.rejects(attempt.run(), /remnawave_panel_id/);
    assert.deepEqual(attempt.writes, []);
  });
});

/**
 * The two writes that used to lose a panel profile without failing.
 *
 * Both are the same shape of bug: a statement whose result nobody read. The
 * CREATE path handed Prisma an `undefined` identity, which Prisma treats as
 * "leave this column alone", and the job COMPLETED with `remnawave_id` still
 * NULL. The DELETE path fenced its retirement on ONE of the profile's two
 * lawful names, matched zero rows on an upgraded panel, and left the
 * subscription non-DELETED with no service behind it. Neither raised anything.
 */
describe('ProfileSyncProcessor — a panel identity that will not decode fails the job', () => {
  function createWithPanelUser(panelUser: Record<string, unknown>) {
    const jobWrites: Array<{ readonly data: Record<string, unknown> }> = [];
    const subscriptionWrites: unknown[] = [];
    const transactionsOpened: unknown[] = [];
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-1',
            action: SyncAction.CREATE,
            status: SyncJobStatus.PENDING,
            attempts: 0,
            createdAt: new Date(),
            supersededAt: null,
            subscription: {
              id: 'subscription-1',
              userId: 'user-1',
              remnawaveId: null,
              trafficLimit: null,
              deviceLimit: 0,
              internalSquads: [],
              externalSquad: null,
              expiresAt: new Date('2099-02-01T00:00:00.000Z'),
              planSnapshot: {},
            },
          }),
          updateMany: async (input: { readonly data: Record<string, unknown> }) => {
            jobWrites.push(input);
            return { count: 1 };
          },
          update: async () => undefined,
        },
        subscription: {
          updateMany: async (input: unknown) => { subscriptionWrites.push(input); return { count: 1 }; },
        },
        // Opening it at all is already the bug: the guard must refuse BEFORE a
        // transaction is started, so the advisory lock is never taken under a
        // key built from an unusable identity.
        $transaction: async () => {
          transactionsOpened.push(true);
          throw new Error('persistProfileLink opened a transaction for an unusable identity');
        },
      } as never,
      {
        getUserByUsername: async () => panelMissing(),
        // `drifted: true` on purpose. The executor is LENIENT — a `2xx` whose
        // body fails the pinned contract is handed back RAW — so this is the
        // shape a real panel can produce, not a fixture that could not happen.
        createUser: async () => ({ kind: 'ok', drifted: true, data: { response: panelUser } }),
      } as never,
      {
        generateProfileName: async () => ({ username: 'rz_subscription_1', description: 'd' }),
        getContactInfo: async () => ({ email: null, telegramId: null }),
      } as never,
      { error: () => undefined, info: () => undefined, warn: () => undefined } as never,
    );
    return {
      go: () => processor.process({ data: { syncJobId: 'sync-job-1' } } as never),
      jobWrites,
      subscriptionWrites,
      transactionsOpened,
    };
  }

  it('refuses a created profile whose identity did not decode, instead of completing empty', async () => {
    // A body with no `id` at all — which the lenient executor hands straight
    // through. `String(undefined)` is `'undefined'`, a NON-EMPTY string that
    // sails past the emptiness guard and names no profile on any panel, so
    // "completed" would once again mean a job that reported success over a
    // meaningless column. That is the same defect the old cast produced,
    // arriving through the one door the new layer deliberately leaves open.
    const attempt = createWithPanelUser({
      username: 'rz_subscription_1',
      subscriptionUrl: 'https://sub.example/created',
      createdAt: '2026-01-15T12:30:00.000Z',
    });

    await assert.rejects(attempt.go(), /empty Remnawave identity/);

    assert.deepEqual(attempt.transactionsOpened, [], 'no transaction, hence no advisory lock');
    assert.deepEqual(attempt.subscriptionWrites, [], 'nothing may be written');
    // …and the job is FAILED, never COMPLETED. That is the whole difference:
    // before, this exact input produced a COMPLETED job and a NULL column.
    const statuses = attempt.jobWrites.map((write) => write.data['status']);
    assert.ok(statuses.includes(SyncJobStatus.FAILED), `expected a FAILED write, got ${statuses.join(', ')}`);
    assert.equal(statuses.includes(SyncJobStatus.COMPLETED), false);
  });

  it('refuses an id that is not a usable number for the same reason', async () => {
    // The other spellings a drifted body can carry: a string where the contract
    // declares a number, and a value too large to survive `String()` intact.
    const attempt = createWithPanelUser({
      id: '4471',
      username: 'rz_subscription_1',
      subscriptionUrl: 'https://sub.example/created',
      createdAt: '2026-01-15T12:30:00.000Z',
    });

    await assert.rejects(attempt.go(), /empty Remnawave identity/);
    assert.deepEqual(attempt.transactionsOpened, []);
    assert.deepEqual(attempt.subscriptionWrites, []);
  });
});

describe('ProfileSyncProcessor — retiring the row is fenced on BOTH era names', () => {
  const UUID = '330f2b38-1362-46ab-b5c0-dea32167eff9';

  function run(options: {
    readonly rowRemnawaveId: string | null;
    readonly rowPanelId: number | null;
    readonly payload: Record<string, unknown>;
    /** What the fenced `updateMany` reports it touched. */
    readonly retiredCount?: number;
  }) {
    const retireWheres: unknown[] = [];
    const errorEvents: unknown[][] = [];
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-delete',
            action: SyncAction.DELETE,
            status: SyncJobStatus.PENDING,
            attempts: 0,
            supersededAt: null,
            createdAt: new Date(),
            payload: options.payload,
            subscription: {
              id: 'subscription-1',
              userId: 'user-1',
              // Retired at enqueue time, as every producer of a DELETE job does.
              status: SubscriptionStatus.DELETED,
              remnawaveId: options.rowRemnawaveId,
              remnawavePanelId: options.rowPanelId,
              remnawavePanelUsername: 'rz_john_sub',
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
          findMany: async () => [],
          updateMany: async (input: { readonly where: unknown }) => {
            retireWheres.push(input.where);
            return { count: options.retiredCount ?? 1 };
          },
        },
      } as never,
      {
        deleteUser: async () => ({ kind: 'ok', drifted: false, data: undefined }),
        resolveUser: async () => {
          throw new Error('the recorded numeric id is the address; nothing may re-resolve it');
        },
      } as never,
      {} as never,
      {
        error: (...args: unknown[]) => { errorEvents.push(args); },
        info: () => undefined,
        warn: () => undefined,
      } as never,
    );
    return {
      go: () => processor.process({ data: { syncJobId: 'sync-job-delete' } } as never),
      retireWheres,
      errorEvents,
    };
  }

  it('asks about the NUMERIC id too, so a row still holding its 2.x uuid is retired', async () => {
    // The surviving half of the two-era problem. The DELETE targets the profile
    // by the numeric id the panel answers to, while the ROW has never been
    // repaired and still stores the uuid it was linked under before the
    // operator upgraded. Both name ONE panel profile, so a fence that compared
    // only `remnawave_id` would find them unequal, touch no rows, and leave the
    // subscription live over a profile that is gone — silently, because nobody
    // read `count`.
    const attempt = run({
      rowRemnawaveId: UUID,
      rowPanelId: 4471,
      payload: {
        targetRemnawaveId: '4471',
        targetRemnawavePanelId: 4471,
        targetRemnawavePanelUsername: 'rz_john_sub',
      },
    });

    await attempt.go();

    assert.deepEqual(attempt.retireWheres, [
      { id: 'subscription-1', OR: [{ remnawaveId: '4471' }, { remnawavePanelId: 4471 }] },
    ]);
    assert.deepEqual(attempt.errorEvents, [], 'a matched fence is not a divergence');
  });

  it('OMITS the numeric arm when no panel id is known — null would match every such row', async () => {
    // `remnawave_panel_id` carries no unique constraint, and the only other
    // predicate here is the row's own id. A `remnawavePanelId: null` arm would
    // therefore turn "this row, if it still holds the target" into "this row,
    // unconditionally", and retire it on a genuine mismatch.
    const attempt = run({
      rowRemnawaveId: '4711',
      rowPanelId: null,
      payload: { targetRemnawaveId: '4711' },
    });

    await attempt.go();

    assert.deepEqual(attempt.retireWheres, [
      { id: 'subscription-1', OR: [{ remnawaveId: '4711' }] },
    ]);
  });

  it('reports a fence that matched nothing while the row still names the deleted profile', async () => {
    // The panel profile is gone and the row still points at it, so the row is
    // live with no service behind it. `count` is the only place that shows.
    const attempt = run({
      rowRemnawaveId: '4471',
      rowPanelId: 4471,
      payload: {
        targetRemnawaveId: '4471',
        targetRemnawavePanelId: 4471,
        targetRemnawavePanelUsername: 'rz_john_sub',
      },
      retiredCount: 0,
    });

    await attempt.go();

    assert.equal(attempt.errorEvents.length, 1);
    assert.match(String(attempt.errorEvents[0]![2]), /still names the profile that was just deleted/);
  });

  it('stays quiet when the row simply moved on to another profile', async () => {
    // Zero rows here is CORRECT — the row was re-provisioned while the DELETE
    // was in flight and must keep its live link. Paging for it would page on a
    // documented, healthy path.
    const attempt = run({
      rowRemnawaveId: '4719',
      rowPanelId: null,
      payload: { targetRemnawaveId: '4718' },
      retiredCount: 0,
    });

    await attempt.go();

    assert.deepEqual(attempt.errorEvents, []);
  });
});