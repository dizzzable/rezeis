import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import { EntitlementBoundarySchedulerService } from '../src/modules/add-on-entitlements/services/entitlement-boundary-scheduler.service';

type DueRow = { subscriptionId: string; status?: string };

/**
 * The two selections are raw SQL; this fake answers each by the table it
 * reads. The ORDER and the parking are proved against PostgreSQL
 * (`entitlement-boundary-sweep-postgres.spec.ts`); what this file proves is
 * what the scheduler DOES with the rows it is handed.
 */
function build(options: {
  fresh?: DueRow[];
  reentries?: DueRow[];
  perSub?: (id: string) => { syncJobIds: string[]; deviceExpiryTriggered?: boolean } | Promise<{ syncJobIds: string[]; deviceExpiryTriggered?: boolean }>;
  planOutcome?: Record<string, unknown>;
  executionOutcome?: Record<string, unknown>;
  throwFor?: string;
} = {}) {
  const processed: string[] = [];
  const activated: string[] = [];
  const retired: string[] = [];
  const enqueued: string[] = [];
  const planned: string[] = [];
  const executions: string[] = [];
  const completed: Array<{ subscriptionId: string; projectionRevision: unknown }> = [];
  const queries: Array<{ kind: 'fresh' | 'reentries'; sql: Prisma.Sql }> = [];
  const prisma = {
    $queryRaw: async (sql: Prisma.Sql) => {
      const text = sql.text;
      if (text.includes(`t."status" = 'SCHEDULED'`)) {
        queries.push({ kind: 'fresh', sql });
        return (options.fresh ?? [{ subscriptionId: 'sub-1' }]).map((row) => ({ status: 'ACTIVE', ...row }));
      }
      if (text.includes(`e."state" = 'EXPIRING'`)) {
        queries.push({ kind: 'reentries', sql });
        return (options.reentries ?? []).map((row) => ({ status: 'ACTIVE', ...row }));
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
  const boundary = {
    activateDueScheduledTerm: async (subscriptionId: string) => {
      activated.push(subscriptionId);
      return { activated: false, termId: null, activatedEntitlements: 0, desiredRevision: null, syncJobIds: [] };
    },
    expireDueForSubscription: async (subscriptionId: string) => {
      processed.push(subscriptionId);
      if (options.throwFor === subscriptionId) throw new Error('boundary failed');
      const base = options.perSub ? await options.perSub(subscriptionId) : { syncJobIds: [`job-${subscriptionId}`] };
      return { deviceExpiryTriggered: false, ...base };
    },
    retireDeletedSubscription: async (subscriptionId: string) => {
      retired.push(subscriptionId);
      return { retired: true };
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
    {} as never,
  );
  return { service, processed, activated, retired, enqueued, planned, executions, completed, queries };
}

afterEach(() => {
  delete process.env.ADDON_DEVICE_CLEANUP_AUTO;
});

describe('EntitlementBoundarySchedulerService (T-008)', () => {
  it('runs the boundary for each due subscription and enqueues its sync jobs', async () => {
    const { service, processed, enqueued } = build({
      fresh: [{ subscriptionId: 'sub-1' }, { subscriptionId: 'sub-2' }],
    });
    const result = await service.runDueBoundaries();
    assert.equal(result.subscriptions, 2);
    assert.equal(result.enqueued, 2);
    assert.deepEqual(processed, ['sub-1', 'sub-2']);
    assert.deepEqual(enqueued, ['job-sub-1', 'job-sub-2']);
  });

  it('processes fresh boundaries first, then re-entries, in the order they were selected', async () => {
    const { service, processed } = build({
      fresh: [{ subscriptionId: 'fresh-b' }, { subscriptionId: 'fresh-a' }],
      reentries: [{ subscriptionId: 'reentry-z' }],
    });
    await service.runDueBoundaries();
    assert.deepEqual(processed, ['fresh-b', 'fresh-a', 'reentry-z']);
  });

  it('asks for re-entries only in the room fresh boundaries left, never twice for one subscription', async () => {
    const { service, queries } = build({
      fresh: [{ subscriptionId: 'fresh-1' }, { subscriptionId: 'fresh-2' }],
    });
    await service.runDueBoundaries();
    const reentry = queries.find((query) => query.kind === 'reentries');
    assert.ok(reentry, 'the re-entry selection runs when there is room');
    // Values in statement order: the due instant, the exclusion list, the
    // cleanup switch inside the parking test, the limit.
    assert.deepEqual(reentry.sql.values[1], ['fresh-1', 'fresh-2']);
    assert.equal(reentry.sql.values[reentry.sql.values.length - 1], 198);
  });

  it('retires a DELETED subscription instead of expiring it', async () => {
    const { service, processed, activated, retired } = build({
      fresh: [{ subscriptionId: 'gone', status: 'DELETED' }, { subscriptionId: 'live' }],
      reentries: [{ subscriptionId: 'gone-too', status: 'DELETED' }],
    });
    const result = await service.runDueBoundaries();
    assert.deepEqual(retired, ['gone', 'gone-too']);
    assert.deepEqual(activated, ['live']);
    assert.deepEqual(processed, ['live']);
    assert.equal(result.subscriptions, 3);
  });

  it('continues the sweep when one subscription boundary throws', async () => {
    const { service, processed, enqueued } = build({
      fresh: [{ subscriptionId: 'bad' }, { subscriptionId: 'good' }],
      throwFor: 'bad',
    });
    const result = await service.runDueBoundaries();
    assert.equal(result.subscriptions, 2);
    assert.deepEqual(processed, ['bad', 'good']);
    assert.deepEqual(enqueued, ['job-good']);
  });

  it('is a no-op with nothing due', async () => {
    const { service, enqueued } = build({ fresh: [] });
    const result = await service.runDueBoundaries();
    assert.equal(result.subscriptions, 0);
    assert.deepEqual(enqueued, []);
  });

  it('builds a device-reduction plan when a device-slot boundary triggers', async () => {
    const { service, planned } = build({
      fresh: [{ subscriptionId: 'sub-dev' }, { subscriptionId: 'sub-traffic' }],
      perSub: (id) => ({ syncJobIds: [`job-${id}`], deviceExpiryTriggered: id === 'sub-dev' }),
    });
    await service.runDueBoundaries();
    assert.deepEqual(planned, ['sub-dev'], 'only the device-expiry subscription is planned');
  });

  it('completes EXPIRING device entitlements after a verified no-plan result', async () => {
    const { service, completed } = build({
      fresh: [],
      reentries: [{ subscriptionId: 'sub-dev' }],
      perSub: () => ({ syncJobIds: [], deviceExpiryTriggered: true }),
      planOutcome: { status: 'VERIFIED', projectionRevision: 4n },
    });
    await service.runDueBoundaries();
    assert.deepStrictEqual(completed, [{ subscriptionId: 'sub-dev', projectionRevision: 4n }]);
  });

  it('auto-executes a planned reduction when the cleanup capability is enabled', async () => {
    process.env.ADDON_DEVICE_CLEANUP_AUTO = 'true';
    const { service, executions } = build({
      fresh: [{ subscriptionId: 'sub-dev' }],
      perSub: () => ({ syncJobIds: [], deviceExpiryTriggered: true }),
      planOutcome: { status: 'PLANNED', planId: 'plan-dev', targetCount: 1 },
    });
    await service.runDueBoundaries();
    assert.deepStrictEqual(executions, ['plan-dev']);
  });

  it('leaves a planned reduction for the operator while the cleanup capability is off', async () => {
    // Explicitly OFF: the flag defaults ON since the 24.09.2026 flip.
    process.env.ADDON_DEVICE_CLEANUP_AUTO = 'false';
    const { service, executions, planned } = build({
      fresh: [{ subscriptionId: 'sub-dev' }],
      perSub: () => ({ syncJobIds: [], deviceExpiryTriggered: true }),
      planOutcome: { status: 'PLANNED', planId: 'plan-dev', targetCount: 1 },
    });
    await service.runDueBoundaries();
    assert.deepStrictEqual(planned, ['sub-dev']);
    assert.deepStrictEqual(executions, []);
  });
});
