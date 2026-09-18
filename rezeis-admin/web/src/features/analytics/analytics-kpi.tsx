/**
 * A KPI tile: the figure, its change against the previous window of the same
 * length, and a sparkline of both windows.
 *
 * The change is coloured by whether it is good news — up is good for revenue,
 * bad for churn — and always carries an arrow and a signed number, so it never
 * rests on colour alone. The sparkline is decoration for the eye (the number
 * and the change say it all) and is hidden from screen readers.
 */
import type { ComponentType, JSX, ReactNode, SVGProps } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'

import { Card } from '@/components/ui/card'
import { InfoTip } from '@/components/ui/info-tip'
import { cn } from '@/lib/utils'

import type { Delta } from './analytics-format'
import { type AnalyticsRule, withRule } from './analytics-chart-support'
import { ACCENT, GHOST } from './analytics-palette'

const TONE_CLASS: Readonly<Record<Delta['tone'], string>> = {
  good: 'text-emerald-700 dark:text-emerald-400',
  bad: 'text-destructive',
  neutral: 'text-muted-foreground',
}

export interface KpiTileProps {
  readonly label: string
  readonly info?: string
  /** The counting rule the figure follows, appended to its (i). */
  readonly rule?: AnalyticsRule
  readonly icon: ComponentType<SVGProps<SVGSVGElement>>
  /** The figure, formatted. `null` draws a dash (and `subtitle` says why). */
  readonly value: string | null
  /** Left out for a figure that has nothing to be compared with. */
  readonly delta?: Delta
  /** `points` for a rate: «+2,5 п. п.». */
  readonly deltaUnit?: 'percent' | 'points'
  /** «к предыдущим 30 дням». */
  readonly comparison?: string
  readonly subtitle?: ReactNode
  readonly current?: readonly (number | null)[]
  readonly previous?: readonly (number | null)[]
  /** `auto` for a stock that never nears zero (subscriptions in force). */
  readonly baseline?: 'zero' | 'auto'
  readonly id: string
}

export function KpiTile({
  label,
  info,
  rule,
  icon: Icon,
  value,
  delta,
  deltaUnit = 'percent',
  comparison,
  subtitle,
  current,
  previous,
  baseline = 'zero',
  id,
}: KpiTileProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <Card className="flex min-w-0 flex-col gap-1 p-4" data-kpi={id} data-kpi-rule={rule}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {/* Wraps rather than cuts: a label is never «Получили пробный пер…». */}
          <p className="text-sm font-medium leading-tight text-muted-foreground">{label}</p>
          {info !== undefined && <InfoTip label={t('analyticsPage.common.aboutLabel', { title: label })}>{withRule(t, info, rule)}</InfoTip>}
        </div>
        <Icon className="size-4 shrink-0 text-muted-foreground/70" aria-hidden="true" />
      </div>
      <p className="truncate text-2xl font-semibold leading-tight" data-kpi-value="">
        {value ?? '—'}
      </p>
      {delta !== undefined && <DeltaLine delta={delta} unit={deltaUnit} comparison={comparison ?? ''} />}
      {current !== undefined && (
        <Sparkline current={current} previous={previous} baseline={baseline} className="mt-1 h-8 w-full" />
      )}
      {subtitle !== undefined && <p className="text-xs text-muted-foreground">{subtitle}</p>}
    </Card>
  )
}

export function DeltaLine({
  delta,
  unit,
  comparison,
}: {
  readonly delta: Delta
  readonly unit: 'percent' | 'points'
  readonly comparison: string
}): JSX.Element {
  const { t } = useTranslation()
  const Arrow = delta.kind === 'up' || delta.kind === 'new' ? ArrowUpRight : delta.kind === 'down' ? ArrowDownRight : Minus
  let text: string
  switch (delta.kind) {
    case 'up':
    case 'down':
      text = unit === 'points' ? t('analyticsPage.delta.points', { value: delta.text }) : delta.text
      break
    case 'new':
      text = t('analyticsPage.delta.new')
      break
    case 'flat':
      text = t('analyticsPage.delta.flat')
      break
    default:
      text = t('analyticsPage.delta.none')
  }
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs" data-kpi-delta={delta.kind} data-kpi-tone={delta.tone}>
      <span className={cn('inline-flex items-center gap-0.5 font-medium', TONE_CLASS[delta.tone])}>
        {delta.kind !== 'none' && <Arrow className="size-3.5" aria-hidden="true" />}
        {text}
      </span>
      {/* A real space, not only the gap: read aloud, «+10 %к предыдущим» is one word. */}
      {delta.kind !== 'none' && <span className="text-muted-foreground">{` ${comparison}`}</span>}
    </p>
  )
}

/** A path through `values` on a 0–100 × 0–30 box; a gap where a value is missing. */
function sparkPath(values: readonly (number | null)[], length: number, low: number, high: number): string {
  const span = high - low || 1
  const step = length <= 1 ? 0 : 100 / (length - 1)
  let path = ''
  let drawing = false
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      drawing = false
      return
    }
    const x = index * step
    const y = 29 - ((value - low) / span) * 27
    path += `${drawing ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)} `
    drawing = true
  })
  return path.trim()
}

/**
 * Both windows on one scale: the current one in the accent, the previous one
 * as a faint grey line behind it, aligned bar for bar.
 */
export function Sparkline({
  current,
  previous,
  baseline,
  className,
}: {
  readonly current: readonly (number | null)[]
  readonly previous?: readonly (number | null)[]
  readonly baseline: 'zero' | 'auto'
  readonly className?: string
}): JSX.Element {
  const values = [...current, ...(previous ?? [])].filter((value): value is number => value !== null && Number.isFinite(value))
  const high = values.length === 0 ? 1 : Math.max(...values)
  const lowest = values.length === 0 ? 0 : Math.min(...values)
  const low = baseline === 'zero' ? Math.min(0, lowest) : lowest - (high - lowest) * 0.15
  const length = Math.max(current.length, previous?.length ?? 0)
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={className} aria-hidden="true" data-sparkline="">
      {previous !== undefined && (
        <path d={sparkPath(previous, length, low, high)} fill="none" stroke={GHOST} strokeOpacity={0.55} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" data-sparkline-previous="" />
      )}
      <path d={sparkPath(current, length, low, high)} fill="none" stroke={ACCENT} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" data-sparkline-current="" />
    </svg>
  )
}
