/**
 * The SVG ceiling the branding slots enforce but never advertised.
 *
 * `icon-upload.service.ts:172` sets `SVG_MAX_BYTES = 512 * 1024` and
 * `assertSafeSvg` enforces it, while the slot's own `MAX_FILE_SIZE` is 2 MB
 * (`branding-asset-upload.service.ts:28`) and the controls advertised "up to
 * 2 MB" while accepting `image/svg+xml`. A 1024×1024 design-tool SVG export
 * commonly lands between the two: the operator picked a file, waited through an
 * upload, and got a rejection there had been no way to anticipate.
 *
 * Everything here is driven through the real file input with real `File`s of
 * real sizes — the same path the picker takes — and the upload function is a
 * spy, so "was the operator saved a pointless round trip" is a fact about
 * whether the request was issued, not about a return value.
 *
 * The client check is GUIDANCE. The server still validates every byte; these
 * tests assert the panel warns first, never that it is the gate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configure, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// The page render at the bottom of this file mounts every tab's section tree at
// once; the same allowance `branding-page.test.tsx` makes.
configure({ asyncUtilTimeout: 20_000 })

vi.mock('./branding-preview', () => ({
  BrandingPreview: () => <div data-testid="branding-preview" />,
}))
vi.mock('./card-effect-section', () => ({
  CardEffectSection: () => <div data-testid="card-effect-section" />,
  CardEffectPicker: () => <div data-testid="card-effect-picker" />,
}))
vi.mock('./concept-card-preset-gallery', () => ({
  ConceptCardPresetGallery: () => <div data-testid="concept-card-preset-gallery" />,
}))

import api from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import {
  BRANDING_RASTER_MAX_BYTES,
  BRANDING_SVG_MAX_BYTES,
  BrandingAssetField,
} from './branding-asset-field'
import WebReiwaPage from './branding-page'

/** The exact `accept` the logo and card-logo slots pass (branding-page.tsx:1174, :1992). */
const SVG_ACCEPT = 'image/png,image/webp,image/svg+xml'
/** The PWA icon slot's `accept` (branding-page.tsx:1340) — no SVG. */
const RASTER_ACCEPT = 'image/png,image/webp'

function fileOfSize(name: string, type: string, bytes: number): File {
  return new File([new Uint8Array(bytes)], name, { type })
}

function renderField(accept: string, upload: (file: File) => Promise<string>) {
  return renderWithProviders(
    <BrandingAssetField
      id="logoUrl"
      label="Logo"
      hint="SVG, PNG or WebP"
      accept={accept}
      value={null}
      onChange={vi.fn()}
      upload={upload}
      urlPlaceholder="https://…"
    />,
  )
}

describe('BrandingAssetField — the SVG byte ceiling', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('states the real SVG limit before a file is picked', async () => {
    renderField(SVG_ACCEPT, vi.fn())

    const limits = await screen.findByText(/SVG up to 512 KB/)
    expect(limits).toHaveTextContent('PNG or WebP up to 2 MB')
  })

  it('does not claim an SVG limit on a slot that refuses SVG', async () => {
    renderField(RASTER_ACCEPT, vi.fn())

    expect(await screen.findByText('PNG or WebP up to 2 MB.')).toBeInTheDocument()
    expect(screen.queryByText(/SVG up to/)).not.toBeInTheDocument()
  })

  it('refuses an over-limit SVG by name and number, without uploading it', async () => {
    const user = userEvent.setup()
    const upload = vi.fn<(file: File) => Promise<string>>()
    const { container } = renderField(SVG_ACCEPT, upload)
    await screen.findByText(/SVG up to 512 KB/)

    const picker = container.querySelector<HTMLInputElement>('input[type="file"]')
    await user.upload(
      picker as HTMLInputElement,
      fileOfSize('brand-mark.svg', 'image/svg+xml', 900 * 1024),
    )

    const message = await screen.findByText(/900 KB/)
    expect(message).toHaveTextContent('512 KB')
    expect(upload).not.toHaveBeenCalled()
  })

  it('uploads an SVG that is under the ceiling', async () => {
    const user = userEvent.setup()
    const upload = vi.fn<(file: File) => Promise<string>>().mockResolvedValue('/uploads/branding/a.svg')
    const { container } = renderField(SVG_ACCEPT, upload)
    await screen.findByText(/SVG up to 512 KB/)

    const picker = container.querySelector<HTMLInputElement>('input[type="file"]')
    await user.upload(
      picker as HTMLInputElement,
      fileOfSize('brand-mark.svg', 'image/svg+xml', 300 * 1024),
    )

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/over the/i)).not.toBeInTheDocument()
  })

  it('does not apply the SVG ceiling to a raster file', async () => {
    const user = userEvent.setup()
    const upload = vi.fn<(file: File) => Promise<string>>().mockResolvedValue('/uploads/branding/a.png')
    const { container } = renderField(SVG_ACCEPT, upload)
    await screen.findByText(/SVG up to 512 KB/)

    const picker = container.querySelector<HTMLInputElement>('input[type="file"]')
    // 1.5 MB: over the SVG ceiling, under the raster one. Applying the wrong
    // limit here would block a file the server accepts — the failure mode a
    // client-side "guide" must not have.
    await user.upload(
      picker as HTMLInputElement,
      fileOfSize('logo.png', 'image/png', 1536 * 1024),
    )

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
  })

  it('mirrors the server constants it is guiding against', () => {
    // If either server constant moves, this is the line that says so.
    expect(BRANDING_SVG_MAX_BYTES).toBe(512 * 1024)
    expect(BRANDING_RASTER_MAX_BYTES).toBe(2 * 1024 * 1024)
  })
})

describe('WebReiwaPage — the limit reaches the slots an operator actually uses', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  /**
   * The field derives "this slot takes SVG" from its own `accept`, so the
   * guidance cannot be forgotten on a new slot — but only if the page really
   * passes `image/svg+xml`. This renders the page an operator opens and looks
   * at the slot they upload a logo into, which is the only place that is true
   * or false.
   */
  it('shows the SVG ceiling on the logo slot and not on the PWA icon slot', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: createBrandingPayload() })

    renderWithProviders(<WebReiwaPage />)

    await screen.findByRole('heading', { name: /WEB Reiwa/ })

    const logoLimits = await screen.findByText(
      (_, node) => node?.getAttribute('data-branding-asset-limits') === 'logoUrl',
    )
    expect(logoLimits).toHaveTextContent('SVG up to 512 KB')

    const pwaLimits = screen.getByText(
      (_, node) => node?.getAttribute('data-branding-asset-limits') === 'pwaIconUrl',
    )
    expect(pwaLimits).not.toHaveTextContent('SVG up to')
    expect(pwaLimits).toHaveTextContent('PNG or WebP up to 2 MB')
  })
})

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
