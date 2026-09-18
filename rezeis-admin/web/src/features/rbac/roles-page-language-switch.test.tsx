/**
 * English → Russian while a SYSTEM role is open, the way a browser does it.
 *
 * `changeLanguage` fires `languageChanged` at once and the Russian dictionaries
 * arrive later, through dynamic imports. The editor used to fill its fields in
 * that first render — from the fallback language, since Russian was not there
 * yet — and never again, so the fields stayed English and Save stored the
 * English description as the operator's own.
 *
 * This file starts in English with Russian NOT loaded: every vitest file gets
 * its own module graph, and nothing here loads Russian before the switch. The
 * precondition is asserted, so a warm dictionary cannot make it pass vacuously.
 */
import { Suspense } from 'react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { coreDictionaryReady, i18n, loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import RolesPage from './roles-page'
import { getResourceCatalog, getRole, listRoles, updateRole } from './rbac-api'
import type { RbacRole } from './rbac-types'
import { usePermissionStore } from './use-permission-store'

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

const SEED_DESCRIPTION = 'Повседневные операции: пользователи, подписки, платежи, поддержка, рассылки.'

const operator: RbacRole = {
  id: 'role-operator',
  name: 'operator',
  displayName: 'Operator',
  description: SEED_DESCRIPTION,
  isSystem: true,
  permissions: [{ resource: 'users', action: 'view' }],
  assignedAdminCount: 0,
  createdAt: '2026-06-04T10:00:00.000Z',
  updatedAt: '2026-06-04T10:00:00.000Z',
}

beforeAll(async () => {
  await Promise.all([coreDictionaryReady('en'), loadFeatureBundle('rbac')])
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set<string>(),
    mustChangePassword: false,
    role: 'DEV',
    rbacRoleId: null,
    error: null,
  })
  vi.mocked(getResourceCatalog).mockResolvedValue({ actions: ['view'], resources: { users: ['view'] } })
  vi.mocked(listRoles).mockResolvedValue([{ ...operator, permissionsCount: 1 }])
  vi.mocked(getRole).mockResolvedValue(operator)
  vi.mocked(updateRole).mockImplementation(async (id, payload) => ({ ...operator, id, ...payload }))
})

afterAll(async () => {
  usePermissionStore.getState().reset()
  await i18n.changeLanguage('en')
})

describe('switching to a language whose dictionaries have not arrived', () => {
  it('shows the untouched name in the new language, keeps what was typed, and saves only what was typed', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <Suspense fallback={<p>loading the roles page</p>}>
        <RolesPage />
      </Suspense>,
    )
    const name = await screen.findByDisplayValue('Operator')
    const description = screen.getByDisplayValue(/^Day-to-day work/)

    // The operator changes the description and leaves the name alone.
    await user.clear(description)
    await user.type(description, 'Смена с восьми до восьми')

    // Precondition: Russian really is not there yet.
    expect(i18n.hasResourceBundle('ru', 'translation')).toBe(false)

    act(() => {
      void i18n.changeLanguage('ru')
    })
    // Before the dictionaries land: never a key path on the page.
    expect(document.body.textContent).not.toContain('rolesPage.')

    await act(async () => {
      await Promise.all([coreDictionaryReady('ru'), loadFeatureBundle('rbac')])
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // The untouched field follows the language; the touched one keeps its text.
    await waitFor(() => expect(name).toHaveValue('Оператор'))
    expect(screen.getByDisplayValue('Смена с восьми до восьми')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('rolesPage.')

    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(updateRole).toHaveBeenCalledTimes(1))
    // The name is stored as it is stored, not as it is shown in Russian.
    expect(vi.mocked(updateRole).mock.calls[0]).toEqual([
      'role-operator',
      { displayName: 'Operator', description: 'Смена с восьми до восьми', permissions: [] },
    ])
  })
})
