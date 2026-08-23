import { beforeEach, describe, expect, it, vi } from 'vitest'

import { referralsAdminApi } from '@/features/referrals/referrals-api'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}))

const mockedPost = vi.mocked(api.post)

/**
 * NO ABSOLUTE DATE LITERALS, here or in any fixture below.
 *
 * The fixture this replaces carried `expiresAt: '2026-09-20T00:00:00.000Z'`,
 * which was a live invite the day it was written and becomes a long-expired one
 * without a single character changing. That exact mechanism already cost this
 * repository thirty green tests asserting an expired-subscription defect. Every
 * timestamp here is an offset from one base the test owns, so "expires in a
 * week" stays "expires in a week" forever.
 */
const BASE_MS = Date.now()
const DAY_MS = 24 * 60 * 60 * 1000
const at = (days: number): string => new Date(BASE_MS + days * DAY_MS).toISOString()

/** `ReferralUserSummaryInterface` — nested, and the only place an inviter appears. */
const INVITER = {
  id: 'user-1',
  username: null,
  name: null,
  displayName: 'web-signup@example.test',
  telegramId: null,
  createdAt: at(-90),
}

/** `ReferralInviteInterface`, in full, as `mapReferralInvite` emits it. */
const INVITE = {
  id: 'invite-1',
  token: 'tok_abc',
  inviter: INVITER,
  note: null,
  expiresAt: at(7),
  revokedAt: null,
  consumedAt: null,
  createdAt: at(-1),
}

/**
 * What the endpoint actually answers with.
 * `ReferralsService.createInvite` returns `{ invite: mapReferralInvite(created) }`.
 */
const CREATE_INVITE_RESPONSE = { invite: INVITE }

function sentBody(): Record<string, unknown> {
  return mockedPost.mock.calls[0]?.[1] as unknown as Record<string, unknown>
}

/**
 * `createInvite` used to send `{ inviterId, ttlHours }`. No DTO and nothing
 * else in the backend has ever had a `ttlHours` field, and the API runs with
 * `forbidNonWhitelisted: true`, so every request this helper could make came
 * back 400 `["property ttlHours should not exist"]`.
 *
 * The server's field is `expiresInDays` (`CreateReferralInviteDto`), honoured
 * in `resolveInviteExpiry`. These cases pin the outgoing request body itself,
 * because the helper has no call sites yet and nothing else would notice it
 * drifting back.
 */
describe('referralsAdminApi.createInvite request body', () => {
  beforeEach(() => {
    mockedPost.mockReset()
    mockedPost.mockResolvedValue({ data: CREATE_INVITE_RESPONSE })
  })

  it('sends expiresInDays, and never the non-existent ttlHours', async () => {
    await referralsAdminApi.createInvite('user-1', 7)

    expect(mockedPost).toHaveBeenCalledWith('/admin/referrals/invites', {
      inviterId: 'user-1',
      expiresInDays: 7,
    })
    expect(sentBody()).not.toHaveProperty('ttlHours')
    expect(Object.keys(sentBody()).sort()).toEqual(['expiresInDays', 'inviterId'])
  })

  it('omits the TTL key entirely when none is given, rather than sending null', async () => {
    await referralsAdminApi.createInvite('user-1')

    // `null` survives `@IsOptional()` and then reaches
    // `addDays(new Date(), null)`, which returns the reference date unchanged:
    // an invite already expired the moment it is created. Absence is what
    // selects the server's default TTL, so the key must be gone entirely, not
    // present-and-null.
    expect(Object.keys(sentBody())).toEqual(['inviterId'])
    expect(sentBody().expiresInDays).toBeUndefined()
    expect(sentBody()).not.toHaveProperty('ttlHours')
  })
})

/**
 * THE RESPONSE HALF of the same defect, and it was the larger one: the request
 * body was merely rejected, whereas the response parse threw on a body the
 * server had answered correctly.
 *
 * `POST /admin/referrals/invites` returns `CreateReferralInviteResultInterface`
 * — `{ invite }` — from `ReferralsService.createInvite`, and the helper parsed
 * the envelope AS the invite. The case this replaces asserted
 * `expect(invite).toEqual(INVITE)` against a fixture that was itself a bare
 * invite, so the test agreed with the code and both were wrong about the
 * server. That is the shape of a green test guarding nothing.
 */
describe('referralsAdminApi.createInvite response envelope', () => {
  beforeEach(() => {
    mockedPost.mockReset()
  })

  it('unwraps { invite } and hands back the invite itself', async () => {
    mockedPost.mockResolvedValue({ data: CREATE_INVITE_RESPONSE })

    const invite = await referralsAdminApi.createInvite('user-1', 30)

    expect(invite).toEqual(INVITE)
    expect(invite).not.toHaveProperty('invite')
  })

  // The envelope has to be load-bearing, or unwrapping it proves nothing: a
  // schema that accepted both shapes would pass the case above unchanged.
  it('refuses a bare invite body, which this endpoint has never sent', async () => {
    mockedPost.mockResolvedValue({ data: INVITE })

    await expect(referralsAdminApi.createInvite('user-1', 30)).rejects.toThrow()
  })

  it('refuses an envelope whose invite is missing a required field', async () => {
    const { token: _token, ...withoutToken } = INVITE
    mockedPost.mockResolvedValue({ data: { invite: withoutToken } })

    await expect(referralsAdminApi.createInvite('user-1', 30)).rejects.toThrow()
  })
})
