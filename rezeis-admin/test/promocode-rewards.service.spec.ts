import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PromoCodeActivation } from '@prisma/client';

import { PromocodeRewardsService } from '../src/modules/promocodes/services/promocode-rewards.service';

function makeActivation(overrides: Partial<PromoCodeActivation> = {}): PromoCodeActivation {
  return {
    id: 'activation-1',
    promoCodeId: 'promo-1',
    userId: 'user-1',
    targetSubscriptionId: null,
    rewardType: 'SUBSCRIPTION',
    rewardValue: 30,
    promoCodeSnapshot: { planSnapshot: { id: 'plan-1', name: 'Plan', trafficLimit: null, deviceLimit: 3 } } as never,
    activatedAt: new Date('2026-04-24T12:00:00.000Z'),
    createdAt: new Date('2026-04-24T12:00:00.000Z'),
    updatedAt: new Date('2026-04-24T12:00:00.000Z'),
    ...overrides,
  } as PromoCodeActivation;
}

describe('PromocodeRewardsService', () => {
  it('marks created profile sync job failed when subscription reward enqueue fails', async () => {
    const events: string[] = [];
    const rawQueueError = new Error('redis://admin:secret@redis.internal payload sub_raw token raw-provider-token');
    const transactionClient = {
      subscription: {
        create: async () => {
          events.push('subscription.create');
          return { id: 'subscription-1' };
        },
      },
      promoCodeActivation: {
        update: async () => {
          events.push('activation.update');
          return {};
        },
      },
      profileSyncJob: {
        create: async () => {
          events.push('profileSyncJob.create');
          return { id: 'sync-job-1' };
        },
        update: async (input: unknown) => {
          events.push('profileSyncJob.update');
          assert.deepStrictEqual(input, {
            where: { id: 'sync-job-1' },
            data: {
              status: 'FAILED',
              lastError: 'PROFILE_SYNC_ENQUEUE_FAILED',
              nextRetryAt: null,
              processedAt: (input as { readonly data: { readonly processedAt: Date } }).data.processedAt,
            },
          });
          return {};
        },
      },
    };
    const prisma = {
      $transaction: async (callback: (client: typeof transactionClient) => Promise<unknown>) => {
        events.push('transaction.begin');
        const result = await callback(transactionClient);
        events.push('transaction.commit');
        return result;
      },
      subscription: {
        create: async () => {
          throw new Error('root subscription.create should not be used for subscription reward staging');
        },
      },
      promoCodeActivation: {
        update: async () => {
          throw new Error('root promoCodeActivation.update should not be used for subscription reward staging');
        },
      },
      profileSyncJob: {
        create: async () => {
          throw new Error('root profileSyncJob.create should not be used for subscription reward staging');
        },
        update: transactionClient.profileSyncJob.update,
      },
    };
    const queue = {
      enqueueJob: async (jobId: string) => {
        events.push(`enqueue:${jobId}`);
        throw rawQueueError;
      },
    };
    const service = new PromocodeRewardsService(prisma as never, undefined, queue as never);

    await assert.rejects(() => service.executeReward(makeActivation(), null), rawQueueError);

    assert.deepStrictEqual(events, [
      'transaction.begin',
      'subscription.create',
      'activation.update',
      'profileSyncJob.create',
      'transaction.commit',
      'enqueue:sync-job-1',
      'profileSyncJob.update',
    ]);
    const serializedEvents = JSON.stringify(events);
    assert.equal(serializedEvents.includes('secret'), false);
    assert.equal(serializedEvents.includes('raw-provider-token'), false);
  });

  it('preserves the original enqueue error when failed marker update also fails', async () => {
    const rawQueueError = new Error('bullmq enqueue rejected provider-token');
    const transactionClient = {
      subscription: { create: async () => ({ id: 'subscription-1' }) },
      promoCodeActivation: { update: async () => ({}) },
      profileSyncJob: {
        create: async () => ({ id: 'sync-job-2' }),
      },
    };
    const prisma = {
      $transaction: async (callback: (client: typeof transactionClient) => Promise<unknown>) => callback(transactionClient),
      profileSyncJob: {
        update: async () => {
          throw new Error('marker update failed');
        },
      },
    };
    const queue = {
      enqueueJob: async () => {
        throw rawQueueError;
      },
    };
    const service = new PromocodeRewardsService(prisma as never, undefined, queue as never);

    await assert.rejects(() => service.executeReward(makeActivation(), null), rawQueueError);
  });

  it('normalizes Remnawave provider failures for existing subscription rewards', async () => {
    const rawProviderError = new Error(
      'Remnawave failed https://remnawave.internal/subscriptionUrl profile token=raw-provider-token 0194f4b6-7cc7-7ecb-9f62-123456789abc',
    );
    let subscriptionUpdateCalls = 0;
    const prisma = {
      subscription: {
        update: async () => {
          subscriptionUpdateCalls += 1;
          throw new Error('local subscription update must not run after provider failure');
        },
      },
    };
    const remnawaveCalls: unknown[] = [];
    const remnawave = {
      updateSubscriptionUser: async (payload: unknown) => {
        remnawaveCalls.push(payload);
        throw rawProviderError;
      },
    };
    const service = new PromocodeRewardsService(prisma as never, remnawave as never, undefined);
    const cases = [
      {
        rewardType: 'DURATION' as const,
        rewardValue: 7,
        targetSubscription: {
          id: 'subscription-duration',
          userId: 'user-1',
          remnawaveId: 'remnawave-subscription-duration',
          expiresAt: new Date('2026-04-24T12:00:00.000Z'),
        },
      },
      {
        rewardType: 'TRAFFIC' as const,
        rewardValue: 10,
        targetSubscription: {
          id: 'subscription-traffic',
          userId: 'user-1',
          remnawaveId: 'remnawave-subscription-traffic',
          trafficLimitBytes: 100,
        },
      },
      {
        rewardType: 'DEVICES' as const,
        rewardValue: 2,
        targetSubscription: {
          id: 'subscription-devices',
          userId: 'user-1',
          remnawaveId: 'remnawave-subscription-devices',
          deviceLimit: 3,
        },
      },
    ];

    for (const rewardCase of cases) {
      await assert.rejects(
        () => service.executeReward(
          makeActivation({ rewardType: rewardCase.rewardType, rewardValue: rewardCase.rewardValue }),
          rewardCase.targetSubscription as never,
        ),
        (error: unknown) => {
          const serialized = JSON.stringify(error);
          assert.equal(serialized.includes('REMNAWAVE_PROVIDER_ERROR'), true, rewardCase.rewardType);
          assert.equal(serialized.includes('https://remnawave.internal'), false, rewardCase.rewardType);
          assert.equal(serialized.includes('subscriptionUrl'), false, rewardCase.rewardType);
          assert.equal(serialized.includes('raw-provider-token'), false, rewardCase.rewardType);
          assert.equal(serialized.includes('0194f4b6-7cc7-7ecb-9f62-123456789abc'), false, rewardCase.rewardType);
          return true;
        },
      );
    }

    assert.equal(subscriptionUpdateCalls, 0);
    assert.equal(remnawaveCalls.length, cases.length);
  });
});
