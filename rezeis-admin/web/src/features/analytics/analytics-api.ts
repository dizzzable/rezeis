import { api } from '@/lib/api'
import { expectArray, unwrapPayload } from '@/lib/api-utils'

// ── Types ────────────────────────────────────────────────────────────────────

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
  completed: number
  failed: number
  canceled: number
  successRate: number
  revenue: number
}

export interface DailyMetric {
  date: string
  revenue: number
  newUsers: number
  newSubscriptions: number
}

export interface AdvancedAnalyticsReport {
  kpis: KpiSummary
  churn: ChurnSnapshot
  funnel: readonly ConversionFunnelStep[]
  providers: readonly ProviderHealth[]
  daily: readonly DailyMetric[]
  windowDays: number
  generatedAt: string
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
  totalSpent: number
  transactionCount: number
  lastPaymentAt: string | null
}

export interface LtvBucket {
  bound: number
  users: number
}

// ── API ──────────────────────────────────────────────────────────────────────

export async function getAnalyticsOverview(days: number): Promise<AdvancedAnalyticsReport> {
  const response = await api.get<AdvancedAnalyticsReport>(`/admin/analytics/overview?days=${days}`)
  return response.data
}

export async function getAnalyticsCohorts(): Promise<readonly CohortRow[]> {
  const response = await api.get('/admin/analytics/cohorts')
  return expectArray<CohortRow>(unwrapPayload(response.data).cohorts)
}

export async function getTopPayers(limit = 20): Promise<readonly TopPayer[]> {
  const response = await api.get(`/admin/analytics/top-payers?limit=${limit}`)
  return expectArray<TopPayer>(unwrapPayload(response.data).payers)
}

export async function getLtvDistribution(): Promise<readonly LtvBucket[]> {
  const response = await api.get('/admin/analytics/ltv-distribution')
  return expectArray<LtvBucket>(unwrapPayload(response.data).buckets)
}

// ── Phase 8 — New endpoints ──────────────────────────────────────────────────

export interface TrialConversionReport {
  windowDays: number
  totalTrialUsers: number
  convertedUsers: number
  conversionRate: number
  avgDaysToConvert: number
  revenueFromConverted: number
  topConvertedPlans: readonly { plan: string; count: number; percentage: number }[]
}

export interface RevenueByCurrency {
  currency: string
  revenue: number
  transactions: number
  percentage: number
}

export interface SubscriptionByPlan {
  plan: string
  active: number
  limited: number
  total: number
  percentage: number
}

export async function getTrialConversion(days: number): Promise<TrialConversionReport> {
  const response = await api.get<TrialConversionReport>(`/admin/analytics/trial-conversion?days=${days}`)
  return response.data
}

export async function getRevenueByCurrency(days: number): Promise<readonly RevenueByCurrency[]> {
  const response = await api.get(`/admin/analytics/revenue-by-currency?days=${days}`)
  return expectArray<RevenueByCurrency>(response.data)
}

export async function getSubscriptionsByPlan(): Promise<readonly SubscriptionByPlan[]> {
  const response = await api.get('/admin/analytics/subscriptions-by-plan')
  return expectArray<SubscriptionByPlan>(response.data)
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
