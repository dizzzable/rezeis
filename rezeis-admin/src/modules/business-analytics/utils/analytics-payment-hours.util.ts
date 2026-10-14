/**
 * «Когда платят»: how many payments fell on each hour of each weekday, in the
 * operator's time zone, over the chosen period.
 *
 * WHICH PAYMENTS. Money received (`analytics-money-received.util.ts`), of any
 * kind — a renewal, a new subscription, an add-on — counted, not summed: the
 * card is about when people pay, not how much. A payment belongs to the hour
 * of its `created_at` (the moment the client started it; see the overview
 * util for why not `updated_at`).
 *
 * AUTOMATIC CHARGES ARE LEFT OUT. A machine picks the time of the ЮKassa
 * autopay charge (the scheduler's checkout, whose idempotency key starts with
 * `auto-renew:`) and of a repeat charge a payment system makes on its own
 * schedule (`plan_snapshot.snapshotSource = PROVIDER_SUBSCRIPTION_CHARGE`,
 * charges 2 and up; the payer's own first charge stays). Their number is
 * reported apart so the page can say how many were left out.
 */
import { Prisma } from '@prisma/client';

import type { PaymentHoursReportInterface } from '../interfaces/business-analytics.types';
import { moneyReceivedSql } from './analytics-money-received.util';
import { type AnalyticsWindowInterface, localTimestampSql } from './analytics-window.util';

/** The prefix the autopay scheduler gives its checkouts (`AutoRenewService`). */
export const AUTOPAY_IDEMPOTENCY_PREFIX = 'auto-renew:';

/** How many busiest hours of the day the subtitle names. */
export const PAYMENT_HOURS_TOP = 3;

export interface PaymentHoursSqlRow {
  /** `cell`: payments by weekday and hour; `automatic`: the automatic charges left out (weekday and hour are 0). */
  readonly kind: 'cell' | 'automatic';
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  readonly weekday: number;
  readonly hour: number;
  readonly payments: number;
}

/** The payment (alias `t`) is a charge a machine made. */
export function automaticChargeSql(): Prisma.Sql {
  // Both tests are NULL for an ordinary payment (no key, no marker), and NOT NULL is NULL: each is made a plain true or false.
  return Prisma.sql`(COALESCE(t."idempotency_key" LIKE ${`${AUTOPAY_IDEMPOTENCY_PREFIX}%`}, FALSE)
    OR COALESCE(t."plan_snapshot"->>'snapshotSource' = 'PROVIDER_SUBSCRIPTION_CHARGE', FALSE))`;
}

export function paymentHoursSql(window: AnalyticsWindowInterface): Prisma.Sql {
  const local = localTimestampSql(Prisma.sql`t."created_at"`, window.zone);
  return Prisma.sql`
    SELECT 'cell' AS "kind", EXTRACT(ISODOW FROM ${local})::int AS "weekday", EXTRACT(HOUR FROM ${local})::int AS "hour",
           COUNT(*)::int AS "payments"
      FROM "transactions" t
     WHERE ${moneyReceivedSql()} AND t."created_at" >= ${window.start} AND NOT ${automaticChargeSql()}
     GROUP BY 2, 3
    UNION ALL
    SELECT 'automatic', 0, 0, COUNT(*)::int
      FROM "transactions" t
     WHERE ${moneyReceivedSql()} AND t."created_at" >= ${window.start} AND ${automaticChargeSql()}`;
}

export function assemblePaymentHours(
  window: AnalyticsWindowInterface,
  rows: readonly PaymentHoursSqlRow[],
): PaymentHoursReportInterface {
  // 7 weekdays × 24 hours, Monday first: the cell of (weekday, hour) is at (weekday - 1) * 24 + hour.
  const cells = Array.from({ length: 7 * 24 }, () => 0);
  let automatic = 0;
  for (const row of rows) {
    if (row.kind === 'automatic') {
      automatic += row.payments;
      continue;
    }
    const index = (row.weekday - 1) * 24 + row.hour;
    if (row.weekday >= 1 && row.weekday <= 7 && row.hour >= 0 && row.hour <= 23) cells[index] = (cells[index] ?? 0) + row.payments;
  }
  const perHour = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    payments: Array.from({ length: 7 }, (_unused, weekday) => cells[weekday * 24 + hour] ?? 0).reduce((sum, count) => sum + count, 0),
  }));
  const topHours = perHour
    .filter((entry) => entry.payments > 0)
    .sort((a, b) => b.payments - a.payments || a.hour - b.hour)
    .slice(0, PAYMENT_HOURS_TOP);
  return {
    windowDays: window.days,
    generatedAt: window.now.toISOString(),
    timeZone: window.zone.name,
    timeZoneFallback: window.zone.fallback,
    total: cells.reduce((sum, count) => sum + count, 0),
    automatic,
    cells,
    topHours,
  };
}
