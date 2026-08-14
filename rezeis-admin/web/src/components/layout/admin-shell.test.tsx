import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router'

import AdminShell from '@/components/layout/admin-shell'
import { useSidebarStore } from '@/stores/sidebar-store'
import { renderWithProviders } from '@/test/test-utils'

vi.mock('@/lib/realtime/use-realtime-updates', () => ({
  useRealtimeUpdates: vi.fn(),
}))

vi.mock('@/components/quick-search/quick-search-overlay', () => ({
  QuickSearchOverlay: () => null,
}))

vi.mock('@/features/update-checker/update-banner', () => ({
  UpdateBanner: () => null,
}))

vi.mock('@/components/layout/admin-topbar/update-indicator', () => ({
  UpdateIndicator: () => null,
}))

vi.mock('@/features/auth/auth-provider', () => ({
  useAuth: () => ({
    admin: { login: 'admin' },
    logout: vi.fn(),
  }),
}))

const pushMocks = vi.hoisted(() => ({
  ensurePushSubscription: vi.fn().mockResolvedValue('subscribed'),
  hasPushOptOut: vi.fn().mockReturnValue(false),
}))

vi.mock('@/lib/push', () => pushMocks)

describe('AdminShell accessibility baseline', () => {
  afterEach(() => {
    cleanup()
    useSidebarStore.getState().resetOrder()
    window.localStorage.clear()
  })

  it('exposes landmarks and a skip link to the admin workspace', async () => {
    renderShell()

    const skipLink = screen.getByRole('link', { name: 'Skip to main content' })
    const main = screen.getByRole('main', { name: 'Admin workspace' })

    expect(screen.getByRole('banner', { name: 'Admin toolbar' })).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Admin sidebar' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument()
    expect(main).toHaveAttribute('id', 'admin-main-content')
    expect(main).toHaveAttribute('tabindex', '-1')

    await userEvent.tab()
    expect(skipLink).toHaveFocus()

    fireEvent.click(skipLink)
    expect(main).toHaveFocus()
  })

  it('names icon-only shell controls', () => {
    renderShell()

    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Admin account menu' })).toBeInTheDocument()
  })
})

/**
 * Rendering this shell is the panel's "an admin is signed in" signal, and it is
 * where the push subscription now re-registers itself. Before that, the only
 * caller was the notification settings tab, so an admin whose row the fanout
 * pruned after a 410 — or whose endpoint another admin had claimed — stopped
 * receiving push and stayed that way until they happened to open that tab.
 *
 * The two guards are what these tests are really about. Healing on every mount
 * would re-register on each route change, and healing past an explicit opt-out
 * would switch push back on for someone who deliberately switched it off. Both
 * are the kind of mistake that is invisible in a browser and obvious here.
 */
describe('AdminShell push healing', () => {
  afterEach(() => {
    cleanup()
    window.sessionStorage.clear()
    pushMocks.ensurePushSubscription.mockClear()
    pushMocks.hasPushOptOut.mockReturnValue(false)
  })

  it('re-registers the subscription once when the shell first renders', () => {
    renderShell()

    expect(pushMocks.ensurePushSubscription).toHaveBeenCalledTimes(1)
  })

  it('does not re-register again in the same session', () => {
    renderShell()
    cleanup()
    renderShell()

    expect(pushMocks.ensurePushSubscription).toHaveBeenCalledTimes(1)
  })

  it('leaves push alone when the operator turned it off on this device', () => {
    pushMocks.hasPushOptOut.mockReturnValue(true)

    renderShell()

    expect(pushMocks.ensurePushSubscription).not.toHaveBeenCalled()
  })
})

function renderShell(): void {
  renderWithProviders(
    <Routes>
      <Route element={<AdminShell />}>
        <Route index element={<h1>Workspace</h1>} />
      </Route>
    </Routes>,
  )
}
