import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { AdminDashboardController } from '../src/modules/dashboard/controllers/admin-dashboard.controller';

describe('AdminDashboardController', () => {
  it('exposes the current guarded admin dashboard routes', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminDashboardController), 'admin/dashboard');
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, AdminDashboardController), [
      AdminJwtAuthGuard,
    ]);
    assertRoute(RequestMethod.GET, 'summary', AdminDashboardController.prototype.getSummary);
    assertRoute(RequestMethod.GET, 'system-health', AdminDashboardController.prototype.getSystemHealth);
  });

  it('delegates summary and system-health reads without response wrapping', async () => {
    const calls: string[] = [];
    const summary = {
      checkedAt: '2026-04-24T12:00:00.000Z',
      users: { total: 1, blocked: 0, recentRegistered7d: 1 },
      subscriptions: { active: 1, limited: 0, expired: 0, expiring7d: 1 },
      transactions: { completed: 1, pending: 0, failed: 0, grossVolume: '10.00' },
      operations: { broadcastDrafts: 1, importDryRunAvailable: true },
      financeOps: {
        refundRequests: 0,
        executedRefunds: 0,
        correctionNotes: 0,
        correctionRequests: 0,
        disputeRecords: 0,
        reconciliationExceptions: 0,
      },
      operationsTimeline: [],
      financeOpsTimeline: [],
      attentionItems: [],
      metrics: [],
    };
    const health = { checkedAt: '2026-04-24T12:00:00.000Z', status: 'ok' };
    const controller = new AdminDashboardController(
      {
        getSummary: async () => {
          calls.push('summary');
          return summary;
        },
      } as never,
      {
        getSystemHealth: async () => {
          calls.push('system-health');
          return health;
        },
      } as never,
    );

    assert.deepStrictEqual(await controller.getSummary(), summary);
    assert.deepStrictEqual(await controller.getSystemHealth(), health);
    assert.deepStrictEqual(calls, ['summary', 'system-health']);
  });
});

function assertRoute(requestMethod: RequestMethod, path: string, target: unknown): void {
  assert.equal(Reflect.getMetadata(METHOD_METADATA, target), requestMethod);
  assert.equal(Reflect.getMetadata(PATH_METADATA, target), path);
}
