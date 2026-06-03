import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { UserRole } from '@prisma/client';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { AdminReferralsController } from '../src/modules/referrals/controllers/admin-referrals.controller';
import { InternalReferralsController } from '../src/modules/referrals/controllers/internal-referrals.controller';

const ADMIN: CurrentAdminInterface = {
  id: 'admin-1',
  login: 'admin',
  email: 'admin@example.com',
  name: 'Admin',
  role: UserRole.ADMIN,
  isActive: true,
  tokenVersion: 1,
  createdAt: new Date('2026-04-01T00:00:00.000Z'),
  lastLoginAt: null,
  lastLoginIp: null,
  rbacRoleId: null,
  mustChangePassword: false,
};

function route(controller: object, methodName: string): { path: string; method: RequestMethod } {
  const method = Object.getPrototypeOf(controller)[methodName] as object;
  return {
    path: Reflect.getMetadata(PATH_METADATA, method) as string,
    method: Reflect.getMetadata(METHOD_METADATA, method) as RequestMethod,
  };
}

function createAdminController(overrides: {
  referrals?: object;
  inviteLimits?: object;
  manualAttach?: object;
  rewards?: object;
  analytics?: object;
  prisma?: object;
} = {}): AdminReferralsController {
  return new AdminReferralsController(
    (overrides.referrals ?? {}) as never,
    (overrides.inviteLimits ?? {}) as never,
    (overrides.manualAttach ?? {}) as never,
    (overrides.rewards ?? {}) as never,
    (overrides.analytics ?? {}) as never,
    (overrides.prisma ?? {}) as never,
  );
}

describe('Referral controllers', () => {
  it('exposes current admin and internal referral route contracts', () => {
    const admin = createAdminController();
    const internal = new InternalReferralsController({} as never, {} as never, {} as never, {} as never);

    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminReferralsController), 'admin/referrals');
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, AdminReferralsController), [AdminJwtAuthGuard]);
    assert.deepStrictEqual(route(admin, 'listReferrals'), { path: '/', method: RequestMethod.GET });
    assert.deepStrictEqual(route(admin, 'getStats'), { path: 'stats', method: RequestMethod.GET });
    assert.deepStrictEqual(route(admin, 'listInvites'), { path: 'invites', method: RequestMethod.GET });
    assert.deepStrictEqual(route(admin, 'createInvite'), { path: 'invites', method: RequestMethod.POST });
    assert.deepStrictEqual(route(admin, 'revokeInvite'), { path: 'invites/:inviteId', method: RequestMethod.DELETE });
    assert.deepStrictEqual(route(admin, 'revokeInviteAlias'), { path: 'invites/:inviteId/revoke', method: RequestMethod.POST });
    assert.deepStrictEqual(route(admin, 'listRewards'), { path: 'rewards', method: RequestMethod.GET });
    assert.deepStrictEqual(route(admin, 'grantReward'), { path: 'rewards', method: RequestMethod.POST });
    assert.deepStrictEqual(route(admin, 'issueReward'), { path: 'rewards/:rewardId/issue', method: RequestMethod.POST });
    assert.deepStrictEqual(route(admin, 'bulkIssueRewards'), { path: 'rewards/bulk-issue', method: RequestMethod.POST });
    assert.deepStrictEqual(route(admin, 'revokeReward'), { path: 'rewards/:rewardId/revoke', method: RequestMethod.POST });
    assert.deepStrictEqual(route(admin, 'manualAttach'), { path: 'manual-attach', method: RequestMethod.POST });
    assert.deepStrictEqual(route(admin, 'attach'), { path: 'attach', method: RequestMethod.POST });
    assert.deepStrictEqual(route(admin, 'getInviteLimits'), { path: 'invite-limits', method: RequestMethod.GET });
    assert.deepStrictEqual(route(admin, 'getInviteCapacity'), { path: 'invite-capacity/:userId', method: RequestMethod.GET });
    assert.deepStrictEqual(route(admin, 'getFunnel'), { path: 'analytics/funnel', method: RequestMethod.GET });
    assert.deepStrictEqual(route(admin, 'getTimeseries'), { path: 'analytics/timeseries', method: RequestMethod.GET });
    assert.deepStrictEqual(route(admin, 'getTopReferrers'), { path: 'analytics/top-referrers', method: RequestMethod.GET });
    assert.deepStrictEqual(route(admin, 'getRewardDistribution'), { path: 'analytics/reward-distribution', method: RequestMethod.GET });
    assert.deepStrictEqual(route(admin, 'getSourceBreakdown'), { path: 'analytics/source-breakdown', method: RequestMethod.GET });

    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalReferralsController), 'internal/user/:userRef/referrals');
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, InternalReferralsController), [InternalAdminAuthGuard]);
    assert.deepStrictEqual(route(internal, 'getSummary'), { path: 'summary', method: RequestMethod.GET });
    assert.deepStrictEqual(route(internal, 'getInvitedUsers'), { path: 'invited', method: RequestMethod.GET });
    assert.deepStrictEqual(route(internal, 'createInvite'), { path: 'invite', method: RequestMethod.POST });
    assert.deepStrictEqual(route(internal, 'getInviteCapacity'), { path: 'invite-capacity', method: RequestMethod.GET });
    assert.deepStrictEqual(route(internal, 'getExchangeOptions'), { path: 'exchange/options', method: RequestMethod.GET });
    assert.deepStrictEqual(route(internal, 'executeExchange'), { path: 'exchange', method: RequestMethod.POST });
    assert.deepStrictEqual(route(internal, 'getRewards'), { path: 'rewards', method: RequestMethod.GET });
  });

  it('delegates admin referral resources to current services', async () => {
    const calls: unknown[] = [];
    const controller = createAdminController({
      referrals: {
        listReferrals: async (query: unknown) => { calls.push(['listReferrals', query]); return []; },
        getStats: async () => ({ totalReferrals: 0, qualifiedReferrals: 0, activeInvites: 0, consumedInvites: 0, generatedAt: 'now', referrals: 0, invites: 0, rewards: 0, issuedRewards: 0 }),
        createInvite: async (dto: unknown) => { calls.push(['createInvite', dto]); return { invite: { id: 'invite-1' } }; },
        revokeInvite: async (id: string) => { calls.push(['revokeInvite', id]); return { id }; },
      },
      rewards: {
        grant: async (dto: unknown, adminId: string) => { calls.push(['grant', dto, adminId]); return { id: 'reward-1' }; },
        issue: async (id: string, adminId: string) => { calls.push(['issue', id, adminId]); return { id }; },
        bulkIssue: async (ids: readonly string[], adminId: string) => { calls.push(['bulkIssue', ids, adminId]); return { issued: ids.length }; },
        revoke: async (id: string, reason: string | null, adminId: string) => { calls.push(['revoke', id, reason, adminId]); return { id }; },
      },
      manualAttach: {
        attachReferrerManually: async (input: unknown) => { calls.push(['manualAttach', input]); return { referralCreated: true, partnerChainAttached: false, historicalPaymentsProcessed: 0 }; },
      },
    });

    assert.deepStrictEqual(await controller.listReferrals({ referrerId: 'user-1' }), []);
    assert.equal((await controller.createInvite({ inviterId: 'user-1' })).invite.id, 'invite-1');
    assert.equal((await controller.revokeInviteAlias('invite-1')).id, 'invite-1');
    assert.equal((await controller.grantReward({ userId: 'user-1' } as never, ADMIN)).id, 'reward-1');
    assert.equal((await controller.issueReward('reward-1', ADMIN)).id, 'reward-1');
    assert.deepStrictEqual(await controller.bulkIssueRewards({ ids: ['reward-1', 'reward-2'] } as never, ADMIN), { issued: 2 });
    assert.equal((await controller.revokeReward('reward-1', { reason: 'duplicate' }, ADMIN)).id, 'reward-1');
    assert.deepStrictEqual(await controller.manualAttach({ userId: 'user-1', referrerId: 'referrer-1' }), { referralCreated: true, partnerChainAttached: false, historicalPaymentsProcessed: 0 });
    assert.deepStrictEqual(calls, [
      ['listReferrals', { referrerId: 'user-1' }],
      ['createInvite', { inviterId: 'user-1' }],
      ['revokeInvite', 'invite-1'],
      ['grant', { userId: 'user-1' }, 'admin-1'],
      ['issue', 'reward-1', 'admin-1'],
      ['bulkIssue', ['reward-1', 'reward-2'], 'admin-1'],
      ['revoke', 'reward-1', 'duplicate', 'admin-1'],
      ['manualAttach', { userId: 'user-1', referrerId: 'referrer-1' }],
    ]);
  });

  it('internal controller resolves users and shapes user-facing referral summary', async () => {
    const controller = new InternalReferralsController(
      {
        user: { findUnique: async () => ({ id: 'user-1', points: 250 }) },
        referral: {
          count: async ({ where }: { readonly where: Record<string, unknown> }) =>
            where.qualifiedAt ? 2 : 5,
        },
        settings: { findUnique: async () => ({ referralSettings: {} }) },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    assert.deepStrictEqual(await controller.getSummary('cmphfcr6i007v01jg0lcu653h'), {
      totalReferrals: 5,
      qualifiedReferrals: 2,
      pointsBalance: 250,
      programAvailable: true,
    });
  });
});
