import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { usePermissionStore } from '@/features/rbac'
import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import PaymentsAnalyticsTab from './payments-analytics-tab'

// jsdom has no layout: give each chart the size its sized wrapper would.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>()
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) =>
      isValidElement(children)
        ? cloneElement(children as ReactElement<{ width?: number; height?: number }>, { width: 640, height: 160 })
        : children,
  }
})

const plain = (text: string | null | undefined): string => (text ?? '').replace(/\s/g, ' ')

const WEBHOOKS = {
  windowDays: 30,
  windowStart: '2026-05-05T00:00:00.000Z',
  generatedAt: '2026-06-04T00:00:00.000Z',
  totalReceived: 0,
  totalProcessed: 0,
  totalFailed: 0,
  reconciliation: { transactionsMissingWebhook: 0, webhooksMissingTransaction: 0 },
  perGateway: [],
}

const RUB_ONLY = { currency: 'RUB', converted: false, rates: [], unconverted: [] }
const RUB_USDT_STARS = {
  currency: 'RUB',
  converted: true,
  rates: [{ currency: 'USDT', rate: 80, source: 'TEST', fetchedAt: '2026-09-17T09:00:00.000Z' }],
  unconverted: ['XTR'],
}

function day(index: number, revenueValue = 0, transactions = 0) {
  return { day: `2026-09-${String(10 + index).padStart(2, '0')}`, revenueValue, transactions, successful: transactions }
}

function provider(overrides: Record<string, unknown>) {
  return {
    gatewayType: 'YOOKASSA',
    isActive: true,
    currency: 'RUB',
    countsAsRevenue: true,
    transactions: 0,
    completed: 0,
    refunded: 0,
    pending: 0,
    failed: 0,
    canceled: 0,
    revenue: { value: 0, byCurrency: [] },
    payments: 0,
    averagePayment: null,
    successRate: 0,
    checkoutRate: 0,
    medianTimeToPaySeconds: null,
    p95TimeToPaySeconds: null,
    stuckPending: 0,
    delta: { revenuePct: null, transactionsPct: null, successRateDelta: null },
    daily: [day(0), day(1)],
    topFailureReasons: [],
    channelMix: { web: 0, telegram: 0 },
    ...overrides,
  }
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    windowDays: 30,
    windowStart: '2026-08-19T21:00:00.000Z',
    previousWindowStart: '2026-07-20T21:00:00.000Z',
    previousWindowEnd: '2026-08-19T09:00:00.000Z',
    generatedAt: '2026-09-18T09:00:00.000Z',
    timeZone: 'Europe/Moscow',
    timeZoneFallback: false,
    money: RUB_ONLY,
    revenue: { value: 0, byCurrency: [] },
    payments: 0,
    partnerBalance: { figure: { value: 0, byCurrency: [] }, payments: 0 },
    totalTransactions: 0,
    totalCompleted: 0,
    totalPaid: 0,
    providers: [],
    ...overrides,
  }
}

/** 1 000 ₽ + 600 ₽ net of a refund through YooKassa, 10 USDT at 80 ₽, 500 Stars with no rate, 300 ₽ from a partner's balance. */
const MIXED = report({
  money: RUB_USDT_STARS,
  revenue: {
    value: 2400,
    byCurrency: [
      { currency: 'RUB', amount: 1600 },
      { currency: 'USDT', amount: 10 },
      { currency: 'XTR', amount: 500 },
    ],
  },
  payments: 4,
  partnerBalance: { figure: { value: 300, byCurrency: [{ currency: 'RUB', amount: 300 }] }, payments: 1 },
  totalTransactions: 7,
  totalCompleted: 5,
  totalPaid: 6,
  providers: [
    provider({
      transactions: 3,
      completed: 2,
      refunded: 1,
      successRate: 1,
      revenue: { value: 1600, byCurrency: [{ currency: 'RUB', amount: 1600 }] },
      payments: 2,
      averagePayment: { currency: 'RUB', amount: 800 },
      daily: [day(0, 1600, 3), day(1)],
    }),
    provider({
      gatewayType: 'CRYPTOPAY',
      currency: 'USDT',
      transactions: 1,
      completed: 1,
      successRate: 1,
      revenue: { value: 800, byCurrency: [{ currency: 'USDT', amount: 10 }] },
      payments: 1,
      averagePayment: { currency: 'RUB', amount: 800 },
    }),
    provider({
      gatewayType: 'TELEGRAM_STARS',
      currency: 'XTR',
      transactions: 1,
      completed: 1,
      successRate: 1,
      revenue: { value: 0, byCurrency: [{ currency: 'XTR', amount: 500 }] },
      payments: 1,
      averagePayment: { currency: 'XTR', amount: 500 },
    }),
    provider({
      gatewayType: 'PARTNER_BALANCE',
      isActive: false,
      currency: 'USD',
      countsAsRevenue: false,
      transactions: 1,
      completed: 1,
      successRate: 1,
    }),
  ],
})

function serve(providers: unknown, webhooks: unknown = WEBHOOKS): void {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path.startsWith('/admin/analytics/payments/providers?days=')) return { data: providers }
    if (path.startsWith('/admin/analytics/payments/webhooks?days=')) return { data: webhooks }
    return { data: {} }
  })
}

/** One gateway with every kind of number the tab prints: a duration, rates, a change in points and in percent, shares. */
const UNITS = report({
  revenue: { value: 1000, byCurrency: [{ currency: 'RUB', amount: 1000 }] },
  payments: 1,
  totalTransactions: 8,
  totalCompleted: 1,
  totalPaid: 1,
  providers: [
    provider({
      transactions: 8,
      completed: 1,
      pending: 1,
      failed: 3,
      canceled: 3,
      successRate: 0.125,
      checkoutRate: 0.5,
      revenue: { value: 1000, byCurrency: [{ currency: 'RUB', amount: 1000 }] },
      payments: 1,
      averagePayment: { currency: 'RUB', amount: 1000 },
      medianTimeToPaySeconds: 360,
      p95TimeToPaySeconds: 5400,
      delta: { revenuePct: 0.25, transactionsPct: null, successRateDelta: 0.015 },
      topFailureReasons: [{ reason: 'card_declined', count: 3, share: 0.375 }],
      channelMix: { web: 0.25, telegram: 0.75 },
    }),
  ],
})

const UNIT_WEBHOOKS = {
  ...WEBHOOKS,
  totalReceived: 8,
  totalProcessed: 7,
  totalFailed: 1,
  perGateway: [
    { gatewayType: 'YOOKASSA', received: 8, processed: 7, failed: 1, retrying: 0, replayed: 0, deliveryRate: 0.875, medianLatencyMs: 120, p95LatencyMs: 300, topErrors: [] },
  ],
}

/** Every number and unit the tab prints for `UNITS`, read off the page with the gateway's card open. */
async function unitsOnPage(): Promise<Record<string, string>> {
  const user = userEvent.setup()
  serve(UNITS, UNIT_WEBHOOKS)
  renderWithProviders(<PaymentsAnalyticsTab />)
  const row = await waitFor(() => {
    const element = document.querySelector<HTMLElement>('[data-provider="YOOKASSA"]')
    if (element === null) throw new Error('no YooKassa row')
    return element
  })
  await user.click(within(row).getAllByRole('button')[0]!)
  await waitFor(() => {
    if (row.querySelector('[data-stat="time-to-pay"]') === null) throw new Error('card not open')
  })
  const latency = await waitFor(() => {
    const element = document.querySelector('[data-webhook-latency]')
    if (element === null) throw new Error('no webhook latency')
    return element
  })
  const read = (selector: string): string => plain(row.querySelector(selector)?.textContent)
  const lineValue = (label: string): string => read(`[data-line="${i18n.t(label)}"] [data-line-value]`)
  return {
    timeToPay: read('[data-stat="time-to-pay"] [data-stat-value]'),
    p95: read('[data-stat="time-to-pay"] [data-stat-hint]'),
    successRate: read('[data-stat="success-rate"] [data-stat-value]'),
    successRateChange: read('[data-stat="success-rate"] [data-stat-hint]'),
    checkoutRate: read('[data-stat="checkout-rate"] [data-stat-value]'),
    revenueChange: read('[data-delta]'),
    completedLine: lineValue('paymentsAnalytics.statuses.completed'),
    web: lineValue('paymentsAnalytics.providers.web'),
    telegram: lineValue('paymentsAnalytics.providers.telegram'),
    failure: plain(within(row).getByText('card_declined').parentElement?.querySelector('span:last-child')?.textContent),
    conversion: plain(document.querySelector('[data-summary="conversion"] [data-summary-value]')?.textContent),
    webhookLatency: plain(latency.textContent),
  }
}

function grantAnalytics(): void {
  // Both reports are guarded by `analytics:view`
  // (admin-payment-analytics.controller.ts:27 and :40). The tab used to
  // render its controls regardless and let the 403 land in the "could not
  // load the report" branch; it now refuses up front, so a spec that wants
  // the reports has to say the admin may read them.
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(['payments:view', 'analytics:view']),
    mustChangePassword: false,
    role: 'ADMIN',
    rbacRoleId: 'role-1',
    error: null,
  })
}

function summaryValue(id: string): Promise<string> {
  return waitFor(() => {
    const value = document.querySelector(`[data-summary="${id}"] [data-summary-value]`)
    if (value === null) throw new Error(`no summary card ${id}`)
    return plain(value.textContent)
  })
}

describe('PaymentsAnalyticsTab accessibility', () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    usePermissionStore.getState().reset()
    grantAnalytics()
    await loadFeatureBundle('payments')
    serve(report())
  })

  it('names the analytics window select', async () => {
    renderWithProviders(<PaymentsAnalyticsTab />)

    expect(await screen.findByRole('combobox', { name: 'Analytics window' })).toBeInTheDocument()
  })
})

describe('PaymentsAnalyticsTab money — the rule and the currency of «Бизнес-аналитика»', () => {
  beforeAll(async () => {
    await i18nReady
    await i18n.changeLanguage('ru')
    await loadFeatureBundle('payments')
  })

  afterAll(async () => {
    await i18n.changeLanguage('en')
  })

  beforeEach(() => {
    vi.restoreAllMocks()
    usePermissionStore.getState().reset()
    grantAnalytics()
  })

  it('prints revenue in its currency the way «Бизнес-аналитика» does — «9,7 тыс. ₽», not «9.7K»', async () => {
    serve(
      report({
        revenue: { value: 9700, byCurrency: [{ currency: 'RUB', amount: 9700 }] },
        payments: 12,
        totalTransactions: 14,
        totalPaid: 12,
        providers: [provider({ transactions: 14, completed: 12, successRate: 12 / 13, revenue: { value: 9700, byCurrency: [{ currency: 'RUB', amount: 9700 }] }, payments: 12, averagePayment: { currency: 'RUB', amount: 9700 / 12 } })],
      }),
    )
    renderWithProviders(<PaymentsAnalyticsTab />)

    expect(await summaryValue('revenue')).toBe('9,7 тыс. ₽')
    expect(plain(document.querySelector('[data-summary="revenue"] [data-summary-subtitle]')?.textContent)).toBe('За 30 дней · 12 платежей')
    expect(plain(document.querySelector('[data-provider="YOOKASSA"] [data-provider-revenue]')?.textContent)).toBe('9,7 тыс. ₽')
    // One currency: nothing was converted, so nothing is said about rates.
    expect(document.querySelector('[data-payments-money-notes]')).toBeNull()
  })

  it('states several currencies in the base at the panel’s rate, names the one with no rate, and a partner’s balance apart', async () => {
    serve(MIXED)
    renderWithProviders(<PaymentsAnalyticsTab />)

    // 1 600 ₽ + 10 USDT at 80 ₽ — never «1 610», and «≈» because part of it was converted.
    expect(await summaryValue('revenue')).toBe('≈ 2,4 тыс. ₽')
    expect(plain(document.querySelector('[data-summary="revenue"] [data-summary-subtitle]')?.textContent)).toBe(
      'За 30 дней · 4 платежа · и ещё 500 XTR без курса',
    )
    const notes = plain(document.querySelector('[data-payments-money-notes]')?.textContent)
    expect(notes).toContain('пересчитаны в RUB по курсу панели на 17 сент.: 1 USDT = 80 ₽.')
    expect(notes).toContain('Для XTR курса нет — эти платежи показаны отдельно и в выручку не входят.')
    expect(notes).toContain('Экрана для курса в панели пока нет')
    expect(notes).toContain('Оплачено балансом партнёра — не выручка: 300 ₽ · 1 платёж')
    // Every row in the view currency, Stars in their own: «500 XTR», not «0 ₽».
    const revenueOf = (gateway: string): string => plain(document.querySelector(`[data-provider="${gateway}"] [data-provider-revenue]`)?.textContent)
    expect(revenueOf('YOOKASSA')).toBe('1,6 тыс. ₽')
    expect(revenueOf('CRYPTOPAY')).toBe('≈ 800 ₽')
    expect(revenueOf('TELEGRAM_STARS')).toBe('500 XTR')
  })

  it('keeps a partner’s balance as a row for its health, marked «не выручка», with no money and no «отключён»', async () => {
    serve(MIXED)
    renderWithProviders(<PaymentsAnalyticsTab />)

    const row = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-provider="PARTNER_BALANCE"]')
      if (element === null) throw new Error('no partner balance row')
      return element
    })
    expect(plain(row.querySelector('[data-provider-revenue]')?.textContent)).toBe('не выручка')
    expect(within(row).queryByText('отключён')).toBeNull()
    expect(row.textContent).not.toMatch(/₽/)
  })

  it('shows the average payment in its currency and the refunds apart from the completed ones', async () => {
    const user = userEvent.setup()
    serve(MIXED)
    renderWithProviders(<PaymentsAnalyticsTab />)

    const row = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-provider="YOOKASSA"]')
      if (element === null) throw new Error('no YooKassa row')
      return element
    })
    await user.click(within(row).getAllByRole('button')[0]!)
    const average = await waitFor(() => {
      const element = row.querySelector('[data-stat="average-payment"]')
      if (element === null) throw new Error('no average')
      return element
    })
    expect(plain(average.querySelector('[data-stat-value]')?.textContent)).toBe('800 ₽')
    expect(average.textContent).toContain('по 2 платежам')
    expect(within(row).getByText('Возвращено')).toBeInTheDocument()
  })

  it('refuses a report from a panel a release behind — one that names no currency — instead of printing its numbers', async () => {
    serve({
      windowDays: 30,
      windowStart: '2026-05-05T00:00:00.000Z',
      previousWindowStart: '2026-04-05T00:00:00.000Z',
      generatedAt: '2026-06-04T00:00:00.000Z',
      totalGrossRevenue: 1010,
      totalTransactions: 2,
      totalCompleted: 2,
      providers: [],
    })
    renderWithProviders(<PaymentsAnalyticsTab />)

    expect(await screen.findByText(i18n.t('paymentsAnalytics.loadError'))).toBeInTheDocument()
    expect(screen.queryByText(/1010|1 010|1,0 тыс/)).toBeNull()
  })

  it('writes every number and unit the Russian way — «6 мин», «12,5 %», «+1,5 п. п.», «120 мс» — not by hand in English', async () => {
    expect(await unitsOnPage()).toEqual({
      timeToPay: '6 мин',
      p95: '95 % — до 1,5 ч',
      successRate: '12,5 %',
      successRateChange: '+1,5 п. п.',
      checkoutRate: '50 %',
      revenueChange: '+25 %',
      completedLine: '1 · 12,5 %',
      web: '25 %',
      telegram: '75 %',
      failure: '3 · 38 %',
      conversion: '12,5 %',
      webhookLatency: '120 мс',
    })
    expect(screen.getAllByText('87,5 %')).toHaveLength(2)
  })

  it('says in the time to pay’s (i) that a payment not delivered yet is left out, not counted as zero', async () => {
    const user = userEvent.setup()
    await unitsOnPage()
    await user.hover(screen.getByRole('button', { name: 'Подробнее: Медианное время оплаты' }))
    const tip = plain((await screen.findByRole('tooltip')).textContent)
    expect(tip).toContain('От начала оплаты до зачисления')
    expect(tip).toContain('Платежи, выдача по которым ещё не завершилась, не учитываются')
    expect(tip).toContain('перенесённые из другого бота тоже')
  })

  it('counts a partner’s balance in neither «Конверсия» nor «Активные шлюзы» — it keeps its own row', async () => {
    // YooKassa 1 paid of 2, and 2 purchases from a partner's balance.
    serve(
      report({
        totalTransactions: 2,
        totalCompleted: 1,
        totalPaid: 1,
        partnerBalance: { figure: { value: 600, byCurrency: [{ currency: 'RUB', amount: 600 }] }, payments: 2 },
        providers: [
          provider({ transactions: 2, completed: 1, failed: 1, successRate: 0.5, checkoutRate: 0.5 }),
          provider({ gatewayType: 'PARTNER_BALANCE', isActive: false, currency: 'USD', countsAsRevenue: false, transactions: 2, completed: 2, successRate: 1, checkoutRate: 1 }),
        ],
      }),
    )
    renderWithProviders(<PaymentsAnalyticsTab />)

    expect(await summaryValue('conversion')).toBe('50 %')
    expect(await summaryValue('providers')).toBe('1')
    expect(plain(document.querySelector('[data-summary="providers"] [data-summary-subtitle]')?.textContent)).toBe('из 1')
    expect(document.querySelector('[data-provider="PARTNER_BALANCE"]')).not.toBeNull()
  })

  it('counts a checkout stuck from the moment it started, and says so in its (i)', async () => {
    const user = userEvent.setup()
    serve(report({ totalTransactions: 5, providers: [provider({ transactions: 5, pending: 3, stuckPending: 3 })] }))
    renderWithProviders(<PaymentsAnalyticsTab />)

    const row = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-provider="YOOKASSA"]')
      if (element === null) throw new Error('no YooKassa row')
      return element
    })
    await user.click(within(row).getAllByRole('button')[0]!)
    const stuck = await waitFor(() => {
      const element = row.querySelector('[data-stat="stuck"] [data-stat-value]')
      if (element === null) throw new Error('no stuck figure')
      return element
    })
    expect(plain(stuck.textContent)).toBe('3')
    await user.hover(screen.getByRole('button', { name: 'Подробнее: Зависли дольше часа' }))
    const tip = plain((await screen.findByRole('tooltip')).textContent)
    expect(tip).toContain('больше часа с того момента, как их начали')
    expect(tip).toContain('через 30 минут')
  })

  it('says the days are UTC days when the panel’s time zone could not be used', async () => {
    serve(report({ timeZone: 'UTC', timeZoneFallback: true }))
    renderWithProviders(<PaymentsAnalyticsTab />)

    await waitFor(() => {
      expect(plain(document.querySelector('[data-payments-money-notes]')?.textContent)).toBe(
        'Часовой пояс панели не задан или не распознан — дни считаются по UTC.',
      )
    })
  })
})

describe('PaymentsAnalyticsTab numbers — English', () => {
  beforeAll(async () => {
    await i18nReady
    await i18n.changeLanguage('en')
    await loadFeatureBundle('payments')
  })

  beforeEach(() => {
    vi.restoreAllMocks()
    usePermissionStore.getState().reset()
    grantAnalytics()
  })

  it('writes every number and unit the English way — "6 min", "12.5%", "+1.5 pp", "120 ms"', async () => {
    expect(await unitsOnPage()).toEqual({
      timeToPay: '6 min',
      p95: '95% within 1.5 h',
      successRate: '12.5%',
      successRateChange: '+1.5 pp',
      checkoutRate: '50%',
      revenueChange: '+25%',
      completedLine: '1 · 12.5%',
      web: '25%',
      telegram: '75%',
      failure: '3 · 38%',
      conversion: '12.5%',
      webhookLatency: '120 ms',
    })
    expect(screen.getAllByText('87.5%')).toHaveLength(2)
  })
})
