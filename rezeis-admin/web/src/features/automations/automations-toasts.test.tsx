/**
 * WHAT THE OPERATOR IS TOLD ONCE THE PANEL HAS FINISHED DOING SOMETHING.
 *
 * Three sentences, all of which were wrong in the same way: they described a
 * situation the operator was not in.
 *
 *   - The template button has two branches. The first writes a hint that no
 *     rule points at yet; the second replaces the words of a hint that already
 *     exists, by PUT, and it lands before the toast does. Both ended on the
 *     same sentence — "the text is created, review the rule and press Create" —
 *     which on the second branch names a creation that did not happen, a review
 *     of something already live, and a button whose only effect would be to add
 *     a SECOND rule for a key that already has one.
 *   - A refusal from the server reached a Russian operator in English, on the
 *     template button and on the rule switch alike, because `getErrorMessage`
 *     is a pure extractor: it pulls `response.data.message` off the rejection
 *     and does no dictionary lookup at all. For a request that never reached
 *     the server it fell through to axios's own `.message` — "Network Error" —
 *     which is transport jargon in every locale and points at the wrong thing:
 *     an unreachable backend reads as a refusal.
 *
 * The cases below are written against the KEY rather than the sentence. Which
 * of two sentences a branch chose is the behaviour; what either sentence says
 * is copy, it is corrected from time to time, and pinning it here would put a
 * second owner on wording that already has one in
 * `i18n/features/automations-copy-truth.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router'

import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import { usePermissionStore, type RbacAction } from '@/features/rbac'
import { HINT_TEMPLATES } from './hint-templates'
import AutomationsPage from './automations-page'
import { getCatalog, getRule, listExecutions, listRules, toggleRule } from './automations-api'
import { createUserHint, listUserHints, updateUserHint } from '@/features/user-hints/user-hints-api'

// No `<Toaster/>` is mounted in this harness, so the sentence is read where it
// is handed over rather than off the screen.
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

const RULE = {
  id: 'rule-1',
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

/** A locator built from a key, for an element found by its text or its label. */
function matching(key: string, values?: Record<string, unknown>): RegExp {
  return new RegExp(says(key, values).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
}

/**
 * A rejection exactly as axios raises it when the request never reached the
 * server: no `response`, `ERR_NETWORK`, and a `.message` that is transport
 * prose in every language.
 *
 * This is the shape that separates the two helpers without depending on which
 * language the harness happens to run in. `getErrorMessage` finds no body and
 * falls through to `.message`, so it puts "Network Error" on screen for a
 * Russian operator and calls a dead backend a refusal; `translateApiError`
 * recognises it as unreachable and says so in the panel's own words.
 */
function unreachable(): Error {
  return Object.assign(new Error('Network Error'), {
    isAxiosError: true,
    code: 'ERR_NETWORK',
  })
}

/**
 * Opens the help card and presses the first ready-made hint in it.
 *
 * The first card is «Первое появление», which asks whom it greets. Its default
 * — everyone — brings a companion rule, and so a sentence of its own; naming a
 * door (`audience`) gives the plain one-rule template the cases below were
 * first written against.
 */
async function pressFirstTemplate(audience?: 'telegram' | 'web'): Promise<void> {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: matching('automationsPage.help.title') }))

  const heading = await screen.findByText(matching('automationsPage.hintTemplates.title'))
  const section = heading.parentElement
  expect(section).not.toBeNull()
  if (audience !== undefined) {
    await user.click(
      within(section!).getByRole('radio', {
        name: says(`automationsPage.hintTemplates.arrival.audiences.${audience}`),
      }),
    )
  }
  const useLabel = String(i18n.t('automationsPage.help.useTemplate'))
  const buttons = Array.from(section!.querySelectorAll('button')).filter(
    (button) => button.textContent?.trim() === useLabel,
  )
  expect(buttons.length).toBeGreaterThan(0)
  await user.click(buttons[0]!)
}

beforeEach(async () => {
  usePermissionStore.getState().reset()
  vi.mocked(getCatalog).mockResolvedValue({ actionTypes: ['show_hint'], coincidentEventGroups: [] })
  vi.mocked(listRules).mockResolvedValue([])
  vi.mocked(getRule).mockResolvedValue(RULE as never)
  vi.mocked(listExecutions).mockResolvedValue({ items: [], nextCursor: null })
  vi.mocked(toggleRule).mockResolvedValue({} as never)
  vi.mocked(listUserHints).mockResolvedValue([])
  vi.mocked(createUserHint).mockResolvedValue({ titleRu: 'Свежий текст' } as never)
  vi.mocked(updateUserHint).mockResolvedValue({ titleRu: 'Уже существовавший текст' } as never)
  await i18nReady
  await loadFeatureBundle('automations')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('which sentence follows the template button', () => {
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

  it('says "created" when it created something', async () => {
    grant([
      { resource: 'automations', action: 'view' },
      { resource: 'automations', action: 'create' },
      { resource: 'user_hints', action: 'create' },
    ])

    renderWithProviders(<AutomationsPage />)
    await pressFirstTemplate('telegram')

    await waitFor(() => {
      expect(createUserHint).toHaveBeenCalledTimes(1)
    })
    const title = 'Свежий текст'
    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith(
        says('automationsPage.hintTemplates.created', { title }),
      )
    })
    // The pair, not the sentence: if the two keys ever render the same words
    // this fails, which is the only thing that makes the case above mean
    // anything.
    expect(toastMock.success).not.toHaveBeenCalledWith(
      says('automationsPage.hintTemplates.updated', { title }),
    )
  })

  it('says "updated" on the branch that created nothing', async () => {
    // THE CASE THE OLD TOAST LIED ABOUT. The PUT has already landed by the time
    // this fires: nothing was created, and if an enabled rule is showing the
    // hint the new words are with customers already.
    hintsAlreadyExist()
    grant([
      { resource: 'automations', action: 'view' },
      { resource: 'automations', action: 'create' },
      { resource: 'user_hints', action: 'edit' },
    ])

    renderWithProviders(<AutomationsPage />)
    await pressFirstTemplate('telegram')

    await waitFor(() => {
      expect(updateUserHint).toHaveBeenCalledTimes(1)
    })
    const title = 'Уже существовавший текст'
    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith(
        says('automationsPage.hintTemplates.updated', { title }),
      )
    })
    expect(createUserHint).not.toHaveBeenCalled()
    expect(toastMock.success).not.toHaveBeenCalledWith(
      says('automationsPage.hintTemplates.created', { title }),
    )
  })

  describe('for a draft that «Создать» saves with a companion rule', () => {
    // «Первое появление» for everyone: one hint, and «Создать» saves TWO rules.
    // "The rule opened as a draft" would under-count what the next press does.

    it('says how many rules «Создать» saves, on the branch that created the text', async () => {
      grant([
        { resource: 'automations', action: 'view' },
        { resource: 'automations', action: 'create' },
        { resource: 'user_hints', action: 'create' },
      ])

      renderWithProviders(<AutomationsPage />)
      await pressFirstTemplate()

      const title = 'Свежий текст'
      await waitFor(() => {
        expect(toastMock.success).toHaveBeenCalledWith(
          says('automationsPage.hintTemplates.createdWithCompanions', { title, count: 2 }),
        )
      })
      expect(toastMock.success).not.toHaveBeenCalledWith(
        says('automationsPage.hintTemplates.created', { title }),
      )
    })

    it('says how many rules the draft would add, on the branch that only refreshed the text', async () => {
      hintsAlreadyExist()
      grant([
        { resource: 'automations', action: 'view' },
        { resource: 'automations', action: 'create' },
        { resource: 'user_hints', action: 'edit' },
      ])

      renderWithProviders(<AutomationsPage />)
      await pressFirstTemplate()

      const title = 'Уже существовавший текст'
      await waitFor(() => {
        expect(toastMock.success).toHaveBeenCalledWith(
          says('automationsPage.hintTemplates.updatedWithCompanions', { title, count: 2 }),
        )
      })
      expect(toastMock.success).not.toHaveBeenCalledWith(
        says('automationsPage.hintTemplates.updated', { title }),
      )
    })
  })
})

describe('an answer that lands after the operator left the page', () => {
  it('does not bring them back to Automations, nor toast about a draft that is gone', async () => {
    // The tab switch after a template is a navigation to this page's own
    // address. Arriving once the operator had gone elsewhere, it dragged them
    // back to a page that no longer held the draft it was opening.
    grant([
      { resource: 'automations', action: 'view' },
      { resource: 'automations', action: 'create' },
      { resource: 'user_hints', action: 'create' },
    ])
    let writeHint!: (value: unknown) => void
    vi.mocked(createUserHint).mockReturnValueOnce(
      new Promise((resolve) => {
        writeHint = resolve
      }) as never,
    )
    function Elsewhere() {
      const { pathname } = useLocation()
      return <p>now at {pathname}</p>
    }
    renderWithProviders(
      <MemoryRouter initialEntries={['/automations']}>
        <Routes>
          <Route
            path="/automations"
            element={
              <>
                <AutomationsPage />
                <Link to="/elsewhere">leave</Link>
              </>
            }
          />
          <Route path="/elsewhere" element={<Elsewhere />} />
        </Routes>
      </MemoryRouter>,
      { withRouter: false },
    )
    const user = userEvent.setup()
    await pressFirstTemplate('telegram')
    await waitFor(() => {
      expect(createUserHint).toHaveBeenCalledTimes(1)
    })

    await user.click(screen.getByRole('link', { name: 'leave' }))
    expect(await screen.findByText('now at /elsewhere')).toBeInTheDocument()

    writeHint({ titleRu: 'Свежий текст' })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })

    expect(screen.getByText('now at /elsewhere')).toBeInTheDocument()
    expect(toastMock.success).not.toHaveBeenCalled()
  })
})

describe('a refusal, in the words the panel owns', () => {
  it('does not report a dead backend to the operator as "Network Error"', async () => {
    grant([
      { resource: 'automations', action: 'view' },
      { resource: 'automations', action: 'create' },
      { resource: 'user_hints', action: 'create' },
    ])
    vi.mocked(createUserHint).mockRejectedValue(unreachable())

    renderWithProviders(<AutomationsPage />)
    await pressFirstTemplate()

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(says('errors.serverUnreachable'))
    })
    // What `getErrorMessage` put there instead. Not copy — it is axios's
    // transport prose, which is the defect: it never varies by language and it
    // calls an unreachable host a refusal.
    expect(toastMock.error).not.toHaveBeenCalledWith('Network Error')
  })

  it('says the same for the rule switch, which has its own call site', async () => {
    grant([
      { resource: 'automations', action: 'view' },
      { resource: 'automations', action: 'edit' },
    ])
    vi.mocked(listRules).mockResolvedValue([RULE] as never)
    vi.mocked(toggleRule).mockRejectedValue(unreachable())

    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('switch', {
        name: matching('automationsPage.list.toggleAria', { name: RULE.name }),
      }),
    )

    await waitFor(() => {
      expect(toggleRule).toHaveBeenCalledWith('rule-1', false)
    })
    // The switch names its rule: the list holds many, and the toast outlives
    // the moment the operator knew which one they pressed.
    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        says('automationsPage.toast.toggleFailed', { name: RULE.name, message: says('errors.serverUnreachable') }),
      )
    })
    expect(toastMock.error).not.toHaveBeenCalledWith(expect.stringContaining('Network Error'))
  })
})
