/**
 * The ring on the analytics page names the slice its tooltip points at.
 *
 * Two donuts on this page once handed recharts a formatter that returned
 * `[value, '']`. recharts 3 prints a tooltip item's name and the " : "
 * separator whenever the name is a string or a number, and `''` is a string,
 * so hovering a slice read " : 12" with nothing to say which slice it was. The
 * third passed no formatter, but its rows carried no `name`, and recharts then
 * names a slice by its index: "0 : 12".
 *
 * Those two donuts — revenue by currency and subscriptions by plan — are gone
 * (a single currency is now a summary, and plans are ranked bars that print
 * their own numbers); `analytics-page.test.tsx` holds the charts that replaced
 * them. The usage ring is still a ring, and still has to say which slice it is.
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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { usePermissionStore } from '@/features/rbac/use-permission-store'
import { installIntersectionObserver, renderWithProviders, type IntersectionObserverHarness } from '@/test/test-utils'

import {
  COHORTS,
  conversionReport,
  expiringReport,
  ltvReport,
  overviewReport,
  revenueReport,
  SUBSCRIPTIONS_BY_PLAN,
  SURFACES,
  topPayersReport,
} from './analytics-test-fixtures'

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
  getRevenueReport: vi.fn(),
  getTrialConversion: vi.fn(),
  getAnalyticsCohorts: vi.fn(),
  getExpiring: vi.fn(),
  getTopPayers: vi.fn(),
  getLtvDistribution: vi.fn(),
  getSubscriptionsByPlan: vi.fn(),
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
  usePermissionStore.getState().reset()
})

beforeEach(() => {
  visibility = installIntersectionObserver()
  vi.clearAllMocks()
  // The page is `analytics:view`; the viewer here holds it.
  usePermissionStore.setState({ loaded: true, role: 'ADMIN', granted: new Set(['analytics:view']) })
  api.getAnalyticsOverview.mockResolvedValue(overviewReport({}, 30))
  api.getRevenueReport.mockResolvedValue(revenueReport())
  api.getTrialConversion.mockResolvedValue(conversionReport())
  api.getAnalyticsCohorts.mockResolvedValue(COHORTS)
  api.getExpiring.mockResolvedValue(expiringReport())
  api.getTopPayers.mockResolvedValue(topPayersReport())
  api.getLtvDistribution.mockResolvedValue(ltvReport())
  api.getSubscriptionsByPlan.mockResolvedValue(SUBSCRIPTIONS_BY_PLAN)
  api.getSurfaceAnalytics.mockResolvedValue(SURFACES)
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

describe('analytics page rings — the tooltip says which slice it is', () => {
  it('usage surfaces: the slice’s surface, in the legend’s words, beside its count', async () => {
    renderWithProviders(<AnalyticsPage />)
    const title = i18n.t('analyticsPage.surfaces.panels.surface')
    await waitFor(() => expect(document.querySelectorAll('.recharts-pie-sector')).toHaveLength(2))
    const card = donutCard(title)
    const miniApp = i18n.t('analyticsPage.surfaces.surface.tma')
    expect(within(card).getByText(miniApp), 'precondition: the legend names the Mini App slice').toBeInTheDocument()

    expect(await hoverSlice(card, 0)).toEqual({ name: miniApp, value: '12' })
  })

  it('the rest of the page draws no ring at all: one currency is not a pie at 100 %', async () => {
    renderWithProviders(<AnalyticsPage />)
    await waitFor(() => expect(document.querySelectorAll('.recharts-pie-sector')).toHaveLength(2))
    // Both sectors are the usage ring's, inside its card.
    const ringCard = document.querySelector('[data-surface-panel="surface"]')
    expect(ringCard?.querySelectorAll('.recharts-pie-sector')).toHaveLength(2)
  })
})
