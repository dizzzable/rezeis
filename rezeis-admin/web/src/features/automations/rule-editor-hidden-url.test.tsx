/**
 * A webhook URL the panel shows only in part is kept by reference, never sent
 * back as its mask.
 *
 * A reader who may not edit a «POST webhook» action gets its URL as the origin
 * and "…", and `urlHidden` — a reference to the action's place in the saved
 * rule, the same shape a saved header gets. The mask is a valid URL, so a save
 * that sent it back used to replace the real one. Now «Сохранить» sends the
 * reference and no URL at all while the URL is left as the panel showed it, and
 * the URL typed in its place, with no reference, once it is changed.
 *
 * An editor meets such a rule when their role gained the rights after the page
 * loaded it; everybody else cannot save the action anyway.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInstance, type TFunction } from 'i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePermissionStore, type RbacAction } from '@/features/rbac'
import { listUserHints } from '@/features/user-hints/user-hints-api'
import { en as coreEn } from '@/i18n/en'
import { en as featureEn } from '@/i18n/features/automations.en'
import { ru as featureRu } from '@/i18n/features/automations.ru'
import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { ru as coreRu } from '@/i18n/ru'
import { renderWithProviders } from '@/test/test-utils'

import { translateAutomationError } from './automation-errors'
import AutomationsPage from './automations-page'
import {
  getCatalog,
  getRule,
  listExecutions,
  listRules,
  updateRule,
  type AutomationCatalog,
  type AutomationRule,
} from './automations-api'
import { getEventCatalog } from './event-catalog-api'
import { actionsForSave, isUrlHidden, paramsWithHeaderKept } from './saved-header'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))

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

const MASK = 'https://hooks.example.com/…'
const REFERENCE = { stored: true, index: 0 }

function ruleWith(params: Record<string, unknown>): AutomationRule {
  return {
    id: 'rule-hidden',
    name: 'Hidden',
    description: null,
    isEnabled: false,
    triggerKind: 'MANUAL',
    triggerSpec: '',
    conditions: null,
    actions: [{ type: 'webhook_post', params }],
    createdById: 'admin-1',
    lastRunAt: null,
    lastRunStatus: null,
    lastRunMessage: null,
    runCount: 0,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
  }
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

function serve(rule: AutomationRule): void {
  vi.mocked(getCatalog).mockResolvedValue({
    actionTypes: ['notify_telegram', 'webhook_post'],
    coincidentEventGroups: [],
    actionPermissions: { notify_telegram: [], webhook_post: [{ resource: 'webhooks', action: 'create' }] },
  } satisfies AutomationCatalog)
  vi.mocked(listRules).mockResolvedValue([{ ...rule }])
  vi.mocked(getRule).mockImplementation(async () => structuredClone(rule))
  vi.mocked(updateRule).mockImplementation(async (id, payload) => ({ ...rule, id, ...payload }) as AutomationRule)
}

/** The sentence a key renders right now — looked up, never restated. */
function says(key: string, values?: Record<string, unknown>): string {
  const sentence = String(i18n.t(key, values ?? {}))
  expect(sentence, `${key} is missing from the loaded bundles`).not.toBe(key)
  return sentence
}

async function openAndRename(rule: AutomationRule): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: says('automationsPage.list.selectAria', { name: rule.name }) }))
  const name = await screen.findByRole('textbox', { name: says('automationsPage.config.name') })
  await waitFor(() => expect(name).toHaveValue(rule.name))
  await user.clear(name)
  await user.type(name, `${rule.name} 2`)
  return user
}

function paramsBox(): HTMLTextAreaElement {
  const box = screen.getAllByRole('textbox').find((element) => (element as HTMLTextAreaElement).value.includes('hooks.example.com'))
  expect(box, 'the params box is missing').toBeDefined()
  return box as HTMLTextAreaElement
}

/** The params «Сохранить» sent for the first action. */
async function savedParams(user: ReturnType<typeof userEvent.setup>): Promise<Record<string, unknown>> {
  await user.click(screen.getByRole('button', { name: says('automationsPage.editor.save') }))
  await waitFor(() => expect(updateRule).toHaveBeenCalledTimes(1))
  return vi.mocked(updateRule).mock.calls[0]![1].actions[0]!.params
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

describe('«Сохранить» on a rule whose URL arrived hidden', () => {
  it('sends the reference and no URL while the URL is left as shown — never the mask', async () => {
    grant(HOOK_ADMIN)
    const rule = ruleWith({ url: MASK, urlHidden: REFERENCE })
    serve(rule)
    renderWithProviders(<AutomationsPage />)
    const user = await openAndRename(rule)

    expect(screen.getByText(says('automationsPage.actions.urlHidden'))).toBeInTheDocument()
    expect(await savedParams(user)).toEqual({ urlHidden: REFERENCE })
  })

  it('sends both references when a saved header sits on the same action', async () => {
    grant(HOOK_ADMIN)
    const rule = ruleWith({ url: MASK, authorizationHeader: REFERENCE, urlHidden: REFERENCE })
    serve(rule)
    renderWithProviders(<AutomationsPage />)
    const user = await openAndRename(rule)

    expect(await savedParams(user)).toEqual({ authorizationHeader: REFERENCE, urlHidden: REFERENCE })
  })

  it('keeps the reference, and still sends no URL, when only something else in the box changes', async () => {
    grant(HOOK_ADMIN)
    const rule = ruleWith({ url: MASK, urlHidden: REFERENCE })
    serve(rule)
    renderWithProviders(<AutomationsPage />)
    const user = await openAndRename(rule)

    fireEvent.change(paramsBox(), { target: { value: JSON.stringify({ url: MASK, note: 'kept' }) } })

    expect(await savedParams(user)).toEqual({ note: 'kept', urlHidden: REFERENCE })
  })

  it('sends the URL typed in its place, and no reference, once the URL is changed', async () => {
    grant(HOOK_ADMIN)
    const rule = ruleWith({ url: MASK, urlHidden: REFERENCE })
    serve(rule)
    renderWithProviders(<AutomationsPage />)
    const user = await openAndRename(rule)

    fireEvent.change(paramsBox(), { target: { value: JSON.stringify({ url: 'https://collector.example.net/in' }) } })
    await waitFor(() => expect(screen.queryByText(says('automationsPage.actions.urlHidden'))).not.toBeInTheDocument())

    expect(await savedParams(user)).toEqual({ url: 'https://collector.example.net/in' })
  })
})

describe('the helpers behind it', () => {
  it('reads a reference as hidden, and nothing else — `true` included', () => {
    expect(isUrlHidden({ url: MASK, urlHidden: REFERENCE })).toBe(true)
    for (const flag of [true, 'yes', 1, null, {}, { stored: true }, { stored: true, index: -1 }, { stored: true, index: 0.5 }]) {
      expect(isUrlHidden({ url: MASK, urlHidden: flag }), JSON.stringify(flag)).toBe(false)
    }
    expect(isUrlHidden(undefined)).toBe(false)
  })

  it('keeps the reference through the params box only while the URL there is the one the panel sent', () => {
    const current = { url: MASK, urlHidden: REFERENCE }
    expect(paramsWithHeaderKept({ url: MASK }, current)).toEqual({ url: MASK, urlHidden: REFERENCE })
    expect(paramsWithHeaderKept({ url: `${MASK} ` }, current)).toEqual({ url: `${MASK} ` })
    expect(paramsWithHeaderKept({ url: 'https://hooks.example.com/new' }, current)).toEqual({ url: 'https://hooks.example.com/new' })
    expect(paramsWithHeaderKept({}, current)).toEqual({})
    // A reference typed into the box is not taken: only the panel's own is.
    expect(paramsWithHeaderKept({ url: 'https://a.example/x', urlHidden: REFERENCE }, { url: 'https://a.example/x' })).toEqual({
      url: 'https://a.example/x',
    })
  })

  it('takes the URL out of every action that keeps a hidden one, and leaves every other action alone', () => {
    const actions = [
      { type: 'webhook_post', params: { url: MASK, urlHidden: REFERENCE, authorizationHeader: REFERENCE } },
      { type: 'webhook_post', params: { url: 'https://hooks.example.com/typed' } },
      { type: 'notify_telegram', params: { text: 'hello' } },
    ]
    const before = structuredClone(actions)
    expect(actionsForSave(actions)).toEqual([
      { type: 'webhook_post', params: { urlHidden: REFERENCE, authorizationHeader: REFERENCE } },
      { type: 'webhook_post', params: { url: 'https://hooks.example.com/typed' } },
      { type: 'notify_telegram', params: { text: 'hello' } },
    ])
    expect(actions, 'the draft itself was changed').toEqual(before)
  })
})

describe('a refusal about a hidden URL, in the operator’s language', () => {
  function translator(lng: 'en' | 'ru'): TFunction {
    const instance = createInstance()
    void instance.init({
      lng,
      fallbackLng: 'en',
      resources: {
        en: { translation: { ...(coreEn as unknown as Record<string, unknown>), ...(featureEn as unknown as Record<string, unknown>) } },
        ru: { translation: { ...(coreRu as unknown as Record<string, unknown>), ...(featureRu as unknown as Record<string, unknown>) } },
      },
      interpolation: { escapeValue: false },
      initAsync: false,
    })
    return instance.t.bind(instance) as TFunction
  }
  const RU = translator('ru')
  const refused = (problem: string) => ({
    isAxiosError: true,
    message: 'Request failed with status code 400',
    response: { status: 400, data: { statusCode: 400, message: `Action 1 (webhook_post): ${problem}` } },
  })

  for (const [problem, key] of [
    [
      '"urlHidden" does not name a saved URL — read the rule again, or send the URL itself without "urlHidden"',
      'urlHiddenNotReference',
    ],
    ['"urlHidden" keeps the URL saved on a rule, and a new rule has none — enter the URL itself', 'urlHiddenNewRule'],
    ['the saved URL "urlHidden" refers to belongs to another action — enter the URL again', 'urlHiddenShifted'],
    ['the saved URL "urlHidden" refers to is no longer on the rule — enter the URL again', 'urlHiddenGone'],
    [
      '"url" and "urlHidden" disagree — send a new URL without "urlHidden", or "urlHidden" without a URL',
      'urlHiddenDisagree',
    ],
    ['the URL is the shortened form the panel shows in place of a hidden one — enter the full URL', 'urlIsHiddenForm'],
  ] as const) {
    it(`says "${key}" in Russian, naming the action`, () => {
      const wording = String(RU(`automationsPage.actionProblems.${key}`))
      expect(wording, `${key} is missing from the Russian bundle`).not.toContain('actionProblems')
      const shown = translateAutomationError(RU, refused(problem))
      expect(shown).toContain(wording)
      expect(shown).toMatch(/[а-яА-Я]/)
      expect(shown).not.toContain(problem)
    })
  }
})
