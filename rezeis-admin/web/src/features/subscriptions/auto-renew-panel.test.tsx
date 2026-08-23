/**
 * `admin/auto-renew` had no reader in the SPA: an operator could neither see
 * whether the cycle was running nor trigger one.
 *
 * `POST run` is synchronous and moves money (it charges saved payment
 * methods), so these specs pin the interaction as well as the wiring: no
 * request until the confirmation is accepted, the button gated on the token
 * the route actually demands, and the panel reachable from a real page.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { usePermissionStore, type RbacAction } from '@/features/rbac'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import { AutoRenewPanel } from './auto-renew-panel'
import SubscriptionsPage from './subscriptions-page'

const STATUS = {
  cron: 'every-minute',
  lastResult: {
    expired: 17,
    warnings3d: 41,
    warnings1d: 39,
    autopayAttempted: 12,
    autopaySucceeded: 9,
    autopayFailed: 3,
    autopaySkipped: 5,
    finishedAt: '2026-06-04T10:00:00.000Z',
    durationMs: 8421,
  },
}

function mockGet(status: unknown = STATUS) {
  return vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/auto-renew/status') return { data: status }
    if (path.startsWith('/admin/subscriptions?')) return { data: { items: [], total: 0 } }
    if (path === '/admin/subscriptions/stats') {
      return { data: { total: 0, byStatus: {}, trialCount: 0, expiringIn7d: 0 } }
    }
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

describe('auto-renew panel', () => {
  beforeEach(() => {
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('renders nothing and issues no request without auto_renew:view', async () => {
    const getSpy = mockGet()
    grantPermissions([])

    const { container } = renderWithProviders(<AutoRenewPanel />)

    expect(container).toBeEmptyDOMElement()
    expect(getSpy).not.toHaveBeenCalled()
  })

  it('shows the last cycle to a viewer', async () => {
    const getSpy = mockGet()
    grantPermissions([{ resource: 'auto_renew', action: 'view' }])

    renderWithProviders(<AutoRenewPanel />)

    expect(await screen.findByText('Runs every minute')).toBeInTheDocument()
    expect(screen.getByText('Auto-renewal')).toBeInTheDocument()
    expect(getSpy).toHaveBeenCalledWith('/admin/auto-renew/status', expect.any(Object))
    expect(screen.getByText('17')).toBeInTheDocument()
    expect(screen.getByText('Autopay charged')).toBeInTheDocument()
    expect(screen.getByText('9')).toBeInTheDocument()
  })

  it('says so when no cycle has been recorded yet', async () => {
    mockGet({ cron: 'every-minute', lastResult: null })
    grantPermissions([{ resource: 'auto_renew', action: 'view' }])

    renderWithProviders(<AutoRenewPanel />)

    expect(
      await screen.findByText(
        'No cycle has been recorded yet — the result appears here after the next tick.',
      ),
    ).toBeInTheDocument()
  })

  it('hides the run control from a viewer without auto_renew:run', async () => {
    mockGet()
    grantPermissions([{ resource: 'auto_renew', action: 'view' }])

    renderWithProviders(<AutoRenewPanel />)

    expect(await screen.findByText('Auto-renewal')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Run now' })).not.toBeInTheDocument()
  })

  it('does not run the cycle until the confirmation is accepted', async () => {
    mockGet()
    const postSpy = vi.spyOn(api, 'post').mockResolvedValue({
      data: { ...STATUS.lastResult },
    })
    grantPermissions([
      { resource: 'auto_renew', action: 'view' },
      { resource: 'auto_renew', action: 'run' },
    ])
    const user = userEvent.setup()

    renderWithProviders(<AutoRenewPanel />)

    await user.click(await screen.findByRole('button', { name: 'Run now' }))

    const dialog = await screen.findByRole('alertdialog', {
      name: 'Run an auto-renewal cycle now?',
    })
    expect(postSpy).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'Run cycle' }))

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith('/admin/auto-renew/run', {})
    })
  })

  it('abandons the run when the confirmation is dismissed', async () => {
    mockGet()
    const postSpy = vi.spyOn(api, 'post').mockResolvedValue({ data: {} })
    grantPermissions([
      { resource: 'auto_renew', action: 'view' },
      { resource: 'auto_renew', action: 'run' },
    ])
    const user = userEvent.setup()

    renderWithProviders(<AutoRenewPanel />)

    await user.click(await screen.findByRole('button', { name: 'Run now' }))
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Run an auto-renewal cycle now?',
    })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(postSpy).not.toHaveBeenCalled()
  })

  it('is reachable from the subscriptions page', async () => {
    // The defect was reachability, so a spec that only renders the panel in
    // isolation would reproduce it: it has to be mounted somewhere an
    // operator goes.
    mockGet()
    grantPermissions([{ resource: 'auto_renew', action: 'view' }])

    renderWithProviders(<SubscriptionsPage />)

    expect(await screen.findByText('Auto-renewal')).toBeInTheDocument()
    expect(await screen.findByText('Runs every minute')).toBeInTheDocument()
  })
})
