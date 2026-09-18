/**
 * «ЗАПУСТИТЬ СЕЙЧАС» ON A RULE THAT SHOWS A HINT.
 *
 * Reported by the owner: pressed on his freshly built welcome, the button marked
 * the rule «ОШИБКА». It posted a run naming no customer, and `show_hint` shows
 * its hint to the customer the trigger names — so the one button an operator
 * reaches for to see a pop-up could only ever fail.
 *
 * Now a rule with `show_hint` asks whom to run it for, says what will happen
 * before it runs, and answers in words per action. A rule without one still runs
 * at once — with its status translated at last.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { translateApiError } from '@/lib/translate-error'

import { usePermissionStore, type RbacAction } from '@/features/rbac'
import {
  getHintVocabulary,
  listUserHints,
  type UserHint,
} from '@/features/user-hints/user-hints-api'
import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import AutomationsPage from './automations-page'
import {
  getCatalog,
  getRule,
  listExecutions,
  listRules,
  runRuleManually,
  type AutomationRule,
} from './automations-api'
import { getEventCatalog } from './event-catalog-api'
import { searchCustomers, type RunCustomer } from './run-customer-search'

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

vi.mock('./run-customer-search', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./run-customer-search')>()),
  searchCustomers: vi.fn(),
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

const ANNA: RunCustomer = {
  id: 'cm-anna',
  telegramId: '101',
  username: 'anna',
  email: null,
  name: 'Anna',
  login: null,
  isBlocked: false,
}

/**
 * A rejection as axios raises it when no answer came back at all.
 *
 * ERR_NETWORK covers two states axios cannot tell apart: the request never left
 * the browser (no run at all, nothing will ever be in the log) and the
 * connection was cut after the bytes went out (a run may be going). The copy
 * has to hold for both.
 */
function unreachable(): Error {
  return Object.assign(new Error('Network Error'), { isAxiosError: true, code: 'ERR_NETWORK' })
}

/** A refusal the panel answered, as axios hands it over. */
function refused(message: string): Error {
  return Object.assign(new Error('Request failed with status code 400'), {
    isAxiosError: true,
    response: { status: 400, data: { message } },
  })
}

/** A run whose request timed out on the way — the browser gave up waiting. */
function timedOut(): Error {
  return Object.assign(new Error('timeout of 120000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED' })
}

/** A run the proxy in front of the panel gave up on. */
function gatewayTimeout(): Error {
  return Object.assign(new Error('Request failed with status code 504'), {
    isAxiosError: true,
    response: { status: 504, data: '<html>504</html>' },
  })
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

/**
 * Hovers `target`, expects its tip, and closes the tip — not the dialog under it.
 *
 * Not moved away with `unhover`: that lands on the page body, which an open
 * modal makes `pointer-events: none`. The next hover moves off this target.
 */
async function expectTip(user: ReturnType<typeof userEvent.setup>, target: HTMLElement, sentence: string) {
  await user.hover(target)
  expect(await screen.findByRole('tooltip')).toHaveTextContent(sentence)
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
}

const WELCOME = savedRule({
  id: 'rule-welcome',
  name: 'Первое появление',
  actions: [
    { type: 'show_hint', params: { hintKey: 'tpl-welcome' } },
    { type: 'notify_telegram', params: { text: 'Somebody signed up' } },
  ],
})

const EVERYTHING = [
  { resource: 'automations', action: 'view' },
  { resource: 'automations', action: 'edit' },
  { resource: 'automations', action: 'run' },
  { resource: 'users', action: 'view' },
] as const

function serve(rule: AutomationRule): void {
  vi.mocked(listRules).mockResolvedValue([rule])
  vi.mocked(getRule).mockResolvedValue(rule)
}

/** Renders the page with `rule` open and presses «Запустить сейчас». Returns the dialog. */
async function openRunDialog(
  user: ReturnType<typeof userEvent.setup>,
  rule: AutomationRule = WELCOME,
): Promise<HTMLElement> {
  serve(rule)
  renderWithProviders(<AutomationsPage />)
  await screen.findByRole('button', { name: says('automationsPage.editor.save') })
  await user.click(screen.getByRole('button', { name: says('automationsPage.editor.runNow') }))
  return screen.findByRole('dialog', { name: says('automationsPage.runDialog.title', { name: rule.name }) })
}

/** Finds Anna through the search and picks her. */
async function pickAnna(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement): Promise<void> {
  await user.type(within(dialog).getByLabelText(says('automationsPage.runDialog.customerLabel')), 'ann')
  await waitFor(() => {
    expect(searchCustomers).toHaveBeenCalledWith('ann', expect.anything())
  })
  await user.click(await within(dialog).findByRole('button', { name: /Anna/ }))
}

beforeEach(async () => {
  usePermissionStore.getState().reset()
  grant(EVERYTHING)
  vi.mocked(getCatalog).mockResolvedValue({ actionTypes: ['show_hint', 'notify_telegram'], coincidentEventGroups: [] })
  vi.mocked(getEventCatalog).mockResolvedValue({ events: [], windowDays: 30 })
  vi.mocked(listExecutions).mockResolvedValue({ items: [], nextCursor: null })
  vi.mocked(getHintVocabulary).mockResolvedValue({ routes: [], surfaces: [], formFactors: [], modes: [] })
  vi.mocked(listUserHints).mockResolvedValue([
    hint({ key: 'tpl-welcome', titleRu: 'Добро пожаловать', surfaces: ['browser'], formFactors: ['mobile'] }),
  ])
  vi.mocked(searchCustomers).mockResolvedValue([ANNA])
  vi.mocked(runRuleManually).mockResolvedValue({
    executionId: 'execution-1',
    status: 'SUCCEEDED',
    actionResults: [],
    errorMessage: null,
  })
  await i18nReady
  await loadFeatureBundle('automations')
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('a rule that shows a hint', () => {
  it('asks whom to run it for, says what will happen, and runs it for the customer picked', async () => {
    const user = userEvent.setup()
    const dialog = await openRunDialog(user)

    expect(runRuleManually).not.toHaveBeenCalled()
    expect(dialog).toHaveTextContent(says('automationsPage.runDialog.what'))
    expect(
      await within(dialog).findByText(
        says('automationsPage.runDialog.hintLine', {
          title: 'Добро пожаловать',
          mode: says('automationsPage.runDialog.modes.MODAL'),
          where: `${says('userHints.surfaces.browser')} · ${says('userHints.formFactors.mobile')}`,
        }),
      ),
    ).toBeInTheDocument()
    expect(dialog).toHaveTextContent(
      says('automationsPage.runDialog.alsoRuns', { actions: says('automationsPage.actionTypes.notify_telegram') }),
    )

    const run = within(dialog).getByRole('button', { name: says('automationsPage.runDialog.run') })
    expect(run).toBeDisabled()

    await pickAnna(user, dialog)
    expect(within(dialog).getByRole('button', { name: says('automationsPage.runDialog.change') })).toBeInTheDocument()
    expect(within(dialog).queryByLabelText(says('automationsPage.runDialog.customerLabel'))).toBeNull()
    expect(run).toBeEnabled()

    await user.click(run)
    await waitFor(() => {
      expect(runRuleManually).toHaveBeenCalledWith('rule-welcome', { userId: 'cm-anna' }, { showAgain: true })
    })
  })

  it('sends showAgain as false once the box is cleared', async () => {
    const user = userEvent.setup()
    const dialog = await openRunDialog(user)
    await pickAnna(user, dialog)

    const box = within(dialog).getByRole('checkbox', { name: says('automationsPage.runDialog.showAgain') })
    expect(box).toBeChecked()
    await user.click(box)
    await user.click(within(dialog).getByRole('button', { name: says('automationsPage.runDialog.run') }))

    await waitFor(() => {
      expect(runRuleManually).toHaveBeenCalledWith('rule-welcome', { userId: 'cm-anna' }, { showAgain: false })
    })
  })

  it('lets the pick be changed', async () => {
    const user = userEvent.setup()
    const dialog = await openRunDialog(user)
    await pickAnna(user, dialog)

    await user.click(within(dialog).getByRole('button', { name: says('automationsPage.runDialog.change') }))

    expect(within(dialog).getByLabelText(says('automationsPage.runDialog.customerLabel'))).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: says('automationsPage.runDialog.run') })).toBeDisabled()
  })

  it('answers with the status and one line per action, worded from its code or kept as the server wrote it', async () => {
    vi.mocked(runRuleManually).mockResolvedValue({
      executionId: 'execution-2',
      status: 'FAILED',
      actionResults: [
        {
          index: 0,
          type: 'show_hint',
          status: 'skipped',
          message: 'hint "tpl-welcome" was not queued',
          code: 'hint_already_delivered',
          details: { hintKey: 'tpl-welcome', userId: 'cm-anna' },
        },
        { index: 1, type: 'notify_telegram', status: 'failed', message: 'telegram notifications are off' },
      ],
      errorMessage: '[notify_telegram] telegram notifications are off',
    })
    const user = userEvent.setup()
    const dialog = await openRunDialog(user)
    await pickAnna(user, dialog)
    const readsBefore = vi.mocked(getRule).mock.calls.length

    await user.click(within(dialog).getByRole('button', { name: says('automationsPage.runDialog.run') }))

    expect(await within(dialog).findByText(says('automationsPage.statuses.FAILED'))).toBeInTheDocument()
    expect(dialog).toHaveTextContent(
      says('automationsPage.runResults.hint_already_delivered', { hintKey: 'tpl-welcome' }),
    )
    expect(dialog).not.toHaveTextContent('was not queued')
    expect(dialog).toHaveTextContent('telegram notifications are off')
    // The run's execution row and run columns are re-read, as before.
    await waitFor(() => {
      expect(vi.mocked(getRule).mock.calls.length).toBeGreaterThan(readsBefore)
    })

    await user.click(within(dialog).getByRole('button', { name: says('automationsPage.runDialog.done') }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    // Opened again, it starts over: nobody picked, nothing answered.
    await user.click(screen.getByRole('button', { name: says('automationsPage.editor.runNow') }))
    const again = await screen.findByRole('dialog')
    expect(within(again).queryByText(says('automationsPage.statuses.FAILED'))).toBeNull()
    expect(within(again).getByRole('button', { name: says('automationsPage.runDialog.run') })).toBeDisabled()
  })

  it('keeps a refusal in the dialog, in the panel’s words, and lets it be tried again', async () => {
    // A REFUSAL — the panel answered. An unanswered run is a different case,
    // below: it may still be going, and is not offered again.
    const refusal = refused('Rule not found')
    vi.mocked(runRuleManually).mockRejectedValueOnce(refusal)
    const user = userEvent.setup()
    const dialog = await openRunDialog(user)
    await pickAnna(user, dialog)

    await user.click(within(dialog).getByRole('button', { name: says('automationsPage.runDialog.run') }))

    expect(
      await within(dialog).findByText(
        says('automationsPage.toast.runFailed', { message: translateApiError(i18n.t, refusal) }),
      ),
    ).toBeInTheDocument()
    expect(dialog).not.toHaveTextContent('Request failed with status code')
    await user.click(within(dialog).getByRole('button', { name: says('automationsPage.runDialog.run') }))
    await waitFor(() => {
      expect(runRuleManually).toHaveBeenCalledTimes(2)
    })
  })

  it('forgets a refusal once whom to run for, or whether to show again, has changed', async () => {
    vi.mocked(runRuleManually)
      .mockRejectedValueOnce(refused('Rule not found'))
      .mockRejectedValueOnce(refused('Rule not found'))
    const user = userEvent.setup()
    const dialog = await openRunDialog(user)
    await pickAnna(user, dialog)
    const run = () => user.click(within(dialog).getByRole('button', { name: says('automationsPage.runDialog.run') }))
    const failedLine = () =>
      within(dialog).queryByText(new RegExp(says('automationsPage.toast.runFailed', { message: '' }).trim()))

    await run()
    await waitFor(() => expect(failedLine()).not.toBeNull())
    await user.click(within(dialog).getByRole('checkbox', { name: says('automationsPage.runDialog.showAgain') }))
    expect(failedLine()).toBeNull()

    await run()
    await waitFor(() => expect(failedLine()).not.toBeNull())
    await user.click(within(dialog).getByRole('button', { name: says('automationsPage.runDialog.change') }))
    expect(failedLine()).toBeNull()
    await user.click(await within(dialog).findByRole('button', { name: /Anna/ }))
    expect(failedLine()).toBeNull()
  })

  it('cannot be closed while its run is out — not by Escape, a click outside, «Отмена» or its X — and keeps the answer', async () => {
    const answer = deferred<Awaited<ReturnType<typeof runRuleManually>>>()
    vi.mocked(runRuleManually).mockReturnValueOnce(answer.promise)
    const user = userEvent.setup()
    const dialog = await openRunDialog(user)
    await pickAnna(user, dialog)

    await user.click(within(dialog).getByRole('button', { name: says('automationsPage.runDialog.run') }))
    await waitFor(() => expect(runRuleManually).toHaveBeenCalledTimes(1))

    await user.keyboard('{Escape}')
    fireEvent.pointerDown(document.body)
    expect(screen.getByRole('dialog')).toBe(dialog)
    const closeX = within(dialog).getByRole('button', { name: says('common.close') })
    expect(closeX).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: says('common.cancel') })).toBeDisabled()
    // Disabled and silent is what the X used to be: it says why, as «Отмена» does,
    // and a keyboard lands on the wrapper that holds the reason — a disabled
    // button is not a tab stop, so without it the reason cannot be reached.
    expect(within(dialog).getByRole('group', { name: says('common.close') })).toBe(closeX.parentElement)
    await expectTip(user, closeX.parentElement!, says('automationsPage.runDialog.runTipRunning'))
    await expectTip(
      user,
      within(dialog).getByRole('button', { name: says('common.cancel') }).parentElement!,
      says('automationsPage.runDialog.runTipRunning'),
    )

    answer.resolve({ executionId: 'execution-late', status: 'SUCCEEDED', actionResults: [], errorMessage: null })
    expect(await within(dialog).findByText(says('automationsPage.statuses.SUCCEEDED'))).toBeInTheDocument()
    expect(runRuleManually).toHaveBeenCalledTimes(1)

    // Answered, it closes as any dialog does.
    expect(within(dialog).getByRole('button', { name: says('common.close') })).toBeEnabled()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('button', { name: says('automationsPage.editor.runNow') })).toHaveFocus()
  })

  it('hands the keyboard back to «Запустить сейчас» when it closes', async () => {
    // Nothing here is a Radix `DialogTrigger`: the dialog is opened by page
    // state, so without help focus fell to the page body on close, and the next
    // Tab started from the top of the document.
    const user = userEvent.setup()
    const dialog = await openRunDialog(user)
    expect(document.activeElement).not.toBe(document.body)

    await user.click(within(dialog).getByRole('button', { name: says('common.cancel') }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    expect(document.activeElement).not.toBe(document.body)
    expect(screen.getByRole('button', { name: says('automationsPage.editor.runNow') })).toHaveFocus()
  })

  it('says what each of its buttons does, and why «Запустить» cannot be pressed yet', async () => {
    const user = userEvent.setup()
    const dialog = await openRunDialog(user)
    const runButton = () => within(dialog).getByRole('button', { name: says('automationsPage.runDialog.run') })

    expect(runButton()).toBeDisabled()
    await expectTip(user, runButton().parentElement!, says('automationsPage.runDialog.runTipNoCustomer'))
    await expectTip(
      user,
      within(dialog).getByRole('button', { name: says('common.cancel') }),
      says('automationsPage.runDialog.cancelTip'),
    )
    await expectTip(
      user,
      within(dialog).getByRole('button', { name: says('common.close') }),
      says('automationsPage.runDialog.cancelTip'),
    )

    await pickAnna(user, dialog)
    await expectTip(user, runButton(), says('automationsPage.runDialog.runTip'))
    await expectTip(
      user,
      within(dialog).getByRole('button', { name: says('automationsPage.runDialog.change') }),
      says('automationsPage.runDialog.changeTip'),
    )

    await user.click(runButton())
    const done = await within(dialog).findByRole('button', { name: says('automationsPage.runDialog.done') })
    await expectTip(user, done, says('automationsPage.runDialog.doneTip'))
    expect(screen.getByRole('dialog')).toBe(dialog)
  })

  for (const [what, rejection] of [
    ['a request that timed out', timedOut],
    ['a proxy that gave up', gatewayTimeout],
    ['no answer at all', unreachable],
  ] as const) {
    it(`sends the operator to the run log after ${what}, offers no second run, and reads the rule again`, async () => {
      vi.mocked(runRuleManually).mockRejectedValueOnce(rejection())
      const user = userEvent.setup()
      const dialog = await openRunDialog(user)
      await pickAnna(user, dialog)
      const readsBefore = vi.mocked(getRule).mock.calls.length

      await user.click(within(dialog).getByRole('button', { name: says('automationsPage.runDialog.run') }))

      const note = await within(dialog).findByText(says('automationsPage.runDialog.noAnswer'))
      expect(note).toBeInTheDocument()
      // Never "it ran, wait for the result": after a dead connection there may
      // be no run at all, and a note promising one sends the operator to wait
      // for something that will never appear.
      expect(note.textContent).toMatch(/«Запуски»|Executions/)
      expect(note.textContent).toMatch(/мог не начаться|may not have started/)
      expect(within(dialog).queryByRole('button', { name: says('automationsPage.runDialog.run') })).toBeNull()
      expect(within(dialog).getByRole('button', { name: says('automationsPage.runDialog.done') })).toBeEnabled()
      await waitFor(() => {
        expect(vi.mocked(getRule).mock.calls.length).toBeGreaterThan(readsBefore)
      })
      expect(runRuleManually).toHaveBeenCalledTimes(1)
    })
  }

  it('finds a customer by a handle typed with its "@"', async () => {
    const user = userEvent.setup()
    const dialog = await openRunDialog(user)

    await user.type(within(dialog).getByLabelText(says('automationsPage.runDialog.customerLabel')), '@ann')

    await waitFor(() => {
      expect(searchCustomers).toHaveBeenCalledWith('ann', expect.anything())
    })
    expect(vi.mocked(searchCustomers).mock.calls.map(([term]) => term)).not.toContain('@ann')
  })

  it('says the test still runs when the rule is switched off, and says nothing when it is on', async () => {
    const user = userEvent.setup()
    const dialog = await openRunDialog(user, { ...WELCOME, isEnabled: false })
    expect(dialog).toHaveTextContent(says('automationsPage.runDialog.disabledNote'))
    cleanup()

    const onDialog = await openRunDialog(userEvent.setup(), WELCOME)
    expect(onDialog).not.toHaveTextContent(says('automationsPage.runDialog.disabledNote'))
  })

  it('names a block among the other actions, and a hint that is missing or switched off', async () => {
    vi.mocked(listUserHints).mockResolvedValue([hint({ key: 'tpl-off', titleRu: 'Выключенная', isActive: false })])
    const user = userEvent.setup()
    const dialog = await openRunDialog(
      user,
      savedRule({
        id: 'rule-mixed',
        name: 'Смешанное',
        triggerKind: 'MANUAL',
        triggerSpec: '',
        actions: [
          { type: 'show_hint', params: { hintKey: 'tpl-gone' } },
          { type: 'show_hint', params: { hintKey: 'tpl-off' } },
          { type: 'block_user', params: {} },
        ],
      }),
    )

    expect(await within(dialog).findByText(says('automationsPage.runDialog.hintMissing', { key: 'tpl-gone' }))).toBeInTheDocument()
    expect(within(dialog).getByText(says('automationsPage.runDialog.hintOff', { title: 'Выключенная' }))).toBeInTheDocument()
    expect(dialog).toHaveTextContent(
      says('automationsPage.runDialog.alsoRuns', { actions: says('automationsPage.actionTypes.block_user') }),
    )
    expect(within(dialog).getByText(says('automationsPage.runDialog.blocksCustomer'))).toBeInTheDocument()
  })
})

describe('who may run it', () => {
  it('without users:view, says the role cannot list customers and does not run', async () => {
    grant(EVERYTHING.filter((permission) => permission.resource !== 'users'))
    const user = userEvent.setup()
    const dialog = await openRunDialog(user)

    expect(within(dialog).getByText(says('automationsPage.runDialog.forbidden'))).toBeInTheDocument()
    expect(within(dialog).queryByLabelText(says('automationsPage.runDialog.customerLabel'))).toBeNull()
    const run = within(dialog).getByRole('button', { name: says('automationsPage.runDialog.run') })
    expect(run).toBeDisabled()
    await expectTip(user, run.parentElement!, says('automationsPage.runDialog.runTipForbidden'))
    expect(searchCustomers).not.toHaveBeenCalled()
  })

  it('without automations:run, the button cannot be pressed and says why on hover and on a tap', async () => {
    grant(EVERYTHING.filter((permission) => permission.action !== 'run'))
    serve(WELCOME)
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    await screen.findByRole('button', { name: says('automationsPage.editor.save') })

    const button = screen.getByRole('button', { name: says('automationsPage.editor.runNow') })
    expect(button).toBeDisabled()
    const wrapper = button.parentElement!
    await user.hover(wrapper)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(says('automationsPage.tips.runNowForbidden'))
    await user.unhover(wrapper)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())

    await user.pointer({ keys: '[TouchA]', target: wrapper })
    expect(await screen.findByRole('tooltip')).toHaveTextContent(says('automationsPage.tips.runNowForbidden'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('a rule without a hint', () => {
  afterEach(async () => {
    // Unmount first: switching the language back under a mounted page
    // re-renders it outside `act`.
    cleanup()
    await i18n.changeLanguage('en')
  })

  it('runs at once and toasts the status in the operator’s language, with the first skipped action in words', async () => {
    await i18n.changeLanguage('ru')
    await waitFor(() => expect(i18n.t('automationsPage.editor.runNow')).toBe('Запустить сейчас'))
    await waitFor(() => expect(i18n.t('common.cancel')).toBe('Отмена'))
    vi.mocked(runRuleManually).mockResolvedValue({
      executionId: 'execution-3',
      status: 'SUCCEEDED',
      actionResults: [
        { index: 0, type: 'notify_telegram', status: 'success', message: 'notify queued' },
        {
          index: 1,
          type: 'show_hint_to_audience',
          status: 'skipped',
          message: 'hint inactive',
          code: 'hint_inactive',
          details: { hintKey: 'tpl-nudge' },
        },
      ],
      errorMessage: null,
    })
    const rule = savedRule({
      id: 'rule-nudge',
      name: 'Напоминание',
      triggerKind: 'MANUAL',
      triggerSpec: '',
      actions: [
        { type: 'notify_telegram', params: { text: 'x' } },
        { type: 'show_hint_to_audience', params: { hintKey: 'tpl-nudge', audience: 'paid-not-connected' } },
      ],
    })
    serve(rule)
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    await screen.findByRole('button', { name: 'Сохранить' })

    await user.click(screen.getByRole('button', { name: 'Запустить сейчас' }))

    await waitFor(() => {
      expect(runRuleManually).toHaveBeenCalledWith('rule-nudge', {})
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith(
        'Запуск завершён: УСПЕШНО. «Показать подсказку по расписанию»: Пропущено: подсказка «tpl-nudge» выключена.',
      )
    })
  })

  it('says a run that got no answer may still be going — not that it failed — and reads the rule again', async () => {
    vi.mocked(runRuleManually).mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 408'), {
        isAxiosError: true,
        response: { status: 408, data: {} },
      }),
    )
    const rule = savedRule({
      id: 'rule-slow',
      name: 'Медленное',
      triggerKind: 'MANUAL',
      triggerSpec: '',
      actions: [{ type: 'webhook_post', params: { url: 'https://example.com/slow' } }],
    })
    serve(rule)
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    await screen.findByRole('button', { name: says('automationsPage.editor.save') })
    const readsBefore = vi.mocked(getRule).mock.calls.length

    await user.click(screen.getByRole('button', { name: says('automationsPage.editor.runNow') }))

    await waitFor(() => {
      expect(toastMock.warning).toHaveBeenCalledWith(says('automationsPage.toast.runNoAnswer'))
    })
    expect(says('automationsPage.toast.runNoAnswer')).toMatch(/мог не начаться|may not have started/)
    expect(toastMock.error).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(vi.mocked(getRule).mock.calls.length).toBeGreaterThan(readsBefore)
    })
  })
})

describe('the run log', () => {
  it('words a result from its code, and keeps the message of a result written before codes', async () => {
    serve(savedRule({ id: 'rule-log', name: 'С журналом' }))
    vi.mocked(listExecutions).mockResolvedValue({
      items: [
        {
          id: 'execution-log',
          ruleId: 'rule-log',
          status: 'SUCCEEDED',
          trigger: 'event:user.registered',
          triggerPayload: {},
          actionResults: [
            {
              index: 0,
              type: 'show_hint',
              status: 'success',
              message: 'queued hint "tpl-welcome" for cm-anna',
              code: 'hint_queued',
              details: { hintKey: 'tpl-welcome', userId: 'cm-anna' },
            },
            { index: 1, type: 'notify_telegram', status: 'success', message: 'notify queued (legacy row)' },
          ],
          errorMessage: null,
          startedAt: '2026-09-15T10:00:00.000Z',
          finishedAt: '2026-09-15T10:00:01.000Z',
          durationMs: 1000,
          createdAt: '2026-09-15T10:00:00.000Z',
        },
      ],
      nextCursor: null,
    })
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    await screen.findByRole('button', { name: says('automationsPage.editor.save') })

    await user.click(screen.getByRole('tab', { name: says('automationsPage.editor.tabs.executions') }))

    expect(
      await screen.findByText(`— ${says('automationsPage.runResults.hint_queued', { hintKey: 'tpl-welcome' })}`),
    ).toBeInTheDocument()
    expect(screen.queryByText(/queued hint "tpl-welcome" for cm-anna/)).toBeNull()
    expect(screen.getByText('— notify queued (legacy row)')).toBeInTheDocument()
  })

  /** One execution row, as the log lists it. */
  function logRow(over: Record<string, unknown>) {
    return {
      id: `execution-${String(over.status)}`,
      ruleId: 'rule-log',
      status: 'SUCCEEDED',
      trigger: 'event:user.registered',
      triggerPayload: {},
      actionResults: [],
      errorMessage: null,
      startedAt: '2026-09-15T10:00:00.000Z',
      finishedAt: '2026-09-15T10:00:01.000Z',
      durationMs: 1000,
      createdAt: '2026-09-15T10:00:00.000Z',
      ...over,
    }
  }

  async function openLog(items: ReturnType<typeof logRow>[]): Promise<void> {
    serve(savedRule({ id: 'rule-log', name: 'С журналом' }))
    vi.mocked(listExecutions).mockResolvedValue({ items: items as never, nextCursor: null })
    renderWithProviders(<AutomationsPage />)
    const user = userEvent.setup()
    await screen.findByRole('button', { name: says('automationsPage.editor.save') })
    await user.click(screen.getByRole('tab', { name: says('automationsPage.editor.tabs.executions') }))
  }

  it('words the executor’s reason for a run that reached no action', async () => {
    await openLog([logRow({ status: 'SKIPPED', errorMessage: 'conditions did not match' })])

    expect(await screen.findByText(says('automationsPage.runResults.conditionsNotMatched'))).toBeInTheDocument()
    expect(screen.queryByText('conditions did not match')).toBeNull()
  })

  it('prints no English line over failures the lines below already word, and keeps it when one has no code', async () => {
    const worded = '[show_hint] show_hint: no hint named tpl-gone'
    const unworded = '[webhook_post] 502 from https://example.com'
    await openLog([
      logRow({
        id: 'execution-worded',
        status: 'FAILED',
        errorMessage: worded,
        actionResults: [
          { index: 0, type: 'show_hint', status: 'failed', message: 'no hint named tpl-gone', code: 'hint_missing', details: { hintKey: 'tpl-gone' } },
        ],
      }),
      logRow({
        id: 'execution-unworded',
        status: 'FAILED',
        errorMessage: unworded,
        actionResults: [{ index: 0, type: 'webhook_post', status: 'failed', message: '502 from https://example.com' }],
      }),
    ])

    expect(
      await screen.findByText(`— ${says('automationsPage.runResults.hint_missing', { hintKey: 'tpl-gone' })}`),
    ).toBeInTheDocument()
    expect(screen.queryByText(worded)).toBeNull()
    // Anti-vacuity: the row without a code still says what happened.
    expect(screen.getByText(unworded)).toBeInTheDocument()
  })
})
