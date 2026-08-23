/**
 * A NON-PARTNER HAS NO PARTNER TAB, SO IT MUST NOT BE ASKED TO HOLD ONE.
 *
 * `PartnerTab` used to open with an `if (!user.partner)` early return that
 * rendered "User is not a partner" and a live "Create partner" button. Nothing
 * could reach it. The tab is mounted `{user.partner && (<TabsContent
 * value="partner">…)}` and its trigger carries the same guard, so the component
 * only ever runs for a user who HAS a partner row — the one shape in which
 * that branch is skipped. A `createMutation` was declared alongside it, wired
 * to a button no operator of any role could press, which is how dead code
 * reads as a supported feature.
 *
 * ── WHAT THESE SPECS ASSERT, AND WHY NOT WITH A SPY ────────────────────────
 *
 * What is ON SCREEN. "The mutation was not called" would have been just as
 * true before the branch was deleted as after — it was unreachable either way
 * — so a call count cannot tell the two states apart. The screen can: the
 * branch's own two pieces of rendered output, the tab that would have to exist
 * to show them, and the Profile tab control that must survive the deletion.
 *
 * The permission shape here is deliberately the ENTITLED one. Asserting "no
 * Create partner button" under a role that lacks `partners:edit` would pass
 * because of the `<PermissionGate>` around it, whether the branch existed or
 * not; granting `partners:edit` removes that explanation and leaves only the
 * true one — there is no such control on this screen at all.
 *
 * This overlaps `partner-lifecycle-permission-gate.test.tsx` on the Profile
 * tab control by design, and narrowly: that file pins WHICH ROLES see it, this
 * one pins that deleting `PartnerTab`'s dead twin did not take it along.
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
const REGISTERED = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

/** Somebody who is not a partner — `partner: null`, exactly as the API sends it. */
const NON_PARTNER = {
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

/** The same person with a partner row — the only shape that mounts `PartnerTab`. */
const PARTNER = {
  ...NON_PARTNER,
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

/** Entitled to the partner routes, so no gate can explain an absent control. */
const PARTNER_MANAGER: ReadonlyArray<{ resource: string; action: RbacAction }> = [
  { resource: 'users', action: 'view' },
  { resource: 'users', action: 'edit' },
  { resource: 'subscriptions', action: 'view' },
  { resource: 'partners', action: 'view' },
  { resource: 'partners', action: 'edit' },
]

function grant(tokens: ReadonlyArray<{ resource: string; action: RbacAction }>): void {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(tokens.map((p) => `${p.resource}:${p.action}`)),
    mustChangePassword: false,
    // NOT 'DEV': `hasPermission` short-circuits to true for DEV, which would
    // make the entitlement above indistinguishable from having none.
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
 * The Actions card the Profile tab's partner control lives inside — located by
 * a control `users:edit` alone is entitled to, so that a card which failed to
 * render cannot be mistaken for a correctly absent button.
 */
async function actionsCard(): Promise<HTMLElement> {
  const points = await screen.findByLabelText('Points')
  const card = points.closest('div.rounded-lg') ?? points.parentElement
  expect(card).not.toBeNull()
  return card as HTMLElement
}

describe('the Partner tab and the create-partner control', () => {
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

  it('renders no Partner tab and no create-partner control for a user who is not a partner', async () => {
    grant(PARTNER_MANAGER)
    serve(NON_PARTNER)

    renderWithProviders(<UserDetailPanel telegramId="12345" />)

    // The panel itself rendered — otherwise every absence below is vacuous.
    expect(await screen.findByRole('tab', { name: 'Profile' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /^Subscriptions/ })).toBeInTheDocument()

    // There is no Partner tab to open…
    expect(screen.queryByRole('tab', { name: 'Partner' })).toBeNull()
    // …and neither piece of what the deleted branch used to render is anywhere
    // on screen, under a role that would have been allowed to see both.
    expect(screen.queryByText('User is not a partner')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Create partner' })).toBeNull()
    // …and by the KEY PATHS too, because the two strings above are no longer
    // in the dictionary: `userDetailPanel.partner.{notPartner,createPartner}`
    // were deleted with the branch (`i18n/features/userDetail.{en,ru}.ts`), so
    // a restored branch would render i18next's fallback — the raw key — and
    // slip past a check that only knows the English prose. Verified against
    // the real instance: `t('userDetailPanel.partner.notPartner')` now returns
    // that exact string, while the sibling `…partner.profileTitle` still
    // returns "Partner profile".
    expect(screen.queryByText('userDetailPanel.partner.notPartner')).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'userDetailPanel.partner.createPartner' }),
    ).toBeNull()
  })

  it('still shows the Profile tab create-partner control to an entitled role, and sends it', async () => {
    // ANTI-VACUITY, and the caution the deletion had to respect: the panel's
    // one REACHABLE create-partner control is this one, and it is a different
    // control with a different label. If removing `PartnerTab`'s dead twin had
    // taken it too, partner creation would be off the panel entirely.
    const person = userEvent.setup()
    grant(PARTNER_MANAGER)
    serve(NON_PARTNER)
    const postSpy = vi.spyOn(api, 'post').mockResolvedValue({ data: {} } as never)

    renderWithProviders(<UserDetailPanel telegramId="12345" />)

    const card = await actionsCard()
    expect(within(card).getByText('Partner program')).toBeInTheDocument()
    const activate = within(card).getByRole('button', { name: 'Activate' })
    expect(activate).toBeInTheDocument()

    await person.click(activate)

    await waitFor(() => expect(postSpy).toHaveBeenCalledWith('/admin/users/12345/create-partner'))
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Partner created'))
  })

  it('opens the Partner tab for a real partner and offers no create-partner control there either', async () => {
    // ANTI-VACUITY for the first spec twice over: the tab genuinely renders
    // when there IS a partner row — so "no Partner tab" above is a statement
    // about this user, not about tabs — and the tab body that non-partners
    // never reach contains no create-partner control for anyone.
    const person = userEvent.setup()
    grant(PARTNER_MANAGER)
    serve(PARTNER)

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    await person.click(await screen.findByRole('tab', { name: 'Partner' }))

    // The tab body is on screen — the partner profile card, by its own heading.
    expect(await screen.findByText('Partner profile')).toBeInTheDocument()
    expect(screen.getByText('Referral statistics')).toBeInTheDocument()
    // And the branch that used to live at the top of it is gone for good.
    expect(screen.queryByText('User is not a partner')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Create partner' })).toBeNull()
    // …and by the KEY PATHS too, because the two strings above are no longer
    // in the dictionary: `userDetailPanel.partner.{notPartner,createPartner}`
    // were deleted with the branch (`i18n/features/userDetail.{en,ru}.ts`), so
    // a restored branch would render i18next's fallback — the raw key — and
    // slip past a check that only knows the English prose. Verified against
    // the real instance: `t('userDetailPanel.partner.notPartner')` now returns
    // that exact string, while the sibling `…partner.profileTitle` still
    // returns "Partner profile".
    expect(screen.queryByText('userDetailPanel.partner.notPartner')).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'userDetailPanel.partner.createPartner' }),
    ).toBeNull()
  })
})
