import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'

import type { DashboardRevenue, DashboardSummaryInterface } from './dashboard-api'
import { DashboardKpiGrid } from './dashboard-kpi-grid'

/**
 * «Выручка за всё время»: the money of «Бизнес-аналитика» → «Выручка» over the
 * whole history, stated in its currency. It replaced «Валовой оборот», which
 * printed every completed amount added across currencies with no unit.
 */

const plain = (text: string | null | undefined): string => (text ?? '').replace(/\s/g, ' ')

function summary(revenue: DashboardRevenue | undefined): DashboardSummaryInterface {
  return {
    checkedAt: '2026-09-18T12:00:00.000Z',
    users: { total: 42, blocked: 3, recentRegistered7d: 5 },
    subscriptions: { active: 11, limited: 2, expired: 7, expiring7d: 8 },
    // What a panel before the update sent — the tile must never print it.
    transactions: { completed: 9, pending: 4, failed: 1, grossVolume: '7810' },
    ...(revenue === undefined ? {} : { revenue }),
    operations: { broadcastDrafts: 6, importDryRunAvailable: true },
    financeOps: { refundRequests: 0, executedRefunds: 0, correctionNotes: 0, correctionRequests: 0, disputeRecords: 0, reconciliationExceptions: 0 },
    metrics: [],
    operationsTimeline: [],
    financeOpsTimeline: [],
    attentionItems: [],
  }
}

/** 1 000 ₽ + 600 ₽ net of a refund, 10 USDT at 80 ₽, 500 Stars with no rate. */
const MIXED: DashboardRevenue = {
  figure: {
    value: 2400,
    byCurrency: [
      { currency: 'RUB', amount: 1600 },
      { currency: 'USDT', amount: 10 },
      { currency: 'XTR', amount: 500 },
    ],
  },
  money: {
    currency: 'RUB',
    converted: true,
    rates: [{ currency: 'USDT', rate: 80, source: 'TEST', fetchedAt: '2026-09-17T09:00:00.000Z' }],
    unconverted: ['XTR'],
  },
  payments: 4,
}

function tile(): Promise<HTMLElement> {
  return waitFor(() => {
    const element = document.querySelector<HTMLElement>('[data-dashboard-kpi="revenue"]')
    if (element === null) throw new Error('no revenue tile')
    return element
  })
}

describe('«Выручка за всё время»', () => {
  beforeAll(async () => {
    await i18nReady
    await i18n.changeLanguage('ru')
    await loadFeatureBundle('dashboard')
  })

  afterAll(async () => {
    await i18n.changeLanguage('en')
  })

  it('states several currencies in the base at the panel’s rate — never «7810» — and names what had no rate', async () => {
    renderWithProviders(<DashboardKpiGrid summary={summary(MIXED)} />)

    const revenue = await tile()
    expect(plain(revenue.querySelector('[data-dashboard-kpi-value]')?.textContent)).toBe('≈ 2,4 тыс. ₽')
    expect(plain(revenue.querySelector('[data-dashboard-kpi-description]')?.textContent)).toBe('4 платежа · и ещё 500 XTR без курса')
    expect(revenue.textContent).toContain('Выручка за всё время')
    expect(screen.queryByText('7810')).toBeNull()
  })

  it('says in its (i) what the money is, at which rate it was converted, and what was left out', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DashboardKpiGrid summary={summary(MIXED)} />)

    await user.hover(await screen.findByRole('button', { name: 'Подробнее: Выручка за всё время' }))
    const tip = plain((await screen.findByRole('tooltip')).textContent)
    expect(tip).toContain('завершённые оплаты больше нуля за вычетом возвратов')
    expect(tip).toContain('Оплаты балансом партнёра не входят')
    expect(tip).toContain('пересчитаны в RUB по курсу панели на 17 сент.: 1 USDT = 80 ₽.')
    expect(tip).toContain('Для XTR курса нет — эти деньги в сумму не вошли: 500 XTR.')
  })

  it('states money in one currency natively', async () => {
    renderWithProviders(
      <DashboardKpiGrid
        summary={summary({
          figure: { value: 12.5, byCurrency: [{ currency: 'USDT', amount: 12.5 }] },
          money: { currency: 'USDT', converted: false, rates: [], unconverted: [] },
          payments: 1,
        })}
      />,
    )

    const revenue = await tile()
    expect(plain(revenue.querySelector('[data-dashboard-kpi-value]')?.textContent)).toBe('12,5 USDT')
    expect(plain(revenue.querySelector('[data-dashboard-kpi-description]')?.textContent)).toBe('1 платёж')
  })

  it('prints a dash, not the old sum, for a summary a panel before the update left in the cache', async () => {
    renderWithProviders(<DashboardKpiGrid summary={summary(undefined)} />)

    const revenue = await tile()
    expect(plain(revenue.querySelector('[data-dashboard-kpi-value]')?.textContent)).toBe('—')
    expect(screen.queryByText('7810')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Подробнее: Выручка за всё время' })).toBeNull()
  })
})
