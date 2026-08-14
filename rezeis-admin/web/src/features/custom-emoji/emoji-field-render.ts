/**
 * Emoji field rendering (pure, no React/DOM)
 * ──────────────────────────────────────────
 * Turns a stored token string into the pieces a panel FIELD should draw, so
 * the operator reads the copy the way Telegram will draw it instead of
 * `:tg_ios_macos_icons_25:`.
 *
 * This module decides only WHAT each token becomes. It never rewrites the
 * value: `parts` is a view over the same string, and the field itself keeps
 * holding the untouched `:slug:` / `{{KEY}}` text that goes to the server.
 *
 * Two renderers consume these tokens downstream and they do NOT agree with
 * each other, which is the whole reason this file exists:
 *
 *   • BOT COPY (`renderBotCopy` / `renderBotCopyHtml`) — a message can carry
 *     `custom_emoji` entities, so a pack entry with an id really does arrive as
 *     the animated emoji. That is exactly what `resolveEmojiDelivery` already
 *     models, so `mode: 'text'` defers to it rather than restating the rules.
 *
 *   • BUTTON LABELS (`renderButtonLabel`, reiwa
 *     `src/infrastructure/bot-config/emoji-utils.ts:356-402`) — inline-button
 *     text cannot carry a custom-emoji entity at all. A LEADING token is
 *     lifted out of the caption into Bot API 9.4 `icon_custom_emoji_id` and
 *     appears as a separate icon BEFORE the caption; every other token in the
 *     same caption is substituted as a plain glyph. Drawing a leading token
 *     inline would be a new lie in place of the old one, so `mode:
 *     'buttonLabel'` reports it separately as `icon` and hands back a body
 *     with the token (and its trailing space) already removed — the same
 *     `body = stripped` the bot performs.
 *
 * A custom emoji never travels alone: Telegram draws it OVER an ordinary
 * carrier glyph, so every renderer needs one. All three of reiwa's pick it the
 * same way (emoji-utils.ts:198, :312, :396), and so does this file:
 *
 *     carrier = the entry's own fallback glyph, else '⭐' when it has a
 *               `custom_emoji_id`, else nothing — the token is undeliverable
 *
 * So an entry with an id but NO glyph of its own is fully deliverable, and the
 * star is only what its artwork is painted on. In copy for a Premium owner it
 * arrives as the animated emoji (drawn here as the pack picture); everywhere
 * the animation cannot go — a non-Premium owner, an inline-button caption —
 * the star itself is what the recipient reads, and drawing an empty glyph for
 * it would claim the token vanishes when in fact the emoji shows up.
 *
 * Two more points, both faithful to the renderer named:
 *   • Promotion to a button icon only needs an id — not a glyph, not a numeric
 *     id (emoji-utils.ts:370). The panel refuses to save a non-numeric id
 *     elsewhere, so it is not re-checked here. A promoted icon carries no
 *     carrier at all: `icon_custom_emoji_id` is its own field, not a glyph
 *     with a tag around it, so `icon.glyph` stays null for a pack shortcode.
 *   • A non-Premium owner gets no `<tg-emoji>` and no `icon_custom_emoji_id`
 *     at all: every token degrades to its carrier, in copy and in captions.
 */
import { resolveEmojiDelivery } from './emoji-delivery'
import { parseTokens } from './emoji-token-text'

/** The pack fields a field rendering needs: the panel art plus what ships. */
export interface FieldPackEmoji {
  readonly slug: string
  /** Panel-side artwork. Never leaves the panel — only ever drawn here. */
  readonly imageUrl: string
  readonly fallback: string | null
  readonly customEmojiId: string | null
}

/** A `{{KEY}}` slot from the bot-config emoji catalog. */
export interface FieldSlotEmoji {
  readonly key: string
  readonly unicode: string
  readonly tgEmojiId: string | null
}

/**
 * Which renderer the field's value is destined for.
 *   • `text`        — bot copy / broadcast body: entities are allowed.
 *   • `buttonLabel` — inline-button caption: no entities, leading token is
 *                     promoted to the button's own icon.
 */
export type EmojiFieldMode = 'text' | 'buttonLabel'

/** Why a token is still shown as literal text. */
export type EmojiFieldRawReason =
  /** No pack/catalog entry defines it. */
  | 'unknown'
  /** Defined, but carries nothing that can reach the user. */
  | 'undeliverable'

/** One drawable piece of the field. */
export type EmojiFieldPart =
  | { readonly kind: 'text'; readonly text: string }
  /** Draw the pack picture: this token really does arrive as a custom emoji. */
  | { readonly kind: 'image'; readonly token: string; readonly imageUrl: string }
  /** Draw the glyph the user will actually read. */
  | { readonly kind: 'glyph'; readonly token: string; readonly glyph: string }
  /** Leave the shortcode visible — that is what the user receives. */
  | { readonly kind: 'raw'; readonly token: string; readonly reason: EmojiFieldRawReason }

/**
 * A leading token lifted out of a button caption into the button's icon.
 * `imageUrl` is set for a pack shortcode, `glyph` for a `{{KEY}}` slot.
 */
export interface EmojiFieldIcon {
  readonly token: string
  readonly imageUrl: string | null
  readonly glyph: string | null
}

export interface EmojiFieldRender {
  /** Non-null only in `buttonLabel` mode, and only when reiwa would promote. */
  readonly icon: EmojiFieldIcon | null
  /** The caption/copy itself, with the promoted token already removed. */
  readonly parts: readonly EmojiFieldPart[]
}

export interface EmojiFieldContext {
  readonly slugs: ReadonlyMap<string, FieldPackEmoji>
  readonly slots: ReadonlyMap<string, FieldSlotEmoji>
  readonly mode: EmojiFieldMode
  readonly ownerHasPremium: boolean
}

/** Same shapes reiwa uses to spot a promotable leading token. */
const LEADING_SLUG = /^\s*:([a-z0-9_]+):\s*/
const LEADING_SLOT = /^\s*\{\{([A-Z0-9_]+)\}\}\s*/

/** The carrier every reiwa renderer substitutes for an id-only entry. */
const ID_ONLY_CARRIER = '⭐'

function trimmed(value: string | null): string {
  return value === null ? '' : value.trim()
}

function hasCustomEmojiId(emoji: FieldPackEmoji): boolean {
  return trimmed(emoji.customEmojiId).length > 0
}

/**
 * The glyph the recipient actually reads for this entry — reiwa's carrier rule,
 * identical in all three of its renderers (emoji-utils.ts:198, :312, :396):
 * the operator's own fallback, else the star an id-only entry rides on. Empty
 * only for an entry that carries neither field and so delivers nothing.
 */
function carrierGlyph(emoji: FieldPackEmoji): string {
  const glyph = trimmed(emoji.fallback)
  if (glyph.length > 0) return glyph
  return hasCustomEmojiId(emoji) ? ID_ONLY_CARRIER : ''
}

/**
 * Resolve a value into drawable pieces. Total: any string produces a render,
 * and concatenating `parts`' `text`/`token` back together (plus `icon.token`)
 * returns the input — the rendering is a view, never an edit.
 */
export function renderEmojiField(value: string, context: EmojiFieldContext): EmojiFieldRender {
  const promoted = context.mode === 'buttonLabel' ? promoteLeadingIcon(value, context) : null
  const body = promoted === null ? value : promoted.body

  const parts: EmojiFieldPart[] = []
  for (const segment of parseTokens(body)) {
    if (segment.type === 'text') {
      parts.push({ kind: 'text', text: segment.text })
    } else if (segment.kind === 'slug') {
      parts.push(renderSlug(segment.raw, segment.name, context))
    } else {
      parts.push(renderSlot(segment.raw, segment.name, context))
    }
  }

  return { icon: promoted === null ? null : promoted.icon, parts }
}

/** True when the render has anything to show beyond the plain text. */
export function hasRenderedEmoji(render: EmojiFieldRender): boolean {
  return render.icon !== null || render.parts.some((part) => part.kind !== 'text')
}

function renderSlug(token: string, slug: string, context: EmojiFieldContext): EmojiFieldPart {
  const emoji = context.slugs.get(slug)
  if (emoji === undefined) return { kind: 'raw', token, reason: 'unknown' }

  const glyph = carrierGlyph(emoji)

  if (context.mode === 'buttonLabel') {
    // A caption carries no entities, so the pack picture is never what the
    // user sees here — only the glyph reiwa substitutes in its place.
    if (glyph.length > 0) return { kind: 'glyph', token, glyph }
    return { kind: 'raw', token, reason: 'undeliverable' }
  }

  switch (resolveEmojiDelivery(emoji)) {
    case 'premium':
      // The animation is Premium-gated; without it the carrier is all that
      // ships — the star included, for an entry that has no glyph of its own.
      return context.ownerHasPremium
        ? { kind: 'image', token, imageUrl: emoji.imageUrl }
        : { kind: 'glyph', token, glyph }
    case 'glyph':
      return { kind: 'glyph', token, glyph }
    default:
      return { kind: 'raw', token, reason: 'undeliverable' }
  }
}

function renderSlot(token: string, key: string, context: EmojiFieldContext): EmojiFieldPart {
  const slot = context.slots.get(key)
  if (slot === undefined) return { kind: 'raw', token, reason: 'unknown' }
  // A slot's premium id only animates the glyph it wraps, so the glyph is
  // what the field shows either way.
  return { kind: 'glyph', token, glyph: slot.unicode }
}

/**
 * Mirror of `renderButtonLabel`'s promotion step: a Premium owner, a leading
 * token with an id behind it, and enough caption left over that Telegram will
 * not reject the button.
 */
function promoteLeadingIcon(
  value: string,
  context: EmojiFieldContext,
): { readonly icon: EmojiFieldIcon; readonly body: string } | null {
  if (!context.ownerHasPremium) return null

  const slugMatch = LEADING_SLUG.exec(value)
  if (slugMatch !== null) {
    const emoji = context.slugs.get(slugMatch[1])
    const body = value.slice(slugMatch[0].length)
    if (emoji !== undefined && hasCustomEmojiId(emoji) && body.trim().length > 0) {
      const glyph = trimmed(emoji.fallback)
      return {
        icon: {
          token: `:${slugMatch[1]}:`,
          imageUrl: emoji.imageUrl,
          glyph: glyph.length > 0 ? glyph : null,
        },
        body,
      }
    }
  }

  const slotMatch = LEADING_SLOT.exec(value)
  if (slotMatch !== null) {
    const slot = context.slots.get(slotMatch[1])
    const body = value.slice(slotMatch[0].length)
    if (slot !== undefined && trimmed(slot.tgEmojiId).length > 0 && body.trim().length > 0) {
      return {
        icon: { token: `{{${slotMatch[1]}}}`, imageUrl: null, glyph: slot.unicode },
        body,
      }
    }
  }

  return null
}
