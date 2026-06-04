import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'

import { loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import PaymentsAnalyticsTab from './payments-analytics-tab'

describe('PaymentsAnalyticsTab accessibility', () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    await loadFeatureBundle('payments')
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/analytics/payments/providers?days=30') {
        return {
          data: {
            windowDays: 30,
            windowStart: '2026-05-05T00:00:00.000Z',
            previousWindowStart: '2026-04-05T00:00:00.000Z',
            generatedAt: '2026-06-04T00:00:00.000Z',
            totalGrossRevenue: 0,
            totalTransactions: 0,
            totalCompleted: 0,
            providers: [],
          },
        }
      }

      if (path === '/admin/analytics/payments/webhooks?days=30') {
        return {
          data: {
            windowDays: 30,
            windowStart: '2026-05-05T00:00:00.000Z',
            generatedAt: '2026-06-04T00:00:00.000Z',
            totalReceived: 0,
            totalProcessed: 0,
            totalFailed: 0,
            reconciliation: {
              transactionsMissingWebhook: 0,
              webhooksMissingTransaction: 0,
            },
            perGateway: [],
          },
        }
      }

      return { data: {} }
    })
  })

  it('names the analytics window select', async () => {
    renderWithProviders(<PaymentsAnalyticsTab />)

    expect(await screen.findByRole('combobox', { name: 'Analytics window' })).toBeInTheDocument()
  })
})
