import { describe, expect, it, vi, beforeAll } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import DashboardPage from '@/features/dashboard/dashboard-page'
import { dashboardApi } from '@/features/dashboard/dashboard-api'
import { renderWithProviders } from '@/test/test-utils'
import { loadFeatureBundle } from '@/i18n/i18n'

describe('DashboardPage', () => {
  beforeAll(async () => {
    // The dashboard i18n bundle is lazy-loaded by the router via
    // `withFeatureBundle('dashboard', ...)`. Tests bypass the router so
    // we need to load it manually.
    await loadFeatureBundle('dashboard')
  })

  it('uses generic bounded copy for dashboard summary load errors', async () => {
    const rawError = 'raw dashboard backend error with provider identifiers and payment ids'
    vi.spyOn(dashboardApi, 'getSummary').mockRejectedValue(new Error(rawError))

    renderWithProviders(<DashboardPage />)

    expect(await screen.findByText('Unable to load dashboard summary.')).toBeInTheDocument()
    expect(screen.queryByText(rawError)).not.toBeInTheDocument()
  })

  it('renders backend-owned dashboard KPI summary', async () => {
    vi.spyOn(dashboardApi, 'getSummary').mockResolvedValue({
      checkedAt: '2026-04-24T12:00:00.000Z',
      users: { total: 42, blocked: 3, recentRegistered7d: 5 },
      subscriptions: { active: 11, limited: 2, expired: 7, expiring7d: 8 },
      transactions: { completed: 9, pending: 4, failed: 1, grossVolume: '125.50' },
  operations: { broadcastDrafts: 6, importDryRunAvailable: true },
  financeOps: { refundRequests: 2, executedRefunds: 1, correctionNotes: 3, correctionRequests: 4, disputeRecords: 5, reconciliationExceptions: 6 },
      metrics: [
        { code: 'TOTAL_USERS', label: 'Total users', value: 42, description: 'All users registered in the admin database.' },
      ],
      operationsTimeline: [
        {
          id: 'broadcast-1',
          source: 'BROADCAST',
          title: 'Maintenance',
          description: 'Draft for ALL audience with 10 selected users.',
          createdAt: '2026-04-24T12:03:00.000Z',
          status: 'INFO',
        },
      ],
      financeOpsTimeline: [
        {
          id: 'raw-transaction-id-sensitive-001',
          source: 'AUDIT',
          title: 'Correction request ADJUST_AMOUNT',
          description: 'Correction request EXECUTED. Transaction identifier hidden.',
          createdAt: '2026-04-24T12:04:00.000Z',
          status: 'SUCCESS',
        },
      ],
      attentionItems: [
        {
          safeKey: 'subscription-expiring-1',
          kind: 'SUBSCRIPTION_EXPIRING',
          severity: 'WARNING',
          title: 'Subscription expiry attention',
          description: 'Paid subscription expires soon. Subscription identifier hidden.',
          occurredAt: '2026-04-25T12:00:00.000Z',
          status: 'ACTIVE',
        },
        {
          safeKey: 'payment-pending-1',
          kind: 'PAYMENT_PENDING',
          severity: 'INFO',
          title: 'Pending payment attention',
          description: 'NEW via WEB. Amount 12.50 USD. Payment identifier hidden.',
          occurredAt: '2026-04-24T10:00:00.000Z',
          status: 'PENDING',
        },
      ],
    })

    renderWithProviders(<DashboardPage />)

    expect((await screen.findAllByText('42')).length).toBeGreaterThan(0)
    expect(await screen.findByText('Active subscriptions')).toBeInTheDocument()
    expect(await screen.findByText('5 registered in 7d')).toBeInTheDocument()
    expect((await screen.findAllByText('11')).length).toBeGreaterThan(0)
    expect(await screen.findByText('2 limited subscriptions')).toBeInTheDocument()
    expect(await screen.findByText('125.50')).toBeInTheDocument()
    expect(await screen.findByText('9 completed transactions')).toBeInTheDocument()
    expect((await screen.findAllByText('6')).length).toBeGreaterThan(0)
    expect(await screen.findByText('Broadcast drafts waiting for delivery phases')).toBeInTheDocument()
    expect(await screen.findByText('Needs attention')).toBeInTheDocument()
    expect(await screen.findByText('Subscriptions expiring in 7 days')).toBeInTheDocument()
    expect((await screen.findAllByText('8')).length).toBeGreaterThan(0)
    expect(await screen.findByText('Pending payments')).toBeInTheDocument()
    expect((await screen.findAllByText('4')).length).toBeGreaterThan(0)
    expect(await screen.findByText('Failed payments')).toBeInTheDocument()
    expect(await screen.findByText('Attention drill-down')).toBeInTheDocument()
    expect(await screen.findByText('Subscription expiry attention')).toBeInTheDocument()
    expect(await screen.findByText('Paid subscription expires soon. Subscription identifier hidden.')).toBeInTheDocument()
    expect(await screen.findByText('Pending payment attention')).toBeInTheDocument()
    expect(await screen.findByText('NEW via WEB. Amount 12.50 USD. Payment identifier hidden.')).toBeInTheDocument()
    expect(screen.queryByText('raw-subscription-id-sensitive-001')).not.toBeInTheDocument()
    expect(screen.queryByText('raw-user-id-sensitive-001')).not.toBeInTheDocument()
    expect(screen.queryByText('raw-provider-uuid-sensitive-001')).not.toBeInTheDocument()
    expect(screen.queryByText('raw-payment-id-sensitive-001')).not.toBeInTheDocument()
    expect(await screen.findByText('Operations activity timeline')).toBeInTheDocument()
    expect(await screen.findByText('Finance operations timeline')).toBeInTheDocument()
    expect(await screen.findByText('Correction request ADJUST_AMOUNT')).toBeInTheDocument()
    expect(await screen.findByText('Correction request EXECUTED. Transaction identifier hidden.')).toBeInTheDocument()
    expect(screen.queryByText('raw-transaction-id-sensitive-001')).not.toBeInTheDocument()
    expect(await screen.findByText('Maintenance')).toBeInTheDocument()
    expect(await screen.findByText('Draft for ALL audience with 10 selected users.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'AUDIT' }))
    expect(await screen.findByText('No recent operations activity for this filter.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'BROADCAST' }))
    expect(await screen.findByText('Maintenance')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'WARNING' }))
    expect(await screen.findByText('No recent finance operations for this filter.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'SUCCESS' }))
    expect(await screen.findByText('Correction request ADJUST_AMOUNT')).toBeInTheDocument()
  })
})
