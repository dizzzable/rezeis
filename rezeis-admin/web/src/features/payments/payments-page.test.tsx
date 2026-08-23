import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { usePermissionStore, type RbacAction } from '@/features/rbac'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import PaymentsPage from './payments-page'

describe('PaymentsPage RBAC gating', () => {
  beforeEach(() => {
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('does not fetch payment operations without payments:view', async () => {
    const getSpy = vi.spyOn(api, 'get').mockResolvedValue({ data: { items: [], total: 0 } })
    grantPermissions([])

    renderWithProviders(<PaymentsPage />)

    expect(await screen.findByText('Payment access is restricted')).toBeInTheDocument()
    expect(getSpy).not.toHaveBeenCalled()
  })

  it('uses the current webhook events endpoint when payment access is granted', async () => {
    const getSpy = vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path.startsWith('/admin/payments/transactions?')) {
        return { data: { items: [], total: 0 } }
      }
      if (path === '/admin/payments/webhooks/events?limit=30') {
        return {
          data: [{
            id: 'webhook-event-1',
            gatewayType: 'YOOKASSA',
            providerEventId: 'provider-event-1234567890',
            status: 'PROCESSED',
            receivedAt: '2026-06-03T00:00:00.000Z',
          }],
        }
      }
      return { data: {} }
    })
    // `payment_webhooks:view`, not `payments:view`, is what the events route
    // requires (admin-payment-webhooks.controller.ts:30). This spec used to
    // grant only the latter and still saw a row, because the mock answered a
    // request the real server refuses — which is the defect the tab gate now
    // matches. `payments-tab-permissions.test.tsx` covers the refusal.
    grantPermissions([
      { resource: 'payments', action: 'view' },
      { resource: 'payment_webhooks', action: 'view' },
    ])
    const user = userEvent.setup()

    renderWithProviders(<PaymentsPage />)
    await user.click(screen.getByRole('tab', { name: 'Webhooks' }))

    expect(await screen.findByText('provider-event-1…')).toBeInTheDocument()
    expect(getSpy).toHaveBeenCalledWith('/admin/payments/webhooks/events?limit=30', expect.any(Object))
  })

  it('names transaction filter controls when payment access is granted', async () => {
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path.startsWith('/admin/payments/transactions?')) {
        return { data: { items: [], total: 0 } }
      }
      return { data: {} }
    })
    grantPermissions([{ resource: 'payments', action: 'view' }])

    renderWithProviders(<PaymentsPage />)

    expect(await screen.findByRole('textbox', { name: 'User' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Gateway' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Purchase type' })).toBeInTheDocument()
  })
})

function grantPermissions(permissions: ReadonlyArray<{ resource: string; action: RbacAction }>): void {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(permissions.map((permission) => `${permission.resource}:${permission.action}`)),
    mustChangePassword: false,
    role: 'ADMIN',
    rbacRoleId: 'role-1',
    error: null,
  })
}
