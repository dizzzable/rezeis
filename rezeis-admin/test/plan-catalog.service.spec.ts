import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Currency, PaymentGatewayType, PlanAvailability, PlanType, PurchaseChannel } from '@prisma/client';

import { PlanCatalogService } from '../src/modules/plans/services/plan-catalog.service';
import { PricingService } from '../src/modules/plans/services/pricing.service';

describe('PlanCatalogService', () => {
  it('returns only ALL plans for anonymous web catalog reads and excludes Telegram Stars on WEB', async () => {
    let actualPlanWhere: unknown;
    const prismaService = {
      paymentGateway: {
        findMany: async () => [
          { id: 'gateway-1', type: PaymentGatewayType.YOOKASSA, currency: Currency.USD, isActive: true, orderIndex: 1 },
          { id: 'gateway-2', type: PaymentGatewayType.TELEGRAM_STARS, currency: Currency.USD, isActive: true, orderIndex: 2 },
        ],
      },
      plan: {
        findMany: async (...args: readonly unknown[]) => {
          actualPlanWhere = (args[0] as { readonly where: unknown }).where;
          return [
            createPlanRecord({
              id: 'plan-all',
              availability: PlanAvailability.ALL,
            }),
          ];
        },
      },
      user: { findUnique: async () => null },
      subscription: { findFirst: async () => null },
      referral: { findFirst: async () => null },
      // Unspent discount GRANTS. A grant may be restricted to certain plans,
      // so the discount is a property of the pair (user, plan) now, and the
      // catalog prices every plan — it loads them once per request.
      userPendingDiscount: { findMany: async () => [] },
    };

    const service = new PlanCatalogService(prismaService as never, new PricingService());
    const actual = await service.getCatalogPlans({ channel: PurchaseChannel.WEB });

    assert.deepStrictEqual(actualPlanWhere, {
      isActive: true,
      isArchived: false,
      availability: PlanAvailability.ALL,
    });
    assert.equal(actual.length, 1);
    assert.deepStrictEqual(actual[0]?.durations[0]?.prices, [
      {
        gatewayType: PaymentGatewayType.YOOKASSA,
        currency: Currency.USD,
        originalPrice: '9.99',
        price: '9.99',
        discountPercent: 0,
        discountSource: 'NONE',
        supportedPaymentAssets: null,
      },
    ]);
    assert.equal(actual[0]?.trafficLimitStrategy, 'NO_RESET');
    assert.deepStrictEqual(actual[0]?.internalSquads, []);
    assert.equal(actual[0]?.externalSquad, null);
    // Gateway-independent display prices expose every configured duration
    // price so the catalog card can render "от X" without an active gateway.
    assert.deepStrictEqual(actual[0]?.displayPrices, [
      { currency: Currency.USD, price: '9.99', days: 30 },
      { currency: Currency.USDT, price: '12.49', days: 30 },
    ]);
  });

  it('filters plans by authenticated user context and applies discounts to gateway-aware prices', async () => {
    const prismaService = {
      paymentGateway: {
        findMany: async () => [
          { id: 'gateway-1', type: PaymentGatewayType.YOOKASSA, currency: Currency.USD, isActive: true, orderIndex: 1 },
          { id: 'gateway-2', type: PaymentGatewayType.HELEKET, currency: Currency.USDT, isActive: true, orderIndex: 2 },
        ],
      },
      plan: {
        findMany: async () => [
          createPlanRecord({ id: 'plan-all', availability: PlanAvailability.ALL }),
          createPlanRecord({ id: 'plan-new', availability: PlanAvailability.NEW }),
          createPlanRecord({ id: 'plan-invited', availability: PlanAvailability.INVITED }),
          createPlanRecord({ id: 'plan-allowed', availability: PlanAvailability.ALLOWED, allowedUserIds: ['user-1'] }),
          createPlanRecord({ id: 'plan-trial', availability: PlanAvailability.TRIAL }),
          createPlanRecord({ id: 'plan-existing', availability: PlanAvailability.EXISTING }),
        ],
      },
      user: {
        findUnique: async () => ({
          id: 'user-1',
          purchaseDiscount: 20,
          personalDiscount: 5,
        }),
      },
      subscription: { findFirst: async () => null, count: async () => 0 },
      trialClaim: {
        aggregate: async () => ({ _sum: { units: 0 } }),
        // The catalog discounts the buyer's own still-open trial attempt, the
        // same way quoting does — otherwise a reservation the buyer could still
        // finish removes the trial plan from the list they would finish it from.
        findMany: async () => [],
      },
      transaction: { findFirst: async () => null },
      referral: { findFirst: async () => ({ id: 'ref-1' }) },
      userPendingDiscount: { findMany: async () => [] },
      partnerReferral: { findFirst: async () => null },
    };

    const service = new PlanCatalogService(prismaService as never, new PricingService());
    const actual = await service.getCatalogPlans({
      channel: PurchaseChannel.WEB,
      userId: 'user-1',
    });

    assert.deepStrictEqual(
      actual.map((plan) => plan.id),
      ['plan-all', 'plan-new', 'plan-invited', 'plan-allowed', 'plan-trial'],
    );
    assert.deepStrictEqual(actual[0]?.durations[0]?.prices, [
      {
        gatewayType: PaymentGatewayType.YOOKASSA,
        currency: Currency.USD,
        originalPrice: '9.99',
        price: '7.99',
        discountPercent: 20,
        discountSource: 'PURCHASE',
        supportedPaymentAssets: null,
      },
      {
        gatewayType: PaymentGatewayType.HELEKET,
        currency: Currency.USDT,
        originalPrice: '12.49',
        price: '9.99',
        discountPercent: 20,
        discountSource: 'PURCHASE',
        supportedPaymentAssets: ['USDT', 'TON', 'BTC', 'ETH'],
      },
    ]);
    assert.equal(actual[0]?.trafficLimitStrategy, 'NO_RESET');
  });

  /**
   * The reported bug, at the layer above quoting.
   *
   * A paid-trial draft holds a RESERVED claim and the quota counter treats
   * RESERVED as spent, so a buyer who abandoned a checkout was told their trial
   * was used up. Quoting was taught to discount the buyer's own still-open
   * attempt — but the catalog gates first, and it still counted that
   * reservation, so the trial plan never appeared in the list and the buyer
   * never reached the quote that would have let them back in.
   *
   * A CONSUMED claim, by contrast, is a genuinely spent trial and must keep
   * hiding the plan.
   */
  for (const scenario of [
    {
      name: 'keeps the trial plan visible while the buyer has an unfinished attempt of their own',
      reservedUnits: 1,
      pendingTransaction: { id: 'tx-1' } as { id: string } | null,
      expectTrial: true,
    },
    {
      name: 'still hides the trial plan once the quota is genuinely spent',
      reservedUnits: 1,
      pendingTransaction: null,
      expectTrial: false,
    },
  ]) {
    it(scenario.name, async () => {
      const prismaService = {
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
        plan: {
          findMany: async () => [
            createPlanRecord({ id: 'plan-all', availability: PlanAvailability.ALL }),
            createPlanRecord({ id: 'plan-trial', availability: PlanAvailability.TRIAL }),
          ],
        },
        user: { findUnique: async () => ({ id: 'user-1', purchaseDiscount: 0, personalDiscount: 0 }) },
        subscription: { findFirst: async () => null, count: async () => 0 },
        trialClaim: {
          // The exclusion is expressed as `transactionId: { not: <resumable> }`,
          // so mirror the real semantics: the unit disappears from the sum only
          // when the resumable draft is the one being excluded.
          aggregate: async (args: { where?: { transactionId?: { not?: string } } }) => ({
            _sum: {
              units:
                args.where?.transactionId?.not === 'tx-1' ? 0 : scenario.reservedUnits,
            },
          }),
          findMany: async () => [{ transactionId: 'tx-1' }],
        },
        transaction: { findFirst: async () => scenario.pendingTransaction },
        referral: { findFirst: async () => null },
        // Unspent discount GRANTS. A grant may be restricted to certain plans,
        // so the discount is a property of the pair (user, plan) now, and the
        // catalog prices every plan — it loads them once per request.
        userPendingDiscount: { findMany: async () => [] },
        partnerReferral: { findFirst: async () => null },
      };

      const service = new PlanCatalogService(prismaService as never, new PricingService());
      const actual = await service.getCatalogPlans({
        channel: PurchaseChannel.WEB,
        userId: 'user-1',
      });

      assert.equal(
        actual.some((plan) => plan.id === 'plan-trial'),
        scenario.expectTrial,
      );
      // The rest of the catalog is unaffected either way.
      assert.ok(actual.some((plan) => plan.id === 'plan-all'));
    });
  }
});

function createPlanRecord(input: {
  readonly id: string;
  readonly availability: PlanAvailability;
  readonly allowedUserIds?: readonly string[];
}) {
  return {
    id: input.id,
    orderIndex: 1,
    name: input.id,
    description: `${input.id} description`,
    tag: null,
    isActive: true,
    isArchived: false,
    archivedRenewMode: 'SELF_RENEW',
    type: PlanType.BOTH,
    availability: input.availability,
    trafficLimit: 1024,
    deviceLimit: 1,
    trafficLimitStrategy: 'NO_RESET',
    internalSquads: [],
    externalSquad: null,
    upgradeToPlanIds: [],
    replacementPlanIds: [],
    allowedUserIds: [...(input.allowedUserIds ?? [])],
    createdAt: new Date('2026-04-19T10:00:00.000Z'),
    updatedAt: new Date('2026-04-19T10:00:00.000Z'),
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
            price: { toString: (): string => '9.99' },
          },
          {
            id: `${input.id}-price-2`,
            planDurationId: `${input.id}-duration-1`,
            currency: Currency.USDT,
            price: { toString: (): string => '12.49' },
          },
        ],
      },
    ],
  };
}
