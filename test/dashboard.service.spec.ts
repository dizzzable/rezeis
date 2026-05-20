import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DashboardService } from '../src/modules/dashboard/dashboard.service';
import { PrismaService } from '../src/common/prisma/prisma.service';

describe('DashboardService', () => {
  it('aggregates bounded KPI summary from existing models', async () => {
    const calls: unknown[] = [];
    const service = new DashboardService({
      user: {
        count: async (input?: unknown): Promise<number> => {
          calls.push(['user.count', input]);
          if (input && JSON.stringify(input).includes('isBlocked')) return 2;
          if (input && JSON.stringify(input).includes('createdAt')) return 3;
          return 10;
        },
      },
      subscription: {
        count: async (input: unknown): Promise<number> => {
          calls.push(['subscription.count', input]);
          const serialized = JSON.stringify(input);
          if (serialized.includes('expiresAt')) return 8;
          if (serialized.includes('ACTIVE')) return 4;
          if (serialized.includes('LIMITED')) return 1;
          return 5;
        },
        findMany: async (input: unknown): Promise<Array<{ status: string; isTrial: boolean; expiresAt: Date | null; updatedAt: Date; createdAt: Date; id?: string; userId?: string; remnawaveId?: string; configUrl?: string }>> => {
          calls.push(['subscription.findMany', input]);
          const serialized = JSON.stringify(input);
          if (serialized.includes('expiresAt')) {
            return [
              {
                id: 'raw-subscription-id-sensitive-001',
                userId: 'raw-user-id-sensitive-001',
                remnawaveId: 'raw-provider-uuid-sensitive-001',
                configUrl: 'https://profile.example.test/raw-token',
                status: 'ACTIVE',
                isTrial: false,
                expiresAt: new Date('2026-04-25T12:00:00.000Z'),
                updatedAt: new Date('2026-04-24T12:00:00.000Z'),
                createdAt: new Date('2026-04-20T12:00:00.000Z'),
              },
            ];
          }
          return [
            {
              id: 'raw-limited-subscription-id-sensitive-001',
              userId: 'raw-limited-user-id-sensitive-001',
              remnawaveId: 'raw-limited-provider-uuid-sensitive-001',
              configUrl: 'https://profile.example.test/raw-limited-token',
              status: 'LIMITED',
              isTrial: true,
              expiresAt: null,
              updatedAt: new Date('2026-04-24T11:30:00.000Z'),
              createdAt: new Date('2026-04-19T12:00:00.000Z'),
            },
          ];
        },
      },
      transaction: {
        count: async (input: unknown): Promise<number> => {
          calls.push(['transaction.count', input]);
          const serialized = JSON.stringify(input);
          if (serialized.includes('COMPLETED')) return 7;
          if (serialized.includes('PENDING')) return 2;
          return 1;
        },
        aggregate: async (input: unknown): Promise<{ _sum: { amount: number } }> => {
          calls.push(['transaction.aggregate', input]);
          return { _sum: { amount: 25.5 } };
        },
        findMany: async (input: unknown): Promise<Array<{ id?: string; userId?: string; paymentId?: string; gatewayId?: string; status: string; purchaseType: string; channel: string; currency: string; amount: number; createdAt: Date }>> => {
          calls.push(['transaction.findMany', input]);
          const serialized = JSON.stringify(input);
          if (serialized.includes('PENDING')) {
            return [{ id: 'raw-pending-transaction-id-sensitive-001', userId: 'raw-payment-user-id-sensitive-001', paymentId: 'raw-payment-id-sensitive-001', gatewayId: 'raw-gateway-id-sensitive-001', status: 'PENDING', purchaseType: 'NEW', channel: 'WEB', currency: 'USD', amount: 12.5, createdAt: new Date('2026-04-24T10:00:00.000Z') }];
          }
          return [{ id: 'raw-failed-transaction-id-sensitive-001', userId: 'raw-failed-payment-user-id-sensitive-001', paymentId: 'raw-failed-payment-id-sensitive-001', gatewayId: 'raw-failed-gateway-id-sensitive-001', status: 'FAILED', purchaseType: 'RENEW', channel: 'TELEGRAM', currency: 'USD', amount: 9.99, createdAt: new Date('2026-04-24T09:00:00.000Z') }];
        },
      },
      broadcast: {
        count: async (): Promise<number> => 6,
        findMany: async (): Promise<Array<{ id: string; audience: string; totalCount: number; payload: { title: string }; createdAt: Date }>> => [
          {
            id: 'broadcast-1',
            audience: 'ALL',
            totalCount: 10,
            payload: { title: 'Maintenance' },
            createdAt: new Date('2026-04-24T12:03:00.000Z'),
          },
        ],
      },
      adminAuditLog: {
        count: async (input: unknown): Promise<number> => {
          calls.push(['adminAuditLog.count', input]);
          const serialized = JSON.stringify(input);
          if (serialized.includes('EXECUTE_REFUND_REQUEST')) return 1;
          if (serialized.includes('CREATE_PAYMENT_REFUND_REQUEST')) return 2;
          return 0;
        },
        findMany: async (): Promise<Array<{ id: string; action: string; createdAt: Date }>> => [
          { id: 'audit-1', action: 'BLOCK_USER', createdAt: new Date('2026-04-24T12:02:00.000Z') },
        ],
      },
      adminPaymentCorrectionNote: {
        count: async (): Promise<number> => 3,
        findMany: async (): Promise<Array<{ id: string; transactionId: string; createdAt: Date }>> => [
          { id: 'note-1', transactionId: 'raw-transaction-id-sensitive-001', createdAt: new Date('2026-04-24T12:04:00.000Z') },
        ],
      },
      adminPaymentCorrectionRequest: {
        count: async (): Promise<number> => 4,
        findMany: async (): Promise<Array<{ id: string; transactionId: string; type: string; status: string; createdAt: Date }>> => [
          { id: 'correction-1', transactionId: 'raw-transaction-id-sensitive-001', type: 'ADJUST_AMOUNT', status: 'EXECUTED', createdAt: new Date('2026-04-24T12:05:00.000Z') },
        ],
      },
      adminPaymentDisputeRecord: {
        count: async (): Promise<number> => 5,
        findMany: async (): Promise<Array<{ id: string; transactionId: string; status: string; createdAt: Date }>> => [
          { id: 'dispute-1', transactionId: 'raw-transaction-id-sensitive-001', status: 'OPEN', createdAt: new Date('2026-04-24T12:06:00.000Z') },
        ],
      },
      adminPaymentReconciliationException: {
        count: async (): Promise<number> => 6,
        findMany: async (): Promise<Array<{ id: string; transactionId: string; type: string; status: string; createdAt: Date }>> => [
          { id: 'reconciliation-1', transactionId: 'raw-transaction-id-sensitive-001', type: 'AMOUNT_MISMATCH', status: 'OPEN', createdAt: new Date('2026-04-24T12:07:00.000Z') },
        ],
      },
      adminImportBatch: {
        findMany: async (): Promise<Array<{ id: string; sourceType: string; status: string; totalRows: number; rejectedRows: number; createdAt: Date }>> => [
          {
            id: 'import-1',
            sourceType: 'CSV',
            status: 'DRY_RUN',
            totalRows: 3,
            rejectedRows: 1,
            createdAt: new Date('2026-04-24T12:01:00.000Z'),
          },
        ],
      },
    } as unknown as PrismaService);

    const result = await service.getSummary();

    assert.equal(result.users.total, 10);
    assert.equal(result.users.blocked, 2);
    assert.equal(result.users.recentRegistered7d, 3);
    assert.equal(result.subscriptions.active, 4);
    assert.equal(result.subscriptions.expiring7d, 8);
    assert.equal(result.transactions.grossVolume, '25.50');
    assert.equal(result.operations.broadcastDrafts, 6);
    assert.equal(result.operations.importDryRunAvailable, true);
    assert.equal(result.financeOps.executedRefunds, 1);
    assert.equal(result.financeOps.correctionRequests, 4);
    assert.equal(result.metrics.length, 6);
    assert.equal(result.metrics.some((metric) => metric.code === 'EXPIRING_SUBSCRIPTIONS_7D' && metric.value === 8), true);
    assert.equal(result.operationsTimeline.length, 3);
    assert.equal(result.financeOpsTimeline.length, 4);
    assert.equal(result.financeOpsTimeline[0]?.title, 'Reconciliation AMOUNT_MISMATCH');
    assert.equal(result.financeOpsTimeline.every((item) => item.description.includes('Transaction identifier hidden.')), true);
    assert.equal(JSON.stringify(result.financeOpsTimeline).includes('raw-transaction-id-sensitive-001'), false);
    assert.equal(result.attentionItems.length, 4);
    assert.equal(result.attentionItems.some((item) => item.kind === 'SUBSCRIPTION_EXPIRING' && item.description.includes('Subscription identifier hidden.')), true);
    assert.equal(result.attentionItems.some((item) => item.kind === 'SUBSCRIPTION_LIMITED' && item.description.includes('User and provider identifiers hidden.')), true);
    assert.equal(result.attentionItems.some((item) => item.kind === 'PAYMENT_PENDING' && item.description.includes('Payment identifier hidden.')), true);
    assert.equal(JSON.stringify(result.attentionItems).includes('raw-subscription-id-sensitive-001'), false);
    assert.equal(JSON.stringify(result.attentionItems).includes('raw-user-id-sensitive-001'), false);
    assert.equal(JSON.stringify(result.attentionItems).includes('raw-provider-uuid-sensitive-001'), false);
    assert.equal(JSON.stringify(result.attentionItems).includes('raw-token'), false);
    assert.equal(JSON.stringify(result.attentionItems).includes('raw-pending-transaction-id-sensitive-001'), false);
    assert.equal(JSON.stringify(result.attentionItems).includes('raw-payment-id-sensitive-001'), false);
    assert.equal(JSON.stringify(result.attentionItems).includes('raw-gateway-id-sensitive-001'), false);
    assert.equal(result.operationsTimeline[0]?.title, 'Maintenance');
    assert.equal(JSON.stringify(result.operationsTimeline).includes('metadata'), false);
    assert.equal(calls.length > 0, true);
    assert.equal(calls.some((call) => Array.isArray(call) && call[0] === 'transaction.aggregate'), true);
    assert.equal(calls.some((call) => Array.isArray(call) && call[0] === 'subscription.count' && JSON.stringify(call[1]).includes('expiresAt')), true);
    assert.equal(calls.some((call) => Array.isArray(call) && call[0] === 'transaction.findMany'), true);
  });
});
