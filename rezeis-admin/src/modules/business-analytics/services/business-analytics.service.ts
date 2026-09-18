import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { FxRateService } from '../../fx/fx-rate.service';
import { SettingsService } from '../../settings/services/settings.service';
import {
  AdvancedAnalyticsReportInterface,
  CohortRowInterface,
  ExpiringReportInterface,
  LtvReportInterface,
  MoneyViewInterface,
  RevenueReportInterface,
  SubscriptionByPlanItem,
  TopPayersReportInterface,
  TrialConversionReport,
  UsageSurfaceReportInterface,
} from '../interfaces/business-analytics.types';
import {
  assembleTrialConversion,
  type CurrencySumRow,
  firstPaymentSql,
  type FirstPaymentRow,
  trialPlansSql,
  type TrialPlanRow,
  trialRevenueSql,
  trialSummarySql,
  type TrialSummaryRow,
} from '../utils/analytics-conversion.util';
import {
  assembleLtv,
  assembleTopPayers,
  chooseLtvBins,
  type LifetimeCurrencyRow,
  lifetimeCurrenciesSql,
  type LtvBinRow,
  ltvBinsSql,
  type LtvStatsRow,
  ltvStatsSql,
  type TopPayerRow,
  topPayersSql,
} from '../utils/analytics-customer-value.util';
import {
  ANALYTICS_COHORT_MONTHS,
  ANALYTICS_DEFAULT_TOP_PAYERS_LIMIT,
  ANALYTICS_ONE_DAY_MS,
} from '../utils/analytics-date.util';
import { chooseMoneyView, type FxSnapshot, readFxSnapshot } from '../utils/analytics-money.util';
import {
  type ActiveSeriesRow,
  activeSeriesSql,
  assembleOverview,
  funnelSql,
  type FunnelRow,
  type OverviewPayerRow,
  overviewNewUsersSql,
  type OverviewPaymentRow,
  overviewPayersSql,
  overviewPaymentsSql,
  type OverviewUserRow,
  partnerBalanceSql,
  type PartnerBalanceRow,
  type ProviderRow,
  providersSql,
  subscriptionSnapshotSql,
  type SubscriptionSnapshotRow,
} from '../utils/analytics-overview.util';
import {
  assembleCohorts,
  assembleExpiring,
  assembleSubscriptionsByPlan,
  type CohortRow,
  cohortSql,
  type ExpiringRow,
  expiringSql,
  subscriptionsByPlanSql,
  type SubscriptionPlanRow,
  zonedMonthStart,
} from '../utils/analytics-retention.util';
import {
  assembleRevenue,
  revenueByGatewaySql,
  revenueByPlanSql,
  type RevenueGatewayRow,
  type RevenuePlanRow,
  revenueSlicesSql,
  type RevenueSliceRow,
} from '../utils/analytics-revenue.util';
import { planAnalyticsWindow } from '../utils/analytics-window.util';
import { type AnalyticsZone, resolveAnalyticsZone } from '../utils/analytics-zone.util';
import {
  buildUsageSurfaceReport,
  usageSurfaceReportSql,
  type UsageSurfaceRow,
} from '../utils/usage-surface-report.util';

const EMPTY_SUBSCRIPTION_SNAPSHOT: SubscriptionSnapshotRow = {
  activeNow: 0,
  activeThen: 0,
  churnBase: 0,
  churned: 0,
  previousChurnBase: 0,
  previousChurned: 0,
  trialsNow: 0,
};

const EMPTY_FUNNEL: FunnelRow = { registered: 0, activated: 0, paid: 0, repeat: 0 };

/**
 * Zones PostgreSQL has been asked about, and its answer — once per process: a
 * zone `Intl` knows and the database's tz data does not would fail every
 * statement it is bound into, so it falls back to UTC instead.
 */
const zonesKnownToDatabase = new Map<string, boolean>();

/**
 * Business analytics aggregation service.
 *
 * Chart-ready data for the admin «Бизнес-аналитика» page. Every report is a
 * set of SQL aggregates — counts and per-currency sums, never rows loaded
 * into memory — assembled by the pure functions in `../utils/`, where each
 * decision is documented next to its statement:
 *
 *   - `analytics-zone.util.ts`     the operator's time zone, the days' calendar;
 *   - `analytics-window.util.ts`   the window, the previous window, the bars;
 *   - `analytics-money-received.util.ts` what counts as money, one rule for all;
 *   - `analytics-money.util.ts`    one currency per report, with the panel's rates;
 *   - `analytics-overview.util.ts` KPI tiles, series, funnel, payment systems;
 *   - `analytics-revenue.util.ts`  revenue by bar, currency, kind, plan, system;
 *   - `analytics-conversion.util.ts` trial → paid, time to the first payment;
 *   - `analytics-retention.util.ts`  cohorts, expiring subscriptions, plans;
 *   - `analytics-customer-value.util.ts` LTV and top payers.
 *
 * A payment belongs to the time of its `created_at` (see the overview util
 * for why not `updated_at`).
 */
@Injectable()
export class BusinessAnalyticsService {
  public constructor(
    private readonly prismaService: PrismaService,
    /**
     * Only for the reporting base currency: the rates themselves are READ from
     * `fx_rates`, never fetched — a report must not wait on an exchange inside
     * the 30-second request limit.
     */
    private readonly fxRateService: FxRateService,
    /** The operator's time zone (`Settings.platformPolicy.timezone`), through the panel's settings reader. */
    private readonly settingsService: SettingsService,
  ) {}

  /**
   * Usage-surface adoption: how users access the cabinet (Telegram Mini App /
   * installed PWA / browser), on which form factor (mobile/tablet/desktop) and
   * OS, plus the PWA-install count, installs by OS and 30-day active reach.
   * Buckets reflect each user's LATEST reported session — except installs by
   * OS, which prefer the OS of the first open from the app.
   *
   * Every figure comes from ONE statement, so every breakdown adds up to the
   * total printed beside it — see `usage-surface-report.util.ts`.
   */
  public async getSurfaceAnalytics(): Promise<UsageSurfaceReportInterface> {
    const now = new Date();
    const activeSince = new Date(now.getTime() - 30 * ANALYTICS_ONE_DAY_MS);
    const rows = await this.prismaService.$queryRaw<UsageSurfaceRow[]>(
      usageSurfaceReportSql(activeSince),
    );
    return buildUsageSurfaceReport(rows, now);
  }

  private readFx(): Promise<FxSnapshot> {
    return readFxSnapshot(this.prismaService, this.fxRateService.getBaseCurrency());
  }

  /** The zone the reports count days in: the panel's setting when it is one both `Intl` and PostgreSQL know, else UTC. */
  private async readZone(): Promise<AnalyticsZone> {
    const branding = await this.settingsService.getPlatformBranding();
    const zone = resolveAnalyticsZone(branding.timezone);
    if (zone.name === 'UTC') return zone;
    let known = zonesKnownToDatabase.get(zone.name);
    if (known === undefined) {
      const [row] = await this.prismaService.$queryRaw<Array<{ known: boolean }>>(
        Prisma.sql`SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE "name" = ${zone.name}) AS "known"`,
      );
      known = row?.known === true;
      zonesKnownToDatabase.set(zone.name, known);
    }
    return known ? zone : { name: 'UTC', fallback: true };
  }

  // ── «Обзор» ────────────────────────────────────────────────────────────

  public async getAdvancedReport(daysRaw: number): Promise<AdvancedAnalyticsReportInterface> {
    const window = planAnalyticsWindow(daysRaw, new Date(), await this.readZone());
    const prisma = this.prismaService;
    const [payments, payers, newUsers, snapshot, activeSeries, funnel, providers, partnerBalance, totalUsers, fx] =
      await Promise.all([
        prisma.$queryRaw<OverviewPaymentRow[]>(overviewPaymentsSql(window)),
        prisma.$queryRaw<OverviewPayerRow[]>(overviewPayersSql(window)),
        prisma.$queryRaw<OverviewUserRow[]>(overviewNewUsersSql(window)),
        prisma.$queryRaw<SubscriptionSnapshotRow[]>(subscriptionSnapshotSql(window)),
        prisma.$queryRaw<ActiveSeriesRow[]>(activeSeriesSql(window)),
        prisma.$queryRaw<FunnelRow[]>(funnelSql(window)),
        prisma.$queryRaw<ProviderRow[]>(providersSql(window)),
        prisma.$queryRaw<PartnerBalanceRow[]>(partnerBalanceSql(window)),
        prisma.user.count(),
        this.readFx(),
      ]);
    return assembleOverview(
      window,
      {
        payments,
        payers,
        newUsers,
        subscriptions: snapshot[0] ?? EMPTY_SUBSCRIPTION_SNAPSHOT,
        activeSeries,
        funnel: funnel[0] ?? EMPTY_FUNNEL,
        providers,
        partnerBalance,
        totalUsers,
      },
      fx,
    );
  }

  // ── «Выручка» ──────────────────────────────────────────────────────────

  public async getRevenueReport(daysRaw: number): Promise<RevenueReportInterface> {
    const window = planAnalyticsWindow(daysRaw, new Date(), await this.readZone());
    const prisma = this.prismaService;
    const [slices, plans, gateways, partnerBalance, fx] = await Promise.all([
      prisma.$queryRaw<RevenueSliceRow[]>(revenueSlicesSql(window)),
      prisma.$queryRaw<RevenuePlanRow[]>(revenueByPlanSql(window)),
      prisma.$queryRaw<RevenueGatewayRow[]>(revenueByGatewaySql(window)),
      prisma.$queryRaw<PartnerBalanceRow[]>(partnerBalanceSql(window)),
      this.readFx(),
    ]);
    return assembleRevenue(window, { slices, plans, gateways, partnerBalance }, fx);
  }

  /** Live subscriptions (ACTIVE and LIMITED) per plan. */
  public async getSubscriptionsByPlan(): Promise<readonly SubscriptionByPlanItem[]> {
    const rows = await this.prismaService.$queryRaw<SubscriptionPlanRow[]>(subscriptionsByPlanSql());
    return assembleSubscriptionsByPlan(rows);
  }

  // ── «Конверсия» ────────────────────────────────────────────────────────

  public async getTrialConversion(daysRaw: number): Promise<TrialConversionReport> {
    const window = planAnalyticsWindow(daysRaw, new Date(), await this.readZone());
    const prisma = this.prismaService;
    const [summary, plans, revenue, firstPayment, fx] = await Promise.all([
      prisma.$queryRaw<TrialSummaryRow[]>(trialSummarySql(window)),
      prisma.$queryRaw<TrialPlanRow[]>(trialPlansSql(window)),
      prisma.$queryRaw<CurrencySumRow[]>(trialRevenueSql(window)),
      prisma.$queryRaw<FirstPaymentRow[]>(firstPaymentSql(window)),
      this.readFx(),
    ]);
    return assembleTrialConversion(
      window,
      { summary: summary[0], plans, revenue, firstPayment: firstPayment[0] },
      fx,
    );
  }

  // ── «Удержание» ────────────────────────────────────────────────────────

  /**
   * The month-cohort matrix: for every local signup month of the last
   * `ANALYTICS_COHORT_MONTHS`, the share of the cohort that paid in each month
   * from the signup month on.
   */
  public async getCohortRetention(): Promise<readonly CohortRowInterface[]> {
    const now = new Date();
    const zone = await this.readZone();
    const rows = await this.prismaService.$queryRaw<CohortRow[]>(
      cohortSql(zonedMonthStart(now, zone, ANALYTICS_COHORT_MONTHS - 1), zone),
    );
    return assembleCohorts(now, zone, rows);
  }

  /** Live subscriptions whose term ends within the coming 30 local days, by day and by what will happen. */
  public async getExpiring(): Promise<ExpiringReportInterface> {
    const now = new Date();
    const zone = await this.readZone();
    const rows = await this.prismaService.$queryRaw<ExpiringRow[]>(expiringSql(now, zone));
    return assembleExpiring(now, zone, rows);
  }

  /**
   * The lifetime money view: one currency when all money ever received is in
   * one, else the base currency with the panel's rates.
   */
  private async lifetimeMoneyView(): Promise<MoneyViewInterface> {
    const [currencies, fx] = await Promise.all([
      this.prismaService.$queryRaw<LifetimeCurrencyRow[]>(lifetimeCurrenciesSql()),
      this.readFx(),
    ]);
    return chooseMoneyView(
      currencies.filter((row) => Number(row.amount ?? 0) !== 0).map((row) => row.currency),
      fx,
    );
  }

  public async getLtvDistribution(): Promise<LtvReportInterface> {
    const view = await this.lifetimeMoneyView();
    const [stats] = await this.prismaService.$queryRaw<LtvStatsRow[]>(ltvStatsSql(view));
    const p95 = stats?.p95 === null || stats?.p95 === undefined ? null : Number(stats.p95);
    const bins = chooseLtvBins(p95);
    const rows = (stats?.payers ?? 0) === 0 ? [] : await this.prismaService.$queryRaw<LtvBinRow[]>(ltvBinsSql(view, bins));
    return assembleLtv(view, stats, bins, rows);
  }

  // ── «Лидеры» ───────────────────────────────────────────────────────────

  public async getTopPayers(
    limit: number = ANALYTICS_DEFAULT_TOP_PAYERS_LIMIT,
  ): Promise<TopPayersReportInterface> {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const view = await this.lifetimeMoneyView();
    const rows = await this.prismaService.$queryRaw<TopPayerRow[]>(topPayersSql(view, safeLimit));
    return { payers: assembleTopPayers(rows), money: view };
  }
}
