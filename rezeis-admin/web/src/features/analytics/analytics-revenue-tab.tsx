/**
 * «Выручка»: how much came in, in which currencies, over time, from what kind
 * of purchase, for which plans and through which payment systems — and what
 * the subscriptions in force are on.
 *
 * ONE CURRENCY IS NOT A CHART. The old tab drew «Выручка по валютам» as a full
 * ring at 100 % whenever an install took roubles only, and labelled it
 * «RUB 9.7K». With one currency the tab now states the total, the number of
 * payments and the average payment; the part-to-whole bar appears only when
 * there are several currencies to compare.
 */
import { type JSX, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Coins, Layers, Receipt, Shapes, Tags } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { Card } from '@/components/ui/card'
import { InfoTip } from '@/components/ui/info-tip'
import { activeLocale, cn } from '@/lib/utils'

import type { TFunction } from 'i18next'

import {
  getRevenueReport,
  getSubscriptionsByPlan,
  type PurchaseKind,
  type RevenuePlan,
  type RevenueReport,
  type SubscriptionByPlanItem,
} from './analytics-api'
import {
  ChartCard,
  ChartLegend,
  ChartSkeleton,
  DataTable,
  EmptyState,
  GatewayIcon,
  MoneyNote,
  QueryBody,
  RankedBars,
  type SegmentShapeProps,
  StackSegment,
  TooltipCard,
  ZoneNote,
} from './analytics-chart-kit'
import {
  approx,
  AXIS_TICK,
  BAR_CURSOR,
  BAR_MAX,
  MONEY_AXIS_WIDTH,
  GRID_STROKE,
  hoveredRow,
  type RechartsTooltipProps,
  sharedInfoWords,
  SWEEP_MS,
  useChartEntrance,
  withRule,
} from './analytics-chart-support'
import { formatBucket, formatCount, formatMoney, formatPercent, gatewayName, partnerBalanceText } from './analytics-format'
import { ACCENT, CURRENCY_ORDER, currencyColor, OTHER_COLOR, PURCHASE_KIND_COLORS } from './analytics-palette'

const LISTS_ROW = 'grid gap-4 @min-[56rem]:grid-cols-2 @min-[88rem]:grid-cols-3'
const KINDS: readonly PurchaseKind[] = ['new', 'renewal', 'change', 'addon']
/** Named currencies a stack may show; the rest fold into «Другие». */
const MAX_NAMED_CURRENCIES = 4
const OTHER_KEY = '__other__'

export function RevenueTab({ days, played }: { readonly days: number; readonly played: Set<string> }): JSX.Element {
  const { t } = useTranslation()
  const revenue = useQuery({
    queryKey: ['analytics', 'revenue', days],
    queryFn: () => getRevenueReport(days),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  })
  const plans = useQuery({
    queryKey: ['analytics', 'subscriptions-by-plan'],
    queryFn: getSubscriptionsByPlan,
    staleTime: 60_000,
  })
  const report = revenue.data

  return (
    <div className="@container space-y-4" data-analytics-tab="revenue">
      {report === undefined ? (
        revenue.isError ? (
          <EmptyState className="h-40 rounded-lg border">{t('analyticsPage.common.unavailable')}</EmptyState>
        ) : (
          <div className="space-y-4" aria-busy="true">
            <ChartSkeleton className="h-28" />
            <ChartSkeleton className="h-80" />
          </div>
        )
      ) : (
        <div className={cn('space-y-4 motion-safe:transition-opacity', revenue.isPlaceholderData && 'opacity-60')} aria-busy={revenue.isPlaceholderData || undefined}>
          <ZoneNote fallback={report.period.timeZoneFallback} />
          <MoneyNote money={report.money} />
          <CurrencySummary report={report} played={played} />
          <RevenueOverTime report={report} played={played} />
          <KindsCard report={report} played={played} />
        </div>
      )}
      {/* The three ranked lists share a row: rows of the same height, so the
          cards differ only by how many lines each has. Two to a row on a
          narrower screen, the third then as wide as both. */}
      <div className={LISTS_ROW}>
        {report === undefined ? <ChartSkeleton className="h-72" /> : <PlansRevenueCard report={report} played={played} />}
        {report === undefined ? <ChartSkeleton className="h-72" /> : <GatewaysCard report={report} played={played} />}
        <SubscriptionsByPlanCard query={plans} played={played} className="@min-[56rem]:col-span-2 @min-[88rem]:col-span-1" />
      </div>
    </div>
  )
}

// ── The total, per currency ──────────────────────────────────────────────────

function CurrencySummary({ report, played }: { readonly report: RevenueReport; readonly played: Set<string> }): JSX.Element {
  const { t } = useTranslation()
  const chartRef = useRef<HTMLDivElement>(null)
  const entrance = useChartEntrance('revenue.currencies', played, chartRef)
  const { money } = report
  const currencies = report.byCurrency
  const approxMark = approx(money, report.total.byCurrency.map((slice) => slice.currency))
  // Over the payments whose money is in the total: a currency with no rate is
  // left out of both sides, as the money note says.
  const convertedPayments = currencies.reduce((sum, slice) => sum + (slice.value === null ? 0 : slice.payments), 0)
  const average = convertedPayments === 0 ? null : report.total.value / convertedPayments
  const title = report.windowDays === 365 ? t('analyticsPage.revenue.summary.titleYear') : t('analyticsPage.revenue.summary.title', { count: report.windowDays })
  const partnerBalance = partnerBalanceText(t, report.partnerBalance)

  return (
    <Card className="p-4" data-analytics-card="revenue-summary" data-analytics-rule="money">
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div>
          <p className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
            {title}
            <InfoTip label={t('analyticsPage.common.aboutLabel', { title })}>
              {withRule(t, t('analyticsPage.revenue.summary.info'), 'money')}
            </InfoTip>
          </p>
          <p className="text-3xl font-semibold leading-tight" data-revenue-total="">
            {approxMark}
            {formatMoney(report.total.value, money.currency)}
          </p>
        </div>
        <Stat label={t('analyticsPage.revenue.summary.payments')} value={formatCount(report.payments)} />
        <Stat
          label={t('analyticsPage.revenue.summary.average')}
          value={average === null ? '—' : `${approxMark}${formatMoney(average, money.currency)}`}
        />
        {currencies.length === 1 && (
          <Stat label={t('analyticsPage.revenue.summary.currency')} value={currencies[0]!.currency} />
        )}
      </div>
      {currencies.length === 0 && (
        <p className="mt-3 text-sm text-muted-foreground">{t('analyticsPage.revenue.summary.empty')}</p>
      )}
      {partnerBalance !== null && (
        <p className="mt-3 text-sm text-muted-foreground" data-partner-balance="">
          {partnerBalance}
        </p>
      )}
      {currencies.length > 1 && (
        <div ref={chartRef} className="mt-4 space-y-2" data-currency-split="">
          <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-r-[4px]" aria-hidden="true">
            {currencies
              .filter((slice) => slice.value !== null && slice.value > 0)
              .map((slice, index) => (
                <div
                  key={slice.currency}
                  className={cn('h-full', entrance.animate && entrance.show && 'motion-safe:animate-in motion-safe:fade-in motion-safe:duration-500 motion-safe:fill-mode-both')}
                  style={{
                    flexGrow: slice.value ?? 0,
                    flexBasis: 0,
                    backgroundColor: currencyColor(slice.currency),
                    animationDelay: entrance.animate ? `${index * 80}ms` : undefined,
                  }}
                />
              ))}
          </div>
          <ul className="flex flex-wrap gap-x-6 gap-y-1.5 text-sm" data-currency-list="">
            {currencies.map((slice) => (
              <li key={slice.currency} className="flex items-center gap-1.5" data-currency={slice.currency}>
                <span aria-hidden="true" className="size-2.5 rounded-[2px]" style={{ backgroundColor: slice.value === null ? 'transparent' : currencyColor(slice.currency), border: slice.value === null ? '1px dashed var(--muted-foreground)' : undefined }} />
                <span className="font-medium">{formatMoney(slice.amount, slice.currency)}</span>{' '}
                {slice.currency !== money.currency && slice.value !== null && (
                  <span className="text-xs text-muted-foreground">{`≈\xa0${formatMoney(slice.value, money.currency)} `}</span>
                )}
                <span className="text-xs text-muted-foreground">
                  {slice.value === null
                    ? t('analyticsPage.revenue.summary.noRate')
                    : formatPercent(report.total.value === 0 ? 0 : slice.value / report.total.value)}
                  {' · '}
                  {t('analyticsPage.revenue.summary.paymentsCount', { count: slice.payments })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}

function Stat({ label, value }: { readonly label: string; readonly value: string }): JSX.Element {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  )
}

// ── Over time, per currency ─────────────────────────────────────────────────

interface Series {
  /** The row field the series reads — never the currency code itself, which is its name. */
  readonly key: string
  /** `null` for «Другие». */
  readonly currency: string | null
  readonly label: string
  readonly color: string
}

/**
 * The currencies a stack shows, in the fixed order the palette gives them,
 * those it cannot convert left out (they are named in the money note), and
 * anything past four folded into «Другие».
 */
function currencySeries(report: RevenueReport, otherLabel: string): Series[] {
  const convertible = report.byCurrency.filter((slice) => slice.value !== null && slice.value > 0)
  const named = [...convertible]
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    .slice(0, convertible.length > MAX_NAMED_CURRENCIES ? MAX_NAMED_CURRENCIES - 1 : MAX_NAMED_CURRENCIES)
    .map((slice) => slice.currency)
  const rank = (currency: string): number => {
    const index = CURRENCY_ORDER.indexOf(currency)
    return index === -1 ? CURRENCY_ORDER.length : index
  }
  const series: Series[] = [...named]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((currency) => ({ key: `cur_${currency}`, currency, label: currency, color: currencyColor(currency) }))
  if (convertible.length > named.length) series.push({ key: OTHER_KEY, currency: null, label: otherLabel, color: OTHER_COLOR })
  return series
}

type StackRow = { readonly index: number; readonly axis: string; readonly heading: string } & Record<string, number | string>

function RevenueOverTime({ report, played }: { readonly report: RevenueReport; readonly played: Set<string> }): JSX.Element {
  const { t } = useTranslation()
  const locale = activeLocale()
  const chartRef = useRef<HTMLDivElement>(null)
  const entrance = useChartEntrance('revenue.overTime', played, chartRef)
  const { money, period } = report
  const series = useMemo(() => currencySeries(report, t('analyticsPage.revenue.overTime.other')), [report, t])
  const seriesOrder = useMemo(() => series.map((entry) => entry.key), [series])
  const single = series.length <= 1
  const rows: StackRow[] = useMemo(
    () =>
      period.buckets.map((bucket, index) => {
        const point = report.series[index]
        const row: Record<string, number | string> = {
          index,
          axis: formatBucket(bucket, period.granularity, 'axis', locale),
          heading: formatBucket(bucket, period.granularity, 'full', locale),
        }
        for (const entry of series) row[entry.key] = 0
        for (const slice of point?.byCurrency ?? []) {
          if (slice.value === null) continue
          const key = series.find((entry) => entry.currency === slice.currency)?.key ?? OTHER_KEY
          row[key] = ((row[key] as number | undefined) ?? 0) + slice.value
        }
        return row as StackRow
      }),
    [period, report.series, series, locale],
  )
  const granularity = period.granularity === 'day' ? 'Day' : period.granularity === 'week' ? 'Week' : 'Month'
  const title = t(`analyticsPage.revenue.overTime.title${granularity}`)
  const empty = report.total.value === 0
  const money_ = (value: number): string => formatMoney(value, money.currency)

  return (
    <ChartCard
      id="revenue-over-time"
      title={title}
      icon={<Coins className="size-4 text-muted-foreground" aria-hidden="true" />}
      info={t('analyticsPage.revenue.overTime.info')}
      rule="money"
      description={single ? t('analyticsPage.revenue.overTime.descriptionSingle', { currency: money.currency }) : t('analyticsPage.revenue.overTime.descriptionMulti', { currency: money.currency })}
      table={
        empty ? undefined : (
          <DataTable
            caption={title}
            columns={[
              { key: 'period', label: t('analyticsPage.common.period') },
              ...series.map((entry) => ({ key: entry.key, label: entry.label, numeric: true })),
              ...(single ? [] : [{ key: 'total', label: t('analyticsPage.common.total'), numeric: true }]),
            ]}
            rows={rows.map((row) => ({
              key: String(row.index),
              period: row.heading,
              ...Object.fromEntries(series.map((entry) => [entry.key, money_(Number(row[entry.key] ?? 0))])),
              total: money_(series.reduce((sum, entry) => sum + Number(row[entry.key] ?? 0), 0)),
            }))}
          />
        )
      }
    >
      {empty ? (
        <EmptyState className="h-72">{t('analyticsPage.revenue.empty')}</EmptyState>
      ) : (
        <div className="space-y-2">
          {!single && <ChartLegend items={series.map((entry) => ({ key: entry.key, label: entry.label, color: entry.color, shape: 'rect' as const }))} />}
          <div ref={chartRef} className="h-72" data-chart="revenue-over-time">
            {entrance.show && (
              <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
                <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="20%">
                  <CartesianGrid vertical={false} stroke={GRID_STROKE} />
                  <XAxis dataKey="axis" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID_STROKE }} minTickGap={16} />
                  <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={MONEY_AXIS_WIDTH} tickFormatter={(value: number) => formatMoney(value, money.currency, { compact: true })} />
                  <Tooltip
                    cursor={BAR_CURSOR}
                    isAnimationActive={false}
                    content={(props: RechartsTooltipProps) => {
                      const row = hoveredRow<StackRow>(props)
                      if (row === null) return null
                      const point = report.series[row.index]
                      const native = new Map((point?.byCurrency ?? []).map((slice) => [slice.currency, slice.amount]))
                      const total = series.reduce((sum, entry) => sum + Number(row[entry.key] ?? 0), 0)
                      return (
                        <TooltipCard
                          heading={row.heading}
                          rows={[...series].reverse().map((entry) => ({
                            key: entry.key,
                            name: entry.label,
                            value: money_(Number(row[entry.key] ?? 0)),
                            color: entry.color,
                            shape: 'rect' as const,
                            note:
                              entry.currency !== null && entry.currency !== money.currency && native.has(entry.currency)
                                ? formatMoney(native.get(entry.currency) ?? 0, entry.currency)
                                : undefined,
                          }))}
                          footer={
                            single
                              ? undefined
                              : t('analyticsPage.revenue.overTime.total', {
                                  value: `${approx(money, series.flatMap((entry) => (entry.currency === null ? [] : [entry.currency])))}${money_(total)}`,
                                })
                          }
                        />
                      )
                    }}
                  />
                  {series.map((entry) => (
                    <Bar
                      key={entry.key}
                      dataKey={entry.key}
                      name={entry.label}
                      stackId="currency"
                      fill={entry.color}
                      shape={(props: SegmentShapeProps) => <StackSegment {...props} order={seriesOrder} segment={entry.key} />}
                      maxBarSize={BAR_MAX}
                      isAnimationActive={entrance.animate}
                      animationDuration={SWEEP_MS}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      )}
    </ChartCard>
  )
}

// ── Where the money comes from ───────────────────────────────────────────────

type KindRow = { readonly index: number; readonly axis: string; readonly heading: string } & Record<PurchaseKind, number>

function KindsCard({ report, played, className }: { readonly report: RevenueReport; readonly played: Set<string>; readonly className?: string }): JSX.Element {
  const { t } = useTranslation()
  const locale = activeLocale()
  const chartRef = useRef<HTMLDivElement>(null)
  const entrance = useChartEntrance('revenue.kinds', played, chartRef)
  const { money, period } = report
  const rows: KindRow[] = useMemo(
    () =>
      period.buckets.map((bucket, index) => ({
        index,
        axis: formatBucket(bucket, period.granularity, 'axis', locale),
        heading: formatBucket(bucket, period.granularity, 'full', locale),
        new: report.series[index]?.byKind.new ?? 0,
        renewal: report.series[index]?.byKind.renewal ?? 0,
        change: report.series[index]?.byKind.change ?? 0,
        addon: report.series[index]?.byKind.addon ?? 0,
      })),
    [period, report.series, locale],
  )
  const totals = new Map(report.byKind.map((kind) => [kind.kind, kind]))
  const total = report.byKind.reduce((sum, kind) => sum + kind.figure.value, 0)
  const empty = total === 0
  const label = (kind: PurchaseKind): string => t(`analyticsPage.revenue.kinds.${kind}`)
  const title = t('analyticsPage.revenue.kinds.title')

  return (
    <ChartCard
      id="revenue-kinds"
      className={className}
      title={title}
      icon={<Shapes className="size-4 text-muted-foreground" aria-hidden="true" />}
      info={t('analyticsPage.revenue.kinds.info', sharedInfoWords(t))}
      rule="money"
      description={t('analyticsPage.revenue.kinds.description')}
      table={
        empty ? undefined : (
          <DataTable
            caption={title}
            columns={[
              { key: 'kind', label: t('analyticsPage.revenue.kinds.kindColumn') },
              { key: 'value', label: t('analyticsPage.common.revenue'), numeric: true },
              { key: 'share', label: t('analyticsPage.common.share'), numeric: true },
              { key: 'payments', label: t('analyticsPage.common.payments'), numeric: true },
            ]}
            rows={KINDS.map((kind) => {
              const entry = totals.get(kind)
              const value = entry?.figure.value ?? 0
              return {
                key: kind,
                kind: label(kind),
                value: formatMoney(value, money.currency),
                share: formatPercent(total === 0 ? 0 : value / total),
                payments: formatCount(entry?.payments ?? 0),
              }
            })}
          />
        )
      }
    >
      {empty ? (
        <EmptyState className="h-64">{t('analyticsPage.revenue.empty')}</EmptyState>
      ) : (
        <div className="space-y-3">
          <ul className="grid grid-cols-2 gap-x-4 gap-y-2 @min-[40rem]:grid-cols-4" data-kind-legend="">
            {KINDS.map((kind) => {
              const value = totals.get(kind)?.figure.value ?? 0
              return (
                <li key={kind} className="min-w-0" data-kind={kind}>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span aria-hidden="true" className="size-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: PURCHASE_KIND_COLORS[kind] }} />
                    <span className="truncate">{label(kind)}</span>
                  </span>{' '}
                  <span className="block text-sm font-medium">
                    {formatMoney(value, money.currency, { compact: true })}
                    <span className="ml-1.5 text-xs font-normal text-muted-foreground">{` ${formatPercent(value / total)}`}</span>
                  </span>
                </li>
              )
            })}
          </ul>
          <div ref={chartRef} className="h-56" data-chart="revenue-kinds">
            {entrance.show && (
              <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
                <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="20%">
                  <CartesianGrid vertical={false} stroke={GRID_STROKE} />
                  <XAxis dataKey="axis" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID_STROKE }} minTickGap={16} />
                  <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={MONEY_AXIS_WIDTH} tickFormatter={(value: number) => formatMoney(value, money.currency, { compact: true })} />
                  <Tooltip
                    cursor={BAR_CURSOR}
                    isAnimationActive={false}
                    content={(props: RechartsTooltipProps) => {
                      const row = hoveredRow<KindRow>(props)
                      if (row === null) return null
                      return (
                        <TooltipCard
                          heading={row.heading}
                          rows={[...KINDS].reverse().map((kind) => ({
                            key: kind,
                            name: label(kind),
                            value: formatMoney(row[kind], money.currency),
                            color: PURCHASE_KIND_COLORS[kind],
                            shape: 'rect' as const,
                          }))}
                        />
                      )
                    }}
                  />
                  {KINDS.map((kind) => (
                    <Bar
                      key={kind}
                      dataKey={kind}
                      name={label(kind)}
                      stackId="kind"
                      fill={PURCHASE_KIND_COLORS[kind]}
                      shape={(props: SegmentShapeProps) => <StackSegment {...props} order={KINDS} segment={kind} />}
                      maxBarSize={BAR_MAX}
                      isAnimationActive={entrance.animate}
                      animationDuration={SWEEP_MS}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      )}
    </ChartCard>
  )
}

// ── Per payment system, per plan ─────────────────────────────────────────────

function GatewaysCard({ report, played }: { readonly report: RevenueReport; readonly played: Set<string> }): JSX.Element {
  const { t } = useTranslation()
  const chartRef = useRef<HTMLDivElement>(null)
  const entrance = useChartEntrance('revenue.gateways', played, chartRef)
  const { money } = report
  const total = report.total.value
  return (
    <ChartCard
      id="revenue-gateways"
      title={t('analyticsPage.revenue.byGateway.title')}
      icon={<Receipt className="size-4 text-muted-foreground" aria-hidden="true" />}
      info={t('analyticsPage.revenue.byGateway.info')}
      rule="money"
    >
      {report.byGateway.length === 0 ? (
        <EmptyState className="h-48">{t('analyticsPage.revenue.empty')}</EmptyState>
      ) : (
        <div ref={chartRef}>
          <RankedBars
            animate={entrance.animate && entrance.show}
            rows={report.byGateway.map((gateway) => ({
              key: gateway.gatewayType,
              label: gatewayName(t, gateway.gatewayType),
              icon: <GatewayIcon gatewayType={gateway.gatewayType} />,
              detail: t('analyticsPage.revenue.summary.paymentsCount', { count: gateway.payments }),
              value: gateway.figure.value,
              valueText: `${approx(money, gateway.figure.byCurrency.map((slice) => slice.currency))}${formatMoney(gateway.figure.value, money.currency, { compact: true })}`,
              shareText: total === 0 ? undefined : formatPercent(gateway.figure.value / total),
            }))}
          />
        </div>
      )}
    </ChartCard>
  )
}

function planLabel(t: TFunction, plan: RevenuePlan): string {
  if (plan.kind === 'addon') return t('analyticsPage.revenue.byPlan.addons')
  if (plan.kind === 'none') return t('analyticsPage.revenue.byPlan.none')
  return plan.name ?? t('analyticsPage.revenue.byPlan.unnamed')
}

function PlansRevenueCard({ report, played }: { readonly report: RevenueReport; readonly played: Set<string> }): JSX.Element {
  const { t } = useTranslation()
  const chartRef = useRef<HTMLDivElement>(null)
  const entrance = useChartEntrance('revenue.plans', played, chartRef)
  const { money } = report
  const total = report.total.value
  const rows = report.byPlan.filter((plan) => plan.figure.value > 0 || plan.payments > 0)
  return (
    <ChartCard
      id="revenue-plans"
      title={t('analyticsPage.revenue.byPlan.title')}
      icon={<Tags className="size-4 text-muted-foreground" aria-hidden="true" />}
      info={t('analyticsPage.revenue.byPlan.info')}
      rule="money"
      description={t('analyticsPage.revenue.byPlan.description')}
    >
      {rows.length === 0 ? (
        <EmptyState className="h-48">{t('analyticsPage.revenue.empty')}</EmptyState>
      ) : (
        <div ref={chartRef}>
          <RankedBars
            animate={entrance.animate && entrance.show}
            limit={10}
            rows={rows.map((plan) => ({
              key: plan.key,
              label: planLabel(t, plan),
              detail: t('analyticsPage.revenue.summary.paymentsCount', { count: plan.payments }),
              value: plan.figure.value,
              valueText: `${approx(money, plan.figure.byCurrency.map((slice) => slice.currency))}${formatMoney(plan.figure.value, money.currency, { compact: true })}`,
              shareText: total === 0 ? undefined : formatPercent(plan.figure.value / total),
            }))}
          />
          {rows.length > 10 && <p className="mt-3 text-xs text-muted-foreground">{t('analyticsPage.common.moreRows', { count: rows.length - 10 })}</p>}
        </div>
      )}
    </ChartCard>
  )
}

function SubscriptionsByPlanCard({
  query,
  played,
  className,
}: {
  readonly query: { readonly data: readonly SubscriptionByPlanItem[] | undefined; readonly isLoading: boolean; readonly isError: boolean }
  readonly played: Set<string>
  readonly className?: string
}): JSX.Element {
  const { t } = useTranslation()
  const chartRef = useRef<HTMLDivElement>(null)
  const entrance = useChartEntrance('revenue.subscriptionsByPlan', played, chartRef)
  return (
    <ChartCard
      id="revenue-subscriptions-by-plan"
      className={className}
      title={t('analyticsPage.revenue.subsByPlan.title')}
      icon={<Layers className="size-4 text-muted-foreground" aria-hidden="true" />}
      info={t('analyticsPage.revenue.subsByPlan.info')}
      description={t('analyticsPage.revenue.subsByPlan.description')}
    >
      <QueryBody query={query} height="h-48">
        {(plans) =>
          plans.length === 0 ? (
            <EmptyState className="h-48">{t('analyticsPage.revenue.subsByPlan.empty')}</EmptyState>
          ) : (
            <div ref={chartRef}>
              <RankedBars
                animate={entrance.animate && entrance.show}
                limit={10}
                rows={plans.map((plan) => ({
                  key: plan.planId ?? `name:${plan.plan}`,
                  label: plan.plan === '' ? t('analyticsPage.revenue.byPlan.unnamed') : plan.plan,
                  detail: [
                    plan.limited > 0 ? t('analyticsPage.revenue.subsByPlan.limited', { count: plan.limited }) : null,
                    plan.trial > 0 ? t('analyticsPage.revenue.subsByPlan.trial', { count: plan.trial }) : null,
                  ]
                    .filter((part): part is string => part !== null)
                    .join(' · ') || undefined,
                  value: plan.total,
                  valueText: formatCount(plan.total),
                  shareText: formatPercent(plan.percentage),
                  color: ACCENT,
                }))}
              />
              {plans.length > 10 && <p className="mt-3 text-xs text-muted-foreground">{t('analyticsPage.common.moreRows', { count: plans.length - 10 })}</p>}
            </div>
          )
        }
      </QueryBody>
    </ChartCard>
  )
}
