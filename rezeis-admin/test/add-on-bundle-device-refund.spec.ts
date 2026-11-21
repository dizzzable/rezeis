import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import 'reflect-metadata';

import { AddOnRefundService } from '../src/modules/payments/services/addon-refund.service';
import { executeGatewayDataWrites } from './helpers/gateway-data-write-double';
import { pinAddOnStagesOffForThisFile } from './helpers/rollout-flags';

/**
 * THE REFUND OF A MERGED SUBSCRIPTION'S DEVICE ADD-ON
 * ────────────────────────────────────────────────────
 * The capture fans a «+1 устройство» out to every profile of the sold bundle
 * (`PaymentSubscriptionMutationService.extendDeviceAddOnToBundleSiblings`,
 * `add-on-bundle-devices.spec.ts`). The refund is its other half, and it comes
 * in two shapes:
 *
 *  - DURABLE — one entitlement line per profile, both reversed here; the card's
 *    devices line must name BOTH halves once a person has to reduce them.
 *  - LEGACY — no lines at all, only the raw columns the increment raised: the
 *    refund has to bring every window down, or the half the customer does not
 *    see keeps the devices for good.
 *
 * Every case runs with the stages pinned OFF, like the capture's spec.
 */

pinAddOnStagesOffForThisFile();

const DAY_MS = 24 * 60 * 60 * 1000;

type Snapshot = Record<string, unknown>;

/** A member plan's snapshot carrying the SOLD-bundle marker. */
function bundledSnapshot(input: { readonly planId: string; readonly deviceLimit: number }): Snapshot {
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

/** An ordinary plan's snapshot: no marker, so no merged subscription. */
function ordinarySnapshot(input: { readonly planId: string; readonly deviceLimit: number }): Snapshot {
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

interface StagedSubscription {
  id: string;
  userId: string;
  status: string;
  remnawaveId: string | null;
  createdAt: Date;
  expiresAt: Date;
  trafficLimit: number | null;
  deviceLimit: number;
  planSnapshot: Snapshot;
}

interface StagedEntitlement {
  readonly id: string;
  readonly subscriptionId: string;
  readonly type: string;
  readonly state: string;
  readonly totalValue: bigint;
  readonly expiresAt: Date | null;
  readonly scheduledActivationAt: Date;
}

/**
 * The real `endForRefund` over a staged store: two halves of one sold bundle,
 * a device add-on already applied to both, and the payment that bought it.
 *
 * `ledger` says which shape the refund meets — with it on the two entitlement
 * lines exist (the capture wrote them), with it off there is no line at all and
 * the columns are all the refund has.
 */
function refundEnv(input: {
  readonly halves: readonly { readonly snapshot: Snapshot; readonly deviceLimit: number }[];
  readonly addOnType?: 'EXTRA_DEVICES' | 'EXTRA_TRAFFIC';
  readonly addOnValue?: number;
  readonly ledger: boolean;
}) {
  const addOnType = input.addOnType ?? 'EXTRA_DEVICES';
  const addOnValue = input.addOnValue ?? 1;
  const expiresAt = new Date(Date.now() + 30 * DAY_MS);
  const createdAt = new Date(Date.now() - DAY_MS);
  const rows = new Map<string, StagedSubscription>();
  input.halves.forEach((half, index) => {
    const id = `sub-${index + 1}`;
    rows.set(id, {
      id,
      userId: 'user-1',
      status: 'ACTIVE',
      remnawaveId: `rw-${index + 1}`,
      createdAt,
      expiresAt,
      trafficLimit: 100,
      deviceLimit: half.deviceLimit,
      planSnapshot: half.snapshot,
    });
  });

  const gatewayData = new Map<string, Record<string, unknown>>([['tx-1', {}]]);
  const syncJobs: Array<Record<string, unknown>> = [];
  const entitlementUpdates: Array<Record<string, unknown>> = [];
  const transitions: string[] = [];

  const entitlements: StagedEntitlement[] = input.ledger
    ? [...rows.keys()].map((subscriptionId, index) => ({
        id: `ent-${index + 1}`,
        subscriptionId,
        type: addOnType,
        state: 'ACTIVE',
        totalValue: BigInt(addOnType === 'EXTRA_TRAFFIC' ? addOnValue * 1024 ** 3 : addOnValue),
        expiresAt,
        scheduledActivationAt: createdAt,
      }))
    : [];

  const txClient = {
    $queryRaw: async () => [{ id: 'locked' }],
    subscription: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = rows.get(where.id);
        return row === undefined ? null : { ...row };
      },
      findMany: async () => [...rows.values()].map((row) => ({ ...row })),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.get(where.id);
        assert.ok(row !== undefined, `update of an unknown staged subscription ${where.id}`);
        Object.assign(row, data);
        return { ...row };
      },
    },
    subscriptionTerm: {
      count: async () => 0,
      findFirst: async () => null,
    },
    addOnEntitlement: {
      findMany: async () => entitlements.map((row) => ({ ...row })),
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        entitlementUpdates.push(data);
        return { count: 1 };
      },
    },
    addOnEntitlementEvent: {
      createMany: async () => ({ count: 1 }),
    },
    profileSyncJob: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        syncJobs.push(data);
        return { id: `job-${syncJobs.length}`, ...data };
      },
    },
    transaction: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        gatewayData: gatewayData.get(where.id) ?? {},
        subscriptionId: 'sub-1',
      }),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        gatewayData.set(where.id, { ...(gatewayData.get(where.id) ?? {}), ...data });
        return {};
      },
    },
    $executeRaw: executeGatewayDataWrites({
      currentGatewayData: (transactionId) => gatewayData.get(transactionId) ?? {},
      update: async ({ where, data }) => {
        gatewayData.set(where.id, (data.gatewayData as Record<string, unknown>) ?? {});
        return {};
      },
    }),
  };

  const prismaService = {
    addOnEntitlement: {
      findMany: async () => entitlements.map((row) => ({ ...row })),
    },
    transaction: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        gatewayData: gatewayData.get(where.id) ?? {},
        subscriptionId: 'sub-1',
      }),
    },
    profileSyncJob: { findFirst: async () => null },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(txClient),
  };

  const entitlementService = {
    recordRefundOrChargebackInTransaction: async () => ({ changed: true, eventId: 'event' }),
    transitionInTransaction: async (_tx: unknown, command: { readonly command: string }) => {
      transitions.push(command.command);
      return { entitlementId: 'ent-1', state: 'REVERSED', changed: true, eventId: 'event' };
    },
  };
  const projections = { recomputeInTransaction: async () => ({ changed: false }) };

  const service = new AddOnRefundService(
    prismaService as never,
    entitlementService as never,
    projections as never,
    { enqueue: async () => undefined } as never,
    undefined,
    undefined,
    undefined,
    // Stage 6 OFF, so the card carries the way by hand — the line that has to
    // name both halves.
    {
      flags: async () => ({
        entitlementShadow: false,
        directPurchase: false,
        deviceCleanupAuto: false,
        resetExpiry: { DAY: false, WEEK: false, MONTH: false, MONTH_ROLLING: false },
      }),
    } as never,
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
    createdAt,
    gatewayData: {},
    planSnapshot: {
      snapshotSource: 'ADDON_PURCHASE',
      addOnId: 'addon-1',
      addOnType,
      addOnValue,
      name: 'Extra',
      targetSubscriptionId: 'sub-1',
      contractVersion: 2,
      addOnRevision: 3,
      lifetime: 'UNTIL_SUBSCRIPTION_END',
      sourceLineKey: 'addon-1',
    },
  };

  return { service, transaction, rows, syncJobs, entitlementUpdates, transitions };
}

const MERGED = [
  { snapshot: bundledSnapshot({ planId: 'plan-obhody', deviceLimit: 2 }), deviceLimit: 3 },
  { snapshot: bundledSnapshot({ planId: 'plan-premium', deviceLimit: 2 }), deviceLimit: 3 },
] as const;

describe('a refunded device add-on comes off every profile of the merged subscription', () => {
  it('lowers BOTH columns when there is no ledger line to reverse', async () => {
    const env = refundEnv({ halves: MERGED, ledger: false, addOnValue: 1 });

    const outcome = await env.service.endForRefund(env.transaction as never, 'REFUND');

    assert.equal(outcome?.ended, true, String(outcome?.note));
    assert.equal(env.rows.get('sub-1')?.deviceLimit, 2, 'the half the customer bought on');
    assert.equal(env.rows.get('sub-2')?.deviceLimit, 2, 'the half nobody would have noticed');
    assert.deepEqual(
      env.syncJobs.map((job) => job['subscriptionId']).sort(),
      ['sub-1', 'sub-2'],
      'both profiles are pushed to Remnawave',
    );
    assert.deepEqual(outcome?.audit['addOnRefundBundleDeviceHalvesLowered'], ['sub-2']);
  });

  it('never lowers a half below its own plan, and never touches an unlimited one', async () => {
    const env = refundEnv({
      halves: [
        { snapshot: bundledSnapshot({ planId: 'plan-obhody', deviceLimit: 2 }), deviceLimit: 3 },
        // Already back at the plan's own number: nothing was left on this half.
        { snapshot: bundledSnapshot({ planId: 'plan-premium', deviceLimit: 2 }), deviceLimit: 2 },
      ],
      ledger: false,
      addOnValue: 2,
    });

    const outcome = await env.service.endForRefund(env.transaction as never, 'REFUND');

    assert.equal(env.rows.get('sub-1')?.deviceLimit, 2, '2 devices bought on a 2-device plan');
    assert.equal(env.rows.get('sub-2')?.deviceLimit, 2, 'untouched — it was at the plan already');
    assert.deepEqual(outcome?.audit['addOnRefundBundleDeviceHalvesLowered'], undefined);
  });

  it('leaves the other half of a TRAFFIC add-on alone', async () => {
    const env = refundEnv({
      halves: [
        { snapshot: bundledSnapshot({ planId: 'plan-obhody', deviceLimit: 2 }), deviceLimit: 2 },
        { snapshot: bundledSnapshot({ planId: 'plan-premium', deviceLimit: 2 }), deviceLimit: 2 },
      ],
      ledger: false,
      addOnType: 'EXTRA_TRAFFIC',
      addOnValue: 50,
    });

    await env.service.endForRefund(env.transaction as never, 'REFUND');

    assert.equal(env.rows.get('sub-1')?.trafficLimit, 100, 'the plan\'s traffic is its floor');
    assert.equal(env.rows.get('sub-2')?.trafficLimit, 100, 'traffic is not fanned out');
  });

  it('does nothing extra for a subscription that was not sold as a bundle', async () => {
    const env = refundEnv({
      halves: [
        { snapshot: ordinarySnapshot({ planId: 'plan-1', deviceLimit: 2 }), deviceLimit: 3 },
        { snapshot: ordinarySnapshot({ planId: 'plan-2', deviceLimit: 2 }), deviceLimit: 3 },
      ],
      ledger: false,
    });

    const outcome = await env.service.endForRefund(env.transaction as never, 'REFUND');

    assert.equal(env.rows.get('sub-1')?.deviceLimit, 2);
    assert.equal(env.rows.get('sub-2')?.deviceLimit, 3, 'a subscription the customer bought separately');
    assert.equal(outcome?.audit['addOnRefundBundleDeviceHalvesLowered'], undefined);
  });

  it('the card names BOTH halves when a person has to reduce the devices', async () => {
    const env = refundEnv({ halves: MERGED, ledger: true });

    const outcome = await env.service.endForRefund(env.transaction as never, 'REFUND');

    assert.equal(outcome?.ended, true, String(outcome?.note));
    assert.deepEqual(
      env.transitions.sort(),
      ['BEGIN_EXPIRY', 'BEGIN_EXPIRY'],
      'one expiry per profile, so the sweep reduces each',
    );
    const line = String(outcome?.devicesLine);
    assert.match(line, /«ID подписки»: sub-1, sub-2\.$/, 'both halves, in id order');
    assert.deepEqual(outcome?.audit['addOnRefundDeviceHalves'], ['sub-1', 'sub-2']);
  });
});
