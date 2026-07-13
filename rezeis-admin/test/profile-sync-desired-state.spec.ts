import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';

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
      id: 'sub-1', userId: 'u-1', remnawaveId: 'rem-1', trafficLimit: 10, deviceLimit: 3,
      internalSquads: [], externalSquad: null, expiresAt: new Date('2099-01-01T00:00:00Z'), planSnapshot: {},
    },
  };
}

function build(options: {
  projection?: { desiredRevision: bigint; desiredTrafficLimitBytes: bigint | null; desiredDeviceLimit: number | null } | null;
  readBack?: unknown;
  setOutcome?: unknown;
}) {
  const projectionUpdates: Array<Record<string, unknown>> = [];
  let setCalled = false;
  let legacyUpdateCalled = false;
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
        profileSyncJob: { findMany: async () => [], create: async () => ({ id: 'x' }) },
      }),
  };
  const remnawave = {
    strictSetUserLimits: async () => {
      setCalled = true;
      return options.setOutcome ?? { kind: 'ok', value: {}, detectedVersion: '2.8.0' };
    },
    strictGetPanelUser: async () =>
      options.readBack ?? { kind: 'ok', value: { uuid: 'rem-1', status: 'ACTIVE', trafficLimitBytes: 20n * 1024n ** 3n, hwidDeviceLimit: 5 }, detectedVersion: '2.8.0' },
    updatePanelUser: async () => { legacyUpdateCalled = true; return {}; },
  };
  const naming = {
    generateProfileName: async () => ({ username: 'rz', description: 'd' }),
    getContactInfo: async () => ({ email: null, telegramId: null }),
  };
  const processor = new ProfileSyncProcessor(
    prisma as never, remnawave as never, naming as never, { error: () => undefined, info: () => undefined } as never,
  );
  return { processor, projectionUpdates, setCalled: () => setCalled, legacyUpdateCalled: () => legacyUpdateCalled };
}

describe('ProfileSyncProcessor versioned desired-state write (T-009/T-010)', () => {
  it('PATCHes absolute limits, reads back, and marks the projection APPLIED on equality', async () => {
    process.env['ADDON_PROJECTION_SYNC'] = 'true';
    const h = build({});
    await h.processor.process({ data: { syncJobId: 'sync-1' } } as never);
    assert.equal(h.setCalled(), true);
    assert.equal(h.legacyUpdateCalled(), false, 'strict path replaces the legacy absolute update');
    const applied = h.projectionUpdates.find((d) => d.state === 'APPLIED');
    assert.notEqual(applied, undefined);
    assert.equal(applied!.lastAppliedRevision, 5n);
    assert.equal(applied!.observedContractVersion, '2.8.0');
  });

  it('records DRIFTED and fails the job when read-back disagrees with desired', async () => {
    process.env['ADDON_PROJECTION_SYNC'] = 'true';
    const h = build({
      readBack: { kind: 'ok', value: { uuid: 'rem-1', status: 'ACTIVE', trafficLimitBytes: 999n, hwidDeviceLimit: 1 }, detectedVersion: '2.7.4' },
    });
    await assert.rejects(() => h.processor.process({ data: { syncJobId: 'sync-1' } } as never), /drift/i);
    const drift = h.projectionUpdates.find((d) => d.state === 'DRIFTED');
    assert.notEqual(drift, undefined);
    assert.equal(drift!.driftClass, 'LIMIT_MISMATCH');
  });

  it('retries (throws) when the panel is unavailable during the PATCH', async () => {
    process.env['ADDON_PROJECTION_SYNC'] = 'true';
    const h = build({ setOutcome: { kind: 'unavailable', retryAfterMs: null } });
    await assert.rejects(() => h.processor.process({ data: { syncJobId: 'sync-1' } } as never), /unavailable/i);
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
