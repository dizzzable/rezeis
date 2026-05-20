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

export interface PlanCatalogPlanInterface {
  readonly id: string;
  readonly orderIndex: number;
  readonly name: string;
  readonly description: string | null;
  readonly tag: string | null;
  readonly type: PlanType;
  readonly availability: PlanAvailability;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly trafficLimitStrategy: TrafficLimitStrategyValue;
  readonly internalSquads: readonly string[];
  readonly externalSquad: string | null;
  readonly durations: readonly PlanCatalogDurationInterface[];
}

export interface PlanCatalogQueryContextInterface {
  readonly channel: PurchaseChannel;
  readonly userId?: string;
}
