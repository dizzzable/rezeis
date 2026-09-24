/**
 * A notification's and a screen's button targets, as their forms take them.
 *
 * The main menu's forms said why a target could not be saved and kept it from
 * being saved (`menuButtonTargetProblem`). A notification's buttons and a
 * screen's saved anything, and «Карта бота» then drew the button red: a «Mini
 * App» address in a notification — the bot opens it as `<miniApp>/https://…`, a
 * page the cabinet does not have — or a screen's `http://` link, which the bot
 * leaves out. Both forms now ask the same rule where they are read
 * (`buttonTargetProblem`), show the same words under the field, and do not
 * save until it is fixed; the server refuses the same.
 *
 * A button saved before with such a target loads as it was, and its form says
 * why and holds its Save until it is fixed — the rest of the template or of
 * the button saves as before.
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { ScreenEditorPanel } from '@/features/bot-flow/components/ScreenEditorPanel'
import type { BotFlowButton, BotFlowScreen } from '@/features/bot-flow/types'
import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

import * as botMapApi from '../bot-map-api'
import type { BotMapPayload, MiniAppScreen, NotificationButtonShape, NotificationMapNode } from '../types'
import { NotificationEditor } from './inspector/NotificationEditor'

vi.mock('../bot-map-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bot-map-api')>()),
  fetchBotMap: vi.fn(),
  patchNotificationTemplate: vi.fn(),
}))

const fetchBotMap = vi.mocked(botMapApi.fetchBotMap)
const patchNotificationTemplate = vi.mocked(botMapApi.patchNotificationTemplate)

const SCREENS: ReadonlyArray<MiniAppScreen> = [
  { route: '/plans', nameRu: 'Тарифы', nameEn: 'Plans', descriptionRu: '', descriptionEn: '' },
  { route: '/referrals', nameRu: 'Реферальная программа', nameEn: 'Referral program', descriptionRu: '', descriptionEn: '' },
]

const payload: BotMapPayload = {
  nodes: [],
  edges: [],
  miniAppScreens: SCREENS,
  meta: { flowStatus: 'NONE', composedAt: '2026-09-24T00:00:00.000Z' },
}

/** The words each reason is shown with — read from the dictionaries, not restated. */
const reason = (name: string) => String(i18n.t(`botConfigPage.buttons.fields.actionTarget.problems.${name}`))

beforeAll(async () => {
  await i18nReady
  await i18n.changeLanguage('ru')
  await loadFeatureBundle('botMap')
})

beforeEach(() => {
  fetchBotMap.mockReset()
  fetchBotMap.mockResolvedValue(payload)
  patchNotificationTemplate.mockReset()
  patchNotificationTemplate.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the reasons', () => {
  it('have words in both languages, the three new ones in the map’s bundle beside the main menu’s six', async () => {
    try {
      for (const language of ['ru', 'en']) {
        await i18n.changeLanguage(language)
        // As the route loads it: the bundle of the language shown.
        await loadFeatureBundle('botMap')
        for (const name of [
          'notAPage',
          'badCharacters',
          'notAnAddress',
          'webAppNeedsHttps',
          'upperCaseScheme',
          'localAddress',
          'linkNeedsHttps',
          'pageOnly',
          'addressOnly',
        ]) {
          const key = `botConfigPage.buttons.fields.actionTarget.problems.${name}`
          expect(i18n.exists(key, { lng: language }), `${language}: ${key}`).toBe(true)
        }
      }
    } finally {
      await i18n.changeLanguage('ru')
    }
  })
})

// ── A notification's buttons ─────────────────────────────────────────────────

function notification(buttons: ReadonlyArray<NotificationButtonShape>): NotificationMapNode {
  return {
    id: 'notif:trial_ended',
    kind: 'notification',
    title: 'Пробный период закончился',
    group: 'notification:other',
    templateId: 'tpl-trial-ended',
    type: 'trial_ended',
    category: 'other',
    titleRu: 'Пробный период закончился',
    titleEn: null,
    bodyRu: 'Оформите подписку',
    bodyEn: null,
    bannerUrl: null,
    buttons,
    isActive: true,
  }
}

const saveTemplate = () => screen.getByRole('button', { name: /Сохранить шаблон/ })

describe('a notification’s buttons', () => {
  it('open a saved Mini App address as it was, say why, and hold «Сохранить шаблон» until it is a page', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <NotificationEditor
        node={notification([
          { labelRu: 'Оформить', labelEn: null, kind: 'webApp', target: 'https://example.com/app', row: 0 },
          { labelRu: 'Меню', labelEn: null, kind: 'callback', target: 'menu:main', row: 1 },
        ])}
      />,
    )
    expect(await screen.findByText(reason('pageOnly'))).toHaveAttribute('role', 'alert')
    expect(screen.getByDisplayValue('https://example.com/app')).toBeInTheDocument()

    // Another button's caption edited: the list is changed, and still not saved.
    await user.type(screen.getByDisplayValue('Меню'), '!')
    expect(saveTemplate()).toBeDisabled()

    // A page picked instead: the reason is gone, and the list saves.
    await user.click(await screen.findByRole('combobox', { name: 'Экран мини-приложения' }))
    await user.click(await screen.findByRole('option', { name: /Тарифы/ }))
    expect(screen.queryByText(reason('pageOnly'))).toBeNull()
    expect(saveTemplate()).toBeEnabled()
    await user.click(saveTemplate())
    await waitFor(() => expect(patchNotificationTemplate).toHaveBeenCalled())
    expect(patchNotificationTemplate.mock.calls[0][1].buttons?.[0]).toMatchObject({ kind: 'webApp', target: '/plans' })
  })

  it('take a «Mini App» page saved without its slash as the page the bot opens: no reason, and the list saves', async () => {
    // Typed by hand before the page picker; the bot gives `renew` its slash
    // and the map draws it green, so it must not hold the other buttons back.
    const user = userEvent.setup()
    renderWithProviders(
      <NotificationEditor
        node={notification([
          { labelRu: 'Продлить', labelEn: null, kind: 'webApp', target: 'renew', row: 0 },
          { labelRu: 'Меню', labelEn: null, kind: 'callback', target: 'menu:main', row: 1 },
        ])}
      />,
    )
    expect(await screen.findByDisplayValue('renew')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    await user.type(screen.getByDisplayValue('Меню'), '!')
    expect(saveTemplate()).toBeEnabled()
    await user.click(saveTemplate())
    await waitFor(() => expect(patchNotificationTemplate).toHaveBeenCalled())
    expect(patchNotificationTemplate.mock.calls[0][1].buttons?.[0]).toMatchObject({ kind: 'webApp', target: 'renew' })
  })

  it('say why a «URL» button takes an https address and nothing else', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <NotificationEditor node={notification([{ labelRu: 'Сайт', labelEn: null, kind: 'url', target: '', row: 0 }])} />,
    )
    const box = screen.getByPlaceholderText('Абсолютный HTTPS URL')
    for (const [typed, name] of [
      ['/plans', 'addressOnly'],
      ['http://example.com/a', 'linkNeedsHttps'],
      ['HTTPS://example.com/a', 'upperCaseScheme'],
      ['https://localhost:5173/', 'localAddress'],
    ] as const) {
      await user.clear(box)
      await user.type(box, typed)
      expect(screen.getByText(reason(name)), typed).toBeInTheDocument()
      expect(box).toHaveAttribute('aria-invalid', 'true')
      expect(saveTemplate()).toBeDisabled()
    }
    await user.clear(box)
    await user.type(box, 'https://example.com/a')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(saveTemplate()).toBeEnabled()
  })

  it('leave a callback’s target to the bot', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <NotificationEditor node={notification([{ labelRu: 'Меню', labelEn: null, kind: 'callback', target: '', row: 0 }])} />,
    )
    await user.type(screen.getByPlaceholderText('callback_data (например, menu:main)'), 'https://not-a-callback')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(saveTemplate()).toBeEnabled()
  })

  it('keep the rest of the template saving while a button is refused', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <NotificationEditor
        node={notification([{ labelRu: 'Оформить', labelEn: null, kind: 'webApp', target: 'https://example.com/app', row: 0 }])}
      />,
    )
    await user.click(screen.getByRole('switch'))
    await waitFor(() => expect(patchNotificationTemplate).toHaveBeenCalledWith('tpl-trial-ended', { isActive: false }))
  })

  it('show the server’s own reason when it refuses anyway', async () => {
    const user = userEvent.setup()
    const error = vi.spyOn(toast, 'error')
    patchNotificationTemplate.mockRejectedValue({
      response: { data: { message: 'buttons.0.target must be a whole address starting with https:// here' } },
    })
    renderWithProviders(
      <NotificationEditor node={notification([{ labelRu: 'Сайт', labelEn: null, kind: 'url', target: '', row: 0 }])} />,
    )
    await user.type(screen.getByPlaceholderText('Абсолютный HTTPS URL'), 'https://example.com')
    await user.click(saveTemplate())
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith('buttons.0.target must be a whole address starting with https:// here'),
    )
  })
})

// ── A screen's buttons in «Схема» ────────────────────────────────────────────

function screenButton(overrides: Partial<BotFlowButton>): BotFlowButton {
  return {
    id: 'button-1',
    screenId: 'screen-1',
    labelRu: 'Сайт',
    labelEn: 'Site',
    row: 0,
    col: 0,
    actionType: 'URL',
    targetScreenId: null,
    url: null,
    webAppUrl: null,
    callbackAction: null,
    style: 'DEFAULT',
    iconCustomEmojiId: null,
    ...overrides,
  }
}

function flowScreen(button: BotFlowButton): BotFlowScreen {
  return {
    id: 'screen-1',
    shortId: 'A1',
    flowId: 'flow-1',
    name: 'promo',
    textRu: 'Привет',
    textEn: 'Hello',
    parseMode: 'HTML',
    mediaType: null,
    mediaFileId: null,
    mediaUrl: null,
    positionX: 0,
    positionY: 0,
    isRoot: false,
    buttons: [button],
  }
}

/** Every PUT the editor sent for the button, in order. */
function puts(): Array<Record<string, unknown>> {
  return vi
    .mocked(api.put)
    .mock.calls.filter(([path]) => String(path).startsWith('/admin/bot-flows/buttons/'))
    .map(([, body]) => body as Record<string, unknown>)
}

describe('a screen’s buttons', () => {
  beforeEach(() => {
    vi.spyOn(api, 'put').mockResolvedValue({ data: {} })
  })

  it('open a saved http link as it was, say why, and save the link only once the bot can open it', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <ScreenEditorPanel screen={flowScreen(screenButton({ url: 'http://example.com/a' }))} flowName="Main Flow" />,
    )
    const box = screen.getByRole('textbox', { name: 'URL' })
    expect(box).toHaveValue('http://example.com/a')
    expect(screen.getByText(reason('linkNeedsHttps'))).toHaveAttribute('role', 'alert')

    // Left as it is, or changed to another refused link: nothing is saved.
    await user.click(box)
    await user.tab()
    await user.clear(box)
    await user.type(box, 'example.com/a')
    expect(screen.getByText(reason('notAPage'))).toBeInTheDocument()
    await user.tab()
    expect(puts()).toEqual([])

    // Typed through — not saved on each keystroke — and saved when left.
    await user.clear(box)
    await user.type(box, 'https://example.com/a')
    expect(puts()).toEqual([])
    await user.tab()
    await waitFor(() => expect(puts()).toEqual([{ url: 'https://example.com/a' }]))
  })

  it('save a page picked for a «Mini App» button at once, and hold one typed that the bot cannot open', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <ScreenEditorPanel
        screen={flowScreen(screenButton({ actionType: 'WEBAPP', webAppUrl: 'www.example.com' }))}
        flowName="Main Flow"
      />,
    )
    expect(await screen.findByText(reason('notAPage'))).toBeInTheDocument()
    const picker = await screen.findByRole('combobox', { name: 'Страница мини-приложения' })
    const box = screen.getByDisplayValue('www.example.com')
    await user.click(box)
    await user.tab()
    expect(puts()).toEqual([])

    await user.click(picker)
    await user.click(await screen.findByRole('option', { name: /Реферальная программа/ }))
    await waitFor(() => expect(puts()).toEqual([{ webAppUrl: '/referrals' }]))
    expect(screen.queryByText(reason('notAPage'))).toBeNull()
  })

  it('save a Mini App page typed under «Свой путь…» when the box is left', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <ScreenEditorPanel
        screen={flowScreen(screenButton({ actionType: 'WEBAPP', webAppUrl: 'referrals' }))}
        flowName="Main Flow"
      />,
    )
    // Typed over, not cleared first: an empty «Свой путь…» box closes, and so
    // does one that reads a listed page on the way. The list loaded first: the
    // box is drawn again beside it.
    await screen.findByRole('combobox', { name: 'Страница мини-приложения' })
    const box = screen.getByDisplayValue('referrals')
    await user.tripleClick(box)
    await user.keyboard('/promo?code=A')
    expect(box).toHaveValue('/promo?code=A')
    expect(puts()).toEqual([])
    await user.tab()
    await waitFor(() => expect(puts()).toEqual([{ webAppUrl: '/promo?code=A' }]))
  })

  it('keep saving the caption of a button whose link is refused', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <ScreenEditorPanel screen={flowScreen(screenButton({ url: 'http://example.com/a' }))} flowName="Main Flow" />,
    )
    const caption = screen.getByDisplayValue('Сайт')
    await user.type(caption, '!')
    await user.tab()
    await waitFor(() => expect(puts()).toEqual([{ labelRu: 'Сайт!' }]))
  })

  it('show the server’s own reason when it refuses anyway', async () => {
    const user = userEvent.setup()
    const error = vi.spyOn(toast, 'error')
    vi.mocked(api.put).mockRejectedValue({ response: { data: { message: 'url must start with https:// here' } } })
    renderWithProviders(<ScreenEditorPanel screen={flowScreen(screenButton({}))} flowName="Main Flow" />)
    const box = screen.getByRole('textbox', { name: 'URL' })
    await user.type(box, 'https://example.com/a')
    await user.tab()
    await waitFor(() => expect(error).toHaveBeenCalledWith('url must start with https:// here'))
  })

  it('save nothing when a box is left as it was — not the stored link, not the one just saved', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <ScreenEditorPanel screen={flowScreen(screenButton({ url: 'https://example.com/a' }))} flowName="Main Flow" />,
    )
    const box = screen.getByRole('textbox', { name: 'URL' })
    await user.click(box)
    await user.tab()
    expect(puts()).toEqual([])

    await user.clear(box)
    await user.type(box, 'https://example.com/b')
    await user.tab()
    await waitFor(() => expect(puts()).toEqual([{ url: 'https://example.com/b' }]))
    // Its row has not come back yet: leaving the box again changes nothing.
    await user.click(box)
    await user.tab()
    expect(puts()).toEqual([{ url: 'https://example.com/b' }])
  })

  it('save a link on Enter — a phone keyboard’s «Go» — as leaving the box does', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ScreenEditorPanel screen={flowScreen(screenButton({}))} flowName="Main Flow" />)
    await user.type(screen.getByRole('textbox', { name: 'URL' }), 'https://example.com/a{Enter}')
    await waitFor(() => expect(puts()).toEqual([{ url: 'https://example.com/a' }]))
  })

  it('save a Mini App page typed under «Свой путь…» on Enter', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <ScreenEditorPanel screen={flowScreen(screenButton({ actionType: 'WEBAPP', webAppUrl: 'referrals' }))} flowName="Main Flow" />,
    )
    await screen.findByRole('combobox', { name: 'Страница мини-приложения' })
    const box = screen.getByDisplayValue('referrals')
    await user.tripleClick(box)
    await user.keyboard('/promo?code=B{Enter}')
    await waitFor(() => expect(puts()).toEqual([{ webAppUrl: '/promo?code=B' }]))
  })

  it('save what was typed when the editor goes away with the box still focused', async () => {
    const user = userEvent.setup()
    const view = renderWithProviders(<ScreenEditorPanel screen={flowScreen(screenButton({}))} flowName="Main Flow" />)
    await user.type(screen.getByRole('textbox', { name: 'URL' }), 'https://example.com/a')
    expect(puts()).toEqual([])
    // Another tab of «Карта бота», the inspector collapsed: no blur comes.
    view.unmount()
    await waitFor(() => expect(puts()).toEqual([{ url: 'https://example.com/a' }]))
  })

  it('save a caption typed when the editor goes away, and nothing that the bot could not open', async () => {
    const user = userEvent.setup()
    const view = renderWithProviders(
      <ScreenEditorPanel screen={flowScreen(screenButton({ url: 'https://example.com/a' }))} flowName="Main Flow" />,
    )
    const box = screen.getByRole('textbox', { name: 'URL' })
    await user.clear(box)
    await user.type(box, 'http://example.com/a')
    await user.type(screen.getByDisplayValue('Сайт'), ' 2')
    view.unmount()
    await waitFor(() => expect(puts()).toEqual([{ labelRu: 'Сайт 2' }]))
  })

  it('keep what is typed after a save while that save’s row is on its way back', async () => {
    const user = userEvent.setup()
    const button = screenButton({})
    const view = renderWithProviders(<ScreenEditorPanel screen={flowScreen(button)} flowName="Main Flow" />)
    const box = screen.getByRole('textbox', { name: 'URL' })
    await user.type(box, 'https://example.com/a')
    await user.tab()
    await waitFor(() => expect(puts()).toEqual([{ url: 'https://example.com/a' }]))
    await user.type(box, '/more')
    // The refetch brings the saved link back: what is typed after it stays.
    view.rerender(<ScreenEditorPanel screen={flowScreen({ ...button, url: 'https://example.com/a' })} flowName="Main Flow" />)
    expect(box).toHaveValue('https://example.com/a/more')
    // A change made elsewhere reaches a box nobody is typing in.
    await user.tab()
    await waitFor(() => expect(puts()).toHaveLength(2))
    view.rerender(<ScreenEditorPanel screen={flowScreen({ ...button, url: 'https://example.com/other' })} flowName="Main Flow" />)
    expect(box).toHaveValue('https://example.com/other')
  })

  it('mark a Mini App box the bot cannot open invalid, and read its reason with it', async () => {
    renderWithProviders(
      <ScreenEditorPanel
        screen={flowScreen(screenButton({ actionType: 'WEBAPP', webAppUrl: 'www.example.com' }))}
        flowName="Main Flow"
      />,
    )
    const note = await screen.findByText(reason('notAPage'))
    const box = screen.getByDisplayValue('www.example.com')
    expect(box).toHaveAttribute('aria-invalid', 'true')
    expect(box).toHaveAttribute('aria-describedby', note.id)
  })
})
