import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { AdminReferralsController } from '../src/modules/referrals/controllers/admin-referrals.controller';
import { InternalReferralsController } from '../src/modules/referrals/controllers/internal-referrals.controller';

describe('referrals controllers', () => {
  it('exposes admin referral routes behind AdminJwtAuthGuard', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminReferralsController), 'admin/referrals');
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, AdminReferralsController), [AdminJwtAuthGuard]);
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminReferralsController.prototype.getSummary), 'summary');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, AdminReferralsController.prototype.getSummary), RequestMethod.GET);
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminReferralsController.prototype.listInvites), 'invites');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, AdminReferralsController.prototype.listInvites), RequestMethod.GET);
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminReferralsController.prototype.listRewards), 'rewards');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, AdminReferralsController.prototype.listRewards), RequestMethod.GET);
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminReferralsController.prototype.createInvite), 'invites');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, AdminReferralsController.prototype.createInvite), RequestMethod.POST);
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminReferralsController.prototype.revokeInvite), 'invites/:inviteId/revoke');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, AdminReferralsController.prototype.revokeInvite), RequestMethod.POST);
  });

  it('exposes internal referral routes behind InternalAdminAuthGuard', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalReferralsController), 'internal/referrals');
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, InternalReferralsController), [InternalAdminAuthGuard]);
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalReferralsController.prototype.getSummary), 'summary');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, InternalReferralsController.prototype.getSummary), RequestMethod.GET);
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalReferralsController.prototype.listRewards), 'rewards');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, InternalReferralsController.prototype.listRewards), RequestMethod.GET);
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalReferralsController.prototype.qualifyReferral), 'qualify');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, InternalReferralsController.prototype.qualifyReferral), RequestMethod.POST);
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalReferralsController.prototype.exchangeGiftPromocode), 'exchange/gift-promocode');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, InternalReferralsController.prototype.exchangeGiftPromocode), RequestMethod.POST);
  });

  it('delegates referral summary and invite calls unchanged', async () => {
    const calls: unknown[] = [];
    const summaryService = {
      getSummary: async (userId: string) => {
        calls.push(['summary', userId]);
        return { userId, referralCode: 'ref-1' };
      },
      listInvites: async (inviterId: string) => {
        calls.push(['listInvites', inviterId]);
        return [{ id: 'invite-1', inviterId }];
      },
      listRewards: async (userId: string) => {
        calls.push(['listRewards', userId]);
        return [{ id: 'reward-1', userId, amount: 100 }];
      },
    };
    const invitesService = {
      createInvite: async (input: unknown) => {
        calls.push(['createInvite', input]);
        return { id: 'invite-2' };
      },
      revokeInvite: async (inviteId: string) => {
        calls.push(['revokeInvite', inviteId]);
        return { id: inviteId };
      },
    };
    const qualificationService = {
      qualifyFromCompletedPurchase: async (input: unknown) => {
        calls.push(['qualify', input]);
        return { referredUserId: 'user-3', qualifiedReferralIds: ['referral-1'], rewardsIssuedCount: 1, totalRewardAmount: 100 };
      },
    };
    const exchangeService = {
      exchangeGiftPromocode: async (input: unknown) => {
        calls.push(['exchangeGiftPromocode', input]);
        return { promoCode: 'GIFT_1234ABCD', durationDays: 30, pointsSpent: 300, pointsRemaining: 50, planSnapshot: { id: 'plan-1' } };
      },
    };

    const adminController = new AdminReferralsController(summaryService as never, invitesService as never);
    assert.deepStrictEqual(await adminController.getSummary({ userId: 'user-1' } as never), { userId: 'user-1', referralCode: 'ref-1' });
    assert.deepStrictEqual(await adminController.listInvites({ inviterId: 'user-1' } as never), [{ id: 'invite-1', inviterId: 'user-1' }]);
    assert.deepStrictEqual(await adminController.listRewards({ userId: 'user-1' } as never), [{ id: 'reward-1', userId: 'user-1', amount: 100 }]);
    assert.deepStrictEqual(await adminController.createInvite({ inviterId: 'user-1' } as never), { id: 'invite-2' });
    assert.deepStrictEqual(await adminController.revokeInvite('invite-1'), { id: 'invite-1' });

    const internalController = new InternalReferralsController(summaryService as never, invitesService as never, qualificationService as never, exchangeService as never);
    assert.deepStrictEqual(await internalController.getSummary({ userId: 'user-2' } as never), { userId: 'user-2', referralCode: 'ref-1' });
    assert.deepStrictEqual(
      await internalController.qualifyReferral({ referredUserId: 'user-3', purchaseChannel: 'WEB', transactionId: 'tx-1' } as never),
      { referredUserId: 'user-3', qualifiedReferralIds: ['referral-1'], rewardsIssuedCount: 1, totalRewardAmount: 100 },
    );
    assert.deepStrictEqual(
      await internalController.exchangeGiftPromocode({ userId: 'user-3', planId: 'plan-1', durationDays: 30 } as never),
      { promoCode: 'GIFT_1234ABCD', durationDays: 30, pointsSpent: 300, pointsRemaining: 50, planSnapshot: { id: 'plan-1' } },
    );

    assert.deepStrictEqual(calls, [
      ['summary', 'user-1'],
      ['listInvites', 'user-1'],
      ['listRewards', 'user-1'],
      ['createInvite', { inviterId: 'user-1' }],
      ['revokeInvite', 'invite-1'],
      ['summary', 'user-2'],
      ['qualify', { referredUserId: 'user-3', purchaseChannel: 'WEB', transactionId: 'tx-1' }],
      ['exchangeGiftPromocode', { userId: 'user-3', planId: 'plan-1', durationDays: 30 }],
    ]);
  });
});
