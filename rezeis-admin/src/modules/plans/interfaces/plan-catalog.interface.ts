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
  readonly internalSquads: readonly string[];
  readonly externalSquad: string | null;
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
