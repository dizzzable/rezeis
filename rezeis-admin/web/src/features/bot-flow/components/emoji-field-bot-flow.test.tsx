/**
 * The bot-flow screens must draw their emoji — and must not let the drawing
 * become the data.
 *
 * Same guarantees `emoji-field-overlay.test.tsx` states for the bot-config
 * screens, restated over the two inspectors an operator actually edits a flow
 * in. They are kept in their own file because the panels here mount a
 * different set of fetches, and because the shared spec is edited by everyone
 * rolling the layer out.
 *
 * Each spec guards one way this could go wrong:
 *
 *   • a screen's copy must show the pack picture, not `:tg_ios_macos_icons_25:`;
 *   • a BUTTON caption — the flow button's own label, and the bot-text key
 *     behind a system button — must draw its leading token as the button's
 *     separate icon, because reiwa lifts that token into
 *     `icon_custom_emoji_id` and Telegram draws it BEFORE the caption. Drawing
 *     it inline would make the field claim the caption contains something the
 *     user never reads there;
 *   • and the value that leaves for the server after an edit must be the same
 *     token text the operator typed — character for character. That last one
 *     is the important one: it is what stops a rendering from leaking into the
 *     data.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import {
  EMOJI_TIMESTAMP,
  LIVE_EMOJI,
  emojiImageUrl,
  emojiStudioPayload,
  packsPayload,
} from '@/features/custom-emoji/emoji-catalog.fixtures'
import { renderWithProviders } from '@/test/test-utils'

import { ScreenEditorPanel } from './ScreenEditorPanel'
import { SystemScreenTexts, TextKeyEditor } from './SystemScreenTexts'
import type { BotFlowScreen } from '../types'

const TIMESTAMP = EMOJI_TIMESTAMP
const IMAGE = emojiImageUrl(LIVE_EMOJI.slug)
/** A real reiwa key rendered by a system button on the `invite` screen. */
const TEXT_KEY = 'invite.share_button'

/**
 * The shared catalog every field layer reads, plus the single bot-config text
 * row `TextKeyEditor` self-fetches. Anything unrecognised answers an empty
 * array so the panel still mounts with the fetches these specs do not care
 * about.
 */
function mockFlowApi(
  textRow: { readonly value: string; readonly valueEn: string | null } | null = null,
): void {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/custom-emoji/packs') return packsPayload([LIVE_EMOJI])
    if (path === '/admin/bot-config/emoji-studio') return emojiStudioPayload()
    if (path === '/admin/bot-config/texts') {
      return {
        data:
          textRow === null
            ? []
            : [
                {
                  id: 'text-1',
                  key: TEXT_KEY,
                  value: textRow.value,
                  visible: true,
                  valueEn: textRow.valueEn,
                  createdAt: TIMESTAMP,
                  updatedAt: TIMESTAMP,
                },
              ],
      }
    }
    return { data: [] }
  })
}

function flowButton(
  overrides: Partial<BotFlowScreen['buttons'][number]> = {},
): BotFlowScreen['buttons'][number] {
  return {
    id: 'button-1',
    screenId: 'screen-1',
    labelRu: 'Кнопка',
    labelEn: 'Button',
    row: 0,
    col: 0,
    actionType: 'NAVIGATE',
    targetScreenId: null,
    url: null,
    webAppUrl: null,
    callbackAction: null,
    style: 'DEFAULT',
    iconCustomEmojiId: null,
    ...overrides,
  }
}

/**
 * `name: 'start'` on purpose: the built-in names (`invite` / `rules` / `help`)
 * pull in the system-button rows and the whole screen-texts section, so only
 * the field under test carries a token and only one layer is in the document.
 */
function flowScreen(overrides: Partial<BotFlowScreen> = {}): BotFlowScreen {
  return {
    id: 'screen-1',
    shortId: 'A1',
    flowId: 'flow-1',
    name: 'start',
    textRu: 'Privet',
    textEn: 'Hello',
    parseMode: 'HTML',
    mediaType: null,
    mediaFileId: null,
    mediaUrl: null,
    positionX: 0,
    positionY: 0,
    isRoot: true,
    buttons: [],
    ...overrides,
  }
}

describe('a screen copy field draws its emoji', () => {
  it('shows the pack picture in the screen text instead of the shortcode', async () => {
    mockFlowApi()
    renderWithProviders(
      <ScreenEditorPanel
        screen={flowScreen({ textRu: ':tg_ios_macos_icons_25: Privet' })}
        flowName="Main Flow"
      />,
    )

    // The layer goes up as soon as the value holds a token — showing it raw,
    // which is the honest answer until the shared pack catalog lands. So wait
    // for the PICTURE, not for the layer, or the assertion races the fetch.
    const image = await screen.findByAltText(':tg_ios_macos_icons_25:')
    expect(image).toHaveAttribute('src', IMAGE)

    const field = screen.getByTestId('emoji-field-overlay')
    expect(field).toContainElement(image)
    // The words around the token are untouched; only the token is drawn.
    expect(field).toHaveTextContent('Privet')
    expect(field.textContent).not.toContain(':tg_ios_macos_icons_25:')
  })
})

describe('a bot-flow caption draws its leading token where the button puts it', () => {
  it('draws a screen button caption in button mode, not text mode', async () => {
    mockFlowApi()
    renderWithProviders(
      <ScreenEditorPanel
        screen={flowScreen({
          buttons: [flowButton({ labelRu: ':tg_ios_macos_icons_25: Kanal' })],
        })}
        flowName="Main Flow"
      />,
    )

    // Drawn once, on its own, labelled as the button's icon — which is where
    // reiwa puts it. `mode="text"` would have drawn it inside the caption.
    const iconRow = await screen.findByTitle(
      /:tg_ios_macos_icons_25: leads the caption, so the bot moves it into the button's own icon/,
    )
    expect(within(iconRow).getByAltText(':tg_ios_macos_icons_25:')).toHaveAttribute('src', IMAGE)
    expect(screen.getByText('Button icon — not part of the caption')).toBeInTheDocument()

    const field = screen.getByTestId('emoji-field-overlay')
    // …and NOT inside the caption: neither as a picture nor as its carrier glyph.
    expect(within(field).queryByAltText(':tg_ios_macos_icons_25:')).not.toBeInTheDocument()
    expect(field).toHaveTextContent('Kanal')
    expect(field.textContent).not.toContain('📣')
    expect(field.textContent).not.toContain(':tg_ios_macos_icons_25:')
  })

  it('draws a caption key as a caption in the roomy card too, without shrinking it', async () => {
    // The section renders every key of a built-in screen on the default card,
    // and eight of the eighteen `invite` keys are captions. The card and the
    // drawing are separate decisions: the caption card caps input at 64 and
    // drops the key name, and with eighteen rows the key name is the only
    // thing telling them apart — so the card stays, and only the DRAWING
    // follows the key. Getting this wrong either way is a lie: text mode
    // leaves a leading token inline that the bot ships as the button's icon.
    mockFlowApi({ value: ':tg_ios_macos_icons_25: Podelitsya', valueEn: null })
    renderWithProviders(<SystemScreenTexts screenName="invite" />)

    const iconRow = await screen.findByTitle(
      /:tg_ios_macos_icons_25: leads the caption, so the bot moves it into the button's own icon/,
    )
    expect(within(iconRow).getByAltText(':tg_ios_macos_icons_25:')).toHaveAttribute('src', IMAGE)

    // …and the roomy card is still the roomy card: the key is named, and the
    // 8000-character field was not swapped for the 64-character one.
    expect(screen.getByText(TEXT_KEY)).toBeInTheDocument()
    const written = screen.getAllByDisplayValue(':tg_ios_macos_icons_25: Podelitsya')
    expect(written[0]).toHaveAttribute('maxLength', '8000')
  })

  it('draws a system-button text key in button mode, not text mode', async () => {
    mockFlowApi({ value: ':tg_ios_macos_icons_25: Podelitsya', valueEn: null })
    renderWithProviders(<TextKeyEditor textKey={TEXT_KEY} layout="buttonLabel" />)

    const iconRow = await screen.findByTitle(
      /:tg_ios_macos_icons_25: leads the caption, so the bot moves it into the button's own icon/,
    )
    expect(within(iconRow).getByAltText(':tg_ios_macos_icons_25:')).toHaveAttribute('src', IMAGE)
    expect(screen.getByText('Button icon — not part of the caption')).toBeInTheDocument()

    const field = screen.getByTestId('emoji-field-overlay')
    expect(within(field).queryByAltText(':tg_ios_macos_icons_25:')).not.toBeInTheDocument()
    expect(field).toHaveTextContent('Podelitsya')
    expect(field.textContent).not.toContain('📣')
    expect(field.textContent).not.toContain(':tg_ios_macos_icons_25:')
  })
})

describe('the rendering never reaches the server', () => {
  it('saves the screen text as the token text the operator typed, not the drawn form', async () => {
    mockFlowApi()
    const put = vi.spyOn(api, 'put').mockResolvedValue({ data: {} })

    renderWithProviders(
      <ScreenEditorPanel
        screen={flowScreen({ textRu: ':tg_ios_macos_icons_25: Privet' })}
        flowName="Main Flow"
      />,
    )

    // The field really is drawing the emoji before the edit…
    const image = await screen.findByAltText(':tg_ios_macos_icons_25:')
    expect(screen.getByTestId('emoji-field-overlay')).toContainElement(image)

    // …and the value it hands back is still the plain token string.
    const user = userEvent.setup()
    const textarea = screen.getByDisplayValue(':tg_ios_macos_icons_25: Privet')
    await user.type(textarea, '!')
    expect(textarea).toHaveValue(':tg_ios_macos_icons_25: Privet!')

    // The panel saves this field on blur, so leaving it is the save.
    await user.tab()
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/admin/bot-flows/screens/screen-1', {
        textRu: ':tg_ios_macos_icons_25: Privet!',
      }),
    )
  })

  it('saves a bot-text key as the token text the operator typed, not the drawn form', async () => {
    mockFlowApi({ value: ':tg_ios_macos_icons_25: Privet', valueEn: null })
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({
      data: {
        id: 'text-1',
        key: TEXT_KEY,
        value: ':tg_ios_macos_icons_25: Privet!',
        visible: true,
        valueEn: null,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    })

    renderWithProviders(<TextKeyEditor textKey={TEXT_KEY} />)

    // Anchor: something must be drawn before "the drawn form did not leak into
    // the value" means anything. For THIS key it is the icon row rather than a
    // picture inside the field — `invite.share_button` is a caption, so the
    // leading token is lifted out of the body exactly as reiwa lifts it. The
    // assertion used to look for the picture inline, which is the drawing this
    // change corrected; anchoring on it would have pinned the old mistake.
    const iconRow = await screen.findByTitle(
      /:tg_ios_macos_icons_25: leads the caption, so the bot moves it into the button's own icon/,
    )
    expect(within(iconRow).getByAltText(':tg_ios_macos_icons_25:')).toBeInTheDocument()

    const user = userEvent.setup()
    const textarea = screen.getByDisplayValue(':tg_ios_macos_icons_25: Privet')
    await user.type(textarea, '!')
    expect(textarea).toHaveValue(':tg_ios_macos_icons_25: Privet!')

    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/admin/bot-config/texts/text-1', {
        value: ':tg_ios_macos_icons_25: Privet!',
        valueEn: null,
      }),
    )
  })
})
