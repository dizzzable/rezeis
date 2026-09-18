/**
 * What happens to an open panel when a deploy replaces every hashed chunk.
 *
 * Production, 16.09.2026, panel 0.9.7.59: an operator on «Пользователи» opened
 * a customer's card and got the crash screen —
 * «Failed to fetch dynamically imported module … user-detail-panel-*.js». The
 * tab had been open across a deploy, so the chunk it asked for was no longer on
 * the server. One reload fixes it; without one the operator is stuck on every
 * piece of the app they had not already downloaded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isStaleChunkError, recoverFromStaleChunk } from './lazy-chunk'

const STALE = new TypeError(
  'Failed to fetch dynamically imported module: https://panel.example/assets/user-detail-panel-Dlgy7jQG.js',
)

let reload: ReturnType<typeof vi.fn>
let realLocation: PropertyDescriptor | undefined

beforeEach(() => {
  reload = vi.fn()
  realLocation = Object.getOwnPropertyDescriptor(window, 'location')
  Object.defineProperty(window, 'location', { configurable: true, value: { reload } })
  sessionStorage.clear()
})

afterEach(() => {
  if (realLocation) Object.defineProperty(window, 'location', realLocation)
  sessionStorage.clear()
  vi.restoreAllMocks()
})

/** Whether a promise has settled by the time the microtask queue drains. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false
  void promise.then(
    () => { done = true },
    () => { done = true },
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  return done
}

describe('a chunk the server no longer has', () => {
  it('reloads the document once and leaves the page on its loading state', async () => {
    const load = recoverFromStaleChunk(() => Promise.reject(STALE))

    const pending = load()

    // Not rejected: React keeps the Suspense fallback up while the document is
    // replaced, instead of flashing a crash screen for an instant.
    expect(await settled(pending)).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('shows the failure instead of reloading again when the fresh page fails the same way', async () => {
    await settled(recoverFromStaleChunk(() => Promise.reject(STALE))())
    reload.mockClear()

    // The reload has happened; this is the new document asking for the same
    // chunk and failing again, which is a real defect, not a stale tab.
    await expect(recoverFromStaleChunk(() => Promise.reject(STALE))()).rejects.toThrow(
      'Failed to fetch dynamically imported module',
    )
    expect(reload).not.toHaveBeenCalled()
  })

  it('clears the mark when a chunk loads, so a later deploy can recover too', async () => {
    await settled(recoverFromStaleChunk(() => Promise.reject(STALE))())
    reload.mockClear()

    await recoverFromStaleChunk(() => Promise.resolve({ default: () => null }))()
    await settled(recoverFromStaleChunk(() => Promise.reject(STALE))())

    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reloads even where sessionStorage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage is blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage is blocked')
    })

    await settled(recoverFromStaleChunk(() => Promise.reject(STALE))())

    expect(reload).toHaveBeenCalledTimes(1)
  })
})

describe('everything else is passed through', () => {
  it('lets a real failure reach the error boundary, without reloading', async () => {
    const boom = new TypeError('Cannot read properties of undefined (reading id)')

    await expect(recoverFromStaleChunk(() => Promise.reject(boom))()).rejects.toThrow(boom)
    expect(reload).not.toHaveBeenCalled()
  })

  it('returns the module and does not touch the page when the import works', async () => {
    const component = () => null

    await expect(recoverFromStaleChunk(() => Promise.resolve({ default: component }))()).resolves.toEqual({
      default: component,
    })
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('what counts as a stale chunk', () => {
  it('recognises the wording of each browser', () => {
    // Chrome/Edge, Firefox, Safari, and the classic module-script failure.
    for (const message of [
      'Failed to fetch dynamically imported module: https://panel.example/assets/a-B1.js',
      'error loading dynamically imported module: https://panel.example/assets/a-B1.js',
      'Importing a module script failed.',
      'Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of "text/html".',
    ]) {
      expect(isStaleChunkError(new TypeError(message)), message).toBe(true)
    }
  })

  it('does not swallow an ordinary application error', () => {
    // ANTI-VACUITY: a pattern one word looser would reload the panel on every
    // failed fetch in the app, and the operator would never see the error.
    for (const message of [
      'Cannot read properties of undefined (reading id)',
      'Request failed with status code 500',
      'Failed to fetch',
      'NetworkError when attempting to fetch resource.',
    ]) {
      expect(isStaleChunkError(new TypeError(message)), message).toBe(false)
    }
  })
})
