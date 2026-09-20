/**
 * Bounded KPI snapshot exposed by `GET /admin/dashboard/summary`.
 *
 * The contract is intentionally narrow — it must not leak provider tokens,
 * raw payloads, or per-user identifiers. Every field is a counter, enum
 * code, or operator-safe label.
 *
 * Shape mirrors `web/src/features/dashboard/dashboard-api.ts` 1:1 so the
 * UI can render every panel without conditional fallbacks.
 */

import type {
  MoneyFigureInterface,
  MoneyViewInterface,
} from '../../business-analytics/interfaces/business-analytics.types';

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
  | 'IMPORT_DRY_RUN_AVAILABLE';

export interface DashboardMetricInterface {
  readonly code: DashboardMetricCode | string;
  readonly label: string;
  readonly value: number | string;
  readonly description: string | null;
}

export type DashboardOperationsTimelineSource = 'BROADCAST' | 'IMPORT' | 'AUDIT' | 'OPS';

export type DashboardTimelineStatus = 'INFO' | 'WARNING' | 'SUCCESS' | 'PENDING' | 'ERROR';

/** Discriminator that lets the SPA compose localized timeline copy. */
export type DashboardTimelineKind =
  | 'IMPORT'
  | 'BROADCAST'
  | 'AUDIT'
  | 'SYSTEM_EVENT'
  | 'PAYMENT';

/**
 * Operator-safe structured values backing the localized timeline copy. Every
 * field is a bounded counter, enum code, or short label — never a user id,
 * payment id, or raw payload. The SPA interpolates these into i18n templates;
 * `title`/`description` stay as English fallbacks for the async-load gap/tests.
 */
export interface DashboardTimelineMetaInterface {
  // IMPORT
  readonly sourceType?: string;
  readonly recordsOk?: number;
  readonly recordsTotal?: number;
  readonly recordsFailed?: number;
  // BROADCAST
  readonly audience?: string;
  readonly successCount?: number;
  readonly totalCount?: number;
  readonly failedCount?: number;
  // AUDIT (raw English action identifier; the SPA holds the labels)
  readonly action?: string;
  // SYSTEM_EVENT — a row written by `SystemEventsService`, whose audit action
  // is `event.<type>`. `eventType` is the machine type with that prefix gone;
  // `eventTitle` is the operator-facing title from `EVENT_PRESENTATION`, the
  // one table the Telegram cards and the notification centre already read, so
  // a new event type is captioned here the day it is added and can never
  // disagree with the card the same event sent. Absent for a type outside that
  // table (an automation rule picks its type at runtime) — then the SPA shows
  // the machine type, which is the only honest thing left to show.
  readonly eventType?: string;
  readonly eventTitle?: string;
  // PAYMENT
  readonly paymentStatus?: string;
  readonly purchaseType?: string;
  readonly channel?: string | null;
  readonly amount?: string;
  readonly currency?: string;
}

export interface DashboardTimelineEntryInterface {
  readonly id: string;
  readonly source: DashboardOperationsTimelineSource;
  readonly title: string;
  readonly description: string;
  readonly createdAt: string;
  readonly status: DashboardTimelineStatus;
  /** Discriminator for client-side localization (falls back to title/description). */
  readonly kind?: DashboardTimelineKind;
  /** Structured, operator-safe values for client-side i18n interpolation. */
  readonly meta?: DashboardTimelineMetaInterface;
}

export type DashboardAttentionKind =
  | 'SUBSCRIPTION_EXPIRING'
  | 'PAYMENT_PENDING'
  | 'WITHDRAWAL_PENDING'
  | 'WEBHOOK_FAILED';

export type DashboardAttentionSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface DashboardAttentionItemInterface {
  readonly safeKey: string;
  readonly kind: DashboardAttentionKind;
  readonly severity: DashboardAttentionSeverity;
  readonly title: string;
  readonly description: string;
  /** Count behind the item (e.g. number of expiring subs) — drives the SPA copy. */
  readonly count: number;
  readonly occurredAt: string;
  readonly status: 'ACTIVE' | 'PENDING' | 'RESOLVED';
}

export interface DashboardUsersSummaryInterface {
  readonly total: number;
  readonly blocked: number;
  readonly recentRegistered7d: number;
}

export interface DashboardSubscriptionsSummaryInterface {
  readonly active: number;
  readonly limited: number;
  readonly expired: number;
  readonly expiring7d: number;
}

export interface DashboardTransactionsSummaryInterface {
  readonly completed: number;
  readonly pending: number;
  readonly failed: number;
  /**
   * Withdrawn: always `'—'`. It was the sum of every completed amount across
   * currencies — 1 000 RUB + 10 USDT read «1010», partner-balance spends and
   * partial refunds included. It stays so a dashboard opened before the update
   * prints a dash instead of that number; the figure is `revenue`.
   */
  readonly grossVolume: string;
}

/**
 * «Выручка за всё время»: money received over the panel's whole history —
 * completed payments for more than nothing, net of partial refunds, without
 * partner-balance spends — by the rule and in the money view of
 * «Бизнес-аналитика» → «Выручка».
 */
export interface DashboardRevenueInterface {
  /** The value in `money.currency`, and the exact sum in every currency it was made of. */
  readonly figure: MoneyFigureInterface;
  /** One currency natively; several in the reporting base at the panel's rates, the ones with no rate named. */
  readonly money: MoneyViewInterface;
  /** The payments whose money `figure` is. */
  readonly payments: number;
}

export interface DashboardOperationsSummaryInterface {
  readonly broadcastDrafts: number;
  readonly importDryRunAvailable: boolean;
}

export interface DashboardFinanceOpsSummaryInterface {
  readonly refundRequests: number;
  readonly executedRefunds: number;
  readonly correctionNotes: number;
  readonly correctionRequests: number;
  readonly disputeRecords: number;
  readonly reconciliationExceptions: number;
}

export interface DashboardSummaryInterface {
  readonly checkedAt: string;
  readonly users: DashboardUsersSummaryInterface;
  readonly subscriptions: DashboardSubscriptionsSummaryInterface;
  readonly transactions: DashboardTransactionsSummaryInterface;
  readonly revenue: DashboardRevenueInterface;
  readonly operations: DashboardOperationsSummaryInterface;
  readonly financeOps: DashboardFinanceOpsSummaryInterface;
  readonly metrics: readonly DashboardMetricInterface[];
  readonly operationsTimeline: readonly DashboardTimelineEntryInterface[];
  readonly financeOpsTimeline: readonly DashboardTimelineEntryInterface[];
  readonly attentionItems: readonly DashboardAttentionItemInterface[];
}
