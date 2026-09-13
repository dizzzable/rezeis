import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PlanReferenceGuardService } from '../src/modules/plans/services/plan-reference-guard.service';
import { RetiredPlanSweeperService } from '../src/modules/plans/services/retired-plan-sweeper.service';
import { _resetProcessRoleCacheForTests } from '../src/common/runtime/process-role.util';
import { buildPlanReferenceDb, PlanReferenceDbSeed, Row } from './fixtures/plan-reference-db';

/**
 * A plan taken out of sale — or deleted while something still used it —
 * disappears once nothing uses it.
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
 * So the database below is a small database: rows in, the service's own queries
 * applied to them, results out (`test/fixtures/plan-reference-db.ts`). And the
 * guard is the REAL `PlanReferenceGuardService` — the same one the delete dialog
 * and the delete read — so this file proves the sweep holds a plan for exactly
 * what the guard reports, not for a list of its own. What each kind counts is
 * pinned kind by kind in `test/plan-reference-guard.spec.ts`.
 */

type PlanRow = {
  id: string;
  name: string;
  orderIndex: number;
  isArchived: boolean;
  archivedRenewMode: 'SELF_RENEW' | 'REPLACE_ON_RENEW';
  upgradeToPlanIds: string[];
  replacementPlanIds: string[];
  deletedAt: Date | null;
};

type SubRow = { planId: string; status: string };
type TxItemRow = { planId: string; transactionStatus: string; appliedAt?: Date | null };
type TxRow = { planId: string; transactionStatus: string; fulfilledAt?: Date | null };

const NOW = new Date();
const DELETED_AT = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);

function build(options: {
  readonly plans: readonly Partial<PlanRow>[];
  readonly subs?: readonly SubRow[];
  readonly txItems?: readonly TxItemRow[];
  /** Single purchases: plan named in the transaction's own snapshot, no items. */
  readonly txns?: readonly TxRow[];
  /** Plan ids a quest gives away as its (DAYS) reward. */
  readonly quests?: readonly string[];
  /** Each entry is one add-on's `applicablePlanIds`. */
  readonly addOns?: readonly (readonly string[])[];
  /** Each entry is one promocode's `allowedPlanIds` — a RESTRICTION, not a grant. */
  readonly promocodes?: readonly (readonly string[])[];
  /** Plan ids an unarchived promocode GRANTS (legacy `plan` column). */
  readonly grantingPromocodes?: readonly string[];
  /** Anything else the shared guard reads, as raw rows. */
  readonly extra?: PlanReferenceDbSeed;
  readonly events?: boolean;
  readonly failDelete?: boolean;
}) {
  const plans: Row[] = options.plans.map((p, i) => ({
    id: p.id ?? `p${i}`,
    name: p.name ?? `Plan ${p.id ?? i}`,
    orderIndex: p.orderIndex ?? i,
    isArchived: p.isArchived ?? true,
    archivedRenewMode: p.archivedRenewMode ?? 'REPLACE_ON_RENEW',
    upgradeToPlanIds: p.upgradeToPlanIds ?? [],
    replacementPlanIds: p.replacementPlanIds ?? [],
    deletedAt: p.deletedAt ?? null,
    isActive: p.deletedAt === undefined || p.deletedAt === null,
  }));
  const parents = (options.txItems ?? []).map((t, i) => ({
    id: `renewal-${i}`,
    status: t.transactionStatus,
    planSnapshot: { combinedRenewal: true },
    fulfilledAt: null,
    createdAt: NOW,
  }));
  const db = buildPlanReferenceDb({
    ...options.extra,
    plans,
    subscriptions: (options.subs ?? []).map((s, i) => ({
      id: `sub-${i}`,
      status: s.status,
      planSnapshot: { id: s.planId },
    })),
    transactions: [
      ...parents,
      ...(options.txns ?? []).map((t, i) => ({
        id: `tx-${i}`,
        status: t.transactionStatus,
        planSnapshot: { id: t.planId },
        fulfilledAt: t.fulfilledAt ?? null,
        createdAt: NOW,
      })),
      ...(options.extra?.transactions ?? []),
    ],
    transactionItems: (options.txItems ?? []).map((t, i) => ({
      id: `item-${i}`,
      transactionId: `renewal-${i}`,
      planId: t.planId,
      appliedAt: t.appliedAt ?? null,
    })),
    quests: (options.quests ?? []).map((planId, i) => ({ id: `quest-${i}`, rewardPlanId: planId, rewardType: 'DAYS' })),
    addOns: (options.addOns ?? []).map((list, i) => ({ id: `addon-${i}`, applicablePlanIds: [...list] })),
    promocodes: [
      ...(options.promocodes ?? []).map((list, i) => ({
        id: `restricted-${i}`,
        archivedAt: null,
        plan: null,
        allowedPlanIds: [...list],
      })),
      ...(options.grantingPromocodes ?? []).map((planId, i) => ({
        id: `granting-${i}`,
        archivedAt: null,
        plan: { id: planId },
        allowedPlanIds: [],
      })),
    ],
    failures: options.failDelete === true ? { 'plan.deleteMany': new Error('delete refused') } : undefined,
  });
  const emitted: Array<{ type: string; category: string; message: string; metadata: unknown }> = [];

  const service = new RetiredPlanSweeperService(
    db.client as never,
    new PlanReferenceGuardService(db.client as never),
    options.events === false
      ? undefined
      : ({
          warn: (type: string, category: string, message: string, metadata: unknown) => {
            emitted.push({ type, category, message, metadata });
          },
        } as never),
  );
  return {
    service,
    plans: db.tables.plan as unknown as PlanRow[],
    emitted,
    audits: db.tables.adminAuditLog,
    db,
  };
}

const order = (plans: readonly PlanRow[]): string =>
  [...plans]
    .filter((p) => p.deletedAt === null)
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

  it('is NOT held by a renewal line that was already applied', async () => {
    // The other direction of the same check. Holding on every COMPLETED line
    // would keep every plan anybody ever renewed — the dead weight this removes.
    const { service, plans } = build({
      plans: [{ id: 'p1' }],
      txItems: [{ planId: 'p1', transactionStatus: 'COMPLETED', appliedAt: new Date() }],
    });

    await service.sweep();

    assert.deepStrictEqual(plans, []);
  });

  it('keeps it while a COMPLETED renewal line has not been applied yet', async () => {
    // This case used to be pinned the OTHER way — "a COMPLETED item does not
    // hold the plan" — and that was the defect. COMPLETED is the provider's
    // word that the money arrived; `appliedAt` is ours that the renewal was
    // delivered. Between the two the plan row is still needed: a legacy line
    // without a verified snapshot is fulfilled from the live row, and throws
    // `Renewal plan not found` without it — money taken, nothing delivered,
    // retried for ever (plan-delete research, table A).
    const { service, plans } = build({
      plans: [{ id: 'p1' }],
      txItems: [{ planId: 'p1', transactionStatus: 'COMPLETED', appliedAt: null }],
    });

    await service.sweep();

    assert.equal(plans.length, 1);
  });

  it('keeps it while a paid single purchase has not been fulfilled yet', async () => {
    // The same gap for a NEW / ADDITIONAL / UPGRADE purchase: COMPLETED with
    // `fulfilledAt` still empty is exactly the state `getRequiredPlan` is
    // about to read the live plan row in.
    const { service, plans } = build({
      plans: [{ id: 'p1' }],
      txns: [{ planId: 'p1', transactionStatus: 'COMPLETED', fulfilledAt: null }],
    });

    await service.sweep();

    assert.equal(plans.length, 1);
  });

  it('is NOT held by a single purchase that was fulfilled', async () => {
    const { service, plans } = build({
      plans: [{ id: 'p1' }],
      txns: [{ planId: 'p1', transactionStatus: 'COMPLETED', fulfilledAt: new Date() }],
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

  it('keeps it while a promocode GRANTS it', async () => {
    // What this file's rationale always claimed to protect and its query never
    // did: a code that mints a subscription on the plan when it is redeemed.
    const { service, plans } = build({ plans: [{ id: 'p1' }], grantingPromocodes: ['p1'] });

    await service.sweep();

    assert.equal(plans.length, 1);
  });

  it('is NOT held by a promocode merely RESTRICTED to it', async () => {
    // `allowed_plan_ids` limits which purchases a discount applies to. Once the
    // plan is gone that purchase cannot happen, and the code refuses cleanly
    // without being used up — so it is not a reference, and the shared guard
    // does not count it. It used to hold the plan here, and nowhere else.
    const { service, plans } = build({ plans: [{ id: 'p1' }], promocodes: [['p1']] });

    await service.sweep();

    assert.deepStrictEqual(plans, []);
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

describe('a plan an operator deleted while it was still used', () => {
  // The deleted plans below are SELF_RENEW on purpose. The retired-plan arm of
  // the sweep never selects that mode, so these rows are candidates ONLY because
  // they were deleted — a fixture that was also archived REPLACE_ON_RENEW would
  // be swept by the other arm, and every case here would pass with the deleted
  // arm removed. (A mutation run caught exactly that in the first version.)
  it('is removed once nothing uses it', async () => {
    const { service, plans } = build({
      plans: [{ id: 'd1', deletedAt: DELETED_AT, archivedRenewMode: 'SELF_RENEW' }],
    });

    const removed = await service.sweep();

    assert.deepStrictEqual(plans, []);
    assert.deepStrictEqual(
      removed.map((p) => ({ id: p.id, wasDeleted: p.wasDeleted })),
      [{ id: 'd1', wasDeleted: true }],
    );
  });

  it('is kept while something still uses it', async () => {
    const { service, plans } = build({
      plans: [{ id: 'd1', deletedAt: DELETED_AT, archivedRenewMode: 'SELF_RENEW' }],
      subs: [{ planId: 'd1', status: 'ACTIVE' }],
    });

    await service.sweep();

    assert.equal(plans.length, 1);
  });

  it('reports a deleted plan as deleted even when it is also an archived REPLACE_ON_RENEW plan', async () => {
    // Both arms select this row; the audit and the announcement must still say
    // it was a DELETED plan, not a retired one.
    const { service, plans, audits } = build({
      plans: [{ id: 'd1', deletedAt: DELETED_AT, archivedRenewMode: 'REPLACE_ON_RENEW' }],
    });

    const removed = await service.sweep();

    assert.deepStrictEqual(plans, []);
    assert.equal(removed[0]?.wasDeleted, true);
    assert.equal((audits[0]?.metadata as Record<string, unknown>).reason, 'deleted-plan-sweep');
  });

  it('never sweeps a LIVE SELF_RENEW plan, however empty, beside a deleted one that goes', async () => {
    // The non-vacuous half of the first case: the same renew mode, not deleted.
    const { service, plans } = build({
      plans: [
        { id: 'kept-self-renew', archivedRenewMode: 'SELF_RENEW' },
        { id: 'd1', deletedAt: DELETED_AT, archivedRenewMode: 'SELF_RENEW' },
      ],
    });

    await service.sweep();

    assert.deepStrictEqual(
      plans.map((p) => p.id),
      ['kept-self-renew'],
    );
  });

  it('goes the night after its last use ends, and not before', async () => {
    const { service, plans, db } = build({
      plans: [{ id: 'd1', deletedAt: DELETED_AT, archivedRenewMode: 'SELF_RENEW' }],
      quests: ['d1'],
    });

    await service.sweep();
    assert.equal(plans.length, 1, 'removed while a quest still gave it away');

    db.tables.quest.splice(0, db.tables.quest.length);
    await service.sweep();

    assert.deepStrictEqual(plans, []);
  });

  it('writes plans.deleted with the deleted-plan reason', async () => {
    const { service, audits, emitted } = build({
      plans: [{ id: 'd1', name: 'Pro 2025', deletedAt: DELETED_AT, archivedRenewMode: 'SELF_RENEW' }],
    });

    await service.sweep();

    assert.equal(audits[0]?.action, 'plans.deleted');
    assert.deepStrictEqual(audits[0]?.metadata, {
      planId: 'd1',
      name: 'Pro 2025',
      automated: true,
      reason: 'deleted-plan-sweep',
    });
    assert.match(String(emitted[0]?.message), /Deleted plan "Pro 2025"/);
  });
});

describe('the sweep holds a plan for exactly what the shared guard reports', () => {
  // Kinds the old seven-check hold list never looked at. Each keeps a retired
  // plan now because the sweep asks the same guard the delete does.
  const kinds: ReadonlyArray<[string, PlanReferenceDbSeed]> = [
    ['a SCHEDULED paid term', { subscriptionTerms: [{ id: 't', planId: 'p1', status: 'SCHEDULED' }] }],
    ['a RESERVED paid trial', { trialClaims: [{ id: 'c', planId: 'p1', status: 'RESERVED' }] }],
    [
      'a wheel sector minting a code for it',
      { wheelSectors: [{ id: 'w', kind: 'PROMOCODE', promoPlanId: 'p1', promoRewardType: 'SUBSCRIPTION' }] },
    ],
    [
      'a recent cancelled checkout a late webhook can revive',
      {
        transactions: [
          { id: 'x', status: 'CANCELED', planSnapshot: { id: 'p1' }, fulfilledAt: null, createdAt: new Date() },
        ],
      },
    ],
  ];

  for (const [what, extra] of kinds) {
    it(`keeps it for ${what}`, async () => {
      const { service, plans } = build({ plans: [{ id: 'p1' }], extra });

      await service.sweep();

      assert.equal(plans.length, 1);
    });
  }

  it('locks the candidates before it counts their references', async () => {
    const { service, db } = build({ plans: [{ id: 'p1' }] });

    await service.sweep();

    const lock = db.calls.indexOf('$queryRaw:lock-plans');
    const firstCount = db.calls.findIndex((call) => call.endsWith('.count') || call.endsWith('.groupBy'));
    assert.ok(lock >= 0 && firstCount > lock, `order was: ${db.calls.join(' -> ')}`);
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

  it('compacts the VISIBLE plans only: a hidden plan still on hold leaves no hole', async () => {
    const { service, plans } = build({
      plans: [
        { id: 'held', orderIndex: 0, deletedAt: DELETED_AT },
        { id: 'gone', orderIndex: 1 },
        { id: 'a', orderIndex: 2, isArchived: false },
        { id: 'b', orderIndex: 3, isArchived: false },
      ],
      subs: [{ planId: 'held', status: 'ACTIVE' }],
    });

    await service.sweep();

    assert.ok(plans.some((p) => p.id === 'held'));
    assert.equal(order(plans), 'a@0 b@1');
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
