import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PromocodeAvailability, PromocodeRewardType, SubscriptionStatus } from '@prisma/client';

import { PromocodeInterface } from '../src/modules/promocodes/interfaces/promocode.interface';
import { PromocodeRewardsService } from '../src/modules/promocodes/services/promocode-rewards.service';

function buildPromocode(overrides: Partial<PromocodeInterface> = {}): PromocodeInterface {
  return {
    id: 'promo-1',
    code: 'PROMO',
    isActive: true,
    availability: PromocodeAvailability.ALL,
    rewardType: PromocodeRewardType.DURATION,
    reward: 7,
    plan: null,
    lifetime: null,
    expiresAt: null,
    maxActivations: null,
    allowedTelegramIds: [],
    allowedPlanIds: [],
    activationsCount: 0,
    createdAt: '2026-04-20T10:00:00.000Z',
    updatedAt: '2026-04-20T10:00:00.000Z',
    ...overrides,
  };
}

describe('PromocodeRewardsService', () => {
  it('applies discount rewards with bounded percentage values', async () => {
    const updateCalls: unknown[] = [];
    const service = new PromocodeRewardsService();

    const result = await service.applyReward({
      transactionClient: {
        user: {
          update: async (args: unknown) => {
            updateCalls.push(args);
          },
        },
      } as never,
      promocode: buildPromocode({ rewardType: PromocodeRewardType.PERSONAL_DISCOUNT, reward: 250 }),
      userId: 'user-1',
      targetSubscriptionId: null,
    });

    assert.deepStrictEqual(result, { applied: true, rewardValue: 100 });
    assert.deepStrictEqual(updateCalls, [
      { where: { id: 'user-1' }, data: { personalDiscount: 100 } },
    ]);
  });

  it('extends active subscriptions for duration rewards', async () => {
    const updateCalls: unknown[] = [];
    const service = new PromocodeRewardsService();
    const expiresAt = new Date('2026-12-01T00:00:00.000Z');

    const result = await service.applyReward({
      transactionClient: {
        $queryRaw: async () => [], // subscription row lock
        subscription: {
          findUnique: async () => ({
            expiresAt,
            status: SubscriptionStatus.ACTIVE,
            remnawaveId: 'rw-1',
            userId: 'user-1', // isEligibleTarget check
            planSnapshot: {},
          }),
          update: async (args: unknown) => {
            updateCalls.push(args);
          },
        },
        profileSyncJob: {
          create: async () => ({ id: 'sync-1' }),
        },
      } as never,
      promocode: buildPromocode({ rewardType: PromocodeRewardType.DURATION, reward: 10 }),
      userId: 'user-1',
      targetSubscriptionId: 'sub-1',
    });

    // The reward now also enqueues a Remnawave profile sync so the extended
    // expiry actually reaches the user's VPN profile (not just the local DB).
    assert.deepStrictEqual(result, { applied: true, rewardValue: 10, syncJobId: 'sync-1' });
    assert.deepStrictEqual(updateCalls, [
      {
        where: { id: 'sub-1' },
        data: { expiresAt: new Date('2026-12-11T00:00:00.000Z') },
      },
    ]);
  });

  it('creates local subscription rows from subscription reward plan snapshots', async () => {
    const createCalls: unknown[] = [];
    const service = new PromocodeRewardsService();
    const result = await service.applyReward({
      transactionClient: {
        subscription: {
          create: async (args: unknown) => {
            createCalls.push(args);
            return { id: 'new-sub-1' };
          },
        },
        user: {
          updateMany: async () => ({ count: 1 }),
        },
        profileSyncJob: {
          create: async () => ({ id: 'sync-1' }),
        },
      } as never,
      promocode: buildPromocode({
        rewardType: PromocodeRewardType.SUBSCRIPTION,
        reward: null,
        plan: {
          id: 'plan-1',
          name: 'Premium',
          type: 'BOTH',
          trafficLimit: 100,
          deviceLimit: 5,
          trafficLimitStrategy: 'NO_RESET',
          internalSquads: ['squad-a'],
          externalSquad: null,
          duration: 30,
        },
      }),
      userId: 'user-1',
      targetSubscriptionId: null,
    });

    assert.deepStrictEqual(result, { applied: true, rewardValue: 30, syncJobId: 'sync-1' });
    assert.equal(createCalls.length, 1);
    assert.equal((createCalls[0] as { data: { userId: string } }).data.userId, 'user-1');
    assert.equal(
      (createCalls[0] as { data: { status: SubscriptionStatus } }).data.status,
      SubscriptionStatus.ACTIVE,
    );
    assert.deepStrictEqual(
      (createCalls[0] as { data: { internalSquads: string[] } }).data.internalSquads,
      ['squad-a'],
    );
  });
});
