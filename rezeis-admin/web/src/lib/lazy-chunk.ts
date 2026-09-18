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
 * A `sessionStorage` flag makes it exactly one reload per session, so a chunk
 * that is genuinely broken shows the error screen instead of looping; the flag
 * is cleared by the next chunk that does load, so a later deploy can recover
 * again.
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
const CHUNK_RELOAD_KEY = 'reiwa:chunk-reload'

/** What a browser calls a chunk that is no longer on the server. */
const STALE_CHUNK_MESSAGE =
  /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|failed to load module script/i

/** Whether this error is a chunk the server no longer has, rather than a bug. */
export function isStaleChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return STALE_CHUNK_MESSAGE.test(message)
}

/**
 * `sessionStorage` can throw (Safari private mode, a locked-down webview), and
 * an explanation must never be the thing that breaks the page. Unreadable
 * storage means "no reload has happened yet", so the recovery still gets its
 * one attempt; an unwritable one means it may try again on the next failure,
 * which is the same page it was already about to reload.
 */
function readReloadFlag(): boolean {
  try {
    return sessionStorage.getItem(CHUNK_RELOAD_KEY) === '1'
  } catch {
    return false
  }
}

function writeReloadFlag(value: '1' | null): void {
  try {
    if (value === null) sessionStorage.removeItem(CHUNK_RELOAD_KEY)
    else sessionStorage.setItem(CHUNK_RELOAD_KEY, value)
  } catch {
    // See `readReloadFlag`.
  }
}

/** Wraps a dynamic import so a stale chunk reloads the document once. */
export function recoverFromStaleChunk<T>(factory: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      const module = await factory()
      writeReloadFlag(null)
      return module
    } catch (error) {
      if (isStaleChunkError(error) && !readReloadFlag()) {
        writeReloadFlag('1')
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
