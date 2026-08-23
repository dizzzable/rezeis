/**
 * What the invites and rewards tabs render, against what the server sends.
 *
 * Both tabs used to fetch with a bare `api.get` cast to a hand-written row
 * type and piped through a local `unwrap()` that proved the value was an array
 * and nothing about what was inside it. That is how the invites tab came to
 * read a top-level `inviterTelegramId` — a field `ReferralInviteInterface` has
 * never had — and print a blank telegram line on every row.
 *
 * The other half of the same hole is the one most of these cases are about: a
 * response that fails to parse leaves `data` undefined, and an empty state
 * answers for it. "No invites yet" is not a neutral placeholder, it is a claim
 * about the operator's own data — so every load-failure case here asserts the
 * failure copy is on screen AND that the empty-state copy is not.
 *
 * Every timestamp is derived from one base this file owns. An invite's whole
 * status comes from `expiresAt` / `revokedAt` / `consumedAt`, so a literal date
 * in a fixture is a statement about the day it was typed: this tree has already
 * had one quietly turn into an "expired" assertion five months later.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { i18nReady } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

import ReferralsPage from './referrals-page'

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = Date.now()
const DAY_MS = 24 * 60 * 60 * 1000
const daysAgo = (days: number): string => new Date(NOW - days * DAY_MS).toISOString()
const daysAhead = (days: number): string => new Date(NOW + days * DAY_MS).toISOString()

interface WireUser {
  readonly id: string
  readonly username: string | null
  readonly name: string | null
  readonly displayName: string
  readonly telegramId: string | null
  readonly createdAt: string
}

function wireUser(over: Partial<WireUser> & Pick<WireUser, 'id' | 'displayName'>): WireUser {
  return {
    username: null,
    name: null,
    telegramId: null,
    createdAt: daysAgo(90),
    ...over,
  }
}

/** Telegram user: the id the tab prints under the name is NESTED on this. */
const TG_USER = wireUser({
  id: 'u-tg',
  name: 'Inviter One',
  displayName: 'Inviter One',
  telegramId: '111222333',
})

/**
 * The web sign-up. `WebAuthService` stores `{ name: '', email }` with no
 * `username` and no `telegramId`, and the server maps that empty name to
 * `null`, so `displayName` is the only field that can name this person at all.
 */
const WEB_USER = wireUser({ id: 'u-web', displayName: 'ops@example.com' })

interface WireInvite {
  readonly id: string
  readonly token: string
  readonly inviter: WireUser
  readonly note: string | null
  readonly expiresAt: string | null
  readonly revokedAt: string | null
  readonly consumedAt: string | null
  readonly createdAt: string
}

function invite(over: Partial<WireInvite> & Pick<WireInvite, 'id' | 'token'>): WireInvite {
  return {
    inviter: TG_USER,
    note: null,
    expiresAt: daysAhead(14),
    revokedAt: null,
    consumedAt: null,
    createdAt: daysAgo(2),
    ...over,
  }
}

/** Expires two weeks out, whenever "now" happens to be. */
const ACTIVE_INVITE = invite({ id: 'inv-active', token: 'tok-active' })
/** Expired yesterday, whenever "now" happens to be. */
const EXPIRED_INVITE = invite({
  id: 'inv-expired',
  token: 'tok-expired',
  inviter: WEB_USER,
  expiresAt: daysAgo(1),
})

/**
 * The wire shape from before the server resolved `displayName`: a user summary
 * with `name` / `username` / `telegramId` and no `displayName`, plus the
 * top-level `inviterTelegramId` the tab used to read. Every field the old row
 * type declared is here, which is the point — it has to be rejected on the
 * strength of what is MISSING.
 */
const LEGACY_INVITE = {
  id: 'inv-legacy',
  token: 'tok-legacy',
  inviterTelegramId: '999888777',
  inviter: {
    id: 'u-legacy',
    username: null,
    name: 'Legacy Inviter',
    telegramId: '999888777',
    createdAt: daysAgo(120),
  },
  expiresAt: daysAhead(3),
  revokedAt: null,
  consumedAt: null,
  createdAt: daysAgo(5),
}

interface WireReward {
  readonly id: string
  readonly referralId: string
  readonly user: WireUser
  readonly userTelegramId: string | null
  readonly type: string
  readonly amount: number
  readonly isIssued: boolean
  readonly issuedAt: string | null
  readonly issuedBy: string | null
  readonly createdAt: string
}

function reward(over: Partial<WireReward> & Pick<WireReward, 'id'>): WireReward {
  return {
    referralId: 'cm-referral-1',
    user: TG_USER,
    // Real, and top-level, unlike the invented `inviterTelegramId` above:
    // `mapReward` sends this one beside the nested `user`.
    userTelegramId: '111222333',
    type: 'POINTS',
    amount: 100,
    isIssued: false,
    issuedAt: null,
    issuedBy: null,
    createdAt: daysAgo(4),
    ...over,
  }
}

const PENDING_REWARD = reward({ id: 'rw-pending' })
const ISSUED_REWARD = reward({
  id: 'rw-issued',
  user: WEB_USER,
  userTelegramId: null,
  type: 'EXTRA_DAYS',
  amount: 7,
  isIssued: true,
  issuedAt: daysAgo(1),
  issuedBy: 'admin-1',
})

/** Same drift as `LEGACY_INVITE`: a `user` summary with no `displayName`. */
const LEGACY_REWARD = {
  id: 'rw-legacy',
  referralId: 'cm-referral-2',
  user: {
    id: 'u-legacy',
    username: 'legacy',
    name: 'Legacy User',
    telegramId: '999888777',
    createdAt: daysAgo(120),
  },
  userTelegramId: '999888777',
  type: 'POINTS',
  amount: 50,
  isIssued: false,
  issuedAt: null,
  issuedBy: null,
  createdAt: daysAgo(6),
}

const STATS = { invites: 2, referrals: 0, qualifiedReferrals: 0, rewards: 2, issuedRewards: 1 }

interface Served {
  readonly invites?: unknown
  readonly rewards?: unknown
}

function serve(payload: Served): void {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/referrals/stats') return { data: STATS }
    if (path === '/admin/referrals/invites') return { data: payload.invites ?? [] }
    if (path === '/admin/referrals/rewards') return { data: payload.rewards ?? { items: [], total: 0 } }
    return { data: [] }
  })
}

type Person = ReturnType<typeof userEvent.setup>

async function openTab(person: Person, name: 'Invites' | 'Rewards'): Promise<void> {
  await person.click(screen.getByRole('tab', { name }))
}

async function rowFor(label: string): Promise<HTMLElement> {
  const cell = await screen.findByText(label)
  const row = cell.closest('tr')
  expect(row).not.toBeNull()
  return row as HTMLElement
}

function cellsOf(row: HTMLElement): readonly HTMLElement[] {
  return within(row).getAllByRole('cell')
}

/** Invites column order, read off the table header. */
const INVITER = 0
const TOKEN = 1
const EXPIRES = 2
const INVITE_STATUS = 3

/** Rewards column order — index 0 is the bulk-select checkbox. */
const REWARD_USER = 1
const REWARD_TYPE = 2
const REWARD_AMOUNT = 3
const REWARD_STATUS = 4

function installDomShims(): void {
  // Radix drives its Select with Pointer Events APIs jsdom does not implement.
  const proto = window.Element.prototype as unknown as Record<string, unknown>
  proto.hasPointerCapture ??= (): boolean => false
  proto.setPointerCapture ??= (): void => {}
  proto.releasePointerCapture ??= (): void => {}
  proto.scrollIntoView ??= (): void => {}
}

describe('invites tab', () => {
  beforeAll(async () => {
    installDomShims()
    // The dictionary arrives after i18next init; without this the first render
    // would assert against raw key paths.
    await i18nReady
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('names each inviter and prints the telegram id nested on that inviter', async () => {
    const person = userEvent.setup()
    serve({ invites: [ACTIVE_INVITE, EXPIRED_INVITE] })
    renderWithProviders(<ReferralsPage />)
    await openTab(person, 'Invites')

    const telegram = await rowFor('Inviter One')
    expect(cellsOf(telegram)[INVITER]).toHaveTextContent('Inviter One')
    // The id lives on `inviter.telegramId`. Read from the sibling
    // `inviterTelegramId` the old row type declared, this cell was blank.
    expect(cellsOf(telegram)[INVITER]).toHaveTextContent('111222333')
    expect(cellsOf(telegram)[TOKEN]).toHaveTextContent('tok-active')

    // A web sign-up has no name, no username and no telegram id; `displayName`
    // is the only thing that can name it, and the dash is right for the id.
    const web = await rowFor('ops@example.com')
    expect(cellsOf(web)[INVITER]).toHaveTextContent('ops@example.com')
    expect(cellsOf(web)[INVITER]).toHaveTextContent('—')
  })

  it('derives active and expired from the dates the server sent', async () => {
    const person = userEvent.setup()
    serve({ invites: [ACTIVE_INVITE, EXPIRED_INVITE] })
    renderWithProviders(<ReferralsPage />)
    await openTab(person, 'Invites')

    expect(cellsOf(await rowFor('Inviter One'))[INVITE_STATUS]).toHaveTextContent('Active')
    expect(cellsOf(await rowFor('ops@example.com'))[INVITE_STATUS]).toHaveTextContent('Expired')
    // Not `—`: the column has a real date on both rows.
    expect(cellsOf(await rowFor('Inviter One'))[EXPIRES]).not.toHaveTextContent('∞')
  })

  it('says the load failed rather than "no invites yet" when the response does not validate', async () => {
    const person = userEvent.setup()
    serve({ invites: [LEGACY_INVITE] })
    renderWithProviders(<ReferralsPage />)
    await openTab(person, 'Invites')

    expect(await screen.findByText('Failed to load invites')).toBeInTheDocument()
    expect(screen.queryByText('No invites yet')).not.toBeInTheDocument()
    // And not a half-rendered row either: an inviter the panel cannot name is
    // what the old code shipped, as a row with two em dashes in it.
    expect(screen.queryByText('Legacy Inviter')).not.toBeInTheDocument()
  })

  it('refuses an { items } envelope, which this endpoint has never sent', async () => {
    const person = userEvent.setup()
    serve({ invites: { items: [ACTIVE_INVITE] } })
    renderWithProviders(<ReferralsPage />)
    await openTab(person, 'Invites')

    expect(await screen.findByText('Failed to load invites')).toBeInTheDocument()
    expect(screen.queryByText('No invites yet')).not.toBeInTheDocument()
    expect(screen.queryByText('Inviter One')).not.toBeInTheDocument()
  })

  it('still says "no invites yet" when the server really did send an empty list', async () => {
    const person = userEvent.setup()
    serve({ invites: [] })
    renderWithProviders(<ReferralsPage />)
    await openTab(person, 'Invites')

    expect(await screen.findByText('No invites yet')).toBeInTheDocument()
    expect(screen.queryByText('Failed to load invites')).not.toBeInTheDocument()
  })
})

describe('rewards tab', () => {
  beforeAll(async () => {
    installDomShims()
    await i18nReady
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('reads the { items, total } envelope and renders a row per item', async () => {
    const person = userEvent.setup()
    serve({ rewards: { items: [PENDING_REWARD, ISSUED_REWARD], total: 2 } })
    renderWithProviders(<ReferralsPage />)
    await openTab(person, 'Rewards')

    const pending = await rowFor('Inviter One')
    expect(cellsOf(pending)[REWARD_USER]).toHaveTextContent('111222333')
    expect(cellsOf(pending)[REWARD_TYPE]).toHaveTextContent('POINTS')
    expect(cellsOf(pending)[REWARD_AMOUNT]).toHaveTextContent(/^100$/)
    expect(cellsOf(pending)[REWARD_STATUS]).toHaveTextContent('Pending')

    const issued = await rowFor('ops@example.com')
    expect(cellsOf(issued)[REWARD_TYPE]).toHaveTextContent('EXTRA_DAYS')
    expect(cellsOf(issued)[REWARD_AMOUNT]).toHaveTextContent(/^7$/)
    expect(cellsOf(issued)[REWARD_STATUS]).toHaveTextContent('Issued')
  })

  it('says the load failed rather than "no rewards yet" when an item does not validate', async () => {
    const person = userEvent.setup()
    serve({ rewards: { items: [LEGACY_REWARD], total: 1 } })
    renderWithProviders(<ReferralsPage />)
    await openTab(person, 'Rewards')

    expect(await screen.findByText('Failed to load rewards')).toBeInTheDocument()
    expect(screen.queryByText('No rewards yet')).not.toBeInTheDocument()
    expect(screen.queryByText('Legacy User')).not.toBeInTheDocument()
  })

  it('treats a bare list — the per-user rewards shape — as a load failure', async () => {
    const person = userEvent.setup()
    serve({ rewards: [PENDING_REWARD] })
    renderWithProviders(<ReferralsPage />)
    await openTab(person, 'Rewards')

    expect(await screen.findByText('Failed to load rewards')).toBeInTheDocument()
    expect(screen.queryByText('No rewards yet')).not.toBeInTheDocument()
    expect(screen.queryByText('Inviter One')).not.toBeInTheDocument()
  })

  it('treats an { items } with no total as a load failure', async () => {
    const person = userEvent.setup()
    serve({ rewards: { items: [PENDING_REWARD] } })
    renderWithProviders(<ReferralsPage />)
    await openTab(person, 'Rewards')

    expect(await screen.findByText('Failed to load rewards')).toBeInTheDocument()
    expect(screen.queryByText('No rewards yet')).not.toBeInTheDocument()
    expect(screen.queryByText('Inviter One')).not.toBeInTheDocument()
  })

  it('still says "no rewards yet" when the envelope really carries no items', async () => {
    const person = userEvent.setup()
    serve({ rewards: { items: [], total: 0 } })
    renderWithProviders(<ReferralsPage />)
    await openTab(person, 'Rewards')

    expect(await screen.findByText('No rewards yet')).toBeInTheDocument()
    expect(screen.queryByText('Failed to load rewards')).not.toBeInTheDocument()
  })

  it('finds a web sign-up by the name its own cell prints', async () => {
    const person = userEvent.setup()
    serve({ rewards: { items: [PENDING_REWARD, ISSUED_REWARD], total: 2 } })
    renderWithProviders(<ReferralsPage />)
    await openTab(person, 'Rewards')

    await rowFor('ops@example.com')
    await person.type(
      screen.getByPlaceholderText('Search by user or referral ID'),
      'ops@example',
    )

    expect(screen.getByText('ops@example.com')).toBeInTheDocument()
    expect(screen.queryByText('Inviter One')).not.toBeInTheDocument()
  })
})
