/**
 * The QR tab end to end: what leaves the page on Save, and where a refusal
 * lands.
 *
 * Every piece on the way is verifiable on its own and each would stay green
 * while the page never sent the field at all — the dirty check that does not
 * iterate it, the schema that strips it, the router that sends its error to a
 * tab where nothing can show it. So what is asserted here is the request body
 * and the tab the operator ends up looking at, not that a setter ran.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { configure, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import api from '@/lib/api'
import { en } from '@/i18n/en'
import { renderWithProviders } from '@/test/test-utils'

vi.mock('@/features/plans/plans-api', () => ({ usePlans: () => ({ data: [] }) }))

const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: toastMock }))

// The phone preview and the effect grid mount renderers this suite has no use
// for; the QR section under test is its own component and stays real.
vi.mock('./branding-preview', () => ({
  BrandingPreview: () => <div data-testid="branding-preview" />,
}))
vi.mock('./card-effect-section', () => ({
  CardEffectSection: () => <div data-testid="card-effect-section" />,
  CardEffectPicker: () => <div data-testid="card-effect-picker" />,
}))

/**
 * The page's logo check, with only the browser-only steps replaced: loading
 * the file (`fetch`) and drawing it (a canvas) answer the picture a case
 * names. Everything after — the links, the drawings, ZXing, the rule — is the
 * production check, over five links of each shape.
 */
const picture = vi.hoisted(() => ({ current: 'transparent' as 'transparent' | 'eye' }))
vi.mock('./qr-logo-check-browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./qr-logo-check-browser')>()
  const bitmaps = await import('@/test/qr-logo-bitmaps')
  return {
    ...actual,
    createBrowserQrLogoChecker: () =>
      actual.createBrowserQrLogoChecker({
        loadHref: async () => 'data:image/png;base64,iVBORw0KGgo=',
        drawBox: async () => bitmaps.paintLogo(picture.current === 'eye' ? bitmaps.EYE_LOGO : bitmaps.TRANSPARENT_LOGO),
        linksPerShape: 5,
      }),
  }
})

import WebReiwaPage from './branding-page'
import { DEFAULT_BRANDING_DRAFT } from './branding-form-schema'

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
  toastMock.info.mockClear()
  toastMock.success.mockClear()
  toastMock.error.mockClear()
})

const page = en.brandingPage
const copy = en.brandingPage.qr

async function openPage() {
  vi.spyOn(api, 'get').mockResolvedValue({ data: { ...DEFAULT_BRANDING_DRAFT } })
  const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: { ...DEFAULT_BRANDING_DRAFT } })
  renderWithProviders(<WebReiwaPage />)
  await screen.findByRole('heading', { name: /WEB Reiwa/ })
  return patchSpy
}

describe('QR tab — saving', () => {
  it('sends the chosen style whole, and nothing else', async () => {
    const user = userEvent.setup()
    const patchSpy = await openPage()

    await user.click(screen.getByRole('tab', { name: page.tabs.qr }))
    const presets = await screen.findByRole('group', { name: copy.presetsLabel })
    await user.click(within(presets).getByRole('button', { name: copy.presets.roundedColour }))
    await user.click(screen.getByRole('button', { name: page.save }))

    await waitFor(() => expect(patchSpy).toHaveBeenCalledOnce())
    expect(patchSpy).toHaveBeenCalledWith('/admin/settings/branding', {
      qrStyle: { modules: 'rounded', eyes: 'rounded', dark: '#1e3a8a', logo: null },
    })
  }, 30_000)

  it('refuses a colour too light to scan, and brings the operator back to it from another tab', async () => {
    const user = userEvent.setup()
    const patchSpy = await openPage()

    await user.click(screen.getByRole('tab', { name: page.tabs.qr }))
    const colour = await screen.findByLabelText(copy.colourLabel)
    await user.clear(colour)
    await user.type(colour, '#767676')
    // Walk away from the control: the refusal has to find it again.
    await user.click(screen.getByRole('tab', { name: page.tabs.brand }))
    await user.click(screen.getByRole('button', { name: page.save }))

    expect(await screen.findByText(copy.tooLight)).toHaveAttribute('role', 'alert')
    expect(screen.getByRole('tab', { name: page.tabs.qr })).toHaveAttribute('aria-selected', 'true')
    expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining(copy.tooLight))
    expect(patchSpy).not.toHaveBeenCalled()
  }, 30_000)
})

describe('QR tab — saving a logo', () => {
  const UPLOADED = '/uploads/branding/0123456789abcdef0123456789abcdef.png'

  /** The operator uploads a logo on the QR tab; the API answers with its address. */
  async function uploadLogo(user: ReturnType<typeof userEvent.setup>) {
    const postSpy = vi.spyOn(api, 'post').mockResolvedValue({ data: { url: UPLOADED } })
    await user.click(screen.getByRole('tab', { name: page.tabs.qr }))
    await screen.findByRole('group', { name: copy.presetsLabel })
    const input = document.querySelector<HTMLInputElement>('[data-qr-logo-file]')
    expect(input, 'the logo file input').not.toBeNull()
    await user.upload(input as HTMLInputElement, new File([new Uint8Array(2048)], 'logo.png', { type: 'image/png' }))
    await waitFor(() => expect(postSpy).toHaveBeenCalledOnce())
    expect(postSpy.mock.calls[0]?.[0]).toBe('/admin/settings/branding/qr-logo-upload')
  }

  const verdict = (status: string): Promise<Element> =>
    waitFor(
      () => {
        const element = document.querySelector(`[data-qr-logo-check="${status}"]`)
        if (element === null) throw new Error(`no ${status} verdict yet`)
        return element
      },
      { timeout: 20_000 },
    )

  const logoAlert = (): Promise<HTMLElement> =>
    waitFor(() => {
      const alert = document.querySelector<HTMLElement>('[data-qr-logo-controls] [role="alert"]')
      if (alert === null) throw new Error('no refusal on the logo controls')
      return alert
    })

  it('refuses a logo the check found unreadable, and brings the operator back to the logo from another tab', async () => {
    picture.current = 'eye'
    const user = userEvent.setup()
    const patchSpy = await openPage()
    await uploadLogo(user)
    await user.click(within(await screen.findByRole('group', { name: copy.logo.sizeLabel })).getByRole('button', { name: copy.logo.sizes.large }))
    const refusal = (await verdict('unreadable')).textContent ?? ''
    expect(refusal).toMatch(/^This logo makes codes unreadable/)

    // Walk away from the logo: the refusal has to find it again.
    await user.click(screen.getByRole('tab', { name: page.tabs.brand }))
    await user.click(screen.getByRole('button', { name: page.save }))

    expect((await logoAlert()).textContent).toBe(refusal)
    expect(screen.getByRole('tab', { name: page.tabs.qr })).toHaveAttribute('aria-selected', 'true')
    expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining(refusal))
    expect(patchSpy).not.toHaveBeenCalled()
  }, 60_000)

  it('refuses a save while the logo is still being checked, then saves it with the style around it once it passed', async () => {
    picture.current = 'transparent'
    const user = userEvent.setup()
    const patchSpy = await openPage()
    await uploadLogo(user)
    // At once — before the check has had its chance to run.
    await user.click(screen.getByRole('button', { name: page.save }))
    expect((await logoAlert()).textContent).toBe(copy.logo.check.pending)
    expect(patchSpy).not.toHaveBeenCalled()

    await verdict('passed')
    await user.click(screen.getByRole('button', { name: page.save }))
    await waitFor(() => expect(patchSpy).toHaveBeenCalledOnce())
    expect(patchSpy).toHaveBeenCalledWith('/admin/settings/branding', {
      qrStyle: { modules: 'square', eyes: 'square', dark: '#000000', logo: { src: UPLOADED, size: 'small', plate: 'light' } },
    })
  }, 60_000)
})
