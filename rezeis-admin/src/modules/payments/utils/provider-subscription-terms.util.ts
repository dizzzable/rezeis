import { BadRequestException } from '@nestjs/common';
import { PaymentGatewayType, Prisma } from '@prisma/client';

import type { CatalogDiscountSource } from '../../plans/interfaces/plan-catalog.interface';
import {
  plategaPeriodForDays,
  type ProviderIntervalUnit,
  wholeRoubles,
} from './provider-subscription-period.util';

/**
 * Gateways whose «для автоматического списания» option is a subscription the
 * PROVIDER runs: the sum and the period are fixed when the payer confirms it,
 * and the provider charges on its own schedule. ЮKassa is not here: there the
 * panel charges a saved method itself (`AUTOPAY_GATEWAY_TYPES`).
 */
export const PROVIDER_SUBSCRIPTION_GATEWAY_TYPES: ReadonlySet<PaymentGatewayType> = new Set([
  PaymentGatewayType.PLATEGA,
]);

/** Written into the draft's `planSnapshot`; its presence is what makes a draft a provider subscription. */
export const PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY = 'providerSubscription';

/** Recorded on each `ProviderSubscription` row; bump when what the payer agrees to changes. */
export const PROVIDER_SUBSCRIPTION_CONSENT_VERSION = 'provider-subscription-v1';

/** The code a refusal carries to the cabinet (allowlisted in `AdminSafeExceptionFilter`). */
export const AUTOPAY_NOT_AVAILABLE_CODE = 'AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE';

export interface ProviderSubscriptionTerms {
  readonly unit: ProviderIntervalUnit;
  readonly count: number;
  /** One charge, in whole roubles. */
  readonly amount: number;
  readonly durationDays: number;
  readonly planId: string;
  /** The subscription each charge renews; null for a new purchase until its first charge creates one. */
  readonly subscriptionId: string | null;
}

export type ProviderSubscriptionRefusal =
  | 'NOT_APPROVED'
  | 'GATEWAY'
  | 'PURCHASE_TYPE'
  | 'TRIAL'
  | 'CURRENCY'
  | 'DISCOUNT'
  | 'DURATION'
  | 'AMOUNT'
  | 'ITEMS'
  | 'ADD_ONS';

export type ProviderSubscriptionTermsResult =
  | { readonly terms: ProviderSubscriptionTerms }
  | { readonly refusal: ProviderSubscriptionRefusal };

/**
 * Whether this purchase can become a provider subscription, and on what terms.
 *
 * Every refusal is about what the provider would charge LATER: it repeats the
 * first charge's sum every period, forever. So a one-time promo discount would
 * be charged again every month (a personal discount is permanent and may be);
 * a price with kopecks cannot be charged at all (Platega takes whole roubles,
 * and rounding would charge a sum nobody was shown); and a term that is not one
 * of the provider's periods would be charged on a schedule nobody bought.
 */
export function resolveProviderSubscriptionTerms(input: {
  readonly gatewayType: PaymentGatewayType;
  readonly currency: string;
  readonly amount: Prisma.Decimal | string | number;
  readonly durationDays: number;
  readonly discountSource: CatalogDiscountSource;
  readonly planId: string;
  readonly subscriptionId: string | null;
}): ProviderSubscriptionTermsResult {
  if (input.gatewayType !== PaymentGatewayType.PLATEGA) return { refusal: 'GATEWAY' };
  if (input.currency !== 'RUB') return { refusal: 'CURRENCY' };
  if (input.discountSource === 'PURCHASE') return { refusal: 'DISCOUNT' };
  const period = plategaPeriodForDays(input.durationDays);
  if (period === null) return { refusal: 'DURATION' };
  const amount = wholeRoubles(input.amount);
  if (amount === null) return { refusal: 'AMOUNT' };
  return {
    terms: {
      unit: period.unit,
      count: period.count,
      amount,
      durationDays: input.durationDays,
      planId: input.planId,
      subscriptionId: input.subscriptionId,
    },
  };
}

export function autopayNotAvailable(refusal: ProviderSubscriptionRefusal): BadRequestException {
  return new BadRequestException({
    code: AUTOPAY_NOT_AVAILABLE_CODE,
    message: 'Automatic charging is not available for this purchase.',
    reason: refusal,
  });
}

/** The terms a draft was created with, or null for an ordinary one-off payment. */
export function readProviderSubscriptionTerms(planSnapshot: unknown): ProviderSubscriptionTerms | null {
  if (typeof planSnapshot !== 'object' || planSnapshot === null || Array.isArray(planSnapshot)) {
    return null;
  }
  const raw = (planSnapshot as Record<string, unknown>)[PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const terms = raw as Record<string, unknown>;
  const unit = terms['unit'];
  const count = terms['count'];
  const amount = terms['amount'];
  const durationDays = terms['durationDays'];
  const planId = terms['planId'];
  const subscriptionId = terms['subscriptionId'];
  if (
    (unit !== 'day' && unit !== 'week' && unit !== 'month' && unit !== 'year') ||
    !isPositiveInteger(count) ||
    !isPositiveInteger(amount) ||
    !isPositiveInteger(durationDays) ||
    typeof planId !== 'string' ||
    planId.length === 0 ||
    !(subscriptionId === null || (typeof subscriptionId === 'string' && subscriptionId.length > 0))
  ) {
    return null;
  }
  return { unit, count, amount, durationDays, planId, subscriptionId };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
