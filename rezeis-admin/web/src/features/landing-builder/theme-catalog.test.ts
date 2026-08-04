import { describe, expect, it } from 'vitest'

import { LANDING_THEME_PRESETS, applyThemePreset } from './theme-presets'
import { GENERATED_THEME_PRESETS } from './theme-presets.generated'
import {
  LANDING_BACKGROUNDS,
  LANDING_SURFACE_STYLES,
  type LandingTheme,
} from './landing-builder-api'
import { MAX_BACKGROUND_COLORS } from './theme-colors'

/**
 * Quality gate for the whole theme catalog.
 *
 * Rendering a hundred themes through a browser on every commit is not viable —
 * the full matrix is sections × themes × viewports × locales — so the cheap,
 * deterministic properties are asserted here instead, and visual checking stays
 * a deliberate spot-check on a handful of reference themes. What these cover is
 * exactly the class of defect that would otherwise reach an operator as "this
 * theme looks broken": unreadable text, a colour the schema rejects, a value
 * the renderer has no branch for, or a fourth colour silently dropped.
 */

const AA = 4.5
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

function toRgb(hex: string): [number, number, number] {
  let raw = hex.replace('#', '')
  if (raw.length === 3) raw = raw.split('').map((c) => c + c).join('')
  const n = Number.parseInt(raw, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function luminance(hex: string): number {
  const lin = toRgb(hex).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)]
  const [hi, lo] = x > y ? [x, y] : [y, x]
  return (hi + 0.05) / (lo + 0.05)
}

const colorsOf = (theme: LandingTheme) => theme.colors ?? {}

describe('theme catalog', () => {
  it('ships the full extracted catalog', () => {
    expect(GENERATED_THEME_PRESETS.length).toBe(104)
    expect(LANDING_THEME_PRESETS.length).toBeGreaterThanOrEqual(104)
  })

  it('has no duplicate ids across curated and generated entries', () => {
    const ids = LANDING_THEME_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('puts the curated presets first', () => {
    // The gallery has no ranking of its own; order here is the ranking.
    expect(LANDING_THEME_PRESETS[0].id).toBe('vital-link')
  })

  describe.each(LANDING_THEME_PRESETS.map((p) => [p.name, p] as const))('%s', (_name, preset) => {
    const { theme } = preset

    it('keeps body text readable on the page background (WCAG AA)', () => {
      const { fg, bg } = colorsOf(theme)
      expect(fg, 'fg').toBeTypeOf('string')
      expect(bg, 'bg').toBeTypeOf('string')
      expect(contrast(fg!, bg!)).toBeGreaterThanOrEqual(AA)
    })

    it('keeps the CTA label readable on the primary colour', () => {
      // The renderer derives the on-primary colour by contrast, so the check is
      // that one of the two candidates clears AA — if neither does, no derived
      // foreground can rescue the button.
      const { primary } = colorsOf(theme)
      const best = Math.max(contrast('#ffffff', primary!), contrast('#000000', primary!))
      expect(best).toBeGreaterThanOrEqual(AA)
    })

    it('uses colours the schema accepts', () => {
      for (const [key, value] of Object.entries(colorsOf(theme))) {
        expect(value, `colors.${key} = ${value}`).toMatch(HEX)
      }
      for (const value of theme.backgroundColors ?? []) {
        expect(value, `backgroundColors: ${value}`).toMatch(HEX)
      }
    })

    it('fits the four background colour slots', () => {
      const count = theme.backgroundColors?.length ?? 0
      expect(count).toBeGreaterThan(0)
      expect(count).toBeLessThanOrEqual(MAX_BACKGROUND_COLORS)
    })

    it('names a background effect and surface style the renderer implements', () => {
      expect(LANDING_BACKGROUNDS).toContain(theme.background)
      expect(LANDING_SURFACE_STYLES).toContain(theme.surfaceStyle)
    })

    it('is a complete, self-contained look', () => {
      // Every presentation key present, so applying it cannot leave a fragment
      // of the previously applied preset behind.
      expect(theme.inherit).toBe(false)
      expect(theme.radius).toBeTypeOf('string')
      expect(theme.animateBackground).toBe(true)
      expect(colorsOf(theme).accent).toBeTypeOf('string')
    })

    it('declares a mood that matches its background', () => {
      // The gallery's light/dark filter is only useful if it tells the truth.
      const expected = luminance(colorsOf(theme).bg!) > 0.35 ? 'light' : 'dark'
      expect(preset.mood).toBe(expected)
    })

    it('applies as a detached copy', () => {
      const applied = applyThemePreset(preset)
      applied.colors = { ...applied.colors, primary: '#000000' }
      expect(colorsOf(theme).primary).not.toBe('#000000')
    })
  })
})
