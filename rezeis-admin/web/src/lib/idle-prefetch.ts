/**
 * Warm a lazily loaded chunk WITHOUT mounting it, once the browser is idle.
 *
 * Only the download and the module evaluation: `load` is a raw importer (never
 * the `lazy()` component, whose only trigger is rendering it), so nothing is
 * mounted, no canvas or GL context is created, no effect runs.
 *
 * A failed warm-up is swallowed here, but it is NOT retried later. The browser
 * keeps a module whose fetch failed as failed for the life of the document
 * (the HTML module map). When the component renders, its own `import()`
 * rejects at once, without a new request. That was measured in Chromium with
 * an HTTP 503. For a component made with `lib/lazy-chunk.ts`, which is every
 * `lazy()` here, that rejection reloads the page once, and the fresh document
 * fetches anew. If that chunk already had its reload in this tab, the error
 * boundary shows the failure instead. That is also why nothing is warmed while the
 * browser reports offline (`browserReportsOffline`).
 *
 * iOS Safari has no `requestIdleCallback`; a timeout keeps the behaviour close
 * enough without competing with whatever the page is doing right now.
 *
 * First written for the glass backgrounds on the sign-in screen
 * (`components/glass/GlassBackground.tsx`) and shared since the admin shell
 * started warming the same way (`app/admin-shell-loader.ts`).
 *
 * `timeout` bounds the wait for idle time. The default of 4 s suits a warm-up
 * nobody is waiting for (the backgrounds). A warm-up that answers something
 * the operator just did passes less: idle time can take seconds to arrive on
 * a busy page, and in a hidden one it did not arrive within 1.5 s at all in a
 * measured run.
 *
 * @returns a cancel function — call it when the reason to warm has gone.
 */
export function prefetchWhenIdle(
  load: () => Promise<unknown>,
  { timeout = 4_000 }: { readonly timeout?: number } = {},
): () => void {
  let cancelled = false
  const run = (): void => {
    // Checked when the warm-up would start, not when it was scheduled: the
    // connection can drop in between.
    if (cancelled || browserReportsOffline()) return
    void load().catch(() => {
      // See above: the render's own import fails too, and the stale-chunk
      // recovery reloads once. Nothing to do here.
    })
  }
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(run, { timeout })
    return () => {
      cancelled = true
      cancelIdleCallback(handle)
    }
  }
  const handle = setTimeout(run, Math.min(2_000, timeout))
  return () => {
    cancelled = true
    clearTimeout(handle)
  }
}

/**
 * Whether the operator asked the browser to save data (`Save-Data`, Chrome's
 * Lite mode, Android data saver). Speculative downloads skip themselves then;
 * what the current screen needs still loads.
 */
export function saveDataRequested(): boolean {
  if (typeof navigator === 'undefined') return false
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
  return connection?.saveData === true
}

/**
 * Whether the browser says it is offline. Warm-ups skip themselves then.
 *
 * Only `false` from `navigator.onLine` means anything. `true` says a network
 * interface is up, not that the panel is reachable, so it is "unknown" and
 * gates nothing.
 *
 * A warm-up started offline fails for certain, and a failed fetch is worse than
 * none: the browser keeps the failed module record, so the component's own
 * import would fail from it later even with the network back. That costs a page
 * reload (see the header). Not warming leaves the render to fetch the chunk
 * normally once the connection returns.
 */
export function browserReportsOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}
