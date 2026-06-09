/**
 * Deep-link return target. When an unauthenticated admin opens a push
 * deep-link (e.g. `/support-tickets?ticket=…`), the auth guard captures the
 * intended path here before redirecting to login; the login flow consumes it
 * and navigates back after a successful sign-in.
 */
const KEY = 'rezeis-admin:returnTo'

export function captureReturnTo(path: string): void {
  if (!path || path === '/' || path.startsWith('/login') || path.startsWith('/sign-in')) return
  try {
    sessionStorage.setItem(KEY, path)
  } catch {
    /* storage unavailable */
  }
}

export function consumeReturnTo(): string | null {
  try {
    const value = sessionStorage.getItem(KEY)
    if (value) sessionStorage.removeItem(KEY)
    return value
  } catch {
    return null
  }
}
