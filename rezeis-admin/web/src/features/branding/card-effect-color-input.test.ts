import { describe, expect, it } from 'vitest'

import { CARD_EFFECT_CATALOG } from './card-effect-catalog'
import { toColorInputValue, withColorInputValue } from './card-effect-color-input'

describe('card effect colour input codec', () => {
  it('shows the RGB of an rgba() value instead of falling back to white', () => {
    expect(toColorInputValue('rgba(255, 255, 255, 0.6)')).toBe('#ffffff')
    expect(toColorInputValue('rgba(18, 52, 86, 0.25)')).toBe('#123456')
    expect(toColorInputValue('rgb(18, 52, 86)')).toBe('#123456')
    expect(toColorInputValue('#123456aa')).toBe('#123456')
    expect(toColorInputValue('#1234')).toBe('#112233')
    expect(toColorInputValue('#abc')).toBe('#aabbcc')
  })

  it('falls back only when the value is not a colour at all', () => {
    expect(toColorInputValue(undefined)).toBe('#ffffff')
    expect(toColorInputValue('checks')).toBe('#ffffff')
    expect(toColorInputValue(42)).toBe('#ffffff')
  })

  it('re-applies the original alpha and notation when writing back', () => {
    expect(withColorInputValue('rgba(255, 255, 255, 0.6)', '#ff0000')).toBe('rgba(255, 0, 0, 0.6)')
    expect(withColorInputValue('#12345680', '#ff0000')).toBe('#ff000080')
    expect(withColorInputValue('#1234', '#ff0000')).toBe('#ff000044')
  })

  it('leaves alpha-free values as plain six-digit hex', () => {
    expect(withColorInputValue('#123456', '#ff0000')).toBe('#ff0000')
    expect(withColorInputValue('rgb(1, 2, 3)', '#ff0000')).toBe('#ff0000')
    expect(withColorInputValue('not-a-colour', '#ff0000')).toBe('#ff0000')
  })

  it('keeps the pixelCard alpha ramp distinct after every swatch is touched', () => {
    // The regression: all three swatches displayed `#ffffff` while the stored
    // values differed, and one click per swatch flattened the ramp for good.
    const ramp = CARD_EFFECT_CATALOG.pixelCard.controls.find((c) => c.prop === 'colors')
      ?.default as string[]
    expect(ramp).toEqual([
      'rgba(255, 255, 255, 1)',
      'rgba(255, 255, 255, 0.8)',
      'rgba(255, 255, 255, 0.6)',
    ])

    const touched = ramp.map((color) => withColorInputValue(color, '#ff8800'))
    expect(touched).toEqual([
      'rgba(255, 136, 0, 1)',
      'rgba(255, 136, 0, 0.8)',
      'rgba(255, 136, 0, 0.6)',
    ])
    expect(new Set(touched).size).toBe(3)
  })
})
