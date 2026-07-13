import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AddOnEntitlementInspectionService } from '../src/modules/add-on-entitlements/services/add-on-entitlement-inspection.service';

function build(options: {
  entitlements?: unknown[];
  projection?: Record<string, unknown> | null;
  incidents?: unknown[];
  plans?: unknown[];
} = {}) {
  const prisma = {
    addOnEntitlement: { findMany: async () => options.entitlements ?? [] },
    subscriptionEffectiveProjection: {
      findUnique: async () => (options.projection === undefined ? null : options.projection),
    },
    entitlementIncident: { findMany: async () => options.incidents ?? [] },
    deviceReductionPlan: { findMany: async () => options.plans ?? [] },
  };
  return new AddOnEntitlementInspectionService(prisma as never);
}

describe('AddOnEntitlementInspectionService (T-013)', () => {
  it('serializes bigints/decimals/dates and stringifies revisions', async () => {
    const service = build({
      entitlements: [
        {
          id: 'ent-1', type: 'EXTRA_TRAFFIC', state: 'ACTIVE', lifetime: 'UNTIL_SUBSCRIPTION_END',
          valuePerUnit: 50, totalValue: 53687091200n, currency: 'USD',
          totalAmount: { toString: () => '2.50' },
          purchasedAt: new Date('2026-01-01T00:00:00.000Z'), activatedAt: new Date('2026-01-01T00:05:00.000Z'),
          expiresAt: null, terminalReason: null, sourceTransactionId: 'tx-1', sourceLineKey: 'addon-1', catalogRevision: 2,
        },
      ],
      projection: {
        desiredRevision: 7n, state: 'APPLIED', desiredTrafficLimitBytes: 53687091200n,
        desiredDeviceLimit: null, lastAppliedRevision: 6n,
      },
    });
    const result = await service.inspectSubscription('sub-1');
    assert.equal(result.entitlements[0]!.totalValue, '53687091200');
    assert.equal(result.entitlements[0]!.totalAmount, '2.50');
    assert.equal(result.entitlements[0]!.activatedAt, '2026-01-01T00:05:00.000Z');
    assert.equal(result.projection!.desiredRevision, '7');
    assert.equal(result.projection!.desiredTrafficLimitBytes, '53687091200');
    assert.equal(result.projection!.desiredDeviceLimit, null);
    assert.equal(result.projection!.lastAppliedRevision, '6');
  });

  it('returns only a bounded target COUNT for device plans (no raw HWIDs)', async () => {
    const service = build({
      plans: [
        {
          id: 'plan-1', state: 'PENDING', desiredLimit: 1, projectionRevision: 4n,
          selectedDevices: [{ hwid: 'secret-a', createdAt: 'x' }, { hwid: 'secret-b', createdAt: 'y' }],
          attempts: 0,
        },
      ],
    });
    const result = await service.inspectSubscription('sub-1');
    assert.equal(result.deviceReductionPlans[0]!.targetCount, 2);
    // The raw HWIDs must not leak into the inspection payload.
    assert.equal(JSON.stringify(result).includes('secret-a'), false);
  });

  it('returns a null projection when none exists', async () => {
    const service = build({ projection: null });
    const result = await service.inspectSubscription('sub-1');
    assert.equal(result.projection, null);
    assert.deepEqual(result.entitlements, []);
  });
});
