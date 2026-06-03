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

    assert.deepStrictEqual(result, { success: true, message: 'Exchanged 200 points', value: 2 });
    assert.deepStrictEqual(txCalls, [
      ['user.update', { where: { id: 'user-1' }, data: { points: { decrement: 200 } } }],
      ['subscription.update', { where: { id: 'sub-1' }, data: { expiresAt: new Date('2026-05-03T00:00:00.000Z') } }],
    ]);
    assert.deepStrictEqual(queueCalls, ['sync-1']);
  });

  it('rejects disabled exchange configurations', async () => {
    const service = new ReferralPointsExchangeService({
      settings: { findFirst: async () => ({ referralSettings: { points_exchange: { exchange_enabled: false } } }) },
    } as never, {} as never);

    await assert.rejects(service.executeExchange({ userId: 'user-1', type: 'TRAFFIC', points: 50 }), BadRequestException);
  });
});
