import { describe, expect, it } from 'vitest'

import {
  CONCEPT_PRESETS,
  CONCEPT_REQUIRED_TOKENS,
  createConceptThemeCss,
  getConceptSourceStyle,
  type HexColor,
} from './concept-presets'
import {
  CONCEPT_THEME_PRESETS,
  LEGACY_THEME_PRESETS,
  PRESET_BY_ID,
  THEME_PRESETS,
  getPresetRecommendedRadiusRem,
} from './presets'

describe('concept presets catalog', () => {
  it('contains all 104 approved concepts and retains legacy themes', () => {
    expect(CONCEPT_PRESETS).toHaveLength(104)
    expect(CONCEPT_THEME_PRESETS).toHaveLength(104)
    expect(LEGACY_THEME_PRESETS).toHaveLength(8)
    expect(THEME_PRESETS).toHaveLength(112)
  })

  it('keeps concept ids unique and stable from A through CZ', () => {
    const ids = CONCEPT_PRESETS.map((preset) => preset.id)

    expect(new Set(ids).size).toBe(104)
    expect(ids[0]).toBe('concept-a')
    expect(ids.at(-1)).toBe('concept-cz')
    expect(PRESET_BY_ID.default?.id).toBe('default')
    expect(PRESET_BY_ID['concept-cz']?.code).toBe('CZ')
  })

  it('generates complete deterministic light/dark admin CSS', () => {
    for (const descriptor of CONCEPT_PRESETS) {
      const css = createConceptThemeCss(descriptor)

      expect(css).toBe(createConceptThemeCss(descriptor))
      expect(css).toContain(':root {')
      expect(css).toContain('.dark {')
      expect(css).toContain('font-family:')
      for (const token of CONCEPT_REQUIRED_TOKENS) {
        expect(css.match(new RegExp(`--${token}:`, 'g'))).toHaveLength(2)
      }
    }
  })

  it('retains audited source semantics and distinct visual geometry', () => {
    const backgrounds = new Set<string>()
    const radii = new Set<number>()
    const fonts = new Set<string>()

    for (const descriptor of CONCEPT_PRESETS) {
      const source = getConceptSourceStyle(descriptor)
      backgrounds.add(source.background ?? 'mesh')
      radii.add(descriptor.classification.canonicalRadius)
      fonts.add(source.headingFont)
      fonts.add(source.bodyFont)
      fonts.add(source.dataFont)

      const css = createConceptThemeCss(descriptor)
      expect(css).toContain(
        `--radius: ${descriptor.classification.canonicalRadius}px;`,
      )
      if (descriptor.classification.radiusClass === 'square') {
        expect(descriptor.classification.canonicalRadius).toBeLessThanOrEqual(4)
      }
      expect(
        getPresetRecommendedRadiusRem(PRESET_BY_ID[descriptor.id]),
      ).toBe(descriptor.classification.canonicalRadius / 16)
    }

    expect(backgrounds.size).toBeGreaterThan(90)
    expect(radii.size).toBeGreaterThan(10)
    expect(fonts.size).toBe(10)
  })

  it('keeps text, focus, boundaries and charts readable in all 208 modes', () => {
    for (const descriptor of CONCEPT_PRESETS) {
      const css = createConceptThemeCss(descriptor)
      const blocks = ([':root', '.dark'] as const).map((selector) =>
        parseTokenBlock(css, selector),
      )

      for (const tokens of blocks) {
        expect(pairContrast(tokens, 'primary-foreground', 'primary')).toBeGreaterThanOrEqual(4.5)
        expect(pairContrast(tokens, 'muted-foreground', 'muted')).toBeGreaterThanOrEqual(4.5)
        expect(pairContrast(tokens, 'ring', 'background')).toBeGreaterThanOrEqual(3)
        expect(pairContrast(tokens, 'border', 'background')).toBeGreaterThanOrEqual(3)
        expect(pairContrast(tokens, 'input', 'background')).toBeGreaterThanOrEqual(3)
        expect(pairContrast(tokens, 'sidebar-ring', 'sidebar')).toBeGreaterThanOrEqual(3)
        expect(pairContrast(tokens, 'sidebar-border', 'sidebar')).toBeGreaterThanOrEqual(3)
        for (let chart = 1; chart <= 5; chart += 1) {
          expect(pairContrast(tokens, `chart-${chart}`, 'background')).toBeGreaterThanOrEqual(3)
        }
      }
    }
  })
})

function parseTokenBlock(css: string, selector: ':root' | '.dark'): Record<string, HexColor> {
  const escaped = selector === ':root' ? ':root' : '\\.dark'
  const body = css.match(new RegExp(`${escaped} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? ''
  return Object.fromEntries(
    [...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?);/g)].map(
      ([, token, value]) => [token, value as HexColor],
    ),
  )
}

function pairContrast(
  tokens: Record<string, HexColor>,
  foregroundToken: string,
  backgroundToken: string,
): number {
  const page = tokens.background
  const background = flatten(tokens[backgroundToken], page)
  const foreground = flatten(tokens[foregroundToken], background)
  return contrast(foreground, background)
}

function flatten(color: HexColor, backdrop: HexColor): HexColor {
  if (color.length < 9) return color
  const alpha = Number.parseInt(color.slice(7, 9), 16) / 255
  return mix(color, backdrop, alpha)
}

function mix(left: HexColor, right: HexColor, leftWeight: number): HexColor {
  const channel = (offset: number): string =>
    Math.round(
      Number.parseInt(left.slice(offset, offset + 2), 16) * leftWeight +
        Number.parseInt(right.slice(offset, offset + 2), 16) * (1 - leftWeight),
    )
      .toString(16)
      .padStart(2, '0')
  return `#${channel(1)}${channel(3)}${channel(5)}`
}

function contrast(left: HexColor, right: HexColor): number {
  const light = Math.max(luminance(left), luminance(right))
  const dark = Math.min(luminance(left), luminance(right))
  return (light + 0.05) / (dark + 0.05)
}

function luminance(color: HexColor): number {
  const channel = (offset: number): number => {
    const value = Number.parseInt(color.slice(offset, offset + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}
