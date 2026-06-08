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
}

interface SubRow {
  id: string;
  expiresAt: Date | null;
  remnawaveId: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

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
        // Missing plan → throws mid-loop.
        { id: 'it-bad', subscriptionId: 'sub-ok', planId: 'plan-missing', durationDays: 30, appliedAt: null },
      ],
    });

    await assert.rejects(() => env.service.applyCompletedTransaction(env.transaction as never));

    // Nothing committed: the good subscription keeps its original expiry and
    // no item is stamped applied.
    assert.equal(env.committedSubs.get('sub-ok')!.expiresAt!.getTime(), env.originalExpiry.get('sub-ok'));
    assert.equal(env.committedItems.get('it-ok')!.appliedAt, null);
    assert.equal(env.committedItems.get('it-bad')!.appliedAt, null);
  });
});

function createEnv(input: { subs: SubRow[]; items: ItemRow[] }) {
  type StoredItem = {
    id: string;
    subscriptionId: string;
    planId: string;
    durationDays: number;
    appliedAt: Date | null;
    amount: string;
    currency: string;
  };
  const committedSubs = new Map<string, SubRow>(input.subs.map((s) => [s.id, { ...s }]));
  const committedItems = new Map<string, StoredItem>(
    input.items.map((i) => [
      i.id,
      { ...i, appliedAt: i.appliedAt, amount: i.amount ?? '10', currency: i.currency ?? 'USD' },
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

  const prismaService = {
    transactionItem: {
      findMany: async () => [...committedItems.values()],
    },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      // Staging layer: changes commit only if the callback resolves.
      const stagedSubs = new Map([...committedSubs].map(([k, v]) => [k, { ...v }] as const));
      const stagedItems = new Map([...committedItems].map(([k, v]) => [k, { ...v }] as const));
      const txClient = {
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
          update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const next = { ...stagedItems.get(where.id)!, ...data } as StoredItem;
            stagedItems.set(where.id, next);
            return next;
          },
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

  const service = new PaymentSubscriptionMutationService(prismaService as never, events as never);

  const transaction = {
    id: 'tx-1',
    paymentId: 'pay-1',
    userId: 'user-1',
    subscriptionId: null,
    purchaseType: 'RENEW',
    gatewayType: 'YOOKASSA',
    currency: 'USD',
    amount: { toString: () => '15' },
    planSnapshot: { combinedRenewal: true },
  };

  return { service, committedSubs, committedItems, originalExpiry, subUpdateCount, transaction };
}
