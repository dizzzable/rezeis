/**
 * Which 401s are allowed to destroy the session.
 *
 * The interceptor in `lib/api.ts` used to exempt exactly two URLs, and the
 * comment above one of them already documented the damage: `forceEndAdminSession`
 * runs `queryClient.clear()`, which removes the page's own queries and remounts
 * it from scratch. That is why the sign-in route was excluded. But the same
 * shape existed on every other endpoint that checks a credential inside a
 * session — one mistyped digit while enabling 2FA, disabling it, or
 * regenerating recovery codes, or one wrong character in the current password
 * on the change-password screen, threw the operator out of a session that was
 * never invalid.
 *
 * The rule under test is not "these URLs are special". It is: a 401 ends the
 * session only when the SESSION was the request's whole authority. Both halves
 * are asserted here, and the second half is what keeps the first honest — the
 * control cases below are plain session-authenticated reads and they MUST
 * still tear the session down.
 *
 * The controls have to be chosen, not just counted. `/admin/users`,
 * `/admin/2fa/status` and `/admin/passkey/credentials` neither extend nor
 * contain an exempt path, so no number of them can notice the match going
 * loose — `has(path)` could become `startsWith` or `includes` and all of them
 * would still tear the session down, which is why the source spends a
 * paragraph on the match being exact and why that paragraph went unguarded.
 * The controls that carry the weight are the ones which EXTEND an exempt path
 * (`/admin/auth/login-history` over `/admin/auth/login`) or merely contain
 * one: under a loosened match those get exempted, a genuinely dead session is
 * kept alive, and the operator is left on a panel where every request fails
 * silently.
 *
 * The real `api` instance and its real interceptor run; only the transport is
 * replaced.
 */
import {
  AxiosError,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { api, normalizeRequestPath, submitsOwnCredential } from '@/lib/api'
import { queryClient } from '@/lib/query-client'
import { endAdminClientSession, isForceLogoutInProgress } from '@/lib/admin-session'
import { authStorage } from '@/lib/auth-storage'

let originalAdapter: AxiosAdapter | undefined

/** Every request 401s. Which URL it was is the only variable. */
const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
  const response = {
    data: { statusCode: 401, message: 'Unauthorized', errorCode: 'UNAUTHORIZED' },
    status: 401,
    statusText: 'Unauthorized',
    headers: {},
    config,
  } as AxiosResponse
  throw new AxiosError(
    'Request failed with status code 401',
    AxiosError.ERR_BAD_REQUEST,
    config,
    {},
    response,
  )
}

const LIVE_QUERY_KEY = ['admin', 'two-factor', 'status'] as const

function seedSession(): void {
  authStorage.setToken('a-live-session-token')
  queryClient.setQueryData(LIVE_QUERY_KEY, { enabled: true })
}

interface Outcome {
  readonly sessionDestroyed: boolean
  readonly cachedQuerySurvived: boolean
}

async function fireAndObserve(
  url: string,
  config?: Record<string, unknown>,
): Promise<Outcome> {
  seedSession()
  await expect(api.post(url, {}, config)).rejects.toBeInstanceOf(AxiosError)
  return {
    sessionDestroyed: isForceLogoutInProgress(),
    cachedQuerySurvived: queryClient.getQueryData(LIVE_QUERY_KEY) !== undefined,
  }
}

beforeEach(() => {
  // `forceEndAdminSession` reads `window.location.pathname` to decide whether
  // to navigate. Parked on the sign-in path so the redirect branch is a no-op
  // and the observable effect is the teardown itself.
  window.history.replaceState({}, '', '/sign-in')
  originalAdapter = api.defaults.adapter as AxiosAdapter | undefined
  api.defaults.adapter = adapter
  // Resets the `forceLogoutInProgress` latch as well as the cache — otherwise
  // one torn-down session would mask every later case.
  endAdminClientSession(queryClient)
  window.localStorage.clear()
})

afterEach(() => {
  api.defaults.adapter = originalAdapter
  endAdminClientSession(queryClient)
  window.localStorage.clear()
})

describe('a 401 on a credential-verification request leaves the session alone', () => {
  const credentialRoutes: readonly [string, string][] = [
    ['/admin/auth/login', 'the password, and the TOTP code on step two'],
    ['/admin/auth/password', 'the current password, re-checked before rotating it'],
    ['/admin/2fa/confirm', 'the first TOTP code of a fresh enrollment'],
    ['/admin/2fa/disable', 'a live TOTP or recovery code'],
    ['/admin/2fa/recovery-codes/regenerate', 'a live TOTP or recovery code'],
    ['/admin/passkey/authenticate/verify', 'a WebAuthn assertion, on the sign-in page'],
    ['/admin/passkey/register/options', 'the fresh factor demanded before enrolment'],
    ['/admin/passkey/register/verify', 'a WebAuthn attestation'],
  ]

  for (const [url, credential] of credentialRoutes) {
    it(`survives a 401 from ${url} (it carried ${credential})`, async () => {
      const outcome = await fireAndObserve(url)
      expect(outcome.sessionDestroyed).toBe(false)
      expect(outcome.cachedQuerySurvived).toBe(true)
    })
  }

  it('survives a 401 from the auth probe, which the auth provider handles itself', async () => {
    seedSession()
    await expect(api.get('/admin/auth/me')).rejects.toBeInstanceOf(AxiosError)
    expect(isForceLogoutInProgress()).toBe(false)
  })

  it('exempts only the probe itself, not everything under /admin/auth', async () => {
    // The probe is exempt for its own reason — the auth provider tears the
    // session down itself and doing it from both places races — and that
    // reason applies to one URL. Widening it to a prefix would silently
    // exempt every future `/admin/auth/*` read.
    const outcome = await fireAndObserve('/admin/auth/sessions')
    expect(outcome.sessionDestroyed).toBe(true)
    expect(outcome.cachedQuerySurvived).toBe(false)
  })

  it('survives a 401 on any request that declares it submits a credential', async () => {
    // The rule as a mechanism rather than a list: a future flow says so at the
    // call site and needs no edit to `lib/api.ts`.
    const outcome = await fireAndObserve('/admin/some/future/step-up', {
      submitsCredential: true,
    })
    expect(outcome.sessionDestroyed).toBe(false)
    expect(outcome.cachedQuerySurvived).toBe(true)
  })

  it('matches through the /api prefix, an absolute URL, and a missing slash', async () => {
    expect(normalizeRequestPath('/api/admin/2fa/disable')).toBe('/admin/2fa/disable')
    expect(normalizeRequestPath('https://panel.example.com/api/admin/2fa/disable?x=1')).toBe(
      '/admin/2fa/disable',
    )
    expect(normalizeRequestPath('admin/2fa/disable/')).toBe('/admin/2fa/disable')
    expect(normalizeRequestPath(undefined)).toBeNull()
  })
})

describe('the exempt-path match is exact — not a prefix, not a substring', () => {
  // `submitsOwnCredential` is the rule itself, tested without the interceptor
  // in the way so the near-misses can be enumerated cheaply. Each string below
  // is a path that a loosened match would wrongly exempt, and the comment says
  // which loosening it catches.
  const nearMisses: readonly [string, string][] = [
    // Extends `/admin/auth/login`: caught by neither `startsWith` nor `includes`.
    ['/admin/auth/login-history', 'a read of past sign-ins — submits nothing'],
    ['/admin/2fa/confirm/undo', 'extends `/admin/2fa/confirm`'],
    ['/admin/2fa/disabled', 'extends `/admin/2fa/disable` without even a slash'],
    ['/admin/passkey/register/options/preview', 'extends `/admin/passkey/register/options`'],
    // Contains an exempt path without starting with one: `includes` only.
    ['/admin/audit/admin/2fa/disable', 'contains an exempt path deeper in'],
  ]

  for (const [url, why] of nearMisses) {
    it(`does not exempt ${url} (${why})`, () => {
      expect(submitsOwnCredential({ url })).toBe(false)
    })
  }

  it('still exempts every path on the list, spelled exactly', () => {
    // The other side of the same rule: tightening the match into something
    // that stops matching at all would pass every assertion above.
    for (const url of [
      '/admin/auth/login',
      '/admin/auth/password',
      '/admin/2fa/confirm',
      '/admin/2fa/disable',
      '/admin/2fa/recovery-codes/regenerate',
      '/admin/passkey/authenticate/verify',
      '/admin/passkey/register/options',
      '/admin/passkey/register/verify',
    ]) {
      expect(submitsOwnCredential({ url })).toBe(true)
      expect(submitsOwnCredential({ url: `/api${url}?x=1` })).toBe(true)
    }
  })
})

describe('a 401 on a plain session-authenticated request still ends the session', () => {
  // Without these the rule above would be indistinguishable from "never log
  // out", and an expired token would strand the operator on a panel where
  // every request fails silently.
  const sessionRoutes: readonly [string, string][] = [
    ['/admin/users', 'an ordinary authenticated read'],
    // Adjacent to the exempt ones: reading 2FA status, or listing passkeys,
    // submits nothing. These two share a FEATURE with exempt routes, which is
    // weaker than it looks — neither string extends nor contains an exempt
    // path, so neither can detect the match going loose.
    ['/admin/2fa/status', 'a read on the same feature as three exempt routes'],
    ['/admin/passkey/credentials', 'a read on the same feature as three exempt routes'],
    // These two can. `/admin/auth/login-history` extends `/admin/auth/login`
    // and also starts with `/admin/auth`, so it is the single control that
    // notices `has` loosening to `startsWith` or `includes` AND the auth-probe
    // test loosening from an equality on `/admin/auth/me` to a prefix on
    // `/admin/auth`. Under any of those three this read is exempted and a dead
    // session survives its own 401.
    ['/admin/auth/login-history', 'a read that EXTENDS an exempt path'],
    ['/admin/2fa/disabled', 'a read whose path extends `/admin/2fa/disable`'],
  ]

  for (const [url, description] of sessionRoutes) {
    it(`ends the session on a 401 from ${url} (${description})`, async () => {
      const outcome = await fireAndObserve(url)
      expect(outcome.sessionDestroyed).toBe(true)
      expect(outcome.cachedQuerySurvived).toBe(false)
    })
  }
})
