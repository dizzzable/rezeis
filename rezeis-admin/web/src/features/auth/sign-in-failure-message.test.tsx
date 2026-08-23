/**
 * What the sign-in card actually prints when a sign-in is refused.
 *
 * The defect: `AdminSafeExceptionFilter` scrubbed its own product copy. Its
 * sensitive-text patterns include a vocabulary list with "password" in it, and
 * the backend's refusal is the sentence 'Invalid login or password' — so the
 * message on the wire was the literal string "Request failed", and this form
 * renders `response.data.message`. An operator who mistyped their password was
 * told the request had failed.
 *
 * Two things had to be true for the operator to be told the truth, and this
 * file drives both through the same render:
 *
 *   1. the sentence has to survive the filter (held on the server side by
 *      `test/safe-exception-product-messages.spec.ts`), and
 *   2. the form has to turn it into copy in the operator's language.
 *
 * The second half is why this file uses the REAL dictionaries rather than the
 * `t: (key) => key` stub its two sibling specs use. Both `en.ts` and `ru.ts`
 * have carried `errors['Invalid login or password']` since they were written
 * and nothing ever read it: the form rendered the server's English straight to
 * screen. A stubbed `t` cannot see that, because under a stub every outcome
 * looks like a key. So the assertions below are on the rendered sentence, in
 * both languages, taken from the dictionaries themselves — a deleted entry
 * fails the test, a re-translated one does not.
 *
 * Nothing on the request path is mocked. The real `api` axios instance, its
 * real 401 interceptor, the real `loginApi` and the real `SignInPage` all run;
 * only the transport underneath axios is replaced, and it answers with the
 * bodies the backend spec asserts leave the server.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import {
  AxiosError,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Off the path under test: the OAuth strip issues a request of its own, and
// the auth context is touched only on the SUCCESS branch, which never runs.
vi.mock('./oauth-buttons', () => ({ OAuthButtons: () => null }))
vi.mock('./auth-provider', () => ({ useAuth: () => ({ login: vi.fn() }) }))

import { api } from '@/lib/api'
import { en } from '@/i18n/en'
import { ru } from '@/i18n/ru'
import SignInPage from './sign-in-page'

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
 * The body `POST /api/admin/auth/login` returns for a wrong password AND for a
 * login that does not exist — one sentence for both, so the response cannot be
 * used to confirm that an account exists. Held on the wire by
 * `test/safe-exception-product-messages.spec.ts`; reproduced here rather than
 * imported because the two suites run in different processes.
 */
const INVALID_CREDENTIALS_BODY = {
  timestamp: '2026-08-21T10:00:00.000Z',
  path: '/api/admin/auth/login',
  requestId: null,
  statusCode: 401,
  message: 'Invalid login or password',
  errorCode: 'UNAUTHORIZED',
  error: 'Unauthorized',
} as const

/** The same response as it was BEFORE the filter stopped scrubbing itself. */
const SCRUBBED_BODY = { ...INVALID_CREDENTIALS_BODY, message: 'Request failed' } as const

/** A deactivated admin: a different status, and a sentence of its own. */
const INACTIVE_BODY = {
  ...INVALID_CREDENTIALS_BODY,
  statusCode: 403,
  message: 'Admin user is inactive',
  errorCode: 'FORBIDDEN',
  error: 'Forbidden',
} as const

/**
 * The fail2ban refusal. Deliberately has NO dictionary entry: it is the case
 * that proves an unknown sentence keeps the server's own words instead of
 * being flattened into "invalid login or password", which would send the
 * operator off to retype credentials that were never the problem.
 */
const RATE_LIMITED_BODY = {
  ...INVALID_CREDENTIALS_BODY,
  message: 'Too many login attempts. Try again later.',
} as const

let responseBody: Record<string, unknown> = { ...INVALID_CREDENTIALS_BODY }
let responseStatus = 401
let originalAdapter: AxiosAdapter | undefined

/** Stands in for the network, and for nothing above it. */
const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
  const url = config.url ?? ''
  if (url.includes('/admin/auth/status')) {
    return {
      data: { hasAdmins: true },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    } as AxiosResponse
  }
  if (url.includes('/admin/auth/login')) {
    const response = {
      data: responseBody,
      status: responseStatus,
      statusText: 'Error',
      headers: {},
      config,
    } as AxiosResponse
    // Exactly how axios's own adapters report a non-2xx. Resolving here would
    // make the refusal look like a success and skip the interceptor entirely.
    throw new AxiosError(
      `Request failed with status code ${responseStatus}`,
      AxiosError.ERR_BAD_REQUEST,
      config,
      {},
      response,
    )
  }
  throw new AxiosError(`unexpected request to ${url}`, AxiosError.ERR_BAD_REQUEST, config, {})
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

function renderPage(lng: 'en' | 'ru' = 'en') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <I18nextProvider i18n={buildI18n(lng)}>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SignInPage />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  )
}

/**
 * Fill both fields and submit. Located by element id rather than by label,
 * because the labels are themselves translated and this file renders the card
 * in two languages.
 */
async function submitCredentials(): Promise<void> {
  const username = await waitFor(() => {
    const field = document.querySelector<HTMLInputElement>('#username')
    if (!field) throw new Error('the sign-in form has not rendered yet')
    return field
  })
  const form = username.closest('form') as HTMLFormElement
  const password = form.querySelector('#password') as HTMLInputElement
  const set = (el: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  set(username, 'operator')
  set(password, 'hunter2hunter2')
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}

beforeEach(() => {
  window.history.replaceState({}, '', '/sign-in')
  originalAdapter = api.defaults.adapter as AxiosAdapter | undefined
  api.defaults.adapter = adapter
  responseBody = { ...INVALID_CREDENTIALS_BODY }
  responseStatus = 401
})

afterEach(() => {
  api.defaults.adapter = originalAdapter
  vi.clearAllMocks()
})

describe('the sign-in card states why the sign-in was refused', () => {
  it('says the login or password was wrong, in English', async () => {
    renderPage('en')
    await submitCredentials()

    expect(
      await screen.findByText(en.errors['Invalid login or password'], {}, { timeout: FIND_TIMEOUT_MS }),
    ).toBeInTheDocument()
    // The defect, named: this is the string the operator used to get instead.
    expect(screen.queryByText('Request failed')).not.toBeInTheDocument()
    // …and the form stayed on step one, with the fields still there to fix.
    expect(document.querySelector('#password')).not.toBeNull()
    expect(document.querySelector('#totp')).toBeNull()
  })

  it('says it in Russian on a Russian panel', async () => {
    // The second half of the defect. Both dictionaries have carried this copy
    // from the start and nothing looked it up, so even once the filter stopped
    // scrubbing the sentence the panel answered a Russian operator in English.
    const localized = ru.errors['Invalid login or password']
    expect(localized).not.toBe(INVALID_CREDENTIALS_BODY.message)

    renderPage('ru')
    await submitCredentials()

    expect(await screen.findByText(localized, {}, { timeout: FIND_TIMEOUT_MS })).toBeInTheDocument()
    expect(
      screen.queryByText(INVALID_CREDENTIALS_BODY.message),
      'the server’s English reached a Russian operator',
    ).not.toBeInTheDocument()
  })

  it('says a deactivated account is deactivated, in Russian', async () => {
    responseBody = { ...INACTIVE_BODY }
    responseStatus = 403
    const localized = ru.errors['Admin user is inactive']

    renderPage('ru')
    await submitCredentials()

    expect(await screen.findByText(localized, {}, { timeout: FIND_TIMEOUT_MS })).toBeInTheDocument()
  })

  it('keeps the server’s own words when the dictionaries have none', async () => {
    // Rate-limited, not wrong-password. Collapsing this into the generic
    // "invalid login or password" would tell the operator to retype
    // credentials that were never the problem, and hide the wait.
    responseBody = { ...RATE_LIMITED_BODY }

    renderPage('en')
    await submitCredentials()

    expect(
      await screen.findByText(RATE_LIMITED_BODY.message, {}, { timeout: FIND_TIMEOUT_MS }),
    ).toBeInTheDocument()
    expect(screen.queryByText(en.signInPage.login.genericError)).not.toBeInTheDocument()
  })

  it('falls back to the generic refusal only when the response says nothing', async () => {
    // A gateway or proxy failure with no body of its own: there is no reason
    // to report, so the form says the one thing it knows.
    responseBody = {}
    responseStatus = 502

    renderPage('en')
    await submitCredentials()

    expect(
      await screen.findByText(en.signInPage.login.genericError, {}, { timeout: FIND_TIMEOUT_MS }),
    ).toBeInTheDocument()
  })

  it('renders a validation array as separated sentences, not run together', async () => {
    // The filter emits `message: string[]` for validation failures. Handed to
    // React as an array they are concatenated with no separator at all
    // ("ab"), which is how a two-item list used to reach the operator.
    responseBody = {
      ...INVALID_CREDENTIALS_BODY,
      statusCode: 400,
      message: ['username should not be empty', 'password should not be empty'],
    }
    responseStatus = 400

    renderPage('en')
    await submitCredentials()

    expect(
      await screen.findByText(
        'username should not be empty password should not be empty',
        {},
        { timeout: FIND_TIMEOUT_MS },
      ),
    ).toBeInTheDocument()
  })

  it('still shows the scrubbed sentence if the server ever sends one', async () => {
    // The form is not allowed to invent a reason. If the backend regresses and
    // scrubs its own copy again, the operator sees the scrubbed string — which
    // is what makes the server-side spec the load-bearing half of this fix,
    // not this file.
    responseBody = { ...SCRUBBED_BODY }

    renderPage('en')
    await submitCredentials()

    expect(await screen.findByText('Request failed', {}, { timeout: FIND_TIMEOUT_MS })).toBeInTheDocument()
  })
})
