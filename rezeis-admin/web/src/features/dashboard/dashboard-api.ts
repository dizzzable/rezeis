import { z } from 'zod'

import { api } from '@/lib/api'
import { expectArray } from '@/lib/api-utils'
import type { MoneyFigure, MoneyView } from '@/features/analytics/analytics-api'

// ── Types ────────────────────────────────────────────────────────────────────

export type DashboardMetricCode =
  | 'TOTAL_USERS'
  | 'BLOCKED_USERS'
  | 'NEW_USERS_7D'
  | 'ACTIVE_SUBSCRIPTIONS'
  | 'LIMITED_SUBSCRIPTIONS'
  | 'EXPIRED_SUBSCRIPTIONS'
  | 'EXPIRING_SUBSCRIPTIONS_7D'
  | 'COMPLETED_TRANSACTIONS'
  | 'PENDING_TRANSACTIONS'
  | 'FAILED_TRANSACTIONS'
  | 'BROADCAST_DRAFTS'
  | 'IMPORT_DRY_RUN_AVAILABLE'

export interface DashboardMetricInterface {
  readonly code: DashboardMetricCode | string
  readonly label: string
  readonly value: number | string
  readonly description: string | null
}

export type DashboardOperationsTimelineSource =
  | 'BROADCAST'
  | 'IMPORT'
  | 'AUDIT'
  | 'OPS'

export type DashboardTimelineStatus =
  | 'INFO'
  | 'WARNING'
  | 'SUCCESS'
  | 'PENDING'
  | 'ERROR'

export type DashboardTimelineKind =
  | 'IMPORT'
  | 'BROADCAST'
  | 'AUDIT'
  | 'SYSTEM_EVENT'
  | 'PAYMENT'

export interface DashboardTimelineMetaInterface {
  readonly sourceType?: string
  readonly recordsOk?: number
  readonly recordsTotal?: number
  readonly recordsFailed?: number
  readonly audience?: string
  readonly successCount?: number
  readonly totalCount?: number
  readonly failedCount?: number
  readonly action?: string
  /** SYSTEM_EVENT: the machine type, `event.` prefix already gone. */
  readonly eventType?: string
  /** SYSTEM_EVENT: the server's own caption for it, absent for a type it has none for. */
  readonly eventTitle?: string
  readonly paymentStatus?: string
  readonly purchaseType?: string
  readonly channel?: string | null
  readonly amount?: string
  readonly currency?: string
}

export interface DashboardTimelineEntryInterface {
  readonly id: string
  readonly source: DashboardOperationsTimelineSource
  readonly title: string
  readonly description: string
  readonly createdAt: string
  readonly status: DashboardTimelineStatus
  readonly kind?: DashboardTimelineKind
  readonly meta?: DashboardTimelineMetaInterface
}

export type DashboardAttentionKind =
  | 'SUBSCRIPTION_EXPIRING'
  | 'PAYMENT_PENDING'
  | 'WITHDRAWAL_PENDING'
  | 'WEBHOOK_FAILED'

export type DashboardAttentionSeverity = 'INFO' | 'WARNING' | 'CRITICAL'

export interface DashboardAttentionItemInterface {
  readonly safeKey: string
  readonly kind: DashboardAttentionKind
  readonly severity: DashboardAttentionSeverity
  readonly title: string
  readonly description: string
  /** Count behind the item — drives the localized SPA copy. */
  readonly count: number
  readonly occurredAt: string
  readonly status: 'ACTIVE' | 'PENDING' | 'RESOLVED'
}

/**
 * «Выручка за всё время»: money received over the panel's whole history —
 * completed payments above zero, net of refunds, without partner-balance
 * spends — by the rule and in the money view of «Бизнес-аналитика» → «Выручка».
 */
export interface DashboardRevenue {
  /** The value in `money.currency`, and the exact sum in every currency it was made of. */
  readonly figure: MoneyFigure
  readonly money: MoneyView
  /** The payments whose money `figure` is. */
  readonly payments: number
}

export interface DashboardSummaryInterface {
  readonly checkedAt: string
  readonly users: {
    readonly total: number
    readonly blocked: number
    readonly recentRegistered7d: number
  }
  readonly subscriptions: {
    readonly active: number
    readonly limited: number
    readonly expired: number
    readonly expiring7d: number
  }
  readonly transactions: {
    readonly completed: number
    readonly pending: number
    readonly failed: number
    /**
     * Withdrawn: the server sends `'—'`. It was every completed amount added
     * across currencies («1 000 RUB + 10 USDT» read «1010»). Never shown; the
     * figure is `revenue`.
     */
    readonly grossVolume: string
  }
  /**
   * Optional on purpose: a summary a panel a release behind wrote into the
   * cache has none, and the tile then says «—» instead of a number.
   */
  readonly revenue?: DashboardRevenue
  readonly operations: {
    readonly broadcastDrafts: number
    readonly importDryRunAvailable: boolean
  }
  readonly financeOps: {
    readonly refundRequests: number
    readonly executedRefunds: number
    readonly correctionNotes: number
    readonly correctionRequests: number
    readonly disputeRecords: number
    readonly reconciliationExceptions: number
  }
  readonly metrics: readonly DashboardMetricInterface[]
  readonly operationsTimeline: readonly DashboardTimelineEntryInterface[]
  readonly financeOpsTimeline: readonly DashboardTimelineEntryInterface[]
  readonly attentionItems: readonly DashboardAttentionItemInterface[]
}

// ── System Health Types ──────────────────────────────────────────────────────

export interface CpuCoreInfo {
  readonly core: number
  readonly usagePercent: number
}

export interface NetworkInterfaceSnapshot {
  readonly name: string
  readonly rxBytes: number
  readonly txBytes: number
}

export interface VpsHealthSnapshot {
  readonly cpuUsagePercent: number
  readonly cpuCores: readonly CpuCoreInfo[]
  readonly cpuCoreCount: number
  readonly cpuModel: string
  readonly ramUsedBytes: number
  readonly ramTotalBytes: number
  readonly ramUsagePercent: number
  readonly diskUsedBytes: number
  readonly diskTotalBytes: number
  readonly diskUsagePercent: number
  readonly uptimeSeconds: number
  readonly loadAverage: readonly [number, number, number]
  readonly network: readonly NetworkInterfaceSnapshot[]
}

export interface ProcessHealthSnapshot {
  readonly cpuUsagePercent: number
  readonly rssBytes: number
  readonly heapUsedBytes: number
  readonly heapTotalBytes: number
  readonly externalBytes: number
  readonly uptimeSeconds: number
  readonly nodeVersion: string
  readonly pid: number
  readonly eventLoopLagMs: number
}

export interface SystemHealthResponse {
  readonly timestamp: string
  readonly vps: VpsHealthSnapshot
  readonly process: ProcessHealthSnapshot
}

// ── API surface ──────────────────────────────────────────────────────────────

export const dashboardApi = {
  async getSummary(): Promise<DashboardSummaryInterface> {
    const response = await api.get<DashboardSummaryInterface>('/admin/dashboard/summary')
    return response.data
  },

  async getSystemHealth(): Promise<SystemHealthResponse> {
    const response = await api.get<SystemHealthResponse>('/admin/dashboard/system-health')
    return response.data
  },

  async getReiwaSystemHealth(): Promise<SystemHealthResponse | null> {
    const response = await api.get<SystemHealthResponse | null>(
      '/admin/dashboard/system-health/reiwa',
    )
    // Backend returns null (serialised as empty body) when reiwa is
    // unreachable / unconfigured — normalise the falsy/empty case to null.
    return response.data && typeof response.data === 'object' ? response.data : null
  },

  async getOnlineOverview(range: OnlineRange): Promise<OnlineOverview> {
    const response = await api.get('/admin/remnawave/metrics/online-overview', { params: { range } })
    return onlineOverviewSchema.parse(response.data)
  },

  async getOnlineDistribution(range: OnlineRange): Promise<OnlineDistribution> {
    const response = await api.get('/admin/remnawave/metrics/online-distribution', { params: { range } })
    return onlineDistributionSchema.parse(response.data)
  },

  async getActivityFeed(limit = 30): Promise<ActivityFeedItem[]> {
    const response = await api.get(`/admin/remnawave/metrics/activity-feed?limit=${limit}`)
    return expectArray<ActivityFeedItem>(response.data)
  },
}

// ── «Онлайн пользователей» ───────────────────────────────────────────────────

/** The card's two windows; the server refuses any other. */
export const ONLINE_RANGES = ['24h', '7d'] as const
export type OnlineRange = (typeof ONLINE_RANGES)[number]

/**
 * Parsed, not asserted: the card reads nested fields off every part of these
 * answers, and an HTML error page or a half-deployed backend must reach its
 * error branch, not a `.map` of undefined inside the chart.
 */
const onlineOverviewSchema = z.object({
  range: z.enum(ONLINE_RANGES),
  generatedAt: z.string(),
  bucketMinutes: z.number(),
  points: z.array(z.object({ time: z.string(), onlineNow: z.number().nullable() })),
  sampleCount: z.number(),
  peak: z.object({ value: z.number(), at: z.string() }).nullable(),
  latestSample: z.object({ onlineNow: z.number(), at: z.string() }).nullable(),
  live: z.object({ onlineNow: z.number(), uniqueUsers: z.number(), checkedAt: z.string() }).nullable(),
})

/**
 * The card's chart for one window (`GET /admin/remnawave/metrics/online-overview`).
 * `points` are 5-minute samples for 24 hours and hourly maxima for 7 days, and
 * `onlineNow: null` is a bucket nothing was measured in. `live` is Remnawave's
 * own figures, `null` when it did not answer. `generatedAt` is the server's
 * clock at the answer: «today» and «out of date» are judged by it, since every
 * other time here was stamped by that same clock and the browser's may be off.
 */
export type OnlineOverview = z.infer<typeof onlineOverviewSchema>

const onlineDistributionSchema = z.object({
  range: z.enum(ONLINE_RANGES),
  generatedAt: z.string(),
  sampledAt: z.string().nullable(),
  nodeReadFailedAt: z.string().nullable(),
  totalUsersOnline: z.number(),
  nodes: z.array(
    z.object({
      uuid: z.string(),
      name: z.string(),
      countryCode: z.string(),
      usersOnline: z.number(),
      peak: z.number(),
      isConnected: z.boolean(),
    }),
  ),
  countries: z.array(
    z.object({
      countryCode: z.string(),
      usersOnline: z.number(),
      nodes: z.number(),
      nodesConnected: z.number(),
    }),
  ),
})

/**
 * Online users by node and by country, from the newest stored sample
 * (`GET /admin/remnawave/metrics/online-distribution`). Counts are connections,
 * so shares are of `totalUsersOnline`; `countryCode` is `''` for no country.
 * `sampledAt` is the newest sample whose node list was READ; `nodeReadFailedAt`
 * says the newest sample could not read it, so the lists are that much older.
 */
export type OnlineDistribution = z.infer<typeof onlineDistributionSchema>

/** Both carry the window, so switching it is a new request and never a stale answer. */
export const onlineCardKeys = {
  overview: (range: OnlineRange) => ['admin', 'remnawave', 'online-overview', range] as const,
  distribution: (range: OnlineRange) => ['admin', 'remnawave', 'online-distribution', range] as const,
}

export interface ActivityFeedItem {
  readonly id: string
  readonly eventType: string
  readonly payload: Record<string, unknown>
  readonly createdAt: string
  readonly isProcessed: boolean
}
