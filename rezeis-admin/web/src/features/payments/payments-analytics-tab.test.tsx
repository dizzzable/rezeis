import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'

import { usePermissionStore } from '@/features/rbac'
import { loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import PaymentsAnalyticsTab from './payments-analytics-tab'

describe('PaymentsAnalyticsTab accessibility', () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    usePermissionStore.getState().reset()
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
