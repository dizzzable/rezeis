import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { en } from '@/i18n/en'
import { QR_STYLE_PLAIN, qrSvg } from '@/lib/qr/kit/qr-style'
import { renderWithProviders } from '@/test/test-utils'

import type { BrandingQrStyleDraft } from './branding-form-schema'
import {
  QR_PREVIEW_CONNECT_LINK,
  QR_PREVIEW_CONNECT_PX,
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
