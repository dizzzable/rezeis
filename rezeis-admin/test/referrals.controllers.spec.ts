import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { UserRole } from '@prisma/client';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
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

/**
 * Distinct non-null values on every field, the same discipline as `META` in
 * `admin-rewards.service.spec.ts`. This REQ flows through
 * `extractRequestMetadata` into the asserted `issue`/`bulkIssue`/
 * `manualAttach` arguments, and an all-null REQ made a hardcoded
 * `{ requestId: null, remoteAddress: null, userAgent: null }` literal
 * IMPERSONATE real extraction — proven by mutation: swapping
 * `extractRequestMetadata(req)` for that literal kept this suite green, i.e.
 * the route could stop reading the request and nothing would notice. With
 * these values the literal no longer matches, so the route has to actually
 * read the headers and the ip it was handed.
 */
const REQ_META = {
  requestId: 'req-ctrl-4f21',
  remoteAddress: '203.0.113.24',
  userAgent: 'rezeis-panel/1.2.3 (ctrl-spec)',
} as const;

const REQ = {
  headers: { 'x-request-id': REQ_META.requestId, 'user-agent': REQ_META.userAgent },
  ip: REQ_META.remoteAddress,
  socket: { remoteAddress: null },
} as never;

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
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, AdminReferralsController), [AdminJwtAuthGuard, RbacGuard]);
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
        issue: async (id: string, adminId: string, meta: unknown) => { calls.push(['issue', id, adminId, meta]); return { id }; },
        bulkIssue: async (ids: readonly string[], adminId: string, meta: unknown) => { calls.push(['bulkIssue', ids, adminId, meta]); return { issued: ids.length }; },
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
    assert.equal((await controller.issueReward('reward-1', ADMIN, REQ)).id, 'reward-1');
    assert.deepStrictEqual(await controller.bulkIssueRewards({ ids: ['reward-1', 'reward-2'] } as never, ADMIN, REQ), { issued: 2 });
    assert.equal((await controller.revokeReward('reward-1', { reason: 'duplicate' }, ADMIN)).id, 'reward-1');
    assert.deepStrictEqual(await controller.manualAttach({ userId: 'user-1', referrerId: 'referrer-1' }, ADMIN, REQ), { referralCreated: true, partnerChainAttached: false, historicalPaymentsProcessed: 0 });
    assert.deepStrictEqual(calls, [
      ['listReferrals', { referrerId: 'user-1' }],
      ['createInvite', { inviterId: 'user-1' }],
      ['revokeInvite', 'invite-1'],
      ['grant', { userId: 'user-1' }, 'admin-1'],
      // The third argument is asserted rather than omitted for the same reason
      // `manualAttach`'s `operator` is: issuing moves money and now writes a
      // `referral.reward.issued` audit row, whose ip / user-agent / requestId
      // can only come from the request. A route that quietly stopped passing it
      // would still compile against a service with a defaulted parameter and
      // would still issue rewards — it would just stop being able to say from
      // where. Pinning the shape here makes that a failure.
      ['issue', 'reward-1', 'admin-1', REQ_META],
      [
        'bulkIssue',
        ['reward-1', 'reward-2'],
        'admin-1',
        REQ_META,
      ],
      ['revoke', 'reward-1', 'duplicate', 'admin-1'],
      // UNKNOWN, and asserted rather than omitted: an admin attaching after the
      // fact never saw an invite link, and `ReferralInviteSource` has no MANUAL
      // member. Pinning it here means a later edit that quietly relabels admin
      // attaches as BOT/WEB — inflating the source breakdown with edges the
      // referral system never observed — fails instead of passing silently.
      // `operator` is asserted rather than omitted for the same reason
      // `inviteSource` is: this route had NO actor parameter at all and wrote
      // nothing, so "an operator did this" has to be visible in what the
      // controller hands the service, not merely in the route metadata.
      // `test/referral-attach-surfaces.spec.ts` pins the row it produces.
      [
        'manualAttach',
        {
          userId: 'user-1',
          referrerId: 'referrer-1',
          inviteSource: 'UNKNOWN',
          operator: {
            currentAdmin: ADMIN,
            requestMetadata: REQ_META,
            source: 'referrals_tab',
          },
        },
      ],
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
      // The permanent, reusable share code the bot and cabinet both build their
      // referral link from — NOT a single-use invite token.
      referralCode: 'user-1',
      // PUBLIC platform: the permanent code admits sign-ups, so no token needed.
      admissionRequiresInvite: false,
      // Empty `referralSettings`: the engine treats an ABSENT `enabled` as on
      // (only an explicit `false` disables), and configures no reward, so there
      // is a program to advertise but nothing to promise for taking part.
      program: { enabled: true, reward: null },
    });
  });

  /**
   * The summary’s `program` block is what a client uses to decide whether to
   * advertise the referral program AND what reward to name. Both halves are
   * claims about the payout engine, so both are pinned against the engine’s
   * own rules rather than against the JSON as written:
   *
   *   • `enabled` mirrors `qualifyReferralAfterPurchase`, where only an
   *     explicit `false` stops accrual. Reading an absent flag as OFF here
   *     would hide the program in the cabinet while rewards kept being paid.
   *   • `reward` mirrors `createConfiguredRewards`, which creates NOTHING at
   *     level 1 when the amount is zero. A zero forwarded as `{ amount: 0 }`
   *     would let a client advertise a reward that is never granted.
   *
   * The legacy case matters because the normaliser bridges two config shapes
   * and only one of them is what the admin form writes today — an install
   * carrying donor data would otherwise be told its program pays nothing.
   */
  it('reports the referral program’s state and reward exactly as the payout engine reads them', async () => {
    const summaryWith = async (referralSettings: unknown) => {
      const controller = new InternalReferralsController(
        {
          user: { findUnique: async () => ({ id: 'user-1', points: 0 }) },
          referral: { count: async () => 0, findUnique: async () => null },
          settings: { findUnique: async () => ({ referralSettings }) },
        } as never,
        {} as never,
        {} as never,
        {} as never,
      );
      const summary = await controller.getSummary('cmphfcr6i007v01jg0lcu653h');
      return summary.program;
    };

    // Form shape, switched on with a level-1 reward configured.
    assert.deepStrictEqual(
      await summaryWith({ enabled: true, rewardType: 'POINTS', level1Reward: 50, level2Reward: 10 }),
      { enabled: true, reward: { type: 'POINTS', amount: 50 } },
    );

    // Days, not points: the unit is the operator’s choice and a client that
    // hardcoded "days" or "points" would be wrong on every other install.
    assert.deepStrictEqual(
      await summaryWith({ rewardType: 'EXTRA_DAYS', level1Reward: 7 }),
      { enabled: true, reward: { type: 'EXTRA_DAYS', amount: 7 } },
    );

    // Kill-switch off. The reward stays configured in the JSON — the point is
    // that `enabled` alone has to be enough to stop a client advertising it.
    assert.deepStrictEqual(
      await summaryWith({ enabled: false, rewardType: 'POINTS', level1Reward: 50 }),
      { enabled: false, reward: { type: 'POINTS', amount: 50 } },
    );

    // Configured type, zero amount: `createConfiguredRewards` skips level 1
    // entirely, so there is no reward to name.
    assert.deepStrictEqual(
      await summaryWith({ rewardType: 'POINTS', level1Reward: 0 }),
      { enabled: true, reward: null },
    );

    // Legacy donor shape, and the legacy spelling of the kill-switch.
    assert.deepStrictEqual(
      await summaryWith({
        enable: true,
        reward: { type: 'EXTRA_DAYS', strategy: 'PERCENT', config: { FIRST: 3, SECOND: 1 } },
      }),
      // `strategy` is absent on purpose: the engine parses it and never reads
      // it, spending `FIRST` as an absolute either way.
      { enabled: true, reward: { type: 'EXTRA_DAYS', amount: 3 } },
    );

    // No user resolved: the key is still present, so a client can tell "off"
    // from "this panel is too old to say".
    const unknownUser = new InternalReferralsController(
      { user: { findUnique: async () => null } } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    assert.deepStrictEqual(
      (await unknownUser.getSummary('cmphfcr6i007v01jg0lcu000z')).program,
      { enabled: false, reward: null },
    );
  });
});
