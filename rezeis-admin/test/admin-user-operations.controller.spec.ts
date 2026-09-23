import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AdminUserManagementController } from '../src/modules/users/controllers/admin-user-management.controller';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';

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
      undefined as never, // UserBlockService
      { listForUser: async () => [], clear: async () => undefined } as never, // DeviceIntelligenceService
      new PointsWalletService(),
      { listForUser: async () => ({ items: [], nextCursor: null }) } as never,
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

  it('marks a trial conversion withheld for refund in the payment history, and only that one', async () => {
    const queries: Array<{ select?: Record<string, boolean> }> = [];
    const payment = (id: string, gatewayData: unknown, at: string) => ({
      id, paymentId: `pay-${id}`, status: 'COMPLETED', purchaseType: 'UPGRADE',
      gatewayType: 'PLATEGA', currency: 'RUB', amount: 299, createdAt: new Date(at), gatewayData,
    });
    const controller = new AdminUserManagementController(
      {
        user: { findFirst: async () => ({ id: 'user-1' }) },
        transaction: {
          findMany: async (query: { select?: Record<string, boolean> }) => {
            queries.push(query);
            return [
              payment('withheld', { conversionWithheldAt: '2026-09-01T10:00:05.000Z', trialConvertedByPaymentId: 'pay-first' }, '2026-09-01T10:00:00.000Z'),
              payment('first', { providerStatus: 'CONFIRMED' }, '2026-08-31T10:00:00.000Z'),
            ];
          },
          count: async () => 2,
        },
        promocodeActivation: { findMany: async () => [], count: async () => 0 },
        referralPointsExchange: { findMany: async () => [], count: async () => 0 },
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
      undefined as never, // UserBlockService
      { listForUser: async () => [], clear: async () => undefined } as never, // DeviceIntelligenceService
      new PointsWalletService(),
      { listForUser: async () => ({ items: [], nextCursor: null }) } as never,
    );

    const result = await controller.listUserOperations('123', '1', '25');

    assert.equal(queries[0]?.select?.gatewayData, true, 'the mark is read from the payment, so it has to be selected');
    const [withheld, first] = result.items.map((item) => item.payload as Record<string, unknown>);
    assert.deepStrictEqual(withheld?.conversionWithheld, {
      reason: 'TRIAL_ALREADY_CONVERTED',
      withheldAt: '2026-09-01T10:00:05.000Z',
      convertedByPaymentId: 'pay-first',
      refundedAt: null,
    });
    assert.equal(first?.conversionWithheld, null);
    // Only the mark leaves the server, never the provider payloads beside it.
    assert.equal(result.items.some((item) => 'gatewayData' in (item.payload as object)), false);
  });
});
