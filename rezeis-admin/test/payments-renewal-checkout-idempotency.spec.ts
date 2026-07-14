import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import 'reflect-metadata';

import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';

import { PaymentsRenewalCheckoutService } from '../src/modules/payments/services/payments-renewal-checkout.service';
import { buildRenewalCheckoutFingerprint, fingerprint } from '../src/modules/payments/utils/checkout-fingerprint.util';

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

const EXPECTED_REQUEST_FP = fingerprint({
  kind: 'RENEWAL_REQUEST',
  contractVersion: 1,
  userId: 'user-1',
  gatewayType: 'YOOKASSA',
  channel: 'WEB',
  subscriptionIds: ['sub-1'],
  durations: [],
  plans: [],
  addOns: [],
});


function draftRow(data: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    paymentId: 'pay-1',
    userId: 'user-1',
    status: 'PENDING',
    purchaseType: 'RENEW',
    channel: 'WEB',
    gatewayType: 'YOOKASSA',
    gatewayId: null,
    currency: 'USD',
    amount: { toString: () => '10.00' },
    planSnapshot: {},
    gatewayData: {},
    checkoutUrl: null,
    checkoutFingerprint: null,
    items: [
      {
        subscriptionId: 'sub-1',
        planId: 'plan-1',
        durationDays: 30,
        addOnLines: null,
      },
    ],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...data,
  };
}

function build(options: {
  existing?: Record<string, unknown> | null;
  candidates?: Array<Record<string, unknown>>;
  priceRenewalItems?: () => Promise<typeof PRICED>;
  paymentGatewayFindUnique?: () => Promise<Record<string, unknown> | null>;
  userFindUnique?: () => Promise<{ id: string } | null>;
  getInternalPlatformPolicy?: () => Promise<{ accessMode: string }>;
  providerCreateCheckout?: () => Promise<Record<string, unknown>>;
  updateMany?: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }>;
  findUnique?: (args: { where: Record<string, unknown> }) => Promise<Record<string, unknown> | null>;
  update?: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<Record<string, unknown>>;
} = {}) {
  const created: Array<Record<string, unknown>> = [];
  let providerCalls = 0;
  const prisma = {
    paymentGateway: {
      findUnique: options.paymentGatewayFindUnique ?? (async () => ({ type: 'YOOKASSA', isActive: true, currency: 'USD', settings: { shopId: 'test-shop', apiKey: 'test-key' } })),
    },
    user: { findUnique: options.userFindUnique ?? (async () => ({ id: 'user-1' })) },
    transaction: {
      findFirst: async () => options.existing ?? null,
      findMany: async () => options.candidates ?? [],
      findUnique: options.findUnique ?? (async () => null),
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return draftRow({ ...args.data });
      },
      updateMany: options.updateMany ?? (async () => ({ count: 1 })),
      update: options.update ?? (async (args: { data: Record<string, unknown> }) => draftRow({
        ...args.data,
        gatewayData: { checkoutUrl: 'https://pay/1', providerMode: 'REDIRECT' },
        checkoutUrl: 'https://pay/1',
      })),
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
  const renewal = { priceRenewalItems: options.priceRenewalItems ?? (async () => PRICED) };
  const provider = {
    createCheckout: async () => {
      providerCalls += 1;
      if (options.providerCreateCheckout !== undefined) {
        return options.providerCreateCheckout();
      }
      return { gatewayId: 'g1', gatewayData: { checkoutUrl: 'https://pay/1' }, checkoutUrl: 'https://pay/1', providerMode: 'REDIRECT' };
    },
  };
  const mutation = { applyCompletedTransaction: async () => ({ syncJobs: [] }) };
  const queue = { enqueue: async () => undefined };
  const settings = {
    getInternalPlatformPolicy: options.getInternalPlatformPolicy ?? (async () => ({ accessMode: 'PUBLIC' })),
  };
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
  expectedAmount: '10.00',
  expectedCurrency: 'USD' as never,
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
    assert.equal(
      (draft!.planSnapshot as { renewalRequestFingerprint?: string }).renewalRequestFingerprint,
      EXPECTED_REQUEST_FP,
    );
  });

  it('replays a keyed draft before mutable gateway validation and repricing', async () => {
    const { service, created, providerCalls } = build({
      existing: draftRow({
        checkoutFingerprint: EXPECTED_FP,
        checkoutUrl: 'https://pay/existing',
        planSnapshot: { renewalRequestFingerprint: EXPECTED_REQUEST_FP },
      }),
      getInternalPlatformPolicy: async () => { throw new Error('policy lookup must not run'); },
      paymentGatewayFindUnique: async () => { throw new Error('gateway lookup must not run'); },
      priceRenewalItems: async () => { throw new Error('pricing must not run'); },
    });

    const result = await service.renewalCheckout(baseInput);
    assert.equal(result.paymentId, 'pay-1');
    assert.equal(result.checkoutUrl, 'https://pay/existing');
    assert.equal(created.length, 0);
    assert.equal(providerCalls(), 0);
  });

  it('rejects a changed raw command under the same key before gateway lookup or repricing', async () => {
    const { service } = build({
      existing: draftRow({
        checkoutFingerprint: EXPECTED_FP,
        checkoutUrl: 'https://pay/existing',
        planSnapshot: { renewalRequestFingerprint: 'different-request' },
      }),
      paymentGatewayFindUnique: async () => { throw new Error('gateway lookup must not run'); },
      priceRenewalItems: async () => { throw new Error('pricing must not run'); },
    });

    await assert.rejects(
      () => service.renewalCheckout(baseInput),
      (error: unknown) =>
        error instanceof ConflictException &&
        (error.getResponse() as { code?: string }).code === 'IDEMPOTENCY_KEY_CONFLICT',
    );
  });

  it('resolves telegram identity before replay-first lookup without repricing', async () => {
    let identityLookups = 0;
    const { service } = build({
      existing: draftRow({
        checkoutFingerprint: EXPECTED_FP,
        checkoutUrl: 'https://pay/existing',
        planSnapshot: { renewalRequestFingerprint: EXPECTED_REQUEST_FP },
      }),
      userFindUnique: async () => {
        identityLookups += 1;
        return { id: 'user-1' };
      },
      paymentGatewayFindUnique: async () => { throw new Error('gateway lookup must not run'); },
      priceRenewalItems: async () => { throw new Error('pricing must not run'); },
    });

    const result = await service.renewalCheckout({
      ...baseInput,
      userId: undefined,
      telegramId: '123456789',
    });

    assert.equal(result.paymentId, 'pay-1');
    assert.equal(identityLookups, 1);
  });

  it('replays the existing draft on a keyed retry with the same composition', async () => {
    const { service, created, providerCalls } = build({
      existing: draftRow({ paymentId: 'pay-existing', checkoutFingerprint: EXPECTED_FP, gatewayData: { checkoutUrl: 'https://pay/1' }, planSnapshot: { renewalRequestFingerprint: EXPECTED_REQUEST_FP } }),
    });
    const result = await service.renewalCheckout(baseInput);
    assert.equal(result.paymentId, 'pay-existing');
    assert.equal(created.length, 0, 'no second draft is created');
    assert.equal(providerCalls(), 0, 'no second provider checkout');
  });

  it('rejects the same key with a different composition (IDEMPOTENCY_KEY_CONFLICT)', async () => {
    const { service } = build({ existing: draftRow({ checkoutFingerprint: 'a-different-fingerprint', planSnapshot: { renewalRequestFingerprint: 'different-request' } }) });
    await assert.rejects(
      () => service.renewalCheckout(baseInput),
      (e: unknown) => e instanceof ConflictException,
    );
  });

  it('rejects a changed live quote before creating a draft or provider checkout', async () => {
    const { service, created, providerCalls } = build({ existing: null });
    await assert.rejects(
      () => service.renewalCheckout({
        ...baseInput,
        expectedAmount: '9.99',
        expectedCurrency: 'USD' as never,
      }),
      (error: unknown) =>
        error instanceof ConflictException &&
        (error.getResponse() as { code?: string }).code === 'QUOTE_CHANGED',
    );
    assert.equal(created.length, 0);
    assert.equal(providerCalls(), 0);
  });

  it('rejects idempotent replay when its pinned quote differs from the persisted draft', async () => {
    const { service, created, providerCalls } = build({
      existing: draftRow({ checkoutFingerprint: EXPECTED_FP, planSnapshot: { renewalRequestFingerprint: EXPECTED_REQUEST_FP } }),
    });
    await assert.rejects(
      () => service.renewalCheckout({
        ...baseInput,
        expectedAmount: '11.00',
        expectedCurrency: 'USD' as never,
      }),
      (error: unknown) =>
        error instanceof ConflictException &&
        (error.getResponse() as { code?: string }).code === 'QUOTE_CHANGED',
    );
    assert.equal(created.length, 0);
    assert.equal(providerCalls(), 0);
  });

  it('atomically claims provider creation so concurrent requests for one PENDING draft call the provider once', async () => {
    const pending = draftRow({ checkoutFingerprint: EXPECTED_FP });
    let releaseFirstProvider!: () => void;
    const firstProviderMayFinish = new Promise<void>((resolve) => {
      releaseFirstProvider = resolve;
    });
    let providerAttempt = 0;
    const { service, providerCalls } = build({
      candidates: [pending],
      updateMany: async (args) => {
        if (pending.gatewayId !== null) return { count: 0 };
        pending.gatewayId = args.data.gatewayId;
        return { count: 1 };
      },
      findUnique: async () => pending,
      update: async (args) => {
        Object.assign(pending, args.data);
        return pending;
      },
      providerCreateCheckout: async () => {
        providerAttempt += 1;
        if (providerAttempt === 1) await firstProviderMayFinish;
        return {
          gatewayId: 'provider-1',
          gatewayData: { checkoutUrl: 'https://pay/1', providerMode: 'REDIRECT' },
          checkoutUrl: 'https://pay/1',
          providerMode: 'REDIRECT',
        };
      },
    });
    const request = {
      userId: 'user-1',
      subscriptionIds: ['sub-1'],
      gatewayType: 'YOOKASSA' as never,
    };

    const first = service.renewalCheckout(request);
    await new Promise((resolve) => setImmediate(resolve));
    const second = service.renewalCheckout(request);
    const secondOutcome = await Promise.allSettled([second]);
    releaseFirstProvider();
    const firstOutcome = await Promise.allSettled([first]);

    assert.equal(providerCalls(), 1, 'only the durable claim owner may call createCheckout');
    assert.equal(firstOutcome[0]!.status, 'fulfilled');
    assert.equal(secondOutcome[0]!.status, 'rejected');
    if (secondOutcome[0]!.status === 'rejected') {
      assert.equal(secondOutcome[0]!.reason instanceof ServiceUnavailableException, true);
    }
  });

  it('keeps an ambiguous provider-creation claim fail-closed across retries', async () => {
    const pending = draftRow({ checkoutFingerprint: EXPECTED_FP });
    const { service, providerCalls } = build({
      candidates: [pending],
      updateMany: async (args) => {
        if (pending.gatewayId !== null) return { count: 0 };
        pending.gatewayId = args.data.gatewayId;
        return { count: 1 };
      },
      findUnique: async () => pending,
      providerCreateCheckout: async () => {
        throw new ServiceUnavailableException('provider timeout');
      },
    });
    const request = {
      userId: 'user-1',
      subscriptionIds: ['sub-1'],
      gatewayType: 'YOOKASSA' as never,
    };

    await assert.rejects(() => service.renewalCheckout(request), ServiceUnavailableException);
    await assert.rejects(() => service.renewalCheckout(request), ServiceUnavailableException);

    assert.equal(providerCalls(), 1, 'an unresolved external outcome must never be retried blindly');
    assert.notEqual(pending.gatewayId, null, 'the durable claim remains persisted for recovery');
  });

  it('keyless renewal persists the full checkout fingerprint for safe draft reuse', async () => {
    const { service, created } = build({ existing: null });
    const result = await service.renewalCheckout({ userId: 'user-1', subscriptionIds: ['sub-1'], gatewayType: 'YOOKASSA' as never });
    assert.equal(result.checkoutUrl, 'https://pay/1');
    const draft = created[0]!;
    assert.equal(draft.idempotencyKey, null);
    assert.equal(draft.checkoutFingerprint, EXPECTED_FP);
  });

  it('does not return a successful keyed PENDING replay without a checkout URL', async () => {
    const { service, providerCalls } = build({
      existing: draftRow({
        checkoutFingerprint: EXPECTED_FP,
        planSnapshot: { renewalRequestFingerprint: EXPECTED_REQUEST_FP },
      }),
    });

    await assert.rejects(
      () => service.renewalCheckout(baseInput),
      (error: unknown) =>
        error instanceof ServiceUnavailableException &&
        (error.getResponse() as { code?: string }).code === 'PROVIDER_CHECKOUT_CREATION_UNRESOLVED',
    );
    assert.equal(providerCalls(), 0, 'an existing keyed draft without a URL must fail closed');
  });

  it('rejects a legacy keyed draft that has no persisted raw request fingerprint', async () => {
    const { service } = build({
      existing: draftRow({
        checkoutFingerprint: EXPECTED_FP,
        checkoutUrl: 'https://pay/existing',
        planSnapshot: {},
      }),
    });

    await assert.rejects(
      () => service.renewalCheckout(baseInput),
      (error: unknown) =>
        error instanceof ConflictException &&
        (error.getResponse() as { code?: string }).code === 'IDEMPOTENCY_KEY_CONFLICT',
    );
  });

  it('fails closed when the provider returns a nullable checkout result', async () => {
    const { service } = build({
      existing: null,
      providerCreateCheckout: async () => null as unknown as Record<string, unknown>,
    });

    await assert.rejects(
      () => service.renewalCheckout({
        userId: 'user-1',
        subscriptionIds: ['sub-1'],
        gatewayType: 'YOOKASSA' as never,
      }),
      (error: unknown) =>
        error instanceof ServiceUnavailableException &&
        (error.getResponse() as { code?: string }).code === 'PROVIDER_CHECKOUT_RESULT_INVALID',
    );
  });

  it('rejects a mismatched userId and telegramId instead of trusting userId alone', async () => {
    let identityLookups = 0;
    const { service } = build({
      existing: null,
      userFindUnique: async () => {
        identityLookups += 1;
        return { id: 'user-2' };
      },
    });

    await assert.rejects(
      () => service.renewalCheckout({
        ...baseInput,
        telegramId: '123456789',
      }),
      (error: unknown) => error instanceof BadRequestException,
    );
    assert.equal(identityLookups, 1);
  });
});
