import type { JSX } from 'react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation } from 'react-router'

import { navItemMap } from '@/components/layout/admin-nav-config'
import { usePermissionStore } from '@/features/rbac/use-permission-store'
import { loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'

import { DashboardQuickActions } from './dashboard-quick-actions'

/**
 * Every quick action is a side-menu item, gated and routed exactly as the menu
 * does it (`admin-nav-config.ts`). «Аналитика» used to show to every role and
 * open five «Не удалось загрузить данные» without `analytics:view`; «Импорт»
 * led to «Платформа».
 */

function Where(): JSX.Element {
  return <output data-testid="where">{useLocation().pathname}</output>
}

function render(): void {
  renderWithProviders(
    <>
      <DashboardQuickActions />
      <Where />
    </>,
  )
}

const labels = (): string[] =>
  screen.queryAllByRole('button').map((button) => button.getAttribute('aria-label') ?? '')

beforeAll(async () => {
  await loadFeatureBundle('dashboard')
})

afterEach(() => {
  usePermissionStore.getState().reset()
})

describe('DashboardQuickActions', () => {
  it('offers only what the operator’s role may open — the side menu’s gate for the same page', () => {
    usePermissionStore.setState({ loaded: true, role: 'ADMIN', granted: new Set(['broadcasts:view']) })
    render()

    // Every other page needs what this role lacks: `payments:view`, `users:view` (or a tab's own
    // right), `imports:view`, `analytics:view`, `settings:view`. «Пользователи» and «Настройки» used
    // to be offered anyway — their menu items carried no permission.
    expect(labels()).toEqual(['Create broadcast'])
  })

  it('offers a page once the role holds exactly the menu’s permission for it', () => {
    usePermissionStore.setState({ loaded: true, role: 'ADMIN', granted: new Set(['analytics:view']) })
    render()

    expect(labels()).toEqual(['Analytics'])
    expect(navItemMap.get('analytics')?.requiredPermission).toEqual({ resource: 'analytics', action: 'view' })
  })

  it('offers «Пользователи» to a role that can work only one tab of the page, as the menu does', () => {
    usePermissionStore.setState({ loaded: true, role: 'ADMIN', granted: new Set(['users:bulk_operations']) })
    render()

    expect(labels()).toEqual(['Users'])
  })

  it('offers the operator’s role what its permissions open — and not «Настройки», which it cannot read', () => {
    usePermissionStore.setState({
      loaded: true,
      role: 'ADMIN',
      granted: new Set(['users:view', 'payments:view', 'broadcasts:view', 'broadcasts:create', 'analytics:view']),
    })
    render()

    expect(labels()).toEqual(['Create broadcast', 'Payments', 'Users', 'Analytics'])
  })

  it('offers everything to a DEV admin, as the menu does', () => {
    usePermissionStore.setState({ loaded: true, role: 'DEV', granted: new Set() })
    render()
    expect(labels()).toEqual(['Create broadcast', 'Payments', 'Users', 'Import', 'Analytics', 'Settings'])
  })

  it('offers everything while the permissions are still loading, as the menu does', () => {
    usePermissionStore.setState({ loaded: false, role: null, granted: new Set() })
    render()
    expect(labels()).toEqual(['Create broadcast', 'Payments', 'Users', 'Import', 'Analytics', 'Settings'])
  })

  it('leads every button where its menu item leads', async () => {
    const user = userEvent.setup()
    usePermissionStore.setState({ loaded: true, role: 'DEV', granted: new Set() })
    render()

    const expected: Record<string, string> = {
      'Create broadcast': '/broadcast',
      Payments: '/payments',
      Users: '/users',
      Import: '/imports',
      Analytics: '/analytics',
      Settings: '/settings',
    }
    const visited: Record<string, string> = {}
    for (const label of Object.keys(expected)) {
      await user.click(screen.getByRole('button', { name: label }))
      visited[label] = screen.getByTestId('where').textContent ?? ''
    }
    expect(visited).toEqual(expected)
  })
})
