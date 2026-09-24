/**
 * «Откуда деньги» and money withheld for refund.
 *
 * A withheld payment — COMPLETED, applied to nothing, due back to the payer —
 * counts in the revenue until its refund takes it out; the card filed it under
 * «Новые подписки» or «Продления» as if it had bought something. It has a row
 * of its own now, «Не применён (к возврату)», shown only while the window
 * holds some, and the card's (i) says what it is.
 */
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { usePermissionStore } from '@/features/rbac/use-permission-store'
import { useAppearanceStore } from '@/lib/theme/appearance-store'
import { installIntersectionObserver, renderWithProviders, type IntersectionObserverHarness } from '@/test/test-utils'

import type { RevenueReport } from './analytics-api'
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
    ResponsiveContainer: ({ children }: { children: ReactNode }) =>
      isValidElement(children)
        ? cloneElement(children as ReactElement<{ width?: number; height?: number }>, { width: 640, height: 240 })
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
import { revenueKindsOf } from './analytics-revenue-kinds'

const api = vi.mocked(analyticsApi)
let visibility: IntersectionObserverHarness | null = null

/** The fixture's week with 370 ₽ of it withheld for refund, in two payments. */
function withheldReport(): RevenueReport {
  const base = revenueReport()
  return {
    ...base,
    series: base.series.map((point, index) =>
      index === 3 ? { ...point, byKind: { ...point.byKind, new: point.byKind.new - 370, withheld: 370 } } : point,
    ),
    byKind: base.byKind.map((kind) =>
      kind.kind === 'withheld'
        ? { kind: 'withheld', figure: { value: 370, byCurrency: [{ currency: 'RUB', amount: 370 }] }, payments: 2 }
        : kind.kind === 'new'
          ? { ...kind, figure: { value: kind.figure.value - 370, byCurrency: [{ currency: 'RUB', amount: kind.figure.value - 370 }] }, payments: kind.payments - 2 }
          : kind,
    ),
  }
}

function legend(): HTMLElement {
  const found = document.querySelector('[data-kind-legend]')
  if (!(found instanceof HTMLElement)) throw new Error('no kinds legend')
  return found
}

async function openRevenue(): Promise<void> {
  const user = userEvent.setup()
  renderWithProviders(<AnalyticsPage />)
  await user.click(await screen.findByRole('tab', { name: i18n.t('analyticsPage.tabs.revenue') }))
  await waitFor(() => expect(document.querySelector('[data-kind-legend]')).not.toBeNull())
}

beforeAll(async () => {
  await i18nReady
  await i18n.changeLanguage('ru')
  await loadFeatureBundle('analytics')
})

beforeEach(() => {
  visibility = installIntersectionObserver()
  vi.clearAllMocks()
  usePermissionStore.setState({ loaded: true, role: 'ADMIN', granted: new Set(['analytics:view']) })
  useAppearanceStore.setState({ animationsEnabled: false })
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

afterEach(() => {
  visibility?.restore()
  visibility = null
  useAppearanceStore.setState({ animationsEnabled: true })
  usePermissionStore.getState().reset()
})

describe('which kinds «Откуда деньги» shows', () => {
  it('the four, while nothing is withheld — and from a server that does not send the row', () => {
    expect(revenueKindsOf(revenueReport())).toEqual(['new', 'renewal', 'change', 'addon'])
    expect(revenueKindsOf({ byKind: revenueReport().byKind.filter((kind) => kind.kind !== 'withheld') })).toEqual([
      'new',
      'renewal',
      'change',
      'addon',
    ])
  })

  it('a fifth row for money withheld for refund, while the window holds some', () => {
    expect(revenueKindsOf(withheldReport())).toEqual(['new', 'renewal', 'change', 'addon', 'withheld'])
    // A payment of a currency without a rate has no value, and is still a payment.
    expect(
      revenueKindsOf({
        byKind: [{ kind: 'withheld', figure: { value: 0, byCurrency: [{ currency: 'XTR', amount: 50 }] }, payments: 1 }],
      }),
    ).toEqual(['new', 'renewal', 'change', 'addon', 'withheld'])
  })
})

describe('the card', () => {
  it('lists «Не применён (к возврату)» with its money beside the four kinds', async () => {
    api.getRevenueReport.mockResolvedValue(withheldReport())
    await openRevenue()

    const withheld = legend().querySelector('[data-kind="withheld"]')
    expect(withheld).not.toBeNull()
    expect(withheld).toHaveTextContent('Не применён (к возврату)')
    expect(withheld).toHaveTextContent(/370/)
    expect([...legend().querySelectorAll('[data-kind]')].map((item) => item.getAttribute('data-kind'))).toEqual([
      'new',
      'renewal',
      'change',
      'addon',
      'withheld',
    ])
  })

  it('shows no such row while nothing is withheld', async () => {
    await openRevenue()

    expect(legend().querySelector('[data-kind="withheld"]')).toBeNull()
    expect(screen.queryByText('Не применён (к возврату)')).not.toBeInTheDocument()
  })

  it('says in its (i) what the row is and that a refund takes the payment out', async () => {
    const user = userEvent.setup()
    api.getRevenueReport.mockResolvedValue(withheldReport())
    await openRevenue()

    await user.hover(screen.getByRole('button', { name: i18n.t('analyticsPage.common.aboutLabel', { title: 'Откуда деньги' }) }))

    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('«Не применён (к возврату)» — деньги, которые пришли, но ничего клиенту не дали')
    expect(tooltip).toHaveTextContent('после возврата платёж уходит из выручки')
  })
})
