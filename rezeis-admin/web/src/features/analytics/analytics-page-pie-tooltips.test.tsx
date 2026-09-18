/**
 * Every donut on the analytics page names the slice its tooltip points at.
 *
 * Two of them handed recharts a formatter that returned `[value, '']`. recharts
 * 3 prints a tooltip item's name and the " : " separator whenever the name is a
 * string or a number, and `''` is a string, so hovering a slice read " : 12"
 * with nothing to say which slice it was. The third passed no formatter, but its
 * rows carry no `name`, and recharts then names a slice by its index: "0 : 12".
 * The currency donut had no `name` either, so dropping its formatter alone
 * would have printed the index too.
 *
 * Real recharts is rendered, with only its entrance animation turned off (jsdom
 * never advances it, so the sectors would have no shape to point at) and the
 * size its fixed wrapper would give. A slice is hovered the way a mouse does,
 * and the tooltip is read off the page.
 *
 * The usage rings sweep in only once their panel is on screen
 * (`surface-motion.ts`), and the suite's `IntersectionObserver` stub never
 * reports anything. So this file installs the driveable one from `test-utils`,
 * which answers the way a browser does for a card already in view: at once,
 * intersecting.
 */
import { cloneElement, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { installIntersectionObserver, renderWithProviders, type IntersectionObserverHarness } from '@/test/test-utils'

vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>()
  return {
    ...actual,
    Pie: (props: ComponentProps<typeof actual.Pie>) => <actual.Pie {...props} isAnimationActive={false} />,
    ResponsiveContainer: ({ children }: { children: ReactNode }) =>
      isValidElement(children)
        ? cloneElement(children as ReactElement<{ width?: number; height?: number }>, { width: 208, height: 208 })
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

// The page's words, as its route loads them, so a label is read the way the operator reads it.
beforeAll(async () => {
  await i18nReady
  await loadFeatureBundle('analytics')
})

// A card already in view: every observed element is reported intersecting at once.
let visibility: IntersectionObserverHarness | null = null

afterEach(() => {
  visibility?.restore()
  visibility = null
})

beforeEach(() => {
  visibility = installIntersectionObserver()
  vi.clearAllMocks()
  api.getAnalyticsOverview.mockResolvedValue({
    kpis: {
      windowDays: 30,
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
    churn: { windowDays: 30, prevActive: 0, stillActive: 0, churned: 0, churnRate: 0, retentionRate: 0 },
    funnel: [],
    providers: [],
    daily: [],
    windowDays: 30,
    generatedAt: '2026-09-14T00:00:00.000Z',
  })
  api.getSurfaceAnalytics.mockResolvedValue({
    surfaces: [
      { key: 'tma', count: 12 },
      { key: 'browser', count: 5 },
    ],
    formFactors: [],
    operatingSystems: [],
    pwaInstalls: 0,
    pwaInstallsByOs: [],
    activeLast30d: 0,
    totalTracked: 17,
    generatedAt: '2026-09-14T00:00:00.000Z',
  })
  api.getRevenueByCurrency.mockResolvedValue([
    { currency: 'RUB', revenue: 12_345, transactions: 3, percentage: 0.8 },
    { currency: 'USD', revenue: 3_000, transactions: 1, percentage: 0.2 },
  ])
  api.getSubscriptionsByPlan.mockResolvedValue([
    { plan: 'Pro', active: 10, limited: 2, total: 12, percentage: 0.6 },
    { plan: 'Basic', active: 8, limited: 0, total: 8, percentage: 0.4 },
  ])
})

/** The box that holds `title` and a donut: the smallest one, as the same words can head more than one block. */
function donutCard(title: string): HTMLElement {
  const boxes = screen.getAllByText(title).flatMap((match) => {
    let element: HTMLElement | null = match
    while (element !== null && element.querySelector('.recharts-pie-sector') === null) element = element.parentElement
    return element === null ? [] : [element]
  })
  const smallest = boxes.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0]
  if (smallest === undefined) throw new Error(`no donut is drawn under "${title}"`)
  return smallest
}

/** Points at slice `index` of the donut in `card`, and reads the one item its tooltip shows. */
async function hoverSlice(card: HTMLElement, index: number): Promise<{ readonly name: string | null; readonly value: string | null }> {
  const sectors = card.querySelectorAll('.recharts-pie-sector')
  const sector = sectors[index]
  if (sector === undefined) throw new Error(`the donut draws ${sectors.length} slices, not ${index + 1}`)
  fireEvent.mouseEnter(sector)
  return waitFor(() => {
    const items = card.querySelectorAll('.recharts-tooltip-item')
    if (items.length !== 1) throw new Error(`the tooltip shows ${items.length} items, not the one slice pointed at`)
    const item = items[0] as Element
    return {
      name: item.querySelector('.recharts-tooltip-item-name')?.textContent ?? null,
      value: item.querySelector('.recharts-tooltip-item-value')?.textContent ?? null,
    }
  })
}

describe('analytics page donuts — the tooltip says which slice it is', () => {
  it('usage surfaces: the slice’s surface, in the legend’s words, beside its count', async () => {
    renderWithProviders(<AnalyticsPage />)
    const title = i18n.t('analyticsPage.surfaces.panels.surface')
    await waitFor(() => expect(document.querySelectorAll('.recharts-pie-sector')).toHaveLength(2))
    const card = donutCard(title)
    const miniApp = i18n.t('analyticsPage.surfaces.surface.tma')
    expect(within(card).getByText(miniApp), 'precondition: the legend names the Mini App slice').toBeInTheDocument()

    expect(await hoverSlice(card, 0)).toEqual({ name: miniApp, value: '12' })
  })

  it('revenue by currency: the currency, beside the amount', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AnalyticsPage />)
    await user.click(await screen.findByRole('tab', { name: i18n.t('analyticsPage.tabs.revenue') }))
    const title = i18n.t('analyticsPage.revenue.byCurrencyTitle')
    await screen.findByText(title)
    await waitFor(() => expect(donutCard(title).querySelectorAll('.recharts-pie-sector')).toHaveLength(2))

    expect(await hoverSlice(donutCard(title), 0)).toEqual({ name: 'RUB', value: '12.3K' })
  })

  it('subscriptions by plan: the plan, not the slice’s position in the list', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AnalyticsPage />)
    await user.click(await screen.findByRole('tab', { name: i18n.t('analyticsPage.tabs.revenue') }))
    const title = i18n.t('analyticsPage.revenue.byPlanTitle')
    await screen.findByText(title)
    await waitFor(() => expect(donutCard(title).querySelectorAll('.recharts-pie-sector')).toHaveLength(2))

    expect(await hoverSlice(donutCard(title), 1)).toEqual({ name: 'Basic', value: '8' })
  })
})
