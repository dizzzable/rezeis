import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { EntitlementBoundarySchedulerService } from '../src/modules/add-on-entitlements/services/entitlement-boundary-scheduler.service';

function build(options: {
  due?: Array<{ subscriptionId: string }>;
  perSub?: (id: string) => { syncJobIds: string[]; deviceExpiryTriggered?: boolean } | Promise<{ syncJobIds: string[]; deviceExpiryTriggered?: boolean }>;
  planOutcome?: Record<string, unknown>;
  executionOutcome?: Record<string, unknown>;
  throwFor?: string;
} = {}) {
  const processed: string[] = [];
  const enqueued: string[] = [];
  const planned: string[] = [];
  const executions: string[] = [];
  const completed: Array<{ subscriptionId: string; projectionRevision: unknown }> = [];
  const dueQueries: unknown[] = [];
  const prisma = {
    addOnEntitlement: {
      findMany: async (input: unknown) => {
        dueQueries.push(input);
        return options.due ?? [{ subscriptionId: 'sub-1' }];
      },
    },
    subscriptionTerm: {
      findMany: async () => [],
    },
  };
  const boundary = {
    activateDueScheduledTerm: async () => ({ activated: false, termId: null, activatedEntitlements: 0, desiredRevision: null, syncJobIds: [] }),
    expireDueForSubscription: async (subscriptionId: string) => {
      processed.push(subscriptionId);
      if (options.throwFor === subscriptionId) throw new Error('boundary failed');
      const base = options.perSub ? await options.perSub(subscriptionId) : { syncJobIds: [`job-${subscriptionId}`] };
      return { deviceExpiryTriggered: false, ...base };
    },
    completeVerifiedDeviceExpiryForSubscription: async (
      subscriptionId: string,
      projectionRevision: unknown,
    ) => {
      completed.push({ subscriptionId, projectionRevision });
      return { status: 'COMPLETED', completed: 1 };
    },
  };
  const queue = { enqueue: async (id: string) => { enqueued.push(id); } };
  const planService = {
    planForSubscription: async (id: string) => {
      planned.push(id);
      return options.planOutcome ?? { status: 'PLANNED', planId: `plan-${id}`, targetCount: 1 };
    },
  };
  const executionService = {
    executePlan: async (planId: string) => {
      executions.push(planId);
      return options.executionOutcome ?? { status: 'APPLIED', deleted: 1 };
    },
  };
  const service = new EntitlementBoundarySchedulerService(
    prisma as never,
    boundary as never,
    queue as never,
    planService as never,
    executionService as never,
  );
  return { service, processed, enqueued, planned, executions, completed, dueQueries };
}

afterEach(() => {
  delete process.env.ADDON_DEVICE_CLEANUP_AUTO;
});

describe('EntitlementBoundarySchedulerService (T-008)', () => {
  it('runs the boundary for each due subscription and enqueues its sync jobs', async () => {
    const { service, processed, enqueued } = build({
      due: [{ subscriptionId: 'sub-1' }, { subscriptionId: 'sub-2' }],
    });
    const result = await service.runDueBoundaries();
    assert.equal(result.subscriptions, 2);
    assert.equal(result.enqueued, 2);
    assert.deepEqual(processed.sort(), ['sub-1', 'sub-2']);
    assert.deepEqual(enqueued.sort(), ['job-sub-1', 'job-sub-2']);
  });

  it('continues the sweep when one subscription boundary throws', async () => {
    const { service, processed, enqueued } = build({
      due: [{ subscriptionId: 'bad' }, { subscriptionId: 'good' }],
      throwFor: 'bad',
    });
    const result = await service.runDueBoundaries();
    assert.equal(result.subscriptions, 2);
    assert.deepEqual(processed.sort(), ['bad', 'good']);
    assert.deepEqual(enqueued, ['job-good']);
  });

  it('is a no-op with nothing due', async () => {
    const { service, enqueued } = build({ due: [] });
    const result = await service.runDueBoundaries();
    assert.equal(result.subscriptions, 0);
    assert.deepEqual(enqueued, []);
  });

  it('selects due EXPIRING entitlements as durable planning retries', async () => {
    const { service, dueQueries } = build({ due: [] });
    await service.runDueBoundaries(new Date('2026-08-01T00:00:00.000Z'));
    assert.deepStrictEqual(
      (dueQueries[0] as { where: { state: unknown } }).where.state,
      { in: ['ACTIVE', 'EXPIRING'] },
    );
  });

  it('builds a device-reduction plan when a device-slot boundary triggers', async () => {
    const { service, planned } = build({
      due: [{ subscriptionId: 'sub-dev' }, { subscriptionId: 'sub-traffic' }],
      perSub: (id) => ({ syncJobIds: [`job-${id}`], deviceExpiryTriggered: id === 'sub-dev' }),
    });
    await service.runDueBoundaries();
    assert.deepEqual(planned, ['sub-dev'], 'only the device-expiry subscription is planned');
  });

  it('completes EXPIRING device entitlements after a verified no-plan result', async () => {
    const { service, completed } = build({
      due: [{ subscriptionId: 'sub-dev' }],
      perSub: () => ({ syncJobIds: [], deviceExpiryTriggered: true }),
      planOutcome: { status: 'VERIFIED', projectionRevision: 4n },
    });
    await service.runDueBoundaries();
    assert.deepStrictEqual(completed, [{ subscriptionId: 'sub-dev', projectionRevision: 4n }]);
  });

  it('auto-executes a planned reduction when the cleanup capability is enabled', async () => {
    process.env.ADDON_DEVICE_CLEANUP_AUTO = 'true';
    const { service, executions } = build({
      due: [{ subscriptionId: 'sub-dev' }],
      perSub: () => ({ syncJobIds: [], deviceExpiryTriggered: true }),
      planOutcome: { status: 'PLANNED', planId: 'plan-dev', targetCount: 1 },
    });
    await service.runDueBoundaries();
    assert.deepStrictEqual(executions, ['plan-dev']);
  });
});
