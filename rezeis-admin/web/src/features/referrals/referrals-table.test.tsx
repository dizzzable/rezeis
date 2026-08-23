/**
 * What the referrals table renders, against what the server actually sends.
 *
 * Every case here was a blank or wrong cell on a real production row. The
 * table's row type used to be hand-written and unvalidated, so it could
 * declare `level`, `referrerTelegramId` and `referredTelegramId` — three
 * fields `GET /admin/referrals` has never sent — and then ship a bare `L`, an
 * em dash for the source and an empty telegram id on every row without one
 * failing assertion anywhere.
 *
 * Timestamps are derived from one base this file owns. A literal date in a
 * fixture is a statement about the day it was typed: this tree has already had
 * one quietly turn into an "expired" assertion five months later.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { i18nReady } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

import ReferralsPage from './referrals-page'
import {
  REFERRAL_INVITE_SOURCES,
  REFERRAL_PAYOUT_BLOCKERS,
  getSourceMeta,
  type ReferralInviteSource,
  type ReferralPayoutBlocker,
} from './referrals-icons'

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = Date.now()
const DAY_MS = 24 * 60 * 60 * 1000
const daysAgo = (days: number): string => new Date(NOW - days * DAY_MS).toISOString()

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

/**
 * The web sign-up: `WebAuthService` stores `{ name: '', email }` with no
 * `username` and no `telegramId`, and the server maps that empty name to
 * `null`. Everything the old `name ?? username ?? '—'` chain could reach is
 * absent, and the referral edge behind it is still `NOT NULL`.
 */
const WEB_ONLY_REFERRER = wireUser({ id: 'u-web', displayName: 'ops@example.com' })
const TG_REFERRER = wireUser({
  id: 'u-tg',
  name: 'Referrer One',
  displayName: 'Referrer One',
  telegramId: '111222333',
})
const TG_INVITEE = wireUser({
  id: 'u-inv',
  name: 'Invitee Two',
  displayName: 'Invitee Two',
  telegramId: '444555666',
})
const PLAIN_INVITEE = wireUser({
  id: 'u-plain',
  name: 'Plain Invitee',
  displayName: 'Plain Invitee',
})

/**
 * The person one step above `TG_REFERRER`, and the one a level-2 row is FOR.
 *
 * `Referral.referredId` is unique, so the level-2 earner is never a row of its
 * own: the server derives it by walking one step up, the same walk
 * `createConfiguredRewards` makes when it pays. Naming them distinctly is what
 * lets the cases below tell "the grandparent was emitted" apart from "the
 * referrer beside them was emitted twice".
 */
const GRANDPARENT = wireUser({
  id: 'u-grand',
  name: 'Grand Parent',
  displayName: 'Grand Parent',
  telegramId: '999888777',
})

interface WireReferral {
  readonly id: string
  readonly referrer: WireUser
  readonly referred: WireUser
  readonly level: number
  readonly inviteSource: ReferralInviteSource
  readonly qualifiedAt: string | null
  readonly createdAt: string
  readonly payoutBlockedBy: ReferralPayoutBlocker | null
}

function referral(over: Partial<WireReferral> & Pick<WireReferral, 'id'>): WireReferral {
  return {
    referrer: TG_REFERRER,
    referred: TG_INVITEE,
    level: 1,
    inviteSource: 'BOT',
    // The default is the common case AND a promise: the referral programme
    // will pay this row. Cases that want the other answer say so.
    payoutBlockedBy: null,
    createdAt: daysAgo(3),
    qualifiedAt: null,
    ...over,
  }
}

/** Web referrer, level 1, never qualified. */
const WEB_ROW = referral({
  id: 'ref-web',
  referrer: WEB_ONLY_REFERRER,
  referred: PLAIN_INVITEE,
  level: 1,
  inviteSource: 'WEB',
  qualifiedAt: null,
})

/** Telegram on both sides, level 2, qualified. */
const TG_ROW = referral({
  id: 'ref-tg',
  referrer: TG_REFERRER,
  referred: TG_INVITEE,
  level: 2,
  inviteSource: 'BOT',
  qualifiedAt: daysAgo(1),
})

/**
 * ONE registration, TWO payout rows - the shape the table now has to render.
 * `TG_REFERRER` invited `TG_INVITEE`; `GRANDPARENT` invited `TG_REFERRER`.
 */
const CHAIN_LEVEL_1 = referral({ id: 'ref-chain', qualifiedAt: daysAgo(1) })
const CHAIN_LEVEL_2 = referral({
  id: 'derived:L2:ref-chain',
  referrer: GRANDPARENT,
  level: 2,
  qualifiedAt: daysAgo(1),
})

const STATS = { invites: 0, referrals: 2, qualifiedReferrals: 1, rewards: 0, issuedRewards: 0 }

function serve(rows: unknown): void {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/referrals') return { data: rows }
    if (path === '/admin/referrals/stats') return { data: STATS }
    return { data: [] }
  })
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

/** Column order, read off the table header. */
const REFERRER = 0
const REFERRED = 1
const LEVEL = 2
const SOURCE = 3
const QUALIFIED = 4

describe('referrals table', () => {
  beforeAll(async () => {
    // Radix's Select drives itself with Pointer Events APIs jsdom does not
    // implement, so opening one throws before any assertion runs.
    const proto = window.Element.prototype as unknown as Record<string, unknown>
    proto.hasPointerCapture ??= (): boolean => false
    proto.setPointerCapture ??= (): void => {}
    proto.releasePointerCapture ??= (): void => {}
    proto.scrollIntoView ??= (): void => {}
    // The dictionary arrives after i18next init; without this the first render
    // would assert against raw key paths.
    await i18nReady
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('names a web sign-up referrer that has no telegram id, username or name', async () => {
    serve([WEB_ROW])
    renderWithProviders(<ReferralsPage />)

    const row = await rowFor('ops@example.com')
    expect(cellsOf(row)[REFERRER]).toHaveTextContent('ops@example.com')
    expect(cellsOf(row)[REFERRED]).toHaveTextContent('Plain Invitee')
  })

  it('reads both telegram ids off the nested user summary', async () => {
    serve([TG_ROW])
    renderWithProviders(<ReferralsPage />)

    const row = await rowFor('Referrer One')
    expect(cellsOf(row)[REFERRER]).toHaveTextContent('111222333')
    expect(cellsOf(row)[REFERRED]).toHaveTextContent('444555666')
  })

  it('matches a row when the operator searches by telegram id', async () => {
    const person = userEvent.setup()
    serve([WEB_ROW, TG_ROW])
    renderWithProviders(<ReferralsPage />)

    await rowFor('Referrer One')
    await person.type(
      screen.getByPlaceholderText('Search by name or Telegram ID'),
      '444555666',
    )

    expect(screen.getByText('Referrer One')).toBeInTheDocument()
    expect(screen.queryByText('ops@example.com')).not.toBeInTheDocument()
  })

  it('renders each level with its number, not a bare L', async () => {
    serve([WEB_ROW, TG_ROW])
    renderWithProviders(<ReferralsPage />)

    expect(cellsOf(await rowFor('ops@example.com'))[LEVEL]).toHaveTextContent(/^L1$/)
    expect(cellsOf(await rowFor('Referrer One'))[LEVEL]).toHaveTextContent(/^L2$/)
  })

  it('keeps a level’s rows when that level is picked, instead of emptying the table', async () => {
    const person = userEvent.setup()
    serve([WEB_ROW, TG_ROW])
    renderWithProviders(<ReferralsPage />)

    await rowFor('Referrer One')
    await person.click(screen.getAllByRole('combobox')[0])
    await person.click(await screen.findByRole('option', { name: 'L2' }))

    expect(screen.getByText('Referrer One')).toBeInTheDocument()
    expect(screen.queryByText('ops@example.com')).not.toBeInTheDocument()
    expect(screen.queryByText('No referrals yet')).not.toBeInTheDocument()
  })

  /**
   * What every `ReferralInviteSource` must look like on this screen.
   *
   * Keyed by the panel's own `ReferralInviteSource`, so a fourth member added
   * to `REFERRAL_INVITE_SOURCES` does not compile until someone states what it
   * should look like — the map this replaces silently answered for `TELEGRAM`
   * and `MANUAL`, which the enum never had, and had no entry at all for `BOT`,
   * which it does.
   *
   * That type is the PANEL's tuple, though, not the database's enum, and the
   * spec below is the half that says so.
   */
  const SOURCE_EXPECTATIONS: Record<
    ReferralInviteSource,
    { readonly label: string; readonly iconClass: string }
  > = {
    BOT: { label: 'Via Telegram bot', iconClass: 'lucide-message-circle' },
    WEB: { label: 'Via the website', iconClass: 'lucide-globe' },
    UNKNOWN: { label: 'Unknown', iconClass: 'lucide-link' },
  }

  /**
   * THE CROSS-CHECK THE MAP ABOVE ONLY LOOKS LIKE IT MAKES.
   *
   * `REFERRAL_INVITE_SOURCES` is a hand-written copy of the Prisma enum
   * `ReferralInviteSource`, and every compile-time guarantee in this file is
   * keyed off the copy. Nothing compared it to the original, so the guarantee
   * ran in one direction only: add a fourth member to the panel tuple and the
   * map stops compiling; add a fourth member to `schema.prisma` and start
   * emitting it, and NOTHING here moves. `referralSchema` validates the column
   * with `z.enum(REFERRAL_INVITE_SOURCES)`, so the first row carrying the new
   * token fails to parse, the operator gets "Failed to load referrals" for the
   * whole table — and `it.each(REFERRAL_INVITE_SOURCES)` below goes on quietly
   * running its three old cases, green.
   *
   * Read as TEXT rather than imported: production code may not reach across
   * the repository boundary at all (the Docker frontend stage is `COPY web/ .`
   * and `tsconfig.app.json` excludes tests — `src/build-isolation.test.ts`
   * pins the arrangement), but a TEST may, and `plan-transition-targets.test.ts`
   * and `referrals-api-wire-contract.test.ts` already make this exact move.
   *
   * The expected list is written out FIRST and agreement asserted second, in
   * that order and never the other way: an assertion that two implementations
   * agree is green when both of them are wrong, which is the failure mode the
   * whole of `referrals-api-wire-contract.test.ts` exists for.
   */
  it('enumerates exactly the invite sources the database can emit', () => {
    // The answer, before anything is compared to anything.
    const EXPECTED_INVITE_SOURCES = ['BOT', 'WEB', 'UNKNOWN']

    // ...then the schema, which is the rule of record.
    const schemaPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../prisma/schema.prisma',
    )
    const schema: string = readFileSync(schemaPath, 'utf8')
    const block = /\benum\s+ReferralInviteSource\s*\{([^}]*)\}/.exec(schema)
    expect(block, 'ReferralInviteSource is no longer declared in schema.prisma').not.toBeNull()
    const declared = (block as RegExpExecArray)[1]
      .split('\n')
      // Prisma allows `///` docs and `@@map` attributes inside an enum body;
      // members are the bare identifiers.
      .map((line) => line.trim())
      .filter((line) => /^[A-Z][A-Z0-9_]*$/.test(line))
    expect([...declared].sort()).toEqual([...EXPECTED_INVITE_SOURCES].sort())

    // ...and only then the panel's own copy, which drives the zod enum, the
    // icon/label map and every case in this file.
    expect([...REFERRAL_INVITE_SOURCES].sort()).toEqual([...EXPECTED_INVITE_SOURCES].sort())
    // The label/icon map is keyed by the tuple's type, so this is the one
    // statement the compiler cannot make: every member has an expectation.
    expect(Object.keys(SOURCE_EXPECTATIONS).sort()).toEqual([...EXPECTED_INVITE_SOURCES].sort())
  })

  it.each(REFERRAL_INVITE_SOURCES)(
    'renders %s with its own translated label and its own icon',
    async (source) => {
      serve([referral({ id: `ref-${source}`, inviteSource: source })])
      renderWithProviders(<ReferralsPage />)

      const cell = cellsOf(await rowFor('Referrer One'))[SOURCE]
      const expected = SOURCE_EXPECTATIONS[source]
      expect(cell).toHaveTextContent(expected.label)
      // The raw enum token is not a label an operator should ever read.
      expect(cell.textContent ?? '').not.toContain(source)
      expect(cell.querySelector('svg')?.classList.contains(expected.iconClass)).toBe(true)
    },
  )

  it('renders a row that has never qualified, where the dash is the right answer', async () => {
    serve([WEB_ROW])
    renderWithProviders(<ReferralsPage />)

    const row = await rowFor('ops@example.com')
    // Qualification happens only on a completed payment, so most rows
    // legitimately have none. The row must still be there, in full.
    expect(cellsOf(row)[QUALIFIED]).toHaveTextContent(/^—$/)
    expect(cellsOf(row)[REFERRER]).toHaveTextContent('ops@example.com')
  })

  it('shows both earners for one registration, at the level each is paid at', async () => {
    serve([CHAIN_LEVEL_1, CHAIN_LEVEL_2])
    renderWithProviders(<ReferralsPage />)

    const direct = await rowFor('Referrer One')
    const derived = await rowFor('Grand Parent')

    expect(cellsOf(direct)[LEVEL]).toHaveTextContent(/^L1$/)
    expect(cellsOf(derived)[LEVEL]).toHaveTextContent(/^L2$/)
    // The level-2 row names the GRANDPARENT as the earner, and the same
    // invitee as the row above it - it is the same sign-up, seen one step up.
    expect(cellsOf(derived)[REFERRER]).toHaveTextContent('Grand Parent')
    expect(cellsOf(derived)[REFERRED]).toHaveTextContent('Invitee Two')
    expect(cellsOf(direct)[REFERRED]).toHaveTextContent('Invitee Two')
    // ...and not the level-1 referrer, which is the slip this pins.
    expect(cellsOf(derived)[REFERRER]).not.toHaveTextContent('Referrer One')
  })

  it('gives each level its own icon rather than one badge for both', async () => {
    serve([CHAIN_LEVEL_1, CHAIN_LEVEL_2])
    renderWithProviders(<ReferralsPage />)

    const direct = cellsOf(await rowFor('Referrer One'))[LEVEL]
    const derived = cellsOf(await rowFor('Grand Parent'))[LEVEL]

    expect(direct.querySelector('svg')?.classList.contains('lucide-crown')).toBe(true)
    expect(derived.querySelector('svg')?.classList.contains('lucide-star')).toBe(true)
  })

  it('selects the level-1 row when L1 is picked, and the level-2 row when L2 is', async () => {
    const person = userEvent.setup()
    serve([CHAIN_LEVEL_1, CHAIN_LEVEL_2])
    renderWithProviders(<ReferralsPage />)

    await rowFor('Grand Parent')
    await person.click(screen.getAllByRole('combobox')[0])
    await person.click(await screen.findByRole('option', { name: 'L1' }))

    expect(screen.getByText('Referrer One')).toBeInTheDocument()
    expect(screen.queryByText('Grand Parent')).not.toBeInTheDocument()

    await person.click(screen.getAllByRole('combobox')[0])
    await person.click(await screen.findByRole('option', { name: 'L2' }))

    expect(screen.getByText('Grand Parent')).toBeInTheDocument()
    expect(screen.queryByText('Referrer One')).not.toBeInTheDocument()
    expect(screen.queryByText('No referrals yet')).not.toBeInTheDocument()
  })

  /**
   * The level-1 row whose referrer is an active partner. `createConfiguredRewards`
   * returns 0 for them - the partner engine pays them out of a different pot -
   * so the row describes a payout that will not happen. It is KEPT, because it
   * is a real database row and a real relationship, and MARKED, because
   * otherwise the table promises money that never moves.
   */
  const BLOCKER_EXPECTATIONS: Record<
    ReferralPayoutBlocker,
    { readonly label: string; readonly iconClass: string }
  > = {
    PARTNER_PROGRAMME: { label: 'Partner pays', iconClass: 'lucide-handshake' },
    REWARD_NOT_CONFIGURED: { label: 'No reward', iconClass: 'lucide-circle-slash' },
  }

  it.each(REFERRAL_PAYOUT_BLOCKERS)(
    'marks a level-1 row blocked by %s, without hiding the relationship',
    async (blocker) => {
      serve([referral({ id: `ref-${blocker}`, payoutBlockedBy: blocker })])
      renderWithProviders(<ReferralsPage />)

      const row = await rowFor('Referrer One')
      const cell = cellsOf(row)[LEVEL]
      const expected = BLOCKER_EXPECTATIONS[blocker]

      expect(cell).toHaveTextContent(expected.label)
      // The raw token is not a label an operator should ever read.
      expect(cell.textContent ?? '').not.toContain(blocker)
      expect(
        [...cell.querySelectorAll('svg')].some((icon) =>
          icon.classList.contains(expected.iconClass),
        ),
      ).toBe(true)
      // The level is still stated, and both people are still named.
      expect(cell).toHaveTextContent('L1')
      expect(cellsOf(row)[REFERRER]).toHaveTextContent('Referrer One')
      expect(cellsOf(row)[REFERRED]).toHaveTextContent('Invitee Two')
    },
  )

  it('marks nothing on a row the referral programme will pay', async () => {
    serve([CHAIN_LEVEL_1, CHAIN_LEVEL_2])
    renderWithProviders(<ReferralsPage />)

    // A marker here would be the mirror-image lie: money the operator is told
    // will not move, when it will.
    expect(cellsOf(await rowFor('Referrer One'))[LEVEL]).toHaveTextContent(/^L1$/)
    expect(cellsOf(await rowFor('Grand Parent'))[LEVEL]).toHaveTextContent(/^L2$/)
    for (const expected of Object.values(BLOCKER_EXPECTATIONS)) {
      expect(screen.queryByText(expected.label)).not.toBeInTheDocument()
    }
  })

  it('refuses a row with no payoutBlockedBy instead of rendering it as payable', async () => {
    // Every field the table has always had, and the one it now needs. Read as
    // "will be paid", a missing blocker is a promise nobody made.
    const { payoutBlockedBy: _dropped, ...withoutBlocker } = CHAIN_LEVEL_1
    serve([withoutBlocker])
    renderWithProviders(<ReferralsPage />)

    expect(await screen.findByText('Failed to load referrals')).toBeInTheDocument()
    expect(screen.queryByText('Referrer One')).not.toBeInTheDocument()
  })

  it('says the load failed rather than "no referrals yet" when the response does not validate', async () => {
    // The legacy shape the SPA used to assume: top-level telegram ids, no
    // `level`, no `displayName`. It has to be reported as a failure, because
    // "No referrals yet" is a claim about the operator's data.
    serve([{ id: 'legacy', referrerTelegramId: '111', referredTelegramId: '222' }])
    renderWithProviders(<ReferralsPage />)

    expect(await screen.findByText('Failed to load referrals')).toBeInTheDocument()
    expect(screen.queryByText('No referrals yet')).not.toBeInTheDocument()
  })
})

describe('referral source metadata', () => {
  it('treats the two tokens the enum never had as unknown', () => {
    // `TELEGRAM` and `MANUAL` were keys in the map this replaced. The Prisma
    // enum is `BOT | WEB | UNKNOWN`; anything else is unknown by definition.
    expect(getSourceMeta('TELEGRAM')).toBe(getSourceMeta('UNKNOWN'))
    expect(getSourceMeta('MANUAL')).toBe(getSourceMeta('UNKNOWN'))
    expect(getSourceMeta(null)).toBe(getSourceMeta('UNKNOWN'))
  })

  it('gives BOT metadata of its own rather than the unknown fallback', () => {
    expect(getSourceMeta('BOT')).not.toBe(getSourceMeta('UNKNOWN'))
  })
})
