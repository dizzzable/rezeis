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

/** RollyPay's `interval` codes. */
export type RollypayInterval = 'month' | 'quarter' | 'half_year' | 'year';

/**
 * RollyPay's periods, as its fixed tariffs count them: a month of 30 days, a
 * quarter of 90, half a year of 180, a year of 365. Its `day` is left out:
 * nobody sells a VPN by the day, and a daily tariff would overrun the 100
 * charges RollyPay lists for a subscription within a few months.
 */
const ROLLYPAY_PERIODS: ReadonlyArray<{
  readonly days: number;
  readonly interval: RollypayInterval;
  readonly period: ProviderPeriod;
}> = [
  { days: 30, interval: 'month', period: { unit: 'month', count: 1 } },
  { days: 90, interval: 'quarter', period: { unit: 'month', count: 3 } },
  { days: 180, interval: 'half_year', period: { unit: 'month', count: 6 } },
  { days: 365, interval: 'year', period: { unit: 'year', count: 1 } },
];

export function rollypayPeriodForDays(durationDays: number): ProviderPeriod | null {
  return ROLLYPAY_PERIODS.find((entry) => entry.days === durationDays)?.period ?? null;
}

export function rollypayIntervalFor(period: ProviderPeriod): RollypayInterval | null {
  return (
    ROLLYPAY_PERIODS.find((entry) => entry.period.unit === period.unit && entry.period.count === period.count)
      ?.interval ?? null
  );
}

/** Antilopay's `recurrent.type` codes. */
export type AntilopayRecurrentType = 'WEEK' | 'MONTH' | 'QUARTER' | 'YEAR';

/**
 * Antilopay's periods (`recurrent.type`: WEEK, MONTH, QUARTER, YEAR — «дней
 * нет»), counted as its fixed ones are on Platega and RollyPay: a week of 7
 * days, a month of 30, a quarter of 90, a year of 365. The provider charges on
 * its own calendar, so a real month is a day or two longer than 30 days; the
 * renewal a charge delivers is stretched over that gap (`chargeCoverDays`).
 * Nothing else is offered: Antilopay has no half-year and no day.
 */
const ANTILOPAY_PERIODS: ReadonlyArray<{
  readonly days: number;
  readonly type: AntilopayRecurrentType;
  readonly period: ProviderPeriod;
}> = [
  { days: 7, type: 'WEEK', period: { unit: 'week', count: 1 } },
  { days: 30, type: 'MONTH', period: { unit: 'month', count: 1 } },
  { days: 90, type: 'QUARTER', period: { unit: 'month', count: 3 } },
  { days: 365, type: 'YEAR', period: { unit: 'year', count: 1 } },
];

export function antilopayPeriodForDays(durationDays: number): ProviderPeriod | null {
  return ANTILOPAY_PERIODS.find((entry) => entry.days === durationDays)?.period ?? null;
}

export function antilopayRecurrentTypeFor(period: ProviderPeriod): AntilopayRecurrentType | null {
  return (
    ANTILOPAY_PERIODS.find((entry) => entry.period.unit === period.unit && entry.period.count === period.count)
      ?.type ?? null
  );
}

/**
 * Antilopay's `recurrent.delay_type` codes («Период задержки перед списанием»):
 * how long an SBP subscription waits before its first charge. Upper-case on
 * the wire, exactly as the documentation spells them, like `RUB`.
 */
export type AntilopayDelayUnit = 'DAY' | 'WEEK' | 'MONTH' | 'QUARTER' | 'YEAR';

export const ANTILOPAY_DELAY_UNITS: readonly AntilopayDelayUnit[] = ['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR'];

/**
 * Days in one unit of a delay: a day is 1 and the rest are the periods above
 * (a week 7, a month 30, a quarter 90, a year 365), so a delay and a charging
 * period of the same word are the same number of days.
 */
export function antilopayDelayUnitDays(unit: AntilopayDelayUnit): number {
  if (unit === 'DAY') return 1;
  const period = ANTILOPAY_PERIODS.find((entry) => entry.type === unit);
  if (period === undefined) throw new Error(`Antilopay has no period ${unit}`);
  return period.days;
}

/**
 * AuraPay's periods (`interval` day, month or year, times `period`), for the
 * terms a VPN is sold for. A month and a year are AuraPay's calendar ones — the
 * payer reads «ежемесячно» and «ежегодно» on its form — and the day or two a
 * real month is longer than 30 days is what `chargeCoverDays` stretches a
 * renewal over. Every other term is counted in days, exactly: six calendar
 * months are up to 184 days, more than that stretch covers, so 180 days are
 * `day` × 180 and never `month` × 6.
 */
const AURAPAY_PERIODS: ReadonlyArray<{ readonly days: number; readonly period: ProviderPeriod }> = [
  { days: 7, period: { unit: 'day', count: 7 } },
  { days: 14, period: { unit: 'day', count: 14 } },
  { days: 30, period: { unit: 'month', count: 1 } },
  { days: 60, period: { unit: 'day', count: 60 } },
  { days: 90, period: { unit: 'day', count: 90 } },
  { days: 180, period: { unit: 'day', count: 180 } },
  { days: 365, period: { unit: 'year', count: 1 } },
];

export function aurapayPeriodForDays(durationDays: number): ProviderPeriod | null {
  return AURAPAY_PERIODS.find((entry) => entry.days === durationDays)?.period ?? null;
}

/** AuraPay's `interval` for a period of its own; null for one it has no word for (a week). */
export function aurapayIntervalFor(period: ProviderPeriod): 'day' | 'month' | 'year' | null {
  return period.unit === 'week' ? null : period.unit;
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
