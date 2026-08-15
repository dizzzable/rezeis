import { describe, expect, it } from 'vitest'

import {
  resolveAppBackgroundPaintedSamples,
  resolveAppBackgroundReadability,
} from './app-background-contrast'
import { CARD_EFFECT_REGISTRY } from './card-effect-registry'
import {
  CONCEPT_PRESETS,
  getConceptSourceBackgroundColor,
  getConceptSourceMode,
  getConceptSourceStyle,
} from '@/lib/theme/concept-presets'
import {
  createBrandingDirtyPatch,
  createBrandingFormSchema,
  createInitialBrandingDraft,
  type BrandingDirtyFields,
} from './branding-form-schema'
import {
  CONCEPT_THEME_PRESETS,
  LEGACY_THEME_PRESETS,
  THEME_PRESETS,
  createConceptReiwaPreset,
  createConceptThemeModeVariants,
  createConceptThemePresetVisualPatch,
  createLegacyThemePresetVisualPatch,
  createThemePresetVisualPatch,
} from './theme-presets'

const validationMessages = {
  hexInvalid: 'hex invalid',
  imageUrlInvalid: 'image invalid',
  gradientInvalid: 'gradient invalid',
} as const

describe('WEB Reiwa theme catalog', () => {
  it('keeps 8 standard themes ahead of 104 unique concepts', () => {
    const ids = THEME_PRESETS.map((preset) => preset.id)

    expect(LEGACY_THEME_PRESETS).toHaveLength(8)
    expect(CONCEPT_THEME_PRESETS).toHaveLength(104)
    expect(THEME_PRESETS).toHaveLength(112)
    expect(new Set(ids).size).toBe(112)
    expect(ids.slice(0, 8)).toEqual([
      'emerald',
      'royal',
      'sunset',
      'rose',
      'cyan',
      'violet',
      'amber',
      'mono',
    ])
    expect(ids[8]).toBe('concept-a')
    expect(ids.at(-1)).toBe('concept-cz')
    expect(THEME_PRESETS.every((preset) => preset.version === 2)).toBe(true)
    expect(LEGACY_THEME_PRESETS.every((preset) => preset.kind === 'legacy')).toBe(
      true,
    )
    expect(CONCEPT_THEME_PRESETS.every((preset) => preset.kind === 'concept')).toBe(
      true,
    )
  })

  it('keeps a standard theme patch from stomping concept-owned fields', () => {
    const base = createInitialBrandingDraft({
      cardEffect: 'aurora',
      cardEffectProps: { speed: 1.2 },
      cardEffectOpacity: 0.77,
      cardPattern: 'radial-gradient(circle, #fff 1px, transparent 1px)',
      borderRadius: 'rounded-none',
      cornerRadii: {
        cardPx: 0,
        itemPx: 0,
        pillPx: 0,
      },
      fontFamily: '"Newsreader Variable", Georgia, serif',
      surfaceTheme: {
        ...createInitialBrandingDraft().surfaceTheme,
        foreground: '#fafafa',
      },
      appBackground: {
        ...createInitialBrandingDraft().appBackground!,
        kind: 'gradient',
        gradient: 'linear-gradient(180deg, #111 0%, #222 100%)',
      },
    })
    const patch = createLegacyThemePresetVisualPatch(LEGACY_THEME_PRESETS[1])
    const resolved = { ...base, ...patch }

    expect(Object.keys(patch).sort()).toEqual(
      [
        'bgEffect',
        'bgPrimary',
        'bgSecondary',
        'cardGradient',
        'primary',
        'primaryFg',
        'themePresetId',
        'themePresetVersion',
      ].sort(),
    )
    expect(patch.themePresetId).toBe('royal')
    expect(resolved.cardEffect).toBe(base.cardEffect)
    expect(resolved.cardEffectProps).toEqual(base.cardEffectProps)
    expect(resolved.cardEffectOpacity).toBe(base.cardEffectOpacity)
    expect(resolved.cardPattern).toBe(base.cardPattern)
    expect(resolved.borderRadius).toBe(base.borderRadius)
    expect(resolved.cornerRadii).toEqual(base.cornerRadii)
    expect(resolved.fontFamily).toBe(base.fontFamily)
    expect(resolved.surfaceTheme).toEqual(base.surfaceTheme)
    expect(resolved.appBackground).toEqual(base.appBackground)
  })

  it('produces only supported effects and schema-valid resolved payloads', () => {
    const effects = new Set(CARD_EFFECT_REGISTRY.map((effect) => effect.id))
    const schema = createBrandingFormSchema(validationMessages)

    for (const preset of THEME_PRESETS) {
      const visualPatch = createThemePresetVisualPatch(preset)
      if (preset.kind === 'concept') {
        expect(effects.has(preset.cardEffect as never)).toBe(true)
      }
      const result = schema.safeParse({
        ...createInitialBrandingDraft(),
        ...visualPatch,
      })
      expect(
        result.success,
        preset.kind === 'concept'
          ? `${preset.code} ${preset.name}`
          : preset.id,
      ).toBe(true)
    }
  })

  it('maps floral and editorial concepts to visibly dynamic Paper effects', () => {
    const midnightSakura = CONCEPT_THEME_PRESETS.find(
      (preset) => preset.code === 'CA',
    )
    const editorialEffects = new Set(['paperMesh', 'paperSwirl'])

    expect(midnightSakura?.name).toBe('Midnight Sakura')
    expect(midnightSakura?.cardEffect).toBe('paperSwirl')
    expect(midnightSakura?.cardEffectProps).toMatchObject({
      speed: expect.any(Number),
      colors: expect.any(Array),
    })

    const editorialPaperPresets = CONCEPT_THEME_PRESETS.filter((preset) => {
      const descriptor = CONCEPT_PRESETS.find(
        (candidate) => candidate.id === preset.id,
      )
      return (
        new Set<string>(descriptor?.classification.visualTags).has('editorial') &&
        editorialEffects.has(preset.cardEffect)
      )
    })
    expect(editorialPaperPresets).not.toHaveLength(0)
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
      const label =
        preset.kind === 'concept' ? `${preset.code} ${preset.name}` : preset.id

      expect(result.success, label).toBe(true)
      if (!result.success) continue
      expect(result.data.themePresetId).toBe(preset.id)
      expect(result.data.themePresetVersion).toBe(preset.version)
      expect(result.data).not.toHaveProperty('brandName')
      expect(result.data).not.toHaveProperty('cardEffectsByIndex')
    }
  })

  it('keeps required foreground pairs at WCAG AA contrast', () => {
    // Standard themes keep their historical colours verbatim (amber sits just
    // under 4.5 by design). Concepts are audited to AA.
    for (const preset of CONCEPT_THEME_PRESETS) {
      expect(contrast(preset.primary, preset.primaryFg)).toBeGreaterThanOrEqual(4.5)
      expect(
        contrast(preset.bgPrimary, preset.surfaceTheme.foreground),
      ).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('reconstructs all concept presets deterministically with unique card compositions', () => {
    const reconstructed = CONCEPT_PRESETS.map(createConceptReiwaPreset)
    const cardGradients = CONCEPT_THEME_PRESETS.map((preset) => preset.cardGradient)

    expect(reconstructed).toEqual(CONCEPT_THEME_PRESETS)
    expect(new Set(cardGradients).size).toBe(CONCEPT_THEME_PRESETS.length)
  })

  it('resolves two valid brightnesses for every concept without exposing a second preset', () => {
    const schema = createBrandingFormSchema(validationMessages)

    for (const preset of CONCEPT_THEME_PRESETS) {
      const variants = createConceptThemeModeVariants(preset)
      const sourceMode = getConceptSourceMode(CONCEPT_PRESETS.find(
        (descriptor) => descriptor.id === preset.id,
      )!)
      const source = createConceptThemePresetVisualPatch(preset)
      const sourceVariant = variants[sourceMode]
      const completeVariants = {
        light: { ...variants.light, cardEffectsByIndex: [] },
        dark: { ...variants.dark, cardEffectsByIndex: [] },
      }
      const result = schema.safeParse({
        ...createInitialBrandingDraft(),
        ...source,
        themeModePolicy: 'user-selectable',
        themeDefaultMode: sourceMode,
        themeVariants: completeVariants,
      })

      expect(result.success, `${preset.code} ${preset.name}`).toBe(true)
      expect(sourceVariant.primary, `${preset.code} source primary`).toBe(source.primary)
      expect(sourceVariant.bgPrimary, `${preset.code} source background`).toBe(source.bgPrimary)
      expect(sourceVariant.cardGradient, `${preset.code} source card`).toBe(source.cardGradient)
      expect(sourceVariant.fontFamily, `${preset.code} source font`).toBe(source.fontFamily)
      expect(sourceVariant.subscriptionCardText, `${preset.code} card text`).toEqual({
        mode: 'auto',
        color: null,
      })
      expect(variants.light.themePresetId).toBe(preset.id)
      expect(variants.dark.themePresetId).toBe(preset.id)
    }
  })

  it('inherits an operator card-text policy into both concept brightness variants', () => {
    const preset = CONCEPT_THEME_PRESETS.find(({ code }) => code === 'CA')!
    const subscriptionCardText = { mode: 'custom' as const, color: '#123456' }
    const variants = createConceptThemeModeVariants(preset, subscriptionCardText)

    expect(variants.light.subscriptionCardText).toEqual(subscriptionCardText)
    expect(variants.dark.subscriptionCardText).toEqual(subscriptionCardText)
    expect(variants.light.cardGradient).not.toBe(variants.dark.cardGradient)
  })

  it('uses a broad semantic composition matrix instead of one generic layout', () => {
    const appCompositions = new Set(
      CONCEPT_THEME_PRESETS.map((preset) => preset.appComposition),
    )
    const cardCompositions = new Set(
      CONCEPT_THEME_PRESETS.map((preset) => preset.cardComposition),
    )

    expect(appCompositions.size).toBeGreaterThanOrEqual(7)
    expect(cardCompositions.size).toBeGreaterThanOrEqual(7)
  })

  it('maps Polar Red Monolith to angular app bands and an orbital card', () => {
    const preset = CONCEPT_THEME_PRESETS.find(({ code }) => code === 'CU')

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

  it('persists a complete gradient and texture recipe for every concept app background', () => {
    for (const preset of CONCEPT_THEME_PRESETS) {
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
    for (const preset of CONCEPT_THEME_PRESETS) {
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

  /**
   * The veil the cabinet paints under the direct copy is CHOSEN from a subset of
   * the colours the app background can produce: `resolveSoftLightTextureSamples`
   * stopped enumerating the blends between textured colours taken from different
   * points of the gradient, because a pixel never carries two gradient positions
   * at once and enumerating them cost 40x the whole resolver (`concept-cu`:
   * 1,346 ms down to 26 ms). That subset moved 12 of these 104 presets, every one
   * DOWNWARD and by at most 0.008 of veil opacity — it spends readability
   * headroom to buy the speed.
   *
   * This is the guard on what it spent. It asserts the veil AS CHOSEN against the
   * FULL painted model — `resolveAppBackgroundPaintedSamples`, cross-position
   * blends included — so the margin is measured against the background the
   * subscriber actually sees, not against the samples the chooser walked. Presets
   * that resolve to no veil are checked unveiled, which is what proves "no veil"
   * means "no veil needed" rather than "no veil helped".
   *
   * The worst margin is RECORDED, not merely bounded. It sits 0.028 above the 4.5
   * threshold — thin enough that a future change eating another 0.02 has to show
   * up as this number moving rather than as a test that still happens to pass.
   */
  const WORST_VEILED_CONTRAST = { code: 'F', margin: 4.5281 }

  it('keeps every concept veil AA-safe against the full painted app background', () => {
    let worst = { code: '', margin: Number.POSITIVE_INFINITY, detail: 'no sample examined' }

    for (const preset of CONCEPT_THEME_PRESETS) {
      const branding = {
        appBackground: preset.appBackground,
        bgPrimary: preset.bgPrimary,
        surfaceTheme: preset.surfaceTheme,
        themePresetId: preset.id,
      }
      const veil = resolveAppBackgroundReadability(branding)
      const painted = resolveAppBackgroundPaintedSamples(branding)
      expect(painted.length, `${preset.code} painted samples`).toBeGreaterThan(0)

      const veilHex = veil ? rgbHex(veil.veilRgb.split(' ').map(Number)) : '#000000'
      const veilOpacity = veil?.veilOpacity ?? 0

      for (const sample of painted) {
        const behindCopy = mix(veilHex, rgbHex(sample), veilOpacity)
        for (const text of [
          preset.surfaceTheme.foreground,
          preset.surfaceTheme.mutedForeground,
        ]) {
          const margin = contrast(text, behindCopy)
          if (margin >= worst.margin) continue
          worst = {
            code: preset.code,
            margin,
            detail:
              `${preset.code} (${preset.id}): ${text} on ${behindCopy} — ` +
              `sample ${rgbHex(sample)} under veil ${veilHex} at ${veilOpacity}`,
          }
        }
      }
    }

    expect(
      worst.margin,
      `a concept veil no longer keeps the direct copy AA-readable — ${worst.detail}`,
    ).toBeGreaterThanOrEqual(4.5)
    expect(
      { code: worst.code, margin: Number(worst.margin.toFixed(4)) },
      `the worst AA margin moved; re-measure and update WORST_VEILED_CONTRAST — ${worst.detail}`,
    ).toEqual(WORST_VEILED_CONTRAST)
    // Building the full painted model for all 104 presets is ~3.5s of real
    // arithmetic — the cross-position blends this guard restores are exactly the
    // ones the resolver stopped computing because they are expensive.
  }, 30_000)

  it('carries source semantics and exact angular geometry into Reiwa', () => {
    for (const [index, preset] of CONCEPT_THEME_PRESETS.entries()) {
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
    const visualPatch = createThemePresetVisualPatch(CONCEPT_THEME_PRESETS[37])
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

function rgbHex(rgb: readonly number[]): string {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
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
