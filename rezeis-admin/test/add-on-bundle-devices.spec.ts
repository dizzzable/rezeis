import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import 'reflect-metadata';

import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { executeGatewayDataWrites } from './helpers/gateway-data-write-double';
import { pinAddOnStagesOffForThisFile } from './helpers/rollout-flags';

/**
 * ONE PAYMENT, EVERY PROFILE OF A MERGED SUBSCRIPTION
 * ────────────────────────────────────────────────────
 * An «объединённая подписка» is ONE product sold once, delivered as one
 * Remnawave profile per member plan — and this panel keeps a device limit PER
 * PROFILE. A «+1 устройство» bought on it used to raise the profile the
 * customer bought on and nothing else: the card (which faces the visible
 * member) then read 3 devices while the other half still cut the customer off
 * at 2. The owner's rule (21.11.2026): devices follow the whole merged
 * subscription, for THIS customer's own subscriptions — never for the plan's
 * other buyers (that is the bundle card's number, and the operator's).
 *
 * Written against every stage off, like `add-on-capture-time-baseline.spec.ts`;
 * the ledger cases turn direct purchase on themselves. Nothing here asserts
 * that a branch was taken — every case asserts what was written.
 */

pinAddOnStagesOffForThisFile();

const DAY_MS = 24 * 60 * 60 * 1000;
const GIB = 1024n * 1024n * 1024n;

type Snapshot = Record<string, unknown>;

/** A member plan's snapshot carrying the SOLD-bundle marker (`bundle-snapshot.util.ts`). */
function bundledSnapshot(input: {
  readonly planId: string;
  readonly deviceLimit: number;
}): Snapshot {
  return {
    id: input.planId,
    name: input.planId,
    trafficLimitStrategy: 'NO_RESET',
    trafficLimit: 100,
    deviceLimit: input.deviceLimit,
    internalSquads: [],
    externalSquad: null,
    bundleId: 'bundle-1',
    bundlePlanId: 'plan-face',
  };
}

/** An ordinary plan's snapshot: no `bundleId`, so no merged subscription. */
function ordinarySnapshot(input: {
  readonly planId: string;
  readonly deviceLimit: number;
}): Snapshot {
  return {
    id: input.planId,
    name: input.planId,
    trafficLimitStrategy: 'NO_RESET',
    trafficLimit: 100,
    deviceLimit: input.deviceLimit,
    internalSquads: [],
    externalSquad: null,
  };
}

interface StagedRow {
  id: string;
  userId: string;
  status: string;
  remnawaveId: string | null;
  expiresAt: Date;
  trafficLimit: number | null;
  deviceLimit: number;
  planSnapshot: Snapshot;
}

interface CapturedEntitlement {
  readonly subscriptionId: string;
  readonly termId: string;
  readonly sourceLineKey: string;
  readonly type: string;
  readonly valuePerUnit: number;
  readonly totalValue: bigint;
  readonly applicabilitySnapshot: Record<string, unknown>;
  readonly unitAmount: unknown;
  readonly totalAmount: unknown;
  readonly expiresAt: Date | null;
  readonly companionOfBundleSibling?: boolean;
}

/**
 * Drives the REAL `applyAddOnTopUp` over a staged store of a merged
 * subscription's two profiles.
 *
 * `ledger` decides which of the two fulfilment paths the capture takes: with it
 * on, direct purchase is enabled and the target gets a ledger line (as
 * `applyAddOnViaLedger` does); with it off the legacy branch raises columns.
 * In both cases the sibling half runs through the code under test.
 */
function bundleCaptureEnv(input: {
  /** The halves: the FIRST is the one the customer bought on. */
  readonly halves: readonly { readonly planSnapshot: Snapshot; readonly deviceLimit: number }[];
  /** The `baseDeviceLimit` both terms carry — what the card handed every profile. */
  readonly termBaseDeviceLimit: number | null;
  readonly addOnType: 'EXTRA_DEVICES' | 'EXTRA_TRAFFIC';
  readonly addOnValue: number;
  readonly ledger: boolean;
}) {
  const expiresAt = new Date(Date.now() + 30 * DAY_MS);
  const rows = new Map<string, StagedRow>();
  input.halves.forEach((half, index) => {
    const id = `sub-${index + 1}`;
    rows.set(id, {
      id,
      userId: 'user-1',
      status: 'ACTIVE',
      remnawaveId: `rw-${index + 1}`,
      expiresAt,
      trafficLimit: 100,
      deviceLimit: half.deviceLimit,
      planSnapshot: half.planSnapshot,
    });
  });
  const targetId = 'sub-1';

  const captured: CapturedEntitlement[] = [];
  const syncJobs: Array<Record<string, unknown>> = [];
  const transactionWrites: Array<Record<string, unknown>> = [];

  const applyUpdate = (id: string, data: Record<string, unknown>): StagedRow => {
    const row = rows.get(id);
    assert.ok(row !== undefined, `update of an unknown staged subscription ${id}`);
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'object' && value !== null && 'increment' in (value as object)) {
        const increment = Number((value as { increment: number }).increment);
        (row as unknown as Record<string, number>)[key] =
          Number((row as unknown as Record<string, unknown>)[key]) + increment;
        continue;
      }
      (row as unknown as Record<string, unknown>)[key] = value;
    }
    return { ...row };
  };

  const txClient = {
    subscription: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = rows.get(where.id);
        return row === undefined ? null : { ...row };
      },
      findMany: async () => [...rows.values()].map((row) => ({ ...row })),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        applyUpdate(where.id, data),
    },
    subscriptionTerm: {
      findFirst: async ({ where }: { where: { subscriptionId: string } }) => {
        const row = rows.get(where.subscriptionId);
        if (row === undefined) return null;
        return {
          id: `term-${row.id}`,
          planId: (row.planSnapshot as Snapshot)['id'],
          startsAt: new Date(Date.now() - DAY_MS),
          endsAt: row.expiresAt,
          baseTrafficLimitBytes: 100n * GIB,
          baseDeviceLimit: input.termBaseDeviceLimit,
          trafficResetStrategy: 'NO_RESET',
          resetAnchorAt: new Date('2026-01-01T00:00:00.000Z'),
        };
      },
    },
    subscriptionEffectiveProjection: {
      findUnique: async () => null,
    },
    addOnEntitlement: {
      // The primary line, as `applyAddOnViaLedger` has just written it — the
      // quote the companion lines are copied from. A capture the ledger recorded
      // as a NO-OP writes no line at all, which is what `captured.length` says.
      findUnique: async () =>
        input.ledger && captured.length > 0
          ? {
              id: 'ent-primary',
              addOnId: 'addon-1',
              catalogRevision: 3,
              receiptName: 'Extra',
              currency: 'USD',
              lifetime: 'UNTIL_SUBSCRIPTION_END',
              expiresAt,
              totalValue: BigInt(input.addOnValue),
            }
          : null,
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
    $executeRaw: executeGatewayDataWrites({
      currentGatewayData: () => ({}),
      update: async () => ({}),
    }),
  };

  const prismaService = {
    transactionItem: { findMany: async () => [] },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(txClient),
  };

  const entitlements = {
    createPendingInTransaction: async (_tx: unknown, created: CapturedEntitlement) => {
      captured.push(created);
      return {
        entitlementId: `ent-${captured.length}`,
        state: 'PENDING_ACTIVATION',
        created: true,
        eventId: `event-${captured.length}`,
      };
    },
    transitionInTransaction: async () => ({
      entitlementId: 'ent',
      state: 'ACTIVE',
      changed: true,
      eventId: 'event',
    }),
  };
  const projections = {
    recomputeInTransaction: async ({ subscriptionId }: { subscriptionId: string }) => ({
      desiredRevision: 4n,
      desiredTrafficLimitBytes: 150n * GIB,
      // What the projection must arrive at for a +1 device on a 2-device pair.
      desiredDeviceLimit: 2 + input.addOnValue,
      subscriptionId,
    }),
  };

  const service = new PaymentSubscriptionMutationService(
    prismaService as never,
    { info: () => undefined } as never,
    entitlements as never,
    projections as never,
    {
      alignTailToExpiryInTransaction: async () => ({ outcome: 'UNCHANGED', termId: 'term' }),
    } as never,
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
      targetSubscriptionId: targetId,
      contractVersion: 2,
      addOnRevision: 3,
      lifetime: 'UNTIL_SUBSCRIPTION_END',
      sourceLineKey: 'addon-1',
    },
  };

  return { service, transaction, captured, syncJobs, transactionWrites, rows, targetId, expiresAt };
}

afterEach(() => {
  // Back to the file's pinned OFF; the pin restores the real environment after
  // the file.
  process.env['ADDON_ENTITLEMENT_DIRECT_PURCHASE'] = 'false';
});

const MERGED_HALVES = [
  { planSnapshot: bundledSnapshot({ planId: 'plan-obhody', deviceLimit: 2 }), deviceLimit: 2 },
  { planSnapshot: bundledSnapshot({ planId: 'plan-premium', deviceLimit: 2 }), deviceLimit: 2 },
] as const;

describe('a merged subscription\u2019s device add-on reaches every profile', () => {
  it('gives the other half its own companion line and pushes both profiles', async () => {
    process.env['ADDON_ENTITLEMENT_DIRECT_PURCHASE'] = 'true';
    const env = bundleCaptureEnv({
      halves: MERGED_HALVES,
      termBaseDeviceLimit: 2,
      addOnType: 'EXTRA_DEVICES',
      addOnValue: 1,
      ledger: true,
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(env.captured.length, 2, 'one line per profile of the product');
    const companion = env.captured.find((line) => line.subscriptionId === 'sub-2');
    assert.ok(companion !== undefined, 'the half the customer did not buy on must get the device');
    assert.equal(companion.companionOfBundleSibling, true);
    assert.equal(companion.applicabilitySnapshot['companion'], true);
    assert.equal(companion.applicabilitySnapshot['primaryEntitlementId'], 'ent-primary');
    assert.equal(companion.sourceLineKey, 'addon-1@sub-2', 'a line key of its own, replayable');
    assert.equal(companion.valuePerUnit, 1);
    assert.equal(
      String(companion.unitAmount),
      '0',
      'the money was charged once, on the primary line',
    );
    assert.equal(String(companion.totalAmount), '0');
    assert.equal(
      companion.expiresAt?.getTime(),
      env.expiresAt.getTime(),
      'both halves end together',
    );

    assert.equal(env.syncJobs.length, 2, 'each profile is pushed on its own');
    assert.deepEqual(env.syncJobs.map((job) => job['subscriptionId']).sort(), ['sub-1', 'sub-2']);
    assert.equal(
      (
        env.syncJobs.find((job) => job['subscriptionId'] === 'sub-2')?.payload as Record<
          string,
          unknown
        >
      )['source'],
      'ADDON_PURCHASE_LEDGER_COMPANION',
    );
    assert.equal(
      env.rows.get('sub-2')?.deviceLimit,
      3,
      'the sibling half carries the extra device',
    );
  });

  it('leaves an unlimited half alone instead of minting a line nothing delivers', async () => {
    process.env['ADDON_ENTITLEMENT_DIRECT_PURCHASE'] = 'true';
    const env = bundleCaptureEnv({
      halves: [
        // The operator raised the target's COLUMN to unlimited after the quote:
        // the purchase is a recorded no-op, and the other half must not receive
        // the product instead.
        {
          planSnapshot: bundledSnapshot({ planId: 'plan-obhody', deviceLimit: 2 }),
          deviceLimit: 0,
        },
        {
          planSnapshot: bundledSnapshot({ planId: 'plan-premium', deviceLimit: 2 }),
          deviceLimit: 2,
        },
      ],
      termBaseDeviceLimit: 2,
      addOnType: 'EXTRA_DEVICES',
      addOnValue: 1,
      ledger: true,
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(
      env.captured.length,
      0,
      'nothing was granted to the target, so nothing is mirrored',
    );
    assert.equal(env.syncJobs.length, 1, 'only the target is re-read');
    assert.equal(env.rows.get('sub-1')?.deviceLimit, 0);
    assert.equal(env.rows.get('sub-2')?.deviceLimit, 2);
  });

  it('does nothing extra for a subscription that was not sold as a bundle', async () => {
    process.env['ADDON_ENTITLEMENT_DIRECT_PURCHASE'] = 'true';
    const env = bundleCaptureEnv({
      halves: [
        { planSnapshot: ordinarySnapshot({ planId: 'plan-solo', deviceLimit: 2 }), deviceLimit: 2 },
        {
          planSnapshot: ordinarySnapshot({ planId: 'plan-other', deviceLimit: 2 }),
          deviceLimit: 2,
        },
      ],
      termBaseDeviceLimit: 2,
      addOnType: 'EXTRA_DEVICES',
      addOnValue: 1,
      ledger: true,
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(env.captured.length, 1, 'a separate purchase on a separate plan stays separate');
    assert.equal(env.syncJobs.length, 1);
    assert.equal(env.rows.get('sub-2')?.deviceLimit, 2);
  });

  it('keeps a traffic top-up on the half it was bought for', async () => {
    process.env['ADDON_ENTITLEMENT_DIRECT_PURCHASE'] = 'true';
    const env = bundleCaptureEnv({
      halves: MERGED_HALVES,
      termBaseDeviceLimit: 2,
      addOnType: 'EXTRA_TRAFFIC',
      addOnValue: 50,
      ledger: true,
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    // Each half's traffic is its own member plan («25 ГБ + безлимит» is not one
    // budget), and the cabinet prints the visible member's counter.
    assert.equal(env.captured.length, 1);
    assert.equal(env.syncJobs.length, 1);
  });

  it('raises both columns when the ledger is off (legacy increment)', async () => {
    const env = bundleCaptureEnv({
      halves: MERGED_HALVES,
      termBaseDeviceLimit: 2,
      addOnType: 'EXTRA_DEVICES',
      addOnValue: 2,
      ledger: false,
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(env.captured.length, 0);
    assert.equal(env.syncJobs.length, 2, 'both profiles still have to be told');
    assert.equal(env.rows.get('sub-1')?.deviceLimit, 4);
    assert.equal(
      env.rows.get('sub-2')?.deviceLimit,
      4,
      'the other half is raised by the same increment',
    );
    assert.equal(
      (
        env.syncJobs.find((job) => job['subscriptionId'] === 'sub-2')?.payload as Record<
          string,
          unknown
        >
      )['companion'],
      true,
    );
  });
});

/**
 * THE GUARD THE COMPANION LINE RESTS ON
 * ────────────────────────────────────
 * `createPendingInTransaction` refuses a source transaction that is not bound
 * to the target subscription — the property that stops one payment from
 * granting entitlements on someone else's row. The companion flag is ONE
 * exception: a sibling of the same SOLD bundle, same customer, both live.
 *
 * The admitted case is proved by getting PAST the guard: the next statement is
 * the subscription row lock, and it throws a sentinel this file owns.
 */
describe('the companion line cannot leave the bundle', () => {
  const PAST_THE_GUARD = 'PASSED_THE_COMPANION_GUARD';

  function guardEnv(input: {
    readonly source: { readonly userId: string; readonly snapshot: Snapshot };
    readonly target: { readonly userId: string; readonly snapshot: Snapshot };
    readonly companionOfBundleSibling: boolean;
  }) {
    const rows = [
      {
        id: 'sub-1',
        userId: input.source.userId,
        status: 'ACTIVE',
        planSnapshot: input.source.snapshot,
      },
      {
        id: 'sub-2',
        userId: input.target.userId,
        status: 'ACTIVE',
        planSnapshot: input.target.snapshot,
      },
    ];
    let queryRawCalls = 0;
    const tx = {
      $queryRaw: async () => {
        queryRawCalls += 1;
        if (queryRawCalls === 1) return [{ id: 'tx-1', subscriptionId: 'sub-1' }];
        throw new Error(PAST_THE_GUARD);
      },
      subscription: {
        findMany: async () => rows,
      },
    };
    return { tx, rows };
  }

  function pendingInput(companionOfBundleSibling: boolean) {
    return {
      subscriptionId: 'sub-2',
      termId: 'term-sub-2',
      sourceTransactionId: 'tx-1',
      sourceLineKey: 'addon-1@sub-2',
      addOnId: 'addon-1',
      catalogRevision: 3,
      receiptName: 'Extra',
      type: 'EXTRA_DEVICES',
      valuePerUnit: 1,
      totalValue: 1n,
      lifetime: 'UNTIL_SUBSCRIPTION_END',
      applicabilitySnapshot: { companion: true },
      unitAmount: '0',
      totalAmount: '0',
      currency: 'USD',
      purchasedAt: new Date('2026-08-01T00:00:00.000Z'),
      scheduledActivationAt: new Date('2026-08-01T00:00:00.000Z'),
      expiresAt: new Date('2026-09-01T00:00:00.000Z'),
      expiryEpochId: null,
      correlationId: 'payment:pay-1:companion:sub-2',
      companionOfBundleSibling,
    } as const;
  }

  const BUNDLED = bundledSnapshot({ planId: 'plan-obhody', deviceLimit: 2 });
  const BUNDLED_OTHER = bundledSnapshot({ planId: 'plan-premium', deviceLimit: 2 });

  it('refuses a target in ANOTHER bundle of the same customer', async () => {
    const other = { ...BUNDLED_OTHER, bundleId: 'bundle-2' };
    const { tx } = guardEnv({
      source: { userId: 'user-1', snapshot: BUNDLED },
      target: { userId: 'user-1', snapshot: other },
      companionOfBundleSibling: true,
    });

    await assert.rejects(
      () =>
        new AddOnEntitlementService().createPendingInTransaction(
          tx as never,
          pendingInput(true) as never,
        ),
      /Source transaction is not bound to the target subscription/,
    );
  });

  it('refuses another customer', async () => {
    const { tx } = guardEnv({
      source: { userId: 'user-1', snapshot: BUNDLED },
      target: { userId: 'user-2', snapshot: BUNDLED_OTHER },
      companionOfBundleSibling: true,
    });

    await assert.rejects(
      () =>
        new AddOnEntitlementService().createPendingInTransaction(
          tx as never,
          pendingInput(true) as never,
        ),
      /Source transaction is not bound to the target subscription/,
    );
  });

  it('refuses a target that is not sold as a bundle at all', async () => {
    const { tx } = guardEnv({
      source: { userId: 'user-1', snapshot: BUNDLED },
      target: {
        userId: 'user-1',
        snapshot: ordinarySnapshot({ planId: 'plan-solo', deviceLimit: 2 }),
      },
      companionOfBundleSibling: true,
    });

    await assert.rejects(
      () =>
        new AddOnEntitlementService().createPendingInTransaction(
          tx as never,
          pendingInput(true) as never,
        ),
      /Source transaction is not bound to the target subscription/,
    );
  });

  it('refuses the sibling WITHOUT the companion flag (the default rule survives)', async () => {
    const { tx } = guardEnv({
      source: { userId: 'user-1', snapshot: BUNDLED },
      target: { userId: 'user-1', snapshot: BUNDLED_OTHER },
      companionOfBundleSibling: false,
    });

    await assert.rejects(
      () =>
        new AddOnEntitlementService().createPendingInTransaction(
          tx as never,
          pendingInput(false) as never,
        ),
      /Source transaction is not bound to the target subscription/,
    );
  });

  it('admits the sibling of the same sold bundle', async () => {
    const { tx } = guardEnv({
      source: { userId: 'user-1', snapshot: BUNDLED },
      target: { userId: 'user-1', snapshot: BUNDLED_OTHER },
      companionOfBundleSibling: true,
    });

    await assert.rejects(
      () =>
        new AddOnEntitlementService().createPendingInTransaction(
          tx as never,
          pendingInput(true) as never,
        ),
      new RegExp(PAST_THE_GUARD),
    );
  });
});
