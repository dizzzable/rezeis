/**
 * `lazyWithPreload`: a lazy component whose chunk can be fetched before it
 * renders, and which then renders WITHOUT suspending.
 *
 * The no-suspend half is the one with a cost attached. React 19.2.8 suspends a
 * `lazy()` component on its first render even when the promise has already
 * resolved, shows the Suspense fallback for a frame, and holds the reveal back
 * until 300 ms after that fallback appeared. The admin shell is fetched during
 * the session check precisely so that it is ready when the check ends; had it
 * suspended anyway, the operator would have waited 300 ms for a download that
 * was already over.
 *
 * A failed warm-up is NOT retried, and the tests below say so. A browser keeps
 * a module whose fetch failed as failed for the life of the document (the HTML
 * module map); in Chromium, a chunk that got an HTTP 503 failed again on a
 * second `import()` with a single request at the server. So the render after a
 * failed warm-up gets the same failure at once, and what recovers is the
 * stale-chunk reload, once. `moduleMapImport` below answers the way the browser
 * does. A mocked factory that simply succeeds on its second call would test a
 * retry no browser performs.
 */
import { act, render, screen } from '@testing-library/react'
import { Component as ReactComponent, Suspense, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { lazyWithPreload, recoverFromStaleChunk } from './lazy-chunk'

const STALE = new TypeError(
  'Failed to fetch dynamically imported module: https://panel.example/assets/admin-shell-Dlgy7jQG.js',
)

function Content() {
  return <p>content</p>
}

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
})

/**
 * An importer that answers the way a browser's `import()` does after a failed
 * fetch. The first call is the request, and it fails. Every later call rejects
 * with the same failure from the module map, WITHOUT a new request.
 */
function moduleMapImport() {
  const counts = { calls: 0, requests: 0 }
  let failed = false
  const importer = (): Promise<{ default: typeof Content }> => {
    counts.calls += 1
    if (!failed) {
      counts.requests += 1
      failed = true
    }
    return Promise.reject(STALE)
  }
  return { importer, counts }
}

/** Catches what the Suspense boundary passes up, and names it. */
class Boundary extends ReactComponent<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    return this.state.error ? <p>error boundary: {this.state.error.message}</p> : this.props.children
  }
}

/** Renders `Component` under a Suspense whose fallback reports each of its renders. */
function renderCountingFallback(Component: React.ComponentType) {
  const fallbackRendered = vi.fn()
  function Fallback() {
    fallbackRendered()
    return <p>fallback</p>
  }
  render(
    <Suspense fallback={<Fallback />}>
      <Component />
    </Suspense>,
  )
  return fallbackRendered
}

describe('lazyWithPreload', () => {
  it('renders a preloaded module on the first pass — no fallback, not even for a frame', async () => {
    const lazyContent = lazyWithPreload(() => Promise.resolve({ default: Content }))
    await lazyContent.preload()
    expect(lazyContent.isLoaded()).toBe(true)

    const fallbackRendered = renderCountingFallback(lazyContent.Component)

    expect(screen.getByText('content')).toBeInTheDocument()
    expect(fallbackRendered).not.toHaveBeenCalled()
  })

  it('still suspends when nothing preloaded it — the case the sync path exists to avoid', async () => {
    const lazyContent = lazyWithPreload(() => Promise.resolve({ default: Content }))

    const fallbackRendered = renderCountingFallback(lazyContent.Component)

    expect(fallbackRendered).toHaveBeenCalled()
    expect(await screen.findByText('content')).toBeInTheDocument()
  })

  it('downloads once however many callers ask, and shares the download with the render', async () => {
    const factory = vi.fn(() => Promise.resolve({ default: Content }))
    const lazyContent = lazyWithPreload(factory)

    const first = lazyContent.preload()
    const second = lazyContent.preload()
    renderCountingFallback(lazyContent.Component)
    await act(async () => {
      await Promise.all([first, second])
    })

    expect(factory).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('content')).toBeInTheDocument()
  })

  it('never rejects and never reloads the page when a warm-up fails', async () => {
    const lazyContent = lazyWithPreload(() => Promise.reject(STALE))

    await expect(lazyContent.preload()).resolves.toBeUndefined()

    expect(reload).not.toHaveBeenCalled()
    expect(lazyContent.isLoaded()).toBe(false)
  })

  it('does not retry a failed warm-up: the render reloads the page once, with the fallback up meanwhile', async () => {
    const { importer, counts } = moduleMapImport()
    const lazyContent = lazyWithPreload(importer)

    await lazyContent.preload()
    expect(reload).not.toHaveBeenCalled() // the warm-up itself never reloads

    renderCountingFallback(lazyContent.Component)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // The wrapper asked again. The browser answered from its record, with no
    // second request: the component's import fails exactly as the warm-up did.
    expect(counts.calls).toBe(2)
    expect(counts.requests).toBe(1)
    // What recovers is the stale-chunk reload, once. The fresh document starts
    // with an empty module map and fetches the chunk anew.
    expect(reload).toHaveBeenCalledTimes(1)
    expect(screen.getByText('fallback')).toBeInTheDocument()
    expect(screen.queryByText('content')).toBeNull()
  })

  it('does not hang when the chunk already had its reload in this tab: the failure reaches the error boundary', async () => {
    // The document before this one already spent this chunk's one reload.
    void recoverFromStaleChunk(() => Promise.reject(STALE))()
    await new Promise((resolve) => setTimeout(resolve, 0))
    reload.mockClear()
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { importer } = moduleMapImport()
    const lazyContent = lazyWithPreload(importer)
    await lazyContent.preload()
    render(
      <Boundary>
        <Suspense fallback={<p>fallback</p>}>
          <lazyContent.Component />
        </Suspense>
      </Boundary>,
    )

    expect(await screen.findByText(/^error boundary: Failed to fetch dynamically imported module/)).toBeInTheDocument()
    expect(reload).not.toHaveBeenCalled()
    quiet.mockRestore()
  })

  it('keeps the stale-chunk recovery on the render path', async () => {
    const lazyContent = lazyWithPreload(() => Promise.reject(STALE))

    renderCountingFallback(lazyContent.Component)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // Rendering is what reloads, like `lazyWithChunkRecovery`; a warm-up never does.
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
