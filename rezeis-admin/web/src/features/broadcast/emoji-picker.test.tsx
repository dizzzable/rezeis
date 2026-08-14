/**
 * The picker is where the operator GETS the `:slug:` syntax — it is mounted
 * inside the bot-copy "Value" field, and clicking an emoji splices
 * `:${emoji.slug}:` into the text. So it must not offer a shortcode that
 * cannot render: an entry with neither a fallback glyph nor a
 * `custom_emoji_id` is left in the message as literal text by every renderer
 * downstream, which is exactly how `:tg_ios_macos_icons_25: Go to channel`
 * reached a user.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import { EmojiPicker } from './emoji-picker'

function mockPacks(): void {
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
                name: 'Dead entry',
                imageUrl: '/uploads/emoji/icon-25.webp',
                lottieUrl: null,
                videoUrl: null,
                fallback: null,
                customEmojiId: null,
              },
              {
                slug: 'tg_ios_macos_icons_26',
                name: 'Live entry',
                imageUrl: '/uploads/emoji/icon-26.webp',
                lottieUrl: null,
                videoUrl: null,
                fallback: '📣',
                customEmojiId: null,
              },
            ],
          },
        ],
      }
    }
    return { data: [] }
  })
}

async function openPackList(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Insert emoji' }))
  await user.click(await screen.findByRole('button', { name: 'Custom' }))
  await user.click(await screen.findByText('TG iOS/macOS Icons'))
  return user
}

describe('EmojiPicker custom pack entries', () => {
  it('refuses to insert a shortcode that would be delivered as raw text', async () => {
    mockPacks()
    const onSelect = vi.fn()
    renderWithProviders(<EmojiPicker onSelect={onSelect} ariaLabel="Insert emoji" />)
    const user = await openPackList()

    const dead = await screen.findByRole('button', { name: 'Dead entry' })
    expect(dead).toBeDisabled()
    expect(dead).toHaveAttribute(
      'title',
      expect.stringContaining('neither a fallback glyph nor a custom_emoji_id'),
    )

    await user.click(dead)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('still inserts a shortcode that reaches the user', async () => {
    mockPacks()
    const onSelect = vi.fn()
    renderWithProviders(<EmojiPicker onSelect={onSelect} ariaLabel="Insert emoji" />)
    const user = await openPackList()

    await user.click(await screen.findByRole('button', { name: 'Live entry' }))
    expect(onSelect).toHaveBeenCalledWith(':tg_ios_macos_icons_26:')
  })
})
