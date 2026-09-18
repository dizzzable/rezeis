/**
 * What the other tabs print: the payment systems' outcomes, the subscriptions
 * to win back, the cohort heatmap, the durations to the first payment and the
 * leaderboard — read off the page the way the operator reads it.
 */
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { usePermissionStore } from '@/features/rbac/use-permission-store'
import { useAppearanceStore } from '@/lib/theme/appearance-store'
import { installIntersectionObserver, renderWithProviders, type IntersectionObserverHarness } from '@/test/test-utils'

import { ACCENT, currencyColor, funnelColor, heatColor, OTHER_COLOR } from './analytics-palette'
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
import { SURFACE_HUES } from './surface-palette'

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

const api = vi.mocked(analyticsApi)
const plain = (text: string | null | undefined): string => (text ?? '').replace(/\s/g, ' ')
let visibility: IntersectionObserverHarness | null = null

beforeAll(async () => {
  await i18nReady
  await i18n.changeLanguage('ru')
  await loadFeatureBundle('analytics')
})

beforeEach(() => {
  visibility = installIntersectionObserver()
  vi.clearAllMocks()
  // The page is `analytics:view`; the viewer here holds it.
  usePermissionStore.setState({ loaded: true, role: 'ADMIN', granted: new Set(['analytics:view']) })
  // Still, so every chart and bar is drawn finished from the first frame.
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

async function openTab(name: string): Promise<void> {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('tab', { name: i18n.t(`analyticsPage.tabs.${name}`) }))
}

describe('the overview', () => {
  it('rates a payment system on its decided attempts, drawn paid | canceled | failed', async () => {
    renderWithProviders(<AnalyticsPage />)
    const row = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-provider="YOOKASSA"]')
      if (found === null) throw new Error('no YooKassa row')
      return found
    })
    expect(plain(row.textContent)).toContain('YooKassa')
    expect(plain(row.textContent)).toContain('79 % успешных')
    // A refund does not undo a checkout that went through: it stays in «оплачено», and is said apart.
    expect(plain(row.textContent)).toContain('оплачено 23 · отменено 4 · с ошибкой 2 · из оплаченных возвращено 2 · ещё 1 ждёт оплаты')
    // The grey stands between the green and the red (see OUTCOME_COLORS).
    const segments = [...row.querySelectorAll<HTMLElement>('[aria-hidden="true"] > div')].map((segment) => segment.style.flexGrow)
    expect(segments).toEqual(['23', '4', '2'])
  })

  it('walks the funnel step by step, each step a share of the one before', async () => {
    renderWithProviders(<AnalyticsPage />)
    await waitFor(() => expect(document.querySelectorAll('[data-funnel-step]')).toHaveLength(4))
    const conversions = [...document.querySelectorAll('[data-funnel-conversion]')].map((line) => plain(line.textContent))
    expect(conversions).toEqual(['↓ 70 % от предыдущего шага', '↓ 43 % от предыдущего шага', '↓ 33 % от предыдущего шага'])
    expect(plain(document.querySelector('[data-funnel-step="paid"]')?.textContent)).toContain('Оплатили')
  })
})

describe('the retention tab', () => {
  it('puts the subscriptions nobody will charge first, with their totals', async () => {
    renderWithProviders(<AnalyticsPage />)
    await openTab('retention')
    await waitFor(() => expect(document.querySelectorAll('[data-expiring-segment]')).toHaveLength(3))
    const totals = [...document.querySelectorAll('[data-expiring-segment]')].map((item) => plain(item.textContent))
    expect(totals).toEqual(['6 Без автоплатежа', '2 С автоплатежом', '4 Пробные'])
  })

  it('prints every cohort cell’s share on a tint of the accent, relative to the strongest cell', async () => {
    renderWithProviders(<AnalyticsPage />)
    await openTab('retention')
    const august = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-cohort="2026-08"]')
      if (found === null) throw new Error('no August cohort')
      return found
    })
    expect(plain(august.querySelector('th')?.textContent)).toBe('авг. 2026 г.')
    const cells = [...august.querySelectorAll<HTMLElement>('[data-cohort-cell]')]
    expect(cells.map((cell) => plain(cell.textContent))).toEqual(['50 %', '25 %'])
    // 50 % is the strongest cell of the table: the cap of 80 %.
    expect(cells[0]?.style.backgroundColor).toBe(heatColor(1))
    expect(cells[1]?.style.backgroundColor).toBe(heatColor(0.5))
  })

  it('states the lifetime value’s median and top decile in the currency of the report', async () => {
    renderWithProviders(<AnalyticsPage />)
    await openTab('retention')
    const stats = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-ltv-stats]')
      if (found === null) throw new Error('no LTV stats')
      return found
    })
    expect(plain(stats.textContent)).toContain('Медиана499 ₽')
    expect(plain(stats.textContent)).toContain('10 % лучших — от1 490 ₽')
  })
})

describe('the conversion tab', () => {
  it('bins the time to the first payment in its own order, with counts and shares', async () => {
    renderWithProviders(<AnalyticsPage />)
    await openTab('conversion')
    const card = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-analytics-card="conversion-first-payment"]')
      if (found === null || found.querySelector('[data-ranked-row]') === null) throw new Error('no first-payment bins yet')
      return found
    })
    const rows = [...card.querySelectorAll('[data-ranked-row]')].map((row) => plain(row.textContent))
    expect(rows).toEqual([
      'В первые сутки 5 42 %',
      '1–3 дня 3 25 %',
      '4–7 дней 2 17 %',
      '8–14 дней 1 8,3 %',
      '15–30 дней 0 0 %',
      'Больше 30 дней 1 8,3 %',
    ])
    expect(plain(card.textContent)).toContain('Медиана — 2 дня.')
    expect(plain(document.querySelector('[data-kpi="medianDays"] [data-kpi-value]')?.textContent)).toBe('4,5 дня')
  })
})

describe('the leaderboard', () => {
  afterEach(() => usePermissionStore.getState().reset())

  it('links a payer to their page, and names a nameless one', async () => {
    usePermissionStore.setState({ loaded: true, role: 'ADMIN', granted: new Set(['analytics:view', 'users:view']) })
    renderWithProviders(<AnalyticsPage />)
    await openTab('leaderboard')
    const table = await screen.findByRole('table')
    const link = within(table).getByRole('link', { name: 'Кит' })
    expect(link).toHaveAttribute('href', '/users/1001')
    expect(within(table).getByText('Без имени')).toBeInTheDocument()
    expect(plain(document.querySelector('[data-top-payer="u1"]')?.textContent)).toContain('12 000 ₽')
  })

  it('names a payer without a link for a viewer who may not open customers', async () => {
    usePermissionStore.setState({ loaded: true, role: 'ADMIN', granted: new Set(['analytics:view']) })
    renderWithProviders(<AnalyticsPage />)
    await openTab('leaderboard')
    const table = await screen.findByRole('table')
    expect(within(table).getByText('Кит')).toBeInTheDocument()
    expect(within(table).queryAllByRole('link')).toEqual([])
  })
})

describe('the palette follows the entity, never its rank', () => {
  it('gives each named currency its own hue and folds the rest into the neutral', () => {
    expect(currencyColor('RUB')).toBe(SURFACE_HUES.blue)
    expect(currencyColor('USDT')).toBe(SURFACE_HUES.sky)
    expect(currencyColor('BTC')).toBe(OTHER_COLOR)
  })

  it('steps the funnel from the accent toward the theme’s anchor, and tints nothing for zero', () => {
    expect(funnelColor(0)).toBe(ACCENT)
    expect(funnelColor(3)).toContain(' 51%')
    expect(heatColor(0)).toBe('transparent')
    expect(heatColor(1)).toContain(' 80%')
  })
})
