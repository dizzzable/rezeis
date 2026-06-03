import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Currency,
  PaymentGatewayType,
  PaymentWebhookLifecycleStatus,
} from '@prisma/client';

import { PaymentAnalyticsService } from '../src/modules/payment-analytics/services/payment-analytics.service';

describe('PaymentAnalyticsService diagnostic redaction', () => {
  it('redacts provider failure reason labels before returning analytics responses', async () => {
    const rawReason = [
      'checkout rejected',
      'checkoutUrl=https://pay.example/checkout?token=raw-provider-token-secret',
      'provider_id=pay_1234567890abcdef',
      'payer@example.com',
    ].join(' ');
    const service = createService({
      gateways: [createGateway(PaymentGatewayType.YOOKASSA)],
      rawQuery: (sql) => {
        if (sql.includes("gateway_data->>'providerStatus'")) {
          return [{ gateway_type: PaymentGatewayType.YOOKASSA, reason: rawReason, count: 3n }];
        }
        return [];
      },
    });

    const report = await service.getProviderReport(30);
    const failure = report.providers[0]?.topFailureReasons[0];
    assert.ok(failure !== undefined);
    const serialized = JSON.stringify(failure);

    assert.equal(failure.reason.includes('[url hidden]'), true);
    assert.equal(failure.reason.includes('[identifier hidden]'), true);
    assert.equal(failure.reason.includes('[email hidden]'), true);
    assert.equal(serialized.includes(rawReason), false);
    assert.equal(serialized.includes('raw-provider-token-secret'), false);
    assert.equal(serialized.includes('pay.example'), false);
    assert.equal(serialized.includes('pay_1234567890abcdef'), false);
    assert.equal(serialized.includes('payer@example.com'), false);
  });

  it('redacts webhook error labels before returning analytics responses', async () => {
    const rawError = [
      'webhook replay failed',
      'redis://admin:redis-secret@redis.internal/0',
      'event_id=evt_1234567890abcdef',
      'signature=raw-webhook-signature',
    ].join(' ');
    const service = createService({
      rawQuery: (sql) => {
        if (sql.includes('GROUP BY gateway_type, status')) {
          return [{
            gateway_type: PaymentGatewayType.YOOKASSA,
            status: PaymentWebhookLifecycleStatus.FAILED,
            count: 2n,
            replayed_count: 0n,
          }];
        }
        if (sql.includes('last_error')) {
          return [{ gateway_type: PaymentGatewayType.YOOKASSA, last_error: rawError, count: 2n }];
        }
        if (sql.includes('transactions_missing_webhook')) {
          return [{ transactions_missing_webhook: 0n, webhooks_missing_transaction: 0n }];
        }
        return [];
      },
    });

    const report = await service.getWebhookHealth(7);
    const error = report.perGateway[0]?.topErrors[0];
    assert.ok(error !== undefined);
    const serialized = JSON.stringify(error);

    assert.equal(error.error.includes('[url hidden]'), true);
    assert.equal(error.error.includes('[identifier hidden]'), true);
    assert.equal(error.error.includes('[token hidden]'), true);
    assert.equal(serialized.includes(rawError), false);
    assert.equal(serialized.includes('redis-secret'), false);
    assert.equal(serialized.includes('redis://'), false);
    assert.equal(serialized.includes('evt_1234567890abcdef'), false);
    assert.equal(serialized.includes('raw-webhook-signature'), false);
  });
});

function createService(input: {
  readonly gateways?: readonly Record<string, unknown>[];
  readonly rawQuery: (sql: string) => readonly unknown[];
}): PaymentAnalyticsService {
  return new PaymentAnalyticsService({
    paymentGateway: {
      findMany: async () => input.gateways ?? [],
    },
    transaction: {
      groupBy: async () => [],
    },
    $queryRawUnsafe: async (sql: string) => input.rawQuery(sql),
  } as never);
}

function createGateway(type: PaymentGatewayType): Record<string, unknown> {
  return {
    id: `gateway-${type.toLowerCase()}`,
    type,
    orderIndex: 1,
    currency: Currency.USD,
    isActive: true,
    settings: {},
    createdAt: new Date('2026-04-19T12:00:00.000Z'),
    updatedAt: new Date('2026-04-19T12:00:00.000Z'),
  };
}
