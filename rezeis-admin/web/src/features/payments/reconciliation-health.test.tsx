/**
 * `GET admin/payments/reconciliation/health` had no reader in the SPA. These
 * specs drive the surface an operator actually reaches — the Webhooks tab of
 * the payments page — and assert the request goes out and the numbers land.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { usePermissionStore, type RbacAction } from '@/features/rbac'
import { api } from '@/lib/api'
import { loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import PaymentsPage from './payments-page'
import { ReconciliationHealthCard } from './reconciliation-health-card'

const HEALTH = {
  queue: { waiting: 4, active: 1, delayed: 0, completed: 987, failed: 5 },
  eventsByStatus: {
    RECEIVED: 21,
    ENQUEUED: 22,
    PROCESSING: 23,
    PROCESSED: 1234,
    FAILED: 11,
  },
  staleProcessingCount: 2,
  staleEnqueuedCount: 3,
  generatedAt: '2026-06-04T10:00:00.000Z',
}

function mockGet(health: unknown = HEALTH) {
  return vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path.startsWith('/admin/payments/transactions?')) return { data: { items: [], total: 0 } }
    if (path === '/admin/payments/webhooks/events?limit=30') return { data: [] }
    if (path === '/admin/payments/reconciliation/health') return { data: health }
    return { data: {} }
  })
}

function grantPermissions(permissions: ReadonlyArray<{ resource: string; action: RbacAction }>) {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(permissions.map((p) => `${p.resource}:${p.action}`)),
    mustChangePassword: false,
    role: 'ADMIN',
    rbacRoleId: 'role-1',
    error: null,
  })
}

describe('payments reconciliation health', () => {
  beforeEach(() => {
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('reads the health route from the webhooks tab and shows the counts', async () => {
    const getSpy = mockGet()
    grantPermissions([{ resource: 'payments', action: 'view' }])
    await loadFeatureBundle('payments')
    const user = userEvent.setup()

    renderWithProviders(<PaymentsPage />)
    await user.click(screen.getByRole('tab', { name: 'Webhooks' }))

    expect(await screen.findByText('Reconciliation health')).toBeInTheDocument()
    expect(getSpy).toHaveBeenCalledWith(
      '/admin/payments/reconciliation/health',
      expect.any(Object),
    )
    // Event group-by and queue depth, from the same payload.
    expect(await screen.findByText('1234')).toBeInTheDocument()
    expect(screen.getByText('987')).toBeInTheDocument()
    expect(screen.getByText('11')).toBeInTheDocument()
  })

  it('names the stuck events and says what they mean', async () => {
    mockGet()
    grantPermissions([{ resource: 'payments', action: 'view' }])
    await loadFeatureBundle('payments')

    renderWithProviders(<ReconciliationHealthCard />)

    expect(await screen.findByText('Enqueued, never picked up')).toBeInTheDocument()
    expect(screen.getByText('Started, never finished')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText(/the reconciliation worker/)).toBeInTheDocument()
  })

  it('says nothing is stuck when both stale counts are zero', async () => {
    mockGet({ ...HEALTH, staleProcessingCount: 0, staleEnqueuedCount: 0 })
    grantPermissions([{ resource: 'payments', action: 'view' }])
    await loadFeatureBundle('payments')

    renderWithProviders(<ReconciliationHealthCard />)

    expect(await screen.findByText('Nothing is stuck.')).toBeInTheDocument()
    expect(screen.queryByText('Enqueued, never picked up')).not.toBeInTheDocument()
  })

  it('renders nothing and issues no request without payments:view', async () => {
    const getSpy = mockGet()
    grantPermissions([])
    await loadFeatureBundle('payments')

    const { container } = renderWithProviders(<ReconciliationHealthCard />)

    expect(container).toBeEmptyDOMElement()
    expect(getSpy).not.toHaveBeenCalled()
  })

  it('says so out loud when the health payload is unavailable', async () => {
    mockGet({})
    grantPermissions([{ resource: 'payments', action: 'view' }])
    await loadFeatureBundle('payments')

    renderWithProviders(<ReconciliationHealthCard />)

    expect(
      await screen.findByText('Reconciliation health is unavailable right now.'),
    ).toBeInTheDocument()
  })
})
