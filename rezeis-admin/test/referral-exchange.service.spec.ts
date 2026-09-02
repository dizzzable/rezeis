import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';

import { ReferralPointsExchangeService } from '../src/modules/referrals/services/referral-points-exchange.service';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';

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
    } as never, {} as never, new PointsWalletService());

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

  it('reads the camelCase pointsExchange shape persisted by the admin panel', async () => {
    // The admin SPA saves `referralSettings.pointsExchange.*` in camelCase and
    // does NOT send a per-type `minPoints`. The reader must honour this shape
    // (otherwise `exchangeEnabled` resolves false → "exchange unavailable") and
    // default the per-type floor to `pointsCost`.
    const camelSettings = {
      pointsExchange: {
        exchangeEnabled: true,
        subscriptionDays: { enabled: true, pointsCost: 5 },
        giftSubscription: { enabled: true, pointsCost: 150, giftDurationDays: 30, giftPlanId: 'plan-x' },
        discount: { enabled: true, pointsCost: 10, maxDiscountPercent: 50 },
        traffic: { enabled: true, pointsCost: 15, maxTrafficGb: 100 },
      },
    };
    const service = new ReferralPointsExchangeService({
      user: { findUnique: async () => ({ points: 25 }) },
      settings: { findFirst: async () => ({ referralSettings: camelSettings }) },
    } as never, {} as never, new PointsWalletService());

    const result = await service.getExchangeOptions('user-1');

    assert.equal(result.exchangeEnabled, true);
    const days = result.types.find((type) => type.type === 'SUBSCRIPTION_DAYS');
    assert.deepStrictEqual(days, {
      type: 'SUBSCRIPTION_DAYS',
      enabled: true,
      available: true, // balance 25 >= minPoints (defaulted to pointsCost 5)
      pointsCost: 5,
      minPoints: 5,
      maxPoints: -1,
      computedValue: 5,
    });
  });

  it('rejects unknown users before exposing options', async () => {
    const service = new ReferralPointsExchangeService({
      user: { findUnique: async () => null },
      settings: { findFirst: async () => ({ referralSettings }) },
    } as never, {} as never, new PointsWalletService());

    await assert.rejects(service.getExchangeOptions('missing-user'), NotFoundException);
  });

  it('executes subscription-day exchanges atomically and enqueues profile sync after commit', async () => {
    const txCalls: unknown[] = [];
    const queueCalls: string[] = [];
    const service = new ReferralPointsExchangeService({
      settings: { findFirst: async () => ({ referralSettings }) },
      user: { findUnique: async () => ({ id: 'user-1', points: 250, currentSubscriptionId: 'sub-1' }) },
      subscription: {
        findUnique: async () => ({ remnawaveId: 'rw-1' }),
        findFirst: async () => ({ id: 'sub-1' }),
      },
      profileSyncJob: { create: async () => ({ id: 'sync-1' }) },
      $transaction: async (callback: (tx: unknown) => Promise<void>) => callback({
        $queryRaw: async () => [],
        user: {
          findUnique: async () => ({ id: 'user-1', currentSubscriptionId: 'sub-1' }),
          updateMany: async (args: unknown) => {
            txCalls.push(['user.updateMany', args]);
            return { count: 1 };
          },
        },
        subscription: {
          findFirst: async () => ({ id: 'sub-1' }),
          findUnique: async () => ({ id: 'sub-1', userId: 'user-1', expiresAt: new Date('2026-05-01T00:00:00.000Z'), trafficLimit: 100, remnawaveId: 'rw-1', status: SubscriptionStatus.ACTIVE }),
          update: async (args: unknown) => txCalls.push(['subscription.update', args]),
        },
        promocode: { create: async (args: unknown) => txCalls.push(['promocode.create', args]) },
        profileSyncJob: { create: async () => ({ id: 'sync-1' }) },
        referralPointsExchange: {
          create: async (args: unknown) => {
            txCalls.push(['referralPointsExchange.create', args]);
            return { id: 'exchange-1' };
          },
        },
        pointsLedgerEntry: {
          findUnique: async () => null,
          create: async (args: unknown) => {
            txCalls.push(['pointsLedgerEntry.create', args]);
            return { id: 'ledger-1' };
          },
        },
      }),
    } as never, {
      enqueue: async (jobId: string) => queueCalls.push(jobId),
    } as never, new PointsWalletService());

    const result = await service.executeExchange({ userId: 'user-1', type: 'SUBSCRIPTION_DAYS', points: 200, subscriptionId: 'sub-1' });

    assert.deepStrictEqual(result, { success: true, message: 'Exchanged 200 points', value: 2, code: undefined, syncPending: true });
    assert.deepStrictEqual(txCalls[0], ['user.updateMany', { where: { id: 'user-1', points: { gte: 200 } }, data: { points: { decrement: 200 } } }]);
    // The spend went through the wallet: one ledger row keyed on the exchange
    // record, and the record is created with THAT id so the two agree.
    const ledgerRow = txCalls.find((c) => Array.isArray(c) && c[0] === 'pointsLedgerEntry.create') as [string, { data: Record<string, unknown> }];
    const exchangeRow = txCalls.find((c) => Array.isArray(c) && c[0] === 'referralPointsExchange.create') as [string, { data: Record<string, unknown> }];
    assert.ok(ledgerRow, 'the spend left a ledger row');
    assert.equal(ledgerRow[1].data.delta, -200);
    assert.equal(ledgerRow[1].data.source, 'EXCHANGE');
    assert.deepStrictEqual(ledgerRow[1].data.details, { exchangeType: 'SUBSCRIPTION_DAYS' });
    assert.equal(typeof ledgerRow[1].data.referenceKey, 'string');
    assert.equal(exchangeRow[1].data.id, ledgerRow[1].data.referenceKey, 'the ledger names the exchange record it paid for');
    const extension = txCalls.find((call) => Array.isArray(call) && call[0] === 'subscription.update') as [string, { data: { expiresAt: Date } }];
    assert.ok(extension[1].data.expiresAt.getTime() >= Date.now() + 2 * 24 * 60 * 60 * 1000 - 1_000);
    assert.deepStrictEqual(queueCalls, ['sync-1']);
  });

  it('rejects a lifetime subscription instead of silently converting it into a finite term', async () => {
    const txCalls: unknown[] = [];
    const queueCalls: string[] = [];
    const findFirstCalls: unknown[] = [];
    const service = new ReferralPointsExchangeService({
      settings: { findFirst: async () => ({ referralSettings }) },
      user: { findUnique: async () => ({ id: 'user-1', points: 250, currentSubscriptionId: null }) },
      subscription: {
        findUnique: async () => ({ remnawaveId: 'rw-1' }),
        findFirst: async (args: unknown) => {
          findFirstCalls.push(args);
          return { id: 'active-sub-9' };
        },
      },
      profileSyncJob: { create: async () => ({ id: 'sync-2' }) },
      $transaction: async (callback: (tx: unknown) => Promise<void>) => callback({
        $queryRaw: async () => [],
        user: {
          findUnique: async () => ({ id: 'user-1', currentSubscriptionId: null }),
          updateMany: async (args: unknown) => {
            txCalls.push(['user.updateMany', args]);
            return { count: 1 };
          },
        },
        subscription: {
          findFirst: async (args: unknown) => {
            findFirstCalls.push(args);
            return { id: 'active-sub-9' };
          },
          findUnique: async () => ({ id: 'active-sub-9', userId: 'user-1', expiresAt: null, trafficLimit: null, remnawaveId: 'rw-1', status: SubscriptionStatus.ACTIVE }),
          update: async (args: unknown) => txCalls.push(['subscription.update', args]),
        },
      }),
    } as never, {
      enqueue: async (jobId: string) => queueCalls.push(jobId),
    } as never, new PointsWalletService());

    await assert.rejects(
      service.executeExchange({ userId: 'user-1', type: 'SUBSCRIPTION_DAYS', points: 200 }),
      BadRequestException,
    );
    assert.ok(findFirstCalls.length >= 1);
    assert.deepStrictEqual(txCalls, []);
    assert.deepStrictEqual(queueCalls, []);
  });

  it('refuses to spend points on an unlinked legacy subscription', async () => {
    const txCalls: unknown[] = [];
    const service = new ReferralPointsExchangeService({
      settings: { findFirst: async () => ({ referralSettings }) },
      user: { findUnique: async () => ({ id: 'user-1', points: 250, currentSubscriptionId: 'legacy-sub' }) },
      $transaction: async (callback: (tx: unknown) => Promise<void>) => callback({
        $queryRaw: async () => [],
        user: {
          findUnique: async () => ({ id: 'user-1', currentSubscriptionId: 'legacy-sub' }),
          updateMany: async (args: unknown) => {
            txCalls.push(['user.updateMany', args]);
            return { count: 1 };
          },
        },
        subscription: {
          findFirst: async () => ({ id: 'legacy-sub' }),
          findUnique: async () => ({
            id: 'legacy-sub',
            userId: 'user-1',
            expiresAt: new Date('2026-05-01T00:00:00.000Z'),
            trafficLimit: 100,
            remnawaveId: null,
            status: SubscriptionStatus.ACTIVE,
          }),
        },
      }),
    } as never, {} as never, new PointsWalletService());

    await assert.rejects(
      service.executeExchange({ userId: 'user-1', type: 'SUBSCRIPTION_DAYS', points: 100, subscriptionId: 'legacy-sub' }),
      { message: 'Subscription needs a Remnawave profile repair before points can be exchanged' },
    );
    assert.deepStrictEqual(txCalls, []);
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
        user: {
          findUnique: async () => ({ id: 'user-1' }),
          updateMany: async (args: unknown) => {
            txCalls.push(['user.updateMany', args]);
            return { count: 1 };
          },
        },
        plan: {
          findUnique: async () => ({
            id: 'plan-x',
            name: 'Gift Plan',
            tag: null,
            type: 'BASE',
            icon: 'zap',
            trafficLimit: 100,
            deviceLimit: 3,
            trafficLimitStrategy: 'NO_RESET',
            internalSquads: ['squad-1'],
            externalSquad: null,
          }),
        },
        promocode: {
          create: async (args: unknown) => {
            txCalls.push(['promocode.create', args]);
            return { id: 'gift-promo-1' };
          },
        },
        referralPointsExchange: { create: async () => ({ id: 'exchange-gift-1' }) },
        pointsLedgerEntry: { findUnique: async () => null, create: async () => ({ id: 'ledger-1' }) },
      }),
    } as never, {} as never, new PointsWalletService());

    // User typed 1000 points, but a gift is a fixed-price item: charge exactly
    // points_cost (500) and mint one code.
    const result = await service.executeExchange({ userId: 'user-1', type: 'GIFT_SUBSCRIPTION', points: 1000 });

    assert.equal(result.success, true);
    assert.equal(result.value, 1);
    assert.equal(typeof result.code, 'string');
    assert.match(result.code as string, /^GIFT-[A-Z0-9]{8}$/);

    const deduct = txCalls.find((c) => Array.isArray(c) && c[0] === 'user.updateMany') as [string, { data: { points: { decrement: number } } }];
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
      icon: 'zap',
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
          updateMany: async (args: unknown) => {
            txCalls.push(['user.updateMany', args]);
            return { count: 1 };
          },
          update: async (args: unknown) => txCalls.push(['user.update', args]),
          findUnique: async () => ({ id: 'user-1', personalDiscount: 45 }),
        },
        referralPointsExchange: { create: async () => ({ id: 'exchange-discount-1' }) },
        pointsLedgerEntry: { findUnique: async () => null, create: async () => ({ id: 'ledger-1' }) },
      }),
    } as never, {} as never, new PointsWalletService());

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
    } as never, {} as never, new PointsWalletService());

    await assert.rejects(service.executeExchange({ userId: 'user-1', type: 'TRAFFIC', points: 50 }), BadRequestException);
  });

  it('replays an idempotent exchange after configuration changes', async () => {
    let loadedSettings = false;
    const service = new ReferralPointsExchangeService({
      referralPointsExchange: {
        findUnique: async () => ({
          pointsSpent: 200,
          rewardValue: 2,
          profileSyncJobId: 'sync-1',
          giftPromocode: null,
        }),
      },
      settings: {
        findFirst: async () => {
          loadedSettings = true;
          return { referralSettings: { points_exchange: { exchange_enabled: false } } };
        },
      },
    } as never, {} as never, new PointsWalletService());

    const result = await service.executeExchange({
      userId: 'user-1',
      type: 'SUBSCRIPTION_DAYS',
      points: 200,
      idempotencyKey: 'retry-after-settings-change',
    });

    assert.deepStrictEqual(result, {
      success: true,
      message: 'Exchanged 200 points',
      value: 2,
      code: undefined,
      syncPending: true,
    });
    assert.equal(loadedSettings, false);
  });
});
