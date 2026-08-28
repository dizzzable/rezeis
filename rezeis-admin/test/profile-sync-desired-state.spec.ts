import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { ServiceUnavailableException } from '@nestjs/common';

import {
  SubscriptionStatus,
  SubscriptionTermStatus,
  SyncAction,
  SyncJobStatus,
  TrafficLimitStrategy,
} from '@prisma/client';

import { ProfileSyncProcessor } from '../src/modules/profile-sync/profile-sync.processor';

const ORIGINAL = process.env['ADDON_PROJECTION_SYNC'];
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env['ADDON_PROJECTION_SYNC'];
  else process.env['ADDON_PROJECTION_SYNC'] = ORIGINAL;
});

function versionedJob() {
  return {
    id: 'sync-1',
    action: SyncAction.UPDATE,
    status: SyncJobStatus.PENDING,
    attempts: 0,
    supersededAt: null,
    aggregateKey: 'sub-1',
    desiredRevision: 5n,
    subscription: {
      id: 'sub-1', userId: 'u-1', remnawaveId: '4711', remnawavePanelId: 4711,
      remnawavePanelUsername: 'rz_u1_sub', configUrl: null,
      trafficLimit: 10, deviceLimit: 3,
      internalSquads: ['internal-deferred'], externalSquad: 'external-deferred',
      expiresAt: new Date('2099-01-01T00:00:00Z'),
      planSnapshot: { tag: 'deferred-premium', trafficLimitStrategy: 'MONTH_ROLLING' },
    },
  };
}

/** The panel's answer for the profile the projection describes. */
function panelUser(patch: Record<string, unknown> = {}) {
  return {
    id: 4711,
    username: 'rz_u1_sub',
    status: 'ACTIVE',
    createdAt: new Date('2024-03-31T10:15:00.000Z'),
    subscriptionUrl: 'https://panel.example/api/sub/abc',
    trafficLimitBytes: Number(20n * 1024n ** 3n),
    hwidDeviceLimit: 5,
    ...patch,
  };
}

function build(options: {
  projection?: { desiredRevision: bigint; desiredTrafficLimitBytes: bigint | null; desiredDeviceLimit: number | null } | null;
  readBack?: unknown;
  setOutcome?: unknown;
}) {
  const projectionUpdates: Array<Record<string, unknown>> = [];
  const termAnchorUpdates: unknown[] = [];
  const strictSetInputs: unknown[] = [];
  let setCalled = false;
  let legacyUpdateCalled = false;
  let patchCount = 0;
  const prisma = {
    profileSyncJob: {
      findUnique: async () => versionedJob(),
      findMany: async () => [],
      updateMany: async () => ({ count: 1 }),
      update: async () => undefined,
    },
    subscriptionEffectiveProjection: {
      findUnique: async () =>
        options.projection === undefined
          ? { desiredRevision: 5n, desiredTrafficLimitBytes: 20n * 1024n ** 3n, desiredDeviceLimit: 5 }
          : options.projection,
      updateMany: async (input: { data: Record<string, unknown> }) => {
        projectionUpdates.push(input.data);
        return { count: 1 };
      },
    },
    $transaction: async (cb: (t: unknown) => Promise<unknown>) =>
      cb({
        $queryRaw: async () => [{ status: SubscriptionStatus.ACTIVE }],
        subscription: { update: async () => undefined },
        subscriptionTerm: {
          updateMany: async (input: unknown) => {
            termAnchorUpdates.push(input);
            return { count: 1 };
          },
        },
        profileSyncJob: { findMany: async () => [], create: async () => ({ id: 'x' }) },
      }),
  };
  // ONE `updateUser` SERVES BOTH PATHS, because the desired-state write and
  // the legacy absolute update are now the SAME call on the SAME client — the
  // strict adapter that used to make one of them apart is gone. They are told
  // apart by their BODY: the desired-state write carries the projection's
  // limits and no contact fields, the legacy one carries `description`.
  const panelUsers = {
    updateUser: async (body: Record<string, unknown>) => {
      patchCount += 1;
      if ('description' in body) {
        legacyUpdateCalled = true;
        return { kind: 'ok', drifted: false, data: { response: panelUser() } };
      }
      setCalled = true;
      strictSetInputs.push(body);
      return options.setOutcome ?? { kind: 'ok', drifted: false, data: { response: panelUser() } };
    },
    getUserById: async () =>
      options.readBack ?? { kind: 'ok', drifted: false, data: { response: panelUser() } },
    resetTraffic: async () => ({ kind: 'ok', drifted: false, data: { response: panelUser() } }),
    resolveUser: async () => {
      throw new Error('a row carrying a numeric identity must never be re-resolved');
    },
  };
  const naming = {
    generateProfileName: async () => ({ username: 'rz', description: 'd' }),
    getContactInfo: async () => ({ email: null, telegramId: null }),
  };
  const processor = new ProfileSyncProcessor(
    prisma as never, panelUsers as never, naming as never, { error: () => undefined, info: () => undefined } as never,
  );
  return {
    processor,
    projectionUpdates,
    termAnchorUpdates,
    strictSetInputs,
    patchCount: () => patchCount,
    setCalled: () => setCalled,
    legacyUpdateCalled: () => legacyUpdateCalled,
  };
}

describe('ProfileSyncProcessor versioned desired-state write (T-009/T-010)', () => {
  it('PATCHes absolute limits, reads back, and marks the projection APPLIED on equality', async () => {
    process.env['ADDON_PROJECTION_SYNC'] = 'true';
    const h = build({});
    await h.processor.process({ data: { syncJobId: 'sync-1' } } as never);
    assert.equal(h.setCalled(), true);
    assert.equal(h.legacyUpdateCalled(), false, 'strict path replaces the legacy absolute update');
    // The identity travels IN THE BODY as the numeric `id` the route declares,
    // and the limits are the projection's, encoded the way the panel spells
    // them: bytes as a plain number, unlimited as `0`.
    assert.deepStrictEqual(h.strictSetInputs, [{
      id: 4711,
      trafficLimitBytes: Number(20n * 1024n ** 3n),
      hwidDeviceLimit: 5,
      tag: 'deferred-premium',
      trafficLimitStrategy: 'MONTH_ROLLING',
      activeInternalSquads: ['internal-deferred'],
      externalSquadUuid: 'external-deferred',
    }]);
    const applied = h.projectionUpdates.find((d) => d.state === 'APPLIED');
    assert.notEqual(applied, undefined);
    assert.equal(applied!.lastAppliedRevision, 5n);
    // The panel's own build string is NOT on a user route — the field the
    // strict adapter used to read off the envelope does not exist on 3.x — so
    // the column records nothing rather than recording our own contract pin as
    // though it were the panel's.
    assert.equal(applied!.observedContractVersion, null);
    assert.equal(applied!.observedTrafficLimitBytes, 20n * 1024n ** 3n);
    assert.equal(applied!.observedDeviceLimit, 5);
    assert.deepStrictEqual(h.termAnchorUpdates, [{
      where: {
        subscriptionId: 'sub-1',
        status: { in: [SubscriptionTermStatus.ACTIVE, SubscriptionTermStatus.SCHEDULED] },
        trafficResetStrategy: TrafficLimitStrategy.MONTH_ROLLING,
      },
      data: { resetAnchorAt: new Date('2024-03-31T10:15:00.000Z') },
    }]);
  });

  it('records DRIFTED and fails the job when read-back disagrees with desired', async () => {
    process.env['ADDON_PROJECTION_SYNC'] = 'true';
    const h = build({
      readBack: {
        kind: 'ok',
        drifted: false,
        data: { response: panelUser({ trafficLimitBytes: 999, hwidDeviceLimit: 1 }) },
      },
    });
    await assert.rejects(() => h.processor.process({ data: { syncJobId: 'sync-1' } } as never), /drift/i);
    const drift = h.projectionUpdates.find((d) => d.state === 'DRIFTED');
    assert.notEqual(drift, undefined);
    assert.equal(drift!.driftClass, 'LIMIT_MISMATCH');
  });

  it('retries (throws) when the panel could not be reached during the PATCH', async () => {
    // `network` is the outcome nothing was heard back for, and it MUST classify
    // TRANSIENT: a job burned as terminal here is a paid subscription that
    // never converges, and the recovery sweep only re-drives transient rows.
    process.env['ADDON_PROJECTION_SYNC'] = 'true';
    const h = build({ setOutcome: { kind: 'network', detail: 'ETIMEDOUT' } });
    await assert.rejects(
      () => h.processor.process({ data: { syncJobId: 'sync-1' } } as never),
      (err: Error) => err instanceof ServiceUnavailableException && /ETIMEDOUT/.test(err.message),
    );
  });

  it('does NOT retry when the panel answered and refused the PATCH', async () => {
    // The other half of the same decision. A 400 is the panel reading our body
    // and saying no; re-sending identical bytes every five minutes cannot
    // change that, and TRANSIENT would mean nobody is ever told.
    process.env['ADDON_PROJECTION_SYNC'] = 'true';
    const h = build({
      setOutcome: {
        kind: 'rejected',
        status: 400,
        code: 'A001',
        detail: 'tag must be uppercase',
        retryAfterMs: null,
      },
    });
    await assert.rejects(
      () => h.processor.process({ data: { syncJobId: 'sync-1' } } as never),
      (err: Error) => !(err instanceof ServiceUnavailableException) && /400/.test(err.message),
    );
  });

  it('reads the limits back with a SECOND request, not off the PATCH answer', async () => {
    // The PATCH echoing what we sent proves only that the panel read the body.
    // `GET /api/users/{id}` proves it stored it, and the applied revision is
    // advanced on the second answer alone.
    process.env['ADDON_PROJECTION_SYNC'] = 'true';
    let reads = 0;
    const h = build({});
    const client = (h.processor as unknown as {
      panelUsers: { getUserById: () => Promise<unknown> };
    }).panelUsers;
    const original = client.getUserById.bind(client);
    client.getUserById = async () => {
      reads += 1;
      return original();
    };
    await h.processor.process({ data: { syncJobId: 'sync-1' } } as never);
    assert.equal(h.patchCount(), 1);
    assert.equal(reads, 1, 'the read-back must be its own request');
  });

  it('falls back to the legacy absolute update when no projection exists', async () => {
    process.env['ADDON_PROJECTION_SYNC'] = 'true';
    const h = build({ projection: null });
    await h.processor.process({ data: { syncJobId: 'sync-1' } } as never);
    assert.equal(h.legacyUpdateCalled(), true);
    assert.equal(h.setCalled(), false);
  });

  it('uses the legacy path when the projectionSync flag is off', async () => {
    const h = build({});
    await h.processor.process({ data: { syncJobId: 'sync-1' } } as never);
    assert.equal(h.legacyUpdateCalled(), true);
    assert.equal(h.setCalled(), false);
  });
});
