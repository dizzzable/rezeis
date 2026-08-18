import type { ReactElement, ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, type RenderOptions, type RenderResult } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter } from 'react-router'
import { i18n } from '@/i18n/i18n'

interface RenderWithProvidersOptions extends Omit<RenderOptions, 'wrapper'> {
  readonly route?: string
  readonly withRouter?: boolean
}

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false,
      },
    },
  })
}

export function renderWithProviders(
  ui: ReactElement,
  { route = '/', withRouter = true, ...renderOptions }: RenderWithProvidersOptions = {},
): RenderResult {
  const queryClient = createTestQueryClient()

  function Wrapper({ children }: { readonly children: ReactNode }): ReactElement {
    const content: ReactNode = withRouter ? (
      <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
    ) : (
      children
    )

    return (
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>{content}</QueryClientProvider>
      </I18nextProvider>
    )
  }

  return render(ui, { wrapper: Wrapper, ...renderOptions })
}

export interface IntersectionObserverHarness {
  /** Elements currently observed, in `observe()` order. */
  readonly observed: readonly Element[]
  /** Re-report every observed element, intersecting when `isVisible` says so. */
  report(isVisible: (node: Element) => boolean): void
  /** Put the suite-wide inert stub back. Call from `afterEach`. */
  restore(): void
}

/**
 * A driveable `IntersectionObserver` for one test file.
 *
 * `setup-tests.ts` installs an INERT stub suite-wide — it records nothing and
 * never calls its callback — which is right for the framer-motion
 * `whileInView` props it was added for and actively wrong for anything that
 * decides behaviour from visibility. Under the inert stub such a component sees
 * "never intersected" forever, so a test cannot tell a component that correctly
 * waits for visibility from one that is broken and shows nothing: both render
 * nothing, and both pass an assertion written as "nothing yet".
 *
 * This replaces it for tests that need visibility to be a fact they control.
 * `observe()` reports `initiallyIntersecting` (true by default — an element a
 * test rendered is on screen unless the test says otherwise), and `report()`
 * re-answers for every observed element, which is how a test moves an element
 * out of view without a layout engine.
 *
 * Callbacks fire synchronously, so wrap `report()` in `act()`.
 */
export function installIntersectionObserver(options?: {
  readonly initiallyIntersecting?: boolean
}): IntersectionObserverHarness {
  const initiallyIntersecting = options?.initiallyIntersecting ?? true
  const original = globalThis.IntersectionObserver
  const originalOnWindow = window.IntersectionObserver
  type Callback = (entries: IntersectionObserverEntry[]) => void
  const entries: Array<{ readonly callback: Callback; readonly node: Element }> = []

  const notify = (
    callback: Callback,
    node: Element,
    isIntersecting: boolean,
  ): void => {
    callback([
      { target: node, isIntersecting, intersectionRatio: isIntersecting ? 1 : 0 },
    ] as unknown as IntersectionObserverEntry[])
  }

  class DriveableIntersectionObserver {
    readonly root = null
    readonly rootMargin = ''
    readonly thresholds: ReadonlyArray<number> = []
    constructor(private readonly callback: Callback) {}
    observe(node: Element): void {
      entries.push({ callback: this.callback, node })
      notify(this.callback, node, initiallyIntersecting)
    }
    unobserve(node: Element): void {
      const at = entries.findIndex(
        (entry) => entry.callback === this.callback && entry.node === node,
      )
      if (at !== -1) entries.splice(at, 1)
    }
    disconnect(): void {
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        if (entries[i]?.callback === this.callback) entries.splice(i, 1)
      }
    }
    takeRecords(): IntersectionObserverEntry[] {
      return []
    }
  }

  const install = (value: unknown): void => {
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      writable: true,
      configurable: true,
      value,
    })
    Object.defineProperty(window, 'IntersectionObserver', {
      writable: true,
      configurable: true,
      value,
    })
  }

  install(DriveableIntersectionObserver)

  return {
    get observed() {
      return entries.map((entry) => entry.node)
    },
    report(isVisible) {
      // Copy first: a callback may disconnect its observer, which mutates
      // `entries` while it is being walked.
      for (const entry of [...entries]) {
        notify(entry.callback, entry.node, isVisible(entry.node))
      }
    },
    restore() {
      entries.length = 0
      install(original)
      if (originalOnWindow !== original) {
        Object.defineProperty(window, 'IntersectionObserver', {
          writable: true,
          configurable: true,
          value: originalOnWindow,
        })
      }
    },
  }
}
