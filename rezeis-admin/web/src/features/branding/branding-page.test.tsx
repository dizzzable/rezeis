import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configure, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import api from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import WebReiwaPage from './branding-page'
import { CONCEPT_CARD_PRESETS } from './concept-card-presets'
import {
  CARD_GRADIENT_PRESETS,
  CONCEPT_THEME_PRESETS,
  createConceptThemeModeVariants,
} from './theme-presets'

// WebReiwaPage mounts every tab's section tree at once (kept mounted so the
// form/preview stay intact), so the first render is heavy — under the full
// parallel suite it can take several seconds. Give the async queries room so
// this file doesn't flake on findBy timeouts (the assertions are unchanged).
configure({ asyncUtilTimeout: 20_000 })

vi.mock('./branding-preview', () => ({
  BrandingPreview: () => <div data-testid="branding-preview" />,
}))

vi.mock('./card-effect-section', () => ({
  CardEffectSection: () => <div data-testid="card-effect-section" />,
  CardEffectPicker: () => <div data-testid="card-effect-picker" />,
}))

vi.mock('./concept-card-preset-gallery', async () => {
  const {
    CONCEPT_CARD_PRESETS: presets,
    createConceptCardPresetVisualPatch,
  } = await import('./concept-card-presets')
  const preset = presets[0]

  return {
    ConceptCardPresetGallery: ({
      onApply,
      labels,
    }: {
      onApply: (
        selectedPreset: typeof preset,
        patch: ReturnType<typeof createConceptCardPresetVisualPatch>,
      ) => void
      labels?: {
        apply?: (selectedPreset: typeof preset) => string
      }
    }) => (
      <button
        type="button"
        onClick={() =>
          onApply(preset, createConceptCardPresetVisualPatch(preset))
        }
      >
        {labels?.apply?.(preset) ??
          `Apply ${preset.code} ${preset.name}; effect ${preset.cardEffectName}`}
      </button>
    ),
  }
})

describe('WebReiwaPage branding settings', () => {
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

    expect(
      await screen.findByText(
        'Enter an HTTPS URL, data:image URL, or a branding upload path.',
      ),
    ).toBeInTheDocument()
    expect(patchSpy).not.toHaveBeenCalled()
  }, 20_000)

  it('submits normalized branding URLs', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: createBrandingPayload() })
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: createBrandingPayload() })

    renderWithProviders(<WebReiwaPage />)

    await screen.findByRole('heading', { name: /WEB Reiwa/ })
    await user.type(screen.getByLabelText('Logo URL (optional)'), ' https://cdn.example.com/logo.png ')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patchSpy).toHaveBeenCalledOnce())
    expect(patchSpy).toHaveBeenCalledWith(
      '/admin/settings/branding',
      {
        logoUrl: 'https://cdn.example.com/logo.png',
      },
    )
  }, 20_000)

  it('gives color controls distinct programmatic names', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: createBrandingPayload() })
    vi.spyOn(api, 'patch').mockResolvedValue({ data: createBrandingPayload() })

    renderWithProviders(<WebReiwaPage />)

    await screen.findByRole('heading', { name: /WEB Reiwa/ })

    expect(screen.getByRole('textbox', { name: 'Primary' })).toHaveValue('#22c55e')
    expect(screen.getByLabelText('Primary color picker')).toHaveAttribute('type', 'color')
  }, 20_000)

  it('submits a selected WEB Reiwa theme through the settings PATCH', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: createBrandingPayload() })
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({
      data: createBrandingPayload(),
    })

    renderWithProviders(<WebReiwaPage />)

    await screen.findByRole('heading', { name: /WEB Reiwa/ })
    await user.click(screen.getByRole('button', { name: 'A Vital Link' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patchSpy).toHaveBeenCalledOnce())
    expect(patchSpy).toHaveBeenCalledWith(
      '/admin/settings/branding',
      expect.objectContaining({
        themePresetId: 'concept-a',
        themePresetVersion: 2,
        cornerRadii: expect.objectContaining({
          cardPx: expect.any(Number),
          itemPx: expect.any(Number),
          pillPx: expect.any(Number),
        }),
      }),
    )
  }, 20_000)

  it('makes existing positional card slots inherit the global gradient when applying a full theme', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        ...createBrandingPayload(),
        cardEffectsByIndex: [
          {
            cardEffect: 'aurora',
            cardEffectProps: {},
            cardEffectOpacity: 1,
            cardGradient: 'url(https://legacy.example/card.png)',
          },
          {
            cardEffect: 'waves',
            cardEffectProps: { speed: 2 },
            cardEffectOpacity: 0.4,
            cardGradient: null,
          },
          {
            cardEffect: 'threads',
            cardEffectProps: { amplitude: 3 },
            cardEffectOpacity: 0.75,
            cardGradient:
              'linear-gradient(135deg, #111827 0%, #2563eb 100%)',
          },
        ],
      },
    })
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({
      data: createBrandingPayload(),
    })

    renderWithProviders(<WebReiwaPage />)

    await screen.findByRole('heading', { name: /WEB Reiwa/ })
    await user.click(screen.getByRole('button', { name: 'A Vital Link' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patchSpy).toHaveBeenCalledOnce())
    const payload = patchSpy.mock.calls[0]?.[1] as Record<string, unknown>
    const selectedTheme = CONCEPT_THEME_PRESETS[0]
    const expectedVariants = createConceptThemeModeVariants(selectedTheme)
    expect(payload).toMatchObject({
      themePresetId: 'concept-a',
      themePresetVersion: 2,
      cardEffectsByIndex: [
        {
          mode: 'inherit',
          cardGradient: null,
        },
        {
          mode: 'inherit',
          cardGradient: null,
        },
        {
          mode: 'inherit',
          cardGradient: null,
        },
      ],
      // Applying a concept keeps its intentional light/dark card artwork.
      // A manual operator gradient is the only path that synchronizes both.
      themeVariants: {
        light: expect.objectContaining({
          cardGradient: expectedVariants.light.cardGradient,
          cardEffectsByIndex: [
            expect.objectContaining({ cardGradient: null }),
            expect.objectContaining({ cardGradient: null }),
            expect.objectContaining({ cardGradient: null }),
          ],
        }),
        dark: expect.objectContaining({
          cardGradient: expectedVariants.dark.cardGradient,
          cardEffectsByIndex: [
            expect.objectContaining({ cardGradient: null }),
            expect.objectContaining({ cardGradient: null }),
            expect.objectContaining({ cardGradient: null }),
          ],
        }),
      },
    })
    expect(payload).not.toHaveProperty('brandName')
  }, 20_000)

  it('applies an independent concept card while clearing stale positional gradient overrides', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        ...createBrandingPayload(),
        cardEffectsByIndex: [
          {
            cardEffect: 'aurora',
            cardEffectProps: { speed: 0.3 },
            cardEffectOpacity: 0.7,
            cardGradient:
              'linear-gradient(135deg, #172554 0%, #2563eb 100%)',
          },
          {
            cardEffect: 'waves',
            cardEffectProps: { speed: 2 },
            cardEffectOpacity: 0.4,
            cardGradient: null,
          },
          {
            cardEffect: 'threads',
            cardEffectProps: { amplitude: 3 },
            cardEffectOpacity: 0.75,
            cardGradient:
              'linear-gradient(135deg, #111827 0%, #2563eb 100%)',
          },
        ],
      },
    })
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({
      data: createBrandingPayload(),
    })

    renderWithProviders(<WebReiwaPage />)

    await screen.findByRole('heading', { name: /WEB Reiwa/ })
    await user.click(
      screen.getByRole('tab', { name: 'Subscription card' }),
    )
    await user.click(
      screen.getByRole('button', {
        name: /^Apply A Vital Link; effect /,
      }),
    )
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patchSpy).toHaveBeenCalledOnce())
    const selectedCard = CONCEPT_CARD_PRESETS[0]
    expect(patchSpy).toHaveBeenCalledWith('/admin/settings/branding', {
      cardGradient: selectedCard.cardGradient,
      cardPattern: selectedCard.cardPattern,
      cardEffect: selectedCard.cardEffect,
      cardEffectProps: selectedCard.cardEffectProps,
      cardEffectOpacity: selectedCard.cardEffectOpacity,
      cardEffectsByIndex: [
        {
          mode: 'inherit',
          cardGradient: null,
        },
        {
          mode: 'inherit',
          cardGradient: null,
        },
        {
          mode: 'inherit',
          cardGradient: null,
        },
      ],
    })
  }, 20_000)

  it('makes a gradient selected from the operator palette override legacy conceptual slot gradients', async () => {
    const user = userEvent.setup()
    const staleSlots = [
      {
        cardEffect: 'paperWarp',
        cardEffectProps: { speed: 1 },
        cardEffectOpacity: 0.84,
        cardGradient: 'linear-gradient(135deg, #2d0a4d 0%, #8545f7 100%)',
      },
      {
        cardEffect: 'grainient',
        cardEffectProps: { noise: 0.25 },
        cardEffectOpacity: 0.68,
        cardGradient: 'linear-gradient(135deg, #0c4a6e 0%, #22d3ee 100%)',
      },
    ]
    const variants = createConceptThemeModeVariants(CONCEPT_THEME_PRESETS[0])
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        ...createBrandingPayload(),
        themePresetId: 'concept-cu',
        cardEffectsByIndex: staleSlots,
        themeVariants: {
          light: { ...variants.light, cardEffectsByIndex: staleSlots },
          dark: { ...variants.dark, cardEffectsByIndex: staleSlots },
        },
      },
    })
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({
      data: createBrandingPayload(),
    })

    renderWithProviders(<WebReiwaPage />)

    await screen.findByRole('heading', { name: /WEB Reiwa/ })
    await user.click(screen.getByRole('tab', { name: 'Subscription card' }))
    const indigoGradient = screen
      .getAllByRole('button', { name: 'Indigo' })
      .find((button) => button.className.includes('aspect-square'))
    expect(indigoGradient).toBeDefined()
    await user.click(indigoGradient!)
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patchSpy).toHaveBeenCalledOnce())
    const payload = patchSpy.mock.calls[0]?.[1] as Record<string, unknown>
    expect(payload).toMatchObject({
      cardGradient: CARD_GRADIENT_PRESETS.find((preset) => preset.id === 'indigo')?.value,
      cardEffectsByIndex: [
        { mode: 'inherit', cardGradient: null },
        { mode: 'inherit', cardGradient: null },
      ],
      themeVariants: {
        light: expect.objectContaining({
          cardGradient: CARD_GRADIENT_PRESETS.find((preset) => preset.id === 'indigo')?.value,
          cardEffectsByIndex: [
            { mode: 'inherit', cardGradient: null },
            { mode: 'inherit', cardGradient: null },
          ],
        }),
        dark: expect.objectContaining({
          cardGradient: CARD_GRADIENT_PRESETS.find((preset) => preset.id === 'indigo')?.value,
          cardEffectsByIndex: [
            { mode: 'inherit', cardGradient: null },
            { mode: 'inherit', cardGradient: null },
          ],
        }),
      },
    })
  }, 20_000)
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
