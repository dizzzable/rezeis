/**
 * The dashboard row that holds «Онлайн пользователей» and «Распределение
 * подписок» puts them side by side only from `xl` (1280 px).
 *
 * Side by side in a narrow window, the subscription card stacks its two rings,
 * each with its legend under it, and grows to about 1000 px; the grid row
 * stretches the trend card to match. From 1024 to 1256 px with the sidebar open
 * that was a chart 862–902 px tall in a card 347–463 px wide (measured in
 * Chromium 152 against the compiled classes, Geist and IBM Plex Mono, ru and
 * en). From 1024 to 1279 px the two cards now stack at full width, as they
 * already did below `lg`: a 192 px chart over a subscription card with its
 * rings side by side, with the sidebar open or collapsed. From `xl` up the row
 * is as it was, and 1920 px with it.
 *
 * jsdom has no layout engine, so what is held here is the class the layout
 * depends on. The chart's own ceiling is held in
 * `dashboard-online-trend-layout.test.tsx`.
 */
import { screen } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import { dashboardApi, type DashboardSummaryInterface } from './dashboard-api'
import DashboardPage from './dashboard-page'

vi.mock('./dashboard-online-trend', () => ({
  DashboardOnlineTrend: () => <section data-testid="online-trend" />,
}))

vi.mock('./dashboard-subscription-chart', () => ({
  DashboardSubscriptionChart: () => <section data-testid="subscription-chart" />,
}))

const SUMMARY: DashboardSummaryInterface = {
  checkedAt: '2026-09-14T10:00:00.000Z',
  users: { total: 42, blocked: 3, recentRegistered7d: 5 },
  subscriptions: { active: 11, limited: 2, expired: 7, expiring7d: 8 },
  transactions: { completed: 9, pending: 4, failed: 1, grossVolume: '125.50' },
  operations: { broadcastDrafts: 6, importDryRunAvailable: true },
  financeOps: {
    refundRequests: 2,
    executedRefunds: 1,
    correctionNotes: 3,
    correctionRequests: 4,
    disputeRecords: 5,
    reconciliationExceptions: 6,
  },
  metrics: [],
  operationsTimeline: [],
  financeOpsTimeline: [],
  attentionItems: [],
}

beforeAll(async () => {
  await loadFeatureBundle('dashboard')
})

beforeEach(() => {
  vi.spyOn(dashboardApi, 'getSummary').mockResolvedValue(SUMMARY)
  vi.spyOn(dashboardApi, 'getOnlineTrend').mockResolvedValue([])
})

describe('the dashboard chart row', () => {
  it('puts the online trend beside the subscription card only from xl', async () => {
    renderWithProviders(<DashboardPage />)
    const trend = await screen.findByTestId('online-trend')
    const subscriptions = await screen.findByTestId('subscription-chart')

    const row = trend.parentElement as HTMLElement
    // Anti-vacuity: both cards are cells of this one grid.
    expect(subscriptions.parentElement).toBe(row)
    expect(row).toHaveClass('grid')

    expect(row).toHaveClass('xl:grid-cols-2')
    // No column count at any breakpoint below `xl`, so below it the cards stack.
    expect(row.className).not.toMatch(/(^|\s)(sm|md|lg|@[\w-]+|min-\[[^\]]+\]):grid-cols-/)
    expect(row.className.match(/(^|\s)grid-cols-/g)).toBeNull()
  })

  it('shows the loading placeholder of that row on the same breakpoint', async () => {
    vi.spyOn(dashboardApi, 'getSummary').mockReturnValue(new Promise(() => {}))
    renderWithProviders(<DashboardPage />)
    const row = await screen.findByTestId('dashboard-chart-row-skeleton')

    expect(row).toHaveClass('grid')
    expect(row).toHaveClass('xl:grid-cols-2')
    // The placeholder must not promise two columns where the loaded row stacks.
    expect(row.className).not.toMatch(/(^|\s)(sm|md|lg|@[\w-]+|min-\[[^\]]+\]):grid-cols-/)
    expect(row.className.match(/(^|\s)grid-cols-/g)).toBeNull()
  })
})
