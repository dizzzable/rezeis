import { describe, expect, it, vi, beforeAll, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { usePermissionStore } from '@/features/rbac'
import { loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import { settingsApi } from './settings-api'
import { ApiTokensPage } from './api-tokens-page'

describe('ApiTokensPage RBAC gating', () => {
  beforeAll(async () => {
    await loadFeatureBundle('platformSettings')
  })

  beforeEach(() => {
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('does not fetch or render token management controls without api_tokens:view', async () => {
    const listSpy = vi.spyOn(settingsApi, 'listApiTokens').mockResolvedValue([])
    grantPermissions([])

    renderWithProviders(<ApiTokensPage />)

    expect(await screen.findByText('API token access is restricted')).toBeInTheDocument()
    expect(listSpy).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Create API token' })).not.toBeInTheDocument()
  })

  it('shows read-only token list when create and delete grants are absent', async () => {
    vi.spyOn(settingsApi, 'listApiTokens').mockResolvedValue([
      {
        id: 'token-1',
        name: 'Reiwa',
        prefix: 'abcdef',
        audience: 'rezeis-internal-api',
        createdBy: 'admin-1',
        lastUsedAt: null,
        expiresAt: '2026-12-01T00:00:00.000Z',
        createdAt: '2026-06-03T00:00:00.000Z',
      },
    ])
    grantPermissions([{ resource: 'api_tokens', action: 'view' }])

    renderWithProviders(<ApiTokensPage />)

    expect(await screen.findByText('Reiwa')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create API token' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument()
  })

  it('shows create and revoke controls only with matching grants', async () => {
    vi.spyOn(settingsApi, 'listApiTokens').mockResolvedValue([
      {
        id: 'token-1',
        name: 'Reiwa',
        prefix: 'abcdef',
        audience: 'rezeis-internal-api',
        createdBy: 'admin-1',
        lastUsedAt: null,
        expiresAt: '2026-12-01T00:00:00.000Z',
        createdAt: '2026-06-03T00:00:00.000Z',
      },
    ])
    grantPermissions([
      { resource: 'api_tokens', action: 'view' },
      { resource: 'api_tokens', action: 'create' },
      { resource: 'api_tokens', action: 'delete' },
    ])

    renderWithProviders(<ApiTokensPage />)

    expect(await screen.findByText('Reiwa')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create API token' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument()
  })

  it('names the one-time API token copy action for assistive technology', async () => {
    const user = userEvent.setup()
    vi.spyOn(settingsApi, 'listApiTokens').mockResolvedValue([])
    vi.spyOn(settingsApi, 'createApiToken').mockResolvedValue({
      id: 'token-1',
      name: 'Reiwa',
      token: 'ruid.test.secret',
      prefix: 'ruid',
      expiresAt: '2026-12-01T00:00:00.000Z',
      createdAt: '2026-06-03T00:00:00.000Z',
    })
    grantPermissions([
      { resource: 'api_tokens', action: 'view' },
      { resource: 'api_tokens', action: 'create' },
    ])

    renderWithProviders(<ApiTokensPage />)

    await user.type(screen.getByLabelText('Token name'), 'Reiwa')
    await user.click(screen.getByRole('button', { name: 'Create API token' }))

    expect(await screen.findByRole('button', { name: 'Copy' })).toBeInTheDocument()
  })
})

function grantPermissions(permissions: ReadonlyArray<{ resource: string; action: 'view' | 'create' | 'delete' }>): void {
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
