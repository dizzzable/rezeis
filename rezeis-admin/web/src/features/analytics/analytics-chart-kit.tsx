/**
 * The components every chart of the analytics page is built from, so the page
 * reads as one system: the card and its table view, the tooltip, the legend,
 * stacked segments, ranked bars, the empty and loading states, the period
 * switch and the note that says which currency the money is in. How charts
 * enter and what their axes look like: `analytics-chart-support.ts`.
 */
import { type JSX, type ReactNode, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { Info, Table2, BarChart3 } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { InfoTip } from '@/components/ui/info-tip'
import { getPaymentGatewayIcon } from '@/features/payments/payment-gateway-icons'
import { cn } from '@/lib/utils'

import type { MoneyView } from './analytics-api'
import { ANALYTICS_PERIODS, type AnalyticsPeriodDays, type AnalyticsRule, SWEEP_MS, withRule } from './analytics-chart-support'
import { formatMoney, formatShortDate } from './analytics-format'
import { ACCENT } from './analytics-palette'

// ── Card ─────────────────────────────────────────────────────────────────────

export interface ChartCardProps {
  readonly title: string
  readonly description?: ReactNode
  /** An (i) beside the title: what the chart counts and how. */
  readonly info?: string
  /** The counting rule the card follows, appended to its (i). */
  readonly rule?: AnalyticsRule
  readonly icon?: ReactNode
  /** The chart's data as a table — its accessible twin, behind a toggle. */
  readonly table?: ReactNode
  readonly headerExtra?: ReactNode
  readonly className?: string
  readonly contentClassName?: string
  readonly children: ReactNode
  /** Marks the card for tests and styling. */
  readonly id?: string
}

/**
 * A chart's card. When `table` is given the header carries a switch between
 * the chart and a table of the same numbers — every value a tooltip shows is
 * then reachable without hovering.
 */
export function ChartCard({
  title,
  description,
  info,
  rule,
  icon,
  table,
  headerExtra,
  className,
  contentClassName,
  children,
  id,
}: ChartCardProps): JSX.Element {
  const { t } = useTranslation()
  const [asTable, setAsTable] = useState(false)
  const titleId = useId()
  return (
    <Card className={cn('flex min-w-0 flex-col', className)} data-analytics-card={id} data-analytics-rule={rule} aria-labelledby={titleId} role="region">
      <CardHeader className="gap-1 space-y-0 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            {icon}
            <CardTitle id={titleId} className="text-base leading-tight">
              {title}
            </CardTitle>
            {info !== undefined && (
              <InfoTip label={t('analyticsPage.common.aboutLabel', { title })}>{withRule(t, info, rule)}</InfoTip>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {headerExtra}
            {table !== undefined && (
              <button
                type="button"
                aria-pressed={asTable}
                onClick={() => setAsTable((value) => !value)}
                className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                {asTable ? <BarChart3 className="size-3.5" aria-hidden="true" /> : <Table2 className="size-3.5" aria-hidden="true" />}
                {asTable ? t('analyticsPage.common.showChart') : t('analyticsPage.common.showTable')}
              </button>
            )}
          </div>
        </div>
        {description !== undefined && <CardDescription className="text-xs">{description}</CardDescription>}
      </CardHeader>
      <CardContent className={cn('flex-1', contentClassName)}>{asTable && table !== undefined ? table : children}</CardContent>
    </Card>
  )
}

// ── States ───────────────────────────────────────────────────────────────────

/** A shimmer the size of what is coming, still for anyone who asked for stillness. */
export function ChartSkeleton({ className }: { readonly className?: string }): JSX.Element {
  return <div aria-hidden="true" className={cn('rounded-md bg-muted motion-safe:animate-pulse', className)} data-analytics-skeleton="" />
}

/** An honest "nothing here", at the height the chart would have had. */
export function EmptyState({ children, className }: { readonly children: ReactNode; readonly className?: string }): JSX.Element {
  return (
    <div className={cn('flex items-center justify-center px-4 text-center text-sm text-muted-foreground', className)} data-analytics-empty="">
      {children}
    </div>
  )
}

/** The card body while a query settles: data, else a skeleton, else why there is none. */
export function QueryBody<T>({
  query,
  height,
  children,
}: {
  readonly query: { readonly data: T | undefined; readonly isLoading: boolean; readonly isError: boolean }
  readonly height: string
  readonly children: (data: T) => ReactNode
}): JSX.Element {
  const { t } = useTranslation()
  if (query.data !== undefined) return <>{children(query.data)}</>
  if (query.isLoading) return <ChartSkeleton className={height} />
  return <EmptyState className={height}>{t(query.isError ? 'analyticsPage.common.unavailable' : 'analyticsPage.common.noData')}</EmptyState>
}

// ── Legend and tooltip ───────────────────────────────────────────────────────

export interface LegendItem {
  readonly key: string
  readonly label: string
  readonly color: string
  /** The mark it stands for: a filled rect for bars, a stroke for lines. */
  readonly shape: 'rect' | 'line' | 'ghost'
}

function Key({ color, shape }: { readonly color: string; readonly shape: LegendItem['shape'] }): JSX.Element {
  if (shape === 'rect') return <span aria-hidden="true" className="size-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: color }} />
  return (
    <span
      aria-hidden="true"
      className={cn('h-0.5 w-3.5 shrink-0 rounded-full', shape === 'ghost' && 'opacity-70')}
      style={{ backgroundColor: color }}
    />
  )
}

export function ChartLegend({ items, className }: { readonly items: readonly LegendItem[]; readonly className?: string }): JSX.Element {
  return (
    <ul className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground', className)} data-analytics-legend="">
      {items.map((item) => (
        <li key={item.key} className="flex items-center gap-1.5">
          <Key color={item.color} shape={item.shape} />
          <span>{item.label}</span>
        </li>
      ))}
    </ul>
  )
}

export interface TooltipRow {
  readonly key: string
  readonly name: string
  readonly value: string
  readonly color: string
  readonly shape: LegendItem['shape']
  /** A second line under the value, e.g. the native amount of a converted one. */
  readonly note?: string
}

/**
 * The card the pointer brings up: the bar's name, then every series at that
 * bar — the value strong, the series name beside it in secondary ink, keyed
 * by a short stroke of its colour. Text never wears the series colour.
 */
export function TooltipCard({ heading, rows, footer }: { readonly heading: string; readonly rows: readonly TooltipRow[]; readonly footer?: string }): JSX.Element {
  return (
    <div className="min-w-40 max-w-72 rounded-lg border bg-background px-3 py-2 text-xs shadow-md" data-analytics-tooltip="">
      <p className="mb-1.5 font-medium text-foreground">{heading}</p>
      <ul className="space-y-1">
        {rows.map((row) => (
          <li key={row.key} className="flex items-start gap-2">
            <span className="mt-1.5">
              <Key color={row.color} shape={row.shape} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-baseline justify-between gap-3">
                <span className="truncate text-muted-foreground">{row.name}</span>{' '}
                <span className="font-semibold tabular-nums text-foreground">{row.value}</span>
              </span>
              {row.note !== undefined && <span className="text-[11px] text-muted-foreground">{` ${row.note}`}</span>}
            </span>
          </li>
        ))}
      </ul>
      {footer !== undefined && <p className="mt-1.5 border-t pt-1.5 text-muted-foreground">{footer}</p>}
    </div>
  )
}

// ── Stacked bars ─────────────────────────────────────────────────────────────

/** What Recharts hands a bar's `shape`. */
export interface SegmentShapeProps {
  readonly x?: number
  readonly y?: number
  readonly width?: number
  readonly height?: number
  readonly fill?: string
  readonly payload?: unknown
}

/**
 * One segment of a stacked bar, as the page draws them: a 2 px gap of card
 * between it and the segment below (whitespace does the separating, not an
 * outline), and the 4 px rounded data end on whichever segment is on top in
 * THAT bar — with Recharts' `radius` only the last series is ever rounded,
 * so a bar whose last series is zero ends square.
 *
 * The gap comes off the bottom of the upper segment, so the top of the stack
 * still sits exactly at the bar's total.
 *
 * `order` is the stack's series, bottom first; `segment` is this one's.
 */
export function StackSegment({
  order,
  segment,
  x = 0,
  y = 0,
  width = 0,
  height = 0,
  fill,
  payload,
}: SegmentShapeProps & { readonly order: readonly string[]; readonly segment: string }): JSX.Element {
  const position = order.indexOf(segment)
  const row = (payload ?? {}) as Record<string, unknown>
  const filled = (name: string): boolean => Number(row[name] ?? 0) > 0
  const below = order.slice(0, position).some(filled)
  const above = order.slice(position + 1).some(filled)
  const drawn = height - (below ? 2 : 0)
  if (width <= 0 || drawn <= 0) return <g />
  const r = above ? 0 : Math.min(4, width / 2, drawn)
  const bottom = y + drawn
  const path =
    r === 0
      ? `M${x},${y}h${width}v${drawn}h${-width}Z`
      : `M${x},${bottom}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${bottom}Z`
  return <path d={path} fill={fill} data-stack-segment={segment} />
}

// ── Ranked bars ──────────────────────────────────────────────────────────────

export interface RankedBar {
  readonly key: string
  readonly label: string
  /** A logo before the label (a payment system's). */
  readonly icon?: ReactNode
  /** Muted text after the label, e.g. «23 платежа». */
  readonly detail?: string
  readonly value: number
  readonly valueText: string
  readonly shareText?: string
  readonly color?: string
}

/**
 * Horizontal bars, largest first, each with its name above and its value at
 * the tip — the value is always printed, so nothing here needs a tooltip. The
 * bars grow from one baseline, 10 px thick with a 4 px rounded end.
 */
export function RankedBars({
  rows,
  animate,
  className,
  limit,
}: {
  readonly rows: readonly RankedBar[]
  readonly animate: boolean
  readonly className?: string
  readonly limit?: number
}): JSX.Element {
  const shown = limit === undefined ? rows : rows.slice(0, limit)
  const max = Math.max(0, ...shown.map((row) => row.value))
  return (
    <ul className={cn('space-y-3', className)} data-analytics-ranked="">
      {shown.map((row, index) => {
        const width = max <= 0 ? 0 : Math.max(0.5, (row.value / max) * 100)
        return (
          <li key={row.key} className="space-y-1" data-ranked-row={row.key}>
            {/* The spaces between the spans are text, not only gaps: read aloud,
                «5» and «42 %» side by side would be «542 %». */}
            <div className="flex items-baseline justify-between gap-3 text-sm">
              {/* The name wraps rather than cuts: on a phone «Премиум · 3 у…» names nothing. */}
              <span className="flex min-w-0 items-center gap-1.5">
                {row.icon}
                <span className="min-w-0 break-words font-medium leading-tight">{row.label}</span>
                {row.detail !== undefined && <span className="shrink-0 text-xs text-muted-foreground">{` ${row.detail}`}</span>}
              </span>{' '}
              <span className="shrink-0 tabular-nums">
                <span className="font-medium">{row.valueText}</span>
                {row.shareText !== undefined && <span className="ml-1.5 text-xs text-muted-foreground">{` ${row.shareText}`}</span>}
              </span>
            </div>
            <div className="h-2.5" aria-hidden="true">
              {animate ? (
                <motion.div
                  className="h-full rounded-r-[4px]"
                  style={{ backgroundColor: row.color ?? ACCENT }}
                  initial={{ width: 0 }}
                  animate={{ width: `${width}%` }}
                  transition={{ duration: SWEEP_MS / 1000, delay: index * 0.04, ease: [0.16, 1, 0.3, 1] }}
                />
              ) : (
                <div className="h-full rounded-r-[4px]" style={{ width: `${width}%`, backgroundColor: row.color ?? ACCENT }} />
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

// ── Table view ───────────────────────────────────────────────────────────────

export interface TableColumn {
  readonly key: string
  readonly label: string
  readonly numeric?: boolean
}

/** The accessible twin of a chart: the same numbers, in rows. */
export function DataTable({
  caption,
  columns,
  rows,
}: {
  readonly caption: string
  readonly columns: readonly TableColumn[]
  readonly rows: ReadonlyArray<Readonly<Record<string, ReactNode>> & { readonly key: string }>
}): JSX.Element {
  return (
    <div className="max-h-80 overflow-auto">
      <table className="w-full text-xs" data-analytics-table="">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 bg-card text-muted-foreground">
          <tr className="border-b">
            {columns.map((column) => (
              <th key={column.key} scope="col" className={cn('px-2 py-1.5 font-medium', column.numeric ? 'text-right' : 'text-left')}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b last:border-0">
              {columns.map((column) => (
                <td key={column.key} className={cn('px-2 py-1.5', column.numeric && 'text-right tabular-nums')}>
                  {row[column.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── A payment system's logo ──────────────────────────────────────────────────

/**
 * The payment system's logo, or nothing for one without a logo.
 *
 * `getPaymentGatewayIcon` builds a new component function on every call, and
 * mounting that as `<Icon />` would remount the image on every re-render. The
 * function has no hooks and returns one `<img>`, so it is CALLED here, not
 * mounted: the element it returns is reconciled like any other.
 */
export function GatewayIcon({ gatewayType }: { readonly gatewayType: string }): JSX.Element | null {
  const draw = getPaymentGatewayIcon(gatewayType)
  return draw === null ? null : draw({ className: 'size-4 shrink-0' })
}

// ── The period switch ────────────────────────────────────────────────────────

/** «7 дней / 30 дней / 90 дней / Год», as a segmented control. */
export function PeriodSwitch({
  value,
  onChange,
  busy,
  animate,
}: {
  readonly value: number
  readonly onChange: (days: AnalyticsPeriodDays) => void
  readonly busy: boolean
  readonly animate: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const thumbId = useId()
  return (
    <div
      role="group"
      aria-label={t('analyticsPage.periods.label')}
      aria-busy={busy || undefined}
      className="inline-flex h-8 items-center rounded-md border bg-muted/50 p-0.5"
      data-analytics-periods=""
    >
      {ANALYTICS_PERIODS.map((days) => {
        const selected = days === value
        return (
          <button
            key={days}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(days)}
            className={cn(
              'relative h-7 whitespace-nowrap rounded-[5px] px-2.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:transition-colors',
              selected ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {selected ? (
              animate ? (
                <motion.span
                  layoutId={thumbId}
                  aria-hidden="true"
                  className="absolute inset-0 rounded-[5px] bg-background shadow-sm"
                  transition={{ type: 'spring', bounce: 0.15, duration: 0.35 }}
                />
              ) : (
                <span aria-hidden="true" className="absolute inset-0 rounded-[5px] bg-background shadow-sm" />
              )
            ) : null}
            <span className="relative">{days === 365 ? t('analyticsPage.periods.year') : t('analyticsPage.periods.days', { count: days })}</span>
          </button>
        )
      })}
    </div>
  )
}

// ── Which currency the money is in ──────────────────────────────────────────

/**
 * One line under a tab's header when the money is not all in one currency:
 * which rates converted what, as of when — and which currency had no rate and
 * is therefore left out of the totals (its amounts are still shown).
 */
/**
 * Said when the panel's time zone setting is empty or not a zone: the report
 * then counts UTC days, and an operator east or west of UTC would otherwise
 * read every bar a few hours off without being told.
 */
export function ZoneNote({ fallback }: { readonly fallback: boolean }): JSX.Element | null {
  const { t } = useTranslation()
  if (!fallback) return null
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground" data-analytics-zone-note="">
      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span>{t('analyticsPage.zone.fallback')}</span>
    </p>
  )
}

export function MoneyNote({ money }: { readonly money: MoneyView }): JSX.Element | null {
  const { t } = useTranslation()
  if (!money.converted && money.unconverted.length === 0) return null
  const oldest = money.rates.reduce<string | null>(
    (earliest, rate) => (earliest === null || rate.fetchedAt < earliest ? rate.fetchedAt : earliest),
    null,
  )
  const rates = money.rates
    .map((rate) => `1\xa0${rate.currency} = ${formatMoney(rate.rate, money.currency)}`)
    .join(' · ')
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground" data-analytics-money-note="">
      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span>
        {money.converted &&
          t('analyticsPage.money.converted', {
            currency: money.currency,
            date: oldest === null ? '—' : formatShortDate(oldest),
            rates,
          })}
        {money.converted && money.unconverted.length > 0 && ' '}
        {money.unconverted.length > 0 &&
          `${t('analyticsPage.money.unconverted', { count: money.unconverted.length, currencies: money.unconverted.join(', ') })} ${t('analyticsPage.money.whereToSetRate')}`}
      </span>
    </p>
  )
}
