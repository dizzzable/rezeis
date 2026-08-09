/**
 * Sign-in autoFocus is desktop-only.
 *
 * `autoFocus` on the username field (and on the TOTP field once the second
 * factor is requested) is a keyboard nicety. On a touch device it raises the
 * software keyboard over the card the instant it renders and scroll-jumps the
 * page before the operator has seen it — on iOS it also combines with the
 * focus-zoom to leave the panel half-scaled. The fields therefore focus only
 * where `(pointer: fine)` matches.
 *
 * The gate is a `matchMedia` read, so these tests drive `matchMedia` and then
 * assert on `document.activeElement`. React does not reflect `autoFocus` as
 * an HTML attribute — it calls `.focus()` on mount — so the moved focus is
 * the only observable form of the decision.
 *
 * Known limit, deliberately not papered over: the second-factor card is a
 * different return value of the SAME component, so React reconciles the code
 * field onto the username field's existing <input> node. The node is never
 * re-mounted, which means the code field's own `autoFocus` prop never fires —
 * focus at the TOTP step is inherited from the username field. Mutating that
 * prop alone therefore changes nothing, and no test here claims otherwise.
 * What the TOTP cases pin is the user-visible invariant: on a touch device
 * the second-factor step arrives with nothing focused.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const api = vi.hoisted(() => ({
  getAuthStatus: vi.fn(),
  loginApi: vi.fn(),
  registerApi: vi.fn(),
}))

vi.mock('./auth-api', () => api)
vi.mock('./auth-provider', () => ({ useAuth: () => ({ login: vi.fn() }) }))
vi.mock('./oauth-buttons', () => ({ OAuthButtons: () => null }))

import SignInPage from './sign-in-page'

/** Makes `matchMedia` answer `(pointer: fine)` with `matches`. */
function setFinePointer(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('pointer: fine') ? matches : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SignInPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  api.getAuthStatus.mockResolvedValue({ hasAdmins: true })
  // Every login attempt asks for the second factor, so one submit walks the
  // form to the TOTP step where the other gated field lives.
  api.loginApi.mockRejectedValue({ response: { data: { code: 'totp_required' } } })
})

afterEach(() => {
  vi.clearAllMocks()
})

/**
 * Walk the form to the second-factor step.
 *
 * `focusBeforeSubmit` decides which node holds focus at the moment the branch
 * switches, and that is the entire point — see the TOTP cases below. The
 * default ('submit') is what a real operator does; 'username' reproduces the
 * artificial state a programmatic submit leaves behind.
 */
async function goToTotpStep(
  focusBeforeSubmit: 'submit' | 'password' | 'username' | 'leave-as-is' = 'submit',
): Promise<{ totp: HTMLElement; usernameNode: HTMLElement }> {
  const username = await screen.findByLabelText(/username/i)
  const form = username.closest('form') as HTMLFormElement
  const password = form.querySelector('#password') as HTMLInputElement
  const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement
  // Bypass userEvent: the assertion is about where focus lands, and
  // react-hook-form's zod resolver only needs both values to be non-empty.
  const set = (el: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  set(username as HTMLInputElement, 'operator')
  set(password, 'hunter2hunter2')

  if (focusBeforeSubmit !== 'leave-as-is') {
    const focusTarget =
      focusBeforeSubmit === 'submit'
        ? submit
        : focusBeforeSubmit === 'password'
          ? password
          : username
    focusTarget.focus()
    expect(document.activeElement).toBe(focusTarget)
  }

  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  return { totp: await screen.findByLabelText(/codeLabel/i), usernameNode: username }
}

describe('sign-in autoFocus on a fine pointer (desktop)', () => {
  beforeEach(() => setFinePointer(true))

  it('focuses the username field on render', async () => {
    renderPage()
    const username = await screen.findByLabelText(/username/i)
    await waitFor(() => expect(document.activeElement).toBe(username))
  })

  it('reconciles the code field onto the username field’s existing node', async () => {
    // The mechanism behind the note in this file's header, pinned rather than
    // asserted in prose: both branches return `<Card>…<form>` whose first
    // child is a `div.space-y-2` wrapping a Label and an Input, so React
    // reuses ONE <input> element for username and then for the code. The
    // element is never re-mounted, which is exactly why the code field's own
    // `autoFocus={autoFocusField}` prop can never fire. Change the markup so
    // the branches no longer align and this test goes red — at which point
    // the TOTP `autoFocus` starts working and the header note is stale.
    renderPage()
    const { totp, usernameNode } = await goToTotpStep('username')
    expect(totp).toBe(usernameNode)
  })

  it('arrives at the second factor with nothing focused, as in a real session', async () => {
    // This case previously asserted that the code field ends up focused. It
    // did pass — but only because the harness submitted the form
    // programmatically while focus still sat on the username node, which
    // React then reuses as the code field. Focus never moved; nothing about
    // the TOTP step was being tested.
    //
    // A real operator submits from the button (click) or from the password
    // field (Enter). Both of those nodes are unmounted by the branch switch —
    // only the first `div.space-y-2` survives reconciliation — so focus falls
    // to <body>, exactly as on touch. That is the user-visible truth.
    for (const from of ['submit', 'password'] as const) {
      const { unmount } = renderPage()
      const { totp } = await goToTotpStep(from)
      expect(document.activeElement, `submitted from the ${from} element`).toBe(document.body)
      expect(document.activeElement).not.toBe(totp)
      unmount()
    }
  })
})

describe('sign-in autoFocus on a coarse pointer (touch)', () => {
  beforeEach(() => setFinePointer(false))

  it('leaves the username field unfocused so the keyboard stays down', async () => {
    renderPage()
    const username = await screen.findByLabelText(/username/i)
    expect(document.activeElement).not.toBe(username)
    expect(document.activeElement).toBe(document.body)
  })

  it('reaches the TOTP step with nothing focused, so no keyboard pops up', async () => {
    renderPage()
    // 'leave-as-is': the harness must not plant focus anywhere, or it would
    // manufacture the very state this asserts against. On touch nothing is
    // focused at mount, and the branch switch must not change that — the
    // code field's `autoFocus` is gated off, and there is no focused node
    // for reconciliation to carry across either.
    expect(document.activeElement).toBe(document.body)
    const { totp } = await goToTotpStep('leave-as-is')
    expect(document.activeElement).not.toBe(totp)
    expect(document.activeElement).toBe(document.body)
  })
})
