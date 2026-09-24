/**
 * The branding page with the cabinet's report on the last save, and the PWA
 * icon's note on installed apps — both on the real page, so the wiring is what
 * is tested: where the card sits, which tab its button opens, that a save
 * starts the re-checks, and that the note stands in the icon's own card.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { configure, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import api from '@/lib/api'
import { loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'

vi.mock('@/features/plans/plans-api', () => ({ usePlans: () => ({ data: [] }) }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
vi.mock('./branding-preview', () => ({
  BrandingPreview: () => <div data-testid="branding-preview" />,
}))
vi.mock('./card-effect-section', () => ({
  CardEffectSection: () => <div data-testid="card-effect-section" />,
  CardEffectPicker: () => <div data-testid="card-effect-picker" />,
}))

import WebReiwaPage from './branding-page'

configure({ asyncUtilTimeout: 20_000 })

beforeAll(async () => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>
  proto['hasPointerCapture'] ??= () => false
  proto['setPointerCapture'] ??= () => {}
  proto['releasePointerCapture'] ??= () => {}
  proto['scrollIntoView'] ??= () => {}
  // The route loads the branding bundle before the page renders.
  await loadFeatureBundle('branding')
})

let delivery: unknown = { report: null }

beforeEach(() => {
  vi.restoreAllMocks()
  delivery = { report: null }
  vi.spyOn(api, 'get').mockImplementation(async (url: string) =>
    url === '/admin/settings/branding/delivery' ? { data: delivery } : { data: createBrandingPayload() },
  )
})

const deliveryCalls = (): number =>
  vi.mocked(api.get).mock.calls.filter(([url]) => url === '/admin/settings/branding/delivery').length

describe('the cabinet’s report on the branding page', () => {
  it('names the field it kept and takes the operator to its tab', async () => {
    delivery = {
      report: {
        version: 'b'.repeat(32),
        reportedAt: '2026-09-24T20:00:00.000Z',
        rejected: [{ path: 'branding.primary', reason: 'not-a-hex-colour', value: '"rebeccapurple"' }],
      },
    }
    const user = userEvent.setup()
    renderWithProviders(<WebReiwaPage />)

    const card = await screen.findByTestId('branding-delivery-notice')
    expect(within(card).getByText('Primary')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Brand' })).toHaveAttribute('data-state', 'active')

    await user.click(within(card).getByRole('button', { name: 'Open the “Colors & layout” tab' }))
    expect(screen.getByRole('tab', { name: 'Colors & layout' })).toHaveAttribute('data-state', 'active')
  }, 30_000)

  it('shows nothing while the cabinet has said nothing about the version saved now', async () => {
    renderWithProviders(<WebReiwaPage />)
    await screen.findByRole('heading', { name: /WEB Reiwa/ })
    await waitFor(() => expect(deliveryCalls()).toBe(1))
    expect(screen.queryByTestId('branding-delivery-notice')).toBeNull()
  }, 30_000)

  it('asks again after a save', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'patch').mockResolvedValue({ data: createBrandingPayload() })
    renderWithProviders(<WebReiwaPage />)
    await screen.findByRole('heading', { name: /WEB Reiwa/ })
    await waitFor(() => expect(deliveryCalls()).toBe(1))

    await user.type(screen.getByLabelText('Logo'), 'https://cdn.example.com/logo.png')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    // The first re-check is due two seconds after the save succeeded.
    await waitFor(() => expect(deliveryCalls()).toBe(2), { timeout: 10_000 })
  }, 30_000)
})

describe('the PWA icon', () => {
  it('says what a new icon does to an app that is already installed, in its own card', async () => {
    renderWithProviders(<WebReiwaPage />)
    const hint = await screen.findByTestId('pwa-icon-installed-hint')
    expect(hint).toHaveTextContent(
      'An app that is already installed does not pick up a new icon at once. iPhone stores the icon once, when the app is added to the Home Screen, so to see the new one the app has to be removed from the Home Screen and added again. On Android the icon updates by itself within a day: Chrome re-checks it at launch at most once a day.',
    )
    // Next to the icon's upload — in the card whose title is the icon's — not
    // somewhere else on the page.
    const card = hint.closest<HTMLElement>('[data-concept-surface="card"]')
    expect(card).not.toBeNull()
    const title = card!.querySelector('[data-concept-heading]')
    expect(title).toHaveTextContent('App icon (PWA)')
  }, 30_000)
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
