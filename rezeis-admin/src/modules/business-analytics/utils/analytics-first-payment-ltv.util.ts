/**
 * «Ценность клиента по месяцу первой оплаты»: for the clients of each month of
 * first payment (the last twelve, in the panel's time zone), the mean and the
 * median of everything they have paid to date — and the same two figures over
 * all of those clients.
 *
 * It reads money the way «Пожизненная ценность клиента» does
 * (`analytics-customer-value.util.ts`): money received, net of a partial
 * refund, each payment converted into the lifetime view currency in SQL with
 * the same rates. What differs is the clients' date: a payment dated before
 * the client registered (a donor's, moved in from another bot) is neither
 * money paid to this panel nor a first payment, as in the cohort tables.
 *
 * THE LATEST MONTHS HAVE HAD LESS TIME to pay: a client of last month has
 * paid once, a client of a year ago has renewed. The page says so under the
 * chart; nothing here corrects for it.
 */
import { Prisma } from '@prisma/client';

import type {
  FirstPaymentLtvReportInterface,
  FirstPaymentLtvRowInterface,
  MoneyViewInterface,
} from '../interfaces/business-analytics.types';
import { ANALYTICS_COHORT_MONTHS } from './analytics-date.util';
import { moneyReceivedSql, netAmountSql } from './analytics-money-received.util';
import { viewRates } from './analytics-money.util';
import { localTimestampSql } from './analytics-window.util';
import { type AnalyticsZone, dateKeyOf, monthStartKey } from './analytics-zone.util';

type SqlNumeric = Prisma.Decimal | string | number | bigint | null;
const numOrNull = (value: SqlNumeric | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);

export interface FirstPaymentLtvSqlRow {
  /** The cohort's `YYYY-MM`, or `all` for the figures over every client shown. */
  readonly cohort: string;
  readonly clients: number;
  readonly mean: SqlNumeric;
  readonly median: SqlNumeric;
}

export function firstPaymentLtvSql(earliest: Date, zone: AnalyticsZone, view: MoneyViewInterface): Prisma.Sql {
  const local = (column: Prisma.Sql): Prisma.Sql => localTimestampSql(column, zone);
  return Prisma.sql`
    WITH "rate" AS (
      SELECT r."key" AS "currency", r."value"::numeric AS "rate"
        FROM JSONB_EACH_TEXT(${JSON.stringify(viewRates(view))}::jsonb) AS r
    ),
    "client" AS MATERIALIZED (
      SELECT t."user_id", MIN(t."created_at") AS "first_at", SUM(${netAmountSql()} * r."rate") AS "value"
        FROM "transactions" t
        JOIN "users" u ON u."id" = t."user_id"
        LEFT JOIN "rate" r ON r."currency" = t."currency"::text
       WHERE ${moneyReceivedSql()} AND t."created_at" >= u."created_at"
       GROUP BY t."user_id"
    ),
    "member" AS (
      SELECT TO_CHAR(DATE_TRUNC('month', ${local(Prisma.sql`c."first_at"`)}), 'YYYY-MM') AS "cohort", c."value"
        FROM "client" c
       WHERE c."first_at" >= ${earliest} AND c."value" IS NOT NULL
    )
    SELECT m."cohort", COUNT(*)::int AS "clients", AVG(m."value") AS "mean",
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY m."value") AS "median"
      FROM "member" m
     GROUP BY m."cohort"
    UNION ALL
    SELECT 'all', COUNT(*)::int, AVG(m."value"), PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY m."value")
      FROM "member" m`;
}

export function assembleFirstPaymentLtv(
  now: Date,
  zone: AnalyticsZone,
  view: MoneyViewInterface,
  rows: readonly FirstPaymentLtvSqlRow[],
): FirstPaymentLtvReportInterface {
  const byCohort = new Map<string, FirstPaymentLtvSqlRow>();
  let overall: FirstPaymentLtvSqlRow | undefined;
  for (const row of rows) {
    if (row.cohort === 'all') overall = row;
    else byCohort.set(row.cohort, row);
  }
  const today = dateKeyOf(now, zone.name);
  const list: FirstPaymentLtvRowInterface[] = [];
  for (let back = ANALYTICS_COHORT_MONTHS - 1; back >= 0; back--) {
    const cohort = monthStartKey(today, -back).slice(0, 7);
    const row = byCohort.get(cohort);
    list.push({
      cohort,
      clients: row?.clients ?? 0,
      mean: numOrNull(row?.mean),
      median: numOrNull(row?.median),
    });
  }
  return {
    rows: list,
    clients: overall?.clients ?? 0,
    mean: numOrNull(overall?.mean),
    median: numOrNull(overall?.median),
    money: view,
    generatedAt: now.toISOString(),
    timeZone: zone.name,
    timeZoneFallback: zone.fallback,
  };
}
