/**
 * «ПЕРВОЕ ПОЯВЛЕНИЕ» — WHOM IT GREETS IS CHOSEN ON THE CARD.
 *
 * Reported by the owner: he applied the welcome, set its hint's «Где показывать»
 * to «Браузер», and waited for people signing up in the browser to be greeted.
 * None were. That template's rule listened to the Telegram sign-up
 * (`user.registered`); a sign-up on the site raises `user.web_registered`, and
 * the only thing on the card that said which was a code string under the title.
 *
 * Now the two welcomes are one card with «Кого приветствовать». The default,
 * everyone, is one hint and TWO rules — a draft on one sign-up and a companion
 * on the other — because the trigger grammar has no "either of these events".
 * These cases walk the real page from the card to the rules «Создать» writes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { usePermissionStore, type RbacAction } from '@/features/rbac'
import {
  createUserHint,
  getHintVocabulary,
  listUserHints,
  updateUserHint,
  type UserHint,
} from '@/features/user-hints/user-hints-api'
import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
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

vi.mock('./automations-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./automations-api')>()),
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

vi.mock('@/features/user-hints/user-hints-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/user-hints/user-hints-api')>()),
  createUserHint: vi.fn(),
  updateUserHint: vi.fn(),
  listUserHints: vi.fn(),
  getHintVocabulary: vi.fn(),
}))

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

function hint(over: Partial<UserHint>): UserHint {
  return {
    id: `hint-${over.key ?? 'x'}`,
    key: 'x',
    titleRu: 'Подсказка',
    bodyRu: 'Текст',
    titleEn: null,
    bodyEn: null,
    mode: 'MODAL',
    tone: 'INFO',
    ctaKind: 'NONE',
    ctaLabelRu: null,
    ctaLabelEn: null,
    ctaTarget: null,
    surfaces: [],
    formFactors: [],
    groupKey: null,
    ttlHours: 168,
    isRepeatable: false,
    isActive: true,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...over,
  }
}

function savedRule(over: Partial<AutomationRule> & Pick<AutomationRule, 'id' | 'name'>): AutomationRule {
  return {
    description: null,
    isEnabled: true,
    triggerKind: 'REALTIME',
    triggerSpec: 'user.registered',
    conditions: null,
    actions: [{ type: 'show_hint', params: { hintKey: 'tpl-welcome' } }],
    createdById: 'admin-1',
    lastRunAt: null,
    lastRunStatus: null,
    lastRunMessage: null,
    runCount: 0,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...over,
  }
}

/** A rejection as axios raises it when the request never reached the server. */
function unreachable(): Error {
  return Object.assign(new Error('Network Error'), { isAxiosError: true, code: 'ERR_NETWORK' })
}

/** The panel's rules, as creates and reads leave them. */
function servePanel(): { readonly created: () => AutomationRule[] } {
  const rows = new Map<string, AutomationRule>()
  vi.mocked(createRule).mockImplementation(async (payload: UpsertRulePayload) => {
    const row = savedRule({
      id: `rule-created-${rows.size + 1}`,
      name: payload.name,
      description: payload.description ?? null,
      isEnabled: payload.isEnabled ?? false,
      triggerKind: payload.triggerKind,
      triggerSpec: payload.triggerSpec,
      conditions: payload.conditions ?? null,
      actions: payload.actions,
      createdAt: '2026-09-15T12:00:00.000Z',
      updatedAt: '2026-09-15T12:00:00.000Z',
    })
    rows.set(row.id, row)
    return row
  })
  vi.mocked(getRule).mockImplementation(async (id) => {
    const row = rows.get(id)
    if (row === undefined) throw new Error(`no rule ${id}`)
    return row
  })
  return { created: () => [...rows.values()] }
}

/** Opens the guide and returns the «Первое появление» card. */
async function arrivalCard(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: says('automationsPage.help.title') }))
  const card = (await screen.findByText(says('automationsPage.hintTemplates.arrival.title'))).parentElement
  expect(card).not.toBeNull()
  return card!
}

function nameField(): HTMLElement {
  return screen.getByRole('textbox', { name: says('automationsPage.config.name') })
}

const WRITE_BOTH = [
  { resource: 'automations', action: 'view' },
  { resource: 'automations', action: 'create' },
  { resource: 'automations', action: 'edit' },
  { resource: 'user_hints', action: 'create' },
  { resource: 'user_hints', action: 'edit' },
] as const

beforeEach(async () => {
  usePermissionStore.getState().reset()
  grant(WRITE_BOTH)
  vi.mocked(getCatalog).mockResolvedValue({ actionTypes: ['show_hint', 'notify_telegram'], coincidentEventGroups: [] })
  vi.mocked(getEventCatalog).mockResolvedValue({ events: [], windowDays: 30 })
  vi.mocked(listRules).mockResolvedValue([])
  vi.mocked(listExecutions).mockResolvedValue({ items: [], nextCursor: null })
  vi.mocked(listUserHints).mockResolvedValue([])
  vi.mocked(getHintVocabulary).mockResolvedValue({ routes: [], surfaces: [], formFactors: [], modes: [] })
  vi.mocked(createUserHint).mockImplementation(async (input) => hint({ key: input.key, titleRu: input.titleRu }))
  vi.mocked(updateUserHint).mockImplementation(async (id, input) => hint({ id, key: input.key, titleRu: input.titleRu }))
  await i18nReady
  await loadFeatureBundle('automations')
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('the card and the choice on it', () => {
  it('greets everyone by default: the welcome hint, a draft on the Telegram sign-up, and the site rule beside it', async () => {
    servePanel()
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    const card = await arrivalCard(user)

    // The two welcome templates are not cards of their own any more.
    expect(screen.queryByText(says('automationsPage.hintTemplates.welcome.name'))).toBeNull()
    expect(screen.queryByText(says('automationsPage.hintTemplates.welcome_web.name'))).toBeNull()

    expect(
      within(card).getByRole('radio', { name: says('automationsPage.hintTemplates.arrival.audiences.everyone') }),
    ).toBeChecked()
    // The line under the choice names BOTH events, in words.
    expect(within(card).getByText(says('automationsPage.hintTemplates.arrival.firesOnBoth'))).toBeInTheDocument()
    expect(within(card).getByText(says('automationsPage.popupEvents.user_registered'))).toBeInTheDocument()
    expect(within(card).getByText(says('automationsPage.popupEvents.user_web_registered'))).toBeInTheDocument()

    await user.click(within(card).getByRole('button', { name: says('automationsPage.help.useTemplate') }))

    await waitFor(() => {
      expect(createUserHint).toHaveBeenCalledTimes(1)
    })
    expect(vi.mocked(createUserHint).mock.calls[0]![0].key).toBe('tpl-welcome')
    expect(await screen.findByRole('textbox', { name: says('automationsPage.config.name') })).toHaveValue(
      says('automationsPage.hintTemplates.welcome.name'),
    )
    // Written for both rules, because the companion copies it.
    expect(screen.getByRole('textbox', { name: says('automationsPage.config.description') })).toHaveValue(
      says('automationsPage.hintTemplates.arrival.ruleDescription'),
    )

    const notice = screen.getByText(says('automationsPage.editor.companions.title')).closest('[role="alert"]')
    expect(notice, 'the draft does not say what else «Создать» will save').not.toBeNull()
    expect(notice).toHaveTextContent(says('automationsPage.hintTemplates.welcome_web.name'))
    expect(notice).toHaveTextContent(says('automationsPage.popupEvents.user_web_registered'))
  })

  it('greets one door only when one is chosen, and the line follows the choice', async () => {
    servePanel()
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    const card = await arrivalCard(user)

    await user.click(
      within(card).getByRole('radio', { name: says('automationsPage.hintTemplates.arrival.audiences.web') }),
    )
    expect(within(card).getByText(says('automationsPage.hintTemplates.arrival.firesOnOne'))).toBeInTheDocument()
    expect(within(card).getByText(says('automationsPage.popupEvents.user_web_registered'))).toBeInTheDocument()
    expect(within(card).queryByText(says('automationsPage.popupEvents.user_registered'))).toBeNull()

    await user.click(within(card).getByRole('button', { name: says('automationsPage.help.useTemplate') }))

    await waitFor(() => {
      expect(createUserHint).toHaveBeenCalledTimes(1)
    })
    expect(vi.mocked(createUserHint).mock.calls[0]![0].key).toBe('tpl-welcome-web')
    expect(await screen.findByRole('textbox', { name: says('automationsPage.config.name') })).toHaveValue(
      says('automationsPage.hintTemplates.welcome_web.name'),
    )
    expect(screen.getByRole('textbox', { name: says('automationsPage.config.description') })).toHaveValue(
      says('automationsPage.hintTemplates.welcome_web.description'),
    )
    expect(screen.queryByText(says('automationsPage.editor.companions.title'))).toBeNull()
  })
})

describe('«Создать» on the welcome for everyone', () => {
  async function applyEveryone(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    const card = await arrivalCard(user)
    await user.click(within(card).getByRole('button', { name: says('automationsPage.help.useTemplate') }))
    await screen.findByText(says('automationsPage.editor.companions.title'))
  }

  it('creates the draft, then the site rule with the draft’s payload under its own name and event', async () => {
    const panel = servePanel()
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    await applyEveryone(user)

    await user.click(screen.getByRole('button', { name: says('automationsPage.editor.create') }))

    await waitFor(() => {
      expect(createRule).toHaveBeenCalledTimes(2)
    })
    const [draft, companion] = vi.mocked(createRule).mock.calls.map(([payload]) => payload)
    const shared = {
      triggerKind: 'REALTIME',
      isEnabled: false,
      description: says('automationsPage.hintTemplates.arrival.ruleDescription'),
      actions: [{ type: 'show_hint', params: { hintKey: 'tpl-welcome' } }],
    }
    expect(draft).toMatchObject({
      ...shared,
      name: says('automationsPage.hintTemplates.welcome.name'),
      triggerSpec: 'user.registered',
    })
    expect(companion).toMatchObject({
      ...shared,
      name: says('automationsPage.hintTemplates.welcome_web.name'),
      triggerSpec: 'user.web_registered',
    })

    const names = [
      says('automationsPage.toast.ruleName', { name: says('automationsPage.hintTemplates.welcome.name') }),
      says('automationsPage.toast.ruleName', { name: says('automationsPage.hintTemplates.welcome_web.name') }),
    ].join(', ')
    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith(says('automationsPage.toast.createdSeveralOff', { names }))
    })
    // The draft that was on screen is the rule that is open now.
    expect(await screen.findByRole('button', { name: says('automationsPage.editor.save') })).toBeInTheDocument()
    expect(nameField()).toHaveValue(panel.created()[0]!.name)
  })

  it('says the rules are switched ON when the switch in the header was turned on before «Создать»', async () => {
    servePanel()
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    await applyEveryone(user)

    await user.click(screen.getByRole('switch', { name: says('automationsPage.editor.enabledLabel') }))
    await user.click(screen.getByRole('button', { name: says('automationsPage.editor.create') }))

    await waitFor(() => {
      expect(createRule).toHaveBeenCalledTimes(2)
    })
    expect(vi.mocked(createRule).mock.calls.map(([payload]) => payload.isEnabled)).toEqual([true, true])
    const names = [
      says('automationsPage.toast.ruleName', { name: says('automationsPage.hintTemplates.welcome.name') }),
      says('automationsPage.toast.ruleName', { name: says('automationsPage.hintTemplates.welcome_web.name') }),
    ].join(', ')
    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith(says('automationsPage.toast.createdSeveralOn', { names }))
    })
    expect(toastMock.success).not.toHaveBeenCalledWith(says('automationsPage.toast.createdSeveralOff', { names }))
  })

  it('says which rule exists and which does not when the site rule fails, and keeps the created one open', async () => {
    const panel = servePanel()
    const serveCreate = vi.mocked(createRule).getMockImplementation()!
    vi.mocked(createRule)
      .mockImplementationOnce(serveCreate)
      .mockImplementationOnce(async () => {
        throw unreachable()
      })
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    await applyEveryone(user)
    // The template's own toast is a success; nothing after «Создать» may be.
    const successesBeforeCreate = toastMock.success.mock.calls.length

    await user.click(screen.getByRole('button', { name: says('automationsPage.editor.create') }))

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        says('automationsPage.toast.createdPartly', {
          created: says('automationsPage.toast.ruleName', {
            name: says('automationsPage.hintTemplates.welcome.name'),
          }),
          failed: says('automationsPage.toast.ruleFailed', {
            name: says('automationsPage.hintTemplates.welcome_web.name'),
            message: says('errors.serverUnreachable'),
          }),
        }),
      )
    })
    expect(toastMock.success).toHaveBeenCalledTimes(successesBeforeCreate)
    expect(panel.created()).toHaveLength(1)
    expect(await screen.findByRole('button', { name: says('automationsPage.editor.save') })).toBeInTheDocument()
    expect(nameField()).toHaveValue(says('automationsPage.hintTemplates.welcome.name'))
  })

  it('saves only the draft after «Не создавать эти правила», and keeps what was typed', async () => {
    servePanel()
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    await applyEveryone(user)
    const create = () => screen.getByRole('button', { name: says('automationsPage.editor.create') })

    await user.hover(create())
    expect(await screen.findByRole('tooltip')).toHaveTextContent(says('automationsPage.tips.createWithCompanions'))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
    await user.unhover(create())

    await user.type(nameField(), ' (typed)')
    await user.click(screen.getByRole('button', { name: says('automationsPage.editor.companions.drop') }))

    expect(screen.queryByText(says('automationsPage.editor.companions.title'))).toBeNull()
    expect(nameField()).toHaveValue(`${says('automationsPage.hintTemplates.welcome.name')} (typed)`)
    // Nothing on the draft still speaks of more than one rule: the button says
    // it saves this rule, and the description is true of one.
    await user.hover(create())
    expect(await screen.findByRole('tooltip')).toHaveTextContent(says('automationsPage.tips.create'))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
    expect(screen.getByRole('textbox', { name: says('automationsPage.config.description') })).toHaveValue(
      says('automationsPage.hintTemplates.arrival.ruleDescription'),
    )

    await user.click(create())
    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith(says('automationsPage.toast.created'))
    })
    expect(createRule).toHaveBeenCalledTimes(1)
    expect(vi.mocked(createRule).mock.calls[0]![0].triggerSpec).toBe('user.registered')
  })

  it('brings no companion while the draft itself fires on the companion’s event', async () => {
    servePanel()
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    await applyEveryone(user)

    const spec = screen.getByRole('textbox', { name: says('automationsPage.config.eventPattern') })
    await user.clear(spec)
    await user.type(spec, 'user.web_registered')
    expect(screen.queryByText(says('automationsPage.editor.companions.title'))).toBeNull()

    await user.clear(spec)
    await user.type(spec, 'user.registered')
    expect(screen.getByText(says('automationsPage.editor.companions.title'))).toBeInTheDocument()
  })
})

describe('where the welcome may appear, for every rule «Создать» saves', () => {
  it('warns that the site rule would never draw a welcome allowed only in Telegram, and stops once the site rule is dropped', async () => {
    // The owner's setup turned round: `tpl-welcome` limited to «Telegram». The
    // Telegram sign-up's own rule is fine; the companion on the site sign-up
    // queues it for people who open the cabinet in a browser.
    servePanel()
    vi.mocked(listUserHints).mockResolvedValue([
      hint({ key: 'tpl-welcome', titleRu: 'Добро пожаловать', surfaces: ['tma'] }),
    ])
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    const card = await arrivalCard(user)
    await user.click(within(card).getByRole('button', { name: says('automationsPage.help.useTemplate') }))
    await screen.findByText(says('automationsPage.editor.companions.title'))

    const companionGap = says('automationsPage.actions.surfaceGapCompanion', {
      allowed: says('userHints.surfaces.tma'),
      rule: says('automationsPage.hintTemplates.welcome_web.name'),
      event: says('automationsPage.popupEvents.user_web_registered'),
      home: `${says('userHints.surfaces.browser')}, ${says('userHints.surfaces.pwa')}`,
    })
    expect(await screen.findByText(companionGap)).toBeInTheDocument()
    // Anti-vacuity: the draft's own event raises no gap for this hint.
    const opening = says('automationsPage.actions.surfaceGap', { allowed: '', event: '', home: '' }).slice(0, 16)
    expect(screen.getAllByText(new RegExp(opening.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: says('automationsPage.editor.companions.drop') }))
    expect(screen.queryByText(companionGap)).toBeNull()
  })
})

describe('a second window, before «Создать»', () => {
  it('warns about an enabled rule on the companion’s event', async () => {
    servePanel()
    vi.mocked(listRules).mockResolvedValue([
      savedRule({
        id: 'rule-site',
        name: 'Приветствие на сайте',
        triggerSpec: 'user.web_registered',
        actions: [{ type: 'show_hint', params: { hintKey: 'tpl-welcome-web' } }],
      }),
    ])
    vi.mocked(listUserHints).mockResolvedValue([hint({ key: 'tpl-welcome-web', titleRu: 'Добро пожаловать на сайт' })])
    vi.mocked(getRule).mockImplementation(async (id) => {
      if (id === 'rule-site') {
        return savedRule({
          id: 'rule-site',
          name: 'Приветствие на сайте',
          triggerSpec: 'user.web_registered',
          actions: [{ type: 'show_hint', params: { hintKey: 'tpl-welcome-web' } }],
        })
      }
      throw new Error(`no rule ${id}`)
    })
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    const card = await arrivalCard(user)
    await user.click(within(card).getByRole('button', { name: says('automationsPage.help.useTemplate') }))
    await screen.findByText(says('automationsPage.editor.companions.title'))

    const warning = (await screen.findByText(says('automationsPage.hintCollision.title'))).closest('[role="alert"]')
    expect(warning).not.toBeNull()
    expect(warning).toHaveTextContent('Приветствие на сайте')

    // The draft's own event collides with nothing: take the companion off and
    // the warning goes with it.
    await user.click(screen.getByRole('button', { name: says('automationsPage.editor.companions.drop') }))
    expect(screen.queryByText(says('automationsPage.hintCollision.title'))).toBeNull()
  })

  it('warns when the owner already has a welcome on the Telegram sign-up', async () => {
    servePanel()
    const existing = savedRule({ id: 'rule-welcome', name: 'Первое появление' })
    vi.mocked(listRules).mockResolvedValue([existing])
    vi.mocked(listUserHints).mockResolvedValue([hint({ key: 'tpl-welcome', titleRu: 'Добро пожаловать' })])
    vi.mocked(getRule).mockResolvedValue(existing)
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    const card = await arrivalCard(user)
    await user.click(within(card).getByRole('button', { name: says('automationsPage.help.useTemplate') }))

    // The text already existed, so this was the refresh branch — and the draft
    // would put the same window on the same sign-up a second time.
    await waitFor(() => {
      expect(updateUserHint).toHaveBeenCalledTimes(1)
    })
    await screen.findByRole('button', { name: says('automationsPage.editor.create') })
    const warning = (await screen.findByText(says('automationsPage.hintCollision.title'))).closest('[role="alert"]')
    expect(warning).toHaveTextContent('Первое появление')
  })
})
