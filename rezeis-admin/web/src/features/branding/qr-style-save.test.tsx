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
      qrStyle: { modules: 'rounded', eyes: 'rounded', dark: '#1e3a8a' },
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
