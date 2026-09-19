/**
 * Which provider period a plan duration IS, for repeat charges the provider
 * runs (Platega's recurring SBP subscriptions).
 *
 * Platega charges `amount` every `intervalCount` × `interval`: day (up to 31),
 * week (up to 4), month (30 days, up to 12) or year (up to 3). A duration is
 * offered «для автоматического списания» only when it equals one of those
 * periods: a customer who bought 45 days must not be charged every 30.
 *
 * When two periods are equal (30 days is a month and 30 days), the larger unit
 * wins: the payer reads «ежемесячно» on the provider's form and in its emails.
 */
export type ProviderIntervalUnit = 'day' | 'week' | 'month' | 'year';

export interface ProviderPeriod {
  readonly unit: ProviderIntervalUnit;
  readonly count: number;
}

/** Platega's `paymentDetails.interval` codes. */
export const PLATEGA_INTERVAL_CODE: Readonly<Record<ProviderIntervalUnit, number>> = {
  day: 1,
  week: 2,
  month: 3,
  year: 4,
};

const PLATEGA_LIMITS: ReadonlyArray<{ readonly unit: ProviderIntervalUnit; readonly days: number; readonly max: number }> = [
  { unit: 'year', days: 365, max: 3 },
  { unit: 'month', days: 30, max: 12 },
  { unit: 'week', days: 7, max: 4 },
  { unit: 'day', days: 1, max: 31 },
];

export function plategaPeriodForDays(durationDays: number): ProviderPeriod | null {
  if (!Number.isInteger(durationDays) || durationDays <= 0) return null;
  for (const { unit, days, max } of PLATEGA_LIMITS) {
    if (durationDays % days === 0 && durationDays / days <= max) {
      return { unit, count: durationDays / days };
    }
  }
  return null;
}

/**
 * Platega takes the amount of one charge as an integer number of roubles, so a
 * price with kopecks cannot be charged as it is. Rounding would charge a price
 * the customer was never shown; such a price offers no automatic charging.
 */
export function wholeRoubles(amount: { toString(): string } | number): number | null {
  const text = typeof amount === 'number' ? String(amount) : amount.toString();
  if (!/^\d+(\.0+)?$/.test(text.trim())) return null;
  const value = Number.parseInt(text, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
