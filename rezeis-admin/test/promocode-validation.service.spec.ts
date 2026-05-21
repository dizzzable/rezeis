import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PromoCode } from '@prisma/client';

import { PromocodeValidationService, UserSubscriptionInfo } from '../src/modules/promocodes/services/promocode-validation.service';

type MockUser = {
  id: string;
  hasActiveSubscriptions: boolean;
  hasAnySubscriptions: boolean;
};

type MockSubscription = {
  id: string;
  planSnapshot: Record<string, unknown> | null;
  status: string;
  planId: string | null;
};

function makePromoCode(overrides: Partial<PromoCode> = {}): PromoCode {
  return {
    id: 'pc-1',
    code: 'SUMMER2024',
    codeNormalized: 'SUMMER2024',
    planSnapshot: null,
    isActive: true,
    availability: 'ALL',
    rewardType: 'SUBSCRIPTION',
    rewardValue: 30,
    maxActivations: 100,
    expiresAt: null,
    allowedUserIds: [],
    allowedPlanIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as PromoCode;
}

function makeUser(overrides: Partial<MockUser> = {}): MockUser {
  return {
    id: 'user-1',
    hasActiveSubscriptions: false,
    hasAnySubscriptions: false,
    ...overrides,
  };
}

function makeSubscription(planId = 'plan-a', status = 'ACTIVE'): MockSubscription {
  return {
    id: 'sub-1',
    planSnapshot: { id: planId, name: 'Pro Plan' },
    status,
    planId,
  };
}

describe('PromocodeValidationService', () => {
  const service = new PromocodeValidationService();

  // --- INACTIVE ---

  it('returns INACTIVE when promo code is not active', () => {
    const promo = makePromoCode({ isActive: false });
    const user = makeUser();
    const result = service.validateForActivation(promo, user, [], 0, false);
    assert.equal(result, 'INACTIVE');
  });

  it('allows active promo codes to proceed past inactive check', () => {
    const promo = makePromoCode({ isActive: true });
    const user = makeUser({ hasAnySubscriptions: false });
    // This will fail at SUBSCRIPTION_REQUIRED since it's SUBSCRIPTION type with no subscriptions
    // But passes the inactive check
    const result = service.validateForActivation(promo, user, [], 0, false);
    // SUBSCRIPTION type needs subscription — not INACTIVE
    assert.notEqual(result, 'INACTIVE');
  });

  // --- EXPIRED ---

  it('returns EXPIRED when expiresAt is in the past', () => {
    const pastDate = new Date(Date.now() - 86400000);
    const promo = makePromoCode({ expiresAt: pastDate, isActive: true });
    const user = makeUser();
    const result = service.validateForActivation(promo, user, [], 0, false);
    assert.equal(result, 'EXPIRED');
  });

  it('allows promo codes with future expiry dates', () => {
    const futureDate = new Date(Date.now() + 86400000 * 30);
    const promo = makePromoCode({ expiresAt: futureDate, isActive: true });
    const user = makeUser();
    // Will fail at SUBSCRIPTION_REQUIRED but not EXPIRED
    const result = service.validateForActivation(promo, user, [], 0, false);
    assert.notEqual(result, 'EXPIRED');
  });

  it('allows promo codes with null expiry (never expires)', () => {
    const promo = makePromoCode({ expiresAt: null, isActive: true });
    const user = makeUser();
    const result = service.validateForActivation(promo, user, [], 0, false);
    assert.notEqual(result, 'EXPIRED');
  });

  // --- DEPLETED ---

  it('returns DEPLETED when activations count equals maxActivations', () => {
    const promo = makePromoCode({ maxActivations: 5 });
    const user = makeUser();
    const result = service.validateForActivation(promo, user, [], 5, false);
    assert.equal(result, 'DEPLETED');
  });

  it('allows promo codes when activations are below maxActivations', () => {
    const promo = makePromoCode({ maxActivations: 5, rewardType: 'PERSONAL_DISCOUNT' });
    const user = makeUser();
    const result = service.validateForActivation(promo, user, [], 4, false);
    assert.equal(result, null);
  });

  it('returns DEPLETED when activations count exceeds maxActivations', () => {
    const promo = makePromoCode({ maxActivations: 3 });
    const user = makeUser();
    const result = service.validateForActivation(promo, user, [], 10, false);
    assert.equal(result, 'DEPLETED');
  });

  it('treats null maxActivations as unlimited', () => {
    const promo = makePromoCode({ maxActivations: null });
    const user = makeUser({ hasAnySubscriptions: true });
    const subs = [makeSubscription()] as UserSubscriptionInfo[];
    const result = service.validateForActivation(promo, user, subs, 999, false);
    assert.notEqual(result, 'DEPLETED');
  });

  // --- ALREADY_ACTIVATED ---

  it('returns ALREADY_ACTIVATED when user has previously activated', () => {
    const promo = makePromoCode({ isActive: true });
    const user = makeUser();
    const result = service.validateForActivation(promo, user, [], 0, true);
    assert.equal(result, 'ALREADY_ACTIVATED');
  });

  it('allows fresh activation when user has no existing activation', () => {
    const promo = makePromoCode({ isActive: true, rewardType: 'PERSONAL_DISCOUNT' });
    const user = makeUser();
    const result = service.validateForActivation(promo, user, [], 0, false);
    assert.equal(result, null);
  });

  // --- AVAILABILITY: ALL ---

  it('allows ALL availability to any user with subscription', () => {
    const promo = makePromoCode({ availability: 'ALL', rewardType: 'PERSONAL_DISCOUNT' });
    const user = makeUser();
    const result = service.validateForActivation(promo, user, [], 0, false);
    assert.equal(result, null);
  });

  // --- AVAILABILITY: NEW ---

  it('allows NEW availability for users with no subscriptions', () => {
    const promo = makePromoCode({ availability: 'NEW', rewardType: 'PERSONAL_DISCOUNT' });
    const user = makeUser({ hasAnySubscriptions: false });
    const result = service.validateForActivation(promo, user, [], 0, false);
    assert.equal(result, null);
  });

  it('returns NOT_AVAILABLE_FOR_USER for NEW availability when user has subscriptions', () => {
    const promo = makePromoCode({ availability: 'NEW', rewardType: 'PERSONAL_DISCOUNT' });
    const user = makeUser({ hasAnySubscriptions: true, hasActiveSubscriptions: false });
    const result = service.validateForActivation(promo, user, [], 0, false);
    assert.equal(result, 'NOT_AVAILABLE_FOR_USER');
  });

  // --- AVAILABILITY: EXISTING ---

  it('allows EXISTING availability for users with active subscriptions', () => {
    const promo = makePromoCode({ availability: 'EXISTING', rewardType: 'PERSONAL_DISCOUNT' });
    const user = makeUser({ hasActiveSubscriptions: true, hasAnySubscriptions: true });
    const result = service.validateForActivation(promo, user, [], 0, false);
    assert.equal(result, null);
  });

  it('returns NOT_AVAILABLE_FOR_USER for EXISTING availability when user has no active subscriptions', () => {
    const promo = makePromoCode({ availability: 'EXISTING', rewardType: 'PERSONAL_DISCOUNT' });
    const user = makeUser({ hasActiveSubscriptions: false, hasAnySubscriptions: false });
    const result = service.validateForActivation(promo, user, [], 0, false);
    assert.equal(result, 'NOT_AVAILABLE_FOR_USER');
  });

  // --- AVAILABILITY: ALLOWED ---

  it('allows ALLOWED availability when user id is in allowedUserIds', () => {
    const promo = makePromoCode({ availability: 'ALLOWED', allowedUserIds: ['user-1'], rewardType: 'PERSONAL_DISCOUNT' });
    const user = makeUser({ id: 'user-1' });
    const result = service.validateForActivation(promo, user, [], 0, false);
    assert.equal(result, null);
  });

  it('returns NOT_AVAILABLE_FOR_USER for ALLOWED when user id is not in allowedUserIds', () => {
    const promo = makePromoCode({ availability: 'ALLOWED', allowedUserIds: ['user-2'], rewardType: 'PERSONAL_DISCOUNT' });
    const user = makeUser({ id: 'user-1' });
    const result = service.validateForActivation(promo, user, [], 0, false);
    assert.equal(result, 'NOT_AVAILABLE_FOR_USER');
  });

  it('allows ALLOWED availability when allowedUserIds is empty (no restriction)', () => {
    const promo = makePromoCode({ availability: 'ALLOWED', allowedUserIds: [], rewardType: 'PERSONAL_DISCOUNT' });
    const user = makeUser({ id: 'user-1' });
    const result = service.validateForActivation(promo, user, [], 0, false);
    assert.equal(result, null);
  });

  // --- AVAILABILITY: INVITED ---

  it('allows INVITED availability (currently falls through — no referral check in Rezeis yet)', () => {
    const promo = makePromoCode({ availability: 'INVITED', rewardType: 'PERSONAL_DISCOUNT' });
    const user = makeUser();
    // Currently falls through to null — not a failure
    const result = service.validateForActivation(promo, user, [], 0, false);
    assert.equal(result, null);
  });

  // --- PLAN_NOT_ELIGIBLE ---

  it('returns PLAN_NOT_ELIGIBLE when allowedPlanIds is set but user has no matching plan', () => {
    const promo = makePromoCode({ allowedPlanIds: ['plan-x', 'plan-y'], rewardType: 'DURATION' });
    const user = makeUser({ hasAnySubscriptions: true });
    const subs = [makeSubscription('plan-a')] as UserSubscriptionInfo[];
    const result = service.validateForActivation(promo, user, subs, 0, false);
    assert.equal(result, 'PLAN_NOT_ELIGIBLE');
  });

  it('allows promo when allowedPlanIds includes one of the user plan ids', () => {
    const promo = makePromoCode({ allowedPlanIds: ['plan-x'], rewardType: 'DURATION' });
    const user = makeUser({ hasAnySubscriptions: true });
    const subs = [makeSubscription('plan-x')] as UserSubscriptionInfo[];
    const result = service.validateForActivation(promo, user, subs, 0, false);
    assert.equal(result, null);
  });

  it('allows promo when allowedPlanIds is empty (no plan restriction)', () => {
    const promo = makePromoCode({ allowedPlanIds: [], rewardType: 'DURATION' });
    const user = makeUser({ hasAnySubscriptions: true });
    const subs = [makeSubscription('plan-any')] as UserSubscriptionInfo[];
    const result = service.validateForActivation(promo, user, subs, 0, false);
    assert.equal(result, null);
  });

  // --- SUBSCRIPTION_REQUIRED ---

  it('returns SUBSCRIPTION_REQUIRED for DURATION type when user has no subscriptions', () => {
    const promo = makePromoCode({ rewardType: 'DURATION' });
    const user = makeUser({ hasAnySubscriptions: false });
    const result = service.validateForActivation(promo, user, [], 0, false);
    assert.equal(result, 'SUBSCRIPTION_REQUIRED');
  });

  it('allows DURATION type when user has at least one subscription', () => {
    const promo = makePromoCode({ rewardType: 'DURATION' });
    const user = makeUser({ hasAnySubscriptions: true });
    const subs = [makeSubscription()] as UserSubscriptionInfo[];
    const result = service.validateForActivation(promo, user, subs, 0, false);
    assert.equal(result, null);
  });

  it('does NOT require subscription for PERSONAL_DISCOUNT type', () => {
    const promo = makePromoCode({ rewardType: 'PERSONAL_DISCOUNT' });
    const user = makeUser({ hasAnySubscriptions: false });
    const result = service.validateForActivation(promo, user, [], 0, false);
    assert.equal(result, null);
  });

  it('does NOT require subscription for PURCHASE_DISCOUNT type', () => {
    const promo = makePromoCode({ rewardType: 'PURCHASE_DISCOUNT' });
    const user = makeUser({ hasAnySubscriptions: false });
    const result = service.validateForActivation(promo, user, [], 0, false);
    assert.equal(result, null);
  });

  it('returns SUBSCRIPTION_REQUIRED for DEVICES type when user has no subscriptions', () => {
    const promo = makePromoCode({ rewardType: 'DEVICES' });
    const user = makeUser({ hasAnySubscriptions: false });
    const result = service.validateForActivation(promo, user, [], 0, false);
    assert.equal(result, 'SUBSCRIPTION_REQUIRED');
  });

  it('returns SUBSCRIPTION_REQUIRED for TRAFFIC type when user has no subscriptions', () => {
    const promo = makePromoCode({ rewardType: 'TRAFFIC' });
    const user = makeUser({ hasAnySubscriptions: false });
    const result = service.validateForActivation(promo, user, [], 0, false);
    assert.equal(result, 'SUBSCRIPTION_REQUIRED');
  });

  // --- Short-circuit order ---

  it('short-circuits at INACTIVE before checking expiry', () => {
    const pastDate = new Date(Date.now() - 86400000);
    const promo = makePromoCode({ isActive: false, expiresAt: pastDate });
    const user = makeUser();
    const result = service.validateForActivation(promo, user, [], 0, false);
    assert.equal(result, 'INACTIVE');
  });

  it('short-circuits at EXPIRED before checking depletion', () => {
    const pastDate = new Date(Date.now() - 86400000);
    const promo = makePromoCode({ isActive: true, expiresAt: pastDate, maxActivations: 1 });
    const user = makeUser();
    const result = service.validateForActivation(promo, user, [], 999, false);
    assert.equal(result, 'EXPIRED');
  });

  // --- hasRemainingUses ---

  describe('hasRemainingUses', () => {
    it('returns false when promo code is inactive', () => {
      const promo = makePromoCode({ isActive: false });
      assert.equal(service.hasRemainingUses(promo, 0), false);
    });

    it('returns false when promo code is expired', () => {
      const promo = makePromoCode({ isActive: true, expiresAt: new Date(Date.now() - 86400000) });
      assert.equal(service.hasRemainingUses(promo, 0), false);
    });

    it('returns false when activations are at maxActivations', () => {
      const promo = makePromoCode({ isActive: true, maxActivations: 5 });
      assert.equal(service.hasRemainingUses(promo, 5), false);
    });

    it('returns true when promo is active, not expired, and not depleted', () => {
      const promo = makePromoCode({ isActive: true, maxActivations: 10 });
      assert.equal(service.hasRemainingUses(promo, 3), true);
    });

    it('returns true for null maxActivations (unlimited)', () => {
      const promo = makePromoCode({ isActive: true, maxActivations: null });
      assert.equal(service.hasRemainingUses(promo, 9999), true);
    });
  });
});