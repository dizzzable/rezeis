/**
 * WHAT THIS FILE PINS, and why fixture-based specs alone were not enough.
 *
 * `referrals-api.ts` shipped schemas that no response the backend has ever
 * produced could satisfy. `referralInviteSchema` required a top-level
 * `inviterId` that `mapReferralInvite` does not emit and a non-nullable
 * `expiresAt` that it emits as null; `referralRewardSchema` required a
 * top-level `userId` that `mapReward` does not emit, and `listRewards` parsed
 * `z.array(...)` against an endpoint that answers `{ items, total }`;
 * `referralRewardIssueSchema` invented a `{ status, reason }` protocol that
 * exists nowhere in the module. Every one of those threw a ZodError on the
 * first byte of a correct response.
 *
 * A spec that only asserts "this fixture parses" would not have caught any of
 * them, because the fixture would have been written from the same
 * misunderstanding as the schema — which is exactly what happened to the
 * `createInvite` case in `referrals-api.test.ts`, where a bare-invite fixture
 * and a bare-invite parse agreed with each other and both disagreed with the
 * server. So the checks below read the BACKEND's own declarations as text and
 * compare three things:
 *
 *     the key list written out here  ->  the backend interface  ->  what the
 *     panel's schema actually admits
 *
 * ...in that order. The expected answer is stated first and agreement second,
 * every time. An agreement-only assertion between two implementations is green
 * when both are wrong, which is the failure mode this whole file exists for.
 *
 * The third leg needs no new exports. Zod strips unknown keys and throws on
 * missing required ones, so feeding a payload built from the EXPECTED key list
 * through the real fetcher and reading `Object.keys` off the result is a
 * complete bidirectional check: a key the schema requires but the server never
 * sends throws, and a key the server sends but the schema omits vanishes from
 * the result.
 *
 * ── WHAT IT WOULD CATCH ────────────────────────────────────────────────────
 *
 *   - a field added to, removed from or renamed in `ReferralInviteInterface`,
 *     `ReferralUserSummaryInterface`, `AdminReferralRewardInterface`,
 *     `AdminReferralRewardsListInterface` or
 *     `CreateReferralInviteResultInterface`;
 *   - a schema here that starts requiring a key the server does not send, or
 *     stops carrying one it does;
 *   - a route renamed, removed or added on `AdminReferralsController`;
 *   - a fetcher re-pointed at a path the controller does not serve.
 *
 * ── READING THE BACKEND FROM A TEST ────────────────────────────────────────
 *
 * Deliberate, and the same move `plan-transition-targets.test.ts` and
 * `plan-write-refusals.test.ts` make. Read as TEXT rather than imported: these
 * files pull in Nest and Prisma, and this assertion needs neither.
 * `tsconfig.app.json` excludes tests so the production build never follows
 * this path, and `src/build-isolation.test.ts` pins that arrangement.
 *
 * ── NO ABSOLUTE DATE LITERALS ──────────────────────────────────────────────
 *
 * Invites carry `expiresAt`, `revokedAt` and `consumedAt`, so this trap is
 * directly in the path here. A `2026-09-20` fixture is a live invite the day
 * it is written and a long-expired one later, with no character changing —
 * the same mechanism that left thirty green tests asserting an
 * expired-subscription defect elsewhere in this repository. Every timestamp
 * below is an offset from one base the test owns.
 *
 * ── REACHABILITY, for the record ───────────────────────────────────────────
 *
 * Of the twelve members of `referralsAdminApi`, live UI code reaches exactly
 * three — `listReferrals`, `listAdminInvites` and `listAdminRewards`, all from
 * `referrals-page.tsx`. The other nine are reachable only from
 * `referrals-queries.ts`, which nothing in the tree imports. That is why none
 * of the defects above was ever seen. Four of those nine
 * (`getSummary`, `listQualificationAudit`, `getExchangePolicy`,
 * `updateExchangePolicy`) do not merely have the wrong schema — they call
 * routes `AdminReferralsController` does not declare at all, so no schema
 * could be right. The route census at the bottom of this file states that as a
 * fact and fails the moment it stops being one.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { referralsAdminApi } from '@/features/referrals/referrals-api'
import { REFERRAL_PAYOUT_BLOCKERS } from '@/features/referrals/referrals-icons'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}))

const mockedGet = vi.mocked(api.get)
const mockedPost = vi.mocked(api.post)

// ── Reading the backend ─────────────────────────────────────────────────────

const BACKEND_MODULE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../src/modules/referrals',
)

function backendSource(relative: string): string {
  return readFileSync(path.join(BACKEND_MODULE, relative), 'utf8')
}

/** Comments carry field names and route strings of their own; drop them first. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** The property names an `export interface` declares, in declaration order. */
function interfaceKeys(source: string, name: string): readonly string[] {
  const match = new RegExp(`export interface ${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(
    withoutComments(source),
  )
  if (match === null) {
    throw new Error(`interface ${name} not found — the backend file moved or it was renamed`)
  }
  return [...match[1].matchAll(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/gm)].map(
    (member) => member[1],
  )
}

/** Every route an `@Controller`-decorated class declares, as `METHOD /full/path`. */
function declaredRoutes(source: string): readonly string[] {
  const clean = withoutComments(source)
  const base = /@Controller\(\s*'([^']*)'\s*\)/.exec(clean)
  if (base === null) throw new Error('no @Controller base path — the controller was restructured')
  return [...clean.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)')?\s*\)/g)].map(
    (route) =>
      `${route[1].toUpperCase()} /${[base[1], route[2] ?? ''].filter((part) => part.length > 0).join('/')}`,
  )
}

function routeMatches(declared: string, actual: string): boolean {
  const [declaredMethod, declaredPath] = declared.split(' ')
  const [actualMethod, actualPath] = actual.split(' ')
  if (declaredMethod !== actualMethod) return false
  const pattern = declaredPath
    .split('/')
    .map((segment) =>
      segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/')
  return new RegExp(`^${pattern}$`).test(actualPath)
}

const isDeclared = (actual: string): boolean =>
  DECLARED_ROUTES.some((declared) => routeMatches(declared, actual))

// ── The answers, written out ────────────────────────────────────────────────

const EXPECTED_USER_SUMMARY_KEYS = [
  'id',
  'username',
  'name',
  'displayName',
  'telegramId',
  'createdAt',
]

/**
 * `payoutBlockedBy` is the field that makes this list a statement about MONEY
 * and not only about the graph. A row without it cannot say whether the payout
 * it describes will actually happen, which is the whole reason the table shows
 * a level at all.
 */
const EXPECTED_REFERRAL_KEYS = [
  'id',
  'referrer',
  'referred',
  'level',
  'inviteSource',
  'qualifiedAt',
  'createdAt',
  'payoutBlockedBy',
]

/** The wire spelling of every blocker, enumerated once for the whole feature. */
const EXPECTED_PAYOUT_BLOCKERS = ['PARTNER_PROGRAMME', 'REWARD_NOT_CONFIGURED']

/** No `inviterId`. The inviter is nested, and always has been. */
const EXPECTED_INVITE_KEYS = [
  'id',
  'token',
  'inviter',
  'note',
  'expiresAt',
  'revokedAt',
  'consumedAt',
  'createdAt',
]

/** No `userId`. The user is nested; `userTelegramId` is the one real top-level id. */
const EXPECTED_REWARD_KEYS = [
  'id',
  'referralId',
  'user',
  'userTelegramId',
  'type',
  'amount',
  'isIssued',
  'issuedAt',
  'issuedBy',
  'createdAt',
]

const EXPECTED_REWARDS_ENVELOPE_KEYS = ['items', 'total']
const EXPECTED_CREATE_INVITE_ENVELOPE_KEYS = ['invite']

/** The twenty handlers `AdminReferralsController` declares. */
const DECLARED_ROUTES = [
  'GET /admin/referrals',
  'GET /admin/referrals/stats',
  'GET /admin/referrals/invites',
  'POST /admin/referrals/invites',
  'DELETE /admin/referrals/invites/:inviteId',
  'POST /admin/referrals/invites/:inviteId/revoke',
  'GET /admin/referrals/rewards',
  'POST /admin/referrals/rewards',
  'POST /admin/referrals/rewards/:rewardId/issue',
  'POST /admin/referrals/rewards/bulk-issue',
  'POST /admin/referrals/rewards/:rewardId/revoke',
  'POST /admin/referrals/manual-attach',
  'POST /admin/referrals/attach',
  'GET /admin/referrals/invite-limits',
  'GET /admin/referrals/invite-capacity/:userId',
  'GET /admin/referrals/analytics/funnel',
  'GET /admin/referrals/analytics/timeseries',
  'GET /admin/referrals/analytics/top-referrers',
  'GET /admin/referrals/analytics/reward-distribution',
  'GET /admin/referrals/analytics/source-breakdown',
]

/**
 * Paths `referralsAdminApi` calls that no handler serves. Not a wish list — a
 * statement of the current defect, so that adding any of these endpoints turns
 * this file red and sends the next reader to the schema that has to be written
 * against it.
 */
const KNOWN_ABSENT_ROUTES = [
  'GET /admin/referrals/summary',
  'GET /admin/referrals/qualification-audit',
  'GET /admin/referrals/exchange-policy',
  'POST /admin/referrals/exchange-policy',
]

// ── Fixtures ────────────────────────────────────────────────────────────────

const BASE_MS = Date.now()
const DAY_MS = 24 * 60 * 60 * 1000
const at = (days: number): string => new Date(BASE_MS + days * DAY_MS).toISOString()

function without(source: object, key: string): Record<string, unknown> {
  const copy = { ...source } as Record<string, unknown>
  delete copy[key]
  return copy
}

function withoutNested(source: object, outer: string, inner: string): Record<string, unknown> {
  const copy = { ...source } as Record<string, unknown>
  copy[outer] = without(copy[outer] as object, inner)
  return copy
}

const USER = {
  id: 'usr_referrer',
  username: null,
  name: null,
  displayName: 'web-signup@example.test',
  telegramId: '77123456789',
  createdAt: at(-200),
}

/**
 * A --> B --> C. `GRANDPARENT` referred `USER`; `USER` referred `INVITEE`.
 *
 * One database row (C's registration) and two people who can be paid for it,
 * which is the shape this endpoint now sends: `Referral.referredId` is unique,
 * so the level-2 earner is not a row at all - the server derives it by walking
 * one step up, exactly as `createConfiguredRewards` does at payout time.
 */
const GRANDPARENT = {
  id: 'usr_grandparent',
  username: 'grandparent',
  name: 'Grand Parent',
  displayName: 'Grand Parent',
  telegramId: '77000000001',
  createdAt: at(-400),
}

const INVITEE = {
  id: 'usr_invitee',
  username: 'invitee',
  name: 'In Vitee',
  displayName: 'In Vitee',
  telegramId: '77000000002',
  createdAt: at(-10),
}

/** The level-1 row: a real `Referral`, and the referral programme will pay it. */
const REFERRAL = {
  id: 'ref_1',
  referrer: USER,
  referred: INVITEE,
  level: 1,
  inviteSource: 'BOT',
  qualifiedAt: null,
  createdAt: at(-5),
  payoutBlockedBy: null,
}

/**
 * The level-2 row for that SAME registration. No database row stands behind
 * it, so its id is marked derived, and `payoutBlockedBy` is null because the
 * server would not have sent it otherwise.
 */
const DERIVED_LEVEL_2 = {
  ...REFERRAL,
  id: 'derived:L2:ref_1',
  referrer: GRANDPARENT,
  level: 2,
}

/** The level-1 row the engine will NOT pay: its referrer is an active partner. */
const BLOCKED_REFERRAL = {
  ...REFERRAL,
  id: 'ref_blocked',
  payoutBlockedBy: 'PARTNER_PROGRAMME',
}

const INVITE = {
  id: 'inv_1',
  token: 'ZmFrZS10b2tlbg',
  inviter: USER,
  note: null,
  expiresAt: at(14),
  revokedAt: null,
  consumedAt: null,
  createdAt: at(-3),
}

/**
 * The permanent invite. `resolveInviteExpiry` returns null for an explicit
 * `expiresAt: null` — the spelling the bot uses when link-TTL is disabled or
 * the inviter holds the VIP bypass — and `mapReferralInvite` sends that null
 * straight through. A non-nullable `expiresAt` refused exactly these rows.
 */
const PERMANENT_INVITE = { ...INVITE, id: 'inv_forever', expiresAt: null }

const REWARD = {
  id: 'rwd_1',
  referralId: 'ref_1',
  user: USER,
  userTelegramId: '77123456789',
  type: 'POINTS',
  amount: 250,
  isIssued: false,
  issuedAt: null,
  issuedBy: null,
  createdAt: at(-2),
}

const ISSUED_REWARD = {
  ...REWARD,
  isIssued: true,
  issuedAt: at(0),
  issuedBy: 'adm_1',
}

beforeEach(() => {
  mockedGet.mockReset()
  mockedPost.mockReset()
})

// ── 1. The backend's own declarations ───────────────────────────────────────

describe('the wire shapes the backend declares', () => {
  const referralInterface = backendSource('interfaces/referral.interface.ts')
  const rewardsInterface = backendSource('interfaces/admin-rewards.interface.ts')

  it('ReferralUserSummaryInterface carries six fields and no nested id sibling', () => {
    expect(EXPECTED_USER_SUMMARY_KEYS).toEqual([
      'id',
      'username',
      'name',
      'displayName',
      'telegramId',
      'createdAt',
    ])
    expect([...interfaceKeys(referralInterface, 'ReferralUserSummaryInterface')].sort()).toEqual(
      [...EXPECTED_USER_SUMMARY_KEYS].sort(),
    )
  })

  it('ReferralInterface carries payoutBlockedBy alongside the level', () => {
    // The answer, before anything is compared to anything. A row that names a
    // level without saying whether that level pays is the exact thing this
    // field exists to stop.
    expect(EXPECTED_REFERRAL_KEYS).toContain('level')
    expect(EXPECTED_REFERRAL_KEYS).toContain('payoutBlockedBy')
    // ...and only then, that the server says the same thing.
    const backend = interfaceKeys(referralInterface, 'ReferralInterface')
    expect([...backend].sort()).toEqual([...EXPECTED_REFERRAL_KEYS].sort())
  })

  // The nullability, separately - a key-set check cannot see it, and null is
  // the half that carries the promise ("the engine will create this reward").
  it('declares payoutBlockedBy nullable on the referral row', () => {
    const declaration = /readonly payoutBlockedBy:([^;]*);/.exec(
      withoutComments(referralInterface).split('export interface ReferralInterface')[1] ?? '',
    )
    expect(declaration).not.toBeNull()
    expect((declaration as RegExpExecArray)[1].replace(/\s+/g, '')).toBe(
      'ReferralPayoutBlockerValue|null',
    )
  })

  it('declares exactly the blockers the panel knows how to render', () => {
    expect(EXPECTED_PAYOUT_BLOCKERS).toEqual(['PARTNER_PROGRAMME', 'REWARD_NOT_CONFIGURED'])
    // The server union, read as text...
    const declaration = /export type ReferralPayoutBlockerValue =([^;]*);/.exec(
      withoutComments(referralInterface),
    )
    expect(declaration).not.toBeNull()
    const declared = [...(declaration as RegExpExecArray)[1].matchAll(/'([^']+)'/g)].map(
      (member) => member[1],
    )
    expect([...declared].sort()).toEqual([...EXPECTED_PAYOUT_BLOCKERS].sort())
    // ...and the panel's own enumeration, which drives the icons and labels.
    expect([...REFERRAL_PAYOUT_BLOCKERS].sort()).toEqual([...EXPECTED_PAYOUT_BLOCKERS].sort())
  })

  it('ReferralInviteInterface nests the inviter and declares no inviterId', () => {
    // The answer, before anything is compared to anything.
    expect(EXPECTED_INVITE_KEYS).toContain('inviter')
    expect(EXPECTED_INVITE_KEYS).not.toContain('inviterId')
    // ...and only then, that the server says the same thing.
    const backend = interfaceKeys(referralInterface, 'ReferralInviteInterface')
    expect([...backend].sort()).toEqual([...EXPECTED_INVITE_KEYS].sort())
    expect(backend).not.toContain('inviterId')
  })

  // The nullability, separately — a key-set check cannot see it, and this is
  // the half that refused every permanent invite.
  it('declares expiresAt nullable on the invite', () => {
    const declaration = /readonly expiresAt:([^;]*);/.exec(
      withoutComments(referralInterface).split('export interface ReferralInviteInterface')[1] ?? '',
    )
    expect(declaration).not.toBeNull()
    expect((declaration as RegExpExecArray)[1].replace(/\s+/g, '')).toBe('string|null')
  })

  it('AdminReferralRewardInterface nests the user and declares no userId', () => {
    expect(EXPECTED_REWARD_KEYS).toContain('user')
    expect(EXPECTED_REWARD_KEYS).toContain('userTelegramId')
    expect(EXPECTED_REWARD_KEYS).not.toContain('userId')
    const backend = interfaceKeys(rewardsInterface, 'AdminReferralRewardInterface')
    expect([...backend].sort()).toEqual([...EXPECTED_REWARD_KEYS].sort())
    expect(backend).not.toContain('userId')
  })

  it('AdminReferralRewardsListInterface is an envelope, with a required total', () => {
    expect(EXPECTED_REWARDS_ENVELOPE_KEYS).toEqual(['items', 'total'])
    expect([...interfaceKeys(rewardsInterface, 'AdminReferralRewardsListInterface')].sort()).toEqual(
      [...EXPECTED_REWARDS_ENVELOPE_KEYS].sort(),
    )
  })

  it('CreateReferralInviteResultInterface wraps the invite in { invite }', () => {
    expect(EXPECTED_CREATE_INVITE_ENVELOPE_KEYS).toEqual(['invite'])
    expect(
      [...interfaceKeys(referralInterface, 'CreateReferralInviteResultInterface')].sort(),
    ).toEqual([...EXPECTED_CREATE_INVITE_ENVELOPE_KEYS].sort())
  })

  // The fixtures below are what the third leg of the check is built from, so
  // they are held to the same list rather than trusted.
  it('every fixture in this file is built from those same key lists', () => {
    expect(Object.keys(USER).sort()).toEqual([...EXPECTED_USER_SUMMARY_KEYS].sort())
    expect(Object.keys(GRANDPARENT).sort()).toEqual([...EXPECTED_USER_SUMMARY_KEYS].sort())
    expect(Object.keys(INVITEE).sort()).toEqual([...EXPECTED_USER_SUMMARY_KEYS].sort())
    expect(Object.keys(REFERRAL).sort()).toEqual([...EXPECTED_REFERRAL_KEYS].sort())
    expect(Object.keys(DERIVED_LEVEL_2).sort()).toEqual([...EXPECTED_REFERRAL_KEYS].sort())
    expect(Object.keys(BLOCKED_REFERRAL).sort()).toEqual([...EXPECTED_REFERRAL_KEYS].sort())
    expect(Object.keys(INVITE).sort()).toEqual([...EXPECTED_INVITE_KEYS].sort())
    expect(Object.keys(PERMANENT_INVITE).sort()).toEqual([...EXPECTED_INVITE_KEYS].sort())
    expect(Object.keys(REWARD).sort()).toEqual([...EXPECTED_REWARD_KEYS].sort())
    expect(Object.keys(ISSUED_REWARD).sort()).toEqual([...EXPECTED_REWARD_KEYS].sort())
  })
})

// ── 2. What the panel's schemas admit ───────────────────────────────────────

describe('referralsAdminApi.listReferrals — GET /admin/referrals', () => {
  it('carries exactly the keys the server sends, on both levels', async () => {
    mockedGet.mockResolvedValue({ data: [REFERRAL, DERIVED_LEVEL_2] })

    const rows = await referralsAdminApi.listReferrals()

    expect(rows).toEqual([REFERRAL, DERIVED_LEVEL_2])
    expect(Object.keys(rows[0]).sort()).toEqual([...EXPECTED_REFERRAL_KEYS].sort())
    expect(Object.keys(rows[1]).sort()).toEqual([...EXPECTED_REFERRAL_KEYS].sort())
    expect(Object.keys(rows[0].referrer).sort()).toEqual([...EXPECTED_USER_SUMMARY_KEYS].sort())
  })

  it('keeps the two rows of one registration apart by level and by earner', async () => {
    mockedGet.mockResolvedValue({ data: [REFERRAL, DERIVED_LEVEL_2] })

    const [level1, level2] = await referralsAdminApi.listReferrals()

    expect([level1.level, level2.level]).toEqual([1, 2])
    expect(level2.referrer.id).toBe('usr_grandparent')
    expect(level2.referrer.id).not.toBe(level1.referrer.id)
    // Same registration, seen by the person one step further up.
    expect(level2.referred.id).toBe(level1.referred.id)
    expect(level2.id).not.toBe(level1.id)
  })

  it('parses each blocker the server can send', async () => {
    mockedGet.mockResolvedValue({
      data: EXPECTED_PAYOUT_BLOCKERS.map((blocker, index) => ({
        ...REFERRAL,
        id: `ref_${index}`,
        payoutBlockedBy: blocker,
      })),
    })

    const rows = await referralsAdminApi.listReferrals()

    expect(rows.map((row) => row.payoutBlockedBy)).toEqual(EXPECTED_PAYOUT_BLOCKERS)
  })

  it('refuses a row with no payoutBlockedBy rather than reading it as “will be paid”', async () => {
    // An older server, or a mapper that dropped the field. Defaulting it to
    // null would turn "we do not know" into a promise of money.
    mockedGet.mockResolvedValue({ data: [without(REFERRAL, 'payoutBlockedBy')] })

    await expect(referralsAdminApi.listReferrals()).rejects.toThrow()
  })

  it('refuses a blocker token the panel has no label for', async () => {
    mockedGet.mockResolvedValue({ data: [{ ...REFERRAL, payoutBlockedBy: 'SOMETHING_NEW' }] })

    await expect(referralsAdminApi.listReferrals()).rejects.toThrow()
  })

  it('accepts the { items } envelope this route has also answered with', async () => {
    mockedGet.mockResolvedValue({ data: { items: [REFERRAL, DERIVED_LEVEL_2] } })

    expect(await referralsAdminApi.listReferrals()).toEqual([REFERRAL, DERIVED_LEVEL_2])
  })
})

describe('referralsAdminApi.listInvites — GET /admin/referrals/invites?inviterId=', () => {
  it('carries exactly the keys the server sends, and no others', async () => {
    mockedGet.mockResolvedValue({ data: [INVITE] })

    const [row] = await referralsAdminApi.listInvites('usr_referrer')

    // A required key the server never sends would have thrown above; a key the
    // server does send but the schema drops would be missing here.
    expect(Object.keys(row).sort()).toEqual([...EXPECTED_INVITE_KEYS].sort())
    expect(Object.keys(row.inviter).sort()).toEqual([...EXPECTED_USER_SUMMARY_KEYS].sort())
    expect(row).toEqual(INVITE)
  })

  it('accepts expiresAt: null — the invite that never expires', async () => {
    mockedGet.mockResolvedValue({ data: [PERMANENT_INVITE] })

    const [row] = await referralsAdminApi.listInvites('usr_referrer')

    expect(row.expiresAt).toBeNull()
    expect(row).toEqual(PERMANENT_INVITE)
  })

  it('sends the inviterId filter the server whitelists, and nothing else', async () => {
    mockedGet.mockResolvedValue({ data: [] })

    await referralsAdminApi.listInvites('usr_referrer')

    expect(mockedGet).toHaveBeenCalledWith('/admin/referrals/invites', {
      params: { inviterId: 'usr_referrer' },
    })
  })

  it('refuses a row with no token', async () => {
    mockedGet.mockResolvedValue({ data: [without(INVITE, 'token')] })

    await expect(referralsAdminApi.listInvites('usr_referrer')).rejects.toThrow()
  })

  it('refuses a row whose inviter has no displayName', async () => {
    mockedGet.mockResolvedValue({ data: [withoutNested(INVITE, 'inviter', 'displayName')] })

    await expect(referralsAdminApi.listInvites('usr_referrer')).rejects.toThrow()
  })

  // The historical wrong shape, stated as a payload: a flat inviterId in place
  // of the nested inviter. It has to be refused, or the repair is cosmetic.
  it('refuses the old flat shape — inviterId instead of a nested inviter', async () => {
    mockedGet.mockResolvedValue({
      data: [{ ...without(INVITE, 'inviter'), inviterId: 'usr_referrer' }],
    })

    await expect(referralsAdminApi.listInvites('usr_referrer')).rejects.toThrow()
  })
})

describe('referralsAdminApi.listRewards — GET /admin/referrals/rewards?userId=', () => {
  it('reads the { items, total } envelope and returns the rows', async () => {
    mockedGet.mockResolvedValue({ data: { items: [REWARD], total: 1 } })

    const rows = await referralsAdminApi.listRewards('usr_referrer')

    expect(rows).toEqual([REWARD])
    expect(Object.keys(rows[0]).sort()).toEqual([...EXPECTED_REWARD_KEYS].sort())
    expect(Object.keys(rows[0].user).sort()).toEqual([...EXPECTED_USER_SUMMARY_KEYS].sort())
  })

  it('refuses a bare array, which this endpoint has never sent', async () => {
    mockedGet.mockResolvedValue({ data: [REWARD] })

    await expect(referralsAdminApi.listRewards('usr_referrer')).rejects.toThrow()
  })

  // `total` comes from an unconditional `prisma.count()`, so an envelope
  // without it did not come from this handler. Accepting it would turn some
  // other endpoint's body into an empty table.
  it('refuses an envelope with no total', async () => {
    mockedGet.mockResolvedValue({ data: { items: [REWARD] } })

    await expect(referralsAdminApi.listRewards('usr_referrer')).rejects.toThrow()
  })

  it('refuses a row with no user', async () => {
    mockedGet.mockResolvedValue({ data: { items: [without(REWARD, 'user')], total: 1 } })

    await expect(referralsAdminApi.listRewards('usr_referrer')).rejects.toThrow()
  })

  it('refuses the old flat shape — userId instead of a nested user', async () => {
    mockedGet.mockResolvedValue({
      data: { items: [{ ...without(REWARD, 'user'), userId: 'usr_referrer' }], total: 1 },
    })

    await expect(referralsAdminApi.listRewards('usr_referrer')).rejects.toThrow()
  })

  it('sends the userId filter the server whitelists, and nothing else', async () => {
    mockedGet.mockResolvedValue({ data: { items: [], total: 0 } })

    await referralsAdminApi.listRewards('usr_referrer')

    expect(mockedGet).toHaveBeenCalledWith('/admin/referrals/rewards', {
      params: { userId: 'usr_referrer' },
    })
  })
})

describe('referralsAdminApi.issueReward — POST /admin/referrals/rewards/:id/issue', () => {
  it('parses the reward the handler returns', async () => {
    mockedPost.mockResolvedValue({ data: ISSUED_REWARD })

    const reward = await referralsAdminApi.issueReward('rwd_1')

    expect(reward).toEqual(ISSUED_REWARD)
    expect(Object.keys(reward).sort()).toEqual([...EXPECTED_REWARD_KEYS].sort())
  })

  // `AdminRewardsService.issue` never answers with a verdict object: the
  // outcomes the old `z.enum(['ISSUED', 'BLOCKED'])` imagined are a 200
  // carrying the reward and a thrown 4xx carrying a Nest error body.
  it('refuses a { status, reason } verdict, which the endpoint has never sent', async () => {
    mockedPost.mockResolvedValue({ data: { id: 'rwd_1', status: 'BLOCKED', reason: 'revoked' } })

    await expect(referralsAdminApi.issueReward('rwd_1')).rejects.toThrow()
  })

  it('refuses a reward with no amount', async () => {
    mockedPost.mockResolvedValue({ data: without(ISSUED_REWARD, 'amount') })

    await expect(referralsAdminApi.issueReward('rwd_1')).rejects.toThrow()
  })
})

describe('referralsAdminApi.revokeInvite — POST /admin/referrals/invites/:id/revoke', () => {
  // The controller declares this POST as an explicit alias of the DELETE, so
  // the method is deliberate; the body is a bare invite either way.
  it('parses the bare invite the alias returns', async () => {
    const revoked = { ...INVITE, revokedAt: at(0) }
    mockedPost.mockResolvedValue({ data: revoked })

    const invite = await referralsAdminApi.revokeInvite('inv_1')

    expect(invite).toEqual(revoked)
    expect(mockedPost).toHaveBeenCalledWith('/admin/referrals/invites/inv_1/revoke')
  })

  it('refuses an { invite } envelope — that is createInvite, not this', async () => {
    mockedPost.mockResolvedValue({ data: { invite: INVITE } })

    await expect(referralsAdminApi.revokeInvite('inv_1')).rejects.toThrow()
  })
})

describe('referralsAdminApi.listAdminInvites / listAdminRewards — the reachable pair', () => {
  it('listAdminInvites and listInvites admit the same shape, being one route', async () => {
    mockedGet.mockResolvedValue({ data: [INVITE, PERMANENT_INVITE] })

    const rows = await referralsAdminApi.listAdminInvites()

    expect(rows).toEqual([INVITE, PERMANENT_INVITE])
    expect(Object.keys(rows[0]).sort()).toEqual([...EXPECTED_INVITE_KEYS].sort())
  })

  it('listAdminRewards and listRewards read the same envelope, being one route', async () => {
    mockedGet.mockResolvedValue({ data: { items: [REWARD, ISSUED_REWARD], total: 2 } })

    const rows = await referralsAdminApi.listAdminRewards()

    expect(rows).toEqual([REWARD, ISSUED_REWARD])
    expect(Object.keys(rows[0]).sort()).toEqual([...EXPECTED_REWARD_KEYS].sort())
  })
})

// ── 3. The route census ─────────────────────────────────────────────────────

/**
 * Where a fetcher POINTS, recorded independently of what it parses: the mocked
 * response is `undefined` and the refusal is swallowed, because the request
 * has already been made by then. Nothing here encodes a guessed body shape.
 */
async function observedRoute(run: () => Promise<unknown>): Promise<string> {
  mockedGet.mockReset()
  mockedPost.mockReset()
  mockedGet.mockResolvedValue({ data: undefined })
  mockedPost.mockResolvedValue({ data: undefined })
  await run().then(
    () => undefined,
    () => undefined,
  )
  if (mockedGet.mock.calls.length > 0) return `GET ${String(mockedGet.mock.calls[0][0])}`
  if (mockedPost.mock.calls.length > 0) return `POST ${String(mockedPost.mock.calls[0][0])}`
  throw new Error('the fetcher issued no request at all')
}

describe('the routes AdminReferralsController actually declares', () => {
  it('is the twenty handlers written out above', () => {
    // The answer first: the four the panel depends on are there, and the four
    // it wrongly calls are not.
    expect(DECLARED_ROUTES).toHaveLength(20)
    expect(DECLARED_ROUTES).toContain('GET /admin/referrals')
    expect(DECLARED_ROUTES).toContain('GET /admin/referrals/invites')
    expect(DECLARED_ROUTES).toContain('GET /admin/referrals/rewards')
    expect(DECLARED_ROUTES).toContain('POST /admin/referrals/rewards/:rewardId/issue')
    for (const absent of KNOWN_ABSENT_ROUTES) {
      expect(DECLARED_ROUTES).not.toContain(absent)
    }

    // ...and only then, that the controller agrees.
    const backend = declaredRoutes(
      backendSource('controllers/admin-referrals.controller.ts'),
    )
    expect([...backend].sort()).toEqual([...DECLARED_ROUTES].sort())
  })

  // Both revoke forms are deliberate — the POST is declared as an explicit
  // alias of the DELETE — so `revokeInvite` using POST is not a defect.
  it('serves both revoke forms for an invite', () => {
    expect(DECLARED_ROUTES).toContain('DELETE /admin/referrals/invites/:inviteId')
    expect(DECLARED_ROUTES).toContain('POST /admin/referrals/invites/:inviteId/revoke')
  })
})

describe('every fetcher points at a route that exists', () => {
  it.each([
    ['listReferrals', (): Promise<unknown> => referralsAdminApi.listReferrals()],
    ['listAdminInvites', (): Promise<unknown> => referralsAdminApi.listAdminInvites()],
    ['listAdminRewards', (): Promise<unknown> => referralsAdminApi.listAdminRewards()],
    ['listInvites', (): Promise<unknown> => referralsAdminApi.listInvites('usr_1')],
    ['listRewards', (): Promise<unknown> => referralsAdminApi.listRewards('usr_1')],
    ['createInvite', (): Promise<unknown> => referralsAdminApi.createInvite('usr_1')],
    ['revokeInvite', (): Promise<unknown> => referralsAdminApi.revokeInvite('inv_1')],
    ['issueReward', (): Promise<unknown> => referralsAdminApi.issueReward('rwd_1')],
  ])('%s', async (_name, run) => {
    const route = await observedRoute(run)
    expect({ route, declared: isDeclared(route) }).toEqual({ route, declared: true })
  })
})

/**
 * THE UNSERVED FOUR. These fetchers cannot be repaired by fixing a schema —
 * there is no handler behind them, so the response is a 404 body and any shape
 * written for them is invention. `referrals-queries.ts` is their only caller
 * and nothing imports that file, which is why this has never been seen.
 *
 * Asserted as ABSENT on purpose. Adding any of these endpoints turns this red,
 * which is the moment the matching schema in `referrals-api.ts` has to be
 * written against the real body — see the notes there.
 */
describe('the fetchers that point at no handler at all', () => {
  it.each([
    ['getSummary', (): Promise<unknown> => referralsAdminApi.getSummary('usr_1')],
    [
      'listQualificationAudit',
      (): Promise<unknown> => referralsAdminApi.listQualificationAudit('usr_1'),
    ],
    ['getExchangePolicy', (): Promise<unknown> => referralsAdminApi.getExchangePolicy()],
    ['updateExchangePolicy', (): Promise<unknown> => referralsAdminApi.updateExchangePolicy({})],
  ])('%s calls a path the controller does not serve', async (_name, run) => {
    const route = await observedRoute(run)
    expect(KNOWN_ABSENT_ROUTES).toContain(route)
    expect({ route, declared: isDeclared(route) }).toEqual({ route, declared: false })
  })
})
