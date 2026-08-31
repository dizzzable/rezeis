import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import 'reflect-metadata';

import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';

/**
 * What is true at the QUOTE is not what is true at the CAPTURE
 * ───────────────────────────────────────────────────────────
 *
 * An add-on can only extend a FINITE limit; layered onto an unlimited one it is
 * absorbed and the customer paid for nothing. Both money paths used to answer
 * that question against something other than the subscription's real baseline:
 *
 *   * the renewal capture did not answer it AT ALL — persisted `addOnLines` went
 *     straight into `createPendingInTransaction`, so eligibility at quote time
 *     was the only gate a renewal add-on ever passed;
 *   * the direct-purchase capture answered it against the RAW TERM, so an
 *     operator setting the COLUMN to unlimited between draft and capture left
 *     the term's finite number in place, a charged entitlement was created, and
 *     `EffectiveProjectionService` — which does resolve the override — then
 *     absorbed it into an unlimited desired state.
 *
 * Both windows are genuine TOCTOU: the answer at capture may legitimately differ
 * from the answer at quote. What these cases pin is that the difference is
 * VISIBLE and that the two paths handle an already-paid line differently ON
 * PURPOSE — a renewal entitlement activates at a FUTURE term start, so its
 * capture-time verdict is a prediction and the line is captured and flagged; a
 * direct purchase activates immediately, so its verdict is final and the
 * fulfillment is a recorded no-op.
 *
 * Nothing here asserts that a branch was taken. Every case asserts what was
 * written to the ledger for a line the customer has already been charged for.
 */

const GIB = 1024n * 1024n * 1024n;
const DAY_MS = 24 * 60 * 60 * 1000;

type Snapshot = Record<string, unknown>;

/** A stored snapshot carrying all four inherited keys — a DECIDABLE one. */
function decidableSnapshot(patch: Snapshot = {}): Snapshot {
  return {
    id: 'plan-1',
    trafficLimitStrategy: 'NO_RESET',
    trafficLimit: 100,
    deviceLimit: 3,
    internalSquads: [],
    externalSquad: null,
    ...patch,
  };
}

/** A snapshot an import left behind: readable, but carrying no limit keys. */
const unreadableLimits: Snapshot = { id: 'plan-1', trafficLimitStrategy: 'NO_RESET' };

type CapturedEntitlement = {
  readonly sourceLineKey: string;
  readonly type: string;
  readonly totalValue: bigint;
  readonly applicabilitySnapshot: Record<string, unknown>;
};

// ── Renewal capture ─────────────────────────────────────────────────────────

type RenewalLine = {
  readonly type: 'EXTRA_TRAFFIC' | 'EXTRA_DEVICES';
  readonly value: number;
  readonly sourceLineKey: string;
};

/**
 * Drives the REAL `applyCombinedRenewal` over a staged store. The paid item
 * carries a strictly-valid v1 draft snapshot, so the plan the renewal term is
 * minted from is exactly `input.plan` and no live catalog row can change it.
 */
function renewalEnv(input: {
  readonly sub: {
    readonly trafficLimit: number | null;
    readonly deviceLimit: number;
    readonly planSnapshot: Snapshot;
  };
  readonly plan: { readonly trafficLimit: number | null; readonly deviceLimit: number };
  readonly lines: readonly RenewalLine[];
  readonly projection?: {
    readonly activeTrafficContributionBytes: bigint;
    readonly activeDeviceContribution: number;
  } | null;
}) {
  const currentExpiry = new Date(Date.now() + 10 * DAY_MS);
  const captured: CapturedEntitlement[] = [];
  const termCreates: Array<Record<string, unknown>> = [];
  const stats = { projectionReads: 0 };

  const itemSnapshot: Snapshot = {
    snapshotVersion: 1,
    snapshotSource: 'RENEWAL_DRAFT',
    purchaseType: 'RENEW',
    id: 'plan-1',
    name: 'P',
    description: null,
    tag: null,
    type: 'BOTH',
    trafficLimit: input.plan.trafficLimit,
    deviceLimit: input.plan.deviceLimit,
    trafficLimitStrategy: 'NO_RESET',
    internalSquads: [],
    externalSquad: null,
    selectedDurationDays: 30,
    gatewayType: 'YOOKASSA',
    amount: '10',
    currency: 'USD',
  };

  const item = {
    id: 'it-1',
    subscriptionId: 'sub-1',
    planId: 'plan-1',
    durationDays: 30,
    appliedAt: null as Date | null,
    amount: '10',
    currency: 'USD',
    planSnapshot: itemSnapshot,
    addOnLines: input.lines.map((line) => ({
      addOnId: `addon-${line.sourceLineKey}`,
      catalogRevision: 1,
      type: line.type,
      value: line.value,
      lifetime: 'UNTIL_SUBSCRIPTION_END',
      activation: 'TERM_START',
      sourceLineKey: line.sourceLineKey,
      unitAmount: '2.50',
      receiptName: `Paid ${line.type}`,
    })),
  };

  const subscription: Record<string, unknown> = {
    id: 'sub-1',
    status: 'ACTIVE',
    isTrial: false,
    expiresAt: currentExpiry,
    remnawaveId: 'rw-1',
    internalSquads: [],
    externalSquad: null,
    ...input.sub,
  };

  const prismaService = {
    transactionItem: { findMany: async () => [item] },
    user: { updateMany: async () => ({ count: 0 }) },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      const staged = { ...subscription };
      const stagedItem = { ...item };
      const txClient = {
        $queryRaw: async () => [{ id: 'sub-1', status: 'ACTIVE' }],
        subscriptionTerm: {
          findFirst: async (query: { where: { status?: unknown } }) =>
            query.where.status === 'ACTIVE'
              ? { id: 'term-active' }
              : { id: 'term-active', status: 'ACTIVE', generation: 1, endsAt: currentExpiry },
        },
        plan: {
          findUnique: async () => ({
            id: 'plan-1',
            name: 'P',
            description: null,
            tag: null,
            type: 'BOTH',
            availability: 'ALL',
            trafficLimit: input.plan.trafficLimit,
            deviceLimit: input.plan.deviceLimit,
            trafficLimitStrategy: 'NO_RESET',
            internalSquads: [],
            externalSquad: null,
          }),
        },
        subscription: {
          findUnique: async () => ({ ...staged }),
          update: async ({ data }: { data: Record<string, unknown> }) => {
            Object.assign(staged, data);
            return { ...staged };
          },
        },
        subscriptionEffectiveProjection: {
          findUnique: async () => {
            stats.projectionReads += 1;
            return input.projection ?? null;
          },
        },
        profileSyncJob: { create: async ({ data }: { data: object }) => ({ id: 'job-1', ...data }) },
        transactionItem: {
          updateMany: async () => ({ count: 1 }),
          findUnique: async () => ({ ...stagedItem }),
        },
        transaction: { update: async () => ({}) },
      };
      return cb(txClient);
    },
  };

  const entitlements = {
    createPendingInTransaction: async (_tx: unknown, created: CapturedEntitlement) => {
      captured.push(created);
      return { entitlementId: `ent-${captured.length}`, state: 'PENDING_ACTIVATION', created: true, eventId: 'ev' };
    },
  };
  const terms = {
    createScheduledInTransaction: async (_tx: unknown, termInput: Record<string, unknown>) => {
      termCreates.push(termInput);
      return { id: 'term-renewed', generation: 2, status: 'SCHEDULED' };
    },
  };

  const service = new PaymentSubscriptionMutationService(
    prismaService as never,
    // `warn` too: a capture that flags a paid line now also raises an operator
    // card, and a stub that lacks the method turns that into a TypeError inside
    // the money path rather than a visible assertion.
    { info: () => undefined, warn: () => undefined } as never,
    entitlements as never,
    {} as never,
    terms as never,
    // `TrafficResetService` — the sixth dependency. A paid RESET_TRAFFIC add-on
    // is performed after the fulfilment transaction commits; these specs never
    // buy one, but the constructor takes all six.
    {} as never,
  );

  const transaction = {
    id: 'tx-1',
    paymentId: 'pay-1',
    userId: 'user-1',
    subscriptionId: null,
    purchaseType: 'RENEW',
    gatewayType: 'YOOKASSA',
    currency: 'USD',
    amount: { toString: () => '15' },
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    planSnapshot: { combinedRenewal: true, snapshotVersion: 1 },
  };

  return { service, transaction, captured, termCreates, stats };
}

/** The verdict this capture recorded on one paid line. */
function verdict(captured: readonly CapturedEntitlement[], sourceLineKey: string) {
  const row = captured.find((entry) => entry.sourceLineKey === sourceLineKey);
  assert.ok(
    row !== undefined,
    `no entitlement was recorded for paid line ${sourceLineKey}. Money has already moved: a line ` +
      'that cannot be delivered must still leave a durable, refundable record — dropping it is the ' +
      'one outcome this path may never produce.',
  );
  return row.applicabilitySnapshot;
}

describe('renewal capture — a limit change between quote and capture is caught and recorded', () => {
  it('flags a device line whose limit an operator made unlimited after the quote, and still records it', async () => {
    // OVERRIDDEN toward unlimited: the column says 0, the stored snapshot says
    // the plan gave 3. Eligibility said "finite" when this renewal was quoted;
    // by capture the operator has made this ONE customer unlimited, so the paid
    // +2 devices will be absorbed and deliver nothing.
    const env = renewalEnv({
      sub: { trafficLimit: 100, deviceLimit: 0, planSnapshot: decidableSnapshot() },
      plan: { trafficLimit: 100, deviceLimit: 3 },
      lines: [{ type: 'EXTRA_DEVICES', value: 2, sourceLineKey: 'renew:sub-1:devices' }],
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    const recorded = verdict(env.captured, 'renew:sub-1:devices');
    assert.equal(
      recorded.extendable,
      false,
      'the capture-time baseline is unlimited, so this paid line adds nothing and the ledger must say so',
    );
    assert.equal(recorded.source, 'RENEWAL_CAPTURE');
    assert.equal(recorded.baseDeviceLimit, null);
    assert.deepEqual(recorded.overriddenKeys, ['deviceLimit']);
    assert.equal(
      env.captured.length,
      1,
      'the paid line is captured, never dropped — a refund has to be discoverable from the ledger',
    );
    assert.equal(
      env.stats.projectionReads,
      2,
      'the recorded add-on contribution must actually be read, and by BOTH askers on this path: the ' +
        'inherited-limit refresh subtracts it before comparing a column with the stored snapshot, and ' +
        'the capture-time baseline subtracts it again from the row the renewal just wrote. Neither ' +
        'may fall back to a hard zero.',
    );
  });

  it('flags a traffic line whose limit an operator made unlimited after the quote', async () => {
    const env = renewalEnv({
      sub: { trafficLimit: null, deviceLimit: 3, planSnapshot: decidableSnapshot() },
      plan: { trafficLimit: 100, deviceLimit: 3 },
      lines: [{ type: 'EXTRA_TRAFFIC', value: 50, sourceLineKey: 'renew:sub-1:traffic' }],
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    const recorded = verdict(env.captured, 'renew:sub-1:traffic');
    assert.equal(recorded.extendable, false);
    assert.equal(recorded.baseTrafficLimitBytes, null);
  });

  it('flags the line the change touched and leaves the other line on the same payment alone', async () => {
    // Devices went unlimited; traffic did not. A verdict computed per PAYMENT
    // rather than per RESOURCE would condemn both and refund-flag a line that
    // delivers exactly what it promised.
    const env = renewalEnv({
      sub: { trafficLimit: 100, deviceLimit: 0, planSnapshot: decidableSnapshot() },
      plan: { trafficLimit: 100, deviceLimit: 3 },
      lines: [
        { type: 'EXTRA_DEVICES', value: 2, sourceLineKey: 'renew:sub-1:devices' },
        { type: 'EXTRA_TRAFFIC', value: 50, sourceLineKey: 'renew:sub-1:traffic' },
      ],
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(verdict(env.captured, 'renew:sub-1:devices').extendable, false);
    assert.equal(
      verdict(env.captured, 'renew:sub-1:traffic').extendable,
      true,
      'the traffic baseline is still finite; flagging it too would make the flag meaningless',
    );
  });

  it('records a clean verdict when nothing changed — the flag is written for every line', async () => {
    // The other direction, and it is not optional: a check that condemns
    // everything satisfies the cases above and is just as wrong. Writing the
    // verdict only when something is wrong would also make "checked and fine"
    // indistinguishable from "never checked".
    const env = renewalEnv({
      sub: { trafficLimit: 100, deviceLimit: 3, planSnapshot: decidableSnapshot() },
      plan: { trafficLimit: 100, deviceLimit: 3 },
      lines: [{ type: 'EXTRA_DEVICES', value: 2, sourceLineKey: 'renew:sub-1:devices' }],
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    const recorded = verdict(env.captured, 'renew:sub-1:devices');
    assert.equal(
      recorded.extendable,
      true,
      'a never-individually-adjusted subscription renewing onto the same plan must capture cleanly',
    );
    assert.equal(recorded.baseDeviceLimit, 3);
    assert.deepEqual(recorded.overriddenKeys, []);
    assert.equal(recorded.baselineTermId, 'term-renewed', 'the verdict names the term the line binds to');
  });

  it('leaves the term baseline in force for an imported row, so its paid line captures cleanly', async () => {
    // `planSnapshot` carries no limit keys, so a `deviceLimit` of 0 cannot be
    // attributed to an operator. UNDECIDABLE resolves toward the PLAN — the same
    // answer the offer gives — so this line really does land on the term's 3.
    // Collapsing UNDECIDABLE into OVERRIDDEN would flag a perfectly good line
    // for every imported customer at once.
    const env = renewalEnv({
      sub: { trafficLimit: 100, deviceLimit: 0, planSnapshot: unreadableLimits },
      plan: { trafficLimit: 100, deviceLimit: 3 },
      lines: [{ type: 'EXTRA_DEVICES', value: 2, sourceLineKey: 'renew:sub-1:devices' }],
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(verdict(env.captured, 'renew:sub-1:devices').extendable, true);
  });

  it('flags a line when the PLAN went unlimited between quote and capture, not just the column', async () => {
    // Nobody touched this customer; the tariff itself changed to unlimited
    // devices, so the term this renewal mints has no finite device baseline to
    // extend. Same harm, different cause — a check that only watched the column
    // would miss it.
    const env = renewalEnv({
      sub: { trafficLimit: 100, deviceLimit: 3, planSnapshot: decidableSnapshot() },
      plan: { trafficLimit: 100, deviceLimit: 0 },
      lines: [{ type: 'EXTRA_DEVICES', value: 2, sourceLineKey: 'renew:sub-1:devices' }],
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(verdict(env.captured, 'renew:sub-1:devices').extendable, false);
    assert.equal(
      env.termCreates.length,
      1,
      'the renewed term is still minted — the customer keeps the time they paid for',
    );
  });
});

// ── Direct-purchase capture ────────────────────────────────────────────────

const ORIGINAL_DIRECT_PURCHASE = process.env['ADDON_ENTITLEMENT_DIRECT_PURCHASE'];
afterEach(() => {
  if (ORIGINAL_DIRECT_PURCHASE === undefined) delete process.env['ADDON_ENTITLEMENT_DIRECT_PURCHASE'];
  else process.env['ADDON_ENTITLEMENT_DIRECT_PURCHASE'] = ORIGINAL_DIRECT_PURCHASE;
});

/** Drives the REAL `applyAddOnTopUp` → `applyAddOnViaLedger` over a staged store. */
function directPurchaseEnv(input: {
  readonly sub: {
    readonly trafficLimit: number | null;
    readonly deviceLimit: number;
    readonly planSnapshot: Snapshot;
  };
  readonly term: { readonly baseTrafficLimitBytes: bigint | null; readonly baseDeviceLimit: number | null };
  readonly addOnType: 'EXTRA_TRAFFIC' | 'EXTRA_DEVICES';
  readonly addOnValue: number;
  readonly projection?: {
    readonly activeTrafficContributionBytes: bigint;
    readonly activeDeviceContribution: number;
  } | null;
}) {
  process.env['ADDON_ENTITLEMENT_DIRECT_PURCHASE'] = 'true';

  const captured: CapturedEntitlement[] = [];
  const syncJobs: Array<Record<string, unknown>> = [];
  const transactionWrites: Array<Record<string, unknown>> = [];
  const subscription: Record<string, unknown> = {
    id: 'sub-1',
    userId: 'user-1',
    status: 'ACTIVE',
    remnawaveId: 'rw-1',
    ...input.sub,
  };

  const prismaService = {
    transactionItem: { findMany: async () => [] },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      const staged = { ...subscription };
      const txClient = {
        subscription: {
          findUnique: async () => ({ ...staged }),
          update: async ({ data }: { data: Record<string, unknown> }) => {
            Object.assign(staged, data);
            return { ...staged };
          },
        },
        subscriptionTerm: {
          findFirst: async () => ({
            id: 'term-active',
            endsAt: new Date(Date.now() + 30 * DAY_MS),
            trafficResetStrategy: 'NO_RESET',
            resetAnchorAt: new Date('2026-01-01T00:00:00.000Z'),
            ...input.term,
          }),
        },
        subscriptionEffectiveProjection: {
          findUnique: async () => input.projection ?? null,
        },
        profileSyncJob: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            syncJobs.push(data);
            return { id: `job-${syncJobs.length}`, ...data };
          },
        },
        transaction: {
          update: async ({ data }: { data: Record<string, unknown> }) => {
            transactionWrites.push(data);
            return {};
          },
        },
      };
      return cb(txClient);
    },
  };

  const entitlements = {
    createPendingInTransaction: async (_tx: unknown, created: CapturedEntitlement) => {
      captured.push(created);
      return { entitlementId: 'ent-1', state: 'PENDING_ACTIVATION', created: true, eventId: 'ev' };
    },
    transitionInTransaction: async () => ({ entitlementId: 'ent-1', state: 'ACTIVE', changed: true, eventId: 'ev2' }),
  };
  const projections = {
    recomputeInTransaction: async () => ({
      desiredRevision: 4n,
      desiredTrafficLimitBytes: 150n * GIB,
      desiredDeviceLimit: 5,
    }),
  };

  const service = new PaymentSubscriptionMutationService(
    prismaService as never,
    { info: () => undefined } as never,
    entitlements as never,
    projections as never,
    {} as never,
    // `TrafficResetService` — the sixth dependency. A paid RESET_TRAFFIC add-on
    // is performed after the fulfilment transaction commits; these specs never
    // buy one, but the constructor takes all six.
    {} as never,
  );

  const transaction = {
    id: 'tx-1',
    paymentId: 'pay-1',
    userId: 'user-1',
    subscriptionId: null,
    purchaseType: 'ADDITIONAL',
    gatewayType: 'YOOKASSA',
    currency: 'USD',
    amount: { toString: () => '2.50' },
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    planSnapshot: {
      snapshotSource: 'ADDON_PURCHASE',
      addOnId: 'addon-1',
      addOnType: input.addOnType,
      addOnValue: input.addOnValue,
      name: 'Extra',
      targetSubscriptionId: 'sub-1',
      contractVersion: 2,
      addOnRevision: 3,
      lifetime: 'UNTIL_SUBSCRIPTION_END',
      sourceLineKey: 'addon-1',
    },
  };

  return { service, transaction, captured, syncJobs, transactionWrites };
}

describe('direct-purchase capture — the no-op is judged against the baseline, not the raw term', () => {
  it('records a no-op when the operator made the column unlimited while the term still says 3', async () => {
    // The term the customer bought still carries a finite `baseDeviceLimit`, so
    // the old raw-term test saw "finite" and created a charged entitlement that
    // the projection then absorbed into an unlimited desired state: money taken,
    // nothing delivered, and a ledger row claiming otherwise.
    const env = directPurchaseEnv({
      sub: { trafficLimit: 100, deviceLimit: 0, planSnapshot: decidableSnapshot() },
      term: { baseTrafficLimitBytes: 100n * GIB, baseDeviceLimit: 3 },
      addOnType: 'EXTRA_DEVICES',
      addOnValue: 2,
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(
      env.captured.length,
      0,
      'no entitlement may be created against a baseline that absorbs it — the raw term is not the baseline',
    );
    assert.equal(env.syncJobs.length, 1);
    assert.equal(
      (env.syncJobs[0]!.payload as Record<string, unknown>).note,
      'UNLIMITED_NOOP',
      'the no-op has to be recorded; a direct purchase activates immediately, so this verdict is final',
    );
    assert.ok(
      env.transactionWrites.some((write) => write.fulfilledAt !== undefined),
      'fulfillment is still stamped so the webhook does not re-process the payment forever',
    );
  });

  it('records a no-op when the operator made the traffic column unlimited', async () => {
    const env = directPurchaseEnv({
      sub: { trafficLimit: null, deviceLimit: 3, planSnapshot: decidableSnapshot() },
      term: { baseTrafficLimitBytes: 100n * GIB, baseDeviceLimit: 3 },
      addOnType: 'EXTRA_TRAFFIC',
      addOnValue: 50,
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(env.captured.length, 0);
    assert.equal((env.syncJobs[0]!.payload as Record<string, unknown>).note, 'UNLIMITED_NOOP');
  });

  it('creates the entitlement for a never-individually-adjusted subscription (the other direction)', async () => {
    const env = directPurchaseEnv({
      sub: { trafficLimit: 100, deviceLimit: 3, planSnapshot: decidableSnapshot() },
      term: { baseTrafficLimitBytes: 100n * GIB, baseDeviceLimit: 3 },
      addOnType: 'EXTRA_DEVICES',
      addOnValue: 2,
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(
      env.captured.length,
      1,
      'an INHERITED, finite baseline must still be extendable — refusing here withholds paid goods',
    );
    assert.equal(env.captured[0]!.totalValue, 2n);
    assert.equal(
      (env.syncJobs[0]!.payload as Record<string, unknown>).source,
      'ADDON_PURCHASE_LEDGER',
    );
  });

  it('creates the entitlement for an imported row whose snapshot carries no limit keys (UNDECIDABLE)', async () => {
    const env = directPurchaseEnv({
      sub: { trafficLimit: 100, deviceLimit: 0, planSnapshot: unreadableLimits },
      term: { baseTrafficLimitBytes: 100n * GIB, baseDeviceLimit: 3 },
      addOnType: 'EXTRA_DEVICES',
      addOnValue: 2,
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(
      env.captured.length,
      1,
      'UNDECIDABLE resolves toward the PLAN, exactly as the offer and the checkout resolve it',
    );
  });

  it('still records a no-op when the TERM itself is unlimited (the original rule survives)', async () => {
    const env = directPurchaseEnv({
      sub: { trafficLimit: 100, deviceLimit: 0, planSnapshot: decidableSnapshot({ deviceLimit: 0 }) },
      term: { baseTrafficLimitBytes: 100n * GIB, baseDeviceLimit: null },
      addOnType: 'EXTRA_DEVICES',
      addOnValue: 2,
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(env.captured.length, 0);
    assert.equal((env.syncJobs[0]!.payload as Record<string, unknown>).note, 'UNLIMITED_NOOP');
  });
});
