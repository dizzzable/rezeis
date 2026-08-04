import { describe, expect, it } from 'vitest'

import {
  LANDING_THEME_PRESETS,
  applyThemePreset,
  findThemePreset,
  isPresetApplied,
  preserveFont,
} from './theme-presets'
import { buildDefaultSection } from './section-defaults'
import type { LandingConfig, LandingTheme } from './landing-builder-api'

const LOCALES = ['ru', 'en']

function configWithContent(): LandingConfig {
  const hero = buildDefaultSection('hero', LOCALES)
  return {
    schemaVersion: 1,
    enabled: true,
    theme: { inherit: true },
    locales: LOCALES,
    defaultLocale: 'ru',
    meta: { title: { ru: 'Т', en: 'T' }, description: { ru: 'О', en: 'D' } },
    sections: [
      { ...hero, data: { ...(hero.data as Record<string, unknown>), heading: { ru: 'Мой', en: 'Mine' } } },
      buildDefaultSection('pricing', LOCALES),
    ],
  } as LandingConfig
}

describe('theme presets', () => {
  it('ships presets with unique ids and names', () => {
    const ids = LANDING_THEME_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    const names = LANDING_THEME_PRESETS.map((p) => p.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('always disables branding inheritance', () => {
    // With `inherit: true` the renderer keeps platform branding and ignores the
    // preset's colours — the tile would look like it did nothing.
    for (const preset of LANDING_THEME_PRESETS) {
      expect(preset.theme.inherit, preset.id).toBe(false)
    }
  })

  it('sets every presentation key on every preset', () => {
    // A preset that omits a key would inherit that fragment from whichever
    // preset ran before it, making the same tile render differently depending
    // on the order the operator clicked things.
    for (const preset of LANDING_THEME_PRESETS) {
      const { theme } = preset
      expect(theme.colors?.primary, preset.id).toBeTypeOf('string')
      expect(theme.colors?.bg, preset.id).toBeTypeOf('string')
      expect(theme.colors?.fg, preset.id).toBeTypeOf('string')
      expect(theme.colors?.accent, preset.id).toBeTypeOf('string')
      expect(theme.radius, preset.id).toBeTypeOf('string')
      expect(theme.background, preset.id).toBeTypeOf('string')
      expect(theme.surfaceStyle, preset.id).toBeTypeOf('string')
      expect(theme.animateBackground, preset.id).toBe(true)
      expect(Array.isArray(theme.backgroundColors), preset.id).toBe(true)
      // The interaction keys count too. Applying a preset replaces the theme
      // wholesale, so a key it does not name is one the operator's setting is
      // reset by — and, because the same keys decide whether a theme still
      // "is" the preset, one the gallery never learns to remember.
      expect(theme.backgroundOverlay, preset.id).toBeTypeOf('string')
      expect(theme.cardHover, preset.id).toBeTypeOf('string')
      expect(theme.ctaStyle, preset.id).toBeTypeOf('string')
    }
  })

  it('never exceeds the four background colour slots', () => {
    for (const preset of LANDING_THEME_PRESETS) {
      expect(preset.theme.backgroundColors?.length ?? 0, preset.id).toBeLessThanOrEqual(4)
    }
  })

  it('uses valid hex for every colour', () => {
    const hex = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i
    for (const preset of LANDING_THEME_PRESETS) {
      for (const value of Object.values(preset.theme.colors ?? {})) {
        expect(value, `${preset.id}: ${value}`).toMatch(hex)
      }
      for (const value of preset.theme.backgroundColors ?? []) {
        expect(value, `${preset.id}: ${value}`).toMatch(hex)
      }
    }
  })

  it('leaves sections untouched when a preset is applied', () => {
    // The whole point: re-skinning must not be able to eat the operator's copy.
    const config = configWithContent()
    const before = JSON.stringify(config.sections)
    const next: LandingConfig = { ...config, theme: applyThemePreset(LANDING_THEME_PRESETS[0]) }
    expect(JSON.stringify(next.sections)).toBe(before)
  })

  it('replaces the look wholesale rather than merging with the previous preset', () => {
    const glass = LANDING_THEME_PRESETS.find((p) => p.theme.surfaceStyle === 'glass')
    const outline = LANDING_THEME_PRESETS.find((p) => p.theme.surfaceStyle === 'outline')
    expect(glass && outline).toBeTruthy()
    const afterGlass = applyThemePreset(glass!)
    const afterOutline = applyThemePreset(outline!)
    expect(afterGlass.surfaceStyle).toBe('glass')
    expect(afterOutline.surfaceStyle).toBe('outline')
    // Applying the second preset must yield exactly the second preset, with no
    // residue of the first in any key.
    expect(afterOutline).toEqual(outline!.theme)
  })

  it('hands back a detached copy, so editing the theme cannot mutate the catalog', () => {
    const source = LANDING_THEME_PRESETS[0]
    const applied = applyThemePreset(source)
    applied.colors!.primary = '#000000'
    applied.backgroundColors!.push('#ffffff')
    expect(source.theme.colors?.primary).not.toBe('#000000')
    expect(source.theme.backgroundColors?.length).toBeLessThanOrEqual(4)
  })

  it('recognises an applied preset and stops recognising it after a tweak', () => {
    const source = LANDING_THEME_PRESETS[1]
    const applied = applyThemePreset(source)
    expect(isPresetApplied(applied, source)).toBe(true)
    applied.colors = { ...applied.colors, primary: '#123456' }
    expect(isPresetApplied(applied, source)).toBe(false)
  })

  it.each([
    ['backgroundOverlay', 'vignette'],
    ['cardHover', 'lift'],
    ['ctaStyle', 'shine'],
  ] as const)('stops recognising the preset when only %s differs', (key, value) => {
    // These three sat outside the comparison, so a theme differing ONLY here
    // still reported as the pristine preset — the gallery then took the "no
    // tweak to remember" path and the next tile click erased the setting past
    // undo, which is the exact failure this module exists to prevent.
    const source = LANDING_THEME_PRESETS[0]
    const tweaked: LandingTheme = { ...applyThemePreset(source), [key]: value }
    expect(isPresetApplied(tweaked, source)).toBe(false)
  })

  it('resets a hand-tweaked interaction setting to the preset it applies', () => {
    // The other half of the same rule: the preset is the complete look, so
    // applying one must not leave the previous theme's hover behaviour behind.
    const applied = applyThemePreset(LANDING_THEME_PRESETS[0])
    expect(applied.cardHover).toBe('none')
    expect(applied.ctaStyle).toBe('none')
    expect(applied.backgroundOverlay).toBe('none')
  })

  it('names no typeface of its own', () => {
    // `font: {}` was not "no opinion". A preset replaces the theme wholesale,
    // so every tile in the catalog carried an empty font that landed on top of
    // whatever the operator had chosen in the Settings tab and cleared it.
    for (const preset of LANDING_THEME_PRESETS) {
      expect(preset.theme.font, preset.id).toBeUndefined()
    }
  })

  it('carries the current typography onto the incoming look', () => {
    const current: LandingTheme = {
      ...applyThemePreset(LANDING_THEME_PRESETS[1]),
      font: { family: 'Georgia, serif' },
    }
    const { font, ...look } = preserveFont(applyThemePreset(LANDING_THEME_PRESETS[0]), current)
    expect(font).toEqual({ family: 'Georgia, serif' })
    // And nothing else survives from the outgoing theme: the look is still
    // replaced wholesale, font is the single exception.
    expect(look).toEqual(LANDING_THEME_PRESETS[0].theme)
  })

  it('takes the font away again when the current theme has none', () => {
    // The gallery replays a remembered variant, which was captured whenever the
    // operator last left that tile — its font is the older of the two.
    const remembered: LandingTheme = {
      ...applyThemePreset(LANDING_THEME_PRESETS[0]),
      font: { family: 'Georgia, serif' },
    }
    expect(preserveFont(remembered, { inherit: false }).font).toBeUndefined()
  })

  it('still recognises the preset once the operator sets a font', () => {
    // Typography is not part of the look, so the tile stays lit. Were it
    // compared, the gallery would read the font as a per-preset tweak and file
    // a copy away under whichever tile happened to be active.
    const source = LANDING_THEME_PRESETS[0]
    const themed: LandingTheme = {
      ...applyThemePreset(source),
      font: { family: 'Georgia, serif' },
    }
    expect(isPresetApplied(themed, source)).toBe(true)
  })

  it('does not report a preset as applied for an unrelated theme', () => {
    expect(isPresetApplied({ inherit: true }, LANDING_THEME_PRESETS[0])).toBe(false)
  })

  it('looks a preset up by id', () => {
    expect(findThemePreset(LANDING_THEME_PRESETS[0].id)?.name).toBe(LANDING_THEME_PRESETS[0].name)
    expect(findThemePreset('no-such-preset')).toBeUndefined()
  })
})
