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
  autopayReport,
  COHORTS,
  installNewCardMocks,
  conversionReport,
  discountReport,
  expiringReport,
  firstPaymentLtvReport,
  ltvReport,
  overviewReport,
  paidCohortReport,
  paymentHoursReport,
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
  getPaidCohorts: vi.fn(),
  getAutopayReport: vi.fn(),
  getDiscountReport: vi.fn(),
  getPaidLtv: vi.fn(),
  getPaymentHours: vi.fn(),
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
  installNewCardMocks(api)
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

  it('states the share of paying clients with autopay, and what became of the ended periods in each group', async () => {
    renderWithProviders(<AnalyticsPage />)
    await openTab('retention')
    const card = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-analytics-card="retention-autopay"]')
      if (found === null || found.querySelector('[data-autopay]') === null) throw new Error('no autopay card')
      return found
    })
    expect(plain(card.querySelector('[data-autopay-share]')?.textContent)).toBe('40 %платящих клиентов с автоплатежом: 80 из 200')
    const outcomes = (group: string): string[] =>
      [...card.querySelectorAll(`[data-autopay-group="${group}"] [data-autopay-outcome]`)].map((row) => plain(row.textContent))
    // 70 periods ended with autopay on, 100 without.
    expect(outcomes('with')).toEqual([
      'Продлили до окончания86 % 60',
      'В первые 3 дня после8,6 % 6',
      'Через 4–30 дней4,3 % 3',
      'Не вернулись за 30 дней1,4 % 1',
    ])
    expect(outcomes('without')).toEqual([
      'Продлили до окончания20 % 20',
      'В первые 3 дня после10 % 10',
      'Через 4–30 дней30 % 30',
      'Не вернулись за 30 дней40 % 40',
    ])
    expect(plain(card.querySelector('[data-autopay-group="with"] h4')?.textContent)).toContain('С автоплатежом')
    expect(plain(card.querySelector('[data-autopay-group="with"] h4')?.textContent)).toContain('70 оплаченных сроков')
    expect(plain(card.querySelector('[data-autopay-group="without"] h4')?.textContent)).toContain('Без автоплатежа')
    expect(plain(card.querySelector('[data-autopay-footnote]')?.textContent)).toContain('Автоплатёж учтён на дату конца каждого срока')
  })

  it('draws each outcome’s bar as its share of the group', async () => {
    renderWithProviders(<AnalyticsPage />)
    await openTab('retention')
    const bars = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>('[data-autopay-group="without"] [data-autopay-outcome] [aria-hidden="true"] > div')]
      if (found.length !== 4) throw new Error('no bars')
      return found
    })
    expect(bars.map((bar) => bar.style.width)).toEqual(['20%', '10%', '30%', '40%'])
  })

  it('says which history autopay is read from, in the (i), and the window it compares', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AnalyticsPage />)
    await openTab('retention')
    await user.hover(await screen.findByRole('button', { name: i18n.t('analyticsPage.common.aboutLabel', { title: 'Автоплатёж' }) }))
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('закончились от 30 до 120 дней назад')
    expect(tip).toHaveTextContent('автоплатёж был включён на момент конца срока, а не сегодня')
  })

  it('says there is nothing to compare when no period ended in the window and nobody pays', async () => {
    api.getAutopayReport.mockResolvedValue({
      ...autopayReport(),
      payingClients: 0,
      withAutopay: 0,
      withAutopayPeriods: { early: 0, firstDays: 0, later: 0, gone: 0 },
      withoutAutopayPeriods: { early: 0, firstDays: 0, later: 0, gone: 0 },
    })
    renderWithProviders(<AnalyticsPage />)
    await openTab('retention')
    expect(await screen.findByText('Сравнивать пока нечего: ни один оплаченный срок не закончился от 30 до 120 дней назад.')).toBeTruthy()
  })

  it('puts the first-payment cohorts beside the registration ones, columns from month 1, a cell only once its date has come', async () => {
    renderWithProviders(<AnalyticsPage />)
    await openTab('retention')
    const table = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-cohort-kind="first-payment"]')
      if (found === null) throw new Error('no first-payment table')
      return found
    })
    expect([...table.querySelectorAll('thead th [aria-hidden="true"]')].map((head) => head.textContent)).toEqual(
      Array.from({ length: 12 }, (_, index) => String(index + 1)),
    )
    const august = table.querySelector<HTMLElement>('[data-cohort="2026-08"]')
    expect(plain(august?.querySelector('th')?.textContent)).toBe('авг. 2026 г.')
    expect(plain(august?.querySelector('td')?.textContent)).toBe('80')
    const cells = [...(august?.querySelectorAll<HTMLElement>('[data-cohort-cell]') ?? [])]
    expect(cells.map((cell) => plain(cell.textContent))).toEqual(['75 %', '50 %'])
    expect(cells.map((cell) => cell.getAttribute('data-cohort-cell'))).toEqual(['1', '2'])
    // 80 % (July, month 1) is the strongest cell of the table.
    expect(cells[0]?.style.backgroundColor).toBe(heatColor(0.75 / 0.8))
    // September's clients have no date behind them yet: a row with no cell at all.
    expect(table.querySelector('[data-cohort="2026-09"] [data-cohort-cell]')).toBeNull()
    expect(table.querySelectorAll('[data-cohort="2026-07"] [data-cohort-cell]')).toHaveLength(3)
  })

  it('says in plain words what the registration table counts, and what the first-payment one counts instead', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AnalyticsPage />)
    await openTab('retention')
    await waitFor(() => expect(document.querySelector('[data-cohort-kind="first-payment"]')).not.toBeNull())
    const registration = document.querySelector('[data-analytics-card="retention-cohorts"]')
    expect(plain(registration?.textContent)).toContain('считаются месяцы с оплатой, а не оплаченные месяцы')
    await user.hover(screen.getByRole('button', { name: i18n.t('analyticsPage.common.aboutLabel', { title: 'Удержание по месяцам регистрации' }) }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Считаются месяцы, в которых была оплата, а не оплаченные месяцы')
    const paid = document.querySelector('[data-analytics-card="retention-paid-cohorts"]')
    expect(plain(paid?.textContent)).toContain('Удержание по месяцу первой оплаты')
  })

  it('says it has no first payments to follow when there are none', async () => {
    api.getPaidCohorts.mockResolvedValue({ ...paidCohortReport(), cohorts: paidCohortReport().cohorts.map((row) => ({ ...row, cohortSize: 0, retentionByMonth: [] })) })
    renderWithProviders(<AnalyticsPage />)
    await openTab('retention')
    expect(await screen.findByText('За последние 12 месяцев никто не оплатил подписку впервые.')).toBeTruthy()
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

describe('revenue by plan and term', () => {
  async function card(): Promise<HTMLElement> {
    renderWithProviders(<AnalyticsPage />)
    await openTab('revenue')
    return waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-analytics-card="revenue-plans"]')
      if (found === null || found.querySelector('[data-ranked-row]') === null) throw new Error('no plans card')
      return found
    })
  }

  it('names each row by its plan and its term: whole months as «1 мес», other terms in days', async () => {
    const found = await card()
    const rows = [...found.querySelectorAll('[data-ranked-row]')].map((row) => [row.getAttribute('data-ranked-row'), plain(row.querySelector('.break-words')?.textContent)])
    expect(rows).toEqual([
      ['plan:p1:30', 'Pro · 1 мес'],
      ['plan:p2:30', 'Basic · 1 мес'],
      ['plan:p1:90', 'Pro · 3 мес'],
      ['plan:p2:45', 'Basic · 45 дн.'],
      ['other', 'Прочее'],
      ['addon:EXTRA_TRAFFIC', 'Дополнения: трафик'],
    ])
  })

  it('names every kind of add-on and a lifetime term in the list', async () => {
    const base = revenueReport()
    const money = (value: number) => ({ value, byCurrency: [{ currency: 'RUB', amount: value }] })
    api.getRevenueReport.mockResolvedValue({
      ...base,
      byPlan: [
        { key: 'plan:p1:-1', kind: 'plan', planId: 'p1', name: 'Pro', days: -1, addOnType: null, figure: money(900), payments: 1 },
        { key: 'addon:EXTRA_DEVICES', kind: 'addon', planId: null, name: null, days: null, addOnType: 'EXTRA_DEVICES', figure: money(80), payments: 1 },
        { key: 'addon:RESET_TRAFFIC', kind: 'addon', planId: null, name: null, days: null, addOnType: 'RESET_TRAFFIC', figure: money(60), payments: 1 },
        { key: 'addon:', kind: 'addon', planId: null, name: null, days: null, addOnType: null, figure: money(40), payments: 1 },
        { key: 'none', kind: 'none', planId: null, name: null, days: null, addOnType: null, figure: money(20), payments: 1 },
      ],
    })
    const found = await card()
    const labels = [...found.querySelectorAll('[data-ranked-row] .break-words')].map((label) => plain(label.textContent))
    expect(labels).toEqual(['Pro · Бессрочно', 'Дополнения: устройства', 'Дополнения: сброс трафика', 'Дополнения', 'Без тарифа'])
  })

  it('shows a table of every row with plan, term, payments and revenue', async () => {
    const user = userEvent.setup()
    const found = await card()
    await user.click(within(found).getByRole('button', { name: i18n.t('analyticsPage.common.showTable') }))
    const rows = [...found.querySelectorAll('[data-analytics-table] tbody tr')].map((row) => [...row.querySelectorAll('td')].map((cell) => plain(cell.textContent)))
    expect(rows[0]).toEqual(['Pro', '1 мес', '7', '3 500 ₽'])
    expect(rows[3]).toEqual(['Basic', '45 дн.', '2', '500 ₽'])
    expect(rows[4]).toEqual(['Прочее', '—', '1', '500 ₽'])
    expect(rows).toHaveLength(6)
  })

  it('tells in the (i) what a row is, what «Прочее» holds and how an add-on is split', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AnalyticsPage />)
    await openTab('revenue')
    await user.hover(await screen.findByRole('button', { name: i18n.t('analyticsPage.common.aboutLabel', { title: 'Выручка по тарифам' }) }))
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('строка — тариф и срок')
    expect(tip).toHaveTextContent('трафик, устройства, сброс трафика')
    expect(tip).toHaveTextContent('«Прочее» — тарифы вне общего каталога, с доступностью «Разрешённые»')
  })
})

describe('the payment hours card', () => {
  async function card(): Promise<HTMLElement> {
    renderWithProviders(<AnalyticsPage />)
    await openTab('revenue')
    return waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-analytics-card="revenue-hours"]')
      if (found === null || found.querySelector('[data-hours]') === null) throw new Error('no hours card')
      return found
    })
  }

  it('draws a row per weekday and a column per hour, 168 cells with their counts', async () => {
    const found = await card()
    expect(found.querySelectorAll('[data-hours-weekday]')).toHaveLength(7)
    expect(found.querySelectorAll('[data-hours-cell]')).toHaveLength(168)
    expect(found.querySelector('[data-hours-cell="5-20"]')?.getAttribute('data-count')).toBe('15')
    expect(found.querySelector('[data-hours-cell="3-3"]')?.getAttribute('data-count')).toBe('0')
    expect(found.querySelectorAll('thead th [aria-hidden="true"]')).toHaveLength(24)
  })

  it('names the three busiest hours in the subtitle', async () => {
    const found = await card()
    expect(plain(found.textContent)).toContain('Чаще всего платят в 19:00, 20:00 и 12:00 (по часовому поясу панели).')
  })

  it('shades each cell relative to the busiest one, and gives an empty cell the faintest tint', async () => {
    const found = await card()
    const colour = (key: string): string | undefined => found.querySelector<HTMLElement>(`[data-hours-cell="${key}"]`)?.style.backgroundColor
    expect(colour('5-20')).toBe(heatColor(1))
    expect(colour('1-20')).toBe(heatColor(10 / 15))
    expect(colour('3-3')).toBe(heatColor(0))
  })

  it('labels every cell for a screen reader with its day, hour and count', async () => {
    const found = await card()
    expect(plain(found.querySelector('[data-hours-cell="5-20"]')?.textContent)).toBe('пятница, 20:00: 15 платежей')
    expect(plain(found.querySelector('[data-hours-cell="7-9"]')?.textContent)).toBe('воскресенье, 09:00: 6 платежей')
  })

  it('says what it left out, and how many', async () => {
    const found = await card()
    const note = plain(found.querySelector('[data-hours-footnote]')?.textContent)
    expect(note).toContain('Автоматические списания не учтены')
    expect(note).toContain('Не вошло автоматических списаний за период: 7.')
  })

  it('keeps the grid’s scroll inside the card so a phone does not widen', async () => {
    const found = await card()
    const scroller = found.querySelector('[data-hours-table]')?.parentElement
    expect(scroller?.className).toContain('overflow-x-auto')
  })

  it('says nobody paid in the period, and still says how many automatic charges were left out', async () => {
    api.getPaymentHours.mockResolvedValue({ ...paymentHoursReport(), total: 0, cells: Array.from({ length: 168 }, () => 0), topHours: [] })
    renderWithProviders(<AnalyticsPage />)
    await openTab('revenue')
    expect(await screen.findByText('За период клиенты не сделали ни одного платежа.')).toBeTruthy()
    expect(plain(document.querySelector('[data-hours-footnote]')?.textContent)).toContain('7')
  })

  it('defines what it counts in its (i): payments by number, and not the automatic ones', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AnalyticsPage />)
    await openTab('revenue')
    await user.hover(await screen.findByRole('button', { name: i18n.t('analyticsPage.common.aboutLabel', { title: 'Когда платят' }) }))
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('штуками, а не суммой')
    expect(tip).toHaveTextContent('Автоматические списания не считаются')
  })
})

describe('the discounts card', () => {
  async function discountsCard(): Promise<HTMLElement> {
    renderWithProviders(<AnalyticsPage />)
    await openTab('revenue')
    return waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-analytics-card="revenue-discounts"]')
      if (found === null || found.querySelector('[data-discounts]') === null) throw new Error('no discounts card')
      return found
    })
  }

  it('states the share of purchases with a discount and the average discount', async () => {
    const card = await discountsCard()
    expect(plain(card.querySelector('[data-discounts-share]')?.textContent)).toBe('40 %')
    expect(plain(card.querySelector('[data-discounts-header]')?.textContent)).toContain('12 из 30')
    expect(plain(card.querySelector('[data-discounts-average]')?.textContent)).toBe('25 %')
  })

  it('lists the size buckets, and leaves the 1-9 % one out while nobody is in it', async () => {
    const card = await discountsCard()
    const rows = [...card.querySelectorAll('[data-discount-bucket]')].map((row) => plain(row.textContent))
    expect(rows).toEqual(['10–19 %5 42 %', '20–29 %3 25 %', '30–39 %2 17 %', '40–49 %0 0 %', '50 % и больше2 17 %'])
  })

  it('shows the 1-9 % bucket once a purchase falls in it', async () => {
    const report = discountReport()
    api.getDiscountReport.mockResolvedValue({
      ...report,
      buckets: report.buckets.map((bucket, index) => (index === 0 ? { ...bucket, purchases: 1 } : bucket)),
    })
    const card = await discountsCard()
    expect(plain(card.querySelector('[data-discount-bucket="1"]')?.textContent)).toBe('1–9 %1 8,3 %')
  })

  it('asks whether they buy again for first purchases with and without a discount, and states the full-price share', async () => {
    const card = await discountsCard()
    expect(plain(card.querySelector('[data-discounts-first="discount"]')?.textContent)).toBe('Первая покупка со скидкой40 % купили снова: 4 из 10')
    expect(plain(card.querySelector('[data-discounts-first="full"]')?.textContent)).toBe('Первая покупка без скидки60 % купили снова: 12 из 20')
    expect(plain(card.querySelector('[data-discounts-footnote]')?.textContent)).toBe(
      'Из тех, кто купил снова после первой покупки со скидкой, второй раз полную цену заплатили 75 % (3 из 4).',
    )
  })

  it('says how many purchases it could not price', async () => {
    const card = await discountsCard()
    expect(plain(card.querySelector('[data-discounts-unknown]')?.textContent)).toContain('2 покупки не вошли в цифры')
  })

  it('says it has nothing to compare when no purchase has a price', async () => {
    api.getDiscountReport.mockResolvedValue({ ...discountReport(), purchases: 0, discounted: 0, averageDiscount: null })
    renderWithProviders(<AnalyticsPage />)
    await openTab('revenue')
    expect(await screen.findByText('За период не было покупок подписки, цену которых есть с чем сравнить.')).toBeTruthy()
  })

  it('defines a discount in its (i): against the list price, with no fee and no conversion', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AnalyticsPage />)
    await openTab('revenue')
    await user.hover(await screen.findByRole('button', { name: i18n.t('analyticsPage.common.aboutLabel', { title: 'Промокоды и скидки' }) }))
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('Скидка — разница между прайсом и уплаченной суммой')
    expect(tip).toHaveTextContent('Комиссия платёжной системы и пересчёт валюты скидкой не считаются')
    expect(tip).toHaveTextContent('«по старой цене»')
  })
})

describe('the value of customers by month of first payment', () => {
  async function card(): Promise<HTMLElement> {
    renderWithProviders(<AnalyticsPage />)
    await openTab('retention')
    return waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-analytics-card="retention-paid-ltv"]')
      if (found === null || found.querySelector('[data-paid-ltv-stats]') === null) throw new Error('no paid LTV card')
      return found
    })
  }

  it('states the mean and median over all of those customers, in the currency of the report', async () => {
    const found = await card()
    expect(plain(found.querySelector('[data-paid-ltv-stats]')?.textContent)).toBe('Клиентов160В среднем1 231 ₽Медиана950 ₽')
  })

  it('draws a pair of bars per month, one for the mean and one for the median, and names both in a legend', async () => {
    const found = await card()
    await waitFor(() => expect(found.querySelectorAll('.recharts-bar').length).toBe(2))
    expect([...found.querySelectorAll('[data-analytics-legend] li')].map((item) => plain(item.textContent))).toEqual(['В среднем', 'Медиана'])
    expect(found.querySelectorAll('.recharts-bar-rectangle').length).toBe(6)
  })

  it('says under the chart that the newest months have not had time to pay', async () => {
    const found = await card()
    expect(plain(found.querySelector('[data-paid-ltv-footnote]')?.textContent)).toBe('Клиенты свежих месяцев ещё не успели накопить сумму.')
  })

  it('has a table of the months with their customers, mean and median', async () => {
    const user = userEvent.setup()
    const found = await card()
    await user.click(within(found).getByRole('button', { name: i18n.t('analyticsPage.common.showTable') }))
    const rows = [...found.querySelectorAll('[data-analytics-table] tbody tr')].map((row) => [...row.querySelectorAll('td')].map((cell) => plain(cell.textContent)))
    expect(rows).toEqual([
      ['июль 2026 г.', '50', '1 800 ₽', '1 200 ₽'],
      ['авг. 2026 г.', '80', '1 100 ₽', '900 ₽'],
      ['сент. 2026 г.', '30', '450 ₽', '400 ₽'],
    ])
  })

  it('says nobody paid for the first time when nobody did', async () => {
    api.getPaidLtv.mockResolvedValue({ ...firstPaymentLtvReport(), clients: 0, mean: null, median: null, rows: [] })
    renderWithProviders(<AnalyticsPage />)
    await openTab('retention')
    expect(await screen.findByText('За последние 12 месяцев никто не оплатил впервые.')).toBeTruthy()
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
