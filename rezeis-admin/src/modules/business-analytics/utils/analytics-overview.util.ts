/**
 * «Обзор»: the KPI tiles against the previous window, their series, the
 * funnel and the payment systems' health — as SQL aggregates and one pure
 * function that puts them together.
 *
 * WHICH TIME A PAYMENT BELONGS TO: `created_at`. It is written once, when the
 * checkout starts, minutes before the money arrives, and never touched again.
 * The old report used `updated_at`, which every importer leaves at the moment
 * of the import (Bedolaga, Remnashop, Altshop and StealthNet all write the
 * payment's original date into `created_at` only), and which an account merge
 * and a tax-receipt registration rewrite later.
 *
 * WHICH PAYMENTS ARE MONEY: see `analytics-money-received.util.ts` — one rule
 * for every money figure here.
 *
 * Nothing here loads rows into memory: every statement returns counts and sums
 * grouped by window, bar and currency.
 */
import { Prisma } from '@prisma/client';

import type {
  AdvancedAnalyticsReportInterface,
  ChurnFigureInterface,
  ConversionFunnelStepInterface,
  MoneyFigureInterface,
  MoneyViewInterface,
  PartnerBalanceSpendInterface,
  ProviderHealthInterface,
} from '../interfaces/business-analytics.types';
import {
  boughtSubscriptionSql,
  moneyReceivedSql,
  netAmountSql,
  type PaymentOutcome,
  paymentOutcomeSql,
  purchaseKindSql,
  refundedSoFarSql,
} from './analytics-money-received.util';
import { chooseMoneyView, type FxSnapshot, hasUnconverted, moneyFigure } from './analytics-money.util';
import {
  type AnalyticsWindowInterface,
  bothWindowsSql,
  bucketIndexSql,
  describePeriod,
  isPreviousSql,
  zeroes,
} from './analytics-window.util';

type SqlNumeric = Prisma.Decimal | string | number | bigint | null;

const num = (value: SqlNumeric | undefined): number => (value === null || value === undefined ? 0 : Number(value));

// ── Statements ───────────────────────────────────────────────────────────

export interface OverviewPaymentRow {
  readonly previous: number;
  readonly bucket: number;
  readonly currency: string;
  readonly amount: SqlNumeric;
  readonly payments: number;
  readonly newSubscriptions: number;
}

/** Money received in both windows, per window, bar and currency — net of partial refunds. */
export function overviewPaymentsSql(window: AnalyticsWindowInterface): Prisma.Sql {
  const at = Prisma.sql`t."created_at"`;
  return Prisma.sql`
    SELECT ${isPreviousSql(at, window)}::int AS "previous",
           ${bucketIndexSql(at, window)} AS "bucket",
           t."currency"::text AS "currency",
           SUM(${netAmountSql()}) AS "amount",
           COUNT(*)::int AS "payments",
           COUNT(*) FILTER (WHERE ${purchaseKindSql()} = 'new')::int AS "newSubscriptions"
      FROM "transactions" t
     WHERE ${moneyReceivedSql()} AND ${bothWindowsSql(at, window)}
     GROUP BY 1, 2, 3`;
}

export interface OverviewPayerRow {
  readonly previous: number;
  /** `null` on the whole-window row. */
  readonly bucket: number | null;
  readonly payers: number;
  readonly wholeWindow: number;
}

/**
 * Distinct paying customers per bar AND per whole window, in one pass: a
 * customer who paid on two days is one payer of the window, which no sum of
 * daily counts can say.
 */
export function overviewPayersSql(window: AnalyticsWindowInterface): Prisma.Sql {
  const at = Prisma.sql`t."created_at"`;
  return Prisma.sql`
    SELECT "previous", "bucket", COUNT(DISTINCT "user_id")::int AS "payers", GROUPING("bucket")::int AS "wholeWindow"
      FROM (
        SELECT ${isPreviousSql(at, window)}::int AS "previous", ${bucketIndexSql(at, window)} AS "bucket", t."user_id"
          FROM "transactions" t
         WHERE ${moneyReceivedSql()} AND ${bothWindowsSql(at, window)}
      ) AS "paid"
     GROUP BY GROUPING SETS (("previous", "bucket"), ("previous"))`;
}

export interface OverviewUserRow {
  readonly previous: number;
  readonly bucket: number;
  readonly users: number;
}

export function overviewNewUsersSql(window: AnalyticsWindowInterface): Prisma.Sql {
  const at = Prisma.sql`u."created_at"`;
  return Prisma.sql`
    SELECT ${isPreviousSql(at, window)}::int AS "previous", ${bucketIndexSql(at, window)} AS "bucket", COUNT(*)::int AS "users"
      FROM "users" u
     WHERE ${bothWindowsSql(at, window)} AND u."anonymized_at" IS NULL
     GROUP BY 1, 2`;
}

/**
 * THE PAID TERM of every subscription that is on a paid plan now — `from` when
 * it became paid, `until` when its paid time ran or runs out — for
 * "in force at T": `from <= T < until`.
 *
 * A PAID TRIAL IS PAID (the owner's rule): a trial subscription that was
 * bought ({@link boughtSubscriptionSql}) counts from its purchase, whatever it
 * cost and however it was paid, like any paid plan. A free trial does not.
 *
 * ON A PLAN: its snapshot names one — `id`, which every purchase, renewal and
 * operator action writes, or `planId`, which «Клонировать тарифы» and
 * «Назначить план всем» write on an imported row and the only key a re-import
 * carries over. No importer writes either: a profile brought in from
 * Remnawave, 3x-ui or another bot is on no plan until one is assigned, and it
 * is neither a paid subscription nor a lapse. (The Remnawave and 3x-ui
 * importers also stamp the import as the start, so five profiles imported on
 * Monday used to appear as five new paid subscriptions, and a year of them in
 * the 365-day view.)
 *
 * WHEN IT BECAME PAID. Not `created_at` alone, and not `started_at` alone:
 *   - a free trial converts by an UPGRADE of the trial row in place, which
 *     keeps the trial's `created_at` — such a row (it carries a trial claim, the
 *     ledger every trial subscription gets, and it was not bought) is paid from
 *     its first completed UPGRADE;
 *   - an importer writes `created_at` = the import and `started_at` = the
 *     donor's start date;
 *   - every UPGRADE resets `started_at` to its own moment, so a paid
 *     subscription moved to another plan — a paid trial moved to a regular one
 *     included — would look new.
 *   So: a former free trial from its conversion; anything else from the
 *   earlier of `created_at` and `started_at`.
 *
 * WHEN IT ENDS. `expires_at` — and for a deleted row the earlier of that and
 * the deletion, its last write (`updated_at`). Deleted rows count: under the
 * default settings the expired-profile cleanup deletes a lapsed subscription
 * three days after it ends, so leaving them out left only the lapses of the
 * last three days in any churn figure. A row deleted while its term ran — an
 * operator's removal — ended when it was deleted.
 *
 * WHAT CANNOT BE SEEN, and the page's (i) says so:
 *   - A row keeps only its latest `expires_at`: a customer who let a
 *     subscription lapse and later renewed the SAME subscription looks as if
 *     it never lapsed (by default that is only possible inside the three days
 *     before the cleanup deletes it). No table keeps the history: the durable
 *     terms (`subscription_terms`) exist only on installs that ran the add-on
 *     entitlement cutover script, and payments do not record every extension
 *     (grants, promo days, operator edits).
 *   - The duplicate «Слияние подписок-дубликатов» retires is the row the
 *     Remnawave importer minted, so it is on no plan and never counted — unless
 *     «Назначить план всем» reached it first. Then it reads as a second paid
 *     subscription until the merge and a lapse on the day of it: the merge
 *     leaves nothing on the row to tell it from a deletion (DELETED with the
 *     identity cleared is also a row deleted before it ever got a profile), and
 *     the audit row naming it (`subscriptions.duplicate_pair_merged`) is written
 *     after the merge commits and rotated away after 90 days.
 *   - A Remnawave or 3x-ui import that has been given a plan is paid from the
 *     import: neither importer keeps the profile's own start.
 */
function paidTermSql(): Prisma.Sql {
  // Joined, not correlated: every non-trial subscription is read, and a hash
  // join of the (few) former trials beats an index probe per subscription.
  // MATERIALIZED, so the CASE below runs once per row however many figures read it.
  return Prisma.sql`"former_trial" AS (
      SELECT c."subscription_id", MIN(u."created_at") AS "converted_at"
        FROM "trial_claims" c
        LEFT JOIN "transactions" u
          ON u."subscription_id" = c."subscription_id" AND u."status" = 'COMPLETED' AND u."purchase_type" = 'UPGRADE'
       WHERE c."status" = 'CONSUMED' AND c."subscription_id" IS NOT NULL
         AND NOT ${boughtSubscriptionSql(Prisma.sql`c."subscription_id"`)}
       GROUP BY c."subscription_id"
    ),
    "paid_term" AS MATERIALIZED (
      SELECT CASE
               WHEN f."subscription_id" IS NOT NULL THEN COALESCE(f."converted_at", s."started_at", s."created_at")
               ELSE LEAST(s."created_at", COALESCE(s."started_at", s."created_at"))
             END AS "from",
             CASE
               WHEN s."status" = 'DELETED' THEN LEAST(COALESCE(s."expires_at", 'infinity'::timestamptz), s."updated_at")
               ELSE s."expires_at"
             END AS "until"
        FROM "subscriptions" s
        LEFT JOIN "former_trial" f ON f."subscription_id" = s."id"
       WHERE (NOT s."is_trial" OR ${boughtSubscriptionSql(Prisma.sql`s."id"`)})
         AND (NULLIF(s."plan_snapshot"->>'id', '') IS NOT NULL OR NULLIF(s."plan_snapshot"->>'planId', '') IS NOT NULL)
    )`;
}

function inForceAt(at: Date): Prisma.Sql {
  return Prisma.sql`("from" <= ${at} AND ("until" IS NULL OR "until" > ${at}))`;
}

export interface SubscriptionSnapshotRow {
  readonly activeNow: number;
  readonly activeThen: number;
  readonly churnBase: number;
  readonly churned: number;
  readonly previousChurnBase: number;
  readonly previousChurned: number;
  readonly trialsNow: number;
}

/**
 * Paid subscriptions in force at the ends of both windows, and churn over each,
 * from one scan of the paid terms ({@link paidTermSql}).
 *
 * CHURN OVER A WINDOW: of the paid subscriptions in force when it opened, those
 * whose paid term ended inside it and was not extended past its end.
 */
export function subscriptionSnapshotSql(window: AnalyticsWindowInterface): Prisma.Sql {
  const { now, start, previousStart, previousEnd } = window;
  return Prisma.sql`
    WITH ${paidTermSql()}
    SELECT COUNT(*) FILTER (WHERE ${inForceAt(now)})::int AS "activeNow",
           COUNT(*) FILTER (WHERE ${inForceAt(previousEnd)})::int AS "activeThen",
           COUNT(*) FILTER (WHERE ${inForceAt(start)})::int AS "churnBase",
           COUNT(*) FILTER (WHERE ${inForceAt(start)} AND "until" <= ${now})::int AS "churned",
           COUNT(*) FILTER (WHERE ${inForceAt(previousStart)})::int AS "previousChurnBase",
           COUNT(*) FILTER (WHERE ${inForceAt(previousStart)} AND "until" <= ${previousEnd})::int AS "previousChurned",
           (SELECT COUNT(*)
              FROM "subscriptions" s
             WHERE s."is_trial" AND s."status" IN ('ACTIVE', 'LIMITED')
               AND (s."expires_at" IS NULL OR s."expires_at" > ${now})
               -- Free trials only: a paid one is already among the paid subscriptions.
               AND NOT ${boughtSubscriptionSql(Prisma.sql`s."id"`)})::int AS "trialsNow"
      FROM "paid_term"`;
}

export interface ActiveSeriesRow {
  readonly kind: 'start' | 'in' | 'out';
  readonly bucket: number;
  readonly count: number;
}

/**
 * The paid subscriptions in force at the end of every bar of the current
 * window, as events: the count at the window's start, then per bar the paid
 * terms that began (`in`) and ended (`out`). Summed up bar by bar it ends
 * exactly at `activeNow` of {@link subscriptionSnapshotSql} — the spec holds
 * the two together.
 */
export function activeSeriesSql(window: AnalyticsWindowInterface): Prisma.Sql {
  const { now, start } = window;
  return Prisma.sql`
    WITH ${paidTermSql()},
    "term" AS (
      SELECT "from", "until" FROM "paid_term" WHERE "until" IS NULL OR "until" > "from"
    )
    SELECT 'start' AS "kind", 0 AS "bucket", COUNT(*)::int AS "count"
      FROM "term"
     WHERE "from" <= ${start} AND ("until" IS NULL OR "until" > ${start})
    UNION ALL
    SELECT 'in', ${bucketIndexSql(Prisma.sql`"from"`, window)}, COUNT(*)::int
      FROM "term"
     WHERE "from" > ${start} AND "from" <= ${now}
     GROUP BY 2
    UNION ALL
    SELECT 'out', ${bucketIndexSql(Prisma.sql`"until"`, window)}, COUNT(*)::int
      FROM "term"
     WHERE "until" > ${start} AND "until" <= ${now}
     GROUP BY 2`;
}

export interface FunnelRow {
  readonly registered: number;
  readonly activated: number;
  readonly paid: number;
  readonly repeat: number;
}

/**
 * The funnel of the customers who REGISTERED in the window, followed to today:
 * registered → started using (a trial, or any subscription, or a payment) →
 * paid → paid again. Each step is a subset of the one before, so every
 * step-to-step share is a real conversion.
 *
 * Only money received AFTER the registration counts: an importer stamps
 * `created_at` with the import, and a donor's payments keep their own, earlier
 * dates — they are not this funnel's «Оплатили».
 */
export function funnelSql(window: AnalyticsWindowInterface): Prisma.Sql {
  return Prisma.sql`
    WITH "cohort" AS (
      SELECT u."id", u."created_at" FROM "users" u WHERE u."created_at" >= ${window.start}
    ),
    "paid" AS (
      SELECT t."user_id", COUNT(*)::int AS "payments"
        FROM "transactions" t
        JOIN "cohort" c ON c."id" = t."user_id"
       WHERE ${moneyReceivedSql()} AND t."created_at" >= c."created_at"
       GROUP BY t."user_id"
    )
    SELECT COUNT(*)::int AS "registered",
           COUNT(*) FILTER (
             WHERE g."user_id" IS NOT NULL OR p."payments" > 0
                OR EXISTS (SELECT 1 FROM "subscriptions" s WHERE s."user_id" = c."id")
           )::int AS "activated",
           COUNT(*) FILTER (WHERE p."payments" >= 1)::int AS "paid",
           COUNT(*) FILTER (WHERE p."payments" >= 2)::int AS "repeat"
      FROM "cohort" c
      LEFT JOIN "trial_grants" g ON g."user_id" = c."id"
      LEFT JOIN "paid" p ON p."user_id" = c."id"`;
}

/** How a checkout ended ({@link paymentOutcomeSql}), with a partial refund told apart from a plain completion. */
export type ProviderOutcome = PaymentOutcome | 'completedRefundedInPart';

export interface ProviderRow {
  readonly gateway: string;
  readonly outcome: ProviderOutcome;
  readonly currency: string;
  readonly count: number;
  readonly amount: SqlNumeric;
}

/**
 * Every checkout STARTED in the window through a payment system, per system,
 * outcome and currency — with the money received from it.
 *
 * A checkout for nothing (a 100 % promo code) never reaches a payment system,
 * and a partner's balance is not one: neither is here. A refund is an outcome
 * of a checkout that WENT THROUGH: reconciliation writes a full one as
 * CANCELED stamped `refundReversedAt`, a partial one as a COMPLETED payment
 * carrying `refundedAmountTotal`.
 */
export function providersSql(window: AnalyticsWindowInterface): Prisma.Sql {
  return Prisma.sql`
    SELECT t."gateway_type"::text AS "gateway",
           (CASE
              WHEN t."status" = 'COMPLETED' AND ${refundedSoFarSql()} > 0 THEN 'completedRefundedInPart'
              ELSE ${paymentOutcomeSql()}
            END) AS "outcome",
           t."currency"::text AS "currency",
           COUNT(*)::int AS "count",
           SUM(CASE WHEN ${moneyReceivedSql()} THEN ${netAmountSql()} ELSE 0 END) AS "amount"
      FROM "transactions" t
     WHERE t."created_at" >= ${window.start} AND t."amount" > 0 AND t."gateway_type" <> 'PARTNER_BALANCE'
     GROUP BY 1, 2, 3`;
}

export interface PartnerBalanceRow {
  readonly currency: string;
  readonly amount: SqlNumeric;
  readonly payments: number;
}

/** Purchases paid from a partner's balance in the current window — not revenue, stated apart. */
export function partnerBalanceSql(window: AnalyticsWindowInterface): Prisma.Sql {
  return Prisma.sql`
    SELECT t."currency"::text AS "currency", SUM(t."amount") AS "amount", COUNT(*)::int AS "payments"
      FROM "transactions" t
     WHERE t."status" = 'COMPLETED' AND t."gateway_type" = 'PARTNER_BALANCE' AND t."amount" > 0
       AND t."created_at" >= ${window.start}
     GROUP BY 1`;
}

export function assemblePartnerBalance(view: MoneyViewInterface, rows: readonly PartnerBalanceRow[]): PartnerBalanceSpendInterface {
  const sums = new Map<string, number>();
  let payments = 0;
  for (const row of rows) {
    sums.set(row.currency, (sums.get(row.currency) ?? 0) + num(row.amount));
    payments += row.payments;
  }
  return { figure: moneyFigure(view, sums), payments };
}

// ── Assembly ─────────────────────────────────────────────────────────────

export interface OverviewRows {
  readonly payments: readonly OverviewPaymentRow[];
  readonly payers: readonly OverviewPayerRow[];
  readonly newUsers: readonly OverviewUserRow[];
  readonly subscriptions: SubscriptionSnapshotRow;
  readonly activeSeries: readonly ActiveSeriesRow[];
  readonly funnel: FunnelRow;
  readonly providers: readonly ProviderRow[];
  readonly partnerBalance: readonly PartnerBalanceRow[];
  readonly totalUsers: number;
}

const FUNNEL_LABELS: Readonly<Record<keyof FunnelRow, string>> = {
  registered: 'Registered',
  activated: 'Started using',
  paid: 'Paid',
  repeat: 'Paid again',
};

function churnFigure(base: number, churned: number): ChurnFigureInterface {
  return { base, churned, rate: base === 0 ? null : churned / base };
}

function arppuOf(view: MoneyViewInterface, figure: MoneyFigureInterface, payers: number): number | null {
  // Withheld while part of the money has no rate: the payers of that money
  // are in the denominator and their payments are not in the numerator.
  if (payers === 0 || hasUnconverted(view, figure)) return null;
  return figure.value / payers;
}

function inRange(bucket: number | null, length: number): bucket is number {
  return bucket !== null && Number.isInteger(bucket) && bucket >= 0 && bucket < length;
}

export function assembleOverview(
  window: AnalyticsWindowInterface,
  rows: OverviewRows,
  fx: FxSnapshot,
): AdvancedAnalyticsReportInterface {
  const view = chooseMoneyView(
    rows.payments.filter((row) => num(row.amount) !== 0).map((row) => row.currency),
    fx,
  );
  const lengths = [window.bucketCount, window.previousBucketCount] as const;

  // Per window (0 = current, 1 = previous): money per bar and currency, and the totals.
  const perBucket = lengths.map((length) => Array.from({ length }, () => new Map<string, number>()));
  const perWindow = [new Map<string, number>(), new Map<string, number>()];
  const payments = [0, 0];
  const newSubscriptions = [0, 0];
  const newSubscriptionSeries = lengths.map((length) => zeroes(length));
  for (const row of rows.payments) {
    const side = row.previous === 1 ? 1 : 0;
    const amount = num(row.amount);
    perWindow[side]!.set(row.currency, (perWindow[side]!.get(row.currency) ?? 0) + amount);
    payments[side]! += row.payments;
    newSubscriptions[side]! += row.newSubscriptions;
    if (inRange(row.bucket, lengths[side])) {
      const bucket = perBucket[side]![row.bucket]!;
      bucket.set(row.currency, (bucket.get(row.currency) ?? 0) + amount);
      newSubscriptionSeries[side]![row.bucket]! += row.newSubscriptions;
    }
  }

  const payersWhole = [0, 0];
  const payerSeries = lengths.map((length) => zeroes(length));
  for (const row of rows.payers) {
    const side = row.previous === 1 ? 1 : 0;
    if (row.wholeWindow === 1) payersWhole[side] = row.payers;
    else if (inRange(row.bucket, lengths[side])) payerSeries[side]![row.bucket] = row.payers;
  }

  const newUserSeries = lengths.map((length) => zeroes(length));
  const newUsers = [0, 0];
  for (const row of rows.newUsers) {
    const side = row.previous === 1 ? 1 : 0;
    newUsers[side]! += row.users;
    if (inRange(row.bucket, lengths[side])) newUserSeries[side]![row.bucket]! += row.users;
  }

  const revenueFigures = perWindow.map((sums) => moneyFigure(view, sums));
  const bucketFigures = perBucket.map((buckets) => buckets.map((sums) => moneyFigure(view, sums)));
  const revenueSeries = bucketFigures.map((figures) => figures.map((figure) => figure.value));
  const arppuSeries = bucketFigures.map((figures, side) =>
    figures.map((figure, index) => arppuOf(view, figure, payerSeries[side]![index]!)),
  );

  // Paid subscriptions in force at the end of every current bar.
  const deltas = zeroes(window.bucketCount);
  let startCount = 0;
  for (const row of rows.activeSeries) {
    if (row.kind === 'start') startCount = row.count;
    else if (inRange(row.bucket, window.bucketCount)) deltas[row.bucket]! += row.kind === 'in' ? row.count : -row.count;
  }
  let running = startCount;
  const activeSeries = deltas.map((delta) => (running += delta));

  const snapshot = rows.subscriptions;
  const churn = {
    current: churnFigure(snapshot.churnBase, snapshot.churned),
    previous: churnFigure(snapshot.previousChurnBase, snapshot.previousChurned),
  };

  const funnelSteps = (['registered', 'activated', 'paid', 'repeat'] as const).map((key) => ({
    key,
    count: rows.funnel[key],
  }));
  const funnel: ConversionFunnelStepInterface[] = funnelSteps.map((step, index) => {
    const first = funnelSteps[0]!.count;
    const prev = index === 0 ? step.count : funnelSteps[index - 1]!.count;
    return {
      key: step.key,
      label: FUNNEL_LABELS[step.key],
      count: step.count,
      pctOfStart: first === 0 ? 0 : step.count / first,
      pctOfPrev: prev === 0 ? 0 : step.count / prev,
    };
  });

  const providers = assembleProviders(rows.providers, view);

  const period = describePeriod(window);
  const current = revenueFigures[0]!;
  const arppu = {
    current: arppuOf(view, current, payersWhole[0]!),
    previous: arppuOf(view, revenueFigures[1]!, payersWhole[1]!),
  };

  return {
    kpis: {
      windowDays: window.days,
      totalRevenue: current.value,
      paidCount: payments[0]!,
      payingUsers: payersWhole[0]!,
      arpu: rows.totalUsers === 0 ? 0 : current.value / rows.totalUsers,
      arppu: arppu.current ?? 0,
      activeSubscriptions: snapshot.activeNow,
      trialSubscriptions: snapshot.trialsNow,
      totalUsers: rows.totalUsers,
      newUsersInWindow: newUsers[0]!,
    },
    churn: {
      windowDays: window.days,
      prevActive: churn.current.base,
      stillActive: churn.current.base - churn.current.churned,
      churned: churn.current.churned,
      churnRate: churn.current.rate ?? 0,
      retentionRate: churn.current.rate === null ? 1 : 1 - churn.current.rate,
    },
    funnel,
    providers,
    daily: period.buckets.map((bucket, index) => ({
      date: bucket.from,
      revenue: revenueSeries[0]![index]!,
      newUsers: newUserSeries[0]![index]!,
      newSubscriptions: newSubscriptionSeries[0]![index]!,
    })),
    windowDays: window.days,
    generatedAt: window.now.toISOString(),
    period,
    money: view,
    metrics: {
      revenue: { current, previous: revenueFigures[1]! },
      payments: { current: payments[0]!, previous: payments[1]! },
      payingCustomers: { current: payersWhole[0]!, previous: payersWhole[1]! },
      arppu,
      newUsers: { current: newUsers[0]!, previous: newUsers[1]! },
      newSubscriptions: { current: newSubscriptions[0]!, previous: newSubscriptions[1]! },
      activeSubscriptions: { current: snapshot.activeNow, previous: snapshot.activeThen },
      trialSubscriptions: snapshot.trialsNow,
      churn,
    },
    partnerBalance: assemblePartnerBalance(view, rows.partnerBalance),
    series: {
      revenue: revenueSeries[0]!,
      payingCustomers: payerSeries[0]!,
      arppu: arppuSeries[0]!,
      newUsers: newUserSeries[0]!,
      newSubscriptions: newSubscriptionSeries[0]!,
      activeSubscriptions: activeSeries,
    },
    previousSeries: {
      revenue: revenueSeries[1]!,
      payingCustomers: payerSeries[1]!,
      arppu: arppuSeries[1]!,
      newUsers: newUserSeries[1]!,
      newSubscriptions: newSubscriptionSeries[1]!,
    },
  };
}

function assembleProviders(rows: readonly ProviderRow[], view: MoneyViewInterface): ProviderHealthInterface[] {
  interface Tally {
    completed: number;
    refundedInPart: number;
    refundedInFull: number;
    failed: number;
    canceled: number;
    pending: number;
    total: number;
    revenue: Map<string, number>;
  }
  const byGateway = new Map<string, Tally>();
  for (const row of rows) {
    const tally =
      byGateway.get(row.gateway) ??
      {
        completed: 0,
        refundedInPart: 0,
        refundedInFull: 0,
        failed: 0,
        canceled: 0,
        pending: 0,
        total: 0,
        revenue: new Map<string, number>(),
      };
    tally.total += row.count;
    tally.revenue.set(row.currency, (tally.revenue.get(row.currency) ?? 0) + num(row.amount));
    switch (row.outcome) {
      case 'completed':
        tally.completed += row.count;
        break;
      case 'completedRefundedInPart':
        tally.completed += row.count;
        tally.refundedInPart += row.count;
        break;
      case 'refunded':
        tally.refundedInFull += row.count;
        break;
      case 'failed':
        tally.failed += row.count;
        break;
      case 'canceled':
        tally.canceled += row.count;
        break;
      default:
        tally.pending += row.count;
        break;
    }
    byGateway.set(row.gateway, tally);
  }
  return [...byGateway.entries()]
    .map(([gatewayType, tally]): ProviderHealthInterface => {
      const paid = tally.completed + tally.refundedInFull;
      const decided = paid + tally.failed + tally.canceled;
      const revenueFigure = moneyFigure(view, tally.revenue);
      return {
        gatewayType,
        total: tally.total,
        paid,
        completed: tally.completed,
        refunded: tally.refundedInFull + tally.refundedInPart,
        failed: tally.failed,
        canceled: tally.canceled,
        pending: tally.pending,
        successRate: decided === 0 ? 0 : paid / decided,
        revenue: revenueFigure.value,
        revenueFigure,
      };
    })
    .sort((a, b) => b.revenue - a.revenue || b.total - a.total || a.gatewayType.localeCompare(b.gatewayType));
}
