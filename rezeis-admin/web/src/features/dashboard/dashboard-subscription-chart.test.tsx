/**
 * The subscription card's two halves line up.
 *
 * The owner's screenshot (13.09.2026): "Приложения клиентов" sat lower and
 * smaller than "Распределение подписок", because the status half used the
 * card's own header — above the grid — while the client-apps half had a small
 * heading inside its column. jsdom has no layout, so this pins the STRUCTURE
 * that makes them line up: both titles are the same heading component, each is
 * the first row of its own column, and the two columns are siblings in one grid.
 *
 * And the colours: five apps drawn from the theme's `--chart-*` were three
 * greys on the owner's theme. The palette is the component's own now.
 */
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}))

// jsdom has no layout engine; give the ring the size its fixed wrapper would.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>()
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) =>
      isValidElement(children)
        ? cloneElement(children as ReactElement<{ width?: number; height?: number }>, {
            width: 192,
            height: 192,
          })
        : children,
  }
})

vi.mock('@/features/remnawave/remnawave-api', () => ({
  remnawaveApi: { getHwidStats: vi.fn() },
}))

import { remnawaveApi } from '@/features/remnawave/remnawave-api'
import { usePermissionStore } from '@/features/rbac/use-permission-store'

import { CLIENT_APP_COLORS, CLIENT_APPS_OTHER_COLOR } from './dashboard-client-apps'
import { DashboardSubscriptionChart, SUBSCRIPTION_STATUS_COLORS } from './dashboard-subscription-chart'

const SUMMARY = { subscriptions: { active: 52, limited: 0, expired: 2, expiring7d: 8 } } as never

function renderCard(summary: unknown = SUMMARY) {
  usePermissionStore.setState({ loaded: true, role: 'ADMIN', granted: new Set(['remnawave:view']) })
  vi.mocked(remnawaveApi.getHwidStats).mockResolvedValue({
    totalUniqueDevices: 95,
    totalHwidDevices: 95,
    averageHwidDevicesPerUser: 1,
    apps: [
      { app: 'INCY', count: 41 },
      { app: 'Happ', count: 36 },
      { app: 'FlClash X', count: 5 },
      { app: 'koala-clash', count: 5 },
      { app: 'v2raytun', count: 4 },
      { app: 'Streisand', count: 4 },
    ],
  } as never)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <DashboardSubscriptionChart summary={summary as never} />
    </QueryClientProvider>,
  )
}

/** The status half: its heading's column. */
const statusColumn = (): HTMLElement =>
  screen.getByRole('heading', { name: 'dashboardPage.subscriptionChart.title' }).closest('section') as HTMLElement

/** The status legend as the operator reads it: each row's label and number. */
function statusLegend(): Record<string, number> {
  return Object.fromEntries(
    within(statusColumn())
      .getAllByRole('listitem')
      .map((row) => {
        const [, name, value] = row.children
        return [name?.textContent ?? '', Number(value?.textContent)]
      }),
  )
}

/**
 * A CSS colour in OKLab, where a distance reads as a difference the eye sees.
 * Only the notations the two rings use; any other is refused by name rather
 * than read as black.
 */
function oklab(css: string): readonly [number, number, number] {
  const hsl = /^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/.exec(css)
  if (hsl !== null) {
    const [h, s, l] = [Number(hsl[1]), Number(hsl[2]) / 100, Number(hsl[3]) / 100]
    const k = (n: number): number => (n + h / 30) % 12
    const f = (n: number): number => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
    const linear = [f(0), f(8), f(4)].map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    const [r, g, b] = linear as [number, number, number]
    const lms = [
      0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b,
      0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b,
      0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b,
    ].map(Math.cbrt) as [number, number, number]
    return [
      0.2104542553 * lms[0] + 0.793617785 * lms[1] - 0.0040720468 * lms[2],
      1.9779984951 * lms[0] - 2.428592205 * lms[1] + 0.4505937099 * lms[2],
      0.0259040371 * lms[0] + 0.7827717662 * lms[1] - 0.808675766 * lms[2],
    ]
  }
  const oklch = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(css)
  if (oklch !== null) {
    const [lightness, chroma, hue] = [Number(oklch[1]), Number(oklch[2]), (Number(oklch[3]) * Math.PI) / 180]
    return [lightness, chroma * Math.cos(hue), chroma * Math.sin(hue)]
  }
  throw new Error(`${css}: teach this test the notation before comparing it`)
}

const distance = (a: string, b: string): number => {
  const [p, q] = [oklab(a), oklab(b)]
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
}

afterEach(() => {
  usePermissionStore.getState().reset()
  vi.mocked(remnawaveApi.getHwidStats).mockReset()
})

describe('the subscription card', () => {
  it('puts both titles in the first row of sibling columns, as the same heading', async () => {
    renderCard()

    const statusTitle = screen.getByRole('heading', { name: 'dashboardPage.subscriptionChart.title' })
    const appsTitle = await screen.findByRole('heading', { name: 'dashboardPage.clientAppsChart.title' })

    // The same component: same element, same classes, the concept-theme hook.
    expect(appsTitle.tagName).toBe(statusTitle.tagName)
    expect(appsTitle.className).toBe(statusTitle.className)
    expect(statusTitle).toHaveAttribute('data-concept-heading')
    expect(appsTitle).toHaveAttribute('data-concept-heading')

    // Each title opens its own column: heading → its block → the column.
    const statusColumn = statusTitle.closest('section')
    const appsColumn = appsTitle.closest('section')
    expect(statusColumn).not.toBeNull()
    expect(appsColumn).not.toBeNull()
    expect(statusColumn?.firstElementChild).toBe(statusTitle.parentElement)
    expect(appsColumn?.firstElementChild).toBe(appsTitle.parentElement)

    // …and the two columns are siblings in one grid. A title rendered in the
    // card's header, above the grid, is exactly what this refuses.
    expect(statusColumn?.parentElement).toBe(appsColumn?.parentElement)
    expect(statusColumn?.parentElement?.className).toMatch(/\bgrid\b/)

    // The descriptions sit on the second line of each heading block.
    expect(within(statusColumn as HTMLElement).getByText(/subscriptionChart\.description/)).toBeInTheDocument()
    expect(await within(appsColumn as HTMLElement).findByText(/clientAppsChart\.description/)).toBeInTheDocument()
  })

  it('counts every subscription once — the ones expiring within 7 days are active ones, not a fifth status', () => {
    // 52 active, 8 of them expiring within 7 days; 2 expired; none limited.
    renderCard()
    const column = within(statusColumn())

    expect(column.getByText('dashboardPage.subscriptionChart.description:{"total":54}')).toBeInTheDocument()
    // The number in the ring's hole: the same total, hidden from assistive technology.
    expect(column.getByText('54').closest('[aria-hidden]')).not.toBeNull()
    expect(column.queryByText('62')).not.toBeInTheDocument()

    // Every slice a different set of subscriptions, so the legend adds up to the total.
    expect(statusLegend()).toEqual({
      'dashboardPage.subscriptionChart.active': 44,
      'dashboardPage.subscriptionChart.limited': 0,
      'dashboardPage.subscriptionChart.expired': 2,
      'dashboardPage.subscriptionChart.expiring': 8,
    })
  })

  it('never draws a negative slice when the two counts were taken a moment apart', () => {
    // The API counts active and expiring in separate queries: a subscription
    // activated between them can make the second larger than the first.
    renderCard({ subscriptions: { active: 2, limited: 0, expired: 1, expiring7d: 3 } })

    expect(within(statusColumn()).getByText('dashboardPage.subscriptionChart.description:{"total":3}')).toBeInTheDocument()
    expect(statusLegend()).toEqual({
      'dashboardPage.subscriptionChart.active': 0,
      'dashboardPage.subscriptionChart.limited': 0,
      'dashboardPage.subscriptionChart.expired': 1,
      'dashboardPage.subscriptionChart.expiring': 2,
    })
  })

  it('keeps every client-app colour clear of every status colour beside it, and of each other', () => {
    /**
     * The closest pairs the two rings had when this was written, and nobody
     * mistook: pink beside "expired" red at 0.132, the app palette's blue and
     * violet at 0.145. The pair that WAS mistaken — the top app's amber and
     * "expiring" orange, the largest app reading as the expiring share — sat
     * at 0.066.
     */
    const MIN_DISTANCE = 0.12
    // The measure itself: one colour in the two notations reads as one colour.
    expect(distance('hsl(25, 95%, 53%)', 'oklch(0.707 0.186 48.1)')).toBeLessThan(0.01)

    const apps = [...CLIENT_APP_COLORS, CLIENT_APPS_OTHER_COLOR]
    const statuses = Object.entries(SUBSCRIPTION_STATUS_COLORS)
    expect(statuses.length).toBe(4)
    const tooClose: string[] = []
    for (const app of apps) {
      for (const [status, color] of statuses) {
        const d = distance(app, color)
        if (d < MIN_DISTANCE) tooClose.push(`${app} beside the "${status}" status ${color}: ${d.toFixed(3)}`)
      }
    }
    apps.forEach((app, index) => {
      for (const other of apps.slice(index + 1)) {
        const d = distance(app, other)
        if (d < MIN_DISTANCE) tooClose.push(`${app} beside ${other}: ${d.toFixed(3)}`)
      }
    })
    expect(tooClose).toEqual([])
  })

  it('draws each client app in a colour of its own, never a theme chart variable', () => {
    expect(new Set(CLIENT_APP_COLORS).size).toBe(CLIENT_APP_COLORS.length)
    expect(CLIENT_APP_COLORS.length).toBeGreaterThanOrEqual(5)
    for (const color of [...CLIENT_APP_COLORS, CLIENT_APPS_OTHER_COLOR]) {
      expect(color).not.toMatch(/var\(--chart-/)
    }
    expect(CLIENT_APP_COLORS).not.toContain(CLIENT_APPS_OTHER_COLOR)
  })

  it('gives the legend dots the palette, in rank order, and the folded tail the neutral colour', async () => {
    renderCard()
    const appsTitle = await screen.findByRole('heading', { name: 'dashboardPage.clientAppsChart.title' })
    const column = appsTitle.closest('section') as HTMLElement

    const rows = await within(column).findAllByRole('listitem')
    const dots = rows.map((row) => (row.querySelector('span') as HTMLElement).style.backgroundColor)
    const expected = [...CLIENT_APP_COLORS, CLIENT_APPS_OTHER_COLOR]
    // jsdom normalises what it can parse and leaves oklch() as written.
    expect(dots).toEqual(expected.map((color) => color.replace(/\s+/g, ' ')))
  })
})
