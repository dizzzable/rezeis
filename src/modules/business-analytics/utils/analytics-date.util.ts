/**
 * Date helpers used by the analytics service. Plain, no-DI utilities —
 * factored out so the service file is dominated by aggregation logic
 * instead of calendar arithmetic.
 *
 * All functions operate on local-time `Date` instances (not UTC), which
 * matches the existing service behaviour. Switching to UTC would shift
 * cohort boundaries for users in non-zero timezones; keep that in mind
 * before changing any of the helpers below.
 */

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 365;

export const ANALYTICS_DEFAULT_WINDOW_DAYS = DEFAULT_WINDOW_DAYS;
export const ANALYTICS_MAX_WINDOW_DAYS = MAX_WINDOW_DAYS;
export const ANALYTICS_ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Number of months to span the cohort matrix. 12 keeps the table compact
 * while still surfacing yearly retention trends.
 */
export const ANALYTICS_COHORT_MONTHS = 12;

/** Bucket boundaries (USD-equivalent) for the LTV histogram. */
export const ANALYTICS_LTV_BUCKETS: readonly number[] = [
  0, 10, 50, 100, 250, 500, 1_000, 2_500, 5_000,
];

export const ANALYTICS_DEFAULT_TOP_PAYERS_LIMIT = 20;

export function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

export function startOfWeek(d: Date): Date {
  const r = startOfDay(d);
  const offset = (r.getDay() + 6) % 7;
  r.setDate(r.getDate() - offset);
  return r;
}

export function startOfMonth(d: Date): Date {
  const r = new Date(d);
  r.setDate(1);
  r.setHours(0, 0, 0, 0);
  return r;
}

export function addMonths(date: Date, months: number): Date {
  const r = new Date(date);
  r.setMonth(r.getMonth() + months);
  return r;
}

export function monthsBetween(start: Date, end: Date): number {
  return (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
}

export function formatYearMonth(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function findCohortKeyByUser(
  cohorts: Map<string, Set<string>>,
  userId: string,
): string | null {
  for (const [key, set] of cohorts.entries()) {
    if (set.has(userId)) return key;
  }
  return null;
}

export function clampWindow(days: number): number {
  if (!Number.isFinite(days) || days <= 0) return DEFAULT_WINDOW_DAYS;
  return Math.min(Math.floor(days), MAX_WINDOW_DAYS);
}
