/**
 * Pressing Save must never be silent.
 *
 * `onSubmit` computes a dirty patch and used to `return` outright when it came
 * back empty: no request, no toast, nothing moved on screen. Every other exit
 * from that handler speaks (validation, `saved`, `saveFailed`), so this was the
 * one outcome an operator could not distinguish from a save that failed — and
 * on a page where they have just spent real effort configuring appearance, what
 * gets reported is "settings do not save".
 *
 * Reaching the branch takes a disagreement between two different notions of
 * "changed": the Save button is gated on react-hook-form's `isDirty`
 * (structural, against `defaultValues`) while the patch comes from
 * `getBrandingChangedFields` (semantic, against the loaded server draft). Today
 * the two agree, so the button is disabled whenever the patch would be empty
 * and the branch is unreachable through the UI — which is precisely why the
 * test stubs `getBrandingChangedFields` to report "nothing changed" rather than
 * pantomiming it: clicking a disabled button would assert nothing at all, and a
 * guard that only matters once those two diverge still has to be correct when
 * they do. Everything else in the module stays real.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { configure, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import api from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

vi.mock('@/features/plans/plans-api', () => ({ usePlans: () => ({ data: [] }) }))

// sonner renders through a <Toaster> the page does not own, so spying on the
// module is how the resolved text becomes assertable at all.
const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: toastMock }))

/**
 * Flips the SEMANTIC half of the comparison to "nothing changed" while
 * react-hook-form goes on tracking the real edit — the exact divergence the
 * guard exists for. Off by default so the companion test exercises the real
 * diff end to end.
 */
const diffControl = vi.hoisted(() => ({ reportNoChanges: false }))
vi.mock('./branding-form-schema', async () => {
  const actual =
    await vi.importActual<typeof import('./branding-form-schema')>(
      './branding-form-schema',
    )
  return {
    ...actual,
    getBrandingChangedFields: (
      ...args: Parameters<typeof actual.getBrandingChangedFields>
    ) => (diffControl.reportNoChanges ? {} : actual.getBrandingChangedFields(...args)),
  }
})

vi.mock('./branding-preview', () => ({
  BrandingPreview: () => <div data-testid="branding-preview" />,
}))
vi.mock('./card-effect-section', () => ({
  CardEffectSection: () => <div data-testid="card-effect-section" />,
  CardEffectPicker: () => <div data-testid="card-effect-picker" />,
}))

import WebReiwaPage from './branding-page'

// The page mounts every tab's section tree plus the preview, so the first
// render is heavy under the parallel suite. Same allowance as branding-page.
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
  diffControl.reportNoChanges = false
  toastMock.info.mockClear()
  toastMock.success.mockClear()
  toastMock.error.mockClear()
})

describe('WEB Reiwa save with an empty patch', () => {
  it('tells the operator when there is nothing to save instead of doing nothing', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: createBrandingPayload() })
    const patchSpy = vi
      .spyOn(api, 'patch')
      .mockResolvedValue({ data: createBrandingPayload() })

    renderWithProviders(<WebReiwaPage />)
    await screen.findByRole('heading', { name: /WEB Reiwa/ })

    // A real edit, so react-hook-form marks the form dirty and Save is live.
    // The semantic diff is what will come back empty.
    await user.type(
      screen.getByLabelText('Logo'),
      'https://cdn.example.com/logo.png',
    )
    diffControl.reportNoChanges = true

    const save = screen.getByRole('button', { name: 'Save' })
    expect(
      save,
      'Save is disabled, so the click below asserts nothing — this test would ' +
        'pass no matter what the empty-patch branch does',
    ).toBeEnabled()

    await user.click(save)

    expect(
      toastMock.info,
      'pressing Save with an empty patch produced no message at all — from ' +
        'the operator side that is indistinguishable from a failed save',
    ).toHaveBeenCalledWith('No changes to save')
    expect(
      patchSpy,
      'an empty patch must not reach the API',
    ).not.toHaveBeenCalled()
  }, 30_000)

  it('still sends the request exactly once when something really changed', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: createBrandingPayload() })
    const patchSpy = vi
      .spyOn(api, 'patch')
      .mockResolvedValue({ data: createBrandingPayload() })

    renderWithProviders(<WebReiwaPage />)
    await screen.findByRole('heading', { name: /WEB Reiwa/ })

    await user.type(
      screen.getByLabelText('Logo'),
      'https://cdn.example.com/logo.png',
    )
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patchSpy).toHaveBeenCalledOnce())
    expect(patchSpy).toHaveBeenCalledWith('/admin/settings/branding', {
      logoUrl: 'https://cdn.example.com/logo.png',
    })
    // The no-change notice must not fire on a real save, or it becomes noise
    // the operator learns to ignore on the one screen it matters.
    expect(toastMock.info).not.toHaveBeenCalledWith('No changes to save')
  }, 30_000)

  /**
   * "To palette" is the same shape one handler over: its two other exits toast
   * (`saveExists`, `saved`) and the empty-gradient exit did not. Unlike the
   * submit guard this one IS reachable straight from the UI.
   */
  it('explains the empty-gradient case on the To palette button', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { ...createBrandingPayload(), cardGradient: '' },
    })
    vi.spyOn(api, 'patch').mockResolvedValue({ data: createBrandingPayload() })

    renderWithProviders(<WebReiwaPage />)
    await screen.findByRole('heading', { name: /WEB Reiwa/ })

    await user.click(screen.getByRole('tab', { name: 'Subscription card' }))
    await user.click(screen.getByRole('button', { name: /To palette/ }))

    expect(
      toastMock.info,
      'the To palette button did nothing and said nothing on an empty gradient',
    ).toHaveBeenCalledWith('Set a gradient first — there is nothing to save')
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
