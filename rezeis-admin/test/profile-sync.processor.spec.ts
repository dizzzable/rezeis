import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SyncAction, SyncJobStatus } from '@prisma/client';

import { ProfileSyncProcessor } from '../src/modules/profile-sync/profile-sync.processor';

describe('ProfileSyncProcessor', () => {
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
          update: async (input: unknown) => { profileSyncUpdates.push(input); },
        },
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
          update: async (input: unknown) => { profileSyncUpdates.push(input); },
        },
        subscription: {
          update: async (input: unknown) => { subscriptionUpdates.push(input); },
        },
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
          update: async () => undefined,
        },
        subscription: {
          update: async (input: unknown) => { subscriptionUpdates.push(input); },
        },
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

  it('detaches the profile (nulls remnawaveId, keeps row) on successful DELETE', async () => {
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
          update: async () => undefined,
        },
        subscription: {
          update: async (input: unknown) => { subscriptionUpdates.push(input); },
        },
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

    assert.deepStrictEqual(subscriptionUpdates, [{
      where: { id: 'subscription-1' },
      data: { remnawaveId: null },
    }]);
  });

  it('leaves remnawaveId intact when panel DELETE reports not-deleted', async () => {
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
          update: async () => undefined,
        },
        subscription: {
          update: async (input: unknown) => { subscriptionUpdates.push(input); },
        },
      } as never,
      {
        deletePanelUser: async () => ({ isDeleted: false }),
      } as never,
      {} as never,
      { error: () => undefined, info: () => undefined } as never,
    );

    await processor.process({ data: { syncJobId: 'sync-job-1' } } as never);

    assert.deepStrictEqual(subscriptionUpdates, []);
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
