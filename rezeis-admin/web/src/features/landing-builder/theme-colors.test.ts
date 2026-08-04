import { describe, expect, it } from 'vitest'

import {
  BACKGROUND_COLOR_SLOTS,
  MAX_BACKGROUND_COLORS,
  setBackgroundColor,
} from './theme-colors'

const FALLBACK = '#22c55e'

describe('background colour slots', () => {
  it('exposes one picker per schema-allowed slot', () => {
    expect(BACKGROUND_COLOR_SLOTS).toHaveLength(MAX_BACKGROUND_COLORS)
    expect([...BACKGROUND_COLOR_SLOTS]).toEqual([0, 1, 2, 3])
  })

  it('writes a colour into an existing slot without touching its neighbours', () => {
    expect(setBackgroundColor(['#111111', '#222222', '#333333'], 1, '#abcdef', FALLBACK)).toEqual([
      '#111111',
      '#abcdef',
      '#333333',
    ])
  })

  it('keeps the written colour in the slot the operator clicked', () => {
    // The regression: the old implementation spread into a sparse array and
    // then filtered it, and `Array.prototype.filter` skips holes — so setting
    // slot 3 on a one-colour theme produced ['#111111', '#abcdef'] and the
    // colour drove --ls-c2 instead of --ls-c4.
    const next = setBackgroundColor(['#111111'], 3, '#abcdef', FALLBACK)
    expect(next).toHaveLength(4)
    expect(next[3]).toBe('#abcdef')
  })

  it('fills the gap with the swatch the picker already displays', () => {
    // Unset slots render as `colors.primary`, so persisting that same value
    // keeps the stored config equal to what the operator is looking at.
    expect(setBackgroundColor(['#111111'], 3, '#abcdef', FALLBACK)).toEqual([
      '#111111',
      FALLBACK,
      FALLBACK,
      '#abcdef',
    ])
  })

  it('accepts a fourth colour — the majority of concept palettes need one', () => {
    const next = setBackgroundColor(['#111111', '#222222', '#333333'], 3, '#444444', FALLBACK)
    expect(next).toEqual(['#111111', '#222222', '#333333', '#444444'])
  })

  it('never grows past the schema limit', () => {
    const full = ['#111111', '#222222', '#333333', '#444444']
    expect(setBackgroundColor(full, 4, '#555555', FALLBACK)).toEqual(full)
    expect(setBackgroundColor(full, 1, '#555555', FALLBACK)).toHaveLength(MAX_BACKGROUND_COLORS)
  })

  it('ignores a negative slot instead of corrupting the array', () => {
    expect(setBackgroundColor(['#111111'], -1, '#abcdef', FALLBACK)).toEqual(['#111111'])
  })

  it('truncates an over-long stored array rather than propagating it', () => {
    const overlong = ['#111111', '#222222', '#333333', '#444444', '#555555']
    expect(setBackgroundColor(overlong, 0, '#000000', FALLBACK)).toHaveLength(MAX_BACKGROUND_COLORS)
  })
})
