/**
 * A ready-made hint takes TWO grants, and the panel hands them out one at a time.
 *
 * `user_hints:create` writes the words; `automations:create` writes the rule
 * that shows them. The template button does both, in that order, and the order
 * is what made the split expensive: a role holding only the first got a text
 * row written, a draft rule opened, and a 403 from Create — leaving a hint on
 * the Hints tab that fires for nobody and that the operator cannot finish or,
 * without `user_hints:delete`, remove.
 *
 * The server refused correctly throughout. What was missing is refusing BEFORE
 * the half that succeeds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import { usePermissionStore, type RbacAction } from '@/features/rbac'
import { HINT_TEMPLATES } from './hint-templates'
import AutomationsPage from './automations-page'
import { getCatalog, listExecutions, listRules } from './automations-api'
import { createUserHint, listUserHints, updateUserHint } from '@/features/user-hints/user-hints-api'

// The refusal reaches the operator as a toast, and no `<Toaster/>` is mounted
// in this harness — so the text is read where it is handed over.
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

vi.mock('@/features/user-hints/user-hints-api', () => ({
  createUserHint: vi.fn(),
  updateUserHint: vi.fn(),
  listUserHints: vi.fn(),
  deleteUserHint: vi.fn(),
  getUserHint: vi.fn(),
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

/**
 * The sentence a key renders right now, as a substring matcher.
 *
 * Every string this file needs is a LOCATOR — find the help card, find the
 * template section inside it, find the button on a template card — and not one
 * of them is a claim about wording. Pinning the wording made all six cases here
 * go red for a copy correction they have nothing to do with: the library used
 * to be called "Ready-made pop-ups" while nine of its twenty-one templates
 * render as a line that does not take the screen. Looked up through the bundle,
 * the locator moves with the copy and only a KEY rename breaks it — which is a
 * real break, and the `not.toBe(key)` below is what turns it into a readable
 * failure instead of a matcher that quietly matches nothing.
 */
function says(key: string): RegExp {
  const sentence = String(i18n.t(key))
  expect(sentence, `${key} is missing from the automations bundle`).not.toBe(key)
  return new RegExp(sentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
}

/** Opens the help card and presses the first ready-made hint in it. */
async function pressFirstTemplate(): Promise<void> {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: says('automationsPage.help.title') }))

  const heading = await screen.findByText(says('automationsPage.hintTemplates.title'))
  const section = heading.parentElement
  expect(section).not.toBeNull()
  const useLabel = String(i18n.t('automationsPage.help.useTemplate'))
  const buttons = Array.from(section!.querySelectorAll('button')).filter(
    (button) => button.textContent?.trim() === useLabel,
  )
  expect(buttons.length).toBeGreaterThan(0)
  await user.click(buttons[0]!)
}

describe('applying a ready-made hint without both grants', () => {
  beforeEach(async () => {
    usePermissionStore.getState().reset()
    vi.mocked(getCatalog).mockResolvedValue({ actionTypes: ['show_hint'], coincidentEventGroups: [] })
    vi.mocked(listRules).mockResolvedValue([])
    vi.mocked(listExecutions).mockResolvedValue({ items: [], nextCursor: null })
    vi.mocked(listUserHints).mockResolvedValue([])
    vi.mocked(createUserHint).mockResolvedValue({} as never)
    vi.mocked(updateUserHint).mockResolvedValue({} as never)
    await loadFeatureBundle('automations')
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('writes no text when the rule could never be created', async () => {
    grant([{ resource: 'automations', action: 'view' }, { resource: 'user_hints', action: 'create' }])

    renderWithProviders(<AutomationsPage />)
    await pressFirstTemplate()

    // The sentence names the grant, because "forbidden" sends an operator to
    // the wrong page: they have the automations page open and can see it.
    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('automations:create'))
    })
    expect(createUserHint).not.toHaveBeenCalled()
    expect(updateUserHint).not.toHaveBeenCalled()
  })

  it('says which half is missing when it is the text half', async () => {
    grant([{ resource: 'automations', action: 'view' }, { resource: 'automations', action: 'create' }])

    renderWithProviders(<AutomationsPage />)
    await pressFirstTemplate()

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('user_hints:create'))
    })
    expect(createUserHint).not.toHaveBeenCalled()
  })

  it('goes through when the role holds both', async () => {
    grant([
      { resource: 'automations', action: 'view' },
      { resource: 'automations', action: 'create' },
      { resource: 'user_hints', action: 'create' },
    ])

    renderWithProviders(<AutomationsPage />)
    await pressFirstTemplate()

    // Anti-vacuity: without this the two cases above pass just as well when
    // the button does nothing at all.
    await waitFor(() => {
      expect(createUserHint).toHaveBeenCalledTimes(1)
    })
  })
})

describe('applying a ready-made hint that already has its text', () => {
  // The UPDATE branch, which the cases above never reach: they all mock
  // `listUserHints` to `[]`. It is a PUT, so it needs `user_hints:edit` — a
  // different grant from the one that writes a new hint — and the button that
  // exists only for this branch is the amber "text ready, no rule" one on the
  // map. A role holding every grant the first version of the check asked for
  // pressed exactly that button, got a bare server refusal, and could not
  // finish.
  beforeEach(async () => {
    usePermissionStore.getState().reset()
    vi.mocked(getCatalog).mockResolvedValue({ actionTypes: ['show_hint'], coincidentEventGroups: [] })
    vi.mocked(listRules).mockResolvedValue([])
    vi.mocked(listExecutions).mockResolvedValue({ items: [], nextCursor: null })
    vi.mocked(createUserHint).mockResolvedValue({} as never)
    vi.mocked(updateUserHint).mockResolvedValue({} as never)
    await loadFeatureBundle('automations')
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  /** Every template hint already written, so the apply takes the PUT branch. */
  function hintsAlreadyExist(): void {
    vi.mocked(listUserHints).mockResolvedValue(
      HINT_TEMPLATES.map((template, index) => ({
        id: `hint-${index}`,
        key: template.hintKey,
        titleRu: 'Уже есть',
        bodyRu: 'Текст',
        surfaces: [],
        formFactors: [],
        groupKey: null,
        isActive: true,
        mode: template.mode,
        tone: template.tone,
        ttlHours: template.ttlHours,
        isRepeatable: template.repeatable,
        ctaKind: 'NONE',
        ctaTarget: null,
      })) as never,
    )
  }

  it('names user_hints:edit, not user_hints:create', async () => {
    hintsAlreadyExist()
    grant([
      { resource: 'automations', action: 'view' },
      { resource: 'automations', action: 'create' },
      { resource: 'user_hints', action: 'create' },
    ])

    renderWithProviders(<AutomationsPage />)
    await pressFirstTemplate()

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('user_hints:edit'))
    })
    expect(updateUserHint).not.toHaveBeenCalled()
  })

  it('goes through for a role that holds the edit grant', async () => {
    hintsAlreadyExist()
    grant([
      { resource: 'automations', action: 'view' },
      { resource: 'automations', action: 'create' },
      { resource: 'user_hints', action: 'edit' },
    ])

    renderWithProviders(<AutomationsPage />)
    await pressFirstTemplate()

    await waitFor(() => {
      expect(updateUserHint).toHaveBeenCalledTimes(1)
    })
    expect(createUserHint).not.toHaveBeenCalled()
  })

  it('does not silently revert where the operator pointed the button', async () => {
    // "Refresh the words" has to mean the words. An operator who repointed the
    // pop-up and lengthened its window lost both by pressing the one button the
    // map offers for resuming a half-built pop-up.
    vi.mocked(listUserHints).mockResolvedValue([
      {
        id: 'hint-aimed',
        key: HINT_TEMPLATES[0].hintKey,
        titleRu: 'Уже есть',
        bodyRu: 'Текст',
        surfaces: ['tma'],
        formFactors: ['mobile'],
        groupKey: 'a-group',
        isActive: false,
        mode: 'TOAST',
        tone: 'INFO',
        ttlHours: 72,
        isRepeatable: false,
        ctaKind: 'ROUTE',
        ctaTarget: '/plans',
      },
    ] as never)
    grant([
      { resource: 'automations', action: 'view' },
      { resource: 'automations', action: 'create' },
      { resource: 'user_hints', action: 'edit' },
    ])

    renderWithProviders(<AutomationsPage />)
    await pressFirstTemplate()

    await waitFor(() => {
      expect(updateUserHint).toHaveBeenCalledTimes(1)
    })
    const [, sent] = vi.mocked(updateUserHint).mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ]
    expect(sent.ctaTarget).toBe('/plans')
    expect(sent.ttlHours).toBe(72)
    expect(sent.isRepeatable).toBe(false)
    expect(sent.mode).toBe('TOAST')
    expect(sent.tone).toBe('INFO')
    expect(sent.surfaces).toEqual(['tma'])
    expect(sent.isActive).toBe(false)
    expect(sent.groupKey).toBe('a-group')
    // And the words ARE refreshed — otherwise the whole button does nothing.
    //
    // To the STOCK wording, not merely to something other than what was there.
    // "Not the old text" is satisfied by an empty body, by the title written
    // into the body, by any accident at all — and "give me the stock text back"
    // is the entire promise of the button. Read out of the bundle through the
    // key the payload itself carries, so this stays a claim about the branch
    // rather than a second opinion about the copy.
    const applied = HINT_TEMPLATES.find((template) => template.hintKey === sent.key)
    expect(applied, `no template owns the key "${String(sent.key)}"`).toBeDefined()
    const stock = String(i18n.t(`automationsPage.hintTemplates.${applied!.id}.bodyRu`))
    expect(stock, 'the template body is missing from the automations bundle').not.toBe(
      `automationsPage.hintTemplates.${applied!.id}.bodyRu`,
    )
    expect(sent.bodyRu).toBe(stock)
  })
})

describe('re-applying a template over a hint whose group or button the operator changed', () => {
  /**
   * "THE OTHER SETTINGS ARE KEPT" INCLUDES A SETTING THE OPERATOR REMOVED.
   *
   * The refresh branch kept a group and a button only when the hint HAD one:
   * a group the operator had cleared, or a button they had taken off, came
   * back from the template — while the toast, and the map's tooltip for the
   * same button, said every other setting was kept.
   *
   * The hints PUT replaces the whole row (`user-hint.service.ts`,
   * `buildWriteData`): an absent or empty `groupKey` is written as no group,
   * and a button of kind NONE has its words and destination cleared — while a
   * button of any other kind is refused without its Russian words. So what is
   * sent has to say "none" in exactly those terms, and carry a kept button's
   * words with it.
   */
  beforeEach(async () => {
    usePermissionStore.getState().reset()
    vi.mocked(getCatalog).mockResolvedValue({ actionTypes: ['show_hint'], coincidentEventGroups: [] })
    vi.mocked(listRules).mockResolvedValue([])
    vi.mocked(listExecutions).mockResolvedValue({ items: [], nextCursor: null })
    vi.mocked(createUserHint).mockResolvedValue({} as never)
    vi.mocked(updateUserHint).mockResolvedValue({} as never)
    grant([
      { resource: 'automations', action: 'view' },
      { resource: 'automations', action: 'create' },
      { resource: 'user_hints', action: 'edit' },
    ])
    await loadFeatureBundle('automations')
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  function templateOf(id: string) {
    const template = HINT_TEMPLATES.find((candidate) => candidate.id === id)
    expect(template, `no template ${id}`).toBeDefined()
    return template!
  }

  /** The hint as the operator left it: the template's key, their own aiming. */
  function existing(id: string, over: Record<string, unknown>): void {
    const template = templateOf(id)
    vi.mocked(listUserHints).mockResolvedValue([
      {
        id: 'hint-changed',
        key: template.hintKey,
        titleRu: 'Уже есть',
        bodyRu: 'Текст оператора',
        titleEn: null,
        bodyEn: null,
        surfaces: [],
        formFactors: [],
        groupKey: null,
        isActive: true,
        mode: template.mode,
        tone: template.tone,
        ttlHours: template.ttlHours,
        isRepeatable: template.repeatable,
        ctaKind: 'NONE',
        ctaLabelRu: null,
        ctaLabelEn: null,
        ctaTarget: null,
        ...over,
      },
    ] as never)
  }

  /** Opens the guide and presses «Использовать» on the card named for `id`. */
  async function pressCard(id: string): Promise<Record<string, unknown>> {
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: says('automationsPage.help.title') }))
    const card = (
      await screen.findByText(String(i18n.t(`automationsPage.hintTemplates.${id}.name`)))
    ).parentElement!
    const use = Array.from(card.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === String(i18n.t('automationsPage.help.useTemplate')),
    )
    expect(use, `the ${id} card has no «Использовать»`).toBeDefined()
    await user.click(use!)
    await waitFor(() => {
      expect(updateUserHint).toHaveBeenCalledTimes(1)
    })
    const [, sent] = vi.mocked(updateUserHint).mock.calls[0] as unknown as [string, Record<string, unknown>]
    // Anti-vacuity: this is the refresh branch, and the words ARE refreshed.
    expect(sent.bodyRu).toBe(String(i18n.t(`automationsPage.hintTemplates.${id}.bodyRu`)))
    return sent
  }

  it('keeps no group and no button when the operator had removed both', async () => {
    // The premise: this template ships both, so both could come back.
    expect(templateOf('payment_failed').groupKey).toBeDefined()
    expect(templateOf('payment_failed').route).not.toBeNull()
    existing('payment_failed', { groupKey: null, ctaKind: 'NONE' })

    const sent = await pressCard('payment_failed')

    // `''` or nothing is what the server writes as no group.
    expect(sent.groupKey ?? '').toBe('')
    expect(sent.ctaKind).toBe('NONE')
    expect(sent.ctaTarget).toBeUndefined()
    expect(sent.ctaLabelRu).toBeUndefined()
    expect(sent.ctaLabelEn).toBeUndefined()
  })

  it('keeps the operator’s own group and button — destination and words — over the template’s', async () => {
    existing('payment_failed', {
      groupKey: 'my-payments',
      ctaKind: 'ROUTE',
      ctaTarget: '/renew',
      ctaLabelRu: 'Продлить сейчас',
      ctaLabelEn: 'Renew now',
    })

    const sent = await pressCard('payment_failed')

    expect(sent).toMatchObject({
      groupKey: 'my-payments',
      ctaKind: 'ROUTE',
      ctaTarget: '/renew',
      ctaLabelRu: 'Продлить сейчас',
      ctaLabelEn: 'Renew now',
    })
  })

  it('keeps a button the template has none of, with the words the server requires of a button', async () => {
    expect(templateOf('first_connected').route).toBeNull()
    existing('first_connected', {
      ctaKind: 'ROUTE',
      ctaTarget: '/support',
      ctaLabelRu: 'Написать нам',
      ctaLabelEn: null,
    })

    const sent = await pressCard('first_connected')

    expect(sent).toMatchObject({ ctaKind: 'ROUTE', ctaTarget: '/support', ctaLabelRu: 'Написать нам' })
    // No English words on the operator's button stays no English words.
    expect(sent.ctaLabelEn ?? '').toBe('')
  })
})
