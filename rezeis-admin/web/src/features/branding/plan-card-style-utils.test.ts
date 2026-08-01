import { describe, expect, it } from 'vitest'

import { autoPlanGradient, resolvePlanCardTextureCss } from './plan-card-style-utils'

describe('plan card style helpers', () => {
  it('derives a stable, distinct fallback gradient for each plan id', () => {
    expect(autoPlanGradient('starter')).toBe(autoPlanGradient('starter'))
    expect(autoPlanGradient('starter')).not.toBe(autoPlanGradient('pro'))
    expect(autoPlanGradient('starter')).toMatch(/^linear-gradient\(135deg, hsl\(/)
  })

  it('keeps an uploaded texture above the generated preset texture', () => {
    expect(
      resolvePlanCardTextureCss({
        texturePreset: 'grid',
        textureUrl: 'https://example.test/card-texture.webp',
      }),
    ).toBeNull()
  })

  it('builds a preset texture with the configured accent', () => {
    const css = resolvePlanCardTextureCss({ texturePreset: 'grid', accent: '#63f0e0' })

    expect(css).toMatchObject({
      backgroundColor: 'transparent',
      backgroundSize: '16px 16px',
    })
    expect(decodeURIComponent(css?.backgroundImage ?? '')).toContain('rgba(99,240,224,0.5)')
  })
})
