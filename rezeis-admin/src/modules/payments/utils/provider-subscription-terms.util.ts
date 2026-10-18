import { BadRequestException } from '@nestjs/common';
import { PaymentGatewayType, Prisma } from '@prisma/client';

import type { CatalogDiscountSource } from '../../plans/interfaces/plan-catalog.interface';
import {
  type AntilopayAutopayMethod,
  type AntilopayDelay,
  isAntilopayAutopayMethod,
  makeAntilopayDelay,
} from './antilopay-recurrent.util';
import { AURAPAY_SUBSCRIPTION_MAX_AMOUNT } from './aurapay-subscription.util';
import {
  antilopayPeriodForDays,
  aurapayPeriodForDays,
  plategaPeriodForDays,
  type ProviderIntervalUnit,
  type ProviderPeriod,
  rollypayPeriodForDays,
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
  PaymentGatewayType.ROLLYPAY,
  PaymentGatewayType.ANTILOPAY,
  PaymentGatewayType.AURAPAY,
]);

function providerPeriodForDays(gatewayType: PaymentGatewayType, durationDays: number): ProviderPeriod | null {
  switch (gatewayType) {
    case PaymentGatewayType.PLATEGA:
      return plategaPeriodForDays(durationDays);
    case PaymentGatewayType.ROLLYPAY:
      return rollypayPeriodForDays(durationDays);
    case PaymentGatewayType.ANTILOPAY:
      return antilopayPeriodForDays(durationDays);
    case PaymentGatewayType.AURAPAY:
      return aurapayPeriodForDays(durationDays);
    default:
      return null;
  }
}

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
  /**
   * Antilopay only: how the payer signs up, CARD or SBP. Chosen before the
   * payment form opens, because the two are different categories of recurrent
   * payment (`antilopay-recurrent.util.ts`). Absent for every other gateway.
   */
  readonly method?: AntilopayAutopayMethod;
  /**
   * Antilopay SBP only: «Отсрочка первого списания по СБП». Nothing is charged
   * at activation: the first charge comes after `delay.days`. Present only when
   * the cabinet showed it and the panel decided on it
   * (`antilopay-delay-policy.util.ts`); absent, the first charge is made at
   * activation. A draft made before 18.10.2026 gave the plan for the delay at
   * once (`antilopay-delay-grant.util.ts`); one marked
   * {@link ProviderSubscriptionTerms.deliversOnCharge} gives nothing until the
   * first charge.
   */
  readonly delay?: AntilopayDelay;
  /**
   * Antilopay SBP only, on every draft made since 18.10.2026: the checkout is
   * delivered by the first CHARGE of the subscription, never by its start.
   *
   * The start of an SBP subscription is the payer confirming it in their bank,
   * and Antilopay calls that payment of OUR order paid — but no money moves with
   * it («Нельзя сделать возврат у начала подписки, отмените подписку или
   * сделайте возврат платежа, созданного по подписке»): the money is in a
   * separate payment the subscription makes, at activation or after the delay.
   * A draft without the mark was delivered by the start, so a payer whose
   * first charge failed kept a full term nobody paid for; it keeps the rules it
   * was made with (`assignAntilopayChargeRoles`).
   */
  readonly deliversOnCharge?: true;
}

/**
 * Every reason `AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE` is refused with. The reason
 * reaches the cabinet (`CODES_CARRYING_REASON` in the panel's exception filter,
 * which restates this list and whose spec checks it against this one).
 */
export const PROVIDER_SUBSCRIPTION_REFUSALS = [
  'NOT_APPROVED',
  'GATEWAY',
  'PURCHASE_TYPE',
  'TRIAL',
  'CURRENCY',
  'DISCOUNT',
  'DURATION',
  'AMOUNT',
  'ITEMS',
  // This VPN subscription already renews itself: a second one would charge twice a period.
  'ALREADY_ACTIVE',
  // Another sign-up converting the same trial still waits to be confirmed (see `assertNoLiveSubscriptionFor`).
  'PENDING_SIGN_UP',
  // RollyPay: none of the operator's tariffs charges this sum every this period.
  'PLAN',
  // A renewal onto a plan the subscription is not on (see `renewsOntoAnotherPlan`).
  'PLAN_CHANGE',
  // Antilopay: the sign-up names neither CARD nor SBP.
  'METHOD',
  // Antilopay SBP: the delay the payer was shown is not the one the panel gives now.
  'DELAY_CHANGED',
] as const;

export type ProviderSubscriptionRefusal = (typeof PROVIDER_SUBSCRIPTION_REFUSALS)[number];

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
 * and rounding would charge a sum nobody was shown; RollyPay is held to the
 * same rule so the cabinet can tell from the price alone); and a term that is
 * not one of the provider's periods would be charged on a schedule nobody bought.
 */
export function resolveProviderSubscriptionTerms(input: {
  readonly gatewayType: PaymentGatewayType;
  readonly currency: string;
  readonly amount: Prisma.Decimal | string | number;
  readonly durationDays: number;
  readonly discountSource: CatalogDiscountSource;
  readonly planId: string;
  readonly subscriptionId: string | null;
  /** The payer's choice where a gateway offers two (Antilopay: CARD or SBP). */
  readonly method?: unknown;
  /** Antilopay SBP: the delay the sign-up is made with (`settleDelayWithConsent`); none for a card. */
  readonly delay?: AntilopayDelay | null;
}): ProviderSubscriptionTermsResult {
  if (!PROVIDER_SUBSCRIPTION_GATEWAY_TYPES.has(input.gatewayType)) return { refusal: 'GATEWAY' };
  if (input.currency !== 'RUB') return { refusal: 'CURRENCY' };
  if (input.discountSource === 'PURCHASE') return { refusal: 'DISCOUNT' };
  const period = providerPeriodForDays(input.gatewayType, input.durationDays);
  if (period === null) return { refusal: 'DURATION' };
  const amount = wholeRoubles(input.amount);
  if (amount === null) return { refusal: 'AMOUNT' };
  // «Сумма от 1 до 50 000 ₽»: AuraPay takes no larger regular charge.
  if (input.gatewayType === PaymentGatewayType.AURAPAY && amount > AURAPAY_SUBSCRIPTION_MAX_AMOUNT) {
    return { refusal: 'AMOUNT' };
  }
  // Antilopay repeats a charge either on a card or over SBP, and the payer
  // must have said which before the payment form opened.
  const method = input.gatewayType === PaymentGatewayType.ANTILOPAY ? input.method : undefined;
  if (input.gatewayType === PaymentGatewayType.ANTILOPAY && !isAntilopayAutopayMethod(method)) {
    return { refusal: 'METHOD' };
  }
  return {
    terms: {
      unit: period.unit,
      count: period.count,
      amount,
      durationDays: input.durationDays,
      planId: input.planId,
      subscriptionId: input.subscriptionId,
      ...(isAntilopayAutopayMethod(method) ? { method } : {}),
      // A delay belongs to SBP alone: a card's first payment is charged on the form.
      ...(method === 'SBP' && input.delay !== undefined && input.delay !== null ? { delay: input.delay } : {}),
      // An SBP subscription's start is not a payment: its first charge is.
      ...(method === 'SBP' ? { deliversOnCharge: true as const } : {}),
    },
  };
}

/**
 * Whether a payment is the checkout of an Antilopay SBP sign-up delivered by
 * the subscription's first charge ({@link ProviderSubscriptionTerms.deliversOnCharge}):
 * nothing that says only that the sign-up's own order is paid may fulfil it.
 */
export function isChargeDeliveredCheckout(transaction: {
  readonly gatewayType: PaymentGatewayType;
  readonly planSnapshot: unknown;
}): boolean {
  return (
    transaction.gatewayType === PaymentGatewayType.ANTILOPAY &&
    readProviderSubscriptionTerms(transaction.planSnapshot)?.deliversOnCharge === true
  );
}

/**
 * Whether a renewal is onto a plan other than the one its subscription is on:
 * an archived plan's replacement, or a plan chosen at renewal.
 *
 * Such a renewal is not refused a provider subscription for its price, which
 * is the new plan's own, but because of what the sweep reads. It compares the
 * plan of each charge with the plan in the subscription's snapshot, and that
 * snapshot keeps the OLD plan until the new plan's term begins: at fulfilment
 * without durable terms, at the end of the current term with them. The sign-up
 * was cancelled as "moved to another plan" in between, nobody told. So it is
 * refused upfront, where the refusal reaches the buyer; once the subscription
 * is on the new plan, its next renewal may be one.
 *
 * A snapshot that names no plan (an imported subscription) is not a change:
 * the sweep has nothing to compare it with either.
 */
export function renewsOntoAnotherPlan(currentPlanSnapshot: unknown, planId: string): boolean {
  if (typeof currentPlanSnapshot !== 'object' || currentPlanSnapshot === null || Array.isArray(currentPlanSnapshot)) {
    return false;
  }
  const current = (currentPlanSnapshot as Record<string, unknown>)['id'];
  return typeof current === 'string' && current.length > 0 && current !== planId;
}

export function autopayNotAvailable(refusal: ProviderSubscriptionRefusal): BadRequestException {
  return new BadRequestException({
    code: AUTOPAY_NOT_AVAILABLE_CODE,
    message: 'Automatic charging is not available for this purchase.',
    reason: refusal,
  });
}

/**
 * The refusal of a gateway that would not create the repeat charge (Antilopay's
 * errors 29 and 30). To the buyer it is the same code and reason as an approval
 * switched off — the cabinet offers the ordinary payment — and `cause` is a
 * bounded code that is also what the failed checkout keeps as its
 * `failureReason`: an operator who opens the payment reads WHY, where a bare
 * refusal read `PAYMENT_PROVIDER_ERROR`.
 */
export function autopayRefusedByGateway(cause: string): BadRequestException {
  return new BadRequestException({
    code: AUTOPAY_NOT_AVAILABLE_CODE,
    message: cause,
    reason: 'NOT_APPROVED' satisfies ProviderSubscriptionRefusal,
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
  const method = terms['method'];
  const delay = readTermsDelay(terms['delay']);
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
  return {
    unit,
    count,
    amount,
    durationDays,
    planId,
    subscriptionId,
    ...(isAntilopayAutopayMethod(method) ? { method } : {}),
    ...(method === 'SBP' && delay !== null ? { delay } : {}),
    ...(method === 'SBP' && terms['deliversOnCharge'] === true ? { deliversOnCharge: true as const } : {}),
  };
}

/** The delay a draft's terms hold: a count and one of Antilopay's own words, worth the days written beside them. */
function readTermsDelay(raw: unknown): AntilopayDelay | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const delay = makeAntilopayDelay(record['count'], record['unit']);
  return delay !== null && record['days'] === delay.days ? delay : null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
