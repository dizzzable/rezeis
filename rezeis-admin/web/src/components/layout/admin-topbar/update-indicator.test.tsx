import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { UpdateIndicator } from '@/components/layout/admin-topbar/update-indicator'
import { usePermissionStore } from '@/features/rbac'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

/**
 * «⚠ Кабинет старше панели» in the updates menu (pair reliability, 26.09.2026).
 *
 * The panel's update status says whether the connected cabinet lacks something
 * this panel expects (`components.reiwa.behindPanel`). Then the icon gets an
 * amber badge and the menu a line that opens «WEB Reiwa», where the block at
 * the top lists what does not work — whether or not Reiwa's releases are
 * tracked, and only for an operator who can read that block (`settings:view`,
 * review R1-13). A panel older than the field sends none: nothing changes.
 */

function component(overrides: Record<string, unknown> = {}) {
  return {
    current: '0.9.7.71',
    latest: '0.9.7.71',
    hasUpdate: false,
    publishedAt: null,
    htmlUrl: null,
    notes: null,
    checkedAt: '2026-09-26T12:00:00.000Z',
    source: 'github',
    error: null,
    ...overrides,
  }
}

function status(reiwa: Record<string, unknown>) {
  const panel = component()
  return { data: { ...panel, components: { panel, reiwa } } }
}

/** The operator's grants, as the permission store holds them after sign-in. Not 'DEV': it passes every check. */
function grant(tokens: readonly string[]): void {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(tokens),
    mustChangePassword: false,
    role: 'ADMIN',
    rbacRoleId: null,
    error: null,
  })
}

async function openMenu(): Promise<void> {
  renderWithProviders(<UpdateIndicator />)
  await userEvent.click(await screen.findByRole('button', { name: /updates|обновлени/i }))
}

describe('UpdateIndicator: a cabinet older than the panel', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    usePermissionStore.getState().reset()
  })

  it('shows an amber badge and a line that opens «WEB Reiwa»', async () => {
    grant(['settings:view'])
    vi.spyOn(api, 'get').mockResolvedValue(status(component({ current: '0.9.7.52', behindPanel: true })) as never)
    renderWithProviders(<UpdateIndicator />)
    const badge = await screen.findByTestId('update-indicator-badge')
    expect(badge.className).toContain('bg-amber-500')
    cleanup()

    await openMenu()
    const line = await screen.findByTestId('update-indicator-cabinet-behind')
    expect(line).toHaveAttribute('href', '/web-reiwa')
    expect(line).toHaveTextContent('The cabinet is older than the panel')
  })

  it('says so even when Reiwa’s releases are not tracked', async () => {
    grant(['settings:view'])
    vi.spyOn(api, 'get').mockResolvedValue(status(component({ source: 'unknown', behindPanel: true })) as never)
    await openMenu()
    expect(await screen.findByTestId('update-indicator-cabinet-behind')).toHaveAttribute('href', '/web-reiwa')
  })

  it('shows neither the line nor the dot to an operator who cannot read the block (review R1-13)', async () => {
    grant(['users:view'])
    vi.spyOn(api, 'get').mockResolvedValue(status(component({ current: '0.9.7.52', behindPanel: true })) as never)
    await openMenu()
    await screen.findByText('Reiwa (cabinet)')
    expect(screen.queryByTestId('update-indicator-cabinet-behind')).toBeNull()
    expect(screen.queryByTestId('update-indicator-badge')).toBeNull()
  })

  it('stays as it was for a cabinet that is not behind, and for a panel that does not say', async () => {
    grant(['settings:view'])
    for (const reiwa of [component({ behindPanel: false }), component()]) {
      vi.spyOn(api, 'get').mockResolvedValue(status(reiwa) as never)
      await openMenu()
      await screen.findByText('Reiwa (cabinet)')
      expect(screen.queryByTestId('update-indicator-cabinet-behind')).toBeNull()
      expect(screen.queryByTestId('update-indicator-badge')).toBeNull()
      cleanup()
      vi.restoreAllMocks()
    }
  })
})
