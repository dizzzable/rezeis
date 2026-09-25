import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AddOnLifetime, AddOnType } from '@prisma/client';

import {
  type AddOnPurchaseDatingInput,
  isAddOnPurchaseDated,
} from '../src/modules/add-on-entitlements/domain/add-on-purchase-dating';

/**
 * Whether an add-on bought now is recorded with an end — the offer's `dated`,
 * the cabinet's only licence to say «Действует до …». Each
 * gate here is one the fulfilment passes before it ledgers a purchase; that the
 * two agree, purchase by purchase, is `add-on-offer-dated-postgres.spec.ts`.
 */

const NOW = new Date('2090-03-10T12:00:00.000Z');
const DAY_MS = 86_400_000;
const inDays = (days: number): Date => new Date(NOW.getTime() + days * DAY_MS);

/** In the model, stage 2 on, twenty days left: dated. */
const BASE: AddOnPurchaseDatingInput = {
  type: AddOnType.EXTRA_TRAFFIC,
  lifetime: AddOnLifetime.UNTIL_SUBSCRIPTION_END,
  flags: { directPurchase: true, entitlementShadow: false },
  activeTerm: { endsAt: inDays(20) },
  hasAnyTerm: true,
  subscriptionExpiresAt: inDays(20),
  now: NOW,
};
const dated = (over: Partial<AddOnPurchaseDatingInput>): boolean => isAddOnPurchaseDated({ ...BASE, ...over });

describe('whether an add-on bought now is recorded with an end', () => {
  it('is, in the model with stage 2 on and the subscription’s end ahead — traffic and devices alike', () => {
    assert.equal(dated({}), true);
    assert.equal(dated({ type: AddOnType.EXTRA_DEVICES }), true);
  });

  it('is not with stage 2 off, whatever else holds: the purchase is the permanent increment', () => {
    assert.equal(dated({ flags: { directPurchase: false, entitlementShadow: true } }), false);
    assert.equal(dated({ flags: { directPurchase: false, entitlementShadow: false } }), false);
  });

  it('is, outside the model, only when stage 1 lets the purchase bring the subscription in', () => {
    const outside = { activeTerm: null, hasAnyTerm: false };
    assert.equal(dated({ ...outside }), false, 'stage 1 off: nothing brings it in');
    assert.equal(dated({ ...outside, flags: { directPurchase: true, entitlementShadow: true } }), true);
    assert.equal(
      dated({ activeTerm: null, hasAnyTerm: true, flags: { directPurchase: true, entitlementShadow: true } }),
      false,
      'terms but none ACTIVE: not entered again',
    );
  });

  it('is not for a subscription with no end, nor one whose end has passed — the purchase falls back', () => {
    assert.equal(dated({ subscriptionExpiresAt: null }), false);
    assert.equal(dated({ subscriptionExpiresAt: inDays(-1) }), false);
    assert.equal(dated({ subscriptionExpiresAt: NOW }), false, 'an end AT now is not ahead');
  });

  it('reads the end the purchase aligns the term to, not the term’s stored one', () => {
    // Bonus days not caught up yet: the purchase aligns first, so what counts
    // is the subscription's own expiry.
    assert.equal(dated({ activeTerm: { endsAt: inDays(-1) }, subscriptionExpiresAt: inDays(5) }), true);
    assert.equal(dated({ activeTerm: { endsAt: inDays(5) }, subscriptionExpiresAt: null }), false);
  });

  it('under a paid renewal queued after the current period, ends with the SUBSCRIPTION, the queued term included', () => {
    // «До конца подписки» is `Subscription.expiresAt` (review R3a-05): the
    // current period's end no longer decides anything.
    const queued = { activeTerm: { endsAt: inDays(20) }, subscriptionExpiresAt: inDays(50) };
    assert.equal(dated(queued), true);
    assert.equal(dated({ ...queued, activeTerm: { endsAt: inDays(-1) } }), true, 'the current period is over, the subscription is not');
    assert.equal(dated({ ...queued, subscriptionExpiresAt: null }), false, 'a lifetime subscription has no end');
  });

  it('«until the next reset» is dated once it can be offered at all — in the model, with stage 2 on', () => {
    const reset = { lifetime: AddOnLifetime.UNTIL_NEXT_RESET, subscriptionExpiresAt: null };
    assert.equal(dated(reset), true);
    assert.equal(dated({ ...reset, flags: { directPurchase: false, entitlementShadow: true } }), false);
    assert.equal(dated({ ...reset, activeTerm: null, hasAnyTerm: true }), false);
  });

  it('never for a traffic reset, which grants nothing that could end', () => {
    assert.equal(dated({ type: AddOnType.RESET_TRAFFIC }), false);
  });
});
