import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PromocodeAvailability, PromocodeRewardType } from '@prisma/client';

import { PromocodeInterface } from '../src/modules/promocodes/interfaces/promocode.interface';
import { PromocodeLifecycleService } from '../src/modules/promocodes/services/promocode-lifecycle.service';

function buildPromocode(): PromocodeInterface {
  return {
    id: 'promo-1',
    code: 'GIFT-ONEUSE',
    isActive: true,
    availability: PromocodeAvailability.ALL,
    rewardType: PromocodeRewardType.DURATION,
    reward: 7,
    plan: null,
    lifetime: null,
    expiresAt: null,
    maxActivations: 1,
    allowedTelegramIds: [],
    allowedPlanIds: [],
    activationsCount: 0,
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  };
}

describe('PromocodeLifecycleService activation capacity', () => {
  it('rechecks one-use capacity under a row lock before creating an activation', async () => {
    const calls: string[] = [];
    const promocode = buildPromocode();
    const transactionClient = {
      $queryRaw: async () => {
        calls.push('lock');
        return [{ id: promocode.id }];
      },
      promocode: {
        findUnique: async () => {
          calls.push('read');
          return {
            isActive: true,
            archivedAt: null,
            createdAt: new Date('2026-07-11T00:00:00.000Z'),
            updatedAt: new Date(promocode.updatedAt),
            lifetime: null,
            expiresAt: null,
            maxActivations: 1,
          };
        },
      },
      promocodeActivation: {
        count: async () => {
          calls.push('count');
          return 1;
        },
        create: async () => assert.fail('must not create a depleted activation'),
      },
    };
    const prismaService = {
      $transaction: async (callback: (tx: typeof transactionClient) => unknown) =>
        callback(transactionClient),
    };
    const validationService = {
      resolveActivationContext: async () => ({
        hasActiveSubscriptions: false,
        isInvitedUser: false,
      }),
      validate: async () => ({ success: true, promocode }),
      resolveTargetSubscription: async () => ({ subscriptionId: null, errorCode: null }),
    };
    const rewardsService = {
      resolveActivationRewardValue: () => 7,
      applyReward: async () => assert.fail('must not apply a depleted reward'),
      getSuccessMessageKey: () => 'ntf-promocode-activated-duration',
    };
    const service = new PromocodeLifecycleService(
      prismaService as never,
      validationService as never,
      rewardsService as never,
      { info: () => undefined, error: () => undefined } as never,
      { enqueue: async () => undefined } as never,
    );

    const result = await service.activate({
      rawCode: promocode.code,
      userId: 'user-2',
      userTelegramId: null,
      targetSubscriptionId: null,
    });

    assert.equal(result.step, 'REJECTED');
    assert.equal(result.errorCode, 'DEPLETED');
    assert.deepStrictEqual(calls, ['lock', 'read', 'count']);
  });
});
