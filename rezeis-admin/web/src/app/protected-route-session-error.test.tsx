/**
 * What the locked-workspace card tells an operator when the session probe
 * fails - driven through the real `AuthProvider`, the real axios instance and
 * the real dictionaries.
 *
 * The defect. `protected-route.tsx` rendered
 * `translateErrorMessage(t, sessionError.message)`, and both halves of that
 * were wrong:
 *
 *   1. `translateErrorMessage` looked the string up at the dictionary ROOT
 *      (`t(message)`). The panel's server-sentence copy lives under
 *      `errors.<sentence>`, so every lookup missed and handed its input back.
 *   2. `sessionError` is whatever `/admin/auth/me` or the permission probe
 *      threw, so `.message` was never a server sentence in the first place -
 *      it is axios transport prose. An operator outside the IP allowlist,
 *      whose 403 body says 'Access denied for your IP', was shown
 *      "Request failed with status code 403" instead: English on a Russian
 *      panel, and nothing they could act on.
 *
 * So the lookup could not have hit even at the right prefix - it was being fed
 * the wrong kind of string. The fix reads the sentence off the response body
 * and localizes THAT, through the one lookup the sign-in form also uses.
 *
 * Nothing on the path is mocked. `AuthProvider` runs, `getMeApi` and the
 * permission probe run, the 401 interceptor runs; only the transport
 * underneath axios is replaced.
 */
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import {
  AxiosError,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { en } from '@/i18n/en'
import { ru } from '@/i18n/ru'
import { useAuthStore } from '@/stores/auth-store'
import { usePermissionStore } from '@/features/rbac'
import { AuthProvider } from '@/features/auth/auth-provider'
import ProtectedRoute from './protected-route'

/**
 * Async-find window. Deliberately well above testing-library's 1 s default and
 * below the 15 s `testTimeout` vite.config.ts already sets: that timeout exists
 * because jsdom specs that finish in ~200 ms in isolation take seconds under
 * parallel worker contention, and a short window here turns that contention
 * into a red suite somebody else has to re-run. Measured on this tree: 200 ms
 * alone, and a run that took 17.9 s wall for thirteen files while other suites
 * were live.
 */
const FIND_TIMEOUT_MS = 10_000

/**
 * The 403 an operator outside the allowlist really gets, from
 * `modules/blocked-ips/guards/blocked-ip.guard.ts:102`, shaped by
 * `AdminSafeExceptionFilter`. The sentence trips none of the filter's
 * sensitive patterns, so it reaches the wire verbatim - and it has no
 * dictionary entry, which is exactly why the fallback below matters.
 */
const BLOCKED_IP_BODY = {
  timestamp: '2026-08-21T10:00:00.000Z',
  path: '/api/admin/auth/me',
  requestId: null,
  statusCode: 403,
  message: 'Access denied for your IP',
  errorCode: 'FORBIDDEN',
  error: 'Forbidden',
} as const

/**
 * A refusal whose sentence the dictionaries DO carry. Its live producer is the
 * change-password route rather than `/me`, so this case is here to pin the
 * lookup itself: at the old root prefix it missed silently, and the operator
 * read English even where the copy existed.
 */
const INACTIVE_BODY = {
  ...BLOCKED_IP_BODY,
  message: 'Admin user is inactive',
} as const

/** What the safe filter puts on the wire for an unhandled 500. */
const INTERNAL_ERROR_BODY = {
  timestamp: '2026-08-21T10:00:00.000Z',
  path: '/api/admin/auth/permissions',
  requestId: null,
  statusCode: 500,
  message: 'Internal server error',
  errorCode: 'INTERNAL_SERVER_ERROR',
  error: 'Internal Server Error',
} as const

/** The axios prose the card used to print, in every locale. */
const AXIOS_403_MESSAGE = 'Request failed with status code 403'
const AXIOS_500_MESSAGE = 'Request failed with status code 500'

const ADMIN = {
  id: 'admin-1',
  login: 'operator',
  email: null,
  name: null,
  role: 'ADMIN' as const,
  isActive: true,
  createdAt: '2026-06-04T00:00:00.000Z',
  lastLoginAt: null,
  lastLoginIp: null,
}

type Reply =
  | { readonly kind: 'status'; readonly status: number; readonly body: Record<string, unknown> }
  | { readonly kind: 'network' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'ok'; readonly data: unknown }

let meReply: Reply = { kind: 'status', status: 403, body: { ...BLOCKED_IP_BODY } }
let permissionsReply: Reply = { kind: 'ok', data: { role: 'ADMIN', permissions: [] } }

function ok(config: InternalAxiosRequestConfig, data: unknown): AxiosResponse {
  return { data, status: 200, statusText: 'OK', headers: {}, config } as AxiosResponse
}

function reject(config: InternalAxiosRequestConfig, reply: Reply): never {
  if (reply.kind === 'network') {
    // How axios reports a refused connection: no `response` at all, and a
    // message that is transport jargon in every locale.
    throw new AxiosError('Network Error', AxiosError.ERR_NETWORK, config, {})
  }
  if (reply.kind === 'timeout') {
    // And how it reports a request the host accepted but never answered. The
    // code is the only thing separating the two; the message is jargon either
    // way. ECONNABORTED is the default spelling, ETIMEDOUT the one axios uses
    // with `transitional.clarifyTimeoutError`.
    throw new AxiosError(
      'timeout of 30000ms exceeded',
      AxiosError.ECONNABORTED,
      config,
      {},
    )
  }
  if (reply.kind === 'ok') throw new Error('not a rejection')
  const response = {
    data: reply.body,
    status: reply.status,
    statusText: 'Error',
    headers: {},
    config,
  } as AxiosResponse
  throw new AxiosError(
    'Request failed with status code ' + String(reply.status),
    AxiosError.ERR_BAD_REQUEST,
    config,
    {},
    response,
  )
}

/** Stands in for the network, and for nothing above it. */
const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
  const url = config.url ?? ''
  // The client-error reporter is best-effort and off the path under test.
  if (url.includes('/admin/client-errors')) return ok(config, {})
  if (url.includes('/admin/auth/me')) {
    if (meReply.kind === 'ok') return ok(config, { admin: meReply.data })
    reject(config, meReply)
  }
  if (url.includes('/admin/auth/permissions')) {
    if (permissionsReply.kind === 'ok') return ok(config, permissionsReply.data)
    reject(config, permissionsReply)
  }
  throw new AxiosError('unexpected request to ' + url, AxiosError.ERR_BAD_REQUEST, config, {})
}

function buildI18n(lng: 'en' | 'ru'): I18nInstance {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng,
    fallbackLng: 'en',
    resources: { en: { translation: en }, ru: { translation: ru } },
    interpolation: { escapeValue: false },
  })
  return instance
}

function renderGate(lng: 'en' | 'ru' = 'ru') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <I18nextProvider i18n={buildI18n(lng)}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/']}>
          <AuthProvider>
            <Routes>
              <Route element={<ProtectedRoute />}>
                <Route path="/" element={<p>workspace</p>} />
              </Route>
              <Route path="/sign-in" element={<p>sign in</p>} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  )
}

let originalAdapter: AxiosAdapter | undefined

beforeEach(() => {
  originalAdapter = api.defaults.adapter as AxiosAdapter | undefined
  api.defaults.adapter = adapter
  meReply = { kind: 'status', status: 403, body: { ...BLOCKED_IP_BODY } }
  permissionsReply = { kind: 'ok', data: { role: 'ADMIN', permissions: [] } }
  // The card is only reachable with a token in hand; without one the gate
  // redirects to /sign-in and none of this renders.
  useAuthStore.setState({ token: 'a-live-admin-token' })
  usePermissionStore.getState().reset()
})

afterEach(() => {
  api.defaults.adapter = originalAdapter
  useAuthStore.setState({ token: '' })
  usePermissionStore.getState().reset()
  vi.clearAllMocks()
})

describe('the locked-workspace card names the reason the session probe failed', () => {
  it('shows the response body sentence, not the axios status prose', async () => {
    // The realistic case: a valid token, an address outside the allowlist.
    // "Request failed with status code 403" told the operator nothing; the
    // body underneath it named the problem all along.
    renderGate('ru')

    expect(
      await screen.findByText(BLOCKED_IP_BODY.message, {}, { timeout: FIND_TIMEOUT_MS }),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(AXIOS_403_MESSAGE),
      'the card is still printing the axios message instead of the response body',
    ).not.toBeInTheDocument()
    // ...and this is the locked card, not a redirect and not the workspace.
    expect(screen.getByText(ru.auth.sessionCheckFailedTitle)).toBeInTheDocument()
    expect(screen.queryByText('workspace')).not.toBeInTheDocument()
    // The control for the transport copy below: a server that ANSWERED must
    // never be reported as one that could not be reached. Without this, a
    // routing bug that sent every failure to the transport string would still
    // pass the two cases that assert it.
    expect(document.body.textContent ?? '').not.toContain(ru.errors.serverUnreachable)
  })

  it('localizes a sentence the dictionaries do carry', async () => {
    // The lookup, pinned. At the dictionary ROOT this key does not exist, so
    // the miss was silent and a Russian operator read English.
    meReply = { kind: 'status', status: 403, body: { ...INACTIVE_BODY } }
    const localized = ru.errors['Admin user is inactive']
    expect(localized).not.toBe(INACTIVE_BODY.message)

    renderGate('ru')

    expect(await screen.findByText(localized, {}, { timeout: FIND_TIMEOUT_MS })).toBeInTheDocument()
    expect(screen.queryByText(INACTIVE_BODY.message)).not.toBeInTheDocument()
  })

  it('never leaves a raw i18n key on screen for a sentence with no entry', async () => {
    // The failure mode a prefixed lookup invites. i18next answers an
    // unresolved key by echoing it back, so a missing entry would render as
    // "errors.Access denied for your IP" - worse than the English it replaced.
    renderGate('ru')

    await screen.findByText(BLOCKED_IP_BODY.message, {}, { timeout: FIND_TIMEOUT_MS })
    expect(document.body.textContent ?? '').not.toContain('errors.')
  })

  it('reads the body of the PERMISSION probe too, not just /me', async () => {
    // `sessionError` has two producers. The permission probe is the second,
    // and it reaches the same card by a different route: `/me` succeeds, the
    // catalogue does not, and the workspace stays locked so a forced
    // password-change admin cannot briefly render the shell.
    meReply = { kind: 'ok', data: ADMIN }
    permissionsReply = { kind: 'status', status: 500, body: { ...INTERNAL_ERROR_BODY } }

    renderGate('ru')

    expect(
      await screen.findByText(INTERNAL_ERROR_BODY.message, {}, { timeout: FIND_TIMEOUT_MS }),
    ).toBeInTheDocument()
    expect(screen.queryByText(AXIOS_500_MESSAGE)).not.toBeInTheDocument()
    expect(screen.queryByText('workspace')).not.toBeInTheDocument()
  })

  it('says the server could not be reached, in the operator\u2019s language', async () => {
    // No response at all. The old card printed axios's "Network Error" here -
    // English on every panel, and jargon on all of them. The generic
    // "Request failed" that briefly replaced it was worse in a different way:
    // it read as a refusal, and sent the operator to look at permissions
    // instead of at the backend and its proxy.
    meReply = { kind: 'network' }

    renderGate('ru')

    expect(
      await screen.findByText(ru.errors.serverUnreachable, {}, { timeout: FIND_TIMEOUT_MS }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Network Error')).not.toBeInTheDocument()
    expect(screen.queryByText(ru.errors.requestFailed)).not.toBeInTheDocument()
  })

  it('tells a timeout apart from a dead host', async () => {
    // The host accepted the socket and never answered the request. What the
    // operator checks next is different - load, or an upstream timeout shorter
    // than the work - so the two must not collapse into one sentence.
    meReply = { kind: 'timeout' }

    renderGate('ru')

    expect(
      await screen.findByText(ru.errors.serverTimeout, {}, { timeout: FIND_TIMEOUT_MS }),
    ).toBeInTheDocument()
    expect(screen.queryByText(ru.errors.serverUnreachable)).not.toBeInTheDocument()
    expect(screen.queryByText('timeout of 30000ms exceeded')).not.toBeInTheDocument()
  })

  it('shows the English copy on an English panel', async () => {
    // The same copy, proving the card renders dictionary strings rather than
    // one hardcoded sentence that merely happens to match a language.
    meReply = { kind: 'network' }

    renderGate('en')

    expect(
      await screen.findByText(en.errors.serverUnreachable, {}, { timeout: FIND_TIMEOUT_MS }),
    ).toBeInTheDocument()
  })

  it('keeps the generic for a server that answered with nothing readable', async () => {
    // A proxy's HTML error page, or an empty body. The request DID reach a
    // server, so reporting it as unreachable would point the operator at the
    // wrong layer entirely.
    meReply = { kind: 'status', status: 502, body: {} }

    renderGate('ru')

    expect(
      await screen.findByText(ru.errors.requestFailed, {}, { timeout: FIND_TIMEOUT_MS }),
    ).toBeInTheDocument()
    expect(screen.queryByText(ru.errors.serverUnreachable)).not.toBeInTheDocument()
  })

  it('does not empty a Zod issue dump into the card', async () => {
    // `getMeApi` parses the profile with `authUserSchema`, so a backend that
    // reshapes that payload rejects with a ZodError - an `Error` whose
    // `.message` is the pretty-printed JSON of every issue it found. Rendering
    // `.message` puts that blob in the destructive-red slot.
    meReply = { kind: 'ok', data: { id: 'admin-1' } }

    renderGate('ru')

    expect(
      await screen.findByText(ru.errors.requestFailed, {}, { timeout: FIND_TIMEOUT_MS }),
    ).toBeInTheDocument()
    const rendered = document.body.textContent ?? ''
    expect(rendered).not.toContain('invalid_type')
    expect(rendered).not.toContain('"path"')
  })
})
