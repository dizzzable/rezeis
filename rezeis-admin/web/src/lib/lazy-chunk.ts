import { lazy as reactLazy, type ComponentType, type LazyExoticComponent } from 'react'

/**
 * `React.lazy` that survives a deploy.
 *
 * ── The failure it removes ────────────────────────────────────────────────
 *
 * Every lazily loaded piece of this SPA lives in a file whose name carries a
 * content hash. A deploy replaces the whole `assets/` directory, so the hashes
 * an already-open tab knows are gone from the server. The tab keeps working —
 * until it needs a piece it has not downloaded yet, and the dynamic import
 * 404s: «Failed to fetch dynamically imported module …». React turns that into
 * a render error, and the operator gets the crash screen instead of the page.
 *
 * Reported from production on 16.09.2026, panel 0.9.7.59: an operator on
 * «Пользователи» opened a customer's card, whose panel is a chunk of its own,
 * and the card never appeared. The route chunks had this recovery (it lived in
 * `app/router.tsx`); everything loaded from INSIDE a page did not, which is
 * exactly where that operator was.
 *
 * ── What it does ─────────────────────────────────────────────────────────
 *
 * On a stale-chunk failure it reloads the document once. The service worker
 * serves navigations network-first (`src/sw.ts`), so the reload brings the new
 * `index.html` with the new hashes and the page opens as if nothing happened.
 *
 * ONE RELOAD PER FAILING CHUNK, PER DEPLOY. The reload is remembered in
 * `sessionStorage` under the URL of the chunk that failed, and under the build
 * it failed in (the entry script's hashed name). When the same URL fails again
 * in the same build, the error goes to the error boundary: the chunk is really
 * broken, not stale.
 *
 * The marks of the last THREE builds are kept, not only the current one's. Two
 * builds can be served in turn: two panel replicas during a rolling update, or
 * a CDN that caches `index.html`. With one build remembered, each build's
 * document wiped the other's mark, and a failing chunk in each reloaded forever
 * (review R1-22).
 *
 * Nothing else clears the mark; only a new deploy does. It used to be
 * one flag for the whole tab, cleared by ANY chunk that loaded. On a signed-in
 * page the default animated background loads first on every document, so a
 * chunk that failed every time reloaded the tab forever (review R1-16): a 404 a
 * proxy or CDN cached mid-deploy, or a file missing from the image. A load of
 * that same URL cannot clear it either, because a successful import does not
 * say which file it came from. Guessing is how the loop came back:
 * resource timing reports 200 for the index.html a proxy serves in place of a
 * missing chunk. A second failure of a URL that once recovered, in the same
 * build, therefore goes to the error screen, whose «Попробовать снова» reloads.
 *
 * Without usable `sessionStorage` (a browser that blocks site data) there is no
 * automatic reload at all. A reload nothing can remember is exactly the reload
 * that repeats forever. The error screen shows, and its button reloads.
 *
 * Only a stale-chunk failure reloads. Any other error — a module that throws
 * while evaluating, a component that fails to construct — is passed through to
 * the error boundary untouched.
 *
 * USE IT FOR EVERY `lazy()` IN THE APP, decorative ones included: a stale
 * chunk means the tab is stale, and the decorative pieces sit in the shell
 * (`EffectsProvider`) and in page headings (`TitleEffect`), where the crash
 * takes the whole screen rather than one widget. `lazy-chunk-coverage.test.ts`
 * holds that line.
 */
/**
 * `{ builds: [{ build, urls }] }`, least recently spent first: the chunk URLs
 * whose one reload this tab spent, per build.
 */
const CHUNK_RELOADS_KEY = 'rezeis:chunk-reloads'

/**
 * How many builds keep their marks. Two builds served in turn need two; the
 * third leaves room for a deploy landing in the middle of that. Bounded, so an
 * endlessly long session does not collect every deploy it ever saw.
 */
const MAX_REMEMBERED_BUILDS = 3

/** A bound, not a budget: only chunks that failed are ever listed. */
const MAX_REMEMBERED_URLS = 50

interface SpentReloads {
  readonly build: string
  readonly urls: readonly string[]
}

/** What a browser calls a chunk that is no longer on the server. */
const STALE_CHUNK_MESSAGE =
  /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|failed to load module script/i

/** Whether this error is a chunk the server no longer has, rather than a bug. */
export function isStaleChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return STALE_CHUNK_MESSAGE.test(message)
}

/**
 * The URL a browser names in a failed dynamic import: Chrome and Firefox put it
 * in the message. '' when there is none (Safari's «Importing a module script
 * failed.»), so such failures share a single reload.
 */
export function failedChunkUrl(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const match = /https?:\/\/[^\s"'<>]+/.exec(message)
  return match ? match[0].replace(/[.,;:)]+$/, '') : ''
}

/**
 * The deploy this document belongs to: the entry script's hashed URL. The entry
 * lists every lazy chunk's file name, so any change to the app changes it.
 */
function currentBuild(): string {
  if (typeof document === 'undefined') return ''
  return document.querySelector('script[type="module"][src]')?.getAttribute('src') ?? ''
}

/**
 * Every remembered build's spent URLs, or null when `sessionStorage` cannot be
 * read at all. A browser can throw here (site data blocked, a locked-down
 * webview), and a page must not break over it. A value that does not parse
 * counts as nothing spent.
 */
function readSpentReloads(): SpentReloads[] | null {
  let raw: string | null
  try {
    raw = sessionStorage.getItem(CHUNK_RELOADS_KEY)
  } catch {
    return null
  }
  if (raw === null) return []
  try {
    const stored = JSON.parse(raw) as { builds?: unknown }
    if (!Array.isArray(stored.builds)) return []
    return stored.builds.flatMap((entry: unknown): SpentReloads[] => {
      const candidate = entry as { build?: unknown; urls?: unknown } | null
      if (typeof candidate?.build !== 'string' || !Array.isArray(candidate.urls)) return []
      return [
        {
          build: candidate.build,
          urls: candidate.urls.filter((url): url is string => typeof url === 'string'),
        },
      ]
    })
  } catch {
    return []
  }
}

/**
 * Spends the one automatic reload for `url` in this build.
 *
 * Answers false when it was spent already, or when the spending cannot be
 * written down. A reload the next document cannot see is how a chunk that fails
 * every time reloads forever.
 */
function spendReloadFor(url: string): boolean {
  const build = currentBuild()
  const remembered = readSpentReloads()
  if (remembered === null) return false
  const spent = remembered.find((entry) => entry.build === build)?.urls ?? []
  if (spent.includes(url)) return false
  const builds = [
    ...remembered.filter((entry) => entry.build !== build),
    { build, urls: [...spent, url].slice(-MAX_REMEMBERED_URLS) },
  ].slice(-MAX_REMEMBERED_BUILDS)
  try {
    sessionStorage.setItem(CHUNK_RELOADS_KEY, JSON.stringify({ builds }))
    return true
  } catch {
    return false
  }
}

/** Wraps a dynamic import so a stale chunk reloads the document once. */
export function recoverFromStaleChunk<T>(factory: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      // A success clears nothing: see "ONE RELOAD PER FAILING CHUNK" above.
      return await factory()
    } catch (error) {
      if (isStaleChunkError(error) && spendReloadFor(failedChunkUrl(error))) {
        window.location.reload()
        // Never resolves: React keeps the Suspense fallback up while the
        // document is being replaced, instead of flashing an error screen the
        // operator would only see for an instant.
        return new Promise<T>(() => {})
      }
      throw error
    }
  }
}

/** Drop-in for `React.lazy` that recovers from a stale chunk after a deploy. */
// The constraint is React's own (`lazy<T extends ComponentType<any>>`): anything
// narrower refuses every component that takes props.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyWithChunkRecovery<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return reactLazy(recoverFromStaleChunk(factory))
}

/**
 * A lazy component whose chunk can be fetched before anything renders it.
 *
 * `Component` behaves like `lazyWithChunkRecovery(factory)`, stale-chunk
 * reload included. `preload()` only downloads and evaluates the module. It
 * mounts nothing, never reloads the page and never rejects. That is the
 * `BG_LOADERS` / `prefetchBackground` arrangement of the glass backgrounds,
 * packaged for one component.
 *
 * A FAILED WARM-UP IS NOT RETRIED. The browser keeps a module whose fetch
 * failed as failed for the rest of the document's life (the HTML module map).
 * When `Component` renders, its own `import()` therefore rejects at once,
 * without a new request. That was measured in Chromium: a chunk that got an
 * HTTP 503 failed again on the second `import()` with 1 request at the server.
 * `recoverFromStaleChunk` treats the rejection as a stale chunk and reloads
 * the page once, and the fresh document fetches the chunk anew. If that
 * chunk already had its reload in this tab (same URL, same build), the error
 * goes to the error boundary instead. Either way nothing hangs. A cache-busting
 * re-import (`?retry=1`) would fetch again, but as a SECOND instance of the
 * module, with its own state. That is worse than one reload.
 *
 * One thing is new: once the module has arrived, `Component` renders it
 * WITHOUT suspending. `React.lazy` suspends on first render even when its
 * promise has already resolved, because it learns the result from `.then`,
 * which a native promise calls back a microtask later. React 19.2.8 then shows
 * the Suspense fallback for a frame, and holds back the re-render that reveals
 * the content until 300 ms after that fallback appeared
 * (`globalMostRecentFallbackTime + 300` in react-dom). A download finished
 * ahead of time would still cost 300 ms. So
 * when the module is already here, the factory hands `lazy` a thenable that
 * calls back synchronously. React 19's `lazy` then reads the module on the
 * spot: its initializer checks `_status` right after `.then` returns (see
 * `lazyInitializer` in react's production build). React's docs allow any
 * thenable for `lazy`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface PreloadableLazy<T extends ComponentType<any>> {
  readonly Component: LazyExoticComponent<T>
  /** Download and evaluate the chunk without rendering it. Never rejects, never reloads. */
  preload(): Promise<void>
  /** Whether the chunk has arrived — `Component` then renders without suspending. */
  isLoaded(): boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyWithPreload<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
): PreloadableLazy<T> {
  let loaded: { default: T } | null = null
  let inflight: Promise<{ default: T }> | null = null

  // One download however many callers ask. A failure is not kept here: the
  // next caller calls `factory` again, and the browser, not this wrapper,
  // decides what that `import()` does. For a module whose fetch failed, that is
  // to reject again at once (see above).
  const load = (): Promise<{ default: T }> => {
    inflight ??= factory().then(
      (module) => {
        loaded = module
        return module
      },
      (error: unknown) => {
        inflight = null
        throw error
      },
    )
    return inflight
  }
  const loadForRender = recoverFromStaleChunk(load)

  const Component = reactLazy((): Promise<{ default: T }> => {
    const ready = loaded
    if (ready === null) return loadForRender()
    const settled = {
      then(onFulfilled: (module: { default: T }) => unknown) {
        onFulfilled(ready)
      },
    }
    return settled as unknown as Promise<{ default: T }>
  })

  return {
    Component,
    preload: () => load().then(
      () => undefined,
      () => undefined,
    ),
    isLoaded: () => loaded !== null,
  }
}
