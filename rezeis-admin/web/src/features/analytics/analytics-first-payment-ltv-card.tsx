/**
 * «Ценность клиента по месяцу первой оплаты»: for the clients of each month of
 * first payment, the mean and the median of everything they have paid to date.
 * It stands beside «Пожизненная ценность клиента» (the histogram of all payers)
 * and reads money the same way.
 *
 * The latest months have had the least time to pay; the card says so under the
 * chart.
 */
import { type JSX, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { TrendingUp } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { activeLocale } from '@/lib/utils'

import { type FirstPaymentLtvReport, getPaidLtv } from './analytics-api'
import { ChartCard, ChartLegend, DataTable, EmptyState, MoneyNote, QueryBody, TooltipCard } from './analytics-chart-kit'
import {
  AXIS_TICK,
  BAR_CURSOR,
  type RechartsTooltipProps,
  GRID_STROKE,
  hoveredRow,
  MONEY_AXIS_WIDTH,
  SWEEP_MS,
  useChartEntrance,
} from './analytics-chart-support'
import { formatCohortMonth, formatCount, formatMoney } from './analytics-format'
import { ACCENT } from './analytics-palette'
import { SURFACE_HUES } from './surface-palette'

const MEDIAN_COLOR = SURFACE_HUES.lavender

interface Row {
  readonly cohort: string
  readonly axis: string
  readonly heading: string
  readonly clients: number
  readonly mean: number | null
  readonly median: number | null
}

function monthAxis(cohort: string): string {
  return new Intl.DateTimeFormat(activeLocale(), { timeZone: 'UTC', month: 'short' }).format(new Date(`${cohort}-01T00:00:00Z`))
}

export function FirstPaymentLtvCard({ played }: { readonly played: Set<string> }): JSX.Element {
  const { t } = useTranslation()
  const query = useQuery({ queryKey: ['analytics', 'paid-ltv'], queryFn: getPaidLtv, staleTime: 5 * 60_000 })
  const title = t('analyticsPage.retention.paidLtv.title')
  const report = query.data
  const rows = useMemo<Row[]>(
    () =>
      (report?.rows ?? []).map((row) => ({
        cohort: row.cohort,
        axis: monthAxis(row.cohort),
        heading: formatCohortMonth(row.cohort),
        clients: row.clients,
        mean: row.mean,
        median: row.median,
      })),
    [report],
  )
  return (
    <ChartCard
      id="retention-paid-ltv"
      title={title}
      icon={<TrendingUp className="size-4 text-muted-foreground" aria-hidden="true" />}
      info={t('analyticsPage.retention.paidLtv.info')}
      rule="money"
      description={t('analyticsPage.retention.paidLtv.description')}
      table={
        report === undefined || report.clients === 0 ? undefined : (
          <DataTable
            caption={title}
            columns={[
              { key: 'cohort', label: t('analyticsPage.retention.paidLtv.cohortColumn') },
              { key: 'clients', label: t('analyticsPage.retention.paidLtv.clientsColumn'), numeric: true },
              { key: 'mean', label: t('analyticsPage.retention.paidLtv.mean'), numeric: true },
              { key: 'median', label: t('analyticsPage.retention.paidLtv.median'), numeric: true },
            ]}
            rows={rows
              .filter((row) => row.clients > 0)
              .map((row) => ({
                key: row.cohort,
                cohort: row.heading,
                clients: formatCount(row.clients),
                mean: row.mean === null ? '—' : formatMoney(row.mean, report.money.currency),
                median: row.median === null ? '—' : formatMoney(row.median, report.money.currency),
              }))}
          />
        )
      }
    >
      <QueryBody query={query} height="h-64">
        {(data) =>
          data.clients === 0 ? (
            <EmptyState className="h-48">{t('analyticsPage.retention.paidLtv.empty')}</EmptyState>
          ) : (
            <PaidLtvBody report={data} rows={rows} played={played} />
          )
        }
      </QueryBody>
    </ChartCard>
  )
}

function PaidLtvBody({
  report,
  rows,
  played,
}: {
  readonly report: FirstPaymentLtvReport
  readonly rows: readonly Row[]
  readonly played: Set<string>
}): JSX.Element {
  const { t } = useTranslation()
  const chartRef = useRef<HTMLDivElement>(null)
  const entrance = useChartEntrance('retention.paid-ltv', played, chartRef)
  const currency = report.money.currency
  const money = (value: number | null): string => (value === null ? '—' : formatMoney(value, currency))
  const meanName = t('analyticsPage.retention.paidLtv.mean')
  const medianName = t('analyticsPage.retention.paidLtv.median')
  return (
    <div className="space-y-3">
      <MoneyNote money={report.money} />
      <dl className="flex flex-wrap gap-x-8 gap-y-2" data-paid-ltv-stats="">
        <div>
          <dt className="text-xs text-muted-foreground">{t('analyticsPage.retention.paidLtv.clients')}</dt>
          <dd className="text-lg font-semibold">{formatCount(report.clients)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{meanName}</dt>
          <dd className="text-lg font-semibold">{money(report.mean)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{medianName}</dt>
          <dd className="text-lg font-semibold">{money(report.median)}</dd>
        </div>
      </dl>
      <ChartLegend
        items={[
          { key: 'mean', label: meanName, color: ACCENT, shape: 'rect' },
          { key: 'median', label: medianName, color: MEDIAN_COLOR, shape: 'rect' },
        ]}
      />
      <div ref={chartRef} className="h-56" data-chart="retention-paid-ltv">
        {entrance.show && (
          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
            <BarChart data={rows as Row[]} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="18%">
              <CartesianGrid vertical={false} stroke={GRID_STROKE} />
              <XAxis dataKey="axis" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID_STROKE }} interval={0} minTickGap={4} />
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
                  const row = hoveredRow<Row>(props)
                  if (row === null || row.clients === 0) return null
                  return (
                    <TooltipCard
                      heading={row.heading}
                      rows={[
                        { key: 'mean', name: meanName, value: money(row.mean), color: ACCENT, shape: 'rect' },
                        { key: 'median', name: medianName, value: money(row.median), color: MEDIAN_COLOR, shape: 'rect' },
                      ]}
                      footer={t('analyticsPage.retention.paidLtv.clientsOfMonth', { count: row.clients })}
                    />
                  )
                }}
              />
              <Bar dataKey="mean" name={meanName} fill={ACCENT} radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={entrance.animate} animationDuration={SWEEP_MS} />
              <Bar dataKey="median" name={medianName} fill={MEDIAN_COLOR} radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={entrance.animate} animationDuration={SWEEP_MS} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
      <p className="text-xs text-muted-foreground" data-paid-ltv-footnote="">
        {t('analyticsPage.retention.paidLtv.footnote')}
      </p>
    </div>
  )
}
