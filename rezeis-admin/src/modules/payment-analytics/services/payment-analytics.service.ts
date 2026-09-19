import { Injectable } from '@nestjs/common';
import { PaymentGatewayType, PaymentWebhookLifecycleStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { readFxSnapshot } from '../../business-analytics/utils/analytics-money.util';
import { partnerBalanceSql, type PartnerBalanceRow } from '../../business-analytics/utils/analytics-overview.util';
import { planAnalyticsWindow, readAnalyticsZone } from '../../business-analytics/utils/analytics-window.util';
import type { AnalyticsZone } from '../../business-analytics/utils/analytics-zone.util';
import { FxRateService } from '../../fx/fx-rate.service';
import { redactPaymentDiagnosticMessage } from '../../payments/utils/payment-provider-error.util';
import { SettingsService } from '../../settings/services/settings.service';
import {
  PaymentProvidersReportInterface,
  PaymentWebhookHealthReportInterface,
  ReconciliationGapInterface,
  WebhookGatewayHealthInterface,
} from '../interfaces/payment-analytics.types';
import {
  assembleProviderReport,
  channelMixSql,
  type ChannelRow,
  failureReasonsSql,
  type FailureReasonRow,
  providerDaysSql,
  type ProviderDayRow,
  providerWindowsSql,
  type ProviderWindowRow,
  stuckPendingSql,
  type StuckPendingRow,
  timeToPaySql,
  type TimeToPayRow,
} from '../utils/payment-provider-report.util';

const ONE_HOUR_MS = 60 * 60 * 1000;

/** Clamp a window-size request to a sane positive integer. */
function clampDays(days: number, fallback: number): number {
  if (!Number.isFinite(days) || days <= 0) return fallback;
  return Math.min(365, Math.max(1, Math.floor(days)));
}

function sanitizeAnalyticsLabel(
  value: string | null | undefined,
  fallback: string,
  maxLength: number,
): string {
  return redactPaymentDiagnosticMessage(value ?? fallback, maxLength) ?? fallback;
}

interface WebhookGatewayRow {
  readonly gateway_type: PaymentGatewayType;
  readonly status: PaymentWebhookLifecycleStatus;
  readonly count: bigint;
  readonly replayed_count: bigint;
}

interface WebhookLatencyRow {
  readonly gateway_type: PaymentGatewayType;
  readonly median_ms: number | null;
  readonly p95_ms: number | null;
}

interface WebhookErrorRow {
  readonly gateway_type: PaymentGatewayType;
  readonly last_error: string | null;
  readonly count: bigint;
}

interface ReconciliationRow {
  readonly transactions_missing_webhook: bigint;
  readonly webhooks_missing_transaction: bigint;
}

/**
 * Payment-analytics service.
 *
 * Builds operational dashboards on top of the `transactions` and
 * `payment_webhook_events` tables. Heavy aggregations are pushed into
 * PostgreSQL so we don't drag full result sets into Node memory
 * (transaction history can be very large).
 *
 * Scope:
 *   • Provider-level performance (Level 1 in the design doc): revenue,
 *     conversion rate, average payment, time-to-pay percentiles, daily trend,
 *     top failure reasons, channel mix, period-over-period delta. Its money,
 *     its time and its days follow «Бизнес-аналитика» — see
 *     `utils/payment-provider-report.util.ts`.
 *   • Webhook health (Level 2): delivery rate per gateway, replay rate,
 *     latency percentiles, top errors, reconciliation gap — over the same
 *     window the providers report covers.
 *
 * The service avoids returning raw transaction rows or PII — every
 * endpoint emits aggregated metrics only.
 */
@Injectable()
export class PaymentAnalyticsService {
  public constructor(
    private readonly prismaService: PrismaService,
    /**
     * Only for the reporting base currency: the rates themselves are READ from
     * `fx_rates`, never fetched — a report must not wait on an exchange inside
     * the 30-second request limit.
     */
    private readonly fxRateService: FxRateService,
    /** The operator's time zone (`Settings.platformPolicy.timezone`), the calendar the days are counted in. */
    private readonly settingsService: SettingsService,
  ) {}

  /**
   * The zone the days are counted in — «Бизнес-аналитика»'s own reader
   * (`readAnalyticsZone`), so the two pages can never count different days:
   * the panel's setting when both `Intl` and PostgreSQL know it, else UTC.
   */
  private async readZone(): Promise<AnalyticsZone> {
    const branding = await this.settingsService.getPlatformBranding();
    return readAnalyticsZone(this.prismaService, branding.timezone);
  }

  // ───────────────────────────────────────────────────────────────────────
  //  Level 1 — Provider performance
  // ───────────────────────────────────────────────────────────────────────

  public async getProviderReport(daysRaw: number): Promise<PaymentProvidersReportInterface> {
    const now = new Date();
    const window = planAnalyticsWindow(clampDays(daysRaw, 30), now, await this.readZone());
    const prisma = this.prismaService;

    const [gateways, windows, days, timeToPay, stuck, channels, failures, partnerBalance, fx] = await Promise.all([
      prisma.paymentGateway.findMany({
        orderBy: [{ orderIndex: 'asc' }, { type: 'asc' }],
        select: { type: true, isActive: true, currency: true },
      }),
      prisma.$queryRaw<ProviderWindowRow[]>(providerWindowsSql(window)),
      prisma.$queryRaw<ProviderDayRow[]>(providerDaysSql(window)),
      prisma.$queryRaw<TimeToPayRow[]>(timeToPaySql(window)),
      // "Stuck" = still PENDING an hour after the checkout started. The pending
      // sweep cancels an abandoned one at 30 minutes, so an hour flags only what
      // really hangs (see `stuckPendingSql` for why not "untouched for an hour").
      prisma.$queryRaw<StuckPendingRow[]>(stuckPendingSql(new Date(now.getTime() - ONE_HOUR_MS))),
      prisma.$queryRaw<ChannelRow[]>(channelMixSql(window)),
      prisma.$queryRaw<FailureReasonRow[]>(failureReasonsSql(window)),
      prisma.$queryRaw<PartnerBalanceRow[]>(partnerBalanceSql(window)),
      readFxSnapshot(prisma, this.fxRateService.getBaseCurrency()),
    ]);

    return assembleProviderReport(
      window,
      {
        windows,
        days,
        timeToPay,
        stuck,
        channels,
        // A provider's status string can carry a checkout URL, a payment id or
        // an e-mail: redacted before it reaches any response.
        failures: failures.map((row) => ({ ...row, reason: sanitizeAnalyticsLabel(row.reason, 'unknown', 80) })),
        partnerBalance,
      },
      gateways.map((gateway) => ({ type: gateway.type, isActive: gateway.isActive, currency: gateway.currency })),
      fx,
    );
  }

  // ───────────────────────────────────────────────────────────────────────
  //  Level 2 — Webhook health
  // ───────────────────────────────────────────────────────────────────────

  public async getWebhookHealth(daysRaw: number): Promise<PaymentWebhookHealthReportInterface> {
    const now = new Date();
    // The same window as the providers report beside it: from local midnight
    // of the first day, in the operator's zone.
    const window = planAnalyticsWindow(clampDays(daysRaw, 7), now, await this.readZone());
    const days = window.days;
    const windowStart = window.start;

    const [statusRows, latencyRows, errorRows, reconciliation] = await Promise.all([
      this.queryWebhookStatuses(windowStart),
      this.queryWebhookLatencyPercentiles(windowStart),
      this.queryWebhookErrors(windowStart),
      this.queryReconciliationGap(windowStart),
    ]);

    interface AccumRow {
      received: number;
      processed: number;
      failed: number;
      retrying: number;
      replayed: number;
    }
    const accums = new Map<PaymentGatewayType, AccumRow>();
    for (const row of statusRows) {
      const existing = accums.get(row.gateway_type) ?? {
        received: 0,
        processed: 0,
        failed: 0,
        retrying: 0,
        replayed: 0,
      };
      const count = Number(row.count);
      existing.received += count;
      switch (row.status) {
        case PaymentWebhookLifecycleStatus.PROCESSED:
          existing.processed += count;
          break;
        case PaymentWebhookLifecycleStatus.FAILED:
          existing.failed += count;
          break;
        default:
          // RECEIVED, ENQUEUED, PROCESSING — still in flight
          existing.retrying += count;
          break;
      }
      existing.replayed += Number(row.replayed_count);
      accums.set(row.gateway_type, existing);
    }

    const latencyMap = new Map<PaymentGatewayType, { median: number | null; p95: number | null }>(
      latencyRows.map((row) => [row.gateway_type, { median: row.median_ms, p95: row.p95_ms }]),
    );
    const errorMap = new Map<PaymentGatewayType, { error: string; count: number }[]>();
    for (const row of errorRows) {
      const reasonText = sanitizeAnalyticsLabel(row.last_error, 'unknown', 120);
      const existing = errorMap.get(row.gateway_type) ?? [];
      existing.push({ error: reasonText, count: Number(row.count) });
      errorMap.set(row.gateway_type, existing);
    }

    const perGateway: WebhookGatewayHealthInterface[] = [];
    for (const [gatewayType, accum] of accums.entries()) {
      const latency = latencyMap.get(gatewayType);
      const errors = errorMap.get(gatewayType) ?? [];
      perGateway.push({
        gatewayType,
        received: accum.received,
        processed: accum.processed,
        failed: accum.failed,
        retrying: accum.retrying,
        replayed: accum.replayed,
        deliveryRate: accum.received === 0 ? 0 : accum.processed / accum.received,
        medianLatencyMs: latency?.median ?? null,
        p95LatencyMs: latency?.p95 ?? null,
        topErrors: errors.slice(0, 5),
      });
    }
    perGateway.sort((a, b) => b.received - a.received || a.gatewayType.localeCompare(b.gatewayType));

    const totalReceived = perGateway.reduce((sum, row) => sum + row.received, 0);
    const totalProcessed = perGateway.reduce((sum, row) => sum + row.processed, 0);
    const totalFailed = perGateway.reduce((sum, row) => sum + row.failed, 0);

    return {
      windowDays: days,
      windowStart: windowStart.toISOString(),
      generatedAt: now.toISOString(),
      totalReceived,
      totalProcessed,
      totalFailed,
      reconciliation,
      perGateway,
    };
  }

  private async queryWebhookStatuses(windowStart: Date): Promise<readonly WebhookGatewayRow[]> {
    const sql = `
      SELECT
        gateway_type,
        status,
        COUNT(*)::bigint AS count,
        COUNT(*) FILTER (WHERE replay_count > 0)::bigint AS replayed_count
      FROM payment_webhook_events
      WHERE received_at >= $1
      GROUP BY gateway_type, status
    `;
    return this.prismaService.$queryRawUnsafe<WebhookGatewayRow[]>(sql, windowStart);
  }

  private async queryWebhookLatencyPercentiles(
    windowStart: Date,
  ): Promise<readonly WebhookLatencyRow[]> {
    const sql = `
      SELECT
        gateway_type,
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (processed_at - received_at)) * 1000
        ) AS median_ms,
        percentile_cont(0.95) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (processed_at - received_at)) * 1000
        ) AS p95_ms
      FROM payment_webhook_events
      WHERE processed_at IS NOT NULL AND received_at >= $1
      GROUP BY gateway_type
    `;
    return this.prismaService.$queryRawUnsafe<WebhookLatencyRow[]>(sql, windowStart);
  }

  private async queryWebhookErrors(windowStart: Date): Promise<readonly WebhookErrorRow[]> {
    const sql = `
      WITH per_gateway AS (
        SELECT
          gateway_type,
          COALESCE(NULLIF(last_error, ''), 'unknown') AS last_error,
          COUNT(*)::bigint AS count,
          ROW_NUMBER() OVER (
            PARTITION BY gateway_type
            ORDER BY COUNT(*) DESC
          ) AS rn
        FROM payment_webhook_events
        WHERE last_error IS NOT NULL AND received_at >= $1
        GROUP BY gateway_type, COALESCE(NULLIF(last_error, ''), 'unknown')
      )
      SELECT gateway_type, last_error, count
      FROM per_gateway
      WHERE rn <= 5
      ORDER BY gateway_type, count DESC
    `;
    return this.prismaService.$queryRawUnsafe<WebhookErrorRow[]>(sql, windowStart);
  }

  /**
   * Reconciliation gap: transactions with no webhook event and webhooks
   * with no transaction. Both are alerts — the first means the provider
   * forgot to call us back; the second means we received unsolicited
   * traffic (probe, attack, or stale config).
   *
   * An imported payment is not a transaction the provider owes this panel a
   * call about: every importer writes the donor's own gateway id into
   * `gateway_id` and marks the row `plan_snapshot.importedFrom`, and the
   * donor's webhooks went to the donor. Counted, a Bedolaga import turned a
   * year of settled payments into «Транзакции без вебхука».
   */
  private async queryReconciliationGap(windowStart: Date): Promise<ReconciliationGapInterface> {
    const sql = `
      SELECT
        (
          SELECT COUNT(*)::bigint FROM transactions t
          WHERE t.created_at >= $1
            AND t.gateway_id IS NOT NULL
            AND (t.plan_snapshot->>'importedFrom') IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM payment_webhook_events e
              WHERE e.payment_id = t.payment_id
            )
        ) AS transactions_missing_webhook,
        (
          SELECT COUNT(*)::bigint FROM payment_webhook_events e
          WHERE e.received_at >= $1
            AND NOT EXISTS (
              SELECT 1 FROM transactions t
              WHERE t.payment_id = e.payment_id
            )
        ) AS webhooks_missing_transaction
    `;
    const rows = await this.prismaService.$queryRawUnsafe<readonly ReconciliationRow[]>(sql, windowStart);
    const row = rows[0];
    return {
      transactionsMissingWebhook: row ? Number(row.transactions_missing_webhook) : 0,
      webhooksMissingTransaction: row ? Number(row.webhooks_missing_transaction) : 0,
    };
  }
}
