/**
 * Type bundle for the analytics service. Lives in its own file so that
 * the service file can stay focused on aggregation queries without the
 * shape definitions getting in the way.
 */

export interface TimeSeriesPointInterface {
  readonly date: string;
  readonly value: number;
}

export interface RevenueByGatewayInterface {
  readonly gatewayType: string;
  readonly totalAmount: number;
  readonly transactionCount: number;
}

export interface UserGrowthInterface {
  readonly totalUsers: number;
  readonly newUsersToday: number;
  readonly newUsersThisWeek: number;
  readonly newUsersThisMonth: number;
  readonly blockedUsers: number;
}

export interface SubscriptionFunnelInterface {
  readonly active: number;
  readonly trial: number;
  readonly expired: number;
  readonly disabled: number;
  readonly deleted: number;
  readonly total: number;
}

export interface BusinessAnalyticsReportInterface {
  readonly userGrowth: UserGrowthInterface;
  readonly subscriptionFunnel: SubscriptionFunnelInterface;
  readonly revenueByGateway: readonly RevenueByGatewayInterface[];
  readonly dailyRevenue7d: readonly TimeSeriesPointInterface[];
  readonly dailyNewUsers7d: readonly TimeSeriesPointInterface[];
  readonly generatedAt: string;
}

// ── Phase 7 — Advanced types ─────────────────────────────────────────────

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

export interface ConversionFunnelStepInterface {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  /** Share of `start` (the first step) — always between 0 and 1. */
  readonly pctOfStart: number;
  /** Share of the previous step — measures step-to-step conversion. */
  readonly pctOfPrev: number;
}

export interface ProviderHealthInterface {
  readonly gatewayType: string;
  readonly total: number;
  readonly completed: number;
  readonly failed: number;
  readonly canceled: number;
  readonly successRate: number;
  readonly revenue: number;
}

export interface CohortRowInterface {
  /** `YYYY-MM` cohort label — month the user registered in. */
  readonly cohort: string;
  readonly cohortSize: number;
  /**
   * `retentionByMonth[i]` is the share of the cohort that placed at
   * least one COMPLETED transaction in the i-th calendar month after
   * signup (`i = 0` means the signup month itself).
   */
  readonly retentionByMonth: readonly number[];
}

export interface TopPayerInterface {
  readonly userId: string;
  readonly telegramId: string | null;
  readonly username: string | null;
  readonly name: string;
  readonly totalSpent: number;
  readonly transactionCount: number;
  readonly lastPaymentAt: string | null;
}

export interface LtvBucketInterface {
  /** Lower-bound of the bucket in major currency units (e.g. 0, 50, 100…). */
  readonly bound: number;
  readonly users: number;
}

export interface DailyMetricInterface {
  readonly date: string;
  readonly revenue: number;
  readonly newUsers: number;
  readonly newSubscriptions: number;
}

export interface AdvancedAnalyticsReportInterface {
  readonly kpis: KpiSummaryInterface;
  readonly churn: ChurnSnapshotInterface;
  readonly funnel: readonly ConversionFunnelStepInterface[];
  readonly providers: readonly ProviderHealthInterface[];
  readonly daily: readonly DailyMetricInterface[];
  readonly windowDays: number;
  readonly generatedAt: string;
}

// ── Phase 8 — Trial Conversion & Revenue Breakdown ───────────────────────────

export interface TrialConversionReport {
  readonly windowDays: number;
  readonly totalTrialUsers: number;
  readonly convertedUsers: number;
  readonly conversionRate: number;
  readonly avgDaysToConvert: number;
  readonly revenueFromConverted: number;
  readonly topConvertedPlans: readonly ConvertedPlanItem[];
}

export interface ConvertedPlanItem {
  readonly plan: string;
  readonly count: number;
  readonly percentage: number;
}

export interface RevenueByCurrencyItem {
  readonly currency: string;
  readonly revenue: number;
  readonly transactions: number;
  readonly percentage: number;
}

export interface SubscriptionByPlanItem {
  readonly plan: string;
  readonly active: number;
  readonly limited: number;
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
  /** Users seen on any surface within the last 30 days. */
  readonly activeLast30d: number;
  /** Users with any surface telemetry recorded. */
  readonly totalTracked: number;
  readonly generatedAt: string;
}
