/**
 * «Попробовать снова» on the error screen: a reload for a chunk that failed to
 * load, an in-place retry for everything else.
 *
 * The in-place retry re-renders the children. That recovers a render that
 * failed once, and never a chunk that failed to load: the browser keeps the
 * failed module record and React keeps the rejected `lazy()` result, so the
 * same error comes straight back. The button looked alive and did nothing. It
 * happens when a warm-up of the admin shell hit an HTTP error and that chunk
 * had already had its one automatic reload in this tab (`lib/lazy-chunk.ts`). For that error
 * the button now reloads the page, and a fresh document fetches the chunk anew.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { Suspense } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { lazyWithChunkRecovery, recoverFromStaleChunk } from '@/lib/lazy-chunk'

import { ErrorBoundary } from './ErrorBoundary'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

// The boundary reports what it catches to the backend; no network in a spec.
vi.mock('@/lib/client-logger', () => ({
  logClientDiagnostic: () => {},
  reportReactError: () => {},
}))

const STALE = new TypeError(
  'Failed to fetch dynamically imported module: https://panel.example/assets/admin-shell-Dlgy7jQG.js',
)

let reload: ReturnType<typeof vi.fn>
let realLocation: PropertyDescriptor | undefined

beforeEach(() => {
  reload = vi.fn()
  realLocation = Object.getOwnPropertyDescriptor(window, 'location')
  Object.defineProperty(window, 'location', { configurable: true, value: { reload } })
  sessionStorage.clear()
  // React prints every error a boundary catches; these are the point of the test.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  if (realLocation) Object.defineProperty(window, 'location', realLocation)
  sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('«Попробовать снова»', () => {
  it('reloads the page when the error is a chunk that failed to load', async () => {
    // This chunk already had its automatic reload in this tab, so the failure
    // reaches the boundary instead of reloading on its own: the R1-11 case.
    void recoverFromStaleChunk(() => Promise.reject(STALE))()
    await new Promise((resolve) => setTimeout(resolve, 0))
    reload.mockClear()

    const factory = vi.fn(() => Promise.reject(STALE))
    const Shell = lazyWithChunkRecovery(factory)
    render(
      <ErrorBoundary>
        <Suspense fallback={<p>loading</p>}>
          <Shell />
        </Suspense>
      </ErrorBoundary>,
    )
    const retry = await screen.findByRole('button', { name: 'errorBoundary.retry' })
    expect(reload).not.toHaveBeenCalled()

    fireEvent.click(retry)

    expect(reload).toHaveBeenCalledTimes(1)
    // No second attempt in this document: it could only fail the same way.
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('a chunk that fails every time, next to a background chunk that loads, ends on the error screen after ONE reload', async () => {
    // Review R1-16: the default animated background loads on every signed-in
    // document, ahead of a page chunk that goes to the network. When any
    // successful load re-armed the reload, a page chunk that always failed —
    // a 404 cached by a proxy mid-deploy — reloaded the tab forever.
    const outcomes: string[] = []
    for (let document = 1; document <= 3; document += 1) {
      const reloadsBefore = reload.mock.calls.length
      // Fresh lazy components per document, as after a real reload.
      const Background = lazyWithChunkRecovery(() => Promise.resolve({ default: () => <p>background</p> }))
      const Page = lazyWithChunkRecovery(
        () => new Promise<{ default: () => null }>((_resolve, reject) => setTimeout(() => reject(STALE), 5)),
      )
      const view = render(
        <>
          <Suspense fallback={null}>
            <Background />
          </Suspense>
          <ErrorBoundary>
            <Suspense fallback={<p>loading</p>}>
              <Page />
            </Suspense>
          </ErrorBoundary>
        </>,
      )
      expect(await screen.findByText('background')).toBeInTheDocument()
      await new Promise((resolve) => setTimeout(resolve, 30))
      // `errorBoundary.title` is «Произошла ошибка».
      const errorScreen = screen.queryByText('errorBoundary.title') !== null
      outcomes.push(reload.mock.calls.length > reloadsBefore ? 'reloaded' : errorScreen ? 'error screen' : 'pending')
      view.unmount()
    }

    expect(outcomes).toEqual(['reloaded', 'error screen', 'error screen'])
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('retries in place for any other error, without reloading', async () => {
    let broken = true
    function Flaky() {
      if (broken) throw new Error('render failed once')
      return <p>content</p>
    }
    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    )
    const retry = await screen.findByRole('button', { name: 'errorBoundary.retry' })

    broken = false
    fireEvent.click(retry)

    expect(await screen.findByText('content')).toBeInTheDocument()
    expect(reload).not.toHaveBeenCalled()
  })
})
