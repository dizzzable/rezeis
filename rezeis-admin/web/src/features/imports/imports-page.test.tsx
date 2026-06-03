import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'

import { usePermissionStore, type RbacAction } from '@/features/rbac'
import { loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import ImportsPage from './imports-page'

describe('ImportsPage RBAC gating', () => {
  beforeAll(async () => {
    await loadFeatureBundle('imports')
  })

  beforeEach(() => {
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('does not fetch or render imports without imports:view', async () => {
    const getSpy = vi.spyOn(api, 'get').mockResolvedValue({ data: { items: [] } })
    grantPermissions([])

    renderWithProviders(<ImportsPage />)

    expect(await screen.findByText('Import access is restricted')).toBeInTheDocument()
    expect(getSpy).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Import' })).not.toBeInTheDocument()
  })

  it('shows import history read-only when import and run grants are absent', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        items: [
          {
            id: 'import-1',
            filename: 'import.json',
            sourceType: 'remnawave',
            status: 'COMMITTED',
            recordsTotal: 2,
            recordsOk: 2,
            recordsFailed: 0,
            errorMessage: null,
            createdAt: '2026-06-03T00:00:00.000Z',
            committedAt: '2026-06-03T00:01:00.000Z',
          },
        ],
      },
    })
    grantPermissions([{ resource: 'imports', action: 'view' }])

    renderWithProviders(<ImportsPage />)

    expect(await screen.findByText('Import history is read-only')).toBeInTheDocument()
    expect(await screen.findByText('remnawave')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Import' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Run sync' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Select file' })).not.toBeInTheDocument()
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
