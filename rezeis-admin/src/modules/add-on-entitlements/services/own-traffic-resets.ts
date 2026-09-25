import { Prisma } from '@prisma/client';

/**
 * THE RESETS THE PANEL ITSELF ASKED FOR — which say nothing about Remnawave's
 * schedule (reviews R3a-03 and R3a-04).
 *
 * `remnawave_last_traffic_reset_at` is Remnawave's `lastTrafficResetAt`, and
 * Remnawave writes it for a scheduled run AND for every manual reset. Two
 * readers took it for the schedule: the confirmation of a reset boundary (one
 * subscriber's reset «confirmed» a missed run for everybody, and their
 * add-ons came off onto counters nobody had zeroed) and the daily check (a
 * renewal from the auto-renew cron, a second after a whole minute, read as a
 * run in «UTC−02:15»). Most manual resets are the panel's own:
 *
 *  - a paid renewal zeroes the counter after its PATCH — the UPDATE job
 *    carries `resetTraffic: true` (`ProfileSyncProcessor`);
 *  - a TRAFFIC_RESET job, and the operator's «Сбросить» on the subscription
 *    and the users toolbar's «Сбросить трафик», each recorded as one
 *    (`recordOperatorTrafficReset`);
 *  - a paid or free «Обнулить трафик» — a `subscription_traffic_resets` row
 *    (`TrafficResetService`).
 *
 * Each of those rows brackets the instant Remnawave stamped — its `now` while
 * it served the panel's request — so a stamped reset inside one of them is
 * the panel's own. The bracket is widened by {@link OWN_RESET_CLOCK_SKEW_MS}:
 * the panel's clock and Remnawave's are not one clock. A reset somebody makes
 * in Remnawave's own UI leaves no such row; those are what the readers' other
 * rule is for (a scheduled run stamps MANY profiles with one instant per
 * status group, the groups milliseconds apart — `RUN_STAMP_SPREAD_MS`).
 */

/** How far outside its own record a reset the panel asked for may be stamped: the two clocks differ. */
export const OWN_RESET_CLOCK_SKEW_MS = 5 * 60 * 1000;

function msInterval(ms: number): Prisma.Sql {
  return Prisma.sql`(interval '1 millisecond' * ${ms}::double precision)`;
}

/**
 * True when the reset at `resetAt` of subscription `subscriptionId` (two SQL
 * expressions of the caller's query) was one the panel asked for. Never NULL.
 */
export function ownTrafficResetSql(subscriptionId: Prisma.Sql, resetAt: Prisma.Sql): Prisma.Sql {
  const skew = msInterval(OWN_RESET_CLOCK_SKEW_MS);
  return Prisma.sql`(
    EXISTS (
      SELECT 1
        FROM "profile_sync_jobs" j
       WHERE j."subscription_id" = ${subscriptionId}
         AND (
           j."action" = 'TRAFFIC_RESET'
           OR (j."action" = 'UPDATE' AND j."payload"->>'resetTraffic' = 'true')
         )
         AND ${resetAt} >= j."created_at" - ${skew}
         AND ${resetAt} <= COALESCE(j."completed_at", j."updated_at") + ${skew}
    )
    OR EXISTS (
      SELECT 1
        FROM "subscription_traffic_resets" r
       WHERE r."subscription_id" = ${subscriptionId}
         AND ${resetAt} >= r."performed_at" - ${skew}
         AND ${resetAt} <= r."performed_at" + ${skew}
    )
  )`;
}
