import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DeviceReductionPlanService } from '../src/modules/add-on-entitlements/services/device-reduction-plan.service';

function devices(...rows: Array<[string, string]>) {
  return { kind: 'ok' as const, value: { devices: rows.map(([hwid, createdAt]) => ({ hwid, createdAt })), total: rows.length }, detectedVersion: '2.8.0' };
}

function build(options: {
  projection?: { id: string; desiredRevision: bigint; desiredDeviceLimit: number | null } | null;
  subscription?: { remnawaveId: string | null; status: string } | null;
  strictList?: unknown;
} = {}) {
  const created: Array<Record<string, unknown>> = [];
  const prisma = {
    subscriptionEffectiveProjection: {
      findUnique: async () =>
        options.projection === undefined
          ? { id: 'proj-1', desiredRevision: 4n, desiredDeviceLimit: 1 }
          : options.projection,
    },
    subscription: {
      findUnique: async () =>
        options.subscription === undefined
          ? { remnawaveId: 'rem-1', status: 'ACTIVE' }
          : options.subscription,
    },
    deviceReductionPlan: {
      upsert: async (args: { create: Record<string, unknown> }) => {
        created.push(args.create);
        return { id: 'plan-1', ...args.create };
      },
    },
  };
  const remnawave = {
    strictListUserDevices: async () =>
      options.strictList ?? devices(['old', '2026-01-01T00:00:00Z'], ['new', '2026-06-01T00:00:00Z']),
  };
  const service = new DeviceReductionPlanService(prisma as never, remnawave as never);
  return { service, created };
}

describe('DeviceReductionPlanService (T-011b)', () => {
  it('persists an immutable plan targeting the newest devices when over the limit', async () => {
    const { service, created } = build();
    const outcome = await service.planForSubscription('sub-1');
    assert.equal(outcome.status, 'PLANNED');
    if (outcome.status !== 'PLANNED') return;
    assert.equal(outcome.targetCount, 1);
    assert.equal(created.length, 1);
    assert.equal(created[0]!.desiredLimit, 1);
    assert.equal(created[0]!.projectionRevision, 4n);
    const selected = created[0]!.selectedDevices as Array<{ hwid: string }>;
    assert.deepEqual(selected.map((d) => d.hwid), ['new']);
  });

  it('returns VERIFIED (no plan) when devices are within the limit', async () => {
    const { service, created } = build({ strictList: devices(['only', '2026-01-01T00:00:00Z']) });
    const outcome = await service.planForSubscription('sub-1');
    assert.equal(outcome.status, 'VERIFIED');
    assert.equal(created.length, 0);
  });

  it('is NOT_APPLICABLE for an unlimited desired device limit', async () => {
    const { service } = build({ projection: { id: 'p', desiredRevision: 1n, desiredDeviceLimit: null } });
    const outcome = await service.planForSubscription('sub-1');
    assert.equal(outcome.status, 'NOT_APPLICABLE');
  });

  it('is NOT_APPLICABLE when the subscription has no panel profile', async () => {
    const { service } = build({ subscription: { remnawaveId: null, status: 'ACTIVE' } });
    const outcome = await service.planForSubscription('sub-1');
    assert.equal(outcome.status, 'NOT_APPLICABLE');
  });

  it('DEFERS when the strict device list is unavailable (retry later)', async () => {
    const { service, created } = build({ strictList: { kind: 'unavailable', retryAfterMs: null } });
    const outcome = await service.planForSubscription('sub-1');
    assert.equal(outcome.status, 'DEFERRED');
    assert.equal(created.length, 0);
  });

  it('BLOCKS on an invalid-contract device list (no plan, incident territory)', async () => {
    const { service, created } = build({ strictList: { kind: 'invalidContract', details: 'total mismatch' } });
    const outcome = await service.planForSubscription('sub-1');
    assert.equal(outcome.status, 'BLOCKED');
    assert.equal(created.length, 0);
  });

  it('is NOT_APPLICABLE when the panel profile is already gone (notFound)', async () => {
    const { service } = build({ strictList: { kind: 'notFound' } });
    const outcome = await service.planForSubscription('sub-1');
    assert.equal(outcome.status, 'NOT_APPLICABLE');
  });
});
