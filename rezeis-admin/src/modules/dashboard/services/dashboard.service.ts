import { Injectable } from '@nestjs/common';
import {
  PaymentWebhookLifecycleStatus,
  Prisma,
  SubscriptionStatus,
  TransactionStatus,
  WithdrawalStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { RawCacheService } from '../../../common/cache/raw-cache.service';
import { moneyReceivedSql, netAmountSql } from '../../business-analytics/utils/analytics-money-received.util';
import { chooseMoneyView, type FxSnapshot, moneyFigure, readFxSnapshot } from '../../business-analytics/utils/analytics-money.util';
import { FxRateService } from '../../fx/fx-rate.service';
import {
  DashboardAttentionItemInterface,
  DashboardAttentionSeverity,
  DashboardMetricInterface,
  DashboardRevenueInterface,
  DashboardSummaryInterface,
  DashboardTimelineEntryInterface,
  DashboardTimelineStatus,
} from '../interfaces/dashboard-summary.interface';

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

/**
 * Cache key for the dashboard summary — with the number of its shape. The
 * summary is cached as the parsed object, and Redis outlives an image
 * update: a panel reading a summary an older panel wrote would hand the page
 * a shape it does not know. v2: `revenue` added, `grossVolume` withdrawn.
 */
const DASHBOARD_SUMMARY_CACHE_KEY = 'dashboard:summary:v2';

/** What `transactions.grossVolume` holds since the tile became `revenue`. */
const GROSS_VOLUME_WITHDRAWN = '—';

type SqlNumeric = Prisma.Decimal | string | number | bigint | null;

export interface LifetimeRevenueRow {
  readonly currency: string;
  readonly amount: SqlNumeric;
  readonly payments: number;
}

/**
 * Money received over the panel's whole history, per currency — the rule of
 * «Бизнес-аналитика» (`analytics-money-received.util.ts`): completed, for more
 * than nothing, not paid from a partner's balance, net of a partial refund.
 * «Выручка» there is the same sum over a window.
 */
export function lifetimeRevenueSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT t."currency"::text AS "currency", SUM(${netAmountSql()}) AS "amount", COUNT(*)::int AS "payments"
      FROM "transactions" t
     WHERE ${moneyReceivedSql()}
     GROUP BY 1`;
}

/**
 * The tile's figure: one currency natively, several in the reporting base at
 * the panel's rates — a currency with no rate left out and named
 * (`analytics-money.util.ts`).
 */
export function assembleLifetimeRevenue(rows: readonly LifetimeRevenueRow[], fx: FxSnapshot): DashboardRevenueInterface {
  const sums = new Map<string, number>();
  let payments = 0;
  for (const row of rows) {
    const amount = row.amount === null ? 0 : Number(row.amount);
    sums.set(row.currency, (sums.get(row.currency) ?? 0) + amount);
    payments += row.payments;
  }
  const money = chooseMoneyView(
    [...sums.entries()].filter(([, amount]) => amount !== 0).map(([currency]) => currency),
    fx,
  );
  return { figure: moneyFigure(money, sums), money, payments };
}
/** Cache TTL in seconds — 60s keeps the dashboard fresh while reducing DB load by ~95%. */
const DASHBOARD_SUMMARY_TTL_SECONDS = 60;

/**
 * Aggregates the bounded KPI summary that powers the admin dashboard.
 *
 * All queries are bounded counters — no entity rows, raw payloads, or
 * provider identifiers leave the service. Every count is computed inside the
 * database to keep page rendering fast on busy installations.
 *
 * Shape mirrors `DashboardSummaryInterface` 1:1 so the SPA can render
 * every panel without conditional fallbacks. Some sections are still
 * "skeleton" — `financeOps` counters and the timelines return zeroes /
 * empty arrays until the corresponding feature modules surface them.
 * That stays compatible with the React UI which simply renders empty
 * states for those panels.
 */
@Injectable()
export class DashboardService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly cacheService: RawCacheService,
    /**
     * Only for the reporting base currency: the rates themselves are READ from
     * `fx_rates`, never fetched — the summary must not wait on an exchange.
     */
    private readonly fxRateService: FxRateService,
  ) {}

  public async getSummary(): Promise<DashboardSummaryInterface> {
    return this.cacheService.getOrSet<DashboardSummaryInterface>(
      DASHBOARD_SUMMARY_CACHE_KEY,
      () => this.computeSummary(),
      DASHBOARD_SUMMARY_TTL_SECONDS,
    );
  }

  private async computeSummary(): Promise<DashboardSummaryInterface> {
    const now = new Date();
    const expiryHorizon7d = new Date(now.getTime() + 7 * ONE_DAY_MS);
    const recentRegistered7dStart = new Date(now.getTime() - 7 * ONE_DAY_MS);

    const [
      usersTotal,
      usersBlocked,
      usersRecentRegistered7d,
      subscriptionsActive,
      subscriptionsLimited,
      subscriptionsExpiring7d,
      subscriptionsExpired,
      transactionsCompleted,
      transactionsPending,
      transactionsFailed,
      lifetimeRevenueRows,
      fx,
      broadcastDrafts,
      importDryRunCount,
      withdrawalsPending,
      webhooksFailed,
    ] = await Promise.all([
      this.prismaService.user.count(),
      this.prismaService.user.count({ where: { isBlocked: true } }),
      this.prismaService.user.count({ where: { createdAt: { gte: recentRegistered7dStart } } }),
      this.prismaService.subscription.count({
        where: { status: SubscriptionStatus.ACTIVE },
      }),
      this.prismaService.subscription.count({
        where: { status: SubscriptionStatus.LIMITED },
      }),
      this.prismaService.subscription.count({
        where: {
          status: SubscriptionStatus.ACTIVE,
          expiresAt: { gt: now, lte: expiryHorizon7d },
        },
      }),
      this.prismaService.subscription.count({
        where: { status: SubscriptionStatus.EXPIRED },
      }),
      this.prismaService.transaction.count({
        where: { status: TransactionStatus.COMPLETED },
      }),
      this.prismaService.transaction.count({
        where: { status: TransactionStatus.PENDING },
      }),
      this.prismaService.transaction.count({
        where: { status: TransactionStatus.FAILED },
      }),
      // «Выручка за всё время»: the money of «Бизнес-аналитика» → «Выручка», without a window.
      this.prismaService.$queryRaw<LifetimeRevenueRow[]>(lifetimeRevenueSql()),
      readFxSnapshot(this.prismaService, this.fxRateService.getBaseCurrency()),
      // Phase 4 broadcast drafts (Broadcast model). Bounded count.
      this.prismaService.broadcast.count({ where: { status: 'DRAFT' } }),
      // Phase 4 import dry runs available (Imports model).
      this.prismaService.importRecord.count({ where: { status: 'DRY_RUN' } }),
      // Attention: partner withdrawal requests awaiting an operator decision.
      this.prismaService.partnerWithdrawal.count({ where: { status: WithdrawalStatus.PENDING } }),
      // Attention: payment webhooks that failed to process (reconciliation may be stuck).
      this.prismaService.paymentWebhookEvent.count({
        where: { status: PaymentWebhookLifecycleStatus.FAILED },
      }),
    ]);

    const revenue = assembleLifetimeRevenue(lifetimeRevenueRows, fx);

    // Recent rows powering the two activity timelines. Bounded `take` + a
    // PII-free `select` (no user ids, no payment ids, no raw payloads) keep the
    // dashboard contract narrow while the feeds stay live.
    const [recentImports, recentBroadcasts, recentAudit, recentTransactions] = await Promise.all([
      this.prismaService.importRecord.findMany({
        orderBy: { createdAt: 'desc' },
        take: 6,
        select: {
          id: true,
          sourceType: true,
          status: true,
          recordsOk: true,
          recordsTotal: true,
          recordsFailed: true,
          createdAt: true,
        },
      }),
      this.prismaService.broadcast.findMany({
        orderBy: { createdAt: 'desc' },
        take: 6,
        select: {
          id: true,
          status: true,
          audience: true,
          totalCount: true,
          successCount: true,
          failedCount: true,
          createdAt: true,
        },
      }),
      this.prismaService.adminAuditLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, action: true, createdAt: true },
      }),
      this.prismaService.transaction.findMany({
        orderBy: { createdAt: 'desc' },
        take: 15,
        select: {
          id: true,
          status: true,
          amount: true,
          currency: true,
          purchaseType: true,
          channel: true,
          createdAt: true,
        },
      }),
    ]);

    const metrics: DashboardMetricInterface[] = [
      { code: 'TOTAL_USERS', label: 'Total users', value: usersTotal, description: null },
      { code: 'BLOCKED_USERS', label: 'Blocked users', value: usersBlocked, description: null },
      { code: 'NEW_USERS_7D', label: 'New users (7d)', value: usersRecentRegistered7d, description: null },
      { code: 'ACTIVE_SUBSCRIPTIONS', label: 'Active subscriptions', value: subscriptionsActive, description: null },
      { code: 'LIMITED_SUBSCRIPTIONS', label: 'Limited subscriptions', value: subscriptionsLimited, description: null },
      { code: 'EXPIRED_SUBSCRIPTIONS', label: 'Expired subscriptions', value: subscriptionsExpired, description: null },
      { code: 'EXPIRING_SUBSCRIPTIONS_7D', label: 'Expiring within 7d', value: subscriptionsExpiring7d, description: null },
      { code: 'COMPLETED_TRANSACTIONS', label: 'Completed transactions', value: transactionsCompleted, description: null },
      { code: 'PENDING_TRANSACTIONS', label: 'Pending transactions', value: transactionsPending, description: null },
      { code: 'FAILED_TRANSACTIONS', label: 'Failed transactions', value: transactionsFailed, description: null },
      // No money here: a number without its currency is how «Валовой оборот»
      // came to add roubles to USDT. The money is `revenue`.
      { code: 'BROADCAST_DRAFTS', label: 'Broadcast drafts', value: broadcastDrafts, description: null },
      { code: 'IMPORT_DRY_RUN_AVAILABLE', label: 'Imports awaiting commit', value: importDryRunCount, description: null },
    ];

    // Operations + finance feeds are now populated from the recent rows above.
    const operationsTimeline = buildOperationsTimeline({
      recentImports,
      recentBroadcasts,
      recentAudit,
    });
    const financeOpsTimeline = buildFinanceTimeline(recentTransactions);
    const attentionItems = buildAttentionItems({
      now,
      subscriptionsExpiring7d,
      transactionsPending,
      withdrawalsPending,
      webhooksFailed,
    });

    return {
      checkedAt: now.toISOString(),
      users: {
        total: usersTotal,
        blocked: usersBlocked,
        recentRegistered7d: usersRecentRegistered7d,
      },
      subscriptions: {
        active: subscriptionsActive,
        limited: subscriptionsLimited,
        expired: subscriptionsExpired,
        expiring7d: subscriptionsExpiring7d,
      },
      transactions: {
        completed: transactionsCompleted,
        pending: transactionsPending,
        failed: transactionsFailed,
        grossVolume: GROSS_VOLUME_WITHDRAWN,
      },
      revenue,
      operations: {
        broadcastDrafts,
        importDryRunAvailable: importDryRunCount > 0,
      },
      financeOps: {
        refundRequests: 0,
        executedRefunds: 0,
        correctionNotes: 0,
        correctionRequests: 0,
        disputeRecords: 0,
        reconciliationExceptions: 0,
      },
      metrics,
      operationsTimeline,
      financeOpsTimeline,
      attentionItems,
    };
  }
}

/**
 * Project the live counters into the dashboard "requires attention" list.
 *
 * Only genuinely actionable conditions are surfaced, ordered most-severe
 * first. Titles/descriptions here are English fallbacks — the SPA renders
 * localized copy keyed by `kind` (with the `count`), falling back to these.
 *
 * Thresholds (sensible defaults; tune later):
 *   • WEBHOOK_FAILED     > 0   → CRITICAL (reconciliation may be stuck)
 *   • WITHDRAWAL_PENDING > 0   → WARNING (≥10 → CRITICAL — operator must pay out)
 *   • PAYMENT_PENDING    ≥ 10  → WARNING (a few pending mid-checkout is normal)
 *   • SUBSCRIPTION_EXPIRING > 0 → INFO (≥50 → WARNING)
 */
function buildAttentionItems(input: {
  readonly now: Date;
  readonly subscriptionsExpiring7d: number;
  readonly transactionsPending: number;
  readonly withdrawalsPending: number;
  readonly webhooksFailed: number;
}): DashboardAttentionItemInterface[] {
  const at = input.now.toISOString();
  const items: DashboardAttentionItemInterface[] = [];

  if (input.webhooksFailed > 0) {
    items.push({
      safeKey: 'attention:WEBHOOK_FAILED',
      kind: 'WEBHOOK_FAILED',
      severity: 'CRITICAL',
      count: input.webhooksFailed,
      title: `${input.webhooksFailed} failed payment webhook(s)`,
      description: 'Payment webhooks failed to process — reconciliation may be stuck.',
      occurredAt: at,
      status: 'ACTIVE',
    });
  }

  if (input.withdrawalsPending > 0) {
    const severity: DashboardAttentionSeverity = input.withdrawalsPending >= 10 ? 'CRITICAL' : 'WARNING';
    items.push({
      safeKey: 'attention:WITHDRAWAL_PENDING',
      kind: 'WITHDRAWAL_PENDING',
      severity,
      count: input.withdrawalsPending,
      title: `${input.withdrawalsPending} partner withdrawal(s) pending`,
      description: 'Partner withdrawal requests are awaiting an operator decision.',
      occurredAt: at,
      status: 'PENDING',
    });
  }

  if (input.transactionsPending >= 10) {
    items.push({
      safeKey: 'attention:PAYMENT_PENDING',
      kind: 'PAYMENT_PENDING',
      severity: 'WARNING',
      count: input.transactionsPending,
      title: `${input.transactionsPending} payments pending`,
      description: 'An unusual number of payments are stuck in the pending state.',
      occurredAt: at,
      status: 'PENDING',
    });
  }

  if (input.subscriptionsExpiring7d > 0) {
    const severity: DashboardAttentionSeverity = input.subscriptionsExpiring7d >= 50 ? 'WARNING' : 'INFO';
    items.push({
      safeKey: 'attention:SUBSCRIPTION_EXPIRING',
      kind: 'SUBSCRIPTION_EXPIRING',
      severity,
      count: input.subscriptionsExpiring7d,
      title: `${input.subscriptionsExpiring7d} subscription(s) expiring within 7 days`,
      description: 'Active subscriptions will expire within the next 7 days.',
      occurredAt: at,
      status: 'ACTIVE',
    });
  }

  return items;
}

// ── Activity timelines ──────────────────────────────────────────────────────
//
// Compose the operations + finance feeds from recent rows. Titles/descriptions
// are operator-safe: entity type, status and bounded counters/amounts only —
// never a user id, payment id, or raw payload (the dashboard contract).

interface ImportTimelineRow {
  readonly id: string;
  readonly sourceType: string;
  readonly status: string;
  readonly recordsOk: number;
  readonly recordsTotal: number;
  readonly recordsFailed: number;
  readonly createdAt: Date;
}

interface BroadcastTimelineRow {
  readonly id: string;
  readonly status: string;
  readonly audience: string;
  readonly totalCount: number;
  readonly successCount: number;
  readonly failedCount: number;
  readonly createdAt: Date;
}

interface AuditTimelineRow {
  readonly id: string;
  readonly action: string;
  readonly createdAt: Date;
}

interface TransactionTimelineRow {
  readonly id: string;
  readonly status: string;
  readonly amount: unknown;
  readonly currency: string;
  readonly purchaseType: string;
  readonly channel: string | null;
  readonly createdAt: Date;
}

function buildOperationsTimeline(input: {
  readonly recentImports: readonly ImportTimelineRow[];
  readonly recentBroadcasts: readonly BroadcastTimelineRow[];
  readonly recentAudit: readonly AuditTimelineRow[];
}): DashboardTimelineEntryInterface[] {
  const entries: DashboardTimelineEntryInterface[] = [];

  for (const imp of input.recentImports) {
    entries.push({
      id: `import:${imp.id}`,
      source: 'IMPORT',
      status: mapImportTimelineStatus(imp.status),
      title: `Import: ${imp.sourceType}`,
      description: `${imp.recordsOk}/${imp.recordsTotal} processed, ${imp.recordsFailed} failed`,
      createdAt: imp.createdAt.toISOString(),
      kind: 'IMPORT',
      meta: {
        sourceType: imp.sourceType,
        recordsOk: imp.recordsOk,
        recordsTotal: imp.recordsTotal,
        recordsFailed: imp.recordsFailed,
      },
    });
  }

  for (const broadcast of input.recentBroadcasts) {
    entries.push({
      id: `broadcast:${broadcast.id}`,
      source: 'BROADCAST',
      status: mapBroadcastTimelineStatus(broadcast.status),
      title: `Broadcast: ${broadcast.audience}`,
      description: `${broadcast.successCount}/${broadcast.totalCount} delivered, ${broadcast.failedCount} failed`,
      createdAt: broadcast.createdAt.toISOString(),
      kind: 'BROADCAST',
      meta: {
        audience: broadcast.audience,
        successCount: broadcast.successCount,
        totalCount: broadcast.totalCount,
        failedCount: broadcast.failedCount,
      },
    });
  }

  for (const audit of input.recentAudit) {
    entries.push({
      id: `audit:${audit.id}`,
      // System/ops/backup/cron audit actions feed the dedicated OPS lane; the
      // rest stay under AUDIT. The raw action code itself is kept verbatim
      // (an English identifier), only the lane differs.
      source: isOpsAuditAction(audit.action) ? 'OPS' : 'AUDIT',
      status: mapAuditTimelineStatus(audit.action),
      title: audit.action,
      description: '',
      createdAt: audit.createdAt.toISOString(),
      kind: 'AUDIT',
      meta: { action: audit.action },
    });
  }

  return sortByCreatedAtDesc(entries).slice(0, 20);
}

function buildFinanceTimeline(
  rows: readonly TransactionTimelineRow[],
): DashboardTimelineEntryInterface[] {
  return rows.map((tx) => ({
    id: `txn:${tx.id}`,
    source: 'OPS' as const,
    status: mapTransactionTimelineStatus(tx.status),
    title: `Payment ${tx.status.toLowerCase()}`,
    description: `${tx.purchaseType} via ${tx.channel ?? '—'} · ${formatTimelineAmount(tx.amount)} ${tx.currency}`,
    createdAt: tx.createdAt.toISOString(),
    kind: 'PAYMENT' as const,
    meta: {
      paymentStatus: tx.status,
      purchaseType: tx.purchaseType,
      channel: tx.channel,
      amount: formatTimelineAmount(tx.amount),
      currency: tx.currency,
    },
  }));
}

function sortByCreatedAtDesc(
  entries: DashboardTimelineEntryInterface[],
): DashboardTimelineEntryInterface[] {
  return [...entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function mapImportTimelineStatus(status: string): DashboardTimelineStatus {
  switch (status) {
    case 'COMMITTED':
      return 'SUCCESS';
    case 'FAILED':
      return 'ERROR';
    case 'DRY_RUN':
      return 'PENDING';
    case 'ROLLED_BACK':
      return 'WARNING';
    default:
      return 'INFO';
  }
}

function mapBroadcastTimelineStatus(status: string): DashboardTimelineStatus {
  switch (status) {
    case 'COMPLETED':
      return 'SUCCESS';
    case 'FAILED':
      return 'ERROR';
    case 'PROCESSING':
      return 'INFO';
    case 'CANCELED':
      return 'WARNING';
    case 'DRAFT':
      return 'PENDING';
    default:
      return 'INFO';
  }
}

function mapAuditTimelineStatus(action: string): DashboardTimelineStatus {
  return /fail|deni|error|reject/i.test(action) ? 'WARNING' : 'INFO';
}

/**
 * Audit actions are dotted codes (`plans.created`, `system.backup.completed`).
 * Infrastructure/automation actions belong in the dedicated OPS lane so the
 * AUDIT lane stays focused on operator-driven mutations. Match by prefix.
 */
function isOpsAuditAction(action: string): boolean {
  return /^(system|ops|backup|cron|scheduler|maintenance)\./i.test(action);
}

function mapTransactionTimelineStatus(status: string): DashboardTimelineStatus {
  switch (status) {
    case 'COMPLETED':
      return 'SUCCESS';
    case 'PENDING':
      return 'PENDING';
    case 'FAILED':
      return 'ERROR';
    case 'CANCELED':
      return 'WARNING';
    default:
      return 'INFO';
  }
}

function formatTimelineAmount(amount: unknown): string {
  if (amount === null || amount === undefined) return '0';
  if (typeof amount === 'number') return String(amount);
  if (typeof amount === 'string') return amount;
  // Prisma Decimal (and other objects) expose a faithful toString().
  return String(amount);
}
