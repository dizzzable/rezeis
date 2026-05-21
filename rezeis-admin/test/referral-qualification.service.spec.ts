import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PurchaseChannel, ReferralLevel } from '@prisma/client';

import { ReferralQualificationService } from '../src/modules/referrals/services/referral-qualification.service';
import { ReferralRewardsService } from '../src/modules/referrals/services/referral-rewards.service';
import { ReferralSummaryService } from '../src/modules/referrals/services/referral-summary.service';

describe('ReferralRewardsService', () => {
  it('creates a points reward and increments user points for first level rewards', async () => {
    const rewardCreates: unknown[] = [];
    const userUpdates: unknown[] = [];
    const service = new ReferralRewardsService({
      settings: { findFirst: async () => ({ referralSettings: { rewards: { level1: { enabled: true, type: 'POINTS', amount: 25 } } } }) },
      referralReward: {
        findFirst: async () => null,
        create: async (args: unknown) => {
          rewardCreates.push(args);
          return {};
        },
      },
      user: {
        update: async (args: unknown) => {
          userUpdates.push(args);
          return {};
        },
      },
    } as never);

    const rewardAmount = await service.issueRewardsForQualifiedReferral({
      referralId: 'referral-1',
      userId: 'user-1',
      level: ReferralLevel.FIRST,
    });

    assert.equal(rewardAmount, 25);
    assert.equal(rewardCreates.length, 1);
    assert.equal(JSON.stringify(rewardCreates).includes('"isIssued":true'), true);
    assert.equal(userUpdates.length, 1);
  });
});

describe('ReferralSummaryService', () => {
  it('reads referral exchange policy from the existing referral settings seam', async () => {
    const service = new ReferralSummaryService({
      settings: {
        findFirst: async () => ({
          referralSettings: {
            exchange: {
              enabled: true,
              giftPromocode: {
                enabled: true,
                allowedPlanIds: ['plan-1', 'plan-2'],
                allowedDurationDays: [30, 90],
                codePrefix: 'REF',
                costPerDay: 15,
              },
            },
          },
        }),
      },
    } as never);

    const result = await service.getExchangePolicy();

    assert.deepStrictEqual(result, {
      exchangeEnabled: true,
      giftPromocodeEnabled: true,
      allowedPlanIds: ['plan-1', 'plan-2'],
      allowedDurationDays: [30, 90],
      codePrefix: 'REF',
      costPerDay: 15,
    });
  });

  it('uses stable referral exchange policy defaults when settings are missing', async () => {
    const service = new ReferralSummaryService({
      settings: {
        findFirst: async () => null,
      },
    } as never);

    const result = await service.getExchangePolicy();

    assert.deepStrictEqual(result, {
      exchangeEnabled: false,
      giftPromocodeEnabled: false,
      allowedPlanIds: [],
      allowedDurationDays: [],
      codePrefix: 'GIFT_',
      costPerDay: 10,
    });
  });

  it('manually issues pending non-points rewards with audit', async () => {
    const transactionEvents: string[] = [];
    const service = new ReferralSummaryService({
      referralReward: {
        findUnique: async () => ({ id: 'reward-1', referralId: 'referral-1', userId: 'user-1', type: 'GIFT', amount: 10, isIssued: false, createdAt: new Date('2026-04-20T00:00:00.000Z') }),
        update: async () => { throw new Error('root reward update should not be used for manual issue'); },
      },
      adminAuditLog: { create: async () => { throw new Error('root audit create should not be used for manual issue'); } },
      $transaction: async (callback: (client: unknown) => Promise<unknown>) => {
        transactionEvents.push('transaction.begin');
        const result = await callback({
          referralReward: {
            update: async () => {
              transactionEvents.push('reward.update');
              return { id: 'reward-1', referralId: 'referral-1', userId: 'user-1', type: 'GIFT', amount: 10, isIssued: true, createdAt: new Date('2026-04-20T00:00:00.000Z') };
            },
          },
          adminAuditLog: {
            create: async (input: unknown) => {
              transactionEvents.push('audit.create');
              assert.equal(JSON.stringify(input).includes('ISSUE_REFERRAL_REWARD'), true);
            },
          },
        });
        transactionEvents.push('transaction.commit');
        return result;
      },
    } as never);

    const result = await service.issuePendingReward('reward-1', 'admin-1');

    assert.equal(result.status, 'ISSUED');
    assert.equal(result.isIssued, true);
    assert.deepStrictEqual(transactionEvents, ['transaction.begin', 'reward.update', 'audit.create', 'transaction.commit']);
  });

  it('blocks manual issue for automatic points rewards', async () => {
    let updated = false;
    const service = new ReferralSummaryService({
      referralReward: {
        findUnique: async () => ({ id: 'reward-1', referralId: 'referral-1', userId: 'user-1', type: 'POINTS', amount: 10, isIssued: false, createdAt: new Date('2026-04-20T00:00:00.000Z') }),
        update: async () => { updated = true; },
      },
    } as never);

    const result = await service.issuePendingReward('reward-1', 'admin-1');

    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, 'POINTS rewards are issued automatically.');
    assert.equal(updated, false);
  });

  it('updates referral exchange policy with bounded audit fields', async () => {
    const audits: unknown[] = [];
    const transactionEvents: string[] = [];
    let settingsState = { exchange: { enabled: false, giftPromocode: { enabled: false, allowedPlanIds: [], allowedDurationDays: [], codePrefix: 'GIFT', costPerDay: 10 } } };
    const service = new ReferralSummaryService({
      settings: {
        findFirst: async () => ({ id: 'settings-1', referralSettings: settingsState }),
        update: async () => { throw new Error('root settings update should not be used for exchange policy update'); },
      },
      adminAuditLog: { create: async () => { throw new Error('root audit create should not be used for exchange policy update'); } },
      $transaction: async (callback: (client: unknown) => Promise<unknown>) => {
        transactionEvents.push('transaction.begin');
        const result = await callback({
          settings: {
            update: async (input: { readonly data: { readonly referralSettings: typeof settingsState } }) => {
              transactionEvents.push('settings.update');
              settingsState = input.data.referralSettings;
            },
          },
          adminAuditLog: {
            create: async (input: unknown) => {
              transactionEvents.push('audit.create');
              audits.push(input);
            },
          },
        });
        transactionEvents.push('transaction.commit');
        return result;
      },
    } as never);

    const result = await service.updateExchangePolicy({
      adminUserId: 'admin-1',
      dto: { exchangeEnabled: true, giftPromocodeEnabled: true, allowedPlanIds: ['plan-1'], allowedDurationDays: [7, 30], codePrefix: 'REF', costPerDay: 12 },
    });

    assert.equal(result.exchangeEnabled, true);
    assert.equal(result.giftPromocodeEnabled, true);
    assert.deepStrictEqual(result.allowedPlanIds, ['plan-1']);
    assert.deepStrictEqual(result.allowedDurationDays, [7, 30]);
    assert.equal(result.codePrefix, 'REF');
    assert.equal(result.costPerDay, 12);
    assert.deepStrictEqual(transactionEvents, ['transaction.begin', 'settings.update', 'audit.create', 'transaction.commit']);
    assert.equal(JSON.stringify(audits).includes('UPDATE_REFERRAL_EXCHANGE_POLICY'), true);
    assert.equal(JSON.stringify(audits).includes('plan-1'), false);
  });
});

describe('ReferralQualificationService', () => {
  it('qualifies unqualified referrals and issues rewards once', async () => {
    const referralUpdates: unknown[] = [];
    const auditCreates: unknown[] = [];
    const qualificationService = new ReferralQualificationService(
      {
        user: { findUnique: async () => ({ id: 'user-1' }) },
        $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback({
          referral: {
            findMany: async () => [{ id: 'referral-1', referrerId: 'referrer-1', level: ReferralLevel.FIRST }],
            update: async (args: unknown) => {
              referralUpdates.push(args);
              return {};
            },
          },
          settings: { findFirst: async () => ({ referralSettings: {} }) },
          referralReward: {
            findFirst: async () => null,
            create: async () => ({}),
          },
          user: {
            update: async () => ({}),
          },
          adminAuditLog: {
            create: async (args: unknown) => {
              auditCreates.push(args);
              return {};
            },
          },
        }),
      } as never,
      {
        issueRewardsForQualifiedReferral: async () => 100,
      } as never as ReferralRewardsService,
    );

    const result = await qualificationService.qualifyFromCompletedPurchase({
      referredUserId: 'user-1',
      purchaseChannel: PurchaseChannel.WEB,
      transactionId: 'tx-1',
    });

    assert.deepStrictEqual(result, {
      referredUserId: 'user-1',
      qualifiedReferralIds: ['referral-1'],
      rewardsIssuedCount: 1,
      totalRewardAmount: 100,
    });
    assert.equal(referralUpdates.length, 1);
    assert.equal(auditCreates.length, 1);
    assert.equal(JSON.stringify(auditCreates).includes('QUALIFY_REFERRALS_FROM_COMPLETED_PURCHASE'), true);
    assert.equal(JSON.stringify(auditCreates).includes('tx-1'), true);
  });
});
