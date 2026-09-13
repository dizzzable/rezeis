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
import { DashboardSubscriptionChart } from './dashboard-subscription-chart'

const SUMMARY = { subscriptions: { active: 52, limited: 0, expired: 2, expiring7d: 8 } } as never

function renderCard() {
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
      <DashboardSubscriptionChart summary={SUMMARY} />
    </QueryClientProvider>,
  )
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
