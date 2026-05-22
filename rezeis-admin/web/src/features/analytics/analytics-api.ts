import { api } from '@/lib/api'

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
  const response = await api.get<{ cohorts: readonly CohortRow[] }>('/admin/analytics/cohorts')
  return response.data.cohorts
}

export async function getTopPayers(limit = 20): Promise<readonly TopPayer[]> {
  const response = await api.get<{ payers: readonly TopPayer[] }>(
    `/admin/analytics/top-payers?limit=${limit}`,
  )
  return response.data.payers
}

export async function getLtvDistribution(): Promise<readonly LtvBucket[]> {
  const response = await api.get<{ buckets: readonly LtvBucket[] }>(
    '/admin/analytics/ltv-distribution',
  )
  return response.data.buckets
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
  const response = await api.get<readonly RevenueByCurrency[]>(`/admin/analytics/revenue-by-currency?days=${days}`)
  return response.data
}

export async function getSubscriptionsByPlan(): Promise<readonly SubscriptionByPlan[]> {
  const response = await api.get<readonly SubscriptionByPlan[]>('/admin/analytics/subscriptions-by-plan')
  return response.data
}
