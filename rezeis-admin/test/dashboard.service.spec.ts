import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type Prisma, SubscriptionStatus, TransactionStatus } from '@prisma/client';

import {
  assembleLifetimeRevenue,
  DashboardService,
} from '../src/modules/dashboard/services/dashboard.service';
import type { FxSnapshot } from '../src/modules/business-analytics/utils/analytics-money.util';

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
          findMany: async (input: unknown) => {
            calls.push(['transaction.findMany', input]);
            return [];
          },
        },
        broadcast: {
          count: async (input: unknown) => {
            calls.push(['broadcast.count', input]);
            return 6;
          },
          findMany: async (input: unknown) => {
            calls.push(['broadcast.findMany', input]);
            return [];
          },
        },
        importRecord: {
          count: async (input: unknown) => {
            calls.push(['importRecord.count', input]);
            return 1;
          },
          findMany: async (input: unknown) => {
            calls.push(['importRecord.findMany', input]);
            return [];
          },
        },
        adminAuditLog: {
          findMany: async (input: unknown) => {
            calls.push(['adminAuditLog.findMany', input]);
            return [];
          },
        },
        partnerWithdrawal: {
          count: async (input: unknown) => {
            calls.push(['partnerWithdrawal.count', input]);
            return 0;
          },
        },
        paymentWebhookEvent: {
          count: async (input: unknown) => {
            calls.push(['paymentWebhookEvent.count', input]);
            return 0;
          },
        },
        $queryRaw: async (query: Prisma.Sql) => {
          calls.push(['$queryRaw', query.sql]);
          return [{ currency: 'RUB', amount: '25.50', payments: 3 }];
        },
        fxRate: {
          findMany: async (input: unknown) => {
            calls.push(['fxRate.findMany', input]);
            return [];
          },
        },
      } as never,
      {
        getOrSet: async (key: string, loader: () => Promise<unknown>, ttlSeconds: number) => {
          calls.push(['cache.getOrSet', { key, ttlSeconds }]);
          return loader();
        },
      } as never,
      { getBaseCurrency: () => 'RUB' } as never,
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
    // Withdrawn: a dashboard opened before the update prints a dash, not the old sum.
    assert.equal(result.transactions.grossVolume, '—');
    assert.deepStrictEqual(result.revenue, {
      figure: { value: 25.5, byCurrency: [{ currency: 'RUB', amount: 25.5 }] },
      money: { currency: 'RUB', converted: false, rates: [], unconverted: [] },
      payments: 3,
    });
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
    assert.equal(result.metrics.length, 12);
    assert.equal(result.metrics.some((metric) => metric.code === 'GROSS_VOLUME'), false);
    assert.deepStrictEqual(result.operationsTimeline, []);
    assert.deepStrictEqual(result.financeOpsTimeline, []);
    // Attention list is now populated from the live counters: expiring7d=8 (>0
    // → INFO), pending=2 (<10 → not surfaced), withdrawals/webhooks=0.
    assert.deepStrictEqual(
      result.attentionItems.map((item) => ({
        kind: item.kind,
        severity: item.severity,
        count: item.count,
      })),
      [{ kind: 'SUBSCRIPTION_EXPIRING', severity: 'INFO', count: 8 }],
    );
    // The summary is cached as the parsed object: its shape changed, so did its key.
    assert.deepStrictEqual(calls[0], ['cache.getOrSet', { key: 'dashboard:summary:v2', ttlSeconds: 60 }]);
    assert.deepStrictEqual(calls.find((call) => Array.isArray(call) && call[0] === 'fxRate.findMany'), [
      'fxRate.findMany',
      { where: { base: 'RUB' }, select: { quote: true, rate: true, source: true, fetchedAt: true } },
    ]);
  });
});

describe('«Выручка за всё время»', () => {
  const fetchedAt = new Date('2026-09-18T09:00:00.000Z');
  const fx = (rates: Record<string, number>): FxSnapshot => ({
    base: 'RUB',
    rates: new Map(Object.entries(rates).map(([quote, rate]) => [quote, { rate, source: 'TEST', fetchedAt }])),
  });

  it('states the whole history in the base at the panel’s rate — never 1 000 + 10 = 1 010 — and names the one with no rate', () => {
    const revenue = assembleLifetimeRevenue(
      [
        { currency: 'RUB', amount: '1000', payments: 2 },
        { currency: 'USDT', amount: '10', payments: 1 },
        { currency: 'XTR', amount: '500', payments: 1 },
      ],
      fx({ USDT: 80 }),
    );
    assert.deepStrictEqual(revenue, {
      figure: {
        value: 1800,
        byCurrency: [
          { currency: 'RUB', amount: 1000 },
          { currency: 'USDT', amount: 10 },
          { currency: 'XTR', amount: 500 },
        ],
      },
      money: {
        currency: 'RUB',
        converted: true,
        rates: [{ currency: 'USDT', rate: 80, source: 'TEST', fetchedAt: fetchedAt.toISOString() }],
        unconverted: ['XTR'],
      },
      payments: 4,
    });
  });

  it('states one currency natively, whatever the base is', () => {
    const revenue = assembleLifetimeRevenue([{ currency: 'USDT', amount: '12.5', payments: 1 }], fx({ USDT: 80 }));
    assert.deepStrictEqual(revenue.money, { currency: 'USDT', converted: false, rates: [], unconverted: [] });
    assert.equal(revenue.figure.value, 12.5);
  });

  it('has nothing to say before the first payment: zero in the base currency', () => {
    assert.deepStrictEqual(assembleLifetimeRevenue([], fx({})), {
      figure: { value: 0, byCurrency: [] },
      money: { currency: 'RUB', converted: false, rates: [], unconverted: [] },
      payments: 0,
    });
  });
});
