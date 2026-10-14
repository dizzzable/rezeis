/**
 * «Когда платят»: a heatmap of payments by weekday and hour of the day, in the
 * panel's time zone, for the chosen period. Automatic charges are left out —
 * a machine picks their time — and the card says how many.
 *
 * A table, because it is one: every cell carries its count in its label, and
 * the colour only helps the eye find the busy hours. The shade is relative to
 * the busiest cell, mixed toward the card in both themes (`heatColor`). On a
 * phone the grid scrolls inside the card rather than widening the page.
 */
import { type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Clock } from 'lucide-react'

import { activeLocale } from '@/lib/utils'

import { getPaymentHours, type PaymentHoursReport } from './analytics-api'
import { ChartCard, EmptyState, QueryBody, ZoneNote } from './analytics-chart-kit'
import { formatCount } from './analytics-format'
import { heatColor } from './analytics-palette'

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const
const HOURS = Array.from({ length: 24 }, (_, hour) => hour)

/** `2026-01-05` was a Monday: the short name of ISO weekday `n` (1 = Monday). */
function weekdayName(isoWeekday: number, style: 'short' | 'long'): string {
  const day = new Date(Date.UTC(2026, 0, 4 + isoWeekday))
  return new Intl.DateTimeFormat(activeLocale(), { timeZone: 'UTC', weekday: style }).format(day)
}

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
}

export function PaymentHoursCard({ days }: { readonly days: number }): JSX.Element {
  const { t } = useTranslation()
  const query = useQuery({
    queryKey: ['analytics', 'payment-hours', days],
    queryFn: () => getPaymentHours(days),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  })
  const top = query.data?.topHours ?? []
  const description =
    top.length === 0
      ? t('analyticsPage.revenue.hours.description')
      : t('analyticsPage.revenue.hours.descriptionTop', {
          hours: new Intl.ListFormat(activeLocale(), { style: 'long', type: 'conjunction' }).format(top.map((entry) => hourLabel(entry.hour))),
        })
  return (
    <ChartCard
      id="revenue-hours"
      title={t('analyticsPage.revenue.hours.title')}
      icon={<Clock className="size-4 text-muted-foreground" aria-hidden="true" />}
      info={t('analyticsPage.revenue.hours.info')}
      description={description}
    >
      <QueryBody query={query} height="h-64">
        {(report) =>
          report.total === 0 ? (
            <div className="space-y-3">
              <ZoneNote fallback={report.timeZoneFallback} />
              <EmptyState className="h-40">{t('analyticsPage.revenue.hours.empty')}</EmptyState>
              <Footnote report={report} />
            </div>
          ) : (
            <HoursHeatmap report={report} />
          )
        }
      </QueryBody>
    </ChartCard>
  )
}

function Footnote({ report }: { readonly report: PaymentHoursReport }): JSX.Element {
  const { t } = useTranslation()
  return (
    <p className="text-xs text-muted-foreground" data-hours-footnote="">
      {t('analyticsPage.revenue.hours.footnote')}
      {report.automatic > 0 && ` ${t('analyticsPage.revenue.hours.automatic', { count: report.automatic })}`}
    </p>
  )
}

function HoursHeatmap({ report }: { readonly report: PaymentHoursReport }): JSX.Element {
  const { t } = useTranslation()
  const max = Math.max(0, ...report.cells)
  return (
    <div className="space-y-3" data-hours="">
      <ZoneNote fallback={report.timeZoneFallback} />
      {/* `relative`: the screen-reader labels are positioned boxes, and without a positioned scroll box they escape it. */}
      <div className="relative overflow-x-auto">
        <table className="border-separate border-spacing-0.5 text-[11px]" data-hours-table="">
          <caption className="sr-only">{t('analyticsPage.revenue.hours.title')}</caption>
          <thead>
            <tr className="text-muted-foreground">
              <th scope="col" className="pr-2 text-left font-medium">
                <span className="sr-only">{t('analyticsPage.revenue.hours.weekday')}</span>
              </th>
              {HOURS.map((hour) => (
                <th key={hour} scope="col" className="w-6 min-w-6 px-0 py-1 text-center font-medium tabular-nums">
                  <span className="sr-only">{hourLabel(hour)}</span>
                  <span aria-hidden="true">{hour}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {WEEKDAYS.map((weekday) => (
              <tr key={weekday} data-hours-weekday={weekday}>
                <th scope="row" className="whitespace-nowrap pr-2 text-left font-medium">
                  <span className="sr-only">{weekdayName(weekday, 'long')}</span>
                  <span aria-hidden="true">{weekdayName(weekday, 'short')}</span>
                </th>
                {HOURS.map((hour) => {
                  const count = report.cells[(weekday - 1) * 24 + hour] ?? 0
                  const label = t('analyticsPage.revenue.hours.cell', {
                    day: weekdayName(weekday, 'long'),
                    hour: hourLabel(hour),
                    count,
                  })
                  return (
                    <td
                      key={hour}
                      className="h-6 rounded-[3px]"
                      style={{ backgroundColor: heatColor(max === 0 ? 0 : count / max) }}
                      title={label}
                      data-hours-cell={`${weekday}-${hour}`}
                      data-count={count}
                    >
                      <span className="sr-only">{label}</span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" data-hours-scale="">
        <span>{t('analyticsPage.revenue.hours.scale')}</span>
        <span className="ml-auto flex items-center gap-2">
          <span>{formatCount(0)}</span>
          <span
            aria-hidden="true"
            className="h-2.5 w-28 rounded-[2px]"
            style={{ backgroundImage: `linear-gradient(to right, ${heatColor(0.000001)}, ${heatColor(1)})` }}
          />
          <span>{formatCount(max)}</span>
        </span>
      </div>
      <Footnote report={report} />
    </div>
  )
}
