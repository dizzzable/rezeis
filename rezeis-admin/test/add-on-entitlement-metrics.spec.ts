import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { EntitlementMetricsService } from '../src/modules/add-on-entitlements/services/entitlement-metrics.service';

const ENV_KEYS = ['ADDON_SLO_OBJECTIVE_MS', 'ADDON_SLO_ALERT_MS'] as const;
const ORIGINAL: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) ORIGINAL[k] = process.env[k];
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
});

function build(options: {
  entStates?: Array<{ state: string; _count: { _all: number } }>;
  projStates?: Array<{ state: string; _count: { _all: number } }>;
  planStates?: Array<{ state: string; _count: { _all: number } }>;
  incidents?: Array<{ kind: string; _count: { _all: number } }>;
  counts?: Record<string, number>;
  oldestStranded?: { createdAt: Date } | null;
  oldestPendingSync?: { createdAt: Date } | null;
} = {}) {
  let countCall = 0;
  const countValues = options.counts ?? {};
  const prisma = {
    addOnEntitlement: { groupBy: async () => options.entStates ?? [] },
    subscriptionEffectiveProjection: { groupBy: async () => options.projStates ?? [] },
    deviceReductionPlan: { groupBy: async () => options.planStates ?? [] },
    entitlementIncident: { groupBy: async () => options.incidents ?? [] },
    transaction: {
      count: async () => (countCall++, countValues[`tx-${countCall}`] ?? 0),
      findFirst: async () => options.oldestStranded ?? null,
    },
    profileSyncJob: {
      count: async () => (countCall++, countValues[`sync-${countCall}`] ?? 0),
      findFirst: async () => options.oldestPendingSync ?? null,
    },
  };
  return new EntitlementMetricsService(prisma as never);
}

describe('EntitlementMetricsService (T-012)', () => {
  it('zero-fills every enum state even when a group is absent', async () => {
    const service = build({ entStates: [{ state: 'ACTIVE', _count: { _all: 3 } }] });
    const m = await service.collect();
    assert.equal(m.entitlementsByState.ACTIVE, 3);
    assert.equal(m.entitlementsByState.EXPIRED, 0);
    assert.equal(m.entitlementsByState.REMEDIATION_REQUIRED, 0);
    assert.equal(m.entitlementsByState.PENDING_ACTIVATION, 0);
  });

  it('maps projection, device-plan and incident groups into bounded records', async () => {
    const service = build({
      projStates: [{ state: 'APPLIED', _count: { _all: 5 } }, { state: 'DRIFTED', _count: { _all: 1 } }],
      planStates: [{ state: 'REMEDIATION_REQUIRED', _count: { _all: 2 } }],
      incidents: [{ kind: 'DEVICE_REDUCTION_BLOCKED', _count: { _all: 4 } }],
    });
    const m = await service.collect();
    assert.equal(m.projectionsByState.APPLIED, 5);
    assert.equal(m.projectionsByState.DRIFTED, 1);
    assert.equal(m.projectionsByState.SHADOW, 0);
    assert.equal(m.deviceReductionPlansByState.REMEDIATION_REQUIRED, 2);
    assert.equal(m.openIncidentsByKind.DEVICE_REDUCTION_BLOCKED, 4);
    assert.equal(m.openIncidentsByKind.PROJECTION_DRIFT, 0);
  });

  it('reports SLO objective/alert defaults and stranded/pending counts', async () => {
    const service = build({
      // count order: tx over-objective, tx over-alert, sync over-objective, sync over-alert
      counts: { 'tx-1': 7, 'tx-2': 2, 'sync-3': 4, 'sync-4': 1 },
      oldestStranded: { createdAt: new Date(Date.now() - 20 * 60_000) },
      oldestPendingSync: { createdAt: new Date(Date.now() - 8 * 60_000) },
    });
    const m = await service.collect();
    assert.equal(m.slo.objectiveMs, 5 * 60_000);
    assert.equal(m.slo.alertMs, 15 * 60_000);
    assert.equal(m.slo.strandedCapturedOverObjective, 7);
    assert.equal(m.slo.strandedCapturedOverAlert, 2);
    assert.equal(m.slo.pendingSyncOverObjective, 4);
    assert.equal(m.slo.pendingSyncOverAlert, 1);
    assert.equal(m.slo.oldestStrandedAgeMs !== null && m.slo.oldestStrandedAgeMs >= 19 * 60_000, true);
    assert.equal(m.slo.oldestPendingSyncAgeMs !== null && m.slo.oldestPendingSyncAgeMs >= 7 * 60_000, true);
  });

  it('honors configurable SLO thresholds from env', async () => {
    process.env['ADDON_SLO_OBJECTIVE_MS'] = '60000';
    process.env['ADDON_SLO_ALERT_MS'] = '120000';
    const service = build();
    const m = await service.collect();
    assert.equal(m.slo.objectiveMs, 60_000);
    assert.equal(m.slo.alertMs, 120_000);
  });

  it('reports null ages when nothing is stranded or pending', async () => {
    const service = build({ oldestStranded: null, oldestPendingSync: null });
    const m = await service.collect();
    assert.equal(m.slo.oldestStrandedAgeMs, null);
    assert.equal(m.slo.oldestPendingSyncAgeMs, null);
  });
});
