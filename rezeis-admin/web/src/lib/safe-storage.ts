/**
 * Defensive localStorage wrapper for the admin SPA.
 *
 * `localStorage.setItem` throws `QuotaExceededError` in two situations:
 *   1. Safari Private Browsing — the quota is set to zero, every write throws.
 *      This was historically a WebKit bug. Even after the WebKit fix in
 *      Safari 10.1 the wrapper is still recommended because edge cases
 *      (mobile Safari with strict ITP, embedded WebViews) keep surfacing.
 *      See https://stackoverflow.com/q/14555347
 *   2. Operator-side: the per-origin storage quota was actually exceeded.
 *
 * `getItem` / `removeItem` can also throw on locked-down browsers (e.g.
 * "Block all cookies and site data" in Firefox makes accessing
 * `window.localStorage` itself raise `SecurityError`).
 *
 * This module centralizes the try/catch dance so the rest of the codebase
 * can rely on the wrapper and never crash a render because storage is
 * unavailable. Failures are silent on purpose: persisting UI preferences
 * is best-effort and should never break the operator workflow.
 */

function hasLocalStorage(): boolean {
  // `typeof window === 'undefined'` covers SSR / unit tests without jsdom.
  // Reading `window.localStorage` itself can throw `SecurityError`, so we
  // probe with a try/catch.
  if (typeof window === 'undefined') return false
  try {
    return typeof window.localStorage !== 'undefined' && window.localStorage !== null
  } catch {
    return false
  }
}

export function safeGetItem(key: string): string | null {
  if (!hasLocalStorage()) return null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function safeSetItem(key: string, value: string): boolean {
  if (!hasLocalStorage()) return false
  try {
    window.localStorage.setItem(key, value)
    return true
  } catch {
    // Quota exceeded (Safari Private mode, real quota overflow), or
    // SecurityError. Best-effort persistence; never throw.
    return false
  }
}

export function safeRemoveItem(key: string): boolean {
  if (!hasLocalStorage()) return false
  try {
    window.localStorage.removeItem(key)
    return true
  } catch {
    return false
  }
}

/**
 * Returns true when the wrapper believes localStorage is functional. Used
 * by features that may want to render a hint ("Your browser is in private
 * mode, settings won't persist").
 */
export function isStorageAvailable(): boolean {
  if (!hasLocalStorage()) return false
  // Probe with a write/read/remove cycle. Safari Private Browsing only
  // throws on `setItem`, so a probe is the only reliable detection.
  const probe = '__rezeis_storage_probe__'
  try {
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    return true
  } catch {
    return false
  }
}
