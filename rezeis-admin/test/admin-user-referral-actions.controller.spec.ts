import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { REQUIRE_PERMISSION_KEY } from '../src/modules/rbac/decorators/require-permission.decorator';
import { AdminUserManagementController } from '../src/modules/users/controllers/admin-user-management.controller';

describe('AdminUserManagementController referral repair actions', () => {
  it('requires referral editing rights for repair actions that affect rewards', () => {
    assert.deepStrictEqual(
      Reflect.getMetadata(REQUIRE_PERMISSION_KEY, AdminUserManagementController.prototype.syncStealthnetReferrer),
      [{ resource: 'referrals', action: 'edit' }],
    );
    assert.deepStrictEqual(
      Reflect.getMetadata(REQUIRE_PERMISSION_KEY, AdminUserManagementController.prototype.qualifyReferral),
      [{ resource: 'referrals', action: 'edit' }],
    );
  });

  it('audits the STEALTHNET retry and manual qualification from the user card', async () => {
    const auditActions: string[] = [];
    const events: unknown[] = [];
    const syncCalls: string[] = [];
    const qualifyCalls: unknown[] = [];
    const controller = new AdminUserManagementController(
      {
        user: { findFirst: async () => ({ id: 'user-1', telegramId: 42n }) },
        adminAuditLog: { create: async ({ data }: { data: { action: string } }) => auditActions.push(data.action) },
      } as never,
      { info: (...args: unknown[]) => events.push(args) } as never,
      {} as never,
      {} as never,
      {
        qualifyReferralManually: async (input: unknown) => {
          qualifyCalls.push(input);
          return { referralId: 'referral-1', qualified: true, rewardsCreated: 1 };
        },
      } as never,
      {
        syncForUser: async (userId: string) => {
          syncCalls.push(userId);
          return { importRecordId: 'import-1', status: 'CREATED', referrerUserId: 'referrer-1' };
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const admin = { id: 'admin-1' } as never;
    const request = { headers: {}, ip: null, socket: { remoteAddress: null } } as never;

    assert.deepStrictEqual(
      await controller.syncStealthnetReferrer('42', admin, request),
      { importRecordId: 'import-1', status: 'CREATED', referrerUserId: 'referrer-1' },
    );
    assert.deepStrictEqual(
      await controller.qualifyReferral('42', admin, request),
      { referralId: 'referral-1', qualified: true, rewardsCreated: 1 },
    );

    assert.deepStrictEqual(syncCalls, ['user-1']);
    assert.deepStrictEqual(qualifyCalls, [{ referredUserId: 'user-1', actorAdminId: 'admin-1' }]);
    assert.deepStrictEqual(auditActions, [
      'user.referral.stealthnet_synced',
      'user.referral.manually_qualified',
    ]);
    assert.equal(events.length, 1, 'only a newly restored edge emits the attach event');
  });
});
