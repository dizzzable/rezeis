/**
 * «Не получилось подключиться?» — the ready-made pop-up on
 * `subscription.not_connected`.
 *
 * Its event exists only while «Помощь с подключением» sends automatically (for
 * trials and gifts, only with its second switch), and only after the message
 * was tried. An operator who applies the card with the help switched off gets a
 * rule that never fires — so the card carries an (i) that says so, and it is
 * the one card that does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import { usePermissionStore } from '@/features/rbac'
import { listUserHints } from '@/features/user-hints/user-hints-api'
import { HINT_TEMPLATES } from './hint-templates'
import AutomationsPage from './automations-page'
import { getCatalog, listExecutions, listRules } from './automations-api'

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

vi.mock('@/features/user-hints/user-hints-api', () => ({
  createUserHint: vi.fn(),
  updateUserHint: vi.fn(),
  listUserHints: vi.fn(),
  deleteUserHint: vi.fn(),
  getUserHint: vi.fn(),
}))

/** A bundle sentence, failing loudly when the key is missing. */
function says(key: string, values?: Record<string, unknown>): string {
  const sentence = String(i18n.t(key, values ?? {}))
  expect(sentence, `${key} is missing from the automations bundle`).not.toBe(key)
  return sentence
}

describe('the «Не получилось подключиться?» card', () => {
  beforeEach(async () => {
    usePermissionStore.setState({
      loaded: true,
      loading: false,
      granted: new Set(['automations:view', 'automations:create', 'user_hints:create']),
      mustChangePassword: false,
      role: 'ADMIN',
      rbacRoleId: 'role-1',
      error: null,
    })
    vi.mocked(getCatalog).mockResolvedValue({ actionTypes: ['show_hint'], coincidentEventGroups: [] })
    vi.mocked(listRules).mockResolvedValue([])
    vi.mocked(listExecutions).mockResolvedValue({ items: [], nextCursor: null })
    vi.mocked(listUserHints).mockResolvedValue([])
    await loadFeatureBundle('automations')
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    usePermissionStore.getState().reset()
  })

  it('says behind its (i) when its event exists, and it is the only card with one', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AutomationsPage />)
    await user.click(await screen.findByRole('button', { name: says('automationsPage.help.title') }))

    const name = says('automationsPage.hintTemplates.connect_help.name')
    await screen.findByText(name)
    const info = screen.getByRole('button', { name: says('automationsPage.infoAria', { subject: name }) })
    await user.hover(info)
    expect((await screen.findByRole('tooltip')).textContent).toBe(
      says('automationsPage.hintTemplates.connect_help.info'),
    )

    // Anti-vacuity: the flag is what draws it, not every card.
    const flagged = HINT_TEMPLATES.filter((template) => template.info === true).map((template) => template.id)
    expect(flagged).toEqual(['connect_help'])
  })
})
