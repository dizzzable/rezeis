/**
 * THE «ПРАВИЛА» TAB EXPLAINS ITSELF BEHIND (i), AND ITS BUTTONS SAY WHAT THEY DO.
 *
 * Asked by the owner: the operator explanations were grey paragraphs under
 * every field and heading, and a page of them reads as noise. They now sit
 * behind an (i) — reachable by hover, keyboard focus and a tap (`InfoTip`) —
 * and each button says, on hover, what pressing it will do.
 *
 * A sample, not every icon: the page's own explanation, the field ones that
 * replaced grey paragraphs, and a few buttons. Each paragraph that moved is
 * also asserted ABSENT until its (i) is used, because a tooltip added beside a
 * paragraph that was never removed would pass every "shows on hover" check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { usePermissionStore, type RbacAction } from '@/features/rbac'
import { getHintVocabulary, listUserHints } from '@/features/user-hints/user-hints-api'
import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import AutomationsPage from './automations-page'
import { getCatalog, getRule, listExecutions, listRules, type AutomationRule } from './automations-api'
import { getEventCatalog } from './event-catalog-api'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))

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

/** A tooltip's text as the DOM reports it: line breaks collapsed. */
function flat(sentence: string): string {
  return sentence.replace(/\s+/g, ' ').trim()
}

/** The (i) beside a subject, by the name every (i) carries. */
function infoFor(subject: string): HTMLElement {
  return screen.getByRole('button', { name: says('automationsPage.infoAria', { subject }) })
}

type User = ReturnType<typeof userEvent.setup>

/**
 * Hovers `target`, expects its tooltip to say `sentence`, and closes it again.
 *
 * Closed with Escape rather than by moving away: Radix keeps a tip open while
 * the pointer crosses towards it, and jsdom has no geometry for it to decide the
 * pointer left — `info-tip.test.tsx` closes the same way.
 */
async function expectTipOnHover(user: User, target: HTMLElement, sentence: string): Promise<void> {
  await user.hover(target)
  expect(await screen.findByRole('tooltip')).toHaveTextContent(flat(sentence))
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
  await user.unhover(target)
}

/** Every rule control the sample needs: an event trigger, a hint and an audience action. */
const RULE: AutomationRule = {
  id: 'rule-sample',
  name: 'Первое появление',
  description: null,
  isEnabled: true,
  triggerKind: 'REALTIME',
  triggerSpec: 'user.registered',
  conditions: null,
  actions: [
    { type: 'show_hint', params: { hintKey: 'tpl-welcome' } },
    { type: 'show_hint_to_audience', params: { hintKey: 'tpl-welcome', audience: 'paid-not-connected' } },
  ],
  createdById: 'admin-1',
  lastRunAt: null,
  lastRunStatus: null,
  lastRunMessage: null,
  runCount: 0,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
}

beforeEach(async () => {
  usePermissionStore.getState().reset()
  grant([
    { resource: 'automations', action: 'view' },
    { resource: 'automations', action: 'create' },
    { resource: 'automations', action: 'edit' },
    { resource: 'automations', action: 'delete' },
    { resource: 'automations', action: 'run' },
  ])
  vi.mocked(getCatalog).mockResolvedValue({
    actionTypes: ['show_hint', 'show_hint_to_audience', 'notify_telegram'],
    coincidentEventGroups: [],
  })
  vi.mocked(getEventCatalog).mockResolvedValue({ events: [], windowDays: 30 })
  vi.mocked(listRules).mockResolvedValue([RULE])
  vi.mocked(getRule).mockResolvedValue(RULE)
  vi.mocked(listExecutions).mockResolvedValue({ items: [], nextCursor: null })
  vi.mocked(listUserHints).mockResolvedValue([])
  vi.mocked(getHintVocabulary).mockResolvedValue({ routes: [], surfaces: [], formFactors: [], modes: [] })
  await i18nReady
  await loadFeatureBundle('automations')
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function renderEditor(): Promise<User> {
  renderWithProviders(<AutomationsPage />)
  const user = userEvent.setup()
  await screen.findByRole('button', { name: says('automationsPage.editor.save') })
  return user
}

describe('what the page is', () => {
  it('keeps one line under the title and the explanation behind the (i) beside it', async () => {
    const user = await renderEditor()

    expect(screen.getByText(says('automationsPage.subtitle'))).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(flat(says('automationsPage.pageInfo')))
    await expectTipOnHover(user, infoFor(says('automationsPage.title')), says('automationsPage.pageInfo'))
  })
})

describe('field explanations', () => {
  it('are no longer grey text under the fields', async () => {
    await renderEditor()

    // Only paragraphs that WERE on this screen as text — an explanation that
    // never was could not fail to be absent.
    for (const key of [
      'automationsPage.config.eventPatternHint',
      'automationsPage.actions.hintNeedsCustomer',
      'automationsPage.actions.audienceNeedsCron',
    ]) {
      expect(document.body, `${key} is still on the page as text`).not.toHaveTextContent(flat(says(key)))
    }
    // Anti-vacuity: the fields they sat under are drawn.
    expect(screen.getByRole('textbox', { name: says('automationsPage.config.eventPattern') })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: says('automationsPage.actions.audienceLabel') })).toBeInTheDocument()
  })

  it('put the cron explanation behind the (i) of «Cron-выражение», not under it', async () => {
    const nightly = { ...RULE, triggerKind: 'CRON' as const, triggerSpec: '0 3 * * *', actions: [RULE.actions[1]!] }
    vi.mocked(listRules).mockResolvedValue([nightly])
    vi.mocked(getRule).mockResolvedValue(nightly)
    const user = await renderEditor()

    expect(screen.getByRole('textbox', { name: says('automationsPage.config.cronExpression') })).toHaveValue('0 3 * * *')
    expect(document.body).not.toHaveTextContent(flat(says('automationsPage.config.cronHint')))
    await expectTipOnHover(
      user,
      infoFor(says('automationsPage.config.cronExpression')),
      says('automationsPage.config.cronHint'),
    )
  })

  it('open on hover beside the field they explain', async () => {
    const user = await renderEditor()

    await expectTipOnHover(user, infoFor(says('automationsPage.config.name')), says('automationsPage.config.nameInfo'))
    await expectTipOnHover(user, infoFor(says('automationsPage.config.trigger')), says('automationsPage.config.triggerInfo'))
    await expectTipOnHover(
      user,
      infoFor(says('automationsPage.config.conditionsLabel')),
      says('automationsPage.help.conditionsHint'),
    )
    await expectTipOnHover(
      user,
      infoFor(says('automationsPage.actions.hintLabel')),
      says('automationsPage.actions.hintNeedsCustomer'),
    )
    await expectTipOnHover(
      user,
      infoFor(says('automationsPage.actions.audienceLabel')),
      says('automationsPage.actions.audienceNeedsCron'),
    )
    // The action type's (i) explains the type that is SELECTED.
    await expectTipOnHover(
      user,
      infoFor(says('automationsPage.actionTypes.show_hint_to_audience')),
      says('automationsPage.actions.typeInfo', {
        label: says('automationsPage.actionTypes.show_hint_to_audience'),
        description: says('automationsPage.help.actionDescriptions.show_hint_to_audience'),
      }),
    )
  })

  it('open on a tap, where a hover cannot happen', async () => {
    const user = await renderEditor()
    const icon = infoFor(says('automationsPage.config.eventPattern'))

    await user.pointer({ keys: '[TouchA]', target: icon })
    expect(await screen.findByRole('tooltip')).toHaveTextContent(flat(says('automationsPage.config.eventPatternHint')))
    await user.pointer({ keys: '[TouchA]', target: icon })
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
  })

  it('name the editor’s switch, and say it changes the draft while the list’s switch acts at once', async () => {
    const user = await renderEditor()
    const editor = screen.getByRole('button', { name: says('automationsPage.editor.save') }).closest<HTMLElement>(
      '[data-concept-surface="card"]',
    )!

    expect(within(editor).getByRole('switch', { name: says('automationsPage.editor.enabledLabel') })).toBeChecked()
    await expectTipOnHover(
      user,
      infoFor(says('automationsPage.editor.enabledLabel')),
      says('automationsPage.editor.enabledInfo'),
    )
  })
})

describe('the ready-made hints', () => {
  it('explain themselves behind the (i) beside their heading', async () => {
    const user = await renderEditor()
    await user.click(screen.getByRole('button', { name: says('automationsPage.help.title') }))
    await screen.findByText(says('automationsPage.hintTemplates.title'))

    expect(document.body).not.toHaveTextContent(flat(says('automationsPage.hintTemplates.subtitle')))
    await expectTipOnHover(
      user,
      infoFor(says('automationsPage.hintTemplates.title')),
      says('automationsPage.hintTemplates.subtitle'),
    )
    // «Использовать» on a ready-made hint says what it writes at once.
    const card = screen.getByText(says('automationsPage.hintTemplates.payment_failed.name')).parentElement!
    await expectTipOnHover(
      user,
      within(card).getByRole('button', { name: says('automationsPage.help.useTemplate') }),
      says('automationsPage.tips.useHintTemplate'),
    )
  })
})

describe('what pressing a button does', () => {
  it('is said on hover', async () => {
    const user = await renderEditor()

    await expectTipOnHover(
      user,
      screen.getByRole('button', { name: says('automationsPage.editor.delete') }),
      says('automationsPage.tips.delete'),
    )
    await expectTipOnHover(
      user,
      screen.getByRole('button', { name: says('automationsPage.editor.save') }),
      says('automationsPage.tips.save'),
    )
    await expectTipOnHover(
      user,
      screen.getByRole('button', { name: says('automationsPage.newRule') }),
      says('automationsPage.tips.newRule'),
    )
    await expectTipOnHover(
      user,
      screen.getByRole('switch', { name: says('automationsPage.list.toggleAria', { name: RULE.name }) }),
      says('automationsPage.tips.listToggle'),
    )
    await expectTipOnHover(
      user,
      screen.getByRole('button', { name: says('automationsPage.actions.add') }),
      says('automationsPage.tips.addAction'),
    )
  })

  it('is said on keyboard focus too', async () => {
    const user = await renderEditor()
    const remove = screen.getByRole('button', { name: says('automationsPage.actions.removeAria', { index: 1 }) })

    remove.focus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent(flat(says('automationsPage.tips.removeAction')))
    // Anti-vacuity: focus alone pressed nothing.
    expect(screen.getByRole('combobox', { name: `${says('automationsPage.actions.heading')} 1` })).toBeInTheDocument()
    await user.keyboard('{Escape}')
  })
})
