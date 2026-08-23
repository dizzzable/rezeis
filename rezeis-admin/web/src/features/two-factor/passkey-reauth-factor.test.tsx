/**
 * The enrolment dialog asks for the factor the SERVER named, not the one it
 * guessed.
 *
 * Enrolling a passkey demands a fresh credential, and which one is decided by
 * the account: a TOTP or recovery code when 2FA is on, the current password
 * when it is not. The server picks it deliberately — a hijacked session must
 * not be able to nominate the weaker factor — and the dialog only mirrors that
 * choice, from a cached `admin-2fa-status` query with a ten-second staleTime.
 *
 * A mirror can be out of date, and this refusal is what arrives when it is.
 * The operator turned 2FA on in another tab (or on the card directly above);
 * this section still believes it is off, so it prompts for a password and
 * posts `{ password }`. The server reads `reauth.code`, finds it empty, and
 * answers 401 `passkey_reauth_required` naming `factor: 'totp'`. If the dialog
 * ignores that, it re-renders the password field, the operator retypes the
 * same correct password, and the enrolment can never succeed — a dead end with
 * no way out of it from the UI.
 *
 * Two things are therefore asserted here, and neither is about a return value:
 *
 *   1. The rendered prompt flips to the code field. That is the whole fix as
 *      the operator experiences it.
 *   2. The session survives. A 401 is also what an expired token looks like,
 *      and `forceEndAdminSession` runs `queryClient.clear()` — so getting this
 *      wrong does not degrade the feature, it signs the operator out for
 *      opening the dialog.
 *
 * The 401 bodies below are the filter's output shape, not the service's throw:
 * `AdminSafeExceptionFilter` rebuilds every error body, and `code`/`factor`
 * survive it only because both are allowlisted. The backend spec
 * (`test/passkey-hardening.spec.ts`) pins that exact key set against the real
 * filter; this file starts where that one ends.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import {
  AxiosError,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() },
}))

import { api } from '@/lib/api'
import { queryClient } from '@/lib/query-client'
import { endAdminClientSession, isForceLogoutInProgress } from '@/lib/admin-session'
import { authStorage } from '@/lib/auth-storage'
import TwoFactorPage from './two-factor-page'

// ── The wire ────────────────────────────────────────────────────────────────

const CODE_LABEL = 'twoFactorPage.passkey.registerDialog.codeLabel'
const PASSWORD_LABEL = 'twoFactorPage.passkey.registerDialog.passwordLabel'

/** A body shaped exactly as `AdminSafeExceptionFilter` writes it. */
function reauthRequiredBody(
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    timestamp: '2026-08-21T09:00:00.000Z',
    path: '/api/admin/passkey/register/options',
    requestId: null,
    statusCode: 401,
    message: 'Confirm it is you before adding a passkey',
    ...extra,
  }
}

/** What the operator got before the code and factor were allowlisted. */
const BARE_401 = reauthRequiredBody({ errorCode: 'UNAUTHORIZED', error: 'Unauthorized' })

/** What they get now. */
const TYPED_401 = reauthRequiredBody({
  errorCode: 'passkey_reauth_required',
  code: 'passkey_reauth_required',
  factor: 'totp',
})

let registerOptionsBody: Record<string, unknown> = TYPED_401
const requestedPaths: string[] = []

function ok(config: InternalAxiosRequestConfig, data: unknown): AxiosResponse {
  return { data, status: 200, statusText: 'OK', headers: {}, config } as AxiosResponse
}

/**
 * Answers the page's reads, and 401s the enrolment. Only the transport is
 * replaced — the real `api` instance and its real response interceptor run, so
 * the session teardown this file checks for is the production one.
 */
const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
  const url = config.url ?? ''
  requestedPaths.push(url)

  if (url.includes('/admin/passkey/register/options')) {
    const response = {
      data: registerOptionsBody,
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

  // The stale mirror: this account HAS 2FA on, but the panel last heard
  // otherwise, which is the only state from which the refusal is reachable.
  if (url.includes('/admin/2fa/status')) {
    return ok(config, { enabled: false, enrolledAt: null, recoveryCodesRemaining: 0 })
  }
  if (url.includes('/admin/passkey/credentials')) return ok(config, [])
  if (url.includes('/admin/ip-allowlist')) return ok(config, { items: [], total: 0 })
  return ok(config, {})
}

let originalAdapter: AxiosAdapter | undefined

beforeEach(() => {
  registerOptionsBody = TYPED_401
  requestedPaths.length = 0
  originalAdapter = api.defaults.adapter as AxiosAdapter | undefined
  api.defaults.adapter = adapter
  // WebAuthn support is what gates the Register button into the DOM. The
  // ceremony is never reached here — the server refuses before options exist.
  Object.defineProperty(window.navigator, 'credentials', {
    value: { create: vi.fn(), get: vi.fn() },
    configurable: true,
  })
  endAdminClientSession(queryClient)
  window.localStorage.clear()
  authStorage.setToken('a-live-session-token')
})

afterEach(() => {
  api.defaults.adapter = originalAdapter
  endAdminClientSession(queryClient)
  window.localStorage.clear()
  vi.clearAllMocks()
})

function renderPage(): void {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <TwoFactorPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** Opens the enrol dialog, fills the factor field, and submits. */
async function attemptEnrolment(): Promise<void> {
  const open = await screen.findByText('twoFactorPage.passkey.register')
  open.closest('button')?.click()
  const field = await screen.findByLabelText(/registerDialog\.(codeLabel|passwordLabel)/)
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set
  setter?.call(field, 'the-current-password')
  field.dispatchEvent(new Event('input', { bubbles: true }))
  const confirm = await screen.findByText('twoFactorPage.passkey.registerDialog.confirm')
  await waitFor(() => {
    expect(confirm.closest('button')?.disabled).toBe(false)
  })
  confirm.closest('button')?.click()
}

describe('the passkey enrolment dialog follows the factor the server named', () => {
  it('prompts for the password first, because that is what the cached status says', async () => {
    renderPage()
    const open = await screen.findByText('twoFactorPage.passkey.register')
    open.closest('button')?.click()

    expect(await screen.findByText(PASSWORD_LABEL)).toBeTruthy()
    expect(screen.queryByText(CODE_LABEL)).toBeNull()
  })

  it('switches to the code field when the 401 says the account wants a code', async () => {
    renderPage()
    await attemptEnrolment()

    // The prompt the operator now sees. Without `factor` on the wire there is
    // nothing here that could know to change it.
    expect(await screen.findByText(CODE_LABEL)).toBeTruthy()
    expect(screen.queryByText(PASSWORD_LABEL)).toBeNull()
  })

  it('clears the credential typed into the wrong field rather than resubmitting it', async () => {
    renderPage()
    await attemptEnrolment()
    await screen.findByText(CODE_LABEL)

    // A password left sitting in a field now labelled "2FA code" is both a
    // credential lingering in component state and a value that cannot work.
    const field = screen.getByLabelText(CODE_LABEL) as HTMLInputElement
    expect(field.value).toBe('')
  })

  it('re-reads the 2FA status it got wrong, so the next attempt starts correct', async () => {
    renderPage()
    await attemptEnrolment()
    await screen.findByText(CODE_LABEL)

    await waitFor(() => {
      const statusReads = requestedPaths.filter((path) => path.includes('/admin/2fa/status'))
      expect(statusReads.length).toBeGreaterThan(1)
    })
  })

  it('does not end the session — this 401 is a prompt, not an expired token', async () => {
    renderPage()
    await attemptEnrolment()
    await screen.findByText(CODE_LABEL)

    expect(isForceLogoutInProgress()).toBe(false)
    expect(authStorage.getToken()).toBe('a-live-session-token')
  })

  it('leaves the prompt alone for a 401 that carries no factor', async () => {
    // The control, and the one that keeps the rest honest: this is the body
    // the filter produced before the allowlist entry existed. Every assertion
    // above must be reading `code`/`factor` off the response — if the dialog
    // flipped on "any 401 from this endpoint" instead, a genuinely expired
    // session would silently repaint the prompt and hide what happened.
    registerOptionsBody = BARE_401
    renderPage()
    await attemptEnrolment()

    await waitFor(() => {
      expect(requestedPaths.some((p) => p.includes('/admin/passkey/register/options'))).toBe(true)
    })
    expect(screen.queryByText(CODE_LABEL)).toBeNull()
    expect(screen.getByText(PASSWORD_LABEL)).toBeTruthy()
  })
})
