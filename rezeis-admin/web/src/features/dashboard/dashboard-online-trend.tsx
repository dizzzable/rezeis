/**
 * «Онлайн пользователей» — who is online over 24 hours or 7 days, and, behind
 * the globe button, on which node and in which country (owner's design,
 * 18.09.2026).
 *
 * THE HEADER NAMES THREE NUMBERS, EACH FROM WHERE IT IS TRUE:
 *   • «Сейчас» — Remnawave's own online-now; when Remnawave does not answer,
 *     the newest stored sample, saying when it was taken.
 *   • «Пик» — the highest stored sample of the window, and when.
 *   • «Уникальных» — Remnawave's `lastDay` / `lastWeek`: people seen online at
 *     any moment of the window. Only Remnawave knows it; without Remnawave the
 *     card says so rather than printing a 0.
 * The server caches Remnawave's answer for two minutes, so the refetch below
 * does not reach Remnawave every minute.
 *
 * THE LABELS FOLLOW THE NUMBERS, NOT THE BUTTON. Switching the window keeps the
 * previous window's answer on screen until the new one arrives, and while it is
 * there it is labelled as what it is — «Пик за 24 ч» under a pressed «7 дней»
 * for the moment it takes, never a 24-hour peak called a weekly one.
 *
 * MOTION — the chart drawing in, the numbers counting, the sides of the card
 * turning, the bars growing — runs only when `useSurfaceMotion` allows it: not
 * under the system's reduce-motion, not with the panel's animations switched
 * off, not while printing.
 *
 * Without `remnawave:view` the card neither asks nor renders: its routes sit
 * behind that permission and the admin client has no global 403 handler, so an
 * unguarded query used to fail and the card then claimed "no data collected
 * yet" to an operator who simply may not see it.
 */
import { type JSX, type ReactNode, Suspense, useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
  type DotItemDotProps,
} from 'recharts'
import { Activity, Globe } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useCountUp, useSurfaceMotion } from '@/features/analytics/surface-motion'
import { usePermissionStore } from '@/features/rbac/use-permission-store'
import { lazyWithChunkRecovery as lazy } from '@/lib/lazy-chunk'
import { activeLocale, cn } from '@/lib/utils'

import { dashboardApi, onlineCardKeys, ONLINE_RANGES, type OnlineOverview, type OnlineRange } from './dashboard-api'
import {
  axisTicks,
  describeMoment,
  formatAxisTick,
  formatCount,
  formatPointLabel,
  ONLINE_COLOR,
  ONLINE_REFETCH_MS,
  readOnlineCardPreference,
  writeOnlineCardPreference,
  type OnlineCardPreference,
  type OnlineCardView,
} from './dashboard-online-model'
import { useAnswerFreshness } from './dashboard-online-freshness'
import { OnlineNotice, OnlineStaleNotice } from './dashboard-online-notice'

/**
 * «Ноды и страны» is a chunk of its own: it carries every country's flag
 * (`remnawave-flags.tsx` inlines them all, ~180 KB), and most visits to the
 * dashboard never turn the card over. Hovering or focusing the globe starts the
 * download, so the click usually finds it already here.
 */
const loadDistribution = () => import('./dashboard-online-distribution')
const DashboardOnlineDistribution = lazy(() =>
  loadDistribution().then((module) => ({ default: module.DashboardOnlineDistribution })),
)
function preloadDistribution(): void {
  // Only an early start of the same request; a failure is left to the lazy load, which recovers.
  void loadDistribution().catch(() => undefined)
}

const TOOLTIP_STYLE = {
  borderRadius: '8px',
  border: '1px solid var(--border)',
  backgroundColor: 'var(--background)',
  fontSize: '12px',
} as const
const TOOLTIP_ITEM_STYLE = { color: 'var(--foreground)' } as const
const CHART_MARGIN = { top: 8, right: 8, left: 0, bottom: 0 } as const
const SWEEP_MS = 900
const EASE_OUT = [0.16, 1, 0.3, 1] as const

export function DashboardOnlineTrend(): JSX.Element | null {
  const { t } = useTranslation()
  // A boolean selector, so the card appears the moment permissions load.
  const canView = usePermissionStore((s) => s.hasPermission('remnawave', 'view'))
  const animate = useSurfaceMotion()
  const [preference, setPreference] = useState<OnlineCardPreference>(readOnlineCardPreference)
  const { range, view } = preference

  useEffect(() => {
    writeOnlineCardPreference(preference)
  }, [preference])

  const overview = useQuery({
    queryKey: onlineCardKeys.overview(range),
    queryFn: () => dashboardApi.getOnlineOverview(range),
    enabled: canView,
    refetchInterval: ONLINE_REFETCH_MS,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  })
  const freshness = useAnswerFreshness(overview)

  if (!canView) return null

  const setRange = (next: OnlineRange): void => setPreference((current) => ({ ...current, range: next }))
  const toggleView = (): void =>
    setPreference((current) => ({ ...current, view: current.view === 'chart' ? 'distribution' : 'chart' }))

  // THE CHART FILLS THE CARD'S HALF OF THE ROW, UP TO 32rem. This card shares
  // a grid row with the subscription card, which is the taller of the two
  // wherever they sit side by side, and the row stretches both. The chart takes
  // the height the row gives the card below its header, never less than 12rem,
  // so nothing outside the card moves, and a card the row does not stretch (one
  // column, below `xl`) keeps the 12rem chart it always had. The ceiling is for
  // the windows where the subscription card still grows tall: there the chart
  // stops at 32rem and sits in the middle of the card. See
  // `dashboard-online-trend-layout.test.tsx` for the measurements.
  return (
    <Card className="flex flex-col" data-online-card="">
      <CardHeader className="gap-4 space-y-0">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-4 w-4" aria-hidden="true" />
            {t('dashboardPage.onlineTrend.title')}
          </CardTitle>
          <div className="flex items-center gap-1.5">
            <RangeSwitch value={range} busy={overview.isPlaceholderData} animate={animate} onChange={setRange} />
            <ViewToggle view={view} animate={animate} onToggle={toggleView} />
          </div>
        </div>
        <Figures query={overview} selectedRange={range} stale={freshness.stale} animate={animate} />
        {freshness.stale ? (
          <OnlineStaleNotice
            message={t('dashboardPage.onlineTrend.staleAnswer', {
              when: describeMoment(new Date(freshness.receivedAt).toISOString(), freshness.now, t),
            })}
            retryLabel={t('dashboardPage.onlineTrend.retry')}
            retrying={overview.isFetching}
            onRetry={() => void overview.refetch()}
          />
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-center">
        <ViewFrame view={view} animate={animate}>
          {view === 'chart' ? (
            <ChartSide query={overview} stale={freshness.stale} animate={animate} />
          ) : (
            <Suspense fallback={<Skeleton className="min-h-48 w-full" />}>
              <DashboardOnlineDistribution range={range} animate={animate} />
            </Suspense>
          )}
        </ViewFrame>
      </CardContent>
    </Card>
  )
}

/** «24 ч | 7 дней»: two pressed-state buttons, the pressed one under a thumb that slides between them. */
function RangeSwitch({
  value,
  busy,
  animate,
  onChange,
}: {
  readonly value: OnlineRange
  readonly busy: boolean
  readonly animate: boolean
  readonly onChange: (range: OnlineRange) => void
}): JSX.Element {
  const { t } = useTranslation()
  const thumbId = useId()
  return (
    <div
      role="group"
      aria-label={t('dashboardPage.onlineTrend.rangeLabel')}
      aria-busy={busy || undefined}
      className="inline-flex h-8 items-center rounded-md border bg-muted/50 p-0.5"
    >
      {ONLINE_RANGES.map((option) => {
        const selected = option === value
        return (
          <button
            key={option}
            type="button"
            aria-pressed={selected}
            data-range={option}
            onClick={() => onChange(option)}
            className={cn(
              'relative h-7 rounded-[5px] px-2.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:transition-colors',
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
            <span className="relative">{t(`dashboardPage.onlineTrend.range.${option}`)}</span>
          </button>
        )
      })}
    </div>
  )
}

/** The globe: a toggle between the chart and «Ноды и страны». Its name stays put; `aria-pressed` says which side is up. */
function ViewToggle({
  view,
  animate,
  onToggle,
}: {
  readonly view: OnlineCardView
  readonly animate: boolean
  readonly onToggle: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const pressed = view === 'distribution'
  return (
    // Its own provider, as `InfoTip` has: a card rendered outside the shell
    // (a test, a story) must not throw for want of one.
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant={pressed ? 'secondary' : 'ghost'}
            size="icon"
            className="size-8"
            aria-pressed={pressed}
            aria-label={t('dashboardPage.onlineTrend.toggle.label')}
            onClick={onToggle}
            onPointerEnter={preloadDistribution}
            onFocus={preloadDistribution}
          >
            <Globe
              aria-hidden="true"
              className={cn(
                animate && 'motion-safe:transition-transform motion-safe:duration-500',
                pressed && 'rotate-180 text-primary',
              )}
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {pressed ? t('dashboardPage.onlineTrend.toggle.showChart') : t('dashboardPage.onlineTrend.toggle.showDistribution')}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** Swaps the two sides: a short fade and lift when motion is allowed, an instant swap when it is not. */
function ViewFrame({
  view,
  animate,
  children,
}: {
  readonly view: OnlineCardView
  readonly animate: boolean
  readonly children: ReactNode
}): JSX.Element {
  const frame = 'flex flex-1 flex-col justify-center'
  if (!animate) {
    return (
      <div className={frame} data-online-view={view}>
        {children}
      </div>
    )
  }
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={view}
        className={frame}
        data-online-view={view}
        initial={{ opacity: 0, y: 8, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -8, scale: 0.985 }}
        transition={{ duration: 0.22, ease: EASE_OUT }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  )
}

/** The three numbers under the title. */
function Figures({
  query,
  selectedRange,
  stale,
  animate,
}: {
  readonly query: UseQueryResult<OnlineOverview>
  /** Names the figures only until the first answer; from then on its own window does. */
  readonly selectedRange: OnlineRange
  /** The answer on screen is not a current one (see `useAnswerFreshness`). */
  readonly stale: boolean
  readonly animate: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const overview = query.data
  if (overview === undefined) {
    const labels = [
      t('dashboardPage.onlineTrend.now'),
      t(`dashboardPage.onlineTrend.peak.${selectedRange}`),
      t(`dashboardPage.onlineTrend.unique.${selectedRange}`),
    ]
    return (
      <dl className="grid grid-cols-3 gap-x-3 gap-y-1" aria-busy={query.isPending || undefined}>
        {labels.map((label) => (
          <Figure
            key={label}
            label={label}
            value={null}
            caption={query.isPending ? null : t('dashboardPage.onlineTrend.noValue')}
            loading={query.isPending}
            animate={animate}
          />
        ))}
      </dl>
    )
  }

  // The server's clock at the answer: «today» and «yesterday» are judged by it —
  // not by the browser's, which may be off, and not by the query's fetch time,
  // which is 0 while the previous window's answer stands in for the new one.
  const answeredAt = Date.parse(overview.generatedAt)
  const range = overview.range
  const live = overview.live
  const latest = overview.latestSample
  const now =
    live !== null
      ? { value: live.onlineNow, caption: null, state: stale ? ('stale' as const) : ('live' as const) }
      : latest !== null
        ? {
            value: latest.onlineNow,
            caption: t('dashboardPage.onlineTrend.nowFromSample', { when: describeMoment(latest.at, answeredAt, t) }),
            state: 'sample' as const,
          }
        : { value: null, caption: t('dashboardPage.onlineTrend.noValue'), state: 'none' as const }

  return (
    <dl className="grid grid-cols-3 gap-x-3 gap-y-1" data-stale={stale ? 'true' : undefined}>
      <Figure
        label={t('dashboardPage.onlineTrend.now')}
        indicator={<LiveDot state={now.state} animate={animate} />}
        value={now.value}
        caption={now.caption}
        tone={now.state === 'live' || now.state === 'stale' ? 'plain' : 'warning'}
        dimmed={stale}
        animate={animate}
      />
      <Figure
        label={t(`dashboardPage.onlineTrend.peak.${range}`)}
        value={overview.peak?.value ?? null}
        caption={
          overview.peak === null
            ? t('dashboardPage.onlineTrend.noValue')
            : describeMoment(overview.peak.at, answeredAt, t)
        }
        dimmed={stale}
        animate={animate}
      />
      <Figure
        label={t(`dashboardPage.onlineTrend.unique.${range}`)}
        value={live?.uniqueUsers ?? null}
        caption={live === null ? t('dashboardPage.onlineTrend.remnawaveSilent') : null}
        tone={live === null ? 'warning' : 'plain'}
        dimmed={stale}
        animate={animate}
      />
    </dl>
  )
}

function Figure({
  label,
  indicator,
  value,
  caption,
  tone = 'plain',
  loading = false,
  dimmed = false,
  animate,
}: {
  readonly label: string
  readonly indicator?: ReactNode
  readonly value: number | null
  readonly caption: string | null
  readonly tone?: 'plain' | 'warning'
  readonly loading?: boolean
  /** An answer that is not current: still readable, visibly not live. */
  readonly dimmed?: boolean
  readonly animate: boolean
}): JSX.Element {
  // A subgrid of the three rows, so a label that wraps on a narrow card («Уникальных
  // за сутки» on a phone) moves all three numbers down together, not one of them.
  return (
    <div className="row-span-3 grid min-w-0 grid-rows-subgrid" data-online-figure="">
      <dt className="flex min-w-0 items-start gap-1.5 text-xs leading-4 text-muted-foreground">
        {indicator}
        <span className="line-clamp-2">{label}</span>
      </dt>
      <dd className={cn('text-xl font-semibold leading-7 tabular-nums', dimmed && 'text-muted-foreground')}>
        {loading ? <Skeleton className="h-6 w-16" /> : value === null ? '—' : <Counted value={value} animate={animate} />}
      </dd>
      <dd
        className={cn(
          'min-h-4 line-clamp-2 text-xs leading-4',
          tone === 'warning' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
        )}
      >
        {caption}
      </dd>
    </div>
  )
}

/** A number that counts to its value — up from zero when it first appears, from where it stood when it changes. */
function Counted({ value, animate }: { readonly value: number; readonly animate: boolean }): JSX.Element {
  const shown = useCountUp(value, animate, true, 0)
  return <>{formatCount(shown)}</>
}

/**
 * Green: Remnawave's own number, current. Amber: a stored reading stands in for
 * it. Grey: neither — or an answer that has stopped refreshing, never green.
 */
function LiveDot({
  state,
  animate,
}: {
  readonly state: 'live' | 'sample' | 'none' | 'stale'
  readonly animate: boolean
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-live-dot={state}
      className={cn(
        'mt-[5px] inline-block size-1.5 shrink-0 rounded-full',
        state === 'live' ? 'bg-emerald-500' : state === 'sample' ? 'bg-amber-500' : 'bg-muted-foreground/40',
        state === 'live' && animate && 'motion-safe:animate-pulse',
      )}
    />
  )
}

/** The chart side: loading, failed, nothing measured, or the chart. */
function ChartSide({
  query,
  stale,
  animate,
}: {
  readonly query: UseQueryResult<OnlineOverview>
  readonly stale: boolean
  readonly animate: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const overview = query.data
  if (overview === undefined) {
    return query.isError ? (
      <OnlineNotice
        tone="error"
        title={t('dashboardPage.onlineTrend.loadFailed')}
        action={t('dashboardPage.onlineTrend.retry')}
        onAction={() => void query.refetch()}
      />
    ) : (
      <Skeleton className="h-full min-h-48 max-h-128 w-full" />
    )
  }
  if (overview.sampleCount === 0) {
    return (
      <OnlineNotice
        tone="empty"
        title={t(`dashboardPage.onlineTrend.empty.${overview.range}`)}
        hint={t('dashboardPage.onlineTrend.empty.hint')}
      />
    )
  }
  return <OnlineChart overview={overview} animate={animate} dimmed={query.isPlaceholderData || stale} />
}

interface ChartRow {
  readonly at: number
  readonly online: number | null
}

function OnlineChart({
  overview,
  animate,
  dimmed,
}: {
  readonly overview: OnlineOverview
  readonly animate: boolean
  readonly dimmed: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const locale = activeLocale()
  // `useId` spells ids with characters a `url(#…)` reference does not take.
  const gradientId = `online-fill-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const range = overview.range

  const rows = useMemo<ChartRow[]>(
    () => overview.points.map((point) => ({ at: Date.parse(point.time), online: point.onlineNow })),
    [overview.points],
  )
  const start = rows[0]?.at ?? 0
  const end = rows[rows.length - 1]?.at ?? 0
  const ticks = useMemo(() => axisTicks(range, start, end), [range, start, end])

  // The highest point — the LATEST, if the peak was reached twice.
  const top = useMemo(() => {
    let best: ChartRow | null = null
    for (const row of rows) if (row.online !== null && (best === null || row.online >= (best.online ?? 0))) best = row
    return best
  }, [rows])
  // Marked only where it IS the header's peak. When Remnawave's live figure is
  // higher than every stored sample, the header's peak is that live figure and
  // it is on no point of this chart — a marker on the highest sample would then
  // point at a number the header does not show.
  const peak = top !== null && overview.peak !== null && top.online === overview.peak.value ? top : null

  // A reading with no reading on either side draws nothing as a line or an
  // area — both need two points — so it gets a dot of its own. Without it a day
  // sampled every ten minutes, a gap between every two readings, was a blank
  // chart over a count of hundreds of samples.
  const lone = useMemo(() => {
    const found = new Set<number>()
    rows.forEach((row, index) => {
      if (row.online === null) return
      const before = rows[index - 1]?.online ?? null
      const after = rows[index + 1]?.online ?? null
      if (before === null && after === null) found.add(index)
    })
    return found
  }, [rows])
  const drawLoneReading = ({ index, cx, cy }: DotItemDotProps): ReactNode =>
    lone.has(index) && typeof cx === 'number' && typeof cy === 'number' ? (
      <circle cx={cx} cy={cy} r={2.5} fill={ONLINE_COLOR} data-lone-reading="" />
    ) : null

  // Wide enough for the longest label the axis can draw (recharts rounds its top tick up).
  const highest = top?.online ?? 0
  const yAxisWidth = Math.max(24, Math.round(formatCount(Math.ceil(highest * 1.25), locale).length * 6.5 + 10))

  return (
    <div className={cn('h-full min-h-48 max-h-128', dimmed && 'opacity-60 motion-safe:transition-opacity')} data-online-chart={range}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
        <AreaChart data={rows} margin={CHART_MARGIN}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={ONLINE_COLOR} stopOpacity={0.32} />
              <stop offset="95%" stopColor={ONLINE_COLOR} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
          <XAxis
            dataKey="at"
            type="number"
            scale="time"
            domain={[start, end]}
            ticks={ticks}
            tickFormatter={(value: number) => formatAxisTick(value, range, locale)}
            className="text-xs"
            tick={{ fontSize: 10 }}
            minTickGap={12}
          />
          <YAxis
            className="text-xs"
            tick={{ fontSize: 10 }}
            width={yAxisWidth}
            allowDecimals={false}
            tickFormatter={(value: number) => formatCount(value, locale)}
          />
          <ChartTooltip
            contentStyle={TOOLTIP_STYLE}
            separator=": "
            itemStyle={TOOLTIP_ITEM_STYLE}
            isAnimationActive={animate}
            labelFormatter={(value) => formatPointLabel(Number(value), range, overview.bucketMinutes, locale)}
            formatter={(value) => formatCount(Number(value ?? 0), locale)}
          />
          <Area
            type="monotone"
            dataKey="online"
            // The series says what a point IS: over a week, each is an hour's highest reading.
            name={t(range === '7d' ? 'dashboardPage.onlineTrend.series.hourlyMax' : 'dashboardPage.onlineTrend.series.online')}
            stroke={ONLINE_COLOR}
            fill={`url(#${gradientId})`}
            strokeWidth={2}
            dot={drawLoneReading}
            activeDot={{ r: 4 }}
            connectNulls={false}
            isAnimationActive={animate}
            animationDuration={SWEEP_MS}
            animationEasing="ease-out"
          />
          {peak !== null ? (
            <ReferenceDot
              x={peak.at}
              y={peak.online ?? 0}
              r={4}
              fill={ONLINE_COLOR}
              stroke="var(--card)"
              strokeWidth={2}
              ifOverflow="extendDomain"
            />
          ) : null}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
