/**
 * «Меню обновилось» (`menu.updated`) is the toast reiwa answers an old button
 * with, and Telegram takes a toast at no more than 200 characters, counted as
 * code points. A longer one made the answer fail in the bot, and the old button
 * got no menu at all (review R2a-08). Both places the operator writes it —
 * «Карта бота» (`TextKeyEditor`) and the «Тексты» tab — say so under the field
 * and do not save it; the server refuses the same (`bot-texts.service.ts`).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { EMOJI_TIMESTAMP, emojiStudioPayload, packsPayload } from '@/features/custom-emoji/emoji-catalog.fixtures'
import { renderWithProviders } from '@/test/test-utils'
import { TextKeyEditor } from '@/features/bot-flow/components/SystemScreenTexts'

import { BotTextsTab } from './bot-texts-tab'
import { botTextMaxChars, botTextOverLimit, telegramCharCount } from './bot-text-limits'

beforeAll(async () => {
  // The words live in the bundle the «Карта бота» route loads.
  await loadFeatureBundle('botMap')
})

afterEach(() => {
  vi.restoreAllMocks()
})

function mockTexts(key: string, value: string): void {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/bot-config/texts') {
      return {
        data: [
          { id: 'text-1', key, value, visible: true, valueEn: null, createdAt: EMOJI_TIMESTAMP, updatedAt: EMOJI_TIMESTAMP },
        ],
      }
    }
    if (path === '/admin/custom-emoji/packs') return packsPayload([])
    if (path === '/admin/bot-config/emoji-studio') return emojiStudioPayload()
    return { data: [] }
  })
}

/** The words under the field, checked to be words and not the key i18next falls back to. */
function tooLongText(count: number): string {
  const text = i18n.t('botFlow.screenTexts.tooLong', { max: 200, count })
  expect(text).not.toContain('botFlow.screenTexts')
  expect(text).toContain('200')
  return text
}

describe('the limit itself', () => {
  it('is 200 characters for menu.updated alone, counted as code points', () => {
    expect(botTextMaxChars('menu.updated')).toBe(200)
    expect(botTextMaxChars(' MENU.UPDATED ')).toBe(200)
    expect(botTextMaxChars('menu.choose_action')).toBeUndefined()
    expect(telegramCharCount('🔥'.repeat(200))).toBe(200)
    expect(botTextOverLimit('menu.updated', '🔥'.repeat(200))).toBeNull()
    expect(botTextOverLimit('menu.updated', 'М'.repeat(201))).toEqual({ max: 200, count: 201 })
    expect(botTextOverLimit('menu.choose_action', 'М'.repeat(9000))).toBeNull()
  })
})

describe('«Карта бота»: the editor of menu.updated', () => {
  it('says why a text over 200 characters will not be saved, and does not save it', async () => {
    mockTexts('menu.updated', 'Меню обновилось')
    renderWithProviders(<TextKeyEditor textKey="menu.updated" />)
    const field = await screen.findByDisplayValue('Меню обновилось')
    const save = screen.getByRole('button', { name: i18n.t('botFlow.screenTexts.save') })

    fireEvent.change(field, { target: { value: 'М'.repeat(201) } })

    expect(screen.getByRole('alert')).toHaveTextContent(tooLongText(201))
    expect(screen.getByTestId('text-length-count')).toHaveTextContent('201/200')
    expect(save).toBeDisabled()

    // 200 characters of emoji — 400 UTF-16 units — fit.
    fireEvent.change(field, { target: { value: '🔥'.repeat(200) } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(save).toBeEnabled()
  })

  it('leaves any other text at the general limit, with no count under it', async () => {
    mockTexts('menu.choose_action', 'Выберите действие')
    renderWithProviders(<TextKeyEditor textKey="menu.choose_action" />)
    const field = await screen.findByDisplayValue('Выберите действие')

    fireEvent.change(field, { target: { value: 'М'.repeat(201) } })

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByTestId('text-length-count')).toBeNull()
    expect(screen.getByRole('button', { name: i18n.t('botFlow.screenTexts.save') })).toBeEnabled()
  })
})

describe('the «Тексты» tab: editing menu.updated', () => {
  it('says why a text over 200 characters will not be saved, and does not save it', async () => {
    mockTexts('menu.updated', 'Меню обновилось')
    renderWithProviders(<BotTextsTab />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog')
    const field = within(dialog).getByDisplayValue('Меню обновилось')
    const save = within(dialog).getByRole('button', { name: i18n.t('botConfigPage.texts.save') })

    fireEvent.change(field, { target: { value: 'М'.repeat(201) } })

    expect(within(dialog).getByRole('alert')).toHaveTextContent(tooLongText(201))
    expect(within(dialog).getByText('201/200')).toBeInTheDocument()
    expect(save).toBeDisabled()

    fireEvent.change(field, { target: { value: 'Меню обновилось!' } })
    expect(within(dialog).queryByRole('alert')).toBeNull()
    expect(save).toBeEnabled()
  })
})
