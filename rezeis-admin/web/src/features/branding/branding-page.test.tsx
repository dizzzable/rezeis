import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import api from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import WebReiwaPage from './branding-page'

vi.mock('./branding-preview', () => ({
  BrandingPreview: () => <div data-testid="branding-preview" />,
}))

vi.mock('./card-effect-section', () => ({
  CardEffectSection: () => <div data-testid="card-effect-section" />,
}))

describe('WebReiwaPage branding URL validation', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('blocks malformed branding image URLs before submit', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: createBrandingPayload() })
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: createBrandingPayload() })

    renderWithProviders(<WebReiwaPage />)

    await screen.findByRole('heading', { name: /WEB Reiwa/ })
    await user.type(screen.getByLabelText('Logo URL (optional)'), 'ftp://example.com/logo.png')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Enter an HTTP(S) URL or a data:image URL.')).toBeInTheDocument()
    expect(patchSpy).not.toHaveBeenCalled()
  })

  it('submits normalized branding URLs', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: createBrandingPayload() })
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: createBrandingPayload() })

    renderWithProviders(<WebReiwaPage />)

    await screen.findByRole('heading', { name: /WEB Reiwa/ })
    await user.type(screen.getByLabelText('Logo URL (optional)'), ' https://cdn.example.com/logo.png ')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledWith(
        '/admin/settings/branding',
        expect.objectContaining({
          logoUrl: 'https://cdn.example.com/logo.png',
          cardLogoUrl: null,
        }),
      )
    })
  })

  it('gives color controls distinct programmatic names', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: createBrandingPayload() })
    vi.spyOn(api, 'patch').mockResolvedValue({ data: createBrandingPayload() })

    renderWithProviders(<WebReiwaPage />)

    await screen.findByRole('heading', { name: /WEB Reiwa/ })

    expect(screen.getByRole('textbox', { name: 'Primary' })).toHaveValue('#22c55e')
    expect(screen.getByLabelText('Primary color picker')).toHaveAttribute('type', 'color')
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
