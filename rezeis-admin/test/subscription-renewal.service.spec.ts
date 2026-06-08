import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';
import { Currency, PaymentGatewayType, Prisma } from '@prisma/client';
import fc from 'fast-check';

import { SubscriptionRenewalService } from '../src/modules/subscriptions/services/subscription-renewal.service';

interface SubFixture {
  readonly id: string;
  readonly planId: string;
  readonly durationDays: number;
  readonly currency: Currency;
  readonly price: string;
  readonly discountPercent: number;
  /** When true, the discovery quote returns no available plans (not renewable). */
  readonly notRenewable?: boolean;
}

const GATEWAY = PaymentGatewayType.YOOKASSA;

describe('SubscriptionRenewalService.priceRenewalItems', () => {
  it('prices each item and sums the combined total in one currency', async () => {
    const service = createService([
      sub({ id: 's1', price: '10.00' }),
      sub({ id: 's2', price: '5.50' }),
    ]);

    const result = await service.priceRenewalItems({
      identity: { userId: 'user-1' },
      subscriptionIds: ['s1', 's2'],
      gatewayType: GATEWAY,
    });

    assert.equal(result.items.length, 2);
    assert.equal(result.currency, Currency.USD);
    assert.equal(result.total, '15.5');
    assert.equal(result.items[0]?.amount, '10.00');
    assert.equal(result.items[1]?.amount, '5.50');
  });

  it('rejects an empty selection (RENEWAL_NO_ITEMS)', async () => {
    const service = createService([sub({ id: 's1' })]);
    await assert.rejects(
      () => service.priceRenewalItems({ identity: { userId: 'u' }, subscriptionIds: [], gatewayType: GATEWAY }),
      (e: unknown) => e instanceof BadRequestException && e.message === 'RENEWAL_NO_ITEMS',
    );
  });

  it('rejects a mixed-currency selection (MIXED_CURRENCY)', async () => {
    const service = createService([
      sub({ id: 's1', currency: Currency.USD, price: '10.00' }),
      sub({ id: 's2', currency: Currency.RUB, price: '900.00' }),
    ]);
    await assert.rejects(
      () =>
        service.priceRenewalItems({
          identity: { userId: 'u' },
          subscriptionIds: ['s1', 's2'],
          gatewayType: GATEWAY,
        }),
      (e: unknown) => e instanceof BadRequestException && e.message === 'MIXED_CURRENCY',
    );
  });

  it('rejects when an item cannot be priced (RENEWAL_ITEM_NOT_PRICEABLE)', async () => {
    const service = createService([
      sub({ id: 's1', price: '10.00' }),
      sub({ id: 's2', notRenewable: true }),
    ]);
    await assert.rejects(
      () =>
        service.priceRenewalItems({
          identity: { userId: 'u' },
          subscriptionIds: ['s1', 's2'],
          gatewayType: GATEWAY,
        }),
      (e: unknown) => e instanceof BadRequestException && e.message === 'RENEWAL_ITEM_NOT_PRICEABLE',
    );
  });

  it('carries each item discount through from the quote', async () => {
    const service = createService([sub({ id: 's1', price: '8.00', discountPercent: 20 })]);
    const result = await service.priceRenewalItems({
      identity: { userId: 'u' },
      subscriptionIds: ['s1'],
      gatewayType: GATEWAY,
    });
    assert.equal(result.items[0]?.discountPercent, 20);
    assert.equal(result.items[0]?.amount, '8.00');
  });

  it('Property 1: combined total equals the sum of item amounts', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 100_000 }), { minLength: 1, maxLength: 6 }),
        async (cents) => {
          const fixtures = cents.map((c, i) =>
            sub({ id: `s${i}`, price: (c / 100).toFixed(2) }),
          );
          const service = createService(fixtures);
          const result = await service.priceRenewalItems({
            identity: { userId: 'u' },
            subscriptionIds: fixtures.map((f) => f.id),
            gatewayType: GATEWAY,
          });
          const expected = cents
            .reduce((sum, c) => sum.add(new Prisma.Decimal(c).div(100)), new Prisma.Decimal(0))
            .toString();
          assert.equal(result.total, expected);
          assert.equal(result.items.length, fixtures.length);
        },
      ),
      { numRuns: 200 },
    );
  });
});

function sub(input: {
  readonly id: string;
  readonly planId?: string;
  readonly durationDays?: number;
  readonly currency?: Currency;
  readonly price?: string;
  readonly discountPercent?: number;
  readonly notRenewable?: boolean;
}): SubFixture {
  return {
    id: input.id,
    planId: input.planId ?? `plan-${input.id}`,
    durationDays: input.durationDays ?? 30,
    currency: input.currency ?? Currency.USD,
    price: input.price ?? '10.00',
    discountPercent: input.discountPercent ?? 0,
    notRenewable: input.notRenewable ?? false,
  };
}

function createService(fixtures: readonly SubFixture[]): SubscriptionRenewalService {
  const byId = new Map(fixtures.map((f) => [f.id, f]));

  const prismaService = {
    subscription: {
      findMany: async (args: { where: { id?: { in: string[] } } }) => {
        const ids = args.where.id?.in ?? [...byId.keys()];
        return ids
          .map((id) => byId.get(id))
          .filter((f): f is SubFixture => f !== undefined)
          .map((f) => ({ id: f.id, planSnapshot: { id: f.planId, selectedDurationDays: f.durationDays } }));
      },
      findUnique: async (args: { where: { id: string } }) => {
        const f = byId.get(args.where.id);
        if (f === undefined) return null;
        return { id: f.id, planSnapshot: { id: f.planId, selectedDurationDays: f.durationDays } };
      },
    },
    user: { findUnique: async () => ({ id: 'user-1' }) },
  };

  const quoteService = {
    getQuote: async (input: { subscriptionId?: string; planId?: string; durationDays?: number }) => {
      const f = input.subscriptionId ? byId.get(input.subscriptionId) : undefined;
      if (f === undefined || f.notRenewable) {
        return {
          isEligible: false,
          price: null,
          selectedPlan: null,
          selectedDuration: null,
          selectedSubscriptionId: input.subscriptionId ?? null,
          availablePlans: [],
          warnings: [{ code: 'SOURCE_PLAN_MISSING', message: 'missing' }],
        };
      }
      const plan = {
        id: f.planId,
        name: `Plan ${f.id}`,
        tag: null,
        type: 'BOTH',
        trafficLimit: 1024,
        deviceLimit: 1,
        trafficLimitStrategy: 'NO_RESET',
        durations: [{ id: `d${f.durationDays}`, days: f.durationDays }],
      };
      if (input.planId === undefined) {
        // discovery pass
        return {
          isEligible: false,
          price: null,
          selectedPlan: null,
          selectedDuration: null,
          selectedSubscriptionId: f.id,
          availablePlans: [plan],
          warnings: [],
        };
      }
      // pricing pass
      return {
        isEligible: true,
        price: {
          gatewayType: GATEWAY,
          currency: f.currency,
          originalPrice: f.price,
          price: f.price,
          discountPercent: f.discountPercent,
          discountSource: f.discountPercent > 0 ? 'PURCHASE' : 'NONE',
        },
        selectedPlan: plan,
        selectedDuration: plan.durations[0],
        selectedSubscriptionId: f.id,
        availablePlans: [plan],
        warnings: [],
      };
    },
  };

  return new SubscriptionRenewalService(prismaService as never, quoteService as never);
}
