/**
 * The "Тексты бота" tab must give ONE answer per token, and it must be the
 * answer the key's own renderer will give.
 *
 * Two ways it did not:
 *
 * 1. The tab carried its own copy of the delivery rules — a fifth one — under
 *    every field, directly beneath the shared field layer that already answered
 *    correctly. It never asked whether the bot owner has Premium, and in its
 *    glyph branch it substituted the entry's `fallback` instead of the CARRIER,
 *    so an id-only entry (`fallback: null`) came out blank there and animated in
 *    the preview while the recipient reads a star. One value, two answers, on
 *    one screen. The rules now come from `renderEmojiField` for both, through
 *    `RenderedCopyPreview` — the same component the broadcast composer uses.
 *
 * 2. Every field asked for `mode: 'text'`, but this tab edits ANY key and some
 *    keys are read back as inline-button captions, where reiwa cuts a leading
 *    token out of the string and ships it as `icon_custom_emoji_id`. The same
 *    key opened from the bot-flow inspector was drawn correctly, so one stored
 *    string had two renderings in one panel. `botTextKeyMode` decides now.
 *
 * Each spec below fails against the code as it stood before those two changes.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import {
  EMOJI_TIMESTAMP,
  ID_ONLY_EMOJI,
  LIVE_EMOJI,
  emojiStudioPayload,
  packsPayload,
  type PackEmojiFixture,
} from '@/features/custom-emoji/emoji-catalog.fixtures'
import { BotTextsTab } from './bot-texts-tab'

interface RowFixture {
  /** The key is the whole of defect 2: it names which renderer the value feeds. */
  readonly key: string
  readonly value: string
  readonly emojis: readonly PackEmojiFixture[]
  readonly ownerHasPremium: boolean
}

/**
 * The single text row this tab lists, plus the shared emoji catalog every field
 * layer and preview reads. The catalog payloads come from
 * `@/features/custom-emoji/emoji-catalog.fixtures` so a delivery state added
 * there is not re-invented here with a different shape.
 */
function mockApi({ key, value, emojis, ownerHasPremium }: RowFixture): void {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/bot-config/texts') {
      return {
        data: [
          {
            id: 'text-1',
            key,
            value,
            visible: true,
            valueEn: null,
            createdAt: EMOJI_TIMESTAMP,
            updatedAt: EMOJI_TIMESTAMP,
          },
        ],
      }
    }
    if (path === '/admin/custom-emoji/packs') return packsPayload(emojis)
    if (path === '/admin/bot-config/emoji-studio') return emojiStudioPayload(ownerHasPremium)
    return { data: [] }
  })
}

/**
 * Open the row's editor and step off the field.
 *
 * The dialog autofocuses its textarea and the field layer steps aside for a
 * focused field on purpose — the caret belongs to the field, so nothing may
 * cover it. Moving focus off is what an operator does to READ the value, and it
 * is the state in which the layer and the preview are both on screen and can be
 * compared against each other.
 */
async function openEditorAndLook(): Promise<void> {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Edit' }))
  await user.click(await screen.findByRole('dialog'))
}

describe('the field and the preview under it give one answer', () => {
  /**
   * The reported defect, exactly. `ID_ONLY_EMOJI` carries an id and no glyph of
   * its own, and the owner has no Premium — so no `<tg-emoji>` is emitted and
   * the star the emoji would have been painted on is the character that arrives.
   *
   * The removed preview got this wrong twice over: it never read the Premium
   * flag, so it took the `premium` branch and drew the downloaded artwork, and
   * its `glyph` branch would have printed `(fallback ?? '').trim()` — empty for
   * this entry — had it taken it. The layer one line above said `⭐`.
   */
  it('shows an id-only entry as its carrier, not as artwork, when the owner has no Premium', async () => {
    mockApi({
      key: 'menu.channel',
      value: ':tg_ios_macos_icons_28: Go to channel',
      emojis: [ID_ONLY_EMOJI],
      ownerHasPremium: false,
    })
    renderWithProviders(<BotTextsTab />)
    await openEditorAndLook()

    // Anchors every negative assertion below: the layer only goes up once all
    // three catalog queries have settled. Before that, nothing draws artwork
    // anywhere and "no picture here" would pass without proving anything.
    const field = await screen.findByTestId('emoji-field-overlay')

    // The falsifier. The pack artwork is a panel asset and this entry does not
    // reach the user as a custom emoji at all, so it may not be drawn anywhere
    // on the screen — not by the field, and not by the preview under it.
    expect(screen.queryByAltText(':tg_ios_macos_icons_28:')).not.toBeInTheDocument()

    // And both surfaces say the same thing: the star, which is what is read.
    const preview = screen.getByTestId('rendered-copy-preview')
    expect(field).toHaveTextContent('⭐ Go to channel')
    expect(preview).toHaveTextContent('⭐ Go to channel')
    expect(
      within(preview).getByTitle(/^:tg_ios_macos_icons_28: → fallback glyph/),
    ).toHaveTextContent('⭐')
  })

  /**
   * The other side of the same coin: the state that really does arrive as a
   * custom emoji must keep its picture. Pinned on the SHARED preview rather
   * than on the picture anywhere in the document — under the old code that
   * element was drawn by the tab's own fifth implementation, which is what this
   * change removes, so asking the shared component for it is the assertion.
   */
  it('keeps the pack picture when the entry really does arrive as a custom emoji', async () => {
    mockApi({
      key: 'menu.channel',
      value: ':tg_ios_macos_icons_25: Go to channel',
      emojis: [LIVE_EMOJI],
      ownerHasPremium: true,
    })
    renderWithProviders(<BotTextsTab />)
    await openEditorAndLook()

    await screen.findByTestId('emoji-field-overlay')

    const preview = screen.getByTestId('rendered-copy-preview')
    expect(within(preview).getByAltText(':tg_ios_macos_icons_25:')).toHaveAttribute(
      'src',
      '/uploads/emoji/tg_ios_macos_icons_25.webp',
    )
    expect(preview).toHaveTextContent('Go to channel')
    expect(preview.textContent).not.toContain(':tg_ios_macos_icons_25:')
  })
})

describe('the key decides which renderer the value is drawn for', () => {
  /**
   * `invite.share_button` is read back as an inline-button caption (reiwa
   * `bot/pages/invite.ts:238`). A caption carries no entities: reiwa cuts the
   * leading token out of the string and ships it as `icon_custom_emoji_id`, and
   * Telegram draws it BEFORE the caption. Drawing it inside the caption — which
   * `mode: 'text'` did — shows the operator a button they will not get.
   */
  it('draws a `_button` key as a caption, with its leading token as the button icon', async () => {
    mockApi({
      key: 'invite.share_button',
      value: ':tg_ios_macos_icons_25: Share',
      emojis: [LIVE_EMOJI],
      ownerHasPremium: true,
    })
    renderWithProviders(<BotTextsTab />)
    await openEditorAndLook()

    const field = await screen.findByTestId('emoji-field-overlay')

    // The falsifier: in text mode this token was drawn inline, inside the
    // caption. It does not travel inside the caption.
    expect(within(field).queryByAltText(':tg_ios_macos_icons_25:')).not.toBeInTheDocument()
    expect(field).toHaveTextContent('Share')
    // Nor as its carrier glyph — the token leaves the caption entirely.
    expect(field.textContent).not.toContain('📣')

    // It is drawn once, where the button actually puts it.
    const iconRow = screen.getByTitle(/^:tg_ios_macos_icons_25: leads the caption/)
    expect(within(iconRow).getByAltText(':tg_ios_macos_icons_25:')).toHaveAttribute(
      'src',
      '/uploads/emoji/tg_ios_macos_icons_25.webp',
    )
    expect(screen.getByText('Button icon — not part of the caption')).toBeInTheDocument()

    // And the body-copy preview stays away: it renders message bodies, in text
    // mode, so under a caption key it would be a second and contradicting
    // answer sitting directly below the caption-mode one.
    expect(screen.queryByTestId('rendered-copy-preview')).not.toBeInTheDocument()
  })

  /**
   * Not every caption key carries the suffix. `back_to_menu` is the caption
   * reiwa renders most often — `renderSystemButton(backLabel, 'back', …)` on
   * every screen offering a way back — and a rule built on `_button` alone
   * would draw it as body copy, which is the same defect wearing the other hat.
   */
  it('draws a caption key that carries no `_button` suffix as a caption too', async () => {
    mockApi({
      key: 'back_to_menu',
      value: ':tg_ios_macos_icons_25: Back',
      emojis: [LIVE_EMOJI],
      ownerHasPremium: true,
    })
    renderWithProviders(<BotTextsTab />)
    await openEditorAndLook()

    const field = await screen.findByTestId('emoji-field-overlay')

    expect(within(field).queryByAltText(':tg_ios_macos_icons_25:')).not.toBeInTheDocument()
    expect(field).toHaveTextContent('Back')
    expect(field.textContent).not.toContain('📣')
    expect(screen.getByText('Button icon — not part of the caption')).toBeInTheDocument()
  })

  /**
   * The guard in the other direction, and the reason the rule asks for positive
   * evidence before answering `buttonLabel`. `menu.channel` is body copy: its
   * token really does arrive as a custom emoji, so it is drawn where it will
   * appear — inline — and nothing claims a button icon that does not exist.
   *
   * Anchored on the shared preview, so this also fails against the tab's own
   * removed implementation rather than only against the mode.
   */
  it('leaves ordinary copy in text mode, drawing its token inline', async () => {
    mockApi({
      key: 'menu.channel',
      value: ':tg_ios_macos_icons_25: Go to channel',
      emojis: [LIVE_EMOJI],
      ownerHasPremium: true,
    })
    renderWithProviders(<BotTextsTab />)
    await openEditorAndLook()

    const field = await screen.findByTestId('emoji-field-overlay')

    // Body copy keeps its emoji where the reader will see it…
    expect(within(field).getByAltText(':tg_ios_macos_icons_25:')).toBeInTheDocument()
    // …and no part of it is relabelled as a button icon.
    expect(screen.queryByText('Button icon — not part of the caption')).not.toBeInTheDocument()

    const preview = screen.getByTestId('rendered-copy-preview')
    expect(within(preview).getByAltText(':tg_ios_macos_icons_25:')).toBeInTheDocument()
  })
})
