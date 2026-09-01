import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PromocodeRewardType } from '@prisma/client';

import { mapPromocode } from '../src/modules/promocodes/utils/promocode-mappers.util';
import {
  isGrantApplicable,
  pickBestDiscount,
} from '../src/common/utils/pending-discount.util';
import {
  MAX_DISCOUNT_PERCENT,
  clampDiscountPercent,
} from '../src/common/utils/discount.util';

/**
 * A promocode does a LIST of things now, under conditions that have to survive
 * until each of them fires.
 *
 * The old shape was one `rewardType` per code, so "-10% on the next purchase
 * AND +7 days" needed two codes and a line of copy telling the customer to
 * enter both. Everything below is about the three places that shape was load
 * bearing: the order actions run in, the conditions a discount carries with it,
 * and the codes that have no action rows at all.
 */

function record(over: Record<string, unknown> = {}) {
  return {
    id: 'promo-1',
    code: 'D3M-SEP',
    isActive: true,
    availability: 'ALL',
    rewardType: PromocodeRewardType.DURATION,
    reward: 7,
    plan: null,
    lifetime: null,
    expiresAt: null,
    maxActivations: null,
    allowedTelegramIds: [],
    allowedPlanIds: [],
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    archivedAt: null,
    _count: { activations: 0 },
    ...over,
  } as never;
}

describe('what a promocode does, as a list', () => {
  it('reads several actions off one code', () => {
    const promo = mapPromocode(
      record({
        actions: [
          { type: PromocodeRewardType.PURCHASE_DISCOUNT, value: 10, payload: null },
          { type: PromocodeRewardType.DURATION, value: 7, payload: null },
        ],
      }),
    );

    assert.deepStrictEqual(
      promo.actions.map((a) => a.type),
      [PromocodeRewardType.PURCHASE_DISCOUNT, PromocodeRewardType.DURATION],
    );
  });

  it('puts SUBSCRIPTION first whatever order it was stored in', () => {
    // It creates or REPLACES a subscription. Applied after the others, the days
    // and traffic granted beside it land on a row that is then replaced — the
    // customer sees a fresh subscription and none of the extras.
    const promo = mapPromocode(
      record({
        actions: [
          { type: PromocodeRewardType.DURATION, value: 7, payload: null },
          { type: PromocodeRewardType.TRAFFIC, value: 50, payload: null },
          {
            type: PromocodeRewardType.SUBSCRIPTION,
            value: null,
            payload: { plan: { id: 'plan-6m', duration: 180 } },
          },
        ],
      }),
    );

    assert.equal(promo.actions[0]?.type, PromocodeRewardType.SUBSCRIPTION);
    assert.equal(promo.actions[0]?.plan?.id, 'plan-6m');
  });

  it('still yields ONE action for a code that has no action rows', () => {
    // Codes written by an older panel, and everything a donor import writes,
    // have nothing in `promocode_actions`. Reading those as "does nothing"
    // would silently turn every legacy code into a no-op.
    const promo = mapPromocode(record({ rewardType: PromocodeRewardType.DEVICES, reward: 2 }));

    assert.equal(promo.actions.length, 1);
    assert.equal(promo.actions[0]?.type, PromocodeRewardType.DEVICES);
    assert.equal(promo.actions[0]?.value, 2);
  });

  it('reads the restrictions a discount action carries', () => {
    // NOT the promocode's `allowedPlanIds`, which says where the CODE may be
    // activated. This says where the granted DISCOUNT may be spent, and it is
    // the difference between "-20% only on six months" working and not.
    const promo = mapPromocode(
      record({
        actions: [
          {
            type: PromocodeRewardType.PURCHASE_DISCOUNT,
            value: 20,
            payload: { allowedPlanIds: ['plan-6m'], validForDays: 30 },
          },
        ],
      }),
    );

    assert.deepStrictEqual(promo.actions[0]?.discountAllowedPlanIds, ['plan-6m']);
    assert.equal(promo.actions[0]?.discountValidForDays, 30);
  });
});

describe('a discount carries its conditions to the checkout', () => {
  const now = new Date('2026-09-10T12:00:00.000Z');
  const grant = (over: Record<string, unknown> = {}) => ({
    id: 'g-1',
    percent: 20,
    allowedPlanIds: [] as string[],
    expiresAt: null as Date | null,
    consumedAt: null as Date | null,
    ...over,
  });

  it('applies to the plan it is restricted to', () => {
    assert.equal(isGrantApplicable(grant({ allowedPlanIds: ['plan-6m'] }), 'plan-6m', now), true);
  });

  it('does NOT apply to another plan', () => {
    // The whole point. Before grants, the restriction was checked when the code
    // was activated and forgotten by the time the discount was spent, so a
    // six-month-only discount came off a one-month purchase.
    assert.equal(isGrantApplicable(grant({ allowedPlanIds: ['plan-6m'] }), 'plan-1m', now), false);
  });

  it('does not apply when nobody says which plan is being bought', () => {
    // A combined renewal has no single plan. Quoting a restricted discount
    // there would show a price the checkout then refuses to honour.
    assert.equal(isGrantApplicable(grant({ allowedPlanIds: ['plan-6m'] }), null, now), false);
    // An unrestricted one still does.
    assert.equal(isGrantApplicable(grant(), null, now), true);
  });

  it('expires on its own clock', () => {
    const expired = grant({ expiresAt: new Date('2026-09-09T00:00:00.000Z') });
    assert.equal(isGrantApplicable(expired, null, now), false);
  });

  it('is gone once spent', () => {
    assert.equal(isGrantApplicable(grant({ consumedAt: now }), null, now), false);
  });
});

describe('choosing between several unspent discounts', () => {
  const now = new Date('2026-09-10T12:00:00.000Z');
  const base = { expiresAt: null, consumedAt: null };

  it('takes the largest that applies, and names it', () => {
    const chosen = pickBestDiscount({
      grants: [
        { id: 'g-small', percent: 10, allowedPlanIds: [], ...base },
        { id: 'g-big', percent: 25, allowedPlanIds: ['plan-6m'], ...base },
      ],
      planId: 'plan-6m',
      legacyPercent: 0,
      now,
    });

    assert.deepStrictEqual(chosen, { percent: 25, grantId: 'g-big' });
  });

  it('does not spend the big one on a purchase it does not cover', () => {
    // Burning the six-month grant on a one-month order would lose it for good:
    // it is marked consumed and was never applied to the price.
    const chosen = pickBestDiscount({
      grants: [
        { id: 'g-small', percent: 10, allowedPlanIds: [], ...base },
        { id: 'g-big', percent: 25, allowedPlanIds: ['plan-6m'], ...base },
      ],
      planId: 'plan-1m',
      legacyPercent: 0,
      now,
    });

    assert.deepStrictEqual(chosen, { percent: 10, grantId: 'g-small' });
  });

  it('adds nothing up', () => {
    // Discounts have never stacked: the pricing snapshot takes one or the
    // other. Summing grants would change what every existing promocode does on
    // the release that introduced the table.
    const chosen = pickBestDiscount({
      grants: [
        { id: 'a', percent: 30, allowedPlanIds: [], ...base },
        { id: 'b', percent: 30, allowedPlanIds: [], ...base },
      ],
      planId: 'plan-1m',
      legacyPercent: 0,
      now,
    });

    assert.equal(chosen.percent, 30);
  });

  it('still honours a grant written before the table existed', () => {
    // `user.purchaseDiscount` is what donor imports write and what an older
    // half of the system still sets. It competes on equal terms and has no
    // grant to mark spent.
    const chosen = pickBestDiscount({ grants: [], planId: 'plan-1m', legacyPercent: 15, now });

    assert.deepStrictEqual(chosen, { percent: 15, grantId: null });
  });
});

describe('the discount ceiling', () => {
  it('is 90, not 100', () => {
    // A full discount is a free order that still travels through a payment
    // provider: a zero-amount invoice some gateways refuse outright and others
    // accept and never call back. Anything given away entirely belongs in a
    // SUBSCRIPTION action, which grants access without an order at all.
    assert.equal(MAX_DISCOUNT_PERCENT, 90);
    assert.equal(clampDiscountPercent(250), 90);
    assert.equal(clampDiscountPercent(100), 90);
  });

  it('bounds a stored grant on the way out too', () => {
    // A row written before the ceiling — or by a donor import — must not be
    // able to spend more than the ceiling either.
    const chosen = pickBestDiscount({
      grants: [
        {
          id: 'legacy',
          percent: 100,
          allowedPlanIds: [],
          expiresAt: null,
          consumedAt: null,
        },
      ],
      planId: 'plan-1m',
      legacyPercent: 0,
      now: new Date('2026-09-10T12:00:00.000Z'),
    });

    assert.equal(chosen.percent, 90);
  });

  it('leaves ordinary values alone', () => {
    // Mutation check: clamping everything to the ceiling would make every
    // promocode a 90% discount.
    assert.equal(clampDiscountPercent(20), 20);
    assert.equal(clampDiscountPercent(0), 0);
    assert.equal(clampDiscountPercent(-5), 0);
  });
});

// ── The write path ────────────────────────────────────────────────────────

describe('what a write request says the code should do', () => {
  it('reads a list when the request sends one', async () => {
    const { resolvePromocodeActions } = await import(
      '../src/modules/promocodes/utils/promocode-action-input.util'
    );

    const actions = resolvePromocodeActions({
      actions: [
        { type: PromocodeRewardType.PURCHASE_DISCOUNT, value: 10 },
        { type: PromocodeRewardType.DURATION, value: 7 },
      ],
    });

    assert.equal(actions.length, 2);
  });

  it('reads the legacy fields as ONE action when there is no list', async () => {
    // An older panel sends only these, and so does every donor import. Treating
    // their absence of `actions` as "does nothing" would turn every such
    // request into a promocode that activates to nothing.
    const { resolvePromocodeActions } = await import(
      '../src/modules/promocodes/utils/promocode-action-input.util'
    );

    const actions = resolvePromocodeActions({
      rewardType: PromocodeRewardType.DEVICES,
      reward: 2,
    });

    assert.deepStrictEqual(actions.map((a) => [a.type, a.value]), [
      [PromocodeRewardType.DEVICES, 2],
    ]);
  });

  it('sorts SUBSCRIPTION to the front on the way IN as well', async () => {
    // Stored in the order it runs, so the row list reads the way it behaves.
    const { resolvePromocodeActions } = await import(
      '../src/modules/promocodes/utils/promocode-action-input.util'
    );

    const actions = resolvePromocodeActions({
      actions: [
        { type: PromocodeRewardType.DURATION, value: 7 },
        { type: PromocodeRewardType.SUBSCRIPTION, value: null },
      ],
    });

    assert.equal(actions[0]?.type, PromocodeRewardType.SUBSCRIPTION);
  });

  it('refuses the same action twice', async () => {
    // The database enforces it too; caught here so the operator gets a bounded
    // error rather than a unique-constraint failure.
    const { resolvePromocodeActions } = await import(
      '../src/modules/promocodes/utils/promocode-action-input.util'
    );

    assert.throws(() =>
      resolvePromocodeActions({
        actions: [
          { type: PromocodeRewardType.DURATION, value: 7 },
          { type: PromocodeRewardType.DURATION, value: 3 },
        ],
      }),
    );
  });

  it('refuses a request that says nothing at all', async () => {
    // A promocode with no actions activates to nothing while still consuming
    // the customer's one activation of that code.
    const { resolvePromocodeActions } = await import(
      '../src/modules/promocodes/utils/promocode-action-input.util'
    );

    assert.throws(() => resolvePromocodeActions({}));
  });

  it('stores discount restrictions, and nothing for an action without extras', async () => {
    const { buildActionPayload } = await import(
      '../src/modules/promocodes/utils/promocode-action-input.util'
    );

    assert.deepStrictEqual(
      buildActionPayload({
        type: PromocodeRewardType.PURCHASE_DISCOUNT,
        value: 20,
        plan: null,
        discountAllowedPlanIds: ['plan-6m'],
        discountValidForDays: 30,
      }),
      { allowedPlanIds: ['plan-6m'], validForDays: 30 },
    );

    // `undefined`, not `{}` — an empty object reads back as "there is a
    // payload" and invites code that trusts its presence.
    assert.equal(
      buildActionPayload({
        type: PromocodeRewardType.DURATION,
        value: 7,
        plan: null,
        discountAllowedPlanIds: [],
        discountValidForDays: null,
      }),
      undefined,
    );
  });
});

// ── One rule, three places ────────────────────────────────────────────────

describe('the price shown, the price charged and the grant burned agree', () => {
  const now = new Date('2026-09-10T12:00:00.000Z');
  const grants = [
    { id: 'g-any', percent: 10, allowedPlanIds: [], expiresAt: null, consumedAt: null },
    { id: 'g-6m', percent: 25, allowedPlanIds: ['plan-6m'], expiresAt: null, consumedAt: null },
  ];

  /**
   * Three services ask about the same purchase: the CATALOG (to display a
   * price), the QUOTE (to decide the amount charged) and the CHECKOUT (to
   * decide which grant is spent). They call one function — and calling it with
   * DIFFERENT INPUTS is the same defect as calling two different functions,
   * only harder to see. The checkout passed `legacyPercent: 0` while both
   * pricing paths passed the real column.
   */

  it('burns the grant that actually produced the price', () => {
    // The failure this pins: with a legacy column ABOVE every grant, the
    // customer is charged at the column — and the checkout used to answer with
    // the best GRANT instead, marking spent a discount that had reduced
    // nothing.
    const quoted = pickBestDiscount({ grants, planId: 'plan-1m', legacyPercent: 30, now });
    const consumed = pickBestDiscount({ grants, planId: 'plan-1m', legacyPercent: 30, now });

    assert.equal(quoted.percent, 30, 'the column is what the customer was charged at');
    assert.equal(consumed.grantId, null, 'a grant that produced no discount was burned');
  });

  it('does burn a grant when the grant is what produced the price', () => {
    // Mutation check: never returning a grantId would leave every grant
    // unspent, and the discount would apply to every purchase for ever.
    const chosen = pickBestDiscount({ grants, planId: 'plan-6m', legacyPercent: 0, now });

    assert.deepStrictEqual(chosen, { percent: 25, grantId: 'g-6m' });
  });

  it('prefers the grant when it ties with the column', () => {
    // A tie is the NORMAL case: granting an unrestricted discount writes the
    // grant and mirrors it into the column, so both hold the same number.
    // Letting the column win meant `grantId` was null, nothing was marked
    // spent, and the customer kept the discount for ever.
    const chosen = pickBestDiscount({
      grants: [{ id: 'g', percent: 20, allowedPlanIds: [], expiresAt: null, consumedAt: null }],
      planId: 'plan-1m',
      legacyPercent: 20,
      now,
    });

    assert.equal(chosen.grantId, 'g');
  });
});
