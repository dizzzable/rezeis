/**
 * The operator's answer to "why does my logo look small" has to survive the
 * whole trip: a control they can reach, a preview at the size the cabinet
 * really draws, and a PATCH that carries the value.
 *
 * Each case here sits on a seam. The reader, the DTO and the cabinet renderer
 * were each verifiable on their own and each would stay green while the panel
 * never sent the field at all — the failure this project has shipped eleven
 * times. What is asserted is the request body and the rendered geometry, not
 * that a setter ran.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { configure, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import api from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

vi.mock('@/features/plans/plans-api', () => ({ usePlans: () => ({ data: [] }) }))

const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: toastMock }))

// The preview mounts card-effect renderers this suite has no use for; the
// brand-mark tile under test is a separate component and stays real.
vi.mock('./branding-preview', () => ({
  BrandingPreview: () => <div data-testid="branding-preview" />,
}))
vi.mock('./card-effect-section', () => ({
  CardEffectSection: () => <div data-testid="card-effect-section" />,
  CardEffectPicker: () => <div data-testid="card-effect-picker" />,
}))

import WebReiwaPage from './branding-page'
import {
  BRAND_LOGO_BOUNDS,
  CARD_LOGO_STYLE_BOUNDS,
  DEFAULT_BRAND_LOGO_DRAFT,
  DEFAULT_CARD_LOGO_STYLE_DRAFT,
} from './branding-form-schema'
import { describeBrandLogoSize, resolveBrandLogoGeometry } from './brand-logo-geometry'

configure({ asyncUtilTimeout: 20_000 })

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>
  proto['hasPointerCapture'] ??= () => false
  proto['setPointerCapture'] ??= () => {}
  proto['releasePointerCapture'] ??= () => {}
  proto['scrollIntoView'] ??= () => {}
})

beforeEach(() => {
  vi.restoreAllMocks()
  toastMock.success.mockClear()
  toastMock.error.mockClear()
})

describe('brand-mark geometry', () => {
  /**
   * The mirror pin. `reiwa/web/src/components/ui/brand-logo-geometry.ts` holds
   * the same arithmetic and the same table, and neither repository's suite can
   * see the other — so if you change these numbers, change them there in the
   * same change-set. These are the pixels this panel promises the operator.
   */
  it('computes the pixel table both repositories are pinned to', () => {
    const table = [
      // Inherited corners at the stock 14 px item radius: `rounded-3xl` was
      // 14 × 2.2 = 30.8 and `rounded-xl` 14 × 1.4 = 19.6.
      { variant: 'md', logo: { size: 1, fill: 0.58, radius: null, frame: 'glass' }, itemRadiusPx: 14, expected: [80, 46.4, 30.8, 19.6] },
      { variant: 'lg', logo: { size: 1, fill: 0.58, radius: null, frame: 'glass' }, itemRadiusPx: 14, expected: [96, 55.68, 28, 19.6] },
      { variant: 'md', logo: { size: 1, fill: 0.58, radius: null, frame: 'glass' }, itemRadiusPx: 0, expected: [80, 46.4, 0, 0] },
      { variant: 'md', logo: { size: 1, fill: 0.58, radius: null, frame: 'glass' }, itemRadiusPx: 32, expected: [80, 46.4, 70.4, 44.8] },
      { variant: 'md', logo: { size: 1, fill: 1, radius: 30, frame: 'glass' }, itemRadiusPx: 14, expected: [80, 80, 24, 24] },
      { variant: 'md', logo: { size: 1.5, fill: 0.6, radius: 20, frame: 'glass' }, itemRadiusPx: 14, expected: [120, 72, 24, 0] },
      { variant: 'md', logo: { size: 1, fill: 0.5, radius: 0, frame: 'glass' }, itemRadiusPx: 14, expected: [80, 40, 0, 0] },
      { variant: 'md', logo: { size: 1, fill: 0.8, radius: 50, frame: 'glass' }, itemRadiusPx: 14, expected: [80, 64, 40, 32] },
      { variant: 'md', logo: { size: 1, fill: 0.5, radius: 30, frame: 'none' }, itemRadiusPx: 14, expected: [80, 40, 24, 24] },
    ] as const

    for (const { variant, logo, itemRadiusPx, expected } of table) {
      const geometry = resolveBrandLogoGeometry({ variant, logo, itemRadiusPx })
      expect([
        geometry.tilePx,
        geometry.markPx,
        geometry.tileRadiusPx,
        geometry.markRadiusPx,
      ]).toEqual([...expected])
    }
  })

  it('reports the sign-in measurement the operator is shown', () => {
    // The read-out under the tile. It exists because the panel used to preview
    // an uploaded mark at 24 px while the screen that matters drew it at 46.
    expect(
      describeBrandLogoSize({ variant: 'md', logo: DEFAULT_BRAND_LOGO_DRAFT, itemRadiusPx: 14 }),
    ).toEqual({ tilePx: 80, markPx: 46 })
    expect(
      describeBrandLogoSize({
        variant: 'md',
        logo: { size: 1.75, fill: 1, radius: 0, frame: 'glass' },
        itemRadiusPx: 14,
      }),
    ).toEqual({ tilePx: 140, markPx: 140 })
  })
})

describe('defaults', () => {
  it('reproduces the rendering that preceded the setting', () => {
    // Changing either of these silently restyles every existing installation
    // on upgrade, which is the one outcome a cosmetic feature must not have.
    expect(DEFAULT_BRAND_LOGO_DRAFT).toEqual({
      size: 1,
      fill: 0.58,
      frame: 'glass',
      // `null`, not a percentage: the tile's corners followed the theme before
      // this control existed, and a fixed default would have restyled the first
      // screen of every deployment whose theme is not at the stock radius.
      radius: null,
      glow: 1,
    })
    expect(DEFAULT_CARD_LOGO_STYLE_DRAFT).toEqual({ scale: 1, opacity: 0.1 })
  })

  it('keeps every default inside the bounds its own control offers', () => {
    // A default outside its slider's range is a value the operator can never
    // return to once they move it.
    const within = (value: number, bound: { min: number; max: number }): boolean =>
      value >= bound.min && value <= bound.max
    expect(within(DEFAULT_BRAND_LOGO_DRAFT.size, BRAND_LOGO_BOUNDS.size)).toBe(true)
    expect(within(DEFAULT_BRAND_LOGO_DRAFT.fill, BRAND_LOGO_BOUNDS.fill)).toBe(true)
    expect(within(DEFAULT_BRAND_LOGO_DRAFT.glow, BRAND_LOGO_BOUNDS.glow)).toBe(true)
    expect(within(DEFAULT_CARD_LOGO_STYLE_DRAFT.scale, CARD_LOGO_STYLE_BOUNDS.scale)).toBe(true)
    expect(within(DEFAULT_CARD_LOGO_STYLE_DRAFT.opacity, CARD_LOGO_STYLE_BOUNDS.opacity)).toBe(
      true,
    )
  })
})

describe('brand logo controls', () => {
  it('sends the frame choice to the API', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: createBrandingPayload() })
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: createBrandingPayload() })

    renderWithProviders(<WebReiwaPage />)
    await screen.findByRole('heading', { name: /WEB Reiwa/ })

    await user.click(screen.getByRole('button', { name: 'No frame' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patchSpy).toHaveBeenCalledOnce())
    expect(patchSpy).toHaveBeenCalledWith('/admin/settings/branding', {
      brandLogo: { ...DEFAULT_BRAND_LOGO_DRAFT, frame: 'none' },
    })
  }, 30_000)

  it('marks the chosen frame as pressed so the operator can see which one is on', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: createBrandingPayload() })
    vi.spyOn(api, 'patch').mockResolvedValue({ data: createBrandingPayload() })

    renderWithProviders(<WebReiwaPage />)
    await screen.findByRole('heading', { name: /WEB Reiwa/ })

    expect(screen.getByRole('button', { name: 'Glass' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: 'Outline' }))
    expect(screen.getByRole('button', { name: 'Outline' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: 'Glass' })).toHaveAttribute('aria-pressed', 'false')
  }, 30_000)

  it('previews the mark at the size the cabinet draws it, not at a swatch size', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { ...createBrandingPayload(), logoUrl: 'https://cdn.example.com/logo.png' },
    })

    renderWithProviders(<WebReiwaPage />)
    await screen.findByRole('heading', { name: /WEB Reiwa/ })

    const tile = document.querySelector<HTMLElement>('[data-brand-mark-tile="md"]')
    expect(tile).not.toBeNull()
    expect(tile?.style.width).toBe('80px')
    const mark = tile?.querySelector<HTMLElement>('[data-brand-mark-image]')
    expect(mark?.style.width).toBe('46.4px')
    // The measurement is stated in words as well, because a tile rendered at
    // true size still tells the operator nothing about which px it is.
    expect(document.querySelector('[data-brand-mark-measure]')?.textContent).toBe('46×46 / 80')
  }, 30_000)

  it('stops painting the plate when the operator turns the frame off', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: createBrandingPayload() })

    renderWithProviders(<WebReiwaPage />)
    await screen.findByRole('heading', { name: /WEB Reiwa/ })

    const framed = document.querySelector<HTMLElement>('[data-brand-mark-tile="md"]')
    expect(framed?.style.backgroundColor).not.toBe('transparent')

    await user.click(screen.getByRole('button', { name: 'No frame' }))

    const bare = document.querySelector<HTMLElement>('[data-brand-mark-tile="md"]')
    expect(bare?.getAttribute('data-brand-mark-frame')).toBe('none')
    expect(bare?.style.backgroundColor).toBe('transparent')
    expect(bare?.style.boxShadow).not.toContain('inset')
    // The box survives, so the preview does not reflow and neither does the
    // cabinet screen it stands for.
    expect(bare?.style.width).toBe('80px')
  }, 30_000)

  it('leaves the corner rounding to the theme until the operator takes it over', async () => {
    // The regression this pins: the tile's corners were `rounded-3xl`, i.e.
    // `calc(var(--radius) * 2.2)`, so they FOLLOWED the operator's theme. An
    // earlier draft defaulted them to a fixed 30 % of the tile, which squared
    // off every deployment configured round and rounded off every one
    // configured sharp — on the first screen a subscriber ever sees.
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        ...createBrandingPayload(),
        cornerRadii: { cardPx: 24, itemPx: 32, pillPx: 9999 },
      },
    })
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: createBrandingPayload() })

    renderWithProviders(<WebReiwaPage />)
    await screen.findByRole('heading', { name: /WEB Reiwa/ })

    // 32 × 2.2 = 70.4, not 30 % of 80.
    expect(document.querySelector<HTMLElement>('[data-brand-mark-tile="md"]')?.style.borderRadius).toBe(
      '70.4px',
    )
    expect(readSliderValue('Corner rounding')).toBe('theme')

    // Taking it over adopts what is on screen rather than jumping to a number
    // the operator never chose: 70.4 / 80 = 88 %, capped at the slider's 50.
    await user.click(document.querySelector<HTMLElement>('#brandLogoRadiusInherit')!)
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patchSpy).toHaveBeenCalledOnce())
    const body = patchSpy.mock.calls[0]?.[1] as { brandLogo?: { radius: number | null } }
    expect(body.brandLogo?.radius).toBe(50)
  }, 30_000)

  it('paints each frame the way the cabinet paints it', async () => {
    // The preview's entire justification is that it shows what ships. Only
    // `glass` and `none` had cases, so an `outline` painted with a fill, or a
    // `solid` that kept the backdrop blur, would have been invisible here while
    // the operator judged their logo against it.
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: createBrandingPayload() })

    renderWithProviders(<WebReiwaPage />)
    await screen.findByRole('heading', { name: /WEB Reiwa/ })

    const tile = (): HTMLElement =>
      document.querySelector<HTMLElement>('[data-brand-mark-tile="md"]')!

    // glass — surface fill, hairline, backdrop blur.
    expect(tile().style.backgroundColor).not.toBe('')
    expect(tile().style.backgroundColor).not.toBe('transparent')
    expect(tile().style.boxShadow).toContain('inset 0 0 0 1px')
    expect(tile().style.backdropFilter).toBe('blur(24px)')

    // solid — same fill and hairline, no blur.
    await user.click(screen.getByRole('button', { name: 'Plate' }))
    expect(tile().style.backgroundColor).not.toBe('transparent')
    expect(tile().style.backdropFilter).toBe('')

    // outline — hairline only.
    await user.click(screen.getByRole('button', { name: 'Outline' }))
    expect(tile().style.backgroundColor).toBe('transparent')
    expect(tile().style.boxShadow).toContain('inset 0 0 0 1px')
  }, 30_000)

  it('rounds the mark concentrically with the tile, not parallel to it', async () => {
    // `markRadiusPx` exists for exactly this and nothing in the panel read it.
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        ...createBrandingPayload(),
        brandLogo: { size: 1, fill: 0.5, frame: 'glass', radius: 50, glow: 1 },
        logoUrl: 'https://cdn.example.com/logo.png',
      },
    })

    renderWithProviders(<WebReiwaPage />)
    await screen.findByRole('heading', { name: /WEB Reiwa/ })

    const mark = document.querySelector<HTMLElement>('[data-brand-mark-image]')
    // tile 80 × 50 % = 40; inset (80 − 40) / 2 = 20; 40 − 20 = 20.
    expect(document.querySelector<HTMLElement>('[data-brand-mark-tile="md"]')?.style.borderRadius).toBe('40px')
    expect(mark?.style.borderRadius).toBe('20px')

    // With no plate there is no inner edge, so the mark takes the tile's own.
    await user.click(screen.getByRole('button', { name: 'No frame' }))
    expect(document.querySelector<HTMLElement>('[data-brand-mark-image]')?.style.borderRadius).toBe('40px')
  }, 30_000)

  it('scales only the glow radius, because that is all the cabinet scales', async () => {
    // The cabinet paints `var(--color-brand-glow)`, a constant 40 % mix that
    // nothing rescales. A preview that faded the alpha too showed less than
    // half the halo at 50 % — the panel promising a rendering the cabinet does
    // not produce, which is the failure this whole feature exists to end.
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        ...createBrandingPayload(),
        brandLogo: { ...DEFAULT_BRAND_LOGO_DRAFT, glow: 0.5 },
      },
    })

    renderWithProviders(<WebReiwaPage />)
    await screen.findByRole('heading', { name: /WEB Reiwa/ })

    const shadow = document.querySelector<HTMLElement>('[data-brand-mark-tile="md"]')?.style.boxShadow
    expect(shadow).toContain('0 0 30px')
    expect(shadow, 'the preview faded the glow colour as well as its radius').toContain('0.4)')
  }, 30_000)

  it('restores the pre-setting presentation from the reset button', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        ...createBrandingPayload(),
        brandLogo: { size: 1.6, fill: 0.95, frame: 'none', radius: 4, glow: 0 },
      },
    })
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: createBrandingPayload() })

    renderWithProviders(<WebReiwaPage />)
    await screen.findByRole('heading', { name: /WEB Reiwa/ })
    expect(document.querySelector<HTMLElement>('[data-brand-mark-tile="md"]')?.style.width).toBe(
      '128px',
    )

    await user.click(screen.getAllByRole('button', { name: 'Restore defaults' })[0]!)
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patchSpy).toHaveBeenCalledOnce())
    expect(patchSpy).toHaveBeenCalledWith('/admin/settings/branding', {
      brandLogo: DEFAULT_BRAND_LOGO_DRAFT,
    })
  }, 30_000)
})

describe('asset upload', () => {
  it('accepts a dropped file and writes the returned URL into the field', async () => {
    // The operator asked for this specifically: the slot took a URL or a file
    // picker, and dropping a file on it did nothing at all. No `userEvent` here
    // on purpose — it has no drop gesture, and routing round it through the
    // hidden file input is exactly how the earlier version of this case tested
    // everything except the drop.
    vi.spyOn(api, 'get').mockResolvedValue({ data: createBrandingPayload() })
    const postSpy = vi
      .spyOn(api, 'post')
      .mockResolvedValue({ data: { url: '/uploads/branding/dropped.svg' } })

    renderWithProviders(<WebReiwaPage />)
    await screen.findByRole('heading', { name: /WEB Reiwa/ })

    const zone = document.querySelector<HTMLElement>('[data-branding-asset-dropzone="logoUrl"]')
    expect(zone).not.toBeNull()

    // A real drop, not a click on the hidden input. The previous version of
    // this case asserted the zone existed and then uploaded through the file
    // picker, which left `onDragOver`/`onDrop` — the headline of the whole
    // request — with no coverage at all.
    const file = new File(['<svg />'], 'mark.svg', { type: 'image/svg+xml' })
    fireEvent.dragOver(zone!, { dataTransfer: { files: [file] } })
    expect(zone!.className).toContain('border-primary')
    fireEvent.drop(zone!, { dataTransfer: { files: [file] } })

    await waitFor(() => expect(postSpy).toHaveBeenCalledOnce())
    expect(postSpy.mock.calls[0]?.[0]).toBe('/admin/settings/branding/logo-upload')
    await waitFor(() =>
      expect(screen.getByLabelText('Logo')).toHaveValue('/uploads/branding/dropped.svg'),
    )
  }, 30_000)

  it('offers a drop target for the card watermark, which had no uploader at all', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: createBrandingPayload() })

    renderWithProviders(<WebReiwaPage />)
    await screen.findByRole('heading', { name: /WEB Reiwa/ })

    expect(
      document.querySelector('[data-branding-asset-dropzone="cardLogoUrl"]'),
      'the card watermark accepted a pasted URL and nothing else',
    ).not.toBeNull()
    expect(document.querySelector('[data-branding-asset-dropzone="pwaIconUrl"]')).not.toBeNull()
  }, 30_000)
})

describe('card watermark style', () => {
  it('loads a stored style into the controls instead of showing the defaults', async () => {
    // The other half of the round trip. A control that sends correctly but
    // reads back as 100 % tells the operator their saved setting was lost, and
    // the next Save writes the default over it.
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { ...createBrandingPayload(), cardLogoStyle: { scale: 1.5, opacity: 0.3 } },
    })

    renderWithProviders(<WebReiwaPage />)
    await screen.findByRole('heading', { name: /WEB Reiwa/ })

    expect(readSliderValue('Watermark size')).toBe('150%')
    expect(readSliderValue('Presence')).toBe('30%')
  }, 30_000)

  it('sends size and presence to the API', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: createBrandingPayload() })
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: createBrandingPayload() })

    renderWithProviders(<WebReiwaPage />)
    await screen.findByRole('heading', { name: /WEB Reiwa/ })

    await user.click(screen.getByRole('tab', { name: 'Subscription card' }))
    const slider = screen.getByRole('slider', { name: 'Watermark size' })
    slider.focus()
    await user.keyboard('{ArrowRight}')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patchSpy).toHaveBeenCalledOnce())
    const body = patchSpy.mock.calls[0]?.[1] as { cardLogoStyle?: { scale: number } }
    expect(body.cardLogoStyle).toBeDefined()
    expect(body.cardLogoStyle?.scale).toBeGreaterThan(DEFAULT_CARD_LOGO_STYLE_DRAFT.scale)
  }, 30_000)
})

/**
 * The formatted read-out next to a slider, found through the slider's own
 * accessible name so the assertion breaks if either the label or the value
 * moves.
 */
function readSliderValue(label: string): string | null {
  const thumb = screen.getByRole('slider', { name: label })
  const field = thumb.closest('div.space-y-2')
  return field?.querySelector('span.font-mono')?.textContent ?? null
}

function createBrandingPayload() {
  return {
    brandName: 'Reiwa',
    logoUrl: null,
    primary: '#22c55e',
    primaryFg: '#0a0a0a',
    bgPrimary: '#0a0a0a',
    bgSecondary: '#171717',
    cardGradient: 'linear-gradient(135deg, #064e3b 0%, #22c55e 100%)',
    cardPattern: null,
    cardLogo: 'DEFAULT',
    cardLogoUrl: null,
    cardEffect: 'NONE',
    cardEffectProps: {},
    cardEffectOpacity: 1,
    cardEffectsByIndex: [],
    bgEffect: 'AURORA',
    iconColorMode: 'default',
    iconColors: {},
    borderRadius: 'rounded-2xl',
    fontFamily: 'Geist Variable, system-ui, sans-serif',
  }
}
