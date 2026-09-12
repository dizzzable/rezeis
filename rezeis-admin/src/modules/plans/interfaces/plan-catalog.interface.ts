import { Currency, PaymentGatewayType, PlanAvailability, PlanType, PurchaseChannel } from '@prisma/client';
import { TrafficLimitStrategyValue } from '../dto/traffic-limit-strategy.dto';

export type CatalogDiscountSource = 'NONE' | 'PURCHASE' | 'PERSONAL';

export interface PlanCatalogPriceInterface {
  readonly gatewayType: PaymentGatewayType;
  readonly currency: Currency;
  readonly originalPrice: string;
  readonly price: string;
  readonly discountPercent: number;
  readonly discountSource: CatalogDiscountSource;
  readonly supportedPaymentAssets: readonly string[] | null;
}

export interface PlanCatalogDurationInterface {
  readonly id: string;
  readonly days: number;
  readonly prices: readonly PlanCatalogPriceInterface[];
  /**
   * Points a purchase of this duration earns at the price shown, computed by
   * the same function the post-payment hook credits with. `0` when the rule
   * yields nothing (cashback off, plan excluded, no price in the default
   * currency); `null` when the buyer cannot earn at all (an active partner).
   */
  readonly cashbackPoints: number | null;
}

/**
 * Gateway-independent, operator-configured price for catalog DISPLAY only
 * ("от X / N дн" on the tariff card). Unlike `durations[].prices`, these are
 * emitted regardless of whether a matching payment gateway is currently active,
 * so the browse card always shows a price. Checkout still uses the
 * gateway-aware `durations[].prices`. Empty for free trials.
 */
export interface PlanCatalogDisplayPriceInterface {
  readonly currency: Currency;
  readonly price: string;
  readonly days: number;
}

export interface PlanCatalogPlanInterface {
  readonly id: string;
  readonly orderIndex: number;
  readonly name: string;
  readonly description: string | null;
  readonly tag: string | null;
  readonly icon: string | null;
  readonly type: PlanType;
  readonly availability: PlanAvailability;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly trafficLimitStrategy: TrafficLimitStrategyValue;
  /*
   * NO SQUADS HERE, and this gap is the point.
   *
   * A plan carries `internalSquads` and `externalSquad` — the operator's own
   * Remnawave squad identifiers — and both used to be copied into this shape.
   * This shape is the PUBLIC catalog: the cabinet serves it at `/api/v1/plans`
   * behind an OPTIONAL session, so anyone who opens the site, signed in or not,
   * received the operator's internal naming of their own infrastructure. Not a
   * credential, and nothing could be done with it, but it is ours and it was
   * being handed out to the street for no reason at all: neither field was ever
   * read — not by the cabinet, not by its bot, not by the panel's own SPA. The
   * cabinet declared them in its types and never touched them.
   *
   * What a customer needs to choose a plan is what a customer gets. Which
   * servers that plan reaches is answered later, by the subscriber server list,
   * from the subscription they actually own.
   */
  /** True when this is a trial-availability plan. Trials always create an
   *  `isTrial` subscription. A free trial (`trialFree`) is claimed via the
   *  dedicated trial action; a paid trial is bought through the normal flow. */
  readonly isTrial: boolean;
  /** For trial plans: whether the trial is free (true) or paid (false). */
  readonly trialFree: boolean;
  readonly durations: readonly PlanCatalogDurationInterface[];
  /**
   * Operator-configured prices for display, independent of active gateways.
   * Lets the catalog card show "от X" even when no gateway is enabled. Empty
   * for free trials.
   */
  readonly displayPrices: readonly PlanCatalogDisplayPriceInterface[];
}

export interface PlanCatalogQueryContextInterface {
  readonly channel: PurchaseChannel;
  readonly userId?: string;
}
