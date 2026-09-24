/**
 * The bot's screens that have no block in the flow graph, as «Карта бота»
 * lists them — pinned against what reiwa sends.
 *
 * None of these was on the map: the language picker, the channel gate's
 * prompt, the channel quest, the return from a payment, the password reset,
 * `/paysupport`, the error message, AI support and the one-line answers. Their
 * buttons and texts could be changed only by typing a key nobody could guess
 * into «Тексты». The lists below are reiwa's (`src/bot/pages/**`,
 * `src/bot/lib/error-handler.ts`), read at HEAD on 23.09.2026: a button or text
 * reiwa adds is a line here too, or the map is short again. This table is a
 * copy; `system-screens.reiwa.parity.test.ts` holds the lists against reiwa's
 * source itself wherever the sibling checkout is on disk.
 */
import { describe, expect, it } from 'vitest'

import { valueAt } from '@/test/i18n-key-paths'

import { BOT_MAP_DICTIONARIES } from './page-dictionaries.fixtures'

import {
  MAIN_MENU_SYSTEM_BUTTONS,
  MAIN_MENU_TEXT_KEYS,
  SYSTEM_SCREENS,
  systemScreenForNode,
  systemScreenNodeId,
} from './system-screens'
import { SYSTEM_SCREEN_NODE_TYPE, systemScreensToReactFlow } from './utils'

/** Per screen: its texts, then its buttons as [text key, icon slot or null]. */
const REIWA: Record<string, { texts: string[]; buttons: Array<[string, string | null]> }> = {
  // pages/channel-join-prompt.ts + menu.ts
  channelGate: {
    texts: ['channel.required', 'channel.not_subscribed', 'channel.verified'],
    buttons: [
      ['channel.join_button', null],
      ['channel.check_button', null],
    ],
  },
  // pages/quest-channel.ts
  questChannel: {
    texts: [
      'quests.channel.prompt',
      'quests.channel.verified',
      'quests.channel.not_subscribed',
      'quests.channel.retry',
      'quests.channel.link_first',
    ],
    buttons: [
      ['channel.join_button', null],
      ['channel.check_button', null],
    ],
  },
  // pages/lang.ts
  lang: {
    texts: ['lang.choose', 'lang.changed', 'lang.name.ru', 'lang.name.en'],
    buttons: [
      ['lang.ru', null],
      ['lang.en', null],
    ],
  },
  // pages/start.ts, `payment_return`
  paymentReturn: { texts: ['payment_return.title'], buttons: [['payment_return.open_app', null]] },
  // pages/password-reset.ts
  passwordReset: {
    texts: [
      'password_reset.link',
      'password_reset.no_account',
      'password_reset.recently_sent',
      'password_reset.hourly_limit',
      'password_reset.unavailable',
    ],
    buttons: [['password_reset.button', null]],
  },
  // pages/paysupport.ts — the same two system buttons the help screens render
  paysupport: {
    texts: ['paysupport.body', 'paysupport.unavailable', 'paysupport.prefill'],
    buttons: [
      ['help.contact_button', 'help_contact'],
      ['back_to_menu', 'back'],
    ],
  },
  // lib/error-handler.ts
  error: { texts: ['error.unknown'], buttons: [['help.contact_button', 'help_contact']] },
  // pages/ai-support.ts
  aiSupport: {
    texts: [
      'ai_support.intro',
      'ai_support.unavailable',
      'ai_support.exited',
      'ai_support.rate_limited',
      'ai_support.failed',
    ],
    buttons: [['ai_support.exit_button', null]],
  },
  // main.ts → setMyCommands, one per BOT_COMMANDS entry
  commands: {
    texts: [
      'commands.start.description',
      'commands.help.description',
      'commands.lang.description',
      'commands.rules.description',
      'commands.paysupport.description',
    ],
    buttons: [],
  },
  // stale-button.ts (and dynamic-screen.ts for a `screen:` button onto a screen
  // that is gone): the toast over the main menu, whose buttons are the menu's
  staleButton: { texts: ['menu.updated'], buttons: [] },
  // start.ts (access mode, link code), payments.ts
  serviceReplies: {
    texts: [
      'access_mode.restricted',
      'access_mode.reg_blocked_new',
      'access_mode.invited_no_code',
      'link.success',
      'link.invalid',
      'link.already_linked',
      'link.user_not_found',
      'link.error',
      'payments.stars.received',
      'payments.stars.received_delayed',
      'payments.stars.unknown_invoice',
      'payments.stars.already_handled',
      'payments.stars.unavailable',
    ],
    buttons: [],
  },
}

describe('the bot’s screens without a block', () => {
  it('lists every one of them, with the texts and buttons the bot sends from it', () => {
    const listed = Object.fromEntries(
      SYSTEM_SCREENS.map((screen) => [
        screen.id,
        {
          texts: screen.texts.map((text) => text.key),
          buttons: screen.buttons.map((button) => [button.textKey, button.iconKey ?? null]),
        },
      ]),
    )
    expect(listed).toEqual(REIWA)
  })

  it('has the words for every title, button, condition and caption in both languages', () => {
    const keys = [
      ...SYSTEM_SCREENS.flatMap((screen) => [
        screen.titleKey,
        screen.triggerKey,
        ...screen.buttons.flatMap((b) => [b.labelKey, b.conditionKey ?? []].flat()),
        ...screen.texts.flatMap((t) => (t.captionKey !== undefined ? [t.captionKey] : [])),
      ]),
      ...MAIN_MENU_SYSTEM_BUTTONS.flatMap((b) => [b.labelKey, b.conditionKey ?? []].flat()),
    ]
    // As the page has them: the core dictionary with the `botMap` bundle.
    for (const [lng, dictionary] of BOT_MAP_DICTIONARIES) {
      for (const key of keys) {
        expect(typeof valueAt(dictionary, key), `${lng}: ${key}`).toBe('string')
      }
    }
  })

  it('keeps the main menu’s trial button apart: two captions, and no icon slot the bot would read', () => {
    expect(MAIN_MENU_SYSTEM_BUTTONS.map((b) => [b.textKey, b.iconKey ?? null])).toEqual([
      ['menu.btn_trial_free', null],
      ['menu.btn_trial_paid', null],
    ])
    expect(MAIN_MENU_TEXT_KEYS).toContain('menu.choose_action')
    // «Меню обновилось» is edited with the main menu's texts too: it shows over the menu.
    expect(MAIN_MENU_TEXT_KEYS).toContain('menu.updated')
  })
})

describe('the bot’s screens without a block on the canvas', () => {
  it('draws a node for each, in a column of their own, where no screen is placed by default', () => {
    const nodes = systemScreensToReactFlow({})
    expect(nodes.map((node) => node.id)).toEqual(SYSTEM_SCREENS.map((s) => systemScreenNodeId(s.id)))
    for (const node of nodes) {
      expect(node.type).toBe(SYSTEM_SCREEN_NODE_TYPE)
      expect(node.position.x).toBeLessThan(-360)
      expect(systemScreenForNode(node.id)).not.toBeNull()
      // The bot sends these screens whatever the canvas holds: Delete on a
      // selected one must not take it off the map.
      expect(node.deletable).toBe(false)
    }
    expect(new Set(nodes.map((n) => n.position.y)).size).toBe(nodes.length)
  })

  it('puts a node where the operator left it', () => {
    const id = systemScreenNodeId('lang')
    const nodes = systemScreensToReactFlow({ [id]: { x: 12, y: 34 } })
    expect(nodes.find((n) => n.id === id)?.position).toEqual({ x: 12, y: 34 })
  })

  it('names no screen for a node that is not one of them', () => {
    expect(systemScreenForNode('__reply_keyboard__')).toBeNull()
    expect(systemScreenForNode(null)).toBeNull()
  })
})
