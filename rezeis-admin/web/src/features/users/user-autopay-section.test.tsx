/**
 * «Автосписание» on the user card: the operator's «Отменить автосписание»
 * without a refund.
 *
 * The panel had no button that stopped a customer's autopay short of a refund.
 * Now the «Подписки» tab lists each Platega or RollyPay subscription and the
 * saved ЮKassa methods with autopay on; `payments:edit` gets «Отменить
 * автосписание» per provider subscription and «Выключить автосписание ЮKassa»
 * for the methods. Each dialog says no money goes back, the customer is told
 * nothing, and what the customer then sees in the cabinet's «Способы оплаты».
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

import type { DashboardSummaryInterface } from '@/features/dashboard/dashboard-api'
import { DashboardTimelinesSection } from '@/features/dashboard/dashboard-timelines'
import UserDetailPanel from './user-detail-panel'
import type { UserAutopay } from './user-autopay-api'
import { UserAutopaySection } from './user-autopay-section'

const USER_ID = 'cmfk2x9pq0000abcd1234efgh'
const BASE = `/admin/payments/autopay/users/${USER_ID}`

const AUTOPAY: UserAutopay = {
  providerSubscriptions: [
    {
      id: 'psub-live',
      gatewayType: 'PLATEGA',
      status: 'ACTIVE',
      amount: '799',
      currency: 'RUB',
      intervalUnit: 'MONTH',
      intervalCount: 1,
      planName: 'Pro',
      subscriptionId: 'sub-1',
      nextChargeAt: '2026-10-01T10:00:00.000Z',
      cancelRequestedBy: null,
    },
    {
      id: 'psub-operator',
      gatewayType: 'ROLLYPAY',
      status: 'PAST_DUE',
      amount: '399',
      currency: 'RUB',
      intervalUnit: 'MONTH',
      intervalCount: 1,
      planName: null,
      subscriptionId: 'sub-2',
      nextChargeAt: null,
      cancelRequestedBy: 'OPERATOR',
    },
    {
      id: 'psub-refund',
      gatewayType: 'PLATEGA',
      status: 'ACTIVE',
      amount: '199',
      currency: 'RUB',
      intervalUnit: 'MONTH',
      intervalCount: 1,
      planName: 'Lite',
      subscriptionId: 'sub-3',
      nextChargeAt: '2026-10-02T10:00:00.000Z',
      cancelRequestedBy: 'REFUND',
    },
  ],
  yookassaMethods: [
    { id: 'pm-card', title: '•••• 4242', methodType: 'bank_card', cardLast4: '4242', autopayEnabled: true },
    { id: 'pm-sbp', title: 'СБП', methodType: 'sbp', cardLast4: null, autopayEnabled: true },
    { id: 'pm-off', title: '•••• 1111', methodType: 'bank_card', cardLast4: '1111', autopayEnabled: false },
  ],
}

const VIEW = { resource: 'payments', action: 'view' as RbacAction }
const EDIT = { resource: 'payments', action: 'edit' as RbacAction }

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

function serve(autopay: UserAutopay = AUTOPAY) {
  return vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === BASE) return { data: autopay }
    throw new Error(`unexpected GET ${path}`)
  })
}

function renderSection() {
  const user = userEvent.setup()
  renderWithProviders(<UserAutopaySection userId={USER_ID} />)
  return user
}

function row(id: string): HTMLElement {
  const found = document.querySelector(`[data-autopay-provider="${id}"]`)
  if (!(found instanceof HTMLElement)) throw new Error(`no row ${id}`)
  return found
}

function yookassaRow(): HTMLElement {
  const found = document.querySelector('[data-autopay-yookassa]')
  if (!(found instanceof HTMLElement)) throw new Error('no YooKassa row')
  return found
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

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('what the section lists', () => {
  it('each provider subscription with what it charges, and the ЮKassa methods with autopay on', async () => {
    grant([VIEW, EDIT])
    serve()
    renderSection()

    await screen.findByText('Platega · Pro')
    expect(row('psub-live')).toHaveTextContent(/799.*next charge/)
    expect(within(row('psub-live')).getByRole('button', { name: 'Cancel autopay' })).toBeInTheDocument()
    // A cancel already asked for: marked, and not offered again.
    expect(within(row('psub-operator')).getByText('RollyPay · subscription')).toBeInTheDocument()
    expect(within(row('psub-operator')).getByText('The last charge failed')).toBeInTheDocument()
    expect(within(row('psub-operator')).getByText('Cancelling')).toBeInTheDocument()
    expect(within(row('psub-operator')).queryByRole('button', { name: 'Cancel autopay' })).not.toBeInTheDocument()
    expect(within(row('psub-refund')).getByText('Cancelling by a refund')).toBeInTheDocument()
    expect(within(row('psub-refund')).queryByRole('button', { name: 'Cancel autopay' })).not.toBeInTheDocument()
    expect(within(yookassaRow()).getByText('Autopay on: •••• 4242, СБП')).toBeInTheDocument()
    expect(within(yookassaRow()).getByRole('button', { name: 'Turn off YooKassa autopay' })).toBeInTheDocument()
  })

  it('without payments:edit: the same list, no button, and who may', async () => {
    grant([VIEW])
    serve()
    renderSection()

    await screen.findByText('Platega · Pro')
    expect(screen.queryByRole('button', { name: 'Cancel autopay' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Turn off YooKassa autopay' })).not.toBeInTheDocument()
    expect(screen.getByText('Turning autopay off needs the payments:edit permission.')).toBeInTheDocument()
  })

  it('without payments:view: nothing, and no request', () => {
    grant([EDIT])
    const get = serve()
    renderSection()

    expect(screen.queryByText('Autopay')).not.toBeInTheDocument()
    expect(get).not.toHaveBeenCalled()
  })

  it('says it could not load a body of another shape, instead of taking the user card down', async () => {
    grant([VIEW, EDIT])
    serve({ id: USER_ID, subscriptions: [] } as unknown as UserAutopay)
    renderSection()

    expect(await screen.findByText('Could not load the customer’s autopays')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel autopay' })).not.toBeInTheDocument()
  })

  it('says there is none, and no ЮKassa button once every method is off', async () => {
    grant([VIEW, EDIT])
    serve({ providerSubscriptions: [], yookassaMethods: [] })
    const { unmount } = renderWithProviders(<UserAutopaySection userId={USER_ID} />)
    expect(await screen.findByText(/^No autopay: no Platega or RollyPay subscription/)).toBeInTheDocument()
    unmount()

    vi.restoreAllMocks()
    serve({ providerSubscriptions: [], yookassaMethods: [AUTOPAY.yookassaMethods[2]!] })
    renderWithProviders(<UserAutopaySection userId={USER_ID} />)
    expect(await screen.findByText(/^Autopay is off on every method/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Turn off YooKassa autopay' })).not.toBeInTheDocument()
  })
})

describe('«Отменить автосписание» of a Platega or RollyPay subscription', () => {
  it('says no money goes back and what the customer sees, and posts nothing before the confirmation', async () => {
    grant([VIEW, EDIT])
    serve()
    const post = vi.spyOn(api, 'post')
    const user = renderSection()

    await user.click(await screen.findByRole('button', { name: 'Cancel autopay' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Cancel the autopay?')).toBeInTheDocument()
    expect(within(dialog).getByText(/^Platega stops charging .*799.* for “Pro”\. No money is returned, and the paid term of the subscription does not change\./)).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        'The panel tells the customer nothing. In the cabinet, under «Способы оплаты», this autopay is gone; the customer can set it up again only with a new payment through Platega marked «для автоматического списания».',
      ),
    ).toBeInTheDocument()
    expect(post).not.toHaveBeenCalled()
  })

  it('posts the cancel of that subscription, then reads the list again', async () => {
    grant([VIEW, EDIT])
    const get = serve()
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { state: 'CANCELLING' } })
    const user = renderSection()

    await user.click(await screen.findByRole('button', { name: 'Cancel autopay' }))
    await user.click(await screen.findByRole('button', { name: 'Yes, cancel' }))

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post).toHaveBeenCalledWith(`${BASE}/provider-subscriptions/psub-live/cancel`)
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith('The cancel went to the provider. The Telegram card will say how it ended.'),
    )
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
  })

  it.each([
    ['ENDED', 'This autopay has already ended'],
    ['REFUND_ENDING', 'A refund is already cancelling this autopay'],
  ])('says what the server found instead: %s', async (state, words) => {
    grant([VIEW, EDIT])
    serve()
    vi.spyOn(api, 'post').mockResolvedValue({ data: { state } })
    const user = renderSection()

    await user.click(await screen.findByRole('button', { name: 'Cancel autopay' }))
    await user.click(await screen.findByRole('button', { name: 'Yes, cancel' }))

    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith(words))
  })

  it('keeps the dialog open on a failure and says it', async () => {
    grant([VIEW, EDIT])
    serve()
    vi.spyOn(api, 'post').mockRejectedValue({})
    const user = renderSection()

    await user.click(await screen.findByRole('button', { name: 'Cancel autopay' }))
    await user.click(await screen.findByRole('button', { name: 'Yes, cancel' }))

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Could not cancel the autopay'))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })
})

describe('«Выключить автосписание ЮKassa»', () => {
  it('names the methods it switches off, says they stay saved and what the customer sees', async () => {
    grant([VIEW, EDIT])
    serve()
    const post = vi.spyOn(api, 'post')
    const user = renderSection()

    await user.click(await screen.findByRole('button', { name: 'Turn off YooKassa autopay' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Turn off YooKassa autopay?')).toBeInTheDocument()
    expect(within(dialog).getByText(/from these YooKassa payment methods: •••• 4242, СБП\. No money is returned, and the methods stay saved\./)).toBeInTheDocument()
    expect(within(dialog).queryByText(/1111/)).not.toBeInTheDocument()
    expect(
      within(dialog).getByText(
        'The panel tells the customer nothing. In the cabinet, under «Способы оплаты», these methods show the «Автосписание» switch off, and the customer can turn it back on.',
      ),
    ).toBeInTheDocument()
    expect(post).not.toHaveBeenCalled()
  })

  it.each([
    [{ switched: 2, pending: 0 }, 'YooKassa autopay is off'],
    [{ switched: 1, pending: 1 }, 'Autopay is off; the method busy with a charge is switched off right after it'],
    [{ switched: 0, pending: 0 }, 'YooKassa autopay was already off'],
  ])('posts the switch for the customer and says what it did: %o', async (result, words) => {
    grant([VIEW, EDIT])
    serve()
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: result })
    const user = renderSection()

    await user.click(await screen.findByRole('button', { name: 'Turn off YooKassa autopay' }))
    await user.click(await screen.findByRole('button', { name: 'Yes, turn off' }))

    await waitFor(() => expect(post).toHaveBeenCalledWith(`${BASE}/yookassa/disable`))
    expect(post).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith(words))
  })
})

describe('in the user card', () => {
  it('sits on the «Подписки» tab, read for the user the card shows', async () => {
    grant([{ resource: 'users', action: 'view' }, VIEW, EDIT])
    const get = vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === BASE) return { data: AUTOPAY }
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

    await user.click(await screen.findByRole('tab', { name: /^Subscriptions/ }))

    expect(await screen.findByText('Platega · Pro')).toBeInTheDocument()
    expect(get).toHaveBeenCalledWith(BASE)
    expect(screen.getByRole('button', { name: 'Cancel autopay' })).toBeInTheDocument()
  })

  it('speaks Russian with the words the release notes name', async () => {
    await i18n.changeLanguage('ru')
    await loadFeatureBundle('userDetail')
    grant([VIEW, EDIT])
    serve()
    const user = renderSection()

    expect(await screen.findByText('Автосписание')).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Отменить автосписание' }))
    const cancel = await screen.findByRole('alertdialog')
    expect(within(cancel).getByText('Отменить автосписание?')).toBeInTheDocument()
    expect(within(cancel).getByText(/^Клиенту панель ничего не сообщит\. В кабинете, в «Способах оплаты»/)).toBeInTheDocument()
    expect(within(cancel).getByRole('button', { name: 'Да, отменить' })).toBeInTheDocument()
    await user.click(within(cancel).getByRole('button', { name: 'Отмена' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Выключить автосписание ЮKassa' }))
    const disable = await screen.findByRole('alertdialog')
    expect(within(disable).getByText('Выключить автосписание ЮKassa?')).toBeInTheDocument()
    expect(within(disable).getByText(/переключатель «Автосписание»/)).toBeInTheDocument()
    expect(within(disable).getByRole('button', { name: 'Да, выключить' })).toBeInTheDocument()
  })
})

describe('the operator’s switch in the dashboard’s audit timeline', () => {
  const entry = (action: string) =>
    ({
      id: `audit:${action}`,
      source: 'AUDIT',
      status: 'INFO',
      title: action,
      description: '',
      createdAt: '2026-09-24T12:00:00.000Z',
      kind: 'AUDIT',
      meta: { action },
    }) as const
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
    operationsTimeline: [
      entry('payments.autopay.provider_subscription_cancelled'),
      entry('payments.autopay.yookassa_disabled'),
    ],
    financeOpsTimeline: [],
    attentionItems: [],
  } as unknown as DashboardSummaryInterface

  it('names both actions in both languages, not by their codes', async () => {
    await loadFeatureBundle('dashboard')
    const { unmount } = renderWithProviders(<DashboardTimelinesSection summary={summary} />)
    expect(screen.getByText('Customer autopay cancelled (Platega or RollyPay)')).toBeInTheDocument()
    expect(screen.getByText('Customer autopay through YooKassa turned off')).toBeInTheDocument()
    unmount()

    await i18n.changeLanguage('ru')
    await loadFeatureBundle('dashboard')
    renderWithProviders(<DashboardTimelinesSection summary={summary} />)
    expect(screen.getByText('Отменено автосписание клиента (Platega или RollyPay)')).toBeInTheDocument()
    expect(screen.getByText('Выключено автосписание клиента через ЮKassa')).toBeInTheDocument()
    expect(screen.queryByText('payments.autopay.yookassa_disabled')).not.toBeInTheDocument()
  })
})
