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
    await user.type(screen.getByLabelText('Logo'), 'ftp://example.com/logo.png')
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
    await user.type(screen.getByLabelText('Logo'), ' https://cdn.example.com/logo.png ')
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

  it('leaves legacy positional card slots alone when applying a full theme', async () => {
    // Legacy slots: an effect and no `mode`. Every reader — this section, the
    // preview and the API's `readCardEffectSlots` — gates slot artwork on
    // `mode === 'override'`, so these carry nothing that can render and they
    // already follow the preset. Rewriting them was the blanket reset that
    // also erased the slots an operator HAD overridden.
    const user = userEvent.setup()
    const legacySlots = [
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
        cardGradient: 'linear-gradient(135deg, #111827 0%, #2563eb 100%)',
      },
    ]
    // A brightness snapshot is always sent whole and always revalidated, so
    // the copy that goes into it is sanitized the way the API's own
    // `readCardEffectSlots` sanitizes on read: `url(...)` is not a gradient
    // this build accepts and becomes "use the global one", and a legacy effect
    // with no `mode` was never an override to begin with. Slot 3's hand-picked
    // gradient is real operator work and survives.
    const sanitizedLegacySlots = [
      { mode: 'inherit', cardGradient: null },
      { mode: 'inherit', cardGradient: null },
      {
        mode: 'inherit',
        cardGradient: 'linear-gradient(135deg, #111827 0%, #2563eb 100%)',
      },
    ]
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        ...createBrandingPayload(),
        cardEffectsByIndex: legacySlots,
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
    expect(
      payload,
      'the theme preset rewrote the slot array, so the PATCH ships slot ' +
        'values the operator never chose',
    ).not.toHaveProperty('cardEffectsByIndex')
    expect(payload).toMatchObject({
      themePresetId: 'concept-a',
      themePresetVersion: 2,
      // Applying a concept keeps its intentional light/dark card artwork.
      // A manual operator gradient is the only path that synchronizes both.
      themeVariants: {
        light: expect.objectContaining({
          cardGradient: expectedVariants.light.cardGradient,
        }),
        dark: expect.objectContaining({
          cardGradient: expectedVariants.dark.cardGradient,
        }),
      },
    })
    const variants = payload['themeVariants'] as Record<
      'light' | 'dark',
      Record<string, unknown>
    >
    expect(
      [variants.light['cardEffectsByIndex'], variants.dark['cardEffectsByIndex']],
      'a brightness snapshot dropped the slot list — a variant is what the ' +
        'cabinet resolves for the selected mode, so slot 3\'s hand-picked ' +
        'gradient vanishes the moment the brightness changes',
    ).toEqual([sanitizedLegacySlots, sanitizedLegacySlots])
    expect(payload).not.toHaveProperty('brandName')
  }, 20_000)

  it('applies an independent concept card without touching positional slots', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        ...createBrandingPayload(),
        cardEffectsByIndex: [
          {
            mode: 'override',
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
    // A card preset is a GLOBAL card decision. The per-position section is not
    // part of it: slot 1 is an explicit override and slot 3 an explicit
    // gradient, so neither may appear in this patch at all.
    expect(patchSpy).toHaveBeenCalledWith('/admin/settings/branding', {
      cardGradient: selectedCard.cardGradient,
      cardPattern: selectedCard.cardPattern,
      cardEffect: selectedCard.cardEffect,
      cardEffectProps: selectedCard.cardEffectProps,
      cardEffectOpacity: selectedCard.cardEffectOpacity,
    })
  }, 20_000)

  /**
   * The operator's own per-position gradients must survive a GLOBAL gradient
   * change, all the way to what is on screen after the save — not merely up to
   * the request body.
   *
   * The stop-at-the-request version of this test passed while the API nulled
   * exactly these gradients on any PATCH carrying `cardGradient` without
   * `cardEffectsByIndex` (removed from `mergeBrandingSettings`; pinned there by
   * "leaves every stored slot gradient alone when a PATCH carries only
   * cardGradient"). So the PATCH double below is a FAITHFUL one — it echoes the
   * stored branding with the request body merged over it, which is what the
   * server now does for these fields and nothing more — and the assertions run
   * again after `form.reset(response)`. A rule that clears slot gradients
   * cannot then hide in either layer: implemented here it lands in the body and
   * comes back through the double, and implemented in the API it changes the
   * double away from the server contract the backend spec pins by name.
   */
  it('keeps explicit slot gradients when the global palette changes', async () => {
    const user = userEvent.setup()
    const slotOverrides = [
      {
        mode: 'inherit' as const,
        cardGradient: 'linear-gradient(135deg, #2d0a4d 0%, #8545f7 100%)',
      },
      {
        mode: 'override' as const,
        cardEffect: 'waves',
        cardEffectProps: { waveSpeedX: 0.0125 },
        cardEffectOpacity: 0.68,
        cardGradient: 'linear-gradient(135deg, #0c4a6e 0%, #22d3ee 100%)',
      },
    ]
    const slotGradients = slotOverrides.map((slot) => slot.cardGradient)
    const indigo = CARD_GRADIENT_PRESETS.find((preset) => preset.id === 'indigo')
      ?.value
    const variants = createConceptThemeModeVariants(CONCEPT_THEME_PRESETS[0])
    const stored = {
      ...createBrandingPayload(),
      themePresetId: 'concept-cu',
      cardEffectsByIndex: slotOverrides,
      themeVariants: {
        light: { ...variants.light, cardEffectsByIndex: slotOverrides },
        dark: { ...variants.dark, cardEffectsByIndex: slotOverrides },
      },
    }
    vi.spyOn(api, 'get').mockResolvedValue({ data: stored })
    const patchSpy = vi
      .spyOn(api, 'patch')
      .mockImplementation(async (_url: string, body?: unknown) => ({
        data: { ...stored, ...(body as Record<string, unknown>) },
      }))

    renderWithProviders(<WebReiwaPage />)

    await screen.findByRole('heading', { name: /WEB Reiwa/ })
    await user.click(screen.getByRole('tab', { name: 'Subscription card' }))
    expect(
      screen.getByPlaceholderText('repeating-linear-gradient(…) or none'),
    ).toBeInTheDocument()
    const slotGradientValues = () =>
      screen
        .getAllByPlaceholderText('linear-gradient(...) or empty = global')
        .map((input) => (input as HTMLInputElement).value)
    expect(
      slotGradientValues(),
      'the seeded per-position gradients never reached the slot editor, so ' +
        'nothing below is actually being preserved',
    ).toEqual(slotGradients)

    const indigoGradient = screen
      .getAllByRole('button', { name: 'Indigo' })
      .find((button) => button.className.includes('aspect-square'))
    expect(indigoGradient).toBeDefined()
    await user.click(indigoGradient!)
    expect(
      slotGradientValues(),
      'picking a global gradient cleared the per-position gradients in the ' +
        'editor — a global choice is not a request to delete slot artwork',
    ).toEqual(slotGradients)
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patchSpy).toHaveBeenCalledOnce())
    const payload = patchSpy.mock.calls[0]?.[1] as Record<string, unknown>
    expect(
      payload,
      'the untouched slot array turned dirty, so the PATCH now dictates ' +
        'per-position artwork the operator did not change',
    ).not.toHaveProperty('cardEffectsByIndex')
    expect(payload.cardGradient).toBe(indigo)
    const patched = payload.themeVariants as Record<
      'light' | 'dark',
      Record<string, unknown>
    >
    for (const mode of ['light', 'dark'] as const) {
      expect(patched[mode].cardGradient, `${mode} snapshot gradient`).toBe(indigo)
      expect(
        (patched[mode].cardEffectsByIndex as typeof slotOverrides).map(
          (slot) => slot.cardGradient,
        ),
        `the ${mode} brightness snapshot in the PATCH dropped the operator's ` +
          'per-position gradients while carrying the new global one',
      ).toEqual(slotGradients)
    }

    // The operator watches the save land. `form.reset(response)` runs on
    // success, which is also what makes the form clean and Save disabled
    // again — so that is the signal to wait for. The assertion itself stays
    // OUTSIDE `waitFor`: inside, a failure retries until the test times out
    // and the message below never reaches the report.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled(),
    )
    expect(
      slotGradientValues(),
      'the saved branding came back without the per-position gradients, so ' +
        'they vanish from the editor a moment after the save lands',
    ).toEqual(slotGradients)
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
