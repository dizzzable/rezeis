/**
 * The panel has to SAY that an operator is still carrying weak recovery codes.
 *
 * Recovery codes minted before 2026-08-22 are 40 bits behind an unsalted,
 * single-round SHA-256; the current ones are 80 bits behind salted scrypt. The
 * old ones were deliberately left working — a recovery code is single-use, so
 * there is no moment where the plaintext of a code that must SURVIVE is in
 * hand to re-hash, and invalidating them would lock out exactly the operator
 * who has lost their authenticator and is holding a printout. Nothing repairs
 * that except regenerating, and an operator cannot choose to regenerate over a
 * fact nobody told them.
 *
 * The backend already answers it: `getStatus()` returns
 * `recoveryCodesLegacy`. This file is about the half that renders it, and
 * about the two ways rendering it goes quietly wrong:
 *
 *   • `?? 0` on an ABSENT field. A backend older than the change sends
 *     nothing, and "nothing" is not "zero". Collapsing them shows an operator
 *     an all-clear that no server ever asserted — the worst possible failure
 *     for a notice whose entire job is to be believed.
 *
 *   • the wrong number. `recoveryCodesLegacy` is a SUBSET of
 *     `recoveryCodesRemaining`; an operator with 3 weak and 7 current codes
 *     has 10 codes and must not read "3 codes left" and go regenerate out of
 *     panic about running out.
 *
 * Both are pinned below by the DIGITS in the notice, which is the one thing
 * neither the copy nor the layout can drift away from.
 *
 * The wire is stubbed at the axios adapter, not at `two-factor-api`, so
 * `readLegacyRecoveryCount()` — the defensive read that is the actual subject
 * — runs for real. The i18n instance is the real one with the real English
 * bundle loaded, so a key that does not exist renders as its own path and
 * fails here rather than in a browser.
 */
import { screen, within } from '@testing-library/react'
import {
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { api } from '@/lib/api'
import { authStorage } from '@/lib/auth-storage'
import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'

import TwoFactorPage from './two-factor-page'

/** The status body the page reads. `undefined` omits the field entirely. */
interface StatusBody {
  readonly enabled: boolean
  readonly enrolledAt: string | null
  readonly recoveryCodesRemaining: number
  readonly recoveryCodesLegacy?: unknown
}

let statusBody: StatusBody = {
  enabled: true,
  enrolledAt: '2026-01-01T00:00:00.000Z',
  recoveryCodesRemaining: 10,
  recoveryCodesLegacy: 3,
}

function ok(config: InternalAxiosRequestConfig, data: unknown): AxiosResponse {
  return { data, status: 200, statusText: 'OK', headers: {}, config } as AxiosResponse
}

const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
  const url = config.url ?? ''
  if (url.includes('/admin/2fa/status')) return ok(config, statusBody)
  if (url.includes('/admin/passkey/credentials')) return ok(config, [])
  if (url.includes('/admin/ip-allowlist')) return ok(config, { items: [], total: 0 })
  return ok(config, {})
}

let originalAdapter: AxiosAdapter | undefined

/** The rendered notice, or a failure that names it. */
function notice(): HTMLElement {
  return screen.getByTestId('legacy-recovery-notice')
}

/**
 * Waits for the section that owns recovery-code regeneration.
 *
 * Every test anchors here FIRST and then reads the notice synchronously.
 * Waiting for the notice itself would make the two "says nothing" cases sit
 * out a 15 s timeout before failing, and — worse — would make a test that is
 * silently asserting nothing indistinguishable from one that is working.
 */
async function regenerateSection(): Promise<HTMLElement> {
  return screen.findByTestId('regenerate-recovery-codes')
}

/** Every run of digits in the notice, in order. `null` when it has none. */
function digitsIn(element: HTMLElement): readonly string[] | null {
  return (element.textContent ?? '').match(/\d+/g)
}

beforeAll(async () => {
  await i18nReady
  await loadFeatureBundle('twoFactor')
  // Anti-vacuity: with no bundle loaded every `t()` returns its own key path,
  // every assertion below compares one key path to another, and the file
  // passes having rendered no prose at all.
  expect(i18n.language).toBe('en')
  expect(i18n.t('twoFactorPage.legacy.title')).not.toBe('twoFactorPage.legacy.title')
  expect(i18n.t('twoFactorPage.legacy.action')).not.toBe('twoFactorPage.legacy.action')
})

beforeEach(() => {
  statusBody = {
    enabled: true,
    enrolledAt: '2026-01-01T00:00:00.000Z',
    recoveryCodesRemaining: 10,
    recoveryCodesLegacy: 3,
  }
  originalAdapter = api.defaults.adapter as AxiosAdapter | undefined
  api.defaults.adapter = adapter
  window.localStorage.clear()
  authStorage.setToken('a-live-session-token')
})

afterEach(() => {
  api.defaults.adapter = originalAdapter
  window.localStorage.clear()
})

describe('weak recovery codes are visible where recovery codes are managed', () => {
  it('names how many of the remaining codes are still the weak kind', async () => {
    renderWithProviders(<TwoFactorPage />)
    await regenerateSection()

    const text = notice().textContent ?? ''
    expect(text).toContain(i18n.t('twoFactorPage.legacy.title'))
    expect(text).toContain(i18n.t('twoFactorPage.legacy.some', { count: 3 }))
  })

  it('spells out that regenerating is the fix and what it will ask for', async () => {
    // "Regenerate to fix it" is useless to an operator who has lost their
    // authenticator and is wondering whether they can still do it. The line
    // has to say which factor it wants, because holding a recovery code is
    // enough and that is the whole reason these codes were left working.
    renderWithProviders(<TwoFactorPage />)
    await regenerateSection()

    expect(notice().textContent ?? '').toContain(i18n.t('twoFactorPage.legacy.action'))
  })

  it('puts the notice inside the regenerate control, not somewhere else on the page', async () => {
    // Structural, not cosmetic: the notice and the button that acts on it must
    // be the same block, so the next move is on screen with the bad news.
    renderWithProviders(<TwoFactorPage />)
    const section = await regenerateSection()

    expect(within(section).getByTestId('legacy-recovery-notice')).toBeTruthy()
    expect(
      within(section).getByRole('button', {
        name: i18n.t('twoFactorPage.controls.regenerateButton'),
      }),
    ).toBeTruthy()
  })

  it('counts only the weak codes, never every code still left', async () => {
    // 3 weak of 10 remaining. The card header owns the total; the notice owns
    // the subset. If the notice ever renders the total, an operator with seven
    // perfectly good codes reads that all ten are compromised — and an
    // operator reading it as "3 left" regenerates for the wrong reason.
    statusBody = {
      enabled: true,
      enrolledAt: '2026-01-01T00:00:00.000Z',
      recoveryCodesRemaining: 10,
      recoveryCodesLegacy: 3,
    }
    renderWithProviders(<TwoFactorPage />)
    await regenerateSection()

    expect(digitsIn(notice())).toEqual(['3'])
    // …and the total is still stated, in its own place, unchanged.
    expect(
      screen.getByText(i18n.t('twoFactorPage.recoveryCodesRemaining', { count: 10 })),
    ).toBeTruthy()
  })

  it('does not read as an all-clear when the server never reported a count', async () => {
    // An older backend omits the field. `?? 0` here would render "you are
    // fine" on the strength of nothing, which is the one outcome this notice
    // exists to prevent.
    statusBody = {
      enabled: true,
      enrolledAt: '2026-01-01T00:00:00.000Z',
      recoveryCodesRemaining: 10,
    }
    renderWithProviders(<TwoFactorPage />)
    await regenerateSection()

    const shown = notice()
    expect(shown.textContent ?? '').toContain(i18n.t('twoFactorPage.legacy.unknown'))
    // No number at all — not 0, and not the total borrowed from next door.
    expect(digitsIn(shown)).toBeNull()
  })

  it('treats a non-numeric count as unreported rather than trusting it', async () => {
    // A proxy that stringifies the body, or a field that arrives null, is the
    // same epistemic state as absent: nobody counted.
    statusBody = {
      enabled: true,
      enrolledAt: '2026-01-01T00:00:00.000Z',
      recoveryCodesRemaining: 10,
      recoveryCodesLegacy: null,
    }
    renderWithProviders(<TwoFactorPage />)
    await regenerateSection()

    expect(notice().textContent ?? '').toContain(i18n.t('twoFactorPage.legacy.unknown'))
    expect(digitsIn(notice())).toBeNull()
  })

  it('says nothing at all once every remaining code is the current format', async () => {
    // The anchor that keeps the rest honest. A notice rendered
    // unconditionally would satisfy every assertion above and would also be
    // permanent nagging that operators learn to ignore.
    statusBody = {
      enabled: true,
      enrolledAt: '2026-01-01T00:00:00.000Z',
      recoveryCodesRemaining: 10,
      recoveryCodesLegacy: 0,
    }
    renderWithProviders(<TwoFactorPage />)
    const section = await regenerateSection()

    expect(within(section).queryByTestId('legacy-recovery-notice')).toBeNull()
    expect(screen.queryByTestId('legacy-recovery-notice')).toBeNull()
  })
})
