import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { DeviceReductionExecutionService } from '../src/modules/add-on-entitlements/services/device-reduction-execution.service';

/**
 * T-011 failure injection — the destructive saga must be deterministic on
 * resume: a crash after a device delete (or after final verification) must NOT
 * re-delete a different victim or over-delete. Recovery is driven purely by the
 * strict read-back, never by a remembered in-memory cursor.
 */

const ORIGINAL_FLAG = process.env['ADDON_DEVICE_CLEANUP_AUTO'];
afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env['ADDON_DEVICE_CLEANUP_AUTO'];
  else process.env['ADDON_DEVICE_CLEANUP_AUTO'] = ORIGINAL_FLAG;
});

function okList(...hwids: string[]) {
  return {
    kind: 'ok' as const,
    value: { devices: hwids.map((hwid) => ({ hwid, createdAt: '2026-01-01T00:00:00Z' })), total: hwids.length },
    detectedVersion: '2.8.0',
  };
}

function build(plan: Record<string, unknown>, listQueue: unknown[]) {
  const deleteCalls: string[] = [];
  const planUpdates: Array<Record<string, unknown>> = [];
  const queue = [...listQueue];
  const prisma = {
    deviceReductionPlan: {
      findUnique: async () => plan,
      update: async (args: { data: Record<string, unknown> }) => {
        planUpdates.push(args.data);
        return {};
      },
    },
    subscriptionEffectiveProjection: {
      findUnique: async () => ({ desiredRevision: 4n, desiredDeviceLimit: 1 }),
    },
    subscription: { findUnique: async () => ({ remnawaveId: 'rem-1', status: 'ACTIVE' }) },
    entitlementIncident: { upsert: async () => ({ id: 'inc' }) },
  };
  const remnawave = {
    strictListUserDevices: async () => (queue.length > 0 ? queue.shift() : okList('old')),
    strictDeleteUserDevice: async (_u: string, hwid: string) => {
      deleteCalls.push(hwid);
      return { kind: 'ok', value: { total: 1 }, detectedVersion: '2.8.0' };
    },
  };
  const service = new DeviceReductionExecutionService(prisma as never, remnawave as never);
  return { service, deleteCalls, planUpdates };
}

describe('DeviceReductionExecutionService — failure injection / resume', () => {
  it('resuming an IN_PROGRESS plan whose target was already deleted does NOT re-delete', async () => {
    process.env['ADDON_DEVICE_CLEANUP_AUTO'] = 'true';
    const { service, deleteCalls } = build(
      {
        id: 'plan-1', subscriptionId: 'sub-1', projectionId: 'proj-1', projectionRevision: 4n,
        desiredLimit: 1, state: 'IN_PROGRESS',
        selectedDevices: [{ hwid: 'new', createdAt: '2026-06-01T00:00:00Z' }],
      },
      // Pre-crash the delete of 'new' already happened → list is within limit.
      [okList('old'), okList('old')],
    );
    const outcome = await service.executePlan('plan-1');
    assert.equal(outcome.status, 'APPLIED');
    assert.deepEqual(deleteCalls, [], 'no re-delete on resume — read-back proves the target is gone');
  });

  it('deletes only the still-present targets, skipping ones already removed', async () => {
    process.env['ADDON_DEVICE_CLEANUP_AUTO'] = 'true';
    const { service, deleteCalls } = build(
      {
        id: 'plan-2', subscriptionId: 'sub-1', projectionId: 'proj-1', projectionRevision: 4n,
        desiredLimit: 1, state: 'IN_PROGRESS',
        selectedDevices: [
          { hwid: 'gone', createdAt: '2026-06-01T00:00:00Z' },
          { hwid: 'present', createdAt: '2026-05-01T00:00:00Z' },
        ],
      },
      [
        okList('old', 'present'), // target 'gone' already absent → skip
        okList('old', 'present'), // target 'present' still here → delete it
        okList('old'), // final read-back within limit
      ],
    );
    const outcome = await service.executePlan('plan-2');
    assert.equal(outcome.status, 'APPLIED');
    assert.deepEqual(deleteCalls, ['present'], 'only the still-present planned target is deleted');
  });
});
