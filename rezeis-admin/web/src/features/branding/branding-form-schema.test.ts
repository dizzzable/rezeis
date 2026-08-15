import { describe, expect, it } from 'vitest'

import {
  BORDER_RADIUS_CLASSES,
  CORNER_RADII_BY_LEGACY_CLASS,
  createBrandingFormSchema,
  createInitialBrandingDraft,
} from './branding-form-schema'

const messages = {
  hexInvalid: 'hex invalid',
  imageUrlInvalid: 'image url invalid',
  gradientInvalid: 'gradient invalid',
} as const

describe('branding form schema', () => {
  it('normalizes cleared branding URLs before submit', () => {
    const result = createBrandingFormSchema(messages).safeParse({
      ...createInitialBrandingDraft(),
      logoUrl: '   ',
      cardPattern: '   ',
      cardLogoUrl: '',
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.logoUrl).toBeNull()
    expect(result.data.cardPattern).toBeNull()
    expect(result.data.cardLogoUrl).toBeNull()
  })

  it('accepts HTTPS and data:image branding URLs', () => {
    const result = createBrandingFormSchema(messages).safeParse({
      ...createInitialBrandingDraft(),
      logoUrl: ' https://cdn.example.com/logo.png ',
      cardLogoUrl: 'data:image/svg+xml;base64,PHN2Zy8+',
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.logoUrl).toBe('https://cdn.example.com/logo.png')
    expect(result.data.cardLogoUrl).toBe('data:image/svg+xml;base64,PHN2Zy8+')
  })

  it('accepts only the relative upload bucket that Reiwa mirrors durably', () => {
    const accepted = createBrandingFormSchema(messages).safeParse({
      ...createInitialBrandingDraft(),
      logoUrl: '/uploads/branding/operator_logo-1.2.png',
    })

    expect(accepted.success).toBe(true)
    for (const logoUrl of [
      '/uploads/icons/operator-logo.png',
      '/uploads/branding/.hidden.svg',
      '/uploads/branding/a..png',
      '/uploads/branding/nested/logo.png',
      '/uploads/branding/logo.png?version=2',
    ]) {
      expect(
        createBrandingFormSchema(messages).safeParse({
          ...createInitialBrandingDraft(),
          logoUrl,
        }).success,
      ).toBe(false)
    }
  })

  it('rejects plain HTTP, credentials, non-image data URLs and other protocols', () => {
    const result = createBrandingFormSchema(messages).safeParse({
      ...createInitialBrandingDraft(),
      logoUrl: 'http://cdn.example.com/logo.png',
      pwaIconUrl: 'https://user:password@cdn.example.com/icon.png',
      cardLogoUrl: 'data:text/html;base64,PHNjcmlwdD4=',
      planCardStyles: {
        starter: { textureUrl: 'ftp://cdn.example.com/texture.png' },
      },
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ['logoUrl'], message: 'image url invalid' }),
        expect.objectContaining({ path: ['pwaIconUrl'], message: 'image url invalid' }),
        expect.objectContaining({ path: ['cardLogoUrl'], message: 'image url invalid' }),
        expect.objectContaining({
          path: ['planCardStyles', 'starter', 'textureUrl'],
          message: 'image url invalid',
        }),
      ]),
    )
  })

  it('uses the same durable asset contract for plan card textures', () => {
    const base = createInitialBrandingDraft()
    expect(
      createBrandingFormSchema(messages).safeParse({
        ...base,
        planCardStyles: {
          local: { textureUrl: '/uploads/branding/texture.webp' },
          remote: { textureUrl: 'https://cdn.example.com/texture.webp' },
          inline: { textureUrl: 'data:image/png;base64,AA==' },
        },
      }).success,
    ).toBe(true)
    expect(
      createBrandingFormSchema(messages).safeParse({
        ...base,
        planCardStyles: {
          unsafe: { textureUrl: '/uploads/branding/a..webp' },
        },
      }).success,
    ).toBe(false)
  })

  it('rejects malformed hex lengths that backend would refuse', () => {
    const base = createInitialBrandingDraft()
    const result = createBrandingFormSchema(messages).safeParse({
      ...base,
      primary: '#12345',
      surfaceTheme: {
        ...base.surfaceTheme,
        foreground: '#1234567',
      },
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ['primary'], message: 'hex invalid' }),
        expect.objectContaining({ path: ['surfaceTheme', 'foreground'], message: 'hex invalid' }),
      ]),
    )
  })

  it('normalizes legacy drafts and validates semantic surface ranges', () => {
    const legacy = createInitialBrandingDraft({
      themePresetId: undefined,
      themePresetVersion: undefined,
      surfaceTheme: {
        foreground: '#101010',
        surfaceOpacity: 4,
        glassBlurPx: 99,
      } as never,
    })

    expect(legacy.themePresetId).toBeNull()
    expect(legacy.themePresetVersion).toBeNull()
    expect(legacy.surfaceTheme.foreground).toBe('#101010')
    expect(legacy.surfaceTheme.surfaceOpacity).toBe(1)
    expect(legacy.surfaceTheme.glassBlurPx).toBe(40)
    expect(legacy.cornerRadii).toEqual({
      cardPx: 24,
      itemPx: 14,
      pillPx: 9999,
    })
    expect(
      createBrandingFormSchema(messages).safeParse(legacy).success,
    ).toBe(true)
  })

  it('normalizes malformed variants and rejects an incomplete user-selectable mode pair', () => {
    const legacy = createInitialBrandingDraft({
      themeModePolicy: 'user-selectable',
      themeDefaultMode: 'light',
      themeVariants: { light: {} } as never,
    })

    expect(legacy.themeModePolicy).toBe('user-selectable')
    expect(legacy.themeDefaultMode).toBe('light')
    expect(legacy.themeVariants).toBeNull()

    const invalid = createBrandingFormSchema(messages).safeParse({
      ...createInitialBrandingDraft(),
      themeModePolicy: 'user-selectable',
      themeVariants: { light: {}, dark: {} },
    })
    expect(invalid.success).toBe(false)
  })

  it('hydrates a legacy variant pair from the root card-text policy for the editable draft', () => {
    const base = createInitialBrandingDraft()
    const legacyVariant: Record<string, unknown> = { ...base }
    delete legacyVariant.subscriptionCardText
    const legacy = createInitialBrandingDraft({
      ...base,
      subscriptionCardText: { mode: 'custom', color: '#123456' },
      themeVariants: {
        light: { ...legacyVariant, themeVariants: null } as never,
        dark: { ...legacyVariant, themeVariants: null } as never,
      },
    })

    expect(legacy.themeVariants?.light.subscriptionCardText).toEqual({
      mode: 'custom',
      color: '#123456',
    })
    expect(legacy.themeVariants?.dark.subscriptionCardText).toEqual({
      mode: 'custom',
      color: '#123456',
    })
    expect(createBrandingFormSchema(messages).safeParse(legacy).success).toBe(true)
  })

  it('repairs malformed custom card text and clears stale non-custom colours in legacy drafts', () => {
    expect(
      createInitialBrandingDraft({
        subscriptionCardText: { mode: 'custom', color: 'rgb(1, 2, 3)' } as never,
      }).subscriptionCardText,
    ).toEqual({ mode: 'auto', color: null })
    expect(
      createInitialBrandingDraft({
        subscriptionCardText: { mode: 'light', color: '#123456' },
      }).subscriptionCardText,
    ).toEqual({ mode: 'light', color: null })
  })

  it('keeps exact corner radii editable and clamps malformed legacy input', () => {
    const custom = createInitialBrandingDraft({
      cornerRadii: { cardPx: 2, itemPx: 1, pillPx: 0 },
    })
    expect(
      createBrandingFormSchema(messages).safeParse(custom).success,
    ).toBe(true)

    const clamped = createInitialBrandingDraft({
      cornerRadii: { cardPx: 200, itemPx: -2, pillPx: 20_000 },
    })
    expect(clamped.cornerRadii).toEqual({
      cardPx: 48,
      itemPx: 0,
      pillPx: 9999,
    })
  })

  it('accepts layered gradients but rejects CSS image loaders and breakouts', () => {
    const base = createInitialBrandingDraft()
    expect(
      createBrandingFormSchema(messages).safeParse({
        ...base,
        cardGradient:
          'linear-gradient(135deg, #111, #222), radial-gradient(circle, #333, transparent)',
        cardPattern: 'repeating-linear-gradient(90deg, #fff2 0 1px, transparent 1px 8px)',
      }).success,
    ).toBe(true)

    const result = createBrandingFormSchema(messages).safeParse({
      ...base,
      cardGradient: 'url("https://attacker.invalid/card.png")',
      cardPattern:
        'linear-gradient(#fff, #000), url("https://attacker.invalid/pattern.png")',
      cardEffectsByIndex: [
        {
          cardEffect: 'aurora',
          cardEffectProps: {},
          cardEffectOpacity: 1,
          cardGradient: 'image-set(url("https://attacker.invalid/a.png") 1x)',
        },
      ],
      appBackground: {
        ...base.appBackground!,
        gradient: 'paint(attacker)',
      },
      planCardStyles: {
        starter: {
          gradient: 'linear-gradient(#fff, #000); color: red',
        },
      },
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues.map((issue) => issue.path.join('.'))).toEqual(
      expect.arrayContaining([
        'cardGradient',
        'cardPattern',
        'cardEffectsByIndex.0.cardGradient',
        'appBackground.gradient',
        'planCardStyles.starter.gradient',
      ]),
    )
  })

  it('rejects hex colors with unsupported lengths', () => {
    const result = createBrandingFormSchema(messages).safeParse({
      ...createInitialBrandingDraft(),
      primary: '#12345',
      primaryFg: '#1234567',
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ['primary'], message: 'hex invalid' }),
        expect.objectContaining({ path: ['primaryFg'], message: 'hex invalid' }),
      ]),
    )
  })

  it('rejects nested values that the backend would normalize away', () => {
    const base = createInitialBrandingDraft()
    const result = createBrandingFormSchema(messages).safeParse({
      ...base,
      cardEffect: 'unknownShader',
      appBackground: {
        ...base.appBackground,
        effect: 'unknownShader',
        texture: {
          ...base.appBackground!.texture,
          color: 'rgb(1, 2, 3)',
        },
      },
      iconColors: { support: '#12345' },
      planCardStyles: {
        starter: {
          accent: '#1234567',
          textureUrl: 'javascript:alert(1)',
          cardEffect: 'unknownShader',
        },
      },
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues.map((issue) => issue.path.join('.'))).toEqual(
      expect.arrayContaining([
        'cardEffect',
        'appBackground.effect',
        'appBackground.texture.color',
        'iconColors.support',
        'planCardStyles.starter.accent',
        'planCardStyles.starter.textureUrl',
        'planCardStyles.starter.cardEffect',
      ]),
    )
  })
})

/**
 * The radius vocabulary the Reiwa cabinet guard accepts, pinned here on
 * purpose. The cabinet copy lives in
 * `reiwa/src/application/ports/public-config-persistence.port.ts`
 * (`BORDER_RADII`), a different repository this build cannot import. A value
 * the panel writes but the cabinet refuses does not surface as an error: the
 * cabinet keeps serving its previous snapshot and its appearance freezes
 * there indefinitely. A seventh member has to reach the cabinet FIRST.
 */
const CABINET_BORDER_RADII = [
  'rounded-none',
  'rounded-lg',
  'rounded-xl',
  'rounded-2xl',
  'rounded-3xl',
  'rounded-full',
] as const

function themeVariantDraft(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const base = createInitialBrandingDraft()
  return {
    primary: base.primary,
    primaryFg: base.primaryFg,
    bgPrimary: base.bgPrimary,
    bgSecondary: base.bgSecondary,
    cardGradient: base.cardGradient,
    cardPattern: base.cardPattern,
    subscriptionCardText: base.subscriptionCardText,
    cardEffect: base.cardEffect,
    cardEffectProps: base.cardEffectProps,
    cardEffectOpacity: base.cardEffectOpacity,
    cardEffectsByIndex: [],
    bgEffect: base.bgEffect,
    appBackground: base.appBackground,
    borderRadius: base.borderRadius,
    cornerRadii: base.cornerRadii,
    fontFamily: base.fontFamily,
    surfaceTheme: base.surfaceTheme,
    ...overrides,
  }
}

describe('branding form schema — border radius vocabulary', () => {
  it('matches the vocabulary the cabinet accepts, from the one list the panel keeps', () => {
    expect([...BORDER_RADIUS_CLASSES]).toEqual([...CABINET_BORDER_RADII])
    // The list is the key set of the corner-radii map, not a second copy of it.
    expect([...BORDER_RADIUS_CLASSES]).toEqual(
      Object.keys(CORNER_RADII_BY_LEGACY_CLASS),
    )
  })

  it('accepts every radius class the cabinet accepts', () => {
    for (const borderRadius of CABINET_BORDER_RADII) {
      expect(
        createBrandingFormSchema(messages).safeParse({
          ...createInitialBrandingDraft(),
          borderRadius,
        }).success,
      ).toBe(true)
      expect(
        createBrandingFormSchema(messages).safeParse({
          ...createInitialBrandingDraft(),
          themeVariants: {
            light: themeVariantDraft({ borderRadius }),
            dark: themeVariantDraft({ borderRadius }),
          },
        }).success,
      ).toBe(true)
    }
  })

  it('still trims a padded radius rather than refusing it', () => {
    const result = createBrandingFormSchema(messages).safeParse({
      ...createInitialBrandingDraft(),
      borderRadius: '  rounded-3xl  ',
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.borderRadius).toBe('rounded-3xl')
  })

  it('refuses a radius the cabinet would reject, naming the value and the allowed set', () => {
    for (const borderRadius of ['squircle', 'rounded-4xl', 'Rounded-2xl', 'rounded']) {
      const result = createBrandingFormSchema(messages).safeParse({
        ...createInitialBrandingDraft(),
        borderRadius,
      })

      expect(result.success).toBe(false)
      if (result.success) continue
      const issue = result.error.issues.find(
        (candidate) => candidate.path.join('.') === 'borderRadius',
      )
      expect(issue).toBeDefined()
      expect(issue?.message).toContain(borderRadius)
      for (const allowed of CABINET_BORDER_RADII) {
        expect(issue?.message).toContain(allowed)
      }
    }
  })

  it('refuses the same radius inside a brightness variant', () => {
    const result = createBrandingFormSchema(messages).safeParse({
      ...createInitialBrandingDraft(),
      themeVariants: {
        light: themeVariantDraft({ borderRadius: 'squircle' }),
        dark: themeVariantDraft(),
      },
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues.map((issue) => issue.path.join('.'))).toEqual(
      expect.arrayContaining(['themeVariants.light.borderRadius']),
    )
  })

  it('keeps every hex spelling the operator can already type', () => {
    for (const primary of ['#abc', '#abcd', '#a1b2c3', '#a1b2c3d4']) {
      expect(
        createBrandingFormSchema(messages).safeParse({
          ...createInitialBrandingDraft(),
          primary,
        }).success,
      ).toBe(true)
    }
  })
})
