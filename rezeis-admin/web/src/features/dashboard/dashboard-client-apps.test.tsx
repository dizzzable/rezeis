/**
 * The client-apps ring on the dashboard.
 *
 * What is asserted is what an operator reads: which apps get a slice of their
 * own, what the folded tail adds up to, how a nameless app is labelled, and —
 * as important as any of it — that an operator without `remnawave:view` does
 * not trigger a request at all. The admin client has no global 403 handler, so
 * an unguarded query would fail on their dashboard for a card they were never
 * meant to see.
 */
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

import {
  CLIENT_APPS_SHOWN,
  CLIENT_APPS_TOOLTIP_STYLE,
  DashboardClientApps,
} from './dashboard-client-apps'

const getHwidStats = vi.mocked(remnawaveApi.getHwidStats)

const STATS = { totalUniqueDevices: 0, totalHwidDevices: 0, averageHwidDevicesPerUser: 0 }

function grant(...permissions: string[]) {
  usePermissionStore.setState({ loaded: true, role: 'ADMIN', granted: new Set(permissions) })
}

function renderApps() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <DashboardClientApps />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  getHwidStats.mockReset()
})

afterEach(() => {
  usePermissionStore.getState().reset()
})

describe('DashboardClientApps', () => {
  it('gives the largest apps a slice each and folds the rest into one', async () => {
    grant('remnawave:view')
    getHwidStats.mockResolvedValue({
      byPlatform: [],
      stats: STATS,
      apps: [
        { app: 'Happ', count: 40 },
        { app: 'v2rayNG', count: 30 },
        { app: 'Streisand', count: 20 },
        { app: 'Hiddify', count: 10 },
        { app: 'Incy', count: 8 },
        { app: 'FoXray', count: 3 },
        { app: 'Karing', count: 2 },
      ],
    })

    renderApps()

    for (const app of ['Happ', 'v2rayNG', 'Streisand', 'Hiddify', 'Incy']) {
      expect(await screen.findByText(app)).toBeInTheDocument()
    }
    // Exactly the first CLIENT_APPS_SHOWN are named; the sixth and seventh are
    // folded, and their counts add up in the shared slice.
    expect(CLIENT_APPS_SHOWN).toBe(5)
    expect(screen.queryByText('FoXray')).not.toBeInTheDocument()
    expect(screen.queryByText('Karing')).not.toBeInTheDocument()
    const other = screen.getByText('dashboardPage.clientAppsChart.other').closest('li')
    expect(other).toHaveTextContent('5')
  })

  it('counts the folded apps into the total as well', async () => {
    grant('remnawave:view')
    getHwidStats.mockResolvedValue({
      byPlatform: [],
      stats: STATS,
      apps: [
        { app: 'A', count: 1 },
        { app: 'B', count: 1 },
        { app: 'C', count: 1 },
        { app: 'D', count: 1 },
        { app: 'E', count: 1 },
        { app: 'F', count: 1 },
      ],
    })

    renderApps()

    expect(
      await screen.findByText('dashboardPage.clientAppsChart.description:{"total":6}'),
    ).toBeInTheDocument()
  })

  it('labels a device whose app Remnawave could not name, instead of drawing a blank', async () => {
    grant('remnawave:view')
    getHwidStats.mockResolvedValue({ byPlatform: [], stats: STATS, apps: [{ app: '', count: 3 }] })

    renderApps()

    expect(await screen.findByText('dashboardPage.clientAppsChart.unknown')).toBeInTheDocument()
  })

  it('does not ask the panel at all without remnawave:view', async () => {
    grant('dashboard:view')

    const { container } = renderApps()

    expect(container).toBeEmptyDOMElement()
    // Give a would-be query a chance to fire before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(getHwidStats).not.toHaveBeenCalled()
  })

  it('says the statistics are unavailable rather than drawing an empty ring', async () => {
    grant('remnawave:view')
    getHwidStats.mockResolvedValue(null)

    renderApps()

    expect(await screen.findByText('dashboardPage.clientAppsChart.unavailable')).toBeInTheDocument()
  })

  it('says so when no device has reported an HWID yet', async () => {
    grant('remnawave:view')
    getHwidStats.mockResolvedValue({ byPlatform: [], stats: STATS, apps: [] })

    renderApps()

    expect(await screen.findByText('dashboardPage.clientAppsChart.empty')).toBeInTheDocument()
  })
  it('gives the tooltip a background the browser can actually paint', () => {
    // `hsl(var(--background))` is what the charts beside this one pass, and
    // it is invalid at computed-value time here: every theme variable in this
    // project holds a whole `oklch(...)` value, by the rule stated in
    // `index.css`. Measured in a browser, the box comes out `rgba(0, 0, 0, 0)`
    // — the counts land on the ring with nothing behind them.
    for (const value of Object.values(CLIENT_APPS_TOOLTIP_STYLE)) {
      expect(value).not.toMatch(/hsl\(\s*var\(--/)
    }
    expect(CLIENT_APPS_TOOLTIP_STYLE.backgroundColor).toBe('var(--background)')
  })
})
