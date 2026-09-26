/**
 * When the admin shell starts downloading at boot.
 *
 * The shell is lazy so that /sign-in does not download it (`app/router.tsx`).
 * Lazy alone would add a round trip after the session check, so a tab whose
 * first screen IS the shell starts fetching it right before the first render,
 * alongside the session check (`main.tsx` → `warmAdminShellForFirstScreen`).
 * These tests pin the one decision that matters: which first screens warm and
 * which do not. A wrong "yes" puts the shell back on /sign-in; a wrong "no"
 * brings the round trip back.
 */
import { matchRoutes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The router's only use of the i18n module is `withFeatureBundle` around lazy
// pages, which only runs when a page renders; the real module would load a
// whole dictionary on import.
vi.mock('@/i18n/i18n', () => ({
  withFeatureBundle: (_feature: unknown, importer: () => Promise<unknown>) => importer,
}))

import { ADMIN_SHELL_ROUTE_ID, shouldWarmAdminShellAtBoot } from './admin-shell-loader'

afterEach(() => {
  window.history.replaceState(null, '', '/')
  vi.restoreAllMocks()
  delete (navigator as unknown as Record<string, unknown>).onLine
})

describe('shouldWarmAdminShellAtBoot', () => {
  it('warms only with a stored session on a route under the shell', () => {
    const underShell = ['root', ADMIN_SHELL_ROUTE_ID, 'users']
    expect(shouldWarmAdminShellAtBoot({ hasSession: true, routeIds: underShell, offline: false })).toBe(true)
    // No session: the protected routes bounce to /sign-in, which has no shell.
    expect(shouldWarmAdminShellAtBoot({ hasSession: false, routeIds: underShell, offline: false })).toBe(false)
    // A session, but a first screen without the shell.
    expect(shouldWarmAdminShellAtBoot({ hasSession: true, routeIds: ['sign-in'], offline: false })).toBe(false)
    expect(shouldWarmAdminShellAtBoot({ hasSession: true, routeIds: [], offline: false })).toBe(false)
    // The browser reports offline: the fetch would fail for certain and leave a
    // failed module record behind, which later costs a page reload.
    expect(shouldWarmAdminShellAtBoot({ hasSession: true, routeIds: underShell, offline: true })).toBe(false)
  })
})

describe('the real route table', () => {
  /** Route ids of the branch `pathname` renders, from the router's own config. */
  async function branchOf(pathname: string): Promise<Array<string | undefined>> {
    const { routes } = await import('./router')
    return (matchRoutes(routes, pathname) ?? []).map((match) => match.route.id)
  }

  it.each(['/', '/users', '/users/12345', '/settings/panel', '/bot-config', '/notifications/inbox'])(
    'puts %s under the shell',
    async (pathname) => {
      expect(await branchOf(pathname)).toContain(ADMIN_SHELL_ROUTE_ID)
    },
  )

  it.each(['/sign-in', '/change-password', '/no-such-page'])(
    'keeps %s out of the shell — nothing to warm there',
    async (pathname) => {
      expect(await branchOf(pathname)).not.toContain(ADMIN_SHELL_ROUTE_ID)
    },
  )
})

describe('warmAdminShellForFirstScreen', () => {
  /**
   * A fresh router created at `pathname`, as `createBrowserRouter` does on a
   * real boot, with `token` in the auth store; returns the preload spy.
   */
  async function bootAt(pathname: string, token: string) {
    vi.resetModules()
    window.history.replaceState(null, '', pathname)
    const { useAuthStore } = await import('@/stores/auth-store')
    useAuthStore.setState({ token })
    const loader = await import('./admin-shell-loader')
    const preload = vi.spyOn(loader.adminShell, 'preload').mockResolvedValue(undefined)
    const { warmAdminShellForFirstScreen } = await import('./router')
    warmAdminShellForFirstScreen()
    return preload
  }

  it('starts the download when a signed-in operator opens a page of the panel', async () => {
    expect(await bootAt('/users/12345', 'session-token-fixture')).toHaveBeenCalledTimes(1)
  })

  it('leaves /sign-in alone, session or not', async () => {
    expect(await bootAt('/sign-in', 'session-token-fixture')).not.toHaveBeenCalled()
    expect(await bootAt('/sign-in', '')).not.toHaveBeenCalled()
  })

  it('leaves a panel page alone when there is no session — it is about to redirect to /sign-in', async () => {
    expect(await bootAt('/users', '')).not.toHaveBeenCalled()
  })

  it('leaves it alone while the browser reports offline, and does not read online as a promise', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    expect(await bootAt('/users/12345', 'session-token-fixture')).not.toHaveBeenCalled()
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    expect(await bootAt('/users/12345', 'session-token-fixture')).toHaveBeenCalledTimes(1)
  })
})
