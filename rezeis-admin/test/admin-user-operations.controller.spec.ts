import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AdminUserManagementController } from '../src/modules/users/controllers/admin-user-management.controller';

describe('AdminUserManagementController operations history', () => {
  it('merges payments, promocode activations, and point exchanges without reclassifying them as payments', async () => {
    const controller = new AdminUserManagementController(
      {
        user: { findFirst: async () => ({ id: 'user-1' }) },
        transaction: {
          findMany: async () => [{
            id: 'payment-1', paymentId: 'pay-1', status: 'COMPLETED', purchaseType: 'NEW',
            gatewayType: 'YOOKASSA', currency: 'RUB', amount: 199, createdAt: new Date('2026-07-20T10:00:00.000Z'),
          }],
          count: async () => 1,
        },
        promocodeActivation: {
          findMany: async () => [{
            id: 'promo-1', promocodeCode: 'SECRET', rewardType: 'EXTRA_DAYS', rewardValue: 7,
            activatedAt: new Date('2026-07-21T10:00:00.000Z'),
            targetSubscription: { id: 'sub-1', planSnapshot: { name: 'Unlimited' } },
          }],
          count: async () => 1,
        },
        referralPointsExchange: {
          findMany: async () => [{
            id: 'exchange-1', type: 'SUBSCRIPTION_DAYS', pointsSpent: 480, rewardValue: 32,
            expiresAtBefore: new Date('2026-07-20T00:00:00.000Z'),
            expiresAtAfter: new Date('2026-08-21T00:00:00.000Z'),
            trafficLimitBefore: null, trafficLimitAfter: null,
            personalDiscountBefore: null, personalDiscountAfter: null,
            createdAt: new Date('2026-07-22T10:00:00.000Z'),
            targetSubscription: { id: 'sub-1', planSnapshot: { name: 'Unlimited' } },
            profileSyncJob: { status: 'PENDING', lastError: null },
          }],
          count: async () => 1,
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never, // PlansAdminService
    );

    const result = await controller.listUserOperations('123', '1', '25');

    assert.equal(result.total, 3);
    assert.deepStrictEqual(result.items.map((item) => item.kind), [
      'POINTS_EXCHANGE',
      'PROMOCODE_ACTIVATION',
      'PAYMENT',
    ]);
    assert.deepStrictEqual(result.items[0], {
      id: 'exchange-1',
      kind: 'POINTS_EXCHANGE',
      occurredAt: '2026-07-22T10:00:00.000Z',
      payload: {
        type: 'SUBSCRIPTION_DAYS',
        pointsSpent: 480,
        rewardValue: 32,
        expiresAtBefore: '2026-07-20T00:00:00.000Z',
        expiresAtAfter: '2026-08-21T00:00:00.000Z',
        trafficLimitBefore: null,
        trafficLimitAfter: null,
        personalDiscountBefore: null,
        personalDiscountAfter: null,
        targetSubscription: { id: 'sub-1', label: 'Unlimited' },
        sync: { status: 'PENDING', lastError: null },
      },
    });
    assert.equal((result.items[1].payload as { codeMasked: string }).codeMasked, 'SE••••ET');
    assert.equal((result.items[2].payload as { amount: string }).amount, '199');
  });
});
