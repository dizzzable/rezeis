/**
 * «Бизнес-аналитика» as the operator sees it: the period in words, KPI tiles
 * that say how the period compares with the one before, money in one
 * currency, charts that stay still when asked to, and honest empty states.
 *
 * Real Recharts is rendered at a fixed size; Bar, Line and Tooltip are
 * recorded on the way in, so a test can ask what every series was TOLD — its
 * name, whether to animate — and read what a tooltip would print.
 */
import { cloneElement, type ComponentProps, isValidElement, type ReactElement, type ReactNode } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { usePermissionStore } from '@/features/rbac/use-permission-store'
import { useAppearanceStore } from '@/lib/theme/appearance-store'
import { installIntersectionObserver, renderWithProviders, type IntersectionObserverHarness } from '@/test/test-utils'

import { StackSegment } from './analytics-chart-kit'
import {
  COHORTS,
  conversionReport,
  emptyOverviewReport,
  emptyRevenueReport,
  expiringReport,
  ltvReport,
  overviewReport,
  revenueReport,
  ROUBLES_AND_USDT,
  SUBSCRIPTIONS_BY_PLAN,
  SURFACES,
  topPayersReport,
} from './analytics-test-fixtures'

interface RecordedSeries {
  readonly kind: 'bar' | 'line'
  readonly name: unknown
  readonly dataKey: unknown
  readonly isAnimationActive: unknown
}

const recorded = vi.hoisted(() => ({
  series: [] as RecordedSeries[],
  tooltips: [] as Array<(props: Record<string, unknown>) => ReactNode>,
}))

vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>()
  return {
    ...actual,
    Bar: (props: ComponentProps<typeof actual.Bar>) => {
      recorded.series.push({ kind: 'bar', name: props.name, dataKey: props.dataKey, isAnimationActive: props.isAnimationActive })
      return <actual.Bar {...props} />
    },
    Line: (props: ComponentProps<typeof actual.Line>) => {
      recorded.series.push({ kind: 'line', name: props.name, dataKey: props.dataKey, isAnimationActive: props.isAnimationActive })
      return <actual.Line {...props} />
    },
    Tooltip: (props: ComponentProps<typeof actual.Tooltip>) => {
      if (typeof props.content === 'function') recorded.tooltips.push(props.content as (props: Record<string, unknown>) => ReactNode)
      return <actual.Tooltip {...props} />
    },
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
const realMatchMedia = window.matchMedia
let visibility: IntersectionObserverHarness | null = null

function prefersReducedMotion(reduce: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}

beforeAll(async () => {
  await i18nReady
  await i18n.changeLanguage('ru')
  await loadFeatureBundle('analytics')
})

beforeEach(() => {
  recorded.series.length = 0
  recorded.tooltips.length = 0
  visibility = installIntersectionObserver()
  // The page is `analytics:view`; the viewer here holds it.
  usePermissionStore.setState({ loaded: true, role: 'ADMIN', granted: new Set(['analytics:view']) })
  vi.clearAllMocks()
  useAppearanceStore.setState({ animationsEnabled: true })
  prefersReducedMotion(false)
  api.getAnalyticsOverview.mockImplementation((days: number) => Promise.resolve(overviewReport({}, days)))
  api.getRevenueReport.mockResolvedValue(revenueReport())
  api.getTrialConversion.mockResolvedValue(conversionReport())
  api.getAnalyticsCohorts.mockResolvedValue(COHORTS)
  api.getExpiring.mockResolvedValue(expiringReport())
  api.getTopPayers.mockResolvedValue(topPayersReport())
  api.getLtvDistribution.mockResolvedValue(ltvReport())
  api.getSubscriptionsByPlan.mockResolvedValue(SUBSCRIPTIONS_BY_PLAN)
  api.getSurfaceAnalytics.mockResolvedValue(SURFACES)
})

afterEach(async () => {
  visibility?.restore()
  visibility = null
  window.matchMedia = realMatchMedia
  usePermissionStore.getState().reset()
  if (i18n.language !== 'ru') {
    await i18n.changeLanguage('ru')
    await loadFeatureBundle('analytics')
  }
})

const kpi = (id: string): HTMLElement => {
  const tile = document.querySelector<HTMLElement>(`[data-kpi="${id}"]`)
  if (tile === null) throw new Error(`no KPI tile "${id}"`)
  return tile
}

async function openTab(name: string): Promise<void> {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('tab', { name: i18n.t(`analyticsPage.tabs.${name}`) }))
}

describe('the period buttons', () => {
  it('read «7 дней / 30 дней / 90 дней / Год» and change the period of the overview', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AnalyticsPage />)
    const group = await screen.findByRole('group', { name: 'Период' })
    expect(within(group).getAllByRole('button').map((button) => plain(button.textContent))).toEqual(['7 дней', '30 дней', '90 дней', 'Год'])
    expect(within(group).getByRole('button', { name: '30 дней' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(within(group).getByRole('button', { name: '90 дней' }))

    await waitFor(() => expect(api.getAnalyticsOverview).toHaveBeenLastCalledWith(90))
    expect(within(group).getByRole('button', { name: '90 дней' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('read «7 days … Year» to an English operator', async () => {
    await i18n.changeLanguage('en')
    await loadFeatureBundle('analytics')
    renderWithProviders(<AnalyticsPage />)
    const group = await screen.findByRole('group', { name: 'Period' })
    expect(within(group).getAllByRole('button').map((button) => button.textContent)).toEqual(['7 days', '30 days', '90 days', 'Year'])
  })

  it('give way to a note on a tab the period does not apply to', async () => {
    renderWithProviders(<AnalyticsPage />)
    await screen.findByRole('group', { name: 'Период' })
    await openTab('retention')
    expect(screen.queryByRole('group', { name: 'Период' })).toBeNull()
    expect(document.querySelector('[data-analytics-period-note]')?.textContent).toBe(i18n.t('analyticsPage.periods.independent.retention'))
  })
})

describe('the KPI tiles', () => {
  it('state revenue in compact Russian money with its change against the previous week', async () => {
    renderWithProviders(<AnalyticsPage />)
    await waitFor(() => expect(document.querySelector('[data-kpi="revenue"]')).not.toBeNull())
    expect(plain(kpi('revenue').querySelector('[data-kpi-value]')?.textContent)).toBe('9,7 тыс. ₽')
    const delta = kpi('revenue').querySelector('[data-kpi-delta]')
    expect(delta).toHaveAttribute('data-kpi-tone', 'good')
    // The page opens on 30 days.
    expect(plain(delta?.textContent)).toBe('+10 % к предыдущим 30 дням')
  })

  it('give churn in percentage points, and a rise in churn is bad news', async () => {
    renderWithProviders(<AnalyticsPage />)
    await waitFor(() => expect(document.querySelector('[data-kpi="churn"]')).not.toBeNull())
    expect(plain(kpi('churn').querySelector('[data-kpi-value]')?.textContent)).toBe('10 %')
    const delta = kpi('churn').querySelector('[data-kpi-delta]')
    expect(plain(delta?.textContent)).toBe('+2,7 п. п. к предыдущим 30 дням')
    expect(delta).toHaveAttribute('data-kpi-tone', 'bad')
    expect(plain(kpi('churn').textContent)).toContain('Не продлили 12 из 120')
  })

  it('mark money converted from another currency as approximate, and name the rate', async () => {
    api.getAnalyticsOverview.mockResolvedValue(
      overviewReport({
        money: ROUBLES_AND_USDT,
        metrics: {
          ...overviewReport().metrics,
          revenue: {
            current: { value: 10500, byCurrency: [{ currency: 'RUB', amount: 9700 }, { currency: 'USDT', amount: 10 }] },
            previous: { value: 8818, byCurrency: [{ currency: 'RUB', amount: 8818 }] },
          },
        },
      }),
    )
    renderWithProviders(<AnalyticsPage />)
    await waitFor(() => expect(document.querySelector('[data-kpi="revenue"]')).not.toBeNull())
    expect(plain(kpi('revenue').querySelector('[data-kpi-value]')?.textContent)).toBe('≈ 10,5 тыс. ₽')
    expect(plain(document.querySelector('[data-analytics-money-note]')?.textContent)).toContain('1 USDT = 80 ₽')
  })
})

describe('the revenue tab', () => {
  it('states one currency as a summary, not as a ring at 100 %', async () => {
    renderWithProviders(<AnalyticsPage />)
    await openTab('revenue')
    const summary = await screen.findByText(i18n.t('analyticsPage.revenue.summary.currency'))
    expect(summary.nextElementSibling?.textContent).toBe('RUB')
    expect(plain(document.querySelector('[data-revenue-total]')?.textContent)).toBe('9 700 ₽')
    expect(document.querySelector('[data-currency-split]')).toBeNull()
    expect(document.querySelector('.recharts-pie')).toBeNull()
  })

  it('splits the total by currency only when there are several', async () => {
    api.getRevenueReport.mockResolvedValue(revenueReport(ROUBLES_AND_USDT))
    renderWithProviders(<AnalyticsPage />)
    await openTab('revenue')
    await waitFor(() => expect(document.querySelector('[data-currency-split]')).not.toBeNull())
    const listed = [...document.querySelectorAll('[data-currency]')].map((item) => item.getAttribute('data-currency'))
    expect(listed).toEqual(['RUB', 'USDT'])
    expect(plain(document.querySelector('[data-currency="USDT"]')?.textContent)).toContain('≈ 800 ₽')
  })

  it('averages a payment over the payments its total came from — a currency with no rate is out of both', async () => {
    const report = revenueReport({ ...ROUBLES_AND_USDT, unconverted: ['XTR'] })
    api.getRevenueReport.mockResolvedValue({
      ...report,
      payments: report.payments + 4,
      byCurrency: [...report.byCurrency, { currency: 'XTR', amount: 500, value: null, payments: 4 }],
    })
    renderWithProviders(<AnalyticsPage />)
    await openTab('revenue')
    const average = await screen.findByText(i18n.t('analyticsPage.revenue.summary.average'))
    // 10 500 ₽ over the 23 payments in RUB and USDT — not over all 27, which
    // would price the four payments in Stars at nothing.
    expect(plain(average.nextElementSibling?.textContent)).toBe('≈ 457 ₽')
  })

  it('shows what the tooltip of a bar in two currencies says: each currency, its value, and what was paid in it', async () => {
    api.getRevenueReport.mockResolvedValue(revenueReport(ROUBLES_AND_USDT))
    renderWithProviders(<AnalyticsPage />)
    await screen.findByRole('group', { name: 'Период' })
    await openTab('revenue')
    await waitFor(() => expect(document.querySelector('[data-chart="revenue-over-time"] .recharts-surface')).not.toBeNull())
    // The bar of 15 September, as the chart hands it to Recharts: 3 500 ₽ and 10 USDT (800 ₽).
    const hovered = { active: true, payload: [{ payload: { index: 3, axis: '15 сент.', heading: 'вт, 15 сентября', cur_RUB: 3500, cur_USDT: 800 } }] }
    const printed = recorded.tooltips
      .map((content) => render(<>{content(hovered)}</>).container)
      .find((container) => container.textContent?.includes('USDT') === true)
    if (printed === undefined) throw new Error('no chart printed a USDT row for a bar paid partly in USDT')
    const rows = [...printed.querySelectorAll('li')].map((row) => plain(row.textContent))
    expect(rows).toEqual(['USDT 800 ₽ 10 USDT', 'RUB 3 500 ₽'])
    expect(plain(printed.textContent)).toContain('Всего: ≈ 4 300 ₽')
  })
})

describe('empty periods say so', () => {
  it('on the overview', async () => {
    api.getAnalyticsOverview.mockResolvedValue(emptyOverviewReport())
    renderWithProviders(<AnalyticsPage />)
    expect(await screen.findByText('Нет платежей ни в этом, ни в предыдущем периоде.')).toBeInTheDocument()
    expect(screen.getByText('Новых платных подписок не было.')).toBeInTheDocument()
    expect(screen.getByText('За период не было ни одной попытки оплаты.')).toBeInTheDocument()
    expect(kpi('arppu').querySelector('[data-kpi-value]')?.textContent).toBe('—')
  })

  it('on the revenue tab', async () => {
    api.getRevenueReport.mockResolvedValue(emptyRevenueReport())
    renderWithProviders(<AnalyticsPage />)
    await openTab('revenue')
    expect(await screen.findByText('За период не было ни одного оплаченного платежа.')).toBeInTheDocument()
    expect(screen.getAllByText('За период нет оплаченных платежей.').length).toBeGreaterThanOrEqual(1)
  })
})

describe('every series names itself', () => {
  it('in the panel’s language, never by its data key', async () => {
    api.getRevenueReport.mockResolvedValue(revenueReport(ROUBLES_AND_USDT))
    renderWithProviders(<AnalyticsPage />)
    await waitFor(() => expect(document.querySelector('[data-chart="overview-revenue"] .recharts-surface')).not.toBeNull())
    await openTab('revenue')
    await waitFor(() => expect(document.querySelector('[data-chart="revenue-kinds"] .recharts-surface')).not.toBeNull())
    await openTab('retention')
    await waitFor(() => expect(document.querySelector('[data-chart="retention-expiring"] .recharts-surface')).not.toBeNull())
    await waitFor(() => expect(document.querySelector('[data-chart="retention-ltv"] .recharts-surface')).not.toBeNull())

    expect(recorded.series.length).toBeGreaterThan(10)
    for (const series of recorded.series) {
      expect(typeof series.name, `${series.kind} ${String(series.dataKey)}`).toBe('string')
      expect(series.name).not.toBe('')
      expect(series.name, `${series.kind} ${String(series.dataKey)} is named by its key`).not.toBe(series.dataKey)
    }
    const names = new Set(recorded.series.map((series) => series.name))
    for (const expected of ['Этот период', 'Предыдущий период', 'Новые подписки', 'Продления', 'Без автоплатежа', 'С автоплатежом', 'Пробные', 'Клиентов']) {
      expect(names.has(expected), expected).toBe(true)
    }
  })
})

describe('motion', () => {
  async function renderOverviewCharts(): Promise<void> {
    renderWithProviders(<AnalyticsPage />)
    await waitFor(() => expect(document.querySelector('[data-chart="overview-revenue"] .recharts-surface')).not.toBeNull())
    await waitFor(() => expect(document.querySelector('[data-chart="overview-new-subscriptions"] .recharts-surface')).not.toBeNull())
  }

  it('sweeps the charts in when nobody asked for stillness', async () => {
    await renderOverviewCharts()
    expect(recorded.series.length).toBeGreaterThan(0)
    expect(recorded.series.every((series) => series.isAnimationActive === true)).toBe(true)
  })

  it('stays still when the panel’s animations are off', async () => {
    useAppearanceStore.setState({ animationsEnabled: false })
    await renderOverviewCharts()
    expect(recorded.series.length).toBeGreaterThan(0)
    expect(recorded.series.every((series) => series.isAnimationActive === false)).toBe(true)
    // Nor do the HTML bars: the funnel and the payment systems carry no entrance.
    const tab = document.querySelector('[data-analytics-tab="overview"]')
    expect(tab?.querySelectorAll('[class*="animate-in"]')).toHaveLength(0)
  })

  it('stays still when the system asks for reduced motion', async () => {
    prefersReducedMotion(true)
    await renderOverviewCharts()
    expect(recorded.series.length).toBeGreaterThan(0)
    expect(recorded.series.every((series) => series.isAnimationActive === false)).toBe(true)
  })

  it('does not replay a chart the operator has already seen when its tab comes back', async () => {
    await renderOverviewCharts()
    await openTab('revenue')
    await waitFor(() => expect(document.querySelector('[data-chart="overview-revenue"]')).toBeNull())
    // The revenue tab's own charts play their first entrance; let them land first.
    await waitFor(() => expect(document.querySelector('[data-chart="revenue-kinds"] .recharts-surface')).not.toBeNull())
    recorded.series.length = 0
    await openTab('overview')
    await waitFor(() => expect(document.querySelector('[data-chart="overview-revenue"] .recharts-surface')).not.toBeNull())
    // The overview's two charts read `value` and `previous`; the revenue tab's
    // stacks (still settling as the tab is left) read currencies and kinds.
    const overviewSeries = recorded.series.filter((series) => series.dataKey === 'value' || series.dataKey === 'previous')
    expect(overviewSeries.length).toBeGreaterThanOrEqual(4)
    expect(overviewSeries.every((series) => series.isAnimationActive === false)).toBe(true)
  })

  it('shimmers its loading skeletons only for those who did not ask for stillness', async () => {
    api.getAnalyticsOverview.mockReturnValue(new Promise(() => {}))
    renderWithProviders(<AnalyticsPage />)
    const skeletons = await waitFor(() => {
      const found = document.querySelectorAll('[data-analytics-skeleton]')
      expect(found.length).toBeGreaterThan(0)
      return found
    })
    for (const skeleton of skeletons) {
      expect(skeleton.className).toContain('motion-safe:animate-pulse')
      expect(skeleton.className.split(/\s+/)).not.toContain('animate-pulse')
    }
  })
})

describe('a stacked bar', () => {
  const draw = (key: string, payload: Record<string, number>, height = 40) => {
    const { container } = render(
      <svg>
        <StackSegment order={['manual', 'autopay', 'trial']} segment={key} x={10} y={100} width={20} height={height} fill="red" payload={payload} />
      </svg>,
    )
    return container.querySelector('path')?.getAttribute('d') ?? null
  }

  it('leaves 2 px of card under a segment that has another below it, and keeps its top where the total is', () => {
    expect(draw('autopay', { manual: 3, autopay: 2, trial: 0 })).toBe('M10,138V104Q10,100 14,100H26Q30,100 30,104V138Z')
  })

  it('rounds only the top segment of THAT bar, and draws the bottom one to the baseline', () => {
    expect(draw('manual', { manual: 3, autopay: 2, trial: 0 })).toBe('M10,100h20v40h-20Z')
    expect(draw('manual', { manual: 3, autopay: 0, trial: 0 })).toBe('M10,140V104Q10,100 14,100H26Q30,100 30,104V140Z')
  })
})
