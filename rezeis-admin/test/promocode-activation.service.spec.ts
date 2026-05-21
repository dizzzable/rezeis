import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PromoCode, Subscription } from '@prisma/client';

import { PromocodeActivationService } from '../src/modules/promocodes/services/promocode-activation.service';
import { PromocodeValidationService } from '../src/modules/promocodes/services/promocode-validation.service';

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

function makeSubscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub-1',
    userId: 'user-1',
    planSnapshot: { id: 'plan-a', name: 'Pro Plan' } as never,
    status: 'ACTIVE',
    expiresAt: null,
    trafficLimit: null,
    deviceLimit: null,
    remnawaveId: null,
    remnawaveData: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    startedAt: null,
    ...overrides,
  } as Subscription;
}

// Use concrete Prisma JsonValue-compatible plan snapshot
function makePlanSnapshot(planId = 'plan-a', planName = 'Pro Plan') {
  return { id: planId, name: planName } as never;
}

function createService(): PromocodeActivationService {
  const validationService = new PromocodeValidationService();
  return new PromocodeActivationService(validationService);
}

describe('PromocodeActivationService', () => {
  // --- getEligibleSubscriptions ---

  describe('getEligibleSubscriptions', () => {
    it('returns empty array when user has no subscriptions', async () => {
      const service = createService();
      const promo = makePromoCode();
      const subs: Subscription[] = [];
      const result = await service.getEligibleSubscriptions('user-1', promo, subs);
      assert.equal(result.length, 0);
    });

    it('returns empty array when all subscriptions are inactive', async () => {
      const service = createService();
      const promo = makePromoCode();
      const subs = [
        makeSubscription({ id: 'sub-1', status: 'EXPIRED' }),
        makeSubscription({ id: 'sub-2', status: 'DISABLED' }),
      ];
      const result = await service.getEligibleSubscriptions('user-1', promo, subs);
      assert.equal(result.length, 0);
    });

    it('returns only ACTIVE subscriptions', async () => {
      const service = createService();
      const promo = makePromoCode();
      const subs = [
        makeSubscription({ id: 'sub-1', status: 'ACTIVE', planSnapshot: makePlanSnapshot('plan-a', 'Pro') }),
        makeSubscription({ id: 'sub-2', status: 'EXPIRED', planSnapshot: makePlanSnapshot('plan-b', 'Basic') }),
        makeSubscription({ id: 'sub-3', status: 'ACTIVE', planSnapshot: makePlanSnapshot('plan-c', 'Trial') }),
      ];
      const result = await service.getEligibleSubscriptions('user-1', promo, subs);

      assert.equal(result.length, 2);
      const ids = result.map((s) => s.id);
      assert.ok(ids.includes('sub-1'));
      assert.ok(ids.includes('sub-3'));
      assert.ok(!ids.includes('sub-2'));
    });

    it('filters out subscriptions not in allowedPlanIds when set', async () => {
      const service = createService();
      const promo = makePromoCode({ allowedPlanIds: ['plan-a'] });
      const subs = [
        makeSubscription({ id: 'sub-1', status: 'ACTIVE', planSnapshot: makePlanSnapshot('plan-a', 'Pro') }),
        makeSubscription({ id: 'sub-2', status: 'ACTIVE', planSnapshot: makePlanSnapshot('plan-b', 'Basic') }),
        makeSubscription({ id: 'sub-3', status: 'ACTIVE', planSnapshot: makePlanSnapshot('plan-c', 'Trial') }),
      ];
      const result = await service.getEligibleSubscriptions('user-1', promo, subs);

      assert.equal(result.length, 1);
      assert.equal(result[0].id, 'sub-1');
      assert.equal(result[0].planId, 'plan-a');
    });

    it('returns all active subscriptions when allowedPlanIds is empty', async () => {
      const service = createService();
      const promo = makePromoCode({ allowedPlanIds: [] });
      const subs = [
        makeSubscription({ id: 'sub-1', status: 'ACTIVE', planSnapshot: makePlanSnapshot('plan-x', 'X') }),
        makeSubscription({ id: 'sub-2', status: 'ACTIVE', planSnapshot: makePlanSnapshot('plan-y', 'Y') }),
      ];
      const result = await service.getEligibleSubscriptions('user-1', promo, subs);

      assert.equal(result.length, 2);
    });

    it('correctly extracts planId and planName from planSnapshot JSON', async () => {
      const service = createService();
      const promo = makePromoCode({ allowedPlanIds: [] });
      const subs = [
        makeSubscription({
          id: 'sub-1',
          status: 'ACTIVE',
          planSnapshot: makePlanSnapshot('plan-pro', 'Pro Plan'),
        }),
      ];
      const result = await service.getEligibleSubscriptions('user-1', promo, subs);

      assert.equal(result.length, 1);
      assert.equal(result[0].planId, 'plan-pro');
      assert.equal(result[0].planName, 'Pro Plan');
    });

    it('handles subscription with null planSnapshot', async () => {
      const service = createService();
      const promo = makePromoCode({ allowedPlanIds: [] });
      const subs = [
        makeSubscription({ id: 'sub-1', status: 'ACTIVE', planSnapshot: { id: null, name: null } as never }),
      ];
      const result = await service.getEligibleSubscriptions('user-1', promo, subs);

      assert.equal(result.length, 1);
      assert.equal(result[0].id, 'sub-1');
      assert.equal(result[0].planId, null);
      assert.equal(result[0].planName, null);
    });
  });

  // --- determineNextStep ---

  describe('determineNextStep', () => {
    it('returns NONE for DURATION type', () => {
      const service = createService();
      const subs: { id: string; planId: string | null; planName: string | null }[] = [];
      assert.equal(service.determineNextStep('DURATION', subs), 'NONE');
    });

    it('returns NONE for TRAFFIC type', () => {
      const service = createService();
      const subs: { id: string; planId: string | null; planName: string | null }[] = [];
      assert.equal(service.determineNextStep('TRAFFIC', subs), 'NONE');
    });

    it('returns NONE for DEVICES type', () => {
      const service = createService();
      const subs: { id: string; planId: string | null; planName: string | null }[] = [];
      assert.equal(service.determineNextStep('DEVICES', subs), 'NONE');
    });

    it('returns NONE for PERSONAL_DISCOUNT type', () => {
      const service = createService();
      const subs: { id: string; planId: string | null; planName: string | null }[] = [];
      assert.equal(service.determineNextStep('PERSONAL_DISCOUNT', subs), 'NONE');
    });

    it('returns NONE for PURCHASE_DISCOUNT type', () => {
      const service = createService();
      const subs: { id: string; planId: string | null; planName: string | null }[] = [];
      assert.equal(service.determineNextStep('PURCHASE_DISCOUNT', subs), 'NONE');
    });

    it('returns SELECT_SUBSCRIPTION for SUBSCRIPTION type with eligible subscriptions', () => {
      const service = createService();
      const subs = [
        { id: 'sub-1', planId: 'plan-a', planName: 'Pro' },
      ];
      assert.equal(service.determineNextStep('SUBSCRIPTION', subs), 'SELECT_SUBSCRIPTION');
    });

    it('returns CREATE_NEW for SUBSCRIPTION type with no eligible subscriptions', () => {
      const service = createService();
      const subs: { id: string; planId: string | null; planName: string | null }[] = [];
      assert.equal(service.determineNextStep('SUBSCRIPTION', subs), 'CREATE_NEW');
    });

    it('returns CREATE_NEW for unknown reward types', () => {
      const service = createService();
      const subs: { id: string; planId: string | null; planName: string | null }[] = [];
      assert.equal(service.determineNextStep('UNKNOWN_TYPE', subs), 'CREATE_NEW');
    });

    it('returns SELECT_SUBSCRIPTION with multiple subscriptions', () => {
      const service = createService();
      const subs = [
        { id: 'sub-1', planId: 'plan-a', planName: 'Pro' },
        { id: 'sub-2', planId: 'plan-b', planName: 'Basic' },
        { id: 'sub-3', planId: 'plan-c', planName: 'Trial' },
      ];
      assert.equal(service.determineNextStep('SUBSCRIPTION', subs), 'SELECT_SUBSCRIPTION');
    });
  });
});
