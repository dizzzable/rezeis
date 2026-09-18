/**
 * A DRAFT THAT OUTLIVES A VISIT TO ANOTHER TAB.
 *
 * Reported by the owner: a draft rule was open on «Правила», he spent a while on
 * «Подсказки», came back — and the tab showed `["admin","automations","rule",
 * "__new__"] data is undefined`, with «Повторить» repeating it for ever.
 *
 * The unsaved rule was kept in the QUERY CACHE under a synthetic id, and read
 * back by a query function that returned whatever the cache held. The editor
 * only exists on «Правила», so on any other tab nothing observed that entry, and
 * the cache collects an unobserved entry once its `gcTime` has passed. Back on
 * the tab, the query ran, found nothing, and handed TanStack `undefined` — which
 * it refuses as data, every time it is asked.
 *
 * "The way GC would" is done by hand here rather than by waiting five minutes:
 * every query nothing observes is removed, which is exactly what the collector
 * does to each of them once its time is up. It names no key, so it holds the
 * page to "a draft survives the cache" rather than to one way of storing it.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePermissionStore, type RbacAction } from '@/features/rbac'
import { createUserHint, getHintVocabulary, listUserHints } from '@/features/user-hints/user-hints-api'
import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { queryClient as panelQueryClient } from '@/lib/query-client'
import AutomationsPage from './automations-page'
import { createRule, getCatalog, getRule, listExecutions, listRules } from './automations-api'
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

/** The page on the panel's own query defaults, in a client this test can reach. */
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

/** What the garbage collector does to every entry nothing observes once its time is up. */
function collectGarbage(client: QueryClient): number {
  const cache = client.getQueryCache()
  const unobserved = cache.getAll().filter((query) => query.getObserversCount() === 0)
  for (const query of unobserved) cache.remove(query)
  return unobserved.length
}

beforeEach(async () => {
  usePermissionStore.getState().reset()
  grant([
    { resource: 'automations', action: 'view' },
    { resource: 'automations', action: 'create' },
    { resource: 'user_hints', action: 'view' },
    { resource: 'user_hints', action: 'create' },
  ])
  vi.mocked(getCatalog).mockResolvedValue({ actionTypes: ['notify_telegram', 'show_hint'], coincidentEventGroups: [] })
  vi.mocked(getEventCatalog).mockResolvedValue({ events: [], windowDays: 30 })
  vi.mocked(listRules).mockResolvedValue([])
  vi.mocked(getRule).mockRejectedValue(new Error('no saved rule is read in these cases'))
  vi.mocked(listExecutions).mockResolvedValue({ items: [], nextCursor: null })
  vi.mocked(listUserHints).mockResolvedValue([])
  vi.mocked(getHintVocabulary).mockResolvedValue({ routes: [], surfaces: [], formFactors: [], modes: [] })
  vi.mocked(createUserHint).mockResolvedValue({ titleRu: 'Добро пожаловать' } as never)
  await i18nReady
  await loadFeatureBundle('automations')
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('an unsaved draft and a visit to another tab', () => {
  it('is still open, under its name, after the cache has collected everything nothing watched', async () => {
    const client = renderPage()
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: says('automationsPage.newRule') }))
    expect(
      await screen.findByRole('textbox', { name: says('automationsPage.config.name') }),
    ).toHaveValue(says('automationsPage.untitledRule'))

    await user.click(screen.getByRole('tab', { name: says('automationsPage.tabs.hints') }))
    await waitFor(() => {
      expect(screen.queryByRole('textbox', { name: says('automationsPage.config.name') })).toBeNull()
    })
    // Anti-vacuity: the collector had something to collect, so the case is not
    // passing because the cache never held anything to lose.
    expect(collectGarbage(client)).toBeGreaterThan(0)

    await user.click(screen.getByRole('tab', { name: says('automationsPage.tabs.rules') }))

    expect(
      await screen.findByRole('textbox', { name: says('automationsPage.config.name') }),
    ).toHaveValue(says('automationsPage.untitledRule'))
    expect(screen.getByRole('button', { name: says('automationsPage.editor.create') })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: says('common.retry') })).toBeNull()
  })

  it('keeps a template draft too, and it still creates', async () => {
    const client = renderPage()
    const user = userEvent.setup()
    vi.mocked(createRule).mockImplementation(async (payload) => ({
      id: 'rule-created',
      name: payload.name,
      description: payload.description ?? null,
      isEnabled: payload.isEnabled ?? false,
      triggerKind: payload.triggerKind,
      triggerSpec: payload.triggerSpec,
      conditions: payload.conditions ?? null,
      actions: payload.actions,
      createdById: 'admin-1',
      lastRunAt: null,
      lastRunStatus: null,
      lastRunMessage: null,
      runCount: 0,
      createdAt: '2026-09-15T10:00:00.000Z',
      updatedAt: '2026-09-15T10:00:00.000Z',
    }))

    await user.click(await screen.findByRole('button', { name: says('automationsPage.help.title') }))
    const templateName = says('automationsPage.templates.node_down_notify.name')
    const card = (await screen.findByText(templateName)).parentElement
    expect(card).not.toBeNull()
    const use = Array.from(card!.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === says('automationsPage.help.useTemplate'),
    )
    expect(use, 'the template card has no «Использовать» button').toBeDefined()
    await user.click(use!)
    expect(
      await screen.findByRole('textbox', { name: says('automationsPage.config.name') }),
    ).toHaveValue(templateName)

    await user.click(screen.getByRole('tab', { name: says('automationsPage.tabs.map') }))
    await waitFor(() => {
      expect(screen.queryByRole('textbox', { name: says('automationsPage.config.name') })).toBeNull()
    })
    expect(collectGarbage(client)).toBeGreaterThan(0)
    await user.click(screen.getByRole('tab', { name: says('automationsPage.tabs.rules') }))

    expect(
      await screen.findByRole('textbox', { name: says('automationsPage.config.name') }),
    ).toHaveValue(templateName)
    await user.click(screen.getByRole('button', { name: says('automationsPage.editor.create') }))
    await waitFor(() => {
      expect(createRule).toHaveBeenCalledTimes(1)
    })
    expect(vi.mocked(createRule).mock.calls[0]![0]).toMatchObject({
      name: templateName,
      triggerSpec: 'node.connection_lost',
      isEnabled: false,
    })
  })
})
