/**
 * The hints under a menu button's action and a screen button's «Чат поддержки»,
 * against what reiwa does with the tap.
 *
 * reiwa sends a «Внутренняя кнопка»'s ID as the callback. Since 23.09.2026 it
 * answers `invite` / `rules` / `help` with those screens, `menu` and
 * `back_to_menu` with the main menu, and an ID that is exactly a screen's
 * shortId with that screen (`start.ts`, `dynamic-screen.ts`); anything else
 * spins and does nothing. The hint said the second and third never worked —
 * true for a day, wrong now — and the map called those buttons dead. Then it
 * said «any other ID does nothing» while `close`, `check_channel` and
 * `ai_support_exit` — IDs the field takes — each do something, and the canvas
 * drew them as answered: the list it checks is now the map's own vocabulary.
 * The support hints named `.env` as where the username comes from, while the
 * bot reads the panel's «Username поддержки» first (`resolveConfiguredSupportUrl`).
 */
import { describe, expect, it } from 'vitest'

import { BUTTON_ID_PATTERN } from '@/features/bot-config/bot-button-payload'
import { en } from '@/i18n/en'
import { ru } from '@/i18n/ru'
import { valueAt } from '@/test/i18n-key-paths'

import { CALLBACK_VOCABULARY, SUPPORT_FALLBACK_CALLBACK } from './components/reply-keyboard-utils'

const DICTIONARIES = [
  ['ru', ru],
  ['en', en],
] as const

const text = (dictionary: unknown, path: string): string => {
  const value = valueAt(dictionary, path)
  if (typeof value !== 'string') throw new Error(`${path} is not a string`)
  return value
}

/**
 * Every button ID the bot answers, read off the vocabulary the map routes with:
 * its words, and the literal head of each pattern (`check_channel` of
 * `^check_channel(?::q:…)?$`) — those a button's ID can be (`BUTTON_ID_PATTERN`:
 * no `:`, so not `menu:main`, `lang:…`, `quest_channel:…`).
 */
function answeredButtonIds(): string[] {
  const heads = CALLBACK_VOCABULARY.answeredPatterns.map((pattern) => /^\^([a-z_]+:?)/.exec(pattern.source)?.[1] ?? '')
  return [
    ...CALLBACK_VOCABULARY.builtInScreens,
    ...CALLBACK_VOCABULARY.mainMenu,
    ...CALLBACK_VOCABULARY.answered,
    ...heads,
  ].filter((id) => BUTTON_ID_PATTERN.test(id))
}

describe('the «Внутренняя кнопка» hint', () => {
  it('reads every ID it checks off the vocabulary', () => {
    expect(answeredButtonIds()).toEqual([
      'help',
      'rules',
      'invite',
      'menu',
      'back_to_menu',
      'close',
      'ai_support_exit',
      'check_channel',
    ])
  })

  it.each(DICTIONARIES)('%s: names every ID the bot answers, a screen’s shortId, and the surer way to a screen', (_lng, dictionary) => {
    const hint = text(dictionary, 'botConfigPage.buttons.fields.actionType.hint.CALLBACK')
    // Each on its own: `menu` counts only outside `back_to_menu`.
    for (const id of answeredButtonIds()) expect(hint, id).toMatch(new RegExp(`(^|[\\s,(«])${id}(?=[\\s,.)»—]|$)`))
    expect(hint).toMatch(/shortId/)
    expect(hint).toContain(text(dictionary, 'botConfigPage.buttons.fields.actionType.options.SCREEN'))
  })
})

describe('the «Чат с поддержкой» hint', () => {
  // reiwa since 23.09.2026: with no public support @username the button sends
  // `help` (`SUPPORT_FALLBACK_CALLBACK`), which opens the help screen — it no
  // longer sends its own ID the way a «Внутренняя кнопка» does.
  it.each(DICTIONARIES)('%s: says the button opens the help screen without a public username', (_lng, dictionary) => {
    const hint = text(dictionary, 'botConfigPage.buttons.fields.actionType.hint.SUPPORT_URL')
    expect(hint).toMatch(new RegExp(`\\b${SUPPORT_FALLBACK_CALLBACK}\\b`))
    expect(hint).not.toContain(text(dictionary, 'botConfigPage.buttons.fields.actionType.options.CALLBACK'))
  })
})

describe('the support-chat hints', () => {
  it.each(DICTIONARIES)('%s: name the panel’s «Username поддержки» as where the username comes from', (_lng, dictionary) => {
    const setting = text(dictionary, 'botStudio.replyKeyboard.settings.supportUsername')
    expect(text(dictionary, 'botConfigPage.buttons.fields.actionType.hint.SUPPORT_URL')).toContain(setting)
    expect(text(dictionary, 'botFlow.button.supportUrlHint')).toContain(setting)
  })
})
