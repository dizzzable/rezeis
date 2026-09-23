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
    // A slot is free (cap 2), and still no second subscription: the purchase
    // converts the trial.
    assert.equal(actualPolicy.actions.ADDITIONAL, false);
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

  // Multi-subscription left ADDITIONAL open beside a trial, so a subscriber who
  // pressed «Купить» next to it came away holding the trial and a second
  // subscription with a second link.
  for (const status of [SubscriptionStatus.ACTIVE, SubscriptionStatus.LIMITED, SubscriptionStatus.EXPIRED]) {
    it(`closes ADDITIONAL beside a ${status} trial with multi-subscription on, and says the trial is upgraded`, async () => {
      const service = createService({
        user: createUser({ maxSubscriptions: 1 }),
        subscriptions: [
          createSubscription({ id: 'paid-sub', isTrial: false, planId: 'paid-plan' }),
          createSubscription({ id: 'trial-sub', isTrial: true, planId: 'trial-plan', status }),
        ],
        plans: [
          createPlan({ id: 'trial-plan', availability: PlanAvailability.TRIAL }),
          createPlan({ id: 'paid-plan', availability: PlanAvailability.ALL }),
        ],
        multiSubscriptionSettings: { enabled: true, defaultMaxSubscriptions: 5 },
      });

      const policy = await service.getActionPolicy({ userId: 'user-1', channel: PurchaseChannel.WEB });
      const capacity = await service.getSubscriptionCapacity('user-1');

      assert.equal(policy.actions.ADDITIONAL, false);
      assert.equal(policy.actions.NEW, false);
      assert.ok(policy.warnings.some((warning) => warning.code === 'TRIAL_UPGRADE_REQUIRED'));
      // The draft guard reads the same answer.
      assert.equal(capacity.capacityAvailable, true);
      assert.equal(capacity.convertibleTrialId, 'trial-sub');
    });
  }

  it('leaves ADDITIONAL open beside a DISABLED trial, which no upgrade may lift', async () => {
    const service = createService({
      user: createUser({ maxSubscriptions: 1 }),
      subscriptions: [
        createSubscription({
          id: 'trial-sub',
          isTrial: true,
          planId: 'trial-plan',
          status: SubscriptionStatus.DISABLED,
        }),
      ],
      plans: [
        createPlan({ id: 'trial-plan', availability: PlanAvailability.TRIAL }),
        createPlan({ id: 'paid-plan', availability: PlanAvailability.ALL }),
      ],
      multiSubscriptionSettings: { enabled: true, defaultMaxSubscriptions: 5 },
    });

    const policy = await service.getActionPolicy({ userId: 'user-1', channel: PurchaseChannel.WEB });
    const capacity = await service.getSubscriptionCapacity('user-1');

    assert.equal(policy.actions.ADDITIONAL, true);
    assert.ok(!policy.warnings.some((warning) => warning.code === 'TRIAL_UPGRADE_REQUIRED'));
    assert.equal(capacity.convertibleTrialId, null);
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

  describe('what an UPGRADE keeps above the new plan', () => {
    /** On plan A (1024 GB, 1 device) with 50 GB and 2 devices above it. */
    function holderOfExtras(columns = { trafficLimit: 1074, deviceLimit: 3 }): Record<string, unknown> {
      return {
        ...createSubscription({ id: 'paid-sub', isTrial: false, planId: 'plan-a' }),
        planSnapshot: { id: 'plan-a', trafficLimit: 1024, deviceLimit: 1 },
        ...columns,
      };
    }
    const PLANS = [
      createPlan({ id: 'plan-a', availability: PlanAvailability.ALL, upgradeToPlanIds: ['plan-b'] }),
      { ...createPlan({ id: 'plan-b', availability: PlanAvailability.ALL }), trafficLimit: 2048, deviceLimit: 5 },
    ];
    const quote = (service: SubscriptionQuoteService, purchaseType: PurchaseType = PurchaseType.UPGRADE) =>
      service.getQuote({
        userId: 'user-1',
        subscriptionId: 'paid-sub',
        purchaseType,
        planId: purchaseType === PurchaseType.UPGRADE ? 'plan-b' : 'plan-a',
        durationDays: 30,
        channel: PurchaseChannel.WEB,
      });

    it('names what carries — beside the warnings, never blocking eligibility', async () => {
      const service = createService({
        user: createUser({ maxSubscriptions: 1 }),
        subscriptions: [holderOfExtras()],
        plans: PLANS,
      });

      const actualQuote = await quote(service);

      assert.deepStrictEqual(actualQuote.carriedAbovePlan, {
        deviceLimit: 2,
        trafficLimitGb: 50,
        unlimitedDevices: false,
        unlimitedTraffic: false,
      });
      assert.equal(actualQuote.isEligible, true);
      assert.deepStrictEqual(
        actualQuote.warnings.map((warning) => warning.code),
        ['UPGRADE_RESETS_EXPIRY'],
      );
    });

    it('reads the recorded add-on share as the fulfilment does, not the column’s raw excess', async () => {
      // A base cut below the plan with live add-ons on top: only the add-ons
      // carry. Read without the recorded share, the column's raw excess —
      // 26 GB and 1 device — would be announced instead of what was paid for.
      const service = createService({
        user: createUser({ maxSubscriptions: 1 }),
        subscriptions: [
          {
            ...holderOfExtras({ trafficLimit: 1050, deviceLimit: 4 }),
            planSnapshot: { id: 'plan-a', trafficLimit: 1024, deviceLimit: 3 },
            effectiveProjection: {
              activeTrafficContributionBytes: 50n * 1024n * 1024n * 1024n,
              activeDeviceContribution: 2,
            },
          },
        ],
        plans: PLANS,
      });

      assert.deepStrictEqual((await quote(service)).carriedAbovePlan, {
        deviceLimit: 2,
        trafficLimitGb: 50,
        unlimitedDevices: false,
        unlimitedTraffic: false,
      });
    });

    it('says nothing when nothing carries, and nothing on any other action', async () => {
      const onPlan = createService({
        user: createUser({ maxSubscriptions: 1 }),
        subscriptions: [holderOfExtras({ trafficLimit: 1024, deviceLimit: 1 })],
        plans: PLANS,
      });
      assert.equal((await quote(onPlan)).carriedAbovePlan, null);

      const renewing = createService({
        user: createUser({ maxSubscriptions: 1 }),
        subscriptions: [holderOfExtras()],
        plans: PLANS,
      });
      const renewal = await quote(renewing, PurchaseType.RENEW);
      assert.equal(renewal.isEligible, true, 'the renewal quote itself was priced');
      assert.equal(renewal.carriedAbovePlan, null);
    });

    it('promises nothing when a durable term backs the subscription — and still does without one', async () => {
      const previous = process.env.ADDON_ENTITLEMENT_SHADOW;
      process.env.ADDON_ENTITLEMENT_SHADOW = 'true';
      try {
        const durable = createService({
          user: createUser({ maxSubscriptions: 1 }),
          subscriptions: [holderOfExtras()],
          plans: PLANS,
          activeTerm: { id: 'term-1' },
        });
        assert.equal((await quote(durable)).carriedAbovePlan, null);

        const cutOverLater = createService({
          user: createUser({ maxSubscriptions: 1 }),
          subscriptions: [holderOfExtras()],
          plans: PLANS,
          activeTerm: null,
        });
        assert.equal((await quote(cutOverLater)).carriedAbovePlan?.deviceLimit, 2);
      } finally {
        if (previous === undefined) delete process.env.ADDON_ENTITLEMENT_SHADOW;
        else process.env.ADDON_ENTITLEMENT_SHADOW = previous;
      }
    });
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

  // The editor refuses an archived REPLACE_ON_RENEW plan with no replacements,
  // so an empty list only ever means the replacements were deleted (the delete
  // strips them) or taken off sale. Offering nothing turned the subscriber away;
  // the active catalogue is offered to choose from, as for a deleted plan.
  it('offers the active catalogue when no replacement of an archived replace-on-renew plan is left on sale', async () => {
    const service = createService({
      user: createUser({ maxSubscriptions: 2 }),
      subscriptions: [createSubscription({ id: 'sub-1', isTrial: false, planId: 'old-plan' })],
      plans: [
        createPlan({
          id: 'old-plan',
          availability: PlanAvailability.ALL,
          isArchived: true,
          archivedRenewMode: 'REPLACE_ON_RENEW',
          replacementPlanIds: ['retired-replacement'],
        }),
        createPlan({ id: 'retired-replacement', availability: PlanAvailability.ALL, isArchived: true }),
        createPlan({ id: 'catalog-a', availability: PlanAvailability.ALL }),
        createPlan({ id: 'catalog-b', availability: PlanAvailability.ALL }),
        createPlan({ id: 'trial-plan', availability: PlanAvailability.TRIAL }),
      ],
    });

    const discovery = await service.getQuote({
      userId: 'user-1',
      subscriptionId: 'sub-1',
      purchaseType: PurchaseType.RENEW,
      channel: PurchaseChannel.WEB,
    });

    assert.deepStrictEqual(
      discovery.availablePlans.map((plan) => plan.id),
      ['catalog-a', 'catalog-b'],
    );
  });

  // A deleted plan is switched off as it is stamped, but an older image running
  // on the same database can switch the flags back on. `TRANSITION_TARGET_WHERE`
  // reads the stamp too, so such a row is no replacement to renew onto — the
  // same answer `SubscriptionRenewalService` and the delete dialog's
  // `replacementOrphans` read from that one object.
  it('does not offer a deleted replacement whose flags were turned back on', async () => {
    const service = createService({
      user: createUser({ maxSubscriptions: 2 }),
      subscriptions: [createSubscription({ id: 'sub-1', isTrial: false, planId: 'old-plan' })],
      plans: [
        createPlan({
          id: 'old-plan',
          availability: PlanAvailability.ALL,
          isArchived: true,
          archivedRenewMode: 'REPLACE_ON_RENEW',
          replacementPlanIds: ['stamped-replacement'],
        }),
        {
          ...createPlan({ id: 'stamped-replacement', availability: PlanAvailability.ALL }),
          deletedAt: new Date('2026-09-01T00:00:00.000Z'),
        },
        createPlan({ id: 'catalog-a', availability: PlanAvailability.ALL }),
      ],
    });

    const discovery = await service.getQuote({
      userId: 'user-1',
      subscriptionId: 'sub-1',
      purchaseType: PurchaseType.RENEW,
      channel: PurchaseChannel.WEB,
    });

    assert.deepStrictEqual(
      discovery.availablePlans.map((plan) => plan.id),
      ['catalog-a'],
      'a deleted plan was offered as the replacement to renew onto',
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

  // ── A paid trial the buyer cannot claim is not a reason to refuse other plans ─
  //
  // The catalogue lists a paid trial that requires a linked Telegram account to
  // a web-only subscriber, so the NEW/ADDITIONAL quote met it on every request —
  // and its claim warning rode on the quote for WHATEVER plan was chosen. The
  // warning is blocking, so a regular plan quoted with a price and was then
  // refused at checkout (PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE): while that trial was
  // on sale, such a subscriber could buy nothing at all.
  for (const purchaseType of [PurchaseType.NEW, PurchaseType.ADDITIONAL]) {
    it(`keeps a regular plan eligible beside a paid trial the buyer cannot claim (${purchaseType})`, async () => {
      const service = createService({
        // No telegramId: a subscriber who registered on the web.
        user: createUser({ maxSubscriptions: 2 }),
        subscriptions: [],
        plans: [
          createPlan({
            id: 'telegram-trial',
            availability: PlanAvailability.TRIAL,
            trialSettings: { free: false, requireTelegramLink: true },
          }),
          createPlan({ id: 'regular-plan', availability: PlanAvailability.ALL }),
        ],
      });

      const quote = await service.getQuote({
        userId: 'user-1',
        purchaseType,
        planId: 'regular-plan',
        durationDays: 30,
        channel: PurchaseChannel.WEB,
      });

      assert.equal(quote.isEligible, true, 'a regular plan was refused over a trial nobody picked');
      assert.equal(quote.selectedPlan?.id, 'regular-plan');
      assert.deepStrictEqual(quote.warnings, []);
    });
  }

  it('still refuses the unclaimable paid trial itself, and says why', async () => {
    const service = createService({
      user: createUser({ maxSubscriptions: 2 }),
      subscriptions: [],
      plans: [
        createPlan({
          id: 'telegram-trial',
          availability: PlanAvailability.TRIAL,
          trialSettings: { free: false, requireTelegramLink: true },
        }),
        createPlan({ id: 'regular-plan', availability: PlanAvailability.ALL }),
      ],
    });

    const quote = await service.getQuote({
      userId: 'user-1',
      purchaseType: PurchaseType.NEW,
      planId: 'telegram-trial',
      durationDays: 30,
      channel: PurchaseChannel.WEB,
    });

    assert.equal(quote.isEligible, false);
    // The reason first: it is what a client shows, ahead of the bare "not available".
    assert.deepStrictEqual(
      quote.warnings.map((warning) => warning.code),
      ['TRIAL_REQUIRES_TELEGRAM', 'PLAN_NOT_AVAILABLE'],
    );
  });

  it('still names the unclaimable paid trial while no plan is chosen', async () => {
    const service = createService({
      user: createUser({ maxSubscriptions: 2 }),
      subscriptions: [],
      plans: [
        createPlan({
          id: 'telegram-trial',
          availability: PlanAvailability.TRIAL,
          trialSettings: { free: false, requireTelegramLink: true },
        }),
        createPlan({ id: 'regular-plan', availability: PlanAvailability.ALL }),
      ],
    });

    const discovery = await service.getQuote({
      userId: 'user-1',
      purchaseType: PurchaseType.NEW,
      channel: PurchaseChannel.WEB,
    });

    assert.deepStrictEqual(
      discovery.warnings.map((warning) => warning.code),
      ['TRIAL_REQUIRES_TELEGRAM', 'PLAN_SELECTION_REQUIRED'],
    );
  });

  // ── A soft-deleted source plan (plan-deletion contract v2) ────────────────
  //
  // The row is kept for obligations already taken, but for a RENEWAL it is
  // gone: the subscriber is offered the active catalogue to choose from — the
  // same answer a plan whose row is missing gets — never the deleted plan and
  // never silently its own replacement list. UPGRADE from it is unchanged: the
  // row still exists to reprice against.
  it('offers the active catalogue, not the deleted plan, when a RENEW source plan is soft-deleted', async () => {
    const service = createService({
      user: createUser({ maxSubscriptions: 2 }),
      subscriptions: [createSubscription({ id: 'sub-1', isTrial: false, planId: 'deleted-plan' })],
      plans: [
        createPlan({ id: 'deleted-plan', availability: PlanAvailability.ALL, deleted: true }),
        createPlan({ id: 'catalog-a', availability: PlanAvailability.ALL }),
        createPlan({ id: 'catalog-b', availability: PlanAvailability.ALL }),
        createPlan({ id: 'trial-plan', availability: PlanAvailability.TRIAL }),
      ],
    });

    const discovery = await service.getQuote({
      userId: 'user-1',
      subscriptionId: 'sub-1',
      purchaseType: PurchaseType.RENEW,
      channel: PurchaseChannel.WEB,
    });
    const onDeleted = await service.getQuote({
      userId: 'user-1',
      subscriptionId: 'sub-1',
      purchaseType: PurchaseType.RENEW,
      planId: 'deleted-plan',
      durationDays: 30,
      channel: PurchaseChannel.WEB,
    });
    const onChosen = await service.getQuote({
      userId: 'user-1',
      subscriptionId: 'sub-1',
      purchaseType: PurchaseType.RENEW,
      planId: 'catalog-b',
      durationDays: 30,
      channel: PurchaseChannel.WEB,
    });

    assert.deepStrictEqual(
      discovery.availablePlans.map((plan) => plan.id),
      ['catalog-a', 'catalog-b'],
    );
    assert.equal(onDeleted.isEligible, false, 'a renewal was quoted onto the deleted plan');
    assert.ok(onDeleted.warnings.some((warning) => warning.code === 'PLAN_NOT_AVAILABLE'));
    assert.equal(onChosen.isEligible, true, 'the plan the subscriber chose could not be renewed onto');
  });

  it('still renews a LIVE archived SELF_RENEW plan onto itself — the case the one above differs from only by the delete', async () => {
    const service = createService({
      user: createUser({ maxSubscriptions: 2 }),
      subscriptions: [createSubscription({ id: 'sub-1', isTrial: false, planId: 'old-plan' })],
      plans: [
        createPlan({ id: 'old-plan', availability: PlanAvailability.ALL, isArchived: true }),
        createPlan({ id: 'catalog-a', availability: PlanAvailability.ALL }),
      ],
    });

    const discovery = await service.getQuote({
      userId: 'user-1',
      subscriptionId: 'sub-1',
      purchaseType: PurchaseType.RENEW,
      channel: PurchaseChannel.WEB,
    });

    assert.deepStrictEqual(
      discovery.availablePlans.map((plan) => plan.id),
      ['old-plan'],
    );
  });

  it('does not fall back to a soft-deleted plan’s own replacement list', async () => {
    const service = createService({
      user: createUser({ maxSubscriptions: 2 }),
      subscriptions: [createSubscription({ id: 'sub-1', isTrial: false, planId: 'deleted-plan' })],
      plans: [
        createPlan({
          id: 'deleted-plan',
          availability: PlanAvailability.ALL,
          deleted: true,
          archivedRenewMode: 'REPLACE_ON_RENEW',
          replacementPlanIds: ['replacement'],
        }),
        createPlan({ id: 'replacement', availability: PlanAvailability.ALL }),
        createPlan({ id: 'catalog-a', availability: PlanAvailability.ALL }),
      ],
    });

    const discovery = await service.getQuote({
      userId: 'user-1',
      subscriptionId: 'sub-1',
      purchaseType: PurchaseType.RENEW,
      channel: PurchaseChannel.WEB,
    });

    assert.deepStrictEqual(
      discovery.availablePlans.map((plan) => plan.id),
      ['replacement', 'catalog-a'],
    );
  });

  it('keeps UPGRADE from a soft-deleted plan working against its upgrade targets', async () => {
    const service = createService({
      user: createUser({ maxSubscriptions: 2 }),
      subscriptions: [createSubscription({ id: 'sub-1', isTrial: false, planId: 'deleted-plan' })],
      plans: [
        createPlan({
          id: 'deleted-plan',
          availability: PlanAvailability.ALL,
          deleted: true,
          upgradeToPlanIds: ['bigger'],
        }),
        createPlan({ id: 'bigger', availability: PlanAvailability.ALL }),
        createPlan({ id: 'catalog-a', availability: PlanAvailability.ALL }),
      ],
    });

    const quote = await service.getQuote({
      userId: 'user-1',
      subscriptionId: 'sub-1',
      purchaseType: PurchaseType.UPGRADE,
      channel: PurchaseChannel.WEB,
    });

    assert.deepStrictEqual(
      quote.availablePlans.map((plan) => plan.id),
      ['bigger'],
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
  /** The ACTIVE durable term an upgrade quote looks for when the durable model is on. */
  readonly activeTerm?: { readonly id: string } | null;
}): SubscriptionQuoteService {
  const prismaService = {
    subscriptionTerm: {
      findFirst: async () => input.activeTerm ?? null,
    },
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
            readonly deletedAt?: null;
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
          // Honoured only when the query asks, as SQL would: a query that stops
          // asking for live plans must get the deleted one back.
          if (args.where !== undefined && 'deletedAt' in args.where && args.where.deletedAt === null && plan.deletedAt != null) {
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
        // The real catalogue filters `deletedAt: null` beside the flags.
        .filter((plan) => plan.isActive !== false && plan.isArchived !== true && plan.deletedAt == null)
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
  /** Soft-deleted: stamped, archived and inactive, as `PlanDeletionService` leaves it. */
  readonly deleted?: boolean;
}): Record<string, unknown> {
  return {
    id: input.id,
    orderIndex: 1,
    name: input.id,
    description: null,
    tag: null,
    isActive: input.deleted !== true,
    deletedAt: input.deleted === true ? new Date('2026-09-01T00:00:00.000Z') : null,
    isArchived: input.deleted === true ? true : (input.isArchived ?? false),
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
