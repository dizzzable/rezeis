import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AddOnPurchaseService } from '../src/modules/payments/services/addon-purchase.service';
import { buildAddOnCheckoutFingerprint } from '../src/modules/payments/utils/checkout-fingerprint.util';

const FP = buildAddOnCheckoutFingerprint({
  contractVersion: 2,
  userId: 'user-1',
  subscriptionId: 'sub-1',
  termId: null,
  addOnId: 'addon-1',
  addOnRevision: 3,
  type: 'EXTRA_TRAFFIC',
  value: 50,
  lifetime: 'UNTIL_NEXT_RESET',
  gatewayType: 'YOOKASSA',
  channel: 'WEB',
  currency: 'USD',
  amount: '2.50',
});

function txRecord(data: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    paymentId: 'pay-1',
    userId: 'user-1',
    subscriptionId: null,
    status: 'PENDING',
    purchaseType: 'ADDITIONAL',
    channel: 'WEB',
    gatewayType: 'YOOKASSA',
    currency: 'USD',
    amount: '2.50',
    checkoutUrl: null,
    checkoutFingerprint: null,
    idempotencyKey: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...data,
  };
}

function build(options: {
  existing?: Record<string, unknown> | null;
  existingAfterRace?: Record<string, unknown> | null;
  createThrowsP2002?: boolean;
  providerError?: unknown;
} = {}) {
  const created: Array<{ data: Record<string, unknown> }> = [];
  const updated: Array<{ data: Record<string, unknown> }> = [];
  let findFirstCalls = 0;
  const prisma = {
    user: { findFirst: async () => ({ id: 'user-1' }) },
    paymentGateway: {
      findUnique: async () => ({ type: 'YOOKASSA', isActive: true, currency: 'USD', settings: { shopId: 's', apiKey: 'k' } }),
    },
    subscription: {
      findUnique: async () => ({ id: 'sub-1', userId: 'user-1', status: 'ACTIVE', trafficLimit: 100, planSnapshot: {} }),
    },
    addOn: {
      findUnique: async () => ({
        id: 'addon-1', isActive: true, revision: 3, type: 'EXTRA_TRAFFIC', value: 50,
        lifetime: 'UNTIL_NEXT_RESET', name: 'Extra 50GB', applicablePlanIds: [],
        prices: [{ currency: 'USD', price: { toString: () => '2.50' } }],
      }),
    },
    transaction: {
      findFirst: async () => {
        findFirstCalls += 1;
        return findFirstCalls === 1 ? (options.existing ?? null) : (options.existingAfterRace ?? null);
      },
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args);
        if (options.createThrowsP2002) {
          throw new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: '7.8.0' });
        }
        return txRecord({ ...args.data });
      },
      update: async (args: { data: Record<string, unknown> }) => {
        updated.push(args);
        return txRecord({ id: 'tx-1', paymentId: 'pay-1', ...args.data });
      },
      findUnique: async () => txRecord({ status: 'COMPLETED' }),
    },
  };
  const pricing = { buildSnapshot: () => ({ price: '2.50' }) };
  const provider = {
    createCheckout: async () => {
      if (options.providerError !== undefined) {
        throw options.providerError;
      }
      return { gatewayId: 'g1', gatewayData: {}, checkoutUrl: 'https://pay/1', providerMode: 'REDIRECT' };
    },
  };
  const mutation = { applyCompletedTransaction: async () => ({ syncJobs: [] }) };
  const queue = { enqueue: async () => undefined };
  const settings = { getInternalPlatformPolicy: async () => ({ accessMode: 'PUBLIC' }) };
  const guard = { evaluate: () => null };
  const service = new AddOnPurchaseService(
    prisma as never, pricing as never, provider as never, mutation as never, queue as never, settings as never, guard as never,
  );
  return { service, created, updated };
}

const baseInput = {
  userId: 'user-1',
  addOnId: 'addon-1',
  subscriptionId: 'sub-1',
  gatewayType: 'YOOKASSA' as never,
  contractVersion: 2,
  idempotencyKey: 'idem-1',
};

describe('AddOnPurchaseService checkout idempotency (T-005)', () => {
  it('stores the idempotency key + fingerprint on a fresh keyed checkout', async () => {
    const { service, created } = build({ existing: null });
    const result = await service.checkout(baseInput);
    assert.equal(created.length, 1);
    assert.equal(created[0]!.data.idempotencyKey, 'idem-1');
    assert.equal(created[0]!.data.checkoutFingerprint, FP);
    assert.equal(result.checkoutUrl, 'https://pay/1');
    // v2 entitlement-ledger marker is present for the flag-gated fulfillment.
    const marker = created[0]!.data.planSnapshot as Record<string, unknown>;
    assert.equal(marker.contractVersion, 2);
    assert.equal(marker.addOnRevision, 3);
    assert.equal(marker.lifetime, 'UNTIL_NEXT_RESET');
    assert.equal(marker.sourceLineKey, 'addon-1');
  });

  it('replays the existing draft when the same key + composition is retried', async () => {
    const { service, created } = build({
      existing: txRecord({ paymentId: 'pay-existing', status: 'PENDING', checkoutUrl: 'https://pay/1', checkoutFingerprint: FP }),
    });
    const result = await service.checkout(baseInput);
    assert.equal(created.length, 0, 'no second draft/invoice is created');
    assert.equal(result.paymentId, 'pay-existing');
    assert.equal(result.checkoutUrl, 'https://pay/1');
    assert.equal(result.providerMode, 'REDIRECT');
  });

  it('rejects the same key with a different composition (IDEMPOTENCY_KEY_CONFLICT)', async () => {
    const { service, created } = build({
      existing: txRecord({ checkoutFingerprint: 'a-different-fingerprint' }),
    });
    await assert.rejects(
      () => service.checkout(baseInput),
      (e: unknown) => e instanceof ConflictException,
    );
    assert.equal(created.length, 0);
  });

  it('rejects a stale expected add-on revision (ADDON_REVISION_CONFLICT) before creating a draft', async () => {
    const { service, created } = build({ existing: null });
    await assert.rejects(
      () => service.checkout({ ...baseInput, expectedAddOnRevision: 2 }),
      (e: unknown) => e instanceof ConflictException,
    );
    assert.equal(created.length, 0);
  });

  it('replays under a concurrent duplicate race (create hits the unique index)', async () => {
    const { service, created } = build({
      existing: null,
      createThrowsP2002: true,
      existingAfterRace: txRecord({ paymentId: 'pay-winner', checkoutUrl: 'https://pay/1', checkoutFingerprint: FP }),
    });
    const result = await service.checkout(baseInput);
    assert.equal(created.length, 1, 'exactly one create attempt was made');
    assert.equal(result.paymentId, 'pay-winner');
  });

  it('keyless (legacy) checkout always creates a fresh draft with no idempotency fields', async () => {
    const { service, created } = build({ existing: null });
    const result = await service.checkout({
      userId: 'user-1', addOnId: 'addon-1', subscriptionId: 'sub-1', gatewayType: 'YOOKASSA' as never,
    });
    assert.equal(created.length, 1);
    assert.equal(created[0]!.data.idempotencyKey, null);
    assert.equal(created[0]!.data.checkoutFingerprint, null);
    assert.equal(result.checkoutUrl, 'https://pay/1');
  });

  it('marks the draft PROVIDER_OUTCOME_UNKNOWN on a non-deterministic provider failure (no second checkout)', async () => {
    const { service, created, updated } = build({
      existing: null,
      providerError: new ServiceUnavailableException('provider timeout'),
    });
    await assert.rejects(
      () => service.checkout(baseInput),
      (e: unknown) =>
        e instanceof ServiceUnavailableException &&
        typeof e.getResponse() === 'object' &&
        (e.getResponse() as Record<string, unknown>).code === 'PROVIDER_OUTCOME_UNKNOWN',
    );
    // The draft was created (so the provider reference = paymentId is stable),
    // and stamped with an UNKNOWN provider-outcome marker — NOT deleted, so a
    // keyed retry replays it and the webhook/sweeper resolves the money.
    assert.equal(created.length, 1);
    const unknownStamp = updated.find(
      (u) =>
        typeof u.data.gatewayData === 'object' &&
        u.data.gatewayData !== null &&
        (u.data.gatewayData as Record<string, unknown>).providerOutcome === 'UNKNOWN',
    );
    assert.notEqual(unknownStamp, undefined);
  });

  it('propagates a deterministic provider config error unchanged (BadRequest, no UNKNOWN stamp)', async () => {
    const { service, updated } = build({
      existing: null,
      providerError: new BadRequestException('PAYMENT_GATEWAY_MISCONFIGURED'),
    });
    await assert.rejects(
      () => service.checkout(baseInput),
      (e: unknown) => e instanceof BadRequestException,
    );
    const unknownStamp = updated.find(
      (u) =>
        typeof u.data.gatewayData === 'object' &&
        u.data.gatewayData !== null &&
        (u.data.gatewayData as Record<string, unknown>).providerOutcome === 'UNKNOWN',
    );
    assert.equal(unknownStamp, undefined);
  });
});
