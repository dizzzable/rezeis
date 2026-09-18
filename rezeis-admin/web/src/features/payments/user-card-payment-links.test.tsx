/**
 * The user card's Operations tab as a way into payments.
 *
 * It showed each payment's id as bare text — no copy, no way to open it — and
 * nothing led from a customer to their payments on the Payments page, which
 * could not be filtered by customer anyway (`userId` was `@IsUUID('4')` against
 * cuid ids). Now each id goes through `CopyableId`, each payment opens its
 * details, and «Все платежи клиента» opens the list on this customer.
 *
 * The refund control lives on the same card and is asserted to still be there:
 * the card was rebuilt around it.
 *
 * (It lives with the payments feature only because that is where this change
 * may write; it drives `features/users/user-detail-panel.tsx`.)
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import { usePermissionStore, type RbacAction } from '@/features/rbac'

vi.mock('@/features/plans/plans-api', () => ({ usePlans: () => ({ data: [] }) }))

const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: toastMock }))

import UserDetailPanel from '@/features/users/user-detail-panel'

const USER_ID = 'cmfk2x9pq0000abcd1234efgh'
const PAYMENT_ID = 'cmfk2x9pq0011abcd1234efgh'
const TRANSACTION_ID = 'cmfk2x9pq0010abcd1234efgh'

const USER = {
  id: USER_ID,
  telegramId: '12345',
  username: 'alice',
  name: 'Alice',
  email: 'alice@example.com',
  language: 'en',
  role: 'USER',
  isBlocked: false,
  isPartner: false,
  points: 0,
  personalDiscount: 0,
  purchaseDiscount: 0,
  maxSubscriptions: 1,
  createdAt: '2026-06-04T10:00:00.000Z',
  updatedAt: '2026-06-04T10:00:00.000Z',
  subscriptions: [],
  transactions: [],
  referralsGiven: [],
  partner: null,
  webAccount: null,
}

const OPERATIONS = {
  items: [
    {
      id: TRANSACTION_ID,
      kind: 'PAYMENT',
      occurredAt: '2026-09-01T10:00:00.000Z',
      payload: {
        paymentId: PAYMENT_ID,
        status: 'COMPLETED',
        purchaseType: 'RENEW',
        gatewayType: 'YOOKASSA',
        currency: 'RUB',
        amount: '299',
      },
    },
  ],
  total: 1,
  page: 1,
  limit: 25,
}

function mockApi(): void {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/users/12345/operations') return { data: OPERATIONS }
    return { data: { ...USER } }
  })
}

function grant(tokens: ReadonlyArray<{ resource: string; action: RbacAction }>): void {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(tokens.map((p) => `${p.resource}:${p.action}`)),
    mustChangePassword: false,
    role: 'ADMIN',
    rbacRoleId: 'role-1',
    error: null,
  })
}

async function openOperations() {
  const user = userEvent.setup()
  renderWithProviders(<UserDetailPanel telegramId="12345" />)
  await user.click(await screen.findByRole('tab', { name: 'Operations' }))
  const card = (await screen.findByText(PAYMENT_ID)).closest('.rounded-lg')
  if (!(card instanceof HTMLElement)) throw new Error('no payment card')
  return { user, card }
}

beforeAll(async () => {
  await i18nReady
  await loadFeatureBundle('userDetail')
})

beforeEach(() => {
  vi.restoreAllMocks()
  usePermissionStore.getState().reset()
  toastMock.success.mockClear()
  toastMock.error.mockClear()
})

describe('Operations tab → payments', () => {
  it("links to all of the client's payments by the client's own id", async () => {
    mockApi()
    grant([
      { resource: 'users', action: 'view' },
      { resource: 'payments', action: 'view' },
    ])

    await openOperations()

    // By `User.id`, not by the Telegram id the card was opened with: the
    // Payments page filters by the former.
    expect(screen.getByRole('link', { name: 'All client payments' })).toHaveAttribute(
      'href',
      `/payments?userId=${USER_ID}`,
    )
  })

  it('shows each payment id copyable, and opens that payment', async () => {
    mockApi()
    grant([
      { resource: 'users', action: 'view' },
      { resource: 'payments', action: 'view' },
    ])

    const { card } = await openOperations()

    expect(within(card).getByRole('button', { name: 'Copy Payment ID' })).toBeInTheDocument()
    expect(within(card).getByRole('link', { name: 'Open payment' })).toHaveAttribute(
      'href',
      `/payments?payment=${PAYMENT_ID}`,
    )
  })

  it('copies the payment id and says so only once it is on the clipboard', async () => {
    mockApi()
    grant([{ resource: 'users', action: 'view' }])
    const { user, card } = await openOperations()
    // The clipboard answers only when the test says so, so a "copied" claimed
    // before the answer — the defect this card had — has room to show itself.
    let answer: (() => void) | undefined
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          answer = resolve
        }),
    )
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    await user.click(within(card).getByRole('button', { name: 'Copy Payment ID' }))

    expect(writeText).toHaveBeenCalledWith(PAYMENT_ID)
    expect(toastMock.success).not.toHaveBeenCalled()
    expect(toastMock.error).not.toHaveBeenCalled()

    answer?.()

    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Payment ID copied'))
  })

  it('offers no link into a Payments page the operator cannot open', async () => {
    mockApi()
    grant([{ resource: 'users', action: 'view' }])

    const { card } = await openOperations()

    expect(screen.queryByRole('link', { name: 'All client payments' })).not.toBeInTheDocument()
    expect(within(card).queryByRole('link', { name: 'Open payment' })).not.toBeInTheDocument()
    // The id itself is still there to read and copy.
    expect(within(card).getByRole('button', { name: 'Copy Payment ID' })).toBeInTheDocument()
  })

  it('keeps the refund action on the payment card', async () => {
    mockApi()
    grant([
      { resource: 'users', action: 'view' },
      { resource: 'payments', action: 'view' },
      { resource: 'payments', action: 'refund' },
    ])

    const { card } = await openOperations()

    expect(within(card).getByRole('button', { name: 'Refund' })).toBeInTheDocument()
  })
})
