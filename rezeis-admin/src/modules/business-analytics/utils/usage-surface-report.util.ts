/**
 * The usage-surface report — every figure of the analytics card «Поверхности и
 * устройства» — as ONE SQL statement, and the mapping from its rows.
 *
 * WHY ONE STATEMENT. The card prints totals next to breakdowns of the same
 * customers: «С телеметрией» beside three rings of tracked customers,
 * «Установок PWA» beside the installs ring. Counted by separate statements, a
 * customer whose first report lands between two of them makes a total and its
 * ring disagree. A single statement reads one snapshot, so every breakdown adds
 * up to its total by construction — without a transaction, an isolation level
 * or a second round trip — and it scans `users` once instead of five times.
 * Only counts leave the database: no per-customer row reaches Node.
 *
 * `GROUPING SETS` produces one row per bucket of each grouping plus the grand
 * total; `GROUPING(col) = 0` says which set a row belongs to, which is what
 * tells a customer with no surface (a real NULL, reported as `other`) from the
 * NULL a grouping leaves in a column it does not group by.
 *
 * WHICH OS AN INSTALL IS COUNTED UNDER (`install_os`):
 *
 *   1. `pwa_installed_os` — the OS of the first open from the installed app,
 *      written by the same update that stamps `pwa_installed_at`, and carried
 *      over for older installs from the audit rows that still existed when
 *      migration 20260915210000 ran;
 *   2. otherwise the OS of the last visit, but only when that visit was from the
 *      app (`last_surface = 'pwa'`), since then it is the OS the app runs on;
 *   3. otherwise `unknown`.
 */
import { Prisma } from '@prisma/client';

import type {
  SurfaceCountInterface,
  UsageSurfaceReportInterface,
} from '../interfaces/business-analytics.types';

/** The bucket for an install whose OS is on record nowhere. */
export const PWA_INSTALL_OS_UNKNOWN = 'unknown';

/** One row of {@link usageSurfaceReportSql}. Counts arrive as `bigint`. */
export interface UsageSurfaceRow {
  readonly dimension: string;
  readonly key: string | null;
  readonly tracked: bigint | number | null;
  readonly active: bigint | number | null;
  readonly installed: bigint | number | null;
}

export function usageSurfaceReportSql(activeSince: Date): Prisma.Sql {
  return Prisma.sql`
    WITH "customer" AS (
      SELECT "last_seen_at" IS NOT NULL                          AS "tracked",
             COALESCE("last_seen_at" >= ${activeSince}, FALSE)   AS "active",
             "pwa_installed_at" IS NOT NULL                      AS "installed",
             "last_surface"                                      AS "surface",
             "last_form_factor"                                  AS "form_factor",
             "last_os"                                           AS "os",
             CASE
               WHEN "pwa_installed_at" IS NULL THEN NULL
               WHEN "pwa_installed_os" IS NOT NULL THEN "pwa_installed_os"
               WHEN "last_surface" = 'pwa' THEN COALESCE("last_os", 'other')
               ELSE 'unknown'
             END                                                 AS "install_os"
        FROM "users"
    )
    SELECT CASE
             WHEN GROUPING("surface") = 0 THEN 'surface'
             WHEN GROUPING("form_factor") = 0 THEN 'form'
             WHEN GROUPING("os") = 0 THEN 'os'
             WHEN GROUPING("install_os") = 0 THEN 'install_os'
             ELSE 'total'
           END                                                   AS "dimension",
           COALESCE("surface", "form_factor", "os", "install_os") AS "key",
           COUNT(*) FILTER (WHERE "tracked")                     AS "tracked",
           COUNT(*) FILTER (WHERE "active")                      AS "active",
           COUNT(*) FILTER (WHERE "installed")                   AS "installed"
      FROM "customer"
     GROUP BY GROUPING SETS (("surface"), ("form_factor"), ("os"), ("install_os"), ())
  `;
}

const byCountThenKey = (a: SurfaceCountInterface, b: SurfaceCountInterface): number =>
  b.count - a.count || a.key.localeCompare(b.key);

/**
 * The buckets of one grouping, counted by `measure`. A customer with no value
 * is `other`, merged with the customers the cabinet itself reported as `other`;
 * a bucket that counts nobody (the non-installed, the untracked) is dropped.
 */
function breakdown(
  rows: readonly UsageSurfaceRow[],
  dimension: string,
  measure: 'tracked' | 'installed',
): SurfaceCountInterface[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.dimension !== dimension) continue;
    const count = Number(row[measure] ?? 0);
    if (count <= 0) continue;
    const key = row.key ?? 'other';
    counts.set(key, (counts.get(key) ?? 0) + count);
  }
  return [...counts.entries()].map(([key, count]) => ({ key, count })).sort(byCountThenKey);
}

export function buildUsageSurfaceReport(
  rows: readonly UsageSurfaceRow[],
  generatedAt: Date,
): UsageSurfaceReportInterface {
  const total = rows.find((row) => row.dimension === 'total');
  return {
    surfaces: breakdown(rows, 'surface', 'tracked'),
    formFactors: breakdown(rows, 'form', 'tracked'),
    operatingSystems: breakdown(rows, 'os', 'tracked'),
    pwaInstalls: Number(total?.installed ?? 0),
    pwaInstallsByOs: breakdown(rows, 'install_os', 'installed'),
    activeLast30d: Number(total?.active ?? 0),
    totalTracked: Number(total?.tracked ?? 0),
    generatedAt: generatedAt.toISOString(),
  };
}
