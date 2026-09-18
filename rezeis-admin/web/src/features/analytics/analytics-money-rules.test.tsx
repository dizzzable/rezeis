/**
 * What the page says about how it counts, and whom it lets count at all:
 * which rule each figure follows, a partner's balance spend beside revenue
 * (never in it), a payer whose money has no rate, the note when the panel's
 * time zone could not be used — and the `analytics:view` gate in front of
 * every request, with the menu item that leads to it.
 */
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { canShowNavItem, navGroups } from '@/components/layout/admin-nav-config'
import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { holdsPermission, usePermissionStore } from '@/features/rbac/use-permission-store'
import { useAppearanceStore } from '@/lib/theme/appearance-store'
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
  weekPeriod,
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

const api = vi.mocked(analyticsApi)
const plain = (text: string | null | undefined): string => (text ?? '').replace(/\s/g, ' ')
let visibility: IntersectionObserverHarness | null = null

const grant = (granted: readonly string[], role = 'ADMIN'): void => {
  usePermissionStore.setState({ loaded: true, role, granted: new Set(granted) })
}

beforeAll(async () => {
  await i18nReady
  await i18n.changeLanguage('ru')
  await loadFeatureBundle('analytics')
})

beforeEach(() => {
  visibility = installIntersectionObserver()
  vi.clearAllMocks()
  grant(['analytics:view'])
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

function found<T extends Element>(selector: string): Promise<T> {
  return waitFor(() => {
    const element = document.querySelector<T>(selector)
    if (element === null) throw new Error(`nothing matches ${selector}`)
    return element
  })
}

describe('which rule a figure follows', () => {
  it('ends the (i) of a money figure with the money rule', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AnalyticsPage />)
    await user.hover(await screen.findByRole('button', { name: i18n.t('analyticsPage.common.aboutLabel', { title: 'Выручка' }) }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(i18n.t('analyticsPage.rules.money'))
  })

  it('names the rule of every figure: money for money, paid plans for subscriptions', async () => {
    renderWithProviders(<AnalyticsPage />)
    await found('[data-kpi="churn"]')
    const tiles = Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>('[data-kpi]')].map((tile) => [tile.dataset['kpi'], tile.dataset['kpiRule'] ?? null]),
    )
    expect(tiles).toEqual({
      revenue: 'money',
      payers: 'money',
      arppu: 'money',
      newUsers: null,
      activeSubscriptions: 'subscriptions',
      churn: 'subscriptions',
    })
    await found('[data-analytics-card="overview-providers"]')
    const cards = Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>('[data-analytics-card]')].map((card) => [card.dataset['analyticsCard'], card.dataset['analyticsRule'] ?? null]),
    )
    expect(cards).toMatchObject({
      'overview-revenue': 'money',
      'overview-new-subscriptions': 'money',
      'overview-funnel': 'money',
      'overview-providers': 'money',
    })
  })

  it('calls the subscriptions it counts «Платные подписки», and says how the dashboard’s number differs', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AnalyticsPage />)
    const tile = await found<HTMLElement>('[data-kpi="activeSubscriptions"]')
    expect(tile.textContent).toContain('Платные подписки')
    await user.hover(screen.getByRole('button', { name: i18n.t('analyticsPage.common.aboutLabel', { title: 'Платные подписки' }) }))
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('На «Дашборде» «Активные подписки» — другое число')
    expect(tip).toHaveTextContent(i18n.t('analyticsPage.rules.subscriptions'))
  })
})

describe('what the (i) of a figure admits about what it counts', () => {
  async function info(title: string): Promise<HTMLElement> {
    const user = userEvent.setup()
    await user.hover(await screen.findByRole('button', { name: i18n.t('analyticsPage.common.aboutLabel', { title }) }))
    return screen.findByRole('tooltip')
  }

  it('leaves subscriptions without a plan out of «Платные подписки», names where they come from, and admits what the comparison cannot see', async () => {
    renderWithProviders(<AnalyticsPage />)
    const tip = await info('Платные подписки')
    // A paid trial is paid (the owner's rule); the "+ N" beside the count is free trials only.
    expect(tip).toHaveTextContent('бесплатные пробные не входят. Платный пробный период считается с покупки')
    // Exactly what makes a trial paid: bought for more than nothing — a 100 % promo code makes it a free one.
    expect(tip).toHaveTextContent(
      'Пробный период входит, только если его купили больше чем за 0 ₽ — в том числе балансом партнёра; выданный бесплатно или взятый по промокоду на 100 % — бесплатный и сюда не входит.',
    )
    expect(tip).toHaveTextContent('как бы они ни были оплачены: картой, промокодом — даже на 100 %, — баллами или балансом партнёра.')
    const trials = overviewReport({}, 30).metrics.trialSubscriptions
    expect(document.querySelector('[data-kpi="activeSubscriptions"]')?.textContent).toContain(
      i18n.t('analyticsPage.kpi.trials', { count: trials }),
    )
    expect(i18n.t('analyticsPage.kpi.trials', { count: trials })).toContain('бесплатн')
    expect(tip).toHaveTextContent('Подписки без тарифа не входят — это перенесённые импортом из Remnawave, 3x-ui или другого бота')
    expect(tip).toHaveTextContent('«Клонировать тарифы» и «Назначить план всем» после импорта на странице «Импорты»')
    expect(tip).toHaveTextContent('из Remnawave или 3x-ui — со дня переноса')
    // The same two admissions, in the same words, as «Отток»: its previous value is rebuilt the same way.
    expect(tip).toHaveTextContent(i18n.t('analyticsPage.caveats.renewedLapse'))
    expect(tip).toHaveTextContent(i18n.t('analyticsPage.caveats.mergedDuplicate'))
    expect(i18n.t('analyticsPage.caveats.renewedLapse')).toContain('если клиент после перерыва продлил ту же подписку, перерыв не виден')
    expect(i18n.t('analyticsPage.caveats.mergedDuplicate')).toContain('«Слиянием подписок-дубликатов» на странице «Подписки»')
  })

  it('says the same of «Отток»', async () => {
    renderWithProviders(<AnalyticsPage />)
    const tip = await info('Отток')
    expect(tip).toHaveTextContent('Подписки без тарифа не входят')
    expect(tip).toHaveTextContent(i18n.t('analyticsPage.caveats.renewedLapse'))
    expect(tip).toHaveTextContent(i18n.t('analyticsPage.caveats.mergedDuplicate'))
  })

  it('defines a new subscription in the same words under «Новые подписки» and «Откуда деньги»: a paid trial is bought, its move to a plan is a change', async () => {
    const definition = i18n.t('analyticsPage.definitions.newSubscription')
    expect(definition).toBe('покупка новой подписки или ещё одной (в том числе платного пробного периода) или первая оплата после бесплатного пробного периода')
    renderWithProviders(<AnalyticsPage />)
    const counted = await info('Новые подписки по дням')
    expect(counted).toHaveTextContent(`Первые оплаты подписок: ${definition}. Каждая подписка считается один раз.`)
    expect(counted).toHaveTextContent('в том числе переход с платного пробного периода на обычный тариф')
    await openTab('revenue')
    const money = await info('Откуда деньги')
    expect(money).toHaveTextContent(`«Новые подписки» — ${definition}.`)
    expect(money).toHaveTextContent('«Смена тарифа» — переход на другой тариф у подписки, за которую уже платили, в том числе с платного пробного периода.')
  })

  it('starts trial → paid at a free trial only, and says a paid trial bought straight away is a paying customer', async () => {
    renderWithProviders(<AnalyticsPage />)
    await openTab('conversion')
    const tip = await info('Пробный → оплата')
    expect(tip).toHaveTextContent('начавших бесплатный пробный период (в том числе взятый по промокоду на 100 %)')
    expect(tip).toHaveTextContent('покупка платного пробного периода — тоже оплата')
    expect(tip).toHaveTextContent('Кто сразу купил платный пробный период, — не пробный, а платящий клиент и сюда не входит.')
  })
})

describe('a spend of a partner’s balance', () => {
  const spent = { figure: { value: 300, byCurrency: [{ currency: 'RUB', amount: 300 }] }, payments: 1 }
  const line = 'Оплачено балансом партнёра — не выручка: 300 ₽ · 1 платёж'

  it('is stated beside revenue on the overview and the revenue tab — never in it', async () => {
    api.getAnalyticsOverview.mockResolvedValue(overviewReport({ partnerBalance: spent }, 30))
    api.getRevenueReport.mockResolvedValue({ ...revenueReport(), partnerBalance: spent })
    renderWithProviders(<AnalyticsPage />)
    expect(plain((await found('[data-kpi="revenue"] [data-partner-balance]')).textContent)).toBe(line)
    // The revenue itself is the report's, untouched by the line.
    expect(plain(document.querySelector('[data-kpi="revenue"] [data-kpi-value]')?.textContent)).toBe('9,7 тыс. ₽')
    await openTab('revenue')
    expect(plain((await found('[data-analytics-card="revenue-summary"] [data-partner-balance]')).textContent)).toBe(line)
  })

  it('says nothing when nobody paid from a balance', async () => {
    renderWithProviders(<AnalyticsPage />)
    await found('[data-kpi="revenue"]')
    expect(document.querySelector('[data-partner-balance]')).toBeNull()
  })
})

describe('a payer whose money has no rate', () => {
  it('is shown in the currency paid, marked «нет курса» — never as 0 ₽ — and the note says where a rate is set', async () => {
    api.getTopPayers.mockResolvedValue({
      money: {
        currency: 'RUB',
        converted: true,
        rates: [{ currency: 'USDT', rate: 80, source: 'BINANCE+CBR', fetchedAt: '2026-09-18T09:00:00.000Z' }],
        unconverted: ['XTR'],
      },
      payers: [
        ...topPayersReport().payers,
        { userId: 'stars', telegramId: null, username: null, name: 'Звездочёт', totalSpent: null, spentByCurrency: [{ currency: 'XTR', amount: 3500 }], transactionCount: 2, lastPaymentAt: null },
      ],
    })
    renderWithProviders(<AnalyticsPage />)
    await openTab('leaderboard')
    const row = await found<HTMLElement>('[data-top-payer="stars"]')
    expect(plain(row.textContent)).toContain('3 500 XTR нет курса')
    expect(plain(row.textContent)).not.toContain('₽')
    expect(plain(document.querySelector('[data-analytics-money-note]')?.textContent)).toContain('POST /api/admin/advertising/fx-rates')
  })
})

describe('the time zone the days are counted in', () => {
  it('says so when the panel has no usable zone and the days are UTC days', async () => {
    api.getAnalyticsOverview.mockResolvedValue(overviewReport({ period: { ...weekPeriod(), timeZoneFallback: true } }, 30))
    renderWithProviders(<AnalyticsPage />)
    expect((await found('[data-analytics-zone-note]')).textContent).toBe(i18n.t('analyticsPage.zone.fallback'))
  })

  it('says nothing when the panel’s zone is used', async () => {
    renderWithProviders(<AnalyticsPage />)
    await found('[data-kpi="revenue"]')
    expect(document.querySelector('[data-analytics-zone-note]')).toBeNull()
  })
})

describe('who may see the page', () => {
  const requested = (): number =>
    Object.values(api).reduce((sum, fn) => sum + (typeof fn === 'function' && 'mock' in fn ? fn.mock.calls.length : 0), 0)

  it('asks for no report and says why when the viewer lacks analytics:view', async () => {
    grant(['users:view'])
    renderWithProviders(<AnalyticsPage />)
    expect(await screen.findByText(i18n.t('analyticsPage.access.denied'))).toBeInTheDocument()
    expect(screen.queryByRole('tab')).toBeNull()
    expect(requested()).toBe(0)
  })

  it('asks for nothing while the viewer’s rights are still loading', async () => {
    usePermissionStore.getState().reset()
    renderWithProviders(<AnalyticsPage />)
    await waitFor(() => expect(document.querySelector('[data-analytics-access="checking"]')).not.toBeNull())
    expect(requested()).toBe(0)
  })

  it('shows the reports to a viewer who holds it, and to a DEV', async () => {
    grant([], 'DEV')
    renderWithProviders(<AnalyticsPage />)
    await found('[data-kpi="revenue"]')
    expect(api.getAnalyticsOverview).toHaveBeenCalled()
  })

  it('hides the menu item from a viewer without it', () => {
    const item = navGroups.flatMap((group) => group.items).find((entry) => entry.key === 'analytics')
    expect(item).toBeDefined()
    const may = (granted: readonly string[]) => (resource: string, action: string) =>
      holdsPermission({ role: 'ADMIN', granted: new Set(granted) }, resource, action)
    expect(canShowNavItem(item!, true, may(['users:view']))).toBe(false)
    expect(canShowNavItem(item!, true, may(['analytics:view']))).toBe(true)
  })
})
