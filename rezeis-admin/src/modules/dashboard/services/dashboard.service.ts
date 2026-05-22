import { Injectable } from '@nestjs/common';
import {
  SubscriptionStatus,
  TransactionStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { RawCacheService } from '../../../common/cache/raw-cache.service';
import {
  DashboardAttentionItemInterface,
  DashboardMetricInterface,
  DashboardSummaryInterface,
  DashboardTimelineEntryInterface,
} from '../interfaces/dashboard-summary.interface';

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

/** Cache key for the dashboard summary. */
const DASHBOARD_SUMMARY_CACHE_KEY = 'dashboard:summary';
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
      grossVolumeAggregate,
      broadcastDrafts,
      importDryRunCount,
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
      this.prismaService.transaction.aggregate({
        where: { status: TransactionStatus.COMPLETED },
        _sum: { amount: true },
      }),
      // Phase 4 broadcast drafts (Broadcast model). Bounded count.
      this.prismaService.broadcast.count({ where: { status: 'DRAFT' } }),
      // Phase 4 import dry runs available (Imports model).
      this.prismaService.importRecord.count({ where: { status: 'DRY_RUN' } }),
    ]);

    const grossVolume = (grossVolumeAggregate._sum.amount ?? 0).toString();

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
      { code: 'GROSS_VOLUME', label: 'Gross volume', value: grossVolume, description: null },
      { code: 'BROADCAST_DRAFTS', label: 'Broadcast drafts', value: broadcastDrafts, description: null },
      { code: 'IMPORT_DRY_RUN_AVAILABLE', label: 'Imports awaiting commit', value: importDryRunCount, description: null },
    ];

    // Skeleton sections — empty until the corresponding feature surfaces
    // are wired into the dashboard. The UI handles empty arrays
    // gracefully (renders an "empty" state per panel).
    const operationsTimeline: DashboardTimelineEntryInterface[] = [];
    const financeOpsTimeline: DashboardTimelineEntryInterface[] = [];
    const attentionItems: DashboardAttentionItemInterface[] = [];

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
        grossVolume,
      },
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
