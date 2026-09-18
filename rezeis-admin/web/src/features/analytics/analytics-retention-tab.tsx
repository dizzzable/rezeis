/**
 * «Удержание»: who is about to go, how each signup month keeps paying, and
 * what a paying customer is worth over their lifetime. None of it depends on
 * the period buttons — each card says its own horizon.
 *
 * «Истекают в ближайшие 30 дней» is the one to act on: the paid subscriptions
 * that will end with nothing charged are the list for reminders and offers,
 * drawn at the bottom of every bar in the strongest colour.
 */
import { type JSX, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { CalendarClock, Grid3x3, Layers } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { TFunction } from 'i18next'

import { cn } from '@/lib/utils'

import {
  type CohortRow,
  type ExpiringReport,
  getAnalyticsCohorts,
  getExpiring,
  getLtvDistribution,
  type LtvReport,
} from './analytics-api'
import {
  ChartCard,
  DataTable,
  EmptyState,
  MoneyNote,
  QueryBody,
  type SegmentShapeProps,
  StackSegment,
  TooltipCard,
  ZoneNote,
} from './analytics-chart-kit'
import {
  AXIS_TICK,
  BAR_CURSOR,
  BAR_MAX,
  COUNT_AXIS_WIDTH,
  GRID_STROKE,
  hoveredRow,
  type RechartsTooltipProps,
  SWEEP_MS,
  useChartEntrance,
} from './analytics-chart-support'
import { formatCohortMonth, formatCount, formatDay, formatMoney, formatPercent } from './analytics-format'
import { ACCENT, EXPIRING_COLORS, heatColor } from './analytics-palette'

/** Bottom to top: the subscriptions that need the operator sit on the baseline. */
const SEGMENTS = ['manual', 'autopay', 'trial'] as const
type Segment = (typeof SEGMENTS)[number]

export function RetentionTab({ played }: { readonly played: Set<string> }): JSX.Element {
  const expiring = useQuery({ queryKey: ['analytics', 'expiring'], queryFn: getExpiring, staleTime: 60_000 })
  const cohorts = useQuery({ queryKey: ['analytics', 'cohorts'], queryFn: getAnalyticsCohorts, staleTime: 5 * 60_000 })
  const ltv = useQuery({ queryKey: ['analytics', 'ltv'], queryFn: getLtvDistribution, staleTime: 5 * 60_000 })

  return (
    <div className="@container space-y-4" data-analytics-tab="retention">
      <ZoneNote fallback={expiring.data?.timeZoneFallback === true} />
      <ExpiringCard query={expiring} played={played} />
      <CohortCard query={cohorts} />
      <LtvCard query={ltv} played={played} />
    </div>
  )
}

// ── Ending in the coming 30 days ────────────────────────────────────────────

type ExpiringRow = { readonly index: number; readonly axis: string; readonly heading: string } & Record<Segment, number>

function ExpiringCard({
  query,
  played,
}: {
  readonly query: { readonly data: ExpiringReport | undefined; readonly isLoading: boolean; readonly isError: boolean }
  readonly played: Set<string>
}): JSX.Element {
  const { t } = useTranslation()
  const title = t('analyticsPage.retention.expiring.title')
  const report = query.data
  const rows: ExpiringRow[] = useMemo(
    () =>
      (report?.days ?? []).map((day, index) => ({
        index,
        axis: formatDay(day.date, 'axis'),
        heading: formatDay(day.date, 'full'),
        manual: day.manual,
        autopay: day.autopay,
        trial: day.trial,
      })),
    [report],
  )
  const label = (segment: Segment): string => t(`analyticsPage.retention.expiring.${segment}`)
  const total = report === undefined ? 0 : report.totals.manual + report.totals.autopay + report.totals.trial

  return (
    <ChartCard
      id="retention-expiring"
      title={title}
      icon={<CalendarClock className="size-4 text-muted-foreground" aria-hidden="true" />}
      info={t('analyticsPage.retention.expiring.info')}
      description={t('analyticsPage.retention.expiring.description')}
      table={
        report === undefined || total === 0 ? undefined : (
          <DataTable
            caption={title}
            columns={[
              { key: 'day', label: t('analyticsPage.common.day') },
              ...SEGMENTS.map((segment) => ({ key: segment, label: label(segment), numeric: true })),
            ]}
            rows={rows
              .filter((row) => row.manual + row.autopay + row.trial > 0)
              .map((row) => ({
                key: String(row.index),
                day: row.heading,
                manual: formatCount(row.manual),
                autopay: formatCount(row.autopay),
                trial: formatCount(row.trial),
              }))}
          />
        )
      }
    >
      <QueryBody query={query} height="h-72">
        {(data) =>
          total === 0 ? (
            <EmptyState className="h-72">{t('analyticsPage.retention.expiring.empty', { count: data.horizonDays })}</EmptyState>
          ) : (
            <ExpiringChart rows={rows} report={data} played={played} label={label} />
          )
        }
      </QueryBody>
    </ChartCard>
  )
}

function ExpiringChart({
  rows,
  report,
  played,
  label,
}: {
  readonly rows: readonly ExpiringRow[]
  readonly report: ExpiringReport
  readonly played: Set<string>
  readonly label: (segment: Segment) => string
}): JSX.Element {
  const { t } = useTranslation()
  const chartRef = useRef<HTMLDivElement>(null)
  const entrance = useChartEntrance('retention.expiring', played, chartRef)
  return (
    <div className="space-y-3">
      <ul className="grid grid-cols-1 gap-x-6 gap-y-2 @min-[40rem]:grid-cols-3" data-expiring-totals="">
        {SEGMENTS.map((segment) => (
          <li key={segment} className="flex items-baseline gap-2" data-expiring-segment={segment}>
            <span aria-hidden="true" className="size-2.5 shrink-0 translate-y-px rounded-[2px]" style={{ backgroundColor: EXPIRING_COLORS[segment] }} />
            <span className="text-xl font-semibold">{formatCount(report.totals[segment])}</span>{' '}
            <span className="text-xs text-muted-foreground">{label(segment)}</span>
          </li>
        ))}
      </ul>
      <div ref={chartRef} className="h-64" data-chart="retention-expiring">
        {entrance.show && (
          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
            <BarChart data={rows as ExpiringRow[]} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="20%">
              <CartesianGrid vertical={false} stroke={GRID_STROKE} />
              <XAxis dataKey="axis" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID_STROKE }} minTickGap={16} />
              <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={COUNT_AXIS_WIDTH} allowDecimals={false} tickFormatter={(value: number) => formatCount(value, { compact: true })} />
              <Tooltip
                cursor={BAR_CURSOR}
                isAnimationActive={false}
                content={(props: RechartsTooltipProps) => {
                  const row = hoveredRow<ExpiringRow>(props)
                  if (row === null) return null
                  const sum = row.manual + row.autopay + row.trial
                  return (
                    <TooltipCard
                      heading={row.heading}
                      rows={[...SEGMENTS].reverse().map((segment) => ({
                        key: segment,
                        name: label(segment),
                        value: formatCount(row[segment]),
                        color: EXPIRING_COLORS[segment],
                        shape: 'rect' as const,
                      }))}
                      footer={t('analyticsPage.retention.expiring.dayTotal', { count: sum })}
                    />
                  )
                }}
              />
              {SEGMENTS.map((segment) => (
                <Bar
                  key={segment}
                  dataKey={segment}
                  name={label(segment)}
                  stackId="expiring"
                  fill={EXPIRING_COLORS[segment]}
                  shape={(props: SegmentShapeProps) => <StackSegment {...props} order={SEGMENTS} segment={segment} />}
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
  )
}

// ── Cohorts as a heatmap ─────────────────────────────────────────────────────

function CohortCard({
  query,
}: {
  readonly query: { readonly data: readonly CohortRow[] | undefined; readonly isLoading: boolean; readonly isError: boolean }
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <ChartCard
      id="retention-cohorts"
      title={t('analyticsPage.retention.cohorts.title')}
      icon={<Grid3x3 className="size-4 text-muted-foreground" aria-hidden="true" />}
      info={t('analyticsPage.retention.cohorts.info')}
      rule="money"
      description={t('analyticsPage.retention.cohorts.description')}
    >
      <QueryBody query={query} height="h-72">
        {(rows) =>
          rows.every((row) => row.cohortSize === 0) ? (
            <EmptyState className="h-48">{t('analyticsPage.retention.cohorts.empty')}</EmptyState>
          ) : (
            <CohortHeatmap rows={rows} />
          )
        }
      </QueryBody>
    </ChartCard>
  )
}

/**
 * A table, because it is one: every cell prints its percentage, and the colour
 * behind it only helps the eye find the strong and the weak months. The shade
 * is relative to the strongest cell of the table (said in the scale below it).
 */
function CohortHeatmap({ rows }: { readonly rows: readonly CohortRow[] }): JSX.Element {
  const { t } = useTranslation()
  const months = Math.max(1, ...rows.map((row) => row.retentionByMonth.length))
  const max = Math.max(0, ...rows.flatMap((row) => row.retentionByMonth))
  // A month nobody signed up in has nothing to show.
  const visible = rows.filter((row) => row.cohortSize > 0)
  return (
    <div className="space-y-3">
      {/* `relative`: the screen-reader labels of the month columns are positioned
          boxes, and without a positioned scroll box they escape it — on a phone
          the far columns' labels widened the whole page by 335 px. */}
      <div className="relative overflow-x-auto">
        <table className="w-full border-separate border-spacing-0.5 text-xs" data-cohort-table="">
          <caption className="sr-only">{t('analyticsPage.retention.cohorts.title')}</caption>
          <thead>
            <tr className="text-muted-foreground">
              <th scope="col" className="px-2 py-1.5 text-left font-medium">{t('analyticsPage.retention.cohorts.cohortColumn')}</th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('analyticsPage.retention.cohorts.sizeColumn')}</th>
              {Array.from({ length: months }, (_, month) => (
                <th key={month} scope="col" className="min-w-11 px-1 py-1.5 text-center font-medium tabular-nums">
                  <span className="sr-only">{t('analyticsPage.retention.cohorts.monthAfter', { count: month })}</span>
                  <span aria-hidden="true">{month}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.cohort} data-cohort={row.cohort}>
                <th scope="row" className="whitespace-nowrap px-2 py-1.5 text-left font-medium">{formatCohortMonth(row.cohort)}</th>
                <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{formatCount(row.cohortSize)}</td>
                {Array.from({ length: months }, (_, month) => {
                  const value = row.retentionByMonth[month]
                  if (value === undefined) return <td key={month} aria-hidden="true" />
                  return (
                    <td
                      key={month}
                      className={cn('rounded-[3px] px-1 py-1.5 text-center tabular-nums', value === 0 && 'text-muted-foreground')}
                      style={{ backgroundColor: heatColor(max === 0 ? 0 : value / max) }}
                      data-cohort-cell={month}
                    >
                      {formatPercent(value)}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" data-cohort-scale="">
        <span>{t('analyticsPage.retention.cohorts.monthsAfter')}</span>
        <span className="ml-auto flex items-center gap-2">
          <span>{formatPercent(0)}</span>
          <span
            aria-hidden="true"
            className="h-2.5 w-28 rounded-[2px]"
            style={{
              backgroundImage: `linear-gradient(to right, ${heatColor(0.000001)}, ${heatColor(1)})`,
            }}
          />
          <span>{formatPercent(max)}</span>
        </span>
      </div>
    </div>
  )
}

// ── Lifetime value ──────────────────────────────────────────────────────────

interface LtvRow {
  readonly index: number
  readonly axis: string
  readonly heading: string
  readonly users: number
}

function LtvCard({
  query,
  played,
}: {
  readonly query: { readonly data: LtvReport | undefined; readonly isLoading: boolean; readonly isError: boolean }
  readonly played: Set<string>
}): JSX.Element {
  const { t } = useTranslation()
  const title = t('analyticsPage.retention.ltv.title')
  return (
    <ChartCard
      id="retention-ltv"
      title={title}
      icon={<Layers className="size-4 text-muted-foreground" aria-hidden="true" />}
      info={t('analyticsPage.retention.ltv.info')}
      rule="money"
      description={t('analyticsPage.retention.ltv.description')}
      table={
        query.data === undefined || query.data.buckets.length === 0 ? undefined : (
          <DataTable
            caption={title}
            columns={[
              { key: 'range', label: t('analyticsPage.retention.ltv.rangeColumn') },
              { key: 'users', label: t('analyticsPage.retention.ltv.usersColumn'), numeric: true },
            ]}
            rows={ltvRows(query.data, t).map((row) => ({ key: String(row.index), range: row.heading, users: formatCount(row.users) }))}
          />
        )
      }
    >
      <QueryBody query={query} height="h-64">
        {(report) =>
          report.buckets.length === 0 ? (
            <EmptyState className="h-48">{t('analyticsPage.retention.ltv.empty')}</EmptyState>
          ) : (
            <div className="grid gap-6 @min-[56rem]:grid-cols-[minmax(0,1fr)_14rem]">
              <LtvChart report={report} played={played} />
              <LtvStats report={report} />
            </div>
          )
        }
      </QueryBody>
    </ChartCard>
  )
}

function ltvRows(report: LtvReport, t: TFunction): LtvRow[] {
  const currency = report.money.currency
  return report.buckets.map((bucket, index) => {
    const from = formatMoney(bucket.from, currency, { compact: true })
    const to = bucket.to === null ? null : formatMoney(bucket.to, currency, { compact: true })
    return {
      index,
      axis: to === null ? t('analyticsPage.retention.ltv.fromShort', { from }) : from,
      heading: to === null ? t('analyticsPage.retention.ltv.from', { from }) : t('analyticsPage.retention.ltv.range', { from, to }),
      users: bucket.users,
    }
  })
}

function LtvChart({ report, played }: { readonly report: LtvReport; readonly played: Set<string> }): JSX.Element {
  const { t } = useTranslation()
  const chartRef = useRef<HTMLDivElement>(null)
  const entrance = useChartEntrance('retention.ltv', played, chartRef)
  const rows = useMemo(() => ltvRows(report, t), [report, t])
  return (
    <div className="space-y-2">
      <MoneyNote money={report.money} />
      <div ref={chartRef} className="h-56" data-chart="retention-ltv">
        {entrance.show && (
          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
            {/* A histogram: equal bins that touch, 2 px of card between them. */}
            <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap={2}>
              <CartesianGrid vertical={false} stroke={GRID_STROKE} />
              <XAxis dataKey="axis" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID_STROKE }} interval="preserveStartEnd" minTickGap={8} />
              <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={COUNT_AXIS_WIDTH} allowDecimals={false} tickFormatter={(value: number) => formatCount(value, { compact: true })} />
              <Tooltip
                cursor={BAR_CURSOR}
                isAnimationActive={false}
                content={(props: RechartsTooltipProps) => {
                  const row = hoveredRow<LtvRow>(props)
                  if (row === null) return null
                  return (
                    <TooltipCard
                      heading={row.heading}
                      rows={[
                        {
                          key: 'users',
                          name: t('analyticsPage.retention.ltv.usersColumn'),
                          value: formatCount(row.users),
                          color: ACCENT,
                          shape: 'rect',
                          note: formatPercent(report.stats.payers === 0 ? 0 : row.users / report.stats.payers),
                        },
                      ]}
                    />
                  )
                }}
              />
              <Bar
                dataKey="users"
                name={t('analyticsPage.retention.ltv.usersColumn')}
                fill={ACCENT}
                radius={[4, 4, 0, 0]}
                isAnimationActive={entrance.animate}
                animationDuration={SWEEP_MS}
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}

function LtvStats({ report }: { readonly report: LtvReport }): JSX.Element {
  const { t } = useTranslation()
  const currency = report.money.currency
  const money = (value: number | null): string => (value === null ? '—' : formatMoney(value, currency))
  const stats = [
    { key: 'payers', label: t('analyticsPage.retention.ltv.payers'), value: formatCount(report.stats.payers) },
    { key: 'median', label: t('analyticsPage.retention.ltv.median'), value: money(report.stats.median) },
    { key: 'mean', label: t('analyticsPage.retention.ltv.mean'), value: money(report.stats.mean) },
    { key: 'p90', label: t('analyticsPage.retention.ltv.p90'), value: money(report.stats.p90) },
  ]
  return (
    <dl className="grid grid-cols-2 content-start gap-x-4 gap-y-3 @min-[56rem]:grid-cols-1" data-ltv-stats="">
      {stats.map((stat) => (
        <div key={stat.key}>
          <dt className="text-xs text-muted-foreground">{stat.label}</dt>
          <dd className="text-lg font-semibold">{stat.value}</dd>
        </div>
      ))}
    </dl>
  )
}
