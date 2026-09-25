import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import 'reflect-metadata';

import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { pinAddOnStagesOffForThisFile } from './helpers/rollout-flags';

// Written against every stage off (stage 1's lazy entry would take the row
// lock these fakes do not stage); the direct-purchase cases turn stage 2 on
// themselves.
pinAddOnStagesOffForThisFile();

/**
 * What is true at the QUOTE is not what is true at the CAPTURE
 * ───────────────────────────────────────────────────────────
 *
 * An add-on can only extend a FINITE limit; layered onto an unlimited one it is
 * absorbed and the customer paid for nothing. The direct-purchase capture used
 * to answer that question against the RAW TERM, so an operator setting the
 * COLUMN to unlimited between draft and capture left the term's finite number
 * in place, a charged entitlement was created, and `EffectiveProjectionService`
 * — which does resolve the override — then absorbed it into an unlimited
 * desired state.
 *
 * The window is genuine TOCTOU: the answer at capture may legitimately differ
 * from the answer at quote. A direct purchase activates immediately, so its
 * capture-time verdict is final and the fulfillment is a recorded no-op. (The
 * other path this file used to pin — add-ons sold with a renewal, whose verdict
 * was a prediction for a future term start — was deleted with its capture on
 * 24.09.2026.)
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

// ── Direct-purchase capture ────────────────────────────────────────────────

afterEach(() => {
  // Back to the file's pinned OFF; the pin puts the real environment back
  // after the file.
  process.env['ADDON_ENTITLEMENT_DIRECT_PURCHASE'] = 'false';
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
    // Where the ACTIVE term below ends: «до конца подписки» is bound to it.
    expiresAt: new Date(Date.now() + 30 * DAY_MS),
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
    // The ledger aligns the term with the subscription's expiry before reading
    // it; this staged term already ends where the subscription does.
    { alignTailToExpiryInTransaction: async () => ({ outcome: 'UNCHANGED', termId: 'term-active' }) } as never,
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
