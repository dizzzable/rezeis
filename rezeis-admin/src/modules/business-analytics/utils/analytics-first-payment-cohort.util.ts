/**
 * «Удержание по месяцу первой оплаты»: the clients of each month of FIRST
 * payment, and the share that still had a paid subscription running 1…12
 * months later — the question the registration cohorts cannot answer, because
 * a client on a 3-, 6- or 12-month plan pays once in many months and looks
 * lost in the months between payments there.
 *
 * A COHORT is the clients whose first payment fell in a local month (the
 * panel's time zone) of the last twelve. The first payment is the first
 * payment of subscription time the paid-coverage rule sees
 * (`analytics-paid-coverage.util.ts`), so a payment moved from another bot —
 * it carries no days — is never one.
 *
 * A CELL is the share of the cohort with a paid period covering the date
 * `first payment + N months`, with a grace of {@link PAID_COVERAGE_GRACE_DAYS}
 * days for a renewal that comes a little late. It is shown only when the
 * latest date of the row — the end of the cohort month plus N months — plus
 * the grace has passed, so a cell never counts a date that has not come, and a
 * cohort is never shown against a denominator some of whom have not had the
 * chance to renew.
 *
 * The coverage is derived from payments and plan durations, not read from the
 * term ledger: see `analytics-paid-coverage.util.ts` for why, and what it
 * cannot see.
 */
import { Prisma } from '@prisma/client';

import type { PaidCohortReportInterface, PaidCohortRowInterface } from '../interfaces/business-analytics.types';
import { ANALYTICS_COHORT_MONTHS } from './analytics-date.util';
import { PAID_COVERAGE_GRACE_DAYS, paidCoverageCtes } from './analytics-paid-coverage.util';
import { localTimestampSql } from './analytics-window.util';
import { addDays, type AnalyticsZone, dateKeyOf, monthStartKey } from './analytics-zone.util';

/** Columns of the table: 1…12 months after the first payment. */
export const PAID_COHORT_OFFSETS = 12;

export interface PaidCohortSqlRow {
  /** `size`: the cohort's members; `covered`: of them, who had a paid period over the date `offset` months on. */
  readonly kind: 'size' | 'covered';
  readonly cohort: string;
  readonly offset: number;
  readonly users: number;
}

/**
 * Per local month of first payment of the last twelve: the cohort's size, and
 * how many of it were covered at each of the next twelve month marks. One set
 * of statements — a recursive pass over the payments chains the periods, no
 * loop over clients.
 */
export function paidCohortSql(earliest: Date, zone: AnalyticsZone): Prisma.Sql {
  const local = (column: Prisma.Sql): Prisma.Sql => localTimestampSql(column, zone);
  return Prisma.sql`
    WITH RECURSIVE ${paidCoverageCtes()},
    "member" AS (
      SELECT f."user_id", ${local(Prisma.sql`f."first_at"`)} AS "first_local",
             DATE_TRUNC('month', ${local(Prisma.sql`f."first_at"`)}) AS "month"
        FROM (SELECT p."user_id", MIN(p."at") AS "first_at" FROM "pay_line" p GROUP BY p."user_id") f
       WHERE f."first_at" >= ${earliest}
    ),
    "covered" AS (
      SELECT DISTINCT m."user_id", n."n"
        FROM "member" m
       CROSS JOIN GENERATE_SERIES(1, ${Prisma.raw(String(PAID_COHORT_OFFSETS))}) AS n ("n")
        JOIN "pay_period" p ON p."user_id" = m."user_id"
         AND ${local(Prisma.sql`p."starts_at"`)} <= m."first_local" + n."n" * INTERVAL '1 month'
         AND m."first_local" + n."n" * INTERVAL '1 month'
             < ${local(Prisma.sql`p."ends_at"`)} + ${Prisma.raw(String(PAID_COVERAGE_GRACE_DAYS))} * INTERVAL '1 day'
    )
    SELECT 'size' AS "kind", TO_CHAR(m."month", 'YYYY-MM') AS "cohort", 0 AS "offset", COUNT(*)::int AS "users"
      FROM "member" m
     GROUP BY m."month"
    UNION ALL
    SELECT 'covered', TO_CHAR(m."month", 'YYYY-MM'), c."n"::int, COUNT(*)::int
      FROM "covered" c
      JOIN "member" m ON m."user_id" = c."user_id"
     GROUP BY m."month", c."n"`;
}

export function assemblePaidCohorts(
  now: Date,
  zone: AnalyticsZone,
  rows: readonly PaidCohortSqlRow[],
): PaidCohortReportInterface {
  const sizes = new Map<string, number>();
  const covered = new Map<string, Map<number, number>>();
  for (const row of rows) {
    if (row.kind === 'size') {
      sizes.set(row.cohort, row.users);
      continue;
    }
    const byOffset = covered.get(row.cohort) ?? new Map<number, number>();
    byOffset.set(row.offset, row.users);
    covered.set(row.cohort, byOffset);
  }
  const today = dateKeyOf(now, zone.name);
  const cohorts: PaidCohortRowInterface[] = [];
  for (let back = ANALYTICS_COHORT_MONTHS - 1; back >= 0; back--) {
    const cohort = monthStartKey(today, -back).slice(0, 7);
    const size = sizes.get(cohort) ?? 0;
    if (size === 0) {
      cohorts.push({ cohort, cohortSize: 0, retentionByMonth: [] });
      continue;
    }
    const byOffset = covered.get(cohort);
    const monthStart = `${cohort}-01`;
    cohorts.push({
      cohort,
      cohortSize: size,
      retentionByMonth: Array.from({ length: PAID_COHORT_OFFSETS }, (_, index) => {
        const offset = index + 1;
        // The latest date this cell can mean: the first day of the month after the cohort's, `offset` months on.
        const latest = addDays(monthStartKey(monthStart, offset + 1), PAID_COVERAGE_GRACE_DAYS);
        return latest <= today ? (byOffset?.get(offset) ?? 0) / size : null;
      }),
    });
  }
  return {
    cohorts,
    graceDays: PAID_COVERAGE_GRACE_DAYS,
    generatedAt: now.toISOString(),
    timeZone: zone.name,
    timeZoneFallback: zone.fallback,
  };
}
