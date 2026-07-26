import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PaymentGatewayType, TransactionStatus } from '@prisma/client';
import { of } from 'rxjs';

import { PaymentRefundService } from '../src/modules/payments/services/payment-refund.service';
import { PaymentWebhookPayloadRedactionService } from '../src/modules/payments/services/payment-webhook-payload-redaction.service';

/**
 * Operator-issued refunds — the one surface in the panel that moves real money
 * out. Every guard here exists because getting it wrong either refunds twice or
 * refuses a legitimate refund, so each branch is pinned.
 */

const ADMIN = { id: 'admin-1' } as never;
const REQUEST_META = { requestId: 'req-1', remoteAddress: '203.0.113.5', userAgent: 'jest' };

interface TransactionOverrides {
  readonly status?: TransactionStatus;
  readonly gatewayType?: PaymentGatewayType;
  readonly fulfilledAt?: Date | null;
  readonly gatewayId?: string | null;
  readonly gatewayData?: Record<string, unknown> | null;
  readonly amount?: string;
}

function createTransaction(overrides: TransactionOverrides = {}) {
  return {
    id: 'tx-1',
    paymentId: 'payment-1',
    userId: 'user-1',
    status: overrides.status ?? TransactionStatus.COMPLETED,
    gatewayType: overrides.gatewayType ?? PaymentGatewayType.YOOKASSA,
    gatewayId: overrides.gatewayId === undefined ? 'yoo-payment-1' : overrides.gatewayId,
    gatewayData: overrides.gatewayData ?? null,
    fulfilledAt:
      overrides.fulfilledAt === undefined ? new Date('2026-04-19T11:00:00.000Z') : overrides.fulfilledAt,
    currency: 'RUB',
    amount: { toString: () => overrides.amount ?? '1000.00' },
  };
}

function createService(input: {
  readonly transaction?: ReturnType<typeof createTransaction> | null;
  readonly gateway?: Record<string, unknown> | null;
  readonly httpStatus?: number;
  readonly httpData?: unknown;
} = {}) {
  const state = {
    updates: [] as Array<{ where: { id: string }; data: Record<string, unknown> }>,
    audits: [] as Array<Record<string, unknown>>,
    posts: [] as Array<{ url: string; body: Record<string, unknown>; config: Record<string, unknown> }>,
    // Emulates the refund webhook landing between the provider call and our
    // write: the row re-read afterwards already carries reconciliation stamps.
    refreshedGatewayData: null as Record<string, unknown> | null,
    refreshedCalls: 0,
  };
  const transaction = input.transaction === undefined ? createTransaction() : input.transaction;
  const prisma = {
    transaction: {
      findUnique: async (args: { select?: Record<string, unknown> }) => {
        if (args.select !== undefined) {
          state.refreshedCalls += 1;
          return { gatewayData: state.refreshedGatewayData };
        }
        return transaction;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        state.updates.push(args);
        return null;
      },
    },
    paymentGateway: {
      findUnique: async () =>
        input.gateway === undefined
          ? {
              type: PaymentGatewayType.YOOKASSA,
              isActive: true,
              settings: { shopId: 'shop-1', apiKey: 'key-1' },
            }
          : input.gateway,
    },
    adminAuditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        state.audits.push(args.data);
        return null;
      },
    },
  };
  const httpService = {
    post: (url: string, body: Record<string, unknown>, config: Record<string, unknown>) => {
      state.posts.push({ url, body, config });
      return of({
        status: input.httpStatus ?? 200,
        data: input.httpData ?? { id: 'refund-1', status: 'succeeded' },
      });
    },
  };
  const service = new PaymentRefundService(
    prisma as never,
    httpService as never,
    new PaymentWebhookPayloadRedactionService(),
  );
  return { service, state };
}

describe('PaymentRefundService.getEligibility', () => {
  it('allows a fulfilled YooKassa payment and reports the full amount as refundable', async () => {
    const { service } = createService();
    assert.deepStrictEqual(await service.getEligibility('tx-1'), {
      refundable: true,
      reason: null,
      refundableAmount: '1000.00',
      currency: 'RUB',
      refundedAmount: '0.00',
    });
  });

  it('subtracts what was already refunded', async () => {
    const { service } = createService({
      transaction: createTransaction({ gatewayData: { refundedAmountTotal: '400.00' } }),
    });
    const eligibility = await service.getEligibility('tx-1');
    assert.equal(eligibility.refundable, true);
    assert.equal(eligibility.refundableAmount, '600.00');
    assert.equal(eligibility.refundedAmount, '400.00');
  });

  it('refuses every non-refundable state with a specific reason', async () => {
    const cases: ReadonlyArray<[TransactionOverrides, string]> = [
      [{ gatewayType: PaymentGatewayType.TELEGRAM_STARS }, 'PAYMENT_REFUND_UNSUPPORTED_GATEWAY'],
      [{ status: TransactionStatus.PENDING }, 'PAYMENT_REFUND_NOT_COMPLETED'],
      [{ fulfilledAt: null }, 'PAYMENT_REFUND_NOT_FULFILLED'],
      [{ gatewayId: null }, 'PAYMENT_REFUND_MISSING_PROVIDER_ID'],
      // Checkout claim marker — not a real provider id.
      [{ gatewayId: '__RENEWAL_PROVIDER_CREATE__:tx-1' }, 'PAYMENT_REFUND_MISSING_PROVIDER_ID'],
      [{ gatewayData: { refundedAmountTotal: '1000.00' } }, 'PAYMENT_REFUND_ALREADY_REFUNDED'],
    ];
    for (const [overrides, reason] of cases) {
      const { service } = createService({ transaction: createTransaction(overrides) });
      const eligibility = await service.getEligibility('tx-1');
      assert.equal(eligibility.refundable, false, `expected ${reason} to block the refund`);
      assert.equal(eligibility.reason, reason);
    }
  });

  it('throws when the transaction does not exist', async () => {
    const { service } = createService({ transaction: null });
    await assert.rejects(() => service.getEligibility('missing'), /not found/i);
  });
});

describe('PaymentRefundService.refundTransaction', () => {
  it('calls the provider with a transaction+amount idempotence key and records the audit trail', async () => {
    const { service, state } = createService();

    const result = await service.refundTransaction({
      transactionId: 'tx-1',
      amount: null,
      reason: 'duplicate charge',
      currentAdmin: ADMIN,
      requestMetadata: REQUEST_META,
    });

    assert.deepStrictEqual(result, {
      transactionId: 'tx-1',
      refundId: 'refund-1',
      amount: '1000.00',
      currency: 'RUB',
      providerStatus: 'succeeded',
    });
    assert.equal(state.posts.length, 1);
    assert.equal(state.posts[0].url, 'https://api.yookassa.ru/v3/refunds');
    assert.deepStrictEqual(state.posts[0].body, {
      payment_id: 'yoo-payment-1',
      amount: { value: '1000.00', currency: 'RUB' },
      description: 'duplicate charge',
    });
    // Same transaction + same amount must replay the original refund, never
    // create a second one.
    assert.equal(
      (state.posts[0].config.headers as Record<string, string>)['Idempotence-Key'],
      'refund:tx-1:1000.00',
    );
    const gatewayData = state.updates[0].data.gatewayData as Record<string, unknown>;
    assert.equal(gatewayData.refundedAmountTotal, '1000.00');
    assert.equal(gatewayData.refundId, 'refund-1');
    assert.equal(state.audits.length, 1);
    assert.equal(state.audits[0].action, 'payments.transaction.refund');
  });

  it('does not double-count when the provider replays the same refund', async () => {
    // Same transaction + same amount = same Idempotence-Key, so YooKassa hands
    // back the ORIGINAL refund instead of creating a second one. Summing the
    // amount again would invent a refund that never happened and lock the
    // operator out of the remaining balance.
    const { service, state } = createService({
      transaction: createTransaction({
        gatewayData: {
          refunds: [{ refundId: 'refund-1', amount: '300.00', at: '2026-04-19T12:00:00.000Z' }],
          refundedAmountTotal: '300.00',
        },
      }),
    });

    await service.refundTransaction({
      transactionId: 'tx-1',
      amount: '300.00',
      reason: null,
      currentAdmin: ADMIN,
      requestMetadata: REQUEST_META,
    });

    const gatewayData = state.updates[0].data.gatewayData as Record<string, unknown>;
    assert.equal((gatewayData.refunds as unknown[]).length, 1);
    assert.equal(gatewayData.refundedAmountTotal, '300.00');
  });

  it('does not count a pending refund against the refundable balance', async () => {
    // A pending refund can still be cancelled; reserving the amount would strand
    // it with no way to re-issue.
    const { service, state } = createService({
      httpData: { id: 'refund-pending', status: 'pending' },
    });

    await service.refundTransaction({
      transactionId: 'tx-1',
      amount: '100.00',
      reason: null,
      currentAdmin: ADMIN,
      requestMetadata: REQUEST_META,
    });

    const gatewayData = state.updates[0].data.gatewayData as Record<string, unknown>;
    assert.deepStrictEqual(gatewayData.refunds, []);
    assert.equal(gatewayData.refundedAmountTotal, '0.00');
  });

  it('accumulates on top of a total recorded outside the panel (webhook, no ledger)', async () => {
    // A refund issued straight in the provider dashboard reaches us as a
    // webhook that records the total but no ledger entry. Deriving the total
    // from the ledger alone would forget it and hand back balance already gone.
    const { service, state } = createService({
      transaction: createTransaction({ gatewayData: { refundedAmountTotal: '250.00' } }),
    });

    await service.refundTransaction({
      transactionId: 'tx-1',
      amount: '150.00',
      reason: null,
      currentAdmin: ADMIN,
      requestMetadata: REQUEST_META,
    });

    const gatewayData = state.updates[0].data.gatewayData as Record<string, unknown>;
    assert.equal(gatewayData.refundedAmountTotal, '400.00');
  });

  it('re-reads the row so a refund webhook arriving mid-flight is not clobbered', async () => {
    const { service, state } = createService();
    // Reconciliation wrote these while the provider call was in flight.
    state.refreshedGatewayData = {
      refundReversedAt: '2026-04-19T12:00:00.000Z',
      subscriptionRevoked: true,
    };

    await service.refundTransaction({
      transactionId: 'tx-1',
      amount: '100.00',
      reason: null,
      currentAdmin: ADMIN,
      requestMetadata: REQUEST_META,
    });

    assert.equal(state.refreshedCalls, 1);
    const gatewayData = state.updates[0].data.gatewayData as Record<string, unknown>;
    assert.equal(gatewayData.refundReversedAt, '2026-04-19T12:00:00.000Z');
    assert.equal(gatewayData.subscriptionRevoked, true);
    assert.equal(gatewayData.refundId, 'refund-1');
  });

  it('refuses an amount above the remaining balance before calling the provider', async () => {
    const { service, state } = createService({
      transaction: createTransaction({ gatewayData: { refundedAmountTotal: '900.00' } }),
    });

    await assert.rejects(
      () =>
        service.refundTransaction({
          transactionId: 'tx-1',
          amount: '200.00',
          reason: null,
          currentAdmin: ADMIN,
          requestMetadata: REQUEST_META,
        }),
      /EXCEEDS_BALANCE/,
    );
    assert.equal(state.posts.length, 0);
  });

  it('refuses a non-positive amount', async () => {
    const { service, state } = createService();
    await assert.rejects(
      () =>
        service.refundTransaction({
          transactionId: 'tx-1',
          amount: '0',
          reason: null,
          currentAdmin: ADMIN,
          requestMetadata: REQUEST_META,
        }),
      /AMOUNT_INVALID/,
    );
    assert.equal(state.posts.length, 0);
  });

  it('refuses to touch the provider when the transaction is not refundable', async () => {
    const { service, state } = createService({
      transaction: createTransaction({ status: TransactionStatus.CANCELED }),
    });
    await assert.rejects(
      () =>
        service.refundTransaction({
          transactionId: 'tx-1',
          amount: null,
          reason: null,
          currentAdmin: ADMIN,
          requestMetadata: REQUEST_META,
        }),
      /NOT_COMPLETED/,
    );
    assert.equal(state.posts.length, 0);
  });

  it('surfaces a provider rejection and writes nothing', async () => {
    const { service, state } = createService({
      httpStatus: 400,
      httpData: { code: 'invalid_request', description: 'not enough funds' },
    });

    await assert.rejects(
      () =>
        service.refundTransaction({
          transactionId: 'tx-1',
          amount: null,
          reason: null,
          currentAdmin: ADMIN,
          requestMetadata: REQUEST_META,
        }),
      /PAYMENT_REFUND_PROVIDER_REJECTED/,
    );
    assert.deepStrictEqual(state.updates, []);
    assert.deepStrictEqual(state.audits, []);
  });

  it('refuses to refund through a disabled gateway', async () => {
    const { service, state } = createService({
      gateway: { type: PaymentGatewayType.YOOKASSA, isActive: false, settings: { shopId: 's', apiKey: 'k' } },
    });
    await assert.rejects(
      () =>
        service.refundTransaction({
          transactionId: 'tx-1',
          amount: null,
          reason: null,
          currentAdmin: ADMIN,
          requestMetadata: REQUEST_META,
        }),
      /PAYMENT_GATEWAY_NOT_ACTIVE/,
    );
    assert.equal(state.posts.length, 0);
  });

  it('fails when the gateway is not configured', async () => {
    const { service, state } = createService({ gateway: null });
    await assert.rejects(
      () =>
        service.refundTransaction({
          transactionId: 'tx-1',
          amount: null,
          reason: null,
          currentAdmin: ADMIN,
          requestMetadata: REQUEST_META,
        }),
      /PAYMENT_GATEWAY_NOT_ACTIVE/,
    );
    assert.equal(state.posts.length, 0);
  });
});
