import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { useLocation } from 'react-router'

import { usePermissionStore, type RbacAction } from '@/features/rbac'
import { loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import PaymentsPage from './payments-page'

/**
 * The Payments page as a destination: what a link into it asks the server for,
 * what an operator's clicks write into the address bar, and what the details
 * sheet shows for one payment.
 *
 * The server below is a small fake with the real endpoint's manners. It filters
 * by the parameters it is given — so a filter the page forgot to send shows up
 * as wrong ROWS, not only as a wrong call — and it refuses, like
 * `ValidationPipe({ forbidNonWhitelisted })`, any parameter the endpoint does
 * not declare. A UI-only key leaking into the request fails loudly here.
 */

const USER_ID = 'cmfk2x9pq0000abcd1234efgh'
const OTHER_USER_ID = 'cmfk2x9pq0001abcd1234efgh'
const SUBSCRIPTION_ID = 'cmfk2x9pq0002abcd1234efgh'

interface FakeTransaction {
  readonly id: string
  readonly paymentId: string
  readonly gatewayId: string | null
  readonly userId: string
  readonly subscriptionId: string | null
  readonly lineItemSubscriptionIds: readonly string[]
  readonly status: string
  readonly gatewayType: string
}

const ALICE_PAYMENT: FakeTransaction = {
  id: 'cmfk2x9pq0010abcd1234efgh',
  paymentId: 'cmfk2x9pq0011abcd1234efgh',
  gatewayId: '2d8e4f1a-000f-5000-9000-1b2c3d4e5f60',
  userId: USER_ID,
  subscriptionId: SUBSCRIPTION_ID,
  lineItemSubscriptionIds: [],
  status: 'COMPLETED',
  gatewayType: 'YOOKASSA',
}
const BOB_PAYMENT: FakeTransaction = {
  id: 'cmfk2x9pq0020abcd1234efgh',
  paymentId: 'cmfk2x9pq0021abcd1234efgh',
  gatewayId: null,
  userId: OTHER_USER_ID,
  subscriptionId: null,
  lineItemSubscriptionIds: [SUBSCRIPTION_ID],
  status: 'REFUNDED',
  gatewayType: 'PLATEGA',
}
const TRANSACTIONS: readonly FakeTransaction[] = [ALICE_PAYMENT, BOB_PAYMENT]

const LIST_KEYS = new Set([
  'limit',
  'offset',
  'q',
  'userSearch',
  'userId',
  'subscriptionId',
  'status',
  'gatewayType',
  'purchaseType',
  'dateFrom',
  'dateTo',
])

function wire(tx: FakeTransaction) {
  return {
    ...tx,
    userTelegramId: tx.userId === USER_ID ? '777' : null,
    userUsername: tx.userId === USER_ID ? 'alice' : 'bob',
    userName: tx.userId === USER_ID ? 'Alice' : 'Bob',
    userEmail: null,
    purchaseType: 'RENEW',
    channel: 'WEB',
    currency: 'RUB',
    amount: '299',
    paymentAsset: null,
    planSnapshot: { name: 'Pro', selectedDurationDays: 30 },
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:06.000Z',
    fulfilledAt: '2026-09-01T10:00:05.000Z',
  }
}

function badRequest(message: string): Error {
  return Object.assign(new Error('Request failed with status code 400'), {
    response: { status: 400, data: { statusCode: 400, error: 'Bad Request', message: [message] } },
  })
}

function webhookEvent(paymentId: string, id: string, gatewayType = 'YOOKASSA') {
  return {
    id,
    gatewayType,
    paymentId,
    providerEventId: `evt-${id}`,
    eventStatus: 'payment.succeeded',
    status: 'PROCESSED',
    receivedAt: '2026-09-01T10:00:01.000Z',
    processedAt: '2026-09-01T10:00:02.000Z',
    lastError: null,
  }
}

function fakeServer(options: { readonly events?: Record<string, unknown[]> } = {}) {
  return vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    const [route, query = ''] = path.split('?')
    const params = new URLSearchParams(query)
    if (route === '/admin/payments/transactions') {
      for (const key of params.keys()) {
        if (!LIST_KEYS.has(key)) throw badRequest(`property ${key} should not exist`)
      }
      const userId = params.get('userId')
      if (userId !== null && !/^c[a-z0-9]{20,40}$/.test(userId)) {
        throw badRequest('userId must be a user id (a cuid, or a UUID on older rows)')
      }
      const q = params.get('q')
      const subscriptionId = params.get('subscriptionId')
      const status = params.get('status')
      const rows = TRANSACTIONS.filter(
        (tx) =>
          (q === null || tx.paymentId === q || tx.gatewayId === q || tx.id === q) &&
          (userId === null || tx.userId === userId) &&
          (subscriptionId === null ||
            tx.subscriptionId === subscriptionId ||
            tx.lineItemSubscriptionIds.includes(subscriptionId)) &&
          (status === null || tx.status === status),
      )
      return { data: { items: rows.map(wire), total: rows.length } }
    }
    if (route === '/admin/payments/webhooks/events') {
      const paymentId = params.get('paymentId')
      if (paymentId === null) return { data: [] }
      return { data: options.events?.[paymentId] ?? [] }
    }
    if (route === '/admin/payments/reconciliation/health') {
      return {
        data: {
          queue: { waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0 },
          eventsByStatus: { RECEIVED: 0, ENQUEUED: 0, PROCESSING: 0, PROCESSED: 0, FAILED: 0 },
          staleProcessingCount: 0,
          staleEnqueuedCount: 0,
          generatedAt: '2026-09-01T10:00:00.000Z',
        },
      }
    }
    return { data: {} }
  })
}

function listRequests(spy: ReturnType<typeof fakeServer>): URLSearchParams[] {
  return spy.mock.calls
    .map((call) => String(call[0]))
    .filter((path) => path.startsWith('/admin/payments/transactions?'))
    .map((path) => new URLSearchParams(path.split('?')[1]))
}

function grant(tokens: ReadonlyArray<{ resource: string; action: RbacAction }>): void {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(tokens.map((p) => `${p.resource}:${p.action}`)),
    mustChangePassword: false,
    // Not 'DEV': DEV passes every check, and the permission cases would be vacuous.
    role: 'ADMIN',
    rbacRoleId: 'role-1',
    error: null,
  })
}

const PAYMENTS_VIEW = { resource: 'payments', action: 'view' as RbacAction }
const WEBHOOKS_VIEW = { resource: 'payment_webhooks', action: 'view' as RbacAction }
const USERS_VIEW = { resource: 'users', action: 'view' as RbacAction }

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</output>
}

function address(): URL {
  return new URL(screen.getByTestId('location').textContent ?? '', 'http://panel.test')
}

function renderPage(route: string) {
  const user = userEvent.setup()
  renderWithProviders(
    <>
      <PaymentsPage />
      <LocationProbe />
    </>,
    { route },
  )
  return user
}

beforeEach(async () => {
  usePermissionStore.getState().reset()
  vi.restoreAllMocks()
  await loadFeatureBundle('payments')
})

describe('links into the Payments page', () => {
  it("opens on one client's payments from ?userId=, and says so above the list", async () => {
    const server = fakeServer()
    grant([PAYMENTS_VIEW])

    renderPage(`/payments?userId=${USER_ID}`)

    expect(await screen.findByText('@alice')).toBeInTheDocument()
    expect(screen.queryByText('@bob')).not.toBeInTheDocument()
    expect(listRequests(server).at(-1)?.get('userId')).toBe(USER_ID)
    expect(screen.getByRole('button', { name: 'Show payments of every client' })).toBeInTheDocument()
  })

  it('drops the client filter, and only it, when its chip is removed', async () => {
    fakeServer()
    grant([PAYMENTS_VIEW])
    const user = renderPage(`/payments?userId=${USER_ID}&status=COMPLETED#transactions`)

    await user.click(await screen.findByRole('button', { name: 'Show payments of every client' }))

    await waitFor(() => expect(address().searchParams.has('userId')).toBe(false))
    expect(address().searchParams.get('status')).toBe('COMPLETED')
    expect(address().hash).toBe('#transactions')
  })

  it("opens on one subscription's payments from ?subscriptionId=, the combined renewal included", async () => {
    const server = fakeServer()
    grant([PAYMENTS_VIEW])

    renderPage(`/payments?subscriptionId=${SUBSCRIPTION_ID}`)

    expect(await screen.findByText('@alice')).toBeInTheDocument()
    expect(screen.getByText('@bob')).toBeInTheDocument()
    expect(listRequests(server).at(-1)?.get('subscriptionId')).toBe(SUBSCRIPTION_ID)
  })

  it('opens on one payment from ?q=, and the search box shows what the list is filtered by', async () => {
    const server = fakeServer()
    grant([PAYMENTS_VIEW])

    renderPage(`/payments?q=${ALICE_PAYMENT.gatewayId}`)

    expect(await screen.findByText('@alice')).toBeInTheDocument()
    expect(screen.queryByText('@bob')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Payment' })).toHaveValue(ALICE_PAYMENT.gatewayId)
    expect(listRequests(server).at(-1)?.get('q')).toBe(ALICE_PAYMENT.gatewayId)
  })

  it('shows the server refusing a malformed link, instead of "No transactions found"', async () => {
    fakeServer()
    grant([PAYMENTS_VIEW])

    renderPage('/payments?userId=12345')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load payments')
    expect(alert).toHaveTextContent('userId must be a user id')
    expect(screen.queryByText('No transactions found')).not.toBeInTheDocument()
  })
})

describe('filters written to the address bar', () => {
  it('searches for a typed payment reference and puts it in the URL', async () => {
    const server = fakeServer()
    grant([PAYMENTS_VIEW])
    const user = renderPage('/payments')
    await screen.findByText('@bob')

    await user.type(screen.getByRole('textbox', { name: 'Payment' }), ALICE_PAYMENT.paymentId)

    await waitFor(() => expect(address().searchParams.get('q')).toBe(ALICE_PAYMENT.paymentId))
    await waitFor(() => expect(screen.queryByText('@bob')).not.toBeInTheDocument())
    expect(listRequests(server).at(-1)?.get('q')).toBe(ALICE_PAYMENT.paymentId)
  })

  it('offers REFUNDED in the status filter and sends it', async () => {
    const server = fakeServer()
    grant([PAYMENTS_VIEW])
    const user = renderPage('/payments')
    await screen.findByText('@alice')

    await user.click(screen.getByRole('combobox', { name: 'Status' }))
    await user.click(await screen.findByRole('option', { name: 'REFUNDED' }))

    await waitFor(() => expect(address().searchParams.get('status')).toBe('REFUNDED'))
    await waitFor(() => expect(screen.queryByText('@alice')).not.toBeInTheDocument())
    expect(screen.getByText('@bob')).toBeInTheDocument()
    expect(listRequests(server).at(-1)?.get('status')).toBe('REFUNDED')
  })

  it('never sends the open payment or the page number to the API', async () => {
    const server = fakeServer()
    grant([PAYMENTS_VIEW])

    renderPage(`/payments?payment=${ALICE_PAYMENT.paymentId}&page=1&status=COMPLETED`)

    await screen.findByRole('dialog')
    for (const params of listRequests(server)) {
      expect(params.has('payment')).toBe(false)
      expect(params.has('page')).toBe(false)
    }
  })
})

describe('the ids on a transaction row', () => {
  it('shows our payment id and the payment system id, each copyable and revealed in full', async () => {
    fakeServer()
    grant([PAYMENTS_VIEW])

    renderPage(`/payments?userId=${USER_ID}`)

    const row = (await screen.findByText('@alice')).closest('tr')
    if (row === null) throw new Error('no row')
    expect(within(row).getByRole('button', { name: `Payment ID: ${ALICE_PAYMENT.paymentId}` })).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: 'Copy Payment ID' })).toBeInTheDocument()
    expect(within(row).getByText('Payment system ID')).toBeInTheDocument()
    expect(
      within(row).getByRole('button', { name: `Payment system ID: ${ALICE_PAYMENT.gatewayId}` }),
    ).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: 'Copy Payment system ID' })).toBeInTheDocument()
  })
})

describe('opening a row', () => {
  it('does not open the payment when the click ends a text selection inside the row', async () => {
    fakeServer()
    grant([PAYMENTS_VIEW])
    renderPage('/payments')
    const cell = await screen.findByText('@alice')

    // The operator drags across the name to copy it by hand.
    const range = document.createRange()
    range.selectNodeContents(cell)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    fireEvent.click(cell)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(address().searchParams.has('payment')).toBe(false)
    window.getSelection()?.removeAllRanges()
  })

  it('opens from the keyboard: the row takes focus and Enter opens it', async () => {
    fakeServer()
    grant([PAYMENTS_VIEW])
    const user = renderPage('/payments')
    const row = (await screen.findByText('@alice')).closest('tr')
    if (row === null) throw new Error('no row')

    row.focus()
    await user.keyboard('{Enter}')

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(address().searchParams.get('payment')).toBe(ALICE_PAYMENT.paymentId)
  })

  it('does not open when Enter presses a control inside the row', async () => {
    fakeServer()
    grant([PAYMENTS_VIEW])
    vi.spyOn(toast, 'success').mockReturnValue('ok')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    })
    const user = renderPage('/payments')
    const row = (await screen.findByText('@alice')).closest('tr')
    if (row === null) throw new Error('no row')

    within(row).getByRole('button', { name: 'Copy Payment ID' }).focus()
    await user.keyboard('{Enter}')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('imported payments in the table', () => {
  it('shows each imported id by its namespace and its own tail, not one identical prefix', async () => {
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path.startsWith('/admin/payments/transactions?')) {
        const rows = [
          { ...wire(ALICE_PAYMENT), id: 'r1', paymentId: 'remnashop:1048576', gatewayId: null },
          { ...wire(ALICE_PAYMENT), id: 'r2', paymentId: 'remnashop:1048599', gatewayId: null },
        ]
        return { data: { items: rows, total: rows.length } }
      }
      return { data: {} }
    })
    grant([PAYMENTS_VIEW])

    renderPage('/payments')

    expect(await screen.findByText('remnashop:…8576')).toBeInTheDocument()
    expect(screen.getByText('remnashop:…8599')).toBeInTheDocument()
  })
})

describe('the payment details sheet', () => {
  it("names the payment system and states the amount in the operator's language", async () => {
    fakeServer()
    grant([PAYMENTS_VIEW])

    renderPage(`/payments?payment=${ALICE_PAYMENT.paymentId}`)

    const sheet = await screen.findByRole('dialog')
    expect(await within(sheet).findByText('YooKassa')).toBeInTheDocument()
    expect(within(sheet).queryByText('YOOKASSA')).not.toBeInTheDocument()
    // Exactly as stored, in the operator's language — never '299 RUB' as it came off the wire.
    expect(within(sheet).getAllByText('₽299.00').length).toBeGreaterThan(0)
  })

  it('says a failed payment delivers nothing, instead of «not yet»', async () => {
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path.startsWith('/admin/payments/transactions?')) {
        const failed = { ...wire(ALICE_PAYMENT), status: 'FAILED', fulfilledAt: null }
        return { data: { items: [failed], total: 1 } }
      }
      return { data: [] }
    })
    grant([PAYMENTS_VIEW])

    renderPage(`/payments?payment=${ALICE_PAYMENT.paymentId}`)

    const sheet = await screen.findByRole('dialog')
    expect(await within(sheet).findByText('Not delivered: the payment did not go through')).toBeInTheDocument()
  })

  it('opens from a row with all three ids, and the URL names the payment', async () => {
    fakeServer()
    grant([PAYMENTS_VIEW])
    const user = renderPage('/payments')

    await user.click(await screen.findByText('@alice'))

    const sheet = await screen.findByRole('dialog')
    expect(address().searchParams.get('payment')).toBe(ALICE_PAYMENT.paymentId)
    expect(within(sheet).getByText(ALICE_PAYMENT.paymentId)).toBeInTheDocument()
    expect(within(sheet).getByText(ALICE_PAYMENT.gatewayId ?? '')).toBeInTheDocument()
    expect(within(sheet).getByText(ALICE_PAYMENT.id)).toBeInTheDocument()
    expect(within(sheet).getByText("The payment system's own number — the one their support asks for.")).toBeInTheDocument()
  })

  it('opens from the explicit button of a row too — the control a keyboard reaches', async () => {
    fakeServer()
    grant([PAYMENTS_VIEW])
    const user = renderPage('/payments')

    await user.click(await screen.findByRole('button', { name: `Open payment ${BOB_PAYMENT.paymentId}` }))

    expect(await screen.findByRole('dialog')).toHaveTextContent('Combined renewal: 1 subscription')
  })

  it('finds a payment named by its payment system id in a pasted link', async () => {
    const server = fakeServer()
    grant([PAYMENTS_VIEW])

    renderPage(`/payments?payment=${ALICE_PAYMENT.gatewayId}`)

    const sheet = await screen.findByRole('dialog')
    expect(await within(sheet).findByText(ALICE_PAYMENT.id)).toBeInTheDocument()
    expect(listRequests(server).some((params) => params.get('q') === ALICE_PAYMENT.gatewayId)).toBe(true)
  })

  it('says a reference matches nothing, instead of showing an empty sheet', async () => {
    fakeServer()
    grant([PAYMENTS_VIEW])

    renderPage('/payments?payment=nothing-carries-this')

    expect(await screen.findByText('No payment has this number')).toBeInTheDocument()
  })

  it("links to the client's card and to all of the client's payments", async () => {
    fakeServer()
    grant([PAYMENTS_VIEW, USERS_VIEW])

    renderPage(`/payments?payment=${ALICE_PAYMENT.paymentId}`)

    const sheet = await screen.findByRole('dialog')
    expect(await within(sheet).findByRole('link', { name: 'Open user card' })).toHaveAttribute(
      'href',
      `/users/${USER_ID}`,
    )
    expect(within(sheet).getByRole('link', { name: 'All client payments' })).toHaveAttribute(
      'href',
      `/payments?userId=${USER_ID}`,
    )
    expect(within(sheet).getByRole('link', { name: 'All payments for this subscription' })).toHaveAttribute(
      'href',
      `/payments?subscriptionId=${SUBSCRIPTION_ID}`,
    )
  })

  it('offers no user-card link to an operator who cannot open user cards', async () => {
    fakeServer()
    grant([PAYMENTS_VIEW])

    renderPage(`/payments?payment=${ALICE_PAYMENT.paymentId}`)

    const sheet = await screen.findByRole('dialog')
    await within(sheet).findByRole('link', { name: 'All client payments' })
    expect(within(sheet).queryByRole('link', { name: 'Open user card' })).not.toBeInTheDocument()
  })

  it("lists the payment's webhooks, asked for by both of its references", async () => {
    const server = fakeServer({
      events: {
        [ALICE_PAYMENT.paymentId]: [webhookEvent(ALICE_PAYMENT.paymentId, 'ev-1')],
        // A YooKassa refund notice names the gateway's payment id instead.
        [ALICE_PAYMENT.gatewayId ?? '']: [
          webhookEvent(ALICE_PAYMENT.gatewayId ?? '', 'ev-2'),
          // The same id from ANOTHER gateway is not this payment's.
          webhookEvent(ALICE_PAYMENT.gatewayId ?? '', 'ev-3', 'PLATEGA'),
        ],
      },
    })
    grant([PAYMENTS_VIEW, WEBHOOKS_VIEW])

    renderPage(`/payments?payment=${ALICE_PAYMENT.paymentId}`)

    const sheet = await screen.findByRole('dialog')
    expect(await within(sheet).findByText('evt-ev-1')).toBeInTheDocument()
    expect(within(sheet).getByText('evt-ev-2')).toBeInTheDocument()
    expect(within(sheet).queryByText('evt-ev-3')).not.toBeInTheDocument()
    const eventCalls = server.mock.calls.map((call) => String(call[0])).filter((path) => path.startsWith('/admin/payments/webhooks/events?'))
    expect(eventCalls).toContain(`/admin/payments/webhooks/events?paymentId=${ALICE_PAYMENT.paymentId}&limit=50`)
    expect(eventCalls).toContain(`/admin/payments/webhooks/events?paymentId=${ALICE_PAYMENT.gatewayId}&limit=50`)
  })

  it('refuses in words, and asks for nothing, without payment_webhooks:view', async () => {
    const server = fakeServer()
    grant([PAYMENTS_VIEW])

    renderPage(`/payments?payment=${ALICE_PAYMENT.paymentId}`)

    const sheet = await screen.findByRole('dialog')
    expect(await within(sheet).findByText('payment_webhooks:view')).toBeInTheDocument()
    expect(
      server.mock.calls.some((call) => String(call[0]).startsWith('/admin/payments/webhooks/events?paymentId=')),
    ).toBe(false)
  })

  it('closes by dropping the payment from the URL and keeping the filters', async () => {
    fakeServer()
    grant([PAYMENTS_VIEW])
    const user = renderPage(`/payments?status=COMPLETED&payment=${ALICE_PAYMENT.paymentId}`)

    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(address().searchParams.has('payment')).toBe(false)
    expect(address().searchParams.get('status')).toBe('COMPLETED')
  })
})

describe('webhook events lead to their payment', () => {
  it("opens the event's payment over the Webhooks tab, which stays selected", async () => {
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/payments/webhooks/events?limit=30') {
        return { data: [webhookEvent(ALICE_PAYMENT.paymentId, 'ev-1')] }
      }
      if (path.startsWith('/admin/payments/transactions?')) {
        const q = new URLSearchParams(path.split('?')[1]).get('q')
        const rows = TRANSACTIONS.filter((tx) => q === null || tx.paymentId === q)
        return { data: { items: rows.map(wire), total: rows.length } }
      }
      if (path.startsWith('/admin/payments/webhooks/events?paymentId=')) return { data: [] }
      return { data: {} }
    })
    grant([PAYMENTS_VIEW, WEBHOOKS_VIEW])
    const user = renderPage('/payments#webhooks')

    await user.click(await screen.findByRole('button', { name: `Open payment ${ALICE_PAYMENT.paymentId}` }))

    const sheet = await screen.findByRole('dialog')
    expect(await within(sheet).findByText(ALICE_PAYMENT.id)).toBeInTheDocument()
    expect(address().hash).toBe('#webhooks')
    expect(address().searchParams.get('payment')).toBe(ALICE_PAYMENT.paymentId)
  })
})
