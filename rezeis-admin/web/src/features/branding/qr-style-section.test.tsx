import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { en } from '@/i18n/en'
import { ru } from '@/i18n/ru'
import { QR_STYLE_PLAIN, ROUNDED_MODULE_RADIUS, qrSvg } from '@/lib/qr/kit/qr-style'
import { renderWithProviders } from '@/test/test-utils'

import type { BrandingQrStyleDraft } from './branding-form-schema'
import {
  QR_PREVIEW_CONNECT_LINK,
  QR_PREVIEW_CONNECT_PX,
  QR_PREVIEW_PARTNER_LINK,
  QR_PREVIEW_PARTNER_MAGNIFIED_PX,
  QR_PREVIEW_PARTNER_PX,
  QR_PREVIEW_REFERRAL_LINK,
  QR_PREVIEW_REFERRAL_PX,
  QrStyleSection,
} from './qr-style-section'

/**
 * The QR tab as the operator meets it: what it says, what each control hands
 * back, what the contrast line says before a save, and what the preview draws.
 *
 * The preview is compared with the vendored cabinet renderer's own output for
 * the same input, byte for byte — the promise of the tab is that it shows the
 * code subscribers get, so "an image appeared" would prove nothing.
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

const copy = en.brandingPage.qr
const NAVY_DOTS = { modules: 'dots', eyes: 'rounded', dark: '#1e3a8a' } as const

function renderSection(value: BrandingQrStyleDraft, darkError?: string) {
  const onChange = vi.fn()
  const view = renderWithProviders(
    <QrStyleSection value={value} onChange={onChange} darkError={darkError} />,
    { withRouter: false },
  )
  return { onChange, ...view }
}

const group = (name: string) => within(screen.getByRole('group', { name }))
const dataUrl = (svg: string): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

type SampleKind = 'referral' | 'connect' | 'partner' | 'partner-magnified'

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
    expect(onChange).toHaveBeenCalledWith({ modules: 'rounded', eyes: 'rounded', dark: '#1e3a8a' })
  })

  it('marks the preset that matches the current style', () => {
    renderSection({ modules: 'dots', eyes: 'rounded', dark: '#000000' })
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

  it('changes one member and keeps the other two', async () => {
    const user = userEvent.setup()
    const navyRounded = { modules: 'rounded', eyes: 'rounded', dark: '#1e3a8a' } as const
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

  it('resets to the plain code', async () => {
    const user = userEvent.setup()
    const { onChange } = renderSection(NAVY_DOTS)
    await user.click(screen.getByRole('button', { name: copy.reset }))
    expect(onChange).toHaveBeenCalledWith(QR_STYLE_PLAIN)
  })

  it('has nothing to reset when the code is already plain', () => {
    renderSection(QR_STYLE_PLAIN)
    expect(screen.getByRole('button', { name: copy.reset })).toBeDisabled()
  })
})

describe('QR style section — the contrast line, before any save', () => {
  it.each([
    // WCAG's 4.5:1 grey: the one the cabinet's camera model failed to read.
    ['#767676', 'too-light', '4.54:1'],
    // The first grey under 7:1. Floored, so it can never read as "7.00".
    ['#5a5a5a', 'too-light', '6.89:1'],
    // A blue at 6.999258:1 — refused, and near enough the line that rounding
    // to two places would print "7.00:1" beside the refusal. It is flooring,
    // not the distance from the line, that keeps the two honest, and no grey
    // is close enough to show that: #595959 and #5a5a5a sit either side of it.
    ['#0050ca', 'too-light', '6.99:1'],
    // The palest grey that passes.
    ['#595959', 'ok', '7.00:1'],
    ['#000000', 'ok', '21.00:1'],
  ])('%s is %s at %s', (dark, verdict, ratio) => {
    renderSection({ ...NAVY_DOTS, dark })
    const line = document.querySelector('[data-qr-contrast]')
    expect(line).toHaveAttribute('data-qr-contrast', verdict)
    expect(line).toHaveTextContent(ratio)
    expect(line).toHaveTextContent(verdict === 'ok' ? /enough/ : /will not save/)
  })

  it('asks for a colour when the value is not one', () => {
    renderSection({ ...NAVY_DOTS, dark: '#12' })
    const line = document.querySelector('[data-qr-contrast]')
    expect(line).toHaveAttribute('data-qr-contrast', 'invalid')
    expect(line).toHaveTextContent(copy.colourInvalid)
  })

  it('shows a refusal the save attached to the colour, and marks the field', () => {
    renderSection({ ...NAVY_DOTS, dark: '#767676' }, 'refused on save')
    expect(screen.getByRole('alert')).toHaveTextContent('refused on save')
    expect(screen.getByLabelText(copy.colourLabel)).toHaveAttribute('aria-invalid', 'true')
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
})

describe('QR style section — the partner advertising code', () => {
  /**
   * Partners get their codes at 96 CSS px, where the renderer steps dots down
   * to rounded squares; the referral sample, at 208, keeps them. So a tab that
   * showed only the referral sample would let the operator approve dots that
   * no partner ever sees. These cases hold the partner sample to the code the
   * cabinet draws for a partner — byte for byte, at the partner's size, in the
   * draft style — and hold the step-down note to what was actually drawn.
   *
   * What they cannot hold is the NUMBER: for this link the renderer draws the
   * same bytes at every size from 96 to 163 px, so a constant of 120 passes
   * here exactly as 96 does. `qr-preview-cabinet.test.ts` reads the size off
   * the cabinet's source instead.
   */

  it('has its captions and its note in both languages', () => {
    for (const bundle of [en.brandingPage.qr, ru.brandingPage.qr]) {
      expect(bundle.previewPartner).toEqual(expect.stringMatching(/\S/))
      expect(bundle.previewPartnerMagnified).toEqual(expect.stringMatching(/\S/))
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

  it('shows dots on the referral sample and rounded squares on the partner sample, for the same style', async () => {
    renderSection(NAVY_DOTS)
    expect(markup(await sample('referral'))).toContain('<circle')
    const partner = markup(await sample('partner'))
    expect(partner).not.toContain('<circle')
    // Not merely "no dots": rounded data modules are what dots became.
    expect(partner).toContain(` rx="${ROUNDED_MODULE_RADIUS}"`)
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
    expect(drawn).not.toContain(' rx=')
  })
})
