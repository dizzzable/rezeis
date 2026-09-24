import { Currency, PaymentGatewayType, PlanAvailability, PurchaseChannel } from '@prisma/client';

import { CatalogDiscountSource } from '../../plans/interfaces/plan-catalog.interface';
import { TrafficLimitStrategyValue } from '../../plans/dto/traffic-limit-strategy.dto';
import { TrialSettings } from '../../plans/utils/trial-settings.util';
import { SubscriptionQuoteAction } from '../dto/subscription-quote.dto';

export type SubscriptionQuoteWarningCode =
  | 'SOURCE_SUBSCRIPTION_REQUIRED'
  | 'SOURCE_PLAN_MISSING'
  | 'ARCHIVED_PLAN_REPLACEMENT'
  | 'UPGRADE_RESETS_EXPIRY'
  | 'TRIAL_UPGRADE_REQUIRED'
  | 'TRIAL_ALREADY_USED'
  | 'TRIAL_NOT_RENEWABLE'
  | 'TRIAL_PLAN_NOT_RENEWAL_TARGET'
  | 'SUBSCRIPTION_DISABLED_NOT_RENEWABLE'
  /** @deprecated Kept for compatibility with older Reiwa clients. */
  | 'TRIAL_FREE_NOT_RENEWABLE'
  | 'TRIAL_INVITED_ONLY'
  | 'TRIAL_REQUIRES_TELEGRAM'
  | 'SUBSCRIPTION_LIMIT_REACHED'
  | 'PLAN_SELECTION_REQUIRED'
  | 'DURATION_SELECTION_REQUIRED'
  | 'PLAN_NOT_AVAILABLE'
  | 'DURATION_NOT_AVAILABLE'
  | 'DURATION_INVALID'
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
  readonly availability: PlanAvailability;
  readonly description: string | null;
  readonly tag: string | null;
  readonly type: string;
  /**
   * Plan icon identifier — carried through the quote so the renewal draft can
   * freeze it into the subscription snapshot. `null` → the cabinet card falls
   * back to a status glyph.
   */
  readonly icon: string | null;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly trafficLimitStrategy: TrafficLimitStrategyValue;
  readonly internalSquads: readonly string[];
  readonly externalSquad: string | null;
  /** Frozen for paid-trial reservation; ignored for non-trial plans. */
  readonly trialSettings: TrialSettings;
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

/**
 * What an UPGRADE keeps ABOVE the new plan: the part of the subscription's
 * limits that sat above its old plan — a paid add-on, an operator's raise, a
 * bonus. Informational: it describes the purchase, it never decides it.
 */
export interface SubscriptionQuoteCarriedLimitsInterface {
  /** Devices kept above the new plan's device limit. */
  readonly deviceLimit: number;
  /** Gigabytes kept above the new plan's traffic limit. */
  readonly trafficLimitGb: number;
  /** Unlimited devices stay on a finite new plan (an operator's setting). */
  readonly unlimitedDevices: boolean;
  /** Unlimited traffic stays on a finite new plan (an operator's setting). */
  readonly unlimitedTraffic: boolean;
}

/**
 * A live add-on bought through the durable ledger, as an UPGRADE keeps it: its
 * own end date, never later than the subscription's new end (owner,
 * 24.09.2026). Informational, like `carriedAbovePlan`.
 */
export interface SubscriptionQuoteActiveAddOnInterface {
  readonly type: 'EXTRA_TRAFFIC' | 'EXTRA_DEVICES';
  /** Gigabytes for traffic, devices for devices. */
  readonly value: number;
  /**
   * When it ends after the upgrade (ISO): its own date, clamped to the new end
   * as the quote estimates it (the paid remainder included). `null` — it ends
   * with a subscription that has no end.
   */
  readonly expiresAt: string | null;
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
  /**
   * UPGRADE with a plan chosen only; `null` everywhere else and whenever
   * nothing carries. Beside `warnings`, not one of them: it can never count
   * towards `isEligible`, and a client that predates it never reads it.
   *
   * What sits above the OLD PLAN — an operator's raise, a bonus, an add-on
   * bought before the durable model (grandfathered) — and never a live durable
   * add-on: those are listed in `activeAddOns`, with their own end dates, so
   * nothing is told twice.
   */
  readonly carriedAbovePlan: SubscriptionQuoteCarriedLimitsInterface | null;
  /**
   * UPGRADE with a plan chosen only: the live durable add-ons the upgrade
   * keeps, each with the end it will have (see
   * {@link SubscriptionQuoteActiveAddOnInterface}). `null` everywhere else,
   * when there are none, and when they could not be read; one the new plan
   * makes meaningless (unlimited on that resource) is left out. Informational:
   * it never reaches `isEligible`.
   */
  readonly activeAddOns: readonly SubscriptionQuoteActiveAddOnInterface[] | null;
  /**
   * UPGRADE with a plan chosen only: the whole days the old plan's paid
   * remainder would add to the new term if paid NOW
   * (`paid-remainder-conversion.util.ts`). An estimate — fulfilment counts it
   * again at payment, when a little less may be left. `null` everywhere else,
   * and when it could not be worked out; `0` when nothing converts.
   * Informational like `carriedAbovePlan`: it never reaches `isEligible`.
   */
  readonly paidRemainderDays: number | null;
}
