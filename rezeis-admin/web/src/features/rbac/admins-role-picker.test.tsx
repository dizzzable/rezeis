/**
 * The role picker on the Administrators page names system roles the way the
 * Roles tab does.
 *
 * It printed `displayName` as stored, and the four system roles are stored with
 * the backend seed's English names — so a Russian owner assigned «Operator»
 * from a list whose every other word was Russian, and could not match it to
 * «Оператор» on the Roles tab next door.
 *
 * This file runs in Russian: the stored locale is set before the i18n module
 * loads.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { coreDictionaryReady, i18n } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import AdminsPage from '@/features/admins/admins-page'

vi.hoisted(() => {
  window.localStorage.setItem('rezeis.admin.locale', 'ru')
})

vi.mock('@/lib/api', () => ({
  api: { delete: vi.fn(), get: vi.fn(), patch: vi.fn(), post: vi.fn() },
}))

const ROLES = [
  {
    id: 'role-operator',
    name: 'operator',
    displayName: 'Operator',
    description: 'Повседневные операции: пользователи, подписки, платежи, поддержка, рассылки.',
    isSystem: true,
    permissionsCount: 40,
    assignedAdminCount: 1,
    createdAt: '2026-06-04T10:00:00.000Z',
    updatedAt: '2026-06-04T10:00:00.000Z',
  },
  {
    id: 'role-night',
    name: 'night_shift',
    displayName: 'Ночная смена',
    description: null,
    isSystem: false,
    permissionsCount: 3,
    assignedAdminCount: 0,
    createdAt: '2026-06-04T10:00:00.000Z',
    updatedAt: '2026-06-04T10:00:00.000Z',
  },
]

const ALICE = {
  id: 'admin-alice',
  username: 'alice',
  name: null,
  role: 'ADMIN',
  isActive: true,
  rbacRoleId: 'role-operator',
  // As `admin-admins.controller.ts` sends it: the stored displayName.
  rbacRoleName: 'Operator',
  mustChangePassword: false,
  twoFactorEnabled: false,
  lastLoginAt: null,
  createdAt: '2026-06-04T10:00:00.000Z',
  updatedAt: '2026-06-04T10:00:00.000Z',
}

beforeAll(async () => {
  await coreDictionaryReady('ru')
  vi.mocked(api.get).mockImplementation(async (url: string) => {
    if (url === '/admin/admins') return { data: [ALICE] }
    if (url === '/admin/rbac/roles') return { data: ROLES }
    throw new Error(`unexpected GET ${url}`)
  })
})

afterAll(() => {
  window.localStorage.removeItem('rezeis.admin.locale')
})

describe('the role picker on the Administrators page', () => {
  it('shows an assigned system role in the page language', async () => {
    expect(i18n.language).toBe('ru')
    const user = userEvent.setup()
    renderWithProviders(<AdminsPage />)

    await user.click(await screen.findByRole('button', { name: 'Изменить alice' }))
    const dialog = await screen.findByRole('dialog')
    const picker = within(dialog).getByRole('combobox', { name: 'Роль доступа (RBAC)' })

    await vi.waitFor(() => expect(picker).toHaveTextContent('Оператор'))
    expect(picker).not.toHaveTextContent('Operator')
  })

  it('offers system roles in the page language and custom roles as they are named', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AdminsPage />)

    await user.click(await screen.findByRole('button', { name: 'Добавить администратора' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('combobox', { name: 'Роль доступа (RBAC)' }))

    const options = (await screen.findAllByRole('option')).map((option) => option.textContent)
    expect(options).toEqual(['Без роли (доступ по типу учётки)', 'Оператор', 'Ночная смена'])
  })
})
