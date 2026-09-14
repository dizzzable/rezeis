/**
 * Which apps the panel's customers connect with — the right half of the
 * subscription card.
 *
 * DEVICES, not fetches. The panel sums Remnawave's HWID device stats per app
 * (`withHwidApps`), so an app that refreshes its subscription hourly does not
 * outweigh one that refreshes daily. The price is stated under the ring: a
 * client that sends no HWID is not a device here at all.
 *
 * It shares the Remnawave page's cache key, so opening that page after the
 * dashboard costs no second request.
 *
 * It sits behind `remnawave:view`, as its route does, and without that grant it
 * does not even ask. The admin client has no global 403 handler, so an
 * unguarded query would simply fail — and a dashboard that shows an error to an
 * operator who was never meant to see this is worse than one that shows nothing.
 */
import { type JSX, useId, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { remnawaveApi } from '@/features/remnawave/remnawave-api'
import { KEYS } from '@/features/remnawave/remnawave-query-keys'
import { usePermissionStore } from '@/features/rbac/use-permission-store'

import { DashboardRing, DashboardRingHeading, type DashboardRingSlice } from './dashboard-ring'

/** How many apps get a slice of their own; the rest share one. */
export const CLIENT_APPS_SHOWN = 5

/**
 * A categorical palette of its own, NOT the theme's `--chart-1…5`.
 *
 * A theme is free to make those a monochrome ramp, and real ones do: on the
 * owner's panel three of the five were greys, so FlClash X, koala-clash and
 * v2raytun were three shades of grey next to a grey "Other" slice and could not
 * be told apart. Five colours clearly apart, at a lightness that reads on both
 * the dark and the light card, in rank order — the largest app gets the first.
 * Green, yellow, orange and red are left to the statuses in the ring beside
 * this one, which leaves too few hues for five: the lavender stands apart from
 * the violet by lightness rather than hue. Orange was once missed — the first
 * colour was an amber a hair from "expiring", and the largest app read as the
 * expiring share — so the spec measures every colour here against every
 * status colour and every other colour here.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const CLIENT_APP_COLORS = [
  'oklch(0.76 0.1 290)', // lavender
  'oklch(0.62 0.19 258)', // blue
  'oklch(0.63 0.21 300)', // violet
  'oklch(0.72 0.13 195)', // teal
  'oklch(0.67 0.21 350)', // pink
] as const
/** The folded tail: neutral on purpose, so it never reads as one more app. */
export const CLIENT_APPS_OTHER_COLOR = 'oklch(0.6 0.02 260)'

/**
 * The tooltip box, in the theme the operator is actually looking at.
 *
 * NOT `hsl(var(--background))`. This project stores whole colour values in
 * its variables and says so in `index.css` — "no `hsl()` wrapper, plain
 * colour values", so that a theme pasted from ui.shadcn.com or tweakcn works
 * untranslated — and every one of them is an `oklch(...)`. Wrapping that in
 * `hsl()` is invalid at computed-value time: the browser drops the
 * declaration and the box computes to `rgba(0, 0, 0, 0)`, i.e. the numbers
 * land straight on top of the ring with nothing behind them. Measured, not
 * assumed.
 *
 * Exported so the spec can assert what recharts is handed.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const CLIENT_APPS_TOOLTIP_STYLE = {
  borderRadius: '8px',
  border: '1px solid var(--border)',
  backgroundColor: 'var(--background)',
} as const

export function DashboardClientApps(): JSX.Element | null {
  const { t } = useTranslation()
  const titleId = useId()
  // A boolean selector, so the ring appears the moment permissions load rather
  // than on some later unrelated render.
  const canView = usePermissionStore((s) => s.hasPermission('remnawave', 'view'))

  const { data, isLoading, isError } = useQuery({
    queryKey: KEYS.hwidStats,
    queryFn: remnawaveApi.getHwidStats,
    enabled: canView,
    staleTime: 60_000,
  })

  const slices = useMemo<DashboardRingSlice[]>(() => {
    const apps = data?.apps ?? []
    const named = apps.slice(0, CLIENT_APPS_SHOWN).map((row, index) => ({
      key: row.app === '' ? '__unknown__' : row.app,
      name: row.app === '' ? t('dashboardPage.clientAppsChart.unknown') : row.app,
      value: row.count,
      color: CLIENT_APP_COLORS[index % CLIENT_APP_COLORS.length] ?? CLIENT_APPS_OTHER_COLOR,
    }))
    const rest = apps.slice(CLIENT_APPS_SHOWN).reduce((sum, row) => sum + row.count, 0)
    return rest > 0
      ? [
          ...named,
          {
            key: '__other__',
            name: t('dashboardPage.clientAppsChart.other'),
            value: rest,
            color: CLIENT_APPS_OTHER_COLOR,
          },
        ]
      : named
  }, [data, t])

  if (!canView) return null

  const total = slices.reduce((sum, slice) => sum + slice.value, 0)
  const ready = !isLoading && !isError && data !== null && data !== undefined

  return (
    <section aria-labelledby={titleId} className="flex min-w-0 flex-col gap-5">
      <DashboardRingHeading
        id={titleId}
        title={t('dashboardPage.clientAppsChart.title')}
        description={
          ready && slices.length > 0
            ? t('dashboardPage.clientAppsChart.description', { total })
            : undefined
        }
      />

      {isLoading ? (
        <div className="h-48 w-full animate-pulse rounded-lg bg-muted/40" aria-busy="true" />
      ) : !ready ? (
        <p className="text-sm text-muted-foreground">
          {t('dashboardPage.clientAppsChart.unavailable')}
        </p>
      ) : slices.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('dashboardPage.clientAppsChart.empty')}</p>
      ) : (
        <>
          <DashboardRing slices={slices} total={total} tooltipStyle={CLIENT_APPS_TOOLTIP_STYLE} />
          <p className="text-xs text-muted-foreground">{t('dashboardPage.clientAppsChart.note')}</p>
        </>
      )}
    </section>
  )
}
