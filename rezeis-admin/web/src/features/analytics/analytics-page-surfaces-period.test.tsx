/**
 * The period buttons change the period, and nothing else.
 *
 * «Поверхности и устройства» is not about the chosen window — it counts every
 * customer with telemetry by their latest visit, and it fetches that itself. It
 * used to sit INSIDE the part of the overview that a period click replaces with
 * skeletons, so every 7d/30d/90d/1y click unmounted the card: a second request
 * for a breakdown that had not changed, and four sweeps replayed under a click
 * that was about something else.
 *
 * And a tab is not an arrival either: leaving «Обзор» and coming back rebuilds
 * the card, but the operator has already watched it play. The page remembers
 * which panels have had their turn for as long as the visit lasts.
 *
 * Real recharts is rendered with its Pie recorded on the way in, so the test can
 * ask whether a ring was TOLD to animate, and the driveable
 * `IntersectionObserver` reports the card on screen the way a browser would.
 */
import { type ComponentProps, type ReactElement, type ReactNode, cloneElement, isValidElement } from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { useAppearanceStore } from '@/lib/theme/appearance-store'
import { installIntersectionObserver, renderWithProviders, type IntersectionObserverHarness } from '@/test/test-utils'

const recorded = vi.hoisted(() => ({ pies: [] as Array<{ readonly isAnimationActive: unknown }> }))

vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>()
  return {
    ...actual,
    Pie: (props: ComponentProps<typeof actual.Pie>) => {
      recorded.pies.push({ isAnimationActive: props.isAnimationActive })
      return <actual.Pie {...props} />
    },
    ResponsiveContainer: ({ children }: { children: ReactNode }) =>
      isValidElement(children)
        ? cloneElement(children as ReactElement<{ width?: number; height?: number }>, { width: 112, height: 112 })
        : children,
  }
})

vi.mock('./analytics-api', () => ({
  getAnalyticsOverview: vi.fn(),
  getAnalyticsCohorts: vi.fn(),
  getLtvDistribution: vi.fn(),
  getRevenueByCurrency: vi.fn(),
  getSubscriptionsByPlan: vi.fn(),
  getTopPayers: vi.fn(),
  getTrialConversion: vi.fn(),
  getSurfaceAnalytics: vi.fn(),
}))

import * as analyticsApi from './analytics-api'
import AnalyticsPage from './analytics-page'

const api = vi.mocked(analyticsApi)

const overviewFor = (windowDays: number) => ({
  kpis: {
    windowDays,
    totalRevenue: 0,
    paidCount: 0,
    payingUsers: 0,
    arpu: 0,
    arppu: 0,
    activeSubscriptions: 0,
    trialSubscriptions: 0,
    totalUsers: 0,
    newUsersInWindow: 0,
  },
  churn: { windowDays, prevActive: 0, stillActive: 0, churned: 0, churnRate: 0, retentionRate: 0 },
  funnel: [],
  providers: [],
  daily: [],
  windowDays,
  generatedAt: '2026-09-17T00:00:00.000Z',
})

const SURFACES = {
  surfaces: [
    { key: 'tma', count: 30 },
    { key: 'browser', count: 12 },
  ],
  formFactors: [{ key: 'mobile', count: 42 }],
  operatingSystems: [{ key: 'ios', count: 42 }],
  pwaInstalls: 3,
  pwaInstallsByOs: [{ key: 'ios', count: 3 }],
  activeLast30d: 42,
  totalTracked: 48,
  generatedAt: '2026-09-17T00:00:00.000Z',
}

const realMatchMedia = window.matchMedia
let visibility: IntersectionObserverHarness | null = null

beforeAll(async () => {
  await i18nReady
  await i18n.changeLanguage('ru')
  await loadFeatureBundle('analytics')
})

beforeEach(() => {
  recorded.pies.length = 0
  visibility = installIntersectionObserver()
  vi.clearAllMocks()
  // The card may move: neither switch is off.
  useAppearanceStore.setState({ animationsEnabled: true })
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
  api.getAnalyticsOverview.mockImplementation((days: number) => Promise.resolve(overviewFor(days)))
  api.getSurfaceAnalytics.mockResolvedValue(SURFACES)
  api.getRevenueByCurrency.mockResolvedValue([])
  api.getSubscriptionsByPlan.mockResolvedValue([])
})

afterEach(() => {
  visibility?.restore()
  visibility = null
  window.matchMedia = realMatchMedia
})

const surfacePanel = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>('[data-surface-panel="surface"]')
  if (found === null) throw new Error('the surfaces card is not on the page')
  return found
}

async function renderPage(): Promise<void> {
  renderWithProviders(<AnalyticsPage />)
  await waitFor(() => expect(document.querySelectorAll('[data-surface-panel]')).toHaveLength(4))
}

describe('the surfaces card and the period buttons', () => {
  it('is left alone by a period click: not refetched, not rebuilt, not replayed', async () => {
    const user = userEvent.setup()
    await renderPage()
    await waitFor(() => expect(api.getAnalyticsOverview).toHaveBeenCalledTimes(1))
    const drawnFor30d = surfacePanel()
    const sweeps = recorded.pies.length

    await user.click(screen.getByRole('button', { name: '90d' }))

    // The period's own cards ask again…
    await waitFor(() => expect(api.getAnalyticsOverview).toHaveBeenCalledTimes(2))
    expect(api.getAnalyticsOverview).toHaveBeenLastCalledWith(90)
    // …and the surfaces card is untouched: the same request count, the same DOM
    // node (a remount would hand back a new one), and no new ring drawn.
    expect(api.getSurfaceAnalytics).toHaveBeenCalledTimes(1)
    expect(surfacePanel()).toBe(drawnFor30d)
    expect(recorded.pies).toHaveLength(sweeps)
    expect(within(surfacePanel()).getByRole('heading').textContent).toBe(i18n.t('analyticsPage.surfaces.panels.surface'))
  })

  it('does not play again when the operator comes back to the tab', async () => {
    const user = userEvent.setup()
    await renderPage()
    // It played on arrival.
    expect(recorded.pies.length).toBeGreaterThan(0)
    expect(recorded.pies.some((pie) => pie.isAnimationActive === true)).toBe(true)

    await user.click(screen.getByRole('tab', { name: i18n.t('analyticsPage.tabs.revenue') }))
    await waitFor(() => expect(document.querySelectorAll('[data-surface-panel]')).toHaveLength(0))
    recorded.pies.length = 0
    await user.click(screen.getByRole('tab', { name: i18n.t('analyticsPage.tabs.overview') }))
    await waitFor(() => expect(document.querySelectorAll('[data-surface-panel]')).toHaveLength(4))

    // Rebuilt, and drawn finished: the sweep is for arriving at the page, not
    // for every time the card is put back on the screen.
    expect(recorded.pies.length).toBeGreaterThan(0)
    expect(recorded.pies.every((pie) => pie.isAnimationActive === false)).toBe(true)
    expect(document.querySelector('[data-surface-ring-hole]')?.textContent).toBe('42')
  })
})
