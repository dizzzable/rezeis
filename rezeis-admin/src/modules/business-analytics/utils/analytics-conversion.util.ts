/**
 * «Конверсия»: trial → paid, and how long customers take to pay for the first
 * time — as aggregates. The old report fetched every trial grant of the window
 * and every completed payment of those customers into memory, and counted a
 * payment made BEFORE the trial as the trial's conversion.
 *
 * "Paid" is money received (`analytics-money-received.util.ts`): a checkout
 * completed for nothing by a 100 % promo code converts nobody, and a partner's
 * balance spend is not a payment of new money.
 *
 * A TRIAL STARTS ONLY AS A FREE ONE (the owner's rule: a paid trial is paid).
 * Buying anything with money after a free trial — a paid trial included — is
 * the conversion; a customer who bought a paid trial straight away is a new
 * paying customer and starts no trial here.
 */
import { Prisma } from '@prisma/client';

import type {
  ConvertedPlanItem,
  DaysToPayBucket,
  DaysToPayCountInterface,
  TrialConversionReport,
} from '../interfaces/business-analytics.types';
import { boughtSubscriptionSql, moneyReceivedSql, netAmountSql, paidTrialPurchaseSql } from './analytics-money-received.util';
import { chooseMoneyView, type FxSnapshot, moneyFigure } from './analytics-money.util';
import type { AnalyticsWindowInterface } from './analytics-window.util';

type SqlNumeric = Prisma.Decimal | string | number | bigint | null;
const num = (value: SqlNumeric | undefined): number => (value === null || value === undefined ? 0 : Number(value));
const numOrNull = (value: SqlNumeric | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);

export const DAYS_TO_PAY_BUCKETS: readonly DaysToPayBucket[] = ['d0', 'd1_3', 'd4_7', 'd8_14', 'd15_30', 'd31_plus'];

/**
 * Whole days elapsed between `from` and `to`, bucketed: under a day, 1–3,
 * 4–7, 8–14, 15–30, more than 30. A span, not a calendar: it does not depend
 * on any time zone.
 */
function daysToPaySql(from: Prisma.Sql, to: Prisma.Sql): Prisma.Sql {
  const days = Prisma.sql`FLOOR(EXTRACT(EPOCH FROM (${to} - ${from})) / 86400)`;
  return Prisma.sql`
    COUNT(*) FILTER (WHERE ${days} < 1)::int AS "d0",
    COUNT(*) FILTER (WHERE ${days} BETWEEN 1 AND 3)::int AS "d1_3",
    COUNT(*) FILTER (WHERE ${days} BETWEEN 4 AND 7)::int AS "d4_7",
    COUNT(*) FILTER (WHERE ${days} BETWEEN 8 AND 14)::int AS "d8_14",
    COUNT(*) FILTER (WHERE ${days} BETWEEN 15 AND 30)::int AS "d15_30",
    COUNT(*) FILTER (WHERE ${days} > 30)::int AS "d31_plus",
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY GREATEST(0, EXTRACT(EPOCH FROM (${to} - ${from})) / 86400)) AS "medianDays",
    AVG(GREATEST(0, EXTRACT(EPOCH FROM (${to} - ${from})) / 86400)) AS "avgDays"`;
}

export type DaysToPayRow = Readonly<Record<DaysToPayBucket, number>> & {
  readonly medianDays: SqlNumeric;
  readonly avgDays: SqlNumeric;
};

/**
 * THE TRIAL STARTS of the window: each customer's first FREE trial, when it
 * falls in the window — read off the trial ledger, not `trial_grants`. The
 * grant is one row per customer that every trial rewrites, a paid one
 * included: a customer who took a free trial and then bought a paid one keeps
 * only the paid trial's time there. The ledger keeps a claim per trial
 * (`trial_claims`, backfilled for the time before it), and a trial start is a
 * claim that
 *   - was not bought for money: its payment (a paid trial's claim names it)
 *     cost nothing — a 100 % promo code — whatever became of it since; a paid
 *     trial refunded later was still bought;
 *   - nor was written for a subscription that was bought for money — the
 *     backfill wrote LEGACY claims for every trial then running, paid ones too;
 *   - and did not come after the customer had already bought a paid trial for
 *     money: that customer is a paying one, their paid trial the first money.
 *     Before 0.9.6.80 the backfill's claim names neither the payment nor the
 *     subscription, and only the payment's plan tells ({@link paidTrialPurchaseSql}).
 *
 * THE LENGTH OF A TRIAL is the shortest term of the trial plan the claim names
 * (`selectGrantableTrialPlan` grants exactly that), read from the plan as it is
 * now: a claim with no plan of its own (the ledger's backfill) takes its
 * subscription's. A trial whose plan has since lost every term has no known
 * length.
 */
const TRIAL_STARTS = (window: AnalyticsWindowInterface): Prisma.Sql => Prisma.sql`
  "trial_start" AS (
    SELECT c."user_id", MIN(COALESCE(c."consumed_at", c."created_at")) AS "granted_at",
           (ARRAY_AGG(COALESCE(c."plan_id", NULLIF(cs."plan_snapshot"->>'id', '')) ORDER BY COALESCE(c."consumed_at", c."created_at"), c."id"))[1] AS "plan_id"
      FROM "trial_claims" c
      LEFT JOIN "subscriptions" cs ON cs."id" = c."subscription_id"
     WHERE c."status" = 'CONSUMED'
       AND NOT EXISTS (SELECT 1 FROM "transactions" ct WHERE ct."id" = c."transaction_id" AND ct."amount" > 0)
       AND (c."subscription_id" IS NULL OR NOT ${boughtSubscriptionSql(Prisma.sql`c."subscription_id"`)})
     GROUP BY c."user_id"
  ),
  "trial_length" AS (
    SELECT d."plan_id", MIN(d."days") AS "days" FROM "plan_durations" d WHERE d."days" > 0 GROUP BY d."plan_id"
  ),
  "grant" AS (
    SELECT s."user_id", s."granted_at", l."days" AS "trial_days"
      FROM "trial_start" s
      LEFT JOIN "trial_length" l ON l."plan_id" = s."plan_id"
     WHERE s."granted_at" >= ${window.start}
       AND NOT EXISTS (
         SELECT 1 FROM "transactions" e
          WHERE e."user_id" = s."user_id" AND e."status" = 'COMPLETED' AND e."amount" > 0
            AND ${paidTrialPurchaseSql('e')}
            AND e."created_at" <= s."granted_at"
       )
  )`;

/** The trial starts of the window, and each customer's first payment of money received made at or after it. */
const TRIAL_FIRST_PAID = (window: AnalyticsWindowInterface): Prisma.Sql => Prisma.sql`
  ${TRIAL_STARTS(window)},
  "first_paid" AS (
    SELECT DISTINCT ON (t."user_id") t."user_id", t."created_at", g."granted_at", g."trial_days", t."purchase_type", t."plan_snapshot"
      FROM "transactions" t
      JOIN "grant" g ON g."user_id" = t."user_id"
     WHERE ${moneyReceivedSql()} AND t."created_at" >= g."granted_at"
     ORDER BY t."user_id", t."created_at", t."id"
  )`;

export type TrialSummaryRow = DaysToPayRow & { readonly trialUsers: number; readonly converted: number };

export function trialSummarySql(window: AnalyticsWindowInterface): Prisma.Sql {
  return Prisma.sql`
    WITH ${TRIAL_FIRST_PAID(window)}
    SELECT (SELECT COUNT(*) FROM "grant")::int AS "trialUsers",
           COUNT(*)::int AS "converted",
           ${daysToPaySql(Prisma.sql`"granted_at"`, Prisma.sql`"created_at"`)}
      FROM "first_paid"`;
}

/** Trials starting more than this many trial-lengths ago have had time to convert: the base of «Оплатили X %». */
export const TRIAL_MATURITY_LENGTHS = 2;

/** The per-day layout is used for trials up to this many days long. */
export const TRIAL_PER_DAY_MAX_LENGTH = 14;

/** Day indexes past this are one: a conversion later than `2 × 14` days is «позже» whatever the length. */
const TRIAL_DAY_CAP = TRIAL_MATURITY_LENGTHS * TRIAL_PER_DAY_MAX_LENGTH;

export interface TrialPerDaySqlRow {
  /** `length`: the trial starts of one length (counts); `day`: the conversions of that length, by whole days from the start. */
  readonly kind: 'length' | 'day';
  /** The trial's length in days; `null` when it is not known. */
  readonly trialDays: number | null;
  /** `day`: whole days from the trial's start to the payment, capped; `length`: 0. */
  readonly day: number;
  /** `length`: trial starts; `day`: conversions. */
  readonly count: number;
  /** `length`: of those, who paid. */
  readonly converted: number;
  /** `length`: trial starts more than {@link TRIAL_MATURITY_LENGTHS} lengths ago. */
  readonly matured: number;
  /** `length`: of those, who paid. */
  readonly maturedPaid: number;
}

/**
 * The trial starts of the window by length, with who paid and how many of them
 * started long enough ago to have had the chance; and the conversions of each
 * length by whole days since the start. Two small result sets in one statement.
 */
export function trialPerDaySql(window: AnalyticsWindowInterface, now: Date): Prisma.Sql {
  const cap = Prisma.raw(String(TRIAL_DAY_CAP));
  const lengths = Prisma.raw(String(TRIAL_MATURITY_LENGTHS));
  return Prisma.sql`
    WITH ${TRIAL_FIRST_PAID(window)}
    SELECT 'length' AS "kind", g."trial_days" AS "trialDays", 0 AS "day", COUNT(*)::int AS "count",
           COUNT(f."user_id")::int AS "converted",
           COUNT(*) FILTER (WHERE g."trial_days" IS NOT NULL
                              AND g."granted_at" < ${now}::timestamptz - g."trial_days" * ${lengths} * INTERVAL '1 day')::int AS "matured",
           COUNT(f."user_id") FILTER (WHERE g."trial_days" IS NOT NULL
                              AND g."granted_at" < ${now}::timestamptz - g."trial_days" * ${lengths} * INTERVAL '1 day')::int AS "maturedPaid"
      FROM "grant" g
      LEFT JOIN "first_paid" f ON f."user_id" = g."user_id"
     GROUP BY g."trial_days"
    UNION ALL
    SELECT 'day', f."trial_days", LEAST(FLOOR(EXTRACT(EPOCH FROM (f."created_at" - f."granted_at")) / 86400), ${cap})::int,
           COUNT(*)::int, 0, 0, 0
      FROM "first_paid" f
     GROUP BY f."trial_days", 3`;
}

export interface TrialPlanRow {
  readonly kind: 'plan' | 'addon' | 'none';
  readonly planId: string | null;
  readonly name: string | null;
  readonly count: number;
}

/** The plan of each converted customer's first payment after the trial. */
export function trialPlansSql(window: AnalyticsWindowInterface): Prisma.Sql {
  return Prisma.sql`
    WITH ${TRIAL_FIRST_PAID(window)}
    SELECT "kind", "planId", (ARRAY_AGG("name" ORDER BY "created_at" DESC) FILTER (WHERE NULLIF("name", '') IS NOT NULL))[1] AS "name",
           COUNT(*)::int AS "count"
      FROM (
        SELECT CASE WHEN "purchase_type" = 'ADDITIONAL' AND "plan_snapshot"->>'snapshotSource' = 'ADDON_PURCHASE' THEN 'addon'
                    WHEN NULLIF("plan_snapshot"->>'id', '') IS NULL THEN 'none'
                    ELSE 'plan' END AS "kind",
               CASE WHEN "purchase_type" = 'ADDITIONAL' AND "plan_snapshot"->>'snapshotSource' = 'ADDON_PURCHASE' THEN NULL
                    ELSE NULLIF("plan_snapshot"->>'id', '') END AS "planId",
               "plan_snapshot"->>'name' AS "name",
               "created_at"
          FROM "first_paid"
      ) AS "first"
     GROUP BY "kind", "planId"`;
}

export interface CurrencySumRow {
  readonly currency: string;
  readonly amount: SqlNumeric;
}

/** Everything converted trial customers paid from their trial on, per currency — net of partial refunds. */
export function trialRevenueSql(window: AnalyticsWindowInterface): Prisma.Sql {
  return Prisma.sql`
    WITH ${TRIAL_STARTS(window)}
    SELECT t."currency"::text AS "currency", SUM(${netAmountSql()}) AS "amount"
      FROM "transactions" t
      JOIN "grant" g ON g."user_id" = t."user_id"
     WHERE ${moneyReceivedSql()} AND t."created_at" >= g."granted_at"
     GROUP BY 1`;
}

export type FirstPaymentRow = DaysToPayRow & { readonly payers: number };

/**
 * Registration → first payment, for every customer whose FIRST payment of
 * money ever falls in the window, after their registration. A customer who had
 * paid before the window is not a first payment, however many times they paid
 * in it — and neither is one whose earliest money predates their
 * registration: an importer stamps `created_at` with the import, while the
 * donor's payments keep their own dates.
 */
export function firstPaymentSql(window: AnalyticsWindowInterface): Prisma.Sql {
  return Prisma.sql`
    WITH "first" AS (
      SELECT t."user_id", MIN(t."created_at") AS "paid_at", MIN(u."created_at") AS "registered_at"
        FROM "transactions" t
        JOIN "users" u ON u."id" = t."user_id"
       WHERE ${moneyReceivedSql()} AND t."created_at" >= ${window.start}
         AND NOT EXISTS (
           SELECT 1 FROM "transactions" e
            WHERE e."user_id" = t."user_id" AND ${moneyReceivedSql('e')} AND e."created_at" < ${window.start}
         )
       GROUP BY t."user_id"
      HAVING MIN(t."created_at") >= MIN(u."created_at")
    )
    SELECT COUNT(*)::int AS "payers",
           ${daysToPaySql(Prisma.sql`"registered_at"`, Prisma.sql`"paid_at"`)}
      FROM "first"`;
}

function buckets(row: DaysToPayRow | undefined): DaysToPayCountInterface[] {
  return DAYS_TO_PAY_BUCKETS.map((key) => ({ key, users: row?.[key] ?? 0 }));
}

/**
 * The trial's own days: when every trial start of the window has the same known
 * length, and it is up to {@link TRIAL_PER_DAY_MAX_LENGTH} days, each day of the
 * trial is a bar, then «L+1…2L дней», then «позже». Otherwise — a longer trial,
 * several lengths, or one not known — the report keeps its fixed bins and says
 * only the length it knows. `matured` is the share who paid among the trials
 * that started more than two lengths ago.
 */
function assemblePerDay(rows: readonly TrialPerDaySqlRow[]): Pick<TrialConversionReport, 'trialLengthDays' | 'perDay' | 'maturedConversion'> {
  const lengths = rows.filter((row) => row.kind === 'length');
  const known = lengths.filter((row) => row.trialDays !== null);
  const single = lengths.length === 1 && known.length === 1 ? known[0] : undefined;
  const length = single?.trialDays === null || single?.trialDays === undefined ? null : Number(single.trialDays);
  if (single === undefined || length === null) {
    return { trialLengthDays: null, perDay: null, maturedConversion: null };
  }
  const maturedTrials = num(single.matured);
  const maturedConversion = {
    trials: maturedTrials,
    paid: num(single.maturedPaid),
    share: maturedTrials === 0 ? null : num(single.maturedPaid) / maturedTrials,
  };
  if (length > TRIAL_PER_DAY_MAX_LENGTH) return { trialLengthDays: length, perDay: null, maturedConversion };
  const days = Array.from({ length }, () => 0);
  let after = 0;
  let later = 0;
  for (const row of rows) {
    if (row.kind !== 'day') continue;
    const day = Number(row.day);
    if (day < length) days[day] = (days[day] ?? 0) + num(row.count);
    else if (day < length * 2) after += num(row.count);
    else later += num(row.count);
  }
  return { trialLengthDays: length, perDay: { trialDays: length, days, after, later }, maturedConversion };
}

export function assembleTrialConversion(
  window: AnalyticsWindowInterface,
  rows: {
    readonly summary: TrialSummaryRow | undefined;
    readonly plans: readonly TrialPlanRow[];
    readonly revenue: readonly CurrencySumRow[];
    readonly firstPayment: FirstPaymentRow | undefined;
    readonly perDay?: readonly TrialPerDaySqlRow[];
  },
  fx: FxSnapshot,
): TrialConversionReport {
  const trialUsers = rows.summary?.trialUsers ?? 0;
  const converted = rows.summary?.converted ?? 0;
  const sums = new Map<string, number>();
  for (const row of rows.revenue) sums.set(row.currency, (sums.get(row.currency) ?? 0) + num(row.amount));
  const view = chooseMoneyView(
    [...sums.entries()].filter(([, amount]) => amount !== 0).map(([currency]) => currency),
    fx,
  );
  const revenue = moneyFigure(view, sums);
  const avg = numOrNull(rows.summary?.avgDays);

  const topConvertedPlans: ConvertedPlanItem[] = rows.plans
    .map((row) => ({
      plan: row.name ?? '',
      planId: row.planId,
      kind: row.kind,
      count: row.count,
      percentage: converted === 0 ? 0 : row.count / converted,
    }))
    .sort((a, b) => b.count - a.count || a.plan.localeCompare(b.plan))
    .slice(0, 10);

  return {
    windowDays: window.days,
    timeZone: window.zone.name,
    timeZoneFallback: window.zone.fallback,
    totalTrialUsers: trialUsers,
    convertedUsers: converted,
    conversionRate: trialUsers === 0 ? 0 : converted / trialUsers,
    avgDaysToConvert: avg === null ? 0 : Math.round(avg * 10) / 10,
    medianDaysToConvert: converted === 0 ? null : numOrNull(rows.summary?.medianDays),
    revenueFromConverted: revenue.value,
    revenueFromConvertedByCurrency: revenue.byCurrency,
    money: view,
    daysToConvert: buckets(rows.summary),
    ...assemblePerDay(rows.perDay ?? []),
    topConvertedPlans,
    firstPayment: {
      payers: rows.firstPayment?.payers ?? 0,
      medianDays: (rows.firstPayment?.payers ?? 0) === 0 ? null : numOrNull(rows.firstPayment?.medianDays),
      buckets: buckets(rows.firstPayment),
    },
  };
}
