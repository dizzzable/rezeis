/**
 * «Тексты»: deleting one of the panel's default texts is a RESET.
 *
 * The seed writes a default text again at the next panel start whenever it is
 * missing (`DEFAULT_TEXT_KEYS`, server), and until then the bot speaks its
 * built-in text for the key — the same default. «Удалить» over such a row
 * promised something that does not happen (the row is back after a restart),
 * so the dialog names the button «Вернуть стандартный текст», says the text
 * comes back after a panel restart, and says «возвращён к стандартному» when
 * done. A text of the operator's own keeps «Удалить»: it is gone for good.
 *
 * The list is read through the real `botConfigApi.listTexts`, whose zod schema
 * would strip a field it does not declare — the flag has to survive it.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { EMOJI_TIMESTAMP, emojiStudioPayload, packsPayload } from '@/features/custom-emoji/emoji-catalog.fixtures'
import { renderWithProviders } from '@/test/test-utils'

import { BotTextsTab } from './bot-texts-tab'

beforeAll(async () => {
  // The words live in the bundle the «Карта бота» route loads.
  await loadFeatureBundle('botMap')
})

afterEach(() => {
  vi.restoreAllMocks()
})

function mockRow(extra: Record<string, unknown>): void {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/bot-config/texts') {
      return {
        data: [
          {
            id: 'text-1',
            key: 'channel.verified',
            value: 'Своя подпись',
            visible: true,
            valueEn: null,
            createdAt: EMOJI_TIMESTAMP,
            updatedAt: EMOJI_TIMESTAMP,
            ...extra,
          },
        ],
      }
    }
    if (path === '/admin/custom-emoji/packs') return packsPayload([])
    if (path === '/admin/bot-config/emoji-studio') return emojiStudioPayload()
    return { data: [] }
  })
}

async function openDialog() {
  renderWithProviders(<BotTextsTab />)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Edit' }))
  return { user, dialog: await screen.findByRole('dialog') }
}

/** The words, checked to be words and not the key i18next falls back to. */
function words(key: string): string {
  const text = i18n.t(key)
  expect(text, key).not.toBe(key)
  return text
}

describe('«Тексты»: deleting a default text resets it', () => {
  it('a default text offers «Вернуть стандартный текст», says it comes back after a restart, and says it was reset', async () => {
    mockRow({ isDefault: true })
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: undefined })
    const success = vi.spyOn(toast, 'success')
    const { user, dialog } = await openDialog()

    expect(within(dialog).queryByRole('button', { name: words('botConfigPage.texts.delete') })).toBeNull()
    expect(within(dialog).getByText(words('botConfigPage.texts.resetToDefaultHint'))).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: words('botConfigPage.texts.resetToDefault') }))

    expect(post).toHaveBeenCalledWith('/admin/bot-config/texts/text-1/delete')
    await vi.waitFor(() => expect(success).toHaveBeenCalledWith(words('botConfigPage.texts.toasts.resetToDefault')))
  })

  it.each([
    ['a text of the operator’s own', { isDefault: false }],
    ['a row from a panel that does not say', {}],
  ])('%s keeps «Удалить», and no word of a reset', async (_label, extra) => {
    mockRow(extra)
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: undefined })
    const success = vi.spyOn(toast, 'success')
    const { user, dialog } = await openDialog()

    expect(within(dialog).queryByRole('button', { name: words('botConfigPage.texts.resetToDefault') })).toBeNull()
    expect(within(dialog).queryByText(words('botConfigPage.texts.resetToDefaultHint'))).toBeNull()

    await user.click(within(dialog).getByRole('button', { name: words('botConfigPage.texts.delete') }))

    expect(post).toHaveBeenCalledWith('/admin/bot-config/texts/text-1/delete')
    await vi.waitFor(() => expect(success).toHaveBeenCalledWith(words('botConfigPage.texts.toasts.deleted')))
  })

  it.each([
    ['ru', /перезапуск/],
    ['en', /restart/],
  ])('says in %s that the default text comes back after a panel restart', async (language, restart) => {
    await i18n.changeLanguage(language)
    await loadFeatureBundle('botMap')
    expect(words('botConfigPage.texts.resetToDefaultHint')).toMatch(restart)
    words('botConfigPage.texts.resetToDefault')
    words('botConfigPage.texts.toasts.resetToDefault')
    await i18n.changeLanguage('en')
  })
})
