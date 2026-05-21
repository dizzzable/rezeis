import { api } from '@/lib/api'

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
  | 'GROSS_VOLUME'
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

export interface DashboardTimelineEntryInterface {
  readonly id: string
  readonly source: DashboardOperationsTimelineSource
  readonly title: string
  readonly description: string
  readonly createdAt: string
  readonly status: DashboardTimelineStatus
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
  readonly occurredAt: string
  readonly status: 'ACTIVE' | 'PENDING' | 'RESOLVED'
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
    readonly grossVolume: string
  }
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

// ── API surface ──────────────────────────────────────────────────────────────

/**
 * Bounded dashboard summary client. The backend response is intentionally
 * narrow: counters, safe text, and stable enum codes. The client never asks
 * for raw user identifiers, payment ids, or provider payloads.
 */
export const dashboardApi = {
  async getSummary(): Promise<DashboardSummaryInterface> {
    const response = await api.get<DashboardSummaryInterface>('/admin/dashboard/summary')
    return response.data
  },
}
