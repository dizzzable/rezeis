import { describe, expect, it } from 'vitest'

import { isShortcodeEmoji } from './emoji-icon-value'

describe('isShortcodeEmoji', () => {
  it('accepts a normalized custom emoji shortcode', () => {
    expect(isShortcodeEmoji(':news_emoji_1:')).toBe(true)
  })

  it('rejects non-shortcode values', () => {
    expect(isShortcodeEmoji('😀')).toBe(false)
    expect(isShortcodeEmoji(':contains-dash:')).toBe(false)
  })
})
