/**
 * «Конверсия»: trial → paid, and how long customers take to pay for the first
 * time — as aggregates. The old report fetched every trial grant of the window
 * and every completed payment of those customers into memory, and counted a
 * payment made BEFORE the trial as the trial's conversion.
 *
 * "Paid" is money received (`analytics-money-received.util.ts`): a checkout
 * completed for nothing by a 100 % promo code converts nobody, and a partner's
 * balance spend is not a payment of new money.
 */
import { Prisma } from '@prisma/client';

import type {
  ConvertedPlanItem,
  DaysToPayBucket,
  DaysToPayCountInterface,
  TrialConversionReport,
} from '../interfaces/business-analytics.types';
import { moneyReceivedSql, netAmountSql } from './analytics-money-received.util';
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
 * The trial grants of the window, and each customer's first payment of money
 * received made at or after their grant.
 */
const TRIAL_FIRST_PAID = (window: AnalyticsWindowInterface): Prisma.Sql => Prisma.sql`
  "grant" AS (
    SELECT g."user_id", g."granted_at" FROM "trial_grants" g WHERE g."granted_at" >= ${window.start}
  ),
  "first_paid" AS (
    SELECT DISTINCT ON (t."user_id") t."user_id", t."created_at", g."granted_at", t."purchase_type", t."plan_snapshot"
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
    SELECT t."currency"::text AS "currency", SUM(${netAmountSql()}) AS "amount"
      FROM "transactions" t
      JOIN "trial_grants" g ON g."user_id" = t."user_id"
     WHERE g."granted_at" >= ${window.start} AND ${moneyReceivedSql()} AND t."created_at" >= g."granted_at"
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

export function assembleTrialConversion(
  window: AnalyticsWindowInterface,
  rows: {
    readonly summary: TrialSummaryRow | undefined;
    readonly plans: readonly TrialPlanRow[];
    readonly revenue: readonly CurrencySumRow[];
    readonly firstPayment: FirstPaymentRow | undefined;
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
    topConvertedPlans,
    firstPayment: {
      payers: rows.firstPayment?.payers ?? 0,
      medianDays: (rows.firstPayment?.payers ?? 0) === 0 ? null : numOrNull(rows.firstPayment?.medianDays),
      buckets: buckets(rows.firstPayment),
    },
  };
}
