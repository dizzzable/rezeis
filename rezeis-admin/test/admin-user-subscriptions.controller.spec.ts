import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';

import { AdminUserSubscriptionsController } from '../src/modules/users/controllers/admin-user-subscriptions.controller';

describe('AdminUserSubscriptionsController', () => {
  it('persists and enqueues an explicit legacy subscription status update for Remnawave', async () => {
    const jobs: unknown[] = [];
    const enqueued: string[] = [];
    const controller = new AdminUserSubscriptionsController(
      {
        subscription: {
          findUnique: async () => ({
            id: 'legacy-subscription',
            expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          }),
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
          subscription: {
            update: async () => ({ id: 'legacy-subscription', remnawaveId: 'panel-user-1' }),
          },
          profileSyncJob: {
            create: async (input: unknown) => {
              jobs.push(input);
              return { id: 'sync-status-1' };
            },
          },
        }),
      } as never,
      {} as never,
      { enqueue: async (jobId: string) => enqueued.push(jobId) } as never,
      { warn: () => undefined } as never,
      {} as never,
      {} as never,
    );

    const result = await controller.updateSubscription('legacy-subscription', {
      status: SubscriptionStatus.DISABLED,
    });

    assert.deepStrictEqual(result, {
      id: 'legacy-subscription',
      remnawaveId: 'panel-user-1',
      syncPending: true,
      remnawaveLinkRequired: false,
    });
    assert.deepStrictEqual(jobs, [{
      data: {
        subscriptionId: 'legacy-subscription',
        action: SyncAction.UPDATE,
        status: SyncJobStatus.PENDING,
        payload: { source: 'ADMIN_MUTATION', propagateStatus: true },
      },
      select: { id: true },
    }]);
    assert.deepStrictEqual(enqueued, ['sync-status-1']);
  });

  it('keeps a legacy subscription local when its Remnawave link is absent instead of creating a duplicate profile', async () => {
    let jobCreated = false;
    const controller = new AdminUserSubscriptionsController(
      {
        subscription: {
          findUnique: async () => ({ id: 'unlinked-subscription', expiresAt: null }),
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
          subscription: { update: async () => ({ id: 'unlinked-subscription', remnawaveId: null }) },
          profileSyncJob: { create: async () => { jobCreated = true; return { id: 'must-not-exist' }; } },
        }),
      } as never,
      {} as never,
      { enqueue: async () => undefined } as never,
      { warn: () => undefined } as never,
      {} as never,
      {} as never,
    );

    const result = await controller.updateSubscription('unlinked-subscription', {
      status: SubscriptionStatus.DISABLED,
    });

    assert.deepStrictEqual(result, {
      id: 'unlinked-subscription',
      remnawaveId: null,
      syncPending: false,
      remnawaveLinkRequired: true,
    });
    assert.equal(jobCreated, false);
  });

  it('repairs an unlinked legacy subscription only after verifying a unique panel UUID', async () => {
    const updateCalls: unknown[] = [];
    const auditCalls: unknown[] = [];
    const controller = new AdminUserSubscriptionsController(
      {
        subscription: {
          findUnique: async () => ({
            id: 'legacy-subscription',
            userId: 'user-1',
            remnawaveId: null,
            configUrl: null,
            user: { id: 'user-1', telegramId: BigInt(42), email: null },
          }),
          findFirst: async () => null,
          update: async (input: unknown) => {
            updateCalls.push(input);
            return { id: 'legacy-subscription', remnawaveId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' };
          },
        },
        adminAuditLog: { create: async (input: unknown) => auditCalls.push(input) },
      } as never,
      {
        getPanelUser: async () => ({
          subscriptionUrl: 'https://panel.example.test/sub',
          telegramId: 42,
          email: null,
          description: null,
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const result = await controller.linkRemnawaveProfile(
      'legacy-subscription',
      { remnawaveId: ' f47ac10b-58cc-4372-a567-0e02b2c3d479 ' },
      { id: 'admin-1' } as never,
      { headers: {}, ip: null, socket: { remoteAddress: null } } as never,
    );

    assert.deepStrictEqual(result, { id: 'legacy-subscription', remnawaveId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' });
    assert.deepStrictEqual(updateCalls, [{
      where: { id: 'legacy-subscription' },
      data: { remnawaveId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', configUrl: 'https://panel.example.test/sub' },
    }]);
    assert.equal(auditCalls.length, 1);
  });

  it('rejects a malformed UUID before querying Remnawave', async () => {
    let queried = false;
    const controller = new AdminUserSubscriptionsController(
      {} as never,
      { getPanelUser: async () => { queried = true; return null; } } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await assert.rejects(
      () => controller.linkRemnawaveProfile(
        'legacy-subscription',
        { remnawaveId: 'not-a-uuid' },
        { id: 'admin-1' } as never,
        { headers: {}, ip: null, socket: { remoteAddress: null } } as never,
      ),
      { message: 'A valid Remnawave profile UUID is required' },
    );
    assert.equal(queried, false);
  });

  it('rejects linking a panel profile that is not owned by the subscription user', async () => {
    let updated = false;
    const controller = new AdminUserSubscriptionsController(
      {
        subscription: {
          findUnique: async () => ({
            id: 'legacy-subscription',
            userId: 'user-1',
            remnawaveId: null,
            configUrl: null,
            user: { id: 'user-1', telegramId: BigInt(42), email: 'owner@example.test' },
          }),
          findFirst: async () => null,
          update: async () => { updated = true; return {}; },
        },
      } as never,
      {
        getPanelUser: async () => ({
          subscriptionUrl: 'https://panel.example.test/sub',
          telegramId: 99,
          email: 'another@example.test',
          description: 'reiwa_id: another-user',
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await assert.rejects(
      () => controller.linkRemnawaveProfile(
        'legacy-subscription',
        { remnawaveId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' },
        { id: 'admin-1' } as never,
        { headers: {}, ip: null, socket: { remoteAddress: null } } as never,
      ),
      { message: 'Remnawave profile does not belong to this subscription user' },
    );
    assert.equal(updated, false);
  });
});
