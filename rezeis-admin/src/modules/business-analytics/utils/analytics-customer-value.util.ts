/**
 * What a paying customer is worth over their lifetime: the LTV histogram and
 * the top payers — both in one currency per report, never a raw sum across
 * currencies (see `analytics-money.util.ts`).
 *
 * A customer's lifetime value is the sum of the money received from them
 * (`analytics-money-received.util.ts`: completed, for more than nothing, not
 * from a partner's balance, net of partial refunds), each payment converted
 * into the report's view currency in SQL with the same rates the report names,
 * passed in as one JSON parameter. Payments in a currency the view cannot
 * express are left out; the report's `money.unconverted` says so.
 *
 * Both used to load one row per paying customer into memory (a `groupBy` on
 * `userId` over the whole table) before bucketing or ranking them.
 */
import { Prisma } from '@prisma/client';

import type {
  CurrencyAmountInterface,
  LtvBucketInterface,
  LtvReportInterface,
  MoneyViewInterface,
  TopPayerInterface,
} from '../interfaces/business-analytics.types';
import { moneyReceivedSql, netAmountSql } from './analytics-money-received.util';
import { viewRates } from './analytics-money.util';

type SqlNumeric = Prisma.Decimal | string | number | bigint | null;
const numOrNull = (value: SqlNumeric | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);

export interface LifetimeCurrencyRow {
  readonly currency: string;
  readonly amount: SqlNumeric;
}

/** Every currency money was ever received in, with its lifetime sum. */
export function lifetimeCurrenciesSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT t."currency"::text AS "currency", SUM(${netAmountSql()}) AS "amount"
      FROM "transactions" t
     WHERE ${moneyReceivedSql()}
     GROUP BY 1`;
}

/** The rates as a relation, and every paying customer's lifetime value in the view currency. */
function ltvCte(view: MoneyViewInterface): Prisma.Sql {
  return Prisma.sql`
    "rate" AS (
      SELECT r."key" AS "currency", r."value"::numeric AS "rate"
        FROM JSONB_EACH_TEXT(${JSON.stringify(viewRates(view))}::jsonb) AS r
    ),
    "ltv" AS (
      SELECT t."user_id", SUM(${netAmountSql()} * r."rate") AS "value"
        FROM "transactions" t
        JOIN "rate" r ON r."currency" = t."currency"::text
       WHERE ${moneyReceivedSql()}
       GROUP BY t."user_id"
    )`;
}

export interface LtvStatsRow {
  readonly payers: number;
  readonly mean: SqlNumeric;
  readonly median: SqlNumeric;
  readonly p90: SqlNumeric;
  readonly p95: SqlNumeric;
}

export function ltvStatsSql(view: MoneyViewInterface): Prisma.Sql {
  return Prisma.sql`
    WITH ${ltvCte(view)}
    SELECT COUNT(*)::int AS "payers",
           AVG("value") AS "mean",
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "value") AS "median",
           PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY "value") AS "p90",
           PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY "value") AS "p95"
      FROM "ltv"`;
}

export interface LtvBins {
  /** Width of every bin but the last, in the view currency. */
  readonly step: number;
  /** Number of equal bins; one more, open-ended, holds everything from `step × bins` up. */
  readonly bins: number;
}

const NICE = [1, 2, 2.5, 5] as const;
const TARGET_BINS = 8;

/**
 * Equal-width bins from zero that cover the 95th percentile in about eight
 * steps of a round width (1, 2, 2.5 or 5 times a power of ten), and an open
 * last bin for the tail above it — so the few largest customers do not squeeze
 * everyone else into the first bar.
 */
export function chooseLtvBins(p95: number | null): LtvBins {
  if (p95 === null || !Number.isFinite(p95) || p95 <= 0) return { step: 1, bins: 1 };
  const magnitude = 10 ** Math.floor(Math.log10(p95 / TARGET_BINS));
  let best: LtvBins | null = null;
  for (const scale of [magnitude / 10, magnitude, magnitude * 10]) {
    for (const nice of NICE) {
      const step = Number((nice * scale).toPrecision(12));
      const bins = Math.max(1, Math.ceil(p95 / step - 1e-9));
      if (bins > 12) continue;
      const better =
        best === null ||
        Math.abs(bins - TARGET_BINS) < Math.abs(best.bins - TARGET_BINS) ||
        (Math.abs(bins - TARGET_BINS) === Math.abs(best.bins - TARGET_BINS) && step > best.step);
      if (better) best = { step, bins };
    }
  }
  return best ?? { step: p95, bins: 1 };
}

export interface LtvBinRow {
  readonly bin: number;
  readonly users: number;
}

export function ltvBinsSql(view: MoneyViewInterface, bins: LtvBins): Prisma.Sql {
  return Prisma.sql`
    WITH ${ltvCte(view)}
    SELECT LEAST(GREATEST(FLOOR("value" / ${bins.step}::numeric), 0), ${bins.bins})::int AS "bin",
           COUNT(*)::int AS "users"
      FROM "ltv"
     GROUP BY 1`;
}

/** Rounds away the binary noise of `step × index` (0.1 × 3 = 0.30000000000000004). */
function bound(step: number, index: number): number {
  return Number((step * index).toPrecision(12));
}

export function assembleLtv(
  view: MoneyViewInterface,
  stats: LtvStatsRow | undefined,
  bins: LtvBins,
  rows: readonly LtvBinRow[],
): LtvReportInterface {
  const counts = new Map(rows.map((row) => [row.bin, row.users]));
  const buckets: LtvBucketInterface[] = [];
  for (let index = 0; index < bins.bins; index++) {
    const from = bound(bins.step, index);
    buckets.push({ bound: from, from, to: bound(bins.step, index + 1), users: counts.get(index) ?? 0 });
  }
  const tail = counts.get(bins.bins) ?? 0;
  if (tail > 0) {
    const from = bound(bins.step, bins.bins);
    buckets.push({ bound: from, from, to: null, users: tail });
  }
  const payers = stats?.payers ?? 0;
  return {
    buckets: payers === 0 ? [] : buckets,
    money: view,
    stats: {
      payers,
      mean: payers === 0 ? null : numOrNull(stats?.mean),
      median: payers === 0 ? null : numOrNull(stats?.median),
      p90: payers === 0 ? null : numOrNull(stats?.p90),
    },
  };
}

export interface TopPayerRow {
  readonly userId: string;
  /** `null` when none of the customer's money has a rate into the view. */
  readonly value: SqlNumeric;
  readonly payments: number;
  readonly lastAt: Date | string | null;
  readonly byCurrency: unknown;
  readonly telegramId: string | null;
  readonly username: string | null;
  readonly name: string | null;
}

/**
 * The customers who paid the most over their lifetime, ranked by their total in
 * the view currency; each with the exact sums per currency it was made of.
 *
 * A customer whose money is all in currencies with no rate (Telegram Stars,
 * until an operator sets one) has no total at all — `NULL`, not 0 — and ranks
 * after every customer who has one: nothing says how their Stars compare.
 */
export function topPayersSql(view: MoneyViewInterface, limit: number): Prisma.Sql {
  return Prisma.sql`
    WITH "rate" AS (
      SELECT r."key" AS "currency", r."value"::numeric AS "rate"
        FROM JSONB_EACH_TEXT(${JSON.stringify(viewRates(view))}::jsonb) AS r
    ),
    "per_currency" AS (
      SELECT t."user_id", t."currency"::text AS "currency", SUM(${netAmountSql()}) AS "amount",
             COUNT(*)::int AS "payments", MAX(t."created_at") AS "last_at"
        FROM "transactions" t
       WHERE ${moneyReceivedSql()}
       GROUP BY 1, 2
    ),
    "per_user" AS (
      SELECT p."user_id",
             SUM(p."amount" * r."rate") AS "value",
             SUM(p."payments")::int AS "payments",
             MAX(p."last_at") AS "last_at"
        FROM "per_currency" p
        LEFT JOIN "rate" r ON r."currency" = p."currency"
       GROUP BY p."user_id"
       ORDER BY "value" DESC NULLS LAST, "payments" DESC, p."user_id"
       LIMIT ${limit}
    )
    SELECT pu."user_id" AS "userId", pu."value", pu."payments", pu."last_at" AS "lastAt",
           -- Built for the winners only, not for every paying customer.
           (SELECT JSONB_AGG(JSONB_BUILD_OBJECT('currency', pc."currency", 'amount', pc."amount") ORDER BY pc."amount" DESC)
              FROM "per_currency" pc
             WHERE pc."user_id" = pu."user_id") AS "byCurrency",
           u."telegram_id"::text AS "telegramId", u."username", u."name"
      FROM "per_user" pu
      JOIN "users" u ON u."id" = pu."user_id"
     ORDER BY pu."value" DESC NULLS LAST, pu."payments" DESC, pu."user_id"`;
}

function readByCurrency(value: unknown): CurrencyAmountInterface[] {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { currency, amount } = entry as { currency?: unknown; amount?: unknown };
    const number = Number(amount);
    return typeof currency === 'string' && Number.isFinite(number) ? [{ currency, amount: number }] : [];
  });
}

export function assembleTopPayers(rows: readonly TopPayerRow[]): TopPayerInterface[] {
  return rows.map((row) => ({
    userId: row.userId,
    telegramId: row.telegramId,
    username: row.username,
    name: row.name ?? '',
    totalSpent: row.value === null ? null : Number(row.value),
    spentByCurrency: readByCurrency(row.byCurrency),
    transactionCount: row.payments,
    lastPaymentAt: row.lastAt === null ? null : new Date(row.lastAt).toISOString(),
  }));
}
