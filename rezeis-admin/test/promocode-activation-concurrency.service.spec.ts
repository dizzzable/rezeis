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
    // Mirrors the legacy reward, which is exactly what the mapper produces
    // for a code with no rows in `promocode_actions` — every code written by
    // an older panel, and everything a donor import writes.
    actions: [
      {
        type: PromocodeRewardType.DURATION,
        value: null,
        plan: null,
        discountAllowedPlanIds: [],
        discountValidForDays: null,
      },
    ],
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

/**
 * A service whose whole transaction succeeds, so `activate` reaches the code
 * after the commit — which is where the depletion card is raised.
 */
function activatingService(
  promocode: PromocodeInterface,
  quota: { readonly activationsBefore: number; readonly maxActivations: number | null },
  cards: unknown[],
): PromocodeLifecycleService {
  const transactionClient = {
    $queryRaw: async () => [{ id: promocode.id }],
    promocode: {
      findUnique: async () => ({
        isActive: true,
        archivedAt: null,
        createdAt: new Date('2026-07-11T00:00:00.000Z'),
        updatedAt: new Date(promocode.updatedAt),
        lifetime: null,
        expiresAt: null,
        maxActivations: quota.maxActivations,
      }),
    },
    promocodeActivation: {
      count: async () => quota.activationsBefore,
      create: async () => ({
        id: 'act-1',
        promocodeId: promocode.id,
        promocodeCode: promocode.code,
        userId: 'user-1',
        rewardType: promocode.rewardType,
        rewardValue: 7,
        targetSubscriptionId: null,
        activatedAt: new Date('2026-07-11T00:00:00.000Z'),
      }),
    },
    promocodeActivationEffect: { create: async () => ({}) },
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
    applyAction: async () => ({ applied: true, rewardValue: 7 }),
    getSuccessMessageKey: () => 'ntf-promocode-activated-duration',
  };
  return new PromocodeLifecycleService(
    prismaService as never,
    validationService as never,
    rewardsService as never,
    {
      info: (type: string, _category: string, _message: string, metadata: unknown) => {
        cards.push([type, metadata]);
      },
      error: () => undefined,
      emit: () => undefined,
    } as never,
    { enqueue: async () => undefined } as never,
  );
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

  it('raises «Промокод исчерпан» when ITS activation is the one that exhausts the code', async () => {
    // Read under the row lock, not counted again afterwards: two people
    // redeeming the last use at the same moment are serialised by the
    // `SELECT … FOR UPDATE` above, so exactly one of them sees the crossing.
    // A count taken after the commit would have given both the same answer.
    const cards: unknown[] = [];
    const promocode = buildPromocode();
    const service = activatingService(
      promocode,
      { activationsBefore: 0, maxActivations: 1 },
      cards,
    );

    const result = await service.activate({
      rawCode: promocode.code,
      userId: 'user-1',
      userTelegramId: null,
      targetSubscriptionId: null,
    });

    assert.equal(result.step, 'ACTIVATED');
    const depleted = cards.find((c) => (c as string[])[0] === 'promocode.depleted') as
      | [string, Record<string, unknown>]
      | undefined;
    assert.ok(depleted !== undefined, `no depletion card: ${JSON.stringify(cards)}`);
    assert.equal(depleted[1]['activationsCount'], 1);
    assert.equal(depleted[1]['maxActivations'], 1);
  });

  it('raises no depletion card for a code with no limit', async () => {
    // Anti-vacuity, and `isPromocodeDepleted`'s own rule rather than a second
    // statement of it: an unlimited code never runs out, so the card saying it
    // did must never be sent — no matter how many times it has been used.
    const cards: unknown[] = [];
    const promocode = buildPromocode();
    const service = activatingService(
      promocode,
      { activationsBefore: 41, maxActivations: null },
      cards,
    );

    await service.activate({
      rawCode: promocode.code,
      userId: 'user-1',
      userTelegramId: null,
      targetSubscriptionId: null,
    });

    assert.deepStrictEqual(
      cards.filter((c) => (c as string[])[0] === 'promocode.depleted'),
      [],
    );
  });

});
