/**
 * ONE ACT, ONE GATE — and a refusal the operator can read.
 *
 * `partner/toggle` is declared TWICE in `user-detail-panel.tsx`: once in
 * `ProfileTab` and once in `PartnerTab`. `create-partner` is declared ONCE, in
 * `ProfileTab` — `PartnerTab` carried a second copy until the unreachable
 * `if (!user.partner)` branch that was its only caller went, and
 * `partner-tab-has-no-create-control.test.tsx` holds that deletion down. Every
 * one of these mutations POSTs a route carrying
 * `@RequirePermission('partners', 'edit')`
 * (`admin-user-management.controller.ts`), and only `PartnerTab`'s toggle was
 * gated to match. The `ProfileTab` controls sat inside a card gated on
 * `users:edit`, which the shipped `operator` role holds while holding merely
 * `partners:view` (`rbac.resources.ts`) — so that role was shown a live
 * "Activate" button whose only possible answer is 403, on the DEFAULT tab of
 * every user it opened.
 *
 * The backend even wrote the arrangement down as fact: "the SPA hides all five
 * behind `<PermissionGate resource="partners" action="edit">`". True of the
 * Partner tab, false of the Profile tab, and nothing here or there noticed.
 *
 * The second half is the same act failing quietly. `PartnerTab`'s toggle was
 * the only one of this file's four partner mutations with no `onError` at all:
 * a refused flip repainted nothing and said nothing, which reads as a click
 * that missed rather than a server that said no.
 *
 * ── WHAT THESE SPECS ASSERT ────────────────────────────────────────────────
 *
 * What is ON SCREEN for a given permission shape, and what the operator is
 * told when the server refuses. Asserting "a gate component is present" would
 * guard nothing — the defect was never a missing gate, it was a gate naming
 * the wrong resource. Every hiding assertion is therefore paired with a
 * showing one on the same control, and with proof that the card AROUND the
 * control still rendered: "the button is gone" and "the whole card is gone"
 * are different bugs and must not read alike.
 *
 * No absolute date literal appears here — `createdAt` is derived from the
 * clock this file runs on.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePermissionStore, type RbacAction } from '@/features/rbac'
import { loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

vi.mock('@/features/plans/plans-api', () => ({ usePlans: () => ({ data: [] }) }))

const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: toastMock }))

import UserDetailPanel from './user-detail-panel'

/** Never written down: a fixed literal here becomes a claim about a calendar. */
const REGISTERED = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()

const BASE_USER = {
  id: 'user-1',
  telegramId: '12345',
  username: 'alice',
  name: 'Alice',
  language: 'en',
  role: 'USER',
  isBlocked: false,
  isPartner: false,
  points: 0,
  personalDiscount: 0,
  purchaseDiscount: 0,
  maxSubscriptions: 1,
  createdAt: REGISTERED,
  updatedAt: REGISTERED,
  subscriptions: [],
  transactions: [],
  referralsGiven: [],
  partner: null,
  webAccount: null,
}

/** The same person, already a partner and currently active. */
const PARTNER_USER = {
  ...BASE_USER,
  isPartner: true,
  partner: {
    id: 7,
    isActive: true,
    balance: 12_345,
    totalEarned: 12_345,
    totalWithdrawn: 0,
    referrals: [],
    transactions: [],
  },
}

/**
 * The tokens the shipped `operator` role holds that matter to this screen:
 * `users:edit`, and `partners` at VIEW only. This is the exact shape that was
 * offered a button it could not press.
 */
const OPERATOR: ReadonlyArray<{ resource: string; action: RbacAction }> = [
  { resource: 'users', action: 'view' },
  { resource: 'users', action: 'edit' },
  { resource: 'subscriptions', action: 'view' },
  { resource: 'partners', action: 'view' },
]

/** The same shape plus the one token the two routes actually require. */
const PARTNER_MANAGER: ReadonlyArray<{ resource: string; action: RbacAction }> = [
  ...OPERATOR,
  { resource: 'partners', action: 'edit' },
]

function grant(tokens: ReadonlyArray<{ resource: string; action: RbacAction }>): void {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(tokens.map((p) => `${p.resource}:${p.action}`)),
    mustChangePassword: false,
    // NOT 'DEV': `hasPermission` short-circuits to true for DEV, which would
    // make every permission shape below identical and every assertion vacuous.
    role: 'ADMIN',
    rbacRoleId: null,
    error: null,
  })
}

function serve(user: Record<string, unknown>): void {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/users/12345') return { data: user } as never
    return { data: [] } as never
  })
}

/**
 * The Actions card the partner control lives inside — found by a control that
 * `users:edit` alone is genuinely entitled to. Every "the button is not there"
 * assertion is made against this, so a card that failed to render at all
 * cannot masquerade as a correctly hidden button.
 */
async function actionsCard(): Promise<HTMLElement> {
  const points = await screen.findByLabelText('Points')
  const card = points.closest('div.rounded-lg') ?? points.parentElement
  expect(card).not.toBeNull()
  return card as HTMLElement
}

describe('partner lifecycle from the user detail panel', () => {
  beforeAll(async () => {
    await loadFeatureBundle('userDetail')
    const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>
    proto['hasPointerCapture'] ??= () => false
    proto['setPointerCapture'] ??= () => {}
    proto['releasePointerCapture'] ??= () => {}
    proto['scrollIntoView'] ??= () => {}
  })

  beforeEach(() => {
    vi.restoreAllMocks()
    toastMock.info.mockClear()
    toastMock.success.mockClear()
    toastMock.error.mockClear()
    toastMock.warning.mockClear()
  })

  afterEach(() => {
    cleanup()
    usePermissionStore.getState().reset()
  })

  // ── The Profile tab copy ──────────────────────────────────────────────────

  it('does not offer "Activate partner" to a role that holds users:edit but not partners:edit', async () => {
    grant(OPERATOR)
    serve(BASE_USER)
    const postSpy = vi.spyOn(api, 'post')

    renderWithProviders(<UserDetailPanel telegramId="12345" />)

    // The card itself is there — this role IS entitled to the rest of it.
    const card = await actionsCard()
    expect(within(card).getByLabelText('Personal discount %')).toBeInTheDocument()
    // …and the one control it is not entitled to is absent, label and all.
    expect(within(card).queryByRole('button', { name: 'Activate' })).toBeNull()
    expect(screen.queryByText('Partner program')).toBeNull()
    // Nothing was sent on this screen's behalf either.
    expect(postSpy).not.toHaveBeenCalled()
  })

  it('still offers it to a role that holds partners:edit', async () => {
    // ANTI-VACUITY. Without this, a gate that hid the control from EVERYONE —
    // or a card that stopped rendering — satisfies the spec above.
    const person = userEvent.setup()
    grant(PARTNER_MANAGER)
    serve(BASE_USER)
    const postSpy = vi.spyOn(api, 'post').mockResolvedValue({ data: {} } as never)

    renderWithProviders(<UserDetailPanel telegramId="12345" />)

    const card = await actionsCard()
    expect(screen.getByText('Partner program')).toBeInTheDocument()
    await person.click(within(card).getByRole('button', { name: 'Activate' }))

    await waitFor(() =>
      expect(postSpy).toHaveBeenCalledWith('/admin/users/12345/create-partner'),
    )
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Partner created'))
  })

  it('hides the Profile tab toggle from that role too, not only the create button', async () => {
    // The block renders one of TWO buttons depending on `user.partner`. Gating
    // only the branch a non-partner sees would leave the other one 403ing.
    grant(OPERATOR)
    serve(PARTNER_USER)

    renderWithProviders(<UserDetailPanel telegramId="12345" />)

    const card = await actionsCard()
    expect(within(card).getByLabelText('Personal discount %')).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: 'Active' })).toBeNull()
    expect(within(card).queryByRole('button', { name: 'Disabled' })).toBeNull()
    expect(screen.queryByText('Partner program')).toBeNull()
  })

  it('shows the Profile tab toggle to a role that holds partners:edit', async () => {
    // ANTI-VACUITY for the branch above.
    grant(PARTNER_MANAGER)
    serve(PARTNER_USER)

    renderWithProviders(<UserDetailPanel telegramId="12345" />)

    const card = await actionsCard()
    expect(within(card).getByRole('button', { name: 'Active' })).toBeInTheDocument()
  })

  // ── The Partner tab copy ──────────────────────────────────────────────────

  it('tells the operator why a Partner tab toggle was refused', async () => {
    const person = userEvent.setup()
    grant(PARTNER_MANAGER)
    serve(PARTNER_USER)
    // What a refusal from this route actually looks like: Nest's exception
    // filter puts the reason in `response.data.message`, which is the shape
    // `getErrorMessage` reads and the other three partner mutations already
    // surface.
    const refusal = 'Partner has a pending withdrawal and cannot be disabled'
    vi.spyOn(api, 'post').mockRejectedValue({
      response: { status: 409, data: { message: refusal } },
    })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    await person.click(await screen.findByRole('tab', { name: 'Partner' }))

    const disable = await screen.findByRole('button', { name: 'Disable' })
    await person.click(disable)

    // THE assertion: the server's own reason reaches the operator.
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(refusal))
    expect(toastMock.success).not.toHaveBeenCalled()
    // …and the screen still says what is true, which is why the toast is the
    // only feedback there is: nothing about this card repaints on a refusal.
    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument()
  })

  it('reports a toggle that succeeded as a success', async () => {
    // ANTI-VACUITY: a mutation that toasted `error` unconditionally would
    // satisfy the spec above.
    const person = userEvent.setup()
    grant(PARTNER_MANAGER)
    serve(PARTNER_USER)
    const postSpy = vi.spyOn(api, 'post').mockResolvedValue({ data: {} } as never)

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    await person.click(await screen.findByRole('tab', { name: 'Partner' }))
    await person.click(await screen.findByRole('button', { name: 'Disable' }))

    await waitFor(() =>
      expect(postSpy).toHaveBeenCalledWith('/admin/users/12345/partner/toggle'),
    )
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Status changed'))
    expect(toastMock.error).not.toHaveBeenCalled()
  })
})
