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

async function openPage(stored: Partial<typeof DEFAULT_BRANDING_DRAFT> = {}) {
  vi.spyOn(api, 'get').mockResolvedValue({ data: { ...DEFAULT_BRANDING_DRAFT, ...stored } })
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

describe('QR tab — a logo upload that is still running', () => {
  /**
   * A logo upload is a POST of up to 2 MB, and the operator does not stop
   * while it runs. What the upload lands on is the style as it stands when it
   * FINISHES — a preset, a colour, a size picked meanwhile all stay — unless
   * the operator has since taken the logo away or thrown the changes out. And
   * the tab unmounts behind every other tab, so the upload's state cannot live
   * in it: coming back, the operator still sees it running, or what refused it.
   */
  const UPLOADED = '/uploads/branding/fedcba9876543210fedcba9876543210.png'
  const STORED = '/uploads/branding/0123456789abcdef0123456789abcdef.png'

  /** The upload POST, finished or failed when the case says so. */
  function heldUpload() {
    const settle: { finish: (url: string) => void; fail: (error: unknown) => void } = {
      finish: () => {
        throw new Error('the upload was never sent')
      },
      fail: () => {
        throw new Error('the upload was never sent')
      },
    }
    const postSpy = vi.spyOn(api, 'post').mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          settle.finish = (url) => resolve({ data: { url } })
          settle.fail = reject
        }),
    )
    return { postSpy, settle }
  }

  const tab = (name: string) => screen.getByRole('tab', { name })
  const presets = () => within(screen.getByRole('group', { name: copy.presetsLabel }))
  const logoControls = (): Promise<HTMLElement> =>
    waitFor(() => {
      const controls = document.querySelector<HTMLElement>('[data-qr-logo-controls]')
      if (controls === null) throw new Error('the logo controls are not rendered')
      return controls
    })
  const thumbnail = (): HTMLElement | null => document.querySelector('[data-qr-logo-thumbnail]')

  async function pickLogo(user: ReturnType<typeof userEvent.setup>, postSpy: ReturnType<typeof heldUpload>['postSpy']) {
    await user.click(tab(page.tabs.qr))
    await screen.findByRole('group', { name: copy.presetsLabel })
    const input = document.querySelector<HTMLInputElement>('[data-qr-logo-file]')
    expect(input, 'the logo file input').not.toBeNull()
    await user.upload(input as HTMLInputElement, new File([new Uint8Array(2048)], 'logo.png', { type: 'image/png' }))
    await waitFor(() => expect(postSpy).toHaveBeenCalledOnce())
    expect(within(await logoControls()).getByRole('button', { name: copy.logo.uploading })).toBeDisabled()
  }

  it('lands in the style as it stands when it finishes — a preset picked meanwhile stays', async () => {
    picture.current = 'transparent'
    const user = userEvent.setup()
    await openPage()
    const { postSpy, settle } = heldUpload()
    await pickLogo(user, postSpy)

    await user.click(presets().getByRole('button', { name: copy.presets.dots }))
    expect(presets().getByRole('button', { name: copy.presets.dots })).toHaveAttribute('aria-pressed', 'true')

    settle.finish(UPLOADED)
    await waitFor(() => expect(thumbnail()).toHaveAttribute('src', UPLOADED))
    expect(presets().getByRole('button', { name: copy.presets.dots })).toHaveAttribute('aria-pressed', 'true')
    expect(within(await logoControls()).getByRole('button', { name: copy.logo.replace })).toBeEnabled()
  }, 30_000)

  it('is still uploading when the operator comes back from another tab, and lands then', async () => {
    picture.current = 'transparent'
    const user = userEvent.setup()
    await openPage()
    const { postSpy, settle } = heldUpload()
    await pickLogo(user, postSpy)

    await user.click(tab(page.tabs.brand))
    await user.click(tab(page.tabs.qr))
    // A second pick is exactly what an enabled button would invite.
    expect(within(await logoControls()).getByRole('button', { name: copy.logo.uploading })).toBeDisabled()

    settle.finish(UPLOADED)
    await waitFor(() => expect(thumbnail()).toHaveAttribute('src', UPLOADED))
    expect(within(await logoControls()).getByRole('button', { name: copy.logo.replace })).toBeEnabled()
    expect(postSpy).toHaveBeenCalledOnce()
  }, 30_000)

  it('shows a refusal that arrived while the operator was on another tab', async () => {
    const user = userEvent.setup()
    await openPage()
    const { postSpy, settle } = heldUpload()
    await pickLogo(user, postSpy)

    await user.click(tab(page.tabs.brand))
    const refusal = 'SVG contains a disallowed element: <script>.'
    settle.fail(Object.assign(new Error('Bad Request'), { response: { data: { message: refusal } } }))
    await user.click(tab(page.tabs.qr))

    expect(await within(await logoControls()).findByRole('alert')).toHaveTextContent(refusal)
    expect(within(await logoControls()).getByRole('button', { name: copy.logo.upload })).toBeEnabled()
  }, 30_000)

  it('does not bring back a logo the operator took away while its replacement was uploading', async () => {
    picture.current = 'transparent'
    const user = userEvent.setup()
    await openPage({ qrStyle: { modules: 'square', eyes: 'square', dark: '#000000', logo: { src: STORED, size: 'small', plate: 'light' } } })
    const { postSpy, settle } = heldUpload()
    await pickLogo(user, postSpy)

    await user.click(within(await logoControls()).getByRole('button', { name: copy.logo.remove }))
    expect(document.querySelector('[data-qr-logo-none]')).not.toBeNull()

    settle.finish(UPLOADED)
    // Let the finished upload have its chance to land before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(thumbnail()).toBeNull()
    expect(document.querySelector('[data-qr-logo-none]')).not.toBeNull()
    expect(within(await logoControls()).getByRole('button', { name: copy.logo.upload })).toBeEnabled()
  }, 30_000)

  it('does not land in a page whose changes the operator threw out while it ran', async () => {
    picture.current = 'transparent'
    const user = userEvent.setup()
    await openPage()
    const { postSpy, settle } = heldUpload()
    await pickLogo(user, postSpy)
    await user.click(presets().getByRole('button', { name: copy.presets.dots }))

    await user.click(screen.getByRole('button', { name: page.reset }))
    expect(presets().getByRole('button', { name: copy.presets.plain })).toHaveAttribute('aria-pressed', 'true')

    settle.finish(UPLOADED)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(thumbnail()).toBeNull()
    expect(presets().getByRole('button', { name: copy.presets.plain })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: page.save })).toBeDisabled()
  }, 30_000)
})

describe('QR tab — a refused upload', () => {
  /**
   * The page keeps what refused an upload, so the tab mounted again still
   * shows it. That is right while nothing about the logo has changed, and
   * wrong once the operator has thrown their changes out: the red line and
   * the invalid upload button would stay for the rest of the page's life,
   * about a file nobody is trying to use any more.
   */
  const tab = (name: string) => screen.getByRole('tab', { name })
  const logoControls = (): Promise<HTMLElement> =>
    waitFor(() => {
      const controls = document.querySelector<HTMLElement>('[data-qr-logo-controls]')
      if (controls === null) throw new Error('the logo controls are not rendered')
      return controls
    })

  it('keeps the refusal across a look at another tab, and retires it with the changes the operator throws out', async () => {
    const user = userEvent.setup()
    await openPage()
    const postSpy = vi.spyOn(api, 'post')

    await user.click(tab(page.tabs.qr))
    // A change for the page's Reset to throw out: until there is one, it is disabled.
    await user.click(within(await screen.findByRole('group', { name: copy.presetsLabel })).getByRole('button', { name: copy.presets.dots }))
    const input = document.querySelector<HTMLInputElement>('[data-qr-logo-file]')
    expect(input, 'the logo file input').not.toBeNull()
    await user.upload(input as HTMLInputElement, new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' }))
    expect(await within(await logoControls()).findByRole('alert')).toHaveTextContent('2 MB')

    // Nothing about the logo has changed: a look at another tab keeps it.
    await user.click(tab(page.tabs.brand))
    await user.click(tab(page.tabs.qr))
    expect(await within(await logoControls()).findByRole('alert')).toHaveTextContent('2 MB')
    expect(within(await logoControls()).getByRole('button', { name: copy.logo.upload })).toHaveAttribute('aria-invalid', 'true')

    await user.click(screen.getByRole('button', { name: page.reset }))
    const presets = within(screen.getByRole('group', { name: copy.presetsLabel }))
    expect(presets.getByRole('button', { name: copy.presets.plain })).toHaveAttribute('aria-pressed', 'true')
    expect(within(await logoControls()).queryByRole('alert')).toBeNull()
    expect(within(await logoControls()).getByRole('button', { name: copy.logo.upload })).toHaveAttribute('aria-invalid', 'false')
    expect(postSpy).not.toHaveBeenCalled()
  }, 30_000)
})
