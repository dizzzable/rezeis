import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PlanDeletionService } from '../src/modules/plans/services/plan-deletion.service';
import {
  isUnreferenced,
  PLAN_REFERENCE_KINDS,
  PlanReferenceCounts,
  PlanReferenceGuardService,
  PlanReferenceKind,
  readReferralGiftPlanId,
  RECENT_CHECKOUT_REVIVAL_WINDOW_MS,
} from '../src/modules/plans/services/plan-reference-guard.service';
import { ReferralPointsExchangeService } from '../src/modules/referrals/services/referral-points-exchange.service';
import { SubscriptionRenewalService } from '../src/modules/subscriptions/services/subscription-renewal.service';
import { buildPlanReferenceDb, PlanReferenceDbSeed, Row } from './fixtures/plan-reference-db';
import { NOT_IN_TERM_MODEL } from './helpers/term-model-hooks';

/**
 * THE ONE ANSWER TO "WHAT STILL USES THIS PLAN".
 *
 * Every kind below has its positive case AND a negative case for each condition
 * that narrows it, because the narrowing is where a plan is lost or kept for
 * ever: a fulfilled purchase that still counted would pin every plan anybody
 * ever bought; an unfulfilled one that did not count would let the delete take
 * the row a paid invoice is about to be delivered from.
 *
 * The database is `test/fixtures/plan-reference-db.ts`, which applies the
 * guard's own `where` to the rows. The live-engine half of the same claims —
 * that the Prisma JSON-path filters mean on PostgreSQL what they mean here — is
 * `test/plan-delete-postgres.spec.ts`.
 */

const X = 'plan-x';
const OTHER = 'plan-other';
const DAY_MS = 24 * 60 * 60 * 1000;
/** A fixed clock, so no case can drift across the seven-day edge on its own. */
const NOW = new Date('2026-09-13T12:00:00.000Z');

async function countsOf(seed: PlanReferenceDbSeed, planId = X): Promise<PlanReferenceCounts> {
  const db = buildPlanReferenceDb({ plans: [{ id: X }, { id: OTHER }], ...seed });
  const guard = new PlanReferenceGuardService(db.client as never);
  const counts = (await guard.countReferences([planId], { now: NOW })).get(planId);
  assert.ok(counts !== undefined, 'the guard must answer for every id it was asked about');
  return counts;
}

/** Asserts ONE kind's count and that every other kind stayed at zero. */
async function expectOnly(seed: PlanReferenceDbSeed, kind: PlanReferenceKind, count: number): Promise<void> {
  const counts = await countsOf(seed);
  const others = PLAN_REFERENCE_KINDS.filter((other) => other !== kind && counts[other] !== 0);
  assert.equal(counts[kind], count, `${kind} counted ${counts[kind]}, expected ${count}`);
  assert.deepEqual(others, [], `other kinds picked the rows up: ${others.join(', ')}`);
}

const subscription = (overrides: Row): Row => ({
  id: `sub-${Math.random()}`,
  status: 'ACTIVE',
  planSnapshot: { id: X },
  ...overrides,
});
const term = (overrides: Row): Row => ({ id: `term-${Math.random()}`, planId: X, status: 'SCHEDULED', ...overrides });
const payment = (overrides: Row): Row => ({
  id: `tx-${Math.random()}`,
  status: 'PENDING',
  planSnapshot: { id: X, selectedDurationDays: 30 },
  fulfilledAt: null,
  createdAt: new Date(NOW.getTime() - DAY_MS),
  ...overrides,
});
const claim = (overrides: Row): Row => ({ id: `claim-${Math.random()}`, planId: X, status: 'RESERVED', ...overrides });
const code = (overrides: Row): Row => ({ id: `promo-${Math.random()}`, archivedAt: null, isActive: true, plan: null, ...overrides });
const action = (overrides: Row): Row => ({
  id: `action-${Math.random()}`,
  promocodeId: 'promo-1',
  type: 'SUBSCRIPTION',
  payload: { plan: { id: X } },
  ...overrides,
});
const quest = (overrides: Row): Row => ({ id: `quest-${Math.random()}`, rewardPlanId: X, rewardType: 'DAYS', ...overrides });
const prize = (overrides: Row): Row => ({
  id: `prize-${Math.random()}`,
  contestId: 'contest-1',
  kind: 'PROMOCODE',
  promoPlanId: X,
  promoRewardType: 'SUBSCRIPTION',
  ...overrides,
});
const sector = (overrides: Row): Row => ({
  id: `sector-${Math.random()}`,
  kind: 'PROMOCODE',
  promoPlanId: X,
  promoRewardType: 'SUBSCRIPTION',
  ...overrides,
});
const placement = (overrides: Row): Row => ({
  id: `placement-${Math.random()}`,
  signupBonusType: 'TARIFF',
  status: 'ACTIVE',
  signupBonus: { tariffPlanId: X, tariffDurationDays: 30 },
  ...overrides,
});

describe('the reference kinds are the contract', () => {
  it('lists the sixteen kinds in the order the delete dialog reads them', () => {
    // Spelled out, not imported from the SPA: the SPA pins the same literal list
    // in `web/src/features/plans/plan-delete.ts`, and two copies that each agree
    // with the contract is the only agreement worth having.
    assert.deepEqual(
      [...PLAN_REFERENCE_KINDS],
      [
        'subscriptions',
        'scheduledTerms',
        'unsettledPayments',
        'recentCheckouts',
        'renewalItems',
        'trialReservations',
        'promocodes',
        'quests',
        'contests',
        'wheelSectors',
        'addOns',
        'adPlacements',
        'referralGift',
        'referralEligibility',
        'transitions',
        // Appended, as the contract allows: an older SPA tab renders it as an
        // unknown kind that keeps the plan, which is the conservative reading.
        'replacementOrphans',
      ],
    );
  });

  it('keeps the revival window at seven days', () => {
    // A literal beside the constant: a fixture built FROM the constant would
    // move with it, and "8 → 7 days" would change nothing any case could see.
    assert.equal(RECENT_CHECKOUT_REVIVAL_WINDOW_MS, 7 * 24 * 60 * 60 * 1000);
  });

  it('reports nothing for a plan nothing uses — an anchor for every negative below', async () => {
    const counts = await countsOf({});
    assert.deepEqual(
      PLAN_REFERENCE_KINDS.filter((kind) => counts[kind] !== 0),
      [],
    );
  });
});

describe('subscriptions', () => {
  for (const status of ['ACTIVE', 'DISABLED', 'LIMITED', 'EXPIRED']) {
    it(`counts a ${status} subscription whose snapshot names the plan`, async () => {
      await expectOnly({ subscriptions: [subscription({ status })] }, 'subscriptions', 1);
    });
  }

  it('counts the `planId` spelling a panel re-import writes', async () => {
    await expectOnly({ subscriptions: [subscription({ planSnapshot: { planId: X } })] }, 'subscriptions', 1);
  });

  it('counts exactly, one per subscription', async () => {
    await expectOnly(
      { subscriptions: [subscription({}), subscription({ status: 'EXPIRED' }), subscription({ planSnapshot: { planId: X } })] },
      'subscriptions',
      3,
    );
  });

  it('does NOT count a DELETED subscription', async () => {
    await expectOnly({ subscriptions: [subscription({ status: 'DELETED' })] }, 'subscriptions', 0);
  });

  it('does NOT count a subscription on another plan', async () => {
    await expectOnly({ subscriptions: [subscription({ planSnapshot: { id: OTHER } })] }, 'subscriptions', 0);
  });
});

describe('scheduledTerms', () => {
  it('counts a SCHEDULED term — a paid future period', async () => {
    await expectOnly({ subscriptionTerms: [term({})] }, 'scheduledTerms', 1);
  });

  for (const status of ['ACTIVE', 'ENDED', 'CANCELED', 'RECONCILIATION_REQUIRED']) {
    it(`does NOT count a ${status} term`, async () => {
      await expectOnly({ subscriptionTerms: [term({ status })] }, 'scheduledTerms', 0);
    });
  }

  it('does NOT count a term on another plan', async () => {
    await expectOnly({ subscriptionTerms: [term({ planId: OTHER })] }, 'scheduledTerms', 0);
  });
});

describe('unsettledPayments', () => {
  it('counts a PENDING purchase', async () => {
    await expectOnly({ transactions: [payment({})] }, 'unsettledPayments', 1);
  });

  it('counts a COMPLETED purchase that has not been fulfilled yet', async () => {
    // The money is taken; fulfilment reads the LIVE plan row. The case the old
    // sweeper spec pinned the wrong way round.
    await expectOnly({ transactions: [payment({ status: 'COMPLETED', fulfilledAt: null })] }, 'unsettledPayments', 1);
  });

  it('does NOT count a COMPLETED purchase that was fulfilled', async () => {
    await expectOnly(
      { transactions: [payment({ status: 'COMPLETED', fulfilledAt: new Date(NOW.getTime() - DAY_MS) })] },
      'unsettledPayments',
      0,
    );
  });

  it('does NOT count a REFUNDED purchase', async () => {
    await expectOnly({ transactions: [payment({ status: 'REFUNDED' })] }, 'unsettledPayments', 0);
  });

  it('does NOT count a purchase of another plan', async () => {
    await expectOnly({ transactions: [payment({ planSnapshot: { id: OTHER } })] }, 'unsettledPayments', 0);
  });
});

describe('recentCheckouts', () => {
  for (const status of ['CANCELED', 'FAILED']) {
    it(`counts a ${status} checkout from yesterday — a late webhook can revive it`, async () => {
      await expectOnly({ transactions: [payment({ status })] }, 'recentCheckouts', 1);
    });
  }

  it('counts one a minute inside the seven-day window', async () => {
    const createdAt = new Date(NOW.getTime() - 7 * DAY_MS + 60_000);
    await expectOnly({ transactions: [payment({ status: 'CANCELED', createdAt })] }, 'recentCheckouts', 1);
  });

  it('does NOT count one a minute past the seven-day window', async () => {
    const createdAt = new Date(NOW.getTime() - 7 * DAY_MS - 60_000);
    await expectOnly({ transactions: [payment({ status: 'CANCELED', createdAt })] }, 'recentCheckouts', 0);
  });

  it('does NOT count a REFUNDED payment as a revivable checkout', async () => {
    await expectOnly({ transactions: [payment({ status: 'REFUNDED' })] }, 'recentCheckouts', 0);
  });

  it('does NOT count a checkout of another plan', async () => {
    await expectOnly({ transactions: [payment({ status: 'FAILED', planSnapshot: { id: OTHER } })] }, 'recentCheckouts', 0);
  });
});

describe('renewalItems', () => {
  const parent = (status: string): Row => ({
    id: `renewal-${status}`,
    status,
    planSnapshot: { combinedRenewal: true },
    fulfilledAt: null,
    createdAt: new Date(NOW.getTime() - DAY_MS),
  });
  const item = (overrides: Row): Row => ({ id: `item-${Math.random()}`, planId: X, appliedAt: null, ...overrides });

  for (const status of ['PENDING', 'COMPLETED']) {
    it(`counts an unapplied line of a ${status} combined renewal`, async () => {
      await expectOnly(
        { transactions: [parent(status)], transactionItems: [item({ transactionId: `renewal-${status}` })] },
        'renewalItems',
        1,
      );
    });
  }

  it('does NOT count a line that was already applied', async () => {
    await expectOnly(
      {
        transactions: [parent('COMPLETED')],
        transactionItems: [item({ transactionId: 'renewal-COMPLETED', appliedAt: new Date(NOW.getTime() - DAY_MS) })],
      },
      'renewalItems',
      0,
    );
  });

  for (const status of ['CANCELED', 'FAILED']) {
    it(`does NOT count an unapplied line of a ${status} renewal`, async () => {
      await expectOnly(
        { transactions: [parent(status)], transactionItems: [item({ transactionId: `renewal-${status}` })] },
        'renewalItems',
        0,
      );
    });
  }

  it('does NOT count a line on another plan', async () => {
    await expectOnly(
      { transactions: [parent('PENDING')], transactionItems: [item({ transactionId: 'renewal-PENDING', planId: OTHER })] },
      'renewalItems',
      0,
    );
  });
});

describe('trialReservations', () => {
  it('counts a RESERVED paid-trial claim', async () => {
    await expectOnly({ trialClaims: [claim({})] }, 'trialReservations', 1);
  });

  for (const status of ['CONSUMED', 'RELEASED']) {
    it(`does NOT count a ${status} claim — history`, async () => {
      await expectOnly({ trialClaims: [claim({ status })] }, 'trialReservations', 0);
    });
  }
});

describe('promocodes', () => {
  it('counts a code granting the plan through the legacy `plan` column', async () => {
    await expectOnly({ promocodes: [code({ plan: { id: X, name: 'Pro' } })] }, 'promocodes', 1);
  });

  it('counts a code granting the plan through a SUBSCRIPTION action', async () => {
    await expectOnly({ promocodes: [code({ id: 'promo-1' })], promocodeActions: [action({})] }, 'promocodes', 1);
  });

  it('counts a PAUSED code — it can be switched back on', async () => {
    await expectOnly({ promocodes: [code({ isActive: false, plan: { id: X } })] }, 'promocodes', 1);
  });

  it('counts a code once when both spellings name the plan', async () => {
    await expectOnly(
      { promocodes: [code({ id: 'promo-1', plan: { id: X } })], promocodeActions: [action({})] },
      'promocodes',
      1,
    );
  });

  it('does NOT count an ARCHIVED code (legacy column)', async () => {
    await expectOnly({ promocodes: [code({ archivedAt: new Date(NOW.getTime() - DAY_MS), plan: { id: X } })] }, 'promocodes', 0);
  });

  it('does NOT count an ARCHIVED code (action)', async () => {
    await expectOnly(
      { promocodes: [code({ id: 'promo-1', archivedAt: new Date(NOW.getTime() - DAY_MS) })], promocodeActions: [action({})] },
      'promocodes',
      0,
    );
  });

  it('does NOT count a non-SUBSCRIPTION action that happens to carry a plan', async () => {
    await expectOnly(
      { promocodes: [code({ id: 'promo-1' })], promocodeActions: [action({ type: 'DURATION' })] },
      'promocodes',
      0,
    );
  });

  it('does NOT count a code granting another plan', async () => {
    await expectOnly(
      { promocodes: [code({ id: 'promo-1', plan: { id: OTHER } })], promocodeActions: [action({ payload: { plan: { id: OTHER } } })] },
      'promocodes',
      0,
    );
  });
});

describe('quests', () => {
  for (const rewardType of ['DAYS', 'PROMOCODE']) {
    it(`counts a ${rewardType} reward naming the plan`, async () => {
      await expectOnly({ quests: [quest({ rewardType })] }, 'quests', 1);
    });
  }

  for (const rewardType of ['POINTS', 'DISCOUNT', 'TRAFFIC']) {
    it(`does NOT count a ${rewardType} reward — it never reads the plan`, async () => {
      await expectOnly({ quests: [quest({ rewardType })] }, 'quests', 0);
    });
  }

  it('does NOT count a quest rewarding another plan', async () => {
    await expectOnly({ quests: [quest({ rewardPlanId: OTHER })] }, 'quests', 0);
  });
});

describe('contests', () => {
  const contest = (id: string, status: string): Row => ({ id, status });

  for (const status of ['DRAFT', 'ACTIVE']) {
    it(`counts a ${status} contest with a subscription code prize on the plan`, async () => {
      await expectOnly({ contests: [contest('contest-1', status)], contestPrizes: [prize({})] }, 'contests', 1);
    });
  }

  for (const status of ['DRAWN', 'CANCELLED']) {
    it(`does NOT count a ${status} contest`, async () => {
      await expectOnly({ contests: [contest('contest-1', status)], contestPrizes: [prize({})] }, 'contests', 0);
    });
  }

  it('counts a prize with NO reward type — it is minted as a subscription code', async () => {
    await expectOnly(
      { contests: [contest('contest-1', 'ACTIVE')], contestPrizes: [prize({ promoRewardType: null })] },
      'contests',
      1,
    );
  });

  it('does NOT count a code prize of another reward type', async () => {
    await expectOnly(
      { contests: [contest('contest-1', 'ACTIVE')], contestPrizes: [prize({ promoRewardType: 'DURATION' })] },
      'contests',
      0,
    );
  });

  it('does NOT count a prize that is not a code', async () => {
    await expectOnly(
      { contests: [contest('contest-1', 'ACTIVE')], contestPrizes: [prize({ kind: 'POINTS' })] },
      'contests',
      0,
    );
  });

  it('counts contests, not prizes', async () => {
    await expectOnly(
      {
        contests: [contest('contest-1', 'ACTIVE'), contest('contest-2', 'DRAFT')],
        contestPrizes: [prize({}), prize({}), prize({ contestId: 'contest-2' })],
      },
      'contests',
      2,
    );
  });
});

describe('wheelSectors', () => {
  it('counts a subscription code sector on the plan', async () => {
    await expectOnly({ wheelSectors: [sector({})] }, 'wheelSectors', 1);
  });

  it('counts a code sector with NO reward type', async () => {
    await expectOnly({ wheelSectors: [sector({ promoRewardType: null })] }, 'wheelSectors', 1);
  });

  it('counts each sector', async () => {
    await expectOnly({ wheelSectors: [sector({}), sector({ promoRewardType: null })] }, 'wheelSectors', 2);
  });

  it('does NOT count a code sector of another reward type', async () => {
    await expectOnly({ wheelSectors: [sector({ promoRewardType: 'DURATION' })] }, 'wheelSectors', 0);
  });

  it('does NOT count a sector that is not a code', async () => {
    await expectOnly({ wheelSectors: [sector({ kind: 'DAYS' })] }, 'wheelSectors', 0);
  });

  it('does NOT count a sector on another plan', async () => {
    await expectOnly({ wheelSectors: [sector({ promoPlanId: OTHER })] }, 'wheelSectors', 0);
  });
});

describe('addOns', () => {
  it('counts each add-on sold against the plan', async () => {
    await expectOnly(
      {
        addOns: [
          { id: 'a1', applicablePlanIds: [OTHER, X] },
          { id: 'a2', applicablePlanIds: [X] },
        ],
      },
      'addOns',
      2,
    );
  });

  it('does NOT count an add-on sold against other plans only', async () => {
    await expectOnly({ addOns: [{ id: 'a1', applicablePlanIds: [OTHER] }] }, 'addOns', 0);
  });
});

describe('adPlacements', () => {
  for (const status of ['ACTIVE', 'PAUSED', 'DRAFT']) {
    it(`counts a ${status} placement whose TARIFF bonus is the plan`, async () => {
      await expectOnly({ adPlacements: [placement({ status })] }, 'adPlacements', 1);
    });
  }

  it('does NOT count an ARCHIVED placement', async () => {
    await expectOnly({ adPlacements: [placement({ status: 'ARCHIVED' })] }, 'adPlacements', 0);
  });

  it('does NOT count a TRIAL bonus that carries a stale tariff id', async () => {
    await expectOnly({ adPlacements: [placement({ signupBonusType: 'TRIAL' })] }, 'adPlacements', 0);
  });

  it('does NOT count a TARIFF bonus of another plan', async () => {
    await expectOnly({ adPlacements: [placement({ signupBonus: { tariffPlanId: OTHER } })] }, 'adPlacements', 0);
  });

  // ── ONLY WHILE THE BONUS STILL GRANTS THE PLAN ──────────────────────────
  //
  // Archiving a plan or switching it off is how an operator stops a placement's
  // bonus, and deleting a plan that was already off sale keeps it stopped
  // (`deletedWhileOnSale`). A placement naming a plan its bonus no longer pays
  // out holds nothing: counted, it kept an off-sale plan's row from ever being
  // removed, and the delete dialog promised a bonus that had stopped.
  const DELETED = new Date(NOW.getTime() - DAY_MS);
  const stopped: ReadonlyArray<[string, Row]> = [
    ['archived', { id: X, isArchived: true }],
    ['switched off', { id: X, isActive: false }],
    ['deleted while off sale', { id: X, isActive: false, isArchived: true, deletedAt: DELETED, deletedWhileOnSale: false }],
    // A stamped row whose flags an older image turned back on: deleted is deleted.
    ['deleted while off sale, then flagged on sale again', { id: X, deletedAt: DELETED, deletedWhileOnSale: false }],
  ];
  for (const [state, plan] of stopped) {
    it(`does NOT count a placement on a plan that is ${state} — its bonus grants nothing`, async () => {
      await expectOnly({ plans: [plan, { id: OTHER }], adPlacements: [placement({})] }, 'adPlacements', 0);
    });
  }

  it('counts a placement on a plan deleted WHILE on sale — its bonus still grants it', async () => {
    await expectOnly(
      {
        plans: [{ id: X, isActive: false, isArchived: true, deletedAt: DELETED, deletedWhileOnSale: true }, { id: OTHER }],
        adPlacements: [placement({})],
      },
      'adPlacements',
      1,
    );
  });

  it('keeps the counts apart when one plan’s bonus has stopped and the other’s has not', async () => {
    const db = buildPlanReferenceDb({
      plans: [{ id: X }, { id: OTHER, isArchived: true }],
      adPlacements: [placement({}), placement({ signupBonus: { tariffPlanId: OTHER } })],
    });
    const guard = new PlanReferenceGuardService(db.client as never);

    const counts = await guard.countReferences([X, OTHER], { now: NOW });

    assert.equal(counts.get(X)?.adPlacements, 1, 'anti-vacuity: the on-sale plan’s placement counts');
    assert.equal(counts.get(OTHER)?.adPlacements, 0);
  });
});

describe('referralGift', () => {
  it('counts the gift subscription plan (camelCase settings)', async () => {
    await expectOnly(
      { settings: { id: 1, referralSettings: { pointsExchange: { giftSubscription: { giftPlanId: X } } } } },
      'referralGift',
      1,
    );
  });

  it('counts the gift subscription plan (snake_case settings)', async () => {
    await expectOnly(
      { settings: { id: 1, referralSettings: { points_exchange: { gift_subscription: { gift_plan_id: X } } } } },
      'referralGift',
      1,
    );
  });

  it('does NOT count a gift of another plan', async () => {
    await expectOnly(
      { settings: { id: 1, referralSettings: { pointsExchange: { giftSubscription: { giftPlanId: OTHER } } } } },
      'referralGift',
      0,
    );
  });

  it('does NOT count anything when there is no settings row', async () => {
    await expectOnly({ settings: null }, 'referralGift', 0);
  });
});

describe('referralEligibility', () => {
  const eligible = (ids: readonly string[], key = 'eligiblePlanIds'): Row => ({
    id: 1,
    referralSettings: { [key]: ids },
  });

  it('counts the plan when it is the only plan the program is limited to', async () => {
    await expectOnly({ settings: eligible([X]) }, 'referralEligibility', 1);
  });

  it('reads the legacy snake_case list too', async () => {
    await expectOnly({ settings: eligible([X], 'eligible_plan_ids') }, 'referralEligibility', 1);
  });

  it('does NOT count it while another LIVE plan is on the list', async () => {
    await expectOnly({ settings: eligible([X, OTHER]) }, 'referralEligibility', 0);
  });

  it('counts it when every other id on the list names a plan that is gone', async () => {
    await expectOnly({ settings: eligible([X, 'plan-long-gone']) }, 'referralEligibility', 1);
  });

  it('counts it when every other id names a SOFT-deleted plan', async () => {
    await expectOnly(
      {
        plans: [{ id: X }, { id: OTHER, deletedAt: new Date(NOW.getTime() - DAY_MS), isActive: false, isArchived: true }],
        settings: eligible([X, OTHER]),
      },
      'referralEligibility',
      1,
    );
  });

  it('does NOT count a plan the list does not name', async () => {
    await expectOnly({ settings: eligible([OTHER]) }, 'referralEligibility', 0);
  });

  it('does NOT count anything for an unrestricted program (empty list)', async () => {
    await expectOnly({ settings: eligible([]) }, 'referralEligibility', 0);
  });
});

describe('transitions', () => {
  it('counts a plan naming it as an upgrade target', async () => {
    await expectOnly({ plans: [{ id: X }, { id: OTHER, upgradeToPlanIds: [X] }] }, 'transitions', 1);
  });

  it('counts a plan naming it as a replacement target', async () => {
    await expectOnly({ plans: [{ id: X }, { id: OTHER, replacementPlanIds: [X] }] }, 'transitions', 1);
  });

  it('counts a plan once even when it names it in both lists', async () => {
    await expectOnly(
      { plans: [{ id: X }, { id: OTHER, upgradeToPlanIds: [X], replacementPlanIds: [X] }] },
      'transitions',
      1,
    );
  });

  it('counts each referencing plan', async () => {
    await expectOnly(
      { plans: [{ id: X }, { id: OTHER, upgradeToPlanIds: [X] }, { id: 'plan-third', replacementPlanIds: [X] }] },
      'transitions',
      2,
    );
  });

  it('does NOT count a plan naming only other targets', async () => {
    await expectOnly({ plans: [{ id: X }, { id: OTHER, upgradeToPlanIds: ['plan-third'] }] }, 'transitions', 0);
  });
});

/**
 * An archived REPLACE_ON_RENEW plan renews its subscribers onto its replacements.
 * When the plan being deleted is the LAST of them still on sale, the delete
 * strips it from the list and those subscribers have nothing to renew onto:
 * they must choose a plan, autopay stops charging them, and their subscriptions
 * end with the paid term. Nothing about that keeps the deleted plan — it is
 * counted so the dialog can say it.
 */
describe('replacementOrphans', () => {
  const replacing = (overrides: Row): Row => ({
    id: 'plan-legacy',
    isActive: false,
    isArchived: true,
    archivedRenewMode: 'REPLACE_ON_RENEW',
    replacementPlanIds: [X],
    ...overrides,
  });

  /** The orphan count, with `transitions` — which the same plans always raise — beside it. */
  async function orphansOf(plans: readonly Row[]): Promise<{ orphans: number; transitions: number; others: string[] }> {
    const counts = await countsOf({ plans: [{ id: X }, { id: OTHER }, ...plans] });
    return {
      orphans: counts.replacementOrphans,
      transitions: counts.transitions,
      others: PLAN_REFERENCE_KINDS.filter(
        (kind) => kind !== 'replacementOrphans' && kind !== 'transitions' && counts[kind] !== 0,
      ),
    };
  }

  it('counts an archived REPLACE_ON_RENEW plan whose only replacement on sale is this plan', async () => {
    assert.deepEqual(await orphansOf([replacing({})]), { orphans: 1, transitions: 1, others: [] });
  });

  it('counts each plan left without a replacement', async () => {
    const result = await orphansOf([replacing({ id: 'plan-legacy-1' }), replacing({ id: 'plan-legacy-2' })]);

    assert.equal(result.orphans, 2);
  });

  it('does NOT count one that still has another replacement on sale', async () => {
    assert.equal((await orphansOf([replacing({ replacementPlanIds: [X, OTHER] })])).orphans, 0);
  });

  const deadOther: ReadonlyArray<[string, Row]> = [
    ['archived', { id: 'plan-dead', isArchived: true }],
    ['switched off', { id: 'plan-dead', isActive: false }],
    ['a trial', { id: 'plan-dead', availability: 'TRIAL' }],
    ['deleted', { id: 'plan-dead', deletedAt: new Date(NOW.getTime() - DAY_MS), isActive: false, isArchived: true }],
    // `TRANSITION_TARGET_WHERE` reads the stamp, not only the flags: a deleted
    // row an older image switched back on is not a replacement anybody renews onto.
    ['deleted, with its flags turned back on', { id: 'plan-dead', deletedAt: new Date(NOW.getTime() - DAY_MS) }],
  ];
  for (const [state, dead] of deadOther) {
    it(`counts one whose other replacement is ${state}`, async () => {
      const result = await orphansOf([dead, replacing({ replacementPlanIds: [X, 'plan-dead', 'plan-long-gone'] })]);

      assert.equal(result.orphans, 1);
    });
  }

  it('does NOT count anything when this plan is itself off sale — deleting it changes no renewal', async () => {
    const counts = await countsOf({
      plans: [{ id: X, isArchived: true }, replacing({})],
    });

    assert.equal(counts.replacementOrphans, 0);
    assert.equal(counts.transitions, 1, 'anti-vacuity: the replacing plan is there');
  });

  const notReplacing: ReadonlyArray<[string, Row]> = [
    ['a SELF_RENEW archived plan', replacing({ archivedRenewMode: 'SELF_RENEW' })],
    ['a plan that is not archived', replacing({ isActive: true, isArchived: false })],
    ['a plan that was itself deleted', replacing({ deletedAt: new Date(NOW.getTime() - DAY_MS) })],
  ];
  for (const [what, plan] of notReplacing) {
    it(`does NOT count ${what} naming it as a replacement`, async () => {
      const result = await orphansOf([plan]);

      assert.equal(result.orphans, 0);
      assert.equal(result.transitions, 1, 'anti-vacuity: the plan still names it');
    });
  }

  it('does NOT count a plan naming it only as an UPGRADE target', async () => {
    const result = await orphansOf([replacing({ replacementPlanIds: [OTHER], upgradeToPlanIds: [X] })]);

    assert.equal(result.orphans, 0);
  });

  // What the dialog warns about is what the renewal then does. Both read
  // `TRANSITION_TARGET_WHERE`; a deleted replacement whose flags were turned
  // back on is exactly where a flag-only reading makes them disagree.
  it('warns about exactly the renewal the delete then turns into a choice', async () => {
    const db = buildPlanReferenceDb({
      plans: [
        { id: X },
        { id: 'plan-dead', deletedAt: new Date(NOW.getTime() - DAY_MS) },
        replacing({ replacementPlanIds: [X, 'plan-dead'] }),
      ],
      subscriptions: [subscription({ id: 'sub-legacy', planSnapshot: { id: 'plan-legacy' } })],
    });
    const guard = new PlanReferenceGuardService(db.client as never);
    const renewal = new SubscriptionRenewalService(db.client as never, {} as never, {} as never);
    assert.equal(await renewal.requiresPlanSelection('sub-legacy'), false, 'anti-vacuity: it renews onto X today');

    const warned = (await guard.countReferences([X], { now: NOW })).get(X)?.replacementOrphans;
    await new PlanDeletionService(db.client as never, guard).deletePlan(X, {
      currentAdmin: { id: 'admin-1' } as never,
      requestMetadata: { requestId: 'req-1', remoteAddress: '203.0.113.7', userAgent: 'spec' },
    });
    const asksToChoose = await renewal.requiresPlanSelection('sub-legacy');

    // Both halves in one comparison, so a failure names every side that is wrong.
    assert.deepEqual(
      { dialogWarned: warned, renewalAsksToChoose: asksToChoose },
      { dialogWarned: 1, renewalAsksToChoose: true },
      'the dialog and the renewal disagree about a deleted replacement',
    );
  });

  it('never keeps a plan: a count of orphans alone reads as unreferenced', () => {
    const counts = Object.fromEntries(PLAN_REFERENCE_KINDS.map((kind) => [kind, 0])) as Record<PlanReferenceKind, number>;
    counts.replacementOrphans = 3;

    assert.equal(isUnreferenced(counts), true);
    counts.transitions = 1;
    assert.equal(isUnreferenced(counts), false, 'anti-vacuity: a keeping kind still keeps');
  });
});

describe('answering for several plans at once', () => {
  it('keeps each plan’s counts apart', async () => {
    const db = buildPlanReferenceDb({
      plans: [{ id: X }, { id: OTHER }],
      subscriptions: [subscription({}), subscription({ planSnapshot: { id: OTHER } }), subscription({ planSnapshot: { id: OTHER } })],
      quests: [quest({ rewardPlanId: OTHER })],
    });
    const guard = new PlanReferenceGuardService(db.client as never);

    const counts = await guard.countReferences([X, OTHER], { now: NOW });

    assert.equal(counts.get(X)?.subscriptions, 1);
    assert.equal(counts.get(X)?.quests, 0);
    assert.equal(counts.get(OTHER)?.subscriptions, 2);
    assert.equal(counts.get(OTHER)?.quests, 1);
  });
});

describe('listReferences — the body of GET /admin/plans/:planId/references', () => {
  it('lists only kinds above zero, in contract order, with exact counts', async () => {
    // Seeded in REVERSE contract order, so a list that echoed insertion order
    // instead of the contract's would come out backwards.
    const db = buildPlanReferenceDb({
      plans: [{ id: X }, { id: OTHER, upgradeToPlanIds: [X] }],
      quests: [quest({}), quest({ rewardType: 'PROMOCODE' })],
      transactions: [payment({})],
      subscriptions: [subscription({})],
    });
    const guard = new PlanReferenceGuardService(db.client as never);

    const references = await guard.listReferences(X, { now: NOW });

    assert.deepEqual(references, [
      { kind: 'subscriptions', count: 1 },
      { kind: 'unsettledPayments', count: 1 },
      { kind: 'quests', count: 2 },
      { kind: 'transitions', count: 1 },
    ]);
  });

  it('is an empty list for a plan nothing uses', async () => {
    const db = buildPlanReferenceDb({ plans: [{ id: X }] });
    const guard = new PlanReferenceGuardService(db.client as never);

    assert.deepEqual(await guard.listReferences(X, { now: NOW }), []);
  });
});

describe('the gift plan is read the way the points exchange reads it', () => {
  /**
   * `readReferralGiftPlanId` is a copy of a private loader in
   * `ReferralPointsExchangeService`. This drives the REAL exchange with the same
   * settings and records which plan it asks the database for — so a key the
   * exchange learns to read and the guard does not fails here, instead of a
   * deleted gift plan answering "Gift subscription plan not found" to every
   * customer who spends their points.
   */
  async function planTheExchangeAsksFor(referralSettings: unknown): Promise<string | undefined> {
    let asked: string | undefined;
    const tx = {
      user: { findUnique: async () => ({ id: 'user-1', currentSubscriptionId: null }) },
      plan: {
        findUnique: async (args: { where: { id: string } }) => {
          asked = args.where.id;
          return null;
        },
      },
    };
    const prisma = {
      settings: { findFirst: async () => ({ referralSettings }) },
      $transaction: async <T>(fn: (client: unknown) => Promise<T>): Promise<T> => fn(tx),
    };
    const exchange = new ReferralPointsExchangeService(prisma as never, {} as never, {} as never, NOT_IN_TERM_MODEL as never);
    await assert.rejects(
      () => exchange.executeExchange({ userId: 'user-1', type: 'GIFT_SUBSCRIPTION', points: 10 }),
      /Gift subscription plan not found/,
    );
    return asked;
  }

  const shapes: ReadonlyArray<[string, unknown]> = [
    [
      'camelCase',
      {
        pointsExchange: {
          exchangeEnabled: true,
          giftSubscription: { enabled: true, pointsCost: 10, minPoints: 10, giftPlanId: 'gift-camel' },
        },
      },
    ],
    [
      'snake_case',
      {
        points_exchange: {
          exchange_enabled: true,
          gift_subscription: { enabled: true, points_cost: 10, min_points: 10, gift_plan_id: 'gift-snake' },
        },
      },
    ],
  ];

  for (const [label, settings] of shapes) {
    it(`agrees on ${label} settings`, async () => {
      const asked = await planTheExchangeAsksFor(settings);

      assert.ok(asked !== undefined && asked.length > 0, 'the exchange never asked for a plan');
      assert.equal(readReferralGiftPlanId(settings), asked);
    });
  }
});
