import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PromocodeAvailability, PromocodeRewardType, SubscriptionStatus } from '@prisma/client';

import { PromocodeInterface } from '../src/modules/promocodes/interfaces/promocode.interface';
import { PromocodeValidationService } from '../src/modules/promocodes/services/promocode-validation.service';

function createRecord(overrides: Record<string, unknown> = {}) {
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
    createdAt: new Date('2026-04-20T10:00:00.000Z'),
    updatedAt: new Date('2026-04-20T10:00:00.000Z'),
    _count: { activations: 0 },
    ...overrides,
  };
}

function createPromocode(overrides: Partial<PromocodeInterface> = {}): PromocodeInterface {
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

describe('PromocodeValidationService', () => {
  it('normalizes codes and validates current availability rules', async () => {
    let findUniqueArgs: unknown;
    let activationCountArgs: unknown;
    const service = new PromocodeValidationService({
      promocode: {
        findUnique: async (args: unknown) => {
          findUniqueArgs = args;
          return createRecord({
            availability: PromocodeAvailability.ALLOWED,
            allowedTelegramIds: [BigInt('123456789')],
          });
        },
      },
      promocodeActivation: {
        count: async (args: unknown) => {
          activationCountArgs = args;
          return 0;
        },
      },
    } as never);

    const result = await service.validate(' promo ', {
      userId: 'user-1',
      userTelegramId: BigInt('123456789'),
      isInvitedUser: false,
      hasActiveSubscriptions: false,
    });

    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.promocode.code, 'PROMO');
      assert.deepStrictEqual(result.promocode.allowedTelegramIds, ['123456789']);
    }
    assert.deepStrictEqual(findUniqueArgs, {
      where: { code: 'PROMO' },
      include: { _count: { select: { activations: true } } },
    });
    assert.deepStrictEqual(activationCountArgs, {
      where: { promocodeId: 'promo-1', userId: 'user-1' },
    });
  });

  it('returns bounded failure codes without mutating state', async () => {
    const service = new PromocodeValidationService({
      promocode: {
        findUnique: async () => createRecord({ availability: PromocodeAvailability.ALLOWED }),
      },
      promocodeActivation: { count: async () => 0 },
    } as never);

    assert.deepStrictEqual(await service.validate('', {
      userId: 'user-1',
      userTelegramId: null,
      isInvitedUser: false,
      hasActiveSubscriptions: false,
    }), { success: false, errorCode: 'NOT_FOUND', messageKey: 'ntf-promocode-not-found' });
    assert.deepStrictEqual(await service.validate('PROMO', {
      userId: 'user-1',
      userTelegramId: null,
      isInvitedUser: false,
      hasActiveSubscriptions: false,
    }), { success: false, errorCode: 'NOT_AVAILABLE_FOR_USER', messageKey: 'ntf-promocode-not-available' });
  });

  it('rejects a promocode past its absolute expiresAt deadline', async () => {
    const past = new Date(Date.now() - 60_000); // 1 min ago
    const service = new PromocodeValidationService({
      promocode: {
        findUnique: async () => createRecord({ expiresAt: past }),
      },
      promocodeActivation: { count: async () => 0 },
    } as never);

    assert.deepStrictEqual(
      await service.validate('PROMO', {
        userId: 'user-1',
        userTelegramId: null,
        isInvitedUser: false,
        hasActiveSubscriptions: false,
      }),
      { success: false, errorCode: 'EXPIRED', messageKey: 'ntf-promocode-expired' },
    );
  });

  it('accepts a promocode whose absolute expiresAt is still in the future', async () => {
    const future = new Date(Date.now() + 3_600_000); // 1 hour ahead
    const service = new PromocodeValidationService({
      promocode: {
        findUnique: async () => createRecord({ expiresAt: future }),
      },
      promocodeActivation: { count: async () => 0 },
    } as never);

    const result = await service.validate('PROMO', {
      userId: 'user-1',
      userTelegramId: null,
      isInvitedUser: false,
      hasActiveSubscriptions: false,
    });
    assert.equal(result.success, true);
  });

  it('resolves eligible and target subscriptions using active ownership and plan filters', async () => {
    const subscriptionFindManyArgs: unknown[] = [];
    const service = new PromocodeValidationService({
      subscription: {
        findMany: async (args: unknown) => {
          subscriptionFindManyArgs.push(args);
          return [
            { id: 'sub-allowed', planSnapshot: { id: 'plan-allowed' } },
            { id: 'sub-other', planSnapshot: { id: 'plan-other' } },
          ];
        },
        findUnique: async ({ where }: { readonly where: { readonly id: string } }) => {
          if (where.id === 'sub-allowed') {
            return {
              id: 'sub-allowed',
              userId: 'user-1',
              status: SubscriptionStatus.ACTIVE,
              planSnapshot: { id: 'plan-allowed' },
            };
          }
          return {
            id: where.id,
            userId: 'other-user',
            status: SubscriptionStatus.ACTIVE,
            planSnapshot: { id: 'plan-allowed' },
          };
        },
      },
    } as never);
    const promocode = createPromocode({ allowedPlanIds: ['plan-allowed'] });

    assert.deepStrictEqual(await service.getEligibleSubscriptionIds({ userId: 'user-1', promocode }), ['sub-allowed']);
    assert.deepStrictEqual(await service.resolveTargetSubscription({ userId: 'user-1', targetSubscriptionId: 'sub-allowed', promocode }), {
      subscriptionId: 'sub-allowed',
      errorCode: null,
    });
    assert.deepStrictEqual(await service.resolveTargetSubscription({ userId: 'user-1', targetSubscriptionId: 'foreign-sub', promocode }), {
      subscriptionId: null,
      errorCode: 'SUBSCRIPTION_FOREIGN',
    });
    assert.deepStrictEqual(subscriptionFindManyArgs, [{
      where: { userId: 'user-1', status: SubscriptionStatus.ACTIVE },
      select: { id: true, planSnapshot: true },
    }]);
  });
});
