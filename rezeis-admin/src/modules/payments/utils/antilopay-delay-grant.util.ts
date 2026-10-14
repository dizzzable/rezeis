import { PaymentGatewayType, Prisma, type Transaction } from '@prisma/client';

import { readProviderSubscriptionTerms } from './provider-subscription-terms.util';

/**
 * The access a delayed Antilopay SBP subscription grants while its first charge
 * waits («Отсрочка первого списания по СБП»).
 *
 * Nothing is charged at activation, so the sign-up's own checkout — the payment
 * that would have been the first charge — is REWRITTEN into the grant, once, at
 * the moment the panel sees the subscription active: its sum becomes 0 and its
 * term the days of the delay, and it is then settled and fulfilled by the
 * ordinary pipeline, which creates (or renews, or converts the trial of) the
 * subscription exactly as a paid checkout would. The mark below is what tells it
 * apart afterwards, for the operator, for the admin autopay list, and for every
 * sweep that must not treat a free grant as money: it is written in the same
 * database transaction as the rewrite and as `provider_subscriptions.delay_granted_at`,
 * so the three are one fact.
 */
export const DELAY_GRANT_KEY = 'delayGrant';

export interface DelayGrantMark {
  /** The provider subscription (Antilopay's initiating payment id) the grant belongs to. */
  readonly providerSubscriptionId: string;
  /** The days the payer was promised (`provider_subscriptions.delay_days`). */
  readonly delayDays: number;
  /**
   * The days actually granted: the delay, stretched when it would end before the
   * provider's first charge plus a day's grace (`chargeCoverDays`), so access
   * runs without a gap into the first paid term.
   */
  readonly days: number;
  /** The sum the checkout was made for, before it became free: the sum of every charge. */
  readonly originalAmount: string;
  readonly at: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The mark on a transaction's `gatewayData`, or null for every payment that is not a delay grant. */
export function readDelayGrant(gatewayData: unknown): DelayGrantMark | null {
  const mark = asRecord(asRecord(gatewayData)?.[DELAY_GRANT_KEY]);
  if (mark === null) return null;
  const { providerSubscriptionId, delayDays, days, originalAmount, at } = mark;
  if (
    typeof providerSubscriptionId !== 'string' ||
    typeof delayDays !== 'number' ||
    typeof days !== 'number' ||
    typeof originalAmount !== 'string' ||
    typeof at !== 'string'
  ) {
    return null;
  }
  return { providerSubscriptionId, delayDays, days, originalAmount, at };
}

export function isDelayGrant(gatewayData: unknown): boolean {
  return readDelayGrant(gatewayData) !== null;
}

/**
 * Whether a payment is the checkout of an Antilopay SBP sign-up made with a
 * delay: the payment that is rewritten into the grant, and must never be
 * fulfilled as a paid term. Read off the terms the draft was made with.
 */
export function isDelayedCheckout(transaction: Pick<Transaction, 'gatewayType' | 'planSnapshot'>): boolean {
  return (
    transaction.gatewayType === PaymentGatewayType.ANTILOPAY &&
    readProviderSubscriptionTerms(transaction.planSnapshot)?.delay !== undefined
  );
}

/**
 * What the operator's «Платёж получен» card carries for a payment that is the
 * plan granted for a delay: the flag a rule or an integration can bind to, the
 * days, and the note that says no money was taken and the charge comes later.
 * Nothing for every other payment.
 */
export function delayGrantMetadata(gatewayData: unknown): Record<string, unknown> {
  const mark = readDelayGrant(gatewayData);
  if (mark === null) return {};
  return {
    delayGrant: true,
    delayGrantDays: mark.days,
    note:
      `Бесплатный доступ на ${mark.days} дн. на время отсрочки первого списания по СБП (Antilopay): ` +
      `денег не списано. Первое списание на ${mark.originalAmount} ₽ придёт позже отдельным платежом (Antilopay работает в рублях).`,
  };
}

/**
 * What a checkout's `planSnapshot` and line items say once they are the grant:
 * the term is `days` and the sum is 0. A payment for a single subscription keeps
 * its term in `selectedDurationDays`; a combined renewal keeps it in each line
 * item, whose plan snapshot is checked against the item when the renewal is
 * fulfilled (`parsePaidRenewalPlanSnapshot`: the days and the sum must agree),
 * so the snapshot is rewritten with the item.
 */
export function rewritePlanSnapshotForGrant(snapshot: unknown, days: number): Prisma.InputJsonObject {
  return { ...(asRecord(snapshot) ?? {}), selectedDurationDays: days } as Prisma.InputJsonObject;
}

export function rewriteItemSnapshotForGrant(snapshot: unknown, days: number): Prisma.InputJsonObject {
  const held = asRecord(snapshot) ?? {};
  return {
    ...held,
    selectedDurationDays: days,
    // Only where the line records a sum: a snapshot that never did keeps not doing it.
    ...('amount' in held ? { amount: '0' } : {}),
  } as Prisma.InputJsonObject;
}
