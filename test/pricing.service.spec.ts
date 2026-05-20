import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Currency } from '@prisma/client';

import { PricingService } from '../src/modules/plans/services/pricing.service';

describe('PricingService', () => {
  it('prefers purchase discount over personal discount and rounds by currency rules', () => {
    const service = new PricingService();

    const actual = service.buildSnapshot({
      amount: '12.99',
      currency: Currency.USD,
      purchaseDiscount: 20,
      personalDiscount: 40,
    });

    assert.deepStrictEqual(actual, {
      originalPrice: '12.99',
      price: '10.39',
      discountPercent: 20,
      discountSource: 'PURCHASE',
    });
  });

  it('returns the base price when no effective discount is present', () => {
    const service = new PricingService();

    const actual = service.buildSnapshot({
      amount: '9.99',
      currency: Currency.USD,
      purchaseDiscount: 0,
      personalDiscount: 0,
    });

    assert.deepStrictEqual(actual, {
      originalPrice: '9.99',
      price: '9.99',
      discountPercent: 0,
      discountSource: 'NONE',
    });
  });
});
