import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';

import { ReferralPointsExchangeService } from '../src/modules/referrals/services/referral-points-exchange.service';

const referralSettings = {
  points_exchange: {
    exchange_enabled: true,
    subscription_days: { enabled: true, points_cost: 100, min_points: 100, max_points: -1 },
    traffic: { enabled: true, points_cost: 50, min_points: 50, max_points: 500, max_traffic_gb: 100 },
  },
};

describe('ReferralPointsExchangeService', () => {
  it('returns exchange options from current settings JSON', async () => {
    const service = new ReferralPointsExchangeService({
      user: { findUnique: async () => ({ points: 250 }) },
      settings: { findFirst: async () => ({ referralSettings }) },
    } as never, {} as never);

    const result = await service.getExchangeOptions('user-1');

    assert.equal(result.exchangeEnabled, true);
    assert.equal(result.pointsBalance, 250);
    assert.deepStrictEqual(result.types.find((type) => type.type === 'SUBSCRIPTION_DAYS'), {
      type: 'SUBSCRIPTION_DAYS',
      enabled: true,
      available: true,
      pointsCost: 100,
      minPoints: 100,
      maxPoints: -1,
      computedValue: 2,
    });
  });

  it('rejects unknown users before exposing options', async () => {
    const service = new ReferralPointsExchangeService({
      user: { findUnique: async () => null },
      settings: { findFirst: async () => ({ referralSettings }) },
    } as never, {} as never);

    await assert.rejects(service.getExchangeOptions('missing-user'), NotFoundException);
  });

  it('executes subscription-day exchanges atomically and enqueues profile sync after commit', async () => {
    const txCalls: unknown[] = [];
    const queueCalls: string[] = [];
    const service = new ReferralPointsExchangeService({
      settings: { findFirst: async () => ({ referralSettings }) },
      user: { findUnique: async () => ({ id: 'user-1', points: 250, currentSubscriptionId: 'sub-1' }) },
      subscription: { findUnique: async () => ({ remnawaveId: 'rw-1' }) },
      profileSyncJob: { create: async () => ({ id: 'sync-1' }) },
      $transaction: async (callback: (tx: unknown) => Promise<void>) => callback({
        user: { update: async (args: unknown) => txCalls.push(['user.update', args]) },
        subscription: {
          findUnique: async () => ({ id: 'sub-1', expiresAt: new Date('2026-05-01T00:00:00.000Z'), status: SubscriptionStatus.ACTIVE }),
          update: async (args: unknown) => txCalls.push(['subscription.update', args]),
        },
        promocode: { create: async (args: unknown) => txCalls.push(['promocode.create', args]) },
      }),
    } as never, {
      enqueue: async (jobId: string) => queueCalls.push(jobId),
    } as never);

    const result = await service.executeExchange({ userId: 'user-1', type: 'SUBSCRIPTION_DAYS', points: 200 });

    assert.deepStrictEqual(result, { success: true, message: 'Exchanged 200 points', value: 2, code: undefined });
    assert.deepStrictEqual(txCalls, [
      ['user.update', { where: { id: 'user-1' }, data: { points: { decrement: 200 } } }],
      ['subscription.update', { where: { id: 'sub-1' }, data: { expiresAt: new Date('2026-05-03T00:00:00.000Z') } }],
    ]);
    assert.deepStrictEqual(queueCalls, ['sync-1']);
  });

  it('mints a single-use gift promo code with a complete plan snapshot and charges exactly the points cost', async () => {
    const giftSettings = {
      points_exchange: {
        exchange_enabled: true,
        gift_subscription: {
          enabled: true,
          points_cost: 500,
          min_points: 500,
          max_points: -1,
          gift_plan_id: 'plan-x',
          gift_duration_days: 30,
        },
      },
    };
    const txCalls: unknown[] = [];
    const service = new ReferralPointsExchangeService({
      settings: { findFirst: async () => ({ referralSettings: giftSettings }) },
      user: { findUnique: async () => ({ id: 'user-1', points: 1200, currentSubscriptionId: null }) },
      $transaction: async (callback: (tx: unknown) => Promise<void>) => callback({
        user: { update: async (args: unknown) => txCalls.push(['user.update', args]) },
        plan: {
          findUnique: async () => ({
            id: 'plan-x',
            name: 'Gift Plan',
            tag: null,
            type: 'BASE',
            trafficLimit: 100,
            deviceLimit: 3,
            trafficLimitStrategy: 'NO_RESET',
            internalSquads: ['squad-1'],
            externalSquad: null,
          }),
        },
        promocode: { create: async (args: unknown) => txCalls.push(['promocode.create', args]) },
      }),
    } as never, {} as never);

    // User typed 1000 points, but a gift is a fixed-price item: charge exactly
    // points_cost (500) and mint one code.
    const result = await service.executeExchange({ userId: 'user-1', type: 'GIFT_SUBSCRIPTION', points: 1000 });

    assert.equal(result.success, true);
    assert.equal(result.value, 1);
    assert.equal(typeof result.code, 'string');
    assert.match(result.code as string, /^GIFT-[A-Z0-9]{8}$/);

    const deduct = txCalls.find((c) => Array.isArray(c) && c[0] === 'user.update') as [string, { data: { points: { decrement: number } } }];
    assert.equal(deduct[1].data.points.decrement, 500);

    const created = txCalls.find((c) => Array.isArray(c) && c[0] === 'promocode.create') as [string, { data: { plan: Record<string, unknown>; rewardType: string; reward: number; maxActivations: number } }];
    assert.equal(created[1].data.rewardType, 'SUBSCRIPTION');
    assert.equal(created[1].data.reward, 30);
    assert.equal(created[1].data.maxActivations, 1);
    assert.deepStrictEqual(created[1].data.plan, {
      id: 'plan-x',
      name: 'Gift Plan',
      tag: null,
      type: 'BASE',
      trafficLimit: 100,
      deviceLimit: 3,
      trafficLimitStrategy: 'NO_RESET',
      internalSquads: ['squad-1'],
      externalSquad: null,
      duration: 30,
    });
  });

  it('clamps the cumulative personal discount to the configured cap', async () => {
    const discountSettings = {
      points_exchange: {
        exchange_enabled: true,
        discount: { enabled: true, points_cost: 10, min_points: 10, max_points: -1, max_discount_percent: 50 },
      },
    };
    const txCalls: unknown[] = [];
    const service = new ReferralPointsExchangeService({
      settings: { findFirst: async () => ({ referralSettings: discountSettings }) },
      user: { findUnique: async () => ({ id: 'user-1', points: 1000, currentSubscriptionId: null }) },
      $transaction: async (callback: (tx: unknown) => Promise<void>) => callback({
        user: {
          update: async (args: unknown) => txCalls.push(['user.update', args]),
          findUnique: async () => ({ personalDiscount: 45 }),
        },
      }),
    } as never, {} as never);

    // 200 points / 10 = 20%, but capped: 45 + 20 → clamp to 50 (not 65).
    await service.executeExchange({ userId: 'user-1', type: 'DISCOUNT', points: 200 });

    const setDiscount = txCalls.find(
      (c) => Array.isArray(c) && c[0] === 'user.update' && 'personalDiscount' in (c[1] as { data: Record<string, unknown> }).data,
    ) as [string, { data: { personalDiscount: number } }];
    assert.equal(setDiscount[1].data.personalDiscount, 50);
  });

  it('rejects disabled exchange configurations', async () => {
    const service = new ReferralPointsExchangeService({
      settings: { findFirst: async () => ({ referralSettings: { points_exchange: { exchange_enabled: false } } }) },
    } as never, {} as never);

    await assert.rejects(service.executeExchange({ userId: 'user-1', type: 'TRAFFIC', points: 50 }), BadRequestException);
  });
});
