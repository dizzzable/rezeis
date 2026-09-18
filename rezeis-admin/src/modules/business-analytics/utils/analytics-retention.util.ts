/**
 * «Удержание»: the cohort matrix, the subscriptions that end in the coming
 * month, and what the subscriptions in force are on — as aggregates, in the
 * operator's time zone (`analytics-zone.util.ts`).
 *
 * The cohort matrix used to load every customer of the last twelve months and
 * every payment they made into memory and match them up in a loop; the plan
 * breakdown loaded every live subscription to read one JSON field.
 */
import { Prisma } from '@prisma/client';

import type {
  CohortRowInterface,
  ExpiringReportInterface,
  SubscriptionByPlanItem,
} from '../interfaces/business-analytics.types';
import { ANALYTICS_COHORT_MONTHS } from './analytics-date.util';
import { moneyReceivedSql } from './analytics-money-received.util';
import { localDateSql, localTimestampSql } from './analytics-window.util';
import { addDays, type AnalyticsZone, dateKeyOf, monthStartKey, startOfZonedDay } from './analytics-zone.util';

/** The first instant of the local month `monthsBack` months before the one `now` is in. */
export function zonedMonthStart(now: Date, zone: AnalyticsZone, monthsBack: number): Date {
  return startOfZonedDay(monthStartKey(dateKeyOf(now, zone.name), -monthsBack), zone.name);
}

export interface CohortRow {
  /** `size`: the cohort's members; `paid`: of them, who paid in the month `offset` months after signing up. */
  readonly kind: 'size' | 'paid';
  readonly cohort: string;
  readonly offset: number;
  readonly users: number;
}

/**
 * Per local signup month of the last twelve: the cohort's size, and how many
 * of it received money in each later month.
 *
 * A cohort is its members — the customers who registered that month
 * (`created_at`) — and nothing else sizes it. A payment counts from the
 * registration on: an importer stamps `created_at` with the import while the
 * donor's payments keep their own, earlier dates, and such a payment used to
 * land at a negative month and overwrite the cohort's size with its count.
 */
export function cohortSql(earliest: Date, zone: AnalyticsZone): Prisma.Sql {
  const month = (column: Prisma.Sql): Prisma.Sql => Prisma.sql`DATE_TRUNC('month', ${localTimestampSql(column, zone)})`;
  return Prisma.sql`
    WITH "member" AS (
      SELECT u."id", u."created_at", ${month(Prisma.sql`u."created_at"`)} AS "month"
        FROM "users" u
       WHERE u."created_at" >= ${earliest}
    ),
    "paid_month" AS (
      SELECT DISTINCT t."user_id", ${month(Prisma.sql`t."created_at"`)} AS "month"
        FROM "transactions" t
        JOIN "member" m ON m."id" = t."user_id"
       WHERE ${moneyReceivedSql()} AND t."created_at" >= m."created_at"
    )
    SELECT 'size' AS "kind", TO_CHAR(m."month", 'YYYY-MM') AS "cohort", 0 AS "offset", COUNT(*)::int AS "users"
      FROM "member" m
     GROUP BY m."month"
    UNION ALL
    SELECT 'paid', TO_CHAR(m."month", 'YYYY-MM'),
           ((EXTRACT(YEAR FROM p."month") - EXTRACT(YEAR FROM m."month")) * 12
             + EXTRACT(MONTH FROM p."month") - EXTRACT(MONTH FROM m."month"))::int,
           COUNT(*)::int
      FROM "paid_month" p
      JOIN "member" m ON m."id" = p."user_id"
     GROUP BY 2, 3`;
}

export function assembleCohorts(now: Date, zone: AnalyticsZone, rows: readonly CohortRow[]): CohortRowInterface[] {
  const sizes = new Map<string, number>();
  const paid = new Map<string, Map<number, number>>();
  for (const row of rows) {
    if (row.kind === 'size') {
      sizes.set(row.cohort, row.users);
      continue;
    }
    if (row.offset < 0) continue;
    const byOffset = paid.get(row.cohort) ?? new Map<number, number>();
    byOffset.set(row.offset, row.users);
    paid.set(row.cohort, byOffset);
  }
  const today = dateKeyOf(now, zone.name);
  const result: CohortRowInterface[] = [];
  for (let back = ANALYTICS_COHORT_MONTHS - 1; back >= 0; back--) {
    const cohort = monthStartKey(today, -back).slice(0, 7);
    const size = sizes.get(cohort) ?? 0;
    if (size === 0) {
      result.push({ cohort, cohortSize: 0, retentionByMonth: [] });
      continue;
    }
    // The signup month itself, then every month up to the current one.
    const months = back + 1;
    const byOffset = paid.get(cohort);
    result.push({
      cohort,
      cohortSize: size,
      retentionByMonth: Array.from({ length: months }, (_, offset) => (byOffset?.get(offset) ?? 0) / size),
    });
  }
  return result;
}

export const EXPIRING_HORIZON_DAYS = 30;

export interface ExpiringRow {
  readonly day: number;
  readonly segment: 'autopay' | 'manual' | 'trial';
  readonly subscriptions: number;
}

/**
 * The subscription (alias `s`) is one auto-renew WILL charge when its term
 * runs out — the same decision `AutoRenewService.processAutopayCharges` makes,
 * clause for clause (the spec holds the two together, case by case):
 *
 *   - ACTIVE, and not a trial (the scheduler's own query; the owner not being
 *     blocked is the caller's filter);
 *   - the owner's card `SavedPaymentMethodService.findPreferredForCharge`
 *     returns: the NEWEST active, autopay-enabled YooKassa method with a
 *     provider id — and that one must be real (not blank, not `demo_pm_`),
 *     an older card behind a demo one is never reached;
 *   - a renewal that needs nobody's choice
 *     (`SubscriptionRenewalService.requiresPlanSelection`): the plan the
 *     subscription recorded still exists and is not deleted, and if it is
 *     archived to renew onto replacements, one of them is on sale.
 */
export function autopayWillChargeSql(): Prisma.Sql {
  return Prisma.sql`(
    s."status" = 'ACTIVE' AND NOT s."is_trial"
    AND COALESCE((
      SELECT BTRIM(m."provider_method_id") <> '' AND NOT STARTS_WITH(BTRIM(m."provider_method_id"), 'demo_pm_')
        FROM "saved_payment_methods" m
       WHERE m."user_id" = s."user_id" AND m."is_active" AND m."autopay_enabled"
         AND m."gateway_type" = 'YOOKASSA' AND m."provider_method_id" <> ''
       ORDER BY m."created_at" DESC
       LIMIT 1
    ), FALSE)
    AND JSONB_TYPEOF(s."plan_snapshot"->'id') = 'string'
    AND EXISTS (
      SELECT 1
        FROM "plans" p
       WHERE p."id" = s."plan_snapshot"->>'id'
         AND p."deleted_at" IS NULL
         AND (NOT p."is_archived"
              OR p."archived_renew_mode" <> 'REPLACE_ON_RENEW'
              OR EXISTS (
                SELECT 1
                  FROM "plans" r
                 WHERE r."id" = ANY (p."replacement_plan_ids")
                   AND r."is_active" AND NOT r."is_archived" AND r."deleted_at" IS NULL AND r."availability" <> 'TRIAL'))
    )
  )`;
}

/**
 * Live subscriptions whose term ends from now to the end of the 30th local day
 * (today included), per day and per what will happen to them: `trial` — a
 * trial ends, which is never charged; `autopay` — auto-renew will charge the
 * owner's card ({@link autopayWillChargeSql}); `manual` — nothing will be
 * charged, including every LIMITED subscription (auto-renew charges only
 * ACTIVE ones). A blocked owner's subscription is left out: it is never
 * charged and nobody is going to win it back.
 */
export function expiringSql(now: Date, zone: AnalyticsZone): Prisma.Sql {
  const today = dateKeyOf(now, zone.name);
  const horizonEnd = startOfZonedDay(addDays(today, EXPIRING_HORIZON_DAYS), zone.name);
  return Prisma.sql`
    SELECT (${localDateSql(Prisma.sql`s."expires_at"`, zone)} - ${today}::date)::int AS "day",
           CASE WHEN s."is_trial" THEN 'trial'
                WHEN ${autopayWillChargeSql()} THEN 'autopay'
                ELSE 'manual'
           END AS "segment",
           COUNT(*)::int AS "subscriptions"
      FROM "subscriptions" s
      JOIN "users" u ON u."id" = s."user_id"
     WHERE s."status" IN ('ACTIVE', 'LIMITED')
       AND NOT u."is_blocked"
       AND s."expires_at" > ${now}
       AND s."expires_at" < ${horizonEnd}
     GROUP BY 1, 2`;
}

export function assembleExpiring(now: Date, zone: AnalyticsZone, rows: readonly ExpiringRow[]): ExpiringReportInterface {
  const today = dateKeyOf(now, zone.name);
  const days = Array.from({ length: EXPIRING_HORIZON_DAYS }, (_, index) => ({
    date: addDays(today, index),
    autopay: 0,
    manual: 0,
    trial: 0,
  }));
  const totals = { autopay: 0, manual: 0, trial: 0 };
  for (const row of rows) {
    const day = days[row.day];
    if (day === undefined) continue;
    day[row.segment] += row.subscriptions;
    totals[row.segment] += row.subscriptions;
  }
  return {
    generatedAt: now.toISOString(),
    timeZone: zone.name,
    timeZoneFallback: zone.fallback,
    horizonDays: EXPIRING_HORIZON_DAYS,
    days,
    totals,
  };
}

export interface SubscriptionPlanRow {
  readonly key: string;
  readonly planId: string | null;
  readonly name: string | null;
  readonly active: number;
  readonly limited: number;
  readonly trial: number;
}

/** Live subscriptions (ACTIVE and LIMITED) per plan — keyed by the plan's id, else by its name. */
export function subscriptionsByPlanSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT CASE WHEN NULLIF(s."plan_snapshot"->>'id', '') IS NOT NULL THEN 'id:' || (s."plan_snapshot"->>'id')
                ELSE 'name:' || COALESCE(s."plan_snapshot"->>'name', '') END AS "key",
           NULLIF(s."plan_snapshot"->>'id', '') AS "planId",
           (ARRAY_AGG(s."plan_snapshot"->>'name' ORDER BY s."updated_at" DESC)
              FILTER (WHERE NULLIF(s."plan_snapshot"->>'name', '') IS NOT NULL))[1] AS "name",
           COUNT(*) FILTER (WHERE s."status" = 'ACTIVE')::int AS "active",
           COUNT(*) FILTER (WHERE s."status" = 'LIMITED')::int AS "limited",
           COUNT(*) FILTER (WHERE s."is_trial")::int AS "trial"
      FROM "subscriptions" s
     WHERE s."status" IN ('ACTIVE', 'LIMITED')
     GROUP BY 1, 2`;
}

export function assembleSubscriptionsByPlan(rows: readonly SubscriptionPlanRow[]): SubscriptionByPlanItem[] {
  const total = rows.reduce((sum, row) => sum + row.active + row.limited, 0);
  return rows
    .map((row) => ({
      plan: row.name ?? '',
      planId: row.planId,
      active: row.active,
      limited: row.limited,
      trial: row.trial,
      total: row.active + row.limited,
      percentage: total === 0 ? 0 : (row.active + row.limited) / total,
    }))
    .sort((a, b) => b.total - a.total || a.plan.localeCompare(b.plan));
}
