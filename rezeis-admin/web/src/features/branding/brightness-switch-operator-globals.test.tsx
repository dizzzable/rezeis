/**
 * What the "Default mode" dropdown is allowed to overwrite.
 *
 * SIXTH appearance of one defect, and the first on the WRITE side. The five
 * before it were all read-side: an operator edit landed on the branding root,
 * reiwa's `resolveBrandingThemeMode` overwrote it from the concept's brightness
 * snapshot on every read, and the change showed in the panel preview and
 * nowhere else. Two were answered with "root always wins" (the font, the corner
 * radii — neither has any per-brightness meaning) and three with an ownership
 * marker (the card gradient, the brand palette, the surfaces — a concept
 * legitimately ships two of each).
 *
 * This one runs one step earlier and needs no cabinet to reproduce. Selecting a
 * brightness calls `applyConceptVisualPatch(variant, false)`, which copies the
 * snapshot back onto the ROOT of the live form. For the fields reiwa reads from
 * the variant that is correct — the snapshot is where those values live. For
 * the three the read side deliberately pins to the root it is the same
 * overwrite the read side was fixed to stop doing, except the value is now gone
 * for real:
 *
 *   operator picks a font, saves          → root font = theirs, snapshot = the
 *                                           concept's (nothing mirrors it, on
 *                                           purpose — there is no per-mode font)
 *   operator later switches the default   → the snapshot's font is copied onto
 *   brightness for an unrelated reason      the root, and saved on next click
 *   cabinet                               → serves the concept's font faithfully
 *
 * "Root always wins" cannot rescue that: the root is what was overwritten. So
 * the fix is on this side — a brightness snapshot has nothing new to say about
 * typography or geometry, and skipping the write is what stops it from having
 * something old to say.
 *
 * `appBackground` is the opposite case and is here for the boundary: it IS
 * per-brightness (`buildAppBackground` composes it from the mode's own
 * background colour), so the copy must keep happening. It is made safe by
 * mirroring an operator edit INTO both snapshots first — the rule the admin API
 * already applies on save (`mergeBrandingSettings`, `hasDirectVisualPatch`), now
 * applied in the form too so the dropdown cannot revert an edit before it is
 * ever saved.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { configure, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import api from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

/** The site-wide background the operator picks by hand, mid-test. */
const OPERATOR_APP_BACKGROUND = vi.hoisted(() => ({
  kind: 'gradient' as const,
  effect: 'NONE',
  props: {},
  opacity: 1,
  gradient: 'linear-gradient(135deg, #1c1917 0%, #78350f 100%)',
  texture: {
    pattern: 'dots' as const,
    color: '#f59e0b',
    background: '#1c1917',
    scale: 24,
    opacity: 0.15,
  },
}))

vi.mock('./branding-preview', () => ({
  BrandingPreview: () => <div data-testid="branding-preview" />,
}))

vi.mock('./card-effect-section', () => ({
  CardEffectSection: () => <div data-testid="card-effect-section" />,
  CardEffectPicker: () => <div data-testid="card-effect-picker" />,
}))

vi.mock('./concept-card-preset-gallery', () => ({
  ConceptCardPresetGallery: () => <div data-testid="concept-card-gallery" />,
}))

/**
 * The real section is a four-mode configurator; what is under test is the page's
 * `onChange`, which has to reach both brightness snapshots and not just the
 * root. One button that commits a whole background says exactly that.
 */
vi.mock('./app-background-section', () => ({
  AppBackgroundSection: ({
    onChange,
  }: {
    onChange: (value: typeof OPERATOR_APP_BACKGROUND) => void
  }) => (
    <button type="button" onClick={() => onChange(OPERATOR_APP_BACKGROUND)}>
      Set app background
    </button>
  ),
}))

import WebReiwaPage from './branding-page'
import {
  CONCEPT_THEME_PRESETS,
  FONT_OPTIONS,
  createConceptThemeModeVariants,
  createConceptThemePresetVisualPatch,
} from './theme-presets'

// The page mounts every tab's section tree at once, so the first render is heavy
// under the parallel suite. Same allowance as the sibling branding suites.
configure({ asyncUtilTimeout: 20_000 })

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
})

const CONCEPT = CONCEPT_THEME_PRESETS[0]!
const CONCEPT_ROOT = createConceptThemePresetVisualPatch(CONCEPT)

/**
 * The variant pair as the API returns it, not as the panel first builds it.
 * `readThemeVariant` rebuilds a canonical variant on every read and drops the
 * concept id the panel put there, so a saved snapshot carries no identity — the
 * exact reason `applyConceptVisualPatch` cannot sniff its caller off the
 * payload and takes an explicit flag instead.
 */
const SAVED_VARIANTS = (() => {
  const built = createConceptThemeModeVariants(CONCEPT)
  const strip = (variant: (typeof built)['light']) => {
    const { themePresetId: _id, themePresetVersion: _version, ...rest } = variant
    // Always present on a stored variant: `readThemeVariant` rejects a snapshot
    // without the slot array and `readCardEffectSlots` returns an empty one.
    return { ...rest, cardEffectsByIndex: [] }
  }
  return { light: strip(built.light), dark: strip(built.dark) }
})()

/** Typography and geometry the operator chose AFTER the concept, and saved. */
const OPERATOR_FONT =
  FONT_OPTIONS.find((option) => option.value !== SAVED_VARIANTS.light.fontFamily) ??
  FONT_OPTIONS[0]!
const OPERATOR_BORDER_RADIUS =
  SAVED_VARIANTS.light.borderRadius === 'rounded-none'
    ? { value: 'rounded-full', label: 'Full (pill)' }
    : { value: 'rounded-none', label: 'None (0)' }
const OPERATOR_CORNER_RADII = { cardPx: 7, itemPx: 5, pillPx: 3 }

/**
 * A concept applied and saved, then given a hand-picked font and geometry —
 * which is why the root and the snapshots legitimately disagree about all three.
 */
function createBrandingPayload(overrides: Record<string, unknown> = {}) {
  return {
    ...CONCEPT_ROOT,
    brandName: 'Reiwa',
    logoUrl: null,
    themePresetId: CONCEPT.id,
    themePresetVersion: CONCEPT.version,
    themeModePolicy: 'fixed',
    themeDefaultMode: 'dark',
    themeVariants: SAVED_VARIANTS,
    // What the API stores for the selected brightness: root and snapshot agree
    // until the operator changes one of them.
    appBackground: SAVED_VARIANTS.dark.appBackground,
    fontFamily: OPERATOR_FONT.value,
    borderRadius: OPERATOR_BORDER_RADIUS.value,
    cornerRadii: OPERATOR_CORNER_RADII,
    cardLogo: 'DEFAULT',
    cardLogoUrl: null,
    iconColorMode: 'default',
    iconColors: {},
    ...overrides,
  }
}

type PatchSpy = ReturnType<typeof vi.fn>

async function renderPage() {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockResolvedValue({ data: createBrandingPayload() })
  const patchSpy = vi
    .spyOn(api, 'patch')
    .mockResolvedValue({ data: createBrandingPayload() }) as unknown as PatchSpy

  renderWithProviders(<WebReiwaPage />)
  await screen.findByRole('heading', { name: /WEB Reiwa/ })
  return { user, patchSpy }
}

/** Selects the other brightness through the operator's own control. */
async function selectLightBrightness(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await user.click(screen.getByRole('combobox', { name: 'Default mode' }))
  await user.click(screen.getByRole('option', { name: 'Light' }))
}

async function submitPatch(
  user: ReturnType<typeof userEvent.setup>,
  patchSpy: PatchSpy,
): Promise<Record<string, unknown>> {
  await user.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(patchSpy).toHaveBeenCalledOnce())
  return patchSpy.mock.calls[0]?.[1] as Record<string, unknown>
}

describe('selecting a brightness in the panel', () => {
  /**
   * Without this the fixture proves nothing: if the concept happened to ship the
   * operator's own font and radii, every assertion below would hold no matter
   * what the dropdown does.
   */
  it('starts from a root and a snapshot that really disagree', () => {
    for (const mode of ['light', 'dark'] as const) {
      expect(SAVED_VARIANTS[mode].fontFamily).not.toBe(OPERATOR_FONT.value)
      expect(SAVED_VARIANTS[mode].borderRadius).not.toBe(
        OPERATOR_BORDER_RADIUS.value,
      )
      expect(SAVED_VARIANTS[mode].cornerRadii).not.toEqual(OPERATOR_CORNER_RADII)
    }
    expect(SAVED_VARIANTS.light.appBackground).not.toEqual(OPERATOR_APP_BACKGROUND)
    expect(SAVED_VARIANTS.dark.appBackground).not.toEqual(OPERATOR_APP_BACKGROUND)
  })

  it("leaves the operator's typography and geometry exactly as they were", async () => {
    const { user, patchSpy } = await renderPage()

    expect(
      screen.getByRole('combobox', { name: 'Font Family' }),
      'the seeded font never reached the dropdown, so nothing below is ' +
        'actually being preserved',
    ).toHaveTextContent(OPERATOR_FONT.label)

    await selectLightBrightness(user)

    expect(
      screen.getByRole('combobox', { name: 'Font Family' }),
      "switching the default brightness replaced the operator's font with the " +
        'concept\'s — the panel offers one font dropdown, not one per brightness',
    ).toHaveTextContent(OPERATOR_FONT.label)
    expect(
      screen.getByRole('combobox', { name: 'Quick corner style' }),
      "switching the default brightness replaced the operator's corner style",
    ).toHaveTextContent(OPERATOR_BORDER_RADIUS.label)

    const payload = await submitPatch(user, patchSpy)

    expect(payload).toMatchObject({ themeDefaultMode: 'light' })
    expect(
      payload,
      'the brightness switch stamped the card gradient as hand-picked — the ' +
        'same ownership defect pointed the other way, with the concept\'s ' +
        'second gradient now unreachable for a user allowed to switch mode',
    ).not.toHaveProperty('cardGradientSource')
    for (const field of ['fontFamily', 'borderRadius', 'cornerRadii'] as const) {
      expect(
        payload,
        `the brightness switch made \`${field}\` dirty, so the concept's ` +
          "original value is about to overwrite the operator's on the server",
      ).not.toHaveProperty(field)
    }
  }, 30_000)

  it('keeps a hand-picked app background, in the root and in both snapshots', async () => {
    const { user, patchSpy } = await renderPage()

    await user.click(screen.getByRole('button', { name: 'Set app background' }))
    await selectLightBrightness(user)

    const payload = await submitPatch(user, patchSpy)

    expect(
      payload.appBackground,
      'the brightness switch put the concept\'s background back on the root — ' +
        'the operator picked one and watched it disappear in the same form',
    ).toEqual(OPERATOR_APP_BACKGROUND)
    const variants = payload['themeVariants'] as Record<
      'light' | 'dark',
      Record<string, unknown>
    >
    for (const mode of ['light', 'dark'] as const) {
      expect(
        variants?.[mode]?.appBackground,
        `the ${mode} snapshot still carries the concept's background, so the ` +
          'cabinet revives it the moment the user changes brightness',
      ).toEqual(OPERATOR_APP_BACKGROUND)
    }
  }, 30_000)
})
