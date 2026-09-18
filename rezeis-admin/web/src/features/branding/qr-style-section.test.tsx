import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { en } from '@/i18n/en'
import { ru } from '@/i18n/ru'
import { QR_STYLE_PLAIN, qrSvg, type QrLogo } from '@/lib/qr/kit/qr-style'
import { EYE_LOGO, SVG_LOGO_BYTES, TRANSPARENT_LOGO, paintLogo } from '@/test/qr-logo-bitmaps'
import { renderWithProviders } from '@/test/test-utils'

import type { BrandingQrStyleDraft } from './branding-form-schema'
import { createQrLogoCheckStore, type QrLogoChecker, type QrLogoCheckStore } from './qr-logo-check'
import { createBrowserQrLogoChecker } from './qr-logo-check-browser'
import type { QrLogoBitmap } from './qr-logo-check-run'
import { createQrLogoUploadStore } from './qr-logo-upload'
import {
  QR_PREVIEW_CONNECT_LINK,
  QR_PREVIEW_CONNECT_PX,
  QR_PREVIEW_PARTNER_ENLARGED_PX,
  QR_PREVIEW_PARTNER_LINK,
  QR_PREVIEW_PARTNER_MAGNIFIED_PX,
  QR_PREVIEW_PARTNER_PX,
  QR_PREVIEW_REFERRAL_LINK,
  QR_PREVIEW_REFERRAL_PX,
  QrStylePreview,
  QrStyleSection,
} from './qr-style-section'

/**
 * The QR tab as the operator meets it: what it says, what each control hands
 * back, what the contrast line and the logo check say before a save, and what
 * the preview draws.
 *
 * The preview is compared with the vendored cabinet renderer's own output for
 * the same input, byte for byte — the promise of the tab is that it shows the
 * code subscribers get, so "an image appeared" would prove nothing. The logo
 * check decodes for real: its checker is the production one with the
 * browser-only steps (loading through `fetch`, drawing through a canvas)
 * replaced by the picture they would produce, over five links of each shape.
 */

/**
 * The real renderer, with one switch that is off unless a case turns it on: a
 * renderer that keeps dots at any size, the way a future kit with a lower dots
 * threshold would at 96 px. The tab must take "dots were replaced" from what
 * was DRAWN, and at the partner's fixed size and link the real renderer always
 * replaces them — so without this, reading the style instead of the drawing
 * would be indistinguishable here.
 */
const renderer = vi.hoisted(() => ({ keepDotsAtAnySize: false }))
vi.mock('@/lib/qr/kit/qr-style', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/qr/kit/qr-style')>()
  return {
    ...actual,
    // Every argument after the size is passed through untouched, so a renderer
    // that grows one keeps its meaning here instead of losing it on both sides
    // of a comparison.
    qrSvg: (...args: Parameters<typeof actual.qrSvg>) => {
      const [text, style, displayPixels, ...rest] = args
      return actual.qrSvg(text, style, renderer.keepDotsAtAnySize ? undefined : displayPixels, ...rest)
    },
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const copy = en.brandingPage.qr
const NAVY_DOTS = { modules: 'dots', eyes: 'rounded', dark: '#1e3a8a', logo: null } as const
const LOGO: QrLogo = { src: '/uploads/branding/0123456789abcdef0123456789abcdef.png', size: 'small', plate: 'light' }
const LOGO_HREF = 'data:image/png;base64,iVBORw0KGgo='

/** A checker that must never run: the case has no logo, or is not about the check. */
const idleChecker = (): { checker: QrLogoChecker; calls: unknown[] } => {
  const calls: unknown[] = []
  return {
    calls,
    checker: async (style) => {
      calls.push(style)
      return null
    },
  }
}

/** The production checker over five links of each shape, with the picture the browser would have drawn. */
const decodingChecker = (picture: QrLogoBitmap | null, href: string | null = LOGO_HREF): QrLogoChecker =>
  createBrowserQrLogoChecker({ loadHref: async () => href, drawBox: async () => picture, linksPerShape: 5 })

function renderSection(
  value: BrandingQrStyleDraft,
  options: {
    readonly darkError?: string
    readonly logoError?: string
    readonly brandLogoUrl?: string | null
    readonly uploadLogo?: (file: File) => Promise<string>
    readonly logoCheck?: QrLogoCheckStore
  } = {},
) {
  const onChange = vi.fn()
  const uploadLogo = options.uploadLogo ?? vi.fn(async () => LOGO.src)
  const logoCheck = options.logoCheck ?? createQrLogoCheckStore(idleChecker().checker)
  // The page's store, reading the style the page holds — here, the one last rendered.
  let held = value
  const logoUpload = createQrLogoUploadStore({ upload: uploadLogo, read: () => held, write: onChange })
  // The tab as the page composes it: the controls, and beside them the
  // preview, both handed the one value the page holds.
  const section = (current: BrandingQrStyleDraft) => (
    <>
      <QrStyleSection
        value={current}
        onChange={onChange}
        darkError={options.darkError}
        logoError={options.logoError}
        brandLogoUrl={options.brandLogoUrl}
        logoUpload={logoUpload}
        logoCheck={logoCheck}
      />
      <QrStylePreview value={current} />
    </>
  )
  const view = renderWithProviders(section(value), { withRouter: false })
  /** The page handing the section the style it holds now — what a change the section asked for comes back as. */
  const restyle = (next: BrandingQrStyleDraft): void => {
    held = next
    view.rerender(section(next))
  }
  return { onChange, uploadLogo, restyle, ...view }
}

/** An upload the case finishes, or fails, when it chooses to. */
function heldUpload() {
  const never = (): never => {
    throw new Error('the upload was never started')
  }
  let finish: (src: string) => void = never
  let fail: (error: unknown) => void = never
  const uploadLogo = vi.fn(
    () =>
      new Promise<string>((resolve, reject) => {
        finish = resolve
        fail = reject
      }),
  )
  return { uploadLogo, finish: (src: string) => finish(src), fail: (error: unknown) => fail(error) }
}

const UPLOADED = '/uploads/branding/fedcba9876543210fedcba9876543210.webp'

const group = (name: string) => within(screen.getByRole('group', { name }))
const dataUrl = (svg: string): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

type SampleKind = 'referral' | 'connect' | 'partner' | 'partner-magnified' | 'partner-enlarged'

/**
 * A drawn sample, found by what it IS rather than by its caption. A caption
 * key missing from the bundle is `undefined`, and `getByRole('img', { name:
 * undefined })` matches any image at all — the query would pass on the wrong
 * code.
 */
async function sample(kind: SampleKind): Promise<HTMLImageElement> {
  return waitFor(() => {
    const image = document.querySelector<HTMLImageElement>(`img[data-qr-preview="${kind}"]`)
    if (image === null) throw new Error(`the ${kind} sample has not been drawn`)
    return image
  })
}

const markup = (image: HTMLImageElement): string =>
  decodeURIComponent((image.getAttribute('src') ?? '').replace(/^data:image\/svg\+xml;charset=utf-8,/, ''))

const stepDownNote = (): Element | null => document.querySelector('[data-qr-step-down]')
const logoControls = (): HTMLElement => {
  const controls = document.querySelector<HTMLElement>('[data-qr-logo-controls]')
  if (controls === null) throw new Error('the logo controls are not rendered')
  return controls
}
const fileInput = (): HTMLInputElement => {
  const input = document.querySelector<HTMLInputElement>('[data-qr-logo-file]')
  if (input === null) throw new Error('the logo file input is not rendered')
  return input
}
/** The button that opens the file picker, whichever it reads: "Upload a logo", "Replace" or "Uploading…". */
const uploadButton = (): HTMLElement => {
  const names = new Set<string>([copy.logo.upload, copy.logo.replace, copy.logo.uploading])
  const buttons = within(logoControls())
    .getAllByRole('button')
    .filter((button) => names.has(button.textContent?.trim() ?? ''))
  if (buttons.length !== 1) throw new Error(`expected one upload button, found ${buttons.length}`)
  return buttons[0] as HTMLElement
}

describe('QR style section — what it says', () => {
  it('names the two codes it styles, and says the connect code stays plain and why', () => {
    renderSection(QR_STYLE_PLAIN)
    expect(screen.getByText(copy.appliesTo)).toBeInTheDocument()
    expect(screen.getByText(copy.connectPlain)).toBeInTheDocument()
    expect(screen.getByText(copy.colourHint)).toBeInTheDocument()
  })
})

describe('QR style section — controls', () => {
  it('applies a preset as one whole style', async () => {
    const user = userEvent.setup()
    const { onChange } = renderSection(QR_STYLE_PLAIN)
    await user.click(
      group(copy.presetsLabel).getByRole('button', { name: copy.presets.roundedColour }),
    )
    expect(onChange).toHaveBeenCalledWith({ modules: 'rounded', eyes: 'rounded', dark: '#1e3a8a', logo: null })
  })

  it('keeps the operator’s logo when a preset is applied', async () => {
    const user = userEvent.setup()
    const { onChange } = renderSection({ ...NAVY_DOTS, logo: LOGO })
    await user.click(group(copy.presetsLabel).getByRole('button', { name: copy.presets.plain }))
    expect(onChange).toHaveBeenLastCalledWith({ modules: 'square', eyes: 'square', dark: '#000000', logo: LOGO })
  })

  it('marks the preset that matches the current style, whatever the logo', () => {
    renderSection({ modules: 'dots', eyes: 'rounded', dark: '#000000', logo: LOGO })
    const presets = group(copy.presetsLabel)
    expect(presets.getByRole('button', { name: copy.presets.dots })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(presets.getByRole('button', { name: copy.presets.plain })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('changes one member and keeps the others', async () => {
    const user = userEvent.setup()
    const navyRounded = { modules: 'rounded', eyes: 'rounded', dark: '#1e3a8a', logo: LOGO } as const
    const { onChange } = renderSection(navyRounded)
    await user.click(group(copy.modulesLabel).getByRole('button', { name: copy.modules.dots }))
    expect(onChange).toHaveBeenLastCalledWith({ ...navyRounded, modules: 'dots' })
    await user.click(group(copy.eyesLabel).getByRole('button', { name: copy.eyes.square }))
    expect(onChange).toHaveBeenLastCalledWith({ ...navyRounded, eyes: 'square' })
  })

  it('hands back what the operator types into the colour field', async () => {
    const user = userEvent.setup()
    const { onChange } = renderSection({ ...NAVY_DOTS, dark: '' })
    await user.type(screen.getByLabelText(copy.colourLabel), '#')
    expect(onChange).toHaveBeenLastCalledWith({ ...NAVY_DOTS, dark: '#' })
  })

  it('resets to the plain code — logo and all', async () => {
    const user = userEvent.setup()
    const { onChange } = renderSection({ ...NAVY_DOTS, logo: LOGO })
    await user.click(screen.getByRole('button', { name: copy.reset }))
    expect(onChange).toHaveBeenCalledWith(QR_STYLE_PLAIN)
  })

  it('has nothing to reset when the code is already plain — and something when only a logo is set', () => {
    const { unmount } = renderSection(QR_STYLE_PLAIN)
    expect(screen.getByRole('button', { name: copy.reset })).toBeDisabled()
    unmount()
    renderSection({ ...QR_STYLE_PLAIN, logo: LOGO })
    expect(screen.getByRole('button', { name: copy.reset })).toBeEnabled()
  })
})

describe('QR style section — the logo controls', () => {
  it('offers an upload and nothing to size while there is no logo', () => {
    renderSection(QR_STYLE_PLAIN)
    expect(within(logoControls()).getByText(copy.logo.none)).toBeInTheDocument()
    expect(within(logoControls()).getByRole('button', { name: copy.logo.upload })).toBeEnabled()
    expect(screen.queryByRole('group', { name: copy.logo.sizeLabel })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: copy.logo.plateLabel })).not.toBeInTheDocument()
  })

  it('uploads a picked file and hands the logo back small, on the white field', async () => {
    const user = userEvent.setup()
    const uploadLogo = vi.fn(async () => '/uploads/branding/fedcba9876543210fedcba9876543210.webp')
    const { onChange } = renderSection(NAVY_DOTS, { uploadLogo })
    const file = new File([new Uint8Array(1024)], 'mark.webp', { type: 'image/webp' })
    await user.upload(fileInput(), file)
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(uploadLogo).toHaveBeenCalledWith(file)
    expect(onChange).toHaveBeenLastCalledWith({
      ...NAVY_DOTS,
      logo: { src: '/uploads/branding/fedcba9876543210fedcba9876543210.webp', size: 'small', plate: 'light' },
    })
  })

  it('replaces a logo’s file and keeps the size and plate the operator chose', async () => {
    const user = userEvent.setup()
    const chosen: QrLogo = { ...LOGO, size: 'large', plate: 'dark' }
    const { onChange } = renderSection({ ...NAVY_DOTS, logo: chosen }, { uploadLogo: async () => '/uploads/branding/b.svg' })
    await user.upload(fileInput(), new File(['<svg/>'], 'b.svg', { type: 'image/svg+xml' }))
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(onChange).toHaveBeenLastCalledWith({ ...NAVY_DOTS, logo: { ...chosen, src: '/uploads/branding/b.svg' } })
  })

  it('refuses an SVG over 96 KB before uploading it, naming both sizes', async () => {
    const user = userEvent.setup()
    const { onChange, uploadLogo } = renderSection(NAVY_DOTS)
    await user.upload(fileInput(), new File([new Uint8Array(120 * 1024)], 'huge.svg', { type: 'image/svg+xml' }))
    const alert = await within(logoControls()).findByRole('alert')
    expect(alert).toHaveTextContent('This SVG is 120 KB, and a QR logo in SVG may be at most 96 KB')
    expect(uploadLogo).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('refuses an SVG one byte over 96 KB', async () => {
    const user = userEvent.setup()
    const { uploadLogo } = renderSection(NAVY_DOTS)
    await user.upload(fileInput(), new File([new Uint8Array(96 * 1024 + 1)], 'over.svg', { type: 'image/svg+xml' }))
    expect(await within(logoControls()).findByRole('alert')).toHaveTextContent('at most 96 KB')
    expect(uploadLogo).not.toHaveBeenCalled()
  })

  it('uploads an SVG of exactly 96 KB', async () => {
    const user = userEvent.setup()
    const { uploadLogo } = renderSection(NAVY_DOTS)
    await user.upload(fileInput(), new File([new Uint8Array(96 * 1024)], 'fits.svg', { type: 'image/svg+xml' }))
    await waitFor(() => expect(uploadLogo).toHaveBeenCalledTimes(1))
  })

  it('refuses a raster file over 2 MB before uploading it', async () => {
    const user = userEvent.setup()
    const { uploadLogo } = renderSection(NAVY_DOTS)
    await user.upload(fileInput(), new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' }))
    expect(await within(logoControls()).findByRole('alert')).toHaveTextContent('2 MB')
    expect(uploadLogo).not.toHaveBeenCalled()
  })

  it('shows the server’s own refusal of an upload', async () => {
    const user = userEvent.setup()
    const refusal = 'SVG contains a disallowed element: <script>. A namespace prefix does not make it safe.'
    const { onChange } = renderSection(NAVY_DOTS, {
      uploadLogo: () => Promise.reject(Object.assign(new Error('Bad Request'), { response: { data: { message: refusal } } })),
    })
    await user.upload(fileInput(), new File(['<svg/>'], 'bad.svg', { type: 'image/svg+xml' }))
    expect(await within(logoControls()).findByRole('alert')).toHaveTextContent(refusal)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('takes the brand logo when it is an upload the cabinet relays', async () => {
    const user = userEvent.setup()
    const brandLogoUrl = '/uploads/branding/99999999999999999999999999999999.svg'
    const { onChange } = renderSection(NAVY_DOTS, { brandLogoUrl })
    await user.click(within(logoControls()).getByRole('button', { name: copy.logo.useBrandLogo }))
    expect(onChange).toHaveBeenLastCalledWith({ ...NAVY_DOTS, logo: { src: brandLogoUrl, size: 'small', plate: 'light' } })
    expect(screen.queryByText(copy.logo.brandLogoUnusable)).not.toBeInTheDocument()
  })

  it.each([
    ['an external address', 'https://cdn.example.com/logo.png'],
    ['an inline image', 'data:image/png;base64,iVBORw0KGgo='],
  ])('will not take a brand logo that is %s, and says why', (_name, brandLogoUrl) => {
    renderSection(NAVY_DOTS, { brandLogoUrl })
    expect(within(logoControls()).getByRole('button', { name: copy.logo.useBrandLogo })).toBeDisabled()
    expect(screen.getByText(copy.logo.brandLogoUnusable)).toBeInTheDocument()
  })

  it('sets the size and the plate, keeping the address', async () => {
    const user = userEvent.setup()
    const { onChange } = renderSection({ ...NAVY_DOTS, logo: LOGO })
    await user.click(group(copy.logo.sizeLabel).getByRole('button', { name: copy.logo.sizes.large }))
    expect(onChange).toHaveBeenLastCalledWith({ ...NAVY_DOTS, logo: { ...LOGO, size: 'large' } })
    await user.click(group(copy.logo.plateLabel).getByRole('button', { name: copy.logo.plates.dark }))
    expect(onChange).toHaveBeenLastCalledWith({ ...NAVY_DOTS, logo: { ...LOGO, plate: 'dark' } })
    expect(group(copy.logo.sizeLabel).getByRole('button', { name: copy.logo.sizes.small })).toHaveAttribute('aria-pressed', 'true')
    expect(group(copy.logo.plateLabel).getByRole('button', { name: copy.logo.plates.light })).toHaveAttribute('aria-pressed', 'true')
  })

  it('takes the logo away, and only the logo', async () => {
    const user = userEvent.setup()
    const { onChange } = renderSection({ ...NAVY_DOTS, logo: LOGO })
    await user.click(within(logoControls()).getByRole('button', { name: copy.logo.remove }))
    expect(onChange).toHaveBeenLastCalledWith(NAVY_DOTS)
  })

  it('shows a refusal the save attached to the logo beside the logo controls, and marks the upload', () => {
    renderSection({ ...NAVY_DOTS, logo: LOGO }, { logoError: 'refused on save' })
    const controls = within(logoControls())
    expect(controls.getByRole('alert')).toHaveTextContent('refused on save')
    expect(controls.getByRole('button', { name: copy.logo.replace })).toHaveAttribute('aria-invalid', 'true')
    // Not on the colour: a logo refusal names the logo.
    expect(screen.getByLabelText(copy.colourLabel)).toHaveAttribute('aria-invalid', 'false')
  })

  it('puts an upload that finishes late into the style as it stands then — a preset picked meanwhile stays', async () => {
    const user = userEvent.setup()
    const upload = heldUpload()
    const { onChange, restyle } = renderSection(QR_STYLE_PLAIN, { uploadLogo: upload.uploadLogo })
    await user.upload(fileInput(), new File([new Uint8Array(1024)], 'mark.webp', { type: 'image/webp' }))
    await waitFor(() => expect(upload.uploadLogo).toHaveBeenCalledOnce())

    // While it runs the operator picks "Dots", and the page hands that style back.
    await user.click(group(copy.presetsLabel).getByRole('button', { name: copy.presets.dots }))
    const dots = { modules: 'dots', eyes: 'rounded', dark: '#000000', logo: null } as const
    expect(onChange).toHaveBeenLastCalledWith(dots)
    restyle(dots)

    upload.finish(UPLOADED)
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(2))
    expect(onChange).toHaveBeenLastCalledWith({ ...dots, logo: { src: UPLOADED, size: 'small', plate: 'light' } })
  })

  it('keeps the size and plate the operator chose while the replacement was uploading', async () => {
    const user = userEvent.setup()
    const upload = heldUpload()
    const { onChange, restyle } = renderSection({ ...NAVY_DOTS, logo: LOGO }, { uploadLogo: upload.uploadLogo })
    await user.upload(fileInput(), new File([new Uint8Array(1024)], 'mark.webp', { type: 'image/webp' }))
    await waitFor(() => expect(upload.uploadLogo).toHaveBeenCalledOnce())

    const chosen = { ...NAVY_DOTS, logo: { ...LOGO, size: 'large', plate: 'dark' } } as const
    restyle(chosen)

    upload.finish(UPLOADED)
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(onChange).toHaveBeenLastCalledWith({ ...chosen, logo: { ...chosen.logo, src: UPLOADED } })
  })

  it.each([
    [
      'takes the logo away',
      { ...NAVY_DOTS, logo: LOGO },
      async (user: ReturnType<typeof userEvent.setup>) =>
        user.click(within(logoControls()).getByRole('button', { name: copy.logo.remove })),
      NAVY_DOTS,
    ],
    [
      'takes the brand logo',
      NAVY_DOTS,
      async (user: ReturnType<typeof userEvent.setup>) =>
        user.click(within(logoControls()).getByRole('button', { name: copy.logo.useBrandLogo })),
      { ...NAVY_DOTS, logo: { src: '/uploads/branding/99999999999999999999999999999999.svg', size: 'small', plate: 'light' } },
    ],
    [
      'resets the code to plain',
      { ...NAVY_DOTS, logo: LOGO },
      async (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: copy.reset })),
      QR_STYLE_PLAIN,
    ],
  ] as const)('drops an upload that finishes after the operator %s', async (_name, start, act, decided) => {
    const user = userEvent.setup()
    const upload = heldUpload()
    const { onChange, restyle } = renderSection(start, {
      uploadLogo: upload.uploadLogo,
      brandLogoUrl: '/uploads/branding/99999999999999999999999999999999.svg',
    })
    await user.upload(fileInput(), new File([new Uint8Array(1024)], 'mark.webp', { type: 'image/webp' }))
    await waitFor(() => expect(upload.uploadLogo).toHaveBeenCalledOnce())

    await act(user)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith(decided)
    restyle(decided)
    // The upload the operator overruled no longer reads as running: they may pick again.
    expect(within(logoControls()).queryByRole('button', { name: copy.logo.uploading })).toBeNull()

    upload.finish(UPLOADED)
    // Give the finished upload its chance to land before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('says nothing about an upload the operator overruled that then failed', async () => {
    const user = userEvent.setup()
    const upload = heldUpload()
    const { onChange } = renderSection({ ...NAVY_DOTS, logo: LOGO }, { uploadLogo: upload.uploadLogo })
    await user.upload(fileInput(), new File([new Uint8Array(1024)], 'mark.webp', { type: 'image/webp' }))
    await waitFor(() => expect(upload.uploadLogo).toHaveBeenCalledOnce())
    await user.click(within(logoControls()).getByRole('button', { name: copy.logo.remove }))

    upload.fail(Object.assign(new Error('Bad Request'), { response: { data: { message: 'refused on upload' } } }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(within(logoControls()).queryByRole('alert')).toBeNull()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  /**
   * A refusal outlives the tab — the page keeps it, so one that arrived while
   * the operator looked elsewhere is still there to read. It must not outlive
   * the operator's next decision about the logo as well: beside the brand logo
   * they took instead, "this file is too large" and a red upload button read
   * as something wrong with the logo in front of them.
   */
  it.each([
    [
      'takes the logo away',
      { ...NAVY_DOTS, logo: LOGO },
      async (user: ReturnType<typeof userEvent.setup>) =>
        user.click(within(logoControls()).getByRole('button', { name: copy.logo.remove })),
      NAVY_DOTS,
    ],
    [
      'takes the brand logo',
      NAVY_DOTS,
      async (user: ReturnType<typeof userEvent.setup>) =>
        user.click(within(logoControls()).getByRole('button', { name: copy.logo.useBrandLogo })),
      { ...NAVY_DOTS, logo: { src: '/uploads/branding/99999999999999999999999999999999.svg', size: 'small', plate: 'light' } },
    ],
    [
      'resets the code to plain',
      { ...NAVY_DOTS, logo: LOGO },
      async (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: copy.reset })),
      QR_STYLE_PLAIN,
    ],
  ] as const)('retires a standing refusal when the operator %s', async (_name, start, act, decided) => {
    const user = userEvent.setup()
    const { onChange, restyle, uploadLogo } = renderSection(start, {
      brandLogoUrl: '/uploads/branding/99999999999999999999999999999999.svg',
    })
    await user.upload(fileInput(), new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' }))
    expect(await within(logoControls()).findByRole('alert')).toHaveTextContent('2 MB')
    expect(uploadButton()).toHaveAttribute('aria-invalid', 'true')

    await act(user)
    expect(onChange).toHaveBeenLastCalledWith(decided)
    restyle(decided)

    expect(within(logoControls()).queryByRole('alert')).toBeNull()
    expect(uploadButton()).toHaveAttribute('aria-invalid', 'false')
    expect(uploadLogo).not.toHaveBeenCalled()
  })

  it('keeps a refusal while nothing about the logo has been decided — a preset, a size, a plate', async () => {
    const user = userEvent.setup()
    const { onChange, restyle } = renderSection({ ...NAVY_DOTS, logo: LOGO })
    await user.upload(fileInput(), new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' }))
    expect(await within(logoControls()).findByRole('alert')).toHaveTextContent('2 MB')

    // Each change handed back the way the page hands it back.
    const pick = async (control: HTMLElement): Promise<void> => {
      await user.click(control)
      restyle(onChange.mock.lastCall?.[0] as BrandingQrStyleDraft)
    }
    await pick(group(copy.presetsLabel).getByRole('button', { name: copy.presets.plain }))
    await pick(group(copy.logo.sizeLabel).getByRole('button', { name: copy.logo.sizes.large }))
    await pick(group(copy.logo.plateLabel).getByRole('button', { name: copy.logo.plates.dark }))
    expect(onChange).toHaveBeenLastCalledWith({ ...QR_STYLE_PLAIN, logo: { ...LOGO, size: 'large', plate: 'dark' } })

    // The file is still refused and nothing has taken its place.
    expect(within(logoControls()).getByRole('alert')).toHaveTextContent('2 MB')
    expect(uploadButton()).toHaveAttribute('aria-invalid', 'true')
  })

  it('retires a refusal once the operator picks a file that uploads', async () => {
    const user = userEvent.setup()
    const upload = heldUpload()
    const { onChange } = renderSection(NAVY_DOTS, { uploadLogo: upload.uploadLogo })
    await user.upload(fileInput(), new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' }))
    expect(await within(logoControls()).findByRole('alert')).toHaveTextContent('2 MB')

    await user.upload(fileInput(), new File([new Uint8Array(1024)], 'mark.webp', { type: 'image/webp' }))
    await waitFor(() => expect(upload.uploadLogo).toHaveBeenCalledOnce())
    expect(within(logoControls()).queryByRole('alert')).toBeNull()

    upload.finish(UPLOADED)
    await waitFor(() => expect(onChange).toHaveBeenCalledOnce())
    expect(within(logoControls()).queryByRole('alert')).toBeNull()
    expect(uploadButton()).toHaveAttribute('aria-invalid', 'false')
  })

  it('has its labels in both languages', () => {
    for (const bundle of [en.brandingPage.qr.logo, ru.brandingPage.qr.logo]) {
      for (const value of [bundle.label, bundle.upload, bundle.useBrandLogo, bundle.remove, bundle.check.unreadable, bundle.check.passed]) {
        expect(value).toEqual(expect.stringMatching(/\S/))
      }
    }
  })
})

describe('QR style section — the logo check', () => {
  it('checks nothing while there is no logo', async () => {
    const { checker, calls } = idleChecker()
    renderSection(NAVY_DOTS, { logoCheck: createQrLogoCheckStore(checker) })
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(calls).toEqual([])
    expect(document.querySelector('[data-qr-logo-check]')).toBeNull()
  })

  it('checks a logo by decoding codes that carry it, and says they read', async () => {
    renderSection(
      { ...QR_STYLE_PLAIN, logo: { ...LOGO, size: 'large' } },
      { logoCheck: createQrLogoCheckStore(decodingChecker(paintLogo(TRANSPARENT_LOGO))) },
    )
    const status = await waitFor(
      () => {
        const element = document.querySelector('[data-qr-logo-check="passed"]')
        if (element === null) throw new Error('no passing verdict yet')
        return element
      },
      { timeout: 30_000 },
    )
    // Five links of each shape at both sizes: 40 codes carry the logo, and
    // none that reads without it stops reading with it.
    expect(status.textContent).toMatch(/^Checked on 40 codes: 0 of the \d+ that read without the logo stopped reading with it \(0%\)/)
  }, 60_000)

  it('refuses an eye-shaped logo with the numbers it measured', async () => {
    renderSection(
      { ...QR_STYLE_PLAIN, logo: { ...LOGO, size: 'large' } },
      { logoCheck: createQrLogoCheckStore(decodingChecker(paintLogo(EYE_LOGO))) },
    )
    const status = await waitFor(
      () => {
        const element = document.querySelector('[data-qr-logo-check="unreadable"]')
        if (element === null) throw new Error('no refusal yet')
        return element
      },
      { timeout: 30_000 },
    )
    expect(status.textContent).toMatch(/^This logo makes codes unreadable: 17 of the \d+ codes that read without it no longer read with it \(\d+(\.\d)?%; at most 5% is allowed\)/)
  }, 60_000)

  it('says the cabinet cannot load a logo its loader draws nothing from', async () => {
    renderSection({ ...NAVY_DOTS, logo: LOGO }, { logoCheck: createQrLogoCheckStore(decodingChecker(null, null)) })
    expect(await screen.findByText(copy.logo.check.unloadable)).toBeInTheDocument()
  })

  it('offers to check again when the check could not run, and runs it again', async () => {
    const user = userEvent.setup()
    let attempts = 0
    const checker: QrLogoChecker = async () => {
      attempts += 1
      return { status: 'failed' }
    }
    renderSection({ ...NAVY_DOTS, logo: LOGO }, { logoCheck: createQrLogoCheckStore(checker) })
    expect(await screen.findByText(copy.logo.check.failed)).toBeInTheDocument()
    expect(attempts).toBe(1)
    await user.click(screen.getByRole('button', { name: copy.logo.check.retry }))
    await waitFor(() => expect(attempts).toBe(2))
  })

  it('shows progress while it runs', async () => {
    let finish: () => void = () => {}
    const checker: QrLogoChecker = (_style, { onProgress }) =>
      new Promise((resolve) => {
        onProgress(0, 800)
        onProgress(400, 800)
        finish = () => resolve(null)
      })
    renderSection({ ...NAVY_DOTS, logo: LOGO }, { logoCheck: createQrLogoCheckStore(checker) })
    const progress = await screen.findByRole('progressbar', { name: copy.logo.check.progress })
    expect(progress).toBeInTheDocument()
    expect(document.querySelector('[data-qr-logo-check="checking"]')).toHaveTextContent('0 of 800')
    finish()
  })
})

describe('QR style section — the preview', () => {
  it('draws the referral example with the cabinet renderer, at the size the cabinet shows it', async () => {
    renderSection(NAVY_DOTS)
    const referral = await screen.findByRole('img', { name: copy.previewReferral })
    expect(referral).toHaveAttribute(
      'src',
      dataUrl(await qrSvg(QR_PREVIEW_REFERRAL_LINK, NAVY_DOTS, QR_PREVIEW_REFERRAL_PX)),
    )
    // And not the plain writer's output: the style really reached the drawing.
    expect(decodeURIComponent(referral.getAttribute('src') ?? '')).toContain('<circle')
  })

  it('draws the connect example plain, whatever the style', async () => {
    renderSection(NAVY_DOTS)
    const connect = await screen.findByRole('img', { name: copy.previewConnect })
    expect(connect).toHaveAttribute(
      'src',
      dataUrl(await qrSvg(QR_PREVIEW_CONNECT_LINK, QR_STYLE_PLAIN, QR_PREVIEW_CONNECT_PX)),
    )
    expect(decodeURIComponent(connect.getAttribute('src') ?? '')).not.toContain('<circle')
  })

  it('draws a colour it would refuse the way the cabinet would — in black — and says so', async () => {
    renderSection({ ...NAVY_DOTS, dark: '#cccccc' })
    const referral = await screen.findByRole('img', { name: copy.previewReferral })
    expect(referral).toHaveAttribute(
      'src',
      dataUrl(
        await qrSvg(
          QR_PREVIEW_REFERRAL_LINK,
          { ...NAVY_DOTS, dark: '#000000' },
          QR_PREVIEW_REFERRAL_PX,
        ),
      ),
    )
    expect(screen.getByText(copy.previewRefused)).toBeInTheDocument()
  })

  it('draws the logo into the invite and the opened partner code exactly as the cabinet does — and never into the card code', async () => {
    const bytes = SVG_LOGO_BYTES
    const fetch = vi.fn(async () => ({
      ok: true,
      redirected: false,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'image/svg+xml' : null) },
      arrayBuffer: async () => bytes.slice().buffer,
    }))
    vi.stubGlobal('fetch', fetch)
    const logo: QrLogo = { src: '/uploads/branding/11111111111111111111111111111111.svg', size: 'large', plate: 'dark' }
    const style = { ...NAVY_DOTS, logo }
    const href = `data:image/svg+xml;base64,${btoa(String.fromCharCode(...bytes))}`
    renderSection(style)

    const expectedReferral = dataUrl(await qrSvg(QR_PREVIEW_REFERRAL_LINK, style, QR_PREVIEW_REFERRAL_PX, href))
    const expectedEnlarged = dataUrl(await qrSvg(QR_PREVIEW_PARTNER_LINK, style, QR_PREVIEW_PARTNER_ENLARGED_PX, href))
    expect(expectedReferral).toContain(encodeURIComponent('<image'))
    expect(expectedEnlarged).toContain(encodeURIComponent('<image'))

    await waitFor(async () => expect((await sample('referral')).getAttribute('src')).toBe(expectedReferral))
    await waitFor(async () => expect((await sample('partner-enlarged')).getAttribute('src')).toBe(expectedEnlarged))
    expect(fetch).toHaveBeenCalledWith(logo.src, { credentials: 'same-origin' })
    // The card's own code has no room for a logo, and the cabinet draws it without one.
    const card = markup(await sample('partner'))
    expect(card).not.toContain('<image')
    expect(card).toBe(await qrSvg(QR_PREVIEW_PARTNER_LINK, { ...style, logo: null }, QR_PREVIEW_PARTNER_PX))
  })
})

describe('QR style section — the partner advertising code', () => {
  /**
   * Partners get their codes at 96 CSS px on a placement card, where the
   * renderer steps dots down to rounded squares; the referral sample, at 208,
   * keeps them. So a tab that showed only the referral sample would let the
   * operator approve dots that no partner card shows. These cases hold the
   * partner sample to the code the cabinet draws for a partner — byte for
   * byte, at the partner's size, in the draft style — and hold the step-down
   * note to what was actually drawn.
   *
   * What they cannot hold is the NUMBER: for this link the renderer draws the
   * same bytes at every size from 96 to 163 px, so a constant of 120 passes
   * here exactly as 96 does. `qr-preview-cabinet.test.ts` holds it to the
   * cabinet's number instead — on record in every run, and read off the
   * cabinet's source beside a reiwa checkout.
   */

  it('has its captions and its note in both languages', () => {
    for (const bundle of [en.brandingPage.qr, ru.brandingPage.qr]) {
      expect(bundle.previewPartner).toEqual(expect.stringMatching(/\S/))
      expect(bundle.previewPartnerMagnified).toEqual(expect.stringMatching(/\S/))
      expect(bundle.previewPartnerEnlarged).toEqual(expect.stringMatching(/\S/))
      expect(bundle.previewPartnerStepDown).toEqual(expect.stringMatching(/\S/))
    }
  })

  it('draws the partner code with the cabinet renderer, in the draft style, at the partner size', async () => {
    renderSection(NAVY_DOTS)
    const partner = await sample('partner')
    expect(partner).toHaveAttribute(
      'src',
      dataUrl(await qrSvg(QR_PREVIEW_PARTNER_LINK, NAVY_DOTS, QR_PREVIEW_PARTNER_PX)),
    )
    expect(partner).toHaveAttribute('width', String(QR_PREVIEW_PARTNER_PX))
    expect(partner).toHaveAttribute('height', String(QR_PREVIEW_PARTNER_PX))
    expect(partner).toHaveAttribute('alt', copy.previewPartner)
  })

  it('draws the code a partner opens as a drawing of its own, at the size the cabinet opens it', async () => {
    renderSection(NAVY_DOTS)
    const enlarged = await sample('partner-enlarged')
    expect(enlarged).toHaveAttribute(
      'src',
      dataUrl(await qrSvg(QR_PREVIEW_PARTNER_LINK, NAVY_DOTS, QR_PREVIEW_PARTNER_ENLARGED_PX)),
    )
    expect(enlarged).toHaveAttribute('width', String(QR_PREVIEW_PARTNER_ENLARGED_PX))
    expect(enlarged).toHaveAttribute('alt', copy.previewPartnerEnlarged)
    // At its own size the dots survive: it is not the card image scaled.
    expect(markup(enlarged)).toContain('<circle')
    expect(enlarged.getAttribute('src')).not.toBe((await sample('partner')).getAttribute('src'))
  })

  it('shows dots on the referral sample and rounded squares on the partner sample, for the same style', async () => {
    renderSection(NAVY_DOTS)
    expect(markup(await sample('referral'))).toContain('<circle')
    const partner = markup(await sample('partner'))
    expect(partner).not.toContain('<circle')
    // Not merely "no dots": rounded data modules are what dots became — the
    // very code the rounded style draws at this size, byte for byte.
    expect(partner).toBe(await qrSvg(QR_PREVIEW_PARTNER_LINK, { ...NAVY_DOTS, modules: 'rounded' }, QR_PREVIEW_PARTNER_PX))
    // And the step really ran: the same style drawn with no size — as a
    // preview that forgot to pass one would draw it — keeps its dots.
    const unsized = await qrSvg(QR_PREVIEW_PARTNER_LINK, NAVY_DOTS)
    expect(unsized).toContain('<circle')
    expect(partner).not.toBe(unsized)
  })

  it('shows that same image enlarged — the same src, hidden from assistive technology', async () => {
    renderSection(NAVY_DOTS)
    const partner = await sample('partner')
    const magnified = await sample('partner-magnified')
    expect(magnified.getAttribute('src')).toBe(partner.getAttribute('src'))
    expect(magnified).toHaveAttribute('aria-hidden', 'true')
    expect(magnified).toHaveAttribute('alt', '')
    expect(Number(magnified.getAttribute('width'))).toBe(QR_PREVIEW_PARTNER_MAGNIFIED_PX)
    expect(QR_PREVIEW_PARTNER_MAGNIFIED_PX).toBeGreaterThan(QR_PREVIEW_PARTNER_PX)
    expect(screen.getByText(copy.previewPartnerMagnified)).toBeInTheDocument()
  })

  it('explains the step-down when dots were replaced', async () => {
    renderSection(NAVY_DOTS)
    await sample('partner')
    await waitFor(() => expect(stepDownNote()).not.toBeNull())
    expect(stepDownNote()).toHaveTextContent(copy.previewPartnerStepDown)
  })

  it('takes the step-down from the drawing, not from the style — kept dots need no note', async () => {
    renderer.keepDotsAtAnySize = true
    try {
      renderSection(NAVY_DOTS)
      const partner = markup(await sample('partner'))
      expect(partner, 'precondition: this renderer kept the dots at the partner size').toContain('<circle')
      // Drawn and set together with the image, so this is the final answer.
      expect(stepDownNote()).toBeNull()
    } finally {
      renderer.keepDotsAtAnySize = false
    }
  })

  it.each([
    ['rounded squares', { ...NAVY_DOTS, modules: 'rounded' }],
    ['squares', { ...NAVY_DOTS, modules: 'square' }],
    ['the plain code', QR_STYLE_PLAIN],
  ] as const)('says nothing about a step-down for %s — nothing was replaced', async (_name, style) => {
    renderSection(style)
    const partner = await sample('partner')
    expect(partner).toHaveAttribute(
      'src',
      dataUrl(await qrSvg(QR_PREVIEW_PARTNER_LINK, style, QR_PREVIEW_PARTNER_PX)),
    )
    // The image and the note are set together, so a drawn image means the
    // note has had its chance to appear.
    expect(stepDownNote()).toBeNull()
    expect(screen.queryByText(copy.previewPartnerStepDown)).not.toBeInTheDocument()
  })

  it('draws the plain style as the plain code', async () => {
    renderSection(QR_STYLE_PLAIN)
    const drawn = markup(await sample('partner'))
    expect(drawn).toBe(await qrSvg(QR_PREVIEW_PARTNER_LINK, QR_STYLE_PLAIN))
    expect(drawn).not.toContain('<circle')
    // A rounded corner, in either spelling the renderer has had: `rx` on a
    // <rect>, or an arc in a path.
    expect(drawn).not.toMatch(/\srx="|\sd="[^"]*[aA]/)
  })
})
