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
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'

import { remnawaveApi } from '@/features/remnawave/remnawave-api'
import { KEYS } from '@/features/remnawave/remnawave-query-keys'
import { usePermissionStore } from '@/features/rbac/use-permission-store'

/** How many apps get a slice of their own; the rest share one. */
export const CLIENT_APPS_SHOWN = 5

const SLICE_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
] as const
const OTHER_COLOR = 'var(--muted-foreground)'

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

interface Slice {
  readonly key: string
  readonly name: string
  readonly value: number
  readonly color: string
}

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

  const slices = useMemo<Slice[]>(() => {
    const apps = data?.apps ?? []
    const named = apps.slice(0, CLIENT_APPS_SHOWN).map((row, index) => ({
      key: row.app === '' ? '__unknown__' : row.app,
      name: row.app === '' ? t('dashboardPage.clientAppsChart.unknown') : row.app,
      value: row.count,
      color: SLICE_COLORS[index % SLICE_COLORS.length] ?? OTHER_COLOR,
    }))
    const rest = apps.slice(CLIENT_APPS_SHOWN).reduce((sum, row) => sum + row.count, 0)
    return rest > 0
      ? [
          ...named,
          {
            key: '__other__',
            name: t('dashboardPage.clientAppsChart.other'),
            value: rest,
            color: OTHER_COLOR,
          },
        ]
      : named
  }, [data, t])

  if (!canView) return null

  const total = slices.reduce((sum, slice) => sum + slice.value, 0)
  const ready = !isLoading && !isError && data !== null && data !== undefined

  return (
    <section aria-labelledby={titleId} className="flex min-w-0 flex-col gap-3">
      <div>
        <h3 id={titleId} className="text-sm font-medium leading-none">
          {t('dashboardPage.clientAppsChart.title')}
        </h3>
        {ready && slices.length > 0 ? (
          <p className="mt-1.5 text-sm text-muted-foreground">
            {t('dashboardPage.clientAppsChart.description', { total })}
          </p>
        ) : null}
      </div>

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
          <div className="flex items-center gap-6">
            <div className="h-48 w-48 shrink-0">
              <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
                <PieChart>
                  <Pie
                    data={slices}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
                    dataKey="value"
                    nameKey="name"
                  >
                    {slices.map((slice) => (
                      <Cell key={slice.key} fill={slice.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value) => [Number(value ?? 0), '']}
                    contentStyle={CLIENT_APPS_TOOLTIP_STYLE}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <ul className="flex min-w-0 flex-col gap-3">
              {slices.map((slice) => (
                <li key={slice.key} className="flex min-w-0 items-center gap-2">
                  <span
                    className="h-3 w-3 shrink-0 rounded-full"
                    style={{ backgroundColor: slice.color }}
                    aria-hidden
                  />
                  <span className="truncate text-sm text-muted-foreground">{slice.name}</span>
                  <span className="ml-auto pl-3 text-sm font-medium tabular-nums">
                    {slice.value}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-xs text-muted-foreground">{t('dashboardPage.clientAppsChart.note')}</p>
        </>
      )}
    </section>
  )
}
