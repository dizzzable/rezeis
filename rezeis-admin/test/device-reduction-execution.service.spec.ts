import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { DeviceReductionExecutionService } from '../src/modules/add-on-entitlements/services/device-reduction-execution.service';

const ORIGINAL_FLAG = process.env['ADDON_DEVICE_CLEANUP_AUTO'];
afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env['ADDON_DEVICE_CLEANUP_AUTO'];
  else process.env['ADDON_DEVICE_CLEANUP_AUTO'] = ORIGINAL_FLAG;
});
function enableAuto(): void {
  process.env['ADDON_DEVICE_CLEANUP_AUTO'] = 'true';
}

function okList(...hwids: string[]) {
  return {
    kind: 'ok' as const,
    value: { devices: hwids.map((hwid) => ({ hwid, createdAt: '2026-01-01T00:00:00Z' })), total: hwids.length },
    detectedVersion: '2.8.0',
  };
}

interface Opts {
  plan?: Record<string, unknown> | null;
  projection?: { desiredRevision: bigint; desiredDeviceLimit: number | null } | null;
  subscription?: { remnawaveId: string | null; status: string } | null;
  listQueue?: unknown[];
  deleteResults?: unknown[];
}

function build(opts: Opts = {}) {
  const planUpdates: Array<Record<string, unknown>> = [];
  const incidents: Array<Record<string, unknown>> = [];
  const deleteCalls: string[] = [];
  const listQueue = [...(opts.listQueue ?? [])];
  const deleteResults = [...(opts.deleteResults ?? [])];

  const prisma = {
    deviceReductionPlan: {
      findUnique: async () =>
        opts.plan === undefined
          ? {
              id: 'plan-1',
              subscriptionId: 'sub-1',
              projectionId: 'proj-1',
              projectionRevision: 4n,
              desiredLimit: 1,
              state: 'PENDING',
              selectedDevices: [{ hwid: 'new', createdAt: '2026-06-01T00:00:00Z' }],
            }
          : opts.plan,
      update: async (args: { data: Record<string, unknown> }) => {
        planUpdates.push(args.data);
        return {};
      },
    },
    subscriptionEffectiveProjection: {
      findUnique: async () =>
        opts.projection === undefined
          ? { desiredRevision: 4n, desiredDeviceLimit: 1 }
          : opts.projection,
    },
    subscription: {
      findUnique: async () =>
        opts.subscription === undefined ? { remnawaveId: 'rem-1', status: 'ACTIVE' } : opts.subscription,
    },
    entitlementIncident: {
      upsert: async (args: { create: Record<string, unknown> }) => {
        incidents.push(args.create);
        return { id: 'inc-1' };
      },
    },
  };

  const remnawave = {
    strictListUserDevices: async () => (listQueue.length > 0 ? listQueue.shift() : okList('old')),
    strictDeleteUserDevice: async (_uuid: string, hwid: string) => {
      deleteCalls.push(hwid);
      return deleteResults.length > 0 ? deleteResults.shift() : { kind: 'ok', value: { total: 1 }, detectedVersion: '2.8.0' };
    },
  };

  const service = new DeviceReductionExecutionService(prisma as never, remnawave as never);
  return { service, planUpdates, incidents, deleteCalls };
}

describe('DeviceReductionExecutionService (T-011c)', () => {
  it('is a no-op when the deviceCleanupAuto flag is off', async () => {
    const { service, planUpdates, deleteCalls } = build();
    const outcome = await service.executePlan('plan-1');
    assert.equal(outcome.status, 'AUTO_DISABLED');
    assert.equal(planUpdates.length, 0);
    assert.equal(deleteCalls.length, 0);
  });

  it('deletes the planned target and marks APPLIED when the final count is within the limit', async () => {
    enableAuto();
    const { service, planUpdates, deleteCalls } = build({
      // initial list (overage), post-delete final read-back within limit
      listQueue: [okList('old', 'new'), okList('old')],
      deleteResults: [{ kind: 'ok', value: { total: 1 }, detectedVersion: '2.8.0' }],
    });
    const outcome = await service.executePlan('plan-1');
    assert.equal(outcome.status, 'APPLIED');
    assert.deepEqual(deleteCalls, ['new']);
    assert.equal(planUpdates.some((d) => d.state === 'IN_PROGRESS'), true);
    assert.equal(planUpdates.some((d) => d.state === 'APPLIED'), true);
  });

  it('marks SUPERSEDED when the projection revision advanced past the plan', async () => {
    enableAuto();
    const { service, planUpdates, deleteCalls } = build({
      projection: { desiredRevision: 9n, desiredDeviceLimit: 1 },
    });
    const outcome = await service.executePlan('plan-1');
    assert.equal(outcome.status, 'SUPERSEDED');
    assert.deepEqual(deleteCalls, []);
    assert.equal(planUpdates.some((d) => d.state === 'SUPERSEDED'), true);
  });

  it('marks SUPERSEDED when the subscription was deleted (profile DELETE priority)', async () => {
    enableAuto();
    const { service, deleteCalls } = build({ subscription: { remnawaveId: 'rem-1', status: 'DELETED' } });
    const outcome = await service.executePlan('plan-1');
    assert.equal(outcome.status, 'SUPERSEDED');
    assert.deepEqual(deleteCalls, []);
  });

  it('DEFERS without deleting when the panel is unavailable', async () => {
    enableAuto();
    const { service, deleteCalls } = build({ listQueue: [{ kind: 'unavailable', retryAfterMs: null }] });
    const outcome = await service.executePlan('plan-1');
    assert.equal(outcome.status, 'DEFERRED');
    assert.deepEqual(deleteCalls, []);
  });

  it('stops early (converged) when the current overage is already gone', async () => {
    enableAuto();
    const { service, deleteCalls, planUpdates } = build({
      // already within limit at execution time
      listQueue: [okList('old'), okList('old')],
    });
    const outcome = await service.executePlan('plan-1');
    assert.equal(outcome.status, 'APPLIED');
    assert.deepEqual(deleteCalls, [], 'nothing to delete when already within limit');
    assert.equal(planUpdates.some((d) => d.state === 'APPLIED'), true);
  });

  it('skips a target already absent from the panel (idempotent) without deleting', async () => {
    enableAuto();
    const { service, deleteCalls } = build({
      // target "new" is not in the list; still over limit via two other rows
      plan: {
        id: 'plan-1', subscriptionId: 'sub-1', projectionId: 'proj-1', projectionRevision: 4n,
        desiredLimit: 1, state: 'PENDING',
        selectedDevices: [{ hwid: 'new', createdAt: '2026-06-01T00:00:00Z' }],
      },
      listQueue: [okList('old', 'other'), okList('old', 'other')],
    });
    const outcome = await service.executePlan('plan-1');
    // target absent → not deleted; final still over → remediation
    assert.deepEqual(deleteCalls, []);
    assert.equal(outcome.status, 'REMEDIATION_REQUIRED');
  });

  it('BLOCKS and raises an incident on an invalid-contract device list', async () => {
    enableAuto();
    const { service, incidents, planUpdates } = build({
      listQueue: [{ kind: 'invalidContract', details: 'total mismatch' }],
    });
    const outcome = await service.executePlan('plan-1');
    assert.equal(outcome.status, 'BLOCKED');
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0]!.kind, 'DEVICE_REDUCTION_BLOCKED');
    assert.equal(planUpdates.some((d) => d.state === 'BLOCKED'), true);
  });

  it('requires remediation when targets are exhausted but still over the limit', async () => {
    enableAuto();
    const { service, incidents } = build({
      // delete succeeds but final read-back still over the limit
      listQueue: [okList('old', 'new'), okList('old', 'extra')],
      deleteResults: [{ kind: 'ok', value: { total: 2 }, detectedVersion: '2.8.0' }],
    });
    const outcome = await service.executePlan('plan-1');
    assert.equal(outcome.status, 'REMEDIATION_REQUIRED');
    assert.equal(incidents.length, 1);
  });

  it('skips a plan that is already terminal (APPLIED)', async () => {
    enableAuto();
    const { service, deleteCalls } = build({
      plan: { id: 'plan-1', state: 'APPLIED', subscriptionId: 'sub-1', projectionRevision: 4n, desiredLimit: 1, selectedDevices: [] },
    });
    const outcome = await service.executePlan('plan-1');
    assert.equal(outcome.status, 'SKIPPED');
    assert.deepEqual(deleteCalls, []);
  });
});
