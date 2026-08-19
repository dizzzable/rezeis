import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NotFoundException } from '@nestjs/common';
import { SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';
import fc from 'fast-check';

import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { USER_EVENT_WHITELIST } from '../src/modules/realtime/interfaces/user-realtime-event.interface';
import {
  panelUserAddress,
  type StoredPanelIdentity,
} from '../src/modules/remnawave/services/panel-user-address';
import { SubscriptionDeletionService } from '../src/modules/subscriptions/services/subscription-deletion.service';

/** The subscription row as the `FOR UPDATE` read returns it. */
interface LockedRow {
  id: string;
  userId: string;
  status: SubscriptionStatus;
  remnawaveId: string | null;
  remnawavePanelId: number | null;
  remnawavePanelUsername: string | null;
  configUrl?: string | null;
  expiresAt?: Date | null;
}

type LockedRowSeed = Partial<LockedRow> &
  Pick<LockedRow, 'id' | 'userId' | 'status' | 'remnawaveId'>;

/**
 * Fills the two supplementary identity columns unless a test overrides them.
 *
 * They default to present because a real row HAS them: both 2.x and 3.x return
 * a numeric id and a username on every user read, so they accumulate long
 * before anyone upgrades. A fake row carrying only `remnawaveId` would let a
 * DELETE payload that drops them keep passing while leaving the doomed profile
 * unnameable on an upgraded panel — which is exactly the leak under test.
 */
function lockedRow(seed: LockedRowSeed): LockedRow {
  return {
    remnawavePanelId: 4471,
    remnawavePanelUsername: 'rz_bob_1',
    // NOT defaulted to a URL. `configUrl` is only ever read together with a
    // NULL `remnawaveId`, where the pair is the fingerprint of a row whose
    // panel link was lost — so filling it by default would silently mark every
    // unlinked fixture as damaged goods.
    configUrl: null,
    ...seed,
  };
}

interface FakeState {
  subscription: LockedRow | null;
  createdJobs: Array<{
    subscriptionId: string;
    action: SyncAction;
    status: SyncJobStatus;
    payload: unknown;
  }>;
  updatedStatus: SubscriptionStatus | null;
  enqueued: string[];
  enqueueError?: Error;
  emittedEvents: Array<{
    type: string;
    category: string;
    message: string;
    metadata: Readonly<Record<string, unknown>>;
  }>;
  loggedErrors: string[];
  loggedWarnings: string[];
  warnedEvents: Array<{
    type: string;
    category: string;
    message: string;
    metadata: Readonly<Record<string, unknown>>;
  }>;
  lifecycleCalls: Array<{ kind: 'entitlements' | 'terms'; subscriptionId: string; tx: unknown }>;
  deletionWork: string[];
  lockedSubscription?: LockedRow | null;
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
      if (state.enqueueError !== undefined) {
        throw state.enqueueError;
      }
      state.enqueued.push(jobId);
    },
  };
  const events = {
    info: (
      type: string,
      category: string,
      message: string,
      metadata: Readonly<Record<string, unknown>>,
    ) => {
      state.emittedEvents.push({ type, category, message, metadata });
    },
    warn: (
      type: string,
      category: string,
      message: string,
      metadata: Readonly<Record<string, unknown>>,
    ) => {
      state.warnedEvents.push({ type, category, message, metadata });
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
  const service = new SubscriptionDeletionService(
    prisma as never,
    queue as never,
    entitlements as never,
    terms as never,
    events as never,
  );
  const logger = (
    service as unknown as {
      logger: { error: (message: string) => void; warn: (message: string) => void };
    }
  ).logger;
  logger.error = (message: string) => {
    state.loggedErrors.push(message);
  };
  logger.warn = (message: string) => {
    state.loggedWarnings.push(message);
  };
  return service;
}

function freshState(
  sub: LockedRowSeed | null,
): FakeState {
  return {
    subscription: sub === null ? null : lockedRow(sub),
    createdJobs: [],
    updatedStatus: null,
    enqueued: [],
    emittedEvents: [],
    loggedErrors: [],
    loggedWarnings: [],
    warnedEvents: [],
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
    // The whole identity travels in the payload. It has to: the job outlives
    // the row, which may be re-provisioned onto a different profile — or have
    // its identity columns cleared — long before the worker reads it.
    assert.deepStrictEqual(state.createdJobs[0]?.payload, {
      source: 'SELF_SERVICE_DELETE',
      targetRemnawaveId: 'rw-1',
      targetRemnawavePanelId: 4471,
      targetRemnawavePanelUsername: 'rz_bob_1',
    });
    assert.deepStrictEqual(state.enqueued, ['job-1']);
    assert.deepStrictEqual(state.emittedEvents, [
      {
        type: EVENT_TYPES.SUBSCRIPTION_DELETED,
        category: 'SUBSCRIPTION',
        message: 'Subscription deleted',
        metadata: {
          subscriptionId: 'sub-1',
          userId: 'user-1',
          source: 'SELF_SERVICE_DELETE',
        },
      },
    ]);
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
    state.lockedSubscription = lockedRow({
      id: 'sub-race',
      userId: 'user-1',
      status: SubscriptionStatus.DELETED,
      remnawaveId: 'rw-1',
    });
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
    assert.deepEqual(state.emittedEvents, []);
  });

  it('carries the recorded numeric id in the DELETE payload when remnawaveId is a stale 2.x uuid', async () => {
    // Created on 2.x, panel since upgraded to 3.x, nothing re-synced. The
    // stored string names nothing on that panel, and by the time the worker
    // runs the row it came from may be gone — so if the numeric id does not
    // travel WITH the job, the profile is never deleted and never noticed.
    const staleUuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const state = freshState({
      id: 'sub-upgraded',
      userId: 'user-1',
      status: SubscriptionStatus.ACTIVE,
      remnawaveId: staleUuid,
      remnawavePanelId: 4471,
      remnawavePanelUsername: 'rz_bob_1',
    });
    const service = buildService(state);

    await service.delete({ userId: 'user-1', subscriptionId: 'sub-upgraded' });

    assert.equal(state.createdJobs.length, 1);
    const payload = state.createdJobs[0]?.payload as Record<string, unknown>;
    assert.equal(payload['targetRemnawaveId'], staleUuid);
    assert.equal(payload['targetRemnawavePanelId'], 4471);
    assert.equal(payload['targetRemnawavePanelUsername'], 'rz_bob_1');
    // Asserted through the real addressing function: what the payload carries
    // must be enough to BUILD a 3.x path, not merely enough to look complete.
    const fromPayload: StoredPanelIdentity = {
      remnawaveId: payload['targetRemnawaveId'] as string,
      panelId: payload['targetRemnawavePanelId'] as number | null,
      panelUsername: payload['targetRemnawavePanelUsername'] as string | null,
    };
    assert.deepStrictEqual(panelUserAddress(fromPayload, 'id'), { kind: 'ready', segment: '4471' });
    // Counter-check: `targetRemnawaveId` alone — all the payload used to carry
    // — names nothing on that panel.
    assert.equal(
      panelUserAddress({ remnawaveId: staleUuid, panelId: null, panelUsername: null }, 'id').kind,
      'impossible',
    );
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
    assert.deepStrictEqual(state.emittedEvents, []);
    assert.equal(state.lifecycleCalls.length, 0);
  });

  it('skips revocation when there is no Remnawave profile, still flips status', async () => {
    // A row that was NEVER provisioned: no id, no panel username, no config
    // URL. Spelled out rather than left to the fixture defaults, because the
    // silence here is the correct one and the test below turns on the contrast
    // between this row and one that merely LOST its id.
    const state = freshState({
      id: 'sub-1',
      userId: 'user-1',
      status: SubscriptionStatus.ACTIVE,
      remnawaveId: null,
      remnawavePanelId: null,
      remnawavePanelUsername: null,
      configUrl: null,
    });
    const service = buildService(state);

    const result = await service.delete({ userId: 'user-1', subscriptionId: 'sub-1' });

    assert.deepStrictEqual(result, { deleted: true });
    assert.equal(state.updatedStatus, SubscriptionStatus.DELETED);
    assert.equal(state.createdJobs.length, 0);
    assert.deepStrictEqual(state.enqueued, []);
    assert.equal(state.emittedEvents.length, 1);
    // Nothing was left behind, so nothing is said. An alert that also fires for
    // the ordinary case is an alert operators stop reading.
    assert.deepStrictEqual(state.warnedEvents, []);
    assert.deepStrictEqual(state.loggedWarnings, []);
  });

  it('reports the orphaned panel profile when a row with a lost link is retired', async () => {
    // THE ROW THE DECODER DEFECT LEFT BEHIND. The create/update response used to
    // be cast rather than decoded, so on 3.x `uuid` and `id` arrived undefined
    // — Prisma skips undefined columns — while the panel username and the
    // subscription URL, which came from arguments, landed. The panel profile is
    // LIVE; the row simply cannot name it.
    //
    // Retiring it takes the last thing that pointed at that profile out of
    // reach: the row is now DELETED, so it leaves the cabinet, leaves every
    // sweep, and leaves the reconciliation repair (which skips DELETED rows).
    // The customer keeps their service and stops being billed for it, and the
    // old code reported this exactly as it reports deleting a row that never
    // had a profile — `syncJobId: null`, one INFO event, nothing else.
    const state = freshState({
      id: 'sub-damaged',
      userId: 'user-7',
      status: SubscriptionStatus.ACTIVE,
      remnawaveId: null,
      remnawavePanelId: null,
      remnawavePanelUsername: 'rz_dana_1',
      configUrl: 'https://sub.example.test/api/sub/ddd',
    });
    const service = buildService(state);

    const result = await service.delete({ userId: 'user-7', subscriptionId: 'sub-damaged' });

    // The deletion itself is unchanged: still final, still no revocation job —
    // there is no identity to build one from.
    assert.deepStrictEqual(result, { deleted: true });
    assert.equal(state.updatedStatus, SubscriptionStatus.DELETED);
    assert.equal(state.createdJobs.length, 0);
    assert.deepStrictEqual(state.enqueued, []);

    // What changed is that an operator is told, and told the one fact that lets
    // them act: the name the profile still answers to in the panel.
    assert.equal(state.warnedEvents.length, 1);
    assert.equal(state.warnedEvents[0]?.category, 'SYSTEM');
    assert.equal(state.warnedEvents[0]?.metadata.panelUsername, 'rz_dana_1');
    assert.equal(state.warnedEvents[0]?.metadata.subscriptionId, 'sub-damaged');
    assert.equal(state.warnedEvents[0]?.metadata.source, 'SELF_SERVICE_DELETE');
    assert.equal(state.loggedWarnings.length, 1);
    assert.match(state.loggedWarnings[0] ?? '', /rz_dana_1/);
  });

  it('keeps the committed PENDING delete job recoverable when the immediate queue push fails', async () => {
    const state = freshState({
      id: 'sub-queue-outage',
      userId: 'user-1',
      status: SubscriptionStatus.ACTIVE,
      remnawaveId: 'rw-outage',
    });
    state.enqueueError = new Error('Redis unavailable');
    const service = buildService(state);

    const result = await service.delete({
      userId: 'user-1',
      subscriptionId: 'sub-queue-outage',
    });

    assert.deepStrictEqual(result, { deleted: true });
    assert.equal(state.updatedStatus, SubscriptionStatus.DELETED);
    assert.equal(state.createdJobs.length, 1);
    assert.equal(state.createdJobs[0]?.status, SyncJobStatus.PENDING);
    assert.deepStrictEqual(state.enqueued, []);
    assert.equal(state.emittedEvents.length, 1);
    assert.equal(state.loggedErrors.length, 1);
    assert.match(state.loggedErrors[0] ?? '', /pending-job sweep will retry it: Redis unavailable/);
  });

  it('projects subscription.deleted to its owner with subscriptionId only', () => {
    const projection = USER_EVENT_WHITELIST[EVENT_TYPES.SUBSCRIPTION_DELETED];
    assert.notEqual(projection, undefined);

    const metadata = {
      subscriptionId: 'sub-safe',
      userId: 'user-1',
      source: 'ADMIN_PANEL',
      targetRemnawaveId: 'must-not-leak',
    };
    assert.deepStrictEqual(projection?.project(metadata, { userId: 'user-1', telegramId: null }), {
      subscriptionId: 'sub-safe',
    });
    assert.equal(projection?.project(metadata, { userId: 'other-user', telegramId: null }), null);
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
