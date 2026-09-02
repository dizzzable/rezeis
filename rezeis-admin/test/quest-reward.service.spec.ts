import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { QuestRewardService } from '../src/modules/quests/services/quest-reward.service';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import { RewardGrantService } from '../src/modules/rewards/reward-grant.service';
import { resolveInheritedPlanLimitUpdate } from '../src/modules/subscriptions/services/plan-inherited-limits.util';

/** Build a QuestRewardService over a configurable in-memory prisma double. */
function makeService(cfg: {
  quest: Record<string, unknown> | null;
  completion: Record<string, unknown> | null;
  claimCount?: number;
  budgetCount?: number;
  boundedSubId?: string | null;
  activeSubId?: string | null;
  subscription?: Record<string, unknown> | null;
  user?: Record<string, unknown> | null;
}): {
  service: QuestRewardService;
  calls: Record<string, unknown[]>;
} {
  const calls: Record<string, unknown[]> = {
    userUpdate: [],
    ledgerCreate: [],
    subUpdate: [],
    promocodeCreate: [],
    completionUpdate: [],
    completionUpdateMany: [],
    questUpdateMany: [],
    syncEnqueue: [],
    subLock: [],
  };

  const tx = {
    user: {
      findUnique: async () => cfg.user ?? { personalDiscount: 0, points: 0 },
      update: async (a: unknown) => {
        calls.userUpdate.push(a);
        return {};
      },
      // The POINTS payout goes through the wallet, whose balance write is a
      // conditional `updateMany`. Recorded in the same list as the other user
      // writes: "one write to the user row" is what the POINTS case asserts.
      updateMany: async (a: unknown) => {
        calls.userUpdate.push(a);
        return { count: 1 };
      },
    },
    pointsLedgerEntry: {
      findUnique: async () => null,
      create: async (a: unknown) => {
        calls.ledgerCreate.push(a);
        return { id: 'ledger-1' };
      },
    },
    subscription: {
      // The payout resolves the target subscription THROUGH the transaction
      // now, not beside it on the pool: a read on another connection can
      // hand back a row this transaction is about to change.
      findFirst: async (args: { where: { expiresAt?: unknown } }) => {
        const boundedQuery = args.where.expiresAt !== undefined;
        const id = boundedQuery ? cfg.boundedSubId : cfg.activeSubId;
        return id ? { id } : null;
      },
      findUnique: async () => cfg.subscription ?? { expiresAt: new Date('2026-08-01T00:00:00Z'), trafficLimit: 100 },
      update: async (a: unknown) => {
        calls.subUpdate.push(a);
        return {};
      },
    },
    plan: {
      findUnique: async () => ({
        id: 'plan-1', name: 'Plan', tag: null, type: 'STANDARD', trafficLimit: 100,
        deviceLimit: 3, trafficLimitStrategy: 'NO_RESET', internalSquads: [], externalSquad: null,
      }),
    },
    promocode: {
      create: async (a: unknown) => {
        calls.promocodeCreate.push(a);
        return {};
      },
    },
    questCompletion: {
      updateMany: async (a: unknown) => {
        calls.completionUpdateMany.push(a);
        return { count: cfg.claimCount ?? 1 };
      },
      update: async (a: unknown) => {
        calls.completionUpdate.push(a);
        return {};
      },
    },
    quest: {
      updateMany: async (a: unknown) => {
        calls.questUpdateMany.push(a);
        return { count: cfg.budgetCount ?? 1 };
      },
    },
    // The TRAFFIC payout writes an ABSOLUTE traffic limit (the snapshot beside
    // it is JSON and cannot be incremented), so it takes the same `FOR UPDATE`
    // row lock the promocode and referral top-ups take.
    $queryRaw: async (a: unknown) => {
      calls.subLock.push(a);
      return [];
    },
  };

  const prisma = {
    quest: { findUnique: async () => cfg.quest },
    questCompletion: {
      findUnique: async () => cfg.completion,
      update: tx.questCompletion.update,
      updateMany: tx.questCompletion.updateMany,
    },
    subscription: {
      findFirst: async (args: { where: { expiresAt?: unknown } }) => {
        // bounded resolver passes `expiresAt: { not: null }`; active resolver doesn't.
        const boundedQuery = args.where.expiresAt !== undefined;
        const id = boundedQuery ? cfg.boundedSubId : cfg.activeSubId;
        return id ? { id } : null;
      },
      findUnique: tx.subscription.findUnique,
    },
    profileSyncJob: { create: async () => ({ id: 'sync-1' }) },
    $transaction: async (arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg) : (arg as (t: unknown) => Promise<unknown>)(tx),
  };

  const profileSync = {
    enqueue: async (id: unknown) => {
      calls.syncEnqueue.push(id);
    },
  };
  const subMutations = {
    grantTrial: async () => ({ subscriptionId: 'trial-sub-1' }),
  };

  const service = new QuestRewardService(
    prisma as never,
    profileSync as never,
    subMutations as never,
    // The REAL reward applier on the real wallet: the payout moved out of
    // this service, and stubbing it here would leave every assertion below
    // about a payout that never happened.
    new RewardGrantService(new PointsWalletService()),
  );
  return { service, calls };
}

function pointsQuest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'q1', type: 'LINK_TELEGRAM', enabled: true, rewardType: 'POINTS', rewardAmount: 3,
    rewardPlanId: null, daysFallback: 'MINT_PROMOCODE', maxCompletionsGlobal: null,
    startAt: null, endAt: null, ...overrides,
  };
}

describe('QuestRewardService', () => {
  it('credits points, stamps rewardIssuedAt, and returns the snapshot', async () => {
    const { service, calls } = makeService({
      quest: pointsQuest(),
      completion: { id: 'c1', status: 'COMPLETED', rewardIssuedAt: null, rewardSnapshot: null },
    });
    const result = await service.claim({ userId: 'u1', questId: 'q1' });
    assert.equal(result.points, 3);
    assert.equal(calls.userUpdate.length, 1);
    // The credit went through the wallet: one ledger row, keyed on the
    // completion so a re-driven claim cannot journal it twice.
    assert.deepEqual(
      (calls.ledgerCreate as Array<{ data: Record<string, unknown> }>).map((c) => [
        c.data.userId, c.data.delta, c.data.source, c.data.referenceKey,
      ]),
      [['u1', 3, 'QUEST_REWARD', 'c1']],
    );
    // Reward slot was claimed atomically: rewardIssuedAt is stamped via the
    // conditional updateMany (single-winner), not the final snapshot update.
    const stamped = (calls.completionUpdateMany as Array<{ data?: { rewardIssuedAt?: unknown } }>).some(
      (c) => c.data?.rewardIssuedAt != null,
    );
    assert.ok(stamped);
    // The snapshot is persisted at the end of the payout transaction.
    const snap = calls.completionUpdate[0] as { data: { rewardSnapshot: unknown } };
    assert.ok(snap.data.rewardSnapshot);
  });

  it('does not double-issue when the reward slot is claimed concurrently', async () => {
    // Reconciler re-drive of a CLAIMED-but-unpaid completion, but a concurrent
    // driver already stamped rewardIssuedAt → the atomic claim loses (count 0).
    const { service, calls } = makeService({
      quest: pointsQuest(),
      completion: {
        id: 'c1',
        status: 'CLAIMED',
        rewardIssuedAt: null,
        rewardSnapshot: { questId: 'q1', rewardType: 'POINTS', points: 3 },
      },
      claimCount: 0,
    });
    const result = await service.claim({ userId: 'u1', questId: 'q1' });
    assert.equal(calls.userUpdate.length, 0); // NO second payout
    assert.equal(result.points, 3); // returns the winner's stored snapshot
  });

  it('grants a trial once for a DAYS→GRANT_TRIAL reward with no bounded subscription', async () => {
    const { service, calls } = makeService({
      quest: pointsQuest({
        rewardType: 'DAYS',
        rewardAmount: 7,
        daysFallback: 'GRANT_TRIAL',
        rewardPlanId: 'plan-1',
      }),
      completion: { id: 'c1', status: 'COMPLETED', rewardIssuedAt: null, rewardSnapshot: null },
      boundedSubId: null,
    });
    const result = await service.claim({ userId: 'u1', questId: 'q1' });
    assert.equal(result.days, 7);
    assert.equal(result.subscriptionId, 'trial-sub-1');
    // Mutex stamped before the external grantTrial call.
    const stamped = (calls.completionUpdateMany as Array<{ data?: { rewardIssuedAt?: unknown } }>).some(
      (c) => c.data?.rewardIssuedAt != null,
    );
    assert.ok(stamped);
  });

  it('is idempotent — an already-issued claim returns the stored snapshot without re-paying', async () => {
    const { service, calls } = makeService({
      quest: pointsQuest(),
      completion: {
        id: 'c1',
        status: 'CLAIMED',
        rewardIssuedAt: new Date(),
        rewardSnapshot: { questId: 'q1', rewardType: 'POINTS', points: 3 },
      },
    });
    const result = await service.claim({ userId: 'u1', questId: 'q1' });
    assert.equal(result.points, 3);
    assert.equal(calls.userUpdate.length, 0); // no double credit
    assert.equal(calls.completionUpdate.length, 0);
  });

  it('rejects a claim when the global budget is exhausted', async () => {
    const { service } = makeService({
      quest: pointsQuest({ maxCompletionsGlobal: 100 }),
      completion: { id: 'c1', status: 'COMPLETED', rewardIssuedAt: null, rewardSnapshot: null },
      budgetCount: 0,
    });
    await assert.rejects(() => service.claim({ userId: 'u1', questId: 'q1' }), {
      message: 'Quest reward budget is exhausted',
    });
  });

  it('rejects a lost claim race (completion no longer COMPLETED)', async () => {
    const { service } = makeService({
      quest: pointsQuest(),
      completion: { id: 'c1', status: 'COMPLETED', rewardIssuedAt: null, rewardSnapshot: null },
      claimCount: 0,
    });
    await assert.rejects(() => service.claim({ userId: 'u1', questId: 'q1' }), {
      message: 'Quest already claimed or not claimable',
    });
  });

  it('rejects claiming a quest that is not completed yet', async () => {
    const { service } = makeService({
      quest: pointsQuest(),
      completion: { id: 'c1', status: 'IN_PROGRESS', rewardIssuedAt: null, rewardSnapshot: null },
    });
    await assert.rejects(() => service.claim({ userId: 'u1', questId: 'q1' }), {
      message: 'Quest is not completed yet',
    });
  });

  it('rejects a channel quest whose membership proof has expired before reserving reward budget', async () => {
    const { service, calls } = makeService({
      quest: pointsQuest({ type: 'SUBSCRIBE_CHANNEL' }),
      completion: {
        id: 'c1',
        status: 'COMPLETED',
        verifiedAt: new Date(Date.now() - 16 * 60 * 1000),
        rewardIssuedAt: null,
        rewardSnapshot: null,
      },
    });

    await assert.rejects(() => service.claim({ userId: 'u1', questId: 'q1' }), {
      message: 'Quest channel membership verification has expired',
    });
    assert.equal(calls.completionUpdateMany.length, 0);
    assert.equal(calls.userUpdate.length, 0);
  });

  it('extends a bounded active subscription for a DAYS reward and enqueues profile-sync', async () => {
    const { service, calls } = makeService({
      quest: pointsQuest({ rewardType: 'DAYS', rewardAmount: 3 }),
      completion: { id: 'c1', status: 'COMPLETED', rewardIssuedAt: null, rewardSnapshot: null },
      boundedSubId: 'sub-1',
      subscription: { expiresAt: new Date('2999-01-01T00:00:00Z'), trafficLimit: 100 },
    });
    const result = await service.claim({ userId: 'u1', questId: 'q1' });
    assert.equal(result.days, 3);
    assert.equal(result.subscriptionId, 'sub-1');
    assert.equal(calls.subUpdate.length, 1);
    assert.equal(calls.syncEnqueue.length, 1);
  });

  // ── TRAFFIC: a bonus for THIS period, not a permanent limit raise ────────
  //
  // The payout used to be a bare `trafficLimit: { increment }` with no snapshot
  // write. `resolveInheritedPlanLimitUpdate`
  // (`subscriptions/services/plan-inherited-limits.util.ts`) reads a column that
  // disagrees with `plan_snapshot` as an OPERATOR OVERRIDE and preserves it, so
  // a quest top-up survived every renewal for the rest of the subscription's
  // life — a permanent extra granted by a raw column bump that routes around
  // `SubscriptionEffectiveProjection`, which is where a genuinely PURCHASED
  // permanent extra belongs. The owner ruled on this class for the promocode
  // and referral paths; this is the same rule.
  it('grants a TRAFFIC top-up that the next renewal resets to the plan', async () => {
    const planSnapshot = {
      id: 'plan-1',
      name: 'Plan',
      tag: null,
      type: 'STANDARD',
      icon: null,
      trafficLimit: 100,
      deviceLimit: 3,
      trafficLimitStrategy: 'NO_RESET',
      internalSquads: [],
      externalSquad: null,
    };
    const { service, calls } = makeService({
      quest: pointsQuest({ rewardType: 'TRAFFIC', rewardAmount: 25 }),
      completion: { id: 'c1', status: 'COMPLETED', rewardIssuedAt: null, rewardSnapshot: null },
      activeSubId: 'sub-1',
      subscription: { trafficLimit: 100, planSnapshot },
    });

    const result = await service.claim({ userId: 'u1', questId: 'q1' });

    assert.equal(result.trafficGb, 25);
    assert.equal(result.subscriptionId, 'sub-1');
    // The read-modify-write is serialised, or two concurrent quest payouts
    // would each write 125 over a column that should have reached 150 — and,
    // worse, leave the snapshot disagreeing with it.
    assert.equal(calls.subLock.length, 1);
    assert.equal(calls.subUpdate.length, 1);
    const write = calls.subUpdate[0] as {
      data: { trafficLimit: number; planSnapshot: Record<string, unknown> };
    };
    assert.equal(write.data.trafficLimit, 125);
    // THE SNAPSHOT MOVED WITH THE COLUMN, and only the one key.
    assert.deepStrictEqual(write.data.planSnapshot, { ...planSnapshot, trafficLimit: 125 });
    assert.equal(calls.syncEnqueue.length, 1);

    // The outcome, through the reader the payment renewal actually uses: the
    // row still tracks its plan, so renewal resets traffic to the plan's 100.
    const decision = resolveInheritedPlanLimitUpdate({
      current: { trafficLimit: 125, deviceLimit: 3, internalSquads: [], externalSquad: null },
      planSnapshot: write.data.planSnapshot,
      plan: { trafficLimit: 100, deviceLimit: 3, internalSquads: [], externalSquad: null },
    });
    assert.equal(decision.trafficLimit, 100);
  });

  it('leaves an unlimited subscription unlimited rather than making it finite', async () => {
    // `trafficLimit: null` is "no cap". `null + 25` would turn a customer's
    // unlimited plan into a 25 GB one; the guard predates this change and must
    // outlive it, snapshot write included.
    const { service, calls } = makeService({
      quest: pointsQuest({ rewardType: 'TRAFFIC', rewardAmount: 25 }),
      completion: { id: 'c1', status: 'COMPLETED', rewardIssuedAt: null, rewardSnapshot: null },
      activeSubId: 'sub-1',
      subscription: { trafficLimit: null, planSnapshot: { id: 'plan-1', trafficLimit: null } },
    });

    const result = await service.claim({ userId: 'u1', questId: 'q1' });

    assert.equal(result.trafficGb, 25);
    assert.equal(calls.subUpdate.length, 0);
    assert.equal(calls.syncEnqueue.length, 0);
  });

  it('mints a promocode for a DAYS reward when the user has no bounded subscription', async () => {
    const { service, calls } = makeService({
      quest: pointsQuest({ rewardType: 'DAYS', rewardAmount: 5, daysFallback: 'MINT_PROMOCODE', rewardPlanId: 'plan-1' }),
      completion: { id: 'c1', status: 'COMPLETED', rewardIssuedAt: null, rewardSnapshot: null },
      boundedSubId: null,
    });
    const result = await service.claim({ userId: 'u1', questId: 'q1' });
    assert.equal(result.days, 5);
    assert.ok(result.promoCode && result.promoCode.startsWith('QUEST-'));
    assert.equal(calls.promocodeCreate.length, 1);
  });
});
