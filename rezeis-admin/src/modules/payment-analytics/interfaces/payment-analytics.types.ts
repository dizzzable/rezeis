/**
 * Wire-level types for the payment-analytics module.
 *
 * All public DTO interfaces live here so the frontend can copy/derive
 * them without depending on the backend codebase.
 *
 * MONEY HERE FOLLOWS «Бизнес-аналитика». A payment is money when it is
 * COMPLETED, for more than nothing and not paid from a partner's balance, net
 * of a partial refund (`business-analytics/utils/analytics-money-received.util.ts`);
 * it belongs to the time its checkout STARTED (`created_at`); and money in
 * several currencies is stated in one — natively when there is one, else the
 * reporting base at the panel's own rates, a currency with no rate left out
 * and named (`business-analytics/utils/analytics-money.util.ts`).
 *
 * Until 2026-09 this report summed `amount` across currencies by
 * `updated_at` — 1 000 RUB + 10 USDT read «1010», and a payment imported
 * today with a date a year back counted as today's. The money fields of that
 * contract (`totalGrossRevenue`, `grossRevenue`, `avgTicket`, the daily
 * `revenue`) are gone rather than refilled: a panel tab opened before the
 * update prints «—» for them instead of a number in a currency it cannot name.
 */

import type { PaymentGatewayType } from '@prisma/client';

import type {
  CurrencyAmountInterface,
  MoneyFigureInterface,
  MoneyViewInterface,
  PartnerBalanceSpendInterface,
} from '../../business-analytics/interfaces/business-analytics.types';

// ── Provider detail report ───────────────────────────────────────────────────

export interface ProviderFailureReasonInterface {
  /** Provider-supplied error code or status string (e.g. "canceled", "401"). */
  readonly reason: string;
  readonly count: number;
  /** Share of ALL the gateway's failed and canceled checkouts in the window (0..1), not of the listed five. */
  readonly share: number;
}

export interface ProviderDailyPointInterface {
  /** A local calendar day of the report's zone (`timeZone`), `YYYY-MM-DD`. */
  readonly day: string;
  /** Money received that day through the gateway, in the report's `money` view. */
  readonly revenueValue: number;
  /** Checkouts started that day. */
  readonly transactions: number;
  /** Of them, the ones that went through: still completed, or refunded since. */
  readonly successful: number;
}

export interface ProviderDetailInterface {
  readonly gatewayType: PaymentGatewayType;
  /** Whether the gateway is currently active in the catalog. */
  readonly isActive: boolean;
  /** Configured catalog currency for this gateway. */
  readonly currency: string;
  /**
   * `false` for a partner's balance: its purchases spend money the panel
   * counted when the partner's referral paid. The row is there for its health;
   * its money is in the report's `partnerBalance`, never in any revenue.
   */
  readonly countsAsRevenue: boolean;

  /** Checkouts started in the window through this gateway (a checkout for nothing never reaches one). */
  readonly transactions: number;
  /** Paid and not refunded in full (a partial refund stays completed). */
  readonly completed: number;
  /** Paid, then refunded in full (reconciliation writes that as CANCELED stamped `refundReversedAt`). */
  readonly refunded: number;
  readonly pending: number;
  readonly failed: number;
  /** Abandoned or declined before any money moved — a refund is never here. */
  readonly canceled: number;

  /** Money received through the gateway in the window, net of partial refunds, in the report's `money` view. */
  readonly revenue: MoneyFigureInterface;
  /** The payments whose money `revenue` is. */
  readonly payments: number;
  /**
   * The average of those payments: in the view currency, or natively when all
   * of it is in one currency the view cannot convert; `null` with no payments,
   * or when part of the money has no rate.
   */
  readonly averagePayment: CurrencyAmountInterface | null;
  /** Went through (completed + refunded) / checkouts with an outcome (… + failed + canceled), 0..1. */
  readonly successRate: number;
  /** Went through / every checkout, still-pending ones included, 0..1. */
  readonly checkoutRate: number;

  /**
   * Median time-to-pay in seconds: `fulfilledAt − createdAt` — from the
   * checkout's start to the fulfilment that credited it — of the completed
   * payments CREATED in the window. A payment not fulfilled yet has no such
   * time and is left out (never read as 0); imported payments are left out.
   * `null` when none has one.
   */
  readonly medianTimeToPaySeconds: number | null;
  readonly p95TimeToPaySeconds: number | null;

  /**
   * Checkouts still PENDING more than an hour after they STARTED, whenever that
   * was (stuck checkouts): the pending sweep cancels an abandoned one at 30
   * minutes. Not "untouched for an hour" — the sweep re-stamps a YooKassa
   * payment the provider still reports open every 5 minutes.
   */
  readonly stuckPending: number;

  /** Comparison to the previous window of the same length, ending at the same local time. */
  readonly delta: {
    /** Of `revenue.value`; `null` when the previous window had none. */
    readonly revenuePct: number | null;
    readonly transactionsPct: number | null;
    readonly successRateDelta: number | null;
  };

  /** One point per local day of the window (filled in for trend lines). */
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
  /** Local midnight of the window's first day, in `timeZone`. */
  readonly windowStart: string;
  readonly previousWindowStart: string;
  /** The previous window ends at the same local time `windowDays` days ago (exclusive). */
  readonly previousWindowEnd: string;
  readonly generatedAt: string;
  /** The IANA zone the days are counted in, or `UTC`. */
  readonly timeZone: string;
  /** The panel's time zone setting was empty or not a zone, so the days are UTC days. */
  readonly timeZoneFallback: boolean;
  /** The currency every money value of the report is in, and how other currencies got there. */
  readonly money: MoneyViewInterface;
  /** Money received in the window through every gateway — the «Выручка» of «Бизнес-аналитика» for the same window. */
  readonly revenue: MoneyFigureInterface;
  /** The payments whose money `revenue` is. */
  readonly payments: number;
  /** Paid from a partner's balance in the window — not in `revenue`, stated apart. */
  readonly partnerBalance: PartnerBalanceSpendInterface;
  /**
   * Checkouts through the payment systems — a partner's balance left out, like
   * `totalCompleted` and `totalPaid`: it keeps its own row and `partnerBalance`.
   */
  readonly totalTransactions: number;
  readonly totalCompleted: number;
  /** Went through: completed + refunded since. */
  readonly totalPaid: number;
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
  /**
   * Transactions in the window with no matching webhook event — imported ones
   * left out: they carry the donor's gateway id, and no webhook of theirs was
   * ever this panel's to receive.
   */
  readonly transactionsMissingWebhook: number;
  /** Webhook events with no matching transaction (possible spam/probe). */
  readonly webhooksMissingTransaction: number;
}

export interface PaymentWebhookHealthReportInterface {
  readonly windowDays: number;
  /** Local midnight of the window's first day, in the panel's zone — the providers report's window. */
  readonly windowStart: string;
  readonly generatedAt: string;
  readonly totalReceived: number;
  readonly totalProcessed: number;
  readonly totalFailed: number;
  readonly reconciliation: ReconciliationGapInterface;
  readonly perGateway: readonly WebhookGatewayHealthInterface[];
}
