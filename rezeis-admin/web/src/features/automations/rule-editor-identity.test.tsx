/**
 * THE RULE EDITOR DRAWS ONE RULE, AND ONLY WITH THAT RULE IN HAND.
 *
 * Reported from production (panel 0.9.7.56): on Automations → Rules the owner
 * applied the «Первое появление» pop-up, pressed Create, read «Правило создано»
 * — and the page was replaced by the error screen. The client report named
 * `RangeError: Invalid time value`, thrown by the date helper from inside the
 * rule editor.
 *
 * `onSaved` moves the selection from the draft's synthetic `__new__` id to the
 * id the server just gave the rule. The editor is the same component instance,
 * so the first render under the new id still holds the DRAFT in state while the
 * query under that id has nothing yet. The "adjust state while rendering" block
 * schedules the reset — and the rest of that same render carried on with the
 * old draft, `isNew` now false, and built the existing-rule header out of a rule
 * it did not have: `formatDateTime(undefined ?? '')`. React throws away the
 * output of a render that scheduled an update, but only once it returns, and
 * this one never returned.
 *
 * The same render runs whenever the selection moves to a rule whose detail has
 * not been read yet — which is also what clicking a second rule in the list
 * does.
 *
 * WHY THE DATE HELPER IS WATCHED. A render that set state is discarded, so a
 * header drawn from the wrong rule never reaches the DOM once the helper stops
 * throwing: on screen, a fixed editor and a broken one look the same. The date
 * is the one value in that header that only the rule's own data can supply, so
 * every value the helper is handed here must be a real date — and the positive
 * control below keeps that check from passing because nothing called it at all.
 */
import { Suspense } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ErrorBoundary } from '@/components/ErrorBoundary'
import { usePermissionStore, type RbacAction } from '@/features/rbac'
import { createUserHint, listUserHints } from '@/features/user-hints/user-hints-api'
import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { reportReactError } from '@/lib/client-logger'
import { formatDateTime } from '@/lib/utils'
import { renderWithProviders } from '@/test/test-utils'
import AutomationsPage from './automations-page'
import {
  createRule,
  getCatalog,
  getRule,
  listExecutions,
  listRules,
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

// What the route's boundary sends home — the report the owner forwarded.
vi.mock('@/lib/client-logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/client-logger')>()),
  reportReactError: vi.fn(),
}))

// The real helper, watched. See the header for why. The unwatched original is
// kept aside so the expected header can be composed without adding a call.
const real = vi.hoisted(() => ({
  formatDateTime: (() => '') as (date: string | Date) => string,
}))
vi.mock('@/lib/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils')>()
  real.formatDateTime = actual.formatDateTime
  return { ...actual, formatDateTime: vi.fn(actual.formatDateTime) }
})

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

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function savedRule(overrides: Partial<AutomationRule> & Pick<AutomationRule, 'id' | 'name'>): AutomationRule {
  return {
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
    ...overrides,
  }
}

/** The page inside the same boundary and Suspense the router gives it. */
function renderPageAsRouted(): void {
  renderWithProviders(
    <ErrorBoundary>
      <Suspense fallback={null}>
        <AutomationsPage />
      </Suspense>
    </ErrorBoundary>,
  )
}

/** The page survived: no boundary report, no error screen. */
function expectPageAlive(): void {
  expect(vi.mocked(reportReactError).mock.calls.map(([error]) => String(error))).toEqual([])
  expect(screen.queryByText(says('errorBoundary.title'))).toBeNull()
}

/**
 * Every value the date helper was handed was a real date, and the header of
 * `rule` was among them.
 */
function expectHeadersDrawnOnlyFromRealRules(rule: AutomationRule): void {
  const handed = vi.mocked(formatDateTime).mock.calls.map(([value]) => value)
  const missing = handed.filter((value) =>
    value instanceof Date ? Number.isNaN(value.getTime()) : Number.isNaN(Date.parse(String(value))),
  )
  expect(missing, 'the editor built a rule header without that rule').toEqual([])
  expect(handed, 'anti-vacuity: the header of the rule on screen was drawn').toContain(rule.createdAt)
}

/** The existing-rule header of `rule`, as the editor composes it. */
function headerOf(rule: AutomationRule): string {
  return says('automationsPage.editor.existingDescription', {
    createdAt: real.formatDateTime(rule.createdAt),
    runCount: rule.runCount,
  })
}

beforeEach(async () => {
  usePermissionStore.getState().reset()
  vi.mocked(getCatalog).mockResolvedValue({ actionTypes: ['show_hint'], coincidentEventGroups: [] })
  vi.mocked(getEventCatalog).mockResolvedValue({ events: [], windowDays: 30 })
  vi.mocked(listExecutions).mockResolvedValue({ items: [], nextCursor: null })
  vi.mocked(listUserHints).mockResolvedValue([])
  vi.mocked(createUserHint).mockResolvedValue({ titleRu: 'Добро пожаловать' } as never)
  await i18nReady
  await loadFeatureBundle('automations')
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('pressing Create on a ready-made pop-up', () => {
  const CREATED_AT = '2026-09-14T09:30:00.000Z'

  /** What the server answers a create with: the payload, saved, with an id. */
  function asCreated(payload: UpsertRulePayload): AutomationRule {
    return savedRule({
      id: 'rule-created',
      name: payload.name,
      description: payload.description ?? null,
      isEnabled: payload.isEnabled ?? false,
      triggerKind: payload.triggerKind,
      triggerSpec: payload.triggerSpec,
      conditions: payload.conditions ?? null,
      actions: payload.actions,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    })
  }

  /**
   * The owner's steps: the help card, the «Первое появление» template, Create.
   * Returns the rule the server answered with.
   */
  async function applyWelcomeAndCreate(): Promise<AutomationRule> {
    grant([
      { resource: 'automations', action: 'view' },
      { resource: 'automations', action: 'create' },
      { resource: 'user_hints', action: 'create' },
    ])
    let created: AutomationRule | undefined
    vi.mocked(createRule).mockImplementation(async (payload) => {
      created = asCreated(payload)
      return created
    })

    renderPageAsRouted()
    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('button', { name: says('automationsPage.help.title') }),
    )
    const card = (await screen.findByText(says('automationsPage.hintTemplates.welcome.name')))
      .parentElement
    expect(card).not.toBeNull()
    await user.click(
      within(card!).getByRole('button', { name: says('automationsPage.help.useTemplate') }),
    )

    // The draft is open under the template's name, with the Create button.
    expect(
      await screen.findByRole('textbox', { name: says('automationsPage.config.name') }),
    ).toHaveValue(says('automationsPage.hintTemplates.welcome.name'))
    await user.click(screen.getByRole('button', { name: says('automationsPage.editor.create') }))

    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith(says('automationsPage.toast.created'))
    })
    expect(created, 'the create request was never sent').toBeDefined()
    expect(created!.triggerSpec).toBe('user.registered')
    return created!
  }

  it('keeps the page alive while the created rule is still being read', async () => {
    const detail = deferred<AutomationRule>()
    vi.mocked(listRules).mockResolvedValue([])
    vi.mocked(getRule).mockReturnValue(detail.promise)

    const created = await applyWelcomeAndCreate()
    expectPageAlive()

    detail.resolve(created)
    expect(await screen.findByText(headerOf(created))).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: says('automationsPage.config.name') })).toHaveValue(
      created.name,
    )
    expect(vi.mocked(getRule)).toHaveBeenCalledWith('rule-created')
    expectPageAlive()
    expectHeadersDrawnOnlyFromRealRules(created)
  })

  it('keeps the page alive when the created rule is read at once', async () => {
    vi.mocked(listRules).mockResolvedValue([])
    vi.mocked(getRule).mockImplementation(async (id) => {
      const answer = vi.mocked(createRule).mock.results[0]
      expect(answer, `the detail of ${id} was read before anything was created`).toBeDefined()
      return (await answer!.value) as AutomationRule
    })

    const created = await applyWelcomeAndCreate()

    expect(await screen.findByText(headerOf(created))).toBeInTheDocument()
    expectPageAlive()
    expectHeadersDrawnOnlyFromRealRules(created)
  })

  it('keeps the page alive when the refreshed list lands before the rule', async () => {
    const detail = deferred<AutomationRule>()
    const refreshedList = deferred<AutomationRule[]>()
    vi.mocked(listRules).mockResolvedValueOnce([]).mockReturnValue(refreshedList.promise)
    vi.mocked(getRule).mockReturnValue(detail.promise)

    const created = await applyWelcomeAndCreate()
    expectPageAlive()

    refreshedList.resolve([created])
    expect(
      await screen.findByRole('button', {
        name: says('automationsPage.list.selectAria', { name: created.name }),
      }),
    ).toBeInTheDocument()
    expectPageAlive()

    detail.resolve(created)
    expect(await screen.findByText(headerOf(created))).toBeInTheDocument()
    expectPageAlive()
    expectHeadersDrawnOnlyFromRealRules(created)
  })
})

describe('moving between two saved rules', () => {
  it('keeps the page alive, showing nothing of the first rule, while the second is read', async () => {
    grant([
      { resource: 'automations', action: 'view' },
      { resource: 'automations', action: 'edit' },
    ])
    const first = savedRule({ id: 'rule-first', name: 'Payment failure alert' })
    const second = savedRule({
      id: 'rule-second',
      name: 'Node down alert',
      triggerSpec: 'node.connection_lost',
      createdAt: '2026-07-01T08:15:00.000Z',
      updatedAt: '2026-07-01T08:15:00.000Z',
    })
    const secondDetail = deferred<AutomationRule>()
    vi.mocked(listRules).mockResolvedValue([first, second])
    vi.mocked(getRule).mockImplementation((id) =>
      id === first.id ? Promise.resolve(first) : secondDetail.promise,
    )

    renderPageAsRouted()
    const user = userEvent.setup()
    const nameField = await screen.findByRole('textbox', { name: says('automationsPage.config.name') })
    expect(nameField).toHaveValue(first.name)

    await user.click(
      screen.getByRole('button', {
        name: says('automationsPage.list.selectAria', { name: second.name }),
      }),
    )
    expectPageAlive()
    // Nothing of the first rule is left editable while the second is read.
    expect(screen.queryByRole('textbox', { name: says('automationsPage.config.name') })).toBeNull()
    expect(screen.queryByText(headerOf(first))).toBeNull()

    secondDetail.resolve(second)
    expect(await screen.findByText(headerOf(second))).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: says('automationsPage.config.name') })).toHaveValue(
      second.name,
    )
    expectPageAlive()
    expectHeadersDrawnOnlyFromRealRules(second)
  })
})
