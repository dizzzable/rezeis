import { Injectable } from '@nestjs/common';
import { Currency } from '@prisma/client';

import { CatalogDiscountSource } from '../interfaces/plan-catalog.interface';

interface PricingInput {
  readonly amount: string;
  readonly currency: Currency;
  readonly purchaseDiscount: number;
  readonly personalDiscount: number;
}

interface PricingSnapshot {
  readonly originalPrice: string;
  readonly price: string;
  readonly discountPercent: number;
  readonly discountSource: CatalogDiscountSource;
}

@Injectable()
export class PricingService {
  public buildSnapshot(input: PricingInput): PricingSnapshot {
    const originalAmount = this.applyCurrencyRules(Number(input.amount), input.currency);
    if (originalAmount <= 0) {
      return {
        originalPrice: this.formatAmount(originalAmount),
        price: this.formatAmount(originalAmount),
        discountPercent: 0,
        discountSource: 'NONE',
      };
    }
    const purchaseDiscount = clampDiscount(input.purchaseDiscount);
    const personalDiscount = clampDiscount(input.personalDiscount);
    let discountPercent = 0;
    let discountSource: CatalogDiscountSource = 'NONE';
    if (purchaseDiscount > 0) {
      discountPercent = purchaseDiscount;
      discountSource = 'PURCHASE';
    } else if (personalDiscount > 0) {
      discountPercent = personalDiscount;
      discountSource = 'PERSONAL';
    }
    const discountedAmount =
      discountPercent >= 100
        ? 0
        : this.applyCurrencyRules(
            (originalAmount * (100 - discountPercent)) / 100,
            input.currency,
          );
    return {
      originalPrice: this.formatAmount(originalAmount),
      price: this.formatAmount(discountedAmount),
      discountPercent:
        Number(this.formatAmount(discountedAmount)) === Number(this.formatAmount(originalAmount))
          ? 0
          : discountPercent,
      discountSource:
        Number(this.formatAmount(discountedAmount)) === Number(this.formatAmount(originalAmount))
          ? 'NONE'
          : discountSource,
    };
  }

  private applyCurrencyRules(amount: number, currency: Currency): number {
    const minimumByCurrency: Readonly<Record<Currency, number>> = {
      USD: 0.01,
      RUB: 1,
      USDT: 0.01,
      USDC: 0.01,
      XTR: 1,
      TON: 0.000001,
      BTC: 0.00000001,
      ETH: 0.000001,
      LTC: 0.00001,
      BNB: 0.0001,
      DASH: 0.0001,
      SOL: 0.00001,
      XMR: 0.000001,
      TRX: 0.000001,
    };
    const precisionByCurrency: Readonly<Record<Currency, number>> = {
      USD: 2,
      RUB: 0,
      USDT: 2,
      USDC: 2,
      XTR: 0,
      TON: 6,
      BTC: 8,
      ETH: 6,
      LTC: 5,
      BNB: 4,
      DASH: 4,
      SOL: 5,
      XMR: 6,
      TRX: 6,
    };
    const precision = precisionByCurrency[currency];
    const roundedAmount =
      precision === 0
        ? Math.floor(amount)
        : Math.floor(amount * 10 ** precision) / 10 ** precision;
    if (roundedAmount === 0) {
      return 0;
    }
    return Math.max(roundedAmount, minimumByCurrency[currency]);
  }

  private formatAmount(amount: number): string {
    return amount.toLocaleString('en-US', {
      useGrouping: false,
      maximumFractionDigits: 8,
    });
  }
}

function clampDiscount(discount: number): number {
  return Math.min(Math.max(discount, 0), 100);
}
