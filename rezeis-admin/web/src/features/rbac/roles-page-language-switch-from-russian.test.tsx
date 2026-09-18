/**
 * Russian → English while a role is open, English not loaded yet.
 *
 * English is the fallback language, so until its dictionaries arrive there is
 * nothing to fall back TO: every `t()` answers with its key path. The editor
 * used to fill its fields in that render and keep them — the reviewer saw
 * `rolesPage.systemRoles.operator.name` in the name field, and Save renamed
 * the role to it for everyone. And any switch threw away what the operator had
 * typed and ticked, because the fields were reset on every language change.
 *
 * This file starts in Russian — the stored locale is set before the i18n
 * module loads — and nothing here loads English before the switch.
 */
import { Suspense } from 'react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { coreDictionaryReady, i18n, loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import RolesPage from './roles-page'
import { getResourceCatalog, getRole, listRoles, updateRole } from './rbac-api'
import type { RbacRole } from './rbac-types'
import { usePermissionStore } from './use-permission-store'

vi.hoisted(() => {
  window.localStorage.setItem('rezeis.admin.locale', 'ru')
})

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

const custom: RbacRole = {
  id: 'role-night',
  name: 'night_shift',
  displayName: 'Ночная смена',
  description: null,
  isSystem: false,
  permissions: [{ resource: 'users', action: 'view' }],
  assignedAdminCount: 0,
  createdAt: '2026-06-04T10:00:00.000Z',
  updatedAt: '2026-06-04T10:00:00.000Z',
}

const operator: RbacRole = {
  ...custom,
  id: 'role-operator',
  name: 'operator',
  displayName: 'Operator',
  description: 'Повседневные операции: пользователи, подписки, платежи, поддержка, рассылки.',
  isSystem: true,
}

beforeAll(async () => {
  await Promise.all([coreDictionaryReady('ru'), loadFeatureBundle('rbac')])
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set<string>(),
    mustChangePassword: false,
    role: 'DEV',
    rbacRoleId: null,
    error: null,
  })
  vi.mocked(getResourceCatalog).mockResolvedValue({ actions: ['view', 'edit'], resources: { users: ['view', 'edit'] } })
  vi.mocked(listRoles).mockResolvedValue([
    { ...custom, permissionsCount: 1 },
    { ...operator, permissionsCount: 1 },
  ])
  vi.mocked(getRole).mockImplementation(async (id) => (id === operator.id ? operator : custom))
  vi.mocked(updateRole).mockImplementation(async (id, payload) => ({ ...custom, id, ...payload }))
})

afterAll(() => {
  usePermissionStore.getState().reset()
  window.localStorage.removeItem('rezeis.admin.locale')
})

describe('switching from Russian to English that has not arrived', () => {
  it('keeps every edit, and never shows or saves a key path', async () => {
    expect(i18n.language).toBe('ru')
    const user = userEvent.setup()
    renderWithProviders(
      <Suspense fallback={<p>loading the roles page</p>}>
        <RolesPage />
      </Suspense>,
    )
    const name = await screen.findByDisplayValue('Ночная смена')

    await user.clear(name)
    await user.type(name, 'Ночная смена 2')
    await user.click(screen.getByRole('checkbox', { name: 'Пользователи: Изменение' }))

    // Precondition: English really is not there yet.
    expect(i18n.hasResourceBundle('en', 'translation')).toBe(false)

    act(() => {
      void i18n.changeLanguage('en')
    })
    expect(document.body.textContent).not.toContain('rolesPage.')

    await act(async () => {
      await Promise.all([coreDictionaryReady('en'), loadFeatureBundle('rbac')])
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // English now, and the operator's edits are still there.
    const save = await screen.findByRole('button', { name: 'Save' })
    expect(name).toHaveValue('Ночная смена 2')
    expect(screen.getByRole('checkbox', { name: 'Users: Edit' })).toBeChecked()
    // The system role in the list reads in English, not as its key path. (The
    // editor is on the custom role, so the list is the only place it shows.)
    const operatorButton = screen.getByText('Operator').closest('button')!
    expect(within(operatorButton).getByText(/^Day-to-day work/)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('rolesPage.')

    await user.click(save)
    await waitFor(() => expect(updateRole).toHaveBeenCalledTimes(1))
    expect(vi.mocked(updateRole).mock.calls[0][1]).toEqual({
      displayName: 'Ночная смена 2',
      description: null,
      permissions: [
        { resource: 'users', action: 'view' },
        { resource: 'users', action: 'edit' },
      ],
    })
  })
})
