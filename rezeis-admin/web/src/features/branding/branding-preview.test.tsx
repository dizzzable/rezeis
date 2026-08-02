import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { renderWithProviders } from '@/test/test-utils'
import { act, waitFor } from '@testing-library/react'

const delayedPreviewRenderer = vi.hoisted(() => {
  type DelayedModule = { default: () => null }
  let resolveImport: ((module: DelayedModule) => void) | null = null
  const importPromise = new Promise<DelayedModule>((resolve) => {
    resolveImport = resolve
  })

  return {
    importPromise,
    resolve() {
      resolveImport?.({ default: () => null })
    },
  }
})

const previewPlans = vi.hoisted(() => ({ data: [] as unknown[] }))

vi.mock('@/features/plans/plans-api', () => ({
  usePlans: () => ({ data: previewPlans.data }),
}))

vi.mock('./card-effect-registry', async () => {
  const { lazy } = await import('react')
  return {
    CARD_EFFECT_COMPONENTS: {
      aurora: () => <canvas data-testid="preview-effect-renderer" />,
      liquidChrome: () => <canvas data-testid="preview-effect-renderer" />,
      lineWaves: () => <canvas data-testid="preview-effect-renderer" />,
      rippleGrid: () => <canvas data-testid="preview-effect-renderer" />,
      plasma: () => <canvas data-testid="preview-effect-renderer" />,
      grainient: () => <canvas data-testid="preview-effect-renderer" />,
      silk: () => <canvas data-testid="preview-effect-renderer" />,
      beams: () => <canvas data-testid="preview-effect-renderer" />,
      dither: () => <canvas data-testid="preview-effect-renderer" />,
      paperWarp: () => <canvas data-testid="preview-effect-renderer" />,
      paperGrain: () => <canvas data-testid="preview-effect-renderer" />,
      paperMesh: () => <canvas data-testid="preview-effect-renderer" />,
      paperSwirl: () => <canvas data-testid="preview-effect-renderer" />,
      waves: () => <canvas data-testid="preview-effect-renderer" />,
      radar: () => {
        throw new Error('preview renderer failed')
      },
      // A real LazyExoticComponent whose import has not settled. This covers
      // the exact interval in which Suspense must preserve the card baseline.
      threads: lazy(
        () => new Promise<{ default: () => null }>(() => {}),
      ),
      softAurora: lazy(() => delayedPreviewRenderer.importPromise),
    },
    getCardEffectDefaults: () => ({}),
  }
})

import { BrandingPreview } from './branding-preview'
import {
  observePreviewCardEffectCanvases,
  requiresPreviewCardEffectWebGL2,
} from './card-effect-preview-utils'
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
  beforeEach(() => {
    previewPlans.data = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(0)
        return 1
      }),
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      (() => ({
        getExtension: vi.fn().mockReturnValue({ loseContext: vi.fn() }),
      })) as unknown as typeof HTMLCanvasElement.prototype.getContext,
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
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
    expect(
      card?.querySelector('[data-preview-card-layer="effect"]'),
    ).not.toHaveStyle({ mixBlendMode: 'screen' })
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
  ])('renders $effect natively without replacing the operator card gradient', ({ effect, colors, opacity }) => {
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
    const renderer = card?.querySelector('[data-preview-card-effect-renderer]')

    expect(effectLayer).toHaveAttribute(
      'data-preview-card-effect-foundation',
      'transparent',
    )
    expect((effectLayer as HTMLElement | null)?.style.backgroundColor ?? '').toBe('')
    expect(renderer).toHaveStyle({ opacity: String(opacity) })
    expect(effectLayer).not.toHaveStyle({ mixBlendMode: 'screen' })
    expect(
      renderer?.querySelector('[data-testid="preview-effect-renderer"]'),
    ).toBeInTheDocument()
    // No CSS palette may sit beneath a working native renderer: it would tint
    // the operator-selected artwork instead of simply rendering the effect.
    expect(
      card?.querySelector('[data-preview-card-effect-artwork]'),
    ).not.toBeInTheDocument()
    expect(card).toHaveAttribute('data-preview-card-artwork', 'animated')
    expect(
      card?.querySelector('[data-preview-card-layer="readability"]'),
    ).not.toBeInTheDocument()
    expect(pattern?.compareDocumentPosition(effectLayer as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
  })

  it('keeps the operator gradient untouched while a lazy card effect is loading', () => {
    const cardGradient = 'linear-gradient(135deg, #102030 0%, #405060 100%)'
    const { container } = renderWithProviders(
      <BrandingPreview
        values={{
          bgSecondary: '#0a0b0c',
          cardGradient,
          cardEffect: 'threads',
          cardEffectProps: { color: '#ff00aa' },
          cardEffectOpacity: 0.86,
        }}
      />,
    )

    const card = container.querySelector('[data-preview-subscription-card]')
    const foundation = card?.querySelector('[data-preview-card-layer="foundation"]')
    const gradient = card?.querySelector('[data-preview-card-layer="gradient"]')

    expect(card).toHaveAttribute('data-preview-card-artwork', 'animated')
    expect(foundation).toHaveStyle({ backgroundColor: '#0a0b0c' })
    expect(gradient).toHaveStyle({ backgroundImage: cardGradient })
    expect(
      card?.querySelector('[data-preview-card-layer="effect"]'),
    ).toHaveAttribute('data-preview-card-effect-runtime', 'native')
    expect(
      card?.querySelector('[data-preview-card-effect-artwork]'),
    ).not.toBeInTheDocument()
    expect(
      card?.querySelector('[data-preview-card-effect-renderer]'),
    ).not.toBeInTheDocument()
  })

  it('uses alpha CSS artwork on a WebGL1-only preview without replacing the configured gradient', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      ((contextId: string) =>
        contextId === 'webgl'
          ? ({ getExtension: vi.fn().mockReturnValue({ loseContext: vi.fn() }) } as unknown as WebGLRenderingContext)
          : null) as unknown as typeof HTMLCanvasElement.prototype.getContext,
    )
    const gradient = 'linear-gradient(135deg, #052e16, #0f766e)'
    const { container } = renderWithProviders(
      <BrandingPreview
        values={{
          bgSecondary: '#020617',
          cardGradient: gradient,
          cardEffect: 'paperWarp',
          cardEffectProps: { colors: ['#121212', '#9470ff', '#8838ff'] },
          cardEffectOpacity: 1,
        }}
      />,
    )

    const card = container.querySelector('[data-preview-subscription-card]')
    const gradientLayer = card?.querySelector('[data-preview-card-layer="gradient"]')
    const effect = card?.querySelector('[data-preview-card-layer="effect"]')
    const artwork = card?.querySelector('[data-preview-card-effect-artwork]')

    expect(gradientLayer).toHaveStyle({ backgroundImage: gradient })
    expect(effect).toHaveAttribute('data-preview-card-effect-runtime', 'css-fallback')
    expect(effect).toHaveAttribute('data-preview-card-effect-foundation', 'transparent')
    expect(artwork).toHaveStyle({ opacity: '1' })
    expect(effect).not.toHaveStyle({ mixBlendMode: 'screen' })
    expect((artwork as HTMLElement | null)?.style.backgroundColor ?? '').toBe('')
    expect((artwork as HTMLElement | null)?.style.backgroundImage).not.toContain('linear-gradient')
    expect(card?.querySelector('[data-preview-card-effect-renderer]')).toBeNull()
  })

  it('keeps Aurora native on a WebGL1-only preview', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      ((contextId: string) =>
        contextId === 'webgl'
          ? ({ getExtension: vi.fn().mockReturnValue({ loseContext: vi.fn() }) } as unknown as WebGLRenderingContext)
          : null) as unknown as typeof HTMLCanvasElement.prototype.getContext,
    )
    const { container } = renderWithProviders(
      <BrandingPreview values={{ cardEffect: 'aurora', cardEffectProps: {} }} />,
    )

    expect(
      container.querySelector('[data-preview-card-layer="effect"]'),
    ).toHaveAttribute('data-preview-card-effect-runtime', 'native')
    expect(
      container.querySelector('[data-preview-card-effect-renderer]'),
    ).toBeInTheDocument()
  })

  it('keeps WebGL1-compatible effects native instead of substituting Aurora', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      ((contextId: string) =>
        contextId === 'webgl'
          ? ({ getExtension: vi.fn().mockReturnValue({ loseContext: vi.fn() }) } as unknown as WebGLRenderingContext)
          : null) as unknown as typeof HTMLCanvasElement.prototype.getContext,
    )
    const { container } = renderWithProviders(
      <BrandingPreview values={{ cardEffect: 'lineWaves', cardEffectProps: {} }} />,
    )

    const effect = container.querySelector('[data-preview-card-layer="effect"]')
    expect(effect).toHaveAttribute('data-preview-card-effect-runtime', 'native')
    expect(
      effect?.querySelector('[data-preview-card-effect-renderer]'),
    ).toHaveAttribute('data-preview-card-effect-renderer-source', 'lineWaves')
  })

  it('uses a CSS fallback when the Canvas2D Waves renderer cannot initialise', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      ((contextId: string) =>
        contextId === '2d'
          ? null
          : ({ getExtension: vi.fn().mockReturnValue({ loseContext: vi.fn() }) } as unknown as WebGLRenderingContext)) as unknown as typeof HTMLCanvasElement.prototype.getContext,
    )
    const { container } = renderWithProviders(
      <BrandingPreview values={{ cardEffect: 'waves', cardEffectProps: {} }} />,
    )

    const effect = container.querySelector('[data-preview-card-layer="effect"]')
    expect(effect).toHaveAttribute('data-preview-card-effect-runtime', 'css-fallback')
    expect(
      effect?.querySelector('[data-preview-card-effect-artwork]'),
    ).toBeInTheDocument()
    expect(
      effect?.querySelector('[data-preview-card-effect-renderer]'),
    ).not.toBeInTheDocument()
  })

  it('guards configured app-background artwork and preserves its gradient foundation', () => {
    const appGradient = 'linear-gradient(135deg, #020617, #1d4ed8)'
    const { container } = renderWithProviders(
      <BrandingPreview
        values={{
          appBackground: {
            kind: 'effect',
            effect: 'lineWaves',
            props: { color1: '#38bdf8', color2: '#1d4ed8', color3: '#020617' },
            opacity: 0.72,
            gradient: appGradient,
            texture: {
              pattern: 'dots',
              color: '#38bdf8',
              background: '#020617',
              scale: 24,
              opacity: 0.15,
            },
          },
        }}
      />,
    )

    expect(
      container.querySelector('[data-preview-app-background-layer="foundation"]'),
    ).toHaveStyle({ backgroundImage: appGradient })
    const effect = container.querySelector('[data-preview-app-background-layer="effect"]')
    expect(
      effect?.querySelector('[data-preview-card-layer="effect"]'),
    ).toHaveAttribute('data-preview-card-effect-runtime', 'native')
    expect(
      effect?.querySelector('[data-preview-card-effect-renderer]'),
    ).toHaveStyle({ opacity: '0.72' })
  })

  it('uses the guarded renderer for per-plan effects in the tariff preview', () => {
    previewPlans.data = [
      {
        id: 'starter',
        name: 'Starter',
        icon: 'sparkles',
        trafficLimit: 10,
        deviceLimit: 2,
      },
    ]
    const { container } = renderWithProviders(
      <BrandingPreview
        focus="planCards"
        values={{
          planCardStyles: {
            starter: {
              cardEffect: 'lineWaves',
              cardEffectProps: { color1: '#38bdf8', color2: '#1d4ed8', color3: '#020617' },
              cardEffectOpacity: 0.68,
            },
          },
        }}
      />,
    )

    const tariff = container.querySelector('[data-preview-tariff-card]')
    const effect = tariff?.querySelector('[data-preview-card-layer="effect"]')
    expect(effect).toHaveAttribute('data-preview-card-effect-runtime', 'native')
    expect(
      effect?.querySelector('[data-preview-card-effect-renderer]'),
    ).toHaveAttribute('data-preview-card-effect-renderer-source', 'lineWaves')
    expect(
      effect?.querySelector('[data-preview-card-effect-renderer]'),
    ).toHaveStyle({ opacity: '0.68' })
  })

  it.each([
    {
      effect: 'plasma',
      props: { color: '#12ab34' },
      expectedColor: 'rgb(18, 171, 52)',
    },
    {
      effect: 'grainient',
      props: { color1: '#123456', color2: '#abcdef', color3: '#fedcba' },
      expectedColor: 'rgb(171, 205, 239)',
    },
    {
      effect: 'silk',
      props: { color: '#456789' },
      expectedColor: 'rgb(69, 103, 137)',
    },
    {
      effect: 'beams',
      props: { lightColor: '#987654' },
      expectedColor: 'rgb(152, 118, 84)',
    },
    {
      effect: 'dither',
      props: { waveColor: [0.2, 0.4, 0.6] },
      expectedColor: 'rgb(51, 102, 153)',
    },
  ])(
    'preserves the configured $effect palette with CSS on WebGL1 instead of substituting Aurora',
    ({ effect, props, expectedColor }) => {
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
        ((contextId: string) =>
          contextId === 'webgl'
            ? ({ getExtension: vi.fn().mockReturnValue({ loseContext: vi.fn() }) } as unknown as WebGLRenderingContext)
            : null) as unknown as typeof HTMLCanvasElement.prototype.getContext,
      )
      const { container } = renderWithProviders(
        <BrandingPreview
          values={{ cardEffect: effect, cardEffectProps: props }}
        />,
      )

      const layer = container.querySelector('[data-preview-card-layer="effect"]')
      const artwork = layer?.querySelector('[data-preview-card-effect-artwork]')
      expect(layer).toHaveAttribute('data-preview-card-effect-runtime', 'css-fallback')
      expect(layer?.querySelector('[data-preview-card-effect-renderer]')).toBeNull()
      expect((artwork as HTMLElement | null)?.style.backgroundImage).toContain(expectedColor)
    },
  )

  it.each([
    'plasma',
    'grainient',
    'silk',
    'beams',
    'dither',
    'paperMesh',
    'paperWarp',
    'paperGrain',
    'paperDither',
    'paperSwirl',
    'paperMetaballs',
  ])('classifies %s as WebGL2-only', (effect) => {
    expect(requiresPreviewCardEffectWebGL2(effect)).toBe(true)
  })

  it.each(['aurora', 'threads', 'softAurora', 'waves'])(
    'does not misclassify %s as WebGL2-only',
    (effect) => {
      expect(requiresPreviewCardEffectWebGL2(effect)).toBe(false)
    },
  )

  it('does not treat a cold lazy chunk as a GPU failure, then catches a committed blank renderer', async () => {
    vi.useFakeTimers()
    const { container } = renderWithProviders(
      <BrandingPreview
        values={{
          cardEffect: 'softAurora',
          cardEffectProps: { color1: '#123456', color2: '#abcdef' },
        }}
      />,
    )

    act(() => vi.advanceTimersByTime(5_000))
    const layer = container.querySelector('[data-preview-card-layer="effect"]')
    expect(layer).toHaveAttribute('data-preview-card-effect-runtime', 'native')
    expect(layer).toHaveAttribute('data-preview-card-effect-ready', 'false')
    expect(layer?.querySelector('[data-preview-card-effect-artwork]')).toBeNull()

    await act(async () => {
      delayedPreviewRenderer.resolve()
      await Promise.resolve()
    })
    expect(layer).toHaveAttribute('data-preview-card-effect-ready', 'true')

    act(() => vi.advanceTimersByTime(1_200))
    expect(layer).toHaveAttribute('data-preview-card-effect-runtime', 'css-fallback')
    expect(layer?.querySelector('[data-preview-card-effect-artwork]')).toBeInTheDocument()
  })

  it('reports a preview renderer that silently fails to create its canvas', () => {
    vi.useFakeTimers()
    const root = document.createElement('div')
    const onFailure = vi.fn()
    const stop = observePreviewCardEffectCanvases(root, onFailure, 25)

    vi.advanceTimersByTime(25)
    expect(onFailure).toHaveBeenCalledOnce()

    stop()
    vi.useRealTimers()
  })

  it.each(['webglcontextlost', 'webglcontextcreationerror'])(
    'reports an explicit %s event after renderer commit',
    (eventName) => {
      const root = document.createElement('div')
      const canvas = document.createElement('canvas')
      root.append(canvas)
      const onFailure = vi.fn()
      const stop = observePreviewCardEffectCanvases(root, onFailure, 25)

      canvas.dispatchEvent(new Event(eventName))
      expect(onFailure).toHaveBeenCalledOnce()

      stop()
    },
  )

  it('uses a native preview effect at the saved 100% intensity without replacing the gradient', () => {
    const { container } = renderWithProviders(
      <BrandingPreview
        values={{
          cardEffect: 'paperWarp',
          cardEffectProps: { colors: ['#121212', '#9470ff', '#8838ff'] },
          cardEffectOpacity: 1,
        }}
      />,
    )

    expect(
      container.querySelector('[data-preview-card-effect-renderer]'),
    ).toHaveStyle({ opacity: '1' })
    expect(
      container.querySelector('[data-preview-card-layer="effect"]'),
    ).not.toHaveStyle({ mixBlendMode: 'screen' })
  })

  it('recovers to CSS artwork when a native preview renderer throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { container } = renderWithProviders(
      <BrandingPreview
        values={{
          cardEffect: 'radar',
          cardEffectProps: { color: '#9f29ff' },
          cardEffectOpacity: 0.8,
        }}
      />,
    )

    await waitFor(() => {
      expect(
        container.querySelector('[data-preview-card-layer="effect"]'),
      ).toHaveAttribute('data-preview-card-effect-runtime', 'css-fallback')
    })
    expect(
      container.querySelector('[data-preview-card-effect-artwork]'),
    ).toHaveStyle({ opacity: '0.8' })
    expect(
      container.querySelector('[data-preview-card-layer="effect"]'),
    ).not.toHaveStyle({ mixBlendMode: 'screen' })
  })

  it('uses the selected foreground without changing normal card artwork', () => {
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
    expect(card?.getAttribute('data-preview-card-foreground')).toMatch(/^(dark|light)$/)
    expect(card).toHaveStyle({ color: '#0a0a0a' })
    expect(
      card?.querySelector('[data-preview-card-layer="readability"]'),
    ).not.toBeInTheDocument()
    expect(
      card?.querySelector('[data-preview-card-layer="effect"]'),
    ).not.toBeInTheDocument()
    expect(
      Array.from(card?.querySelectorAll('[data-preview-card-layer]') ?? []).map(
        (layer) => layer.getAttribute('data-preview-card-layer'),
      ),
    ).toEqual(['foundation', 'gradient'])
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
      'transparent',
    )
  })

  it('keeps a custom card-text colour literal and visibly warns about weak contrast', () => {
    const { container } = renderWithProviders(
      <BrandingPreview
        values={{
          cardGradient: 'linear-gradient(135deg, #111111 0%, #202020 100%)',
          cardEffect: 'NONE',
          subscriptionCardText: { mode: 'custom', color: '#171717' },
        }}
      />,
    )

    const card = container.querySelector('[data-preview-subscription-card]')
    expect(card).toHaveAttribute('data-preview-card-text-mode', 'custom')
    expect(card).toHaveStyle({ color: '#171717' })
    expect(
      card?.querySelector('[data-preview-card-contrast-warning]'),
    ).toBeInTheDocument()
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
    expect(card?.getAttribute('data-preview-card-foreground')).toMatch(/^(dark|light)$/)
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
              mode: 'override',
              cardEffect: 'aurora',
              cardEffectProps: {},
              cardEffectOpacity: 0.8,
              cardGradient: 'linear-gradient(#111827, #2563eb)',
            },
            {
              mode: 'override',
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
      'native',
    )
    expect(
      effect?.querySelector('[data-preview-card-effect-renderer]'),
    ).toHaveStyle({ opacity: '0.8' })
    expect(effect).not.toHaveStyle({ mixBlendMode: 'screen' })
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
