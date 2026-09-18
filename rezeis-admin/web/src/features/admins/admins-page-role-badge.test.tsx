/**
 * The Administrators list names each admin's access role the way the role
 * picker and the Roles tab do.
 *
 * The badge printed the role's stored `displayName`, and the four system roles
 * are stored with the backend seed's English names — so a Russian owner read
 * "Operator" in the list while the picker a click away said «Оператор». The
 * list row carries only that stored name; the role is looked up in the same
 * roles list the picker reads, and `roleDisplayName` names it.
 *
 * This file runs in Russian: the stored locale is set before the i18n module
 * loads.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'

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

const STAMP = '2026-06-04T10:00:00.000Z'

const ROLES = [
  {
    id: 'role-operator',
    name: 'operator',
    displayName: 'Operator',
    description: 'Повседневные операции: пользователи, подписки, платежи, поддержка, рассылки.',
    isSystem: true,
    permissionsCount: 40,
    assignedAdminCount: 1,
    createdAt: STAMP,
    updatedAt: STAMP,
  },
  {
    // A system role the owner renamed: their words, in every language.
    id: 'role-support',
    name: 'support',
    displayName: 'Дежурный',
    description: null,
    isSystem: true,
    permissionsCount: 12,
    assignedAdminCount: 1,
    createdAt: STAMP,
    updatedAt: STAMP,
  },
  {
    id: 'role-night',
    name: 'night_shift',
    displayName: 'Ночная смена',
    description: null,
    isSystem: false,
    permissionsCount: 3,
    assignedAdminCount: 1,
    createdAt: STAMP,
    updatedAt: STAMP,
  },
]

function admin(username: string, rbacRoleId: string | null, rbacRoleName: string | null) {
  return {
    id: `admin-${username}`,
    username,
    name: null,
    role: 'ADMIN',
    isActive: true,
    rbacRoleId,
    // As `admin-admins.controller.ts` sends it: the stored displayName.
    rbacRoleName,
    mustChangePassword: false,
    twoFactorEnabled: false,
    lastLoginAt: null,
    createdAt: STAMP,
    updatedAt: STAMP,
  }
}

const ADMINS = [
  admin('alice', 'role-operator', 'Operator'),
  admin('bob', 'role-support', 'Дежурный'),
  admin('carol', 'role-night', 'Ночная смена'),
]

let rolesAnswer: () => Promise<{ data: unknown }> = async () => ({ data: ROLES })

beforeAll(async () => {
  await coreDictionaryReady('ru')
  vi.mocked(api.get).mockImplementation(async (url: string) => {
    if (url === '/admin/admins') return { data: ADMINS }
    if (url === '/admin/rbac/roles') return rolesAnswer()
    throw new Error(`unexpected GET ${url}`)
  })
})

beforeEach(() => {
  rolesAnswer = async () => ({ data: ROLES })
})

afterAll(() => {
  window.localStorage.removeItem('rezeis.admin.locale')
})

/** The «Доступ» cell of one admin's row: the column that carries the role badge. */
async function accessCell(username: string): Promise<HTMLElement> {
  const row = (await screen.findByText(username)).closest('tr')
  expect(row, `no table row for ${username}`).not.toBeNull()
  return within(row as HTMLElement).getAllByRole('cell')[2] as HTMLElement
}

describe('the access role in the Administrators list', () => {
  it('names an assigned system role in the page language, as the role picker does', async () => {
    expect(i18n.language).toBe('ru')
    renderWithProviders(<AdminsPage />)

    const alice = await accessCell('alice')
    await vi.waitFor(() => expect(alice).toHaveTextContent('Оператор'))
    expect(alice.textContent).toBe('Оператор')
  })

  it('shows a renamed system role and a custom role exactly as they are named', async () => {
    renderWithProviders(<AdminsPage />)

    const alice = await accessCell('alice')
    await vi.waitFor(() => expect(alice).toHaveTextContent('Оператор'))
    expect((await accessCell('bob')).textContent).toBe('Дежурный')
    expect((await accessCell('carol')).textContent).toBe('Ночная смена')
  })

  it('falls back to the stored name when the roles cannot be read', async () => {
    // An operator who may list admins but not roles gets a 403 here. The list
    // must still name the role — as stored, never as a key path or a blank.
    rolesAnswer = async () => {
      throw Object.assign(new Error('Forbidden'), { response: { status: 403 } })
    }
    renderWithProviders(<AdminsPage />)

    const alice = await accessCell('alice')
    await vi.waitFor(() => expect(vi.mocked(api.get)).toHaveBeenCalledWith('/admin/rbac/roles'))
    expect(alice.textContent).toBe('Operator')
  })
})
