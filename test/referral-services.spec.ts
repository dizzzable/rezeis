import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ReferralInvitesService } from '../src/modules/referrals/services/referral-invites.service';
import { ReferralSummaryService } from '../src/modules/referrals/services/referral-summary.service';

describe('ReferralSummaryService', () => {
  it('builds referral summary from user, invites, referrals, and rewards', async () => {
    const service = new ReferralSummaryService({
      user: {
        findUnique: async () => ({ id: 'user-1', referralCode: 'ref-1', points: 42 }),
      },
      referralInvite: {
        count: async () => 2,
        findMany: async () => [],
      },
      referral: {
        count: async (args: { where: { qualifiedAt?: unknown } }) =>
          args.where.qualifiedAt ? 1 : 3,
      },
      referralReward: {
        count: async (args: { where: { isIssued: boolean } }) => (args.where.isIssued ? 2 : 1),
        aggregate: async () => ({ _sum: { amount: 150 } }),
      },
    } as never);

    const result = await service.getSummary('user-1');

    assert.deepStrictEqual(result, {
      userId: 'user-1',
      referralCode: 'ref-1',
      referralPointsBalance: 42,
      activeInvitesCount: 2,
      totalReferrals: 3,
      qualifiedReferrals: 1,
      issuedRewardsCount: 2,
      pendingRewardsCount: 1,
      totalRewardAmount: 150,
    });
  });

  it('lists referral rewards newest first', async () => {
    const service = new ReferralSummaryService({
      referralReward: {
        findMany: async () => [
          {
            id: 'reward-2',
            referralId: 'referral-1',
            userId: 'user-1',
            type: 'POINTS',
            amount: 100,
            isIssued: true,
            createdAt: new Date('2026-04-20T00:00:00.000Z'),
          },
        ],
      },
    } as never);

    const result = await service.listRewards('user-1');

    assert.deepStrictEqual(result, [
      {
        id: 'reward-2',
        referralId: 'referral-1',
        userId: 'user-1',
        type: 'POINTS',
        amount: 100,
        isIssued: true,
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
  });
});

describe('ReferralInvitesService', () => {
  it('creates invite using settings defaults when ttl is omitted', async () => {
    const createCalls: unknown[] = [];
    const service = new ReferralInvitesService({
      user: { findUnique: async () => ({ id: 'user-1' }) },
      settings: { findFirst: async () => ({ referralSettings: { invites: { maxActiveInvitesPerUser: 5, ttlHours: 24 } } }) },
      referralInvite: {
        count: async () => 0,
        findUnique: async () => null,
        create: async (args: { data: Record<string, unknown> }) => {
          createCalls.push(args.data);
          return {
            id: 'invite-1',
            inviterId: 'user-1',
            token: String(args.data.token),
            expiresAt: args.data.expiresAt as Date,
            revokedAt: null,
            createdAt: new Date('2026-04-20T00:00:00.000Z'),
          };
        },
      },
    } as never);

    const result = await service.createInvite({ inviterId: 'user-1' });

    assert.equal(result.inviterId, 'user-1');
    assert.equal(result.revokedAt, null);
    assert.equal(createCalls.length, 1);
  });

  it('revokes an existing invite', async () => {
    const service = new ReferralInvitesService({
      referralInvite: {
        findUnique: async () => ({ id: 'invite-1' }),
        update: async () => ({
          id: 'invite-1',
          inviterId: 'user-1',
          token: 'TOKEN1234',
          expiresAt: new Date('2026-04-21T00:00:00.000Z'),
          revokedAt: new Date('2026-04-20T12:00:00.000Z'),
          createdAt: new Date('2026-04-20T00:00:00.000Z'),
        }),
      },
    } as never);

    const result = await service.revokeInvite('invite-1');

    assert.equal(result.id, 'invite-1');
    assert.equal(result.inviterId, 'user-1');
    assert.ok(result.revokedAt !== null);
  });
});
