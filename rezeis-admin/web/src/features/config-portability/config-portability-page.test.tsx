import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'

import { usePermissionStore, type RbacAction } from '@/features/rbac'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import ConfigPortabilityPage from './config-portability-page'

describe('ConfigPortabilityPage RBAC gating', () => {
  beforeEach(() => {
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('does not fetch config sections without config_portability:view', async () => {
    const getSpy = vi.spyOn(api, 'get').mockResolvedValue({ data: { sections: [] } })
    grantPermissions([])

    renderWithProviders(<ConfigPortabilityPage />)

    expect(await screen.findByText('Configuration portability access is restricted')).toBeInTheDocument()
    expect(getSpy).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Download JSON' })).not.toBeInTheDocument()
  })

  it('shows export sections read-only when export and import grants are absent', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: { sections: ['settings'] } })
    grantPermissions([{ resource: 'config_portability', action: 'view' }])

    renderWithProviders(<ConfigPortabilityPage />)

    expect(await screen.findByText('settings')).toBeInTheDocument()
    expect(screen.getByText('Configuration portability is read-only')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Download JSON' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('JSON file')).not.toBeInTheDocument()
  })
})

function grantPermissions(permissions: ReadonlyArray<{ resource: string; action: RbacAction }>): void {
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
