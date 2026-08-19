/**
 * The second-factor step, driven from the wire.
 *
 * The companion to `test/admin-auth-totp.http.spec.ts` in the backend, and
 * written for the same reason. That defect survived because two correct halves
 * were tested separately and nobody tested the joint between them; the client
 * half of the same story is `sign-in-autofocus.test.tsx`, which reaches the
 * TOTP screen by mocking `./auth-api` to reject with a hand-written
 * `{ response: { data: { code: 'totp_required' } } }`. That mock IS the branch
 * it is exercising — it would keep passing if the backend stopped sending the
 * code, if the axios interceptor swallowed the error, or if `loginApi` reshaped
 * it. It pins autofocus, which is what it claims to pin, and nothing about the
 * pivot itself.
 *
 * So this file mocks nothing on the path. The real `api` axios instance, its
 * real 401 response interceptor, the real `loginApi`, and the real
 * `SignInPage` all run; only the transport underneath axios is replaced, and it
 * replies with the exact body the backend spec asserts leaves the server.
 *
 * It also holds the second interceptor invariant. A 401 from
 * `/admin/auth/login` is the login form's own answer — "wrong password", or the
 * pivot to the second factor — never an expired session, because there is no
 * session yet. Handing it to `forceEndAdminSession` runs `queryClient.clear()`
 * on the singleton client this very page's `auth-status` query lives in.
 *
 * Measured, not assumed: the redirect is skipped (the path already matches),
 * and nothing about the second-factor card changes at that instant, because
 * `setTotpRequired` re-renders `LoginForm` alone and `SignInPage` above it
 * keeps its resolved query result. The damage is stored, not spent — the
 * removed query is rebuilt as `pending` the moment anything re-renders
 * `SignInPage`, which swaps the whole form for the loading skeleton, unmounts
 * `LoginForm`, and takes `totpRequired` with it. The operator is then back at
 * an empty step one with nothing said. The last case here forces exactly that
 * re-render, and it is the assertion that fails without the route exclusion in
 * `lib/api.ts`.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

// Off the path under test: the OAuth strip issues its own request, and the auth
// context is only touched on the SUCCESS branch, which never runs here.
vi.mock('./oauth-buttons', () => ({ OAuthButtons: () => null }))
vi.mock('./auth-provider', () => ({ useAuth: () => ({ login: vi.fn() }) }))

import { api } from '@/lib/api'
import { queryClient } from '@/lib/query-client'
import { endAdminClientSession, isForceLogoutInProgress } from '@/lib/admin-session'
import SignInPage from './sign-in-page'

/**
 * Byte-for-byte the body `POST /api/admin/auth/login` returns when 2FA is on
 * and no code was supplied — see the assertions in
 * `test/admin-auth-totp.http.spec.ts`. Reproduced rather than imported because
 * the two suites run in different processes; the backend spec is what keeps it
 * honest, so change both or neither.
 */
const TOTP_REQUIRED_BODY = {
  timestamp: '2026-08-19T10:00:00.000Z',
  path: '/api/admin/auth/login',
  requestId: null,
  statusCode: 401,
  message: 'Two-factor authentication required',
  errorCode: 'totp_required',
  code: 'totp_required',
} as const

/** And the body a WRONG code produces: a plain 401, carrying no product code. */
const INVALID_CODE_BODY = {
  timestamp: '2026-08-19T10:00:05.000Z',
  path: '/api/admin/auth/login',
  requestId: null,
  statusCode: 401,
  message: 'Invalid verification code',
  errorCode: 'UNAUTHORIZED',
} as const

const loginRequests: Array<Record<string, unknown>> = []
let loginResponseBody: Record<string, unknown> = { ...TOTP_REQUIRED_BODY }
let originalAdapter: AxiosAdapter | undefined

/**
 * Stands in for the network, not for the client. Everything above it —
 * interceptors, `loginApi`, the page — is the real thing.
 */
const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
  const url = config.url ?? ''
  if (url.includes('/admin/auth/status')) {
    return {
      data: { hasAdmins: true, locales: ['ru'], defaultLocale: 'ru' },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    } as AxiosResponse
  }
  if (url.includes('/admin/auth/login')) {
    loginRequests.push(
      typeof config.data === 'string'
        ? (JSON.parse(config.data) as Record<string, unknown>)
        : {},
    )
    // Exactly how axios's own adapters report a non-2xx: a rejected
    // AxiosError carrying the parsed body on `.response.data`. Resolving here
    // instead would make the 401 look like a success and quietly skip the
    // interceptor this file exists to hold.
    const response = {
      data: loginResponseBody,
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
  throw new AxiosError(`unexpected request to ${url}`, AxiosError.ERR_BAD_REQUEST, config, {})
}

// The REAL singleton client — the one `forceEndAdminSession()` clears when
// called with no argument. A fresh QueryClient here would decouple the page
// from the interceptor and make the teardown invisible.
function buildPageTree() {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SignInPage />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

function renderPage() {
  return render(buildPageTree())
}

/** Fill both fields and submit, the way the sibling spec does. */
async function submitCredentials(): Promise<void> {
  const username = await screen.findByLabelText(/usernameLabel/i)
  const form = username.closest('form') as HTMLFormElement
  const password = form.querySelector('#password') as HTMLInputElement
  const set = (el: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  set(username as HTMLInputElement, 'operator')
  set(password, 'hunter2hunter2')
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}

beforeEach(() => {
  // The router mounts SignInPage at exactly one path, and `forceEndAdminSession`
  // reads `window.location.pathname` to decide whether to redirect. Left at
  // jsdom's default "/" the spec would exercise the redirect branch production
  // never takes here, and would be testing a different bug than the reported one.
  window.history.replaceState({}, '', '/sign-in')
  originalAdapter = api.defaults.adapter as AxiosAdapter | undefined
  api.defaults.adapter = adapter
  loginRequests.length = 0
  loginResponseBody = { ...TOTP_REQUIRED_BODY }
  // Resets both the shared cache and the `forceLogoutInProgress` latch, so no
  // test inherits a latch that would mask the teardown for the next one.
  endAdminClientSession(queryClient)
})

afterEach(() => {
  api.defaults.adapter = originalAdapter
  endAdminClientSession(queryClient)
  vi.clearAllMocks()
})

describe('sign-in second factor, end to end from the response body', () => {
  it('shows the code field when the login 401 carries code: "totp_required"', async () => {
    renderPage()
    await submitCredentials()

    // The whole defect, stated as the operator experiences it.
    const code = await screen.findByLabelText(/codeLabel/i, {}, { timeout: 3000 })
    expect(code).toBeInTheDocument()
    expect(code).toHaveAttribute('autocomplete', 'one-time-code')
    // …and step one is gone, rather than the two cards being stacked.
    expect(screen.queryByLabelText(/passwordLabel/i)).not.toBeInTheDocument()
  })

  it('keeps the page intact: a login 401 is not an expired session', async () => {
    const { rerender } = renderPage()
    // The page's own bootstrap query must be resolved before the submit, or
    // its absence afterwards would prove nothing.
    await screen.findByLabelText(/usernameLabel/i)
    await waitFor(() => expect(queryClient.getQueryData(['auth-status'])).toBeDefined())

    await submitCredentials()
    await screen.findByLabelText(/codeLabel/i, {}, { timeout: 3000 })

    expect(
      queryClient.getQueryData(['auth-status']),
      'the 401 interceptor cleared the query cache, which holds the sign-in ' +
        "page's own `auth-status` query",
    ).toBeDefined()
    expect(
      isForceLogoutInProgress(),
      'the sign-in 401 latched a forced logout — the page has no session to end',
    ).toBe(false)

    // Why the cleared cache is not merely untidy. `setTotpRequired` re-renders
    // LoginForm alone, so the damage stays invisible until anything re-renders
    // SignInPage above it — a locale switch, a theme toggle, StrictMode's
    // second pass in development. At that moment `useQuery` rebuilds the
    // removed query from scratch, reports `isLoading`, and SignInPage swaps the
    // whole form for its skeleton: LoginForm unmounts, `totpRequired` goes with
    // it, and the operator is returned to an empty step one with nothing said.
    //
    // A FRESH element, deliberately. Handing `rerender` the identical element
    // object makes React bail out of re-rendering the children entirely, and
    // the assertion below would then pass without the page re-rendering at all.
    rerender(buildPageTree())
    expect(
      screen.queryByLabelText(/codeLabel/i),
      'a re-render of the page threw the second-factor step away',
    ).toBeInTheDocument()
  })

  it('reports a rejected code against the code field instead of restarting the form', async () => {
    renderPage()
    await submitCredentials()
    await screen.findByLabelText(/codeLabel/i, {}, { timeout: 3000 })

    // Second step: the operator mistypes. The server answers with a plain 401
    // and no product code.
    loginResponseBody = { ...INVALID_CODE_BODY }
    const codeField = screen.getByLabelText(/codeLabel/i) as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(codeField, '000000')
    codeField.dispatchEvent(new Event('input', { bubbles: true }))
    const totpForm = codeField.closest('form') as HTMLFormElement
    totpForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    expect(await screen.findByText('signInPage.totp.invalidCode')).toBeInTheDocument()
    // Still on step two, with the typed code still there to correct.
    expect(screen.getByLabelText(/codeLabel/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/passwordLabel/i)).not.toBeInTheDocument()

    // And the credentials were re-sent with the code, not dropped: the second
    // step has no password field, so losing them strands the operator.
    await waitFor(() => expect(loginRequests).toHaveLength(2))
    expect(loginRequests[1]).toMatchObject({
      username: 'operator',
      password: 'hunter2hunter2',
      totpCode: '000000',
    })
  })
})
