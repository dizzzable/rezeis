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

  it('changes only theme-owned fields and preserves operator content/layout overrides', () => {
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
    const resolved = {
      ...base,
      ...createThemePresetVisualPatch(THEME_PRESETS[37]),
    }

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
