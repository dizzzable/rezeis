import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';

interface ItemRow {
  id: string;
  subscriptionId: string;
  planId: string;
  durationDays: number;
  appliedAt: Date | null;
  amount?: string;
  currency?: string;
  addOnLines?: unknown;
  planSnapshot?: unknown;
}

interface SubRow {
  id: string;
  expiresAt: Date | null;
  remnawaveId: string | null;
  trafficLimit?: number | null;
  deviceLimit?: number;
  planSnapshot?: unknown;
  internalSquads?: string[];
  externalSquad?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function validPlanSnapshot(id: string, durationDays: number): Record<string, unknown> {
  return {
    snapshotVersion: 1,
    snapshotSource: 'RENEWAL_DRAFT',
    purchaseType: 'RENEW',
    id,
    name: 'P',
    description: null,
    tag: null,
    type: 'BOTH',
    trafficLimit: 1024,
    deviceLimit: 1,
    trafficLimitStrategy: 'NO_RESET',
    internalSquads: [],
    externalSquad: null,
    selectedDurationDays: durationDays,
    gatewayType: 'YOOKASSA',
    amount: '10',
    currency: 'USD',
  };
}

describe('PaymentSubscriptionMutationService — combined renewal', () => {
  it('Property 4: extends each subscription from max(now, expiresAt) and never shortens', async () => {
    const future = new Date(Date.now() + 100 * DAY_MS);
    const past = new Date(Date.now() - 100 * DAY_MS);
    const env = createEnv({
      subs: [
        { id: 'sub-future', expiresAt: future, remnawaveId: 'rw-1' },
        { id: 'sub-expired', expiresAt: past, remnawaveId: null },
      ],
      items: [
        { id: 'it1', subscriptionId: 'sub-future', planId: 'plan-1', durationDays: 30, appliedAt: null },
        { id: 'it2', subscriptionId: 'sub-expired', planId: 'plan-1', durationDays: 30, appliedAt: null },
      ],
    });

    const before = Date.now();
    const { syncJobs } = await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(syncJobs.length, 2);
    // Future subscription renews from its existing expiry: future + 30d exactly.
    const renewedFuture = env.committedSubs.get('sub-future')!;
    assert.equal(renewedFuture.expiresAt!.getTime(), future.getTime() + 30 * DAY_MS);
    // Expired subscription renews from "now": >= before+30d, never shorter than now.
    const renewedExpired = env.committedSubs.get('sub-expired')!;
    assert.ok(renewedExpired.expiresAt!.getTime() >= before + 30 * DAY_MS - DAY_MS);
    assert.ok(renewedExpired.expiresAt!.getTime() > Date.now());
    // Both items stamped applied.
    assert.ok(env.committedItems.get('it1')!.appliedAt !== null);
    assert.ok(env.committedItems.get('it2')!.appliedAt !== null);
  });

  it('Property 5: already-applied items are skipped (idempotent replay)', async () => {
    const env = createEnv({
      subs: [
        { id: 'sub-a', expiresAt: new Date(Date.now() + 10 * DAY_MS), remnawaveId: 'rw' },
        { id: 'sub-b', expiresAt: new Date(Date.now() + 10 * DAY_MS), remnawaveId: 'rw' },
      ],
      items: [
        { id: 'it-a', subscriptionId: 'sub-a', planId: 'plan-1', durationDays: 30, appliedAt: new Date() },
        { id: 'it-b', subscriptionId: 'sub-b', planId: 'plan-1', durationDays: 30, appliedAt: null },
      ],
    });

    const { syncJobs } = await env.service.applyCompletedTransaction(env.transaction as never);

    // Only the pending item is fulfilled.
    assert.equal(syncJobs.length, 1);
    assert.equal(env.subUpdateCount.get('sub-a') ?? 0, 0);
    assert.equal(env.subUpdateCount.get('sub-b') ?? 0, 1);
  });

  it('Property 6: a failing item rolls back the whole fulfillment (all-or-nothing)', async () => {
    const env = createEnv({
      subs: [{ id: 'sub-ok', expiresAt: new Date(Date.now() + 10 * DAY_MS), remnawaveId: 'rw' }],
      items: [
        { id: 'it-ok', subscriptionId: 'sub-ok', planId: 'plan-1', durationDays: 30, appliedAt: null },
        { id: 'it-bad', subscriptionId: 'sub-ok', planId: 'plan-missing', durationDays: 30, appliedAt: null,
          planSnapshot: { ...validPlanSnapshot('plan-missing', 30), id: 'different-paid-plan' } },
      ],
    });

    await assert.rejects(() => env.service.applyCompletedTransaction(env.transaction as never));

    // Nothing committed: the good subscription keeps its original expiry and
    // no item is stamped applied.
    assert.equal(env.committedSubs.get('sub-ok')!.expiresAt!.getTime(), env.originalExpiry.get('sub-ok'));
    assert.equal(env.committedItems.get('it-ok')!.appliedAt, null);
    assert.equal(env.committedItems.get('it-bad')!.appliedAt, null);
  });
  it('preserves current effective limits and plan identity until the scheduled term activates', async () => {
    const previous = process.env.ADDON_ENTITLEMENT_SHADOW;
    process.env.ADDON_ENTITLEMENT_SHADOW = 'true';
    const currentExpiry = new Date(Date.now() + 30 * DAY_MS);
    const env = createEnv({
      subs: [{
        id: 'sub-early',
        expiresAt: currentExpiry,
        remnawaveId: 'rw-early',
        trafficLimit: 1500,
        deviceLimit: 4,
        planSnapshot: { id: 'plan-current' },
        internalSquads: ['current-squad'],
        externalSquad: 'current-external',
      }],
      items: [{
        id: 'it-early',
        subscriptionId: 'sub-early',
        planId: 'plan-1',
        durationDays: 30,
        appliedAt: null,
      }],
      durableActiveTermEndsAt: currentExpiry,
    });

    try {
      await env.service.applyCompletedTransaction(env.transaction as never);
      const renewed = env.committedSubs.get('sub-early')!;
      assert.equal(renewed.expiresAt!.getTime(), currentExpiry.getTime() + 30 * DAY_MS);
      assert.equal(renewed.trafficLimit, 1500);
      assert.equal(renewed.deviceLimit, 4);
      assert.deepStrictEqual(renewed.planSnapshot, { id: 'plan-current' });
      assert.deepStrictEqual(renewed.internalSquads, ['current-squad']);
      assert.equal(renewed.externalSquad, 'current-external');
      assert.equal(env.termCreates.length, 1);
    } finally {
      if (previous === undefined) delete process.env.ADDON_ENTITLEMENT_SHADOW;
      else process.env.ADDON_ENTITLEMENT_SHADOW = previous;
    }
  });

  it('fulfills a paid unlimited snapshot without consulting mutable catalog state', async () => {
    const env = createEnv({
      subs: [{ id: 'sub-unlimited', expiresAt: new Date(Date.now() + 10 * DAY_MS), remnawaveId: 'rw' }],
      items: [{
        id: 'it-unlimited',
        subscriptionId: 'sub-unlimited',
        planId: 'plan-unlimited',
        durationDays: 30,
        appliedAt: null,
        planSnapshot: {
          ...validPlanSnapshot('plan-unlimited', 30),
          type: 'UNLIMITED',
          trafficLimit: null,
          deviceLimit: -1,
        },
      }],
    });

    await env.service.applyCompletedTransaction(env.transaction as never);

    const renewed = env.committedSubs.get('sub-unlimited')!;
    assert.equal(renewed.trafficLimit, null);
    assert.equal(renewed.deviceLimit, -1);
    assert.equal((renewed.planSnapshot as { id?: string }).id, 'plan-unlimited');
    assert.ok(env.committedItems.get('it-unlimited')!.appliedAt !== null);
  });

  it('fails closed on paid snapshot gateway, plan type, or nullable-shape drift', async () => {
    const missingDescription = validPlanSnapshot('plan-1', 30);
    delete missingDescription['description'];
    const malformedSnapshots = [
      { ...validPlanSnapshot('plan-1', 30), gatewayType: 'CRYPTOMUS' },
      { ...validPlanSnapshot('plan-1', 30), type: 'NOT_A_PLAN_TYPE' },
      missingDescription,
    ];

    for (const [index, planSnapshot] of malformedSnapshots.entries()) {
      const originalExpiry = new Date(Date.now() + 40 * DAY_MS);
      const env = createEnv({
        subs: [{ id: `sub-shape-${index}`, expiresAt: originalExpiry, remnawaveId: 'rw-1' }],
        items: [{
          id: `it-shape-${index}`,
          subscriptionId: `sub-shape-${index}`,
          planId: 'plan-1',
          durationDays: 30,
          appliedAt: null,
          planSnapshot,
        }],
      });

      await assert.rejects(
        () => env.service.applyCompletedTransaction(env.transaction as never),
        /snapshot/i,
      );
      assert.equal(
        env.committedSubs.get(`sub-shape-${index}`)!.expiresAt!.getTime(),
        originalExpiry.getTime(),
      );
      assert.equal(env.committedItems.get(`it-shape-${index}`)!.appliedAt, null);
    }
  });

  it('rejects a malformed parent marker instead of treating arbitrary items as combined renewal', async () => {
    const env = createEnv({
      subs: [{ id: 'sub-marker', expiresAt: new Date(Date.now() + 10 * DAY_MS), remnawaveId: 'rw' }],
      items: [{
        id: 'it-marker',
        subscriptionId: 'sub-marker',
        planId: 'plan-1',
        durationDays: 30,
        appliedAt: null,
      }],
    });
    (env.transaction as Record<string, unknown>).purchaseType = 'NEW';
    (env.transaction as Record<string, unknown>).planSnapshot = { combinedRenewal: false };

    await assert.rejects(
      () => env.service.applyCompletedTransaction(env.transaction as never),
      /combined|purchase type/i,
    );
    assert.equal(env.committedItems.get('it-marker')!.appliedAt, null);
  });

  it('fails closed and rolls back when persisted paid addOnLines is not an array', async () => {
    const originalExpiry = new Date(Date.now() + 40 * DAY_MS);
    const env = createEnv({
      subs: [{ id: 'sub-malformed', expiresAt: originalExpiry, remnawaveId: 'rw-1' }],
      items: [{
        id: 'it-malformed',
        subscriptionId: 'sub-malformed',
        planId: 'plan-1',
        durationDays: 30,
        appliedAt: null,
        addOnLines: { addOnId: 'paid-but-corrupt' },
      }],
    });

    await assert.rejects(
      () => env.service.applyCompletedTransaction(env.transaction as never),
      /add-on lines/i,
    );
    assert.equal(env.committedSubs.get('sub-malformed')!.expiresAt!.getTime(), originalExpiry.getTime());
    assert.equal(env.committedItems.get('it-malformed')!.appliedAt, null);
  });
  it('fulfills a legacy in-flight draft (no snapshotVersion) via live-plan fallback — paid money is never stranded', async () => {
    // Reproduces a combined-renewal draft created BEFORE strict snapshot
    // verification shipped: the parent marker and the item snapshot both lack
    // snapshotVersion and the item snapshot is partial (the pre-strict shape).
    // It must still fulfill — falling back to the live plan row — so a payment
    // captured across the deploy renews the subscription instead of looping in
    // ConflictException forever.
    const currentExpiry = new Date(Date.now() + 10 * DAY_MS);
    const env = createEnv({
      subs: [{ id: 'sub-legacy', expiresAt: currentExpiry, remnawaveId: 'rw-legacy' }],
      items: [{
        id: 'it-legacy',
        subscriptionId: 'sub-legacy',
        planId: 'plan-1',
        durationDays: 30,
        appliedAt: null,
        planSnapshot: {
          id: 'plan-1',
          name: 'P',
          selectedDurationDays: 30,
          gatewayType: 'YOOKASSA',
          amount: '10',
          currency: 'USD',
          purchaseType: 'RENEW',
          snapshotSource: 'RENEWAL_DRAFT',
        },
      }],
    });
    // Legacy parent marker: combinedRenewal without snapshotVersion.
    (env.transaction as Record<string, unknown>).planSnapshot = { combinedRenewal: true, itemCount: 1 };

    const { syncJobs } = await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(syncJobs.length, 1);
    const renewed = env.committedSubs.get('sub-legacy')!;
    assert.equal(renewed.expiresAt!.getTime(), currentExpiry.getTime() + 30 * DAY_MS);
    assert.ok(env.committedItems.get('it-legacy')!.appliedAt !== null);
  });

  it('rejects a mixed paid addOnLines array instead of fulfilling only the valid subset', async () => {
    const originalExpiry = new Date(Date.now() + 40 * DAY_MS);
    const env = createEnv({
      subs: [{ id: 'sub-mixed', expiresAt: originalExpiry, remnawaveId: 'rw-1' }],
      items: [{
        id: 'it-mixed',
        subscriptionId: 'sub-mixed',
        planId: 'plan-1',
        durationDays: 30,
        appliedAt: null,
        addOnLines: [
          {
            addOnId: 'addon-valid',
            catalogRevision: 1,
            type: 'EXTRA_TRAFFIC',
            value: 50,
            lifetime: 'UNTIL_SUBSCRIPTION_END',
            activation: 'TERM_START',
            sourceLineKey: 'renew:sub-mixed:addon-valid',
            unitAmount: '2.50',
            receiptName: 'Valid paid line',
          },
          { addOnId: 'addon-corrupt', type: 'EXTRA_TRAFFIC' },
        ],
      }],
    });

    await assert.rejects(
      () => env.service.applyCompletedTransaction(env.transaction as never),
      /add-on lines/i,
    );
    assert.equal(env.committedSubs.get('sub-mixed')!.expiresAt!.getTime(), originalExpiry.getTime());
    assert.equal(env.committedItems.get('it-mixed')!.appliedAt, null);
  });
});

function createEnv(input: {
  subs: SubRow[];
  items: ItemRow[];
  durableActiveTermEndsAt?: Date;
}) {
  type StoredItem = {
    id: string;
    subscriptionId: string;
    planId: string;
    durationDays: number;
    appliedAt: Date | null;
    amount: string;
    currency: string;
    addOnLines: unknown;
    planSnapshot: unknown;
  };
  const committedSubs = new Map<string, SubRow>(input.subs.map((s) => [s.id, { ...s }]));
  const committedItems = new Map<string, StoredItem>(
    input.items.map((i) => [
      i.id,
      {
        ...i,
        appliedAt: i.appliedAt,
        amount: i.amount ?? '10',
        currency: i.currency ?? 'USD',
        addOnLines: i.addOnLines ?? null,
        planSnapshot: i.planSnapshot ?? (i.planId === 'plan-missing' ? {
          snapshotVersion: 1,
          snapshotSource: 'RENEWAL_DRAFT',
          purchaseType: 'RENEW',
          id: i.planId,
          name: 'P',
          description: null,
          tag: null,
          type: 'BOTH',
          trafficLimit: 1024,
          deviceLimit: 1,
          trafficLimitStrategy: 'NO_RESET',
          internalSquads: [],
          externalSquad: null,
          selectedDurationDays: i.durationDays,
          gatewayType: 'YOOKASSA',
          amount: i.amount ?? '10',
          currency: i.currency ?? 'USD',
        } : {
          snapshotVersion: 1,
          snapshotSource: 'RENEWAL_DRAFT',
          purchaseType: 'RENEW',
          id: i.planId,
          name: 'P',
          description: null,
          tag: null,
          type: 'BOTH',
          trafficLimit: 1024,
          deviceLimit: 1,
          trafficLimitStrategy: 'NO_RESET',
          internalSquads: [],
          externalSquad: null,
          selectedDurationDays: i.durationDays,
          gatewayType: 'YOOKASSA',
          amount: i.amount ?? '10',
          currency: i.currency ?? 'USD',
        }),
      },
    ]),
  );
  const originalExpiry = new Map(
    input.subs.map((s) => [s.id, s.expiresAt ? s.expiresAt.getTime() : null] as const),
  );
  const subUpdateCount = new Map<string, number>();
  const plans = new Map<string, { id: string; trafficLimit: number | null; deviceLimit: number; internalSquads: string[]; externalSquad: string | null; name: string; description: string | null; tag: string | null; type: string; trafficLimitStrategy: string }>([
    ['plan-1', { id: 'plan-1', trafficLimit: 1024, deviceLimit: 1, internalSquads: [], externalSquad: null, name: 'P', description: null, tag: null, type: 'BOTH', trafficLimitStrategy: 'NO_RESET' }],
  ]);
  let jobSeq = 0;
  const termCreates: Array<Record<string, unknown>> = [];

  const prismaService = {
    transactionItem: {
      findMany: async () => [...committedItems.values()],
    },
    user: {
      // Consumes the one-time purchase discount after completion; no-op here.
      updateMany: async () => ({ count: 0 }),
    },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      // Staging layer: changes commit only if the callback resolves.
      const stagedSubs = new Map([...committedSubs].map(([k, v]) => [k, { ...v }] as const));
      const stagedItems = new Map([...committedItems].map(([k, v]) => [k, { ...v }] as const));
      const txClient = {
        $queryRaw: async () => [{ id: 'sub-early', status: 'ACTIVE' }],
        subscriptionTerm: {
          findFirst: async (query: { where: { status?: unknown } }) => {
            if (input.durableActiveTermEndsAt === undefined) return null;
            if (query.where.status === 'ACTIVE') return { id: 'term-active' };
            return {
              id: 'term-active',
              status: 'ACTIVE',
              generation: 1,
              endsAt: input.durableActiveTermEndsAt,
            };
          },
        },
        plan: { findUnique: async ({ where }: { where: { id: string } }) => plans.get(where.id) ?? null },
        subscription: {
          findUnique: async ({ where }: { where: { id: string } }) => stagedSubs.get(where.id) ?? null,
          update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            subUpdateCount.set(where.id, (subUpdateCount.get(where.id) ?? 0) + 1);
            const next = { ...stagedSubs.get(where.id)!, ...data } as SubRow;
            stagedSubs.set(where.id, next);
            return next;
          },
        },
        profileSyncJob: {
          create: async ({ data }: { data: { subscriptionId: string } }) => ({
            id: `job-${jobSeq++}`,
            ...data,
          }),
        },
        transactionItem: {
          updateMany: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const current = stagedItems.get(where.id)! as StoredItem;
            if ((where as { appliedAt?: unknown }).appliedAt === null && current.appliedAt !== null) return { count: 0 };
            const next = { ...current, ...data } as StoredItem;
            stagedItems.set(where.id, next);
            return { count: 1 };
          },
          findUnique: async ({ where }: { where: { id: string } }) => stagedItems.get(where.id) ?? null,
          update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const next = { ...stagedItems.get(where.id)!, ...data } as StoredItem;
            stagedItems.set(where.id, next);
            return next;
          },
        },
        transaction: {
          // Combined renewal stamps `fulfilledAt` on the parent transaction
          // atomically with the item applications (idempotency for the webhook
          // reconciler). No assertions on it here — accept and no-op.
          update: async () => ({}),
        },
      };
      const result = await cb(txClient);
      // Commit.
      for (const [k, v] of stagedSubs) committedSubs.set(k, v);
      for (const [k, v] of stagedItems) committedItems.set(k, v);
      return result;
    },
  };

  const events = { info: () => undefined };

  const service = new PaymentSubscriptionMutationService(
    prismaService as never,
    events as never,
    {} as never,
    {} as never,
    {
      createScheduledInTransaction: async (_tx: unknown, termInput: Record<string, unknown>) => {
        termCreates.push(termInput);
        return { id: `term-${termCreates.length + 1}`, generation: termCreates.length + 1, status: 'SCHEDULED' };
      },
    } as never,
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
    planSnapshot: { combinedRenewal: true, snapshotVersion: 1 },
  };

  return {
    service,
    committedSubs,
    committedItems,
    originalExpiry,
    subUpdateCount,
    termCreates,
    transaction,
  };
}
