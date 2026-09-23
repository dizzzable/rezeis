/**
 * A trial's conversion withheld for refund, in the panel (R3-support-money N4
 * and laterList 3).
 *
 * The payment is COMPLETED and stamped delivered, so every list showed it as an
 * ordinary sale; and nothing in the panel could record that its money had gone
 * back, which most gateways never report. Now it is marked wherever a payment
 * is listed — the Payments list, its details, the user card's Operations tab —
 * and its details carry «Отметить возврат» while the money is held, to
 * `payments:refund` only. The operator's card names that button's path.
 *
 * (The user card half drives `features/users/user-detail-panel.tsx`.)
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
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
import type { DashboardSummaryInterface } from '@/features/dashboard/dashboard-api'
import { DashboardTimelinesSection } from '@/features/dashboard/dashboard-timelines'
import { PaymentDetailsSheet } from './payment-details-sheet'
import PaymentsPage from './payments-page'
import type { TransactionRow } from './payment-records'

const USER_ID = 'cmfk2x9pq0000abcd1234efgh'

const ORDINARY: TransactionRow = {
  id: 'cmfk2x9pq0010abcd1234efgh',
  paymentId: 'cmfk2x9pq0011abcd1234efgh',
  userId: USER_ID,
  userUsername: 'alice',
  userName: 'Alice',
  subscriptionId: 'cmfk2x9pq0002abcd1234efgh',
  lineItemSubscriptionIds: [],
  status: 'COMPLETED',
  purchaseType: 'UPGRADE',
  channel: 'WEB',
  gatewayType: 'PLATEGA',
  gatewayId: 'platega-1',
  currency: 'RUB',
  amount: '799',
  paymentAsset: null,
  planSnapshot: { name: 'Pro', selectedDurationDays: 30 },
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:06.000Z',
  fulfilledAt: '2026-09-01T10:00:05.000Z',
  conversionWithheld: null,
}

const WITHHELD: TransactionRow = {
  ...ORDINARY,
  id: 'cmfk2x9pq0020abcd1234efgh',
  paymentId: 'cmfk2x9pq0021abcd1234efgh',
  gatewayId: 'platega-2',
  conversionWithheld: {
    withheldAt: '2026-09-01T10:00:05.000Z',
    convertedByPaymentId: ORDINARY.paymentId,
    refundedAt: null,
  },
}

const REFUNDED: TransactionRow = {
  ...WITHHELD,
  status: 'CANCELED',
  conversionWithheld: { ...WITHHELD.conversionWithheld!, refundedAt: '2026-09-02T09:00:00.000Z' },
}

const VIEW = { resource: 'payments', action: 'view' as RbacAction }
const REFUND = { resource: 'payments', action: 'refund' as RbacAction }

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

function renderSheet(seed: TransactionRow) {
  const user = userEvent.setup()
  renderWithProviders(
    <PaymentDetailsSheet reference={seed.paymentId} seed={seed} onClose={() => undefined} onShowMatches={() => undefined} />,
    { route: '/payments' },
  )
  return user
}

beforeAll(async () => {
  await i18nReady
  await loadFeatureBundle('payments')
  await loadFeatureBundle('userDetail')
})

beforeEach(() => {
  vi.restoreAllMocks()
  usePermissionStore.getState().reset()
  toastMock.success.mockClear()
  toastMock.error.mockClear()
})

describe('a withheld payment in its details', () => {
  it('says what it is and offers «Record refund» to an operator who may refund', async () => {
    grant([VIEW, REFUND])

    renderSheet(WITHHELD)

    const section = await screen.findByRole('region', { name: /Payment received but not applied/ })
    expect(within(section).getByRole('button', { name: 'Record refund' })).toBeInTheDocument()
    expect(within(section).getByText(ORDINARY.paymentId)).toBeInTheDocument()
    // Stamped like a delivery, and said not to be one.
    expect(screen.getByText('Not delivered: the payment was not applied')).toBeInTheDocument()
  })

  it('offers nothing of the kind for an ordinary payment, to the same operator', async () => {
    grant([VIEW, REFUND])

    renderSheet(ORDINARY)

    expect(await screen.findByText(ORDINARY.gatewayId!)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Record refund' })).not.toBeInTheDocument()
    expect(screen.queryByText('Not applied')).not.toBeInTheDocument()
  })

  it('offers nothing once its refund is recorded, and says when it was', async () => {
    grant([VIEW, REFUND])

    renderSheet(REFUNDED)

    const section = await screen.findByRole('region', { name: /Payment received but not applied/ })
    expect(within(section).queryByRole('button', { name: 'Record refund' })).not.toBeInTheDocument()
    expect(within(section).getByText(/^Refund recorded /)).toBeInTheDocument()
  })

  it('offers nothing without payments:refund, and says who may', async () => {
    grant([VIEW])

    renderSheet(WITHHELD)

    const section = await screen.findByRole('region', { name: /Payment received but not applied/ })
    expect(within(section).queryByRole('button', { name: 'Record refund' })).not.toBeInTheDocument()
    expect(within(section).getByText(/payments:refund/)).toBeInTheDocument()
  })

  it('records it after the confirmation, and then shows the refund instead of the button', async () => {
    grant([VIEW, REFUND])
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      data: { transactionId: WITHHELD.id, recorded: true, refundedAt: '2026-09-23T12:00:00.000Z' },
    })
    const user = renderSheet(WITHHELD)

    await user.click(await screen.findByRole('button', { name: 'Record refund' }))
    expect(post).not.toHaveBeenCalled()
    await user.click(await screen.findByRole('button', { name: 'Yes, the money is returned' }))

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post).toHaveBeenCalledWith(`/admin/payments/transactions/${WITHHELD.id}/withheld-refund`)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Record refund' })).not.toBeInTheDocument())
    expect(screen.getByText(/^Refund recorded /)).toBeInTheDocument()
    expect(toastMock.success).toHaveBeenCalledWith('Refund recorded')
  })

  it('says in words that another click is already recording it', async () => {
    grant([VIEW, REFUND])
    vi.spyOn(api, 'post').mockRejectedValue(
      Object.assign(new Error('Request failed with status code 409'), {
        response: { status: 409, data: { statusCode: 409, message: 'PAYMENT_WITHHELD_REFUND_IN_PROGRESS' } },
      }),
    )
    const user = renderSheet(WITHHELD)

    await user.click(await screen.findByRole('button', { name: 'Record refund' }))
    await user.click(await screen.findByRole('button', { name: 'Yes, the money is returned' }))

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        'The refund of this payment is being recorded. Refresh the page in a minute.',
      ),
    )
  })
})

describe('a withheld payment where payments are listed', () => {
  it('is marked in the Payments list, and the ordinary one beside it is not', async () => {
    grant([VIEW])
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path.startsWith('/admin/payments/transactions?')) {
        return { data: { items: [ORDINARY, WITHHELD], total: 2 } }
      }
      return { data: {} }
    })
    renderWithProviders(<PaymentsPage />, { route: '/payments' })

    const withheldRow = (await screen.findByText('platega-2')).closest('tr')
    const ordinaryRow = screen.getByText('platega-1').closest('tr')
    if (!(withheldRow instanceof HTMLElement) || !(ordinaryRow instanceof HTMLElement)) throw new Error('no rows')
    expect(within(withheldRow).getByText('Not applied')).toBeInTheDocument()
    expect(within(ordinaryRow).queryByText('Not applied')).not.toBeInTheDocument()
  })

  it("is marked in the user card's Operations tab, and the ordinary one is not", async () => {
    grant([{ resource: 'users', action: 'view' }, VIEW])
    const operation = (row: TransactionRow) => ({
      id: row.id,
      kind: 'PAYMENT',
      occurredAt: row.createdAt,
      payload: {
        paymentId: row.paymentId,
        status: row.status,
        purchaseType: row.purchaseType,
        gatewayType: row.gatewayType,
        currency: row.currency,
        amount: String(row.amount),
        conversionWithheld: row.conversionWithheld ?? null,
      },
    })
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/users/12345/operations') {
        return { data: { items: [operation(WITHHELD), operation(ORDINARY)], total: 2, page: 1, limit: 25 } }
      }
      return {
        data: {
          id: USER_ID,
          telegramId: '12345',
          username: 'alice',
          name: 'Alice',
          email: null,
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
        },
      }
    })
    const user = userEvent.setup()
    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    await user.click(await screen.findByRole('tab', { name: 'Operations' }))

    const card = (id: string) => {
      const found = screen.getByText(id).closest('.rounded-lg')
      if (!(found instanceof HTMLElement)) throw new Error(`no card for ${id}`)
      return found
    }
    await screen.findByText(WITHHELD.paymentId)
    expect(within(card(WITHHELD.paymentId)).getByText('Not applied')).toBeInTheDocument()
    expect(within(card(ORDINARY.paymentId)).queryByText('Not applied')).not.toBeInTheDocument()
  })
})

describe('«Отметить возврат» in the dashboard audit timeline', () => {
  // The audit row the record writes. Without a name for its code the timeline
  // printed `payments.transaction.withheld_refund_recorded` in either language.
  const RECORDED = {
    id: 'audit:withheld',
    source: 'AUDIT',
    status: 'INFO',
    title: 'payments.transaction.withheld_refund_recorded',
    description: '',
    createdAt: '2026-09-23T12:00:00.000Z',
    kind: 'AUDIT',
    meta: { action: 'payments.transaction.withheld_refund_recorded' },
  } as const
  const summary = {
    checkedAt: '2026-09-23T12:00:00.000Z',
    users: { total: 1, blocked: 0, recentRegistered7d: 0 },
    subscriptions: { active: 0, limited: 0, expired: 0, expiring7d: 0 },
    transactions: { completed: 0, pending: 0, failed: 0, grossVolume: '—' },
    revenue: { figure: { value: 0, byCurrency: [] }, money: { currency: 'RUB', converted: false, rates: [], unconverted: [] }, payments: 0 },
    operations: { broadcastDrafts: 0, importDryRunAvailable: false },
    financeOps: {
      refundRequests: 0,
      executedRefunds: 0,
      correctionNotes: 0,
      correctionRequests: 0,
      disputeRecords: 0,
      reconciliationExceptions: 0,
    },
    metrics: [],
    operationsTimeline: [RECORDED],
    financeOpsTimeline: [],
    attentionItems: [],
  } as unknown as DashboardSummaryInterface

  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('names the action in both languages, not by its code', async () => {
    await loadFeatureBundle('dashboard')
    const { unmount } = renderWithProviders(<DashboardTimelinesSection summary={summary} />)
    expect(screen.getByText('Refund of an unapplied payment recorded')).toBeInTheDocument()
    unmount()

    await i18n.changeLanguage('ru')
    await loadFeatureBundle('dashboard')
    renderWithProviders(<DashboardTimelinesSection summary={summary} />)
    expect(screen.getByText('Отмечен возврат неприменённого платежа')).toBeInTheDocument()
    expect(screen.queryByText('payments.transaction.withheld_refund_recorded')).not.toBeInTheDocument()
  })
})
