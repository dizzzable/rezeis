import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AddOnEligibilityService } from '../src/modules/add-ons/services/add-on-eligibility.service';
import { AddOnPurchaseService } from '../src/modules/payments/services/addon-purchase.service';
import { buildAddOnCheckoutFingerprint } from '../src/modules/payments/utils/checkout-fingerprint.util';

// `UNTIL_SUBSCRIPTION_END` because that is what the default catalog row below
// sells. A `UNTIL_NEXT_RESET` add-on is only SELLABLE while the intake can bind
// it to a reset epoch (`resolveIntakeResetCapabilities`), which the default
// fixture — NO_RESET strategy, rollout flags off — deliberately cannot; every
// case in this file would then be answered by the lifetime guard instead of the
// thing it means to exercise. The lifetime guard has its own file,
// `test/add-on-checkout-lifetime-gate.spec.ts`.
const FP = buildAddOnCheckoutFingerprint({
  contractVersion: 2,
  userId: 'user-1',
  subscriptionId: 'sub-1',
  termId: null,
  addOnId: 'addon-1',
  addOnRevision: 3,
  type: 'EXTRA_TRAFFIC',
  value: 50,
  lifetime: 'UNTIL_SUBSCRIPTION_END',
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

const GIB = 1024n * 1024n * 1024n;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The end of a term window that is still OPEN, expressed relative to the wall
 * clock rather than as a literal.
 *
 * `resolveAddOnLifetimeGrant` — the one reader the offer and this checkout
 * share — refuses an `UNTIL_SUBSCRIPTION_END` add-on whose window has already
 * closed, because `applyAddOnViaLedger` requires `endsAt > now` before it will
 * bind the entitlement to that window and otherwise falls through to the
 * PERMANENT legacy increment. The literal `2026-03-01` these fixtures used to
 * carry described a live subscription when they were written and an expired one
 * afterwards, so every "the draft is created" assertion below silently drifted
 * into asserting that a CLOSED term still sells.
 */
const LIVE_TERM_ENDS_AT = new Date(Date.now() + 60 * DAY_MS);

/** The target subscription's own columns, as checkout selects them. */
type SubColumns = {
  trafficLimit: number | null;
  deviceLimit: number;
  planSnapshot: unknown;
  createdAt: Date;
  expiresAt: Date | null;
};

/**
 * The ACTIVE durable term as checkout selects it — the resource baseline (what
 * the customer BOUGHT) plus the three fields the LIFETIME guard reads.
 *
 * The window/reset fields are not decoration: Prisma returns `null` for a
 * nullable column, never `undefined`, and a fixture that omitted `endsAt`
 * altogether would sail past an `endsAt === null` guard on `undefined` and
 * report a pass for a subscription with no term window at all.
 */
type TermRow = {
  baseTrafficLimitBytes: bigint | null;
  baseDeviceLimit: number | null;
  endsAt: Date | null;
  trafficResetStrategy: string;
  resetAnchorAt: Date | null;
};

/** What the previous projection recompute recorded as the add-on share. */
type ProjectionRow = {
  activeTrafficContributionBytes: bigint;
  activeDeviceContribution: number;
};

/**
 * A never-individually-adjusted subscriber: the columns equal what the stored
 * snapshot says the plan gave them, so both limit fields read as INHERITED and
 * the term's baseline governs.
 */
const defaultSubColumns: SubColumns = {
  trafficLimit: 100,
  deviceLimit: 3,
  planSnapshot: {
    id: 'plan-a',
    trafficLimitStrategy: 'NO_RESET',
    trafficLimit: 100,
    deviceLimit: 3,
    internalSquads: [],
    externalSquad: null,
  },
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  expiresAt: LIVE_TERM_ENDS_AT,
};

const defaultTerm: TermRow = {
  baseTrafficLimitBytes: 100n * GIB,
  baseDeviceLimit: 3,
  endsAt: LIVE_TERM_ENDS_AT,
  // NO_RESET + no anchor: the default world sells `UNTIL_SUBSCRIPTION_END` and
  // has no commercial reset window, which is the production default (every
  // `reset_expiry_*` rollout flag is off).
  trafficResetStrategy: 'NO_RESET',
  resetAnchorAt: null,
};

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
  /** Overrides on the target subscription's own columns + stored snapshot. */
  sub?: Partial<SubColumns>;
  /**
   * The ACTIVE durable term, or `null` for the pre-cutover fallback path.
   * Merged over {@link defaultTerm}, so a case names only what it varies.
   */
  term?: Partial<TermRow> | null;
  /** The projection row a previous recompute left, or `null` when there is none. */
  projection?: ProjectionRow | null;
  /** Overrides on the catalog row being bought (type, value, plan scoping…). */
  addOn?: Record<string, unknown>;
} = {}) {
  const amount = options.amount ?? '2.50';
  const columns: SubColumns = { ...defaultSubColumns, ...options.sub };
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
    projectionReads: 0,
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
      findUnique: async () => ({ id: 'sub-1', userId: 'user-1', status: 'ACTIVE', ...columns }),
    },
    // The ACTIVE durable term the resource guard resolves its baseline against.
    // Present by default: the term path is the one where offer and checkout can
    // disagree, so it is what the whole file exercises unless a case says
    // otherwise.
    subscriptionTerm: {
      findFirst: async () =>
        options.term === null ? null : { ...defaultTerm, ...(options.term ?? {}) },
    },
    // The contribution the PREVIOUS projection recorded. Counted so a case can
    // pin that the read really happens instead of a hard 0 standing in for it.
    subscriptionEffectiveProjection: {
      findUnique: async () => {
        state.projectionReads += 1;
        return options.projection ?? null;
      },
    },
    addOn: {
      findUnique: async () => ({
        id: 'addon-1', isActive: true, revision: 3, type: 'EXTRA_TRAFFIC', value: 50,
        lifetime: 'UNTIL_SUBSCRIPTION_END', name: 'Extra 50GB', applicablePlanIds: [],
        prices: [{ currency: 'USD', price: { toString: () => amount } }],
        ...options.addOn,
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
    assert.equal(marker.lifetime, 'UNTIL_SUBSCRIPTION_END');
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

// ── The offer and the checkout must answer ONE question ─────────────────────
//
// Discovery is authoritative for what a customer is SHOWN; checkout re-validates
// server-side and is authoritative for money. That division is fine. What is not
// fine is the two answering "is this subscription already unlimited?" with two
// different derivations — because then discovery offers a product checkout
// refuses, and the customer sees a 400 on a button we drew for them.
//
// That is precisely what happened. `AddOnEligibilityService` was corrected to
// ask `resolveEntitlementBaseline` (term baseline + the operator-override rule
// read off `planSnapshot`), while checkout kept testing the RAW `Subscription`
// columns. The two agree on an OVERRIDDEN row and part company on an
// UNDECIDABLE one — an imported row whose snapshot carries no limit keys.
//
// So every case below asks the SAME world twice, once through the real
// `AddOnEligibilityService` and once through the real `AddOnPurchaseService`,
// and asserts on the PAIR. Asserting only on checkout would pass just as well
// with checkout refusing everything.
describe('AddOnPurchaseService — checkout agrees with the offer about "already unlimited"', () => {
  /** A stored snapshot carrying all four inherited keys, i.e. a DECIDABLE one. */
  function decidableSnapshot(patch: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'plan-a',
      trafficLimitStrategy: 'NO_RESET',
      trafficLimit: 100,
      deviceLimit: 3,
      internalSquads: [],
      externalSquad: null,
      ...patch,
    };
  }

  /** A snapshot an import left behind: readable, but carrying no limit keys. */
  const unreadableLimits = { id: 'plan-a', trafficLimitStrategy: 'NO_RESET' };

  type Answer = {
    readonly offered: boolean;
    readonly bought: boolean;
    readonly refusal: string | null;
    readonly checkoutProjectionReads: number;
  };

  /**
   * Runs one world past BOTH gates. The two services get the same subscription
   * columns, the same ACTIVE term, the same projection row and the same catalog
   * entry — so a disagreement here is a disagreement about the rule, never about
   * the fixture.
   */
  async function askBoth(world: {
    readonly type: 'EXTRA_TRAFFIC' | 'EXTRA_DEVICES';
    readonly sub?: Partial<SubColumns>;
    readonly term?: Partial<TermRow> | null;
    readonly projection?: ProjectionRow | null;
  }): Promise<Answer> {
    const columns: SubColumns = { ...defaultSubColumns, ...world.sub };
    const term = world.term === null ? null : { ...defaultTerm, ...(world.term ?? {}) };
    const catalogEntry = {
      id: 'addon-1',
      revision: 3,
      name: 'Extra',
      description: null,
      type: world.type,
      icon: null,
      value: 50,
      lifetime: 'UNTIL_SUBSCRIPTION_END',
      applicablePlanIds: [] as string[],
      prices: [{ currency: 'USD', price: '2.50' }],
    };

    const eligibilityPrisma = {
      subscription: {
        findUnique: async () => ({ id: 'sub-1', userId: 'user-1', status: 'ACTIVE', ...columns }),
      },
      subscriptionTerm: {
        // The IDENTICAL row both services read — window and reset fields
        // included. The two used to be handed different `endsAt` / anchors,
        // which is exactly the kind of fixture difference that can make a
        // genuine offer↔checkout disagreement look like agreement.
        findFirst: async () => (term === null ? null : { id: 'term-1', planId: 'plan-a', ...term }),
      },
      subscriptionEffectiveProjection: {
        findUnique: async () => world.projection ?? null,
      },
      user: { findFirst: async () => ({ id: 'user-1' }) },
      addOn: { findMany: async () => [catalogEntry] },
    };
    const offer = await new AddOnEligibilityService(eligibilityPrisma as never, {} as never).listForSubscription(
      'sub-1',
    );

    const { service, state } = build({
      sub: world.sub,
      term,
      projection: world.projection,
      addOn: { type: world.type, lifetime: 'UNTIL_SUBSCRIPTION_END', value: 50 },
    });
    let bought = false;
    let refusal: string | null = null;
    try {
      await service.checkout({
        userId: 'user-1',
        addOnId: 'addon-1',
        subscriptionId: 'sub-1',
        gatewayType: 'YOOKASSA' as never,
        contractVersion: 2,
      });
      bought = true;
    } catch (error: unknown) {
      if (!(error instanceof BadRequestException)) throw error;
      refusal = error.message;
    }

    return {
      offered: offer.addOns.some((addOn) => addOn.id === 'addon-1'),
      bought,
      refusal,
      checkoutProjectionReads: state.projectionReads,
    };
  }

  // ── UNDECIDABLE: the case the two used to disagree on ─────────────────────

  it('sells the devices it offered on an imported row whose snapshot carries no limit keys', async () => {
    // The headline defect, verbatim: `planSnapshot` has no `deviceLimit` key, so
    // the column's 0 cannot be attributed to an operator. That is UNDECIDABLE
    // and it resolves toward the PLAN, so the term's finite 3 stands and the
    // add-on really does land on top of it. Judging the raw column instead reads
    // `deviceLimit <= 0` as unlimited and answers 400 on a product we drew a
    // button for.
    const answer = await askBoth({
      type: 'EXTRA_DEVICES',
      sub: { deviceLimit: 0, planSnapshot: unreadableLimits },
    });

    assert.equal(answer.offered, true, 'the offer must still be made for an UNDECIDABLE row');
    assert.equal(
      answer.bought,
      true,
      `checkout refused an add-on the offer advertised (${answer.refusal ?? 'no refusal recorded'}). ` +
        'An unreadable snapshot is UNDECIDABLE, not OVERRIDDEN: checkout must resolve the baseline ' +
        'through resolveConfiguredEntitlementBaseline, not read Subscription.deviceLimit raw.',
    );
    assert.equal(
      answer.checkoutProjectionReads,
      1,
      'checkout must read the projection row the offer reads, not substitute a hard 0',
    );
  });

  it('sells the traffic it offered on an imported row whose snapshot carries no limit keys', async () => {
    const answer = await askBoth({
      type: 'EXTRA_TRAFFIC',
      sub: { trafficLimit: null, planSnapshot: unreadableLimits },
    });

    assert.equal(answer.offered, true);
    assert.equal(
      answer.bought,
      true,
      `checkout refused an add-on the offer advertised (${answer.refusal ?? 'no refusal recorded'})`,
    );
  });

  // ── OVERRIDDEN toward unlimited: BOTH refuse ──────────────────────────────

  it('refuses, like the offer does, when the operator granted unlimited devices over a finite term', async () => {
    const answer = await askBoth({
      type: 'EXTRA_DEVICES',
      sub: { deviceLimit: 0, planSnapshot: decidableSnapshot() },
    });

    assert.equal(answer.offered, false, 'the offer must be withheld for an OVERRIDDEN-unlimited row');
    assert.equal(
      answer.bought,
      false,
      'a crafted request must not buy devices for a subscription an operator made unlimited — ' +
        'the contribution would be absorbed and the customer would pay for nothing',
    );
    assert.match(String(answer.refusal), /unlimited devices/);
  });

  it('refuses, like the offer does, when the operator granted unlimited traffic over a finite term', async () => {
    const answer = await askBoth({
      type: 'EXTRA_TRAFFIC',
      sub: { trafficLimit: null, planSnapshot: decidableSnapshot() },
    });

    assert.equal(answer.offered, false);
    assert.equal(answer.bought, false);
    assert.match(String(answer.refusal), /unlimited traffic/);
  });

  // ── INHERITED: the other direction, and it is not optional ────────────────
  //
  // Refusing every row whose column differs from the term would satisfy the two
  // cases above and be just as wrong: it would freeze a paying customer out of
  // the upgrade they are already entitled to. These fail if the guard is
  // inverted, and the two above fail if it is not — neither pair alone pins it.

  it('lets a never-individually-adjusted subscription buy devices (INHERITED, finite)', async () => {
    const answer = await askBoth({
      type: 'EXTRA_DEVICES',
      sub: { deviceLimit: 3, planSnapshot: decidableSnapshot() },
    });

    assert.equal(answer.offered, true);
    assert.equal(
      answer.bought,
      true,
      `checkout refused a finite, never-adjusted subscription (${answer.refusal ?? 'no refusal recorded'}). ` +
        'Column equal to snapshot is INHERITED: the term the customer paid for governs and the add-on applies.',
    );
  });

  it('lets a never-individually-adjusted subscription buy traffic (INHERITED, finite)', async () => {
    const answer = await askBoth({
      type: 'EXTRA_TRAFFIC',
      sub: { trafficLimit: 100, planSnapshot: decidableSnapshot() },
    });

    assert.equal(answer.offered, true);
    assert.equal(
      answer.bought,
      true,
      `checkout refused a finite, never-adjusted subscription (${answer.refusal ?? 'no refusal recorded'})`,
    );
  });

  it('lets an operator-RAISED finite limit buy more — an override is not a refusal', async () => {
    // Column 12 against a snapshot of 3: genuinely OVERRIDDEN, and genuinely
    // finite. The operator's 12 becomes the baseline and 12 + 50 is a real
    // increase, so refusing here would confuse "overridden" with "unlimited".
    const answer = await askBoth({
      type: 'EXTRA_DEVICES',
      sub: { deviceLimit: 12, planSnapshot: decidableSnapshot() },
    });

    assert.equal(answer.offered, true);
    assert.equal(answer.bought, true, answer.refusal ?? 'checkout refused an overridden-but-finite row');
  });

  // ── Pre-cutover: no ACTIVE term, so the columns ARE the baseline ──────────

  it('falls back to the subscription columns with no ACTIVE term, and reads no projection row', async () => {
    const unlimited = await askBoth({
      type: 'EXTRA_DEVICES',
      term: null,
      sub: { deviceLimit: 0, planSnapshot: decidableSnapshot() },
    });
    assert.equal(unlimited.offered, false);
    assert.equal(unlimited.bought, false, 'the pre-cutover fallback must still refuse an unlimited column');
    assert.equal(
      unlimited.checkoutProjectionReads,
      0,
      'the pre-cutover path has no recorded contribution to subtract; it must not pay for that query',
    );

    const finite = await askBoth({
      type: 'EXTRA_DEVICES',
      term: null,
      sub: { deviceLimit: 4, planSnapshot: decidableSnapshot() },
    });
    assert.equal(finite.offered, true);
    assert.equal(finite.bought, true, finite.refusal ?? 'the pre-cutover fallback refused a finite column');
  });

  // ── A finite budget of zero gigabytes is not "unlimited" ──────────────────

  it('keeps the two encodings apart: a 0-byte traffic baseline is buyable, a 0 device baseline is not', async () => {
    // Both rows are INHERITED (column equals snapshot), so in both the TERM's
    // baseline governs — and the two resources encode "zero" to opposite
    // meanings. Harmonising them would silently break one of these two lines.
    const zeroTraffic = await askBoth({
      type: 'EXTRA_TRAFFIC',
      term: { baseTrafficLimitBytes: 0n, baseDeviceLimit: 3 },
      sub: { trafficLimit: 0, planSnapshot: decidableSnapshot({ trafficLimit: 0 }) },
    });
    assert.equal(zeroTraffic.offered, true);
    assert.equal(
      zeroTraffic.bought,
      true,
      'a 0-byte traffic baseline is a real budget of zero gigabytes — adding 50 GB delivers 50 GB',
    );

    const zeroDevices = await askBoth({
      type: 'EXTRA_DEVICES',
      term: { baseTrafficLimitBytes: 100n * GIB, baseDeviceLimit: 0 },
      sub: { deviceLimit: 0, planSnapshot: decidableSnapshot({ deviceLimit: 0 }) },
    });
    assert.equal(zeroDevices.offered, false);
    assert.equal(
      zeroDevices.bought,
      false,
      'a 0 device baseline is the canonical unlimited, matching the panel — the add-on would be absorbed',
    );
  });
});
