import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'

import { usePermissionStore } from '@/features/rbac'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import AuthProvidersTab from './auth-providers-tab'

describe('AuthProvidersTab RBAC gating', () => {
  beforeEach(() => {
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('does not fetch or render OAuth provider controls without auth_providers:view', async () => {
    const getSpy = vi.spyOn(api, 'get').mockResolvedValue({ data: [] })
    grantPermissions([])

    renderWithProviders(<AuthProvidersTab />)

    expect(await screen.findByText('Authentication provider access is restricted')).toBeInTheDocument()
    expect(getSpy).not.toHaveBeenCalled()
    expect(screen.queryByText('GitHub')).not.toBeInTheDocument()
  })

  it('shows provider status read-only when edit grant is absent', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: [providerConfig()] })
    grantPermissions([{ resource: 'auth_providers', action: 'view' }])

    renderWithProviders(<AuthProvidersTab />)

    expect(await screen.findByText('GitHub')).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Toggle GitHub' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })

  it('shows provider edit controls only with auth_providers:edit', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: [providerConfig()] })
    grantPermissions([
      { resource: 'auth_providers', action: 'view' },
      { resource: 'auth_providers', action: 'edit' },
    ])

    renderWithProviders(<AuthProvidersTab />)

    expect(await screen.findByText('GitHub')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Toggle GitHub' })).toBeInTheDocument()
  })
})

function grantPermissions(permissions: ReadonlyArray<{ resource: string; action: 'view' | 'edit' }>): void {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(permissions.map((permission) => `${permission.resource}:${permission.action}`)),
    mustChangePassword: false,
    role: 'ADMIN',
    rbacRoleId: 'role-1',
    error: null,
  })
}

function providerConfig() {
  return {
    id: 'provider-1',
    type: 'GITHUB',
    isEnabled: false,
    displayName: 'GitHub',
    clientId: 'client-id',
    frontendDomain: 'admin.example.com',
    backendDomain: 'https://api.example.com',
    authorizationUrl: null,
    tokenUrl: null,
    realm: null,
    providerDomain: null,
    usePkce: false,
    allowedEmails: [],
    allowedTelegramIds: [],
  }
}
