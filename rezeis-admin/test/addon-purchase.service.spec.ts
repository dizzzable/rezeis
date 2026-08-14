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
    fulfilledAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...data,
  };
}

/** Names what actually arrived so a wrong-exception failure is readable. */
function describeError(error: unknown): string {
  return error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error);
}

function build(options: {
  existing?: Record<string, unknown> | null;
  existingAfterRace?: Record<string, unknown> | null;
  createThrowsP2002?: boolean;
  providerError?: unknown;
  /**
   * Price the add-on is sold at (price row + pricing snapshot). `'0'` selects
   * the free-add-on branch — mirrors `createService({ amount: '0' })` in
   * `payments-checkout.service.spec.ts`.
   */
  amount?: string;
  /**
   * Rows affected by the zero-value COMPLETED claim. `0` means a concurrent
   * fulfiller (webhook / sweeper) won it, which sends the service to the
   * re-read below.
   */
  zeroClaimCount?: number;
  /**
   * What the re-read after a LOST claim finds: the winner's fulfilled row, or
   * `null` when the draft is gone (rolled back / swept).
   */
  afterLostClaim?: Record<string, unknown> | null;
} = {}) {
  const amount = options.amount ?? '2.50';
  const created: Array<{ data: Record<string, unknown> }> = [];
  const updated: Array<{ data: Record<string, unknown> }> = [];
  const state = {
    /** Every conditional claim (`transaction.updateMany`) the service issued. */
    claims: [] as Array<{
      readonly where: Record<string, unknown>;
      readonly data: Record<string, unknown>;
    }>,
    providerCreateCalls: 0,
    applyCompletedCalls: 0,
    enqueueCalls: 0,
  };
  // The claim is lost only when the fixture says so; `undefined` means "we won".
  const claimLost = options.zeroClaimCount === 0;
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
        prices: [{ currency: 'USD', price: { toString: () => amount } }],
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
      // The zero-value branch closes the draft with a conditional claim, not a
      // blind update: the `fulfilledAt: null` predicate is what makes a racing
      // webhook / sweeper lose instead of granting the add-on twice.
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        state.claims.push(args);
        return { count: options.zeroClaimCount ?? 1 };
      },
      // After a lost claim the service re-reads the row to choose replay vs
      // conflict; on the won path the same read returns the row it completed.
      findUnique: async () =>
        claimLost ? (options.afterLostClaim ?? null) : txRecord({ status: 'COMPLETED', amount }),
      findUniqueOrThrow: async () => txRecord({ status: 'COMPLETED', amount }),
    },
  };
  const pricing = { buildSnapshot: () => ({ price: amount }) };
  const provider = {
    createCheckout: async () => {
      state.providerCreateCalls += 1;
      if (options.providerError !== undefined) {
        throw options.providerError;
      }
      return { gatewayId: 'g1', gatewayData: {}, checkoutUrl: 'https://pay/1', providerMode: 'REDIRECT' };
    },
  };
  const mutation = {
    applyCompletedTransaction: async () => {
      state.applyCompletedCalls += 1;
      return { syncJobs: [{ id: 'sync-1' }] };
    },
  };
  const queue = {
    enqueue: async () => {
      state.enqueueCalls += 1;
    },
  };
  const settings = { getInternalPlatformPolicy: async () => ({ accessMode: 'PUBLIC' }) };
  const guard = { evaluate: () => null };
  const service = new AddOnPurchaseService(
    prisma as never, pricing as never, provider as never, mutation as never, queue as never, settings as never, guard as never,
  );
  return { service, created, updated, state };
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
    const draft = created[0];
    assert.ok(draft, 'the keyed checkout created no draft to carry the key and fingerprint');
    assert.equal(draft.data.idempotencyKey, 'idem-1');
    assert.equal(draft.data.checkoutFingerprint, FP);
    assert.equal(result.checkoutUrl, 'https://pay/1');
    // v2 entitlement-ledger marker is present for the flag-gated fulfillment.
    const marker = draft.data.planSnapshot as Record<string, unknown>;
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
    const draft = created[0];
    assert.ok(draft, 'the keyless checkout created no fresh draft');
    assert.equal(draft.data.idempotencyKey, null);
    assert.equal(draft.data.checkoutFingerprint, null);
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

// A 0-price add-on (operator grant, fully-covered price) skips the provider and
// is fulfilled inline behind a conditional claim. All three outcomes of that
// claim are covered here — the same three the plan checkout covers in
// `payments-checkout.service.spec.ts`.
describe('AddOnPurchaseService zero-price add-on fulfillment', () => {
  it('grants a zero-price add-on inline without calling the payment provider', async () => {
    const { service, created, state } = build({ existing: null, amount: '0' });

    const result = await service.checkout(baseInput);

    assert.equal(result.checkoutUrl, null);
    assert.equal(result.providerMode, 'NONE');
    assert.equal(result.transactionStatus, 'COMPLETED');
    assert.equal(created.length, 1);
    assert.equal(state.providerCreateCalls, 0, 'no money moves — the provider is never called');
    // Exactly one claim, and its predicate is the idempotency guard itself:
    // a blind `update` here would let a racing webhook grant the add-on twice.
    assert.deepEqual(
      state.claims.map((claim) => claim.where),
      [{ id: 'tx-1', status: 'PENDING', fulfilledAt: null }],
    );
    assert.deepEqual(
      state.claims.map((claim) => claim.data),
      [{ status: 'COMPLETED' }],
    );
    // The add-on is actually applied and its panel sync enqueued.
    assert.equal(state.applyCompletedCalls, 1);
    assert.equal(state.enqueueCalls, 1);
  });

  it('replays the already-fulfilled result when the claim was lost (no second grant)', async () => {
    const { service, state } = build({
      existing: null,
      amount: '0',
      zeroClaimCount: 0,
      afterLostClaim: txRecord({
        paymentId: 'pay-winner',
        status: 'COMPLETED',
        amount: '0',
        fulfilledAt: new Date('2026-07-21T12:00:00.000Z'),
      }),
    });

    const result = await service.checkout(baseInput);

    assert.equal(result.paymentId, 'pay-winner');
    assert.equal(result.transactionStatus, 'COMPLETED');
    assert.equal(result.checkoutUrl, null);
    assert.equal(result.providerMode, 'NONE');
    assert.equal(state.providerCreateCalls, 0);
    assert.equal(
      state.applyCompletedCalls,
      0,
      'the winner already applied this add-on — replaying must not raise the limit again',
    );
    assert.equal(state.enqueueCalls, 0);
  });

  it('refuses with 409 when the claimed draft is gone — absence is not a fulfilled purchase', async () => {
    // Regression guard. The lost-claim re-read used `current?.fulfilledAt !== null`,
    // so a VANISHED row (rolled back / swept) evaluated `undefined !== null` → true
    // and fell into the replay branch, which dereferences `current.paymentId` on
    // null: a TypeError, i.e. HTTP 500 where the code below means to answer 409.
    // Restoring the `?.` must fail here, and say why.
    const { service, state } = build({
      existing: null,
      amount: '0',
      zeroClaimCount: 0,
      afterLostClaim: null,
    });

    await assert.rejects(
      () => service.checkout(baseInput),
      (error: unknown) => {
        if (!(error instanceof ConflictException)) {
          assert.fail(
            `a vanished zero-price draft must answer 409 ConflictException, got ${describeError(error)}. ` +
              'A missing row is not a completed purchase: the re-read must check `current !== null` ' +
              'before replaying it, otherwise the replay branch dereferences null and returns 500.',
          );
        }
        assert.match(error.message, /already being fulfilled/);
        return true;
      },
    );

    // Nothing was granted on the way out.
    assert.equal(state.applyCompletedCalls, 0);
    assert.equal(state.enqueueCalls, 0);
    assert.equal(state.providerCreateCalls, 0);
  });
});
