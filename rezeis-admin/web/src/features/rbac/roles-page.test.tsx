import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/test-utils';
import RolesPage from './roles-page';
import {
  createRole,
  deleteRole,
  getResourceCatalog,
  getRole,
  listRoles,
  syncSystemRoles,
  updateRole,
} from './rbac-api';

vi.mock('./rbac-api', () => ({
  createRole: vi.fn(),
  deleteRole: vi.fn(),
  getEffectivePermissions: vi.fn(),
  getResourceCatalog: vi.fn(),
  getRole: vi.fn(),
  listRoles: vi.fn(),
  syncSystemRoles: vi.fn(),
  updateRole: vi.fn(),
}))

describe('RolesPage accessibility', () => {
  beforeEach(() => {
    vi.mocked(listRoles).mockResolvedValue([
      {
        id: 'role-1',
        name: 'support_lead',
        displayName: 'Support Lead',
        description: 'Support team role',
        isSystem: false,
        permissionsCount: 1,
        assignedAdminCount: 0,
        createdAt: '2026-06-04T10:00:00.000Z',
        updatedAt: '2026-06-04T10:00:00.000Z',
      },
    ])
    vi.mocked(getRole).mockResolvedValue({
      id: 'role-1',
      name: 'support_lead',
      displayName: 'Support Lead',
      description: 'Support team role',
      isSystem: false,
      permissions: [{ resource: 'users', action: 'view' }],
      assignedAdminCount: 0,
      createdAt: '2026-06-04T10:00:00.000Z',
      updatedAt: '2026-06-04T10:00:00.000Z',
    })
    vi.mocked(getResourceCatalog).mockResolvedValue({
      actions: ['view', 'edit'],
      resources: {
        users: ['view', 'edit'],
      },
    })
    vi.mocked(createRole).mockResolvedValue({} as never)
    vi.mocked(deleteRole).mockResolvedValue(undefined)
    vi.mocked(syncSystemRoles).mockResolvedValue(undefined)
    vi.mocked(updateRole).mockResolvedValue({} as never)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('uses an accessible alert dialog before deleting a custom role', async () => {
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    renderWithProviders(<RolesPage />)

    await screen.findByDisplayValue('Support Lead')
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    const dialog = await screen.findByRole('alertdialog', { name: 'Delete' })
    expect(dialog).toHaveTextContent('Delete role "Support Lead"?')
    expect(deleteRole).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(deleteRole).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(deleteRole).toHaveBeenCalledWith('role-1')
    })
    expect(confirmSpy).not.toHaveBeenCalled()
  })
})
