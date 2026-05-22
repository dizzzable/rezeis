import { Injectable, Logger } from '@nestjs/common';
import {
  PaymentGatewayType,
  SubscriptionStatus,
  TransactionStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  AdvancedAnalyticsReportInterface,
  BusinessAnalyticsReportInterface,
  ChurnSnapshotInterface,
  CohortRowInterface,
  ConversionFunnelStepInterface,
  DailyMetricInterface,
  KpiSummaryInterface,
  LtvBucketInterface,
  ProviderHealthInterface,
  RevenueByGatewayInterface,
  RevenueByCurrencyItem,
  SubscriptionByPlanItem,
  SubscriptionFunnelInterface,
  TimeSeriesPointInterface,
  TopPayerInterface,
  TrialConversionReport,
  UserGrowthInterface,
} from '../interfaces/business-analytics.types';
import {
  addMonths,
  ANALYTICS_COHORT_MONTHS,
  ANALYTICS_DEFAULT_TOP_PAYERS_LIMIT,
  ANALYTICS_LTV_BUCKETS,
  ANALYTICS_ONE_DAY_MS,
  clampWindow,
  findCohortKeyByUser,
  formatYearMonth,
  monthsBetween,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from '../utils/analytics-date.util';

/**
 * Business analytics aggregation service.
 *
 * Provides chart-ready data for the admin dashboard analytics page. All
 * queries are bounded aggregates — no raw user data leaves the service.
 *
 * Phase 7 additions
 *   - `getAdvancedReport(days)` — KPI bundle with churn, funnel, daily
 *     metrics, provider health.
 *   - `getCohortRetention()` — month-cohort matrix (registration month ×
 *     activity month).
 *   - `getTopPayers()` — leaderboard of users by total revenue.
 *   - `getLtvDistribution()` — histogram of lifetime value across the
 *     paying user base.
 *
 * Type definitions live in `../interfaces/business-analytics.types.ts`
 * and date arithmetic helpers in `../utils/analytics-date.util.ts`.
 */
@Injectable()
export class BusinessAnalyticsService {
  private readonly logger = new Logger(BusinessAnalyticsService.name);

  public constructor(private readonly prismaService: PrismaService) {}

  public async getReport(): Promise<BusinessAnalyticsReportInterface> {
    const now = new Date();
    const todayStart = startOfDay(now);
    const weekStart = startOfWeek(now);
    const monthStart = startOfMonth(now);

    const [
      userGrowth,
      subscriptionFunnel,
      revenueByGateway,
      dailyRevenue7d,
      dailyNewUsers7d,
    ] = await Promise.all([
      this.getUserGrowth(todayStart, weekStart, monthStart),
      this.getSubscriptionFunnel(),
      this.getRevenueByGateway(),
      this.getDailyRevenue7d(now),
      this.getDailyNewUsers7d(now),
    ]);

    return {
      userGrowth,
      subscriptionFunnel,
      revenueByGateway,
      dailyRevenue7d,
      dailyNewUsers7d,
      generatedAt: now.toISOString(),
    };
  }

  // ── Phase 7 — Advanced report ──────────────────────────────────────────

  public async getAdvancedReport(daysRaw: number): Promise<AdvancedAnalyticsReportInterface> {
    const days = clampWindow(daysRaw);
    const now = new Date();
    const windowStart = new Date(startOfDay(now).getTime() - (days - 1) * ANALYTICS_ONE_DAY_MS);
    const previousWindowStart = new Date(windowStart.getTime() - days * ANALYTICS_ONE_DAY_MS);

    const [kpis, churn, funnel, providers, daily] = await Promise.all([
      this.computeKpis(windowStart, days),
      this.computeChurn(windowStart, previousWindowStart, days),
      this.computeFunnel(windowStart),
      this.computeProviderHealth(windowStart),
      this.computeDailyMetrics(windowStart, days),
    ]);

    return {
      kpis,
      churn,
      funnel,
      providers,
      daily,
      windowDays: days,
      generatedAt: now.toISOString(),
    };
  }

  // ── Trial Conversion Analytics ───────────────────────────────────────────

  /**
   * Computes trial-to-paid conversion metrics.
   *
   * - conversionRate: % of trial users who purchased a paid subscription
   * - avgDaysToConvert: average days from trial grant to first payment
   * - totalTrialUsers: users who received a trial in the window
   * - convertedUsers: users who converted to paid
   * - revenueFromConverted: total revenue from converted trial users
   * - topConvertedPlans: which plans converted users chose
   */
  public async getTrialConversion(daysRaw: number): Promise<TrialConversionReport> {
    const days = clampWindow(daysRaw);
    const now = new Date();
    const windowStart = new Date(startOfDay(now).getTime() - (days - 1) * ANALYTICS_ONE_DAY_MS);

    // All trial grants in the window
    const trialGrants = await this.prismaService.trialGrant.findMany({
      where: { grantedAt: { gte: windowStart } },
      select: { userId: true, grantedAt: true },
    });

    const totalTrialUsers = trialGrants.length;
    if (totalTrialUsers === 0) {
      return {
        windowDays: days,
        totalTrialUsers: 0,
        convertedUsers: 0,
        conversionRate: 0,
        avgDaysToConvert: 0,
        revenueFromConverted: 0,
        topConvertedPlans: [],
      };
    }

    const trialUserIds = trialGrants.map((g) => g.userId);
    const trialUserMap = new Map(trialGrants.map((g) => [g.userId, g.grantedAt]));

    // Find first paid transaction for each trial user
    const paidTransactions = await this.prismaService.transaction.findMany({
      where: {
        userId: { in: trialUserIds },
        status: TransactionStatus.COMPLETED,
      },
      select: { userId: true, amount: true, updatedAt: true, planSnapshot: true },
      orderBy: { updatedAt: 'asc' },
    });

    // Group by user — take first transaction per user
    const firstPaidByUser = new Map<string, { amount: number; updatedAt: Date; planSnapshot: unknown }>();
    for (const tx of paidTransactions) {
      if (tx.userId && !firstPaidByUser.has(tx.userId)) {
        firstPaidByUser.set(tx.userId, {
          amount: Number(tx.amount),
          updatedAt: tx.updatedAt,
          planSnapshot: tx.planSnapshot,
        });
      }
    }

    const convertedUsers = firstPaidByUser.size;
    const conversionRate = totalTrialUsers > 0 ? convertedUsers / totalTrialUsers : 0;

    // Calculate average days to convert
    let totalDaysToConvert = 0;
    let revenueFromConverted = 0;
    const planCounts = new Map<string, number>();

    for (const [userId, tx] of firstPaidByUser.entries()) {
      const trialDate = trialUserMap.get(userId);
      if (trialDate) {
        const daysToConvert = (tx.updatedAt.getTime() - trialDate.getTime()) / ANALYTICS_ONE_DAY_MS;
        totalDaysToConvert += Math.max(0, daysToConvert);
      }
      revenueFromConverted += tx.amount;

      // Extract plan name from snapshot
      const snapshot = tx.planSnapshot as Record<string, unknown> | null;
      const planName = typeof snapshot?.name === 'string' ? snapshot.name : 'Unknown';
      planCounts.set(planName, (planCounts.get(planName) ?? 0) + 1);
    }

    const avgDaysToConvert = convertedUsers > 0 ? totalDaysToConvert / convertedUsers : 0;

    const topConvertedPlans = [...planCounts.entries()]
      .map(([plan, count]) => ({ plan, count, percentage: convertedUsers > 0 ? count / convertedUsers : 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      windowDays: days,
      totalTrialUsers,
      convertedUsers,
      conversionRate,
      avgDaysToConvert: Math.round(avgDaysToConvert * 10) / 10,
      revenueFromConverted,
      topConvertedPlans,
    };
  }

  /**
   * Revenue breakdown by currency for pie/donut charts.
   */
  public async getRevenueByCurrency(daysRaw: number): Promise<readonly RevenueByCurrencyItem[]> {
    const days = clampWindow(daysRaw);
    const windowStart = new Date(startOfDay(new Date()).getTime() - (days - 1) * ANALYTICS_ONE_DAY_MS);

    const grouped = await this.prismaService.transaction.groupBy({
      by: ['currency'],
      where: { status: TransactionStatus.COMPLETED, updatedAt: { gte: windowStart } },
      _sum: { amount: true },
      _count: { _all: true },
    });

    const total = grouped.reduce((sum, row) => sum + Number(row._sum.amount ?? 0), 0);

    return grouped
      .map((row) => ({
        currency: row.currency,
        revenue: Number(row._sum.amount ?? 0),
        transactions: row._count._all,
        percentage: total > 0 ? Number(row._sum.amount ?? 0) / total : 0,
      }))
      .sort((a, b) => b.revenue - a.revenue);
  }

  /**
   * Subscription distribution by plan name.
   */
  public async getSubscriptionsByPlan(): Promise<readonly SubscriptionByPlanItem[]> {
    const allSubs = await this.prismaService.subscription.findMany({
      where: { status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.LIMITED] } },
      select: { planSnapshot: true, status: true },
    });

    const planCounts = new Map<string, { active: number; limited: number }>();
    for (const sub of allSubs) {
      const snapshot = sub.planSnapshot as Record<string, unknown> | null;
      const planName = typeof snapshot?.name === 'string' ? snapshot.name : 'Unknown';
      const existing = planCounts.get(planName) ?? { active: 0, limited: 0 };
      if (sub.status === SubscriptionStatus.ACTIVE) existing.active += 1;
      else existing.limited += 1;
      planCounts.set(planName, existing);
    }

    const total = allSubs.length;
    return [...planCounts.entries()]
      .map(([plan, counts]) => ({
        plan,
        active: counts.active,
        limited: counts.limited,
        total: counts.active + counts.limited,
        percentage: total > 0 ? (counts.active + counts.limited) / total : 0,
      }))
      .sort((a, b) => b.total - a.total);
  }

  // ── Cohort retention ───────────────────────────────────────────────────

  /**
   * Returns a month-cohort retention matrix. For every signup month in
   * the past `ANALYTICS_COHORT_MONTHS`, computes the share of users
   * that placed at least one COMPLETED transaction in each subsequent
   * month.
   */
  public async getCohortRetention(): Promise<readonly CohortRowInterface[]> {
    const now = new Date();
    const earliest = addMonths(startOfMonth(now), -(ANALYTICS_COHORT_MONTHS - 1));

    const cohortUsers = await this.prismaService.user.findMany({
      where: { createdAt: { gte: earliest } },
      select: { id: true, createdAt: true },
    });

    const cohorts = new Map<string, Set<string>>();
    for (const user of cohortUsers) {
      const key = formatYearMonth(user.createdAt);
      const set = cohorts.get(key);
      if (set) set.add(user.id);
      else cohorts.set(key, new Set([user.id]));
    }

    if (cohorts.size === 0) return [];

    const cohortUserIds = cohortUsers.map((u) => u.id);
    const activity = cohortUserIds.length === 0
      ? []
      : await this.prismaService.transaction.findMany({
          where: {
            userId: { in: cohortUserIds },
            status: TransactionStatus.COMPLETED,
            updatedAt: { gte: earliest },
          },
          select: { userId: true, updatedAt: true },
        });

    const activeByCohort = new Map<string, Map<string, Set<string>>>();
    for (const tx of activity) {
      const userId = tx.userId;
      if (userId === null) continue;
      const cohortKey = findCohortKeyByUser(cohorts, userId);
      if (!cohortKey) continue;
      const monthKey = formatYearMonth(tx.updatedAt);
      let bucket = activeByCohort.get(cohortKey);
      if (!bucket) {
        bucket = new Map();
        activeByCohort.set(cohortKey, bucket);
      }
      let users = bucket.get(monthKey);
      if (!users) {
        users = new Set();
        bucket.set(monthKey, users);
      }
      users.add(userId);
    }

    const result: CohortRowInterface[] = [];
    for (let i = 0; i < ANALYTICS_COHORT_MONTHS; i++) {
      const cohortDate = addMonths(startOfMonth(now), -(ANALYTICS_COHORT_MONTHS - 1 - i));
      const cohortKey = formatYearMonth(cohortDate);
      const cohort = cohorts.get(cohortKey);
      if (!cohort || cohort.size === 0) {
        result.push({ cohort: cohortKey, cohortSize: 0, retentionByMonth: [] });
        continue;
      }
      const monthsToScan = Math.max(0, monthsBetween(cohortDate, now)) + 1;
      const retention: number[] = [];
      const cohortActivity = activeByCohort.get(cohortKey);
      for (let m = 0; m < monthsToScan; m++) {
        const targetDate = addMonths(cohortDate, m);
        const targetKey = formatYearMonth(targetDate);
        const activeUsers = cohortActivity?.get(targetKey)?.size ?? 0;
        retention.push(cohort.size === 0 ? 0 : activeUsers / cohort.size);
      }
      result.push({
        cohort: cohortKey,
        cohortSize: cohort.size,
        retentionByMonth: retention,
      });
    }

    return result;
  }

  // ── Top payers ────────────────────────────────────────────────────────

  public async getTopPayers(
    limit: number = ANALYTICS_DEFAULT_TOP_PAYERS_LIMIT,
  ): Promise<readonly TopPayerInterface[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));

    const grouped = await this.prismaService.transaction.groupBy({
      by: ['userId'],
      where: { status: TransactionStatus.COMPLETED },
      _sum: { amount: true },
      _count: { _all: true },
      _max: { updatedAt: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: safeLimit,
    });

    if (grouped.length === 0) return [];

    const userIds = grouped
      .map((row) => row.userId)
      .filter((id): id is string => id !== null);
    const users = await this.prismaService.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, telegramId: true, username: true, name: true },
    });
    const userById = new Map(users.map((u) => [u.id, u]));

    return grouped.map((row): TopPayerInterface => {
      const user = row.userId ? userById.get(row.userId) : undefined;
      return {
        userId: row.userId ?? '',
        telegramId: user?.telegramId ? user.telegramId.toString() : null,
        username: user?.username ?? null,
        name: user?.name ?? '',
        totalSpent: Number(row._sum.amount ?? 0),
        transactionCount: row._count._all,
        lastPaymentAt: row._max.updatedAt?.toISOString() ?? null,
      };
    });
  }

  // ── LTV distribution ──────────────────────────────────────────────────

  public async getLtvDistribution(): Promise<readonly LtvBucketInterface[]> {
    const grouped = await this.prismaService.transaction.groupBy({
      by: ['userId'],
      where: { status: TransactionStatus.COMPLETED },
      _sum: { amount: true },
    });

    const buckets = ANALYTICS_LTV_BUCKETS.map((bound) => ({ bound, users: 0 }));
    for (const row of grouped) {
      const total = Number(row._sum.amount ?? 0);
      let placed = false;
      for (let i = ANALYTICS_LTV_BUCKETS.length - 1; i >= 0; i--) {
        if (total >= ANALYTICS_LTV_BUCKETS[i]!) {
          buckets[i]!.users += 1;
          placed = true;
          break;
        }
      }
      if (!placed) buckets[0]!.users += 1;
    }
    return buckets;
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private async getUserGrowth(
    todayStart: Date,
    weekStart: Date,
    monthStart: Date,
  ): Promise<UserGrowthInterface> {
    const [total, newToday, newWeek, newMonth, blocked] = await Promise.all([
      this.prismaService.user.count(),
      this.prismaService.user.count({ where: { createdAt: { gte: todayStart } } }),
      this.prismaService.user.count({ where: { createdAt: { gte: weekStart } } }),
      this.prismaService.user.count({ where: { createdAt: { gte: monthStart } } }),
      this.prismaService.user.count({ where: { isBlocked: true } }),
    ]);
    return {
      totalUsers: total,
      newUsersToday: newToday,
      newUsersThisWeek: newWeek,
      newUsersThisMonth: newMonth,
      blockedUsers: blocked,
    };
  }

  private async getSubscriptionFunnel(): Promise<SubscriptionFunnelInterface> {
    const [active, trial, expired, disabled, deleted, total] = await Promise.all([
      this.prismaService.subscription.count({ where: { status: SubscriptionStatus.ACTIVE, isTrial: false } }),
      this.prismaService.subscription.count({ where: { status: SubscriptionStatus.ACTIVE, isTrial: true } }),
      this.prismaService.subscription.count({ where: { status: SubscriptionStatus.EXPIRED } }),
      this.prismaService.subscription.count({ where: { status: SubscriptionStatus.DISABLED } }),
      this.prismaService.subscription.count({ where: { status: SubscriptionStatus.DELETED } }),
      this.prismaService.subscription.count(),
    ]);
    return { active, trial, expired, disabled, deleted, total };
  }

  private async getRevenueByGateway(): Promise<readonly RevenueByGatewayInterface[]> {
    const grouped = await this.prismaService.transaction.groupBy({
      by: ['gatewayType'],
      where: { status: TransactionStatus.COMPLETED },
      _sum: { amount: true },
      _count: { _all: true },
    });
    return grouped.map((row) => ({
      gatewayType: row.gatewayType,
      totalAmount: Number(row._sum.amount ?? 0),
      transactionCount: row._count._all,
    }));
  }

  private async getDailyRevenue7d(now: Date): Promise<readonly TimeSeriesPointInterface[]> {
    const windowStart = new Date(startOfDay(now).getTime() - 6 * ANALYTICS_ONE_DAY_MS);
    const rows = await this.prismaService.$queryRawUnsafe<Array<{ day: string; total: bigint | null }>>(
      `SELECT date_trunc('day', updated_at)::date::text AS day, SUM(amount) AS total
       FROM transactions
       WHERE status = 'COMPLETED' AND updated_at >= $1
       GROUP BY day ORDER BY day`,
      windowStart,
    );
    // Fill gaps for days with no revenue
    const revenueMap = new Map(rows.map((r) => [r.day, Number(r.total ?? 0)]));
    const points: TimeSeriesPointInterface[] = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(startOfDay(now).getTime() - (6 - i) * ANALYTICS_ONE_DAY_MS).toISOString().slice(0, 10);
      points.push({ date, value: revenueMap.get(date) ?? 0 });
    }
    return points;
  }

  private async getDailyNewUsers7d(now: Date): Promise<readonly TimeSeriesPointInterface[]> {
    const windowStart = new Date(startOfDay(now).getTime() - 6 * ANALYTICS_ONE_DAY_MS);
    const rows = await this.prismaService.$queryRawUnsafe<Array<{ day: string; cnt: bigint }>>(
      `SELECT date_trunc('day', created_at)::date::text AS day, COUNT(*)::bigint AS cnt
       FROM users
       WHERE created_at >= $1
       GROUP BY day ORDER BY day`,
      windowStart,
    );
    const countMap = new Map(rows.map((r) => [r.day, Number(r.cnt)]));
    const points: TimeSeriesPointInterface[] = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(startOfDay(now).getTime() - (6 - i) * ANALYTICS_ONE_DAY_MS).toISOString().slice(0, 10);
      points.push({ date, value: countMap.get(date) ?? 0 });
    }
    return points;
  }

  // ── Phase 7 — KPI / Churn / Funnel / Daily computations ───────────────

  private async computeKpis(windowStart: Date, days: number): Promise<KpiSummaryInterface> {
    const [
      revenueAgg,
      payingUsersAgg,
      activeSubs,
      trialSubs,
      totalUsers,
      newUsersInWindow,
    ] = await Promise.all([
      this.prismaService.transaction.aggregate({
        where: { status: TransactionStatus.COMPLETED, updatedAt: { gte: windowStart } },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prismaService.transaction.findMany({
        where: { status: TransactionStatus.COMPLETED, updatedAt: { gte: windowStart } },
        select: { userId: true },
        distinct: ['userId'],
      }),
      this.prismaService.subscription.count({
        where: { status: SubscriptionStatus.ACTIVE, isTrial: false },
      }),
      this.prismaService.subscription.count({
        where: { status: SubscriptionStatus.ACTIVE, isTrial: true },
      }),
      this.prismaService.user.count(),
      this.prismaService.user.count({ where: { createdAt: { gte: windowStart } } }),
    ]);

    const totalRevenue = Number(revenueAgg._sum.amount ?? 0);
    const paidCount = revenueAgg._count._all;
    const payingUsers = payingUsersAgg.length;
    const arpu = totalUsers === 0 ? 0 : totalRevenue / totalUsers;
    const arppu = payingUsers === 0 ? 0 : totalRevenue / payingUsers;

    return {
      windowDays: days,
      totalRevenue,
      paidCount,
      payingUsers,
      arpu,
      arppu,
      activeSubscriptions: activeSubs,
      trialSubscriptions: trialSubs,
      totalUsers,
      newUsersInWindow,
    };
  }

  /**
   * Churn rate over the rolling window.
   *
   * Definition
   *   `prevActive` — subscriptions whose lifetime straddled the start
   *   of the window: `createdAt < windowStart` AND
   *   (`expiresAt` is null OR `expiresAt >= windowStart`). These are
   *   the subscriptions that were "alive" the moment the window opened.
   *   `stillActive` — those same subscriptions that are still ACTIVE
   *   today.
   *   `churned = prevActive - stillActive`. Rates are computed as
   *   `churnRate = churned / prevActive`.
   *
   * Subscriptions are snapshotted by id so renewals/upgrades don't
   * double-count — only the persisted row mutates from ACTIVE to
   * EXPIRED/DISABLED/DELETED on real churn.
   */
  private async computeChurn(
    windowStart: Date,
    previousWindowStart: Date,
    days: number,
  ): Promise<ChurnSnapshotInterface> {
    void previousWindowStart;
    const eligible = await this.prismaService.subscription.findMany({
      where: {
        createdAt: { lt: windowStart },
        status: { not: SubscriptionStatus.DELETED },
        OR: [
          { expiresAt: null },
          { expiresAt: { gte: windowStart } },
        ],
      },
      select: { id: true, status: true },
      take: 100_000,
    });
    const prevActive = eligible.length;
    if (prevActive === 0) {
      return {
        windowDays: days,
        prevActive: 0,
        stillActive: 0,
        churned: 0,
        churnRate: 0,
        retentionRate: 1,
      };
    }
    const stillActive = await this.prismaService.subscription.count({
      where: { id: { in: eligible.map((s) => s.id) }, status: SubscriptionStatus.ACTIVE },
    });
    const churned = prevActive - stillActive;
    return {
      windowDays: days,
      prevActive,
      stillActive,
      churned,
      churnRate: churned / prevActive,
      retentionRate: stillActive / prevActive,
    };
  }

  /**
   * Conversion funnel — registration → trial → first paid → repeat purchase.
   * Counts within the rolling window so operators see the funnel drift
   * over time.
   */
  private async computeFunnel(windowStart: Date): Promise<readonly ConversionFunnelStepInterface[]> {
    const [registered, startedTrial, firstPaidUsersGroup, paidPerUser] =
      await Promise.all([
        this.prismaService.user.count({ where: { createdAt: { gte: windowStart } } }),
        this.prismaService.trialGrant.count({ where: { grantedAt: { gte: windowStart } } }),
        this.prismaService.transaction.findMany({
          where: { status: TransactionStatus.COMPLETED, updatedAt: { gte: windowStart } },
          select: { userId: true },
          distinct: ['userId'],
        }),
        this.prismaService.transaction.groupBy({
          by: ['userId'],
          where: { status: TransactionStatus.COMPLETED, updatedAt: { gte: windowStart } },
          _count: { _all: true },
        }),
      ]);

    const firstPaid = firstPaidUsersGroup.length;
    const repeatPaid = paidPerUser.filter((row) => row._count._all > 1).length;
    const start = registered;

    const steps = [
      { key: 'registered', label: 'Registered', count: registered },
      { key: 'trial', label: 'Started trial', count: startedTrial },
      { key: 'firstPaid', label: 'First paid purchase', count: firstPaid },
      { key: 'repeatPaid', label: 'Repeat paid purchase', count: repeatPaid },
    ];

    return steps.map((step, idx, arr) => {
      const prev = idx === 0 ? 0 : arr[idx - 1]!.count;
      return {
        ...step,
        pctOfStart: start === 0 ? 0 : step.count / start,
        pctOfPrev: prev === 0 ? (idx === 0 ? 1 : 0) : step.count / prev,
      };
    });
  }

  private async computeProviderHealth(windowStart: Date): Promise<readonly ProviderHealthInterface[]> {
    const grouped = await this.prismaService.transaction.groupBy({
      by: ['gatewayType', 'status'],
      where: { updatedAt: { gte: windowStart } },
      _count: { _all: true },
      _sum: { amount: true },
    });

    interface ProviderAccumulator {
      gatewayType: PaymentGatewayType;
      total: number;
      completed: number;
      failed: number;
      canceled: number;
      revenue: number;
    }

    const byGateway = new Map<PaymentGatewayType, ProviderAccumulator>();
    for (const row of grouped) {
      const existing = byGateway.get(row.gatewayType);
      const acc: ProviderAccumulator = existing ?? {
        gatewayType: row.gatewayType,
        total: 0,
        completed: 0,
        failed: 0,
        canceled: 0,
        revenue: 0,
      };
      acc.total += row._count._all;
      switch (row.status) {
        case TransactionStatus.COMPLETED:
          acc.completed += row._count._all;
          acc.revenue += Number(row._sum.amount ?? 0);
          break;
        case TransactionStatus.FAILED:
          acc.failed += row._count._all;
          break;
        case TransactionStatus.CANCELED:
          acc.canceled += row._count._all;
          break;
        default:
          break;
      }
      byGateway.set(row.gatewayType, acc);
    }

    const result: ProviderHealthInterface[] = [];
    for (const value of byGateway.values()) {
      const successRate = value.total === 0 ? 0 : value.completed / value.total;
      result.push({
        gatewayType: value.gatewayType,
        total: value.total,
        completed: value.completed,
        failed: value.failed,
        canceled: value.canceled,
        successRate,
        revenue: value.revenue,
      });
    }
    return result.sort((a, b) => b.revenue - a.revenue);
  }

  private async computeDailyMetrics(
    windowStart: Date,
    days: number,
  ): Promise<readonly DailyMetricInterface[]> {
    // Single raw SQL query replaces the previous N+1 loop (was: 3 queries × days iterations)
    const [revenueRows, userRows, subRows] = await Promise.all([
      this.prismaService.$queryRawUnsafe<Array<{ day: string; total: bigint | null }>>(
        `SELECT date_trunc('day', updated_at)::date::text AS day, SUM(amount) AS total
         FROM transactions
         WHERE status = 'COMPLETED' AND updated_at >= $1
         GROUP BY day ORDER BY day`,
        windowStart,
      ),
      this.prismaService.$queryRawUnsafe<Array<{ day: string; cnt: bigint }>>(
        `SELECT date_trunc('day', created_at)::date::text AS day, COUNT(*)::bigint AS cnt
         FROM users
         WHERE created_at >= $1
         GROUP BY day ORDER BY day`,
        windowStart,
      ),
      this.prismaService.$queryRawUnsafe<Array<{ day: string; cnt: bigint }>>(
        `SELECT date_trunc('day', created_at)::date::text AS day, COUNT(*)::bigint AS cnt
         FROM subscriptions
         WHERE created_at >= $1
         GROUP BY day ORDER BY day`,
        windowStart,
      ),
    ]);

    const revenueMap = new Map(revenueRows.map((r) => [r.day, Number(r.total ?? 0)]));
    const userMap = new Map(userRows.map((r) => [r.day, Number(r.cnt)]));
    const subMap = new Map(subRows.map((r) => [r.day, Number(r.cnt)]));

    const startOfStart = startOfDay(windowStart);
    const points: DailyMetricInterface[] = [];
    for (let i = 0; i < days; i++) {
      const date = new Date(startOfStart.getTime() + i * ANALYTICS_ONE_DAY_MS).toISOString().slice(0, 10);
      points.push({
        date,
        revenue: revenueMap.get(date) ?? 0,
        newUsers: userMap.get(date) ?? 0,
        newSubscriptions: subMap.get(date) ?? 0,
      });
    }
    return points;
  }
}
