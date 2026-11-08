import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PaymentGatewayType, TransactionStatus, UserRole } from '@prisma/client';
import { of } from 'rxjs';

import type { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import {
  isDeclinedRefundNotice,
  isRefundProviderStatus,
} from '../src/modules/payments/services/payment-reconciliation.service';
import { PaymentRefundService } from '../src/modules/payments/services/payment-refund.service';
import { PaymentWebhookPayloadRedactionService } from '../src/modules/payments/services/payment-webhook-payload-redaction.service';
import { PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY } from '../src/modules/payments/utils/provider-subscription-terms.util';
import { executeGatewayDataWrites } from './helpers/gateway-data-write-double';

/**
 * «Вернуть» for a Platega payment (the owner, 08.11.2026): Platega is asked
 * first (`cancel-supported`), the whole goes back through `cancel`, part of it
 * through `cancel-partial`; a full refund undoes the purchase, a partial one
 * when the operator ticks «Отменить покупку».
 */

const ADMIN = { id: 'admin-1', role: UserRole.ADMIN } as unknown as CurrentAdminInterface;
const META = { requestId: 'req-1', remoteAddress: '203.0.113.5', userAgent: 'panel' };
const SETTINGS = { merchantId: 'merchant-1', secret: 'secret-1' };

interface Harness {
  readonly service: PaymentRefundService;
  readonly gets: Array<{ url: string; params: unknown; headers: Record<string, string> }>;
  readonly posts: Array<{ url: string; body: unknown; headers: Record<string, string> }>;
  readonly row: { gatewayData: Record<string, unknown> | null };
  readonly reversals: string[];
  readonly autopayEnds: string[];
  readonly purchaseCancels: string[];
  readonly audits: Array<Record<string, unknown>>;
}

function harness(input: {
  readonly check?: Record<string, unknown>;
  readonly answer?: Record<string, unknown>;
  readonly planSnapshot?: Record<string, unknown>;
}): Harness {
  const gets: Harness['gets'] = [];
  const posts: Harness['posts'] = [];
  const row = { gatewayData: null as Record<string, unknown> | null };
  const reversals: string[] = [];
  const autopayEnds: string[] = [];
  const purchaseCancels: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const transaction = {
    id: 'tx-1',
    paymentId: 'payment-1',
    userId: 'user-1',
    status: TransactionStatus.COMPLETED,
    gatewayType: PaymentGatewayType.PLATEGA,
    gatewayId: 'pl-1',
    get gatewayData() {
      return row.gatewayData;
    },
    fulfilledAt: new Date('2026-11-05T19:00:00.000Z'),
    planSnapshot: input.planSnapshot ?? { id: 'plan-1' },
    currency: 'RUB',
    amount: { toString: () => '1000.00' },
  };
  const client = {
    $queryRaw: async () => [{ id: 'tx-1' }],
    transaction: {
      findUnique: async (args: { select?: Record<string, unknown> }) =>
        args.select === undefined ? transaction : { gatewayData: row.gatewayData },
      update: async (args: { data: { gatewayData: Record<string, unknown> } }) => {
        row.gatewayData = args.data.gatewayData;
        return null;
      },
    },
  };
  Object.assign(client, {
    $executeRaw: executeGatewayDataWrites({
      currentGatewayData: () => row.gatewayData,
      update: (args) => client.transaction.update(args as never),
    }),
  });
  const prisma = {
    ...client,
    $transaction: async <T>(callback: (tx: typeof client) => Promise<T>): Promise<T> => callback(client),
    paymentGateway: {
      findUnique: async () => ({ type: PaymentGatewayType.PLATEGA, isActive: false, settings: SETTINGS }),
    },
    adminAuditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        audits.push(args.data);
        return null;
      },
    },
  };
  const http = {
    get: (url: string, config: { params?: unknown; headers: Record<string, string> }) => {
      gets.push({ url, params: config.params, headers: config.headers });
      return of({
        status: 200,
        data: input.check ?? { supported: true, partialSupported: true, penaltyNativeAmount: null, blockReason: null },
      });
    },
    post: (url: string, body: unknown, config: { headers: Record<string, string> }) => {
      posts.push({ url, body, headers: config.headers });
      return of({
        status: 200,
        data: input.answer ?? { transactionId: 'pl-1', accepted: true, manualControlRequired: false, refundOperationId: 'op-1' },
      });
    },
  };
  const service = new PaymentRefundService(prisma as never, http as never, new PaymentWebhookPayloadRedactionService(), {
    reverseFulfilledPayment: async (reversed: { id: string }) => {
      reversals.push(reversed.id);
    },
    endAutopayAfterResponse: async (ended: { id: string }) => {
      autopayEnds.push(ended.id);
    },
    cancelPurchaseForPartialRefund: async (canceled: { id: string }) => {
      purchaseCancels.push(canceled.id);
      return { canceled: true, revoked: true, needsManualReview: false };
    },
  } as never);
  return { service, gets, posts, row, reversals, autopayEnds, purchaseCancels, audits };
}

function refund(h: Harness, amount: string | null, cancelPurchase?: boolean) {
  return h.service.refundTransaction({
    transactionId: 'tx-1',
    amount,
    reason: null,
    ...(cancelPurchase === undefined ? {} : { cancelPurchase }),
    currentAdmin: ADMIN,
    requestMetadata: META,
  });
}

describe('Platega refund eligibility', () => {
  it('asks Platega and passes on whether part can go back and its fee', async () => {
    const h = harness({
      check: { supported: true, partialSupported: false, penaltyNativeAmount: 50, penaltyNativeCurrency: 'RUB', blockReason: null },
    });

    const eligibility = await h.service.getEligibility('tx-1');

    assert.equal(h.gets[0]?.url, 'https://app.platega.io/transaction/pl-1/cancel-supported');
    assert.deepStrictEqual(h.gets[0]?.headers, { 'X-MerchantId': 'merchant-1', 'X-Secret': 'secret-1' });
    assert.equal(eligibility.refundable, true);
    assert.equal(eligibility.partialSupported, false);
    assert.deepStrictEqual(eligibility.providerFee, { amount: '50.00', currency: 'RUB' });
  });

  it('names a short balance, and refuses a sign-up checkout without asking', async () => {
    const short = harness({ check: { supported: false, partialSupported: false, blockReason: 'INSUFFICIENT_FUNDS' } });
    const blocked = await short.service.getEligibility('tx-1');
    assert.equal(blocked.refundable, false);
    assert.equal(blocked.reason, 'PAYMENT_REFUND_PROVIDER_INSUFFICIENT_FUNDS');

    const signUp = harness({
      planSnapshot: {
        id: 'plan-1',
        [PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY]: {
          unit: 'month',
          count: 1,
          amount: 1000,
          durationDays: 30,
          planId: 'plan-1',
          subscriptionId: null,
        },
      },
    });
    const refused = await signUp.service.getEligibility('tx-1');
    assert.equal(refused.reason, 'PAYMENT_REFUND_SUBSCRIPTION_CHECKOUT');
    assert.equal(signUp.gets.length, 0);
  });
});

describe('Platega refund', () => {
  it('gives the whole back through `cancel` and undoes the purchase with the money', async () => {
    const h = harness({});

    const result = await refund(h, null);

    assert.deepStrictEqual(
      h.posts.map((post) => [post.url, post.body]),
      [['https://app.platega.io/transaction/pl-1/cancel', undefined]],
    );
    assert.equal(result.refundId, 'op-1');
    assert.equal(result.purchaseCanceled, true);
    assert.equal(h.row.gatewayData?.['refundedAmountTotal'], '1000.00');
    assert.deepStrictEqual(h.reversals, ['tx-1']);
    assert.deepStrictEqual(h.purchaseCancels, []);
  });

  it('gives part back through `cancel-partial` with its key, and cancels the purchase when asked', async () => {
    const h = harness({});

    const result = await refund(h, '300', true);

    assert.equal(h.gets[0]?.url, 'https://app.platega.io/transaction/pl-1/cancel-supported');
    assert.deepStrictEqual(h.gets[0]?.params, { amount: '300.00' });
    assert.equal(h.posts[0]?.url, 'https://app.platega.io/transaction/pl-1/cancel-partial');
    assert.deepStrictEqual(h.posts[0]?.body, { amount: 300 });
    assert.equal(h.posts[0]?.headers['Idempotency-Key'], 'refund-tx-1-0.00-300.00');
    assert.equal(h.row.gatewayData?.['refundedAmountTotal'], '300.00');
    assert.deepStrictEqual(h.reversals, []);
    assert.deepStrictEqual(h.autopayEnds, ['tx-1']);
    assert.deepStrictEqual(h.purchaseCancels, ['tx-1']);
    assert.equal(result.purchaseCanceled, true);
    assert.equal(h.audits[0]?.['metadata'] !== undefined, true);
  });

  it('keeps the purchase on a partial refund the operator did not cancel it with', async () => {
    const h = harness({});
    const result = await refund(h, '300');
    assert.deepStrictEqual(h.purchaseCancels, []);
    assert.equal(result.purchaseCanceled, false);
  });

  it('counts and undoes nothing while Platega reviews a whole refund by hand: its CHARGEBACKED will', async () => {
    const h = harness({
      answer: { transactionId: 'pl-1', accepted: true, manualControlRequired: true, refundOperationId: 'op-2' },
    });

    const result = await refund(h, null);

    assert.equal(result.manualControlRequired, true);
    assert.equal(result.providerStatus, 'MANUAL_CONTROL');
    assert.equal(h.row.gatewayData?.['refundedAmountTotal'], '0.00');
    assert.deepStrictEqual(h.reversals, []);
    assert.deepStrictEqual(h.purchaseCancels, []);
    assert.equal(result.purchaseCanceled, false);
  });

  it('keeps «Отменить покупку» for the confirmation of a partial refund Platega reviews by hand', async () => {
    const h = harness({
      answer: { transactionId: 'pl-1', accepted: true, manualControlRequired: true, refundOperationId: 'op-3' },
    });

    const result = await refund(h, '300', true);

    assert.deepStrictEqual(h.purchaseCancels, []);
    assert.equal(result.purchaseCancelPending, true);
    assert.equal(h.row.gatewayData?.['refundCancelPurchasePending'], 'op-3');
  });

  it('refuses part of the sum where Platega cannot give part back, before any refund', async () => {
    const h = harness({ check: { supported: true, partialSupported: false, blockReason: null } });
    await assert.rejects(refund(h, '300', true), /PAYMENT_REFUND_PARTIAL_UNSUPPORTED/);
    assert.equal(h.posts.length, 0);
  });
});

describe('Platega refund callbacks', () => {
  it('reads PARTIALLY_REFUNDED as a refund, and a declined one as no refund at all', () => {
    assert.equal(isRefundProviderStatus('PARTIALLY_REFUNDED'), true);
    assert.equal(isDeclinedRefundNotice(PaymentGatewayType.PLATEGA, { status: 'PARTIALLY_REFUNDED', refundStatus: 'Declined' }), true);
    assert.equal(isDeclinedRefundNotice(PaymentGatewayType.PLATEGA, { status: 'PARTIALLY_REFUNDED', refundStatus: 'Succeeded' }), false);
    assert.equal(isDeclinedRefundNotice(PaymentGatewayType.YOOKASSA, { refundStatus: 'Declined' }), false);
  });
});
