/**
 * The catalog payloads every emoji-rendering spec needs, written once.
 *
 * Three suites grew their own copy of this — the shared field-layer specs, the
 * bot-flow ones and the copy-preview ones — each with its own `packsPayload`
 * and its own idea of what a pack row looks like. That is the same split the
 * production code just had, and it fails the same way: a delivery state added
 * here would have to be remembered in three files, and a fixture that drifted
 * from the real API shape would make its suite agree with itself while the
 * screen disagreed with the server.
 *
 * Only the CATALOG lives here. Each suite still mocks its own screen's
 * endpoints, because those differ per screen and are part of what it is
 * testing.
 */

export const EMOJI_TIMESTAMP = '2026-08-14T00:00:00.000Z'

/**
 * A pack entry reduced to the two fields that decide delivery. Everything else
 * about a row is panel-side decoration and never reaches Telegram.
 */
export interface PackEmojiFixture {
  readonly slug: string
  readonly fallback: string | null
  readonly customEmojiId: string | null
}

/** Fully deliverable: its own glyph AND an id, so a Premium owner sends art. */
export const LIVE_EMOJI: PackEmojiFixture = {
  slug: 'tg_ios_macos_icons_25',
  fallback: '📣',
  customEmojiId: '5188621441926438751',
}

/** What importing an ordinary sticker set leaves: a glyph, and no id. */
export const GLYPH_ONLY_EMOJI: PackEmojiFixture = {
  slug: 'sticker_import',
  fallback: '📣',
  customEmojiId: null,
}

/** An id with no glyph of its own — deliverable, carried on the star. */
export const ID_ONLY_EMOJI: PackEmojiFixture = {
  slug: 'tg_ios_macos_icons_28',
  fallback: null,
  customEmojiId: '5188621441926438752',
}

/** Neither field: nothing reaches the user, and the token stays raw text. */
export const DEAD_EMOJI: PackEmojiFixture = {
  slug: 'dead_entry',
  fallback: null,
  customEmojiId: null,
}

/** The panel-side artwork URL the pack manager stores for a slug. */
export function emojiImageUrl(slug: string): string {
  return `/uploads/emoji/${slug}.webp`
}

/** `GET /admin/custom-emoji/packs`, shaped as the endpoint really answers. */
export function packsPayload(emojis: readonly PackEmojiFixture[]): unknown {
  return {
    data: [
      {
        id: 'pack-1',
        name: 'TG iOS/macOS Icons',
        emojis: emojis.map((emoji) => ({
          slug: emoji.slug,
          name: emoji.slug,
          imageUrl: emojiImageUrl(emoji.slug),
          lottieUrl: null,
          videoUrl: null,
          fallback: emoji.fallback,
          customEmojiId: emoji.customEmojiId,
        })),
      },
    ],
  }
}

/** `GET /admin/bot-config/emoji-studio` — the owner's Premium flag lives here. */
export function emojiStudioPayload(ownerHasPremium = true): unknown {
  return { data: { slots: [], ownerHasPremium } }
}
