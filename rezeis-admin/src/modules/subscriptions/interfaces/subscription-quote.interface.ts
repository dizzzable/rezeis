import { Currency, PaymentGatewayType, PurchaseChannel } from '@prisma/client';

import { CatalogDiscountSource } from '../../plans/interfaces/plan-catalog.interface';
import { TrafficLimitStrategyValue } from '../../plans/dto/traffic-limit-strategy.dto';
import { SubscriptionQuoteAction } from '../dto/subscription-quote.dto';

export type SubscriptionQuoteWarningCode =
  | 'SOURCE_SUBSCRIPTION_REQUIRED'
  | 'SOURCE_PLAN_MISSING'
  | 'ARCHIVED_PLAN_REPLACEMENT'
  | 'UPGRADE_RESETS_EXPIRY'
  | 'TRIAL_UPGRADE_REQUIRED'
  | 'TRIAL_ALREADY_USED'
  | 'TRIAL_INVITED_ONLY'
  | 'SUBSCRIPTION_LIMIT_REACHED'
  | 'PLAN_SELECTION_REQUIRED'
  | 'DURATION_SELECTION_REQUIRED'
  | 'PLAN_NOT_AVAILABLE'
  | 'DURATION_NOT_AVAILABLE'
  | 'GATEWAY_NOT_AVAILABLE'
  | 'TRIAL_NOT_AVAILABLE';

export interface SubscriptionQuoteWarningInterface {
  readonly code: SubscriptionQuoteWarningCode;
  readonly message: string;
}

export interface SubscriptionQuoteDurationInterface {
  readonly id: string;
  readonly days: number;
}

export interface SubscriptionQuotePlanInterface {
  readonly id: string;
  readonly name: string;
  readonly tag: string | null;
  readonly type: string;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly trafficLimitStrategy: TrafficLimitStrategyValue;
  readonly durations: readonly SubscriptionQuoteDurationInterface[];
}

export interface SubscriptionQuotePriceInterface {
  readonly gatewayType: PaymentGatewayType;
  readonly currency: Currency;
  readonly originalPrice: string;
  readonly price: string;
  readonly discountPercent: number;
  readonly discountSource: CatalogDiscountSource;
}

export interface SubscriptionActionPolicyInterface {
  readonly userId: string;
  readonly channel: PurchaseChannel;
  readonly actions: {
    readonly NEW: boolean;
    readonly ADDITIONAL: boolean;
    readonly RENEW: boolean;
    readonly UPGRADE: boolean;
    readonly TRIAL: boolean;
  };
  readonly activeSubscriptionCount: number;
  readonly maxSubscriptions: number;
  readonly currentSubscriptionId: string | null;
  readonly availablePlans: readonly SubscriptionQuotePlanInterface[];
  readonly warnings: readonly SubscriptionQuoteWarningInterface[];
}

export interface SubscriptionQuoteInterface {
  readonly userId: string;
  readonly purchaseType: SubscriptionQuoteAction;
  readonly channel: PurchaseChannel;
  readonly isEligible: boolean;
  readonly selectedSubscriptionId: string | null;
  readonly selectedPlan: SubscriptionQuotePlanInterface | null;
  readonly selectedDuration: SubscriptionQuoteDurationInterface | null;
  readonly availablePlans: readonly SubscriptionQuotePlanInterface[];
  readonly price: SubscriptionQuotePriceInterface | null;
  readonly warnings: readonly SubscriptionQuoteWarningInterface[];
}
