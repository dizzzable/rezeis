/**
 * What the sign-in card tells an operator when the backend never answered at
 * all - as opposed to when it answered and refused them.
 *
 * The defect. `sign-in-page.tsx` read the reason off `response.data.message`
 * and, finding none, fell back to `signInPage.login.genericError` - "sign-in
 * failed". A dead backend has no `response` at all, so every transport failure
 * landed on that generic, and "sign-in failed" is a sentence an operator can
 * only act on one way: by retyping a password that was never wrong. On the
 * second step it was worse. A rejected code and an unreachable host both read
 * as `signInPage.totp.invalidCode`, so the operator waits for the authenticator
 * to roll and types a fresh code, which fails exactly as often, for as long as
 * the backend stays down.
 *
 * "Cannot reach the server" and "the server refused you" send the operator to
 * different places - the backend and its reverse proxy, versus their own
 * credentials - and that is the whole reason the distinction is worth a
 * dictionary entry. The same two keys and the same lookup
 * (`translateTransportFailure`) serve the locked-workspace card in
 * `app/protected-route-session-error.test.tsx`; one sentence has one
 * translation path.
 *
 * ORDER is the safety property this file guards, not just presence. The body
 * is read first, so a refusal that named a reason keeps saying it; the
 * transport rung fires only when there was no response at all. A 502 that DID
 * answer, with an empty body, must still take the generic - reporting it as an
 * unreachable host points the operator at the wrong layer entirely.
 *
 * Nothing on the path is mocked. The real axios instance, its real 401
 * interceptor, the real `loginApi` and the real `SignInPage` all run against
 * the real dictionaries; only the transport underneath axios is replaced.
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
import { queryClient } from '@/lib/query-client'
import { endAdminClientSession } from '@/lib/admin-session'
import { en } from '@/i18n/en'
import { ru } from '@/i18n/ru'
import SignInPage from './sign-in-page'

/**
 * Async-find window. Deliberately well above testing-library's 1 s default and
 * below the 15 s `testTimeout` vite.config.ts already sets, for the same reason
 * the two sibling specs say so: jsdom specs that finish in ~200 ms alone take
 * seconds under parallel worker contention, and a short window turns that
 * contention into a red suite somebody else has to re-run.
 */
const FIND_TIMEOUT_MS = 10_000

/**
 * The body `POST /api/admin/auth/login` returns for a wrong password AND for a
 * login that does not exist - one sentence for both, so the response cannot be
 * used to confirm an account exists. Held on the wire by
 * `test/safe-exception-product-messages.spec.ts`.
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

/** The pivot to the second factor, as the backend spec asserts it leaves. */
const TOTP_REQUIRED_BODY = {
  ...INVALID_CREDENTIALS_BODY,
  message: 'Two-factor authentication required',
  errorCode: 'totp_required',
  code: 'totp_required',
} as const

/** And the body a WRONG code produces: a plain 401, carrying no product code. */
const INVALID_CODE_BODY = {
  ...INVALID_CREDENTIALS_BODY,
  message: 'Invalid verification code',
} as const

type Reply =
  | { readonly kind: 'status'; readonly status: number; readonly body: Record<string, unknown> }
  | { readonly kind: 'network' }
  | { readonly kind: 'timeout' }

let loginReply: Reply = { kind: 'network' }
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
    if (loginReply.kind === 'network') {
      // How axios reports a host that is not there: no `response` at all, and
      // a `.message` that is English jargon in every locale.
      throw new AxiosError('Network Error', AxiosError.ERR_NETWORK, config, {})
    }
    if (loginReply.kind === 'timeout') {
      // And a host that accepted the socket and never answered the request.
      // The `code` is the only thing separating the two.
      throw new AxiosError('timeout of 30000ms exceeded', AxiosError.ECONNABORTED, config, {})
    }
    const response = {
      data: loginReply.body,
      status: loginReply.status,
      statusText: 'Error',
      headers: {},
      config,
    } as AxiosResponse
    // Exactly how axios's own adapters report a non-2xx. Resolving here would
    // make the refusal look like a success and skip the interceptor entirely.
    throw new AxiosError(
      `Request failed with status code ${String(loginReply.status)}`,
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
 * The card's one mutation-error slot, on either step. Selected by class rather
 * than by text, which is the point: every assertion below reads WHICH sentence
 * landed here, instead of asking whether one particular sentence is present.
 *
 * `text-sm` rather than `text-xs` distinguishes it from the per-field
 * validation messages react-hook-form renders in the same colour.
 */
function errorSlotText(): string {
  const slot = document.querySelector('p.text-sm.text-destructive')
  return slot?.textContent?.trim() ?? ''
}

/**
 * Wait until the card has reported SOMETHING, then hand back what it said.
 *
 * Waiting for one expected sentence instead would make every assertion that
 * follows unreachable in exactly the mutant it exists to catch: the find would
 * time out first and the interesting comparison would never run. This is the
 * shape that keeps the anti-vacuity controls below load-bearing.
 */
async function whatTheCardSaid(): Promise<string> {
  return waitFor(
    () => {
      const text = errorSlotText()
      if (!text) throw new Error('the sign-in card has not reported a failure yet')
      return text
    },
    { timeout: FIND_TIMEOUT_MS },
  )
}

/** Fill both fields and submit. Located by id: the labels are translated. */
async function submitCredentials(): Promise<void> {
  const username = await waitFor(() => {
    const field = document.querySelector<HTMLInputElement>('#username')
    if (!field) throw new Error('the sign-in form has not rendered yet')
    return field
  })
  const form = username.closest('form') as HTMLFormElement
  const password = form.querySelector('#password') as HTMLInputElement
  setValue(username, 'operator')
  setValue(password, 'hunter2hunter2')
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}

/**
 * Wait for the pivot to the second step.
 *
 * Kept separate from the submit below because the ORDER matters to the
 * harness: `submitCredentials` only dispatches the event, and
 * react-hook-form validates asynchronously, so the login request has not
 * left yet when it returns. Reassigning `loginReply` before this resolves
 * hands the FIRST request the second reply, and the pivot never happens -
 * which is the shape of a harness bug that reads as a product bug.
 */
async function waitForTotpStep(): Promise<HTMLInputElement> {
  return waitFor(
    () => {
      const el = document.querySelector<HTMLInputElement>('#totp')
      if (!el) throw new Error('the second-factor step has not rendered yet')
      return el
    },
    { timeout: FIND_TIMEOUT_MS },
  )
}

/** Submit a code against the second step, which must already be showing. */
function submitTotpCode(field: HTMLInputElement, code: string): void {
  setValue(field, code)
  const form = field.closest('form') as HTMLFormElement
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}

function setValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  // `forceEndAdminSession` reads `window.location.pathname` to decide whether
  // to redirect; left at jsdom's default "/" this would exercise a branch the
  // router never takes for this page.
  window.history.replaceState({}, '', '/sign-in')
  originalAdapter = api.defaults.adapter as AxiosAdapter | undefined
  api.defaults.adapter = adapter
  loginReply = { kind: 'network' }
  // Resets the shared cache and the `forceLogoutInProgress` latch, so no test
  // inherits a latch that would mask the next one's teardown.
  endAdminClientSession(queryClient)
})

afterEach(() => {
  api.defaults.adapter = originalAdapter
  endAdminClientSession(queryClient)
  vi.clearAllMocks()
})

describe('the sign-in card separates an unreachable backend from a refusal', () => {
  it('says the server could not be reached instead of "sign-in failed"', async () => {
    // The whole defect, as the operator meets it: the panel will not let them
    // in and tells them only that it did not work, so the one action available
    // is to retype a password that was never the problem.
    loginReply = { kind: 'network' }

    renderPage('en')
    await submitCredentials()

    expect(await whatTheCardSaid()).toBe(en.errors.serverUnreachable)
    // The two sentences it must NOT be: the generic that misdirects, and
    // axios's own English jargon that the card never showed here anyway.
    expect(document.body.textContent ?? '').not.toContain(en.signInPage.login.genericError)
    expect(screen.queryByText('Network Error')).not.toBeInTheDocument()
  })

  it('tells a timeout apart from a dead host', async () => {
    // The host accepted the socket and never answered. What the operator
    // checks next differs - load, or an upstream timeout shorter than the work
    // - so the two must not collapse into one sentence.
    loginReply = { kind: 'timeout' }

    renderPage('en')
    await submitCredentials()

    expect(await whatTheCardSaid()).toBe(en.errors.serverTimeout)
    expect(screen.queryByText('timeout of 30000ms exceeded')).not.toBeInTheDocument()
  })

  it('says it in the operator’s language', async () => {
    // The card renders dictionary strings, not one hardcoded sentence that
    // happens to match a language. English on a Russian panel is what the
    // axios `.message` gave every operator before any of this.
    loginReply = { kind: 'network' }

    renderPage('ru')
    await submitCredentials()

    expect(await whatTheCardSaid()).toBe(ru.errors.serverUnreachable)
  })

  it('ANTI-VACUITY: a wrong password still reads as a wrong password', async () => {
    // The regression that would matter most. A refusal DID reach the server,
    // and it named its reason; reporting that as an unreachable host would
    // send an operator who simply mistyped off to inspect the reverse proxy.
    //
    // This asserts WHICH sentence landed, having waited only for some sentence
    // to land - so the mutant that routes a refusal to the transport copy is
    // caught here rather than timing out on a find for the right one.
    loginReply = { kind: 'status', status: 401, body: { ...INVALID_CREDENTIALS_BODY } }

    renderPage('en')
    await submitCredentials()

    const shown = await whatTheCardSaid()
    expect(shown).toBe(en.errors['Invalid login or password'])
    expect(shown).not.toBe(en.errors.serverUnreachable)
    expect(shown).not.toBe(en.errors.serverTimeout)
  })

  it('ANTI-VACUITY: a 502 that answered with nothing still takes the generic', async () => {
    // A proxy's HTML error page, or an empty body. The request DID reach a
    // server, so the transport copy would point at the wrong layer entirely.
    // This is the guard that keeps the transport rung UNDER the body rung, and
    // it is the case that proves `signInPage.login.genericError` still has a
    // job after this change.
    loginReply = { kind: 'status', status: 502, body: {} }

    renderPage('en')
    await submitCredentials()

    const shown = await whatTheCardSaid()
    expect(shown).toBe(en.signInPage.login.genericError)
    expect(shown).not.toBe(en.errors.serverUnreachable)
  })

  it('never leaves a raw i18n key on screen', async () => {
    // i18next answers an unresolved key by echoing it back, so a key that does
    // not resolve renders as "errors.serverUnreachable" - worse than the
    // English jargon it replaced.
    loginReply = { kind: 'network' }

    renderPage('ru')
    await whatTheCardSaidAfter(submitCredentials)

    expect(document.body.textContent ?? '').not.toContain('errors.')
    expect(document.body.textContent ?? '').not.toContain('signInPage.')
  })

  it('does not report an unreachable backend as a rejected second-factor code', async () => {
    // The second step, where the misdirection costs more: a fresh code is the
    // operator's natural response to "invalid code", and it will keep failing
    // for as long as the backend is down.
    loginReply = { kind: 'status', status: 401, body: { ...TOTP_REQUIRED_BODY } }

    renderPage('en')
    await submitCredentials()
    const field = await waitForTotpStep()

    loginReply = { kind: 'network' }
    submitTotpCode(field, '123456')

    expect(await whatTheCardSaid()).toBe(en.errors.serverUnreachable)
    expect(document.body.textContent ?? '').not.toContain(en.signInPage.totp.invalidCode)
  })

  it('ANTI-VACUITY: a genuinely rejected code still reads as a rejected code', async () => {
    // The control for the case above. A wrong code DID reach the server, so it
    // must keep its own message - the transport rung answers null for anything
    // carrying a response, and this is what proves that.
    loginReply = { kind: 'status', status: 401, body: { ...TOTP_REQUIRED_BODY } }

    renderPage('en')
    await submitCredentials()
    const field = await waitForTotpStep()

    loginReply = { kind: 'status', status: 401, body: { ...INVALID_CODE_BODY } }
    submitTotpCode(field, '000000')

    const shown = await whatTheCardSaid()
    expect(shown).toBe(en.signInPage.totp.invalidCode)
    expect(shown).not.toBe(en.errors.serverUnreachable)
    // Still on step two, with the typed code there to correct.
    expect(document.querySelector('#totp')).not.toBeNull()
  })
})

/** Runs an action and waits for the card to say something, discarding what. */
async function whatTheCardSaidAfter(action: () => Promise<void>): Promise<void> {
  await action()
  await whatTheCardSaid()
}
