/**
 * What the phone preview counts as a colour.
 *
 * Three readers pull colours out of an effect's props: the cabinet's
 * `card-effect-runtime.asColor`, the tile preview's
 * `card-effect-preview-utils.isSafeHexColor`, and the phone preview inside
 * `branding-preview.tsx`. The first two were widened to `rgb()`, `rgba()`,
 * `hsl()` and `transparent` in the round that started shipping `rgba()`
 * defaults; the third was left on `/^#[\da-f]{3,8}$/`.
 *
 * That is not a cosmetic gap. `resolvePreviewEffectInputColors` treats ANY
 * non-empty result as the whole picture, so a partial match is worse than none:
 * Pixel Card's three `rgba(255,255,255,…)` marks were invisible while its
 * `#000000` field was not, the preview concluded "black card" and promised the
 * operator light text — and the cabinet, seeing the whites, shipped dark. The
 * effect carries no `fullOutputGamut`, so nothing masked the disagreement.
 *
 * The acceptance table below is run through BOTH the shared module and the
 * rendered preview, so the two cannot quietly drift apart again: a form only
 * one of them accepts fails here, in whichever direction it goes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { renderWithProviders } from '@/test/test-utils'

vi.mock('@/features/plans/plans-api', () => ({
  usePlans: () => ({ data: [] }),
}))

/**
 * Whether `getCardEffectDefaults` answers from the catalogue.
 *
 * ON for the Pixel Card case, which is about the SHIPPED defaults; OFF for the
 * notation table, which needs the probe value to be the only colour in play.
 */
const catalogDefaults = vi.hoisted(() => ({ enabled: true }))

vi.mock('./card-effect-registry', async () => {
  const actual =
    await vi.importActual<typeof import('./card-effect-registry')>('./card-effect-registry')
  return {
    ...actual,
    // Only `pixelCard` is ever rendered here, and the real Canvas2D component
    // would spend the whole test drawing into a jsdom canvas.
    CARD_EFFECT_COMPONENTS: {
      ...actual.CARD_EFFECT_COMPONENTS,
      pixelCard: () => <canvas data-testid="preview-effect-renderer" />,
    },
    getCardEffectDefaults: (effect: string) =>
      catalogDefaults.enabled ? actual.getCardEffectDefaults(effect) : {},
  }
})

import { BrandingPreview } from './branding-preview'
import { resolveCardEffectPreviewColors } from './card-effect-preview-utils'

/** A card dark enough that one white mark is what decides the text tone. */
const DARK_CARD = {
  primaryFg: '#ffffff',
  bgSecondary: '#020617',
  cardGradient: 'linear-gradient(135deg, #020617 0%, #111827 100%)',
  cardEffect: 'pixelCard',
  cardEffectOpacity: 1,
} as const

/** Opaque white, written every way the other two readers accept it. */
const WHITE_NOTATIONS = [
  '#fff',
  '#ffff',
  '#ffffff',
  '#ffffffff',
  'rgb(255, 255, 255)',
  'rgba(255, 255, 255, 1)',
  'rgb(100%, 100%, 100%)',
  'rgb(255 255 255 / 1)',
  'hsl(0, 0%, 100%)',
  'hsla(0, 0%, 100%, 1)',
  'hsl(0 0% 100% / 100%)',
]

/**
 * Values that must NOT be read as colours. `white` is here on purpose: bare
 * keywords are rejected by all three readers, because telling `white` from
 * `checks` needs the full keyword table and no effect default uses one. The
 * odd-length hexes are here because `/^#[\da-f]{3,8}$/` used to accept them
 * while every parser downstream rejected them.
 */
const NON_COLOURS = ['checks', 'dense', 'middle', 'white', '#fffff', '#fffffff', 'rgb(255']

function foregroundOf(props: Record<string, unknown> | undefined): string | null {
  const { container } = renderWithProviders(
    <BrandingPreview values={{ ...DARK_CARD, ...(props ? { cardEffectProps: props } : {}) }} />,
  )
  return container
    .querySelector('[data-preview-subscription-card]')
    ?.getAttribute('data-preview-card-foreground') ?? null
}

beforeEach(() => {
  catalogDefaults.enabled = true
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
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Pixel Card, at the defaults the catalogue ships', () => {
  it('reads its rgba() marks and picks the text tone the cabinet picks', () => {
    // `colors` is `rgba(255,255,255,1) / 0.8 / 0.6` and the field is `#000000`.
    // Hex-only saw the field alone and answered "light"; the whites make this a
    // card with both extremes on it, where dark text needs the weaker veil.
    expect(foregroundOf(undefined)).toBe('dark')
  })
})

describe('the colour forms the preview accepts', () => {
  it.each(WHITE_NOTATIONS)('reads %s as the white it is', (value) => {
    catalogDefaults.enabled = false

    expect(foregroundOf({ probe: value })).toBe('dark')
  })

  it.each(NON_COLOURS)('does not mistake %s for a colour', (value) => {
    catalogDefaults.enabled = false

    expect(foregroundOf({ probe: value })).toBe('light')
  })

  it('treats transparent as a colour form that carries no contrast evidence', () => {
    // Accepted by all three readers, and contributing nothing: compositing it
    // would add the backdrop as a sample and tilt the verdict toward whatever
    // sits behind the card.
    catalogDefaults.enabled = false

    expect(resolveCardEffectPreviewColors('pixelCard', { probe: 'transparent' })).toContain(
      'transparent',
    )
    expect(foregroundOf({ probe: 'transparent' })).toBe('light')
  })

  it('flattens a translucent mark instead of reading it at full strength', () => {
    // Not the defect — hex-only rejected this outright and also answered
    // "light" — but the obvious way to get the widening wrong. White at 0.35
    // over the card is a mid grey that white text still clears; only an
    // implementation that accepted the form and then ignored its alpha would
    // call this a white card and flip to dark text.
    catalogDefaults.enabled = false

    expect(foregroundOf({ probe: 'rgba(255, 255, 255, 0.35)' })).toBe('light')
  })
})

describe('the same table, through the module the tile preview uses', () => {
  // If these ever disagree with the cases above, the operator's two previews
  // have started answering to different evidence — which is the whole failure
  // this file exists to catch.
  it.each(WHITE_NOTATIONS)('accepts %s', (value) => {
    expect(resolveCardEffectPreviewColors('pixelCard', { probe: value })).toContain(value)
  })

  it.each(NON_COLOURS)('rejects %s', (value) => {
    expect(resolveCardEffectPreviewColors('pixelCard', { probe: value })).not.toContain(value)
  })
})
