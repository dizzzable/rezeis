/**
 * WHAT IS WRONG WITH THE HINT A RULE SHOWS, SAID IN THE RULE EDITOR.
 *
 * Two failures the owner could not see from «Правила»: a hint switched off
 * behind a switched-on rule queues nothing on every fire; and a hint limited to
 * «Браузер» behind the Telegram sign-up waits for people who open the cabinet
 * inside Telegram, where it is never drawn. Each tab showed only its own half.
 *
 * The warnings are computed from the data, so each case makes one appear and
 * then changes the data — the hint library in the cache, or the draft's own
 * event — and watches it go.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePermissionStore, type RbacAction } from '@/features/rbac'
import { getHintVocabulary, listUserHints, type UserHint } from '@/features/user-hints/user-hints-api'
import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { queryClient as panelQueryClient } from '@/lib/query-client'
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

function hint(over: Partial<UserHint>): UserHint {
  return {
    id: 'hint-welcome',
    key: 'tpl-welcome',
    titleRu: 'Добро пожаловать',
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

const WELCOME: AutomationRule = {
  id: 'rule-welcome',
  name: 'Первое появление',
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
}

const HINTS_KEY = ['admin', 'user-hints']

/** The page on the panel's own defaults, in a client the case can write the library into. */
function renderPage(): QueryClient {
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
  return client
}

function gapWarning(surfaces: readonly string[]): string {
  return says('automationsPage.actions.surfaceGap', {
    allowed: surfaces.map((surface) => says(`userHints.surfaces.${surface}`)).join(', '),
    event: says('automationsPage.popupEvents.user_registered'),
    home: says('userHints.surfaces.tma'),
  })
}

beforeEach(async () => {
  usePermissionStore.getState().reset()
  grant([
    { resource: 'automations', action: 'view' },
    { resource: 'automations', action: 'edit' },
  ])
  vi.mocked(getCatalog).mockResolvedValue({ actionTypes: ['show_hint'], coincidentEventGroups: [] })
  vi.mocked(getEventCatalog).mockResolvedValue({ events: [], windowDays: 30 })
  vi.mocked(listRules).mockResolvedValue([WELCOME])
  vi.mocked(getRule).mockResolvedValue(WELCOME)
  vi.mocked(listExecutions).mockResolvedValue({ items: [], nextCursor: null })
  vi.mocked(getHintVocabulary).mockResolvedValue({ routes: [], surfaces: [], formFactors: [], modes: [] })
  await i18nReady
  await loadFeatureBundle('automations')
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('under the hint a show_hint action picked', () => {
  it('warns while the hint is switched off, and stops once it is on', async () => {
    vi.mocked(listUserHints).mockResolvedValue([hint({ isActive: false })])
    const client = renderPage()

    const off = says('automationsPage.actions.hintOff', { title: 'Добро пожаловать' })
    expect(await screen.findByText(off)).toBeInTheDocument()

    act(() => {
      client.setQueryData(HINTS_KEY, [hint({ isActive: true })])
    })
    // The cache hands the change to its observers on a timer of its own.
    await waitFor(() => {
      expect(screen.queryByText(off)).toBeNull()
    })
    // Anti-vacuity: the editor is still there, with the action it warned under.
    expect(screen.getByRole('textbox', { name: says('automationsPage.config.name') })).toHaveValue(WELCOME.name)
  })

  it('warns when the hint may not appear where this event’s customers are — the owner’s welcome', async () => {
    vi.mocked(listUserHints).mockResolvedValue([hint({ surfaces: ['browser'] })])
    const client = renderPage()

    expect(await screen.findByText(gapWarning(['browser']))).toBeInTheDocument()

    // Allowed everywhere: nothing to warn about.
    act(() => {
      client.setQueryData(HINTS_KEY, [hint({ surfaces: [] })])
    })
    await waitFor(() => {
      expect(screen.queryByText(gapWarning(['browser']))).toBeNull()
    })

    // And back, to show the warning follows the data both ways.
    act(() => {
      client.setQueryData(HINTS_KEY, [hint({ surfaces: ['browser'] })])
    })
    expect(await screen.findByText(gapWarning(['browser']))).toBeInTheDocument()
  })

  it('stops warning about the gap once the rule fires on the event whose customers are in the browser', async () => {
    vi.mocked(listUserHints).mockResolvedValue([hint({ surfaces: ['browser'] })])
    renderPage()
    const user = userEvent.setup()
    expect(await screen.findByText(gapWarning(['browser']))).toBeInTheDocument()

    const spec = screen.getByRole('textbox', { name: says('automationsPage.config.eventPattern') })
    await user.clear(spec)
    await user.type(spec, 'user.web_registered')

    // No gap warning at all — not merely not the one naming the Telegram sign-up.
    const opening = says('automationsPage.actions.surfaceGap', { allowed: '', event: '', home: '' }).slice(0, 16)
    expect(screen.queryByText(new RegExp(opening.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeNull()
    expect(screen.queryByText(gapWarning(['browser']))).toBeNull()
    // Anti-vacuity: the draft really moved to the site sign-up.
    expect(spec).toHaveValue('user.web_registered')
  })

  it('says nothing for a hint that is on and allowed everywhere', async () => {
    vi.mocked(listUserHints).mockResolvedValue([hint({})])
    renderPage()
    await screen.findByRole('textbox', { name: says('automationsPage.config.name') })

    expect(screen.queryByText(says('automationsPage.actions.hintOff', { title: 'Добро пожаловать' }))).toBeNull()
    expect(screen.queryByText(gapWarning(['browser']))).toBeNull()
  })
})
