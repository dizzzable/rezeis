import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import 'reflect-metadata';

import { ConflictException } from '@nestjs/common';

import { PaymentsRenewalCheckoutService } from '../src/modules/payments/services/payments-renewal-checkout.service';
import { buildRenewalCheckoutFingerprint } from '../src/modules/payments/utils/checkout-fingerprint.util';

const PRICED = {
  userId: 'user-1',
  currency: 'USD',
  total: '10.00',
  items: [
    {
      subscriptionId: 'sub-1',
      planId: 'plan-1',
      planName: 'Plan 1',
      durationDays: 30,
      currency: 'USD',
      amount: '10.00',
      discountPercent: 0,
      planSnapshot: { id: 'plan-1', snapshotSource: 'RENEWAL_DRAFT' },
    },
  ],
};

const EXPECTED_FP = buildRenewalCheckoutFingerprint({
  contractVersion: 1,
  userId: 'user-1',
  gatewayType: 'YOOKASSA',
  channel: 'WEB',
  currency: 'USD',
  lines: [{ subscriptionId: 'sub-1', planId: 'plan-1', durationDays: 30, termId: null, addOns: [] }],
});

function draftRow(data: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    paymentId: 'pay-1',
    userId: 'user-1',
    status: 'PENDING',
    purchaseType: 'RENEW',
    gatewayType: 'YOOKASSA',
    currency: 'USD',
    amount: { toString: () => '10.00' },
    gatewayData: {},
    checkoutFingerprint: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...data,
  };
}

function build(options: { existing?: Record<string, unknown> | null } = {}) {
  const created: Array<Record<string, unknown>> = [];
  let providerCalls = 0;
  const prisma = {
    paymentGateway: {
      findUnique: async () => ({ type: 'YOOKASSA', isActive: true, currency: 'USD', settings: { shopId: 's', apiKey: 'k' } }),
    },
    transaction: {
      findFirst: async () => options.existing ?? null,
      findMany: async () => [],
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return draftRow({ ...args.data });
      },
      update: async (args: { data: Record<string, unknown> }) => draftRow({ ...args.data, gatewayData: { checkoutUrl: 'https://pay/1' } }),
    },
    transactionItem: { createMany: async () => ({ count: 1 }) },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        transaction: {
          create: async (args: { data: Record<string, unknown> }) => {
            created.push(args.data);
            return draftRow({ ...args.data });
          },
        },
        transactionItem: { createMany: async () => ({ count: 1 }) },
      }),
  };
  const renewal = { priceRenewalItems: async () => PRICED };
  const provider = {
    createCheckout: async () => {
      providerCalls += 1;
      return { gatewayId: 'g1', gatewayData: { checkoutUrl: 'https://pay/1' }, checkoutUrl: 'https://pay/1', providerMode: 'REDIRECT' };
    },
  };
  const mutation = { applyCompletedTransaction: async () => ({ syncJobs: [] }) };
  const queue = { enqueue: async () => undefined };
  const settings = { getInternalPlatformPolicy: async () => ({ accessMode: 'PUBLIC' }) };
  const guard = { evaluate: () => null };
  const service = new PaymentsRenewalCheckoutService(
    prisma as never, renewal as never, provider as never, mutation as never, queue as never, settings as never, guard as never,
  );
  return { service, created, providerCalls: () => providerCalls };
}

const baseInput = {
  userId: 'user-1',
  subscriptionIds: ['sub-1'],
  gatewayType: 'YOOKASSA' as never,
  idempotencyKey: 'renew-key-1',
};

describe('PaymentsRenewalCheckoutService idempotency (T-007)', () => {
  it('persists the idempotency key + renewal fingerprint on a fresh keyed checkout', async () => {
    const { service, created } = build({ existing: null });
    const result = await service.renewalCheckout(baseInput);
    assert.equal(result.checkoutUrl, 'https://pay/1');
    const draft = created.find((d) => d.idempotencyKey === 'renew-key-1');
    assert.notEqual(draft, undefined);
    assert.equal(draft!.checkoutFingerprint, EXPECTED_FP);
  });

  it('replays the existing draft on a keyed retry with the same composition', async () => {
    const { service, created, providerCalls } = build({
      existing: draftRow({ paymentId: 'pay-existing', checkoutFingerprint: EXPECTED_FP, gatewayData: { checkoutUrl: 'https://pay/1' } }),
    });
    const result = await service.renewalCheckout(baseInput);
    assert.equal(result.paymentId, 'pay-existing');
    assert.equal(created.length, 0, 'no second draft is created');
    assert.equal(providerCalls(), 0, 'no second provider checkout');
  });

  it('rejects the same key with a different composition (IDEMPOTENCY_KEY_CONFLICT)', async () => {
    const { service } = build({ existing: draftRow({ checkoutFingerprint: 'a-different-fingerprint' }) });
    await assert.rejects(
      () => service.renewalCheckout(baseInput),
      (e: unknown) => e instanceof ConflictException,
    );
  });

  it('keyless (legacy) renewal creates a draft with no idempotency fields', async () => {
    const { service, created } = build({ existing: null });
    const result = await service.renewalCheckout({ userId: 'user-1', subscriptionIds: ['sub-1'], gatewayType: 'YOOKASSA' as never });
    assert.equal(result.checkoutUrl, 'https://pay/1');
    const draft = created[0]!;
    assert.equal(draft.idempotencyKey, null);
    assert.equal(draft.checkoutFingerprint, null);
  });
});
