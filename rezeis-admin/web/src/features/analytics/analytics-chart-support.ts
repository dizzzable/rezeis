/**
 * What every chart of the analytics page shares besides its components: how it
 * enters, the look of its axes and bars, and small readers of Recharts' props.
 * The components themselves live in `analytics-chart-kit.tsx`.
 *
 * MOTION. A chart sweeps in the first time it comes into view during a visit
 * to the page, and never when the operator asked for stillness — the system's
 * reduced motion OR the panel's animations switch (`useSurfaceMotion`). A tab
 * switch or a period click is not an arrival: the page remembers what has
 * played, as it does for the usage rings.
 */
import { type RefObject, useEffect, useState } from 'react'

import type { MoneyView } from './analytics-api'
import { useFirstAppearance, useSurfaceMotion } from './surface-motion'

export interface ChartEntrance {
  /** Whether the chart may animate at all during this mount. */
  readonly animate: boolean
  /** Whether to draw it yet: at once when still, on first view when moving. */
  readonly show: boolean
}

/**
 * @param id Unique on the page — the key under which "has played" is kept.
 * @param played The page's memory of what has played during this visit.
 * @param target The chart's box: what "comes into view".
 */
export function useChartEntrance(id: string, played: Set<string>, target: RefObject<Element | null>): ChartEntrance {
  const motionAllowed = useSurfaceMotion()
  const [mayPlay] = useState(() => !played.has(id))
  const animate = motionAllowed && mayPlay
  const show = useFirstAppearance(target, animate)
  useEffect(() => {
    if (show) played.add(id)
  }, [show, played, id])
  return { animate, show }
}

/** Recharts' sweep, when a chart may move. */
export const SWEEP_MS = 700

/** Axis text in the muted ink, at the size of the page's small print. */
export const AXIS_TICK = { fontSize: 11, fill: 'var(--muted-foreground)' } as const
/** One hairline grid, solid, one step off the card. */
export const GRID_STROKE = 'var(--border)'
/** The band behind the bar under the pointer: a ghost wash. */
export const BAR_CURSOR = { fill: 'var(--muted)', opacity: 0.6 } as const
/** The crosshair of a line chart: a hairline at the hovered bar. */
export const LINE_CURSOR = { stroke: 'var(--border)', strokeWidth: 1 } as const
/** A data end rounded 4 px, square at the baseline. */
export const BAR_RADIUS: [number, number, number, number] = [4, 4, 0, 0]
/** Bars never fill their slot: 24 px at most, the rest is air. */
export const BAR_MAX = 24

/**
 * Room for a y-axis label: compact counts reach «1,4 тыс.» and compact money
 * «16,5 тыс. ₽». Narrower, Recharts clips them from the left («,4 тыс.») —
 * seen in the browser on the LTV histogram.
 */
export const COUNT_AXIS_WIDTH = 56
export const MONEY_AXIS_WIDTH = 68

/** What Recharts hands a tooltip's `content`. */
export interface RechartsTooltipProps {
  readonly active?: boolean
  readonly label?: unknown
  readonly payload?: ReadonlyArray<{ readonly payload?: unknown }>
}

/** The point Recharts is showing a tooltip for, as the chart's own row. */
export function hoveredRow<T>(props: RechartsTooltipProps): T | null {
  if (props.active !== true) return null
  const first = props.payload?.[0]?.payload
  return first === undefined || first === null ? null : (first as T)
}

/** «≈ » before a figure that includes money converted from another currency. */
export function approx(money: MoneyView, figureCurrencies: readonly string[]): string {
  return money.converted && figureCurrencies.some((currency) => currency !== money.currency) ? '≈\xa0' : ''
}

/**
 * Which of the page's two counting rules a figure follows, said as the last
 * paragraph of its (i): `money` — money received (completed, above zero, net
 * of refunds, not paid from a partner's balance); `subscriptions` —
 * subscriptions on paid plans, however they were paid.
 */
export type AnalyticsRule = 'money' | 'subscriptions'

/** An (i)'s text with the rule it follows as its last paragraph. */
export function withRule(t: (key: string) => string, info: string, rule: AnalyticsRule | undefined): string {
  return rule === undefined ? info : `${info}\n\n${t(`analyticsPage.rules.${rule}`)}`
}

export const ANALYTICS_PERIODS = [7, 30, 90, 365] as const
export type AnalyticsPeriodDays = (typeof ANALYTICS_PERIODS)[number]
