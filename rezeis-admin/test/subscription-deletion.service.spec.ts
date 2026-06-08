import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NotFoundException } from '@nestjs/common';
import { SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';
import fc from 'fast-check';

import { SubscriptionDeletionService } from '../src/modules/subscriptions/services/subscription-deletion.service';

interface FakeState {
  subscription: {
    id: string;
    userId: string;
    status: SubscriptionStatus;
    remnawaveId: string | null;
  } | null;
  createdJobs: Array<{ subscriptionId: string; action: SyncAction; status: SyncJobStatus }>;
  updatedStatus: SubscriptionStatus | null;
  enqueued: string[];
}

function buildService(state: FakeState) {
  const tx = {
    profileSyncJob: {
      create: async ({ data }: { data: { subscriptionId: string; action: SyncAction; status: SyncJobStatus } }) => {
        state.createdJobs.push({
          subscriptionId: data.subscriptionId,
          action: data.action,
          status: data.status,
        });
        return { id: `job-${state.createdJobs.length}` };
      },
    },
    subscription: {
      update: async ({ data }: { data: { status: SubscriptionStatus } }) => {
        state.updatedStatus = data.status;
        return {};
      },
    },
  };
  const prisma = {
    subscription: {
      findUnique: async () => state.subscription,
    },
    user: {
      findFirst: async () => ({ id: 'resolved-from-telegram' }),
    },
    $transaction: async (cb: (t: typeof tx) => Promise<string | null>) => cb(tx),
  };
  const queue = {
    enqueue: async (jobId: string) => {
      state.enqueued.push(jobId);
    },
  };
  return new SubscriptionDeletionService(prisma as never, queue as never);
}

function freshState(
  sub: FakeState['subscription'],
): FakeState {
  return { subscription: sub, createdJobs: [], updatedStatus: null, enqueued: [] };
}

describe('SubscriptionDeletionService', () => {
  it('deletes an owned active subscription: enqueues Remnawave revocation and flips status to DELETED', async () => {
    const state = freshState({
      id: 'sub-1',
      userId: 'user-1',
      status: SubscriptionStatus.ACTIVE,
      remnawaveId: 'rw-1',
    });
    const service = buildService(state);

    const result = await service.delete({ userId: 'user-1', subscriptionId: 'sub-1' });

    assert.deepStrictEqual(result, { deleted: true });
    assert.equal(state.updatedStatus, SubscriptionStatus.DELETED);
    assert.equal(state.createdJobs.length, 1);
    assert.equal(state.createdJobs[0]?.action, SyncAction.DELETE);
    assert.deepStrictEqual(state.enqueued, ['job-1']);
  });

  it('is idempotent: deleting an already-DELETED subscription is a no-op success', async () => {
    const state = freshState({
      id: 'sub-1',
      userId: 'user-1',
      status: SubscriptionStatus.DELETED,
      remnawaveId: 'rw-1',
    });
    const service = buildService(state);

    const result = await service.delete({ userId: 'user-1', subscriptionId: 'sub-1' });

    assert.deepStrictEqual(result, { deleted: true });
    assert.equal(state.updatedStatus, null);
    assert.equal(state.createdJobs.length, 0);
    assert.deepStrictEqual(state.enqueued, []);
  });

  it('skips revocation when there is no Remnawave profile, still flips status', async () => {
    const state = freshState({
      id: 'sub-1',
      userId: 'user-1',
      status: SubscriptionStatus.ACTIVE,
      remnawaveId: null,
    });
    const service = buildService(state);

    const result = await service.delete({ userId: 'user-1', subscriptionId: 'sub-1' });

    assert.deepStrictEqual(result, { deleted: true });
    assert.equal(state.updatedStatus, SubscriptionStatus.DELETED);
    assert.equal(state.createdJobs.length, 0);
    assert.deepStrictEqual(state.enqueued, []);
  });

  it('rejects deletion of a subscription owned by another user (no mutation)', async () => {
    const state = freshState({
      id: 'sub-1',
      userId: 'owner',
      status: SubscriptionStatus.ACTIVE,
      remnawaveId: 'rw-1',
    });
    const service = buildService(state);

    await assert.rejects(
      () => service.delete({ userId: 'attacker', subscriptionId: 'sub-1' }),
      NotFoundException,
    );
    assert.equal(state.updatedStatus, null);
    assert.equal(state.createdJobs.length, 0);
  });

  // Property: a delete only ever mutates a subscription whose userId equals the
  // resolved requester; any mismatch (or missing row) never transitions to DELETED.
  it('property: ownership is always enforced', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 12 }),
        fc.string({ minLength: 1, maxLength: 12 }),
        async (ownerId, requesterId) => {
          const state = freshState({
            id: 'sub-x',
            userId: ownerId,
            status: SubscriptionStatus.ACTIVE,
            remnawaveId: 'rw-x',
          });
          const service = buildService(state);
          if (ownerId === requesterId) {
            const result = await service.delete({ userId: requesterId, subscriptionId: 'sub-x' });
            assert.deepStrictEqual(result, { deleted: true });
            assert.equal(state.updatedStatus, SubscriptionStatus.DELETED);
          } else {
            await assert.rejects(() =>
              service.delete({ userId: requesterId, subscriptionId: 'sub-x' }),
            );
            assert.equal(state.updatedStatus, null);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
