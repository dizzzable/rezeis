import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ReferralExchangeService } from '../src/modules/referrals/services/referral-exchange.service';

describe('ReferralExchangeService', () => {
  it('creates a one-time gift promocode and debits referral points', async () => {
    const userUpdates: unknown[] = [];
    const promoCreates: unknown[] = [];
    const service = new ReferralExchangeService({
      settings: {
        findFirst: async () => ({
          referralSettings: {
            exchange: {
              enabled: true,
              giftPromocode: {
                enabled: true,
                allowedPlanIds: ['plan-1'],
                allowedDurationDays: [30],
                codePrefix: 'GIFT_',
                maxGenerateAttempts: 5,
                costPerDay: 10,
              },
            },
          },
        }),
      },
      $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback({
        user: {
          findUnique: async () => ({ id: 'user-1', points: 500 }),
          update: async (args: unknown) => {
            userUpdates.push(args);
            return {};
          },
        },
        plan: {
          findUnique: async () => ({
            id: 'plan-1',
            name: 'Starter',
            tag: null,
            type: 'BOTH',
            trafficLimit: 1024,
            deviceLimit: 1,
            trafficLimitStrategy: 'NO_RESET',
            isActive: true,
            isArchived: false,
          }),
        },
        promoCode: {
          findUnique: async () => null,
          create: async (args: unknown) => {
            promoCreates.push(args);
            return {};
          },
        },
      }),
    } as never);

    const result = await service.exchangeGiftPromocode({
      userId: 'user-1',
      planId: 'plan-1',
      durationDays: 30,
    });

    assert.equal(result.durationDays, 30);
    assert.equal(result.pointsSpent, 300);
    assert.equal(result.pointsRemaining, 200);
    assert.equal(typeof result.promoCode, 'string');
    assert.ok(result.promoCode.startsWith('GIFT_'));
    assert.equal(userUpdates.length, 1);
    assert.equal(promoCreates.length, 1);
  });
});
