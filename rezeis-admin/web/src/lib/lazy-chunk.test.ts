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

import { failedChunkUrl, isStaleChunkError, recoverFromStaleChunk } from './lazy-chunk'

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

  it('is NOT re-armed when a different chunk loads — the endless reload of R1-16', async () => {
    // On a signed-in page the default background chunk loads on every
    // document, ahead of a page chunk that goes to the network. When any load
    // cleared the mark, a page chunk that failed every time reloaded the tab
    // forever instead of reaching the error screen.
    await settled(recoverFromStaleChunk(() => Promise.reject(STALE))())
    reload.mockClear()

    await recoverFromStaleChunk(() => Promise.resolve({ default: () => null }))()
    await expect(recoverFromStaleChunk(() => Promise.reject(STALE))()).rejects.toThrow(STALE.message)

    expect(reload).not.toHaveBeenCalled()
  })

  it('gives every failing chunk URL its own reload', async () => {
    await settled(recoverFromStaleChunk(() => Promise.reject(STALE))())
    reload.mockClear()

    const other = new TypeError(
      'Failed to fetch dynamically imported module: https://panel.example/assets/plans-page-Q9x.js',
    )
    await settled(recoverFromStaleChunk(() => Promise.reject(other))())

    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('is re-armed by a new deploy — the entry script names the build', async () => {
    const entry = document.createElement('script')
    entry.type = 'module'
    entry.src = '/assets/index-Build1.js'
    document.head.appendChild(entry)
    try {
      await settled(recoverFromStaleChunk(() => Promise.reject(STALE))())
      await settled(recoverFromStaleChunk(() => Promise.reject(STALE))())
      expect(reload).toHaveBeenCalledTimes(1) // spent in this build

      entry.src = '/assets/index-Build2.js' // the next document is a new deploy
      await settled(recoverFromStaleChunk(() => Promise.reject(STALE))())
      expect(reload).toHaveBeenCalledTimes(2)
    } finally {
      entry.remove()
    }
  })

  describe('when documents alternate between builds (review R1-22)', () => {
    // Two panel replicas mid-update, or a CDN caching index.html, serve two
    // builds in turn. Each document below is one load: the entry script names
    // its build, and that build's chunk fails. With only the current build
    // remembered, each build wiped the other's mark and both reloaded forever.
    let entry: HTMLScriptElement
    beforeEach(() => {
      entry = document.createElement('script')
      entry.type = 'module'
      document.head.appendChild(entry)
    })
    afterEach(() => entry.remove())

    /** One document of `build` whose chunk fails: 'reloaded' or 'error screen'. */
    async function documentOf(build: string): Promise<'reloaded' | 'error screen'> {
      entry.src = `/assets/index-${build}.js`
      const before = reload.mock.calls.length
      const failure = new TypeError(
        `Failed to fetch dynamically imported module: https://panel.example/assets/users-page-${build}.js`,
      )
      const outcome = await Promise.race([
        recoverFromStaleChunk(() => Promise.reject(failure))().then(
          () => 'loaded',
          () => 'error screen' as const,
        ),
        new Promise((resolve) => setTimeout(() => resolve('pending'), 10)),
      ])
      if (reload.mock.calls.length > before) return 'reloaded'
      expect(outcome).toBe('error screen')
      return 'error screen'
    }

    it('A/B/A/B: each build reloads once, then both end on the error screen', async () => {
      const outcomes = [await documentOf('A'), await documentOf('B'), await documentOf('A'), await documentOf('B')]
      expect(outcomes).toEqual(['reloaded', 'reloaded', 'error screen', 'error screen'])
    })

    it('A/B/C/A: three builds are remembered', async () => {
      const outcomes = [
        await documentOf('A'),
        await documentOf('B'),
        await documentOf('C'),
        await documentOf('A'),
      ]
      expect(outcomes).toEqual(['reloaded', 'reloaded', 'reloaded', 'error screen'])
    })

    it('A/B/C/D/A: a fourth build pushes the oldest out — the memory stays bounded', async () => {
      const outcomes = [
        await documentOf('A'),
        await documentOf('B'),
        await documentOf('C'),
        await documentOf('D'),
        await documentOf('A'),
      ]
      expect(outcomes).toEqual(['reloaded', 'reloaded', 'reloaded', 'reloaded', 'reloaded'])
    })
  })

  it('shares one reload among failures that name no URL (Safari)', async () => {
    const safari = new TypeError('Importing a module script failed.')
    await settled(recoverFromStaleChunk(() => Promise.reject(safari))())
    await settled(recoverFromStaleChunk(() => Promise.reject(safari))())

    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does not reload at all where sessionStorage cannot be read — it could never stop', async () => {
    // Nothing could remember the reload, so every fresh document would reload
    // again. The error screen shows instead, and its button reloads by hand.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage is blocked')
    })

    await expect(recoverFromStaleChunk(() => Promise.reject(STALE))()).rejects.toThrow(STALE.message)

    expect(reload).not.toHaveBeenCalled()
  })

  it('does not reload where the reload cannot be written down either', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError')
    })

    await expect(recoverFromStaleChunk(() => Promise.reject(STALE))()).rejects.toThrow(STALE.message)

    expect(reload).not.toHaveBeenCalled()
  })
})

describe('failedChunkUrl', () => {
  it('reads the URL Chrome and Firefox put in the message, and answers empty for Safari', () => {
    expect(failedChunkUrl(STALE)).toBe('https://panel.example/assets/user-detail-panel-Dlgy7jQG.js')
    expect(
      failedChunkUrl(new TypeError('error loading dynamically imported module: https://panel.example/assets/a-B1.js')),
    ).toBe('https://panel.example/assets/a-B1.js')
    expect(failedChunkUrl(new TypeError('Importing a module script failed.'))).toBe('')
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
