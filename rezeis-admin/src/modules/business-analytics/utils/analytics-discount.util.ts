/**
 * «Промокоды и скидки»: how many subscription purchases of the window were
 * paid with a discount, how large, and whether a client whose first purchase
 * had one comes back.
 *
 * THE DISCOUNT OF A PURCHASE is the difference between its list price and what
 * was paid, in whole per cent. The panel does not record the discount a
 * payment carried (the quote knows it, the draft does not keep it), so:
 *
 *   - an ordinary payment is compared with the plan's list price NOW for that
 *     duration and currency (`plan_prices`). A price changed since reads as a
 *     discount (a rise) or none (a cut) on older payments — the (i) says so;
 *   - a payment of a provider subscription's first charge is compared with the
 *     list price recorded at sign-up (`provider_subscriptions.list_amount`),
 *     and so is every later charge, whose amount is the frozen one: a renewal
 *     «по старой цене» is a discount only by what the payer had at sign-up,
 *     never by the price having risen since;
 *   - a line of a combined renewal carries the percent the quote applied
 *     (`transaction_items.discount_percent`), which is used as it stands.
 *
 * No gateway fee or conversion enters: a price list is kept per currency, and
 * a payment is compared with the list of ITS currency. A currency with no
 * list price for the plan and duration (a deleted plan, a currency removed
 * from it) leaves the purchase out of both counts; it is reported as unknown.
 *
 * WHICH PAYMENTS. Payments of subscription time that are money received
 * (`analytics-paid-coverage.util.ts`): not an add-on, not withheld for refund,
 * not from a partner's balance, not a payment moved from another bot. A plan
 * change (an UPGRADE after the client's first payment) is priced by the
 * difference between plans, not by a list, and is left out.
 *
 * «ПОКУПАЮТ ЛИ ПОВТОРНО» follows the clients whose FIRST purchase was in the
 * window and whose first period ended more than
 * {@link DISCOUNT_REPEAT_AFTER_DAYS} days ago, in two groups by whether that
 * purchase had a discount (a client whose first price is unknown is in
 * neither). "Bought again" is any later purchase of subscription time, at any
 * moment — before the first period ended or after it.
 */
import { Prisma } from '@prisma/client';

import type {
  DiscountBucketInterface,
  DiscountReportInterface,
} from '../interfaces/business-analytics.types';
import { paidCoverageCtes } from './analytics-paid-coverage.util';
import { type AnalyticsWindowInterface } from './analytics-window.util';

/** A client's first period must have ended this many days ago for them to count in «Покупают ли повторно». */
export const DISCOUNT_REPEAT_AFTER_DAYS = 7;

/** The buckets of the discount's size, in whole per cent: from (included) to (excluded); the last is open. */
export const DISCOUNT_BUCKETS: readonly { readonly key: string; readonly from: number; readonly to: number | null }[] = [
  { key: 'b1', from: 1, to: 10 },
  { key: 'b10', from: 10, to: 20 },
  { key: 'b20', from: 20, to: 30 },
  { key: 'b30', from: 30, to: 40 },
  { key: 'b40', from: 40, to: 50 },
  { key: 'b50', from: 50, to: null },
];

export interface DiscountSqlRow {
  /** `purchases`: the window's purchases by bucket; `first`: first purchases, by whether they had a discount. */
  readonly kind: 'purchases' | 'first';
  /** `unknown`, `full`, one of the bucket keys; or `discount` / `full` for `first`. */
  readonly key: string;
  readonly count: number;
  /** `purchases`: the sum of the whole percents; `first`: clients who bought again. */
  readonly sum: number | string | null;
  /** `first` only: of those, clients whose second price is known. */
  readonly known: number | null;
  /** `first` only: of those, clients who paid the full price the second time. */
  readonly full: number | null;
}

function bucketCase(): Prisma.Sql {
  const arms = DISCOUNT_BUCKETS.map((bucket) =>
    bucket.to === null
      ? Prisma.sql`ELSE '${Prisma.raw(bucket.key)}'`
      : Prisma.sql`WHEN d."pct" < ${Prisma.raw(String(bucket.to))} THEN '${Prisma.raw(bucket.key)}'`,
  );
  return Prisma.sql`CASE WHEN d."pct" IS NULL THEN 'unknown' WHEN d."pct" < 1 THEN 'full' ${Prisma.join(arms, ' ')} END`;
}

export function discountSql(window: AnalyticsWindowInterface, now: Date): Prisma.Sql {
  const repeatAfter = Prisma.raw(String(DISCOUNT_REPEAT_AFTER_DAYS));
  return Prisma.sql`
    WITH RECURSIVE ${paidCoverageCtes()},
    "d_catalog" AS MATERIALIZED (
      SELECT pd."plan_id", pd."days", pp."currency"::text AS "currency", pp."price" AS "list"
        FROM "plan_durations" pd
        JOIN "plan_prices" pp ON pp."plan_duration_id" = pd."id"
    ),
    "d_line" AS MATERIALIZED (
      SELECT r."tx", r."user_id", r."at", r."ptype", r."gateway", r."charge_of", r."plan_id", r."days", r."currency",
             r."amount" AS "paid", NULL::int AS "recorded", FALSE AS "from_item"
        FROM "pay_raw" r
       WHERE r."bought" AND NOT r."combined" AND r."days" IS NOT NULL AND r."plan_id" IS NOT NULL
      UNION ALL
      SELECT r."tx", r."user_id", r."at", r."ptype", r."gateway", r."charge_of", i."plan_id", i."duration_days", i."currency"::text,
             i."amount", i."discount_percent", TRUE
        FROM "pay_raw" r
        JOIN "transaction_items" i ON i."transaction_id" = r."tx"
       WHERE r."bought" AND r."combined" AND (i."duration_days" = -1 OR i."duration_days" > 0)
    ),
    "d_ranked" AS MATERIALIZED (
      SELECT l.*, DENSE_RANK() OVER (PARTITION BY l."user_id" ORDER BY l."at", l."tx") AS "rk"
        FROM "d_line" l
    ),
    "d_priced" AS MATERIALIZED (
      SELECT k."tx", k."user_id", k."at", k."days", k."rk",
             CASE
               WHEN k."charge_of" IS NOT NULL THEN
                 CASE WHEN pc."list_amount" > 0 THEN GREATEST(ROUND((1 - k."paid" / pc."list_amount") * 100), 0) END
               WHEN k."from_item" THEN k."recorded"::numeric
               ELSE
                 CASE WHEN COALESCE(pf."list_amount", c."list") > 0
                      THEN GREATEST(ROUND((1 - k."paid" / COALESCE(pf."list_amount", c."list")) * 100), 0) END
             END AS "pct"
        FROM "d_ranked" k
        LEFT JOIN "provider_subscriptions" pc
          ON pc."provider_subscription_id" = k."charge_of" AND pc."gateway_type"::text = k."gateway"
        LEFT JOIN "provider_subscriptions" pf ON pf."first_transaction_id" = k."tx"
        LEFT JOIN "d_catalog" c ON c."plan_id" = k."plan_id" AND c."days" = k."days" AND c."currency" = k."currency"
       WHERE k."ptype" <> 'UPGRADE' OR k."rk" = 1
    ),
    -- One row per payment, for "the first purchase" and "the second": the counting lines only.
    "d_tx" AS MATERIALIZED (
      SELECT p."user_id", p."tx", MIN(p."at") AS "at", MAX(p."pct") AS "pct",
             MIN(CASE WHEN p."days" = -1 THEN 'infinity'::timestamptz
                      ELSE p."at"::timestamptz + p."days" * INTERVAL '1 day' END) AS "ends_at"
        FROM "d_priced" p
       GROUP BY p."user_id", p."tx"
    ),
    "d_tx_ranked" AS MATERIALIZED (
      SELECT t.*, ROW_NUMBER() OVER (PARTITION BY t."user_id" ORDER BY t."at", t."tx") AS "n"
        FROM "d_tx" t
    )
    SELECT 'purchases' AS "kind", ${bucketCase()} AS "key", COUNT(*)::int AS "count",
           COALESCE(SUM(d."pct"), 0) AS "sum", NULL::int AS "known", NULL::int AS "full"
      FROM "d_priced" d
     WHERE d."at" >= ${window.start}
     GROUP BY 2
    UNION ALL
    SELECT 'first', CASE WHEN f."pct" >= 1 THEN 'discount' ELSE 'full' END, COUNT(*)::int,
           COUNT(s."tx")::int,
           COUNT(s."pct")::int,
           COUNT(*) FILTER (WHERE s."pct" < 1)::int
      FROM "d_tx_ranked" f
      LEFT JOIN "d_tx_ranked" s ON s."user_id" = f."user_id" AND s."n" = 2
     WHERE f."n" = 1
       AND f."at" >= ${window.start}
       AND f."pct" IS NOT NULL
       AND f."ends_at" < ${now}::timestamptz - ${repeatAfter} * INTERVAL '1 day'
     GROUP BY 2`;
}

const num = (value: number | string | null | undefined): number => (value === null || value === undefined ? 0 : Number(value));

export function assembleDiscounts(
  window: AnalyticsWindowInterface,
  rows: readonly DiscountSqlRow[],
): DiscountReportInterface {
  let unknown = 0;
  let full = 0;
  let discounted = 0;
  let percentSum = 0;
  const counts = new Map<string, number>();
  const firsts = new Map<string, DiscountSqlRow>();
  for (const row of rows) {
    if (row.kind === 'first') {
      firsts.set(row.key, row);
      continue;
    }
    if (row.key === 'unknown') {
      unknown += row.count;
    } else if (row.key === 'full') {
      full += row.count;
    } else {
      counts.set(row.key, row.count);
      discounted += row.count;
      percentSum += num(row.sum);
    }
  }
  const buckets: DiscountBucketInterface[] = DISCOUNT_BUCKETS.map((bucket) => ({
    from: bucket.from,
    to: bucket.to,
    purchases: counts.get(bucket.key) ?? 0,
  }));
  const group = (key: string): { clients: number; boughtAgain: number } => {
    const row = firsts.get(key);
    return { clients: row?.count ?? 0, boughtAgain: num(row?.sum) };
  };
  const afterDiscount = firsts.get('discount');
  const purchases = discounted + full;
  return {
    windowDays: window.days,
    generatedAt: window.now.toISOString(),
    purchases,
    discounted,
    averageDiscount: discounted === 0 ? null : percentSum / discounted,
    unknown,
    buckets,
    repeat: {
      afterDays: DISCOUNT_REPEAT_AFTER_DAYS,
      withDiscount: group('discount'),
      withoutDiscount: group('full'),
      secondPriceKnown: afterDiscount?.known ?? 0,
      secondFullPrice: afterDiscount?.full ?? 0,
    },
  };
}
