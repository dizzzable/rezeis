import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';

import { ProfileSyncProcessor } from '../src/modules/profile-sync/profile-sync.processor';

/**
 * T-009a — versioned profile-sync convergence (flag-gated by
 * ADDON_PROJECTION_SYNC).
 *
 * A "versioned" ProfileSyncJob carries `aggregateKey` (= subscriptionId) and a
 * `desiredRevision`. The authoritative latest desired revision lives on
 * `SubscriptionEffectiveProjection`. When projection-sync is enabled:
 *  - a job whose `desiredRevision` is behind the projection's latest revision
 *    supersedes ITSELF (marks `supersededAt`, terminal) and never pushes a
 *    stale limit to the panel;
 *  - a job that IS the latest applies and supersedes any older-revision
 *    non-terminal sibling jobs for the same aggregate, so only the newest
 *    desired state converges upstream.
 *
 * With the flag OFF (default) versioned jobs behave exactly like today.
 */

const ORIGINAL_FLAG = process.env['ADDON_PROJECTION_SYNC'];

function enableFlag(): void {
  process.env['ADDON_PROJECTION_SYNC'] = 'true';
}

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) {
    delete process.env['ADDON_PROJECTION_SYNC'];
  } else {
    process.env['ADDON_PROJECTION_SYNC'] = ORIGINAL_FLAG;
  }
});

function versionedUpdateJob(desiredRevision: bigint) {
  return {
    id: 'sync-job-versioned',
    action: SyncAction.UPDATE,
    status: SyncJobStatus.PENDING,
    attempts: 0,
    supersededAt: null,
    aggregateKey: 'subscription-1',
    desiredRevision,
    subscription: {
      id: 'subscription-1',
      userId: 'user-1',
      remnawaveId: 'rem-user-1',
      trafficLimit: 10,
      deviceLimit: 3,
      internalSquads: [],
      externalSquad: null,
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      planSnapshot: {},
    },
  };
}

describe('ProfileSyncProcessor versioned convergence (T-009a)', () => {
  it('supersedes a stale-revision job without calling Remnawave when the projection is ahead', async () => {
    enableFlag();
    const jobUpdates: Array<Record<string, unknown>> = [];
    let upstreamCalled = false;
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => versionedUpdateJob(2n),
          updateMany: async (input: { data: Record<string, unknown> }) => {
            jobUpdates.push(input.data);
            return { count: 1 };
          },
          update: async () => undefined,
        },
        subscriptionEffectiveProjection: {
          findUnique: async () => ({ desiredRevision: 5n }),
        },
      } as never,
      { updatePanelUser: async () => { upstreamCalled = true; } } as never,
      { generateProfileName: async () => ({ username: 'rz', description: 'd' }), getContactInfo: async () => ({ email: null, telegramId: null }) } as never,
      { error: () => undefined, info: () => undefined } as never,
    );

    await processor.process({ data: { syncJobId: 'sync-job-versioned' } } as never);

    assert.equal(upstreamCalled, false, 'a stale revision must not push to the panel');
    const supersede = jobUpdates.find((d) => d.supersededAt != null);
    assert.notEqual(supersede, undefined, 'stale job is marked superseded');
    assert.equal(supersede!.cause, 'SUPERSEDED_BY_REVISION');
  });

  it('applies the latest-revision job and supersedes older non-terminal siblings', async () => {
    enableFlag();
    let upstreamCalled = false;
    const supersedeSiblingCalls: Array<Record<string, unknown>> = [];
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => versionedUpdateJob(5n),
          findMany: async () => [],
          updateMany: async (input: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            // The stale-sibling supersede targets lower revisions.
            if (
              typeof input.where.desiredRevision === 'object' &&
              input.where.desiredRevision !== null &&
              'lt' in (input.where.desiredRevision as object)
            ) {
              supersedeSiblingCalls.push(input.where);
              return { count: 1 };
            }
            return { count: 1 };
          },
          update: async () => undefined,
        },
        subscriptionEffectiveProjection: {
          // Null projection → the versioned desired-state write falls back to
          // the legacy absolute update (this test asserts updatePanelUser +
          // sibling supersession, not the strict read-back path).
          findUnique: async () => null,
        },
        $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb({
          $queryRaw: async () => [{ status: SubscriptionStatus.ACTIVE }],
          subscription: { update: async () => undefined },
          profileSyncJob: { findMany: async () => [], create: async () => ({ id: 'x' }) },
        }),
      } as never,
      { updatePanelUser: async () => { upstreamCalled = true; } } as never,
      { generateProfileName: async () => ({ username: 'rz', description: 'd' }), getContactInfo: async () => ({ email: null, telegramId: null }) } as never,
      { error: () => undefined, info: () => undefined } as never,
    );

    await processor.process({ data: { syncJobId: 'sync-job-versioned' } } as never);

    assert.equal(upstreamCalled, true, 'the latest revision applies upstream');
    assert.equal(supersedeSiblingCalls.length, 1, 'older-revision siblings are superseded');
    const where = supersedeSiblingCalls[0]!;
    assert.equal(where.aggregateKey, 'subscription-1');
    assert.deepEqual(where.desiredRevision, { lt: 5n });
  });

  it('with the flag OFF, a stale-revision versioned job still applies (legacy behavior)', async () => {
    // Flag intentionally not enabled.
    let upstreamCalled = false;
    let projectionRead = false;
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => versionedUpdateJob(2n),
          updateMany: async () => ({ count: 1 }),
          update: async () => undefined,
        },
        subscriptionEffectiveProjection: {
          findUnique: async () => { projectionRead = true; return { desiredRevision: 5n }; },
        },
        $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb({
          $queryRaw: async () => [{ status: SubscriptionStatus.ACTIVE }],
          subscription: { update: async () => undefined },
          profileSyncJob: { findMany: async () => [], create: async () => ({ id: 'x' }) },
        }),
      } as never,
      { updatePanelUser: async () => { upstreamCalled = true; } } as never,
      { generateProfileName: async () => ({ username: 'rz', description: 'd' }), getContactInfo: async () => ({ email: null, telegramId: null }) } as never,
      { error: () => undefined, info: () => undefined } as never,
    );

    await processor.process({ data: { syncJobId: 'sync-job-versioned' } } as never);

    assert.equal(upstreamCalled, true, 'legacy path applies unconditionally');
    assert.equal(projectionRead, false, 'the projection is not consulted when the flag is off');
  });

  it('supersedes a versioned UPDATE when a DELETE is pending for the same aggregate (DELETE priority)', async () => {
    enableFlag();
    const jobUpdates: Array<Record<string, unknown>> = [];
    let upstreamCalled = false;
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => versionedUpdateJob(5n),
          findMany: async (input: { where: Record<string, unknown> }) => {
            // The DELETE-priority probe looks for non-terminal DELETE jobs.
            if ((input.where as { action?: unknown }).action === SyncAction.DELETE) {
              return [{ id: 'pending-delete-job' }];
            }
            return [];
          },
          updateMany: async (input: { data: Record<string, unknown> }) => {
            jobUpdates.push(input.data);
            return { count: 1 };
          },
          update: async () => undefined,
        },
        subscriptionEffectiveProjection: {
          findUnique: async () => ({ desiredRevision: 5n }),
        },
      } as never,
      { updatePanelUser: async () => { upstreamCalled = true; } } as never,
      { generateProfileName: async () => ({ username: 'rz', description: 'd' }), getContactInfo: async () => ({ email: null, telegramId: null }) } as never,
      { error: () => undefined, info: () => undefined } as never,
    );

    await processor.process({ data: { syncJobId: 'sync-job-versioned' } } as never);

    assert.equal(upstreamCalled, false, 'a pending DELETE must block an UPDATE push');
    const supersede = jobUpdates.find((d) => d.supersededAt != null);
    assert.notEqual(supersede, undefined);
    assert.equal(supersede!.cause, 'SUPERSEDED_BY_DELETE');
  });
});
