import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'

import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'

import type {
  DashboardSummaryInterface,
  DashboardTimelineEntryInterface,
} from './dashboard-api'
import { DashboardTimelinesSection } from './dashboard-timelines'

/**
 * «Лента операционной активности» used to print the audit row's `action`
 * verbatim, and the busiest writer of that table is `SystemEventsService`,
 * whose rows are `event.<type>`. An operator working through the anti-fraud
 * queue therefore got a card of ten identical lines reading
 * «event.fraud.signal_transitioned» — the machine type, in a panel that is
 * otherwise entirely in Russian.
 */

function summaryWith(
  operationsTimeline: readonly DashboardTimelineEntryInterface[],
): DashboardSummaryInterface {
  return {
    checkedAt: '2026-09-20T12:00:00.000Z',
    users: { total: 42, blocked: 3, recentRegistered7d: 5 },
    subscriptions: { active: 11, limited: 2, expired: 7, expiring7d: 8 },
    transactions: { completed: 9, pending: 4, failed: 1, grossVolume: '—' },
    revenue: {
      figure: { value: 0, byCurrency: [] },
      money: { currency: 'RUB', converted: false, rates: [], unconverted: [] },
      payments: 0,
    },
    operations: { broadcastDrafts: 0, importDryRunAvailable: false },
    financeOps: {
      refundRequests: 0,
      executedRefunds: 0,
      correctionNotes: 0,
      correctionRequests: 0,
      disputeRecords: 0,
      reconciliationExceptions: 0,
    },
    metrics: [],
    operationsTimeline,
    financeOpsTimeline: [],
    attentionItems: [],
  }
}

const SIGNAL_TRANSITIONED: DashboardTimelineEntryInterface = {
  id: 'audit:1',
  source: 'OPS',
  status: 'INFO',
  title: 'fraud.signal_transitioned',
  description: '',
  createdAt: '2026-09-20T12:31:42.000Z',
  kind: 'SYSTEM_EVENT',
  meta: {
    action: 'event.fraud.signal_transitioned',
    eventType: 'fraud.signal_transitioned',
    eventTitle: 'Антифрод: изменён статус сигнала',
  },
}

describe('«Лента операционной активности»', () => {
  beforeAll(async () => {
    await i18nReady
    await i18n.changeLanguage('ru')
    await loadFeatureBundle('dashboard')
  })

  afterAll(async () => {
    await i18n.changeLanguage('en')
  })

  it('names a system event the way its Telegram card does, not by its machine type', () => {
    renderWithProviders(<DashboardTimelinesSection summary={summaryWith([SIGNAL_TRANSITIONED])} />)

    expect(screen.getByText('Антифрод: изменён статус сигнала')).toBeTruthy()
    expect(screen.queryByText(/event\.fraud\.signal_transitioned/)).toBeNull()
  })

  it('falls back to the machine type for an event the server has no title for', () => {
    // A type an automation rule picked at runtime: by construction it is in no
    // table, and the server sends no `eventTitle` for it. The row must still
    // say something — an empty caption is worse than a technical one.
    renderWithProviders(
      <DashboardTimelinesSection
        summary={summaryWith([
          {
            ...SIGNAL_TRANSITIONED,
            meta: { action: 'event.custom.rule_fired', eventType: 'custom.rule_fired' },
          },
        ])}
      />,
    )

    expect(screen.getByText('custom.rule_fired')).toBeTruthy()
  })

  it('names an admin action by its audit code, and shows the code itself when it has no name', () => {
    renderWithProviders(
      <DashboardTimelinesSection
        summary={summaryWith([
          {
            id: 'audit:2',
            source: 'AUDIT',
            status: 'INFO',
            title: 'plans.created',
            description: '',
            createdAt: '2026-09-20T12:30:00.000Z',
            kind: 'AUDIT',
            meta: { action: 'plans.created' },
          },
          {
            id: 'audit:3',
            source: 'AUDIT',
            status: 'INFO',
            title: 'something.nobody.named',
            description: '',
            createdAt: '2026-09-20T12:29:00.000Z',
            kind: 'AUDIT',
            meta: { action: 'something.nobody.named' },
          },
        ])}
      />,
    )

    expect(screen.getByText('Создан тариф')).toBeTruthy()
    expect(screen.getByText('something.nobody.named')).toBeTruthy()
  })

  it('writes the severity badge in words, so «ERROR» is not the only Latin left on the card', () => {
    renderWithProviders(
      <DashboardTimelinesSection
        summary={summaryWith([{ ...SIGNAL_TRANSITIONED, status: 'ERROR' }])}
      />,
    )

    // Scoped to the row: «Ошибка» is also a filter button of the finance card.
    const row = screen.getByText('Антифрод: изменён статус сигнала').closest('li')
    expect(row?.textContent).toContain('Ошибка')
    expect(row?.textContent).not.toContain('ERROR')
  })
})
