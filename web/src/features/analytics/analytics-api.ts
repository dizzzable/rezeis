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
