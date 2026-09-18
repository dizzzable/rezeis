/**
 * «Поверхности и устройства» — where and on what customers open the cabinet.
 *
 * Four panels, each a ring with its own legend and its own numbers beside it:
 * surface (Mini App / browser / PWA), device, OS, and the OS the installed app
 * runs on. The card this replaces floated three detached tiles in a band of
 * empty space and drew a single donut far off to the right.
 *
 * THE LAYOUT IS DECIDED BY WIDTH, NEVER BY CONTENT. Both the column count (on
 * the card) and where a legend sits (on the panel) are container queries, so
 * every panel of a row is laid out the same way: a legend that dropped under
 * its ring because ITS rows were long, while the neighbour's stayed beside,
 * left ~84 px of nothing under the neighbour.
 *
 * AND THE RING ABSORBS WHAT IS LEFT. Beside its legend, a panel is as tall as
 * the taller of the two — and the ring is 7rem, exactly the longest legend the
 * card can draw (the installs ring's seven OS buckets, a row each). So every
 * panel of a row is the ring's height, whether its legend has three rows or
 * seven, and a row has no gaps to explain. That is also why a legend never goes
 * under its ring while panels share a row: stacked, the two heights add, and a
 * three-row legend beside a seven-row one leaves four rows of nothing.
 *
 * Measured in Chromium against the compiled classes, ru and en, six-digit
 * counts and all six OS buckets, sidebar open (see the report): the card is
 * shorter than the block it replaces at every window width from 768 px up.
 */
import { type JSX, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Smartphone } from 'lucide-react'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { InfoTip } from '@/components/ui/info-tip'
import { activeLocale, cn } from '@/lib/utils'

import { getSurfaceAnalytics, type SurfaceCount, type UsageSurfaceReport } from './analytics-api'
import {
  SURFACE_STAGGER_MS,
  SURFACE_SWEEP_MS,
  useCountUp,
  useFirstAppearance,
  useSurfaceMotion,
  useSurfacePlayed,
} from './surface-motion'
import type { SurfaceDimension } from './surface-palette'
import { formatSurfaceShare, surfaceHoleTextClass, surfaceSlices, type SurfaceSlice } from './surface-slices'

/**
 * The four panels: one column, two from 37rem of card content, four from 75rem.
 * Those are the widths at which EVERY panel of the row is wide enough to hold
 * its legend beside its ring (18rem each, plus the 1rem gutters) — the card
 * never takes a column count that would push legends under rings, because that
 * is the arrangement whose height depends on how many rows a legend has, and
 * a row of a three-row legend beside a seven-row one is then 4 rows of nothing.
 */
export const SURFACE_PANEL_GRID = 'grid gap-x-4 gap-y-5 @min-[37rem]:grid-cols-2 @min-[75rem]:grid-cols-4'

/**
 * A panel spans two rows of that grid — heading, then ring — through a subgrid.
 * Its two halves carry the panel's container, not the panel itself: a query
 * container is size-contained, and a size-contained grid item is not allowed to
 * be a subgrid. Both halves are the panel's width, so `@…/panel` means the same
 * in either.
 *
 * The subgrid itself is what makes panels beside each other share one heading
 * height, so their rings start level. Where it is missing (Chrome 111–116 are
 * inside this app's build target) the rows are each panel's own: a heading that
 * wrapped then pushes its own ring down a line, which is untidy but not broken.
 */
export const SURFACE_PANEL = 'row-span-2 grid min-w-0 grid-rows-subgrid gap-y-2'

/**
 * Each half sits in a box that carries the panel's container: a query container
 * is size-contained, which a subgrid item may not be, and an element cannot ask
 * about a container it declares itself.
 */
export const SURFACE_PANEL_HALF = '@container/panel min-w-0'

/** Title and its numbers: side by side when the panel is wide, stacked when it is not. */
export const SURFACE_PANEL_HEADING =
  'flex flex-col gap-y-0.5 @min-[25rem]/panel:flex-row @min-[25rem]/panel:items-baseline @min-[25rem]/panel:gap-x-2'
export const SURFACE_TITLE_LINE = 'flex h-4 items-center gap-1.5'
export const SURFACE_NOTE_LINE = 'min-h-4'

/**
 * The ring's box: 7rem — the height of the longest legend a panel can show (the
 * seven OS buckets of the installs ring, at 1rem a row). Beside a legend, the
 * panel is as tall as the taller of the two, so a ring that matches the longest
 * legend leaves the shortest-legend panel of a row exactly as tall as the
 * fullest, and the row has no gaps to explain. In rem, so it follows the
 * operator's font size like the text beside it.
 */
export const SURFACE_RING_BOX = 'relative size-28 shrink-0'

/** One legend row, and the skeleton's lines, so the two stack alike. */
export const SURFACE_LEGEND_ROW_BOX = 'min-h-4'

/**
 * How many legend lines each skeleton panel draws: the rows the panel usually
 * ends up with, so the card arrives at the height the skeleton held.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const SURFACE_SKELETON_LEGEND_ROWS = { surface: 3, form: 3, os: 6, pwa: 6 } as const

/**
 * The ring and its legend: beside each other from 18rem of panel, stacked below
 * that — which only ever happens in a single column, where a panel has no
 * neighbour to be uneven with.
 *
 * 18rem is measured, not guessed: 7rem of ring, the 0.5rem gap, and 163 px for
 * the widest legend either language can draw without folding a row (six-digit
 * counts, «Не записана»/«Not recorded», «>99,9 %»).
 */
export const SURFACE_RING_ROW =
  'flex flex-col items-center gap-2 @min-[18rem]/panel:flex-row @min-[18rem]/panel:items-start @min-[18rem]/panel:gap-x-2'

/** Loading shimmer that stops for anyone who asked for stillness. */
const SHIMMER_MOTION = 'motion-safe:animate-pulse'
const SHIMMER = `bg-muted ${SHIMMER_MOTION}`

/**
 * Dimming the slices the pointer is not on, in CSS.
 *
 * NOT a prop on the sectors: Recharts derives a fresh animation id from the
 * Pie's props on every render and remounts its animator, so a re-render during
 * the sweep restarts it from nothing (`useAnimationId`, `SectorsWithAnimation`).
 * The chart element is therefore memoised and never re-rendered by hovering;
 * the ring's box carries `data-active-slice` and these rules do the dimming.
 * One literal per index, because Tailwind reads the source, not the runtime.
 */
const DIM_OTHER_SLICES = [
  'data-[active-slice="0"]:[&_.recharts-pie-sector:not(:nth-child(1))]:opacity-30',
  'data-[active-slice="1"]:[&_.recharts-pie-sector:not(:nth-child(2))]:opacity-30',
  'data-[active-slice="2"]:[&_.recharts-pie-sector:not(:nth-child(3))]:opacity-30',
  'data-[active-slice="3"]:[&_.recharts-pie-sector:not(:nth-child(4))]:opacity-30',
  'data-[active-slice="4"]:[&_.recharts-pie-sector:not(:nth-child(5))]:opacity-30',
  'data-[active-slice="5"]:[&_.recharts-pie-sector:not(:nth-child(6))]:opacity-30',
  'data-[active-slice="6"]:[&_.recharts-pie-sector:not(:nth-child(7))]:opacity-30',
  'data-[active-slice="7"]:[&_.recharts-pie-sector:not(:nth-child(8))]:opacity-30',
  '[&_.recharts-pie-sector]:motion-safe:transition-opacity',
].join(' ')

const SURFACE_TOOLTIP_STYLE = {
  borderRadius: '8px',
  border: '1px solid var(--border)',
  backgroundColor: 'var(--background)',
} as const
const SURFACE_TOOLTIP_ITEM_STYLE = { color: 'var(--foreground)' } as const

/**
 * Radii as shares of the box, and no chart margin, so the ring keeps its
 * thickness at every root font size and the grey track lies exactly where the
 * slices will.
 */
const RING_INNER = 0.7
const RING_OUTER = 0.96
const NO_MARGIN = { top: 0, right: 0, bottom: 0, left: 0 } as const

interface PanelSpec {
  readonly id: 'surface' | 'form' | 'os' | 'pwa'
  /** Which palette the panel's categories take: the two OS panels share one. */
  readonly dimension: SurfaceDimension
  readonly rows: (report: UsageSurfaceReport) => readonly SurfaceCount[]
  readonly titleKey: string
  readonly emptyKey: string
}

const PANELS: readonly PanelSpec[] = [
  {
    id: 'surface',
    dimension: 'surface',
    rows: (report) => report.surfaces,
    titleKey: 'analyticsPage.surfaces.panels.surface',
    emptyKey: 'analyticsPage.surfaces.empty',
  },
  {
    id: 'form',
    dimension: 'form',
    rows: (report) => report.formFactors,
    titleKey: 'analyticsPage.surfaces.panels.form',
    emptyKey: 'analyticsPage.surfaces.empty',
  },
  {
    id: 'os',
    dimension: 'os',
    rows: (report) => report.operatingSystems,
    titleKey: 'analyticsPage.surfaces.panels.os',
    emptyKey: 'analyticsPage.surfaces.empty',
  },
  {
    id: 'pwa',
    dimension: 'os',
    rows: (report) => report.pwaInstallsByOs,
    titleKey: 'analyticsPage.surfaces.panels.pwa',
    emptyKey: 'analyticsPage.surfaces.emptyInstalls',
  },
]

/**
 * @param played Which panels have already had their sweep during this visit to
 *   the page — the page owns it, because this card is rebuilt by things that are
 *   not arrivals (a period button, a tab). Left out, the card keeps its own.
 */
export function SurfaceUsageCard({ played }: { readonly played?: Set<string> } = {}): JSX.Element {
  const { t } = useTranslation()
  const motion = useSurfaceMotion()
  const playedPanels = useSurfacePlayed(played)
  const { data, isLoading, isError } = useQuery({
    queryKey: ['analytics', 'surfaces'],
    queryFn: getSurfaceAnalytics,
    staleTime: 60_000,
  })

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Smartphone className="h-4 w-4" aria-hidden="true" />
          {t('analyticsPage.surfaces.title')}
        </CardTitle>
        <InfoTip label={t('analyticsPage.surfaces.aboutLabel')}>{t('analyticsPage.surfaces.about')}</InfoTip>
      </CardHeader>
      <CardContent className="@container pb-5">
        {/* Data first: a refetch that fails in the background must not take the
            rings the operator is reading off the screen. */}
        {data !== undefined ? (
          <div className={SURFACE_PANEL_GRID}>
            {PANELS.map((panel, index) => (
              <SurfacePanel
                key={panel.id}
                spec={panel}
                report={data}
                order={index}
                motion={motion}
                played={playedPanels}
              />
            ))}
          </div>
        ) : isLoading ? (
          <div className={SURFACE_PANEL_GRID} aria-busy="true">
            {PANELS.map((panel) => (
              <SurfacePanelSkeleton key={panel.id} legendRows={SURFACE_SKELETON_LEGEND_ROWS[panel.id]} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t(isError ? 'analyticsPage.surfaces.unavailable' : 'analyticsPage.surfaces.empty')}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function SurfacePanel({
  spec,
  report,
  order,
  motion,
  played,
}: {
  readonly spec: PanelSpec
  readonly report: UsageSurfaceReport
  readonly order: number
  readonly motion: boolean
  readonly played: Set<string>
}): JSX.Element {
  const { t } = useTranslation()
  const titleId = useId()
  const panelRef = useRef<HTMLElement>(null)
  // Once per page visit: a period button rebuilds the tab around this card, and
  // a tab switch unmounts it — neither is a reason to play the sweep again.
  const [mayPlay] = useState(() => !played.has(spec.id))
  const animate = motion && mayPlay
  const started = useFirstAppearance(panelRef, animate)
  // Seen — whether it swept in or was drawn finished because the operator asked
  // for stillness, or because the page was printed.
  useEffect(() => {
    if (started) played.add(spec.id)
  }, [started, played, spec.id])
  const [activeKey, setActiveKey] = useState<string | null>(null)

  const locale = activeLocale()
  const translate = useCallback((key: string) => String(t(key)), [t])
  const rows = spec.rows(report)
  const slices = useMemo(() => surfaceSlices(spec.dimension, rows, translate), [spec.dimension, rows, translate])
  const total = slices.reduce((sum, slice) => sum + slice.count, 0)
  const delay = order * SURFACE_STAGGER_MS
  const activeIndex = slices.findIndex((slice) => slice.key === activeKey)
  const active = activeIndex === -1 ? null : (slices[activeIndex] as SurfaceSlice)

  const onSliceEnter = useCallback(
    (_: unknown, index: number) => setActiveKey(slices[index]?.key ?? null),
    [slices],
  )
  const onSliceLeave = useCallback(() => setActiveKey(null), [])

  /**
   * The chart, built once per set of slices. Nothing about hovering or counting
   * is in here: a new element would remount Recharts' animator and restart the
   * sweep from nothing, which is what made the ring sit empty while the numbers
   * counted.
   */
  const chart = useMemo(
    () =>
      slices.length === 0 ? null : (
        <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
          <PieChart margin={NO_MARGIN}>
            <Pie
              data={slices}
              dataKey="count"
              nameKey="name"
              startAngle={90}
              endAngle={-270}
              innerRadius={`${RING_INNER * 100}%`}
              outerRadius={`${RING_OUTER * 100}%`}
              paddingAngle={slices.length > 1 ? 2 : 0}
              cornerRadius={3}
              stroke="var(--card)"
              strokeWidth={2}
              isAnimationActive={animate}
              animationBegin={delay}
              animationDuration={SURFACE_SWEEP_MS}
              animationEasing="ease-out"
              onMouseEnter={onSliceEnter}
              onMouseLeave={onSliceLeave}
            >
              {slices.map((slice) => (
                <Cell key={slice.key} fill={slice.color} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={SURFACE_TOOLTIP_STYLE}
              // Text in the text colour: recharts paints the item in the slice's own
              // colour, and the pale ones are unreadable as text on a light card.
              itemStyle={SURFACE_TOOLTIP_ITEM_STYLE}
              wrapperStyle={{ zIndex: 30 }}
              allowEscapeViewBox={{ x: true, y: true }}
              isAnimationActive={animate}
              // The count alone, so the slice keeps its name: `[value, '']` printed " : 12".
              formatter={(value) => Number(value ?? 0).toLocaleString(locale)}
            />
          </PieChart>
        </ResponsiveContainer>
      ),
    [slices, animate, delay, locale, onSliceEnter, onSliceLeave],
  )

  return (
    <section ref={panelRef} aria-labelledby={titleId} data-surface-panel={spec.id} className={SURFACE_PANEL}>
      <div className={SURFACE_PANEL_HALF}>
        <div className={SURFACE_PANEL_HEADING} data-surface-heading="">
          <div className={SURFACE_TITLE_LINE}>
            <h3 id={titleId} className="text-sm font-semibold leading-none">
              {t(spec.titleKey)}
            </h3>
            {spec.id === 'pwa' && (
              <InfoTip label={t('analyticsPage.surfaces.pwaAboutLabel')} align="end">
                {t('analyticsPage.surfaces.pwaAbout')}
              </InfoTip>
            )}
          </div>
          <div
            className={cn(
              SURFACE_NOTE_LINE,
              'flex flex-wrap items-baseline gap-x-3 text-xs leading-4 text-muted-foreground',
            )}
          >
            {spec.id === 'surface' ? (
              <>
                <PanelStat label={t('analyticsPage.surfaces.tracked')} value={report.totalTracked} animate={animate} started={started} delay={delay} />
                <PanelStat label={t('analyticsPage.surfaces.active30d')} value={report.activeLast30d} animate={animate} started={started} delay={delay} />
              </>
            ) : spec.id === 'pwa' ? (
              <PanelStat label={t('analyticsPage.surfaces.pwaInstalls')} value={report.pwaInstalls} animate={animate} started={started} delay={delay} />
            ) : (
              <span>{t('analyticsPage.surfaces.lastVisit')}</span>
            )}
          </div>
        </div>
      </div>

      <div className={SURFACE_PANEL_HALF}>
        <div className={SURFACE_RING_ROW}>
          <div
            className={cn(SURFACE_RING_BOX, DIM_OTHER_SLICES)}
            data-surface-ring=""
            data-active-slice={active === null ? undefined : activeIndex}
          >
            {/* The track stays under the slices: the box is never empty — not
                while the panel waits to be seen, not while the ring sweeps in. */}
            <RingTrack />
            {!animate || started ? chart : null}
            <RingHole
              total={total}
              active={active}
              animate={animate}
              started={started}
              delay={delay}
              locale={locale}
            />
          </div>

          {slices.length === 0 ? (
            <p className="min-w-0 grow self-center text-xs leading-4 text-muted-foreground">{t(spec.emptyKey)}</p>
          ) : (
            <ul className="grid w-full grid-cols-[auto_minmax(min-content,1fr)_auto_auto] items-center gap-x-1.5 text-xs leading-4 @min-[18rem]/panel:w-max @min-[18rem]/panel:max-w-full @min-[18rem]/panel:self-center">
              {slices.map((slice, index) => (
                <LegendRow
                  key={slice.key}
                  slice={slice}
                  total={total}
                  locale={locale}
                  active={active}
                  animate={animate}
                  started={started}
                  delay={delay + index * 60}
                  onEnter={() => setActiveKey(slice.key)}
                  onLeave={() => setActiveKey(null)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  )
}

/**
 * The number in the ring, counting up — in its own component, so a frame of the
 * count re-renders this span and nothing else. In the panel it would re-render
 * the chart 60 times a second; inside what the hover swaps it would start over
 * every time the pointer left a slice.
 */
function RingHole({
  total,
  active,
  animate,
  started,
  delay,
  locale,
}: {
  readonly total: number
  readonly active: SurfaceSlice | null
  readonly animate: boolean
  readonly started: boolean
  readonly delay: number
  readonly locale: string
}): JSX.Element {
  const shown = useCountUp(total, animate, started, delay)
  const final = total.toLocaleString(locale)
  return (
    <div
      aria-hidden="true"
      data-surface-ring-hole=""
      className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-0.5"
    >
      {active === null ? (
        <span className={cn(surfaceHoleTextClass(final), 'font-semibold tabular-nums', total === 0 && 'text-muted-foreground')}>
          {animate && shown !== total ? shown.toLocaleString(locale) : final}
        </span>
      ) : (
        <>
          <span className="size-1.5 rounded-full" style={{ backgroundColor: active.color }} />
          <span className="text-sm font-semibold tabular-nums">{formatSurfaceShare(active.count, total, locale)}</span>
        </>
      )}
    </div>
  )
}

function LegendRow({
  slice,
  total,
  locale,
  active,
  animate,
  started,
  delay,
  onEnter,
  onLeave,
}: {
  readonly slice: SurfaceSlice
  readonly total: number
  readonly locale: string
  readonly active: SurfaceSlice | null
  readonly animate: boolean
  readonly started: boolean
  readonly delay: number
  readonly onEnter: () => void
  readonly onLeave: () => void
}): JSX.Element {
  const highlighted = active !== null && active.key === slice.key
  const entering = animate && started
  return (
    <li
      data-surface-legend-row={slice.key}
      data-highlighted={highlighted ? '' : undefined}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      className={cn(
        SURFACE_LEGEND_ROW_BOX,
        'col-span-4 grid grid-cols-subgrid items-center rounded-sm',
        // Chrome 111–116 drop `subgrid`, and a row without columns of its own
        // stacks its four cells into four lines. Its own columns then: the
        // counts no longer line up between rows, and every row is still a row.
        'not-supports-[grid-template-columns:subgrid]:grid-cols-[auto_minmax(0,1fr)_auto_auto]',
        'motion-safe:transition-[opacity,background-color] motion-safe:duration-150',
        highlighted && 'bg-muted',
        active !== null && !highlighted && 'opacity-50',
        animate && !started && 'opacity-0',
        entering &&
          'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-left-1 motion-safe:animation-duration-500 motion-safe:fill-mode-both',
      )}
      style={entering ? { animationDelay: `${delay}ms` } : undefined}
    >
      <span className="size-2 rounded-full" style={{ backgroundColor: slice.color }} aria-hidden="true" />
      <span className="min-w-0 break-words text-muted-foreground">{slice.name}</span>
      <AnimatedCount
        value={slice.count}
        animate={animate}
        started={started}
        delay={delay}
        locale={locale}
        className="pl-1.5 text-right font-medium tabular-nums"
      />
      <span className="pl-1 text-right tabular-nums text-muted-foreground">
        {formatSurfaceShare(slice.count, total, locale)}
      </span>
    </li>
  )
}

function PanelStat({
  label,
  value,
  animate,
  started,
  delay,
}: {
  readonly label: string
  readonly value: number
  readonly animate: boolean
  readonly started: boolean
  readonly delay: number
}): JSX.Element {
  return (
    <span className="whitespace-nowrap">
      {label}{' '}
      <AnimatedCount
        value={value}
        animate={animate}
        started={started}
        delay={delay}
        locale={activeLocale()}
        className="font-semibold tabular-nums text-foreground"
      />
    </span>
  )
}

/**
 * A number on its way up, and the number it ends on.
 *
 * WHILE IT COUNTS THERE ARE TWO: the counted one, `aria-hidden`, and the final
 * one for a screen reader — and for a printer. A page printed before the panel
 * had ever been on screen read «С телеметрией 0» beside shares that were real,
 * because the count starts at zero and waits to be seen. (The card also stops
 * animating the moment the browser says it is printing; see `useSurfaceMotion`.)
 *
 * Once the count has arrived there is one again, so that selecting the number
 * on the page copies «270 539» and not «270 539270 539».
 */
function AnimatedCount({
  value,
  animate,
  started,
  delay,
  locale,
  className,
}: {
  readonly value: number
  readonly animate: boolean
  readonly started: boolean
  readonly delay: number
  readonly locale: string
  readonly className?: string
}): JSX.Element {
  const shown = useCountUp(value, animate, started, delay)
  const final = value.toLocaleString(locale)
  if (!animate || shown === value) return <span className={className}>{final}</span>
  return (
    <span className={className} data-counting="">
      <span aria-hidden="true">{shown.toLocaleString(locale)}</span>
      <span className="sr-only">{final}</span>
    </span>
  )
}

/** The ring's grey track: under the slices always, and all an empty panel draws. */
function RingTrack({ className }: { readonly className?: string }): JSX.Element {
  const radius = ((RING_INNER + RING_OUTER) / 2) * 56
  const width = (RING_OUTER - RING_INNER) * 56
  return (
    <svg
      viewBox="0 0 112 112"
      className={cn('absolute inset-0 size-full', className)}
      aria-hidden="true"
      data-surface-ring-track=""
    >
      <circle cx="56" cy="56" r={radius} fill="none" stroke="var(--muted)" strokeWidth={width} />
    </svg>
  )
}

function SurfacePanelSkeleton({ legendRows }: { readonly legendRows: number }): JSX.Element {
  return (
    <div className={SURFACE_PANEL} aria-hidden="true" data-surface-panel-skeleton="">
      <div className={SURFACE_PANEL_HALF}>
        <div className={SURFACE_PANEL_HEADING} data-surface-heading="">
          <div className={SURFACE_TITLE_LINE}>
            <div className={cn('h-3.5 w-24 rounded', SHIMMER)} />
          </div>
          <div className={cn(SURFACE_NOTE_LINE, 'flex items-center')}>
            <div className={cn('h-3 w-32 max-w-full rounded', SHIMMER)} />
          </div>
        </div>
      </div>
      <div className={SURFACE_PANEL_HALF}>
        <div className={SURFACE_RING_ROW}>
          <div className={SURFACE_RING_BOX} data-surface-ring="">
            <RingTrack className={SHIMMER_MOTION} />
          </div>
          <div className="flex min-w-0 grow flex-col self-center" data-surface-skeleton-legend="">
            {Array.from({ length: legendRows }, (_, line) => (
              <div key={line} className={cn(SURFACE_LEGEND_ROW_BOX, 'flex items-center')}>
                <div className={cn('h-2.5 w-full max-w-40 rounded', SHIMMER)} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
