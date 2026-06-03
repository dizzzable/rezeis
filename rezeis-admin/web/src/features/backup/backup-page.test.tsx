import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'

import { usePermissionStore, type RbacAction } from '@/features/rbac'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import BackupPage from './backup-page'

describe('BackupPage RBAC gating', () => {
  beforeEach(() => {
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('does not fetch backup records without backups:view', async () => {
    const getSpy = vi.spyOn(api, 'get').mockResolvedValue({ data: { items: [], total: 0, limit: 50, offset: 0 } })
    grantPermissions([])

    renderWithProviders(<BackupPage />)

    expect(await screen.findByText('Backup access is restricted')).toBeInTheDocument()
    expect(getSpy).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Create Backup' })).not.toBeInTheDocument()
  })

  it('shows backup records read-only when write grants are absent', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        items: [
          {
            id: 'backup-1',
            filename: 'backup-1.sql.gz',
            scope: 'DB',
            sizeBytes: '4096',
            checksum: null,
            deliveryChannel: 'local',
            deliveryRecipient: null,
            deliveredAt: '2026-06-03T00:00:00.000Z',
            errorMessage: null,
            createdAt: '2026-06-03T00:00:00.000Z',
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
      },
    })
    grantPermissions([{ resource: 'backups', action: 'view' }])

    renderWithProviders(<BackupPage />)

    expect(await screen.findByText('backup-1.sql.gz')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create Backup' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
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
