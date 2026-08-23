/**
 * `POST admin/payments/webhooks/events/:eventId/replay` had no caller in the
 * SPA, so the reconciliation-health card could report stuck events an operator
 * could not act on.
 *
 * These specs drive the Webhooks tab as an operator does and assert the
 * request that actually goes out — in particular that `force` is never in it,
 * and that nothing is sent until the confirmation is completed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'

import { usePermissionStore, type RbacAction } from '@/features/rbac'
import { api } from '@/lib/api'
import { loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import PaymentsPage from './payments-page'

const STUCK_EVENT_ID = '11111111-1111-4111-8111-111111111111'
const PROCESSED_EVENT_ID = '22222222-2222-4222-8222-222222222222'

const EVENTS = [
  {
    id: STUCK_EVENT_ID,
    gatewayType: 'YOOKASSA',
    providerEventId: 'evt-stuck-1',
    status: 'ENQUEUED',
    receivedAt: '2026-06-04T10:00:00.000Z',
    lastError: 'reconciliation worker timed out',
  },
  {
    id: PROCESSED_EVENT_ID,
    gatewayType: 'CRYPTOMUS',
    providerEventId: 'evt-done-2',
    status: 'PROCESSED',
    receivedAt: '2026-06-04T09:00:00.000Z',
    lastError: null,
  },
]

const HEALTH = {
  queue: { waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0 },
  eventsByStatus: { RECEIVED: 0, ENQUEUED: 1, PROCESSING: 0, PROCESSED: 1, FAILED: 0 },
  staleProcessingCount: 0,
  staleEnqueuedCount: 1,
  generatedAt: '2026-06-04T10:00:00.000Z',
}

function mockGet() {
  return vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path.startsWith('/admin/payments/transactions?')) return { data: { items: [], total: 0 } }
    if (path === '/admin/payments/webhooks/events?limit=30') return { data: EVENTS }
    if (path === '/admin/payments/reconciliation/health') return { data: HEALTH }
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

// `payment_webhooks:view` is what `GET /admin/payments/webhooks/events`
// requires (admin-payment-webhooks.controller.ts:30). It was missing from both
// shapes below while the tab was gated on `payments:view` alone: the request
// 403'd, the table rendered empty, and these specs only passed because the
// fixture mock answered a request the real server would have refused. With the
// tab gated on the token the route actually needs, an operator who is to see a
// row must hold it — so both shapes carry it, and `REPLAYER` is `VIEWER` plus
// the one extra grant its name claims.
const VIEWER = [
  { resource: 'payments', action: 'view' as RbacAction },
  { resource: 'payment_webhooks', action: 'view' as RbacAction },
]
const REPLAYER = [...VIEWER, { resource: 'payment_webhooks', action: 'run' as RbacAction }]

async function openWebhooksTab(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup()
  await loadFeatureBundle('payments')
  renderWithProviders(<PaymentsPage />)
  await user.click(screen.getByRole('tab', { name: 'Webhooks' }))
  return user
}

describe('payment webhook replay', () => {
  beforeEach(() => {
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('hides the replay control without payment_webhooks:run', async () => {
    mockGet()
    grantPermissions(VIEWER)

    await openWebhooksTab()

    expect(await screen.findByText('evt-stuck-1')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Replay' })).not.toBeInTheDocument()
  })

  it('offers replay for a stuck event and refuses it for a processed one', async () => {
    // Anti-vacuity pair: a control that is always enabled, or always disabled,
    // fails one half of this.
    mockGet()
    grantPermissions(REPLAYER)

    await openWebhooksTab()

    await screen.findByText('evt-stuck-1')
    const buttons = screen.getAllByRole('button', { name: 'Replay' })
    expect(buttons).toHaveLength(2)
    expect(buttons[0]).toBeEnabled()
    expect(buttons[1]).toBeDisabled()
  })

  it('sends nothing until the confirmation is completed, then omits force', async () => {
    mockGet()
    const postSpy = vi.spyOn(api, 'post').mockResolvedValue({ data: { alreadyQueued: false } })
    grantPermissions(REPLAYER)

    const user = await openWebhooksTab()
    await screen.findByText('evt-stuck-1')
    await user.click(screen.getAllByRole('button', { name: 'Replay' })[0])

    const dialog = await screen.findByRole('alertdialog', {
      name: 'Replay this webhook event?',
    })
    expect(postSpy).not.toHaveBeenCalled()
    // The DTO requires a reason of at least 3 characters, so the confirm stays
    // shut until there is one.
    expect(within(dialog).getByRole('button', { name: 'Replay event' })).toBeDisabled()

    await user.type(within(dialog).getByLabelText('Reason'), '  worker outage  ')
    await user.click(within(dialog).getByRole('button', { name: 'Replay event' }))

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledTimes(1)
    })
    // Exact body: `force` must not be on the wire at all. Replaying with force
    // is a different product from replaying without it.
    expect(postSpy).toHaveBeenCalledWith(
      `/admin/payments/webhooks/events/${STUCK_EVENT_ID}/replay`,
      { reason: 'worker outage' },
    )
  })

  it('abandons the replay when the confirmation is dismissed', async () => {
    mockGet()
    const postSpy = vi.spyOn(api, 'post').mockResolvedValue({ data: { alreadyQueued: false } })
    grantPermissions(REPLAYER)

    const user = await openWebhooksTab()
    await screen.findByText('evt-stuck-1')
    await user.click(screen.getAllByRole('button', { name: 'Replay' })[0])

    const dialog = await screen.findByRole('alertdialog', {
      name: 'Replay this webhook event?',
    })
    await user.type(within(dialog).getByLabelText('Reason'), 'worker outage')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(postSpy).not.toHaveBeenCalled()
  })

  it('names the event and its last error in the confirmation', async () => {
    mockGet()
    vi.spyOn(api, 'post').mockResolvedValue({ data: { alreadyQueued: false } })
    grantPermissions(REPLAYER)

    const user = await openWebhooksTab()
    await screen.findByText('evt-stuck-1')
    await user.click(screen.getAllByRole('button', { name: 'Replay' })[0])

    const dialog = await screen.findByRole('alertdialog', {
      name: 'Replay this webhook event?',
    })
    expect(within(dialog).getByText('YOOKASSA · evt-stuck-1 · ENQUEUED')).toBeInTheDocument()
    expect(
      within(dialog).getByText('Last error: reconciliation worker timed out'),
    ).toBeInTheDocument()
  })

  it('does not claim a replay happened when the job was already queued', async () => {
    // `replayEvent` dedupes on the job id `reconcile:webhook:<eventId>` and
    // returns `alreadyQueued: true` having enqueued nothing.
    mockGet()
    vi.spyOn(api, 'post').mockResolvedValue({ data: { alreadyQueued: true } })
    const successSpy = vi.spyOn(toast, 'success').mockReturnValue('toast-1')
    grantPermissions(REPLAYER)

    const user = await openWebhooksTab()
    await screen.findByText('evt-stuck-1')
    await user.click(screen.getAllByRole('button', { name: 'Replay' })[0])

    const dialog = await screen.findByRole('alertdialog', {
      name: 'Replay this webhook event?',
    })
    await user.type(within(dialog).getByLabelText('Reason'), 'worker outage')
    await user.click(within(dialog).getByRole('button', { name: 'Replay event' }))

    await waitFor(() => {
      expect(successSpy).toHaveBeenCalledWith(
        'Already queued for replay — nothing new was enqueued.',
      )
    })
  })
})
