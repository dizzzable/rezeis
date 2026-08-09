/**
 * Deferred service-worker registration, and the reload it must not perform.
 *
 * The SW precaches ~7 MiB / ~300 entries. Registering at module eval
 * (`immediate: true` at import time) made that download race the
 * login-critical path — locale chunk, auth status, session probe — on
 * first visit. Under test:
 *
 *   • registration waits for window `load` plus an idle period
 *     (requestIdleCallback with a ~3 s setTimeout fallback);
 *   • …but not forever — a stalled subresource must not cost the session
 *     its service worker;
 *   • the update semantics (probe on registration + hourly re-probe)
 *     survive the deferral unchanged;
 *   • and the auto-update reload never lands on an operator mid-typing.
 *     That last one is the defect the deferral CREATED: registration used
 *     to happen at module eval, so a post-deploy reload landed before first
 *     paint; deferred, it lands ~3–5 s in, right after `autoFocus` put the
 *     cursor in the username field.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const registerSWMock = vi.hoisted(() => vi.fn())

vi.mock('virtual:pwa-register', () => ({
  registerSW: registerSWMock,
}))

import { registerServiceWorker } from './register-sw'

function setReadyState(value: DocumentReadyState): void {
  Object.defineProperty(document, 'readyState', {
    configurable: true,
    get: () => value,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  registerSWMock.mockReset()
  // jsdom has no navigator.serviceWorker — provide a stub so the guard passes.
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {},
  })
})

afterEach(() => {
  vi.useRealTimers()
  delete (navigator as { serviceWorker?: unknown }).serviceWorker
  setReadyState('complete')
})

describe('registerServiceWorker deferral', () => {
  it('waits for window load, then an idle period, then registers', async () => {
    // One flow end-to-end: the `load` listener is registered once per call
    // and would leak into sibling tests if left undrained, so the whole
    // deferral contract is pinned in a single scenario.
    setReadyState('loading')
    await registerServiceWorker()

    // Nothing while the page is still loading…
    await vi.advanceTimersByTimeAsync(9_000)
    expect(registerSWMock).not.toHaveBeenCalled()

    setReadyState('complete')
    window.dispatchEvent(new Event('load'))
    // Load fired, but the idle window has not elapsed yet.
    await vi.advanceTimersByTimeAsync(0)
    expect(registerSWMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(3_000)
    expect(registerSWMock).toHaveBeenCalledTimes(1)
    expect(registerSWMock).toHaveBeenCalledWith(
      expect.objectContaining({ immediate: true }),
    )

    // The timeout fallback must have been disarmed by the real `load`.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(registerSWMock).toHaveBeenCalledTimes(1)
  })

  it('registers anyway when `load` never fires (a stalled subresource)', async () => {
    // `load` waits on EVERY subresource. One hung font request and an
    // unbounded wait means no service worker for the entire session — no
    // offline shell, no precache, and no error either.
    setReadyState('loading')
    await registerServiceWorker()

    await vi.advanceTimersByTimeAsync(9_999)
    expect(registerSWMock).not.toHaveBeenCalled()

    // 10 s cap, then the usual idle window. `load` is never dispatched.
    await vi.advanceTimersByTimeAsync(1 + 3_000)
    expect(registerSWMock).toHaveBeenCalledTimes(1)
  })

  it('registers exactly once when `load` arrives right at the cap', async () => {
    setReadyState('loading')
    await registerServiceWorker()

    await vi.advanceTimersByTimeAsync(10_000)
    setReadyState('complete')
    window.dispatchEvent(new Event('load'))
    await vi.advanceTimersByTimeAsync(10_000)

    expect(registerSWMock).toHaveBeenCalledTimes(1)
  })

  it('still registers (after idle) when called in an already-loaded document', async () => {
    setReadyState('complete')

    await registerServiceWorker()
    // Drain microtasks before asserting. `registerNow` reaches `registerSW`
    // only after `await import('virtual:pwa-register')`, so an undeferred
    // implementation ALSO looks quiet for one tick — without this flush the
    // assertion below passes whether or not the deferral exists.
    await vi.advanceTimersByTimeAsync(0)
    expect(registerSWMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(3_000)
    expect(registerSWMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the on-register update probe and the hourly re-probe', async () => {
    setReadyState('complete')
    await registerServiceWorker()
    await vi.advanceTimersByTimeAsync(3_000)

    const options = registerSWMock.mock.calls[0]?.[0] as {
      onRegisteredSW: (url: string, registration: { update: () => Promise<void> }) => void
    }
    const update = vi.fn().mockResolvedValue(undefined)
    options.onRegisteredSW('/sw.js', { update })

    // Immediate probe on registration…
    expect(update).toHaveBeenCalledTimes(1)

    // …and again every hour.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(update).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(update).toHaveBeenCalledTimes(3)
  })

  it('bails out silently when the browser has no service worker support', async () => {
    delete (navigator as { serviceWorker?: unknown }).serviceWorker
    setReadyState('complete')

    await registerServiceWorker()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(registerSWMock).not.toHaveBeenCalled()
  })
})

describe('auto-update reload timing', () => {
  let reload: ReturnType<typeof vi.fn>

  /** Register, then hand back the `onNeedReload` the plugin would call. */
  async function activateUpdate(): Promise<() => void> {
    setReadyState('complete')
    await registerServiceWorker()
    await vi.advanceTimersByTimeAsync(3_000)
    const options = registerSWMock.mock.calls[0]?.[0] as { onNeedReload?: () => void }
    // Supplying this is the ONLY thing that stops vite-plugin-pwa's
    // autoUpdate template from calling window.location.reload() itself the
    // instant the new worker activates (dist/client/build/register.js).
    expect(typeof options.onNeedReload).toBe('function')
    return options.onNeedReload!
  }

  function setVisibility(state: DocumentVisibilityState): void {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => state,
    })
    document.dispatchEvent(new Event('visibilitychange'))
  }

  beforeEach(() => {
    reload = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { reload },
    })
    setVisibility('visible')
    document.body.innerHTML = ''
  })

  afterEach(async () => {
    // A case that (correctly) ends with the reload still pending leaves a
    // live watcher on `document`, which would fire during the NEXT test and
    // be blamed on it. Draining it here keeps the cases independent — and
    // doubles as proof that a watcher which fires removes its own listeners,
    // since nothing accumulates across the file.
    document.body.innerHTML = ''
    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(5_000)
    reload.mockClear()
    setVisibility('visible')
  })

  it('does not reload while the operator is typing in a field', async () => {
    document.body.innerHTML = '<input id="username" />'
    const input = document.querySelector('input') as HTMLInputElement
    input.focus()
    input.value = 'admi' // mid-word: differs from defaultValue

    const onNeedReload = await activateUpdate()
    onNeedReload()

    // Well past every idle threshold in the module.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(reload).not.toHaveBeenCalled()
  })

  it('does not reload while a background tab holds a half-filled form', async () => {
    // Hidden is otherwise the ideal moment — but not when it would discard
    // work. Unsaved input vetoes unconditionally.
    document.body.innerHTML = '<textarea></textarea>'
    const area = document.querySelector('textarea') as HTMLTextAreaElement
    area.value = 'half a broadcast message'

    const onNeedReload = await activateUpdate()
    onNeedReload()
    setVisibility('hidden')

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads once the tab is hidden and nothing is unsaved', async () => {
    document.body.innerHTML = '<input value="preset" />'

    const onNeedReload = await activateUpdate()
    onNeedReload()
    expect(reload).not.toHaveBeenCalled()

    setVisibility('hidden')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reloads a visible, idle tab with nothing focused', async () => {
    const onNeedReload = await activateUpdate()
    onNeedReload()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(reload).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(35_000) // past the 60 s quiet period
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('restarts the quiet period every time the operator interacts', async () => {
    const onNeedReload = await activateUpdate()
    onNeedReload()

    // Keep poking the page just under the threshold, forever.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(50_000)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    }
    expect(reload).not.toHaveBeenCalled()

    // Stop, and it lands.
    await vi.advanceTimersByTimeAsync(65_000)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reloads only once, even though the poll keeps ticking', async () => {
    const onNeedReload = await activateUpdate()
    onNeedReload()

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
