import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { DashboardController } from '../src/modules/dashboard/dashboard.controller';
import { DashboardService } from '../src/modules/dashboard/dashboard.service';

describe('DashboardController', () => {
  it('is guarded by admin jwt guard', () => {
    const guards = Reflect.getMetadata('__guards__', DashboardController) as unknown[] | undefined;
    assert.equal(guards?.some((guard) => guard === AdminJwtAuthGuard), true);
  });

  it('wraps dashboard summary response', async () => {
    const controller = new DashboardController({
      getSummary: async () => ({
        checkedAt: '2026-04-24T12:00:00.000Z',
        users: { total: 1, blocked: 0, recentRegistered7d: 1 },
        subscriptions: { active: 1, limited: 0, expired: 0, expiring7d: 1 },
        transactions: { completed: 1, pending: 0, failed: 0, grossVolume: '10.00' },
        operations: { broadcastDrafts: 1, importDryRunAvailable: true },
        financeOps: { refundRequests: 0, executedRefunds: 0, correctionNotes: 0, correctionRequests: 0, disputes: 0, reconciliationExceptions: 0 },
        operationsTimeline: [],
        financeOpsTimeline: [],
        attentionItems: [],
        metrics: [],
      }),
    } as unknown as DashboardService);

    const result = await controller.getSummary();

    assert.equal(result.data.users.total, 1);
    assert.equal(result.data.transactions.grossVolume, '10.00');
  });
});
