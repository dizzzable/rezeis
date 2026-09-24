/**
 * «Отметить возврат» for a payment of any gateway but ЮKassa.
 *
 * The panel refunds by itself only through ЮKassa («Вернуть»). A refund made in
 * Platega's or RollyPay's dashboard never reached it, and the panel had no
 * button to say so — only a withheld payment had one. Now a COMPLETED payment
 * of any other gateway carries «Отметить возврат» in its details («Платежи» →
 * «Транзакции») and beside «Вернуть» in the user card's «Операции», to
 * `payments:refund` only; the dialog says what the panel will undo, and
 * confirming posts to the provider-refund route and nothing else.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { en as paymentsEn } from '@/i18n/features/payments.en'
import { ru as paymentsRu } from '@/i18n/features/payments.ru'
import { en as userDetailEn } from '@/i18n/features/userDetail.en'
import { ru as userDetailRu } from '@/i18n/features/userDetail.ru'
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
import type { TransactionRow } from './payment-records'
import { isProviderRefundCandidate, type ProviderRefundPayment } from './provider-refund-candidate'

const USER_ID = 'cmfk2x9pq0000abcd1234efgh'

const PLATEGA: TransactionRow = {
  id: 'cmfk2x9pq0030abcd1234efgh',
  paymentId: 'cmfk2x9pq0031abcd1234efgh',
  userId: USER_ID,
  userUsername: 'alice',
  userName: 'Alice',
  subscriptionId: 'cmfk2x9pq0002abcd1234efgh',
  lineItemSubscriptionIds: [],
  status: 'COMPLETED',
  purchaseType: 'NEW',
  channel: 'WEB',
  gatewayType: 'PLATEGA',
  gatewayId: 'platega-30',
  currency: 'RUB',
  amount: '799',
  paymentAsset: null,
  planSnapshot: { name: 'Pro', selectedDurationDays: 30 },
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:06.000Z',
  fulfilledAt: '2026-09-01T10:00:05.000Z',
  conversionWithheld: null,
}

const VIEW = { resource: 'payments', action: 'view' as RbacAction }
const REFUND = { resource: 'payments', action: 'refund' as RbacAction }
const POST_PATH = `/admin/payments/transactions/${PLATEGA.id}/provider-refund`

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

function refusal(status: number, message: string): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { statusCode: status, message } },
  })
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

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('which payments are offered «Отметить возврат»', () => {
  const candidate: ProviderRefundPayment = {
    id: PLATEGA.id,
    paymentId: PLATEGA.paymentId,
    status: 'COMPLETED',
    gatewayType: 'PLATEGA',
    purchaseType: 'NEW',
    amount: '799',
    currency: 'RUB',
    conversionWithheld: null,
    fulfilledAt: PLATEGA.fulfilledAt,
    planSnapshot: PLATEGA.planSnapshot,
  }

  it('a completed, delivered payment of a gateway the panel does not refund itself', () => {
    expect(isProviderRefundCandidate(candidate)).toBe(true)
    expect(isProviderRefundCandidate({ ...candidate, gatewayType: 'ROLLYPAY' })).toBe(true)
    expect(isProviderRefundCandidate({ ...candidate, gatewayType: 'CRYPTOMUS' })).toBe(true)
    // The «Операции» tab does not know the delivery: the server checks it.
    expect(isProviderRefundCandidate({ ...candidate, fulfilledAt: undefined, planSnapshot: undefined })).toBe(true)
  })

  it('not a ЮKassa payment — «Вернуть» refunds it — nor a partner-balance one, which no provider took', () => {
    expect(isProviderRefundCandidate({ ...candidate, gatewayType: 'YOOKASSA' })).toBe(false)
    expect(isProviderRefundCandidate({ ...candidate, gatewayType: 'PARTNER_BALANCE' })).toBe(false)
    expect(isProviderRefundCandidate({ ...candidate, gatewayType: null })).toBe(false)
  })

  it('not a payment that is not completed, not delivered, for nothing, withheld, or imported', () => {
    expect(isProviderRefundCandidate({ ...candidate, status: 'CANCELED' })).toBe(false)
    expect(isProviderRefundCandidate({ ...candidate, status: 'PENDING' })).toBe(false)
    expect(isProviderRefundCandidate({ ...candidate, fulfilledAt: null })).toBe(false)
    expect(isProviderRefundCandidate({ ...candidate, amount: '0' })).toBe(false)
    expect(isProviderRefundCandidate({ ...candidate, amount: 'abc' })).toBe(false)
    expect(isProviderRefundCandidate({ ...candidate, conversionWithheld: { withheldAt: '2026-09-01T10:00:05.000Z' } })).toBe(false)
    expect(isProviderRefundCandidate({ ...candidate, paymentId: 'bedolaga:4821' })).toBe(false)
    expect(isProviderRefundCandidate({ ...candidate, planSnapshot: { name: 'Pro', importedFrom: 'bedolaga' } })).toBe(false)
  })
})

describe('«Отметить возврат» in the payment’s details', () => {
  it('says what it is for and offers the button to an operator who may refund', async () => {
    grant([VIEW, REFUND])

    renderSheet(PLATEGA)

    const section = await screen.findByRole('region', { name: 'Refund made at the provider' })
    expect(within(section).getByText(/in the Platega dashboard or another way/)).toBeInTheDocument()
    expect(within(section).getByRole('button', { name: 'Record refund' })).toBeInTheDocument()
  })

  it('offers nothing for a ЮKassa payment: «Вернуть» refunds it', async () => {
    grant([VIEW, REFUND])

    renderSheet({ ...PLATEGA, gatewayType: 'YOOKASSA', gatewayId: 'yookassa-30' })

    expect(await screen.findByText('yookassa-30')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Refund made at the provider' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Record refund' })).not.toBeInTheDocument()
  })

  it('leaves a withheld payment to its own section: one «Record refund», which posts the withheld route', async () => {
    grant([VIEW, REFUND])

    renderSheet({
      ...PLATEGA,
      conversionWithheld: { withheldAt: '2026-09-01T10:00:05.000Z', convertedByPaymentId: null, refundedAt: null },
    })

    await screen.findByRole('region', { name: /Payment received but not applied/ })
    expect(screen.queryByRole('region', { name: 'Refund made at the provider' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Record refund' })).toHaveLength(1)
  })

  it('without payments:refund, says who may and offers no button', async () => {
    grant([VIEW])

    renderSheet(PLATEGA)

    const section = await screen.findByRole('region', { name: 'Refund made at the provider' })
    expect(within(section).queryByRole('button', { name: 'Record refund' })).not.toBeInTheDocument()
    expect(within(section).getByText(/payments:refund/)).toBeInTheDocument()
  })

  it('says in the dialog what the panel will undo — and posts nothing before the confirmation', async () => {
    grant([VIEW, REFUND])
    const post = vi.spyOn(api, 'post')
    const user = renderSheet(PLATEGA)

    await user.click(await screen.findByRole('button', { name: 'Record refund' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Record the refund?')).toBeInTheDocument()
    expect(within(dialog).getByText(/^First return .*799.* to the customer at the provider \(Platega\)\. The panel sends the provider nothing/)).toBeInTheDocument()
    const consequences = dialog.querySelector('[data-provider-refund-consequences]')
    if (!(consequences instanceof HTMLElement)) throw new Error('no consequences list')
    const items = within(consequences).getAllByRole('listitem').map((item) => item.textContent)
    expect(items).toEqual([
      'the subscription this payment created is switched off, if nothing else paid for it;',
      'the customer’s autopay ends: at Platega and RollyPay for the subscription this payment paid for, through YooKassa on every saved payment method;',
      // The panel files «Мой налог» receipts for YooKassa payments only, and a
      // refund can be recorded here only for the others: there is no receipt
      // of the panel's to cancel, and the dialog must not say there is.
      'the partner commission, the referral reward and the cashback of this payment are taken back. The panel files «Мой налог» receipts for YooKassa payments only, so it has none for this one: if you declared this income in «Мой налог» yourself, cancel that receipt there.',
    ])
    expect(within(dialog).getByText(/The payment becomes CANCELED and no longer counts as revenue/)).toBeInTheDocument()
    expect(post).not.toHaveBeenCalled()
  })

  it('says a renewal’s subscription stays as it is, to be adjusted by hand', async () => {
    grant([VIEW, REFUND])
    const user = renderSheet({ ...PLATEGA, purchaseType: 'RENEW' })

    await user.click(await screen.findByRole('button', { name: 'Record refund' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/^the subscription does not change: adjust a renewal/)).toBeInTheDocument()
    // An add-on's refund ends it at once: the dialog says so.
    expect(within(dialog).getByText(/an add-on this payment bought ends at once;$/)).toBeInTheDocument()
    expect(within(dialog).queryByText(/^the subscription this payment created is switched off/)).not.toBeInTheDocument()
  })

  it('records it after the confirmation, on the provider-refund route, and then says when', async () => {
    grant([VIEW, REFUND])
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      data: { transactionId: PLATEGA.id, recorded: true, refundedAt: '2026-09-24T12:00:00.000Z' },
    })
    const user = renderSheet(PLATEGA)

    await user.click(await screen.findByRole('button', { name: 'Record refund' }))
    await user.click(await screen.findByRole('button', { name: 'Yes, the money is returned' }))

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post).toHaveBeenCalledWith(POST_PATH)
    const section = screen.getByRole('region', { name: 'Refund made at the provider' })
    await waitFor(() => expect(within(section).getByText(/^Refund recorded /)).toBeInTheDocument())
    expect(within(section).queryByRole('button', { name: 'Record refund' })).not.toBeInTheDocument()
    expect(toastMock.success).toHaveBeenCalledWith('Refund recorded')
  })

  it('says so when the refund had already been recorded', async () => {
    grant([VIEW, REFUND])
    vi.spyOn(api, 'post').mockResolvedValue({
      data: { transactionId: PLATEGA.id, recorded: false, refundedAt: '2026-09-20T12:00:00.000Z' },
    })
    const user = renderSheet(PLATEGA)

    await user.click(await screen.findByRole('button', { name: 'Record refund' }))
    await user.click(await screen.findByRole('button', { name: 'Yes, the money is returned' }))

    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('This payment’s refund was already recorded'))
  })

  it.each([
    [409, 'PAYMENT_REFUND_RECORD_IN_PROGRESS', 'This payment’s refund is already being recorded. Refresh the page in a minute.'],
    [400, 'PAYMENT_REFUND_RECORD_USE_REFUND', 'The panel refunds a YooKassa payment itself: Users → the customer → Operations tab → “Refund”.'],
    [400, 'PAYMENT_REFUND_RECORD_IMPORTED', 'The payment was imported from another bot and settled there — its refund cannot be recorded.'],
    [400, 'PAYMENT_REFUND_NOT_FULFILLED', 'This payment’s purchase was never delivered — there is nothing to undo.'],
  ])('shows the server’s refusal %s %s in words, keeping the dialog open', async (status, code, words) => {
    grant([VIEW, REFUND])
    vi.spyOn(api, 'post').mockRejectedValue(refusal(status, code))
    const user = renderSheet(PLATEGA)

    await user.click(await screen.findByRole('button', { name: 'Record refund' }))
    await user.click(await screen.findByRole('button', { name: 'Yes, the money is returned' }))

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(words))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })

  it('speaks Russian with the words the release notes name', async () => {
    await i18n.changeLanguage('ru')
    await loadFeatureBundle('payments')
    grant([VIEW, REFUND])
    const user = renderSheet(PLATEGA)

    const section = await screen.findByRole('region', { name: 'Возврат у провайдера' })
    await user.click(within(section).getByRole('button', { name: 'Отметить возврат' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Отметить возврат?')).toBeInTheDocument()
    expect(within(dialog).getByText(/В Telegram придёт карточка «↩️ Платёж возвращён»/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Да, деньги возвращены' })).toBeInTheDocument()
  })
})

describe('«Отметить возврат» beside «Вернуть» in the user card’s «Операции»', () => {
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
  const YOOKASSA: TransactionRow = {
    ...PLATEGA,
    id: 'cmfk2x9pq0040abcd1234efgh',
    paymentId: 'cmfk2x9pq0041abcd1234efgh',
    gatewayType: 'YOOKASSA',
  }

  function renderOperations() {
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/users/12345/operations') {
        return { data: { items: [operation(PLATEGA), operation(YOOKASSA)], total: 2, page: 1, limit: 25 } }
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
    return user
  }

  function card(paymentId: string): HTMLElement {
    const found = screen.getByText(paymentId).closest('.rounded-lg')
    if (!(found instanceof HTMLElement)) throw new Error(`no card for ${paymentId}`)
    return found
  }

  it('is offered for the Platega payment and not for the ЮKassa one, to an operator who may refund', async () => {
    grant([{ resource: 'users', action: 'view' }, VIEW, REFUND])
    const user = renderOperations()
    await user.click(await screen.findByRole('tab', { name: 'Operations' }))
    await screen.findByText(PLATEGA.paymentId)

    expect(within(card(PLATEGA.paymentId)).getByRole('button', { name: 'Record refund' })).toBeInTheDocument()
    expect(within(card(PLATEGA.paymentId)).getByRole('button', { name: 'Refund' })).toBeInTheDocument()
    expect(within(card(YOOKASSA.paymentId)).queryByRole('button', { name: 'Record refund' })).not.toBeInTheDocument()
    expect(within(card(YOOKASSA.paymentId)).getByRole('button', { name: 'Refund' })).toBeInTheDocument()
  })

  it('is not offered without payments:refund', async () => {
    grant([{ resource: 'users', action: 'view' }, VIEW])
    const user = renderOperations()
    await user.click(await screen.findByRole('tab', { name: 'Operations' }))
    await screen.findByText(PLATEGA.paymentId)

    expect(screen.queryByRole('button', { name: 'Record refund' })).not.toBeInTheDocument()
  })

  it('records the payment of that card, on the provider-refund route', async () => {
    grant([{ resource: 'users', action: 'view' }, VIEW, REFUND])
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      data: { transactionId: PLATEGA.id, recorded: true, refundedAt: '2026-09-24T12:00:00.000Z' },
    })
    const user = renderOperations()
    await user.click(await screen.findByRole('tab', { name: 'Operations' }))
    await screen.findByText(PLATEGA.paymentId)

    await user.click(within(card(PLATEGA.paymentId)).getByRole('button', { name: 'Record refund' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Record the refund?')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Yes, the money is returned' }))

    await waitFor(() => expect(post).toHaveBeenCalledWith(POST_PATH))
    expect(post).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Refund recorded'))
  })

  it('points a Platega payment’s «Вернуть» at «Отметить возврат»', () => {
    expect(userDetailRu.userDetailPanel.refund.reasons.PAYMENT_REFUND_UNSUPPORTED_GATEWAY).toMatch(/«Отметить возврат»/)
    expect(userDetailEn.userDetailPanel.refund.reasons.PAYMENT_REFUND_UNSUPPORTED_GATEWAY).toMatch(/“Record refund”/)
  })
})

describe('one dialog on two pages', () => {
  it('has the same words in the Payments page’s bundle and the user card’s', () => {
    // Each page loads only its own bundle; the dialog reads the one it is on.
    expect(paymentsRu.paymentsPage.providerRefund).toEqual(userDetailRu.userDetailPanel.providerRefund)
    expect(paymentsEn.paymentsPage.providerRefund).toEqual(userDetailEn.userDetailPanel.providerRefund)
  })
})

describe('the recorded refund in the dashboard’s audit timeline', () => {
  const RECORDED = {
    id: 'audit:provider-refund',
    source: 'AUDIT',
    status: 'INFO',
    title: 'payments.transaction.provider_refund_recorded',
    description: '',
    createdAt: '2026-09-24T12:00:00.000Z',
    kind: 'AUDIT',
    meta: { action: 'payments.transaction.provider_refund_recorded' },
  } as const
  const summary = {
    checkedAt: '2026-09-24T12:00:00.000Z',
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

  it('names the action in both languages, not by its code', async () => {
    await loadFeatureBundle('dashboard')
    const { unmount } = renderWithProviders(<DashboardTimelinesSection summary={summary} />)
    expect(screen.getByText('Refund made at the provider recorded')).toBeInTheDocument()
    unmount()

    await i18n.changeLanguage('ru')
    await loadFeatureBundle('dashboard')
    renderWithProviders(<DashboardTimelinesSection summary={summary} />)
    expect(screen.getByText('Отмечен возврат платежа у провайдера')).toBeInTheDocument()
    expect(screen.queryByText('payments.transaction.provider_refund_recorded')).not.toBeInTheDocument()
  })
})
