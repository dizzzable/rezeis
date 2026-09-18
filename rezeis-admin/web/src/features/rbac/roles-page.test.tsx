/**
 * The roles page, read by an owner who has just installed the panel.
 *
 * Everything below is something that page used to show raw: the seventeen
 * action columns as lowercase English verbs, the forty-eight sections as code
 * keys in one flat list, checkbox names like `users:export`, system roles in
 * the seed's mixed English/Russian, counts such as «1 прав» and «2 админов»,
 * and every refusal as "Request failed with status code 403".
 *
 * The page waits for its own dictionary (`i18n/features/rbac.*`) before it
 * paints, so every render here sits inside a `<Suspense>`, as it does on the
 * Administrators page.
 */
import { Suspense, type ReactElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'

import { coreDictionaryReady, i18n, loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import RolesPage from './roles-page'
import {
  createRole,
  deleteRole,
  getResourceCatalog,
  getRole,
  listRoles,
  syncSystemRoles,
  updateRole,
} from './rbac-api'
import type { RbacResourceCatalog, RbacRole, RbacRoleListItem } from './rbac-types'
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

/**
 * Deliberately NOT in the order the matrix shows it: the server lists
 * `backups` first, the page must put Overview, then Customers, then System.
 */
const CATALOG: RbacResourceCatalog = {
  actions: ['view', 'create', 'edit', 'delete', 'export', 'run'],
  resources: {
    backups: ['view', 'create', 'delete', 'run', 'export'],
    users: ['view', 'edit', 'delete', 'export'],
    dashboard: ['view'],
  },
}

const OPERATOR_SEED_DESCRIPTION = 'Повседневные операции: пользователи, подписки, платежи, поддержка, рассылки.'

function role(overrides: Partial<RbacRole> = {}): RbacRole {
  return {
    id: 'role-1',
    name: 'support_lead',
    displayName: 'Support Lead',
    description: 'Support team role',
    isSystem: false,
    permissions: [{ resource: 'users', action: 'view' }],
    assignedAdminCount: 0,
    createdAt: '2026-06-04T10:00:00.000Z',
    updatedAt: '2026-06-04T10:00:00.000Z',
    ...overrides,
  }
}

function listItem(from: RbacRole, overrides: Partial<RbacRoleListItem> = {}): RbacRoleListItem {
  const { permissions, ...rest } = from
  return { ...rest, permissionsCount: permissions.length, ...overrides }
}

function operatorRole(overrides: Partial<RbacRole> = {}): RbacRole {
  return role({
    id: 'role-operator',
    name: 'operator',
    displayName: 'Operator',
    description: OPERATOR_SEED_DESCRIPTION,
    isSystem: true,
    permissions: [
      { resource: 'dashboard', action: 'view' },
      { resource: 'users', action: 'view' },
    ],
    ...overrides,
  })
}

/** Serve these roles; the first is the one the page opens. */
function serve(...roles: RbacRole[]): void {
  vi.mocked(listRoles).mockResolvedValue(roles.map((entry) => listItem(entry)))
  vi.mocked(getRole).mockImplementation(async (id) => {
    const found = roles.find((entry) => entry.id === id)
    if (found === undefined) throw new Error(`no fixture for ${id}`)
    return found
  })
}

/** The acting admin: DEV holds everything, as the backend's own check does. */
function actAsDev(): void {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set<string>(),
    mustChangePassword: false,
    role: 'DEV',
    rbacRoleId: null,
    error: null,
  })
}

function actAs(tokens: readonly string[]): void {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(tokens),
    mustChangePassword: false,
    // Not 'DEV': that role short-circuits every permission check.
    role: 'ADMIN',
    rbacRoleId: null,
    error: null,
  })
}

/** As the Administrators page mounts it: inside a Suspense boundary. */
function renderPage(ui: ReactElement = <RolesPage />) {
  return renderWithProviders(<Suspense fallback={<p>loading the roles page</p>}>{ui}</Suspense>)
}

/** Both dictionaries the page reads, in the current language. */
async function wordsLoaded(): Promise<void> {
  await Promise.all([coreDictionaryReady(i18n.language), loadFeatureBundle('rbac')])
}

/**
 * Switched BEFORE the render, and only once both dictionaries are in the
 * store: `changeLanguage` resolves at once while they arrive through dynamic
 * imports. (Switching while the page is open is its own file:
 * `roles-page-language-switch*.test.tsx`.)
 */
async function switchToRussian(): Promise<void> {
  await i18n.changeLanguage('ru')
  await wordsLoaded()
}

/**
 * Opens the tip behind `element`, returns its text, and closes it again.
 *
 * Closed with Escape rather than by moving the pointer away: inside a modal
 * dialog Radix sets `pointer-events: none` on the body, so an unhover has
 * nowhere to go. The next hover moves the pointer anyway.
 */
async function tipOf(user: ReturnType<typeof userEvent.setup>, element: Element): Promise<string> {
  await user.hover(element)
  const text = (await screen.findByRole('tooltip')).textContent ?? ''
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
  return text
}

/** The wrapper a disabled button's tip hangs on (see `ButtonTip`). */
function wrapperOf(button: HTMLElement): HTMLElement {
  return button.parentElement!
}

/** The role list on the left, found from something only it shows. */
function roleListOf(inside: HTMLElement): HTMLElement {
  return inside.closest('div.space-y-1') as HTMLElement
}

async function openMatrix(): Promise<HTMLTableElement> {
  const [checkbox] = await screen.findAllByRole('checkbox', { name: /^(Users|Пользователи): / })
  return checkbox.closest('table')!
}

beforeAll(async () => {
  // The page paints at once when its words are already in; a test that
  // renders before they are would only be measuring the dynamic import.
  await wordsLoaded()
})

beforeEach(() => {
  vi.mocked(getResourceCatalog).mockResolvedValue(CATALOG)
  vi.mocked(createRole).mockResolvedValue(role({ id: 'role-new', name: 'ops_lead' }))
  vi.mocked(deleteRole).mockResolvedValue(undefined)
  vi.mocked(syncSystemRoles).mockResolvedValue(undefined)
  vi.mocked(updateRole).mockImplementation(async (id, payload) => role({ id, ...payload, permissions: payload.permissions }))
  actAsDev()
})

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  usePermissionStore.getState().reset()
  if (i18n.language !== 'en') await i18n.changeLanguage('en')
})

describe('RolesPage on the Administrators page', () => {
  it('says what a role is and where it is assigned, instead of an empty header', async () => {
    serve(role())
    renderPage(<RolesPage embedded />)

    const intro = await screen.findByText(/^A role is a set of permissions/)
    expect(intro).toHaveTextContent('on the Administrators tab, in the “Access role (RBAC)” field')
    expect(screen.queryByRole('heading', { name: 'Roles & permissions' })).toBeNull()
  })

  it('tells an admin without the view permission so, and asks the server nothing', async () => {
    actAs(['users:view'])
    serve(role())
    renderPage()

    expect(await screen.findByText('Roles are not available to you')).toBeInTheDocument()
    expect(
      screen.getByText('Your role does not include “Roles and permissions: View”, so the roles are not shown.'),
    ).toBeInTheDocument()
    expect(listRoles).not.toHaveBeenCalled()
    expect(getResourceCatalog).not.toHaveBeenCalled()
  })

  it('reports a refused list as a refusal, not as an empty one', async () => {
    vi.mocked(listRoles).mockRejectedValue(
      Object.assign(new Error('Request failed with status code 403'), {
        isAxiosError: true,
        response: { status: 403, data: { message: 'Missing permission: rbac_roles:view' } },
      }),
    )
    renderPage()

    expect(await screen.findByText('The roles did not load')).toBeInTheDocument()
    expect(screen.getByText('Your role does not include “Roles and permissions: View”.')).toBeInTheDocument()
    expect(screen.queryByText(/^No roles yet/)).toBeNull()
  })

  it('reports a role that did not load instead of a skeleton for ever', async () => {
    vi.mocked(listRoles).mockResolvedValue([listItem(role())])
    vi.mocked(getRole).mockRejectedValue(
      Object.assign(new Error('Request failed with status code 404'), {
        isAxiosError: true,
        response: { status: 404, data: { message: 'Role not found' } },
      }),
    )
    renderPage()

    expect(await screen.findByText('This role did not load')).toBeInTheDocument()
    expect(screen.getByText('The role no longer exists; someone may have deleted it.')).toBeInTheDocument()
  })
})

describe('RolesPage accessibility', () => {
  it('uses an accessible alert dialog before deleting a custom role', async () => {
    serve(role())
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    renderPage()

    await screen.findByDisplayValue('Support Lead')
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    const dialog = await screen.findByRole('alertdialog', { name: 'Delete' })
    expect(dialog).toHaveTextContent('Delete the role “Support Lead”? This cannot be undone.')
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

  it('names the row buttons with the word they show, and says what each box does to a screen reader', async () => {
    actAs(['rbac_roles:view', 'rbac_roles:edit', 'users:view', 'users:edit'])
    serve(role({ permissions: [] }))
    renderPage()
    const table = await openMatrix()

    // WCAG 2.5.3: the accessible name contains — here, starts with — the
    // visible text, so "click all" in voice control reaches the button.
    const all = within(table).getByRole('button', { name: /^all: tick the permissions of “Users”/ })
    expect(all).toHaveTextContent(/^all$/)
    expect(all).toHaveAccessibleName('all: tick the permissions of “Users” that you can grant')

    expect(within(table).getByRole('checkbox', { name: 'Users: Edit' })).toHaveAccessibleDescription(
      'Profile, points, blocking, invite settings, the web cabinet’s login and password, the Telegram link, a message to the customer.',
    )
    expect(within(table).getByRole('checkbox', { name: 'Users: Export' })).toHaveAccessibleDescription(
      'Download the customer list as CSV with the columns you pick, without registration data. ' +
        'Dangerous: Personal data of every customer, in one file. ' +
        'You cannot grant a permission you do not hold yourself',
    )
  })
})

describe('the permission matrix speaks in words', () => {
  it('translates every column and groups the sections by area, keeping the raw key in small print', async () => {
    serve(role())
    renderPage()
    const table = await openMatrix()

    const head = table.querySelector('thead')!
    expect(within(head).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'Section',
      'View',
      'Create',
      'Edit',
      'Delete',
      'Export',
      'Run',
    ])

    const groups = [...table.querySelectorAll('tbody')].map((body) => ({
      title: body.querySelector('th')?.textContent,
      rows: [...body.querySelectorAll('tr')].slice(1).map((row) => row.querySelector('td span')?.textContent),
    }))
    expect(groups).toEqual([
      { title: 'Overview', rows: ['Dashboard'] },
      { title: 'Customers', rows: ['Users'] },
      { title: 'System', rows: ['Backups'] },
    ])

    expect(within(table).getByText('users', { selector: 'code' })).toBeInTheDocument()
  })

  it('keeps the header row and the section column in place while the table scrolls, legibly under glass', async () => {
    serve(role())
    renderPage()
    const table = await openMatrix()

    // The box scrolls in both directions itself, so `sticky` has something
    // to stick to.
    const box = table.closest('[data-permission-matrix-scroll]')!
    expect(box).toHaveClass('overflow-auto')
    expect(box.className).toMatch(/max-h-\[/)

    const head = [...table.querySelectorAll('thead th')]
    const firstColumn = [...table.querySelectorAll('tbody tr td:first-child')]
    expect(head.length).toBe(7)
    expect(firstColumn.length).toBe(3)
    for (const cell of head) expect(cell).toHaveClass('sticky', 'top-0')
    expect(head[0]).toHaveClass('left-0')
    for (const cell of firstColumn) expect(cell).toHaveClass('sticky', 'left-0')

    // Liquid Glass makes `.bg-card` translucent and `.bg-muted/50` fully
    // transparent; a pinned cell with either lets the scrolled rows through.
    for (const cell of [...head, ...firstColumn]) {
      const classes = [...cell.classList]
      expect(classes.filter((name) => /^bg-(card|muted)(\/[0-9]+)?$/.test(name) && name !== 'bg-card/90')).toEqual([])
      expect(classes.some((name) => name.startsWith('bg-'))).toBe(true)
    }
  })

  it('names every checkbox «section: action» and leaves what a section does not offer as a dash', async () => {
    serve(role())
    renderPage()
    const table = await openMatrix()

    expect(within(table).getByRole('checkbox', { name: 'Users: Export' })).toBeInTheDocument()
    expect(within(table).getByRole('checkbox', { name: 'Backups: Run' })).toBeInTheDocument()
    expect(within(table).queryByRole('checkbox', { name: /users:/ })).toBeNull()
    expect(within(table).queryByRole('checkbox', { name: 'Dashboard: Create' })).toBeNull()

    const dashboardRow = within(table).getByText('Dashboard').closest('tr')!
    expect(within(dashboardRow).getAllByRole('checkbox')).toHaveLength(1)
    expect(within(dashboardRow).getAllByText('–')).toHaveLength(5)
  })

  it('explains, on hover, what a section is and what each of its permissions unlocks there', async () => {
    serve(role())
    const user = userEvent.setup()
    renderPage()
    await openMatrix()

    const tip = await tipOf(user, screen.getByRole('button', { name: 'More about Users' }))
    expect(tip).toContain('Your service’s customers')
    expect(tip).toContain('Export — Download the customer list as CSV')
    expect(tip).toContain('Delete — Delete a customer. Cannot be undone.')
  })

  it('opens a section’s explanation below its (i) and no wider than the screen', async () => {
    serve(role())
    const user = userEvent.setup()
    renderPage()
    await openMatrix()

    await user.hover(screen.getByRole('button', { name: 'More about Users' }))
    const content = (await screen.findByRole('tooltip')).closest('[data-side]')!
    // Opening to the right at a fixed 384 px cut the text off on a 375 px phone.
    expect(content).toHaveAttribute('data-side', 'bottom')
    expect(content.className).toContain('max-w-[min(24rem,calc(100vw-1rem))]')
  })

  it('explains, on hover, what an action column means', async () => {
    serve(role())
    const user = userEvent.setup()
    renderPage()
    await openMatrix()

    expect(await tipOf(user, screen.getByRole('button', { name: 'More about Export' }))).toBe(
      'Download the section’s data as a file.',
    )
  })

  it('marks a dangerous permission where it can be seen, and says why', async () => {
    serve(role())
    const user = userEvent.setup()
    renderPage()
    await openMatrix()

    expect(screen.getByText(/marks a dangerous permission/)).toBeInTheDocument()
    const marker = screen.getByRole('button', { name: 'Why this is dangerous: Backups: Run' })
    expect(await tipOf(user, marker)).toBe(
      'Restoring replaces the whole database with the copy: everything since it was taken is lost.',
    )
    expect(await tipOf(user, screen.getByRole('button', { name: 'Why this is dangerous: Users: Delete' }))).toBe(
      'The customer is deleted together with their subscriptions and Remnawave profiles; there is no undo.',
    )
    // Not every box is a warning, or none of them means anything.
    expect(screen.queryByRole('button', { name: 'Why this is dangerous: Backups: View' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Why this is dangerous: Users: Edit' })).toBeNull()
  })

  it('reads in Russian: sections, actions, areas and checkbox names', async () => {
    await switchToRussian()
    serve(role())
    renderPage()
    const table = await openMatrix()

    expect(within(table).getByRole('checkbox', { name: 'Пользователи: Выгрузка' })).toBeInTheDocument()
    expect(within(table).getByRole('checkbox', { name: 'Бэкапы: Запуск' })).toBeInTheDocument()
    expect(within(table.querySelector('thead')!).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'Раздел',
      'Просмотр',
      'Создание',
      'Изменение',
      'Удаление',
      'Выгрузка',
      'Запуск',
    ])
    expect([...table.querySelectorAll('tbody')].map((body) => body.querySelector('th')?.textContent)).toEqual([
      'Обзор',
      'Клиенты',
      'Система',
    ])
  })

  it('lets «all» tick only what the acting admin can grant', async () => {
    actAs(['rbac_roles:view', 'rbac_roles:edit', 'users:view', 'users:edit'])
    serve(role({ permissions: [] }))
    const user = userEvent.setup()
    renderPage()
    const table = await openMatrix()

    expect(screen.getByText(/Greyed-out boxes are permissions you do not hold yourself/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^all: tick the permissions of “Users”/ }))

    expect(within(table).getByRole('checkbox', { name: 'Users: View' })).toBeChecked()
    expect(within(table).getByRole('checkbox', { name: 'Users: Edit' })).toBeChecked()
    expect(within(table).getByRole('checkbox', { name: 'Users: Delete' })).not.toBeChecked()
    expect(within(table).getByRole('checkbox', { name: 'Users: Export' })).not.toBeChecked()
    // Nothing was ticked that the save would refuse.
    expect(document.querySelector('[data-role-editor-beyond-actor]')).toBeNull()
    // And the same button now clears the row.
    expect(screen.getByRole('button', { name: 'none: untick every permission of “Users”' })).toBeInTheDocument()
  })

  it('follows the acting admin’s grants when they change, not only as first loaded', async () => {
    actAs(['rbac_roles:view', 'rbac_roles:edit', 'users:view'])
    serve(role({ permissions: [] }))
    renderPage()
    const table = await openMatrix()
    expect(within(table).getByRole('checkbox', { name: 'Users: Delete' })).toBeDisabled()

    act(() => {
      usePermissionStore.setState({ granted: new Set(['rbac_roles:view', 'rbac_roles:edit', 'users:view', 'users:delete']) })
    })

    expect(within(table).getByRole('checkbox', { name: 'Users: Delete' })).toBeEnabled()
  })

  it('shows permissions the catalogue no longer has, and lets them be removed before saving', async () => {
    serve(
      role({
        permissions: [
          { resource: 'users', action: 'view' },
          // A row left in the database after its resource was retired. Written
          // action-first on purpose: `rbac-catalog-parity.test.ts` reads every
          // `resource: …, action: …` literal as a gate, and this one is
          // deliberately NOT in the catalogue.
          { action: 'view', resource: 'legacy_reports' },
        ],
      }),
    )
    const user = userEvent.setup()
    renderPage()
    await openMatrix()

    const alert = document.querySelector('[data-role-editor-unknown]') as HTMLElement
    expect(alert).toHaveTextContent('This role holds permissions the panel no longer has')
    expect(alert).toHaveTextContent('legacy_reports:view')

    await user.click(within(alert).getByRole('button', { name: 'Remove them' }))
    expect(document.querySelector('[data-role-editor-unknown]')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(updateRole).toHaveBeenCalledTimes(1))
    expect(vi.mocked(updateRole).mock.calls[0][1].permissions).toEqual([{ resource: 'users', action: 'view' }])
  })
})

describe('roles are shown in the operator’s language', () => {
  it('counts permissions and admins with real Russian plurals', async () => {
    await switchToRussian()
    const one = role({ assignedAdminCount: 2 })
    serve(one, role({ id: 'role-2', name: 'second', displayName: 'Вторая', permissions: [], assignedAdminCount: 0 }))
    vi.mocked(listRoles).mockResolvedValue([
      listItem(one),
      listItem(role({ id: 'role-2', name: 'second', displayName: 'Вторая' }), {
        permissionsCount: 5,
        assignedAdminCount: 0,
      }),
      listItem(role({ id: 'role-3', name: 'third', displayName: 'Третья' }), {
        permissionsCount: 22,
        assignedAdminCount: 21,
      }),
    ])
    renderPage()

    const list = roleListOf(await screen.findByText('Вторая'))
    const counts = within(list)
      .getAllByRole('button')
      .map((button) => button.querySelector('.tabular-nums')?.textContent)
    expect(counts).toEqual(['1 право2 администратора', '5 прав0 администраторов', '22 права21 администратор'])
    expect(await screen.findByText('Идентификатор: support_lead · 2 администратора · 1 право')).toBeInTheDocument()
  })

  it('shows an untouched system role in Russian, and an edited or custom one exactly as typed', async () => {
    await switchToRussian()
    serve(
      operatorRole(),
      role({
        id: 'role-finance',
        name: 'finance',
        displayName: 'Бухгалтерия',
        description: 'Наше собственное описание',
        isSystem: true,
      }),
      role({ id: 'role-custom', displayName: 'Ночная смена', description: 'Как написали' }),
    )
    renderPage()

    // The list and the editor are checked apart: the editor opens on the
    // operator too, and a name found there says nothing about the list.
    const list = roleListOf(await screen.findByText('Ночная смена'))
    expect(within(list).getByText('Оператор')).toBeInTheDocument()
    expect(within(list).queryByText('Operator')).toBeNull()
    expect(within(list).getByText(/^Повседневная работа: клиенты, подписки/)).toBeInTheDocument()
    expect(screen.queryByText(OPERATOR_SEED_DESCRIPTION)).toBeNull()
    expect(within(list).getByText('Бухгалтерия')).toBeInTheDocument()
    expect(within(list).getByText('Наше собственное описание')).toBeInTheDocument()
    expect(within(list).getByText('Как написали')).toBeInTheDocument()

    await waitFor(() => expect(document.querySelector('[data-concept-heading]')).toHaveTextContent(/^Оператор$/))
  })

  it('never shows an English owner the seed’s Russian description', async () => {
    serve(operatorRole())
    renderPage()

    expect(await screen.findByText(/^Day-to-day work: customers, subscriptions/)).toBeInTheDocument()
    expect(screen.queryByText(OPERATOR_SEED_DESCRIPTION)).toBeNull()
  })

  it('saves an untouched system role with its stored text, and a renamed one as typed', async () => {
    await switchToRussian()
    serve(operatorRole())
    const user = userEvent.setup()
    renderPage()

    const name = await screen.findByDisplayValue('Оператор')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(updateRole).toHaveBeenCalledTimes(1))
    // The translation on screen is not what is stored: saving «Оператор» would
    // rename the role for every English owner.
    expect(updateRole).toHaveBeenLastCalledWith('role-operator', {
      displayName: 'Operator',
      description: OPERATOR_SEED_DESCRIPTION,
      permissions: [],
    })

    await user.clear(name)
    await user.type(name, 'Главный оператор')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(updateRole).toHaveBeenCalledTimes(2))
    expect(vi.mocked(updateRole).mock.calls[1][1].displayName).toBe('Главный оператор')
  })

  it('lets an admin without the role’s own permissions rename a system role', async () => {
    // The server ignores a system role's permissions but checks them against
    // the actor first, so the editor sends none: re-sending the role's own
    // stopped anyone lacking one of them from even renaming it.
    actAs(['rbac_roles:view', 'rbac_roles:edit'])
    serve(operatorRole())
    const user = userEvent.setup()
    renderPage()

    const name = await screen.findByDisplayValue('Operator')
    await user.clear(name)
    await user.type(name, 'Ops desk')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(updateRole).toHaveBeenCalledTimes(1))
    expect(vi.mocked(updateRole).mock.calls[0][1]).toMatchObject({ displayName: 'Ops desk', permissions: [] })
  })
})

describe('a refusal is told in words', () => {
  function refusal(status: number, message: string): Error {
    return Object.assign(new Error(`Request failed with status code ${status}`), {
      isAxiosError: true,
      response: { status, data: { statusCode: status, message } },
    })
  }

  it('names the permissions a save may not grant the way the matrix names them', async () => {
    serve(role())
    const error = vi.spyOn(toast, 'error').mockReturnValue('toast')
    vi.mocked(updateRole).mockRejectedValue(
      refusal(403, 'Cannot grant permissions you do not hold: users:delete, backups:export'),
    )
    const user = userEvent.setup()
    renderPage()

    await screen.findByDisplayValue('Support Lead')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(error).toHaveBeenCalledTimes(1))
    expect(error).toHaveBeenCalledWith(
      'Could not save the role: You cannot grant permissions you do not hold yourself: Users: Delete; Backups: Export.',
    )
  })

  it('says the server could not be reached instead of repeating axios', async () => {
    serve(role())
    const error = vi.spyOn(toast, 'error').mockReturnValue('toast')
    vi.mocked(deleteRole).mockRejectedValue(
      Object.assign(new Error('Network Error'), { isAxiosError: true, code: 'ERR_NETWORK' }),
    )
    const user = userEvent.setup()
    renderPage()

    await screen.findByDisplayValue('Support Lead')
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(error).toHaveBeenCalledTimes(1))
    const [message] = error.mock.calls[0]
    expect(message).toBe(`Could not delete the role: ${i18n.t('errors.serverUnreachable')}`)
    expect(String(message)).not.toContain('Network Error')
  })
})

describe('the create dialog', () => {
  it('states the identifier rule in full and refuses a bad identifier before sending it', async () => {
    serve(role())
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'New role' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('starting with a letter')

    const identifier = within(dialog).getByLabelText(/Identifier/)
    const create = within(dialog).getByRole('button', { name: 'Create role' })
    await user.type(within(dialog).getByLabelText(/^Name/), 'Ops')

    await user.type(identifier, '1role')
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Start with a letter and use only lowercase Latin letters, digits and “_”.',
    )
    expect(create).toBeDisabled()
    expect(await tipOf(user, wrapperOf(create))).toBe('Enter a valid identifier first.')

    await user.clear(identifier)
    await user.type(identifier, 'operator')
    expect(within(dialog).getByRole('alert')).toHaveTextContent('This identifier belongs to a system role.')
    expect(create).toBeDisabled()

    await user.clear(identifier)
    await user.type(identifier, 'ops_lead')
    expect(within(dialog).queryByRole('alert')).toBeNull()
    expect(create).toBeEnabled()
    await user.click(create)
    await waitFor(() => expect(createRole).toHaveBeenCalledTimes(1))
    expect(vi.mocked(createRole).mock.calls[0][0]).toMatchObject({ name: 'ops_lead', displayName: 'Ops' })
  })

  it('has nothing left in English for a Russian owner', async () => {
    await switchToRussian()
    serve(role())
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Новая роль' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText(/^Название/)).toHaveAttribute('placeholder', 'Старший оператор')
    expect(dialog).toHaveTextContent('первой — буква')
  })
})

describe('every button says what it does', () => {
  it('explains Save, Delete, Sync and New role on hover', async () => {
    serve(role())
    const user = userEvent.setup()
    renderPage()
    await screen.findByDisplayValue('Support Lead')

    expect(await tipOf(user, screen.getByRole('button', { name: 'Save' }))).toMatch(
      /^Saves the name, description and ticked permissions\. If you removed a permission, every admin with this role is signed out/,
    )
    expect(await tipOf(user, screen.getByRole('button', { name: 'Delete' }))).toBe(
      'Deletes the role for good. Only a role nobody holds can be deleted.',
    )
    expect(await tipOf(user, screen.getByRole('button', { name: 'Sync system roles' }))).toMatch(
      /^Creates any missing system role/,
    )
    expect(await tipOf(user, screen.getByRole('button', { name: 'New role' }))).toMatch(/^Opens the form for a new role/)
  })

  it('will not send a nameless role, and says so', async () => {
    serve(role())
    const user = userEvent.setup()
    renderPage()

    await user.clear(await screen.findByDisplayValue('Support Lead'))
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    expect(await tipOf(user, wrapperOf(save))).toBe('Enter a name of at least 2 characters first.')
    expect(updateRole).not.toHaveBeenCalled()
  })

  it('says why Delete cannot be pressed while the role is assigned', async () => {
    serve(role({ assignedAdminCount: 2 }))
    const user = userEvent.setup()
    renderPage()
    await screen.findByDisplayValue('Support Lead')

    const remove = screen.getByRole('button', { name: 'Delete' })
    expect(remove).toBeDisabled()
    expect(await tipOf(user, wrapperOf(remove))).toBe(
      'The role is assigned to 2 admins. Give them another role on the Administrators tab first.',
    )
  })

  it('says which permission the acting admin lacks instead of letting the server refuse', async () => {
    actAs(['rbac_roles:view', 'rbac_roles:edit', 'users:view'])
    serve(role())
    const user = userEvent.setup()
    renderPage()
    await screen.findByDisplayValue('Support Lead')

    const remove = screen.getByRole('button', { name: 'Delete' })
    const create = screen.getByRole('button', { name: 'New role' })
    expect(remove).toBeDisabled()
    expect(create).toBeDisabled()
    expect(await tipOf(user, wrapperOf(remove))).toBe(
      'Unavailable: your role does not include “Roles and permissions: Delete”.',
    )
    expect(await tipOf(user, wrapperOf(create))).toBe(
      'Unavailable: your role does not include “Roles and permissions: Create”.',
    )
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })
})
