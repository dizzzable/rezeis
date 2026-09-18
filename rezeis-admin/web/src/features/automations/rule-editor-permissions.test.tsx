/**
 * The editor does not offer what the role cannot save.
 *
 * Saving a rule, switching one on and running one by hand now ask the admin for
 * the permission each action needs on its own screen — `blocked_ips:create` for
 * blocking an address, `users:edit` for blocking a customer, `webhooks:create`
 * for sending event data out. The server refuses; this page says so FIRST:
 * such an action is offered greyed out with the permission it needs, and the
 * buttons it would make fail are held with the reason on them.
 *
 * The map is the server's (the catalogue's `actionPermissions`), so each case
 * serves one. The grants come from the permission store, set per case.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePermissionStore, type RbacAction } from '@/features/rbac'
import { listUserHints } from '@/features/user-hints/user-hints-api'
import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'

import { permissionList } from './action-permissions'
import AutomationsPage from './automations-page'
import {
  getCatalog,
  getRule,
  listExecutions,
  listRules,
  toggleRule,
  updateRule,
  type AutomationCatalog,
  type AutomationRule,
} from './automations-api'
import { getEventCatalog } from './event-catalog-api'

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: toastMock }))

vi.mock('./automations-api', () => ({
  createRule: vi.fn(),
  deleteRule: vi.fn(),
  getCatalog: vi.fn(),
  getRule: vi.fn(),
  listExecutions: vi.fn(),
  listRules: vi.fn(),
  runRuleManually: vi.fn(),
  toggleRule: vi.fn(),
  updateRule: vi.fn(),
}))

vi.mock('./event-catalog-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./event-catalog-api')>()),
  getEventCatalog: vi.fn(),
}))

vi.mock('@/features/user-hints/user-hints-api', () => ({
  createUserHint: vi.fn(),
  updateUserHint: vi.fn(),
  listUserHints: vi.fn(),
  deleteUserHint: vi.fn(),
  getUserHint: vi.fn(),
}))

const ALL_TYPES = [
  'notify_telegram',
  'webhook_post',
  'block_ip',
  'system_event',
  'block_user',
  'show_hint',
  'show_hint_to_audience',
] as const

/** The server's map, as `GET /admin/automations/catalog` serves it. */
const MAP: NonNullable<AutomationCatalog['actionPermissions']> = {
  notify_telegram: [],
  webhook_post: [{ resource: 'webhooks', action: 'create' }],
  block_ip: [{ resource: 'blocked_ips', action: 'create' }],
  system_event: [],
  block_user: [{ resource: 'users', action: 'edit' }],
  show_hint: [],
  show_hint_to_audience: [],
}

const RULE_ADMIN: ReadonlyArray<{ resource: string; action: RbacAction }> = [
  { resource: 'automations', action: 'view' },
  { resource: 'automations', action: 'create' },
  { resource: 'automations', action: 'edit' },
  { resource: 'automations', action: 'run' },
]

const NOTIFY: AutomationRule = {
  id: 'rule-notify',
  name: 'Notify',
  description: null,
  isEnabled: true,
  triggerKind: 'MANUAL',
  triggerSpec: '',
  conditions: null,
  actions: [{ type: 'notify_telegram', params: { text: 'fired' } }],
  createdById: 'admin-1',
  lastRunAt: null,
  lastRunStatus: null,
  lastRunMessage: null,
  runCount: 0,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
}

const BLOCKER: AutomationRule = {
  ...NOTIFY,
  id: 'rule-blocker',
  name: 'Blocker',
  isEnabled: false,
  actions: [
    { type: 'notify_telegram', params: { text: 'blocking' } },
    { type: 'block_ip', params: { address: '203.0.113.9' } },
  ],
}

const HOOK_ON: AutomationRule = {
  ...NOTIFY,
  id: 'rule-hook-on',
  name: 'Hook on',
  isEnabled: true,
  actions: [{ type: 'webhook_post', params: { url: 'https://hooks.example.com/in' } }],
}

function grant(permissions: ReadonlyArray<{ resource: string; action: RbacAction }>): void {
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

function serve(rules: readonly AutomationRule[], catalog: Partial<AutomationCatalog> = {}): void {
  vi.mocked(getCatalog).mockResolvedValue({
    actionTypes: [...ALL_TYPES],
    coincidentEventGroups: [],
    actionPermissions: MAP,
    ...catalog,
  })
  vi.mocked(listRules).mockResolvedValue(rules.map((rule) => ({ ...rule })))
  vi.mocked(getRule).mockImplementation(async (id) => {
    const rule = rules.find((candidate) => candidate.id === id)
    if (rule === undefined) throw new Error(`no rule ${id}`)
    return { ...rule }
  })
}

/** The sentence a key renders right now — looked up, never restated. */
function says(key: string, values?: Record<string, unknown>): string {
  const sentence = String(i18n.t(key, values ?? {}))
  expect(sentence, `${key} is missing from the loaded bundles`).not.toBe(key)
  return sentence
}

function label(type: string): string {
  return says(`automationsPage.actionTypes.${type}`)
}

function quoted(name: string): string {
  return says('automationsPage.quotedName', { name })
}

function escape(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
}

async function openRule(name: string): Promise<void> {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: says('automationsPage.list.selectAria', { name }) }))
  await waitFor(() => {
    expect(screen.getByRole('textbox', { name: says('automationsPage.config.name') })).toHaveValue(name)
  })
}

beforeEach(async () => {
  usePermissionStore.getState().reset()
  vi.mocked(getEventCatalog).mockResolvedValue({ events: [], windowDays: 30 })
  vi.mocked(listExecutions).mockResolvedValue({ items: [], nextCursor: null })
  vi.mocked(listUserHints).mockResolvedValue([])
  vi.mocked(toggleRule).mockImplementation(async (id, isEnabled) => ({ ...NOTIFY, id, isEnabled }))
  await i18nReady
  await loadFeatureBundle('automations')
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('the action picker', () => {
  it('offers an action the role may not save greyed out, naming the permission it needs', async () => {
    grant(RULE_ADMIN)
    serve([NOTIFY])
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    await openRule(NOTIFY.name)

    await user.click(screen.getByRole('combobox', { name: `${says('automationsPage.actions.heading')} 1` }))
    const reason = says('automationsPage.tips.actionNeedsPermission', {
      permissions: permissionList(i18n.t, [{ resource: 'blocked_ips', action: 'create' }]),
    })
    const blockIp = await screen.findByRole('option', { name: escape(label('block_ip')) })
    expect(blockIp).toHaveAttribute('aria-disabled', 'true')
    expect(blockIp).toHaveAttribute('title', reason)
    expect(blockIp).toHaveTextContent(reason)
    expect(reason).toContain(says('automationsPage.permissionNames.blocked_ips.create'))

    for (const type of ['webhook_post', 'block_user']) {
      expect(screen.getByRole('option', { name: escape(label(type)) })).toHaveAttribute('aria-disabled', 'true')
    }
    // Anti-vacuity: the actions that need nothing more are offered as ever.
    for (const type of ['notify_telegram', 'system_event', 'show_hint']) {
      expect(screen.getByRole('option', { name: label(type) })).not.toHaveAttribute('aria-disabled', 'true')
    }

    // And a greyed-out option cannot be picked: the press changes nothing, and
    // the list has to be closed by hand.
    await user.click(blockIp)
    await user.keyboard('{Escape}')
    expect(screen.getByRole('combobox', { name: `${says('automationsPage.actions.heading')} 1` })).toHaveTextContent(
      label('notify_telegram'),
    )
  })

  it('offers it once the role holds the permission', async () => {
    grant([...RULE_ADMIN, { resource: 'blocked_ips', action: 'create' }])
    serve([NOTIFY])
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    await openRule(NOTIFY.name)

    await user.click(screen.getByRole('combobox', { name: `${says('automationsPage.actions.heading')} 1` }))
    expect(await screen.findByRole('option', { name: label('block_ip') })).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('greys nothing out before the grants have loaded, or when the panel sends no map', async () => {
    serve([NOTIFY])
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    await openRule(NOTIFY.name)
    await user.click(screen.getByRole('combobox', { name: `${says('automationsPage.actions.heading')} 1` }))
    expect(await screen.findByRole('option', { name: label('block_ip') })).not.toHaveAttribute('aria-disabled', 'true')
    cleanup()

    grant(RULE_ADMIN)
    serve([NOTIFY], { actionPermissions: undefined })
    renderWithProviders(<AutomationsPage />)
    await openRule(NOTIFY.name)
    await user.click(screen.getByRole('combobox', { name: `${says('automationsPage.actions.heading')} 1` }))
    expect(await screen.findByRole('option', { name: label('block_ip') })).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('adds, as a new action, the first one the role may save', async () => {
    grant(RULE_ADMIN)
    serve([NOTIFY], { actionTypes: ['block_ip', 'notify_telegram'] })
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    await openRule(NOTIFY.name)

    await user.click(screen.getByRole('button', { name: says('automationsPage.actions.add') }))
    expect(screen.getByRole('combobox', { name: `${says('automationsPage.actions.heading')} 2` })).toHaveTextContent(
      label('notify_telegram'),
    )
  })
})

describe('the buttons an action the role lacks would make fail', () => {
  it('holds «Сохранить» on a rule that keeps such an action, says why, and gives it back once the action is gone', async () => {
    grant(RULE_ADMIN)
    serve([BLOCKER])
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    await openRule(BLOCKER.name)

    const save = screen.getByRole('button', { name: says('automationsPage.editor.save') })
    expect(save).toBeDisabled()
    await user.hover(save.parentElement!)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      says('automationsPage.tips.saveNeedsPermission', {
        actions: quoted(label('block_ip')),
        permissions: quoted(says('automationsPage.permissionNames.blocked_ips.create')),
      }),
    )
    await user.unhover(save.parentElement!)

    // Removing the action needs no permission, so the save comes back.
    await user.click(screen.getByRole('button', { name: says('automationsPage.actions.removeAria', { index: 2 }) }))
    expect(screen.getByRole('button', { name: says('automationsPage.editor.save') })).toBeEnabled()
  })

  it('holds «Запустить сейчас» on such a rule, and says why', async () => {
    grant(RULE_ADMIN)
    serve([BLOCKER])
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    await openRule(BLOCKER.name)

    const run = screen.getByRole('button', { name: says('automationsPage.editor.runNow') })
    expect(run).toBeDisabled()
    await user.hover(run.parentElement!)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      says('automationsPage.tips.runNowNeedsPermission', {
        actions: quoted(label('block_ip')),
        permissions: quoted(says('automationsPage.permissionNames.blocked_ips.create')),
      }),
    )
  })

  it('leaves both alone for a role that holds the permission', async () => {
    grant([...RULE_ADMIN, { resource: 'blocked_ips', action: 'create' }])
    serve([BLOCKER])
    renderWithProviders(<AutomationsPage />)
    await openRule(BLOCKER.name)

    expect(screen.getByRole('button', { name: says('automationsPage.editor.save') })).toBeEnabled()
    expect(screen.getByRole('button', { name: says('automationsPage.editor.runNow') })).toBeEnabled()
  })

  it('holds the list switch of a switched-off rule the role could not switch on — never the one that turns a rule off', async () => {
    grant(RULE_ADMIN)
    serve([BLOCKER, HOOK_ON])
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()

    const blockerSwitch = await screen.findByRole('switch', { name: says('automationsPage.list.toggleAria', { name: BLOCKER.name }) })
    expect(blockerSwitch).toBeDisabled()
    await user.hover(blockerSwitch.parentElement!)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      says('automationsPage.tips.listToggleNeedsPermission', {
        actions: quoted(label('block_ip')),
        permissions: quoted(says('automationsPage.permissionNames.blocked_ips.create')),
      }),
    )
    await user.unhover(blockerSwitch.parentElement!)

    const hookSwitch = screen.getByRole('switch', { name: says('automationsPage.list.toggleAria', { name: HOOK_ON.name }) })
    expect(hookSwitch).toBeEnabled()
    await user.click(hookSwitch)
    await waitFor(() => expect(toggleRule).toHaveBeenCalledWith(HOOK_ON.id, false))
  })

  it('greys out a rule template whose actions the role cannot save, and only that one', async () => {
    grant(RULE_ADMIN)
    serve([NOTIFY])
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: says('automationsPage.help.title') }))

    const card = (id: string): HTMLElement => {
      const title = screen.getByText(says(`automationsPage.templates.${id}.name`))
      return title.parentElement!
    }
    const use = says('automationsPage.help.useTemplate')
    expect(within(card('payment_completed_webhook')).getByRole('button', { name: use })).toBeDisabled()
    expect(within(card('daily_healthcheck_cron')).getByRole('button', { name: use })).toBeDisabled()
    expect(within(card('payment_failed_notify')).getByRole('button', { name: use })).toBeEnabled()
  })
})

describe('a refusal the page did not see coming', () => {
  it('shows the server’s reason in words, naming the permission and the action', async () => {
    // No map from the server: nothing is greyed out, and the save goes out.
    grant(RULE_ADMIN)
    serve([HOOK_ON], { actionPermissions: undefined })
    vi.mocked(updateRule).mockRejectedValue({
      isAxiosError: true,
      message: 'Request failed with status code 403',
      response: {
        status: 403,
        data: { statusCode: 403, message: ['Missing permission: webhooks:create (needed by the webhook_post action)'] },
      },
    })
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    await openRule(HOOK_ON.name)

    await user.click(screen.getByRole('button', { name: says('automationsPage.editor.save') }))

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        says('automationsPage.toast.saveFailed', {
          message: says('automationsPage.serverErrors.actionPermission', {
            permission: quoted(says('automationsPage.permissionNames.webhooks.create')),
            actions: quoted(label('webhook_post')),
          }),
        }),
      )
    })
  })
})
