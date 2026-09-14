/**
 * WHAT THE RULE EDITOR KEEPS, AND WHAT IT LETS GO, AS A RULE MOVES ON.
 *
 * Five things an operator met on Automations → Rules:
 *
 *   - A SAVE THE EDITOR FORGOT. «Сохранить» is answered with the rule as saved,
 *     and only the list was refreshed with it: the rule's own copy stayed the
 *     one read before the save. Back on the rule while that copy still counted
 *     as fresh, the editor was seeded from it — the old name, the old switch —
 *     and a second «Сохранить» wrote the old rule back over the new one without
 *     a word.
 *   - TYPING THAT A SAVE'S ANSWER THREW AWAY. Once that answer became the
 *     rule's copy, the draft started over from it, since its content had moved.
 *     Whatever the operator typed or switched while the save was still running
 *     vanished the moment it answered — and «Создать» had always dropped it.
 *   - TYPING THAT A RUN THREW AWAY. Every execution writes the rule's run
 *     columns, which moves `updatedAt`, and the draft started over whenever
 *     `updatedAt` moved. «Запустить» re-reads the rule, so whatever the operator
 *     had typed and not saved was replaced by the copy on the server.
 *   - A TAB AND A SPINNER THAT CARRIED OVER. One editor served every rule, so
 *     «Выполнения» stayed selected on the next rule — on a new draft, which has
 *     no such tab, the card had no body at all — and a save still running on
 *     one rule kept «Сохранить» spinning and disabled on the next.
 *   - A READ THAT FAILED FOR EVER. A failed read of the rule left the skeleton
 *     pulsing, with nothing to say and nothing to press; clicking the rule again
 *     did nothing, because it was already the selected one.
 *
 * The page runs on the panel's OWN query defaults. The first case exists only
 * because a copy read a moment ago is served again without a read; the shared
 * test client re-reads on every mount, which would hide it.
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePermissionStore, type RbacAction } from '@/features/rbac'
import { listUserHints } from '@/features/user-hints/user-hints-api'
import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { queryClient as panelQueryClient } from '@/lib/query-client'
import { formatDateTime } from '@/lib/utils'
import AutomationsPage from './automations-page'
import {
  createRule,
  getCatalog,
  getRule,
  listExecutions,
  listRules,
  runRuleManually,
  updateRule,
  type AutomationRule,
  type UpsertRulePayload,
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

const FIRST: AutomationRule = {
  id: 'rule-first',
  name: 'Payment failure alert',
  description: null,
  isEnabled: true,
  triggerKind: 'REALTIME',
  triggerSpec: 'payment.failed',
  conditions: null,
  actions: [{ type: 'notify_telegram', params: { text: 'Payment failed' } }],
  createdById: 'admin-1',
  lastRunAt: null,
  lastRunStatus: null,
  lastRunMessage: null,
  runCount: 0,
  createdAt: '2026-06-04T10:00:00.000Z',
  updatedAt: '2026-06-04T10:00:00.000Z',
}

const SECOND: AutomationRule = {
  ...FIRST,
  id: 'rule-second',
  name: 'Node down alert',
  triggerSpec: 'node.connection_lost',
  actions: [{ type: 'notify_telegram', params: { text: 'Node down' } }],
  createdAt: '2026-07-01T08:15:00.000Z',
  updatedAt: '2026-07-01T08:15:00.000Z',
}

/** A rule that makes the editor draw every kind of control it has. */
const EVERY_CONTROL: AutomationRule = {
  ...FIRST,
  id: 'rule-every-control',
  name: 'Every control',
  conditions: { '==': ['$severity', 'HIGH'] },
  actions: [
    { type: 'notify_telegram', params: { text: 'Payment failed' } },
    { type: 'show_hint', params: { hintKey: 'payment-failed' } },
    { type: 'show_hint_to_audience', params: { hintKey: 'payment-failed', audience: 'paid-not-connected' } },
  ],
}

/** A copy as it comes off the wire: equal to the row, never the same object. */
function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * The panel as far as these rules go: the rows it holds, and its answers,
 * written the way `automations.service.ts` and the executor write them.
 */
function servePanel(initial: readonly AutomationRule[]) {
  const rows = new Map(initial.map((rule) => [rule.id, rule]))
  let clock = Date.parse('2026-09-14T10:00:00.000Z')
  const now = (): string => new Date((clock += 60_000)).toISOString()
  const saved = (row: AutomationRule, payload: UpsertRulePayload): AutomationRule => ({
    ...row,
    name: payload.name,
    description: payload.description ?? null,
    isEnabled: payload.isEnabled ?? true,
    triggerKind: payload.triggerKind,
    triggerSpec: payload.triggerSpec,
    conditions: payload.conditions ?? null,
    actions: payload.actions,
    updatedAt: now(),
  })

  vi.mocked(listRules).mockImplementation(async () => wire([...rows.values()]))
  vi.mocked(getRule).mockImplementation(async (id) => {
    const row = rows.get(id)
    if (row === undefined) throw new Error(`the panel holds no rule ${id}`)
    return wire(row)
  })
  vi.mocked(createRule).mockImplementation(async (payload) => {
    const row = saved({ ...FIRST, id: 'rule-created', createdAt: now() }, payload)
    rows.set(row.id, row)
    return wire(row)
  })
  vi.mocked(updateRule).mockImplementation(async (id, payload) => {
    const row = saved(rows.get(id)!, payload)
    rows.set(id, row)
    return wire(row)
  })
  vi.mocked(runRuleManually).mockImplementation(async (id) => {
    const row = rows.get(id)!
    const finishedAt = now()
    // The run columns — and `updatedAt`, which Prisma's @updatedAt moves with
    // any write to the row. Nothing the operator edits.
    rows.set(id, {
      ...row,
      runCount: row.runCount + 1,
      lastRunAt: finishedAt,
      lastRunStatus: 'SUCCEEDED',
      lastRunMessage: null,
      updatedAt: finishedAt,
    })
    return { executionId: `execution-${finishedAt}`, status: 'SUCCEEDED', actionResults: [], errorMessage: null }
  })

  return {
    row: (id: string): AutomationRule => wire(rows.get(id)!),
    savedAs: saved,
  }
}

/**
 * The page on the panel's own query defaults, in a client of this test's own.
 */
function renderPage(): void {
  const client = new QueryClient({ defaultOptions: panelQueryClient.getDefaultOptions() })
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AutomationsPage />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  )
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

/** The sentence a key renders right now — looked up, never restated. */
function says(key: string, values?: Record<string, unknown>): string {
  const sentence = String(i18n.t(key, values ?? {}))
  expect(sentence, `${key} is missing from the loaded bundles`).not.toBe(key)
  return sentence
}

function nameField(): HTMLElement {
  return screen.getByRole('textbox', { name: says('automationsPage.config.name') })
}

function ruleInList(name: string): HTMLElement {
  return screen.getByRole('button', { name: says('automationsPage.list.selectAria', { name }) })
}

function descriptionField(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: says('automationsPage.config.description') })
}

/** The editor's own card. The list, with a switch on every rule, is another. */
function editorCard(): HTMLElement {
  const save = screen.queryByRole('button', { name: says('automationsPage.editor.save') })
    ?? screen.getByRole('button', { name: says('automationsPage.editor.create') })
  const card = save.closest<HTMLElement>('[data-concept-surface="card"]')
  if (card === null) throw new Error('the editor is not drawn in a card')
  return card
}

/** The on/off switch in the editor's header. */
function editorSwitch(): HTMLElement {
  return within(editorCard()).getByRole('switch')
}

/**
 * Every control in the editor that changes the draft: the switch in its header
 * and everything on «Настройка». Not «Запустить», «Удалить» or the tabs, which
 * change nothing in it.
 */
function controlsThatEdit(): HTMLElement[] {
  const settings = within(editorCard()).getByRole('tabpanel')
  return [
    editorSwitch(),
    ...settings.querySelectorAll<HTMLElement>(
      'input:not([aria-hidden="true"]), textarea, select:not([aria-hidden="true"]), button',
    ),
  ]
}

/** Enough to tell one control from another in a failure. */
function labelOf(control: HTMLElement): string {
  const label = control.id === '' ? null : document.querySelector(`label[for="${control.id}"]`)
  const name = control.getAttribute('aria-label') ?? label?.textContent ?? control.textContent ?? ''
  return `<${control.tagName.toLowerCase()} role=${control.getAttribute('role') ?? '-'}> «${name.trim()}»`
}

/** The existing-rule header of `rule`, as the editor composes it. */
function headerOf(rule: AutomationRule): string {
  return says('automationsPage.editor.existingDescription', {
    createdAt: formatDateTime(rule.createdAt),
    runCount: rule.runCount,
  })
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

/** A rejection as axios raises it when the request never reached the server. */
function unreachable(): Error {
  return Object.assign(new Error('Network Error'), { isAxiosError: true, code: 'ERR_NETWORK' })
}

/**
 * Lets an answer that has already been given reach the screen. The query cache
 * hands its updates to the page in a timeout of its own, so an answer that
 * changes nothing on screen cannot be waited for by what it shows.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
}

beforeEach(async () => {
  usePermissionStore.getState().reset()
  grant([
    { resource: 'automations', action: 'view' },
    { resource: 'automations', action: 'create' },
    { resource: 'automations', action: 'edit' },
  ])
  vi.mocked(getCatalog).mockResolvedValue({ actionTypes: ['notify_telegram'], coincidentEventGroups: [] })
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

describe('after «Сохранить»', () => {
  const RENAMED = 'Payment failure alert, renamed'

  it('opens the rule as saved when the operator comes back to it, and a second save keeps it', async () => {
    const panel = servePanel([FIRST, SECOND])
    renderPage()
    const user = userEvent.setup()
    expect(
      await screen.findByRole('textbox', { name: says('automationsPage.config.name') }),
    ).toHaveValue(FIRST.name)

    await user.clear(nameField())
    await user.type(nameField(), RENAMED)
    await user.click(screen.getByRole('button', { name: says('automationsPage.editor.save') }))
    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith(says('automationsPage.toast.updated'))
    })

    await user.click(ruleInList(SECOND.name))
    expect(await screen.findByText(headerOf(SECOND))).toBeInTheDocument()
    await user.click(await screen.findByRole('button', {
      name: says('automationsPage.list.selectAria', { name: RENAMED }),
    }))
    expect(await screen.findByText(headerOf(panel.row(FIRST.id)))).toBeInTheDocument()

    // The window this case lives in: the rule was not read again on the way
    // back, so what the editor shows is whatever copy it was holding.
    expect(vi.mocked(getRule).mock.calls.filter(([id]) => id === FIRST.id)).toHaveLength(1)
    expect(nameField()).toHaveValue(RENAMED)

    await user.click(screen.getByRole('button', { name: says('automationsPage.editor.save') }))
    await waitFor(() => {
      expect(updateRule).toHaveBeenCalledTimes(2)
    })
    expect(vi.mocked(updateRule).mock.calls[1]![1].name).toBe(RENAMED)
    await waitFor(() => {
      expect(panel.row(FIRST.id).name).toBe(RENAMED)
    })
  })

  it('keeps the saved copy when a read of the rule begun before the save answers after it', async () => {
    const panel = servePanel([FIRST])
    renderPage()
    const user = userEvent.setup()
    expect(
      await screen.findByRole('textbox', { name: says('automationsPage.config.name') }),
    ).toHaveValue(FIRST.name)

    // «Запустить» re-reads the rule, and that read is still out when the
    // operator saves. It carries the rule as it stood before the save.
    const lateRead = deferred<AutomationRule>()
    vi.mocked(getRule).mockImplementationOnce(() => lateRead.promise)
    await user.click(screen.getByRole('button', { name: says('automationsPage.editor.runNow') }))
    await waitFor(() => {
      expect(getRule).toHaveBeenCalledTimes(2)
    })
    const beforeTheSave = panel.row(FIRST.id)

    await user.clear(nameField())
    await user.type(nameField(), RENAMED)
    await user.click(screen.getByRole('button', { name: says('automationsPage.editor.save') }))
    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith(says('automationsPage.toast.updated'))
    })

    lateRead.resolve(beforeTheSave)
    await settle()

    expect(nameField()).toHaveValue(RENAMED)
    expect(beforeTheSave.name, 'anti-vacuity: the late read carried the old name').toBe(FIRST.name)
  })

  it('opens a rule it has just created at once, from the answer to «Создать»', async () => {
    servePanel([])
    // Whatever reads the created rule back never gets an answer.
    vi.mocked(getRule).mockImplementation(() => new Promise<AutomationRule>(() => {}))
    renderPage()
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: says('automationsPage.newRule') }))
    await user.click(await screen.findByRole('button', { name: says('automationsPage.editor.create') }))
    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith(says('automationsPage.toast.created'))
    })
    const created = await vi.mocked(createRule).mock.results[0]!.value

    expect(await screen.findByText(headerOf(created))).toBeInTheDocument()
    expect(nameField()).toHaveValue(says('automationsPage.untitledRule'))
  })
})

describe('while «Сохранить» is still running', () => {
  const RENAMED = 'Payment failure alert, renamed'

  it('loses nothing the operator types or switches before its answer lands', async () => {
    const panel = servePanel([FIRST])
    const answer = deferred<void>()
    const serveUpdate = vi.mocked(updateRule).getMockImplementation()!
    vi.mocked(updateRule).mockImplementationOnce(async (id, payload) => {
      await answer.promise
      return serveUpdate(id, payload)
    })
    renderPage()
    const user = userEvent.setup()
    expect(
      await screen.findByRole('textbox', { name: says('automationsPage.config.name') }),
    ).toHaveValue(FIRST.name)

    await user.clear(nameField())
    await user.type(nameField(), RENAMED)
    await user.click(screen.getByRole('button', { name: says('automationsPage.editor.save') }))
    // Anti-vacuity: the save is out, and it carries a name, so its answer is
    // not the copy the draft was taken from.
    expect(screen.getByRole('button', { name: says('automationsPage.editor.save') })).toBeDisabled()
    expect(vi.mocked(updateRule).mock.calls[0]![1].name).toBe(RENAMED)

    await user.type(nameField(), ', and then some')
    await user.type(descriptionField(), 'Typed while the save runs')
    await user.click(editorSwitch())
    const whileSaving = {
      name: (nameField() as HTMLInputElement).value,
      description: descriptionField().value,
      switchedOn: editorSwitch().getAttribute('aria-checked'),
    }

    answer.resolve()
    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith(says('automationsPage.toast.updated'))
    })
    await settle()
    expect(panel.row(FIRST.id).name, 'anti-vacuity: the save went through').toBe(RENAMED)

    // What each field showed while the save ran, it shows now: it either never
    // took the typing, or it kept it.
    expect(nameField()).toHaveValue(whileSaving.name)
    expect(descriptionField()).toHaveValue(whileSaving.description)
    expect(editorSwitch()).toHaveAttribute('aria-checked', whileSaving.switchedOn)

    // And with the answer in, the rule takes typing again.
    await user.type(descriptionField(), 'Typed after')
    expect(descriptionField()).toHaveValue(`${whileSaving.description}Typed after`)
  })

  it('loses nothing typed into a new rule while «Создать» runs', async () => {
    servePanel([])
    const answer = deferred<void>()
    const serveCreate = vi.mocked(createRule).getMockImplementation()!
    vi.mocked(createRule).mockImplementationOnce(async (payload) => {
      await answer.promise
      return serveCreate(payload)
    })
    renderPage()
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: says('automationsPage.newRule') }))
    await user.click(await screen.findByRole('button', { name: says('automationsPage.editor.create') }))
    expect(screen.getByRole('button', { name: says('automationsPage.editor.create') })).toBeDisabled()

    await user.type(descriptionField(), 'Typed while the rule is created')
    const whileCreating = descriptionField().value

    answer.resolve()
    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith(says('automationsPage.toast.created'))
    })
    const created = await vi.mocked(createRule).mock.results[0]!.value
    expect(await screen.findByText(headerOf(created))).toBeInTheDocument()

    expect(descriptionField()).toHaveValue(whileCreating)
  })

  it('takes no input on any control that edits the rule, and hands every one back when it answers', async () => {
    servePanel([EVERY_CONTROL])
    const answer = deferred<void>()
    const serveUpdate = vi.mocked(updateRule).getMockImplementation()!
    vi.mocked(updateRule).mockImplementationOnce(async (id, payload) => {
      await answer.promise
      return serveUpdate(id, payload)
    })
    renderPage()
    const user = userEvent.setup()
    await screen.findByRole('textbox', { name: says('automationsPage.config.name') })

    // Anti-vacuity: the editor drew its controls — the switch, the fields, the
    // pickers and the action buttons — and all of them take input.
    const drawn = controlsThatEdit()
    expect(drawn.length, drawn.map(labelOf).join('\n')).toBeGreaterThanOrEqual(17)
    for (const control of drawn) expect(control, labelOf(control)).toBeEnabled()

    await user.click(screen.getByRole('button', { name: says('automationsPage.editor.save') }))
    expect(screen.getByRole('button', { name: says('automationsPage.editor.save') })).toBeDisabled()
    for (const control of controlsThatEdit()) expect(control, labelOf(control)).toBeDisabled()

    answer.resolve()
    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith(says('automationsPage.toast.updated'))
    })
    await settle()
    const after = controlsThatEdit()
    expect(after).toHaveLength(drawn.length)
    for (const control of after) expect(control, labelOf(control)).toBeEnabled()
  })

  it('gives the fields back, with the draft as it was, when the save fails', async () => {
    servePanel([FIRST])
    const refusal = deferred<void>()
    vi.mocked(updateRule).mockImplementationOnce(async () => {
      await refusal.promise
      throw unreachable()
    })
    renderPage()
    const user = userEvent.setup()
    expect(
      await screen.findByRole('textbox', { name: says('automationsPage.config.name') }),
    ).toHaveValue(FIRST.name)

    await user.clear(nameField())
    await user.type(nameField(), RENAMED)
    await user.click(screen.getByRole('button', { name: says('automationsPage.editor.save') }))
    expect(nameField(), 'anti-vacuity: the save is running').toBeDisabled()

    refusal.resolve()
    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledTimes(1)
    })
    await settle()

    expect(nameField()).toBeEnabled()
    expect(nameField()).toHaveValue(RENAMED)
    await user.type(nameField(), ', retried')
    expect(nameField()).toHaveValue(`${RENAMED}, retried`)
  })
})

describe('«Запустить»', () => {
  it('keeps what the operator typed and has not saved', async () => {
    const panel = servePanel([FIRST])
    renderPage()
    const user = userEvent.setup()
    expect(
      await screen.findByRole('textbox', { name: says('automationsPage.config.name') }),
    ).toHaveValue(FIRST.name)

    await user.clear(nameField())
    await user.type(nameField(), 'Typed, not saved yet')
    await user.click(screen.getByRole('button', { name: says('automationsPage.editor.runNow') }))
    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith(
        says('automationsPage.toast.runFinished', { status: 'SUCCEEDED' }),
      )
    })

    // The re-read is in hand: the header counts the run it recorded.
    expect(panel.row(FIRST.id).runCount).toBe(1)
    expect(await screen.findByText(headerOf(panel.row(FIRST.id)))).toBeInTheDocument()
    expect(nameField()).toHaveValue('Typed, not saved yet')
  })
})

describe('moving to another rule', () => {
  it('opens the next saved rule on «Настройка»', async () => {
    servePanel([FIRST, SECOND])
    renderPage()
    const user = userEvent.setup()
    await screen.findByRole('textbox', { name: says('automationsPage.config.name') })
    // Both rules already read once this visit, the ordinary state of a page an
    // operator has been working on: moving between them draws no placeholder,
    // and nothing in between gets the chance to start the editor afresh.
    await user.click(ruleInList(SECOND.name))
    expect(await screen.findByText(headerOf(SECOND))).toBeInTheDocument()
    await user.click(ruleInList(FIRST.name))
    expect(await screen.findByText(headerOf(FIRST))).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: says('automationsPage.editor.tabs.executions') }))
    expect(await screen.findByText(says('automationsPage.executions.empty'))).toBeInTheDocument()

    await user.click(ruleInList(SECOND.name))
    expect(await screen.findByText(headerOf(SECOND))).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: says('automationsPage.editor.tabs.config') })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(nameField()).toHaveValue(SECOND.name)
  })

  it('opens a new draft on «Настройка», with its fields, when the last rule was left on «Выполнения»', async () => {
    servePanel([FIRST])
    renderPage()
    const user = userEvent.setup()
    await screen.findByRole('textbox', { name: says('automationsPage.config.name') })

    await user.click(screen.getByRole('tab', { name: says('automationsPage.editor.tabs.executions') }))
    expect(await screen.findByText(says('automationsPage.executions.empty'))).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: says('automationsPage.newRule') }))
    expect(
      await screen.findByRole('button', { name: says('automationsPage.editor.create') }),
    ).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: says('automationsPage.editor.tabs.config') })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(nameField()).toHaveValue(says('automationsPage.untitledRule'))
  })

  it('does not carry a save still running on one rule over to the next', async () => {
    const panel = servePanel([FIRST, SECOND])
    const running = deferred<AutomationRule>()
    vi.mocked(updateRule).mockImplementationOnce(() => running.promise)
    renderPage()
    const user = userEvent.setup()
    await screen.findByRole('textbox', { name: says('automationsPage.config.name') })

    await user.click(screen.getByRole('button', { name: says('automationsPage.editor.save') }))
    // Anti-vacuity: the save on the first rule is running.
    expect(screen.getByRole('button', { name: says('automationsPage.editor.save') })).toBeDisabled()

    await user.click(ruleInList(SECOND.name))
    expect(await screen.findByText(headerOf(SECOND))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: says('automationsPage.editor.save') })).toBeEnabled()

    // Let the first save finish, so nothing is left running past this case.
    running.resolve(panel.savedAs(panel.row(FIRST.id), vi.mocked(updateRule).mock.calls[0]![1]))
    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith(says('automationsPage.toast.updated'))
    })
  })
})

describe('a read of the rule that fails', () => {
  it('says why, in the panel’s words, and reads the rule again on «Повторить»', async () => {
    servePanel([FIRST])
    vi.mocked(getRule).mockRejectedValueOnce(unreachable())
    renderPage()
    const user = userEvent.setup()

    const message = await screen.findByText(says('errors.serverUnreachable'))
    const alert = message.closest('[role="alert"]')
    expect(alert, 'the reason is not in an alert').not.toBeNull()
    expect(alert).not.toHaveTextContent('Network Error')

    await user.click(within(alert as HTMLElement).getByRole('button', { name: says('common.retry') }))

    expect(
      await screen.findByRole('textbox', { name: says('automationsPage.config.name') }),
    ).toHaveValue(FIRST.name)
    expect(getRule).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(says('errors.serverUnreachable'))).toBeNull()
  })
})
