/**
 * These rules mirror the renderers that actually consume a `:slug:` token —
 * the panel's `CustomEmojiService.substituteTelegramHtml` and the bot's
 * `renderBotCopy` / `renderButtonLabel`, both of which get the same two fields
 * (`customEmojiId`, `fallback`) and nothing else. If they ever diverge, the
 * preview starts lying again, so they are pinned here.
 */
import { describe, expect, it } from 'vitest'

import { findEmojiSaveProblem, resolveEmojiDelivery } from './emoji-delivery'

describe('resolveEmojiDelivery', () => {
  it('renders the custom emoji only with both an id and a glyph to carry it', () => {
    expect(resolveEmojiDelivery({ customEmojiId: '5188621441926438751', fallback: '📣' })).toBe(
      'premium',
    )
  })

  it('degrades to the glyph without an id — the pack image never leaves the panel', () => {
    expect(resolveEmojiDelivery({ customEmojiId: null, fallback: '📣' })).toBe('glyph')
    expect(resolveEmojiDelivery({ customEmojiId: '   ', fallback: '📣' })).toBe('glyph')
    // Non-numeric ids are stripped by the renderer, leaving the bare glyph.
    expect(resolveEmojiDelivery({ customEmojiId: 'not-an-id', fallback: '📣' })).toBe('glyph')
  })

  it('carries an id with no glyph of its own on the star, as reiwa does', () => {
    // `renderBotCopyHtml` (emoji-utils.ts:312) wraps '⭐' here, so the custom
    // emoji really arrives. The panel used to call this state undeliverable.
    expect(resolveEmojiDelivery({ customEmojiId: '5188621441926438751', fallback: null })).toBe(
      'premium',
    )
    expect(resolveEmojiDelivery({ customEmojiId: '5188621441926438751', fallback: '   ' })).toBe(
      'premium',
    )
    // No numeric id survives stripping, so no tag is emitted — the star ships
    // as a plain glyph rather than the emoji being dropped.
    expect(resolveEmojiDelivery({ customEmojiId: 'not-an-id', fallback: null })).toBe('glyph')
  })

  it('delivers nothing only when neither field is set', () => {
    expect(resolveEmojiDelivery({ customEmojiId: null, fallback: null })).toBe('nothing')
    expect(resolveEmojiDelivery({ customEmojiId: null, fallback: '  ' })).toBe('nothing')
    expect(resolveEmojiDelivery({ customEmojiId: '   ', fallback: null })).toBe('nothing')
  })
})

describe('findEmojiSaveProblem', () => {
  it('names each state the backend refuses, and only those', () => {
    expect(findEmojiSaveProblem({ customEmojiId: 'abc', fallback: '📣' })).toBe('id-not-numeric')
    expect(findEmojiSaveProblem({ customEmojiId: '', fallback: '' })).toBe('nothing-to-deliver')
    expect(findEmojiSaveProblem({ customEmojiId: '123', fallback: '📣' })).toBeNull()
    expect(findEmojiSaveProblem({ customEmojiId: null, fallback: '📣' })).toBeNull()
    // An id without a glyph is deliverable — refusing it rejected a setting
    // that works in the bot, which is the whole reason the rule was unified.
    expect(findEmojiSaveProblem({ customEmojiId: '123', fallback: null })).toBeNull()
  })
})
