/**
 * «Список» says what the bot does with a button, in the words «Схема» uses.
 *
 * The composer marks an edge broken with a reason; the list showed every
 * reason as «✕ Цель не задана» — a `screen:` button onto a deleted screen, a
 * callback nothing answers and a page the Mini App lacks all read «target
 * unset». A menu link typed as a path had no destination at all to show: it
 * read «✕ Небезопасный URL» while the bot opened it on the cabinet. And the
 * notification editor's free-text callback field named no value but its
 * placeholder.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'

import { api } from '@/lib/api'
import { en } from '@/i18n/en'
import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { ru } from '@/i18n/ru'
import { en as botMapEn } from '@/i18n/features/botMap.en'
import { ru as botMapRu } from '@/i18n/features/botMap.ru'
import { emojiStudioPayload, packsPayload } from '@/features/custom-emoji/emoji-catalog.fixtures'
import { CALLBACK_VOCABULARY } from '@/features/bot-flow/components/reply-keyboard-utils'
import { valueAt } from '@/test/i18n-key-paths'
import { renderWithProviders } from '@/test/test-utils'

import type { BotMapEdge, BotMapPayload, NotificationMapNode, ReplyKeyboardMapNode } from '../types'
import { NotificationEditor } from './inspector/NotificationEditor'
import { ListView } from './ListView'

beforeAll(async () => {
  await loadFeatureBundle('botMap')
})

afterEach(() => {
  vi.restoreAllMocks()
})

const MENU: ReplyKeyboardMapNode = {
  id: '__reply_keyboard__',
  kind: 'reply-keyboard',
  title: 'Главное меню',
  group: 'reply',
  buttons: [],
}

function edge(sourceLabel: string, rest: Omit<BotMapEdge, 'id' | 'source' | 'sourceLabel'>): BotMapEdge {
  return { id: `e-${sourceLabel}`, source: MENU.id, sourceLabel, ...rest }
}

describe('a main-menu button on «Список»', () => {
  it('says where the bot sends it, or what is wrong with it, reason by reason', () => {
    const payload: BotMapPayload = {
      nodes: [MENU],
      edges: [
        edge('Тарифы', { target: 'site:/plans', destination: { kind: 'site', path: '/plans' }, valid: true }),
        edge('Подписка', {
          target: 'callback:subscription',
          destination: { kind: 'callback', id: 'subscription' },
          valid: false,
          reason: 'unanswered-callback',
        }),
        edge('Старый', {
          target: 'invalid:unknown-shortid',
          destination: { kind: 'callback', id: '' },
          valid: false,
          reason: 'unknown-shortid',
        }),
        edge('Промо', {
          target: 'url:unknown-route',
          destination: { kind: 'webApp', route: '/promoo' },
          valid: false,
          reason: 'unknown-mini-app-route',
        }),
      ],
      meta: { flowStatus: 'PUBLISHED', composedAt: '2026-09-23T00:00:00.000Z' },
    }
    renderWithProviders(<ListView payload={payload} visibleNodes={[MENU]} selectedId={null} onSelect={() => undefined} />)

    expect(screen.getByText(i18n.t('botMapPage.destination.site', { path: '/plans' }))).toBeInTheDocument()
    expect(screen.getByText(i18n.t('botMapPage.destination.unanswered'))).toBeInTheDocument()
    expect(screen.getByText(i18n.t('botMapPage.destination.missingScreen'))).toBeInTheDocument()
    expect(screen.getByText(i18n.t('botMapPage.destination.missingPage'))).toBeInTheDocument()
    expect(screen.queryByText(i18n.t('botMapPage.destination.invalid'))).toBeNull()
    // A key missing from a bundle renders as its own path — and would match above.
    for (const key of ['site', 'unanswered', 'missingScreen', 'missingPage', 'chatOrScreen'].map((name) => `botMapPage.destination.${name}`)) {
      for (const bundle of [botMapRu, botMapEn]) expect(typeof valueAt(bundle, key), key).toBe('string')
    }
  })

  /**
   * «Username поддержки» empty: reiwa's `.env` decides, which the panel cannot
   * see — «Схема» names both roads, and «Список» said only «Чат поддержки».
   */
  it('names both roads of a support button the panel cannot place, as «Схема» does', () => {
    const payload: BotMapPayload = {
      nodes: [MENU],
      edges: [
        edge('Поддержка', { target: 'chat', destination: { kind: 'chat', fallbackScreen: 'help' }, valid: true }),
        edge('Чат', { target: 'chat', destination: { kind: 'chat' }, valid: true }),
      ],
      meta: { flowStatus: 'PUBLISHED', composedAt: '2026-09-23T00:00:00.000Z' },
    }
    renderWithProviders(<ListView payload={payload} visibleNodes={[MENU]} selectedId={null} onSelect={() => undefined} />)

    expect(screen.getByText(i18n.t('botMapPage.destination.chatOrScreen', { name: 'help' }))).toBeInTheDocument()
    expect(screen.getByText(i18n.t('botMapPage.destination.chat'))).toBeInTheDocument()
  })
})

describe('a notification’s callback button', () => {
  it('names the callbacks the bot answers under its free-text field', () => {
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/custom-emoji/packs') return packsPayload([])
      if (path === '/admin/bot-config/emoji-studio') return emojiStudioPayload()
      return { data: [] }
    })
    const node: NotificationMapNode = {
      id: 'notif:expires_in_3_days',
      kind: 'notification',
      title: 'expires_in_3_days',
      group: 'notification:expires',
      templateId: 'tpl-1',
      type: 'expires_in_3_days',
      category: 'expires',
      titleRu: 'Подписка истекает',
      titleEn: null,
      bodyRu: 'Скоро',
      bodyEn: null,
      bannerUrl: null,
      isActive: true,
      buttons: [{ labelRu: 'Меню', labelEn: null, kind: 'callback', target: 'menu:main' }],
    }
    renderWithProviders(<NotificationEditor node={node} />)

    expect(screen.getByText(i18n.t('botMapPage.notification.callbackHint'))).toBeInTheDocument()
  })

  it.each([
    ['ru', botMapRu, 'надёжнее'],
    ['en', botMapEn, 'more reliably'],
  ] as const)('%s: the hint names every word and pattern the bot answers, and the surer way to a screen', (_lng, bundle, surer) => {
    const hint = String(valueAt(bundle, 'botMapPage.notification.callbackHint'))
    // A pattern by its literal head: `check_channel`, `lang:`, `quest_channel:`.
    const heads = CALLBACK_VOCABULARY.answeredPatterns.map((pattern) => /^\^([a-z_]+:?)/.exec(pattern.source)?.[1] ?? '')
    expect(heads).toEqual(['check_channel', 'lang:', 'quest_channel:'])
    const words = [
      ...CALLBACK_VOCABULARY.mainMenu,
      ...CALLBACK_VOCABULARY.builtInScreens,
      ...CALLBACK_VOCABULARY.answered,
      ...heads,
      CALLBACK_VOCABULARY.screenPrefix,
    ]
    // Each on its own: `menu` counts only outside `menu:main` and `back_to_menu`.
    for (const word of words) expect(hint, word).toMatch(new RegExp(`(^|[\\s;:,—(])${word}(?=[\\s;,.<—)]|$)`))
    // A bare shortId can be passed over while the panel answers slowly: the
    // hint sends a screen of one's own through `screen:<shortId>`.
    expect(hint).toContain(surer)
    expect(hint).toMatch(new RegExp(`${surer}[^.;]*${CALLBACK_VOCABULARY.screenPrefix}<shortId>`))
  })

  it.each([
    ['ru', botMapRu, ru],
    ['en', botMapEn, en],
  ] as const)('%s: names the channel quest by the name its type has in the panel', (_lng, bundle, dictionary) => {
    const hint = String(valueAt(bundle, 'botMapPage.notification.callbackHint'))
    const questType = valueAt(dictionary, 'questsAdminPage.types.SUBSCRIBE_CHANNEL')
    expect(typeof questType).toBe('string')
    expect(hint).toContain(`«${String(questType)}»`)
  })
})
