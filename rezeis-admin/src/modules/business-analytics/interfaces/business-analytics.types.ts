/**
 * Type bundle for the analytics service. Lives in its own file so that
 * the service file can stay focused on aggregation queries without the
 * shape definitions getting in the way.
 *
 * MONEY IS NEVER ONE NUMBER ACROSS CURRENCIES. Every money figure a report
 * carries comes with the exact per-currency sums it was made of, and the
 * report's `money` view says which currency the single `value` is in and
 * whether amounts in other currencies were converted into it (with the
 * panel's own rates, `fx_rates`) or left out for want of a rate. See
 * `utils/analytics-money.util.ts`.
 *
 * MONEY IS MONEY RECEIVED: completed, for more than nothing, not paid from a
 * partner's balance, net of partial refunds — one rule for every money figure
 * (`utils/analytics-money-received.util.ts`).
 */

// ── Money ────────────────────────────────────────────────────────────────

/** An exact sum in one currency, in major units (roubles, dollars, coins). */
export interface CurrencyAmountInterface {
  readonly currency: string;
  readonly amount: number;
}

/** A rate the report converted with: 1 unit of `currency` = `rate` units of the view currency. */
export interface FxRateUsedInterface {
  readonly currency: string;
  readonly rate: number;
  readonly source: string;
  readonly fetchedAt: string;
}

/**
 * The currency a report's single numbers are in.
 *
 * One currency in the data: that currency, natively — nothing is converted,
 * whatever the reporting base is. Several: the panel's reporting base
 * (`REPORTING_BASE_CURRENCY`, RUB by default), every other currency converted
 * with the rate listed in `rates`; a currency with no rate on record is named
 * in `unconverted` and its amounts are in NO `value` of the report.
 */
export interface MoneyViewInterface {
  readonly currency: string;
  readonly converted: boolean;
  readonly rates: readonly FxRateUsedInterface[];
  readonly unconverted: readonly string[];
}

/** A money figure: its value in the view currency, and the exact sums it was made of. */
export interface MoneyFigureInterface {
  readonly value: number;
  readonly byCurrency: readonly CurrencyAmountInterface[];
}

/** One currency of a breakdown, with its amount in the view currency when it has one. */
export interface CurrencySliceInterface extends CurrencyAmountInterface {
  /** `amount` in the view currency; `null` when no rate could convert it. */
  readonly value: number | null;
}

/**
 * Purchases paid from a partner's balance in the window — NOT revenue (that
 * money was counted when the partner's referral paid), stated beside it.
 */
export interface PartnerBalanceSpendInterface {
  readonly figure: MoneyFigureInterface;
  readonly payments: number;
}

// ── Periods ──────────────────────────────────────────────────────────────

export type AnalyticsGranularity = 'day' | 'week' | 'month';

/** One bar of a time series: the local calendar days it covers, both ends included. */
export interface AnalyticsBucketLabelInterface {
  readonly from: string;
  readonly to: string;
}

/**
 * The window a report covers and the one it is compared with.
 *
 * Days are calendar days in the operator's time zone (`timeZone`), and every
 * date is a local `YYYY-MM-DD`. The current window is the last `windowDays`
 * days up to now; the previous one has the same number of days and ends at the
 * same local time `windowDays` days before now — so a window whose last day is
 * half over is compared with a window whose last day is half over.
 */
export interface AnalyticsPeriodInterface {
  readonly start: string;
  readonly end: string;
  readonly previousStart: string;
  readonly previousEnd: string;
  /** The IANA zone the days are counted in, or `UTC`. */
  readonly timeZone: string;
  /** The panel's time zone setting was empty or not a zone, so the days are UTC days. */
  readonly timeZoneFallback: boolean;
  readonly granularity: AnalyticsGranularity;
  readonly buckets: readonly AnalyticsBucketLabelInterface[];
  readonly previousBuckets: readonly AnalyticsBucketLabelInterface[];
}

/** A figure for the current window and the same figure for the previous one. */
export interface ComparedInterface<T> {
  readonly current: T;
  readonly previous: T;
}

// ── Phase 7 — Advanced types ─────────────────────────────────────────────

/**
 * The flat KPI block the page read before the 2026-09 rework. Still filled —
 * a panel tab left open across an update reads it — and every money field in
 * it is a `value` in the report's `money` view, never a raw cross-currency sum.
 */
export interface KpiSummaryInterface {
  readonly windowDays: number;
  readonly totalRevenue: number;
  readonly paidCount: number;
  readonly payingUsers: number;
  readonly arpu: number;
  /** Average revenue per paying user across the window. */
  readonly arppu: number;
  readonly activeSubscriptions: number;
  readonly trialSubscriptions: number;
  readonly totalUsers: number;
  readonly newUsersInWindow: number;
}

export interface ChurnSnapshotInterface {
  readonly windowDays: number;
  readonly prevActive: number;
  readonly stillActive: number;
  readonly churned: number;
  readonly churnRate: number;
  readonly retentionRate: number;
}

/**
 * Churn over one window: of the paid subscriptions in force when the window
 * opened (`base`), how many had a paid term that ended inside it and was not
 * extended past its end (`churned`). `rate` is `null` when there was nothing
 * to lose.
 */
export interface ChurnFigureInterface {
  readonly base: number;
  readonly churned: number;
  readonly rate: number | null;
}

export interface ConversionFunnelStepInterface {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  /** Share of `start` (the first step) — always between 0 and 1. */
  readonly pctOfStart: number;
  /** Share of the previous step — measures step-to-step conversion. */
  readonly pctOfPrev: number;
}

/**
 * One payment system over the window's checkouts: those that reached it — a
 * checkout for nothing never does, and a partner's balance is not one.
 */
export interface ProviderHealthInterface {
  readonly gatewayType: string;
  /** Every checkout started in the window, whatever became of it. */
  readonly total: number;
  /** Went through: paid — including those refunded since. */
  readonly paid: number;
  /** Paid and not refunded in full (a partial refund stays completed). */
  readonly completed: number;
  /** Of `paid`, the money was returned — in full or in part. */
  readonly refunded: number;
  readonly failed: number;
  /** Abandoned or declined before any money moved — never a refund. */
  readonly canceled: number;
  /** Still open: neither paid nor abandoned yet — not part of `successRate`. */
  readonly pending: number;
  /**
   * `paid / (paid + failed + canceled)` — of the checkouts that have an
   * outcome, the share that went through; `0` when none has one yet.
   */
  readonly successRate: number;
  /** `value` of `revenueFigure` — kept for a tab left open across an update. */
  readonly revenue: number;
  /** Money received through the system, net of refunds. */
  readonly revenueFigure: MoneyFigureInterface;
}

export interface CohortRowInterface {
  /** `YYYY-MM` cohort label — the local month the customers registered in. */
  readonly cohort: string;
  readonly cohortSize: number;
  /**
   * `retentionByMonth[i]` is the share of the cohort that paid (money
   * received, after registering) in the i-th calendar month after signup
   * (`i = 0` means the signup month itself).
   */
  readonly retentionByMonth: readonly number[];
}

export interface TopPayerInterface {
  readonly userId: string;
  readonly telegramId: string | null;
  readonly username: string | null;
  readonly name: string;
  /**
   * Lifetime money received from the customer, in the report's money view;
   * `null` when none of it can be converted (all of it in a currency with no
   * rate) — `spentByCurrency` still says how much of what.
   */
  readonly totalSpent: number | null;
  readonly spentByCurrency: readonly CurrencyAmountInterface[];
  readonly transactionCount: number;
  readonly lastPaymentAt: string | null;
}

export interface TopPayersReportInterface {
  readonly payers: readonly TopPayerInterface[];
  readonly money: MoneyViewInterface;
}

export interface LtvBucketInterface {
  /** Lower bound of the bucket in the view currency (kept under its old name). */
  readonly bound: number;
  readonly from: number;
  /** Upper bound, exclusive; `null` for the last bucket, which is open. */
  readonly to: number | null;
  readonly users: number;
}

export interface LtvReportInterface {
  readonly buckets: readonly LtvBucketInterface[];
  readonly money: MoneyViewInterface;
  readonly stats: {
    readonly payers: number;
    readonly mean: number | null;
    readonly median: number | null;
    readonly p90: number | null;
  };
}

export interface DailyMetricInterface {
  readonly date: string;
  readonly revenue: number;
  readonly newUsers: number;
  readonly newSubscriptions: number;
}

/** The KPI tiles of «Обзор», each against the previous window of the same length. */
export interface OverviewMetricsInterface {
  readonly revenue: ComparedInterface<MoneyFigureInterface>;
  readonly payments: ComparedInterface<number>;
  readonly payingCustomers: ComparedInterface<number>;
  /** Revenue per paying customer; `null` with no payers, or while any revenue is unconverted. */
  readonly arppu: ComparedInterface<number | null>;
  readonly newUsers: ComparedInterface<number>;
  /** Payments that began a paying subscription: NEW, another subscription, a trial's first payment. */
  readonly newSubscriptions: ComparedInterface<number>;
  /** Subscriptions on a paid plan whose paid term runs, at the end of each window — however they were paid. */
  readonly activeSubscriptions: ComparedInterface<number>;
  /** Trial subscriptions in force now. */
  readonly trialSubscriptions: number;
  readonly churn: ComparedInterface<ChurnFigureInterface>;
}

/** Per-bucket series, aligned with `period.buckets` (or `previousBuckets`). */
export interface OverviewSeriesInterface {
  readonly revenue: readonly number[];
  readonly payingCustomers: readonly number[];
  readonly arppu: readonly (number | null)[];
  readonly newUsers: readonly number[];
  readonly newSubscriptions: readonly number[];
}

/** The current window's series, and the paid subscriptions in force at the end of each bar (the last one: now). */
export interface OverviewCurrentSeriesInterface extends OverviewSeriesInterface {
  readonly activeSubscriptions: readonly number[];
}

export interface AdvancedAnalyticsReportInterface {
  readonly kpis: KpiSummaryInterface;
  readonly churn: ChurnSnapshotInterface;
  readonly funnel: readonly ConversionFunnelStepInterface[];
  readonly providers: readonly ProviderHealthInterface[];
  readonly daily: readonly DailyMetricInterface[];
  readonly windowDays: number;
  readonly generatedAt: string;
  readonly period: AnalyticsPeriodInterface;
  readonly money: MoneyViewInterface;
  readonly metrics: OverviewMetricsInterface;
  /** Paid from a partner's balance in the current window — not in `metrics.revenue`. */
  readonly partnerBalance: PartnerBalanceSpendInterface;
  readonly series: OverviewCurrentSeriesInterface;
  readonly previousSeries: OverviewSeriesInterface;
}

// ── Revenue ──────────────────────────────────────────────────────────────

/**
 * What a payment's money paid for: `renewal` (RENEW), `addon` (an ADDITIONAL
 * payment whose snapshot is `ADDON_PURCHASE`), `new` (NEW, another
 * subscription, and the first money a subscription ever brought in — a trial
 * turned paid) and `change` (an UPGRADE of a subscription that had already
 * brought money in).
 */
export type PurchaseKind = 'new' | 'renewal' | 'change' | 'addon';

export interface RevenueSeriesPointInterface {
  readonly total: number;
  readonly byCurrency: readonly CurrencySliceInterface[];
  readonly byKind: Readonly<Record<PurchaseKind, number>>;
}

export interface RevenueKindInterface {
  readonly kind: PurchaseKind;
  readonly figure: MoneyFigureInterface;
  readonly payments: number;
}

/**
 * Revenue of one plan. `kind` `addon` is every standalone add-on purchase
 * together; `none` is money no plan is recorded for (an imported payment, a
 * snapshot without an id). A combined renewal's total is shared among its
 * lines in proportion to their prices, so the rows add up to the total.
 */
export interface RevenuePlanInterface {
  readonly key: string;
  readonly kind: 'plan' | 'addon' | 'none';
  readonly planId: string | null;
  readonly name: string | null;
  readonly figure: MoneyFigureInterface;
  readonly payments: number;
}

export interface RevenueGatewayInterface {
  readonly gatewayType: string;
  readonly figure: MoneyFigureInterface;
  readonly payments: number;
}

export interface RevenueReportInterface {
  readonly windowDays: number;
  readonly generatedAt: string;
  readonly period: AnalyticsPeriodInterface;
  readonly money: MoneyViewInterface;
  readonly total: MoneyFigureInterface;
  readonly payments: number;
  readonly byCurrency: readonly (CurrencySliceInterface & { readonly payments: number })[];
  readonly series: readonly RevenueSeriesPointInterface[];
  readonly byKind: readonly RevenueKindInterface[];
  readonly byPlan: readonly RevenuePlanInterface[];
  readonly byGateway: readonly RevenueGatewayInterface[];
  /** Paid from a partner's balance in the window — not in `total`. */
  readonly partnerBalance: PartnerBalanceSpendInterface;
}

// ── Expiring ─────────────────────────────────────────────────────────────

/**
 * Subscriptions whose term ends on one local day of the coming month, split by
 * what will happen: `autopay` — auto-renew will charge the owner's card;
 * `manual` — nothing will be charged (every LIMITED subscription among them);
 * `trial` — a trial ending, which is never charged.
 */
export interface ExpiringDayInterface {
  readonly date: string;
  readonly autopay: number;
  readonly manual: number;
  readonly trial: number;
}

export interface ExpiringReportInterface {
  readonly generatedAt: string;
  /** The zone the days are counted in, as in `AnalyticsPeriodInterface`. */
  readonly timeZone: string;
  readonly timeZoneFallback: boolean;
  readonly horizonDays: number;
  readonly days: readonly ExpiringDayInterface[];
  readonly totals: { readonly autopay: number; readonly manual: number; readonly trial: number };
}

// ── Phase 8 — Trial Conversion & Revenue Breakdown ───────────────────────────

/** Days from a start to the first payment, as whole days elapsed. */
export type DaysToPayBucket = 'd0' | 'd1_3' | 'd4_7' | 'd8_14' | 'd15_30' | 'd31_plus';

export interface DaysToPayCountInterface {
  readonly key: DaysToPayBucket;
  readonly users: number;
}

export interface TrialConversionReport {
  readonly windowDays: number;
  /** The zone the window's days are counted in, as in `AnalyticsPeriodInterface`. */
  readonly timeZone: string;
  readonly timeZoneFallback: boolean;
  readonly totalTrialUsers: number;
  readonly convertedUsers: number;
  readonly conversionRate: number;
  readonly avgDaysToConvert: number;
  readonly medianDaysToConvert: number | null;
  /** `value` of everything converted trial users paid after their trial — kept as a number. */
  readonly revenueFromConverted: number;
  readonly revenueFromConvertedByCurrency: readonly CurrencyAmountInterface[];
  readonly money: MoneyViewInterface;
  /** Trial grant → first payment after it. */
  readonly daysToConvert: readonly DaysToPayCountInterface[];
  readonly topConvertedPlans: readonly ConvertedPlanItem[];
  /** Registration → first payment ever, for customers who first paid in the window. */
  readonly firstPayment: {
    readonly payers: number;
    readonly medianDays: number | null;
    readonly buckets: readonly DaysToPayCountInterface[];
  };
}

export interface ConvertedPlanItem {
  /** The plan's name, or `''` when the payment names none. */
  readonly plan: string;
  readonly planId: string | null;
  readonly kind: 'plan' | 'addon' | 'none';
  readonly count: number;
  readonly percentage: number;
}

export interface SubscriptionByPlanItem {
  /** The plan's latest recorded name, or `''` when none is recorded. */
  readonly plan: string;
  readonly planId: string | null;
  readonly active: number;
  readonly limited: number;
  /** Of `total`, how many are trials. */
  readonly trial: number;
  readonly total: number;
  readonly percentage: number;
}

// ── Usage surfaces (where/how users access the cabinet) ──────────────────────

export interface SurfaceCountInterface {
  /** Bucket key — surface (tma/pwa/browser), form factor or OS. */
  readonly key: string;
  readonly count: number;
}

export interface UsageSurfaceReportInterface {
  /** Latest surface per user: `tma` | `pwa` | `browser`. */
  readonly surfaces: readonly SurfaceCountInterface[];
  /** Latest form factor per user: `mobile` | `tablet` | `desktop`. */
  readonly formFactors: readonly SurfaceCountInterface[];
  /** Latest OS per user: `ios`/`android`/`windows`/`macos`/`linux`/`other`. */
  readonly operatingSystems: readonly SurfaceCountInterface[];
  /** Users who have ever opened the cabinet as an installed PWA. */
  readonly pwaInstalls: number;
  /**
   * The same users by the OS the installed app was opened on: the first open
   * (`users.pwa_installed_os`), else the latest visit when it was from the app,
   * else `unknown`. Adds up to `pwaInstalls`. See
   * `utils/usage-surface-report.util.ts` for what is recorded and since when.
   */
  readonly pwaInstallsByOs: readonly SurfaceCountInterface[];
  /** Users seen on any surface within the last 30 days. */
  readonly activeLast30d: number;
  /** Users with any surface telemetry recorded. */
  readonly totalTracked: number;
  readonly generatedAt: string;
}
