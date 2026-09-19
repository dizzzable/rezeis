/**
 * A webhook action's Authorization header in the editor: write-only.
 *
 * The panel never sends a saved header back; a reference stands in its place
 * (`saved-header.ts`). So the editor shows THAT one is saved and offers
 * «Заменить» and «Удалить» — and whatever the operator does, what «Сохранить»
 * sends is one of three things: the reference unchanged (keep), a string
 * (replace) or null (remove). Never a mask, never the reference retyped.
 *
 * Also here: the rule template that blocked «the address the event carries» is
 * gone — no event carries one.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePermissionStore, type RbacAction } from '@/features/rbac'
import { listUserHints } from '@/features/user-hints/user-hints-api'
import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'

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

const HOOK_ADMIN: ReadonlyArray<{ resource: string; action: RbacAction }> = [
  { resource: 'automations', action: 'view' },
  { resource: 'automations', action: 'create' },
  { resource: 'automations', action: 'edit' },
  { resource: 'automations', action: 'run' },
  { resource: 'webhooks', action: 'create' },
]

const REFERENCE = { stored: true, index: 0 }

/** A rule as the panel serves it now: the header replaced by its reference. */
const RELAY: AutomationRule = {
  id: 'rule-relay',
  name: 'Relay',
  description: null,
  isEnabled: false,
  triggerKind: 'MANUAL',
  triggerSpec: '',
  conditions: null,
  actions: [{ type: 'webhook_post', params: { url: 'https://hooks.example.com/in', authorizationHeader: REFERENCE } }],
  createdById: 'admin-1',
  lastRunAt: null,
  lastRunStatus: null,
  lastRunMessage: null,
  runCount: 0,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
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

function serve(rules: readonly AutomationRule[]): void {
  vi.mocked(getCatalog).mockResolvedValue({
    actionTypes: ['notify_telegram', 'webhook_post', 'block_ip'],
    coincidentEventGroups: [],
    actionPermissions: {
      notify_telegram: [],
      webhook_post: [{ resource: 'webhooks', action: 'create' }],
      block_ip: [{ resource: 'blocked_ips', action: 'create' }],
    },
  } satisfies AutomationCatalog)
  vi.mocked(listRules).mockResolvedValue(rules.map((rule) => ({ ...rule })))
  vi.mocked(getRule).mockImplementation(async (id) => {
    const rule = rules.find((candidate) => candidate.id === id)
    if (rule === undefined) throw new Error(`no rule ${id}`)
    return structuredClone(rule)
  })
  vi.mocked(updateRule).mockImplementation(async (id, payload) => ({ ...RELAY, id, ...payload }) as AutomationRule)
}

/** The sentence a key renders right now — looked up, never restated. */
function says(key: string, values?: Record<string, unknown>): string {
  const sentence = String(i18n.t(key, values ?? {}))
  expect(sentence, `${key} is missing from the loaded bundles`).not.toBe(key)
  return sentence
}

async function openRule(name: string): Promise<void> {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: says('automationsPage.list.selectAria', { name }) }))
  await waitFor(() => {
    expect(screen.getByRole('textbox', { name: says('automationsPage.config.name') })).toHaveValue(name)
  })
}

/** The params «Сохранить» sent for the first action. */
function sentParams(): Record<string, unknown> {
  expect(updateRule).toHaveBeenCalledTimes(1)
  const payload = vi.mocked(updateRule).mock.calls[0]![1]
  return payload.actions[0]!.params
}

beforeEach(async () => {
  usePermissionStore.getState().reset()
  vi.mocked(getEventCatalog).mockResolvedValue({ events: [], windowDays: 30 })
  vi.mocked(listExecutions).mockResolvedValue({ items: [], nextCursor: null })
  vi.mocked(listUserHints).mockResolvedValue([])
  await i18nReady
  await loadFeatureBundle('automations')
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('a saved Authorization header', () => {
  it('is shown as saved, with «Заменить» and «Удалить», and never in the params box', async () => {
    grant(HOOK_ADMIN)
    serve([RELAY])
    renderWithProviders(<AutomationsPage />)
    await openRule(RELAY.name)

    expect(screen.getByText(says('automationsPage.actions.header.saved'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: says('automationsPage.actions.header.replace') })).toBeEnabled()
    expect(screen.getByRole('button', { name: says('automationsPage.actions.header.remove') })).toBeEnabled()
    const box = screen.getAllByRole('textbox').find((element) => (element as HTMLTextAreaElement).value.includes('hooks.example.com'))
    expect(box, 'the params box is missing').toBeDefined()
    expect((box as HTMLTextAreaElement).value).not.toMatch(/authorizationHeader|stored/)
  })

  it('is kept by a save that leaves it alone: the reference goes back, not a value', async () => {
    grant(HOOK_ADMIN)
    serve([RELAY])
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    await openRule(RELAY.name)

    const name = screen.getByRole('textbox', { name: says('automationsPage.config.name') })
    await user.clear(name)
    await user.type(name, 'Relay 2')
    await user.click(screen.getByRole('button', { name: says('automationsPage.editor.save') }))

    await waitFor(() => expect(updateRule).toHaveBeenCalled())
    expect(sentParams()).toEqual({ url: 'https://hooks.example.com/in', authorizationHeader: REFERENCE })
  })

  it('is removed by «Удалить»: the save sends null', async () => {
    grant(HOOK_ADMIN)
    serve([RELAY])
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    await openRule(RELAY.name)

    await user.click(screen.getByRole('button', { name: says('automationsPage.actions.header.remove') }))
    expect(screen.getByText(says('automationsPage.actions.header.none'))).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: says('automationsPage.editor.save') }))

    await waitFor(() => expect(updateRule).toHaveBeenCalled())
    expect(sentParams()).toEqual({ url: 'https://hooks.example.com/in', authorizationHeader: null })
  })

  it('is replaced by «Заменить» only once the new value is applied — an abandoned one keeps it', async () => {
    grant(HOOK_ADMIN)
    serve([RELAY])
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    await openRule(RELAY.name)

    await user.click(screen.getByRole('button', { name: says('automationsPage.actions.header.replace') }))
    const input = screen.getByRole('textbox', { name: says('automationsPage.actions.header.newValueAria') })
    await user.type(input, 'Bearer half-typed')
    await user.click(screen.getByRole('button', { name: says('automationsPage.actions.header.cancel') }))
    expect(screen.getByText(says('automationsPage.actions.header.saved'))).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: says('automationsPage.actions.header.replace') }))
    await user.type(
      screen.getByRole('textbox', { name: says('automationsPage.actions.header.newValueAria') }),
      'Bearer brand-new',
    )
    await user.click(screen.getByRole('button', { name: says('automationsPage.actions.header.apply') }))
    await user.click(screen.getByRole('button', { name: says('automationsPage.editor.save') }))

    await waitFor(() => expect(updateRule).toHaveBeenCalled())
    expect(sentParams()).toEqual({ url: 'https://hooks.example.com/in', authorizationHeader: 'Bearer brand-new' })
  })

  it('warns when the URL is moved to another host, where a kept header will not follow', async () => {
    grant(HOOK_ADMIN)
    serve([RELAY])
    renderWithProviders(<AutomationsPage />)
    await openRule(RELAY.name)

    expect(screen.queryByText(says('automationsPage.actions.header.moved'))).not.toBeInTheDocument()
    const box = screen.getAllByRole('textbox').find((element) => (element as HTMLTextAreaElement).value.includes('hooks.example.com'))!
    // `fireEvent` rather than typing: the box parses on every keystroke and keeps
    // the last valid JSON, so the whole new value is set at once.
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.change(box, { target: { value: JSON.stringify({ url: 'https://collector.example.net/grab' }) } })

    expect(await screen.findByText(says('automationsPage.actions.header.moved'))).toBeInTheDocument()
  })

  it('warns as soon as the URL changes at all — another path on the same host is another receiver', async () => {
    grant(HOOK_ADMIN)
    serve([RELAY])
    renderWithProviders(<AutomationsPage />)
    await openRule(RELAY.name)

    const box = screen.getAllByRole('textbox').find((element) => (element as HTMLTextAreaElement).value.includes('hooks.example.com'))!
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.change(box, { target: { value: JSON.stringify({ url: 'https://hooks.example.com/in/elsewhere' }) } })

    expect(await screen.findByText(says('automationsPage.actions.header.moved'))).toBeInTheDocument()
    expect(screen.getByText(says('automationsPage.actions.header.saved'))).toBeInTheDocument()
  })

  it('warns when an action above it is removed: a kept header stays with the place it was saved at', async () => {
    const shifted: AutomationRule = {
      ...RELAY,
      id: 'rule-shifted',
      name: 'Shifted',
      actions: [
        { type: 'notify_telegram', params: { text: 'fired' } },
        { type: 'webhook_post', params: { url: 'https://hooks.example.com/in', authorizationHeader: { stored: true, index: 1 } } },
      ],
    }
    grant(HOOK_ADMIN)
    serve([shifted])
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    await openRule(shifted.name)

    expect(screen.queryByText(says('automationsPage.actions.header.shifted'))).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: says('automationsPage.actions.removeAria', { index: 1 }) }))

    expect(await screen.findByText(says('automationsPage.actions.header.shifted'))).toBeInTheDocument()
  })
})

describe('a URL the panel shows only in part', () => {
  it('says why, and keeps the marker out of the params box', async () => {
    const hidden: AutomationRule = {
      ...RELAY,
      id: 'rule-hidden',
      name: 'Hidden',
      actions: [{ type: 'webhook_post', params: { url: 'https://hooks.example.com/…', urlHidden: { stored: true, index: 0 } } }],
    }
    usePermissionStore.setState({
      loaded: true,
      loading: false,
      granted: new Set(['automations:view']),
      mustChangePassword: false,
      role: 'ADMIN',
      rbacRoleId: 'role-1',
      error: null,
    })
    serve([hidden])
    renderWithProviders(<AutomationsPage />)
    await openRule(hidden.name)

    expect(screen.getByText(says('automationsPage.actions.urlHidden'))).toBeInTheDocument()
    const box = screen.getAllByRole('textbox').find((element) => (element as HTMLTextAreaElement).value.includes('hooks.example.com'))
    expect(box, 'the params box is missing').toBeDefined()
    expect((box as HTMLTextAreaElement).value).not.toMatch(/urlHidden/)
  })
})

describe('a switch refused because the rule changed', () => {
  it('names the rule, says what happened, and reloads the rule open in the editor', async () => {
    grant(HOOK_ADMIN)
    serve([RELAY])
    vi.mocked(toggleRule).mockRejectedValue({
      isAxiosError: true,
      message: 'Request failed with status code 409',
      response: {
        status: 409,
        data: { statusCode: 409, message: 'The rule changed while it was being switched on — reload it and try again' },
      },
    })
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    await openRule(RELAY.name)
    const readsBefore = vi.mocked(getRule).mock.calls.length

    await user.click(screen.getByRole('switch', { name: says('automationsPage.list.toggleAria', { name: RELAY.name }) }))

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        says('automationsPage.toast.toggleFailed', {
          name: RELAY.name,
          message: says('automationsPage.serverErrors.ruleChanged'),
        }),
      ),
    )
    await waitFor(() => expect(vi.mocked(getRule).mock.calls.length).toBeGreaterThan(readsBefore))
  })
})

describe('the rule templates', () => {
  it('offer none that blocks an address on an event', async () => {
    grant([...HOOK_ADMIN, { resource: 'blocked_ips', action: 'create' }])
    serve([RELAY])
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: says('automationsPage.help.title') }))

    const templates = screen.getByText(says('automationsPage.help.templatesTitle')).parentElement!
    expect(within(templates).getAllByRole('button', { name: says('automationsPage.help.useTemplate') }).length).toBeGreaterThan(0)
    expect(i18n.exists('automationsPage.templates.fraud_block_ip.name')).toBe(false)
    expect(templates).not.toHaveTextContent(/Антифрод → блок IP|Anti-fraud → block IP/)
  })
})
