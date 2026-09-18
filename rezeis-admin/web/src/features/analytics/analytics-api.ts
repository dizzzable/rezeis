import { api } from '@/lib/api'
import { expectArray, isRecord, unwrapPayload } from '@/lib/api-utils'

// ── Types ────────────────────────────────────────────────────────────────────
//
// Field for field the backend's `interfaces/business-analytics.types.ts`, the
// `…Interface` suffix dropped: `analytics-reports-wire-contract.test.ts` reads
// both files and holds them together.

/** An exact sum in one currency, in major units (roubles, dollars, coins). */
export interface CurrencyAmount {
  currency: string
  amount: number
}

/** A rate the report converted with: 1 unit of `currency` = `rate` units of the view currency. */
export interface FxRateUsed {
  currency: string
  rate: number
  source: string
  fetchedAt: string
}

/**
 * The currency a report's single numbers are in: the only currency there is,
 * natively; or, with several, the panel's reporting base with every other
 * currency converted at the listed rate. `unconverted` currencies have no rate
 * and are in no `value` of the report.
 */
export interface MoneyView {
  currency: string
  converted: boolean
  rates: readonly FxRateUsed[]
  unconverted: readonly string[]
}

/** A money figure: its value in the view currency, and the exact sums it was made of. */
export interface MoneyFigure {
  value: number
  byCurrency: readonly CurrencyAmount[]
}

export interface CurrencySlice extends CurrencyAmount {
  value: number | null
}

/** Paid from a partner's balance in the window — not revenue; stated beside it. */
export interface PartnerBalanceSpend {
  figure: MoneyFigure
  payments: number
}

export type AnalyticsGranularity = 'day' | 'week' | 'month'

/** One bar: the local calendar days it covers, both ends included. */
export interface AnalyticsBucketLabel {
  from: string
  to: string
}

export interface AnalyticsPeriod {
  start: string
  end: string
  previousStart: string
  previousEnd: string
  /** The IANA zone the days are counted in, or `UTC`. */
  timeZone: string
  /** The panel's time zone setting was empty or not a zone, so the days are UTC days. */
  timeZoneFallback: boolean
  granularity: AnalyticsGranularity
  buckets: readonly AnalyticsBucketLabel[]
  previousBuckets: readonly AnalyticsBucketLabel[]
}

export interface Compared<T> {
  current: T
  previous: T
}

export interface KpiSummary {
  windowDays: number
  totalRevenue: number
  paidCount: number
  payingUsers: number
  arpu: number
  arppu: number
  activeSubscriptions: number
  trialSubscriptions: number
  totalUsers: number
  newUsersInWindow: number
}

export interface ChurnSnapshot {
  windowDays: number
  prevActive: number
  stillActive: number
  churned: number
  churnRate: number
  retentionRate: number
}

export interface ChurnFigure {
  base: number
  churned: number
  rate: number | null
}

export interface ConversionFunnelStep {
  key: string
  label: string
  count: number
  pctOfStart: number
  pctOfPrev: number
}

export interface ProviderHealth {
  gatewayType: string
  total: number
  paid: number
  completed: number
  refunded: number
  failed: number
  canceled: number
  pending: number
  successRate: number
  revenue: number
  revenueFigure: MoneyFigure
}

export interface DailyMetric {
  date: string
  revenue: number
  newUsers: number
  newSubscriptions: number
}

export interface OverviewMetrics {
  revenue: Compared<MoneyFigure>
  payments: Compared<number>
  payingCustomers: Compared<number>
  arppu: Compared<number | null>
  newUsers: Compared<number>
  newSubscriptions: Compared<number>
  activeSubscriptions: Compared<number>
  trialSubscriptions: number
  churn: Compared<ChurnFigure>
}

export interface OverviewSeries {
  revenue: readonly number[]
  payingCustomers: readonly number[]
  arppu: readonly (number | null)[]
  newUsers: readonly number[]
  newSubscriptions: readonly number[]
}

export interface OverviewCurrentSeries extends OverviewSeries {
  activeSubscriptions: readonly number[]
}

export interface AdvancedAnalyticsReport {
  kpis: KpiSummary
  churn: ChurnSnapshot
  funnel: readonly ConversionFunnelStep[]
  providers: readonly ProviderHealth[]
  daily: readonly DailyMetric[]
  windowDays: number
  generatedAt: string
  period: AnalyticsPeriod
  money: MoneyView
  metrics: OverviewMetrics
  partnerBalance: PartnerBalanceSpend
  series: OverviewCurrentSeries
  previousSeries: OverviewSeries
}

export type PurchaseKind = 'new' | 'renewal' | 'change' | 'addon'

export interface RevenueSeriesPoint {
  total: number
  byCurrency: readonly CurrencySlice[]
  byKind: Readonly<Record<PurchaseKind, number>>
}

export interface RevenueKind {
  kind: PurchaseKind
  figure: MoneyFigure
  payments: number
}

export interface RevenuePlan {
  key: string
  kind: 'plan' | 'addon' | 'none'
  planId: string | null
  name: string | null
  figure: MoneyFigure
  payments: number
}

export interface RevenueGateway {
  gatewayType: string
  figure: MoneyFigure
  payments: number
}

export interface RevenueReport {
  windowDays: number
  generatedAt: string
  period: AnalyticsPeriod
  money: MoneyView
  total: MoneyFigure
  payments: number
  byCurrency: readonly (CurrencySlice & { readonly payments: number })[]
  series: readonly RevenueSeriesPoint[]
  byKind: readonly RevenueKind[]
  byPlan: readonly RevenuePlan[]
  byGateway: readonly RevenueGateway[]
  partnerBalance: PartnerBalanceSpend
}

export interface ExpiringDay {
  date: string
  autopay: number
  manual: number
  trial: number
}

export interface ExpiringReport {
  generatedAt: string
  timeZone: string
  timeZoneFallback: boolean
  horizonDays: number
  days: readonly ExpiringDay[]
  totals: { readonly autopay: number; readonly manual: number; readonly trial: number }
}

export interface CohortRow {
  cohort: string
  cohortSize: number
  retentionByMonth: readonly number[]
}

export interface TopPayer {
  userId: string
  telegramId: string | null
  username: string | null
  name: string
  /** `null` when none of the customer's money has a rate into the view. */
  totalSpent: number | null
  spentByCurrency: readonly CurrencyAmount[]
  transactionCount: number
  lastPaymentAt: string | null
}

export interface TopPayersReport {
  payers: readonly TopPayer[]
  money: MoneyView
}

export interface LtvBucket {
  bound: number
  from: number
  to: number | null
  users: number
}

export interface LtvReport {
  buckets: readonly LtvBucket[]
  money: MoneyView
  stats: {
    readonly payers: number;
    readonly mean: number | null;
    readonly median: number | null;
    readonly p90: number | null;
  }
}

export type DaysToPayBucket = 'd0' | 'd1_3' | 'd4_7' | 'd8_14' | 'd15_30' | 'd31_plus'

export interface DaysToPayCount {
  key: DaysToPayBucket
  users: number
}

export interface ConvertedPlanItem {
  plan: string
  planId: string | null
  kind: 'plan' | 'addon' | 'none'
  count: number
  percentage: number
}

export interface TrialConversionReport {
  windowDays: number
  timeZone: string
  timeZoneFallback: boolean
  totalTrialUsers: number
  convertedUsers: number
  conversionRate: number
  avgDaysToConvert: number
  medianDaysToConvert: number | null
  revenueFromConverted: number
  revenueFromConvertedByCurrency: readonly CurrencyAmount[]
  money: MoneyView
  daysToConvert: readonly DaysToPayCount[]
  topConvertedPlans: readonly ConvertedPlanItem[]
  firstPayment: {
    readonly payers: number;
    readonly medianDays: number | null;
    readonly buckets: readonly DaysToPayCount[];
  }
}

export interface SubscriptionByPlanItem {
  plan: string
  planId: string | null
  active: number
  limited: number
  trial: number
  total: number
  percentage: number
}

// ── Reading a body ───────────────────────────────────────────────────────────

/**
 * The body as a record, or a throw — an HTML error page served with HTTP 200,
 * or a panel a release behind this page, must fail the query (the card then
 * says it could not load) rather than crash the tab on its first `.map`.
 */
function recordWith(body: unknown, fields: readonly string[]): Record<string, unknown> {
  const record = unwrapPayload(body)
  if (!isRecord(record) || fields.some((field) => !(field in record))) {
    throw new Error('errors.unexpectedResponsePayload')
  }
  return record
}

// ── API ──────────────────────────────────────────────────────────────────────

export async function getAnalyticsOverview(days: number): Promise<AdvancedAnalyticsReport> {
  const response = await api.get(`/admin/analytics/overview?days=${days}`)
  return recordWith(response.data, ['metrics', 'series', 'previousSeries', 'period', 'money', 'funnel', 'providers', 'partnerBalance']) as unknown as AdvancedAnalyticsReport
}

export async function getRevenueReport(days: number): Promise<RevenueReport> {
  const response = await api.get(`/admin/analytics/revenue?days=${days}`)
  return recordWith(response.data, ['total', 'series', 'byCurrency', 'byKind', 'byPlan', 'byGateway', 'money', 'period', 'partnerBalance']) as unknown as RevenueReport
}

export async function getTrialConversion(days: number): Promise<TrialConversionReport> {
  const response = await api.get(`/admin/analytics/trial-conversion?days=${days}`)
  return recordWith(response.data, ['daysToConvert', 'firstPayment', 'topConvertedPlans', 'money']) as unknown as TrialConversionReport
}

export async function getAnalyticsCohorts(): Promise<readonly CohortRow[]> {
  const response = await api.get('/admin/analytics/cohorts')
  return expectArray<CohortRow>(unwrapPayload(response.data).cohorts)
}

export async function getExpiring(): Promise<ExpiringReport> {
  const response = await api.get('/admin/analytics/expiring')
  return recordWith(response.data, ['days', 'totals', 'timeZone']) as unknown as ExpiringReport
}

export async function getTopPayers(limit = 20): Promise<TopPayersReport> {
  const response = await api.get(`/admin/analytics/top-payers?limit=${limit}`)
  const body = recordWith(response.data, ['payers', 'money'])
  return { payers: expectArray<TopPayer>(body.payers), money: body.money as MoneyView }
}

export async function getLtvDistribution(): Promise<LtvReport> {
  const response = await api.get('/admin/analytics/ltv-distribution')
  const body = recordWith(response.data, ['buckets', 'money', 'stats'])
  return { buckets: expectArray<LtvBucket>(body.buckets), money: body.money as MoneyView, stats: body.stats as LtvReport['stats'] }
}

export async function getSubscriptionsByPlan(): Promise<readonly SubscriptionByPlanItem[]> {
  const response = await api.get('/admin/analytics/subscriptions-by-plan')
  return expectArray<SubscriptionByPlanItem>(response.data)
}

// ── Usage surfaces ───────────────────────────────────────────────────────────

export interface SurfaceCount {
  key: string
  count: number
}

/**
 * `GET /admin/analytics/surfaces`, field for field the backend's
 * `UsageSurfaceReportInterface` — `surface-report-wire-contract.test.ts` holds
 * the two together.
 */
export interface UsageSurfaceReport {
  surfaces: readonly SurfaceCount[]
  formFactors: readonly SurfaceCount[]
  operatingSystems: readonly SurfaceCount[]
  pwaInstalls: number
  /**
   * The same installs by the OS the app was opened on: the first open while its
   * audit row survives, else the latest visit when it was from the app, else
   * `unknown`. Adds up to `pwaInstalls`.
   */
  pwaInstallsByOs: readonly SurfaceCount[]
  activeLast30d: number
  totalTracked: number
  generatedAt: string
}

export async function getSurfaceAnalytics(): Promise<UsageSurfaceReport> {
  const response = await api.get<UsageSurfaceReport>('/admin/analytics/surfaces')
  return readSurfaceReport(response.data)
}

/**
 * The report as the card may read it, or a throw.
 *
 * Four rings `.map` these lists, and a panel a release behind this page answers
 * without `pwaInstallsByOs`. Rather than crash the whole overview tab, or draw
 * "no installs yet" for installs that exist, the query fails and the card says
 * it could not load.
 */
export function readSurfaceReport(body: unknown): UsageSurfaceReport {
  const report = unwrapPayload(body)
  return {
    surfaces: expectArray<SurfaceCount>(report.surfaces),
    formFactors: expectArray<SurfaceCount>(report.formFactors),
    operatingSystems: expectArray<SurfaceCount>(report.operatingSystems),
    pwaInstalls: Number(report.pwaInstalls ?? 0),
    pwaInstallsByOs: expectArray<SurfaceCount>(report.pwaInstallsByOs),
    activeLast30d: Number(report.activeLast30d ?? 0),
    totalTracked: Number(report.totalTracked ?? 0),
    generatedAt: String(report.generatedAt ?? ''),
  }
}
