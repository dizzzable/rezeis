import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RetiredPlanSweeperService } from '../src/modules/plans/services/retired-plan-sweeper.service';
import { _resetProcessRoleCacheForTests } from '../src/common/runtime/process-role.util';

/**
 * A plan taken out of sale disappears once the last customer has left it.
 *
 * ── Why the fake obeys the query instead of answering from options ────────
 *
 * The first version of this file did the opposite, and a review proved what
 * that costs: fifty-one mutations of the service, THIRTY-THREE surviving. The
 * suite verified that each guard EXISTED — deleting an `if` was caught — and
 * almost nothing about whether a guard was CORRECT. Dropping `DISABLED` from
 * the live-subscription statuses, flipping the payment check from PENDING to
 * COMPLETED, deleting the `replacementPlanIds` half of the transition probe,
 * and removing the whole `orderIndex` compaction all left ten green tests.
 *
 * Every one of those mutations deletes a paying customer's plan.
 *
 * So the fake below is a small database: rows in, queries applied to them,
 * results out. A stub that answers from its own options is only ever testing
 * that its options were read.
 */

type PlanRow = {
  id: string;
  name: string;
  orderIndex: number;
  isArchived: boolean;
  archivedRenewMode: 'SELF_RENEW' | 'REPLACE_ON_RENEW';
  upgradeToPlanIds: string[];
  replacementPlanIds: string[];
};

type SubRow = { planId: string; status: string };
type TxItemRow = { planId: string; transactionStatus: string };

function build(options: {
  readonly plans: readonly Partial<PlanRow>[];
  readonly subs?: readonly SubRow[];
  readonly txItems?: readonly TxItemRow[];
  /** Single purchases: plan named in the transaction's own snapshot, no items. */
  readonly txns?: readonly TxItemRow[];
  /** Plan ids a quest gives away as its reward. */
  readonly quests?: readonly string[];
  /** Each entry is one add-on's `applicablePlanIds`. */
  readonly addOns?: readonly (readonly string[])[];
  /** Each entry is one promocode's `allowedPlanIds`. */
  readonly promocodes?: readonly (readonly string[])[];
  readonly events?: boolean;
  readonly failDelete?: boolean;
}) {
  const plans: PlanRow[] = options.plans.map((p, i) => ({
    id: p.id ?? `p${i}`,
    name: p.name ?? `Plan ${p.id ?? i}`,
    orderIndex: p.orderIndex ?? i,
    isArchived: p.isArchived ?? true,
    archivedRenewMode: p.archivedRenewMode ?? 'REPLACE_ON_RENEW',
    upgradeToPlanIds: p.upgradeToPlanIds ?? [],
    replacementPlanIds: p.replacementPlanIds ?? [],
  }));
  const subs = [...(options.subs ?? [])];
  const txItems = [...(options.txItems ?? [])];
  const txns = (options.txns ?? []).map((t) => ({ planId: t.planId, status: t.transactionStatus }));
  const quests = [...(options.quests ?? [])];
  const addOns = (options.addOns ?? []).map((l) => [...l]);
  const promocodes = (options.promocodes ?? []).map((l) => [...l]);
  const audits: Array<Record<string, unknown>> = [];
  const emitted: Array<{ type: string; category: string; message: string; metadata: unknown }> = [];

  function matchesPlanWhere(row: PlanRow, where: Record<string, unknown>): boolean {
    if (where.isArchived !== undefined && row.isArchived !== where.isArchived) return false;
    if (where.archivedRenewMode !== undefined && row.archivedRenewMode !== where.archivedRenewMode) {
      return false;
    }
    const or = where.OR as ReadonlyArray<Record<string, { hasSome: string[] }>> | undefined;
    if (or !== undefined) {
      // Both arms are evaluated — the whole point. Reading only `OR[0]` is what
      // let the `replacementPlanIds` half be deleted with every test green.
      return or.some((arm) => {
        const [field, spec] = Object.entries(arm)[0]!;
        const held = row[field as 'upgradeToPlanIds' | 'replacementPlanIds'];
        return spec.hasSome.some((id) => held.includes(id));
      });
    }
    return true;
  }

  const tx = {
    plan: {
      findMany: async (args: { where?: Record<string, unknown>; orderBy?: unknown }) => {
        const rows = plans.filter((p) => matchesPlanWhere(p, args.where ?? {}));
        return [...rows].sort((a, b) => a.orderIndex - b.orderIndex);
      },
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        if (options.failDelete === true) throw new Error('delete refused');
        for (const id of where.id.in) {
          const i = plans.findIndex((p) => p.id === id);
          if (i >= 0) plans.splice(i, 1);
        }
        return { count: where.id.in.length };
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { orderIndex: number };
      }) => {
        const row = plans.find((p) => p.id === where.id);
        if (row !== undefined) row.orderIndex = data.orderIndex;
        return {};
      },
    },
    subscription: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const planId = (where.planSnapshot as { equals: string }).equals;
        const excluded = (where.status as { not: string }).not;
        const hit = subs.find((s) => s.planId === planId && s.status !== excluded);
        return hit === undefined ? null : { id: 'sub-1' };
      },
    },
    transaction: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const planId = (where.planSnapshot as { equals: string }).equals;
        const status = where.status as string;
        const hit = txns.find((t) => t.planId === planId && t.status === status);
        return hit === undefined ? null : { id: 'tx-1' };
      },
    },
    quest: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const ids = (where.rewardPlanId as { in: string[] }).in;
        return quests.filter((q) => ids.includes(q)).map((rewardPlanId) => ({ rewardPlanId }));
      },
    },
    addOn: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const ids = (where.applicablePlanIds as { hasSome: string[] }).hasSome;
        return addOns
          .filter((list) => list.some((id) => ids.includes(id)))
          .map((applicablePlanIds) => ({ applicablePlanIds }));
      },
    },
    promocode: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const ids = (where.allowedPlanIds as { hasSome: string[] }).hasSome;
        return promocodes
          .filter((list) => list.some((id) => ids.includes(id)))
          .map((allowedPlanIds) => ({ allowedPlanIds }));
      },
    },
    adminAuditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return data;
      },
    },
    transactionItem: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const ids = (where.planId as { in: string[] }).in;
        const status = (where.transaction as { status: string }).status;
        const hits = txItems.filter(
          (t) => ids.includes(t.planId) && t.transactionStatus === status,
        );
        return [...new Set(hits.map((t) => t.planId))].map((planId) => ({ planId }));
      },
    },
  };

  const prisma = {
    ...tx,
    $transaction: async <T>(fn: (client: unknown) => Promise<T>): Promise<T> => fn(tx),
  };

  const service = new RetiredPlanSweeperService(
    prisma as never,
    options.events === false
      ? undefined
      : ({
          warn: (type: string, category: string, message: string, metadata: unknown) => {
            emitted.push({ type, category, message, metadata });
          },
        } as never),
  );
  return { service, plans, emitted, audits };
}

const order = (plans: readonly PlanRow[]): string =>
  [...plans]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((p) => `${p.id}@${p.orderIndex}`)
    .join(' ');

describe('a retired plan goes once it is empty', () => {
  it('removes it when nobody is on it', async () => {
    const { service, plans } = build({ plans: [{ id: 'p1' }] });

    const removed = await service.sweep();

    assert.deepStrictEqual(plans, []);
    assert.deepStrictEqual(
      removed.map((p) => p.id),
      ['p1'],
    );
  });

  it('announces it with the name, the id and a category that routes', async () => {
    // The category is not decoration: it picks the Telegram topic and the
    // realtime permission gate. A plan vanishing unannounced is
    // indistinguishable from a bug.
    const { service, emitted } = build({ plans: [{ id: 'p1', name: 'Legacy 50' }] });

    await service.sweep();

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.type, 'plan.retired_removed');
    assert.equal(emitted[0]?.category, 'SYSTEM');
    assert.match(String(emitted[0]?.message), /Legacy 50/);
    assert.deepStrictEqual(emitted[0]?.metadata, { planId: 'p1', planName: 'Legacy 50' });
  });

  it('works with no events service wired', async () => {
    const { service, plans } = build({ plans: [{ id: 'p1' }], events: false });

    await service.sweep();

    assert.deepStrictEqual(plans, []);
  });
});

describe('what keeps a retired plan alive', () => {
  for (const status of ['ACTIVE', 'DISABLED', 'LIMITED', 'EXPIRED']) {
    it(`keeps it while a ${status} subscription names it`, async () => {
      // EXPIRED belongs in this list, and leaving it out was a defect that
      // would have cost a customer. A subscription inside the grace window is
      // still RENEWABLE — `ExpiredProfileCleanupService` says so in its own
      // contract — so deleting the plan takes away the thing they were coming
      // back for, and `REPLACE_ON_RENEW` keeps its replacements ON that row.
      const { service, plans } = build({
        plans: [{ id: 'p1' }],
        subs: [{ planId: 'p1', status }],
      });

      await service.sweep();

      assert.equal(plans.length, 1, `deleted a plan with a ${status} subscription on it`);
    });
  }

  it('goes once every subscription has been cleaned up to DELETED', async () => {
    // The other side: `ExpiredProfileCleanupService` flips EXPIRED to DELETED a
    // few days past expiry, and that IS "they did not renew". The wide
    // predicate self-clears, so the plan still disappears on its own.
    const { service, plans } = build({
      plans: [{ id: 'p1' }],
      subs: [{ planId: 'p1', status: 'DELETED' }],
    });

    await service.sweep();

    assert.deepStrictEqual(plans, []);
  });

  it('keeps it while a single purchase names it in the transaction snapshot', async () => {
    // Single purchases carry NO `TransactionItem` — items exist only for
    // combined multi-subscription renewals. An item-only probe missed every
    // NEW, ADDITIONAL and UPGRADE, and those settle by reading the LIVE plan
    // row: delete it and the money is taken with nothing delivered.
    const { service, plans } = build({
      plans: [{ id: 'p1' }],
      txns: [{ planId: 'p1', transactionStatus: 'PENDING' }],
    });

    await service.sweep();

    assert.equal(plans.length, 1);
  });

  it('keeps it while a PENDING payment names it', async () => {
    // Guards MONEY, not tidiness: a legacy in-flight draft carries no snapshot,
    // so fulfilment reads the live plan row and throws without it.
    const { service, plans } = build({
      plans: [{ id: 'p1' }],
      txItems: [{ planId: 'p1', transactionStatus: 'PENDING' }],
    });

    await service.sweep();

    assert.equal(plans.length, 1);
  });

  it('is NOT held by a payment that already settled', async () => {
    // The other direction of the same check. Holding on COMPLETED would keep
    // every plan anybody ever bought — which is the dead weight this removes.
    const { service, plans } = build({
      plans: [{ id: 'p1' }],
      txItems: [{ planId: 'p1', transactionStatus: 'COMPLETED' }],
    });

    await service.sweep();

    assert.deepStrictEqual(plans, []);
  });

  it('keeps it while another plan names it as an UPGRADE target', async () => {
    const { service, plans } = build({
      plans: [{ id: 'p1' }, { id: 'live', isArchived: false, upgradeToPlanIds: ['p1'] }],
    });

    await service.sweep();

    assert.ok(plans.some((p) => p.id === 'p1'));
  });

  it('keeps it while another plan names it as a REPLACEMENT target', async () => {
    // The arm the first suite never reached, and the one the service's own
    // rationale is written about: a replacement target is somebody's renewal
    // destination.
    const { service, plans } = build({
      plans: [{ id: 'p1' }, { id: 'live', isArchived: false, replacementPlanIds: ['p1'] }],
    });

    await service.sweep();

    assert.ok(plans.some((p) => p.id === 'p1'));
  });

  it('keeps it while a quest gives it away as a reward', async () => {
    // A dangling reward id does not fail loudly: the grant throws, the mutex is
    // released, and the reconciler retries the same doomed claim for ever — a
    // quest that silently stops paying out while its editor shows no plan.
    const { service, plans } = build({ plans: [{ id: 'p1' }], quests: ['p1'] });

    await service.sweep();

    assert.equal(plans.length, 1);
  });

  it('keeps it while an add-on is sold against it', async () => {
    // Worse than it sounds: the add-on editor re-validates the whole list it
    // round-trips, so a dead id rejects EVERY edit — including a rename or an
    // on/off toggle — and the operator cannot fix it from the panel.
    const { service, plans } = build({ plans: [{ id: 'p1' }], addOns: [['other', 'p1']] });

    await service.sweep();

    assert.equal(plans.length, 1);
  });

  it('keeps it while a promocode is restricted to it', async () => {
    const { service, plans } = build({ plans: [{ id: 'p1' }], promocodes: [['p1']] });

    await service.sweep();

    assert.equal(plans.length, 1);
  });

  it('is not held by config naming a DIFFERENT plan', async () => {
    // The other direction: `hasSome` must not be read as "any config exists".
    const { service, plans } = build({
      plans: [{ id: 'p1' }],
      quests: ['other'],
      addOns: [['other']],
      promocodes: [['other']],
    });

    await service.sweep();

    assert.deepStrictEqual(plans, []);
  });

  it('never touches a SELF_RENEW plan, however empty it is', async () => {
    // That mode is a promise to keep old customers on their old price.
    const { service, plans } = build({
      plans: [{ id: 'p1', archivedRenewMode: 'SELF_RENEW' }],
    });

    await service.sweep();

    assert.equal(plans.length, 1);
  });

  it('never touches a plan that is still on sale', async () => {
    const { service, plans } = build({ plans: [{ id: 'p1', isArchived: false }] });

    await service.sweep();

    assert.equal(plans.length, 1);
  });
});

describe('the order of the surviving plans', () => {
  it('leaves no hole and no duplicate after removing ONE plan', async () => {
    const { service, plans } = build({
      plans: [
        { id: 'gone', orderIndex: 0 },
        { id: 'a', orderIndex: 1, isArchived: false },
        { id: 'b', orderIndex: 2, isArchived: false },
      ],
    });

    await service.sweep();

    assert.equal(order(plans), 'a@0 b@1');
  });

  it('leaves no hole and no duplicate after removing SEVERAL in one sweep', async () => {
    // THE regression this suite exists for. Compacting once per delete from an
    // index captured before any of them ran put two surviving plans on the SAME
    // index and vacated another — in a column with no unique constraint, so the
    // database accepted it silently.
    const { service, plans } = build({
      plans: [
        { id: 'gone1', orderIndex: 0 },
        { id: 'gone2', orderIndex: 1 },
        { id: 'c', orderIndex: 2, isArchived: false },
        { id: 'd', orderIndex: 3, isArchived: false },
      ],
    });

    await service.sweep();

    assert.equal(order(plans), 'c@0 d@1');
  });

  it('leaves a already-compact table alone', async () => {
    const { service, plans } = build({
      plans: [
        { id: 'gone', orderIndex: 2 },
        { id: 'a', orderIndex: 0, isArchived: false },
        { id: 'b', orderIndex: 1, isArchived: false },
      ],
    });

    await service.sweep();

    assert.equal(order(plans), 'a@0 b@1');
  });
});

describe('the sweep as a whole', () => {
  it('removes the free ones and keeps the held one, in one pass', async () => {
    const { service, plans } = build({
      plans: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
      subs: [{ planId: 'p2', status: 'ACTIVE' }],
    });

    await service.sweep();

    assert.deepStrictEqual(
      plans.map((p) => p.id),
      ['p2'],
    );
  });

  it('writes the SAME audit action a human deletion writes', async () => {
    // `plans.deleted`, not a type of our own: an operator asking "who removed
    // this plan?" filters by the obvious action, and must not find nothing
    // because the answer lives under a different name.
    const { service, audits } = build({ plans: [{ id: 'p1', name: 'Старт 2024' }] });

    await service.sweep();

    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.action, 'plans.deleted');
    assert.deepStrictEqual(audits[0]?.metadata, {
      planId: 'p1',
      name: 'Старт 2024',
      automated: true,
      reason: 'retired-plan-sweep',
    });
    // No admin connected — that absence is what marks the row as ours.
    assert.equal(audits[0]?.adminUser, undefined);
  });

  it('writes no audit row when nothing was removed', async () => {
    const { service, audits } = build({
      plans: [{ id: 'p1' }],
      subs: [{ planId: 'p1', status: 'ACTIVE' }],
    });

    await service.sweep();

    assert.deepStrictEqual(audits, []);
  });

  it('is safe to run twice', async () => {
    const { service, plans } = build({ plans: [{ id: 'p1' }] });

    await service.sweep();
    const second = await service.sweep();

    assert.deepStrictEqual(plans, []);
    assert.deepStrictEqual(second, []);
  });
});

describe('the scheduled wrapper', () => {
  it('does nothing on a process that does not run schedules', async () => {
    const previous = process.env.RUID_PROCESS_ROLE;
    process.env.RUID_PROCESS_ROLE = 'api';
    _resetProcessRoleCacheForTests();
    try {
      const { service, plans } = build({ plans: [{ id: 'p1' }] });

      await service.sweepScheduled();

      // Both containers sweeping the same rows is the failure this gate
      // prevents; inverting it moves the sweep to the wrong one entirely.
      assert.equal(plans.length, 1, 'the API process swept');
    } finally {
      process.env.RUID_PROCESS_ROLE = previous;
      _resetProcessRoleCacheForTests();
    }
  });

  it('sweeps on the worker', async () => {
    const previous = process.env.RUID_PROCESS_ROLE;
    process.env.RUID_PROCESS_ROLE = 'worker';
    _resetProcessRoleCacheForTests();
    try {
      const { service, plans } = build({ plans: [{ id: 'p1' }] });

      await service.sweepScheduled();

      assert.deepStrictEqual(plans, []);
    } finally {
      process.env.RUID_PROCESS_ROLE = previous;
      _resetProcessRoleCacheForTests();
    }
  });

  it('swallows a failure rather than taking the worker down', async () => {
    const previous = process.env.RUID_PROCESS_ROLE;
    process.env.RUID_PROCESS_ROLE = 'worker';
    _resetProcessRoleCacheForTests();
    try {
      const { service } = build({ plans: [{ id: 'p1' }], failDelete: true });

      await service.sweepScheduled();
    } finally {
      process.env.RUID_PROCESS_ROLE = previous;
      _resetProcessRoleCacheForTests();
    }
  });
});
