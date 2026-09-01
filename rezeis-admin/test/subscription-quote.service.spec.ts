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
  it('raises the effective subscription cap from the global multi-subscription default', async () => {
    // User column default is 1; a single active subscription would normally
    // block ADDITIONAL. With the global policy enabled (default 3) the
    // effective cap rises so the user can buy more.
    const service = createService({
      user: createUser({ maxSubscriptions: 1 }),
      subscriptions: [createSubscription({ id: 'sub-1', isTrial: false, planId: 'plan-a' })],
      plans: [createPlan({ id: 'plan-a', availability: PlanAvailability.ALL })],
      multiSubscriptionSettings: { enabled: true, defaultMaxSubscriptions: 3 },
    });

    const actualPolicy = await service.getActionPolicy({
      userId: 'user-1',
      channel: PurchaseChannel.WEB,
    });

    assert.equal(actualPolicy.actions.ADDITIONAL, true);
    assert.equal(actualPolicy.maxSubscriptions, 3);
    assert.equal(
      actualPolicy.warnings.some((warning) => warning.code === 'SUBSCRIPTION_LIMIT_REACHED'),
      false,
    );
  });

  it('keeps the per-user cap when the global multi-subscription policy is disabled', async () => {
    const service = createService({
      user: createUser({ maxSubscriptions: 1 }),
      subscriptions: [createSubscription({ id: 'sub-1', isTrial: false, planId: 'plan-a' })],
      plans: [createPlan({ id: 'plan-a', availability: PlanAvailability.ALL })],
      multiSubscriptionSettings: { enabled: false, defaultMaxSubscriptions: 3 },
    });

    const actualPolicy = await service.getActionPolicy({
      userId: 'user-1',
      channel: PurchaseChannel.WEB,
    });

    assert.equal(actualPolicy.actions.ADDITIONAL, false);
    assert.equal(actualPolicy.maxSubscriptions, 1);
  });

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
    assert.deepStrictEqual(
      actualPolicy.availablePlans.map((plan) => plan.id),
      ['plan-new'],
    );
  });

  it('blocks NEW when an active trial requires upgrade and exposes upgrade candidates', async () => {
    const service = createService({
      user: createUser({ maxSubscriptions: 2 }),
      subscriptions: [createSubscription({ id: 'trial-sub', isTrial: true, planId: 'trial-plan' })],
      trialGrant: { id: 'trial-grant-1' },
      plans: [
        createPlan({
          id: 'trial-plan',
          availability: PlanAvailability.TRIAL,
          upgradeToPlanIds: ['paid-plan'],
        }),
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
    assert.deepStrictEqual(
      actualPolicy.warnings.map((warning) => warning.code),
      [
        'TRIAL_NOT_RENEWABLE',
        'UPGRADE_RESETS_EXPIRY',
        'TRIAL_UPGRADE_REQUIRED',
        'TRIAL_ALREADY_USED',
      ],
    );
  });

  it('lets a trial without configured upgrade targets upgrade to any non-trial plan (fallback)', async () => {
    const service = createService({
      user: createUser({ maxSubscriptions: 2 }),
      subscriptions: [createSubscription({ id: 'trial-sub', isTrial: true, planId: 'trial-plan' })],
      trialGrant: { id: 'trial-grant-1' },
      plans: [
        // No upgradeToPlanIds configured on the trial plan.
        createPlan({ id: 'trial-plan', availability: PlanAvailability.TRIAL }),
        createPlan({ id: 'paid-plan', availability: PlanAvailability.ALL }),
      ],
    });

    const actualPolicy = await service.getActionPolicy({
      userId: 'user-1',
      subscriptionId: 'trial-sub',
      channel: PurchaseChannel.WEB,
    });

    // Fallback: trial → any active non-trial catalog plan.
    assert.equal(actualPolicy.actions.UPGRADE, true);
  });

  it('keeps an UPGRADE quote eligible despite the informational reset-expiry warning', async () => {
    // Regression: UPGRADE_RESETS_EXPIRY is attached to every upgrade quote.
    // Treating it as a blocking warning made `isEligible` false, so
    // createDraft rejected the checkout with PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE
    // (a 400 BAD_REQUEST) — the "payment on trial upgrade doesn't go through"
    // bug. The informational warning must NOT block eligibility.
    const service = createService({
      user: createUser({ maxSubscriptions: 2 }),
      subscriptions: [createSubscription({ id: 'trial-sub', isTrial: true, planId: 'trial-plan' })],
      trialGrant: { id: 'trial-grant-1' },
      plans: [
        createPlan({ id: 'trial-plan', availability: PlanAvailability.TRIAL }),
        createPlan({ id: 'paid-plan', availability: PlanAvailability.ALL }),
      ],
    });

    const actualQuote = await service.getQuote({
      userId: 'user-1',
      subscriptionId: 'trial-sub',
      purchaseType: PurchaseType.UPGRADE,
      planId: 'paid-plan',
      durationDays: 30,
      channel: PurchaseChannel.WEB,
    });

    assert.equal(actualQuote.isEligible, true);
    assert.equal(actualQuote.price?.price, '10');
    assert.deepStrictEqual(
      actualQuote.warnings.map((warning) => warning.code),
      ['UPGRADE_RESETS_EXPIRY'],
    );
  });

  it('blocks RENEW for a free trial source and steers the user to upgrade', async () => {
    const service = createService({
      user: createUser({ maxSubscriptions: 2 }),
      subscriptions: [createSubscription({ id: 'trial-sub', isTrial: true, planId: 'trial-plan' })],
      plans: [
        createPlan({
          id: 'trial-plan',
          availability: PlanAvailability.TRIAL,
          upgradeToPlanIds: ['paid-plan'],
          trialSettings: { free: true },
        }),
        createPlan({ id: 'paid-plan', availability: PlanAvailability.ALL }),
      ],
    });

    const actualPolicy = await service.getActionPolicy({
      userId: 'user-1',
      subscriptionId: 'trial-sub',
      channel: PurchaseChannel.WEB,
    });

    assert.equal(actualPolicy.actions.RENEW, false);
    assert.equal(actualPolicy.actions.UPGRADE, true);
    assert.equal(
      actualPolicy.warnings.some((warning) => warning.code === 'TRIAL_NOT_RENEWABLE'),
      true,
    );
  });

  it('blocks RENEW for an expired paid trial so maxClaims cannot be bypassed', async () => {
    const service = createService({
      user: createUser({ maxSubscriptions: 2 }),
      subscriptions: [
        createSubscription({
          id: 'paid-trial-sub',
          isTrial: true,
          planId: 'paid-trial-plan',
          status: SubscriptionStatus.EXPIRED,
        }),
      ],
      plans: [
        createPlan({
          id: 'paid-trial-plan',
          availability: PlanAvailability.TRIAL,
          trialSettings: { free: false },
        }),
        createPlan({ id: 'regular-plan', availability: PlanAvailability.ALL }),
      ],
    });

    const actualPolicy = await service.getActionPolicy({
      userId: 'user-1',
      subscriptionId: 'paid-trial-sub',
      channel: PurchaseChannel.WEB,
    });

    assert.equal(actualPolicy.actions.RENEW, false);
    assert.equal(actualPolicy.actions.UPGRADE, true);
    assert.equal(
      actualPolicy.warnings.some((warning) => warning.code === 'TRIAL_NOT_RENEWABLE'),
      true,
    );
  });

  it('blocks RENEW for a disabled regular subscription', async () => {
    const service = createService({
      user: createUser({ maxSubscriptions: 2 }),
      subscriptions: [
        createSubscription({
          id: 'disabled-sub',
          isTrial: false,
          planId: 'regular-plan',
          status: SubscriptionStatus.DISABLED,
        }),
      ],
      plans: [createPlan({ id: 'regular-plan', availability: PlanAvailability.ALL })],
    });

    const quote = await service.getQuote({
      userId: 'user-1',
      subscriptionId: 'disabled-sub',
      purchaseType: PurchaseType.RENEW,
      planId: 'regular-plan',
      durationDays: 30,
      channel: PurchaseChannel.WEB,
    });

    assert.equal(quote.isEligible, false);
    assert.equal(
      quote.warnings.some(
        (warning) => warning.code === 'SUBSCRIPTION_DISABLED_NOT_RENEWABLE',
      ),
      true,
    );
  });

  it('blocks self-renew before payment when the live source plan became TRIAL', async () => {
    const service = createService({
      user: createUser({ maxSubscriptions: 2 }),
      subscriptions: [
        createSubscription({
          id: 'regular-sub',
          isTrial: false,
          planId: 'reclassified-plan',
        }),
      ],
      plans: [
        createPlan({
          id: 'reclassified-plan',
          availability: PlanAvailability.TRIAL,
        }),
      ],
    });

    const quote = await service.getQuote({
      userId: 'user-1',
      subscriptionId: 'regular-sub',
      purchaseType: PurchaseType.RENEW,
      planId: 'reclassified-plan',
      durationDays: 30,
      channel: PurchaseChannel.WEB,
    });

    assert.equal(quote.isEligible, false);
    assert.deepStrictEqual(quote.availablePlans, []);
    assert.equal(
      quote.warnings.some((warning) => warning.code === 'TRIAL_PLAN_NOT_RENEWAL_TARGET'),
      true,
    );
  });

  it('allows the second paid-trial claim when maxClaims is 2', async () => {
    const service = createService({
      user: createUser({ maxSubscriptions: 3 }),
      subscriptions: [
        createSubscription({
          id: 'first-paid-trial',
          isTrial: true,
          planId: 'paid-trial-plan',
          status: SubscriptionStatus.EXPIRED,
        }),
      ],
      trialGrant: { id: 'legacy-marker-does-not-imply-exhaustion' },
      plans: [
        createPlan({
          id: 'paid-trial-plan',
          availability: PlanAvailability.TRIAL,
          trialSettings: { free: false, maxClaims: 2 },
        }),
      ],
    });

    const quote = await service.getQuote({
      userId: 'user-1',
      purchaseType: PurchaseType.ADDITIONAL,
      planId: 'paid-trial-plan',
      durationDays: 30,
      channel: PurchaseChannel.WEB,
    });

    assert.equal(quote.isEligible, true);
    assert.equal(quote.selectedPlan?.id, 'paid-trial-plan');
  });

  it('keeps an exhausted paid trial out of NEW checkout quotes', async () => {
    const service = createService({
      user: createUser({ maxSubscriptions: 2 }),
      subscriptions: [
        createSubscription({
          id: 'paid-trial-sub',
          isTrial: true,
          planId: 'paid-trial-plan',
          status: SubscriptionStatus.EXPIRED,
        }),
      ],
      trialGrant: { id: 'trial-grant-1' },
      plans: [
        createPlan({
          id: 'paid-trial-plan',
          availability: PlanAvailability.TRIAL,
          trialSettings: { free: false, maxClaims: 1 },
        }),
      ],
    });

    const actualQuote = await service.getQuote({
      userId: 'user-1',
      purchaseType: PurchaseType.ADDITIONAL,
      planId: 'paid-trial-plan',
      durationDays: 30,
      channel: PurchaseChannel.WEB,
    });

    assert.equal(actualQuote.isEligible, false);
    assert.deepStrictEqual(actualQuote.availablePlans, []);
    assert.equal(
      actualQuote.warnings.some((warning) => warning.code === 'TRIAL_ALREADY_USED'),
      true,
    );
  });

  it('uses subscription claim count instead of the legacy TrialGrant marker', async () => {
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

    assert.equal(actualPolicy.actions.TRIAL, true);
    assert.deepStrictEqual(
      actualPolicy.warnings.map((warning) => warning.code),
      ['SOURCE_SUBSCRIPTION_REQUIRED'],
    );
  });

  it('keeps a free trial claimable when only the legacy TrialGrant marker exists', async () => {
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

    assert.equal(actualQuote.isEligible, true);
    assert.equal(actualQuote.selectedPlan?.id, 'trial-plan');
    assert.deepStrictEqual(actualQuote.warnings, []);
  });

  it('filters TRIAL plans out of configured upgrade targets', async () => {
    const service = createService({
      user: createUser({ maxSubscriptions: 2 }),
      subscriptions: [createSubscription({ id: 'sub-1', isTrial: false, planId: 'plan-1' })],
      plans: [
        createPlan({
          id: 'plan-1',
          availability: PlanAvailability.ALL,
          upgradeToPlanIds: ['trial-target', 'regular-target'],
        }),
        createPlan({ id: 'trial-target', availability: PlanAvailability.TRIAL }),
        createPlan({ id: 'regular-target', availability: PlanAvailability.ALL }),
      ],
    });

    const policy = await service.getActionPolicy({
      userId: 'user-1',
      subscriptionId: 'sub-1',
      channel: PurchaseChannel.WEB,
    });

    assert.equal(policy.actions.UPGRADE, true);
    const quote = await service.getQuote({
      userId: 'user-1',
      subscriptionId: 'sub-1',
      purchaseType: PurchaseType.UPGRADE,
      planId: 'trial-target',
      durationDays: 30,
      channel: PurchaseChannel.WEB,
    });
    assert.equal(quote.isEligible, false);
    assert.equal(quote.availablePlans.some((plan) => plan.id === 'trial-target'), false);
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

    // ARCHIVED_PLAN_REPLACEMENT is an informational notice (the renewal moves
    // onto the valid replacement plan), so the quote stays ELIGIBLE — otherwise
    // archived REPLACE_ON_RENEW subscriptions could never be renewed.
    assert.equal(actualQuote.isEligible, true);
    assert.deepStrictEqual(
      actualQuote.availablePlans.map((plan) => plan.id),
      ['new-plan'],
    );
    assert.deepStrictEqual(
      actualQuote.warnings.map((warning) => warning.code),
      ['ARCHIVED_PLAN_REPLACEMENT'],
    );
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

  it("keeps the trial offered while the buyer's own attempt is unpaid", async () => {
    // The reported bug: an abandoned checkout holds a RESERVED claim, the quota
    // counter treats RESERVED as spent, and the buyer was told the trial was
    // already used — for an attempt they had not paid for and could still
    // finish. That reservation is theirs to resolve, so it must not hide the plan.
    const service = createService({
      user: createUser({ maxSubscriptions: 2 }),
      subscriptions: [],
      trialClaimUnits: 1,
      resumableTrialTransactionId: 'tx-pending',
      plans: [
        createPlan({
          id: 'paid-trial-plan',
          availability: PlanAvailability.TRIAL,
          trialSettings: { free: false, maxClaims: 1 },
        }),
      ],
    });

    const actualQuote = await service.getQuote({
      userId: 'user-1',
      purchaseType: PurchaseType.ADDITIONAL,
      planId: 'paid-trial-plan',
      durationDays: 30,
      channel: PurchaseChannel.WEB,
    });

    assert.equal(
      actualQuote.warnings.some((warning) => warning.code === 'TRIAL_ALREADY_USED'),
      false,
      'the buyer must not be told the trial is used while their own draft is unpaid',
    );
    assert.equal(actualQuote.isEligible, true);
  });

  it('still blocks the trial once it was genuinely consumed', async () => {
    // Same spent count, nothing resumable behind it — this one must keep blocking.
    const service = createService({
      user: createUser({ maxSubscriptions: 2 }),
      subscriptions: [],
      trialClaimUnits: 1,
      plans: [
        createPlan({
          id: 'paid-trial-plan',
          availability: PlanAvailability.TRIAL,
          trialSettings: { free: false, maxClaims: 1 },
        }),
      ],
    });

    const actualQuote = await service.getQuote({
      userId: 'user-1',
      purchaseType: PurchaseType.ADDITIONAL,
      planId: 'paid-trial-plan',
      durationDays: 30,
      channel: PurchaseChannel.WEB,
    });

    assert.equal(
      actualQuote.warnings.some((warning) => warning.code === 'TRIAL_ALREADY_USED'),
      true,
    );
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
    assert.deepStrictEqual(
      actualQuote.warnings.map((warning) => warning.code),
      ['SOURCE_PLAN_MISSING', 'PLAN_SELECTION_REQUIRED'],
    );
  });
});

function createService(input: {
  readonly user: Record<string, unknown>;
  readonly subscriptions: readonly Record<string, unknown>[];
  readonly trialGrant?: Record<string, unknown> | null;
  readonly trialClaimUnits?: number;
  /** A RESERVED claim on a still-PENDING draft — the buyer's own unfinished
   *  attempt, which quoting must not count against them. */
  readonly resumableTrialTransactionId?: string;
  readonly plans: readonly Record<string, unknown>[];
  readonly multiSubscriptionSettings?: Record<string, unknown> | null;
}): SubscriptionQuoteService {
  const prismaService = {
    settings: {
      findFirst: async () => ({
        multiSubscriptionSettings: input.multiSubscriptionSettings ?? null,
      }),
    },
    user: {
      findUnique: async () => input.user,
    },
    subscription: {
      findMany: async () => input.subscriptions,
      count: async () =>
        input.subscriptions.filter((subscription) => subscription.isTrial === true).length,
    },
    trialGrant: {
      findUnique: async () => input.trialGrant ?? null,
    },
    trialClaim: {
      aggregate: async (args: { where?: { transactionId?: { not?: string } } }) => {
        const base =
          input.trialClaimUnits ??
          input.subscriptions.filter((subscription) => subscription.isTrial === true).length;
        // Mirror the real exclusion: skipping the buyer's own resumable draft
        // removes exactly its one unit from the total.
        const excluded = args?.where?.transactionId?.not;
        const skips =
          excluded !== undefined && excluded === input.resumableTrialTransactionId ? 1 : 0;
        return { _sum: { units: Math.max(0, base - skips) } };
      },
      findMany: async () =>
        input.resumableTrialTransactionId === undefined
          ? []
          : [{ transactionId: input.resumableTrialTransactionId }],
    },
    transaction: {
      findFirst: async () =>
        input.resumableTrialTransactionId === undefined
          ? null
          : { id: input.resumableTrialTransactionId },
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
      findMany: async (
        args: {
          readonly where?: {
            readonly id?: { readonly in?: readonly string[] };
            readonly isActive?: boolean;
            readonly isArchived?: boolean;
          };
        } = {},
      ) => {
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
    getCatalogPlans: async () =>
      input.plans
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
    // Unspent discount GRANTS. The quote prices with the SAME choice the
    // catalog displays, so it needs the same input — reading the bare column
    // alone charged whatever the most recent grant happened to be, ignoring the
    // plans it was restricted to.
    pendingDiscounts: [],
  };
}

function createSubscription(input: {
  readonly id: string;
  readonly isTrial: boolean;
  readonly planId: string | null;
  readonly status?: SubscriptionStatus;
}): Record<string, unknown> {
  return {
    id: input.id,
    userId: 'user-1',
    status: input.status ?? SubscriptionStatus.ACTIVE,
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
  readonly trialSettings?: Record<string, unknown>;
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
    trialSettings: input.trialSettings ?? {},
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
