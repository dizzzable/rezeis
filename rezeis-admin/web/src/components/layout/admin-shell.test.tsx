import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'

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

function renderShell(): void {
  renderWithProviders(
    <Routes>
      <Route element={<AdminShell />}>
        <Route index element={<h1>Workspace</h1>} />
      </Route>
    </Routes>,
  )
}
