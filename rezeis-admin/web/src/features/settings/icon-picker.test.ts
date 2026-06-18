import { describe, expect, it } from 'vitest'

import { isEmojiIcon, CUSTOM_ICON_PREFIX } from './icon-picker'

/**
 * `isEmojiIcon` must classify icon values exactly: emoji = a Unicode glyph or a
 * `:slug:` custom-pack shortcode, but NOT a Lucide preset key, a `custom:<id>`
 * uploaded icon, or null. This keeps existing icons from being rerouted.
 */
describe('isEmojiIcon', () => {
  it('returns false for null / empty (Auto)', () => {
    expect(isEmojiIcon(null)).toBe(false)
    expect(isEmojiIcon('')).toBe(false)
  })

  it('returns false for Lucide preset keys', () => {
    expect(isEmojiIcon('zap')).toBe(false)
    expect(isEmojiIcon('shield')).toBe(false)
    expect(isEmojiIcon('sparkles')).toBe(false)
  })

  it('returns false for uploaded custom icons', () => {
    expect(isEmojiIcon(`${CUSTOM_ICON_PREFIX}abc123`)).toBe(false)
  })

  it('returns true for a Unicode emoji glyph', () => {
    expect(isEmojiIcon('🚀')).toBe(true)
    expect(isEmojiIcon('⚜️')).toBe(true)
  })

  it('returns true for a custom-pack shortcode', () => {
    expect(isEmojiIcon(':news_emoji_1:')).toBe(true)
  })
})
