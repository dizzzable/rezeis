/**
 * The sign-in form starts downloading the admin shell on intent — never before.
 *
 * The shell left the login route (`app/router.tsx`), and «Войти» must not pay
 * for that with a round trip after the session check. So the form warms the
 * shell on the operator's first sign of intent, and only then:
 *
 *   • the first focus of, or input into, a field;
 *   • a pointer down on the card («Войти», passkey, providers);
 *   • a browser autofill of a field;
 *   • each at idle time, half a second at most. For a pointer down that is
 *     what lets the click's own login request leave first;
 *   • never on mount, although the desktop autofocus focuses the login field
 *     during the very commit that mounts it;
 *   • never while Save-Data is on.
 *
 * `requestIdleCallback` is replaced by a queue the tests flush by hand, so
 * "at idle" is told apart from "on the spot" without timing anything.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AUTOFILL_ANIMATION, INTENT_IDLE_TIMEOUT_MS, adminShell } from '@/app/admin-shell-loader'

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

let idleQueue: Array<() => void> = []
let idleTimeouts: Array<number | undefined> = []
let preload: ReturnType<typeof vi.spyOn>

function flushIdle(): void {
  const queued = idleQueue
  idleQueue = []
  for (const run of queued) run()
}

/** `navigator.connection.saveData`, as Chrome's Lite mode / data saver sets it. */
function setSaveData(saveData: boolean | undefined): void {
  Object.defineProperty(navigator, 'connection', {
    configurable: true,
    value: saveData === undefined ? undefined : { saveData },
  })
}

/** `navigator.onLine`; `undefined` puts jsdom's own (always `true`) back. */
function setOnLine(onLine: boolean | undefined): void {
  if (onLine === undefined) {
    delete (navigator as unknown as Record<string, unknown>).onLine
    return
  }
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: onLine })
}

/** `(pointer: fine)` — the desktop case, where the login field autofocuses. */
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

async function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SignInPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return {
    username: (await screen.findByLabelText('signInPage.login.usernameLabel')) as HTMLInputElement,
    password: screen.getByLabelText('signInPage.login.passwordLabel') as HTMLInputElement,
    submit: screen.getByRole('button', { name: 'signInPage.login.submit' }),
  }
}

/**
 * The event name React DOM listens on for `onAnimationStart`: `animationstart`
 * where the browser has `AnimationEvent` (every browser the panel supports),
 * the WebKit-prefixed name where it does not — and jsdom does not.
 */
const ANIMATION_START = 'AnimationEvent' in window ? 'animationstart' : 'webkitAnimationStart'

/** What the browser dispatches when an autofilled field starts the detector. */
function animationStart(target: Element, animationName: string): void {
  const event = new Event(ANIMATION_START, { bubbles: true })
  Object.defineProperty(event, 'animationName', { value: animationName })
  target.dispatchEvent(event)
}

beforeEach(() => {
  api.getAuthStatus.mockResolvedValue({ hasAdmins: true })
  // Hoisted once for the file, and `restoreAllMocks` leaves a vi.fn's calls in
  // place: without this, every submit test counts the ones before it.
  api.loginApi.mockReset()
  idleQueue = []
  idleTimeouts = []
  vi.stubGlobal('requestIdleCallback', (run: () => void, options?: { timeout?: number }) => {
    idleQueue.push(run)
    idleTimeouts.push(options?.timeout)
    return idleQueue.length
  })
  vi.stubGlobal('cancelIdleCallback', () => {})
  preload = vi.spyOn(adminShell, 'preload').mockResolvedValue(undefined)
  setFinePointer(true)
  setSaveData(undefined)
})

afterEach(() => {
  // Unmount first: the card's cleanup cancels its idle warm-up through the
  // stubbed `cancelIdleCallback`, which must still exist at that moment.
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setSaveData(undefined)
  setOnLine(undefined)
})

describe('sign-in warms the admin shell on intent', () => {
  it('does not warm on mount — not even when the desktop autofocus focuses the login field', async () => {
    const { username } = await renderPage()

    // The autofocus really happened: this is the focus that must not count.
    expect(document.activeElement).toBe(username)
    flushIdle()
    expect(preload).not.toHaveBeenCalled()
  })

  it('warms at idle on the first focus of a field', async () => {
    const { password } = await renderPage()

    password.focus()
    expect(preload).not.toHaveBeenCalled() // at idle, not on the spot
    // …but never later than half a second: idle time can take seconds to come,
    // and the typing that follows is the head start.
    expect(idleTimeouts).toEqual([INTENT_IDLE_TIMEOUT_MS])
    expect(INTENT_IDLE_TIMEOUT_MS).toBeLessThanOrEqual(1_000)
    flushIdle()

    expect(preload).toHaveBeenCalledTimes(1)
  })

  it('warms at idle on the first input, e.g. typing into the autofocused field', async () => {
    const { username } = await renderPage()

    fireEvent.input(username, { target: { value: 'a' } })
    flushIdle()

    expect(preload).toHaveBeenCalledTimes(1)
  })

  it('warms on a pointer down on «Войти» — once the click has sent its own request', async () => {
    const { submit } = await renderPage()

    fireEvent.pointerDown(submit)
    // Not on the spot: over HTTP/1.1 the shell's requests would take the
    // sockets ahead of the login POST the click is about to send.
    expect(preload).not.toHaveBeenCalled()
    flushIdle()

    expect(preload).toHaveBeenCalledTimes(1)
  })

  it('warms when the browser autofills a field, and on no other animation', async () => {
    const { password } = await renderPage()

    animationStart(password, 'some-other-animation')
    flushIdle()
    expect(preload).not.toHaveBeenCalled()

    animationStart(password, AUTOFILL_ANIMATION)
    flushIdle()
    expect(preload).toHaveBeenCalledTimes(1)
  })

  it('warms once however many signs follow', async () => {
    const { username, password, submit } = await renderPage()

    password.focus()
    fireEvent.input(username, { target: { value: 'a' } })
    fireEvent.pointerDown(submit)
    fireEvent.pointerDown(submit)
    flushIdle()

    expect(preload).toHaveBeenCalledTimes(1)
  })

  it('does nothing while Save-Data is on', async () => {
    setSaveData(true)
    const { password, submit } = await renderPage()

    password.focus()
    fireEvent.pointerDown(submit)
    animationStart(password, AUTOFILL_ANIMATION)
    flushIdle()

    expect(preload).not.toHaveBeenCalled()
  })

  it('keeps a scheduled warm-up when the card unmounts — sign-in succeeding is why it unmounts', async () => {
    const { submit } = await renderPage()

    fireEvent.pointerDown(submit)
    cleanup()
    flushIdle()

    expect(preload).toHaveBeenCalledTimes(1)
  })

  it('warms right after the login request is sent — never before it', async () => {
    api.loginApi.mockReturnValue(new Promise(() => {}))
    const { username, password, submit } = await renderPage()

    fireEvent.input(username, { target: { value: 'operator' } })
    fireEvent.input(password, { target: { value: 'fixture-value' } })
    fireEvent.click(submit)

    // The idle queue is never flushed here, so this call can only come from
    // the submit path.
    await waitFor(() => expect(preload).toHaveBeenCalledTimes(1))
    expect(api.loginApi).toHaveBeenCalledTimes(1)
    expect(api.loginApi.mock.invocationCallOrder[0]).toBeLessThan(preload.mock.invocationCallOrder[0])
  })

  it('does nothing while the browser reports offline, and warms on the next sign once it is back', async () => {
    // A warm-up fetch made offline fails for certain, and the browser keeps the
    // failed module record: the render after «Войти» would then have to reload.
    setOnLine(false)
    const { username, password, submit } = await renderPage()

    password.focus()
    fireEvent.pointerDown(submit)
    flushIdle()
    expect(preload).not.toHaveBeenCalled()

    // `true` gates nothing, and the offline signs did not spend the one-shot.
    setOnLine(true)
    fireEvent.input(username, { target: { value: 'a' } })
    flushIdle()
    expect(preload).toHaveBeenCalledTimes(1)
  })

  it('does not start a warm-up that went offline while it waited for idle time', async () => {
    const { password } = await renderPage()

    password.focus()
    setOnLine(false)
    flushIdle()

    expect(preload).not.toHaveBeenCalled()
  })

  it('does not warm after submit while the browser reports offline', async () => {
    setOnLine(false)
    api.loginApi.mockReturnValue(new Promise(() => {}))
    const { username, password, submit } = await renderPage()

    fireEvent.input(username, { target: { value: 'operator' } })
    fireEvent.input(password, { target: { value: 'fixture-value' } })
    fireEvent.click(submit)
    await waitFor(() => expect(api.loginApi).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(preload).not.toHaveBeenCalled()
  })

  it('does not warm after submit while Save-Data is on', async () => {
    setSaveData(true)
    api.loginApi.mockReturnValue(new Promise(() => {}))
    const { username, password, submit } = await renderPage()

    fireEvent.input(username, { target: { value: 'operator' } })
    fireEvent.input(password, { target: { value: 'fixture-value' } })
    fireEvent.click(submit)
    await waitFor(() => expect(api.loginApi).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(preload).not.toHaveBeenCalled()
  })

  it('warms on the first-admin registration form too', async () => {
    api.getAuthStatus.mockResolvedValue({ hasAdmins: false })
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <SignInPage />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'signInPage.register.submit' }))
    flushIdle()

    expect(preload).toHaveBeenCalledTimes(1)
  })
})
