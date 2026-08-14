/**
 * What a token may be DRAWN as inside an editable field.
 *
 * The field is where the operator forms an intention, so a rendering that
 * flatters the value is worse than the raw shortcode: it teaches them the
 * message is finished. Two renderers decide the truth and they disagree —
 * bot copy may carry `custom_emoji` entities, an inline-button caption may
 * not — so both are pinned here, against reiwa
 * `src/infrastructure/bot-config/emoji-utils.ts` (`renderBotCopyHtml`,
 * `renderButtonLabel`).
 */
import { describe, expect, it } from 'vitest'

import {
  hasRenderedEmoji,
  renderEmojiField,
  type EmojiFieldContext,
  type EmojiFieldMode,
  type EmojiFieldPart,
  type FieldPackEmoji,
  type FieldSlotEmoji,
} from './emoji-field-render'

const LIVE: FieldPackEmoji = {
  slug: 'tg_ios_macos_icons_25',
  imageUrl: '/uploads/emoji/icon-25.webp',
  fallback: '📣',
  customEmojiId: '5188621441926438751',
}
const GLYPH_ONLY: FieldPackEmoji = {
  slug: 'tg_ios_macos_icons_26',
  imageUrl: '/uploads/emoji/icon-26.webp',
  fallback: '📣',
  customEmojiId: null,
}
const DEAD: FieldPackEmoji = {
  slug: 'tg_ios_macos_icons_27',
  imageUrl: '/uploads/emoji/icon-27.webp',
  fallback: null,
  customEmojiId: null,
}
const ID_ONLY: FieldPackEmoji = {
  slug: 'tg_ios_macos_icons_28',
  imageUrl: '/uploads/emoji/icon-28.webp',
  fallback: null,
  customEmojiId: '5188621441926438752',
}
const SLOT: FieldSlotEmoji = { key: 'CARD', unicode: '💳', tgEmojiId: '5188621441926438753' }

function context(
  mode: EmojiFieldMode,
  ownerHasPremium = true,
  emojis: readonly FieldPackEmoji[] = [LIVE, GLYPH_ONLY, DEAD, ID_ONLY],
): EmojiFieldContext {
  return {
    slugs: new Map(emojis.map((emoji) => [emoji.slug, emoji])),
    slots: new Map([[SLOT.key, SLOT]]),
    mode,
    ownerHasPremium,
  }
}

/** Concatenate a render back into the string it came from. */
function reassemble(value: string, mode: EmojiFieldMode, ownerHasPremium = true): string {
  const render = renderEmojiField(value, context(mode, ownerHasPremium))
  const body = render.parts
    .map((part: EmojiFieldPart) => (part.kind === 'text' ? part.text : part.token))
    .join('')
  return render.icon === null ? body : render.icon.token + body
}

describe('bot copy fields', () => {
  it('draws the pack picture only for a token that really arrives as a custom emoji', () => {
    const render = renderEmojiField(':tg_ios_macos_icons_25: Go to channel', context('text'))
    expect(render.parts[0]).toEqual({
      kind: 'image',
      token: ':tg_ios_macos_icons_25:',
      imageUrl: '/uploads/emoji/icon-25.webp',
    })
    expect(render.parts[1]).toEqual({ kind: 'text', text: ' Go to channel' })
  })

  it('shows the glyph, not the picture, when the entry has no custom_emoji_id', () => {
    const render = renderEmojiField(':tg_ios_macos_icons_26:', context('text'))
    expect(render.parts).toEqual([
      { kind: 'glyph', token: ':tg_ios_macos_icons_26:', glyph: '📣' },
    ])
  })

  it('shows the glyph for every token when the bot owner has no Premium', () => {
    const render = renderEmojiField(':tg_ios_macos_icons_25:', context('text', false))
    expect(render.parts).toEqual([{ kind: 'glyph', token: ':tg_ios_macos_icons_25:', glyph: '📣' }])
  })

  it('carries an id-only entry on the star, never on an empty glyph', () => {
    // The entry has no fallback of its own, so the star IS its carrier: with
    // Premium the pack art rides on it, without Premium the star is the whole
    // of what the recipient reads. All three reiwa renderers substitute '⭐'
    // here (emoji-utils.ts:198, :312, :396); drawing an empty glyph told the
    // operator the token vanishes when in fact the emoji arrives.
    expect(renderEmojiField(':tg_ios_macos_icons_28:', context('text')).parts).toEqual([
      { kind: 'image', token: ':tg_ios_macos_icons_28:', imageUrl: '/uploads/emoji/icon-28.webp' },
    ])
    expect(renderEmojiField(':tg_ios_macos_icons_28:', context('text', false)).parts).toEqual([
      { kind: 'glyph', token: ':tg_ios_macos_icons_28:', glyph: '⭐' },
    ])
  })

  it('leaves an undeliverable token as literal text, because that is what is sent', () => {
    const render = renderEmojiField(':tg_ios_macos_icons_27:', context('text'))
    expect(render.parts).toEqual([
      { kind: 'raw', token: ':tg_ios_macos_icons_27:', reason: 'undeliverable' },
    ])
  })

  it('leaves a shortcode no pack defines as literal text', () => {
    const render = renderEmojiField(':tg_ios_macos_icons_52:', context('text'))
    expect(render.parts).toEqual([
      { kind: 'raw', token: ':tg_ios_macos_icons_52:', reason: 'unknown' },
    ])
  })

  it('never promotes a leading token in bot copy — a message keeps its emoji inline', () => {
    const render = renderEmojiField(':tg_ios_macos_icons_25: Go to channel', context('text'))
    expect(render.icon).toBeNull()
  })
})

describe('inline-button captions', () => {
  it('lifts a leading shortcode out of the caption into the button icon', () => {
    // reiwa strips it from the caption and sends it as `icon_custom_emoji_id`,
    // so Telegram draws it BEFORE the caption — never inside the string.
    const render = renderEmojiField(':tg_ios_macos_icons_25: Go to channel', context('buttonLabel'))
    expect(render.icon).toEqual({
      token: ':tg_ios_macos_icons_25:',
      imageUrl: '/uploads/emoji/icon-25.webp',
      glyph: '📣',
    })
    expect(render.parts).toEqual([{ kind: 'text', text: 'Go to channel' }])
  })

  it('draws every other token in the caption as a glyph — a caption carries no entity', () => {
    const render = renderEmojiField(
      'Go to channel :tg_ios_macos_icons_25:',
      context('buttonLabel'),
    )
    expect(render.icon).toBeNull()
    expect(render.parts).toEqual([
      { kind: 'text', text: 'Go to channel ' },
      { kind: 'glyph', token: ':tg_ios_macos_icons_25:', glyph: '📣' },
    ])
  })

  it('keeps the leading token inline when the owner has no Premium', () => {
    // No Premium, no `icon_custom_emoji_id` — the glyph stays in the caption.
    const render = renderEmojiField(
      ':tg_ios_macos_icons_25: Go to channel',
      context('buttonLabel', false),
    )
    expect(render.icon).toBeNull()
    expect(render.parts[0]).toEqual({
      kind: 'glyph',
      token: ':tg_ios_macos_icons_25:',
      glyph: '📣',
    })
  })

  it('keeps the leading token inline when stripping it would empty the caption', () => {
    // Telegram rejects an empty button label, so reiwa does not promote here.
    const render = renderEmojiField(':tg_ios_macos_icons_25:', context('buttonLabel'))
    expect(render.icon).toBeNull()
    expect(render.parts).toEqual([
      { kind: 'glyph', token: ':tg_ios_macos_icons_25:', glyph: '📣' },
    ])
  })

  it('does not promote a leading token that has no custom_emoji_id behind it', () => {
    const render = renderEmojiField(':tg_ios_macos_icons_26: Go to channel', context('buttonLabel'))
    expect(render.icon).toBeNull()
  })

  it('substitutes the star carrier reiwa uses for an id-only entry', () => {
    const render = renderEmojiField('Go :tg_ios_macos_icons_28:', context('buttonLabel'))
    expect(render.parts[1]).toEqual({
      kind: 'glyph',
      token: ':tg_ios_macos_icons_28:',
      glyph: '⭐',
    })
  })

  it('promotes a leading {{KEY}} slot the same way', () => {
    const render = renderEmojiField('{{CARD}} Pay', context('buttonLabel'))
    expect(render.icon).toEqual({ token: '{{CARD}}', imageUrl: null, glyph: '💳' })
    expect(render.parts).toEqual([{ kind: 'text', text: 'Pay' }])
  })
})

describe('the rendering is a view, never an edit', () => {
  const VALUES = [
    '',
    'plain copy with no tokens',
    ':tg_ios_macos_icons_25: Go to channel',
    '  :tg_ios_macos_icons_25:   Go to channel',
    'a :tg_ios_macos_icons_52: b {{CARD}} c :tg_ios_macos_icons_27:',
    '{{CARD}} Pay now\nsecond line',
  ] as const

  it('reassembles byte-identical to the stored value for copy fields', () => {
    for (const value of VALUES) {
      expect(reassemble(value, 'text')).toBe(value)
    }
  })

  it('reassembles byte-identical for a caption with nothing to promote', () => {
    for (const value of VALUES) {
      // With no Premium nothing is ever lifted out, so a caption behaves
      // exactly like copy: every character is accounted for.
      expect(reassemble(value, 'buttonLabel', false)).toBe(value)
    }
  })

  it('drops nothing from a promoted caption but the padding the bot drops too', () => {
    // `renderButtonLabel` strips the leading token AND the whitespace around
    // it (`body = stripped`), so the padding is genuinely absent from what
    // Telegram draws. Nothing else may go missing.
    expect(reassemble('  :tg_ios_macos_icons_25:   Go to channel', 'buttonLabel')).toBe(
      ':tg_ios_macos_icons_25:Go to channel',
    )
  })
})

describe('hasRenderedEmoji', () => {
  it('is false for copy the field would draw unchanged, so no layer goes up', () => {
    expect(hasRenderedEmoji(renderEmojiField('just words', context('text')))).toBe(false)
    expect(hasRenderedEmoji(renderEmojiField('', context('text')))).toBe(false)
  })

  it('is true as soon as one token resolves to anything', () => {
    expect(hasRenderedEmoji(renderEmojiField(':tg_ios_macos_icons_25:', context('text')))).toBe(true)
    // Even an undeliverable one: the field must mark it.
    expect(hasRenderedEmoji(renderEmojiField(':nope_at_all:', context('text')))).toBe(true)
  })
})
