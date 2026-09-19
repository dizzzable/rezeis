/**
 * «Платежи» → «Аналитика», the providers half: per gateway, what became of the
 * checkouts started in the window and the money that came in — as SQL
 * aggregates and one pure function that puts them together.
 *
 * ONE RULE WITH «Бизнес-аналитика». Until 2026-09 this report dated every
 * checkout by `updated_at` and summed `amount` across currencies: after a
 * Bedolaga import the «30 дней» window held the whole imported year, and
 * 1 000 RUB + 10 USDT read «1010». Now:
 *
 *   - a checkout belongs to the time it STARTED, `created_at` — see
 *     `analytics-overview.util.ts` for why never `updated_at` (every importer
 *     leaves it at the import; an account merge and a tax-receipt
 *     registration rewrite it later). No figure here reads it: a checkout is
 *     stuck when it is still pending an hour after it STARTED
 *     ({@link stuckPendingSql} says why not "untouched for an hour"), and how
 *     long a payment took to settle is `fulfilled_at − created_at`, over the
 *     payments CREATED in the window ({@link timeToPaySql});
 *   - money is money received (`analytics-money-received.util.ts`): completed,
 *     for more than nothing, not from a partner's balance, net of a partial
 *     refund — summed per currency and stated in one view
 *     (`analytics-money.util.ts`), never added across currencies;
 *   - the window, the previous one it is compared with and the days are the
 *     operator's local days (`analytics-window.util.ts`), bound through the
 *     same SQL helpers — which is what keeps a database whose own time zone is
 *     not UTC from shifting them (Prisma's pg adapter sends a `Date` as UTC
 *     wall time with no offset).
 *
 * WHICH CHECKOUTS. Every checkout for more than nothing. One for nothing (a
 * 100 % promo code) completes without reaching any gateway; counted, it would
 * credit the gateway it names with a success — and a settle time of zero — it
 * never saw. A partner's balance is not a gateway that brings money in, but it
 * keeps a row of its own for its health; its money is the report's
 * `partnerBalance`, never revenue.
 *
 * HOW A CHECKOUT ENDED — `paymentOutcomeSql` of
 * `analytics-money-received.util.ts`, the one «Обзор» → «Платёжные системы»
 * counts by too. A full refund is a checkout that WENT THROUGH and was
 * refunded — reconciliation writes it CANCELED stamped `refundReversedAt` — so
 * it is neither a cancellation nor a failure reason; a partial refund leaves
 * the payment completed.
 *
 * Nothing here loads rows into memory: every statement returns counts and sums.
 */
import { type PaymentGatewayType, Prisma } from '@prisma/client';

import type {
  CurrencyAmountInterface,
  MoneyFigureInterface,
  MoneyViewInterface,
} from '../../business-analytics/interfaces/business-analytics.types';
import {
  moneyReceivedSql,
  netAmountSql,
  type PaymentOutcome,
  paymentOutcomeSql,
} from '../../business-analytics/utils/analytics-money-received.util';
import { chooseMoneyView, type FxSnapshot, hasUnconverted, moneyFigure } from '../../business-analytics/utils/analytics-money.util';
import { assemblePartnerBalance, type PartnerBalanceRow } from '../../business-analytics/utils/analytics-overview.util';
import {
  type AnalyticsWindowInterface,
  bothWindowsSql,
  bucketIndexSql,
  bucketLabels,
  isPreviousSql,
} from '../../business-analytics/utils/analytics-window.util';
import type {
  PaymentProvidersReportInterface,
  ProviderDetailInterface,
  ProviderFailureReasonInterface,
} from '../interfaces/payment-analytics.types';

type SqlNumeric = Prisma.Decimal | string | number | bigint | null;

const num = (value: SqlNumeric | undefined): number => (value === null || value === undefined ? 0 : Number(value));

/** A checkout's time: when it started. */
const STARTED_AT = Prisma.sql`t."created_at"`;

/** A checkout that can reach a gateway — one for nothing never does. */
const REACHES_A_GATEWAY = Prisma.sql`t."amount" > 0`;

/** The money a row brings in: money received, net of a partial refund — else nothing. */
function receivedSql(): Prisma.Sql {
  return Prisma.sql`SUM(CASE WHEN ${moneyReceivedSql()} THEN ${netAmountSql()} ELSE 0 END)`;
}

// ── Statements ───────────────────────────────────────────────────────────

export interface ProviderWindowRow {
  /** `1` for the previous window, `0` for the current one. */
  readonly previous: number;
  readonly gateway: string;
  readonly outcome: PaymentOutcome;
  readonly currency: string;
  readonly checkouts: number;
  /** Of them, money received. */
  readonly payments: number;
  /** Their money, net of partial refunds. */
  readonly amount: SqlNumeric;
}

/** Checkouts started in both windows, per window, gateway, outcome and currency, with the money received. */
export function providerWindowsSql(window: AnalyticsWindowInterface): Prisma.Sql {
  return Prisma.sql`
    SELECT ${isPreviousSql(STARTED_AT, window)}::int AS "previous",
           t."gateway_type"::text AS "gateway",
           ${paymentOutcomeSql()} AS "outcome",
           t."currency"::text AS "currency",
           COUNT(*)::int AS "checkouts",
           COUNT(*) FILTER (WHERE ${moneyReceivedSql()})::int AS "payments",
           ${receivedSql()} AS "amount"
      FROM "transactions" t
     WHERE ${REACHES_A_GATEWAY} AND ${bothWindowsSql(STARTED_AT, window)}
     GROUP BY 1, 2, 3, 4`;
}

export interface ProviderDayRow {
  /** The local day, counted from the window's first. */
  readonly day: number;
  readonly gateway: string;
  readonly currency: string;
  readonly checkouts: number;
  /** Of them, went through: completed, or refunded since. */
  readonly paid: number;
  readonly amount: SqlNumeric;
}

/** The window cut into local days, whatever its length: the tab draws one point a day even for 90 days. */
function dailyWindow(window: AnalyticsWindowInterface): AnalyticsWindowInterface {
  return { ...window, granularity: 'day', bucketCount: window.days, previousBucketCount: window.days };
}

/** The current window per local day, gateway and currency. */
export function providerDaysSql(window: AnalyticsWindowInterface): Prisma.Sql {
  return Prisma.sql`
    SELECT ${bucketIndexSql(STARTED_AT, dailyWindow(window))} AS "day",
           t."gateway_type"::text AS "gateway",
           t."currency"::text AS "currency",
           COUNT(*)::int AS "checkouts",
           COUNT(*) FILTER (WHERE ${paymentOutcomeSql()} IN ('completed', 'refunded'))::int AS "paid",
           ${receivedSql()} AS "amount"
      FROM "transactions" t
     WHERE ${REACHES_A_GATEWAY} AND ${STARTED_AT} >= ${window.start}
     GROUP BY 1, 2, 3`;
}

export interface TimeToPayRow {
  readonly gateway: string;
  readonly median: number | null;
  readonly p95: number | null;
}

/**
 * How long a payment took to settle: from its checkout's start to its
 * fulfilment, `fulfilled_at − created_at`, over the completed payments
 * CREATED in the window.
 *
 * WHY `fulfilled_at`. It is the settle stamp: the moment the confirmed payment
 * was claimed for delivery — a conditional update from NULL in
 * `PaymentReconciliationService` — re-stamped in the transaction that delivered
 * it (`PaymentSubscriptionMutationService`), cleared only when a delivery
 * failed and stamped anew by the retry that succeeded. Nothing writes it after.
 * `updated_at` is the LAST write, and a settled payment is written again —
 * a tax receipt registered after it, an account merge, a partial refund —
 * each of which moved the old figure by hours or days. Both columns are
 * written by Prisma from a JS `Date`, so on a database whose own time zone is
 * not UTC both carry the adapter's shift and their difference is exact
 * (measured: 0.004 s either way, while `now() − created_at` read 10 800 s).
 *
 * A completed payment with no `fulfilled_at` yet — its delivery still pending —
 * has no settle time: its difference is NULL, which `PERCENTILE_CONT` skips. It
 * is neither 0 s nor a crash; the page's (i) says it is left out.
 *
 * Imported payments are left out by their mark, not by the stamp: an importer
 * writes the donor's dates, and a backfill stamps `fulfilled_at = created_at`
 * on imported COMPLETED rows — 0 s each, a time no gateway of this panel took.
 */
export function timeToPaySql(window: AnalyticsWindowInterface): Prisma.Sql {
  const seconds = Prisma.sql`EXTRACT(EPOCH FROM (t."fulfilled_at" - t."created_at"))`;
  return Prisma.sql`
    SELECT t."gateway_type"::text AS "gateway",
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${seconds}) AS "median",
           PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ${seconds}) AS "p95"
      FROM "transactions" t
     WHERE t."status" = 'COMPLETED' AND ${REACHES_A_GATEWAY} AND ${STARTED_AT} >= ${window.start}
       AND t."plan_snapshot"->>'importedFrom' IS NULL
     GROUP BY 1`;
}

export interface StuckPendingRow {
  readonly gateway: string;
  readonly stuck: number;
}

/**
 * Checkouts still PENDING and STARTED before `cutoff` (an hour ago), whenever
 * that was.
 *
 * NOT "untouched for an hour". The pending sweep (`PaymentPendingExpiryService`,
 * every 5 minutes) re-stamps `updated_at` on each YooKassa payment the provider
 * still reports as `pending` or `waiting_for_capture` — so those, the ones
 * stuck longest, never aged and were never counted. And the sweep cancels an
 * abandoned checkout 30 minutes after it started; what is still pending an
 * hour after its start really is stuck: still open at the provider, held for an
 * operator's review, or not answered when the panel asked.
 */
export function stuckPendingSql(cutoff: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT t."gateway_type"::text AS "gateway", COUNT(*)::int AS "stuck"
      FROM "transactions" t
     WHERE t."status" = 'PENDING' AND ${REACHES_A_GATEWAY} AND ${STARTED_AT} < ${cutoff}
     GROUP BY 1`;
}

export interface ChannelRow {
  readonly gateway: string;
  readonly channel: string;
  readonly checkouts: number;
}

export function channelMixSql(window: AnalyticsWindowInterface): Prisma.Sql {
  return Prisma.sql`
    SELECT t."gateway_type"::text AS "gateway", t."channel"::text AS "channel", COUNT(*)::int AS "checkouts"
      FROM "transactions" t
     WHERE ${REACHES_A_GATEWAY} AND ${STARTED_AT} >= ${window.start}
     GROUP BY 1, 2`;
}

export interface FailureReasonRow {
  readonly gateway: string;
  readonly reason: string | null;
  readonly count: number;
}

/**
 * The five commonest reasons per gateway among its failed and canceled
 * checkouts of the window — exactly the ones its `failed` and `canceled`
 * count, so a share is of all of them. A refund is not a failure.
 */
export function failureReasonsSql(window: AnalyticsWindowInterface): Prisma.Sql {
  const reason = Prisma.sql`COALESCE(NULLIF(t."gateway_data"->>'providerStatus', ''), t."status"::text)`;
  return Prisma.sql`
    SELECT "gateway", "reason", "count"
      FROM (
        SELECT t."gateway_type"::text AS "gateway", ${reason} AS "reason", COUNT(*)::int AS "count",
               ROW_NUMBER() OVER (PARTITION BY t."gateway_type" ORDER BY COUNT(*) DESC, ${reason}) AS "rank"
          FROM "transactions" t
         WHERE ${REACHES_A_GATEWAY} AND ${STARTED_AT} >= ${window.start}
           AND ${paymentOutcomeSql()} IN ('failed', 'canceled')
         GROUP BY t."gateway_type", ${reason}
      ) AS "ranked"
     WHERE "rank" <= 5
     ORDER BY "gateway", "count" DESC, "reason"`;
}

// ── Assembly ─────────────────────────────────────────────────────────────

/** A gateway of the catalog, as the report needs it. */
export interface GatewayCatalogEntry {
  readonly type: PaymentGatewayType;
  readonly isActive: boolean;
  readonly currency: string;
}

export interface ProviderReportRows {
  readonly windows: readonly ProviderWindowRow[];
  readonly days: readonly ProviderDayRow[];
  readonly timeToPay: readonly TimeToPayRow[];
  readonly stuck: readonly StuckPendingRow[];
  readonly channels: readonly ChannelRow[];
  /** Reasons already redacted by the caller. */
  readonly failures: readonly FailureReasonRow[];
  /** `partnerBalanceSql` of `analytics-overview.util.ts`, for the current window. */
  readonly partnerBalance: readonly PartnerBalanceRow[];
}

/**
 * A partner's balance: spends money the panel counted when the partner's
 * referral paid. `moneyReceivedSql` leaves it out of every sum; this is the
 * same fact for the row that says so.
 */
const NOT_REVENUE: ReadonlySet<string> = new Set(['PARTNER_BALANCE']);

interface Tally {
  checkouts: number;
  completed: number;
  refunded: number;
  canceled: number;
  failed: number;
  pending: number;
  payments: number;
  readonly money: Map<string, number>;
}

function emptyTally(): Tally {
  return { checkouts: 0, completed: 0, refunded: 0, canceled: 0, failed: 0, pending: 0, payments: 0, money: new Map() };
}

function add(map: Map<string, number>, key: string, amount: number): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function tally(tallies: Map<string, Tally>, gateway: string): Tally {
  let entry = tallies.get(gateway);
  if (entry === undefined) {
    entry = emptyTally();
    tallies.set(gateway, entry);
  }
  return entry;
}

function paidOf(entry: Tally): number {
  return entry.completed + entry.refunded;
}

function decidedOf(entry: Tally): number {
  return paidOf(entry) + entry.failed + entry.canceled;
}

/**
 * The average payment: in the view currency when all of the money converts
 * into it; natively when all of it is in one currency the view cannot convert
 * (Telegram Stars without a rate); else — money in a currency without a rate
 * next to another — `null`, rather than an average of the part that converts.
 */
function averagePayment(view: MoneyViewInterface, figure: MoneyFigureInterface, payments: number): CurrencyAmountInterface | null {
  if (payments === 0) return null;
  if (!hasUnconverted(view, figure)) return { currency: view.currency, amount: figure.value / payments };
  const [only] = figure.byCurrency;
  if (figure.byCurrency.length === 1 && only !== undefined) return { currency: only.currency, amount: only.amount / payments };
  return null;
}

function inRange(index: number, length: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < length;
}

export function assembleProviderReport(
  window: AnalyticsWindowInterface,
  rows: ProviderReportRows,
  catalog: readonly GatewayCatalogEntry[],
  fx: FxSnapshot,
): PaymentProvidersReportInterface {
  // One view for everything the report states, both windows alike.
  const view = chooseMoneyView(
    rows.windows.filter((row) => num(row.amount) !== 0).map((row) => row.currency),
    fx,
  );

  const windows = [new Map<string, Tally>(), new Map<string, Tally>()] as const;
  const totalMoney = new Map<string, number>();
  let totalPayments = 0;
  for (const row of rows.windows) {
    const side = row.previous === 1 ? 1 : 0;
    const entry = tally(windows[side], row.gateway);
    entry.checkouts += row.checkouts;
    switch (row.outcome) {
      case 'completed':
        entry.completed += row.checkouts;
        break;
      case 'refunded':
        entry.refunded += row.checkouts;
        break;
      case 'canceled':
        entry.canceled += row.checkouts;
        break;
      case 'failed':
        entry.failed += row.checkouts;
        break;
      default:
        entry.pending += row.checkouts;
        break;
    }
    entry.payments += row.payments;
    add(entry.money, row.currency, num(row.amount));
    if (side === 0) {
      add(totalMoney, row.currency, num(row.amount));
      totalPayments += row.payments;
    }
  }

  const labels = bucketLabels('day', window.startDay, window.lastDay, window.days).map((label) => label.from);
  const days = new Map<string, Array<{ checkouts: number; paid: number; money: Map<string, number> }>>();
  for (const row of rows.days) {
    if (!inRange(row.day, labels.length)) continue;
    let series = days.get(row.gateway);
    if (series === undefined) {
      series = labels.map(() => ({ checkouts: 0, paid: 0, money: new Map<string, number>() }));
      days.set(row.gateway, series);
    }
    const point = series[row.day]!;
    point.checkouts += row.checkouts;
    point.paid += row.paid;
    add(point.money, row.currency, num(row.amount));
  }

  const timeToPay = new Map(rows.timeToPay.map((row) => [row.gateway, row]));
  const stuck = new Map(rows.stuck.map((row) => [row.gateway, row.stuck]));
  const channels = new Map<string, { web: number; telegram: number; total: number }>();
  for (const row of rows.channels) {
    const entry = channels.get(row.gateway) ?? { web: 0, telegram: 0, total: 0 };
    entry.total += row.checkouts;
    if (row.channel === 'WEB') entry.web += row.checkouts;
    else entry.telegram += row.checkouts;
    channels.set(row.gateway, entry);
  }
  const failures = new Map<string, FailureReasonRow[]>();
  for (const row of rows.failures) {
    const list = failures.get(row.gateway) ?? [];
    list.push(row);
    failures.set(row.gateway, list);
  }

  const detail = (gatewayType: string, catalogEntry: GatewayCatalogEntry | undefined): ProviderDetailInterface => {
    const current = windows[0].get(gatewayType) ?? emptyTally();
    const previous = windows[1].get(gatewayType);
    const paid = paidOf(current);
    const decided = decidedOf(current);
    const successRate = decided === 0 ? 0 : paid / decided;
    const revenue = moneyFigure(view, current.money);
    const previousRevenue = previous === undefined ? 0 : moneyFigure(view, previous.money).value;
    const previousDecided = previous === undefined ? 0 : decidedOf(previous);
    const failedOrCanceled = current.failed + current.canceled;
    const reasons: ProviderFailureReasonInterface[] = (failures.get(gatewayType) ?? []).slice(0, 5).map((row) => ({
      reason: row.reason ?? 'unknown',
      count: row.count,
      share: failedOrCanceled === 0 ? 0 : row.count / failedOrCanceled,
    }));
    const channel = channels.get(gatewayType);
    const time = timeToPay.get(gatewayType);
    const series = days.get(gatewayType);
    return {
      gatewayType: gatewayType as PaymentGatewayType,
      isActive: catalogEntry?.isActive ?? false,
      currency: catalogEntry?.currency ?? 'USD',
      countsAsRevenue: !NOT_REVENUE.has(gatewayType),
      transactions: current.checkouts,
      completed: current.completed,
      refunded: current.refunded,
      pending: current.pending,
      failed: current.failed,
      canceled: current.canceled,
      revenue,
      payments: current.payments,
      averagePayment: averagePayment(view, revenue, current.payments),
      successRate,
      checkoutRate: current.checkouts === 0 ? 0 : paid / current.checkouts,
      medianTimeToPaySeconds: time?.median === null || time?.median === undefined ? null : Number(time.median),
      p95TimeToPaySeconds: time?.p95 === null || time?.p95 === undefined ? null : Number(time.p95),
      stuckPending: stuck.get(gatewayType) ?? 0,
      delta: {
        revenuePct: previousRevenue === 0 ? null : (revenue.value - previousRevenue) / previousRevenue,
        transactionsPct:
          previous === undefined || previous.checkouts === 0 ? null : (current.checkouts - previous.checkouts) / previous.checkouts,
        successRateDelta:
          decided === 0 || previous === undefined || previousDecided === 0 ? null : successRate - paidOf(previous) / previousDecided,
      },
      daily: labels.map((day, index) => {
        const point = series?.[index];
        return {
          day,
          revenueValue: point === undefined ? 0 : moneyFigure(view, point.money).value,
          transactions: point?.checkouts ?? 0,
          successful: point?.paid ?? 0,
        };
      }),
      topFailureReasons: reasons,
      channelMix:
        channel === undefined || channel.total === 0
          ? { web: 0, telegram: 0 }
          : { web: channel.web / channel.total, telegram: channel.telegram / channel.total },
    };
  };

  // The catalog first, then any type the window or a stuck checkout names that
  // has no catalog row — a partner's balance never has one.
  const listed = new Set<string>();
  const providers: ProviderDetailInterface[] = [];
  for (const entry of catalog) {
    if (listed.has(entry.type)) continue;
    listed.add(entry.type);
    providers.push(detail(entry.type, entry));
  }
  for (const gatewayType of [...windows[0].keys(), ...windows[1].keys(), ...stuck.keys()]) {
    if (listed.has(gatewayType)) continue;
    listed.add(gatewayType);
    providers.push(detail(gatewayType, undefined));
  }
  providers.sort(
    (a, b) => b.revenue.value - a.revenue.value || b.transactions - a.transactions || a.gatewayType.localeCompare(b.gatewayType),
  );

  // The totals are the payment systems'. A partner's balance keeps its row and
  // its own line, and stays out of them: counted, its purchases — which always
  // "succeed" — lifted «Конверсия» (YooKassa 1 paid of 2 read 75 % beside two
  // balance purchases, not 50 %).
  const currentTallies = [...windows[0].entries()]
    .filter(([gateway]) => !NOT_REVENUE.has(gateway))
    .map(([, entry]) => entry);
  return {
    windowDays: window.days,
    windowStart: window.start.toISOString(),
    previousWindowStart: window.previousStart.toISOString(),
    previousWindowEnd: window.previousEnd.toISOString(),
    generatedAt: window.now.toISOString(),
    timeZone: window.zone.name,
    timeZoneFallback: window.zone.fallback,
    money: view,
    revenue: moneyFigure(view, totalMoney),
    payments: totalPayments,
    partnerBalance: assemblePartnerBalance(view, rows.partnerBalance),
    totalTransactions: currentTallies.reduce((sum, entry) => sum + entry.checkouts, 0),
    totalCompleted: currentTallies.reduce((sum, entry) => sum + entry.completed, 0),
    totalPaid: currentTallies.reduce((sum, entry) => sum + paidOf(entry), 0),
    providers,
  };
}
