/**
 * Emoji deliverability (pure, no React/DOM)
 * ─────────────────────────────────────────
 * What a `:slug:` shortcode actually becomes once it leaves the panel.
 *
 * A pack entry carries an image, a `fallback` glyph and a `customEmojiId`, but
 * only the last two ever travel to Telegram: the image is a panel/cabinet
 * asset. What this module answers is what the ENTRY is capable of —
 *
 *   glyph   = trimmed fallback
 *   carrier = glyph, else '⭐' when a customEmojiId is set, else ''
 *   no carrier → nothing reaches the user
 *   id         → the custom emoji, riding on that carrier
 *   otherwise  → the carrier alone
 *
 * — from the same two fields the bot (reiwa) is handed for bot copy.
 *
 * NOT answered here: whether the bot OWNER has Telegram Premium. Without it
 * Telegram rejects a message carrying custom-emoji entities, so both renderers
 * drop to the bare carrier — reiwa in `renderBotCopy`/`renderBotCopyHtml`, the
 * panel in `CustomEmojiService.substituteTelegramHtml`. That is a property of
 * the deployment, not of the entry, and folding it in here would make a record
 * read as broken on a non-Premium install when nothing about it is. Callers
 * apply it on top: `renderEmojiField` draws the carrier instead of the artwork,
 * and `findEmojiSaveProblem` stays premium-blind on purpose, so a record saved
 * today is not refused because a toggle is off this week.
 *
 * The star matters: an entry with an id but no glyph of its own still delivers
 * the custom emoji, because the tag only needs *a* glyph to wrap. reiwa has
 * always done this; the panel used to call the state undeliverable and drop it.
 *
 * Kept pure and separate so the registry editor and the copy preview agree
 * with each other and with delivery, instead of each guessing.
 */

/** The two fields of a pack entry that reach Telegram. */
export interface EmojiDeliveryFields {
  readonly customEmojiId: string | null
  readonly fallback: string | null
}

/** What the recipient actually gets for this shortcode. */
export type EmojiDeliveryOutcome =
  /**
   * Animated custom emoji, with the carrier glyph as its built-in degradation.
   * The carrier is the entry's own fallback, or the star when it has none.
   */
  | 'premium'
  /** The plain carrier glyph — the pack artwork never leaves the panel. */
  | 'glyph'
  /** Nothing at all: the shortcode contributes an empty string. */
  | 'nothing'

/** A save that provably delivers nothing, named by cause. `null` = fine. */
export type EmojiSaveProblem =
  /** Not the numeric Telegram id — silently stripped before sending. */
  | 'id-not-numeric'
  /** Neither field set: there is nothing left to send. */
  | 'nothing-to-deliver'

/** Telegram `custom_emoji_id`: a decimal 64-bit id, digits only. */
const NUMERIC_ID = /^[0-9]{1,32}$/

/** The glyph the renderers wrap when an entry has an id but no fallback. */
const ID_ONLY_CARRIER = '⭐'

function trimmedOrNull(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Mirrors the renderer's defensive `replace(/[^0-9]/g, '')`. */
function deliverableId(value: string | null): string {
  return value === null ? '' : value.replace(/[^0-9]/g, '')
}

/** Resolve what a stored pack entry delivers to a Telegram user. */
export function resolveEmojiDelivery(emoji: EmojiDeliveryFields): EmojiDeliveryOutcome {
  const glyph = trimmedOrNull(emoji.fallback) ?? ''
  const rawId = trimmedOrNull(emoji.customEmojiId) ?? ''
  const carrier = glyph.length > 0 ? glyph : rawId.length > 0 ? ID_ONLY_CARRIER : ''
  if (carrier.length === 0) return 'nothing'
  return deliverableId(rawId).length > 0 ? 'premium' : 'glyph'
}

/**
 * The reason the panel must refuse this save, or `null` when it is fine.
 * Mirrors `assertEmojiIsDeliverable` on the backend so the operator is stopped
 * at the field instead of by a 400 after the round-trip.
 *
 * An id with no glyph is NOT a problem: the renderers carry it on a star, so
 * the emoji arrives. Only a mistyped id and a wholly empty entry are refused.
 */
export function findEmojiSaveProblem(emoji: EmojiDeliveryFields): EmojiSaveProblem | null {
  const glyph = trimmedOrNull(emoji.fallback)
  const id = trimmedOrNull(emoji.customEmojiId)
  if (id !== null && !NUMERIC_ID.test(id)) return 'id-not-numeric'
  if (id === null && glyph === null) return 'nothing-to-deliver'
  return null
}
