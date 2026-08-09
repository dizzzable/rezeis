/**
 * What a preset is allowed to overwrite in "Background by card position".
 *
 * A slot has TWO independent axes, and each has its own inherit state: the
 * effect axis (`mode`) and the gradient axis (`cardGradient === null`). A slot
 * left on inherit holds no artwork of its own, so it resolves through the
 * globals and follows a preset for free. A slot the operator switched to
 * `override`, or gave an explicit gradient, is deliberate work — and clicking a
 * preset is not a request to delete it.
 *
 * The reported defect: slot 1 in override mode with the gradient
 * `#4c1d95 → #a855f7`, one click on a card preset, and afterwards the mode
 * button had flipped back to "Customize separately" and the gradient input was
 * empty. No confirmation, no toast, no undo. With the preview strip now paging
 * one card per slot, every page then rendered the same artwork, which is what
 * "the per-position backgrounds do not work" turned out to mean.
 *
 * These tests drive the real page and the real preview: they assert what the
 * operator sees in the section (mode + gradient), what the strip renders on
 * each page, and what the PATCH carries — including the light/dark snapshots,
 * which used to be rebuilt as all-inherit placeholders from a bare count.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { configure, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import api from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

vi.mock('@/features/plans/plans-api', () => ({
  usePlans: () => ({ data: [] }),
}))

// The notice is the only user-visible string this change adds, and sonner
// renders through a <Toaster> the page does not own. Spying on the module is
// how the resolved (and pluralized) text becomes assertable at all.
const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: toastMock }))

// The effect grid and its dynamic controls are not under test here, and the
// real picker would mount one per override slot.
vi.mock('./card-effect-section', () => ({
  CardEffectSection: () => <div data-testid="card-effect-section" />,
  CardEffectPicker: () => <div data-testid="card-effect-picker" />,
}))

vi.mock('./concept-card-preset-gallery', async () => {
  const { CONCEPT_CARD_PRESETS, createConceptCardPresetVisualPatch } = await import(
    './concept-card-presets'
  )
  const preset = CONCEPT_CARD_PRESETS[0]!

  return {
    ConceptCardPresetGallery: ({
      onApply,
    }: {
      onApply: (
        selected: typeof preset,
        patch: ReturnType<typeof createConceptCardPresetVisualPatch>,
      ) => void
    }) => (
      <button
        type="button"
        onClick={() => onApply(preset, createConceptCardPresetVisualPatch(preset))}
      >
        Apply card preset
      </button>
    ),
  }
})

import WebReiwaPage from './branding-page'
import { CONCEPT_CARD_PRESETS } from './concept-card-presets'
import { CONCEPT_THEME_PRESETS, createConceptThemeModeVariants } from './theme-presets'
import { en } from '@/i18n/en'
import { ru } from '@/i18n/ru'

// The page mounts every tab's section tree plus the live preview, so the first
// render is heavy under the parallel suite. Same allowance as branding-page.
configure({ asyncUtilTimeout: 20_000 })

/** The operator's own artwork, from the live reproduction. */
const OVERRIDE_GRADIENT = 'linear-gradient(135deg, #4c1d95 0%, #a855f7 100%)'
/** An inherit slot may still carry a hand-picked gradient — separate axis. */
const INHERIT_SLOT_GRADIENT = 'linear-gradient(135deg, #0c4a6e 0%, #22d3ee 100%)'

/**
 * Slot 1 overrides the effect AND the gradient; slot 2 inherits both and so
 * must follow whatever preset lands next; slot 3 inherits the effect but keeps
 * its own gradient.
 */
const OPERATOR_SLOTS = [
  {
    mode: 'override' as const,
    cardEffect: 'waves',
    cardEffectProps: { waveSpeedX: 0.0125 },
    cardEffectOpacity: 0.68,
    cardGradient: OVERRIDE_GRADIENT,
  },
  { mode: 'inherit' as const, cardGradient: null },
  { mode: 'inherit' as const, cardGradient: INHERIT_SLOT_GRADIENT },
]

/** Radix's Select trigger needs these; jsdom ships none of them. */
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

function createBrandingPayload(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  }
}

type PatchSpy = { mock: { calls: unknown[][] } } & ReturnType<typeof vi.fn>

async function renderPage(slots: readonly unknown[] = OPERATOR_SLOTS) {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockResolvedValue({
    data: createBrandingPayload({ cardEffectsByIndex: slots }),
  })
  const patchSpy = vi
    .spyOn(api, 'patch')
    .mockResolvedValue({ data: createBrandingPayload() }) as unknown as PatchSpy

  const view = renderWithProviders(<WebReiwaPage />)
  await screen.findByRole('heading', { name: /WEB Reiwa/ })
  return { user, patchSpy, container: view.container }
}

/** Every strip page's gradient, read off the rendered card, page by page. */
function pageGradients(container: HTMLElement): string[] {
  const dots = () =>
    Array.from(container.querySelectorAll<HTMLElement>('button[data-preview-card-dot]'))
  const out: string[] = []
  for (let index = 0; index < dots().length; index += 1) {
    fireEvent.click(dots()[index]!)
    out.push(
      container.querySelector<HTMLElement>('[data-preview-card-layer="gradient"]')?.style
        .backgroundImage ?? '',
    )
  }
  return out
}

/** How the section reports slot 1: override mode shows a "Use global" escape. */
function overrideModeButtons(): HTMLElement[] {
  return screen.queryAllByRole('button', { name: 'Use global' })
}

/**
 * Every per-slot gradient input, by value. Read as a list rather than asserted
 * one at a time so a failure prints what the section actually holds instead of
 * "expected null to be in the document".
 */
function slotGradientInputs(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLInputElement>(
      'input[placeholder="linear-gradient(...) or empty = global"]',
    ),
  ).map((input) => input.value)
}

/**
 * The slot array each brightness snapshot carries. Pulled out of the payload
 * rather than matched inside it: a whole-variant `toMatchObject` diff buries
 * the one field under a hundred lines of palette.
 */
function variantSlots(payload: Record<string, unknown>): unknown[] {
  const variants = payload['themeVariants'] as
    | Record<'light' | 'dark', Record<string, unknown>>
    | undefined
  return [
    variants?.light?.['cardEffectsByIndex'],
    variants?.dark?.['cardEffectsByIndex'],
  ]
}

const VARIANT_SLOTS_LOST =
  'a brightness snapshot carries placeholder slots instead of the operator\'s. ' +
  'A variant is what the cabinet resolves for the selected light/dark mode, so ' +
  'the override disappears the moment the brightness changes'

async function submitPatch(
  user: ReturnType<typeof userEvent.setup>,
  patchSpy: PatchSpy,
): Promise<Record<string, unknown>> {
  await user.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(patchSpy).toHaveBeenCalledOnce())
  return patchSpy.mock.calls[0]?.[1] as Record<string, unknown>
}

describe('applying a preset over configured card positions', () => {
  it('keeps the overridden slot mode and gradient when a card preset is applied', async () => {
    const { user, patchSpy, container } = await renderPage()

    await user.click(screen.getByRole('tab', { name: 'Subscription card' }))
    expect(overrideModeButtons(), 'slot 1 did not start in override mode').toHaveLength(1)
    expect(slotGradientInputs(container)).toEqual([
      OVERRIDE_GRADIENT,
      '',
      INHERIT_SLOT_GRADIENT,
    ])

    await user.click(screen.getByRole('button', { name: 'Apply card preset' }))

    expect(
      overrideModeButtons(),
      'the card preset flipped slot 1 back to "Customize separately" — the ' +
        'operator explicitly switched that slot to its own effect and a preset ' +
        'click is not a request to undo it',
    ).toHaveLength(1)
    expect(
      slotGradientInputs(container),
      "the card preset emptied a slot's gradient input — hand-picked artwork " +
        'is gone with no confirmation, no toast and no undo (slot 3 inherits ' +
        'only the EFFECT, so its gradient is just as deliberate)',
    ).toEqual([OVERRIDE_GRADIENT, '', INHERIT_SLOT_GRADIENT])

    const payload = await submitPatch(user, patchSpy)
    const preset = CONCEPT_CARD_PRESETS[0]!
    expect(payload).toMatchObject({
      cardGradient: preset.cardGradient,
      cardEffect: preset.cardEffect,
    })
    expect(
      payload,
      'the preset rewrote cardEffectsByIndex, so the PATCH ships slot values ' +
        'the operator never chose',
    ).not.toHaveProperty('cardEffectsByIndex')
  }, 30_000)

  it('keeps the overridden slot when a theme preset is applied, in the root AND both brightness snapshots', async () => {
    const { user, patchSpy, container } = await renderPage()

    await user.click(screen.getByRole('button', { name: 'A Vital Link' }))

    expect(
      overrideModeButtons(),
      'the theme preset flipped slot 1 back to inherit',
    ).toHaveLength(1)
    expect(
      slotGradientInputs(container),
      "the theme preset emptied a slot's gradient input",
    ).toEqual([OVERRIDE_GRADIENT, '', INHERIT_SLOT_GRADIENT])

    const payload = await submitPatch(user, patchSpy)
    const expected = createConceptThemeModeVariants(CONCEPT_THEME_PRESETS[0]!)
    expect(
      payload,
      'the theme preset rewrote the root slot array',
    ).not.toHaveProperty('cardEffectsByIndex')
    expect(payload).toMatchObject({
      themePresetId: 'concept-a',
      themeVariants: {
        light: expect.objectContaining({ cardGradient: expected.light.cardGradient }),
        dark: expect.objectContaining({ cardGradient: expected.dark.cardGradient }),
      },
    })
    expect(variantSlots(payload), VARIANT_SLOTS_LOST).toEqual([
      OPERATOR_SLOTS,
      OPERATOR_SLOTS,
    ])
  }, 30_000)

  it('lets an inherit slot follow the preset while the overridden slot holds still', async () => {
    const { user, container } = await renderPage()

    const before = pageGradients(container)
    // Three slots plus the trailing global page.
    expect(before).toHaveLength(4)
    expect(before[1], 'jsdom did not parse the seeded gradient').toContain('rgb(')

    await user.click(screen.getByRole('tab', { name: 'Subscription card' }))
    await user.click(screen.getByRole('button', { name: 'Apply card preset' }))

    const after = pageGradients(container)

    expect(
      after[0],
      'the overridden slot page changed artwork — the preset overwrote work ' +
        'the operator did by hand',
    ).toBe(before[0])
    expect(
      after[1],
      'the inherit slot page did not change — a slot that owns no artwork must ' +
        'pick the preset up for free',
    ).not.toBe(before[1])
    expect(
      after[1],
      'the inherit slot page and the global fallback page disagree, so the ' +
        'slot is not resolving through the globals the preset just replaced',
    ).toBe(after[3])
    expect(
      after[2],
      'the slot that inherits only the EFFECT lost its own gradient',
    ).toBe(before[2])
    // The whole complaint: after a preset every page looked identical.
    expect(
      new Set(after).size,
      'every page of the strip renders the same artwork, so there is nothing ' +
        'to swipe between',
    ).toBeGreaterThan(1)
  }, 30_000)

  it('survives a light/dark switch after the preset', async () => {
    const { user, patchSpy, container } = await renderPage()

    await user.click(screen.getByRole('button', { name: 'A Vital Link' }))
    // The brightness chooser only appears once a concept prepared the variants.
    await user.click(screen.getByRole('combobox', { name: 'Default mode' }))
    await user.click(screen.getByRole('option', { name: 'Light' }))

    expect(
      overrideModeButtons(),
      'switching the default brightness dropped slot 1 back to inherit',
    ).toHaveLength(1)
    expect(
      slotGradientInputs(container),
      "switching the default brightness emptied a slot's gradient",
    ).toEqual([OVERRIDE_GRADIENT, '', INHERIT_SLOT_GRADIENT])

    const payload = await submitPatch(user, patchSpy)
    expect(payload).not.toHaveProperty('cardEffectsByIndex')
    expect(payload).toMatchObject({ themeDefaultMode: 'light' })
    expect(variantSlots(payload), VARIANT_SLOTS_LOST).toEqual([
      OPERATOR_SLOTS,
      OPERATOR_SLOTS,
    ])
  }, 30_000)

  it('leaves the slots alone for a standard theme too, and explains itself the same way', async () => {
    // A standard preset never rewrote the slot array — only the concept paths
    // did — but it repaints the global card just as thoroughly, so the operator
    // is owed the same explanation for why position 1 did not move with it.
    const { user, patchSpy, container } = await renderPage()

    // "Emerald" is both a standard theme and a card-gradient swatch; only the
    // theme tile is a toggle.
    const themeTile = screen
      .getAllByRole('button', { name: 'Emerald' })
      .find((button) => button.hasAttribute('aria-pressed'))
    expect(themeTile).toBeDefined()
    await user.click(themeTile!)

    expect(overrideModeButtons()).toHaveLength(1)
    expect(
      slotGradientInputs(container),
      "a standard theme emptied a slot's gradient input",
    ).toEqual([OVERRIDE_GRADIENT, '', INHERIT_SLOT_GRADIENT])
    expect(
      toastMock.info,
      'a standard theme repainted the global card and said nothing about the ' +
        'positions that kept their own',
    ).toHaveBeenCalledWith(
      expect.stringContaining('2 card positions keep their own background'),
    )

    const payload = await submitPatch(user, patchSpy)
    expect(payload).not.toHaveProperty('cardEffectsByIndex')
  }, 30_000)

  it('still applies a theme over a legacy slot value this build cannot validate', async () => {
    // Persisted by an older build: `url(...)` is no longer an accepted
    // gradient, the slot never had a `mode`, and the operator has no control
    // that could repair either. Copying such a slot into a brightness snapshot
    // verbatim fails the whole submit, because a variant — unlike the root
    // array, which an unchanged PATCH omits — is always sent and revalidated.
    const { user, patchSpy } = await renderPage([
      {
        cardEffect: 'aurora',
        cardEffectOpacity: 1,
        cardGradient: 'url(https://legacy.example/card.png)',
      },
    ])

    await user.click(screen.getByRole('button', { name: 'A Vital Link' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(
        toastMock.error.mock.calls.length + patchSpy.mock.calls.length,
      ).toBeGreaterThan(0),
    )

    expect(
      toastMock.error.mock.calls.flat(),
      'a legacy slot value blocked the whole submit — this panel is a PATCH ' +
        'client precisely so a value a newer build no longer accepts cannot ' +
        'stop the operator applying a theme',
    ).toEqual([])
    expect(patchSpy).toHaveBeenCalledOnce()
    const payload = patchSpy.mock.calls[0]?.[1] as Record<string, unknown>
    expect(variantSlots(payload)).toEqual([
      [{ mode: 'inherit', cardGradient: null }],
      [{ mode: 'inherit', cardGradient: null }],
    ])
  }, 30_000)

  it('tells the operator which positions kept their own background', async () => {
    const { user } = await renderPage()

    await user.click(screen.getByRole('tab', { name: 'Subscription card' }))
    await user.click(screen.getByRole('button', { name: 'Apply card preset' }))

    // Two of the three slots hold artwork of their own (override + explicit
    // gradient); the bare inherit slot kept nothing, because it had nothing.
    expect(
      toastMock.info,
      'the preset left positions untouched without saying so — the operator ' +
        'swipes to card 1, sees the old artwork and concludes it did not apply',
    ).toHaveBeenCalledWith(
      expect.stringContaining('2 card positions keep their own background'),
    )
  }, 30_000)

  it('says nothing when every slot inherits', async () => {
    const { user } = await renderPage([
      { mode: 'inherit' as const, cardGradient: null },
      { mode: 'inherit' as const, cardGradient: null },
    ])

    await user.click(screen.getByRole('tab', { name: 'Subscription card' }))
    await user.click(screen.getByRole('button', { name: 'Apply card preset' }))

    expect(
      toastMock.info,
      'a preset that changed nothing about the slots still nagged the operator',
    ).not.toHaveBeenCalled()
  }, 30_000)
})

describe('preserved-slot notice copy', () => {
  const slots = (dictionary: typeof en | typeof ru) =>
    dictionary.brandingPage.sections.cardEffectSlots as Record<string, string>

  it('ships the notice in both languages, with the plural forms each needs', () => {
    expect(slots(en)['presetKeptSlots_one']).toBeTruthy()
    expect(slots(en)['presetKeptSlots_other']).toBeTruthy()
    // Russian needs one/few/many, not the two English forms.
    for (const form of ['_one', '_few', '_many', '_other']) {
      expect(
        slots(ru)[`presetKeptSlots${form}`],
        `ru is missing the ${form} plural of presetKeptSlots`,
      ).toBeTruthy()
    }
    expect(slots(ru)['presetKeptSlots_one']).not.toBe(slots(en)['presetKeptSlots_one'])
    for (const dictionary of [en, ru]) {
      expect(slots(dictionary)['presetKeptSlots_one']).toContain('{{count}}')
      expect(slots(dictionary)['presetKeptSlots_other']).toContain('{{count}}')
    }
  })
})
