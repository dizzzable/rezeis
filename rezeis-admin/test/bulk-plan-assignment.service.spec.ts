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
});
