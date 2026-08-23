import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'

import { loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import { usePermissionStore } from '@/features/rbac'
import UserDetailPanel, {
  deriveUserInviteStatus,
  readInviteCreateGate,
} from './user-detail-panel'

/**
 * The Referrals tab's two NEW blocks: the invites this user has issued, and
 * the rewards they have earned.
 *
 * Both come from `/admin/referrals/*`, not from the user-detail query the rest
 * of the tab is painted from, so what is under test here is mostly the seams:
 * that each block fails on its own and says so, that a failure never renders
 * as an empty state, that the invite quota is asked for and honoured BEFORE a
 * POST, and that a write refreshes everything it changed.
 *
 * ── NO ABSOLUTE DATE LITERALS ──────────────────────────────────────────────
 *
 * Invites carry `expiresAt`, `revokedAt` and `consumedAt`, and this repository
 * has already paid for the alternative once: a `2026-03-01` fixture that was
 * live when it was written, silently became an expired-subscription assertion
 * five months later, and left thirty tests green while they asserted the
 * defect. Every timestamp below is an offset from `BASE_MS`, which the test
 * owns, so `at(7)` is the future on every day this file is ever run.
 *
 * Nor is a formatted date ever asserted: re-running `toLocaleDateString` in
 * the expectation would compare the component with itself and pass whatever it
 * printed. The date-free half of the same statement — "Never expires" vs a
 * status badge — is what gets checked.
 *
 * ── AND THE SERVER'S OWN REFUSAL ───────────────────────────────────────────
 *
 * The client gate is no longer the only thing between an operator and an
 * over-quota invite: `ReferralsService.createInvite` asks `getCapacity` at the
 * one place a row is written and refuses with `INVITE_SLOT_LIMIT_REACHED`. The
 * last two describes in this file drive that refusal — the case the gate
 * CANNOT see, being a stale capacity read, a race with the bot minting the
 * last slot, or a direct API call.
 */

const BASE_MS = Date.now()
const DAY_MS = 24 * 60 * 60 * 1000
const at = (days: number): string => new Date(BASE_MS + days * DAY_MS).toISOString()

const USER_ID = 'user-1'
const TELEGRAM_ID = '12345'
const CAPACITY_URL = `/admin/referrals/invite-capacity/${USER_ID}`

// ── Fixtures ────────────────────────────────────────────────────────────────

/** `referralUserSummarySchema` — `displayName` is required and non-empty. */
const PERSON = {
  id: USER_ID,
  username: 'alice',
  name: 'Alice',
  displayName: 'Alice',
  telegramId: TELEGRAM_ID,
  createdAt: at(-30),
}

function userDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    telegramId: TELEGRAM_ID,
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
    createdAt: at(-30),
    updatedAt: at(-1),
    subscriptions: [],
    transactions: [],
    referralsGiven: [],
    referral: null,
    partner: null,
    webAccount: null,
    ...overrides,
  }
}

/** `adminReferralInviteSchema` — `inviter` nested and required. */
function invite(overrides: Record<string, unknown> = {}) {
  return {
    id: 'invite-live',
    token: 'tok-live-000001',
    inviter: PERSON,
    note: null,
    expiresAt: at(7),
    revokedAt: null,
    consumedAt: null,
    createdAt: at(-1),
    ...overrides,
  }
}

/** `adminReferralRewardSchema` — `user` nested, `userTelegramId` top-level. */
function reward(overrides: Record<string, unknown> = {}) {
  return {
    id: 'reward-pending',
    referralId: 'referral-1',
    user: PERSON,
    userTelegramId: TELEGRAM_ID,
    type: 'POINTS',
    amount: 250,
    isIssued: false,
    issuedAt: null,
    issuedBy: null,
    createdAt: at(-2),
    ...overrides,
  }
}

/** `{ items, total }`, exactly — `listRewards` refuses a bare array. */
const rewardsEnvelope = (items: readonly unknown[]) => ({ items, total: items.length })

/** `InviteCapacitySnapshot`. Null in either count means UNLIMITED. */
function capacity(overrides: Record<string, unknown> = {}) {
  return { totalSlots: 3, usedSlots: 1, remainingSlots: 2, canCreateInvite: true, ...overrides }
}

// ── Transport ───────────────────────────────────────────────────────────────

type Answer = { readonly data: unknown } | Error

interface PostCall {
  readonly url: string
  readonly body: unknown
}

interface Wiring {
  /** One entry per GET; the last entry answers every call after it. */
  readonly user?: readonly Answer[]
  readonly invites?: readonly Answer[]
  readonly rewards?: readonly Answer[]
  readonly capacity?: readonly Answer[]
  readonly post?: (url: string) => Answer
}

interface Transport {
  readonly gets: readonly string[]
  readonly posts: readonly PostCall[]
}

function install(wiring: Wiring): Transport {
  const gets: string[] = []
  const posts: PostCall[] = []
  const cursor = new Map<string, number>()

  const take = (name: string, list?: readonly Answer[]): Answer => {
    if (list === undefined || list.length === 0) {
      throw new Error(`spec did not wire a ${name} response`)
    }
    const index = cursor.get(name) ?? 0
    cursor.set(name, Math.min(index + 1, list.length - 1))
    return list[index]
  }

  const settle = (answer: Answer): Promise<{ data: unknown }> => {
    if (answer instanceof Error) return Promise.reject(answer)
    return Promise.resolve(answer)
  }

  vi.spyOn(api, 'get').mockImplementation((async (url: string) => {
    gets.push(url)
    if (url.startsWith('/admin/users/')) return settle(take('user', wiring.user))
    if (url === '/admin/referrals/invites') return settle(take('invites', wiring.invites))
    if (url === '/admin/referrals/rewards') return settle(take('rewards', wiring.rewards))
    if (url === CAPACITY_URL) return settle(take('capacity', wiring.capacity))
    throw new Error(`unexpected GET ${url}`)
  }) as unknown as typeof api.get)

  vi.spyOn(api, 'post').mockImplementation((async (url: string, body?: unknown) => {
    posts.push({ url, body })
    if (wiring.post === undefined) throw new Error(`unexpected POST ${url}`)
    return settle(wiring.post(url))
  }) as unknown as typeof api.post)

  return { gets, posts }
}

async function openReferralsTab(wiring: Wiring): Promise<Transport> {
  const transport = install(wiring)
  renderWithProviders(<UserDetailPanel telegramId={TELEGRAM_ID} />)
  const tab = await screen.findByRole('tab', { name: 'Referrals' })
  await userEvent.setup().click(tab)
  return transport
}

/** The row a token belongs to, so a two-row list cannot be asserted by luck. */
function rowFor(token: string): HTMLElement {
  const cell = screen.getByText(token)
  const row = cell.closest('li')
  if (row === null) throw new Error(`no row around ${token}`)
  return row
}

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('deriveUserInviteStatus', () => {
  const NOW = BASE_MS

  it('reads the terminal facts before the clock', () => {
    // A revoked invite that also happens to be expired is REVOKED: the row
    // states why it stopped being usable, and the clock is the weaker answer.
    expect(
      deriveUserInviteStatus({ expiresAt: at(-5), revokedAt: at(-1), consumedAt: null }, NOW),
    ).toBe('revoked')
    expect(
      deriveUserInviteStatus({ expiresAt: at(-5), revokedAt: null, consumedAt: at(-1) }, NOW),
    ).toBe('consumed')
  })

  it('treats a null expiry as live rather than as the epoch', () => {
    expect(
      deriveUserInviteStatus({ expiresAt: null, revokedAt: null, consumedAt: null }, NOW),
    ).toBe('active')
  })

  it('splits active from expired on the instant it is given', () => {
    expect(
      deriveUserInviteStatus({ expiresAt: at(1), revokedAt: null, consumedAt: null }, NOW),
    ).toBe('active')
    expect(
      deriveUserInviteStatus({ expiresAt: at(-1), revokedAt: null, consumedAt: null }, NOW),
    ).toBe('expired')
  })
})

describe('readInviteCreateGate', () => {
  it('allows only what the server said it allows', () => {
    expect(readInviteCreateGate({ isError: false, data: capacity() })).toEqual({ kind: 'allowed' })
  })

  it('names both numbers when the quota is spent', () => {
    expect(
      readInviteCreateGate({
        isError: false,
        data: capacity({ usedSlots: 3, remainingSlots: 0, canCreateInvite: false }),
      }),
    ).toEqual({ kind: 'exhausted', used: 3, total: 3 })
  })

  it('reads an unlimited quota as unlimited, never as zero', () => {
    // The VIP-bypass answer. Read as a number this is `totalSlots: 0`, which
    // would lock out exactly the users the bypass exists for.
    expect(
      readInviteCreateGate({
        isError: false,
        data: { totalSlots: null, usedSlots: 0, remainingSlots: null, canCreateInvite: true },
      }),
    ).toEqual({ kind: 'allowed' })
  })

  it('refuses rather than guesses when the capacity load failed', () => {
    expect(readInviteCreateGate({ isError: true, data: undefined })).toEqual({ kind: 'unknown' })
  })
})

// ── The tab ─────────────────────────────────────────────────────────────────

describe('Referrals tab — invites and rewards blocks', () => {
  beforeAll(async () => {
    await loadFeatureBundle('userDetail')
  })

  beforeEach(() => {
    vi.restoreAllMocks()
    usePermissionStore.setState({ loaded: true, role: 'DEV' })
  })

  it('renders the invites and rewards a user has', async () => {
    await openReferralsTab({
      user: [{ data: userDetail() }],
      invites: [{ data: [invite(), invite({ id: 'invite-2', token: 'tok-second-00002' })] }],
      rewards: [
        {
          data: rewardsEnvelope([
            reward(),
            reward({
              id: 'reward-issued',
              type: 'EXTRA_DAYS',
              amount: 14,
              isIssued: true,
              issuedAt: at(-1),
              issuedBy: 'admin-1',
            }),
          ]),
        },
      ],
      capacity: [{ data: capacity() }],
    })

    expect(await screen.findByText('Invites issued (2)')).toBeInTheDocument()
    expect(screen.getByText('tok-live-000001')).toBeInTheDocument()
    expect(screen.getByText('tok-second-00002')).toBeInTheDocument()

    expect(await screen.findByText('Rewards earned (2)')).toBeInTheDocument()
    // The amount is the operator's number and the type names its unit; both
    // are asserted as the one line an operator reads.
    expect(screen.getByText('Points · 250')).toBeInTheDocument()
    expect(screen.getByText('Extra days · 14')).toBeInTheDocument()
    expect(within(rowFor('tok-live-000001')).getByText('Active')).toBeInTheDocument()
  })

  it('renders a never-expiring, a consumed and a revoked invite distinctly', async () => {
    await openReferralsTab({
      user: [{ data: userDetail() }],
      invites: [
        {
          data: [
            invite({ id: 'invite-forever', token: 'tok-forever-0002', expiresAt: null }),
            invite({ id: 'invite-consumed', token: 'tok-consumed-003', consumedAt: at(-1) }),
            invite({ id: 'invite-revoked', token: 'tok-revoked-0004', revokedAt: at(-1) }),
            invite({ id: 'invite-expired', token: 'tok-expired-0005', expiresAt: at(-1) }),
          ],
        },
      ],
      rewards: [{ data: rewardsEnvelope([]) }],
      capacity: [{ data: capacity() }],
    })

    const forever = within(await screen.findByText('tok-forever-0002').then(rowForNode))
    // `expiresAt: null` is "no expiry", NOT the epoch. Printed as a date it
    // would read as 01.01.1970 and the row would look long dead.
    expect(forever.getByText('Never expires')).toBeInTheDocument()
    expect(forever.getByText('Active')).toBeInTheDocument()

    expect(within(rowFor('tok-consumed-003')).getByText('Consumed')).toBeInTheDocument()
    expect(within(rowFor('tok-revoked-0004')).getByText('Revoked')).toBeInTheDocument()
    expect(within(rowFor('tok-expired-0005')).getByText('Expired')).toBeInTheDocument()

    // Only a live invite can still be taken back.
    expect(within(rowFor('tok-forever-0002')).getByRole('button', { name: 'Revoke' })).toBeInTheDocument()
    expect(within(rowFor('tok-consumed-003')).queryByRole('button', { name: 'Revoke' })).toBeNull()
    expect(within(rowFor('tok-revoked-0004')).queryByRole('button', { name: 'Revoke' })).toBeNull()
    expect(within(rowFor('tok-expired-0005')).queryByRole('button', { name: 'Revoke' })).toBeNull()
  })

  it('says the invites load failed instead of claiming there are none, and keeps the rewards on screen', async () => {
    await openReferralsTab({
      user: [{ data: userDetail() }],
      invites: [new Error('boom')],
      rewards: [{ data: rewardsEnvelope([reward()]) }],
      capacity: [{ data: capacity() }],
    })

    expect(await screen.findByText('Could not load this user’s invites')).toBeInTheDocument()
    // "No invites issued yet" is a claim about the operator's data. A rejected
    // fetch establishes nothing of the sort — and neither does a header count.
    expect(screen.queryByText('No invites issued yet')).toBeNull()
    expect(screen.queryByText('Invites issued (0)')).toBeNull()
    expect(screen.getByText('Invites issued')).toBeInTheDocument()

    // The other block is a different endpoint and must be untouched by this.
    expect(await screen.findByText('Points · 250')).toBeInTheDocument()
    expect(screen.getByText('Rewards earned (1)')).toBeInTheDocument()
  })

  it('says the rewards load failed instead of claiming there are none, and keeps the invites on screen', async () => {
    await openReferralsTab({
      user: [{ data: userDetail() }],
      invites: [{ data: [invite()] }],
      rewards: [new Error('boom')],
      capacity: [{ data: capacity() }],
    })

    expect(await screen.findByText('Could not load this user’s rewards')).toBeInTheDocument()
    expect(screen.queryByText('No rewards yet')).toBeNull()
    expect(screen.queryByText('Rewards earned (0)')).toBeNull()
    expect(screen.getByText('Rewards earned')).toBeInTheDocument()

    expect(await screen.findByText('tok-live-000001')).toBeInTheDocument()
    expect(screen.getByText('Invites issued (1)')).toBeInTheDocument()
  })

  it('shows the empty state only when the server actually said the list is empty', async () => {
    // ANTI-VACUITY CONTROL for the two tests above: if the empty state were
    // simply unreachable, "it is not shown on failure" would prove nothing.
    await openReferralsTab({
      user: [{ data: userDetail() }],
      invites: [{ data: [] }],
      rewards: [{ data: rewardsEnvelope([]) }],
      capacity: [{ data: capacity() }],
    })

    expect(await screen.findByText('No invites issued yet')).toBeInTheDocument()
    expect(await screen.findByText('No rewards yet')).toBeInTheDocument()
    expect(screen.queryByText('Could not load this user’s invites')).toBeNull()
  })

  it('refuses to create an invite when the quota is spent, before any request is sent', async () => {
    const transport = await openReferralsTab({
      user: [{ data: userDetail() }],
      invites: [{ data: [invite(), invite({ id: 'i2', token: 'tok-two-0000002' }), invite({ id: 'i3', token: 'tok-three-00003' })] }],
      rewards: [{ data: rewardsEnvelope([]) }],
      capacity: [{ data: capacity({ usedSlots: 3, remainingSlots: 0, canCreateInvite: false }) }],
      // No POST wiring at all: reaching the network here is the defect.
    })

    // The limit is NAMED, and named BEFORE the press rather than after it. The
    // server does enforce this quota now — see the last describes in this file
    // — but a refusal the operator can be told about in advance is not one
    // worth spending a request, and a round trip, to discover.
    expect(
      await screen.findByText(
        'All 3 invite slots are in use (3 live). Revoke one, or raise the limit on the Invites tab.',
      ),
    ).toBeInTheDocument()

    const create = screen.getByRole('button', { name: /Create invite/ })
    expect(create).toBeDisabled()

    await userEvent.setup().click(create)
    expect(transport.posts).toEqual([])
  })

  it('holds creation when the quota itself could not be read', async () => {
    const transport = await openReferralsTab({
      user: [{ data: userDetail() }],
      invites: [{ data: [] }],
      rewards: [{ data: rewardsEnvelope([]) }],
      capacity: [new Error('boom')],
    })

    expect(
      await screen.findByText(
        'The invite quota could not be read, so creating an invite is held. Reopen the tab to try again.',
      ),
    ).toBeInTheDocument()

    const create = screen.getByRole('button', { name: /Create invite/ })
    expect(create).toBeDisabled()
    await userEvent.setup().click(create)
    expect(transport.posts).toEqual([])
  })

  it('creates an invite when there is room, and refreshes the list and the remaining quota', async () => {
    // ANTI-VACUITY CONTROL for the refusal above: a button that never fires
    // would satisfy "no request was sent" without protecting anything.
    const created = invite({ id: 'invite-new', token: 'tok-new-0000006' })
    const transport = await openReferralsTab({
      user: [{ data: userDetail() }],
      invites: [{ data: [invite()] }, { data: [invite(), created] }],
      rewards: [{ data: rewardsEnvelope([]) }],
      capacity: [
        { data: capacity() },
        { data: capacity({ usedSlots: 2, remainingSlots: 1 }) },
      ],
      post: () => ({ data: { invite: created } }),
    })

    expect(await screen.findByText('2 of 3 invite slots free')).toBeInTheDocument()

    const create = await screen.findByRole('button', { name: /Create invite/ })
    expect(create).toBeEnabled()
    await userEvent.setup().click(create)

    // `inviterId` and nothing else. The `ttlHours` this helper used to send
    // was never a field on `CreateReferralInviteDto`, and the API runs
    // `forbidNonWhitelisted`, so every call carrying it was a 400.
    expect(transport.posts).toEqual([
      { url: '/admin/referrals/invites', body: { inviterId: USER_ID } },
    ])

    // The list was invalidated…
    expect(await screen.findByText('tok-new-0000006')).toBeInTheDocument()
    // …and so was the quota, which the new invite has just eaten into.
    expect(await screen.findByText('1 of 3 invite slots free')).toBeInTheDocument()
  })

  it('revokes an invite and shows the row in its new state', async () => {
    const live = invite()
    const transport = await openReferralsTab({
      user: [{ data: userDetail() }],
      invites: [{ data: [live] }, { data: [invite({ revokedAt: at(0) })] }],
      rewards: [{ data: rewardsEnvelope([]) }],
      capacity: [{ data: capacity() }],
      post: () => ({ data: invite({ revokedAt: at(0) }) }),
    })

    const row = within(await screen.findByText('tok-live-000001').then(rowForNode))
    await userEvent.setup().click(row.getByRole('button', { name: 'Revoke' }))

    expect(transport.posts).toEqual([
      { url: '/admin/referrals/invites/invite-live/revoke', body: undefined },
    ])

    // The refetch is what proves the invalidation: the badge could not change
    // without the list being asked again.
    expect(await screen.findByText('Revoked')).toBeInTheDocument()
    expect(within(rowFor('tok-live-000001')).queryByRole('button', { name: 'Revoke' })).toBeNull()
  })

  it('issues a reward, and refreshes both the reward list and the user card', async () => {
    const transport = await openReferralsTab({
      // Issuing APPLIES the reward — points and subscription days move — so the
      // user-detail query has to be refetched too. The second response renames
      // the user, which is how the refetch becomes visible rather than counted.
      user: [{ data: userDetail() }, { data: userDetail({ name: 'Alice Reissued' }) }],
      invites: [{ data: [] }],
      rewards: [
        { data: rewardsEnvelope([reward()]) },
        { data: rewardsEnvelope([reward({ isIssued: true, issuedAt: at(0), issuedBy: 'admin-1' })]) },
      ],
      capacity: [{ data: capacity() }],
      post: () => ({ data: reward({ isIssued: true, issuedAt: at(0), issuedBy: 'admin-1' }) }),
    })

    expect(await screen.findByText('Pending')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Issue' }))

    expect(transport.posts).toEqual([
      { url: '/admin/referrals/rewards/reward-pending/issue', body: undefined },
    ])

    expect(await screen.findByText('Issued')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Issue' })).toBeNull()
    // The user card refetched: this name exists only in the second response.
    expect(await screen.findByRole('heading', { name: 'Alice Reissued' })).toBeInTheDocument()
  })

  it('asks the invite endpoint for this user only', async () => {
    // `?inviterId=` is the whole filter. An empty one is dropped by axios and
    // the request degrades into the UNFILTERED list — every invite on the
    // platform, rendered as though it belonged to the user on screen.
    await openReferralsTab({
      user: [{ data: userDetail() }],
      invites: [{ data: [invite()] }],
      rewards: [{ data: rewardsEnvelope([]) }],
      capacity: [{ data: capacity() }],
    })

    await screen.findByText('tok-live-000001')

    const get = vi.mocked(api.get)
    const inviteCall = get.mock.calls.find((call) => call[0] === '/admin/referrals/invites')
    expect(inviteCall?.[1]).toEqual({ params: { inviterId: USER_ID } })

    const rewardCall = get.mock.calls.find((call) => call[0] === '/admin/referrals/rewards')
    expect(rewardCall?.[1]).toEqual({ params: { userId: USER_ID } })
  })
})

/** `findByText` hands back the node; this lifts it to its row. */
function rowForNode(cell: HTMLElement): HTMLElement {
  const row = cell.closest('li')
  if (row === null) throw new Error('no row around the matched cell')
  return row
}

// ── The server's own refusal ────────────────────────────────────────────────

/**
 * The wire literal `POST /admin/referrals/invites` refuses with, and the
 * English diagnostic that travels beside it.
 *
 * Copied rather than imported. The cross-boundary imports this repository
 * already makes from specs — `plan-write-refusal-codes`, `stale-panel-link`,
 * `rbac.resources` — all reach LEAF modules; `referrals.service.ts` is a
 * decorated Nest provider whose import graph reaches Prisma, and pulling it
 * into jsdom to read two strings is not a trade this file should make. The
 * copy is kept honest by the two guards at the bottom of this file, which read
 * the backend source and the filter's allowlist as text.
 */
const QUOTA_REFUSAL_CODE = 'INVITE_SLOT_LIMIT_REACHED'
const QUOTA_REFUSAL_SENTENCE =
  'No invite slots remain for this user. Raise their invite limit on the Invites tab, or revoke a live invite to free one.'

/**
 * What the OPERATOR must read: the panel's own copy, from the `userDetail`
 * dictionary, and never the English sentence above.
 */
const QUOTA_REFUSAL_COPY =
  'The server refused: this user has no invite slots left. Revoke one, or raise the limit on the Invites tab.'

/** The generic answer for every failure that is NOT this refusal. */
const CREATE_FAILED_COPY = 'Could not create the invite'

/**
 * An axios-shaped rejection carrying whatever body the spec wants to test.
 *
 * `axiosMessage` is EMPTY by default on purpose. `getErrorMessage` walks
 * `response.data.message` → `response.data.error` → the Error's own message
 * before it ever reaches the caller's fallback, so a realistic
 * "Request failed with status code 500" would be printed instead of the
 * dictionary copy — and the fallback under test would never be reached.
 */
function refusal(status: number, body: Record<string, unknown>, axiosMessage = ''): Error {
  return Object.assign(new Error(axiosMessage), {
    isAxiosError: true,
    response: { status, data: body },
  })
}

/** As `AdminSafeExceptionFilter` forwards an allowlisted refusal: both fields. */
const quotaRefusal = (): Error =>
  refusal(400, {
    statusCode: 400,
    code: QUOTA_REFUSAL_CODE,
    errorCode: QUOTA_REFUSAL_CODE,
    message: QUOTA_REFUSAL_SENTENCE,
  })

const TOAST_CHANNELS = ['success', 'error', 'warning', 'info'] as const

function toastSpies() {
  return {
    success: vi.spyOn(toast, 'success').mockReturnValue('t-ok'),
    error: vi.spyOn(toast, 'error').mockReturnValue('t-err'),
    warning: vi.spyOn(toast, 'warning').mockReturnValue('t-warn'),
    info: vi.spyOn(toast, 'info').mockReturnValue('t-info'),
  }
}

type ToastSpies = ReturnType<typeof toastSpies>

interface FiredToast {
  readonly channel: string
  readonly text: unknown
  readonly order: number
}

/**
 * Every toast that has fired, in REAL invocation order across all four
 * channels — `invocationCallOrder` is global to the run, so a success that
 * followed an error sorts after it. Walking the channels in a fixed order
 * instead would report the wrong toast the moment a spec presses twice, which
 * is exactly what the "still usable" spec below does.
 */
function firedToasts(spies: ToastSpies): readonly FiredToast[] {
  const fired: FiredToast[] = []
  for (const channel of TOAST_CHANNELS) {
    const calls: unknown[][] = spies[channel].mock.calls
    const orders: number[] = spies[channel].mock.invocationCallOrder
    calls.forEach((call, index) => {
      fired.push({ channel, text: call[0], order: orders[index] ?? 0 })
    })
  }
  return [...fired].sort((left, right) => left.order - right.order)
}

const lastToast = (spies: ToastSpies): FiredToast | undefined => firedToasts(spies).at(-1)

/**
 * Press "Create invite" and wait for the ANSWER to land — for any toast at
 * all, deliberately not for the words about to be asserted. Waiting on the
 * expected text turns a real regression into a fifteen second timeout and
 * makes every negative assertion below unreachable.
 */
async function pressCreate(spies: ToastSpies): Promise<void> {
  const before = firedToasts(spies).length
  const create = await screen.findByRole('button', { name: /Create invite/ })
  await userEvent.setup().click(create)
  await waitFor(() => expect(firedToasts(spies).length).toBeGreaterThan(before))
}

/**
 * The premise of every spec in the block below: the panel's capacity read says
 * there is room, so the client gate is OPEN and the button is pressable. That
 * read is what the server contradicts — a stale cache, a race with the bot
 * minting the last slot, or an operator on a second screen. Wire the quota as
 * spent instead and the client refuses before sending, the server branch is
 * never reached, and the whole block proves nothing.
 */
function openWithRoom(
  post: (url: string) => Answer,
  invites: readonly Answer[] = [{ data: [invite()] }],
  capacities: readonly Answer[] = [{ data: capacity() }],
): Promise<Transport> {
  return openReferralsTab({
    user: [{ data: userDetail() }],
    invites,
    rewards: [{ data: rewardsEnvelope([]) }],
    capacity: capacities,
    post,
  })
}

describe('Referrals tab — the server refuses a create the client thought it had room for', () => {
  beforeAll(async () => {
    await loadFeatureBundle('userDetail')
  })

  beforeEach(() => {
    vi.restoreAllMocks()
    usePermissionStore.setState({ loaded: true, role: 'DEV' })
  })

  it('answers the quota refusal in the operator’s own words', async () => {
    const spies = toastSpies()
    const transport = await openWithRoom(() => quotaRefusal())

    await pressCreate(spies)

    // The POST really was sent: the client gate let this one through, which is
    // the only way the server gate is ever reached.
    expect(transport.posts).toEqual([
      { url: '/admin/referrals/invites', body: { inviterId: USER_ID } },
    ])

    expect(lastToast(spies)?.channel).toBe('error')
    expect(lastToast(spies)?.text).toBe(QUOTA_REFUSAL_COPY)
    // Neither of the two things it must not be. The server's sentence is a
    // diagnostic written for whoever reads the logs — printed verbatim it is
    // how a Russian-language panel ends up showing English in a toast — and
    // the generic fallback drops the one remedy the operator can act on.
    expect(lastToast(spies)?.text).not.toBe(QUOTA_REFUSAL_SENTENCE)
    expect(lastToast(spies)?.text).not.toBe(CREATE_FAILED_COPY)
    expect(spies.success).not.toHaveBeenCalled()
  })

  it('branches on errorCode alone, which is the field the filter always sets', async () => {
    // `AdminSafeExceptionFilter` writes the product code into `errorCode`
    // unconditionally and adds `code` only when the thrown body carried one —
    // the same assertion `subscription-delete-stale-link.test.tsx` makes for
    // its own refusal. A branch that reads `code` only passes the spec above
    // and is dead on every wire shape that omits it.
    const spies = toastSpies()
    await openWithRoom(() =>
      refusal(400, {
        statusCode: 400,
        errorCode: QUOTA_REFUSAL_CODE,
        message: QUOTA_REFUSAL_SENTENCE,
      }),
    )

    await pressCreate(spies)

    expect(lastToast(spies)?.channel).toBe('error')
    expect(lastToast(spies)?.text).toBe(QUOTA_REFUSAL_COPY)
  })

  it('leaves a differently-coded 400 on the ordinary path, even wearing the quota sentence', async () => {
    // THE SELECTIVITY HALF. The body carries the backend's quota prose under
    // somebody else's code, so a branch that matched the SENTENCE rather than
    // the code passes both specs above and fails here — and a branch that
    // returned true for everything fails here too. "Revoke an invite or raise
    // the limit" is useless advice for a refusal that is not about slots.
    const spies = toastSpies()
    await openWithRoom(() =>
      refusal(400, {
        statusCode: 400,
        code: 'INVITE_REQUIRED',
        errorCode: 'INVITE_REQUIRED',
        message: QUOTA_REFUSAL_SENTENCE,
      }),
    )

    await pressCreate(spies)

    expect(lastToast(spies)?.channel).toBe('error')
    // The ordinary path prints whatever sentence arrived…
    expect(lastToast(spies)?.text).toBe(QUOTA_REFUSAL_SENTENCE)
    // …and never the quota copy, whose remedy belongs to a different refusal.
    expect(lastToast(spies)?.text).not.toBe(QUOTA_REFUSAL_COPY)
  })

  it('falls back to its own create-failed copy on a plain 500', async () => {
    // The second unrelated failure, and the one with nothing to print: no
    // code, no sentence, no shape to branch on. The dictionary answers.
    const spies = toastSpies()
    await openWithRoom(() => refusal(500, {}))

    await pressCreate(spies)

    expect(lastToast(spies)?.channel).toBe('error')
    expect(lastToast(spies)?.text).toBe(CREATE_FAILED_COPY)
    expect(lastToast(spies)?.text).not.toBe(QUOTA_REFUSAL_COPY)
  })

  it('leaves the form usable: the operator can revoke a slot and then create again', async () => {
    // A refusal that strands the operator is barely better than a silent
    // failure. The copy names a remedy — revoke one — and this spec performs
    // it, on this screen, and then presses the same button again.
    const created = invite({ id: 'invite-after', token: 'tok-after-000007' })
    let creates = 0
    const spies = toastSpies()
    const transport = await openWithRoom(
      (url) => {
        if (url.endsWith('/revoke')) return { data: invite({ revokedAt: at(0) }) }
        creates += 1
        return creates === 1 ? quotaRefusal() : { data: { invite: created } }
      },
      [
        { data: [invite()] },
        { data: [invite({ revokedAt: at(0) })] },
        { data: [invite({ revokedAt: at(0) }), created] },
      ],
      [
        // The stale read the server contradicts…
        { data: capacity({ usedSlots: 2, remainingSlots: 1 }) },
        // …the slot the revoke gave back…
        { data: capacity({ usedSlots: 2, remainingSlots: 1 }) },
        // …and the quota once the retry has spent it.
        { data: capacity({ usedSlots: 3, remainingSlots: 0, canCreateInvite: false }) },
      ],
    )

    await pressCreate(spies)
    expect(lastToast(spies)?.text).toBe(QUOTA_REFUSAL_COPY)

    // NOT STUCK. A refusal that disabled the button, or left it spinning,
    // leaves a reload as the only way forward.
    expect(screen.getByRole('button', { name: /Create invite/ })).toBeEnabled()

    // The remedy is on this screen: revoke the live invite…
    const row = within(await screen.findByText('tok-live-000001').then(rowForNode))
    await userEvent.setup().click(row.getByRole('button', { name: 'Revoke' }))
    expect(await screen.findByText('Revoked')).toBeInTheDocument()

    // …and the button that was refused now works.
    await pressCreate(spies)
    expect(await screen.findByText('tok-after-000007')).toBeInTheDocument()
    expect(lastToast(spies)?.channel).toBe('success')
    expect(lastToast(spies)?.text).toBe('Invite created')

    expect(transport.posts.map((call) => call.url)).toEqual([
      '/admin/referrals/invites',
      '/admin/referrals/invites/invite-live/revoke',
      '/admin/referrals/invites',
    ])
  })
})

/**
 * THE TWO BACKEND FACTS the block above rests on.
 *
 * Every spec up there writes both sides of the wire itself, so all of them
 * stay green if the server renames its code or the filter stops forwarding it
 * — and the operator, on the day it happens, gets an untyped 400 and the
 * generic sentence with the remedy quietly missing. These two read the backend
 * source as text, which is what a spec running in jsdom can do without
 * dragging a Nest provider and Prisma into the module graph.
 */
describe('the refusal this file drives the wire with is the one the backend sends', () => {
  const backendSource = (relative: string): string =>
    readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), relative), 'utf8')

  it('is spelled the way `referrals.service.ts` spells it', () => {
    // The EXPECTED literal is stated FIRST. Asserting only that two constants
    // agree passes just as happily when both of them are wrong.
    expect(QUOTA_REFUSAL_CODE).toBe('INVITE_SLOT_LIMIT_REACHED')
    expect(
      backendSource('../../../../src/modules/referrals/services/referrals.service.ts'),
    ).toContain(`export const INVITE_SLOT_LIMIT_REACHED_CODE = 'INVITE_SLOT_LIMIT_REACHED';`)
  })

  it('is on the filter’s allowlist, without which it never reaches the wire', () => {
    // Stripped of its code by `AdminSafeExceptionFilter`, the refusal arrives
    // as an untyped 400 and the branch under test above is dead code.
    const source = backendSource('../../../../src/common/filters/admin-safe-exception.filter.ts')
    const declaration = source.slice(source.indexOf('export const SAFE_PRODUCT_CODES'))
    const members = declaration
      .slice(0, declaration.indexOf(']);'))
      .split('\n')
      .map((line) => line.trim())

    // MEMBERSHIP, not a mention: that file names codes in its comments too, and
    // a code named in a comment is not allowlisted. The neighbour anchors the
    // slice — a mis-cut or empty body would satisfy the second line by itself.
    expect(members).toContain(`'SUBSCRIPTION_LIMIT_REACHED',`)
    expect(members).toContain(`'${QUOTA_REFUSAL_CODE}',`)
  })
})
