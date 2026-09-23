/**
 * The bot's main menu is «Главное меню» everywhere the panel names it.
 *
 * reiwa sends those buttons as the INLINE keyboard under the greeting
 * (`src/bot/widgets/main-keyboard.ts`) and never a reply keyboard. The map
 * called the node «Reply-клавиатура» (and «Главное меню (reply-клавиатура)»,
 * «Постоянное меню под полем ввода», «видны поверх клавиатуры Telegram»),
 * which sent operators looking for a keyboard the bot does not have and an
 * editor that is not there. Every dictionary that names the node is checked.
 */
import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/en'
import { ru } from '@/i18n/ru'
import { en as botMapEn } from '@/i18n/features/botMap.en'
import { ru as botMapRu } from '@/i18n/features/botMap.ru'
import { keyPaths, valueAt } from '@/test/i18n-key-paths'

const DICTIONARIES = [
  ['ru', ru],
  ['en', en],
  ['botMap.ru', botMapRu],
  ['botMap.en', botMapEn],
] as const

/** «Reply-клавиатура», «reply keyboard», «Reply-keyboard»… */
const REPLY_KEYBOARD = /reply[\s-]?(клавиатур|keyboard)/i
/** «под полем ввода», «under the chat input», «поверх клавиатуры Telegram», «above the Telegram keyboard». */
const UNDER_THE_INPUT = /под полем ввода|chat input|поверх клавиатуры|above the telegram keyboard/i

describe('the main menu’s name', () => {
  it.each(DICTIONARIES)('%s: no text calls it a reply keyboard or puts it by the input field', (_name, dictionary) => {
    const offenders = keyPaths(dictionary).filter((path) => {
      const value = valueAt(dictionary, path)
      return typeof value === 'string' && (REPLY_KEYBOARD.test(value) || UNDER_THE_INPUT.test(value))
    })
    expect(offenders).toEqual([])
  })

  it('is «Главное меню» / «Main menu» on the canvas node, in its editor and in «Список»', () => {
    for (const path of ['botStudio.replyKeyboard.nodeTitle', 'botStudio.replyKeyboard.title']) {
      expect(valueAt(ru, path), path).toBe('Главное меню')
      expect(valueAt(en, path), path).toBe('Main menu')
    }
    expect(valueAt(botMapRu, 'botMapPage.replyKeyboard.title')).toBe('Главное меню')
    expect(valueAt(botMapEn, 'botMapPage.replyKeyboard.title')).toBe('Main menu')
    expect(valueAt(botMapRu, 'botMapPage.destination.mainMenu')).toBe('→ Главное меню')
    expect(valueAt(botMapEn, 'botMapPage.destination.mainMenu')).toBe('→ Main menu')
  })
})
