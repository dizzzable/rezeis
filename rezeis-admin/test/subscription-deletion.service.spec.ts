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
    expiresAt?: Date | null;
  } | null;
  createdJobs: Array<{
    subscriptionId: string;
    action: SyncAction;
    status: SyncJobStatus;
    payload: unknown;
  }>;
  updatedStatus: SubscriptionStatus | null;
  enqueued: string[];
  lifecycleCalls: Array<{ kind: 'entitlements' | 'terms'; subscriptionId: string; tx: unknown }>;
  deletionWork: string[];
  lockedSubscription?: FakeState['subscription'];
}

function buildService(state: FakeState) {
  const tx = {
    $queryRaw: async () => state.lockedSubscription === undefined
      ? (state.subscription === null ? [] : [state.subscription])
      : state.lockedSubscription === null ? [] : [state.lockedSubscription],
    subscriptionEffectiveProjection: {
      updateMany: async () => {
        state.deletionWork.push('projection-deleted');
        return { count: 1 };
      },
    },
    deviceReductionPlan: {
      updateMany: async () => {
        state.deletionWork.push('device-plans-superseded');
        return { count: 1 };
      },
    },
    profileSyncJob: {
      updateMany: async () => {
        state.deletionWork.push('sync-jobs-superseded');
        return { count: 1 };
      },
      create: async ({ data }: {
        data: {
          subscriptionId: string;
          action: SyncAction;
          status: SyncJobStatus;
          payload: unknown;
        };
      }) => {
        state.deletionWork.push('delete-job-created');
        state.createdJobs.push({
          subscriptionId: data.subscriptionId,
          action: data.action,
          status: data.status,
          payload: data.payload,
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
  const entitlements = {
    terminateForSubscriptionDeletion: async (
      transaction: unknown,
      input: { subscriptionId: string },
    ) => {
      state.lifecycleCalls.push({ kind: 'entitlements', subscriptionId: input.subscriptionId, tx: transaction });
    },
  };
  const terms = {
    closeForSubscriptionDeletion: async (transaction: unknown, subscriptionId: string) => {
      state.lifecycleCalls.push({ kind: 'terms', subscriptionId, tx: transaction });
    },
  };
  return new SubscriptionDeletionService(
    prisma as never,
    queue as never,
    entitlements as never,
    terms as never,
  );
}

function freshState(
  sub: FakeState['subscription'],
): FakeState {
  return {
    subscription: sub,
    createdJobs: [],
    updatedStatus: null,
    enqueued: [],
    lifecycleCalls: [],
    deletionWork: [],
  };
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
    assert.deepEqual(
      state.lifecycleCalls.map(({ kind, subscriptionId }) => ({ kind, subscriptionId })),
      [
        { kind: 'entitlements', subscriptionId: 'sub-1' },
        { kind: 'terms', subscriptionId: 'sub-1' },
      ],
    );
    assert.equal(state.lifecycleCalls[0]?.tx, state.lifecycleCalls[1]?.tx);
    assert.deepEqual(state.deletionWork, [
      'projection-deleted',
      'device-plans-superseded',
      'sync-jobs-superseded',
      'delete-job-created',
    ]);
  });

  it('uses the same lifecycle transaction for operator deletion and returns audit context', async () => {
    const state = freshState({
      id: 'sub-admin',
      userId: 'user-7',
      status: SubscriptionStatus.ACTIVE,
      remnawaveId: 'rw-7',
    });
    const service = buildService(state);

    const result = await service.deleteByOperator('sub-admin');

    assert.deepEqual(result, {
      deleted: true,
      userId: 'user-7',
      hadRemnawaveProfile: true,
    });
    assert.deepEqual(
      state.lifecycleCalls.map(({ kind }) => kind),
      ['entitlements', 'terms'],
    );
    assert.equal(state.createdJobs.length, 1);
    assert.deepEqual(state.enqueued, ['job-1']);
  });

  it('rechecks status under the subscription lock and makes a concurrent duplicate delete a no-op', async () => {
    const state = freshState({
      id: 'sub-race',
      userId: 'user-1',
      status: SubscriptionStatus.ACTIVE,
      remnawaveId: 'rw-1',
    });
    state.lockedSubscription = {
      id: 'sub-race',
      userId: 'user-1',
      status: SubscriptionStatus.DELETED,
      remnawaveId: 'rw-1',
    };
    const service = buildService(state);

    assert.deepEqual(await service.deleteByOperator('sub-race'), {
      deleted: true,
      userId: 'user-1',
      hadRemnawaveProfile: true,
    });
    assert.equal(state.lifecycleCalls.length, 0);
    assert.equal(state.createdJobs.length, 0);
    assert.deepEqual(state.deletionWork, []);
    assert.deepEqual(state.enqueued, []);
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
    assert.equal(state.lifecycleCalls.length, 0);
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
