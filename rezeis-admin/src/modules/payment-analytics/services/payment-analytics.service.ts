import { Injectable, Logger } from '@nestjs/common';
import {
  PaymentGateway,
  PaymentGatewayType,
  PaymentWebhookLifecycleStatus,
  Prisma,
  PurchaseChannel,
  TransactionStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { redactPaymentDiagnosticMessage } from '../../payments/utils/payment-provider-error.util';
import {
  PaymentProvidersReportInterface,
  PaymentWebhookHealthReportInterface,
  ProviderDailyPointInterface,
  ProviderDetailInterface,
  ProviderFailureReasonInterface,
  ReconciliationGapInterface,
  WebhookGatewayHealthInterface,
} from '../interfaces/payment-analytics.types';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

/** Clamp a window-size request to a sane positive integer. */
function clampDays(days: number, fallback: number): number {
  if (!Number.isFinite(days) || days <= 0) return fallback;
  return Math.min(365, Math.max(1, Math.floor(days)));
}

function startOfDayUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function isoDay(d: Date): string {
  return startOfDayUtc(d).toISOString().slice(0, 10);
}

function sanitizeAnalyticsLabel(
  value: string | null | undefined,
  fallback: string,
  maxLength: number,
): string {
  return redactPaymentDiagnosticMessage(value ?? fallback, maxLength) ?? fallback;
}

interface DailyAggregateRow {
  readonly day: string;
  readonly gateway_type: PaymentGatewayType;
  readonly transactions: bigint;
  readonly successful: bigint;
  readonly revenue: string | null;
}

interface PendingAggregateRow {
  readonly gateway_type: PaymentGatewayType;
  readonly stuck_pending: bigint;
}

interface TimeToPayRow {
  readonly gateway_type: PaymentGatewayType;
  readonly median_seconds: number | null;
  readonly p95_seconds: number | null;
}

interface ChannelMixRow {
  readonly gateway_type: PaymentGatewayType;
  readonly channel: PurchaseChannel;
  readonly count: bigint;
}

interface FailureReasonRow {
  readonly gateway_type: PaymentGatewayType;
  readonly reason: string | null;
  readonly count: bigint;
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
 * PostgreSQL with `$queryRawUnsafe` so we don't drag full result sets
 * into Node memory (transaction history can be very large).
 *
 * Scope:
 *   • Provider-level performance (Level 1 in the design doc): GMV,
 *     conversion rate, avg ticket, time-to-pay percentiles, daily trend,
 *     top failure reasons, channel mix, period-over-period delta.
 *   • Webhook health (Level 2): delivery rate per gateway, replay rate,
 *     latency percentiles, top errors, reconciliation gap.
 *
 * The service avoids returning raw transaction rows or PII — every
 * endpoint emits aggregated metrics only.
 */
@Injectable()
export class PaymentAnalyticsService {
  private readonly logger = new Logger(PaymentAnalyticsService.name);

  public constructor(private readonly prismaService: PrismaService) {}

  // ───────────────────────────────────────────────────────────────────────
  //  Level 1 — Provider performance
  // ───────────────────────────────────────────────────────────────────────

  public async getProviderReport(daysRaw: number): Promise<PaymentProvidersReportInterface> {
    const days = clampDays(daysRaw, 30);
    const now = new Date();
    const windowStart = new Date(startOfDayUtc(now).getTime() - (days - 1) * ONE_DAY_MS);
    const previousWindowStart = new Date(windowStart.getTime() - days * ONE_DAY_MS);

    const [gateways, dailyRows, pendingRows, timeToPayRows, channelRows, failureRows, previousAggregate] =
      await Promise.all([
        this.prismaService.paymentGateway.findMany({
          orderBy: [{ orderIndex: 'asc' }, { type: 'asc' }],
        }),
        this.queryDailyAggregate(windowStart),
        this.queryStuckPending(now),
        this.queryTimeToPayPercentiles(windowStart),
        this.queryChannelMix(windowStart),
        this.queryFailureReasons(windowStart),
        this.queryWindowAggregate(previousWindowStart, windowStart),
      ]);

    // ── Aggregate the current-window rows in one pass ─────────────────────
    interface CurrentAccum {
      transactions: number;
      completed: number;
      pending: number;
      failed: number;
      canceled: number;
      grossRevenue: number;
      daily: Map<string, ProviderDailyPointInterface>;
    }
    const accums = new Map<PaymentGatewayType, CurrentAccum>();
    const ensureAccum = (gateway: PaymentGatewayType): CurrentAccum => {
      const existing = accums.get(gateway);
      if (existing) return existing;
      const fresh: CurrentAccum = {
        transactions: 0,
        completed: 0,
        pending: 0,
        failed: 0,
        canceled: 0,
        grossRevenue: 0,
        daily: new Map(),
      };
      accums.set(gateway, fresh);
      return fresh;
    };

    // First pass: status counts & gross revenue. We do this with a
    // per-status group-by because daily rows already filter by completed.
    const statusCounts = await this.prismaService.transaction.groupBy({
      by: ['gatewayType', 'status'],
      where: { updatedAt: { gte: windowStart } },
      _count: { _all: true },
      _sum: { amount: true },
    });
    for (const row of statusCounts) {
      const acc = ensureAccum(row.gatewayType);
      acc.transactions += row._count._all;
      switch (row.status) {
        case TransactionStatus.COMPLETED:
          acc.completed += row._count._all;
          acc.grossRevenue += Number(row._sum.amount ?? 0);
          break;
        case TransactionStatus.PENDING:
          acc.pending += row._count._all;
          break;
        case TransactionStatus.FAILED:
          acc.failed += row._count._all;
          break;
        case TransactionStatus.CANCELED:
          acc.canceled += row._count._all;
          break;
      }
    }

    // Daily series — fill all days for every gateway present so charts
    // render continuous lines.
    for (const row of dailyRows) {
      const acc = ensureAccum(row.gateway_type);
      acc.daily.set(row.day, {
        day: row.day,
        revenue: Number(row.revenue ?? 0),
        transactions: Number(row.transactions),
        successful: Number(row.successful),
      });
    }

    const stuckMap = new Map<PaymentGatewayType, number>(
      pendingRows.map((row) => [row.gateway_type, Number(row.stuck_pending)]),
    );
    const timeToPayMap = new Map<PaymentGatewayType, { median: number | null; p95: number | null }>(
      timeToPayRows.map((row) => [
        row.gateway_type,
        { median: row.median_seconds, p95: row.p95_seconds },
      ]),
    );
    const failureMap = new Map<PaymentGatewayType, ProviderFailureReasonInterface[]>();
    for (const row of failureRows) {
      const reasonText = sanitizeAnalyticsLabel(row.reason, 'unknown', 80);
      const list = failureMap.get(row.gateway_type) ?? [];
      list.push({ reason: reasonText, count: Number(row.count), share: 0 });
      failureMap.set(row.gateway_type, list);
    }
    const channelMap = new Map<
      PaymentGatewayType,
      { web: number; telegram: number; total: number }
    >();
    for (const row of channelRows) {
      const existing = channelMap.get(row.gateway_type) ?? { web: 0, telegram: 0, total: 0 };
      const count = Number(row.count);
      existing.total += count;
      if (row.channel === PurchaseChannel.WEB) {
        existing.web += count;
      } else {
        existing.telegram += count;
      }
      channelMap.set(row.gateway_type, existing);
    }

    const previousByGateway = previousAggregate;

    const providers: ProviderDetailInterface[] = gateways.map((gateway) =>
      this.buildProviderDetail({
        gateway,
        accum: accums.get(gateway.type),
        stuckPending: stuckMap.get(gateway.type) ?? 0,
        timeToPay: timeToPayMap.get(gateway.type),
        topFailures: failureMap.get(gateway.type) ?? [],
        channelStats: channelMap.get(gateway.type),
        previous: previousByGateway.get(gateway.type),
        windowDays: days,
      }),
    );

    // Append any "orphan" gateway types we saw transactions for but which
    // don't have a catalog row (legacy data, manual seeding, etc.).
    const knownTypes = new Set(gateways.map((g) => g.type));
    for (const [gatewayType, accum] of accums.entries()) {
      if (knownTypes.has(gatewayType)) continue;
      providers.push(
        this.buildProviderDetail({
          gateway: null,
          accum,
          stuckPending: stuckMap.get(gatewayType) ?? 0,
          timeToPay: timeToPayMap.get(gatewayType),
          topFailures: failureMap.get(gatewayType) ?? [],
          channelStats: channelMap.get(gatewayType),
          previous: previousByGateway.get(gatewayType),
          windowDays: days,
          fallbackType: gatewayType,
        }),
      );
    }

    providers.sort((a, b) => b.grossRevenue - a.grossRevenue || a.gatewayType.localeCompare(b.gatewayType));

    const totalGrossRevenue = providers.reduce((sum, p) => sum + p.grossRevenue, 0);
    const totalTransactions = providers.reduce((sum, p) => sum + p.transactions, 0);
    const totalCompleted = providers.reduce((sum, p) => sum + p.completed, 0);

    return {
      windowDays: days,
      windowStart: windowStart.toISOString(),
      previousWindowStart: previousWindowStart.toISOString(),
      generatedAt: now.toISOString(),
      totalGrossRevenue,
      totalTransactions,
      totalCompleted,
      providers,
    };
  }

  private buildProviderDetail(input: {
    readonly gateway: PaymentGateway | null;
    readonly accum: {
      transactions: number;
      completed: number;
      pending: number;
      failed: number;
      canceled: number;
      grossRevenue: number;
      daily: Map<string, ProviderDailyPointInterface>;
    } | undefined;
    readonly stuckPending: number;
    readonly timeToPay?: { median: number | null; p95: number | null };
    readonly topFailures: ProviderFailureReasonInterface[];
    readonly channelStats: { web: number; telegram: number; total: number } | undefined;
    readonly previous: ProviderWindowAggregate | undefined;
    readonly windowDays: number;
    readonly fallbackType?: PaymentGatewayType;
  }): ProviderDetailInterface {
    const gatewayType = input.gateway?.type ?? input.fallbackType;
    if (!gatewayType) {
      throw new Error('buildProviderDetail: missing gatewayType (programmer error)');
    }

    const accum = input.accum ?? {
      transactions: 0,
      completed: 0,
      pending: 0,
      failed: 0,
      canceled: 0,
      grossRevenue: 0,
      daily: new Map(),
    };

    const closedAttempts = accum.completed + accum.failed + accum.canceled;
    const successRate = closedAttempts === 0 ? 0 : accum.completed / closedAttempts;
    const checkoutRate = accum.transactions === 0 ? 0 : accum.completed / accum.transactions;
    const avgTicket = accum.completed === 0 ? 0 : accum.grossRevenue / accum.completed;

    // Build a contiguous daily series so charts don't have gaps.
    const daily = this.fillDailySeries(accum.daily, input.windowDays);

    // Failure share ratios.
    const totalFailureCount = input.topFailures.reduce((sum, r) => sum + r.count, 0);
    const topFailureReasons: ProviderFailureReasonInterface[] = input.topFailures
      .slice(0, 5)
      .map((reason) => ({
        reason: reason.reason,
        count: reason.count,
        share: totalFailureCount === 0 ? 0 : reason.count / totalFailureCount,
      }));

    // Channel mix (defaults to 0/0 when no transactions yet).
    const channelMix = input.channelStats && input.channelStats.total > 0
      ? {
          web: input.channelStats.web / input.channelStats.total,
          telegram: input.channelStats.telegram / input.channelStats.total,
        }
      : { web: 0, telegram: 0 };

    // Period-over-period delta. `null` when previous window has no data
    // so the UI can show "—" instead of misleading "+∞%".
    const previous = input.previous;
    const revenuePct =
      !previous || previous.completed === 0
        ? null
        : (accum.grossRevenue - previous.grossRevenue) / previous.grossRevenue;
    const transactionsPct =
      !previous || previous.transactions === 0
        ? null
        : (accum.transactions - previous.transactions) / previous.transactions;
    const previousClosed =
      previous === undefined ? 0 : previous.completed + previous.failed + previous.canceled;
    const previousSuccessRate = previousClosed === 0 ? null : previous!.completed / previousClosed;
    const successRateDelta =
      previousSuccessRate === null ? null : successRate - previousSuccessRate;

    return {
      gatewayType,
      isActive: input.gateway?.isActive ?? false,
      currency: input.gateway?.currency ?? 'USD',
      transactions: accum.transactions,
      completed: accum.completed,
      pending: accum.pending,
      failed: accum.failed,
      canceled: accum.canceled,
      grossRevenue: accum.grossRevenue,
      avgTicket,
      successRate,
      checkoutRate,
      medianTimeToPaySeconds: input.timeToPay?.median ?? null,
      p95TimeToPaySeconds: input.timeToPay?.p95 ?? null,
      stuckPending: input.stuckPending,
      delta: { revenuePct, transactionsPct, successRateDelta },
      daily,
      topFailureReasons,
      channelMix,
    };
  }

  private fillDailySeries(
    map: Map<string, ProviderDailyPointInterface>,
    windowDays: number,
  ): readonly ProviderDailyPointInterface[] {
    const series: ProviderDailyPointInterface[] = [];
    const today = startOfDayUtc(new Date());
    for (let i = windowDays - 1; i >= 0; i--) {
      const day = isoDay(new Date(today.getTime() - i * ONE_DAY_MS));
      const existing = map.get(day);
      series.push(existing ?? { day, revenue: 0, transactions: 0, successful: 0 });
    }
    return series;
  }

  private async queryDailyAggregate(windowStart: Date): Promise<readonly DailyAggregateRow[]> {
    const sql = `
      SELECT
        date_trunc('day', updated_at AT TIME ZONE 'UTC')::date::text AS day,
        gateway_type,
        COUNT(*)::bigint AS transactions,
        COUNT(*) FILTER (WHERE status = 'COMPLETED')::bigint AS successful,
        SUM(amount) FILTER (WHERE status = 'COMPLETED') AS revenue
      FROM transactions
      WHERE updated_at >= $1
      GROUP BY 1, gateway_type
      ORDER BY 1, gateway_type
    `;
    return this.prismaService.$queryRawUnsafe<DailyAggregateRow[]>(sql, windowStart);
  }

  private async queryStuckPending(now: Date): Promise<readonly PendingAggregateRow[]> {
    // "Stuck" = still PENDING after one hour. Tunable via the constant
    // above; one hour is a safe default that won't flag normal slow
    // payments (most providers settle within 5 minutes).
    const cutoff = new Date(now.getTime() - ONE_HOUR_MS);
    const sql = `
      SELECT gateway_type, COUNT(*)::bigint AS stuck_pending
      FROM transactions
      WHERE status = 'PENDING' AND updated_at < $1
      GROUP BY gateway_type
    `;
    return this.prismaService.$queryRawUnsafe<PendingAggregateRow[]>(sql, cutoff);
  }

  private async queryTimeToPayPercentiles(windowStart: Date): Promise<readonly TimeToPayRow[]> {
    const sql = `
      SELECT
        gateway_type,
        percentile_cont(0.5)  WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (updated_at - created_at))) AS median_seconds,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (updated_at - created_at))) AS p95_seconds
      FROM transactions
      WHERE status = 'COMPLETED' AND updated_at >= $1
      GROUP BY gateway_type
    `;
    return this.prismaService.$queryRawUnsafe<TimeToPayRow[]>(sql, windowStart);
  }

  private async queryChannelMix(windowStart: Date): Promise<readonly ChannelMixRow[]> {
    const sql = `
      SELECT gateway_type, channel, COUNT(*)::bigint AS count
      FROM transactions
      WHERE updated_at >= $1
      GROUP BY gateway_type, channel
    `;
    return this.prismaService.$queryRawUnsafe<ChannelMixRow[]>(sql, windowStart);
  }

  /**
   * Top failure reasons per gateway. We pull the provider-supplied
   * status string from `gateway_data->>'providerStatus'` (set by
   * `payment-provider-execution.service.ts` for every adapter) and fall
   * back to the bare `status`.
   */
  private async queryFailureReasons(windowStart: Date): Promise<readonly FailureReasonRow[]> {
    const sql = `
      WITH per_gateway AS (
        SELECT
          gateway_type,
          COALESCE(NULLIF(gateway_data->>'providerStatus', ''), status::text) AS reason,
          COUNT(*)::bigint AS count,
          ROW_NUMBER() OVER (
            PARTITION BY gateway_type
            ORDER BY COUNT(*) DESC
          ) AS rn
        FROM transactions
        WHERE updated_at >= $1 AND status IN ('FAILED', 'CANCELED')
        GROUP BY gateway_type, COALESCE(NULLIF(gateway_data->>'providerStatus', ''), status::text)
      )
      SELECT gateway_type, reason, count
      FROM per_gateway
      WHERE rn <= 5
      ORDER BY gateway_type, count DESC
    `;
    return this.prismaService.$queryRawUnsafe<FailureReasonRow[]>(sql, windowStart);
  }

  private async queryWindowAggregate(
    windowStart: Date,
    windowEnd: Date,
  ): Promise<Map<PaymentGatewayType, ProviderWindowAggregate>> {
    const rows = await this.prismaService.transaction.groupBy({
      by: ['gatewayType', 'status'],
      where: { updatedAt: { gte: windowStart, lt: windowEnd } },
      _count: { _all: true },
      _sum: { amount: true },
    });

    const map = new Map<PaymentGatewayType, ProviderWindowAggregate>();
    for (const row of rows) {
      const existing =
        map.get(row.gatewayType) ?? {
          transactions: 0,
          completed: 0,
          failed: 0,
          canceled: 0,
          grossRevenue: 0,
        };
      existing.transactions += row._count._all;
      switch (row.status) {
        case TransactionStatus.COMPLETED:
          existing.completed += row._count._all;
          existing.grossRevenue += Number(row._sum.amount ?? 0);
          break;
        case TransactionStatus.FAILED:
          existing.failed += row._count._all;
          break;
        case TransactionStatus.CANCELED:
          existing.canceled += row._count._all;
          break;
        default:
          break;
      }
      map.set(row.gatewayType, existing);
    }
    return map;
  }

  // ───────────────────────────────────────────────────────────────────────
  //  Level 2 — Webhook health
  // ───────────────────────────────────────────────────────────────────────

  public async getWebhookHealth(daysRaw: number): Promise<PaymentWebhookHealthReportInterface> {
    const days = clampDays(daysRaw, 7);
    const now = new Date();
    const windowStart = new Date(startOfDayUtc(now).getTime() - (days - 1) * ONE_DAY_MS);

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
   */
  private async queryReconciliationGap(windowStart: Date): Promise<ReconciliationGapInterface> {
    const sql = `
      SELECT
        (
          SELECT COUNT(*)::bigint FROM transactions t
          WHERE t.created_at >= $1
            AND t.gateway_id IS NOT NULL
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

interface ProviderWindowAggregate {
  transactions: number;
  completed: number;
  failed: number;
  canceled: number;
  grossRevenue: number;
}

// `Prisma` import is needed by the @prisma/client tooling even though we
// don't reference it at runtime — re-exporting the namespace keeps the
// generator happy in older toolchains.
export type { Prisma };
