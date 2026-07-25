import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SubscriptionStatus, SyncAction } from '@prisma/client';

import { BulkPlanAssignmentService } from '../src/modules/imports/services/bulk-plan-assignment.service';

describe('BulkPlanAssignmentService', () => {
  it('queues an explicit immediate panel reshape without changing the imported subscription duration', async () => {
    const updates: Array<{ data: Record<string, unknown> }> = [];
    const jobs: unknown[] = [];
    const enqueued: string[] = [];
    const service = new BulkPlanAssignmentService(
      {
        plan: {
          findUnique: async () => ({
            id: 'plan-1', name: 'Plan', tag: null, type: 'BOTH', trafficLimit: 100, deviceLimit: 3,
            trafficLimitStrategy: 'NO_RESET', internalSquads: ['squad-1'], externalSquad: null,
            isActive: true, durations: [{ days: 30 }],
          }),
        },
        subscription: {
          findMany: async () => [{
            id: 'sub-1', status: SubscriptionStatus.ACTIVE, remnawaveId: 'panel-user-1',
            planSnapshot: { importedFrom: 'stealthnet', backupExpireAt: '2030-01-01T00:00:00.000Z' },
          }],
          update: async (input: { data: Record<string, unknown> }) => updates.push(input),
        },
        profileSyncJob: {
          create: async (input: unknown) => {
            jobs.push(input);
            return { id: 'sync-plan-1' };
          },
        },
      } as never,
      { enqueue: async (jobId: string) => enqueued.push(jobId) } as never,
    );

    const result = await service.assignPlan({
      planId: 'plan-1', userIds: ['user-1'], createdBy: 'admin-1', applyImmediately: true,
    });

    assert.equal(result.updated, 1);
    assert.equal(result.syncJobsCreated, 1);
    assert.equal('expiresAt' in updates[0].data, false);
    assert.deepStrictEqual(jobs, [{
      data: {
        subscriptionId: 'sub-1', action: SyncAction.UPDATE,
        payload: { bulkPlanAssignment: true, planId: 'plan-1', applyImmediately: true },
      },
      select: { id: true },
    }]);
    assert.deepStrictEqual(enqueued, ['sync-plan-1']);
  });

  it('resolves users via the durable planSnapshot.importRecordId stamp (no time window)', async () => {
    const findManyCalls: Array<Record<string, unknown>> = [];
    const service = new BulkPlanAssignmentService(
      {
        plan: {
          findUnique: async () => ({
            id: 'plan-1', name: 'Plan', tag: null, type: 'BOTH', trafficLimit: 100, deviceLimit: 3,
            trafficLimitStrategy: 'NO_RESET', internalSquads: [], externalSquad: null,
            isActive: true, durations: [{ days: 30 }],
          }),
        },
        importRecord: {
          findUnique: async () => ({ id: 'imp-1', sourceType: 'stealthnet', createdAt: new Date('2020-01-01T00:00:00Z') }),
        },
        subscription: {
          findMany: async (args: Record<string, unknown>) => {
            findManyCalls.push(args);
            const where = args.where as { planSnapshot?: { path?: string[] } };
            // Durable-stamp query returns two distinct users.
            if (where.planSnapshot?.path?.[0] === 'importRecordId') {
              return [{ userId: 'user-a' }, { userId: 'user-b' }];
            }
            // No per-user subscriptions to actually update (keeps the test focused on resolution).
            return [];
          },
          update: async () => undefined,
        },
        profileSyncJob: { create: async () => ({ id: 'x' }) },
      } as never,
      { enqueue: async () => undefined } as never,
    );

    const result = await service.assignPlan({ planId: 'plan-1', importRecordId: 'imp-1', createdBy: 'admin-1' });

    // Both users resolved by the durable stamp; the time-window query is never hit.
    assert.equal(result.skippedNoSubscription, 2);
    const stampQuery = findManyCalls.find(
      (c) => (c.where as { planSnapshot?: { path?: string[] } }).planSnapshot?.path?.[0] === 'importRecordId',
    );
    assert.ok(stampQuery, 'must query by planSnapshot.importRecordId');
    const usedTimeWindow = findManyCalls.some((c) => 'createdAt' in (c.where as Record<string, unknown>));
    assert.equal(usedTimeWindow, false, 'durable stamp must short-circuit the time-window fallback');
  });

  it('falls back to the source-type + time-window heuristic for legacy imports (no stamp)', async () => {
    const findManyCalls: Array<Record<string, unknown>> = [];
    const service = new BulkPlanAssignmentService(
      {
        plan: {
          findUnique: async () => ({
            id: 'plan-1', name: 'Plan', tag: null, type: 'BOTH', trafficLimit: 100, deviceLimit: 3,
            trafficLimitStrategy: 'NO_RESET', internalSquads: [], externalSquad: null,
            isActive: true, durations: [{ days: 30 }],
          }),
        },
        importRecord: {
          findUnique: async () => ({ id: 'imp-legacy', sourceType: '3xui', createdAt: new Date('2020-01-01T00:00:00Z') }),
        },
        subscription: {
          findMany: async (args: Record<string, unknown>) => {
            findManyCalls.push(args);
            const where = args.where as { planSnapshot?: { path?: string[] }; createdAt?: unknown };
            // Durable stamp finds nothing (legacy import) → fall back.
            if (where.planSnapshot?.path?.[0] === 'importRecordId') return [];
            if ('createdAt' in where) return [{ userId: 'legacy-user' }];
            return [];
          },
          update: async () => undefined,
        },
        profileSyncJob: { create: async () => ({ id: 'x' }) },
      } as never,
      { enqueue: async () => undefined } as never,
    );

    const result = await service.assignPlan({ planId: 'plan-1', importRecordId: 'imp-legacy', createdBy: 'admin-1' });

    assert.equal(result.skippedNoSubscription, 1);
    const usedTimeWindow = findManyCalls.some((c) => 'createdAt' in (c.where as Record<string, unknown>));
    assert.equal(usedTimeWindow, true, 'legacy import must fall back to the time-window query');
  });
});
