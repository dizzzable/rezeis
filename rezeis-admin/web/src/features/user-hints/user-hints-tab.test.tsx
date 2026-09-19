import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import { listRules, type AutomationRule } from '@/features/automations/automations-api'

import { UserHintsTab } from './user-hints-tab'
import {
  createUserHint,
  deleteUserHint,
  getHintVocabulary,
  listUserHints,
  updateUserHint,
  type UserHint,
} from './user-hints-api'

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))

vi.mock('@/features/automations/automations-api', () => ({ listRules: vi.fn() }))
vi.mock('./user-hints-api', () => ({
  listUserHints: vi.fn(),
  getHintVocabulary: vi.fn(),
  createUserHint: vi.fn(),
  updateUserHint: vi.fn(),
  deleteUserHint: vi.fn(),
}))

/**
 * The «Подсказки» tab: whom a hint reaches beside where it may appear, every
 * explanation one hover or tap away, and what each button will do.
 *
 * Sentences are looked up through the bundle, never typed out: the cases are
 * about WHERE a sentence is (visible, behind an (i), in a tooltip, in a toast),
 * and a lookup that answers with its own key fails loudly rather than building
 * a matcher for nothing.
 */
const says = (key: string, values?: Record<string, unknown>): string => {
  const sentence = String(i18n.t(key, values ?? {}))
  expect(sentence, `${key} is missing from the bundles`).not.toBe(key)
  return sentence
}

const infoIcon = (subjectKey: string): HTMLElement =>
  screen.getByRole('button', { name: says('automationsPage.infoAria', { subject: says(subjectKey) }) })

const WELCOME_HINT: UserHint = {
  id: 'hint-welcome',
  key: 'tpl-welcome',
  titleRu: 'Добро пожаловать',
  bodyRu: 'Выберите тариф',
  titleEn: null,
  bodyEn: null,
  mode: 'MODAL',
  tone: 'INFO',
  ctaKind: 'NONE',
  ctaLabelRu: null,
  ctaLabelEn: null,
  ctaTarget: null,
  // THE OWNER'S SETTING: «Браузер» ticked on the Telegram sign-up welcome.
  surfaces: ['browser'],
  formFactors: [],
  groupKey: null,
  ttlHours: 168,
  isRepeatable: false,
  isActive: true,
  createdAt: '2026-09-15T10:00:00.000Z',
  updatedAt: '2026-09-15T10:00:00.000Z',
}

const WELCOME_RULE: AutomationRule = {
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
}

async function openWelcome(user: ReturnType<typeof userEvent.setup>) {
  renderWithProviders(<UserHintsTab />)
  await user.click(await screen.findByRole('button', { name: /Добро пожаловать/ }))
  await screen.findByText('Первое появление')
}

async function openNew(user: ReturnType<typeof userEvent.setup>) {
  renderWithProviders(<UserHintsTab />)
  await user.click(await screen.findByRole('button', { name: says('userHints.new') }))
}

/** Hover a trigger and read the tooltip it opens; Escape closes it again. */
async function tooltipOf(user: ReturnType<typeof userEvent.setup>, target: Element) {
  await user.hover(target)
  const text = (await screen.findByRole('tooltip')).textContent ?? ''
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
  return text
}

describe('the hints tab', () => {
  beforeEach(async () => {
    await loadFeatureBundle('automations')
    vi.mocked(listUserHints).mockResolvedValue([WELCOME_HINT])
    vi.mocked(listRules).mockResolvedValue([WELCOME_RULE])
    vi.mocked(getHintVocabulary).mockResolvedValue({
      routes: ['/plans'],
      surfaces: ['tma', 'pwa', 'browser'],
      formFactors: ['mobile', 'tablet', 'desktop'],
      modes: ['MODAL', 'TOAST'],
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it("shows the owner's gap next to «Где показывать», and ticking «Telegram» clears it", async () => {
    const user = userEvent.setup()
    await openWelcome(user)

    const gap = () => document.querySelector('[data-notice="surface-gap"]')
    await waitFor(() => expect(gap()).not.toBeNull())
    expect(gap()?.textContent).toContain('Первое появление')

    const surfaces = screen.getByRole('group', { name: says('userHints.fields.surfaces') })
    const telegram = within(surfaces).getByRole('button', { name: says('userHints.surfaces.tma') })
    expect(telegram).toHaveAttribute('aria-pressed', 'false')
    await user.click(telegram)

    expect(telegram).toHaveAttribute('aria-pressed', 'true')
    expect(gap()).toBeNull()
  })

  it('warns, while the key is being edited, that the rules calling the saved key lose it', async () => {
    const user = userEvent.setup()
    await openWelcome(user)
    const renamed = () => document.querySelector('[data-notice="renamed"]')
    expect(renamed()).toBeNull()

    const key = screen.getByLabelText(says('userHints.fields.key'))
    await user.type(key, '-new')

    expect(renamed()?.textContent).toContain('Первое появление')
    expect(renamed()?.textContent).toContain('tpl-welcome')
  })

  it("says a new hint's key is taken instead of listing the other hint's rules", async () => {
    const user = userEvent.setup()
    await openNew(user)
    const taken = () => document.querySelector('[data-notice="key-taken"]')

    await user.type(screen.getByLabelText(says('userHints.fields.key')), 'tpl-welcome')

    await waitFor(() => expect(taken()).not.toBeNull())
    expect(taken()?.textContent).toBe(says('userHints.reach.keyTaken', { key: 'tpl-welcome' }))
    // «Первое появление» calls the OTHER hint, so it is not this draft's rule.
    expect(screen.queryByText('Первое появление')).not.toBeInTheDocument()
  })

  it('keeps the explanations behind (i)s: no grey paragraph is visible text any more', async () => {
    const user = userEvent.setup()
    await openWelcome(user)

    for (const key of [
      'userHints.intro',
      'userHints.fields.keyHint',
      'userHints.fields.ttlHint',
      'userHints.fields.surfacesHint',
      'userHints.fields.groupKeyHint',
    ]) {
      expect(screen.queryByText(says(key)), `${key} is still on screen`).not.toBeInTheDocument()
    }
  })

  it('opens an (i) on hover: the intro beside «Библиотека», the key, the surfaces', async () => {
    const user = userEvent.setup()
    await openWelcome(user)

    expect(await tooltipOf(user, infoIcon('userHints.listTitle'))).toBe(says('userHints.intro'))
    expect(await tooltipOf(user, infoIcon('userHints.fields.key'))).toBe(says('userHints.fields.keyHint'))
    expect(await tooltipOf(user, infoIcon('userHints.fields.surfaces'))).toBe(
      says('userHints.fields.surfacesHint'),
    )
    expect(await tooltipOf(user, infoIcon('userHints.fields.isActive'))).toBe(
      says('userHints.fields.isActiveHint'),
    )
  })

  it('opens an (i) on a tap too: «Можно показывать повторно» and «Группа»', async () => {
    const user = userEvent.setup()
    await openWelcome(user)

    const repeatable = infoIcon('userHints.fields.isRepeatable')
    await user.pointer({ keys: '[TouchA]', target: repeatable })
    expect((await screen.findByRole('tooltip')).textContent).toBe(
      says('userHints.fields.isRepeatableHint'),
    )
    await user.pointer({ keys: '[TouchA]', target: repeatable })
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())

    await user.pointer({ keys: '[TouchA]', target: infoIcon('userHints.fields.groupKey') })
    expect((await screen.findByRole('tooltip')).textContent).toBe(says('userHints.fields.groupKeyHint'))
  })

  it('puts an (i) on every field', async () => {
    const user = userEvent.setup()
    // The label and destination fields appear only when there is a button.
    vi.mocked(listUserHints).mockResolvedValue([
      { ...WELCOME_HINT, ctaKind: 'ROUTE', ctaLabelRu: 'К тарифам', ctaTarget: '/plans' },
    ])
    await openWelcome(user)

    for (const subject of [
      'userHints.listTitle',
      'userHints.fields.key',
      'userHints.fields.titleRu',
      'userHints.fields.titleEn',
      'userHints.fields.bodyRu',
      'userHints.fields.bodyEn',
      'userHints.fields.tone',
      'userHints.fields.ttlHours',
      'userHints.fields.ctaKind',
      'userHints.fields.ctaLabelRu',
      'userHints.fields.ctaTarget',
      'userHints.fields.surfaces',
      'userHints.fields.formFactors',
      'userHints.fields.groupKey',
      'userHints.fields.isActive',
      'userHints.fields.isRepeatable',
      'userHints.reach.title',
    ]) {
      expect(infoIcon(subject), `${subject} has no (i)`).toBeInTheDocument()
    }
  })

  it('offers samples, not values, as placeholders', async () => {
    const user = userEvent.setup()
    await openNew(user)

    const key = screen.getByLabelText(says('userHints.fields.key'))
    const group = screen.getByLabelText(says('userHints.fields.groupKey'))
    expect(key).toHaveAttribute('placeholder', says('userHints.fields.keyPlaceholder'))
    expect(group).toHaveAttribute('placeholder', says('userHints.fields.groupKeyPlaceholder'))
    // What an operator read as a filled-in field.
    expect(key.getAttribute('placeholder')).not.toBe('subscription-ready')
    expect(group.getAttribute('placeholder')).not.toBe('purchase')
  })

  it('labels the row of device buttons', async () => {
    const user = userEvent.setup()
    await openNew(user)

    expect(screen.getByText(says('userHints.fields.formFactors'))).toBeInTheDocument()
    const devices = screen.getByRole('group', { name: says('userHints.fields.formFactors') })
    expect(within(devices).getAllByRole('button').map((button) => button.textContent)).toEqual([
      says('userHints.formFactors.mobile'),
      says('userHints.formFactors.tablet'),
      says('userHints.formFactors.desktop'),
    ])
  })

  it('shows the server refusal translated and whole when saving fails', async () => {
    const user = userEvent.setup()
    // A validation refusal is ONE LINE PER FIELD. The old handler read only a
    // string, so this array became a bare "could not save".
    vi.mocked(createUserHint).mockRejectedValue({
      isAxiosError: true,
      message: 'Request failed with status code 400',
      response: {
        status: 400,
        data: { message: ['key must be lower-case letters, digits and hyphens', 'titleRu must not be empty'] },
      },
    })
    await openNew(user)
    await user.click(screen.getByRole('button', { name: says('userHints.save') }))

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1))
    expect(toastMock.error).toHaveBeenCalledWith(
      says('userHints.saveFailed', {
        message: 'key must be lower-case letters, digits and hyphens titleRu must not be empty',
      }),
    )
  })

  it('says the server could not be reached, in the operator\'s words, rather than a raw transport error', async () => {
    const user = userEvent.setup()
    vi.mocked(createUserHint).mockRejectedValue({
      isAxiosError: true,
      code: 'ERR_NETWORK',
      message: 'Network Error',
    })
    await openNew(user)
    await user.click(screen.getByRole('button', { name: says('userHints.save') }))

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1))
    expect(toastMock.error).toHaveBeenCalledWith(
      says('userHints.saveFailed', { message: says('errors.serverUnreachable') }),
    )
  })

  it.each([
    [
      'the server refused it',
      {
        isAxiosError: true,
        message: 'Request failed with status code 404',
        response: { status: 404, data: { message: 'Hint not found' } },
      },
      (): string => 'Hint not found',
    ],
    [
      'the server did not answer in time',
      { isAxiosError: true, code: 'ECONNABORTED', message: 'timeout of 30000ms exceeded' },
      (): string => says('errors.serverTimeout'),
    ],
  ])('says why a delete failed when %s', async (_label, rejection, reason) => {
    const user = userEvent.setup()
    // The old handler showed a bare "could not delete" for every one of these.
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.mocked(deleteUserHint).mockRejectedValue(rejection)
    try {
      await openWelcome(user)
      await user.click(screen.getByRole('button', { name: says('userHints.delete') }))

      await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1))
      expect(deleteUserHint).toHaveBeenCalledWith(WELCOME_HINT.id)
      expect(toastMock.error).toHaveBeenCalledWith(
        says('userHints.deleteFailed', { message: reason() }),
      )
    } finally {
      confirm.mockRestore()
    }
  })

  it('says on hover what every button will do', async () => {
    const user = userEvent.setup()
    await openWelcome(user)

    expect(await tooltipOf(user, screen.getByRole('button', { name: says('userHints.new') }))).toBe(
      says('userHints.tips.new'),
    )
    expect(await tooltipOf(user, screen.getByRole('button', { name: says('userHints.save') }))).toBe(
      says('userHints.tips.saveExisting'),
    )
    expect(await tooltipOf(user, screen.getByRole('button', { name: says('userHints.cancel') }))).toBe(
      says('userHints.tips.cancel'),
    )
    expect(await tooltipOf(user, screen.getByRole('button', { name: says('userHints.delete') }))).toBe(
      says('userHints.tips.delete'),
    )

    // A toggle says what THIS press does, so its sentence follows its state.
    const surfaces = screen.getByRole('group', { name: says('userHints.fields.surfaces') })
    const browser = within(surfaces).getByRole('button', { name: says('userHints.surfaces.browser') })
    const telegram = within(surfaces).getByRole('button', { name: says('userHints.surfaces.tma') })
    expect(await tooltipOf(user, browser)).toBe(
      says('userHints.tips.surfaceOn', { name: says('userHints.surfaces.browser') }),
    )
    expect(await tooltipOf(user, telegram)).toBe(
      says('userHints.tips.surfaceOff', { name: says('userHints.surfaces.tma') }),
    )
    const devices = screen.getByRole('group', { name: says('userHints.fields.formFactors') })
    const phone = within(devices).getByRole('button', { name: says('userHints.formFactors.mobile') })
    expect(await tooltipOf(user, phone)).toBe(
      says('userHints.tips.formFactorOff', { name: says('userHints.formFactors.mobile') }),
    )
  })

  it('names the connect door in words, and never shows the raw "@connect"', async () => {
    // `@connect` is not a path the operator could recognise: it is the door the
    // cabinet opens like its own «Подключить» button. The vocabulary serves it
    // among the routes; the form names it.
    const door: UserHint = {
      ...WELCOME_HINT,
      id: 'hint-door',
      key: 'tpl-connect-help',
      titleRu: 'Не получилось подключиться?',
      ctaKind: 'ROUTE',
      ctaLabelRu: 'Подключить',
      ctaTarget: '@connect',
      surfaces: [],
    }
    vi.mocked(listUserHints).mockResolvedValue([door])
    vi.mocked(getHintVocabulary).mockResolvedValue({
      routes: ['/plans', '@connect', '@teleport'],
      surfaces: ['tma', 'pwa', 'browser'],
      formFactors: ['mobile', 'tablet', 'desktop'],
      modes: ['MODAL', 'TOAST'],
    })
    const user = userEvent.setup()
    renderWithProviders(<UserHintsTab />)
    await user.click(await screen.findByRole('button', { name: /Не получилось подключиться/ }))

    const target = await screen.findByLabelText(says('userHints.fields.ctaTarget'))
    await waitFor(() => expect(target).toHaveTextContent(says('userHints.doors.connect')))
    expect(target).not.toHaveTextContent('@connect')

    await user.click(target)
    const options = (await screen.findAllByRole('option')).map((option) => option.textContent)
    // A door this panel has no name for still gets words, not its string.
    expect(options).toEqual(['/plans', says('userHints.doors.connect'), says('userHints.doors.unknown')])
  })

  it('says a new hint is only created by «Сохранить», and keeps that tooltip while it saves', async () => {
    const user = userEvent.setup()
    vi.mocked(createUserHint).mockReturnValue(new Promise(() => undefined))
    await openNew(user)

    const save = screen.getByRole('button', { name: says('userHints.save') })
    expect(await tooltipOf(user, save)).toBe(says('userHints.tips.saveNew'))

    await user.click(save)
    // Re-queried: wrapping the disabled button mounts a new element.
    const saving = await waitFor(() => {
      const button = screen.getByRole('button', { name: says('userHints.save') })
      expect(button).toBeDisabled()
      return button
    })
    // A disabled button takes neither hover nor focus; the wrapper takes both.
    // Reached by keyboard focus here: the pointer is still parked where the
    // press happened, and Radix opens on a pointer ENTERING, which it did before.
    const wrapper = saving.parentElement!
    expect(wrapper.tagName).toBe('SPAN')
    expect(wrapper).toHaveAttribute('tabindex', '0')
    act(() => wrapper.focus())
    expect((await screen.findByRole('tooltip')).textContent).toBe(says('userHints.tips.saveNew'))
    expect(updateUserHint).not.toHaveBeenCalled()
    expect(deleteUserHint).not.toHaveBeenCalled()
  })
})
