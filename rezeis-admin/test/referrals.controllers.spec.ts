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
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminReferralsController),
      'admin/referrals',
    );
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, AdminReferralsController),
      [AdminJwtAuthGuard],
    );

    // GET / — list edges
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminReferralsController.prototype.listReferrals),
      '/',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, AdminReferralsController.prototype.listReferrals),
      RequestMethod.GET,
    );

    // GET /stats
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminReferralsController.prototype.getStats),
      'stats',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, AdminReferralsController.prototype.getStats),
      RequestMethod.GET,
    );

    // GET /invites
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminReferralsController.prototype.listInvites),
      'invites',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, AdminReferralsController.prototype.listInvites),
      RequestMethod.GET,
    );

    // POST /invites
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminReferralsController.prototype.createInvite),
      'invites',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, AdminReferralsController.prototype.createInvite),
      RequestMethod.POST,
    );

    // DELETE /invites/:inviteId
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminReferralsController.prototype.revokeInvite),
      'invites/:inviteId',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, AdminReferralsController.prototype.revokeInvite),
      RequestMethod.DELETE,
    );
  });

  it('exposes internal referral routes behind InternalAdminAuthGuard', () => {
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, InternalReferralsController),
      'internal/user/:telegramId/referrals',
    );
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, InternalReferralsController),
      [InternalAdminAuthGuard],
    );
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, InternalReferralsController.prototype.getSummary),
      'summary',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, InternalReferralsController.prototype.getSummary),
      RequestMethod.GET,
    );
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, InternalReferralsController.prototype.createInvite),
      'invite',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, InternalReferralsController.prototype.createInvite),
      RequestMethod.POST,
    );
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, InternalReferralsController.prototype.executeExchange),
      'exchange',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, InternalReferralsController.prototype.executeExchange),
      RequestMethod.POST,
    );
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, InternalReferralsController.prototype.getRewards),
      'rewards',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, InternalReferralsController.prototype.getRewards),
      RequestMethod.GET,
    );
  });

  it('admin controller delegates referral list/stats/invites unchanged', async () => {
    const calls: unknown[] = [];
    const referralsService = {
      listReferrals: async (query: unknown) => {
        calls.push(['listReferrals', query]);
        return [{ id: 'ref-1' }];
      },
      getStats: async () => {
        calls.push(['getStats']);
        return {
          totalReferrals: 0,
          qualifiedReferrals: 0,
          activeInvites: 0,
          consumedInvites: 0,
          generatedAt: 'now',
        };
      },
      listInvites: async (query: unknown) => {
        calls.push(['listInvites', query]);
        return [{ id: 'invite-1' }];
      },
      createInvite: async (input: unknown) => {
        calls.push(['createInvite', input]);
        return { invite: { id: 'invite-2' } };
      },
      revokeInvite: async (inviteId: string) => {
        calls.push(['revokeInvite', inviteId]);
        return { id: inviteId };
      },
    } as never;
    const inviteLimitsService = {
      getEffectiveLimits: async () => {
        calls.push(['getEffectiveLimits']);
        return { totalSlots: 5 };
      },
      getCapacity: async (userId: string) => {
        calls.push(['getCapacity', userId]);
        return { remainingSlots: 5 };
      },
    } as never;
    const manualAttachService = {
      attachReferrerManually: async (input: unknown) => {
        calls.push(['attachReferrerManually', input]);
        return { ok: true };
      },
    } as never;

    const controller = new AdminReferralsController(
      referralsService,
      inviteLimitsService,
      manualAttachService,
    );

    assert.deepStrictEqual(
      await controller.listReferrals({ limit: 100 } as never),
      [{ id: 'ref-1' }],
    );
    assert.deepStrictEqual(await controller.getStats(), {
      totalReferrals: 0,
      qualifiedReferrals: 0,
      activeInvites: 0,
      consumedInvites: 0,
      generatedAt: 'now',
    });
    assert.deepStrictEqual(
      await controller.listInvites({ inviterId: 'user-1' } as never),
      [{ id: 'invite-1' }],
    );
    assert.deepStrictEqual(
      await controller.createInvite({ inviterId: 'user-1' } as never),
      { invite: { id: 'invite-2' } },
    );
    assert.deepStrictEqual(await controller.revokeInvite('invite-1'), { id: 'invite-1' });

    assert.deepStrictEqual(calls, [
      ['listReferrals', { limit: 100 }],
      ['getStats'],
      ['listInvites', { inviterId: 'user-1' }],
      ['createInvite', { inviterId: 'user-1' }],
      ['revokeInvite', 'invite-1'],
    ]);
  });
});
