/**
 * Wire-level types for the payment-analytics module.
 *
 * All public DTO interfaces live here so the frontend can copy/derive
 * them without depending on the backend codebase.
 */

import type { PaymentGatewayType } from '@prisma/client';

// ── Provider detail report ───────────────────────────────────────────────────

export interface ProviderFailureReasonInterface {
  /** Provider-supplied error code or status string (e.g. "canceled", "401"). */
  readonly reason: string;
  readonly count: number;
  /** Share of all failures for this gateway in the window (0..1). */
  readonly share: number;
}

export interface ProviderDailyPointInterface {
  /** ISO date (yyyy-mm-dd, UTC). */
  readonly day: string;
  readonly revenue: number;
  readonly transactions: number;
  readonly successful: number;
}

export interface ProviderDetailInterface {
  readonly gatewayType: PaymentGatewayType;
  /** Whether the gateway is currently active in the catalog. */
  readonly isActive: boolean;
  /** Configured catalog currency for this gateway. */
  readonly currency: string;

  /** Total transactions in the window (any status). */
  readonly transactions: number;
  readonly completed: number;
  readonly pending: number;
  readonly failed: number;
  readonly canceled: number;

  /** Sum of `amount` for completed transactions. */
  readonly grossRevenue: number;
  /** Average ticket size for completed transactions (grossRevenue / completed). */
  readonly avgTicket: number;
  /** Conversion rate completed / (completed + failed + canceled), 0..1. */
  readonly successRate: number;
  /** Conversion rate completed / transactions (incl. still-pending), 0..1. */
  readonly checkoutRate: number;

  /** Median time-to-pay (createdAt → updatedAt for completed) in seconds. */
  readonly medianTimeToPaySeconds: number | null;
  readonly p95TimeToPaySeconds: number | null;

  /** Number of pending transactions older than 1 hour (stuck checkouts). */
  readonly stuckPending: number;

  /** Comparison to the previous window of the same length. */
  readonly delta: {
    readonly revenuePct: number | null;
    readonly transactionsPct: number | null;
    readonly successRateDelta: number | null;
  };

  /** Daily breakdown for the entire window (filled in for trend lines). */
  readonly daily: readonly ProviderDailyPointInterface[];

  /** Top failure reasons (up to 5). */
  readonly topFailureReasons: readonly ProviderFailureReasonInterface[];

  /** Channel mix as fractions of total transactions. */
  readonly channelMix: {
    readonly web: number;
    readonly telegram: number;
  };
}

export interface PaymentProvidersReportInterface {
  readonly windowDays: number;
  readonly windowStart: string;
  readonly previousWindowStart: string;
  readonly generatedAt: string;
  /** Sum of grossRevenue across all gateways in the window. */
  readonly totalGrossRevenue: number;
  readonly totalTransactions: number;
  readonly totalCompleted: number;
  readonly providers: readonly ProviderDetailInterface[];
}

// ── Webhook health report ───────────────────────────────────────────────────

export interface WebhookGatewayHealthInterface {
  readonly gatewayType: PaymentGatewayType;
  readonly received: number;
  readonly processed: number;
  readonly failed: number;
  readonly retrying: number;
  /** Webhooks that needed a manual replay at least once. */
  readonly replayed: number;
  /** processed / received, 0..1. */
  readonly deliveryRate: number;
  /** Median ms between receivedAt and processedAt. */
  readonly medianLatencyMs: number | null;
  readonly p95LatencyMs: number | null;
  /** Top last-error messages, up to 5. */
  readonly topErrors: readonly { readonly error: string; readonly count: number }[];
}

export interface ReconciliationGapInterface {
  /** Transactions in the window with no matching webhook event. */
  readonly transactionsMissingWebhook: number;
  /** Webhook events with no matching transaction (possible spam/probe). */
  readonly webhooksMissingTransaction: number;
}

export interface PaymentWebhookHealthReportInterface {
  readonly windowDays: number;
  readonly windowStart: string;
  readonly generatedAt: string;
  readonly totalReceived: number;
  readonly totalProcessed: number;
  readonly totalFailed: number;
  readonly reconciliation: ReconciliationGapInterface;
  readonly perGateway: readonly WebhookGatewayHealthInterface[];
}
