/**
 * The map's hints name what the panel shows and say what the bot does.
 *
 * On 23.09.2026 three did not:
 *   - a no-block screen sent its reader to «Тексты бота» / «Bot texts» — the
 *     toolbar button and the tab read «Тексты» / «Texts»
 *     (`botStudio.toolbar.texts`, rendered by `bot-flow-page.tsx`);
 *   - the help screen said `/help` shows its text «с теми же кнопками» — reiwa
 *     `src/bot/pages/help.ts` sends the three system buttons only (the Mini App
 *     page, the support chat, «◀️ В меню»), never the screen's own;
 *   - «Короткие ответы» said «без кнопок» and listed the reply to a deleted
 *     screen, which carries «◀️ В меню» (`dynamic-screen.ts`).
 * And the main menu's hint sent the reader for the trial button's icon to
 * «Эмодзи», a word no page, tab or button of the panel shows: the TRIAL slot
 * (GIFT, PROMO after it — reiwa `widgets/trial-button.ts`) is edited on the
 * «Эмодзи-паки» page (`adminNav.items.emojiPacks`), tab «Слоты эмодзи»
 * (`emojiPacksPage.tabs.slots`, `custom-emoji-page.tsx`).
 *
 * The «Внешняя ссылка» hints under a main-menu button said «только https://»,
 * while «Схема» and «Список» now caption a path as a page of the cabinet: reiwa
 * (`addressOn`, `widgets/main-keyboard.ts`) sends an http(s) address as typed
 * and puts anything else on the cabinet website's address.
 *
 * The caption under a button whose address Telegram refuses said «Telegram не
 * откроет …»; for a «Внешняя ссылка» that undersold it (the whole menu was
 * refused) and now oversells it — reiwa leaves such a button out, as it does
 * a Mini App's — so it says what the customer sees: no button.
 */
import { describe, expect, it } from 'vitest'

import { valueAt } from '@/test/i18n-key-paths'

import { BOT_MAP_DICTIONARIES } from './page-dictionaries.fixtures'
import { SYSTEM_SCREENS } from './system-screens'

/** As the page has them: the core dictionary with the `botMap` bundle. */
const DICTIONARIES = BOT_MAP_DICTIONARIES

type Dictionary = (typeof DICTIONARIES)[number][1]

function text(dictionary: Dictionary, key: string): string {
  const value = valueAt(dictionary, key)
  expect(typeof value, key).toBe('string')
  return value as string
}

/** How each language says «the system buttons and nothing else». */
const SYSTEM_BUTTONS_ONLY = { ru: 'только системные кнопки', en: 'the system buttons only' } as const

/** How each language says «a reply with no buttons». */
const WITHOUT_BUTTONS = { ru: 'без кнопок', en: 'without buttons' } as const

/** How each language says «a page of the cabinet website». */
const CABINET_PAGE = { ru: 'страница сайта кабинета', en: 'a page of the cabinet website' } as const

/** How each language says «the bot does not show this button». */
const LEFT_OUT = { ru: 'бот не покажет эту кнопку', en: 'the bot leaves this button out' } as const

describe('the map’s hints', () => {
  it.each(DICTIONARIES)('%s: send a no-block screen’s reader to the texts by the name the button shows', (_lng, dictionary) => {
    expect(text(dictionary, 'botFlow.systemScreens.hint')).toContain(`«${text(dictionary, 'botStudio.toolbar.texts')}»`)
  })

  it.each(DICTIONARIES)('%s: find the trial button’s icon on the page and the tab that edit it', (_lng, dictionary) => {
    const hint = text(dictionary, 'botFlow.mainMenu.hint')
    expect(hint).toContain(`«${text(dictionary, 'adminNav.items.emojiPacks')}»`)
    expect(hint).toContain(`«${text(dictionary, 'emojiPacksPage.tabs.slots')}»`)
  })

  it.each(DICTIONARIES)('%s: say the /help command sends the system buttons only', (lng, dictionary) => {
    expect(text(dictionary, 'botFlow.fields.placeholders.help')).toContain(SYSTEM_BUTTONS_ONLY[lng])
  })

  it.each(DICTIONARIES)('%s: say a link typed as a path opens a page of the cabinet, and an http address is sent', (lng, dictionary) => {
    for (const key of [
      'botConfigPage.buttons.fields.actionType.hint.URL',
      'botConfigPage.buttons.fields.actionTarget.urlHint',
    ]) {
      const hint = text(dictionary, key)
      expect(hint, key).toContain(CABINET_PAGE[lng])
      expect(hint, key).toContain('http://')
    }
  })

  it.each(DICTIONARIES)('%s: say under a button with an address Telegram refuses that the bot leaves it out', (lng, dictionary) => {
    // reiwa drops such a Mini App button, and — from 23.09.2026 — such a
    // «Внешняя ссылка» too, instead of sending a menu Telegram refuses whole.
    const caption = text(dictionary, 'botFlow.replyTargets.unsafeUrl')
    expect(caption).toContain(LEFT_OUT[lng])
    expect(caption).toContain('{{host}}')
  })

  it.each(DICTIONARIES)('%s: call a screen buttonless only where the bot sends it without one', (lng, dictionary) => {
    const said = SYSTEM_SCREENS.filter((screen) => text(dictionary, screen.triggerKey).includes(WITHOUT_BUTTONS[lng]))
    expect(said.map((screen) => screen.id)).toContain('serviceReplies')
    for (const screen of said) expect(screen.buttons, screen.id).toEqual([])
  })
})
