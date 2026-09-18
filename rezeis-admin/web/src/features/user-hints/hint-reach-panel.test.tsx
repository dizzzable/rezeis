import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import { listRules, type AutomationRule } from '@/features/automations/automations-api'

import { HintReachPanel } from './hint-reach-panel'

vi.mock('@/features/automations/automations-api', () => ({ listRules: vi.fn() }))

/**
 * «Кто увидит», against the rules and the draft.
 *
 * Every warning here is computed, so every case is a pair: the data that puts
 * the sentence on screen, and the one change that takes it away. A warning that
 * cannot disappear is decoration, and one that cannot appear guards nothing.
 *
 * Sentences are looked up through the bundle rather than typed out, so a copy
 * edit does not turn these red, and a renamed key does — `says` refuses a
 * lookup that answers with its own key.
 */
const says = (key: string, values?: Record<string, unknown>): string => {
  const sentence = String(i18n.t(key, values ?? {}))
  expect(sentence, `${key} is missing from the automations bundle`).not.toBe(key)
  return sentence
}

const quoted = (value: string): string => says('userHints.reach.quoted', { value })

function rule(over: Partial<AutomationRule>): AutomationRule {
  return {
    id: 'rule-welcome',
    name: 'Первое появление',
    description: null,
    isEnabled: true,
    triggerKind: 'REALTIME',
    triggerSpec: 'user.registered',
    conditions: null,
    actions: [{ type: 'show_hint', params: { hintKey: 'tpl-welcome' } }],
    createdById: null,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunMessage: null,
    runCount: 0,
    createdAt: '2026-09-15T10:00:00.000Z',
    updatedAt: '2026-09-15T10:00:00.000Z',
    ...over,
  }
}

interface Draft {
  readonly draftKey: string
  readonly savedKey: string | null
  readonly otherKeys: readonly string[]
  readonly surfaces: readonly string[]
  readonly isActive: boolean
  readonly ttlHours: number
}

const WELCOME: Draft = {
  draftKey: 'tpl-welcome',
  savedKey: 'tpl-welcome',
  otherKeys: [],
  surfaces: [],
  isActive: true,
  ttlHours: 168,
}

function renderPanel(draft: Draft) {
  const view = renderWithProviders(<HintReachPanel {...draft} />)
  return {
    ...view,
    update: (next: Draft) => view.rerender(<HintReachPanel {...next} />),
  }
}

/** The notice of one kind, or null. */
const notice = (kind: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-notice="${kind}"]`)

/** Resolves once the rules have been read (or refused). */
const settled = () =>
  waitFor(() => expect(screen.queryByText(says('userHints.reach.loading'))).not.toBeInTheDocument())

describe('«Кто увидит»', () => {
  beforeEach(async () => {
    await loadFeatureBundle('automations')
    vi.mocked(listRules).mockResolvedValue([rule({})])
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it("warns about the owner's welcome: a Telegram sign-up rule, and only the browser ticked", async () => {
    const { update } = renderPanel({ ...WELCOME, surfaces: ['browser'] })
    await settled()

    const gap = await waitFor(() => {
      const found = notice('surface-gap')
      expect(found).not.toBeNull()
      return found!
    })
    // Every part the operator needs, in one sentence: which rule, whom it
    // greets, where they are, what is ticked, and what happens to the window.
    expect(gap.textContent).toContain(
      says('userHints.reach.gap', {
        rule: 'Первое появление',
        event: says('automationsPage.popupEvents.user_registered'),
        home: quoted(says('userHints.surfaces.tma')),
        ticked: quoted(says('userHints.surfaces.browser')),
      }),
    )
    expect(gap.textContent).toContain(
      says('userHints.reach.gapLapse', { hours: says('userHints.reach.hours', { count: 168 }) }),
    )

    // Ticking the place those customers are in takes it away.
    update({ ...WELCOME, surfaces: ['browser', 'tma'] })
    expect(notice('surface-gap')).toBeNull()
  })

  it('does not warn a site sign-up rule limited to the browser, and does warn it limited to Telegram', async () => {
    vi.mocked(listRules).mockResolvedValue([rule({ triggerSpec: 'user.web_registered' })])
    const { update } = renderPanel({ ...WELCOME, surfaces: ['browser'] })
    await settled()
    await screen.findByText(says('automationsPage.popupEvents.user_web_registered'))
    expect(notice('surface-gap')).toBeNull()

    update({ ...WELCOME, surfaces: ['tma'] })
    expect(notice('surface-gap')?.textContent).toContain(
      quoted(says('userHints.surfaces.browser')),
    )
  })

  it('says the lifetime without a number when the field holds none', async () => {
    renderPanel({ ...WELCOME, surfaces: ['browser'], ttlHours: 0 })
    await settled()
    await waitFor(() => expect(notice('surface-gap')).not.toBeNull())

    expect(notice('surface-gap')?.textContent).toContain(says('userHints.reach.gapLapseUnknown'))
  })

  it('lists every rule that calls the hint: its name, on or off, and whom', async () => {
    vi.mocked(listRules).mockResolvedValue([
      rule({ id: 'a', name: 'Telegram-приветствие' }),
      rule({ id: 'b', name: 'Сайт', isEnabled: false, triggerSpec: 'user.web_registered' }),
      rule({ id: 'c', name: 'Всё про оплату', triggerSpec: 'payment.*' }),
      rule({ id: 'd', name: 'Своё событие', triggerSpec: 'custom.thing_happened' }),
      rule({ id: 'e', name: 'Вручную одному', triggerKind: 'MANUAL', triggerSpec: '' }),
      rule({
        id: 'f',
        name: 'Ночная рассылка',
        triggerKind: 'CRON',
        triggerSpec: '0 9 * * *',
        actions: [
          { type: 'show_hint_to_audience', params: { hintKey: 'tpl-welcome', audience: 'paid-not-connected' } },
        ],
      }),
      rule({
        id: 'g',
        name: 'Аудитория вручную',
        triggerKind: 'MANUAL',
        triggerSpec: '',
        actions: [
          { type: 'show_hint_to_audience', params: { hintKey: 'tpl-welcome', audience: 'paid-not-connected' } },
        ],
      }),
      rule({ id: 'h', name: 'Старое расписание', triggerKind: 'CRON', triggerSpec: '0 3 * * *' }),
      rule({
        id: 'i',
        name: 'Старая аудитория на событии',
        actions: [{ type: 'show_hint_to_audience', params: { hintKey: 'tpl-welcome' } }],
      }),
      rule({ id: 'z', name: 'Чужое', actions: [{ type: 'show_hint', params: { hintKey: 'other' } }] }),
    ])
    renderPanel(WELCOME)
    await settled()

    const line = (name: string): string => {
      const item = screen.getByText(name).closest('li')
      expect(item, `${name} has no line`).not.toBeNull()
      return item!.textContent ?? ''
    }
    await screen.findByText('Telegram-приветствие')

    expect(line('Telegram-приветствие')).toContain(says('userHints.reach.enabled'))
    expect(line('Telegram-приветствие')).toContain(says('automationsPage.popupEvents.user_registered'))
    expect(line('Сайт')).toContain(says('userHints.reach.disabled'))
    expect(line('Сайт')).toContain(says('automationsPage.popupEvents.user_web_registered'))
    expect(line('Всё про оплату')).toContain(says('userHints.reach.whomWildcard', { pattern: 'payment.*' }))
    // An event the panel has not checked: the raw type inside the "not checked"
    // sentence, never a key path, and never the words of a working line.
    expect(line('Своё событие')).toContain(
      says('userHints.reach.whomUnverified', { event: 'custom.thing_happened' }),
    )
    expect(line('Своё событие')).not.toContain('automationsPage.')
    expect(line('Вручную одному')).toContain(says('userHints.reach.whomManual'))
    const audience = says('automationsPage.audiences.paid-not-connected')
    expect(line('Ночная рассылка')).toContain(
      says('userHints.reach.whomAudienceSchedule', { audience }),
    )
    expect(line('Аудитория вручную')).toContain(says('userHints.reach.whomAudienceManual', { audience }))
    expect(line('Старое расписание')).toContain(says('userHints.reach.whomScheduleNamesNobody'))
    expect(line('Старая аудитория на событии')).toContain(says('userHints.reach.whomAudienceOnEvent'))
    // Three kinds of line: failing for certain, unchecked, and working (unmarked).
    const status = (name: string) => screen.getByText(name).closest('li')?.getAttribute('data-status')
    expect(status('Своё событие')).toBe('unverified')
    for (const name of ['Старое расписание', 'Старая аудитория на событии']) {
      expect(status(name), name).toBe('failing')
    }
    for (const name of ['Telegram-приветствие', 'Всё про оплату', 'Вручную одному', 'Ночная рассылка']) {
      expect(status(name), name).toBeNull()
    }
    // The unchecked marker — the element whose whole text is «не проверено», not
    // the same words inside a longer sentence — belongs to the unchecked line only.
    const marker = (name: string) =>
      within(screen.getByText(name).closest('li')!).queryByText(says('userHints.reach.notChecked'))
    expect(marker('Своё событие')).toBeInTheDocument()
    expect(marker('Старое расписание')).not.toBeInTheDocument()
    expect(marker('Telegram-приветствие')).not.toBeInTheDocument()
    // A rule calling another hint is not listed.
    expect(screen.queryByText('Чужое')).not.toBeInTheDocument()
    expect(notice('no-rule')).toBeNull()
  })

  it('warns that no rule calls the hint, and stops once one does', async () => {
    vi.mocked(listRules).mockResolvedValue([])
    const first = renderPanel(WELCOME)
    await settled()
    await waitFor(() => expect(notice('no-rule')).not.toBeNull())
    expect(notice('no-rule')?.textContent).toBe(says('userHints.reach.noRule'))
    first.unmount()

    vi.mocked(listRules).mockResolvedValue([rule({})])
    renderPanel(WELCOME)
    await screen.findByText('Первое появление')
    expect(notice('no-rule')).toBeNull()
  })

  it.each([
    ['user.expire_soon', 'a pre-fix template trigger'],
    ['subscription.expired', 'a pre-fix template trigger'],
    ['user.bandwidth_usage_threshold_reached', 'a pre-fix template trigger'],
    ['support.ticket_created', 'an unlisted event that names a customer'],
    ['payment*', 'a star the grammar reads as an exact string'],
  ])('lists a rule on %s (%s) as unchecked, and says only what is known', async (triggerSpec) => {
    // The panel cannot tell a rule on an event nothing sends from one on an
    // unlisted event that works. So: not counted as working, and no sentence
    // saying customers will not see it — «ни одно из них её не покажет» about a
    // working pop-up got it deleted.
    vi.mocked(listRules).mockResolvedValue([rule({ name: 'Старый шаблон', triggerSpec })])
    const first = renderPanel(WELCOME)
    await screen.findByText('Старый шаблон')

    const item = screen.getByText('Старый шаблон').closest('li')
    expect(item?.getAttribute('data-status')).toBe('unverified')
    expect(item?.textContent).toContain(says('userHints.reach.whomUnverified', { event: triggerSpec }))
    expect(notice('only-unverified')?.textContent).toBe(says('userHints.reach.onlyUnverified'))
    expect(notice('no-working-rule')).toBeNull()
    expect(notice('no-rule')).toBeNull()
    first.unmount()

    // A working rule beside it takes the sentence away.
    vi.mocked(listRules).mockResolvedValue([
      rule({ name: 'Старый шаблон', triggerSpec }),
      rule({ id: 'rule-2', name: 'Рабочее правило' }),
    ])
    renderPanel(WELCOME)
    await screen.findByText('Рабочее правило')
    expect(notice('only-unverified')).toBeNull()
  })

  it('says only-unchecked, not none-will-show, when an unchecked rule sits beside certain failures', async () => {
    vi.mocked(listRules).mockResolvedValue([
      rule({ name: 'Непроверенное событие', triggerSpec: 'partner.activated' }),
      rule({ id: 'rule-cron', name: 'Старое расписание', triggerKind: 'CRON', triggerSpec: '0 3 * * *' }),
    ])
    renderPanel(WELCOME)
    await screen.findByText('Старое расписание')

    expect(notice('only-unverified')).not.toBeNull()
    expect(notice('no-working-rule')).toBeNull()
  })

  it('keeps «none of them will show it» for rules that certainly fail', async () => {
    vi.mocked(listRules).mockResolvedValue([
      rule({ id: 'rule-cron', name: 'Старое расписание', triggerKind: 'CRON', triggerSpec: '0 3 * * *' }),
    ])
    renderPanel(WELCOME)
    await screen.findByText('Старое расписание')

    expect(notice('no-working-rule')?.textContent).toBe(says('userHints.reach.noWorkingRule'))
    expect(notice('only-unverified')).toBeNull()
  })

  it.each([
    ['no audience', {}],
    ['an audience the panel does not know', { audience: 'everyone' }],
  ])('does not count an audience action with %s as showing the hint', async (_label, extra) => {
    // Every run fails with "requires `audience`".
    vi.mocked(listRules).mockResolvedValue([
      rule({
        name: 'Рассылка без аудитории',
        triggerKind: 'CRON',
        triggerSpec: '0 9 * * *',
        actions: [{ type: 'show_hint_to_audience', params: { hintKey: 'tpl-welcome', ...extra } }],
      }),
    ])
    renderPanel(WELCOME)
    await screen.findByText('Рассылка без аудитории')

    const line = screen.getByText('Рассылка без аудитории').closest('li')
    expect(line?.textContent).toContain(says('userHints.reach.whomAudienceInvalid'))
    expect(line?.getAttribute('data-status')).toBe('failing')
    expect(notice('no-working-rule')).not.toBeNull()
  })

  it("says the key belongs to another hint instead of borrowing that hint's rules and gaps", async () => {
    // A new draft typed onto an existing key: the welcome rule and its surface
    // gap belong to the OTHER hint, and saving answers 409.
    const { update } = renderPanel({
      ...WELCOME,
      draftKey: 'tpl-welcome',
      savedKey: null,
      otherKeys: ['tpl-welcome', 'other-hint'],
      surfaces: ['browser'],
    })
    await settled()

    expect(notice('key-taken')?.textContent).toBe(says('userHints.reach.keyTaken', { key: 'tpl-welcome' }))
    expect(screen.queryByText('Первое появление')).not.toBeInTheDocument()
    expect(notice('surface-gap')).toBeNull()
    expect(notice('no-rule')).toBeNull()

    update({ ...WELCOME, draftKey: 'tpl-welcome-2', savedKey: null, otherKeys: ['tpl-welcome'], surfaces: ['browser'] })
    expect(notice('key-taken')).toBeNull()
  })

  it('warns a rename away from a rule on an unchecked event, which may be working', async () => {
    vi.mocked(listRules).mockResolvedValue([
      rule({ name: 'Обращение в поддержку', triggerSpec: 'support.ticket_created' }),
    ])
    const { update } = renderPanel(WELCOME)
    await screen.findByText('Обращение в поддержку')

    update({ ...WELCOME, draftKey: 'tpl-welcome-new' })
    expect(notice('renamed')?.textContent).toContain('Обращение в поддержку')
  })

  it('does not warn a rename away from rules that certainly fail', async () => {
    // They fail the same way whatever the key is called.
    vi.mocked(listRules).mockResolvedValue([
      rule({ name: 'Старое расписание', triggerKind: 'CRON', triggerSpec: '0 3 * * *' }),
    ])
    const { update } = renderPanel(WELCOME)
    await screen.findByText('Старое расписание')

    update({ ...WELCOME, draftKey: 'tpl-welcome-new' })
    expect(notice('renamed')).toBeNull()
  })

  it("says the cabinet shows its own moment, and never that no rule shows it", async () => {
    vi.mocked(listRules).mockResolvedValue([])
    renderPanel({ ...WELCOME, draftKey: 'subscription-ready', savedKey: 'subscription-ready' })
    await settled()

    await waitFor(() => expect(notice('client-moment')).not.toBeNull())
    expect(notice('client-moment')?.textContent).toBe(says('userHints.reach.clientMoment'))
    expect(notice('no-rule')).toBeNull()
  })

  it('says only that the rules could not be read when they cannot be', async () => {
    vi.mocked(listRules).mockRejectedValue(new Error('403'))
    renderPanel({ ...WELCOME, surfaces: ['browser'] })

    await waitFor(() => expect(notice('rules-unreadable')).not.toBeNull())
    expect(notice('rules-unreadable')?.textContent).toBe(says('userHints.reach.unreadable'))
    // Never a guess dressed as a finding.
    expect(notice('no-rule')).toBeNull()
    expect(notice('surface-gap')).toBeNull()
  })

  it('warns that renaming the key unbinds the rules that call the old one', async () => {
    const { update } = renderPanel(WELCOME)
    await screen.findByText('Первое появление')
    expect(notice('renamed')).toBeNull()

    update({ ...WELCOME, draftKey: 'tpl-welcome-new' })
    expect(notice('renamed')?.textContent).toBe(
      says('userHints.reach.renamed', { key: 'tpl-welcome', rules: quoted('Первое появление') }),
    )

    // A new hint has no old key to lose.
    update({ ...WELCOME, draftKey: 'tpl-welcome-new', savedKey: null })
    expect(notice('renamed')).toBeNull()
  })

  it("warns that renaming the cabinet's own moment unbinds it from the cabinet", async () => {
    vi.mocked(listRules).mockResolvedValue([])
    const { update } = renderPanel({
      ...WELCOME,
      draftKey: 'subscription-ready',
      savedKey: 'subscription-ready',
    })
    await settled()
    expect(notice('renamed-client-moment')).toBeNull()

    update({ ...WELCOME, draftKey: 'subscription-ready-2', savedKey: 'subscription-ready' })
    expect(notice('renamed-client-moment')?.textContent).toBe(
      says('userHints.reach.renamedClientMoment', { key: 'subscription-ready' }),
    )
  })

  it('warns that a switched-off hint queues nothing, and stops when it is on', async () => {
    const { update } = renderPanel({ ...WELCOME, isActive: false })
    await settled()
    expect(notice('inactive')?.textContent).toBe(says('userHints.reach.inactive'))

    update(WELCOME)
    expect(notice('inactive')).toBeNull()
  })

  it('asks for a key before it looks for rules', async () => {
    vi.mocked(listRules).mockResolvedValue([])
    renderPanel({ ...WELCOME, draftKey: '', savedKey: null })
    await settled()

    expect(notice('blank-key')?.textContent).toBe(says('userHints.reach.blankKey'))
    expect(notice('no-rule')).toBeNull()
  })

  it('says it is reading the rules while it is', async () => {
    vi.mocked(listRules).mockReturnValue(new Promise(() => undefined))
    renderPanel(WELCOME)

    expect(await screen.findByText(says('userHints.reach.loading'))).toBeInTheDocument()
    expect(notice('no-rule')).toBeNull()
  })

  it('keeps the difference between «Кто увидит» and «Где показывать» behind its (i)', async () => {
    const user = userEvent.setup()
    renderPanel(WELCOME)
    await screen.findByText('Первое появление')

    expect(screen.queryByText(says('userHints.reach.info'))).not.toBeInTheDocument()
    await user.hover(
      screen.getByRole('button', {
        name: says('automationsPage.infoAria', { subject: says('userHints.reach.title') }),
      }),
    )
    expect((await screen.findByRole('tooltip')).textContent).toBe(says('userHints.reach.info'))
  })
})
