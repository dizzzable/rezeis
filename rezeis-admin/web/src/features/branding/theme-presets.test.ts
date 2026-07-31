import { describe, expect, it } from 'vitest'

import { CARD_EFFECT_REGISTRY } from './card-effect-registry'
import {
  CONCEPT_PRESETS,
  getConceptSourceBackgroundColor,
  getConceptSourceStyle,
} from '@/lib/theme/concept-presets'
import {
  createBrandingDirtyPatch,
  createBrandingFormSchema,
  createInitialBrandingDraft,
  type BrandingDirtyFields,
} from './branding-form-schema'
import {
  THEME_PRESETS,
  createConceptReiwaPreset,
  createThemePresetVisualPatch,
} from './theme-presets'

const validationMessages = {
  hexInvalid: 'hex invalid',
  imageUrlInvalid: 'image invalid',
  gradientInvalid: 'gradient invalid',
} as const

describe('WEB Reiwa 104-theme catalog', () => {
  it('contains exactly 104 stable unique concept ids', () => {
    const ids = THEME_PRESETS.map((preset) => preset.id)

    expect(THEME_PRESETS).toHaveLength(104)
    expect(new Set(ids).size).toBe(104)
    expect(ids[0]).toBe('concept-a')
    expect(ids.at(-1)).toBe('concept-cz')
    expect(THEME_PRESETS.every((preset) => preset.version === 2)).toBe(true)
  })

  it('produces only supported effects and schema-valid resolved payloads', () => {
    const effects = new Set(CARD_EFFECT_REGISTRY.map((effect) => effect.id))
    const schema = createBrandingFormSchema(validationMessages)

    for (const preset of THEME_PRESETS) {
      expect(effects.has(preset.cardEffect as never)).toBe(true)
      const result = schema.safeParse({
        ...createInitialBrandingDraft(),
        ...createThemePresetVisualPatch(preset),
      })
      expect(result.success, `${preset.code} ${preset.name}`).toBe(true)
    }
  })

  it('builds a minimal valid PATCH for every theme despite unchanged legacy settings', () => {
    const schema = createBrandingFormSchema(validationMessages)
    const legacyBase = createInitialBrandingDraft({
      brandName: 'Legacy operator',
      cardEffectsByIndex: [
        {
          cardEffect: 'aurora',
          cardEffectProps: {},
          cardEffectOpacity: 1,
          cardGradient: 'url(https://legacy.example/card.png)',
        },
      ],
    })

    for (const preset of THEME_PRESETS) {
      const visualPatch = createThemePresetVisualPatch(preset)
      const dirtyFields = Object.fromEntries(
        Object.keys(visualPatch).map((field) => [field, true]),
      ) as BrandingDirtyFields
      const result = createBrandingDirtyPatch({
        values: { ...legacyBase, ...visualPatch },
        dirtyFields,
        schema,
      })

      expect(result.success, `${preset.code} ${preset.name}`).toBe(true)
      if (!result.success) continue
      expect(result.data.themePresetId).toBe(preset.id)
      expect(result.data.themePresetVersion).toBe(preset.version)
      expect(result.data).not.toHaveProperty('brandName')
      expect(result.data).not.toHaveProperty('cardEffectsByIndex')
    }
  })

  it('keeps required foreground pairs at WCAG AA contrast', () => {
    for (const preset of THEME_PRESETS) {
      expect(contrast(preset.primary, preset.primaryFg)).toBeGreaterThanOrEqual(4.5)
      expect(
        contrast(preset.bgPrimary, preset.surfaceTheme.foreground),
      ).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('reconstructs all presets deterministically with unique card compositions', () => {
    const reconstructed = CONCEPT_PRESETS.map(createConceptReiwaPreset)
    const cardGradients = THEME_PRESETS.map((preset) => preset.cardGradient)

    expect(reconstructed).toEqual(THEME_PRESETS)
    expect(new Set(cardGradients).size).toBe(THEME_PRESETS.length)
  })

  it('uses a broad semantic composition matrix instead of one generic layout', () => {
    const appCompositions = new Set(
      THEME_PRESETS.map((preset) => preset.appComposition),
    )
    const cardCompositions = new Set(
      THEME_PRESETS.map((preset) => preset.cardComposition),
    )

    expect(appCompositions.size).toBeGreaterThanOrEqual(7)
    expect(cardCompositions.size).toBeGreaterThanOrEqual(7)
  })

  it('maps Polar Red Monolith to angular app bands and an orbital card', () => {
    const preset = THEME_PRESETS.find(({ code }) => code === 'CU')

    expect(preset).toBeDefined()
    expect(preset?.appComposition).toBe('orthogonal-bands')
    expect(preset?.cardComposition).toBe('orbit-spotlight')
    expect(preset?.cardGradient).toContain('radial-gradient(circle')
    expect(preset?.cardGradient).toContain('transparent 0 27%')
    expect(preset?.cardGradient).toContain('28% 30%')
    expect(preset?.appBackground.gradient).toContain('#EDF5F7')
    expect(preset?.appBackground.gradient).toContain('#C7DBE1')
    expect(preset?.appBackground.gradient).toContain('#91AAB2')
    expect(preset?.appBackground.gradient).toContain('#E845452A')
    expect(preset?.appBackground.gradient).not.toContain(
      'linear-gradient(145deg, #FFFFFF 0%, #1B2529 100%)',
    )
  })

  it('persists a complete gradient and texture recipe for every app background', () => {
    for (const preset of THEME_PRESETS) {
      const { gradient, texture } = preset.appBackground

      expect(preset.appBackground.kind, `${preset.code} app kind`).toBe(
        'gradient',
      )
      expect(gradient, `${preset.code} app gradient`).toContain('gradient(')
      expect(
        extractGradientHexColors(gradient).length,
        `${preset.code} app gradient colors`,
      ).toBeGreaterThan(0)
      expect(texture.pattern, `${preset.code} texture pattern`).toBeTruthy()
      expect(texture.color, `${preset.code} texture color`).toMatch(
        /^#[\da-f]{6}$/i,
      )
      expect(texture.background, `${preset.code} texture background`).toMatch(
        /^#[\da-f]{6}$/i,
      )
      expect(texture.scale, `${preset.code} texture scale`).toBeGreaterThan(0)
      expect(texture.opacity, `${preset.code} texture opacity`).toBeGreaterThan(0)
      expect(texture.opacity, `${preset.code} texture opacity`).toBeLessThanOrEqual(1)
    }
  })

  it('keeps muted text and strong boundaries readable on composited surfaces', () => {
    for (const preset of THEME_PRESETS) {
      const {
        mutedForeground,
        surface,
        surfaceHigh,
        borderStrong,
        surfaceOpacity,
        surfaceHighOpacity,
      } = preset.surfaceTheme
      const appSamples = extractGradientSamples(
        preset.appBackground.gradient,
        preset.bgPrimary,
      )
      const compositedSurfaces = appSamples.flatMap((appSample) => [
        mix(surface, appSample, surfaceOpacity),
        mix(surfaceHigh, appSample, surfaceHighOpacity),
      ])

      for (const background of compositedSurfaces) {
        expect(
          contrast(mutedForeground, background),
          `${preset.code} muted text on ${background}`,
        ).toBeGreaterThanOrEqual(4.5)
        expect(
          contrast(borderStrong, background),
          `${preset.code} strong border on ${background}`,
        ).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('carries source semantics and exact angular geometry into Reiwa', () => {
    for (const [index, preset] of THEME_PRESETS.entries()) {
      const descriptor = CONCEPT_PRESETS[index]
      const source = getConceptSourceStyle(descriptor)

      expect(preset.primary).toBe(source.accent.slice(0, 7).toUpperCase())
      expect(preset.bgPrimary).toBe(getConceptSourceBackgroundColor(descriptor))
      expect(preset.fontFamily).toContain(source.bodyFont)
      expect(preset.cornerRadii.cardPx).toBe(
        descriptor.classification.radiusClass === 'square'
          ? descriptor.classification.canonicalRadius
          : descriptor.classification.surfaceRadius,
      )
      if (descriptor.classification.radiusClass === 'square') {
        expect(preset.borderRadius).toBe('rounded-none')
        expect(preset.cornerRadii.itemPx).toBeLessThanOrEqual(4)
        expect(preset.cornerRadii.pillPx).toBeLessThanOrEqual(4)
      }
    }
  })

  it('keeps the pure visual patch limited while the page handler owns slot synchronization', () => {
    const base = createInitialBrandingDraft({
      brandName: 'Operator VPN',
      tagline: 'Private access',
      logoUrl: 'https://cdn.example/logo.png',
      pwaIconUrl: 'https://cdn.example/icon.png',
      cardLogoUrl: 'https://cdn.example/watermark.png',
      cardEffectsByIndex: [
        {
          cardEffect: 'waves',
          cardEffectProps: { speed: 2 },
          cardEffectOpacity: 0.6,
        },
      ],
      iconColorMode: 'custom',
      iconColors: { support: '#ff00ff' },
      planCardStyles: { pro: { gradient: 'linear-gradient(red, blue)' } },
      navItems: [
        { id: 'subscriptions', visible: true },
        { id: 'settings', visible: true },
      ],
      navGap: 9,
    })
    const visualPatch = createThemePresetVisualPatch(THEME_PRESETS[37])
    const resolved = {
      ...base,
      ...visualPatch,
    }

    expect(visualPatch).not.toHaveProperty('cardEffectsByIndex')
    expect(resolved.brandName).toBe(base.brandName)
    expect(resolved.tagline).toBe(base.tagline)
    expect(resolved.logoUrl).toBe(base.logoUrl)
    expect(resolved.pwaIconUrl).toBe(base.pwaIconUrl)
    expect(resolved.cardLogoUrl).toBe(base.cardLogoUrl)
    expect(resolved.cardEffectsByIndex).toBe(base.cardEffectsByIndex)
    expect(resolved.iconColorMode).toBe(base.iconColorMode)
    expect(resolved.iconColors).toBe(base.iconColors)
    expect(resolved.planCardStyles).toBe(base.planCardStyles)
    expect(resolved.navItems).toBe(base.navItems)
    expect(resolved.navGap).toBe(base.navGap)
  })
})

function contrast(left: string, right: string): number {
  const leftLuminance = luminance(left)
  const rightLuminance = luminance(right)
  const light = Math.max(leftLuminance, rightLuminance)
  const dark = Math.min(leftLuminance, rightLuminance)
  return (light + 0.05) / (dark + 0.05)
}

function extractGradientHexColors(gradient: string): string[] {
  return [
    ...new Set(
      [...gradient.matchAll(/#[\da-f]{6}(?:[\da-f]{2})?/gi)].map((match) =>
        match[0].slice(0, 7).toUpperCase(),
      ),
    ),
  ]
}

function extractGradientSamples(
  gradient: string,
  fallback: string,
): string[] {
  const colors = [...gradient.matchAll(/#[\da-f]{6}(?:[\da-f]{2})?/gi)].map(
    (match) => match[0].toUpperCase(),
  )
  const opaqueColors = colors.filter((color) => color.length === 7)
  const backdrops = opaqueColors.length > 0 ? opaqueColors : [fallback]
  const translucentSamples = colors
    .filter((color) => color.length === 9)
    .flatMap((color) => {
      const alpha = Number.parseInt(color.slice(7, 9), 16) / 255
      return backdrops.map((backdrop) =>
        mix(color.slice(0, 7), backdrop, alpha),
      )
    })

  return [...new Set([...backdrops, ...translucentSamples])]
}

function mix(left: string, right: string, leftWeight: number): string {
  const channel = (offset: number): string =>
    Math.round(
      Number.parseInt(left.slice(offset, offset + 2), 16) * leftWeight +
        Number.parseInt(right.slice(offset, offset + 2), 16) *
          (1 - leftWeight),
    )
      .toString(16)
      .padStart(2, '0')

  return `#${channel(1)}${channel(3)}${channel(5)}`
}

function luminance(hex: string): number {
  const raw = hex.replace(/^#/, '').slice(0, 6)
  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(raw.slice(offset, offset + 2), 16) / 255
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}
