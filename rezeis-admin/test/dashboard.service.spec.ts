import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SubscriptionStatus, TransactionStatus } from '@prisma/client';

import { DashboardService } from '../src/modules/dashboard/services/dashboard.service';

describe('DashboardService', () => {
  it('aggregates the current bounded KPI summary and caches the result briefly', async () => {
    const calls: unknown[] = [];
    const service = new DashboardService(
      {
        user: {
          count: async (input?: unknown) => {
            calls.push(['user.count', input]);
            const serialized = JSON.stringify(input) ?? '';
            if (serialized.includes('isBlocked')) return 2;
            if (serialized.includes('createdAt')) return 3;
            return 10;
          },
        },
        subscription: {
          count: async (input: unknown) => {
            calls.push(['subscription.count', input]);
            const serialized = JSON.stringify(input);
            if (serialized.includes(SubscriptionStatus.EXPIRED)) return 6;
            if (serialized.includes('expiresAt')) return 8;
            if (serialized.includes(SubscriptionStatus.ACTIVE)) return 4;
            if (serialized.includes(SubscriptionStatus.LIMITED)) return 1;
            return 0;
          },
        },
        transaction: {
          count: async (input: unknown) => {
            calls.push(['transaction.count', input]);
            const serialized = JSON.stringify(input);
            if (serialized.includes(TransactionStatus.COMPLETED)) return 7;
            if (serialized.includes(TransactionStatus.PENDING)) return 2;
            if (serialized.includes(TransactionStatus.FAILED)) return 5;
            return 0;
          },
          aggregate: async (input: unknown) => {
            calls.push(['transaction.aggregate', input]);
            return { _sum: { amount: { toString: () => '25.50' } } };
          },
        },
        broadcast: {
          count: async (input: unknown) => {
            calls.push(['broadcast.count', input]);
            return 6;
          },
        },
        importRecord: {
          count: async (input: unknown) => {
            calls.push(['importRecord.count', input]);
            return 1;
          },
        },
      } as never,
      {
        getOrSet: async (key: string, loader: () => Promise<unknown>, ttlSeconds: number) => {
          calls.push(['cache.getOrSet', { key, ttlSeconds }]);
          return loader();
        },
      } as never,
    );

    const result = await service.getSummary();

    assert.equal(result.users.total, 10);
    assert.equal(result.users.blocked, 2);
    assert.equal(result.users.recentRegistered7d, 3);
    assert.equal(result.subscriptions.active, 4);
    assert.equal(result.subscriptions.limited, 1);
    assert.equal(result.subscriptions.expired, 6);
    assert.equal(result.subscriptions.expiring7d, 8);
    assert.equal(result.transactions.completed, 7);
    assert.equal(result.transactions.pending, 2);
    assert.equal(result.transactions.failed, 5);
    assert.equal(result.transactions.grossVolume, '25.50');
    assert.equal(result.operations.broadcastDrafts, 6);
    assert.equal(result.operations.importDryRunAvailable, true);
    assert.deepStrictEqual(result.financeOps, {
      refundRequests: 0,
      executedRefunds: 0,
      correctionNotes: 0,
      correctionRequests: 0,
      disputeRecords: 0,
      reconciliationExceptions: 0,
    });
    assert.equal(result.metrics.length, 13);
    assert.deepStrictEqual(result.operationsTimeline, []);
    assert.deepStrictEqual(result.financeOpsTimeline, []);
    assert.deepStrictEqual(result.attentionItems, []);
    assert.deepStrictEqual(calls[0], ['cache.getOrSet', { key: 'dashboard:summary', ttlSeconds: 60 }]);
    assert.equal(calls.some((call) => Array.isArray(call) && call[0] === 'transaction.aggregate'), true);
  });
});
