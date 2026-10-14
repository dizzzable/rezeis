/**
 * PAID COVERAGE — the days a client had paid for, rebuilt from their payments.
 *
 * «Удержание по месяцу первой оплаты» and «Автоплатёж» both need to know, for
 * any past date, whether a client had a paid subscription running. No table
 * keeps that history:
 *
 *   - `subscriptions` keeps only the latest `expires_at`, and a lapsed
 *     subscription is deleted three days after it ends (see the note on
 *     `paidTermSql` in `analytics-overview.util.ts`);
 *   - the term ledger (`subscription_terms`) holds the terms of the CURRENT
 *     state — the cutover wrote one term per live subscription, a renewal
 *     moves its tail — and goes with the subscription when it is deleted.
 *
 * What stays for good is the payment. A payment of a subscription's time
 * records the days it bought (`plan_snapshot.selectedDurationDays`; a combined
 * renewal, `transaction_items.duration_days` per subscription), so the
 * coverage is derived the way the panel itself stacks a renewal
 * (`PaymentSubscriptionMutationService`: the new expiry is the later of "now"
 * and the current expiry, plus the days):
 *
 *     starts = the later of (payment time, end of the previous period)
 *     ends   = starts + days            (`-1` days — lifetime — never ends)
 *
 * per subscription (a payment with no subscription is chained per client).
 *
 * WHAT IT COUNTS. Money received (`analytics-money-received.util.ts`) that
 * bought subscription time: not an add-on, not a payment withheld for refund,
 * dated no earlier than the client's registration (a payment moved from
 * another bot keeps its donor date and says nothing about days — an importer
 * writes none, so such a payment never makes a period anyway).
 *
 * WHAT IT DOES NOT COUNT. Days given free (a free trial, promo days, a
 * referral bonus, an operator's grant) are not paid coverage. A refund after
 * the fact is only seen when it took the whole payment back; a partial one
 * leaves the period. The panel's days are added as `days × 1 day`, so a period
 * across a daylight-saving switch is off by an hour.
 */
import { Prisma } from '@prisma/client';

import { moneyReceivedSql } from './analytics-money-received.util';

/** A renewal this many days after the term ran out still counts as the term kept (named, so the page and the SQL cannot drift). */
export const PAID_COVERAGE_GRACE_DAYS = 4;

/**
 * The common table expressions that define the paid periods. Splice them after
 * `WITH RECURSIVE` (comma-separated, no trailing comma); the caller's own
 * expressions follow.
 *
 *   "pay_line"   one row per payment line that bought time: user, payment,
 *                `at` (payment time), `chain` (the subscription it renews),
 *                `days`;
 *   "pay_period" one row per such line with the period it paid for:
 *                `starts_at` and `ends_at` (`infinity` for a lifetime).
 */
export function paidCoverageCtes(): Prisma.Sql {
  return Prisma.sql`
    -- The conditions on the payment's JSON are computed as columns here and filtered in the next
    -- step: PostgreSQL guesses a selectivity for a JSON expression, and guessed twice over it
    -- thought this step held a dozen rows (it holds all of them), then joined it with nested loops.
    "pay_raw" AS MATERIALIZED (
      SELECT t."user_id", t."id" AS "tx", t."created_at" AS "at", t."subscription_id" AS "sub_id",
             t."purchase_type"::text AS "ptype", t."gateway_type"::text AS "gateway", t."currency"::text AS "currency",
             t."amount" AS "amount", NULLIF(t."plan_snapshot"->>'id', '') AS "plan_id",
             CASE WHEN t."plan_snapshot"->>'snapshotSource' = 'PROVIDER_SUBSCRIPTION_CHARGE'
                  THEN t."plan_snapshot"->>'providerSubscriptionId' END AS "charge_of",
             CASE WHEN t."plan_snapshot"->>'selectedDurationDays' ~ '^(-1|[1-9][0-9]{0,4})$'
                  THEN (t."plan_snapshot"->>'selectedDurationDays')::int END AS "days",
             (t."gateway_data"->>'conversionWithheldAt' IS NULL
              AND NOT (t."purchase_type" = 'ADDITIONAL' AND t."plan_snapshot"->>'snapshotSource' = 'ADDON_PURCHASE')) AS "bought",
             EXISTS (SELECT 1 FROM "transaction_items" i WHERE i."transaction_id" = t."id") AS "combined"
        FROM "transactions" t
        JOIN "users" u ON u."id" = t."user_id"
       WHERE ${moneyReceivedSql()}
         AND t."created_at" >= u."created_at"
    ),
    "pay_single" AS (
      SELECT r."user_id", r."tx", r."at", r."sub_id", r."days"
        FROM "pay_raw" r
       WHERE r."bought" AND NOT r."combined" AND r."days" IS NOT NULL
    ),
    "pay_items" AS (
      SELECT r."user_id", r."tx", r."at", i."subscription_id" AS "sub_id", i."duration_days" AS "days"
        FROM "pay_raw" r
        JOIN "transaction_items" i ON i."transaction_id" = r."tx"
       WHERE r."bought" AND r."combined" AND (i."duration_days" = -1 OR i."duration_days" > 0)
    ),
    "pay_line" AS MATERIALIZED (
      SELECT l."user_id", l."tx", l."at", COALESCE(l."sub_id", 'user:' || l."user_id") AS "chain", l."days"
        FROM (SELECT * FROM "pay_single" UNION ALL SELECT * FROM "pay_items") l
    ),
    "pay_ranked" AS MATERIALIZED (
      SELECT l.*, ROW_NUMBER() OVER (PARTITION BY l."chain" ORDER BY l."at", l."tx") AS "rn"
        FROM "pay_line" l
    ),
    "pay_period" ("user_id", "tx", "at", "chain", "rn", "days", "starts_at", "ends_at") AS (
      SELECT r."user_id", r."tx", r."at", r."chain", r."rn", r."days", r."at"::timestamptz,
             CASE WHEN r."days" = -1 THEN 'infinity'::timestamptz ELSE (r."at" + r."days" * INTERVAL '1 day')::timestamptz END
        FROM "pay_ranked" r
       WHERE r."rn" = 1
      UNION ALL
      SELECT r."user_id", r."tx", r."at", r."chain", r."rn", r."days",
             GREATEST(p."ends_at", r."at"),
             CASE WHEN r."days" = -1 THEN 'infinity'::timestamptz
                  ELSE GREATEST(p."ends_at", r."at") + r."days" * INTERVAL '1 day' END
        FROM "pay_period" p
        JOIN "pay_ranked" r ON r."chain" = p."chain" AND r."rn" = p."rn" + 1
    )`;
}
