/**
 * The bot's main menu on the canvas of «Карта бота» — the pinned node the map
 * called «Reply-клавиатура» until 23.09.2026, «Главное меню» since. reiwa sends
 * it as the inline keyboard under the greeting (`src/bot/widgets/main-keyboard.ts`,
 * `buildMainKeyboard`).
 *
 * Three things the node said differently from the bot:
 *   • where a button leads was guessed from its ID alone: «Пригласить» set to
 *     open another screen still pointed at the invite screen, and the words
 *     under each button were i18n keys no dictionary has (`screen.invite`);
 *   • the trial button reiwa puts on top for a customer without a
 *     subscription was not there at all;
 *   • «Всегда видна под полем ввода» — the bot sends no reply keyboard.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, within } from '@testing-library/react'

import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { valueAt } from '@/test/i18n-key-paths'
import { renderWithProviders } from '@/test/test-utils'
import type { BotButton } from '@/features/bot-config/bot-config-api'

import { ReplyKeyboardNode } from './ReplyKeyboardNode'
import { BOT_MAP_DICTIONARIES } from '../page-dictionaries.fixtures'
import { buildReplyToScreenEdges } from '../utils'
import type { BotFlow } from '../types'

// What the route loads with the page: part of the node's words live in it.
beforeAll(async () => {
  await loadFeatureBundle('botMap')
})

vi.mock('@xyflow/react', async () => {
  const React = await import('react')
  return {
    Handle: () => React.createElement('span', { 'data-testid': 'flow-handle' }),
    Position: { Bottom: 'bottom', Left: 'left', Right: 'right', Top: 'top' },
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

function menuButton(overrides: Partial<BotButton>): BotButton {
  return {
    id: `row-${overrides.buttonId}`,
    buttonId: 'invite',
    label: String(overrides.buttonId),
    style: 'DEFAULT',
    iconCustomEmojiId: null,
    visible: true,
    onePerRow: true,
    orderIndex: 0,
    actionType: 'CALLBACK',
    actionTarget: null,
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    ...overrides,
  }
}

function flowWith(screens: ReadonlyArray<{ id: string; shortId: string; name: string }>): BotFlow {
  return {
    id: 'flow-1',
    name: 'Main Flow',
    version: 1,
    status: 'PUBLISHED',
    layoutData: null,
    publishedAt: null,
    screens: screens.map((s) => ({
      ...s,
      flowId: 'flow-1',
      textRu: '',
      textEn: '',
      parseMode: 'HTML',
      mediaType: null,
      mediaFileId: null,
      mediaUrl: null,
      positionX: 0,
      positionY: 0,
      isRoot: false,
      buttons: [],
    })),
  }
}

const FLOW = flowWith([
  { id: 'screen-invite', shortId: 'sc_invite', name: 'invite' },
  { id: 'screen-rules', shortId: 'sc_rules', name: 'rules' },
  { id: 'screen-help', shortId: 'sc_help', name: 'help' },
  { id: 'screen-promo', shortId: 'sc_promo', name: 'promo' },
])

describe('the arrow from a main-menu button', () => {
  const targets = (buttons: BotButton[]) =>
    Object.fromEntries(buildReplyToScreenEdges(FLOW, buttons).map((e) => [e.id, e.target]))

  it('goes where the bot sends the tap: a «Экран бота» button to its screen, not to the screen named like its ID', () => {
    const invite = menuButton({ buttonId: 'invite', actionType: 'SCREEN', actionTarget: 'sc_promo' })
    expect(targets([invite])).toEqual({ 'reply-edge-row-invite': 'screen-promo' })
  })

  it('leads a «Внутренняя кнопка» with a built-in ID to that screen, as the bot’s own handler does', () => {
    expect(targets([menuButton({ buttonId: 'rules', actionType: 'CALLBACK' })])).toEqual({
      'reply-edge-row-rules': 'screen-rules',
    })
  })

  it('keeps «Помощь» → help: with no support @username the bot falls back to that screen', () => {
    expect(targets([menuButton({ buttonId: 'help', actionType: 'SUPPORT_URL' })])).toEqual({
      'reply-edge-row-help': 'screen-help',
    })
  })

  /**
   * reiwa from 23.09.2026: without a public support @username a support
   * button sends `help`, whatever its ID — it sent the ID, and nothing
   * answered `support`. With a public one there is nothing to fall back to.
   */
  it('leads a support button of any ID to the help screen, and none when the panel knows of a public @username', () => {
    const support = [menuButton({ buttonId: 'support', actionType: 'SUPPORT_URL' })]
    expect(targets(support)).toEqual({ 'reply-edge-row-support': 'screen-help' })
    const to = (supportChat: boolean) =>
      Object.fromEntries(buildReplyToScreenEdges(FLOW, support, supportChat).map((e) => [e.id, e.target]))
    expect(to(false)).toEqual({ 'reply-edge-row-support': 'screen-help' })
    expect(to(true)).toEqual({})
  })

  it('draws no screen arrow for a button that opens a page or a link', () => {
    expect(
      targets([
        menuButton({ buttonId: 'rules', actionType: 'WEBAPP', actionTarget: '/plans' }),
        menuButton({ buttonId: 'invite', actionType: 'URL', actionTarget: 'https://example.com/' }),
      ]),
    ).toEqual({})
  })

  it('leads a «Внутренняя кнопка» whose ID is a screen’s shortId to that screen, as the bot does since 23.09', () => {
    expect(targets([menuButton({ buttonId: 'sc_promo', actionType: 'CALLBACK' })])).toEqual({
      'reply-edge-row-sc_promo': 'screen-promo',
    })
  })

  it('takes the FIRST screen of a repeated name, as reiwa’s `findScreenByName` does', () => {
    const twice = flowWith([
      { id: 'screen-rules-1', shortId: 'sc_r1', name: 'rules' },
      { id: 'screen-rules-2', shortId: 'sc_r2', name: 'Rules' },
    ])
    const edges = buildReplyToScreenEdges(twice, [menuButton({ buttonId: 'rules', actionType: 'CALLBACK' })])
    expect(edges.map((e) => e.target)).toEqual(['screen-rules-1'])
  })
})

describe('the main-menu node', () => {
  /** The flow above and the Mini App's pages, as the canvas page hands them to the node. */
  const CONTEXT = {
    screens: FLOW.screens,
    miniAppRoutes: new Set(['/dashboard', '/plans', '/open-in-browser']),
    supportChat: null,
  }

  function renderMenu(buttons: BotButton[], supportChat: boolean | null = null): void {
    const props = {
      id: '__reply_keyboard__',
      data: { buttons, bannerUrl: null, routeContext: { ...CONTEXT, supportChat } },
      selected: false,
    } as unknown as Parameters<typeof ReplyKeyboardNode>[0]
    renderWithProviders(<ReplyKeyboardNode {...props} />)
  }

  const under = (label: string) => screen.getByText(label).closest('[data-menu-button]') as HTMLElement
  const isRed = (label: string) => under(label).querySelector('[data-broken]') !== null

  it('says under each button where the bot sends it, in words', () => {
    renderMenu([
      menuButton({ buttonId: 'invite', label: 'Пригласить', actionType: 'SCREEN', actionTarget: 'sc_promo', orderIndex: 0 }),
      menuButton({ buttonId: 'rules', label: 'Правила', actionType: 'CALLBACK', orderIndex: 1 }),
      menuButton({ buttonId: 'cabinet', label: 'Кабинет', actionType: 'URL', actionTarget: null, orderIndex: 2 }),
      menuButton({ buttonId: 'webapp', label: 'Приложение', actionType: 'WEBAPP', actionTarget: null, orderIndex: 3 }),
      menuButton({ buttonId: 'help', label: 'Помощь', actionType: 'SUPPORT_URL', orderIndex: 4 }),
    ])

    expect(under('Пригласить').textContent).toContain(i18n.t('botFlow.replyTargets.screen', { name: 'promo' }))
    expect(under('Правила').textContent).toContain(i18n.t('botFlow.replyTargets.screen', { name: 'rules' }))
    expect(under('Кабинет').textContent).toContain(i18n.t('botFlow.replyTargets.cabinetBrowser'))
    expect(under('Приложение').textContent).toContain(i18n.t('botFlow.replyTargets.miniApp', { path: '/' }))
    expect(under('Помощь').textContent).toContain(i18n.t('botFlow.replyTargets.support'))
    // No key path reaches the operator.
    expect(document.body.textContent).not.toMatch(/screen\.(invite|rules|help|cabinet)/)
  })

  it('says so under a «Внутренняя кнопка» no handler in the bot answers, and only under that one', () => {
    renderMenu([
      menuButton({ buttonId: 'subscription', label: 'Подписка', actionType: 'CALLBACK', orderIndex: 0 }),
      menuButton({ buttonId: 'back_to_menu', label: 'Меню', actionType: 'CALLBACK', orderIndex: 1 }),
    ])

    expect(under('Подписка').textContent).toContain(i18n.t('botFlow.replyTargets.unhandled'))
    expect(isRed('Подписка')).toBe(true)
    expect(under('Меню').textContent).toContain(i18n.t('botFlow.replyTargets.mainMenu'))
    expect(isRed('Меню')).toBe(false)
  })

  /**
   * reiwa since 23.09.2026: `menu` is `menu:main` (`start.ts`), and a callback
   * that is exactly a screen's shortId opens it (`dynamic-screen.ts`). The
   * node called both dead.
   */
  it('draws `menu` as the main menu and a screen’s shortId as that screen', () => {
    renderMenu([
      menuButton({ buttonId: 'menu', label: 'Меню', actionType: 'CALLBACK', orderIndex: 0 }),
      menuButton({ buttonId: 'sc_promo', label: 'Акция', actionType: 'CALLBACK', orderIndex: 1 }),
    ])

    expect(under('Меню').textContent).toContain(i18n.t('botFlow.replyTargets.mainMenu'))
    expect(under('Акция').textContent).toContain(i18n.t('botFlow.replyTargets.screen', { name: 'promo' }))
    expect(isRed('Меню')).toBe(false)
    expect(isRed('Акция')).toBe(false)
  })

  it.each(['close', 'check_channel', 'ai_support_exit'])(
    'does not call `%s` dead: the bot answers it',
    (buttonId) => {
      renderMenu([menuButton({ buttonId, label: 'Кнопка', actionType: 'CALLBACK' })])
      expect(under('Кнопка').textContent).not.toContain(i18n.t('botFlow.replyTargets.unhandled'))
    },
  )

  it('draws a «Внешняя ссылка» typed as a path, or with none, as a page of the cabinet site — with its slash', () => {
    renderMenu([
      menuButton({ buttonId: 'plans', label: 'Тарифы', actionType: 'URL', actionTarget: 'plans', orderIndex: 0 }),
      menuButton({ buttonId: 'site', label: 'Сайт', actionType: 'URL', actionTarget: null, orderIndex: 1 }),
    ])

    expect(under('Тарифы').textContent).toContain(i18n.t('botFlow.replyTargets.site', { path: '/plans' }))
    expect(under('Сайт').textContent).toContain(i18n.t('botFlow.replyTargets.site', { path: '/' }))
    expect(isRed('Тарифы')).toBe(false)
  })

  it('says where a support button goes, as far as the panel’s «Username поддержки» tells', () => {
    const support = menuButton({ buttonId: 'support', label: 'Поддержка', actionType: 'SUPPORT_URL' })

    // Not set here: reiwa's `.env` decides — a chat, or the help screen.
    renderMenu([support], null)
    expect(under('Поддержка').textContent).toContain(i18n.t('botFlow.replyTargets.supportOrScreen', { name: 'help' }))
    expect(isRed('Поддержка')).toBe(false)
    cleanup()

    // A numeric id: never a chat — the help screen, not «чат поддержки».
    renderMenu([support], false)
    expect(under('Поддержка').textContent).toContain(i18n.t('botFlow.replyTargets.screen', { name: 'help' }))
    expect(under('Поддержка').textContent).not.toContain(i18n.t('botFlow.replyTargets.support'))
    expect(isRed('Поддержка')).toBe(false)
    cleanup()

    // A public @username: the chat.
    renderMenu([support], true)
    expect(under('Поддержка').textContent).toContain(i18n.t('botFlow.replyTargets.support'))
    expect(under('Поддержка').textContent).not.toContain(i18n.t('botFlow.replyTargets.supportOrScreen', { name: 'help' }))
  })

  it('keeps an http «Внешняя ссылка» working — the bot sends it as typed — and a local one red', () => {
    renderMenu([
      menuButton({ buttonId: 'news', label: 'Новости', actionType: 'URL', actionTarget: 'http://example.com/a', orderIndex: 0 }),
      menuButton({ buttonId: 'dev', label: 'Стенд', actionType: 'URL', actionTarget: 'https://localhost:5173/', orderIndex: 1 }),
    ])

    expect(under('Новости').textContent).toContain(i18n.t('botFlow.replyTargets.url', { host: 'example.com' }))
    expect(isRed('Новости')).toBe(false)
    expect(under('Стенд').textContent).toContain(i18n.t('botFlow.replyTargets.unsafeUrl', { host: 'localhost:5173' }))
    expect(isRed('Стенд')).toBe(true)
  })

  it('draws red what the bot will not carry: a Mini App on http, a page the cabinet lacks, a screen that is gone', () => {
    renderMenu([
      menuButton({ buttonId: 'app', label: 'Приложение', actionType: 'WEBAPP', actionTarget: 'http://example.com/app', orderIndex: 0 }),
      menuButton({ buttonId: 'promo', label: 'Промо', actionType: 'WEBAPP', actionTarget: '/promoo', orderIndex: 1 }),
      menuButton({ buttonId: 'gone', label: 'Старый', actionType: 'SCREEN', actionTarget: 'sc_gone', orderIndex: 2 }),
    ])

    expect(under('Приложение').textContent).toContain(i18n.t('botFlow.replyTargets.unsafeUrl', { host: 'example.com' }))
    expect(under('Промо').textContent).toContain(i18n.t('botFlow.replyTargets.missingPage', { path: '/promoo' }))
    expect(under('Старый').textContent).toContain(i18n.t('botFlow.replyTargets.missingScreen', { shortId: 'sc_gone' }))
    for (const label of ['Приложение', 'Промо', 'Старый']) expect(isRed(label), label).toBe(true)
  })

  it('draws the trial button the bot puts on top for a customer without a subscription, and when', () => {
    renderMenu([menuButton({ buttonId: 'invite', label: 'Пригласить' })])

    const trial = screen.getByText(i18n.t('botFlow.systemButtons.mainMenu.trial')).closest('[data-system-button]') as HTMLElement
    expect(within(trial).getByText(i18n.t('botFlow.systemButtons.conditions.trial'))).toBeInTheDocument()
  })

  it('has the words for every road it captions, in both languages', () => {
    // A key missing from a dictionary renders as its own path — and would match the tests above.
    const roads = ['screen', 'mainMenu', 'missingScreen', 'unhandled', 'support', 'supportOrScreen', 'cabinetBrowser', 'miniApp', 'missingPage', 'site', 'url', 'unsafeUrl']
    // As the page has them: the core dictionary with the `botMap` bundle.
    for (const [, dictionary] of BOT_MAP_DICTIONARIES) {
      for (const road of roads) expect(typeof valueAt(dictionary, `botFlow.replyTargets.${road}`), road).toBe('string')
    }
  })

  it('is called «Main menu», and not a keyboard under the input field', () => {
    renderMenu([])
    expect(screen.getByText('Main menu')).toBeInTheDocument()
    expect(screen.getByText(i18n.t('botStudio.replyKeyboard.nodeHint'))).toBeInTheDocument()
    expect(i18n.t('botStudio.replyKeyboard.nodeHint')).not.toMatch(/chat input|input field|под полем ввода/i)
  })
})
