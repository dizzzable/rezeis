import { Currency } from '@prisma/client';

import { SubscriptionQuoteWarningInterface } from './subscription-quote.interface';

/**
 * One renewable subscription as surfaced to the renewal selection UI.
 * `amount`/`currency` are `null` when the item cannot currently be priced
 * (e.g. archived plan with no replacement, or no gateway available); such
 * items render disabled with their `warnings`.
 */
export interface RenewalItemInterface {
  readonly subscriptionId: string;
  readonly planId: string | null;
  readonly planName: string | null;
  readonly durationDays: number | null;
  readonly currency: Currency | null;
  readonly amount: string | null;
  readonly discountPercent: number;
  readonly renewable: boolean;
  readonly warnings: readonly SubscriptionQuoteWarningInterface[];
}

/** Response of the renewal-options endpoint. */
export interface RenewalOptionsInterface {
  readonly userId: string;
  readonly items: readonly RenewalItemInterface[];
  /** Common currency across priceable items, or `null` when none/mixed. */
  readonly currency: Currency | null;
  /** Sum of priceable item amounts as a decimal string, or `null`. */
  readonly total: string | null;
}

/** A fully priced renewal line item used to build a combined checkout. */
export interface PricedRenewalItemInterface {
  readonly subscriptionId: string;
  readonly planId: string;
  readonly planName: string;
  readonly durationDays: number;
  readonly currency: Currency;
  readonly amount: string;
  readonly discountPercent: number;
  readonly planSnapshot: Record<string, unknown>;
}

/** Result of pricing a concrete renewal selection for checkout. */
export interface PricedRenewalInterface {
  readonly userId: string;
  readonly currency: Currency;
  readonly total: string;
  readonly items: readonly PricedRenewalItemInterface[];
}
