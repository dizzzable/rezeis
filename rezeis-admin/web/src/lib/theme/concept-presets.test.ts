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

  it('reconstructs deterministic semantic composition for all concepts', () => {
    const densityLimit = {
      none: 0,
      light: 1,
      medium: 2,
      dense: 4,
    } as const

    for (const descriptor of CONCEPT_PRESETS) {
      const css = createConceptThemeCss(descriptor)
      const expectedLayerCount =
        descriptor.classification.directDecorCount <= 0
          ? 0
          : Math.min(
              densityLimit[descriptor.classification.decorDensity],
              Math.ceil(descriptor.classification.directDecorCount / 4),
            )

      expect(css).toContain(
        `--concept-composition-family: ${descriptor.classification.visualFamily};`,
      )
      expect(
        css.match(
          new RegExp(
            `--concept-decor-layer-count: ${expectedLayerCount};`,
            'g',
          ),
        ),
      ).toHaveLength(2)
    }
  })

  it('restores the sharp Polar Red Monolith zones and hard-edge effects', () => {
    const descriptor = CONCEPT_PRESETS.find(({ code }) => code === 'CU')
    expect(descriptor).toBeDefined()

    const css = createConceptThemeCss(descriptor!)
    expect(css).toContain('conic-gradient(from 0deg at 86% 40%')
    expect(css).toContain('conic-gradient(from 0deg at 70% 40%')
    expect(css).toContain('conic-gradient(from 180deg at 32% 72%')
    expect(css).toContain('conic-gradient(from 180deg at 70% 86%')
    expect(css).toContain('--concept-backdrop-blur: 0px;')
    expect(css).toContain('--concept-surface-shadow: 4px 4px 0')
    expect(css).toContain('--concept-decor-layer-count: 4;')
  })

  it('consumes concept geometry, effects and typography without fighting Liquid Glass', () => {
    const descriptor = CONCEPT_PRESETS.find(
      ({ classification }) =>
        classification.surfaceRadius !== classification.canonicalRadius &&
        classification.backgroundBlur &&
        classification.shadow,
    )
    expect(descriptor).toBeDefined()

    const css = createConceptThemeCss(descriptor!)
    expect(css).toContain(
      `--concept-surface-radius-delta: calc(${descriptor!.classification.surfaceRadius}px - ${descriptor!.classification.canonicalRadius}px);`,
    )
    expect(css).toContain(
      'calc(var(--radius) + var(--concept-surface-radius-delta, 0px))',
    )
    expect(css).toContain('font-family: var(--font-heading);')
    expect(css).toContain('font-family: var(--font-data);')
    expect(css).toContain(
      ':root:not([data-liquid-glass-cards="on"]) [data-concept-surface="card"]',
    )
    expect(css).toContain('box-shadow: var(--concept-surface-shadow);')
    expect(css).toContain(
      'backdrop-filter: blur(var(--concept-backdrop-blur));',
    )
    expect(css).not.toContain(
      ':root[data-liquid-glass-cards="on"] [data-concept-surface="card"]',
    )
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

  it('keeps bare page text AA-readable across composed background layers', () => {
    let supportedModes = 0
    const supportedKeys = new Set<string>()

    for (const descriptor of CONCEPT_PRESETS) {
      const css = createConceptThemeCss(descriptor)

      for (const selector of [':root', '.dark'] as const) {
        const block = parseDeclarationBlock(css, selector)
        const tokens = parseTokenBlock(css, selector)
        const image =
          block.match(
            /--concept-background-image:\s*([\s\S]*?);\n/,
          )?.[1] ?? 'none'
        const overlay = tokens['concept-background-readability-overlay']
        const artwork = removeReadabilityLayer(image, overlay)
        const samples = backgroundSamples(artwork, tokens.background)
        const needsSupport = samples.some(
          (sample) => contrast(tokens.foreground, sample) < 4.5,
        )
        const hasSupport = Number.parseInt(overlay.slice(7, 9), 16) > 0

        expect(overlay).toMatch(/^#[0-9A-Fa-f]{8}$/)
        expect(hasSupport).toBe(needsSupport)
        if (hasSupport) {
          supportedModes += 1
          supportedKeys.add(`${descriptor.code}:${selector}`)
          expect(image).toMatch(
            new RegExp(
              `^linear-gradient\\(${overlay}, ${overlay}\\),`,
              'i',
            ),
          )
        }

        for (const sample of samples) {
          const visible = flatten(overlay, sample)
          expect(
            contrast(tokens.foreground, visible),
            `${descriptor.code} ${selector} foreground ${tokens.foreground} over ${sample}`,
          ).toBeGreaterThanOrEqual(4.5)
        }
      }
    }

    // Modes whose translucent decor can cross an opaque base stop need the
    // support layer too; unaffected concepts keep their original top layer.
    expect(supportedModes).toBe(27)
    for (const key of ['K:.dark', 'CS::root', 'CW:.dark', 'CZ:.dark']) {
      expect(supportedKeys.has(key), key).toBe(true)
    }

    const desertDusk = CONCEPT_PRESETS.find(({ code }) => code === 'AM')
    expect(desertDusk).toBeDefined()
    const darkTokens = parseTokenBlock(
      createConceptThemeCss(desertDusk!),
      '.dark',
    )
    expect(
      contrast(
        darkTokens.foreground,
        flatten(
          darkTokens['concept-background-readability-overlay'],
          '#F3C79C',
        ),
      ),
    ).toBeGreaterThanOrEqual(4.5)
  })
})

function removeReadabilityLayer(image: string, overlay: HexColor): string {
  const prefix = `linear-gradient(${overlay}, ${overlay}), `
  return image.startsWith(prefix) ? image.slice(prefix.length) : image
}

function backgroundSamples(
  background: string,
  bodyBackground: HexColor,
): HexColor[] {
  let samples: HexColor[] = [bodyBackground]

  for (const layer of splitBackgroundLayers(background).reverse()) {
    const stops = [
      ...layer.matchAll(
        /#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?(?![0-9A-Fa-f])/g,
      ),
    ].map(([stop]) => stop as HexColor)
    if (stops.length === 0) continue
    const exposesUnderlying =
      /\btransparent\b/i.test(layer) ||
      stops.some((stop) => Number.parseInt(stop.slice(7, 9), 16) === 0)
    const composited = exposesUnderlying ? [...samples] : []

    for (const stop of stops) {
      if (stop.length < 9) {
        composited.push(stop)
        continue
      }
      const alpha = Number.parseInt(stop.slice(7, 9), 16) / 255
      if (alpha > 0) {
        composited.push(...samples.map((sample) => mix(stop, sample, alpha)))
      }
    }
    samples = [...new Set(composited)]
  }

  return samples
}

function splitBackgroundLayers(background: string): string[] {
  const layers: string[] = []
  let depth = 0
  let start = 0

  for (let index = 0; index < background.length; index += 1) {
    const character = background[index]
    if (character === '(') depth += 1
    else if (character === ')') depth = Math.max(0, depth - 1)
    else if (character === ',' && depth === 0) {
      layers.push(background.slice(start, index).trim())
      start = index + 1
    }
  }

  const tail = background.slice(start).trim()
  if (tail.length > 0 && tail !== 'none') layers.push(tail)
  return layers
}

function parseDeclarationBlock(
  css: string,
  selector: ':root' | '.dark',
): string {
  const escaped = selector === ':root' ? ':root' : '\\.dark'
  return css.match(new RegExp(`${escaped} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? ''
}

function parseTokenBlock(css: string, selector: ':root' | '.dark'): Record<string, HexColor> {
  const body = parseDeclarationBlock(css, selector)
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
