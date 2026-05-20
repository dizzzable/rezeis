import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Currency,
  PaymentGatewayType,
  PlanAvailability,
  PlanType,
  PurchaseChannel,
  PurchaseType,
  SubscriptionStatus,
} from '@prisma/client';

import { SubscriptionQuoteService } from '../src/modules/subscriptions/services/subscription-quote.service';
import { PricingService } from '../src/modules/plans/services/pricing.service';

describe('SubscriptionQuoteService', () => {
  it('allows NEW and ADDITIONAL while capacity is available and returns catalog plans', async () => {
    const service = createService({
      user: createUser({ maxSubscriptions: 2 }),
      subscriptions: [],
      plans: [createPlan({ id: 'plan-new', availability: PlanAvailability.ALL })],
    });

    const actualPolicy = await service.getActionPolicy({
      userId: 'user-1',
      channel: PurchaseChannel.WEB,
    });

    assert.deepStrictEqual(actualPolicy.actions, {
      NEW: true,
      ADDITIONAL: true,
      RENEW: false,
      UPGRADE: false,
      TRIAL: false,
    });
    assert.deepStrictEqual(actualPolicy.availablePlans.map((plan) => plan.id), ['plan-new']);
  });

  it('blocks NEW when an active trial requires upgrade and exposes upgrade candidates', async () => {
    const service = createService({
      user: createUser({ maxSubscriptions: 2 }),
      subscriptions: [createSubscription({ id: 'trial-sub', isTrial: true, planId: 'trial-plan' })],
      trialGrant: { id: 'trial-grant-1' },
      plans: [
        createPlan({ id: 'trial-plan', availability: PlanAvailability.TRIAL, upgradeToPlanIds: ['paid-plan'] }),
        createPlan({ id: 'paid-plan', availability: PlanAvailability.ALL }),
      ],
    });

    const actualPolicy = await service.getActionPolicy({
      userId: 'user-1',
      subscriptionId: 'trial-sub',
      channel: PurchaseChannel.WEB,
    });

    assert.equal(actualPolicy.actions.NEW, false);
    assert.equal(actualPolicy.actions.UPGRADE, true);
    assert.deepStrictEqual(actualPolicy.warnings.map((warning) => warning.code), [
      'UPGRADE_RESETS_EXPIRY',
      'TRIAL_UPGRADE_REQUIRED',
      'TRIAL_ALREADY_USED',
    ]);
  });

  it('blocks trial when a local trial grant exists even without an active trial subscription', async () => {
    const service = createService({
      user: createUser({ maxSubscriptions: 2 }),
      subscriptions: [],
      trialGrant: { id: 'trial-grant-1' },
      plans: [createPlan({ id: 'trial-plan', availability: PlanAvailability.TRIAL })],
    });

    const actualPolicy = await service.getActionPolicy({
      userId: 'user-1',
      channel: PurchaseChannel.WEB,
    });

    assert.equal(actualPolicy.actions.TRIAL, false);
    assert.deepStrictEqual(actualPolicy.warnings.map((warning) => warning.code), [
      'SOURCE_SUBSCRIPTION_REQUIRED',
      'TRIAL_ALREADY_USED',
    ]);
  });

  it('returns an explicit trial-used warning for trial quote attempts after a grant exists', async () => {
    const service = createService({
      user: createUser({ maxSubscriptions: 2 }),
      subscriptions: [],
      trialGrant: { id: 'trial-grant-1' },
      plans: [createPlan({ id: 'trial-plan', availability: PlanAvailability.TRIAL })],
    });

    const actualQuote = await service.getQuote({
      userId: 'user-1',
      purchaseType: 'TRIAL',
      planId: 'trial-plan',
      durationDays: 30,
      channel: PurchaseChannel.WEB,
    });

    assert.equal(actualQuote.isEligible, false);
    assert.deepStrictEqual(actualQuote.availablePlans, []);
    assert.deepStrictEqual(actualQuote.warnings.map((warning) => warning.code), [
      'TRIAL_ALREADY_USED',
      'PLAN_NOT_AVAILABLE',
    ]);
  });

  it('returns replacement renew options for archived replace-on-renew source plans', async () => {
    const service = createService({
      user: createUser({ maxSubscriptions: 2 }),
      subscriptions: [createSubscription({ id: 'sub-1', isTrial: false, planId: 'old-plan' })],
      plans: [
        createPlan({
          id: 'old-plan',
          availability: PlanAvailability.ALL,
          isArchived: true,
          archivedRenewMode: 'REPLACE_ON_RENEW',
          replacementPlanIds: ['new-plan'],
        }),
        createPlan({ id: 'new-plan', availability: PlanAvailability.ALL }),
      ],
    });

    const actualQuote = await service.getQuote({
      userId: 'user-1',
      subscriptionId: 'sub-1',
      purchaseType: PurchaseType.RENEW,
      planId: 'new-plan',
      durationDays: 30,
      channel: PurchaseChannel.WEB,
    });

    assert.equal(actualQuote.isEligible, false);
    assert.deepStrictEqual(actualQuote.availablePlans.map((plan) => plan.id), ['new-plan']);
    assert.deepStrictEqual(actualQuote.warnings.map((warning) => warning.code), [
      'ARCHIVED_PLAN_REPLACEMENT',
    ]);
  });

  it('calculates discount-aware quote pricing without creating transactions', async () => {
    const service = createService({
      user: createUser({ maxSubscriptions: 2, purchaseDiscount: 20 }),
      subscriptions: [],
      plans: [createPlan({ id: 'plan-1', availability: PlanAvailability.ALL })],
    });

    const actualQuote = await service.getQuote({
      userId: 'user-1',
      purchaseType: PurchaseType.NEW,
      planId: 'plan-1',
      durationDays: 30,
      channel: PurchaseChannel.WEB,
    });

    assert.equal(actualQuote.isEligible, true);
    assert.deepStrictEqual(actualQuote.price, {
      gatewayType: PaymentGatewayType.YOOKASSA,
      currency: Currency.USD,
      originalPrice: '10',
      price: '8',
      discountPercent: 20,
      discountSource: 'PURCHASE',
    });
  });

  it('returns a missing source plan warning for legacy subscription snapshots', async () => {
    const service = createService({
      user: createUser({ maxSubscriptions: 2 }),
      subscriptions: [createSubscription({ id: 'sub-1', isTrial: false, planId: null })],
      plans: [],
    });

    const actualQuote = await service.getQuote({
      userId: 'user-1',
      subscriptionId: 'sub-1',
      purchaseType: PurchaseType.RENEW,
      channel: PurchaseChannel.WEB,
    });

    assert.equal(actualQuote.isEligible, false);
    assert.deepStrictEqual(actualQuote.warnings.map((warning) => warning.code), [
      'SOURCE_PLAN_MISSING',
      'PLAN_SELECTION_REQUIRED',
    ]);
  });
});

function createService(input: {
  readonly user: Record<string, unknown>;
  readonly subscriptions: readonly Record<string, unknown>[];
  readonly trialGrant?: Record<string, unknown> | null;
  readonly plans: readonly Record<string, unknown>[];
}): SubscriptionQuoteService {
  const prismaService = {
    user: {
      findUnique: async () => input.user,
    },
    subscription: {
      findMany: async () => input.subscriptions,
    },
    trialGrant: {
      findUnique: async () => input.trialGrant ?? null,
    },
    paymentGateway: {
      findMany: async () => [
        {
          id: 'gateway-1',
          type: PaymentGatewayType.YOOKASSA,
          currency: Currency.USD,
          isActive: true,
          orderIndex: 1,
        },
      ],
    },
    referral: {
      findFirst: async () => null,
    },
    plan: {
      findMany: async (args: { readonly where?: { readonly id?: { readonly in?: readonly string[] }, readonly isActive?: boolean, readonly isArchived?: boolean } } = {}) => {
        const ids = args.where?.id?.in;
        return input.plans.filter((plan) => {
          const id = plan.id as string;
          if (ids !== undefined && !ids.includes(id)) {
            return false;
          }
          if (args.where?.isActive === true && plan.isActive === false) {
            return false;
          }
          if (args.where?.isArchived === false && plan.isArchived === true) {
            return false;
          }
          return true;
        });
      },
      findUnique: async (args: { readonly where: { readonly id: string } }) =>
        input.plans.find((plan) => plan.id === args.where.id) ?? null,
    },
  };
  const planCatalogService = {
    getCatalogPlans: async () => input.plans
      .filter((plan) => plan.isActive !== false && plan.isArchived !== true)
      .map((plan) => ({
        id: plan.id,
      })),
  };
  return new SubscriptionQuoteService(
    prismaService as never,
    planCatalogService as never,
    new PricingService(),
  );
}

function createUser(input: {
  readonly maxSubscriptions: number;
  readonly purchaseDiscount?: number;
  readonly personalDiscount?: number;
}): Record<string, unknown> {
  return {
    id: 'user-1',
    maxSubscriptions: input.maxSubscriptions,
    purchaseDiscount: input.purchaseDiscount ?? 0,
    personalDiscount: input.personalDiscount ?? 0,
  };
}

function createSubscription(input: {
  readonly id: string;
  readonly isTrial: boolean;
  readonly planId: string | null;
}): Record<string, unknown> {
  return {
    id: input.id,
    userId: 'user-1',
    status: SubscriptionStatus.ACTIVE,
    isTrial: input.isTrial,
    planSnapshot: input.planId === null ? {} : { id: input.planId },
    createdAt: new Date('2026-04-19T12:00:00.000Z'),
  };
}

function createPlan(input: {
  readonly id: string;
  readonly availability: PlanAvailability;
  readonly isArchived?: boolean;
  readonly archivedRenewMode?: 'SELF_RENEW' | 'REPLACE_ON_RENEW';
  readonly replacementPlanIds?: readonly string[];
  readonly upgradeToPlanIds?: readonly string[];
}): Record<string, unknown> {
  return {
    id: input.id,
    orderIndex: 1,
    name: input.id,
    description: null,
    tag: null,
    isActive: true,
    isArchived: input.isArchived ?? false,
    archivedRenewMode: input.archivedRenewMode ?? 'SELF_RENEW',
    type: PlanType.BOTH,
    availability: input.availability,
    trafficLimit: 1024,
    deviceLimit: 1,
    trafficLimitStrategy: 'NO_RESET',
    internalSquads: [],
    externalSquad: null,
    upgradeToPlanIds: [...(input.upgradeToPlanIds ?? [])],
    replacementPlanIds: [...(input.replacementPlanIds ?? [])],
    allowedUserIds: [],
    createdAt: new Date('2026-04-19T12:00:00.000Z'),
    updatedAt: new Date('2026-04-19T12:00:00.000Z'),
    durations: [
      {
        id: `${input.id}-duration-1`,
        planId: input.id,
        days: 30,
        prices: [
          {
            id: `${input.id}-price-1`,
            planDurationId: `${input.id}-duration-1`,
            currency: Currency.USD,
            price: { toString: () => '10' },
          },
        ],
      },
    ],
  };
}
