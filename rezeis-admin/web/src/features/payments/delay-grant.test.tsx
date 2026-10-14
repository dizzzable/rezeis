/**
 * The plan granted for the delay of an SBP subscription's first charge
 * («Отсрочка первого списания по СБП», Antilopay), where payments are listed.
 *
 * No money moves when such a subscription is activated, so its checkout is made
 * a free grant: COMPLETED, for 0. Without a mark that row reads as a purchase
 * of nothing. It is marked in the Payments list and in the payment's details,
 * and the ordinary payment beside it is not.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'

import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import { usePermissionStore, type RbacAction } from '@/features/rbac'

vi.mock('@/features/plans/plans-api', () => ({ usePlans: () => ({ data: [] }) }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

import { PaymentDetailsSheet } from './payment-details-sheet'
import PaymentsPage from './payments-page'
import type { TransactionRow } from './payment-records'

const PAID: TransactionRow = {
  id: 'cmfk2x9pq0010abcd1234efgh',
  paymentId: 'cmfk2x9pq0011abcd1234efgh',
  userId: 'cmfk2x9pq0000abcd1234efgh',
  userUsername: 'alice',
  userName: 'Alice',
  subscriptionId: null,
  lineItemSubscriptionIds: [],
  status: 'COMPLETED',
  purchaseType: 'NEW',
  channel: 'WEB',
  gatewayType: 'ANTILOPAY',
  gatewayId: 'apay-paid',
  currency: 'RUB',
  amount: '299',
  paymentAsset: null,
  planSnapshot: { name: 'Pro', selectedDurationDays: 30 },
  createdAt: '2026-10-14T10:00:00.000Z',
  updatedAt: '2026-10-14T10:00:06.000Z',
  fulfilledAt: '2026-10-14T10:00:05.000Z',
  conversionWithheld: null,
  delayGrant: null,
}

const GRANT: TransactionRow = {
  ...PAID,
  id: 'cmfk2x9pq0020abcd1234efgh',
  paymentId: 'cmfk2x9pq0021abcd1234efgh',
  gatewayId: 'apay-grant',
  amount: '0',
  delayGrant: { days: 7, originalAmount: '299' },
}

const VIEW = { resource: 'payments', action: 'view' as RbacAction }

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

beforeAll(async () => {
  await i18nReady
  await loadFeatureBundle('payments')
})

beforeEach(async () => {
  vi.restoreAllMocks()
  usePermissionStore.getState().reset()
  await i18n.changeLanguage('en')
})

describe('the plan granted for a delayed first charge', () => {
  it('is marked in the Payments list, and the ordinary payment beside it is not', async () => {
    grant([VIEW])
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path.startsWith('/admin/payments/transactions?')) {
        return { data: { items: [PAID, GRANT], total: 2 } }
      }
      return { data: {} }
    })
    renderWithProviders(<PaymentsPage />, { route: '/payments' })

    const grantRow = (await screen.findByText('apay-grant')).closest('tr')
    const paidRow = screen.getByText('apay-paid').closest('tr')
    if (!(grantRow instanceof HTMLElement) || !(paidRow instanceof HTMLElement)) throw new Error('no rows')
    const mark = within(grantRow).getByText('Autopay delay')
    expect(mark).toBeInTheDocument()
    // What it means is in the hint: the days given, and that no money was taken.
    expect(mark.getAttribute('title')).toMatch(/granted for 7 days unpaid/)
    expect(mark.getAttribute('title')).toMatch(/No money was taken/)
    expect(mark.getAttribute('title')).toMatch(/first charge of 299 ₽/)
    expect(within(paidRow).queryByText('Autopay delay')).not.toBeInTheDocument()
  })

  it('is marked in the payment’s details too', async () => {
    grant([VIEW])
    renderWithProviders(
      <PaymentDetailsSheet reference={GRANT.paymentId} seed={GRANT} onClose={() => undefined} onShowMatches={() => undefined} />,
      { route: '/payments' },
    )

    expect(await screen.findByText('Autopay delay')).toBeInTheDocument()
  })

  it('is marked in Russian too', async () => {
    await i18n.changeLanguage('ru')
    await loadFeatureBundle('payments')
    grant([VIEW])
    renderWithProviders(
      <PaymentDetailsSheet reference={GRANT.paymentId} seed={GRANT} onClose={() => undefined} onShowMatches={() => undefined} />,
      { route: '/payments' },
    )

    const mark = await screen.findByText('Отсрочка автосписания')
    expect(mark.getAttribute('title')).toMatch(/Тариф выдан на 7 дн\. без оплаты/)
    expect(mark.getAttribute('title')).toMatch(/Первое списание 299 ₽ придёт позже/)
  })

  it('leaves a payment from a server that does not know the mark unmarked', async () => {
    grant([VIEW])
    const { delayGrant: _omitted, ...older } = PAID
    renderWithProviders(
      <PaymentDetailsSheet reference={older.paymentId} seed={older} onClose={() => undefined} onShowMatches={() => undefined} />,
      { route: '/payments' },
    )

    // The sheet is up (its title and the amount), and carries no mark.
    await screen.findByText('Payment')
    expect(screen.getAllByText(/299/).length).toBeGreaterThan(0)
    expect(screen.queryByText('Autopay delay')).not.toBeInTheDocument()
  })
})
