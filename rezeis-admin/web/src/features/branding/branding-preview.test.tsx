import { afterEach, describe, expect, it, vi } from 'vitest'

import { renderWithProviders } from '@/test/test-utils'

vi.mock('@/features/plans/plans-api', () => ({
  usePlans: () => ({ data: [] }),
}))

vi.mock('./card-effect-registry', () => ({
  CARD_EFFECT_COMPONENTS: {
    aurora: () => <div data-testid="preview-effect-renderer" />,
    liquidChrome: () => <div data-testid="preview-effect-renderer" />,
    lineWaves: () => <div data-testid="preview-effect-renderer" />,
    rippleGrid: () => <div data-testid="preview-effect-renderer" />,
    paperWarp: () => <div data-testid="preview-effect-renderer" />,
    paperGrain: () => <div data-testid="preview-effect-renderer" />,
    paperMesh: () => <div data-testid="preview-effect-renderer" />,
    paperSwirl: () => <div data-testid="preview-effect-renderer" />,
  },
  getCardEffectDefaults: () => ({}),
}))

import { BrandingPreview } from './branding-preview'
import { THEME_PRESETS } from './theme-presets'

type Rgb = readonly [number, number, number]

function hexRgb(value: string): Rgb {
  const body = value.replace(/^#/, '')
  return [
    Number.parseInt(body.slice(0, 2), 16),
    Number.parseInt(body.slice(2, 4), 16),
    Number.parseInt(body.slice(4, 6), 16),
  ]
}

function composite(foreground: Rgb, background: Rgb, alpha: number): Rgb {
  return foreground.map(
    (channel, index) =>
      channel * alpha + background[index] * (1 - alpha),
  ) as unknown as Rgb
}

function contrast(left: Rgb, right: Rgb): number {
  const luminance = (rgb: Rgb) => {
    const [red, green, blue] = rgb.map((channel) => {
      const normalized = channel / 255
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue
  }
  const a = luminance(left)
  const b = luminance(right)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function fullHeightGradientOpacities(
  readability: Element,
): readonly [number, number] {
  const background = (readability as HTMLElement).style.background
  const stops = new Map<number, number>()
  for (const match of background.matchAll(
    /rgba\(\s*[\d.]+,\s*[\d.]+,\s*[\d.]+,\s*([\d.]+)\s*\)\s*(0|100)%/g,
  )) {
    stops.set(Number(match[2]), Number(match[1]))
  }
  for (const match of background.matchAll(
    /rgb\(\s*[\d.]+\s+[\d.]+\s+[\d.]+\s*\/\s*([\d.]+)\s*\)\s*(0|100)%/g,
  )) {
    stops.set(Number(match[2]), Number(match[1]))
  }
  const start = stops.get(0)
  const end = stops.get(100)
  if (start === undefined || end === undefined) {
    throw new Error('Expected a generated full-height readability gradient')
  }
  return [start, end]
}

function themeHexRgb(value: string, backdrop: Rgb = [0, 0, 0]): Rgb {
  let body = value.replace(/^#/, '')
  if (body.length === 3 || body.length === 4) {
    body = body
      .split('')
      .map((channel) => `${channel}${channel}`)
      .join('')
  }
  const rgb = [
    Number.parseInt(body.slice(0, 2), 16),
    Number.parseInt(body.slice(2, 4), 16),
    Number.parseInt(body.slice(4, 6), 16),
  ] as Rgb
  if (body.length !== 8) return rgb
  return composite(
    rgb,
    backdrop,
    Number.parseInt(body.slice(6, 8), 16) / 255,
  )
}

describe('BrandingPreview subscription card', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('matches the normal reiwa layer order and clips the animated renderer', () => {
    const { container, getByTestId } = renderWithProviders(
      <BrandingPreview
        values={{
          brandName: 'Vivid Reiwa',
          primary: '#ef4444',
          primaryFg: '#ffffff',
          bgSecondary: '#111827',
          cardGradient: 'linear-gradient(135deg, #7f1d1d 0%, #ef4444 100%)',
          cardPattern:
            'linear-gradient(#ffffff33 1px, transparent 1px)',
          cardEffect: 'aurora',
          cardEffectProps: {},
          cardEffectOpacity: 0.84,
        }}
      />,
    )

    const card = container.querySelector('[data-preview-subscription-card]')
    expect(card).not.toBeNull()
    expect(card).toHaveClass('isolate', '[contain:paint]', 'overflow-hidden')
    expect(getByTestId('preview-effect-renderer')).toBeInTheDocument()

    const layers = Array.from(
      card?.querySelectorAll('[data-preview-card-layer]') ?? [],
    ).map((layer) => layer.getAttribute('data-preview-card-layer'))
    expect(layers).toEqual([
      'foundation',
      'gradient',
      'pattern',
      'effect',
    ])
    expect(card).toHaveAttribute('data-preview-card-artwork', 'animated')
    expect(
      card?.querySelector('[data-preview-card-layer="readability"]'),
    ).not.toBeInTheDocument()
    expect(
      card?.querySelector('[data-preview-card-effect-renderer]'),
    ).toHaveStyle({ opacity: '0.84' })
  })

  it('mirrors the dashboard device area and the configured bottom-nav spacing', () => {
    const { container } = renderWithProviders(
      <BrandingPreview
        values={{
          navGap: 17,
          navItems: [
            { id: 'subscriptions', visible: true },
            { id: 'referrals', visible: true },
            { id: 'settings', visible: true },
          ],
        }}
      />,
    )

    const nav = container.querySelector('[data-preview-bottom-nav]')
    const navItems = container.querySelector('[data-preview-nav-items]')

    expect(container.querySelector('[data-preview-phone-frame]')).toHaveClass('h-[560px]')
    expect(container.querySelector('[data-preview-devices]')).toBeInTheDocument()
    expect(nav).toHaveAttribute('data-preview-nav-gap', '17')
    expect(navItems).toHaveStyle({ gap: '17px' })
    expect(
      container.querySelectorAll('[data-preview-nav-tab]'),
    ).toHaveLength(3)
    expect(
      container.querySelector('[data-preview-nav-tab="subscriptions"]'),
    ).toHaveTextContent(/подпис|sub/i)
    expect(
      container.querySelector('[data-preview-nav-tab="referrals"]'),
    ).toHaveTextContent(/реферал|referral/i)
    expect(
      container.querySelector('[data-preview-nav-tab="settings"]'),
    ).toHaveTextContent(/настрой|settings/i)
  })

  it.each([
    {
      effect: 'paperWarp',
      colors: ['#121212', '#9470ff', '#8838ff'],
      opacity: 0.72,
    },
    {
      effect: 'paperGrain',
      colors: ['#7300ff', '#00bfff', '#000000'],
      opacity: 0.68,
    },
  ])('keeps $effect independent from the theme card artwork', ({ effect, colors, opacity }) => {
    const { container } = renderWithProviders(
      <BrandingPreview
        values={{
          bgSecondary: '#f8fafc',
          cardGradient: 'linear-gradient(135deg, #ffffff, #e2e8f0)',
          cardPattern: 'linear-gradient(#ff000033 1px, transparent 1px)',
          cardEffect: effect,
          cardEffectProps: { colors },
          cardEffectOpacity: opacity,
        }}
      />,
    )

    const card = container.querySelector('[data-preview-subscription-card]')
    const effectLayer = card?.querySelector(
      '[data-preview-card-layer="effect"]',
    )
    const pattern = card?.querySelector('[data-preview-card-layer="pattern"]')
    const artwork = card?.querySelector('[data-preview-card-effect-artwork]')

    expect(effectLayer).toHaveStyle({ backgroundColor: colors[0] })
    expect(artwork).toHaveStyle({ opacity: String(opacity) })
    expect(card).toHaveAttribute('data-preview-card-artwork', 'animated')
    expect(
      card?.querySelector('[data-preview-card-layer="readability"]'),
    ).not.toBeInTheDocument()
    expect(pattern?.compareDocumentPosition(effectLayer as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
  })

  it('uses one adaptive theme-derived readability veil across the full card', () => {
    const { container } = renderWithProviders(
      <BrandingPreview
        values={{
          primaryFg: '#0a0a0a',
          bgSecondary: '#f8fafc',
          cardGradient:
            'linear-gradient(135deg, #ffffff 0%, #e2e8f0 100%)',
          cardPattern: 'none',
          cardEffect: 'NONE',
        }}
      />,
    )

    const card = container.querySelector('[data-preview-subscription-card]')
    const readability = card?.querySelector(
      '[data-preview-card-layer="readability"]',
    )
    expect(card).toHaveAttribute('data-preview-card-foreground', 'dark')
    expect(readability).toHaveAttribute(
      'data-preview-card-readability',
      'wcag-full-card-veil',
    )
    const veil = readability?.getAttribute('data-preview-card-veil-opacity')
    expect(veil).toBeTruthy()
    expect(fullHeightGradientOpacities(readability!)).toEqual([
      Number(veil),
      Number(veil),
    ])
    expect(readability).not.toHaveClass(
      'from-black/40',
      'to-black/60',
      'bg-linear-to-b',
    )
    expect(
      card?.querySelector('[data-preview-card-layer="effect"]'),
    ).not.toBeInTheDocument()
    expect(
      Array.from(card?.querySelectorAll('[data-preview-card-layer]') ?? []).map(
        (layer) => layer.getAttribute('data-preview-card-layer'),
      ),
    ).toEqual(['foundation', 'gradient', 'readability'])
  })

  it('previews a concept texture over its gradient like the reiwa runtime', () => {
    const { container } = renderWithProviders(
      <BrandingPreview
        values={{
          themePresetId: 'concept-cu',
          appBackground: {
            kind: 'gradient',
            effect: 'NONE',
            props: {},
            opacity: 1,
            gradient:
              'linear-gradient(135deg, #edf5f7 0%, #c7dbe1 100%)',
            texture: {
              pattern: 'diagonal',
              color: '#e84545',
              background: '#edf5f7',
              scale: 32,
              opacity: 0.16,
            },
          },
        }}
      />,
    )

    const texture = container.querySelector(
      '[data-preview-app-background-texture="diagonal"]',
    )
    expect(texture).not.toBeNull()
    expect(texture).toHaveStyle({
      mixBlendMode: 'soft-light',
      backgroundRepeat: 'repeat',
    })
    expect(texture).not.toHaveStyle({ opacity: '0.8' })
  })

  it('supports AM header text without replacing its gradient or texture', () => {
    const { container } = renderWithProviders(
      <BrandingPreview
        values={{
          themePresetId: 'concept-am',
          bgPrimary: '#251225',
          surfaceTheme: {
            foreground: '#FFF7EF',
            mutedForeground: '#D6B7AD',
            surface: '#201019',
            surfaceHigh: '#201019',
            borderSoft: '#F28A4B',
            borderStrong: '#F28A4B',
            surfaceOpacity: 0.72,
            surfaceHighOpacity: 0.72,
            borderSoftOpacity: 0.24,
            borderStrongOpacity: 0.38,
            glassBlurPx: 24,
          },
          appBackground: {
            kind: 'gradient',
            effect: 'NONE',
            props: {},
            opacity: 1,
            gradient:
              'linear-gradient(90deg, #F28A4B20 0 28%, transparent 28% 100%), linear-gradient(180deg, #F3C79C -10%, #B56C68 35.6%, #5D3156 74%, #251225 110%)',
            texture: {
              pattern: 'noise',
              color: '#F28A4B',
              background: '#251225',
              scale: 64,
              opacity: 0.1,
            },
          },
        }}
      />,
    )

    const readability = container.querySelector(
      '[data-preview-app-readability="wcag-direct-copy-zones"]',
    )
    const veilOpacity = Number(
      readability?.getAttribute('data-preview-app-readability-opacity'),
    )
    expect(readability).not.toBeNull()
    expect(veilOpacity).toBeGreaterThanOrEqual(0.62)
    expect(readability).toHaveAttribute(
      'data-preview-app-readability-veil',
      'dark',
    )
    expect(readability?.getAttribute('style')).toContain(
      `rgba(0, 0, 0, ${veilOpacity}) 40%`,
    )
    expect(readability?.getAttribute('style')).toContain(
      `rgba(0, 0, 0, ${veilOpacity}) 84%`,
    )
    expect(
      container.querySelector(
        '[data-preview-app-background-texture="noise"]',
      ),
    ).not.toBeNull()
  })

  it('supports a medium muted token on a Concept A-like dark shell', () => {
    const { container } = renderWithProviders(
      <BrandingPreview
        values={{
          themePresetId: 'concept-a',
          bgPrimary: '#090706',
          surfaceTheme: {
            foreground: '#ECE5DF',
            mutedForeground: '#8A807B',
            surface: '#171311',
            surfaceHigh: '#171311',
            borderSoft: '#8E211B',
            borderStrong: '#8E211B',
            surfaceOpacity: 0.72,
            surfaceHighOpacity: 0.72,
            borderSoftOpacity: 0.24,
            borderStrongOpacity: 0.38,
            glassBlurPx: 24,
          },
          appBackground: {
            kind: 'gradient',
            effect: 'NONE',
            props: {},
            opacity: 1,
            gradient:
              'radial-gradient(ellipse 50% 37% at 16% 5%, #351411 0%, #090706 100%)',
            texture: {
              pattern: 'noise',
              color: '#8E211B',
              background: '#090706',
              scale: 64,
              opacity: 0.1,
            },
          },
        }}
      />,
    )

    const readability = container.querySelector(
      '[data-preview-app-readability="wcag-direct-copy-zones"]',
    )
    const veilOpacity = Number(
      readability?.getAttribute('data-preview-app-readability-opacity'),
    )
    expect(readability).not.toBeNull()
    expect(readability).toHaveAttribute(
      'data-preview-app-readability-veil',
      'dark',
    )
    expect(veilOpacity).toBeGreaterThan(0)

    for (const sample of ['#351411', '#090706'].map(hexRgb)) {
      const supported = composite([0, 0, 0], sample, veilOpacity)
      expect(contrast(hexRgb('#ECE5DF'), supported)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(hexRgb('#8A807B'), supported)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('does not invent a white app veil for dark shell copy', () => {
    const { container } = renderWithProviders(
      <BrandingPreview
        values={{
          bgPrimary: '#ffffff',
          surfaceTheme: {
            foreground: '#111827',
            mutedForeground: '#334155',
            surface: '#ffffff',
            surfaceHigh: '#f8fafc',
            borderSoft: '#0f172a',
            borderStrong: '#0f172a',
            surfaceOpacity: 0.72,
            surfaceHighOpacity: 0.8,
            borderSoftOpacity: 0.12,
            borderStrongOpacity: 0.2,
            glassBlurPx: 12,
          },
          appBackground: {
            kind: 'gradient',
            effect: 'NONE',
            props: {},
            opacity: 1,
            gradient: 'linear-gradient(180deg, #ffffff, #e2e8f0)',
            texture: {
              pattern: 'grid',
              color: '#ffffff',
              background: '#ffffff',
              scale: 32,
              opacity: 0,
            },
          },
        }}
      />,
    )

    expect(
      container.querySelector('[data-preview-app-readability]'),
    ).toBeNull()
  })

  it('keeps direct shell copy AA-safe across all 104 concept backgrounds', () => {
    const failures: string[] = []
    const conceptPresets = THEME_PRESETS.filter(
      (preset): preset is Extract<typeof preset, { kind: 'concept' }> =>
        preset.kind === 'concept',
    )

    for (const preset of conceptPresets) {
      const { container, unmount } = renderWithProviders(
        <BrandingPreview
          values={{ ...preset, themePresetId: preset.id }}
        />,
      )
      const readability = container.querySelector(
        '[data-preview-app-readability="wcag-direct-copy-zones"]',
      )
      const veilOpacity = readability
        ? Number(
            readability.getAttribute(
              'data-preview-app-readability-opacity',
            ),
          )
        : 0
      const veil =
        readability?.getAttribute('data-preview-app-readability-veil') ===
        'light'
          ? ([255, 255, 255] as Rgb)
          : ([0, 0, 0] as Rgb)
      const foundation = themeHexRgb(preset.bgPrimary)
      const gradientSamples = Array.from(
        preset.appBackground.gradient.matchAll(
          /#[\da-f]{3,8}(?![\da-f])/gi,
        ),
      ).map((match) => themeHexRgb(match[0], foundation))
      const textureBackground = themeHexRgb(
        preset.appBackground.texture.background,
      )
      const textureSample = composite(
        themeHexRgb(preset.appBackground.texture.color),
        textureBackground,
        preset.appBackground.texture.opacity,
      )
      const samples = [
        ...gradientSamples,
        textureBackground,
        textureSample,
      ]
      const textColors = [
        themeHexRgb(preset.surfaceTheme.foreground),
        themeHexRgb(preset.surfaceTheme.mutedForeground),
      ]

      for (const [sampleIndex, sample] of samples.entries()) {
        const supported =
          veilOpacity > 0
            ? composite(veil, sample, veilOpacity)
            : sample
        for (const [textIndex, text] of textColors.entries()) {
          const ratio = contrast(text, supported)
          if (ratio < 4.5) {
            failures.push(
              `${preset.id}:sample-${sampleIndex}:text-${textIndex}:${ratio.toFixed(3)}:veil-${readability?.getAttribute('data-preview-app-readability-veil') ?? 'none'}-${veilOpacity}`,
            )
          }
        }
      }
      unmount()
    }

    expect(conceptPresets).toHaveLength(104)
    expect(THEME_PRESETS).toHaveLength(112)
    expect(failures).toEqual([])
  })

  it('keeps bright animated colours vivid without copy capsules', () => {
    const { container } = renderWithProviders(
      <BrandingPreview
        values={{
          primaryFg: '#ffffff',
          bgSecondary: '#020617',
          cardGradient:
            'linear-gradient(135deg, #020617 0%, #111827 100%)',
          cardEffect: 'aurora',
          cardEffectProps: { colorStops: ['#e6ff58'] },
          cardEffectOpacity: 0.84,
        }}
      />,
    )

    const card = container.querySelector(
      '[data-preview-subscription-card]',
    )
    expect(card).toHaveAttribute('data-preview-card-artwork', 'animated')
    expect(
      card?.querySelector('[data-preview-card-layer="readability"]'),
    ).not.toBeInTheDocument()
    expect(
      card?.querySelector('[data-preview-card-local-support]'),
    ).not.toBeInTheDocument()
    expect(
      card?.querySelector('[data-preview-card-profile-support]'),
    ).not.toBeInTheDocument()
    expect(card).not.toHaveStyle({
      textShadow: '0 1px 2px rgba(0, 0, 0, 0.42)',
    })
    expect((card as HTMLElement | null)?.style.textShadow ?? '').toBe('')
  })

  it('includes numeric shader colour vectors in preview contrast', () => {
    const { container } = renderWithProviders(
      <BrandingPreview
        values={{
          primaryFg: '#ffffff',
          bgSecondary: '#020617',
          cardGradient:
            'linear-gradient(135deg, #020617 0%, #111827 100%)',
          cardEffect: 'liquidChrome',
          cardEffectProps: { baseColor: [1, 1, 1] },
          cardEffectOpacity: 0.9,
        }}
      />,
    )

    const effect = container.querySelector(
      '[data-preview-card-layer="effect"]',
    )
    expect(effect).toHaveAttribute(
      'data-preview-card-effect-foundation',
      '#ffffff',
    )
  })

  it('keeps concept CS readable when LineWaves amplifies dark inputs to yellow', () => {
    const { container } = renderWithProviders(
      <BrandingPreview
        values={{
          primary: '#9A6A24',
          primaryFg: '#ffffff',
          bgSecondary: '#F2ECDE',
          cardGradient:
            'radial-gradient(ellipse 90% 58% at 64% 8%, #807158CC 0%, transparent 64%), linear-gradient(180deg, #2B2922 0%, #2B1E0A 54%, #000000 100%)',
          cardEffect: 'lineWaves',
          cardEffectProps: {
            color1: '#9A6A24',
            color2: '#553A15',
            color3: '#000000',
            brightness: 0.28,
          },
          cardEffectOpacity: 0.84,
        }}
      />,
    )

    const card = container.querySelector('[data-preview-subscription-card]')
    expect(card).toHaveAttribute('data-preview-card-foreground', 'dark')
    expect(card).toHaveAttribute('data-preview-card-artwork', 'animated')
    expect(
      card?.querySelector('[data-preview-card-layer="readability"]'),
    ).not.toBeInTheDocument()
    expect(
      card?.querySelector('[data-preview-card-local-support]'),
    ).not.toBeInTheDocument()
    expect((card as HTMLElement | null)?.style.textShadow ?? '').toBe('')
  })

  it.each([
    {
      name: 'LineWaves full output gamut',
      values: {
        primary: '#158C88',
        primaryFg: '#000000',
        bgSecondary: '#F1FAF8',
        cardGradient:
          'radial-gradient(ellipse 90% 58% at 88% 8%, #F29B84CC 0%, transparent 64%), linear-gradient(180deg, #0B5E5A 0%, #165251 54%, #163B3B 100%)',
        cardEffect: 'lineWaves',
        cardEffectProps: {
          color1: '#158C88',
          color2: '#0B5E5A',
          color3: '#000000',
        },
        cardEffectOpacity: 1,
      },
    },
    {
      name: 'RippleGrid full output gamut',
      values: {
        primary: '#65E6FF',
        primaryFg: '#ffffff',
        bgSecondary: '#04111A',
        cardGradient:
          'linear-gradient(170deg, #03080B 0 44%, #204B54 44% 67%, #04111A 67% 100%)',
        cardEffect: 'rippleGrid',
        cardEffectProps: {
          gridColor: '#65E6FF',
          glowIntensity: 0.16,
        },
        cardEffectOpacity: 1,
      },
    },
  ])(
    'keeps animated $name uncovered without copy capsules or outlines',
    ({ values }) => {
      const { container } = renderWithProviders(
        <BrandingPreview values={values} />,
      )
      const card = container.querySelector(
        '[data-preview-subscription-card]',
      )
      expect(card).toHaveAttribute('data-preview-card-artwork', 'animated')
      expect(
        card?.querySelector('[data-preview-card-layer="readability"]'),
      ).not.toBeInTheDocument()
      expect(
        card?.querySelector('[data-preview-card-local-support]'),
      ).not.toBeInTheDocument()
      expect(
        card?.querySelector('[data-preview-card-profile-support]'),
      ).not.toBeInTheDocument()
      expect(card?.querySelector('[data-preview-card-copy-band]')).toBeNull()
      expect((card as HTMLElement | null)?.style.textShadow ?? '').toBe('')
      const foregroundTone = card?.getAttribute('data-preview-card-foreground')
      expect(['dark', 'light']).toContain(foregroundTone)
      expect(
        card?.querySelector('[data-preview-card-layer="effect"]'),
      ).toBeInTheDocument()
    },
  )

  it('keeps the configured card effect live while reduced motion preserves accessible carousel targets', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    )
    const { container, getByTestId } = renderWithProviders(
      <BrandingPreview
        values={{
          cardEffect: 'aurora',
          cardEffectProps: {},
          cardEffectsByIndex: [
            {
              cardEffect: 'aurora',
              cardEffectProps: {},
              cardEffectOpacity: 0.8,
              cardGradient: 'linear-gradient(#111827, #2563eb)',
            },
            {
              cardEffect: 'aurora',
              cardEffectProps: {},
              cardEffectOpacity: 0.8,
              cardGradient: 'linear-gradient(#7f1d1d, #ef4444)',
            },
          ],
        }}
      />,
    )

    expect(getByTestId('preview-effect-renderer')).toBeInTheDocument()
    const effect = container.querySelector(
      '[data-preview-card-layer="effect"]',
    )
    expect(effect).toHaveAttribute(
      'data-preview-card-effect-runtime',
      'live',
    )
    expect(
      effect?.querySelector('[data-preview-card-effect-artwork]'),
    ).toHaveStyle({ opacity: '0.8' })
    expect(
      container.querySelector('[data-preview-subscription-card]'),
    ).toHaveAttribute('data-preview-card-artwork', 'animated')
    expect(
      container.querySelector('[data-preview-card-layer="readability"]'),
    ).not.toBeInTheDocument()
    const dots = container.querySelectorAll('button[aria-current]')
    expect(dots).toHaveLength(2)
    dots.forEach((dot) => {
      expect(dot).toHaveClass('h-6', 'w-6', 'focus-visible:ring-2')
      expect(dot.firstElementChild).toHaveAttribute('aria-hidden', 'true')
    })
  })
})
