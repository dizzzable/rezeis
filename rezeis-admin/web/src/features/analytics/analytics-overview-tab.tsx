/**
 * «Обзор»: six KPI tiles against the previous window, revenue and new
 * subscriptions over time with the previous window as a ghost, the funnel of
 * the window's sign-ups, and how each payment system is doing.
 *
 * Revenue and subscriptions are two charts, not one with two y-axes: their
 * scales have nothing to do with each other, and a second axis invents a
 * correlation where the two lines happen to cross.
 */
import { type JSX, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  Activity,
  ArrowRightLeft,
  CreditCard,
  DollarSign,
  Receipt,
  UserPlus,
  Users,
  Wallet,
} from 'lucide-react'
import { Bar, CartesianGrid, ComposedChart, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { activeLocale, cn } from '@/lib/utils'

import { type AdvancedAnalyticsReport, type ConversionFunnelStep, getAnalyticsOverview, type MoneyView, type ProviderHealth } from './analytics-api'
import {
  ChartCard,
  ChartLegend,
  ChartSkeleton,
  DataTable,
  EmptyState,
  GatewayIcon,
  MoneyNote,
  TooltipCard,
  ZoneNote,
} from './analytics-chart-kit'
import {
  approx,
  AXIS_TICK,
  BAR_CURSOR,
  BAR_MAX,
  COUNT_AXIS_WIDTH,
  MONEY_AXIS_WIDTH,
  BAR_RADIUS,
  GRID_STROKE,
  hoveredRow,
  LINE_CURSOR,
  type RechartsTooltipProps,
  sharedInfoWords,
  SWEEP_MS,
  useChartEntrance,
} from './analytics-chart-support'
import {
  comparisonText,
  formatBucket,
  formatCount,
  formatMoney,
  formatPercent,
  gatewayName,
  partnerBalanceText,
  pointDelta,
  relativeDelta,
} from './analytics-format'
import { KpiTile } from './analytics-kpi'
import { ACCENT, funnelColor, GHOST, OUTCOME_COLORS } from './analytics-palette'
import { SurfaceUsageCard } from './surface-usage-card'

/** Rows two and three: the wide chart and its narrow neighbour, side by side from 64rem of tab. */
const PAIR_ROW = 'grid gap-4 @min-[64rem]:grid-cols-3'
const WIDE = '@min-[64rem]:col-span-2'

export function OverviewTab({ days, played }: { readonly days: number; readonly played: Set<string> }): JSX.Element {
  const { t } = useTranslation()
  const overview = useQuery({
    queryKey: ['analytics', 'overview', days],
    queryFn: () => getAnalyticsOverview(days),
    staleTime: 30_000,
    // A period click keeps the tiles and charts on screen, dimmed, until the
    // new window arrives — no skeleton flash, no layout jump.
    placeholderData: keepPreviousData,
  })
  const report = overview.data

  return (
    <div className="@container space-y-4" data-analytics-tab="overview">
      {report === undefined ? (
        overview.isError ? (
          <EmptyState className="h-40 rounded-lg border">{t('analyticsPage.common.unavailable')}</EmptyState>
        ) : (
          <OverviewSkeleton />
        )
      ) : (
        <div className={cn('space-y-4 motion-safe:transition-opacity', overview.isPlaceholderData && 'opacity-60')} aria-busy={overview.isPlaceholderData || undefined}>
          <ZoneNote fallback={report.period.timeZoneFallback} />
          <MoneyNote money={report.money} />
          <KpiRow report={report} />
          <div className={PAIR_ROW}>
            <RevenueCard report={report} played={played} className={WIDE} />
            <FunnelCard funnel={report.funnel} played={played} />
          </div>
          <div className={PAIR_ROW}>
            <NewSubscriptionsCard report={report} played={played} className={WIDE} />
            <ProvidersCard providers={report.providers} money={report.money} played={played} />
          </div>
        </div>
      )}
      {/*
        Where customers open the cabinet does not depend on the chosen period,
        and this card fetches its own breakdown. It stays OUTSIDE the block
        above, so a period click never unmounts it, refetches it or replays its
        rings.
      */}
      <SurfaceUsageCard played={played} />
    </div>
  )
}

function OverviewSkeleton(): JSX.Element {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="grid grid-cols-2 gap-4 @min-[48rem]:grid-cols-3 @min-[96rem]:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => (
          <ChartSkeleton key={index} className="h-36" />
        ))}
      </div>
      <div className={PAIR_ROW}>
        <ChartSkeleton className={cn('h-80', WIDE)} />
        <ChartSkeleton className="h-80" />
      </div>
    </div>
  )
}

// ── KPI tiles ────────────────────────────────────────────────────────────────

function KpiRow({ report }: { readonly report: AdvancedAnalyticsReport }): JSX.Element {
  const { t } = useTranslation()
  const { metrics, money, series, previousSeries } = report
  const comparison = comparisonText(t, report.windowDays)
  const revenue = metrics.revenue.current
  const unconverted = revenue.byCurrency.filter((slice) => money.unconverted.includes(slice.currency))
  const churnRate = metrics.churn.current.rate
  const partnerBalance = partnerBalanceText(t, report.partnerBalance)

  return (
    <div className="grid grid-cols-1 gap-4 @min-[30rem]:grid-cols-2 @min-[48rem]:grid-cols-3 @min-[96rem]:grid-cols-6" data-kpi-row="">
      <KpiTile
        id="revenue"
        icon={DollarSign}
        label={t('analyticsPage.kpi.revenue')}
        info={t('analyticsPage.kpi.revenueInfo')}
        rule="money"
        value={`${approx(money, revenue.byCurrency.map((slice) => slice.currency))}${formatMoney(revenue.value, money.currency, { compact: true })}`}
        delta={relativeDelta(revenue.value, metrics.revenue.previous.value)}
        comparison={comparison}
        current={series.revenue}
        previous={previousSeries.revenue}
        subtitle={
          <>
            {t('analyticsPage.kpi.payments', { count: metrics.payments.current })}
            {unconverted.length > 0 &&
              ` · ${t('analyticsPage.kpi.unconvertedExtra', {
                amount: unconverted.map((slice) => formatMoney(slice.amount, slice.currency, { compact: true })).join(', '),
              })}`}
            {partnerBalance !== null && (
              <span className="mt-0.5 block" data-partner-balance="">
                {partnerBalance}
              </span>
            )}
          </>
        }
      />
      <KpiTile
        id="payers"
        icon={Users}
        label={t('analyticsPage.kpi.payingCustomers')}
        info={t('analyticsPage.kpi.payingCustomersInfo')}
        rule="money"
        value={formatCount(metrics.payingCustomers.current)}
        delta={relativeDelta(metrics.payingCustomers.current, metrics.payingCustomers.previous)}
        comparison={comparison}
        current={series.payingCustomers}
        previous={previousSeries.payingCustomers}
      />
      <KpiTile
        id="arppu"
        icon={Wallet}
        label={t('analyticsPage.kpi.arppu')}
        info={t('analyticsPage.kpi.arppuInfo')}
        rule="money"
        value={
          metrics.arppu.current === null
            ? null
            : `${approx(money, revenue.byCurrency.map((slice) => slice.currency))}${formatMoney(metrics.arppu.current, money.currency)}`
        }
        delta={relativeDelta(metrics.arppu.current, metrics.arppu.previous)}
        comparison={comparison}
        current={series.arppu}
        previous={previousSeries.arppu}
        // An average: its movement is the point, not its distance from zero.
        baseline="auto"
        subtitle={
          metrics.arppu.current === null && metrics.payingCustomers.current > 0
            ? t('analyticsPage.kpi.arppuWithheld')
            : undefined
        }
      />
      <KpiTile
        id="newUsers"
        icon={UserPlus}
        label={t('analyticsPage.kpi.newUsers')}
        info={t('analyticsPage.kpi.newUsersInfo')}
        value={formatCount(metrics.newUsers.current)}
        delta={relativeDelta(metrics.newUsers.current, metrics.newUsers.previous)}
        comparison={comparison}
        current={series.newUsers}
        previous={previousSeries.newUsers}
        subtitle={t('analyticsPage.kpi.totalUsers', { count: report.kpis.totalUsers })}
      />
      <KpiTile
        id="activeSubscriptions"
        icon={CreditCard}
        label={t('analyticsPage.kpi.activeSubs')}
        info={t('analyticsPage.kpi.activeSubsInfo', sharedInfoWords(t))}
        rule="subscriptions"
        value={formatCount(metrics.activeSubscriptions.current)}
        delta={relativeDelta(metrics.activeSubscriptions.current, metrics.activeSubscriptions.previous)}
        comparison={comparison}
        current={series.activeSubscriptions}
        baseline="auto"
        subtitle={t('analyticsPage.kpi.trials', { count: metrics.trialSubscriptions })}
      />
      <KpiTile
        id="churn"
        icon={Activity}
        label={t('analyticsPage.kpi.churn')}
        info={t('analyticsPage.kpi.churnInfo', sharedInfoWords(t))}
        rule="subscriptions"
        value={churnRate === null ? null : formatPercent(churnRate, { digits: 1 })}
        delta={pointDelta(churnRate, metrics.churn.previous.rate, { higherIsBetter: false })}
        deltaUnit="points"
        comparison={comparison}
        subtitle={
          churnRate === null
            ? t('analyticsPage.kpi.churnNone')
            : t('analyticsPage.kpi.churnSubtitle', {
                churned: formatCount(metrics.churn.current.churned),
                base: formatCount(metrics.churn.current.base),
              })
        }
      />
    </div>
  )
}

// ── Revenue over time, against the previous window ──────────────────────────

interface TimeRow {
  readonly index: number
  readonly axis: string
  readonly heading: string
  readonly value: number | null
  readonly previous: number | null
  readonly previousHeading: string | null
}

function useTimeRows(report: AdvancedAnalyticsReport, current: readonly (number | null)[], previous: readonly (number | null)[]): TimeRow[] {
  const locale = activeLocale()
  return useMemo(
    () =>
      report.period.buckets.map((bucket, index) => {
        const previousBucket = report.period.previousBuckets[index]
        return {
          index,
          axis: formatBucket(bucket, report.period.granularity, 'axis', locale),
          heading: formatBucket(bucket, report.period.granularity, 'full', locale),
          value: current[index] ?? null,
          previous: previousBucket === undefined ? null : (previous[index] ?? null),
          previousHeading: previousBucket === undefined ? null : formatBucket(previousBucket, report.period.granularity, 'full', locale),
        }
      }),
    [report.period, current, previous, locale],
  )
}

const CHART_MARGIN = { top: 8, right: 8, bottom: 0, left: 0 } as const

function granularityKey(report: { readonly period: { readonly granularity: string } }): 'Day' | 'Week' | 'Month' {
  return report.period.granularity === 'day' ? 'Day' : report.period.granularity === 'week' ? 'Week' : 'Month'
}

function RevenueCard({
  report,
  played,
  className,
}: {
  readonly report: AdvancedAnalyticsReport
  readonly played: Set<string>
  readonly className?: string
}): JSX.Element {
  const { t } = useTranslation()
  const chartRef = useRef<HTMLDivElement>(null)
  const entrance = useChartEntrance('overview.revenue', played, chartRef)
  const rows = useTimeRows(report, report.series.revenue, report.previousSeries.revenue)
  const currency = report.money.currency
  const empty = rows.every((row) => !row.value && !row.previous)
  const money = (value: number): string => formatMoney(value, currency)
  const title = t(`analyticsPage.revenueChart.title${granularityKey(report)}`)

  return (
    <ChartCard
      id="overview-revenue"
      className={className}
      title={title}
      info={t('analyticsPage.revenueChart.info')}
      rule="money"
      description={t('analyticsPage.revenueChart.description', { currency })}
      table={
        empty ? undefined : (
          <DataTable
            caption={title}
            columns={[
              { key: 'period', label: t('analyticsPage.common.period') },
              { key: 'value', label: t('analyticsPage.revenueChart.current'), numeric: true },
              { key: 'previousPeriod', label: t('analyticsPage.revenueChart.previousPeriod') },
              { key: 'previous', label: t('analyticsPage.revenueChart.previous'), numeric: true },
            ]}
            rows={rows.map((row) => ({
              key: String(row.index),
              period: row.heading,
              value: money(row.value ?? 0),
              previousPeriod: row.previousHeading ?? '—',
              previous: row.previous === null ? '—' : money(row.previous),
            }))}
          />
        )
      }
    >
      {empty ? (
        <EmptyState className="h-64">{t('analyticsPage.revenueChart.empty')}</EmptyState>
      ) : (
        <div className="space-y-2">
          <ChartLegend
            items={[
              { key: 'current', label: t('analyticsPage.revenueChart.current'), color: ACCENT, shape: 'rect' },
              { key: 'previous', label: t('analyticsPage.revenueChart.previous'), color: GHOST, shape: 'ghost' },
            ]}
          />
          <div ref={chartRef} className="h-64" data-chart="overview-revenue">
            {entrance.show && (
              <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
                <ComposedChart data={rows} margin={CHART_MARGIN} barCategoryGap="20%">
                  <CartesianGrid vertical={false} stroke={GRID_STROKE} />
                  <XAxis dataKey="axis" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID_STROKE }} minTickGap={16} />
                  <YAxis
                    tick={AXIS_TICK}
                    tickLine={false}
                    axisLine={false}
                    width={MONEY_AXIS_WIDTH}
                    tickFormatter={(value: number) => formatMoney(value, currency, { compact: true })}
                  />
                  <Tooltip
                    cursor={BAR_CURSOR}
                    isAnimationActive={false}
                    content={(props: RechartsTooltipProps) => {
                      const row = hoveredRow<TimeRow>(props)
                      if (row === null) return null
                      return (
                        <TooltipCard
                          heading={row.heading}
                          rows={[
                            { key: 'current', name: t('analyticsPage.revenueChart.current'), value: money(row.value ?? 0), color: ACCENT, shape: 'rect' },
                            ...(row.previous === null
                              ? []
                              : [
                                  {
                                    key: 'previous',
                                    name: t('analyticsPage.revenueChart.previous'),
                                    value: money(row.previous),
                                    color: GHOST,
                                    shape: 'ghost' as const,
                                    note: row.previousHeading ?? undefined,
                                  },
                                ]),
                          ]}
                        />
                      )
                    }}
                  />
                  <Bar
                    dataKey="value"
                    name={t('analyticsPage.revenueChart.current')}
                    fill={ACCENT}
                    radius={BAR_RADIUS}
                    maxBarSize={BAR_MAX}
                    isAnimationActive={entrance.animate}
                    animationDuration={SWEEP_MS}
                  />
                  <Line
                    dataKey="previous"
                    name={t('analyticsPage.revenueChart.previous')}
                    type="monotone"
                    stroke={GHOST}
                    strokeOpacity={0.75}
                    strokeWidth={2}
                    dot={false}
                    activeDot={false}
                    isAnimationActive={entrance.animate}
                    animationDuration={SWEEP_MS}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      )}
    </ChartCard>
  )
}

function NewSubscriptionsCard({
  report,
  played,
  className,
}: {
  readonly report: AdvancedAnalyticsReport
  readonly played: Set<string>
  readonly className?: string
}): JSX.Element {
  const { t } = useTranslation()
  const chartRef = useRef<HTMLDivElement>(null)
  const entrance = useChartEntrance('overview.newSubscriptions', played, chartRef)
  const rows = useTimeRows(report, report.series.newSubscriptions, report.previousSeries.newSubscriptions)
  const empty = rows.every((row) => !row.value && !row.previous)
  const title = t(`analyticsPage.newSubsChart.title${granularityKey(report)}`)

  return (
    <ChartCard
      id="overview-new-subscriptions"
      className={className}
      title={title}
      info={t('analyticsPage.newSubsChart.info', sharedInfoWords(t))}
      rule="money"
      table={
        empty ? undefined : (
          <DataTable
            caption={title}
            columns={[
              { key: 'period', label: t('analyticsPage.common.period') },
              { key: 'value', label: t('analyticsPage.newSubsChart.current'), numeric: true },
              { key: 'previousPeriod', label: t('analyticsPage.revenueChart.previousPeriod') },
              { key: 'previous', label: t('analyticsPage.newSubsChart.previous'), numeric: true },
            ]}
            rows={rows.map((row) => ({
              key: String(row.index),
              period: row.heading,
              value: formatCount(row.value ?? 0),
              previousPeriod: row.previousHeading ?? '—',
              previous: row.previous === null ? '—' : formatCount(row.previous),
            }))}
          />
        )
      }
    >
      {empty ? (
        <EmptyState className="h-48">{t('analyticsPage.newSubsChart.empty')}</EmptyState>
      ) : (
        // The card shares its row with the payment systems, which grow with the
        // number of systems: the chart takes the height the row gives it (12rem
        // at least), so the row has no empty band under the line.
        <div className="flex h-full flex-col gap-2">
          <ChartLegend
            items={[
              { key: 'current', label: t('analyticsPage.newSubsChart.current'), color: ACCENT, shape: 'line' },
              { key: 'previous', label: t('analyticsPage.newSubsChart.previous'), color: GHOST, shape: 'ghost' },
            ]}
          />
          <div ref={chartRef} className="min-h-48 flex-1" data-chart="overview-new-subscriptions">
            {entrance.show && (
              <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
                <LineChart data={rows} margin={CHART_MARGIN}>
                  <CartesianGrid vertical={false} stroke={GRID_STROKE} />
                  <XAxis dataKey="axis" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID_STROKE }} minTickGap={16} />
                  <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={COUNT_AXIS_WIDTH} allowDecimals={false} tickFormatter={(value: number) => formatCount(value, { compact: true })} />
                  <Tooltip
                    cursor={LINE_CURSOR}
                    isAnimationActive={false}
                    content={(props: RechartsTooltipProps) => {
                      const row = hoveredRow<TimeRow>(props)
                      if (row === null) return null
                      return (
                        <TooltipCard
                          heading={row.heading}
                          rows={[
                            { key: 'current', name: t('analyticsPage.newSubsChart.current'), value: formatCount(row.value ?? 0), color: ACCENT, shape: 'line' },
                            ...(row.previous === null
                              ? []
                              : [
                                  {
                                    key: 'previous',
                                    name: t('analyticsPage.newSubsChart.previous'),
                                    value: formatCount(row.previous),
                                    color: GHOST,
                                    shape: 'ghost' as const,
                                    note: row.previousHeading ?? undefined,
                                  },
                                ]),
                          ]}
                        />
                      )
                    }}
                  />
                  <Line
                    dataKey="previous"
                    name={t('analyticsPage.newSubsChart.previous')}
                    type="monotone"
                    stroke={GHOST}
                    strokeOpacity={0.75}
                    strokeWidth={2}
                    dot={false}
                    activeDot={false}
                    isAnimationActive={entrance.animate}
                    animationDuration={SWEEP_MS}
                  />
                  <Line
                    dataKey="value"
                    name={t('analyticsPage.newSubsChart.current')}
                    type="monotone"
                    stroke={ACCENT}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, stroke: 'var(--card)', strokeWidth: 2 }}
                    isAnimationActive={entrance.animate}
                    animationDuration={SWEEP_MS}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      )}
    </ChartCard>
  )
}

// ── Funnel ───────────────────────────────────────────────────────────────────

const FUNNEL_KEYS = ['registered', 'activated', 'paid', 'repeat'] as const

function FunnelCard({ funnel, played }: { readonly funnel: readonly ConversionFunnelStep[]; readonly played: Set<string> }): JSX.Element {
  const { t } = useTranslation()
  const chartRef = useRef<HTMLDivElement>(null)
  const entrance = useChartEntrance('overview.funnel', played, chartRef)
  const steps = FUNNEL_KEYS.map((key) => funnel.find((step) => step.key === key)).filter(
    (step): step is ConversionFunnelStep => step !== undefined,
  )
  const start = steps[0]?.count ?? 0

  return (
    <ChartCard
      id="overview-funnel"
      title={t('analyticsPage.funnel.title')}
      info={t('analyticsPage.funnel.info')}
      rule="money"
      description={t('analyticsPage.funnel.description')}
      icon={<ArrowRightLeft className="size-4 text-muted-foreground" aria-hidden="true" />}
    >
      {start === 0 ? (
        <EmptyState className="h-56">{t('analyticsPage.funnel.empty')}</EmptyState>
      ) : (
        // The steps spread over the height the row gives the card: beside the
        // revenue chart it is taller than four bars need.
        <div ref={chartRef} className="h-full">
        <ol className="flex h-full flex-col justify-between gap-1" data-funnel="">
          {steps.map((step, index) => {
            const width = start === 0 ? 0 : Math.max(0.5, step.pctOfStart * 100)
            return (
              <li key={step.key} data-funnel-step={step.key}>
                {index > 0 && (
                  <p className="py-0.5 pl-1 text-[11px] text-muted-foreground" data-funnel-conversion="">
                    ↓ {t('analyticsPage.funnel.stepRate', { percent: formatPercent(step.pctOfPrev) })}
                  </p>
                )}
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="font-medium">{t(`analyticsPage.funnel.steps.${step.key}`)}</span>{' '}
                  <span className="tabular-nums">
                    <span className="font-medium">{formatCount(step.count)}</span>
                    {index > 0 && <span className="ml-1.5 text-xs text-muted-foreground">{` ${formatPercent(step.pctOfStart)}`}</span>}
                  </span>
                </div>
                <div className="mt-1 h-3" aria-hidden="true">
                  <div
                    className={cn('h-full rounded-r-[4px]', entrance.animate && entrance.show && 'origin-left motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-left-2 motion-safe:duration-500 motion-safe:fill-mode-both')}
                    style={{
                      width: `${width}%`,
                      backgroundColor: funnelColor(index),
                      animationDelay: entrance.animate ? `${index * 80}ms` : undefined,
                    }}
                  />
                </div>
              </li>
            )
          })}
        </ol>
        </div>
      )}
    </ChartCard>
  )
}

// ── Payment systems ──────────────────────────────────────────────────────────

function ProvidersCard({
  providers,
  money,
  played,
}: {
  readonly providers: readonly ProviderHealth[]
  readonly money: MoneyView
  readonly played: Set<string>
}): JSX.Element {
  const { t } = useTranslation()
  const chartRef = useRef<HTMLDivElement>(null)
  const entrance = useChartEntrance('overview.providers', played, chartRef)
  const legend = [
    { key: 'paid', label: t('analyticsPage.providers.paid'), color: OUTCOME_COLORS.paid, shape: 'rect' as const },
    { key: 'canceled', label: t('analyticsPage.providers.canceled'), color: OUTCOME_COLORS.canceled, shape: 'rect' as const },
    { key: 'failed', label: t('analyticsPage.providers.failed'), color: OUTCOME_COLORS.failed, shape: 'rect' as const },
  ]
  return (
    <ChartCard
      id="overview-providers"
      title={t('analyticsPage.providers.title')}
      info={t('analyticsPage.providers.info')}
      rule="money"
      description={t('analyticsPage.providers.description')}
      icon={<Receipt className="size-4 text-muted-foreground" aria-hidden="true" />}
    >
      {providers.length === 0 ? (
        <EmptyState className="h-48">{t('analyticsPage.providers.empty')}</EmptyState>
      ) : (
        <div ref={chartRef} className="space-y-3">
          <ChartLegend items={legend} />
          <ul className="space-y-3" data-providers="">
            {providers.map((provider) => (
              <ProviderRow key={provider.gatewayType} provider={provider} money={money} animate={entrance.animate && entrance.show} />
            ))}
          </ul>
        </div>
      )}
    </ChartCard>
  )
}

function ProviderRow({ provider, money, animate }: { readonly provider: ProviderHealth; readonly money: MoneyView; readonly animate: boolean }): JSX.Element {
  const { t } = useTranslation()
  // A refund does not undo a checkout that went through: it is in `paid`, and said apart below.
  const paid = provider.paid
  const decided = paid + provider.canceled + provider.failed
  const segments = [
    { key: 'paid', count: paid, color: OUTCOME_COLORS.paid },
    { key: 'canceled', count: provider.canceled, color: OUTCOME_COLORS.canceled },
    { key: 'failed', count: provider.failed, color: OUTCOME_COLORS.failed },
  ].filter((segment) => segment.count > 0)
  return (
    <li className="space-y-1" data-provider={provider.gatewayType}>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="flex min-w-0 items-center gap-1.5">
          <GatewayIcon gatewayType={provider.gatewayType} />
          <span className="truncate font-medium">{gatewayName(t, provider.gatewayType)}</span>
        </span>{' '}
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {decided === 0 ? '—' : t('analyticsPage.providers.successRate', { percent: formatPercent(provider.successRate) })}
          {provider.revenue > 0 && (
            <span className="ml-1.5 font-medium text-foreground">
              {' '}
              {approx(money, provider.revenueFigure.byCurrency.map((slice) => slice.currency))}
              {formatMoney(provider.revenue, money.currency, { compact: true })}
            </span>
          )}
        </span>
      </div>
      {decided > 0 && (
        <div className="flex h-3 gap-[2px] overflow-hidden rounded-r-[4px]" aria-hidden="true">
          {segments.map((segment, index) => (
            <div
              key={segment.key}
              className={cn('h-full', animate && 'motion-safe:animate-in motion-safe:fade-in motion-safe:duration-500 motion-safe:fill-mode-both')}
              style={{ flexGrow: segment.count, flexBasis: 0, backgroundColor: segment.color, animationDelay: animate ? `${index * 80}ms` : undefined }}
            />
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {t('analyticsPage.providers.counts', {
          paid: formatCount(paid),
          canceled: formatCount(provider.canceled),
          failed: formatCount(provider.failed),
        })}
        {provider.refunded > 0 && ` · ${t('analyticsPage.providers.refunded', { count: provider.refunded })}`}
        {provider.pending > 0 && ` · ${t('analyticsPage.providers.pending', { count: provider.pending })}`}
      </p>
    </li>
  )
}
