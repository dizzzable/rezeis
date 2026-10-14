/**
 * «Автоплатёж»: of the clients who pay, how many have autopay on, and what
 * became of the paid periods that ended 30-120 days ago, with and without it.
 *
 * THE PERIODS are the paid periods of `analytics-paid-coverage.util.ts`
 * (rebuilt from payments), whose end fell {@link AUTOPAY_PERIOD_FROM_DAYS_AGO}
 * to {@link AUTOPAY_PERIOD_TO_DAYS_AGO} days ago: the newest of them have had
 * a month to come back, so «Не вернулись» is a fact about each, not a guess.
 * A lifetime period never ends. The owner of a blocked account is left out, as
 * in «Истекают в ближайшие 30 дней»: nobody is going to win them back.
 *
 * WHAT BECAME OF A PERIOD is told by the client's next payment for
 * subscription time, whichever subscription it renews:
 *   - before the period ended .............. «Продлили до окончания»;
 *   - within {@link AUTOPAY_FIRST_DAYS} days after it ...... «В первые 3 дня после»;
 *   - within {@link AUTOPAY_LATER_DAYS} days ........... «Через 4–30 дней»;
 *   - later, or never ...................... «Не вернулись за 30 дней».
 *
 * «С АВТОПЛАТЕЖОМ» MEANS AUTOPAY WAS ON AT THE END OF THAT PERIOD, not today.
 * The history the panel keeps:
 *   - ЮKassa. A saved method (`saved_payment_methods`) has its binding date
 *     (`created_at`), and its unbinding (`unbound_at`). Each switch of the
 *     toggle writes an audit row `event.payment.method_autopay_updated`
 *     (`SavedPaymentMethodService`), which the audit rotation keeps for
 *     `AUDIT_RETENTION_DAYS` (90 by default). Every row is a change of state,
 *     so the state before the first row that is left is the opposite of its
 *     value. A method with no row at all — a switch older than the rotation —
 *     is read as it stands, switched off at its last write if it is off now;
 *   - Platega, RollyPay, Antilopay. A provider's subscription
 *     (`provider_subscriptions`) is autopay from its creation, once the payer
 *     confirmed it (it has charged, or still is active), until it was
 *     cancelled (`cancelled_at`) or the provider's plan of charges ended
 *     (`ends_at`).
 * Nothing records a switch the panel did not see (a card the bank closed) or
 * one the rotation took away from a method that was switched more than once.
 *
 * THE HEADER counts the clients with a paid period in force now (the same
 * rebuilt periods) and, of them, those with autopay on now by the same rule.
 */
import { Prisma } from '@prisma/client';

import type {
  AutopayOutcomesInterface,
  AutopayReportInterface,
} from '../interfaces/business-analytics.types';
import { paidCoverageCtes } from './analytics-paid-coverage.util';

/** The window of periods compared: ended this long ago at the most … */
export const AUTOPAY_PERIOD_FROM_DAYS_AGO = 120;
/** … and this long ago at the least, so each had {@link AUTOPAY_LATER_DAYS} days to come back. */
export const AUTOPAY_PERIOD_TO_DAYS_AGO = 30;
/** «В первые 3 дня после». */
export const AUTOPAY_FIRST_DAYS = 3;
/** «Через 4–30 дней» runs to this many days after the period ended. */
export const AUTOPAY_LATER_DAYS = 30;

export type AutopayOutcome = 'early' | 'firstDays' | 'later' | 'gone';

export interface AutopaySqlRow {
  /** `payers`: the header's clients (`outcome` is null); `periods`: ended periods by outcome. */
  readonly kind: 'payers' | 'periods';
  readonly autopay: boolean;
  readonly outcome: AutopayOutcome | null;
  readonly count: number;
}

/**
 * The history of autopay as intervals of time on which it was ON, per client
 * (`ap_span`: `user_id`, `from_at`, `to_at`), so "was it on at T" is one range
 * join rather than a lookup per question. A ЮKassa method's state is cut into
 * stretches by its audit rows (see the file comment); a provider's subscription
 * is one stretch.
 */
function autopayHistoryCtes(): Prisma.Sql {
  return Prisma.sql`
    "ap_toggle" AS MATERIALIZED (
      SELECT a."metadata"->>'savedPaymentMethodId' AS "method_id", a."created_at" AS "at",
             (a."metadata"->>'autopayEnabled') = 'true' AS "value"
        FROM "admin_audit_log" a
       WHERE a."action" = 'event.payment.method_autopay_updated'
         AND a."metadata"->>'savedPaymentMethodId' IS NOT NULL
         AND a."metadata"->>'autopayEnabled' IN ('true', 'false')
    ),
    "ap_method" AS MATERIALIZED (
      SELECT m."id", m."user_id", m."created_at", m."autopay_enabled", m."updated_at",
             CASE WHEN m."unbound_at" IS NOT NULL THEN m."unbound_at"
                  WHEN NOT m."is_active" THEN m."updated_at" END AS "ended_at"
        FROM "saved_payment_methods" m
       WHERE m."gateway_type" = 'YOOKASSA'
    ),
    "ap_timeline" AS MATERIALIZED (
      -- Before the first row that is left, a method was in the opposite state to the one that row set.
      SELECT f."method_id", '-infinity'::timestamptz AS "from_at", f."at" AS "to_at", NOT f."value" AS "on"
        FROM (SELECT DISTINCT ON (g."method_id") g."method_id", g."at", g."value" FROM "ap_toggle" g ORDER BY g."method_id", g."at") f
      UNION ALL
      SELECT g."method_id", g."at",
             COALESCE(LEAD(g."at") OVER (PARTITION BY g."method_id" ORDER BY g."at"), 'infinity'::timestamptz),
             g."value"
        FROM "ap_toggle" g
      UNION ALL
      -- No row at all: as it stands, and if it is off now, on until its last write.
      SELECT m."id", '-infinity'::timestamptz,
             CASE WHEN m."autopay_enabled" THEN 'infinity'::timestamptz ELSE m."updated_at"::timestamptz END,
             TRUE
        FROM "ap_method" m
       WHERE NOT EXISTS (SELECT 1 FROM "ap_toggle" g WHERE g."method_id" = m."id")
    ),
    "ap_span" AS MATERIALIZED (
      SELECT m."user_id", GREATEST(t."from_at", m."created_at") AS "from_at",
             LEAST(t."to_at", COALESCE(m."ended_at"::timestamptz, 'infinity'::timestamptz)) AS "to_at"
        FROM "ap_timeline" t
        JOIN "ap_method" m ON m."id" = t."method_id"
       WHERE t."on"
         AND GREATEST(t."from_at", m."created_at") < LEAST(t."to_at", COALESCE(m."ended_at"::timestamptz, 'infinity'::timestamptz))
      UNION ALL
      SELECT s."user_id", s."created_at"::timestamptz,
             COALESCE(
               NULLIF(
                 LEAST(
                   COALESCE(s."cancelled_at", CASE WHEN s."status" = 'CANCELLED' THEN s."updated_at" END, 'infinity'::timestamptz),
                   COALESCE(s."ends_at", 'infinity'::timestamptz)),
                 'infinity'::timestamptz),
               'infinity'::timestamptz)
        FROM "provider_subscriptions" s
       WHERE s."user_id" IS NOT NULL
         AND (s."applied_charge_count" > 0 OR s."status" IN ('ACTIVE', 'PAST_DUE'))
    )`;
}

/** The client (a SQL expression) had autopay on at the instant (a SQL expression); needs {@link autopayHistoryCtes}. */
function autopayOnAtSql(userId: Prisma.Sql, at: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM "ap_span" a WHERE a."user_id" = ${userId} AND a."from_at" <= ${at} AND ${at} < a."to_at")`;
}

/**
 * One statement: the header's two counts and the ended periods' outcomes, per
 * autopay on/off. `now` is bound once, so both halves read the same instant.
 */
export function autopaySql(now: Date): Prisma.Sql {
  const from = Prisma.raw(String(AUTOPAY_PERIOD_FROM_DAYS_AGO));
  const to = Prisma.raw(String(AUTOPAY_PERIOD_TO_DAYS_AGO));
  const first = Prisma.raw(String(AUTOPAY_FIRST_DAYS));
  const later = Prisma.raw(String(AUTOPAY_LATER_DAYS));
  return Prisma.sql`
    WITH RECURSIVE ${paidCoverageCtes()},
    ${autopayHistoryCtes()},
    "pay_next" AS MATERIALIZED (
      SELECT x."tx", LEAD(x."at") OVER (PARTITION BY x."user_id" ORDER BY x."at", x."tx") AS "next_at"
        FROM (SELECT DISTINCT l."user_id", l."tx", l."at" FROM "pay_line" l) x
    ),
    "ended" AS MATERIALIZED (
      SELECT ROW_NUMBER() OVER () AS "pid", p."user_id", p."ends_at"::timestamptz AS "ends_at", n."next_at"
        FROM "pay_period" p
        JOIN "users" u ON u."id" = p."user_id"
        JOIN "pay_next" n ON n."tx" = p."tx"
       WHERE NOT u."is_blocked"
         AND p."ends_at" <= ${now}::timestamptz - ${to} * INTERVAL '1 day'
         AND p."ends_at" >= ${now}::timestamptz - ${from} * INTERVAL '1 day'
    ),
    -- A question "was it on" is asked in WHERE, as a semi-join, never in a SELECT list: there
    -- PostgreSQL runs it as a subplan that scans every span once for each row.
    "ended_on" AS MATERIALIZED (
      SELECT d."pid" FROM "ended" d WHERE ${autopayOnAtSql(Prisma.sql`d."user_id"`, Prisma.sql`d."ends_at"`)}
    ),
    "payer" AS MATERIALIZED (
      SELECT DISTINCT p."user_id"
        FROM "pay_period" p
        JOIN "users" u ON u."id" = p."user_id"
       WHERE NOT u."is_blocked" AND p."starts_at" <= ${now}::timestamptz AND p."ends_at" > ${now}::timestamptz
    )
    SELECT 'payers' AS "kind", TRUE AS "autopay", NULL::text AS "outcome", COUNT(*)::int AS "count"
      FROM "payer" r
     WHERE ${autopayOnAtSql(Prisma.sql`r."user_id"`, Prisma.sql`${now}::timestamptz`)}
    UNION ALL
    SELECT 'payers', FALSE, NULL::text, COUNT(*)::int
      FROM "payer" r
     WHERE NOT ${autopayOnAtSql(Prisma.sql`r."user_id"`, Prisma.sql`${now}::timestamptz`)}
    UNION ALL
    SELECT 'periods', e."autopay",
           CASE WHEN e."next_at" IS NULL THEN 'gone'
                WHEN e."next_at" < e."ends_at" THEN 'early'
                WHEN e."next_at" < e."ends_at" + ${first} * INTERVAL '1 day' THEN 'firstDays'
                WHEN e."next_at" <= e."ends_at" + ${later} * INTERVAL '1 day' THEN 'later'
                ELSE 'gone' END,
           COUNT(*)::int
      FROM (
        SELECT d."next_at", d."ends_at", (o."pid" IS NOT NULL) AS "autopay"
          FROM "ended" d
          LEFT JOIN "ended_on" o ON o."pid" = d."pid"
      ) e
     GROUP BY 2, 3`;
}

const emptyOutcomes = (): { -readonly [K in keyof AutopayOutcomesInterface]: number } => ({
  early: 0,
  firstDays: 0,
  later: 0,
  gone: 0,
});

export function assembleAutopay(now: Date, rows: readonly AutopaySqlRow[]): AutopayReportInterface {
  let payingClients = 0;
  let withAutopay = 0;
  const withOutcomes = emptyOutcomes();
  const withoutOutcomes = emptyOutcomes();
  for (const row of rows) {
    if (row.kind === 'payers') {
      payingClients += row.count;
      if (row.autopay) withAutopay += row.count;
      continue;
    }
    if (row.outcome === null) continue;
    (row.autopay ? withOutcomes : withoutOutcomes)[row.outcome] += row.count;
  }
  return {
    payingClients,
    withAutopay,
    withAutopayPeriods: withOutcomes,
    withoutAutopayPeriods: withoutOutcomes,
    fromDaysAgo: AUTOPAY_PERIOD_FROM_DAYS_AGO,
    toDaysAgo: AUTOPAY_PERIOD_TO_DAYS_AGO,
    firstDays: AUTOPAY_FIRST_DAYS,
    laterDays: AUTOPAY_LATER_DAYS,
    generatedAt: now.toISOString(),
  };
}
