/**
 * The pack editor must refuse an entry that cannot reach a Telegram user.
 *
 * Only `fallback` + `customEmojiId` leave the panel; the stored image is a
 * panel/cabinet asset. An entry with neither field is what a plain sticker-set
 * import produces (only `addemoji` sets carry `custom_emoji_id`), and every
 * renderer downstream leaves its `:slug:` token in the message as literal text.
 * The row used to accept that state silently, so the operator saw a saved
 * emoji and the user read the shortcode.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import CustomEmojiPage from './custom-emoji-page'

interface EmojiFixture {
  readonly fallback: string | null
  readonly customEmojiId: string | null
}

function mockPacks(emoji: EmojiFixture): void {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/custom-emoji/packs') {
      return {
        data: [
          {
            id: 'pack-1',
            name: 'TG iOS/macOS Icons',
            emojis: [
              {
                slug: 'tg_ios_macos_icons_25',
                name: 'TG iOS/macOS Icons 25',
                imageUrl: '/uploads/emoji/icon-25.webp',
                lottieUrl: null,
                videoUrl: null,
                fallback: emoji.fallback,
                customEmojiId: emoji.customEmojiId,
              },
            ],
          },
        ],
      }
    }
    return { data: [] }
  })
}

async function openPack(): Promise<void> {
  const user = userEvent.setup()
  await user.click(await screen.findByText('TG iOS/macOS Icons'))
}

describe('custom emoji pack editor deliverability', () => {
  it('blocks saving an entry with neither a glyph nor a custom_emoji_id', async () => {
    mockPacks({ fallback: null, customEmojiId: null })
    const patchSpy = vi.spyOn(api, 'patch')
    renderWithProviders(<CustomEmojiPage />)
    await openPack()

    const save = screen.getByRole('button', { name: 'Save emoji' })
    expect(save).toBeDisabled()
    expect(
      screen.getByText(/the bot sends the raw :shortcode: as text instead of an emoji/),
    ).toBeInTheDocument()

    await userEvent.setup().click(save)
    expect(patchSpy).not.toHaveBeenCalled()
  })

  it('blocks a custom_emoji_id that is not the numeric Telegram id', async () => {
    mockPacks({ fallback: '📣', customEmojiId: null })
    renderWithProviders(<CustomEmojiPage />)
    await openPack()

    const user = userEvent.setup()
    await user.type(
      screen.getByRole('textbox', { name: 'custom_emoji_id (opt.)' }),
      ':tg_ios_macos_icons_25:',
    )

    expect(screen.getByRole('button', { name: 'Save emoji' })).toBeDisabled()
    expect(screen.getByText(/custom_emoji_id must be digits only/)).toBeInTheDocument()
  })

  it('lets an entry that has only a custom_emoji_id save — the star carries it', async () => {
    // reiwa delivers this state (emoji-utils.ts:312), so the panel must not
    // refuse it. The row previously disabled Save and named it undeliverable.
    mockPacks({ fallback: null, customEmojiId: '5188621441926438751' })
    renderWithProviders(<CustomEmojiPage />)
    await openPack()

    expect(screen.getByRole('button', { name: 'Save emoji' })).toBeEnabled()
    expect(screen.queryByText(/Add a fallback glyph/)).not.toBeInTheDocument()
    expect(screen.queryByText(/raw :shortcode:/)).not.toBeInTheDocument()
  })

  it('says a glyph-only entry will not arrive as the pack animation', async () => {
    mockPacks({ fallback: '📣', customEmojiId: null })
    renderWithProviders(<CustomEmojiPage />)
    await openPack()

    expect(screen.getByRole('button', { name: 'Save emoji' })).toBeEnabled()
    expect(
      screen.getByText(/the bot sends the fallback glyph, not this animation/),
    ).toBeInTheDocument()
  })

  it('leaves a fully configured entry alone', async () => {
    mockPacks({ fallback: '📣', customEmojiId: '5188621441926438751' })
    renderWithProviders(<CustomEmojiPage />)
    await openPack()

    expect(screen.getByRole('button', { name: 'Save emoji' })).toBeEnabled()
    expect(screen.queryByText(/the bot sends the fallback glyph/)).not.toBeInTheDocument()
    expect(screen.queryByText(/raw :shortcode:/)).not.toBeInTheDocument()
  })
})
