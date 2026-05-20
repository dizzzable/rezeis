import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SyncAction, SyncJobStatus } from '@prisma/client';

import { ProfileSyncJobExecutorService } from '../src/modules/payments/services/profile-sync-job-executor.service';

function withTransaction<T extends Record<string, unknown>>(prismaDouble: T): T & { $transaction: <R>(callback: (transactionClient: T) => Promise<R>) => Promise<R> } {
  return {
    ...prismaDouble,
    $transaction: async <R>(callback: (transactionClient: T) => Promise<R>): Promise<R> => callback(prismaDouble),
  };
}

describe('ProfileSyncJobExecutorService', () => {
  it('processes one pending UPDATE job through Remnawave and marks it completed', async () => {
    const updates: unknown[] = [];
    const remnawaveCalls: unknown[] = [];
    const service = new ProfileSyncJobExecutorService(withTransaction({
      profileSyncJob: {
        findFirst: async () => ({ id: 'job-1', action: SyncAction.UPDATE, status: SyncJobStatus.PENDING, subscriptionId: 'subscription-1' }),
        update: async (input: unknown) => {
          updates.push(input);
        },
      },
      subscription: {
        findUnique: async () => ({
          id: 'subscription-1',
          remnawaveId: 'rem-sub-1',
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          status: 'ACTIVE',
          trafficLimit: BigInt(1024),
          deviceLimit: 3,
          internalSquads: ['squad-a'],
          externalSquad: 'external-a',
        }),
      },
    }) as never, {
      updateSubscriptionUser: async (input: unknown) => {
        remnawaveCalls.push(input);
        return { status: 'ACTIVE', shortUuid: 'short-1', subscriptionUrl: 'https://sub.example', expireAt: null, trafficLimitBytes: null, hwidDeviceLimit: null, activeInternalSquads: [], externalSquadUuid: null };
      },
    } as never);

    const result = await service.processNextPendingJob();

    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.providerMutation, true);
    assert.deepStrictEqual(remnawaveCalls, [{ remnawaveSubscriptionId: 'rem-sub-1', expireAt: new Date('2099-01-01T00:00:00.000Z'), status: 'ACTIVE', trafficLimitBytes: 1024, hwidDeviceLimit: 3, activeInternalSquads: ['squad-a'], externalSquadUuid: 'external-a' }]);
    assert.equal(JSON.stringify(updates).includes('COMPLETED'), true);
  });

  it('uses one transaction client for UPDATE post-provider local writes', async () => {
    const events: string[] = [];
    const tx = {
      profileSyncJob: {
        update: async () => { events.push('tx.profileSyncJob.update'); },
      },
    };
    const service = new ProfileSyncJobExecutorService({
      profileSyncJob: {
        findFirst: async () => ({ id: 'job-update-tx-1', action: SyncAction.UPDATE, status: SyncJobStatus.PENDING, subscriptionId: 'subscription-1' }),
        update: async (input: { readonly data?: { readonly status?: SyncJobStatus } }) => {
          if (input.data?.status === SyncJobStatus.PROCESSING) {
            events.push('root.profileSyncJob.update.processing');
            return;
          }
          throw new Error('root profileSyncJob.update must not be used for provider success writes');
        },
      },
      subscription: {
        findUnique: async () => ({
          id: 'subscription-1',
          remnawaveId: 'rem-sub-update-tx-1',
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          status: 'ACTIVE',
          trafficLimit: BigInt(1024),
          deviceLimit: 3,
          internalSquads: ['squad-a'],
          externalSquad: 'external-a',
        }),
      },
      $transaction: async (callback: (transactionClient: typeof tx) => Promise<unknown>) => {
        events.push('transaction.begin');
        const result = await callback(tx);
        events.push('transaction.commit');
        return result;
      },
    } as never, {
      updateSubscriptionUser: async () => {
        events.push('remnawave.updateSubscriptionUser');
        return { status: 'ACTIVE', shortUuid: 'short-update-tx-1', subscriptionUrl: 'https://sub.example/update', expireAt: null, trafficLimitBytes: null, hwidDeviceLimit: null, activeInternalSquads: [], externalSquadUuid: null };
      },
    } as never);

    const result = await service.processNextPendingJob();

    assert.equal(result.status, 'COMPLETED');
    assert.deepStrictEqual(events, [
      'root.profileSyncJob.update.processing',
      'remnawave.updateSubscriptionUser',
      'transaction.begin',
      'tx.profileSyncJob.update',
      'transaction.commit',
    ]);
  });

  it('processes one pending CREATE job through Remnawave and stores bounded linkage metadata', async () => {
    const updates: unknown[] = [];
    const subscriptionUpdates: unknown[] = [];
    const remnawaveCreates: unknown[] = [];
    const service = new ProfileSyncJobExecutorService(withTransaction({
      profileSyncJob: {
        findFirst: async () => ({ id: 'job-create-1', action: SyncAction.CREATE, status: SyncJobStatus.PENDING, subscriptionId: 'subscription-1' }),
        update: async (input: unknown) => { updates.push(input); },
      },
      subscription: {
        findUnique: async () => ({
          id: 'subscription-1',
          userId: 'user-1',
          remnawaveId: null,
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          status: 'ACTIVE',
          trafficLimit: BigInt(2048),
          deviceLimit: 4,
          internalSquads: ['squad-b'],
          externalSquad: null,
          user: { email: 'user@example.test', telegramId: 123n },
        }),
        update: async (input: unknown) => { subscriptionUpdates.push(input); },
      },
    }) as never, {
      createSubscriptionUser: async (input: unknown) => {
        remnawaveCreates.push(input);
        return { userUuid: '33333333-3333-4333-8333-333333333333', status: 'ACTIVE', shortUuid: 'short-create-1', subscriptionUrl: 'https://sub.example/create', expireAt: null, trafficLimitBytes: null, hwidDeviceLimit: null, activeInternalSquads: [], externalSquadUuid: null };
      },
    } as never);

    const result = await service.processNextPendingJob();

    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.providerMutation, true);
    assert.equal(remnawaveCreates.length, 1);
    assert.equal(JSON.stringify(remnawaveCreates).includes('rz_subscription1'), true);
    assert.equal(JSON.stringify(subscriptionUpdates).includes('33333333-3333-4333-8333-333333333333'), true);
    assert.equal(JSON.stringify(updates).includes('COMPLETED'), true);
  });

  it('uses one transaction client for CREATE post-provider local writes', async () => {
    const events: string[] = [];
    const tx = {
      subscription: {
        update: async () => { events.push('tx.subscription.update'); },
      },
      profileSyncJob: {
        update: async () => { events.push('tx.profileSyncJob.update'); },
      },
    };
    const service = new ProfileSyncJobExecutorService({
      profileSyncJob: {
        findFirst: async () => ({ id: 'job-create-tx-1', action: SyncAction.CREATE, status: SyncJobStatus.PENDING, subscriptionId: 'subscription-1' }),
        update: async (input: { readonly data?: { readonly status?: SyncJobStatus } }) => {
          if (input.data?.status === SyncJobStatus.PROCESSING) {
            events.push('root.profileSyncJob.update.processing');
            return;
          }
          throw new Error('root profileSyncJob.update must not be used for provider success writes');
        },
      },
      subscription: {
        findUnique: async () => ({
          id: 'subscription-1',
          userId: 'user-1',
          remnawaveId: null,
          expiresAt: null,
          status: 'ACTIVE',
          trafficLimit: null,
          deviceLimit: null,
          internalSquads: [],
          externalSquad: null,
          user: { email: null, telegramId: null },
        }),
        update: async () => { throw new Error('root subscription.update must not be used for provider success writes'); },
      },
      $transaction: async (callback: (transactionClient: typeof tx) => Promise<unknown>) => {
        events.push('transaction.begin');
        const result = await callback(tx);
        events.push('transaction.commit');
        return result;
      },
    } as never, {
      createSubscriptionUser: async () => {
        events.push('remnawave.createSubscriptionUser');
        return { userUuid: '33333333-3333-4333-8333-333333333333', status: 'ACTIVE', shortUuid: 'short-create-tx-1', subscriptionUrl: null, expireAt: null, trafficLimitBytes: null, hwidDeviceLimit: null, activeInternalSquads: [], externalSquadUuid: null };
      },
    } as never);

    const result = await service.processNextPendingJob();

    assert.equal(result.status, 'COMPLETED');
    assert.deepStrictEqual(events, [
      'root.profileSyncJob.update.processing',
      'remnawave.createSubscriptionUser',
      'transaction.begin',
      'tx.subscription.update',
      'tx.profileSyncJob.update',
      'transaction.commit',
    ]);
  });

  it('processes one pending DELETE job through Remnawave and clears local linkage', async () => {
    const updates: unknown[] = [];
    const deletes: string[] = [];
    const service = new ProfileSyncJobExecutorService(withTransaction({
      profileSyncJob: {
        findFirst: async () => ({ id: 'job-delete-1', action: SyncAction.DELETE, status: SyncJobStatus.PENDING, subscriptionId: 'subscription-1' }),
        update: async (input: unknown) => { updates.push(input); },
      },
      subscription: {
        findUnique: async () => ({ id: 'subscription-1', remnawaveId: 'rem-sub-1' }),
        update: async (input: unknown) => { updates.push(input); },
      },
    }) as never, {
      deleteSubscriptionUser: async (remnawaveSubscriptionId: string) => {
        deletes.push(remnawaveSubscriptionId);
        return { affectedRows: 1 };
      },
    } as never);

    const result = await service.processNextPendingJob();

    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.action, SyncAction.DELETE);
    assert.deepStrictEqual(deletes, ['rem-sub-1']);
    assert.equal(JSON.stringify(updates).includes('lastDelete'), true);
    assert.equal(JSON.stringify(updates).includes('COMPLETED'), true);
  });

  it('uses one transaction client for DELETE post-provider local writes', async () => {
    const events: string[] = [];
    const tx = {
      subscription: {
        update: async () => { events.push('tx.subscription.update'); },
      },
      profileSyncJob: {
        update: async () => { events.push('tx.profileSyncJob.update'); },
      },
    };
    const service = new ProfileSyncJobExecutorService({
      profileSyncJob: {
        findFirst: async () => ({ id: 'job-delete-tx-1', action: SyncAction.DELETE, status: SyncJobStatus.PENDING, subscriptionId: 'subscription-1' }),
        update: async (input: { readonly data?: { readonly status?: SyncJobStatus } }) => {
          if (input.data?.status === SyncJobStatus.PROCESSING) {
            events.push('root.profileSyncJob.update.processing');
            return;
          }
          throw new Error('root profileSyncJob.update must not be used for provider success writes');
        },
      },
      subscription: {
        findUnique: async () => ({ id: 'subscription-1', remnawaveId: 'rem-sub-delete-tx-1' }),
        update: async () => { throw new Error('root subscription.update must not be used for provider success writes'); },
      },
      $transaction: async (callback: (transactionClient: typeof tx) => Promise<unknown>) => {
        events.push('transaction.begin');
        const result = await callback(tx);
        events.push('transaction.commit');
        return result;
      },
    } as never, {
      deleteSubscriptionUser: async (remnawaveSubscriptionId: string) => {
        assert.equal(remnawaveSubscriptionId, 'rem-sub-delete-tx-1');
        events.push('remnawave.deleteSubscriptionUser');
        return { affectedRows: 1 };
      },
    } as never);

    const result = await service.processNextPendingJob();

    assert.equal(result.status, 'COMPLETED');
    assert.deepStrictEqual(events, [
      'root.profileSyncJob.update.processing',
      'remnawave.deleteSubscriptionUser',
      'transaction.begin',
      'tx.subscription.update',
      'tx.profileSyncJob.update',
      'transaction.commit',
    ]);
  });

  it('processes a bounded batch and stops when no pending jobs remain', async () => {
    const queue = [
      { id: 'job-1', action: SyncAction.UPDATE, status: SyncJobStatus.PENDING, subscriptionId: 'subscription-1' },
      { id: 'job-2', action: SyncAction.CREATE, status: SyncJobStatus.PENDING, subscriptionId: 'subscription-2' },
    ];
    const updates: unknown[] = [];
    const service = new ProfileSyncJobExecutorService(withTransaction({
      profileSyncJob: {
        findFirst: async () => queue.shift() ?? null,
        update: async (input: unknown) => { updates.push(input); },
      },
      subscription: {
        findUnique: async (input: { readonly where: { readonly id: string } }) => ({
          id: input.where.id,
          userId: 'user-1',
          remnawaveId: input.where.id === 'subscription-1' ? 'rem-sub-1' : null,
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          status: 'ACTIVE',
          trafficLimit: BigInt(1024),
          deviceLimit: 2,
          internalSquads: [],
          externalSquad: null,
          user: { email: null, telegramId: null },
        }),
        update: async (input: unknown) => { updates.push(input); },
      },
    }) as never, {
      updateSubscriptionUser: async () => ({ userUuid: null, status: 'ACTIVE', shortUuid: 'short-1', subscriptionUrl: null, expireAt: null, trafficLimitBytes: null, hwidDeviceLimit: null, activeInternalSquads: [], externalSquadUuid: null }),
      createSubscriptionUser: async () => ({ userUuid: '33333333-3333-4333-8333-333333333333', status: 'ACTIVE', shortUuid: 'short-2', subscriptionUrl: null, expireAt: null, trafficLimitBytes: null, hwidDeviceLimit: null, activeInternalSquads: [], externalSquadUuid: null }),
    } as never);

    const result = await service.processPendingBatch(10);

    assert.deepStrictEqual({ attempted: result.attempted, completed: result.completed, failed: result.failed, blocked: result.blocked }, { attempted: 2, completed: 2, failed: 0, blocked: 0 });
    assert.equal(JSON.stringify(updates).includes('COMPLETED'), true);
  });

  it('schedules retry with backoff using sanitized provider failure copy', async () => {
    const updates: unknown[] = [];
    const rawProviderFailure = 'provider unavailable https://remnawave.example/profile/0194f4b6-7cc7-7ecb-9f62-123456789abc?token=raw-provider-token-secret';
    const service = new ProfileSyncJobExecutorService(withTransaction({
      profileSyncJob: {
        findFirst: async () => ({ id: 'job-retry-1', action: SyncAction.UPDATE, status: SyncJobStatus.PENDING, subscriptionId: 'subscription-1', attempts: 1, maxAttempts: 3, nextRetryAt: null }),
        update: async (input: unknown) => { updates.push(input); },
      },
      subscription: {
        findUnique: async () => ({ id: 'subscription-1', remnawaveId: 'rem-sub-1', expiresAt: null, status: 'ACTIVE', trafficLimit: null, deviceLimit: null, internalSquads: [], externalSquad: null }),
      },
    }) as never, {
      updateSubscriptionUser: async () => { throw new Error(rawProviderFailure); },
    } as never);

    const result = await service.processNextPendingJob();

    assert.equal(result.status, 'RETRY_SCHEDULED');
    assert.equal(result.reason, 'PAYMENT_PROVIDER_UNAVAILABLE');
    assert.equal(JSON.stringify(updates).includes('PAYMENT_PROVIDER_UNAVAILABLE'), true);
    assert.equal(JSON.stringify(updates).includes(rawProviderFailure), false);
    assert.equal(JSON.stringify(updates).includes('raw-provider-token-secret'), false);
    assert.equal(JSON.stringify(updates).includes('0194f4b6-7cc7-7ecb-9f62-123456789abc'), false);
    assert.equal(JSON.stringify(updates).includes('PENDING'), true);
  });

  it('does not reclassify post-provider local DB failures as provider failures', async () => {
    const updates: unknown[] = [];
    const localDbFailure = new Error('database update failed after provider success postgres://admin:secret@db.internal/rezeis profile-sync payload');
    const service = new ProfileSyncJobExecutorService(withTransaction({
      profileSyncJob: {
        findFirst: async () => ({ id: 'job-local-failure-1', action: SyncAction.UPDATE, status: SyncJobStatus.PENDING, subscriptionId: 'subscription-1', attempts: 0, maxAttempts: 3, nextRetryAt: null }),
        update: async (input: { readonly data?: { readonly status?: SyncJobStatus } }) => {
          updates.push(input);
          if (input.data?.status === SyncJobStatus.COMPLETED) {
            throw localDbFailure;
          }
        },
      },
      subscription: {
        findUnique: async () => ({ id: 'subscription-1', remnawaveId: 'rem-sub-1', expiresAt: null, status: 'ACTIVE', trafficLimit: BigInt(1024), deviceLimit: 2, internalSquads: [], externalSquad: null }),
      },
    }) as never, {
      updateSubscriptionUser: async () => ({ userUuid: null, status: 'ACTIVE', shortUuid: 'short-1', subscriptionUrl: null, expireAt: null, trafficLimitBytes: null, hwidDeviceLimit: null, activeInternalSquads: [], externalSquadUuid: null }),
    } as never);

    await assert.rejects(() => service.processNextPendingJob(), localDbFailure);

    assert.equal(updates.length, 2);
    assert.equal((updates[0] as { readonly data: { readonly status: SyncJobStatus } }).data.status, SyncJobStatus.PROCESSING);
    assert.equal((updates[1] as { readonly data: { readonly status: SyncJobStatus } }).data.status, SyncJobStatus.COMPLETED);
    assert.equal(JSON.stringify(updates).includes('PAYMENT_PROVIDER_UNAVAILABLE'), false);
    assert.equal(JSON.stringify(updates).includes('PROFILE_SYNC_FAILED'), false);
    assert.equal(JSON.stringify(updates).includes('PENDING'), false);
    assert.equal(JSON.stringify(updates).includes('FAILED'), false);
  });

  it('normalizes legacy raw provider diagnostics when listing problem jobs', async () => {
    const rawProviderFailure = 'Remnawave failed https://remnawave.example/profile/0194f4b6-7cc7-7ecb-9f62-123456789abc?token=raw-provider-token-secret provider_uuid=22222222-2222-4222-8222-222222222222';
    const service = new ProfileSyncJobExecutorService({
      profileSyncJob: {
        findMany: async () => [
          {
            id: 'job-raw-1',
            subscriptionId: 'subscription-raw-1',
            action: SyncAction.UPDATE,
            status: SyncJobStatus.FAILED,
            attempts: 3,
            maxAttempts: 3,
            nextRetryAt: null,
            lastError: rawProviderFailure,
            createdAt: new Date('2025-01-01T00:00:00.000Z'),
            processedAt: new Date('2025-01-01T00:05:00.000Z'),
          },
          {
            id: 'job-safe-1',
            subscriptionId: 'subscription-safe-1',
            action: SyncAction.UPDATE,
            status: SyncJobStatus.FAILED,
            attempts: 1,
            maxAttempts: 3,
            nextRetryAt: null,
            lastError: 'REMNAWAVE_PROVIDER_ERROR',
            createdAt: new Date('2025-01-02T00:00:00.000Z'),
            processedAt: null,
          },
        ],
      },
    } as never, {} as never);

    const result = await service.listProblemJobs();
    const serialized = JSON.stringify(result);

    assert.equal(result.items[0]?.errorMessage, 'PROFILE_SYNC_FAILED');
    assert.equal(result.items[1]?.errorMessage, 'REMNAWAVE_PROVIDER_ERROR');
    assert.equal(serialized.includes(rawProviderFailure), false);
    assert.equal(serialized.includes('raw-provider-token-secret'), false);
    assert.equal(serialized.includes('0194f4b6-7cc7-7ecb-9f62-123456789abc'), false);
    assert.equal(serialized.includes('22222222-2222-4222-8222-222222222222'), false);
    assert.equal(serialized.includes('https://remnawave.example'), false);
  });

  it('records compensation notes for terminal failed profile sync jobs', async () => {
    const updates: unknown[] = [];
    const service = new ProfileSyncJobExecutorService({
      profileSyncJob: {
        findUnique: async () => ({ id: 'job-failed-1', status: SyncJobStatus.FAILED, response: { compensationNotes: [] } }),
        update: async (input: unknown) => { updates.push(input); },
      },
    } as never, {} as never);

    const result = await service.recordCompensationNote('job-failed-1', 'Provider profile manually reconciled');

    assert.equal(result.status, 'NOTE_RECORDED');
    assert.equal(updates.length, 1);
    assert.equal(JSON.stringify(updates).includes('Provider profile manually reconciled'), true);
  });

  it('blocks compensation notes for non-failed profile sync jobs', async () => {
    let updated = false;
    const service = new ProfileSyncJobExecutorService({
      profileSyncJob: {
        findUnique: async () => ({ id: 'job-pending-1', status: SyncJobStatus.PENDING, response: null }),
        update: async () => { updated = true; },
      },
    } as never, {} as never);

    const result = await service.recordCompensationNote('job-pending-1', 'Do not allow this');

    assert.equal(result.status, 'BLOCKED');
    assert.equal(updated, false);
  });

  it('force-links verified Remnawave users to local subscriptions', async () => {
    const subscriptionUpdates: unknown[] = [];
    const service = new ProfileSyncJobExecutorService({
      subscription: {
        findUnique: async () => ({ id: 'subscription-1', remnawaveId: null }),
        update: async (input: unknown) => { subscriptionUpdates.push(input); },
      },
    } as never, {
      getSubscriptionUserByUuid: async (remnawaveUserUuid: string) => {
        assert.equal(remnawaveUserUuid, '33333333-3333-4333-8333-333333333333');
        return { userUuid: remnawaveUserUuid, status: 'ACTIVE', shortUuid: 'short-1', subscriptionUrl: null, expireAt: null, trafficLimitBytes: null, hwidDeviceLimit: null, activeInternalSquads: [], externalSquadUuid: null };
      },
    } as never);

    const result = await service.forceLinkSubscription({ subscriptionId: 'subscription-1', remnawaveUserUuid: '33333333-3333-4333-8333-333333333333', reason: 'verified manually' });

    assert.equal(result.status, 'LINKED');
    assert.equal(result.providerStatus, 'ACTIVE');
    assert.equal(JSON.stringify(subscriptionUpdates).includes('33333333-3333-4333-8333-333333333333'), true);
    assert.equal(JSON.stringify(subscriptionUpdates).includes('lastForceLink'), true);
  });

  it('blocks force-link when local subscription does not exist', async () => {
    const service = new ProfileSyncJobExecutorService({ subscription: { findUnique: async () => null } } as never, {} as never);

    const result = await service.forceLinkSubscription({ subscriptionId: 'missing-subscription', remnawaveUserUuid: '33333333-3333-4333-8333-333333333333', reason: 'verified manually' });

    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, 'Subscription not found.');
  });
});
