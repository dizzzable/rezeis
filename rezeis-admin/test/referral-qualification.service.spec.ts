import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PurchaseChannel, PurchaseType, ReferralRewardType } from '@prisma/client';

import { ReferralQualificationService } from '../src/modules/referrals/services/referral-qualification.service';

describe('ReferralQualificationService', () => {
  it('qualifies a referral and creates configured L1/L2 rewards after a purchase', async () => {
    const referralUpdates: unknown[] = [];
    const rewardCreates: unknown[] = [];
    const events: unknown[] = [];
    const service = new ReferralQualificationService({
      transaction: {
        findUnique: async () => ({
          id: 'tx-1',
          userId: 'referred-1',
          purchaseType: PurchaseType.NEW,
          channel: PurchaseChannel.WEB,
          planSnapshot: { id: 'plan-1' },
        }),
      },
      settings: { findFirst: async () => ({ referralSettings: {
        enabled: true,
        accrual_strategy: 'ON_FIRST_PAYMENT',
        eligible_plan_ids: ['plan-1'],
        reward: { type: 'POINTS', strategy: 'AMOUNT', config: { FIRST: 100, SECOND: 25 } },
      } }) },
      referral: {
        findUnique: async ({ where }: { readonly where: Record<string, unknown> }) => {
          if (where.referredId === 'referred-1') {
            return { id: 'referral-1', referrerId: 'referrer-1', level: 1, qualifiedAt: null };
          }
          if (where.referredId === 'referrer-1') {
            return { id: 'referral-2', referrerId: 'ancestor-1' };
          }
          return null;
        },
        update: async (args: unknown) => referralUpdates.push(args),
      },
      partner: { findUnique: async () => null },
      referralReward: { create: async (args: unknown) => rewardCreates.push(args) },
    } as never, {
      info: (...args: unknown[]) => events.push(args),
    } as never);

    await service.qualifyReferralAfterPurchase('tx-1');

    assert.equal(referralUpdates.length, 1);
    assert.deepStrictEqual(referralUpdates[0], {
      where: { id: 'referral-1' },
      data: {
        qualifiedAt: (referralUpdates[0] as { data: { qualifiedAt: Date } }).data.qualifiedAt,
        qualifiedTransactionId: 'tx-1',
        qualifiedPurchaseChannel: PurchaseChannel.WEB,
      },
    });
    assert.ok((referralUpdates[0] as { data: { qualifiedAt: unknown } }).data.qualifiedAt instanceof Date);
    assert.deepStrictEqual(rewardCreates, [
      { data: { referralId: 'referral-1', userId: 'referrer-1', type: ReferralRewardType.POINTS, amount: 100 } },
      { data: { referralId: 'referral-2', userId: 'ancestor-1', type: ReferralRewardType.POINTS, amount: 25 } },
    ]);
    assert.equal(events.length, 1);
  });

  it('skips reward creation when the referrer is an active partner', async () => {
    const rewardCreates: unknown[] = [];
    const service = new ReferralQualificationService({
      transaction: { findUnique: async () => ({ id: 'tx-1', userId: 'referred-1', purchaseType: PurchaseType.NEW, channel: PurchaseChannel.WEB, planSnapshot: {} }) },
      settings: { findFirst: async () => ({ referralSettings: { reward: { type: 'POINTS', strategy: 'AMOUNT', config: { FIRST: 100 } } } }) },
      referral: {
        findUnique: async () => ({ id: 'referral-1', referrerId: 'partner-user', level: 1, qualifiedAt: null }),
        update: async () => undefined,
      },
      partner: { findUnique: async () => ({ isActive: true }) },
      referralReward: { create: async (args: unknown) => rewardCreates.push(args) },
    } as never, { info: () => undefined } as never);

    await service.qualifyReferralAfterPurchase('tx-1');

    assert.deepStrictEqual(rewardCreates, []);
  });
});
