/**
 * The GLOBAL invite-limit boxes on the referral settings page — the surface the
 * out-of-range values in `Settings.referralSettings` came from.
 *
 * `PATCH /admin/settings/referral` takes a bare `Record<string, unknown>` and
 * has no DTO, so unlike the per-user override there is no 400 waiting to catch
 * a bad number: whatever this form sends is what gets stored, and the only
 * backstop is `ReferralInviteLimitsService` clamping it again on every read
 * (and only when the matching toggle is ON). The server stays the authority —
 * these tests check that the page stops producing the values in the first
 * place, and says the bound out loud while it does.
 *
 * Everything here asserts the REQUEST BODY THAT ACTUALLY GOES OUT and the
 * RENDERED validation state. No validator function is called directly.
 *
 * A note on the harness, because it lies about one case: `userEvent.type`
 * re-derives a number input's value from the keystrokes and normalises
 * `1e3` into `1000`, which is NOT what a browser does. jsdom's own value
 * sanitiser keeps `"1e3"` (it is a valid floating-point number for
 * `type=number`), and that is the string `parseInt` used to read as 1. The
 * exponent test therefore sets the value directly with `fireEvent.change`;
 * driving it with `userEvent.type` would silently test nothing.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { i18nReady } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import ReferralSettingsPage from './referral-settings-page'

const TTL_LABEL = 'Link TTL (days)'
const SLOTS_LABEL = 'Initial Slots per User'
const TTL_TOGGLE = 'Enable Link TTL'
const SLOTS_TOGGLE = 'Enable Invite Slots'

/**
 * Deliberately none of the page's own defaults.
 *
 * `giftDurationDays` defaults to 30 and `level1Reward` to 5, so a test that
 * typed either could pass on a form that ignored the box entirely. 17 days and
 * 12 slots appear nowhere in `defaultValues`, and neither is the stored
 * fixture below.
 */
const LEGIT_TTL_DAYS = 17
const LEGIT_TTL_SECONDS = LEGIT_TTL_DAYS * 86400 // 1_468_800
const LEGIT_SLOTS = 12

const STORED_TTL_DAYS = 7

function storedSettings(overrides: Record<string, unknown> = {}) {
  return {
    referralSettings: {
      enabled: true,
      inviteLimits: {
        linkTtlEnabled: true,
        linkTtlSeconds: STORED_TTL_DAYS * 86400,
        slotsEnabled: true,
        initialSlots: 3,
        ...overrides,
      },
    },
  }
}

function mount(settings: unknown = storedSettings()): ReturnType<typeof userEvent.setup> {
  vi.spyOn(api, 'get').mockResolvedValue({ data: settings })
  vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })
  renderWithProviders(<ReferralSettingsPage />)
  return userEvent.setup()
}

function patchSpy(): ReturnType<typeof vi.fn> {
  return api.patch as unknown as ReturnType<typeof vi.fn>
}

/** The `inviteLimits` block of the one PATCH this page sends, or null if none. */
async function saveAndReadInviteLimits(
  user: ReturnType<typeof userEvent.setup>,
): Promise<Record<string, unknown> | null> {
  await user.click(screen.getByRole('button', { name: /Save/ }))
  try {
    await vi.waitFor(() => expect(patchSpy()).toHaveBeenCalled(), { timeout: 1000 })
  } catch {
    return null
  }
  const [url, body] = patchSpy().mock.calls[0] as [string, Record<string, unknown>]
  expect(url).toBe('/admin/settings/referral')
  return body.inviteLimits as Record<string, unknown>
}

describe('Referral settings invite-limit bounds', () => {
  beforeAll(async () => {
    await i18nReady
  })

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // ── The defect: a negative reaching storage ────────────────────────────────

  /**
   * The path the `min` attribute never covered.
   *
   * `min` is enforced by the browser only while the input is MOUNTED, and both
   * boxes live behind a toggle. Typing a negative and then switching the
   * section off takes the constraint away with the field — and the mutation
   * writes `linkTtlSeconds` regardless of `linkTtlEnabled`, so the negative
   * landed in `Settings.referralSettings` with nothing left on screen to
   * refuse it. The server's reader then deliberately leaves values behind a
   * disabled toggle unclamped, so it sat there waiting for the toggle.
   */
  it('does not send a negative TTL when the section is switched off after typing one', async () => {
    const user = mount()
    const field = await screen.findByLabelText(TTL_LABEL)
    await user.clear(field)
    await user.type(field, '-5')
    await user.click(screen.getByRole('switch', { name: TTL_TOGGLE }))

    const limits = await saveAndReadInviteLimits(user)

    expect(limits).not.toBeNull()
    expect(limits?.linkTtlSeconds).not.toBe(-432000)
    expect(limits?.linkTtlSeconds as number).toBeGreaterThanOrEqual(86400)
  })

  it('does not send negative slots when the section is switched off after typing them', async () => {
    const user = mount()
    const field = await screen.findByLabelText(SLOTS_LABEL)
    await user.clear(field)
    await user.type(field, '-4')
    await user.click(screen.getByRole('switch', { name: SLOTS_TOGGLE }))

    const limits = await saveAndReadInviteLimits(user)

    expect(limits).not.toBeNull()
    expect(limits?.initialSlots).toBe(0)
  })

  // ── The rendered validation state ─────────────────────────────────────────

  it('marks a below-floor TTL invalid, names the bound, and holds Save', async () => {
    const user = mount()
    const field = await screen.findByLabelText(TTL_LABEL)
    await user.clear(field)
    await user.type(field, '-5')

    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText(/Minimum 1 day/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled()
  })

  it('marks negative slots invalid and holds Save', async () => {
    const user = mount()
    const field = await screen.findByLabelText(SLOTS_LABEL)
    await user.clear(field)
    await user.type(field, '-4')

    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText(/Minimum 0\./)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled()
  })

  /**
   * A stored negative prefills the box — `-432000 / 86400` renders as `-5` —
   * so the operator meets the bound on open, not after a fruitless Save.
   */
  it('names the bound on a stored negative without waiting for a Save', async () => {
    mount(storedSettings({ linkTtlSeconds: -432000, initialSlots: -4 }))

    const ttl = await screen.findByLabelText(TTL_LABEL)
    expect((ttl as HTMLInputElement).value).toBe('-5')
    expect(ttl).toHaveAttribute('aria-invalid', 'true')
    expect(await screen.findByLabelText(SLOTS_LABEL)).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled()
  })

  // ── ANTI-VACUITY CONTROLS ─────────────────────────────────────────────────
  //
  // A bound that also refuses good values is its own outage, and the page
  // already shipped one: `min="1"` on Initial Slots refused `0`, which the
  // server documents as legitimate ("this user gets no invite slots").

  it('ANTI-VACUITY: an ordinary TTL still saves, unmarked, with Save released', async () => {
    const user = mount()
    const field = await screen.findByLabelText(TTL_LABEL)
    await user.clear(field)
    await user.type(field, String(LEGIT_TTL_DAYS))

    expect(field).toHaveAttribute('aria-invalid', 'false')
    expect(screen.getByRole('button', { name: /Save/ })).toBeEnabled()

    const limits = await saveAndReadInviteLimits(user)
    expect(limits?.linkTtlSeconds).toBe(LEGIT_TTL_SECONDS)
    expect(limits?.linkTtlEnabled).toBe(true)
  })

  it('ANTI-VACUITY: an ordinary slot count still saves', async () => {
    const user = mount()
    const field = await screen.findByLabelText(SLOTS_LABEL)
    await user.clear(field)
    await user.type(field, String(LEGIT_SLOTS))

    expect(field).toHaveAttribute('aria-invalid', 'false')

    const limits = await saveAndReadInviteLimits(user)
    expect(limits?.initialSlots).toBe(LEGIT_SLOTS)
  })

  /**
   * ANTI-VACUITY, and a fix in its own right. `initialSlots: 0` is a real
   * setting the server explicitly permits (`MIN_INVITE_COUNT_SETTING = 0`);
   * `min="1"` made the form refuse to submit at all, with no message, because
   * an unsatisfiable native constraint blocks submission silently.
   */
  it('ANTI-VACUITY: zero slots is a legitimate setting and reaches the request', async () => {
    const user = mount()
    const field = await screen.findByLabelText(SLOTS_LABEL)
    expect(field).toHaveAttribute('min', '0')

    await user.clear(field)
    await user.type(field, '0')

    expect(field).toHaveAttribute('aria-invalid', 'false')
    expect(screen.getByRole('button', { name: /Save/ })).toBeEnabled()

    const limits = await saveAndReadInviteLimits(user)
    expect(limits?.initialSlots).toBe(0)
  })

  // ── `0` days vs an empty box ──────────────────────────────────────────────

  /**
   * "No expiry" is an EMPTY box, and must stay one. It was never `0`: `'0'` is
   * a non-empty string, so the old `values.inviteLinkTtlDays ? … : null` sent
   * `linkTtlSeconds: 0` — an invite expired at the instant it is minted, the
   * exact value `MIN_LINK_TTL_SECONDS` exists to refuse. (The backend's own
   * comment believed this form mapped "an empty/zero box" to `null`; only half
   * of that was true.)
   */
  it('keeps an empty TTL box meaning no expiry', async () => {
    const user = mount()
    const field = await screen.findByLabelText(TTL_LABEL)
    await user.clear(field)

    expect(field).toHaveAttribute('aria-invalid', 'false')
    expect(screen.getByRole('button', { name: /Save/ })).toBeEnabled()

    const limits = await saveAndReadInviteLimits(user)
    expect(limits?.linkTtlSeconds).toBeNull()
  })

  it('keeps an empty slots box meaning unlimited', async () => {
    const user = mount()
    const field = await screen.findByLabelText(SLOTS_LABEL)
    await user.clear(field)

    const limits = await saveAndReadInviteLimits(user)
    expect(limits?.initialSlots).toBeNull()
  })

  it('refuses a zero-day TTL instead of minting already-dead links', async () => {
    const user = mount()
    const field = await screen.findByLabelText(TTL_LABEL)
    await user.clear(field)
    await user.type(field, '0')

    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled()
  })

  // ── `parseInt` leniency ───────────────────────────────────────────────────

  /**
   * The quietest defect on this page, and the one no `min` could have caught.
   *
   * `1e3` is a valid value for `<input type="number">` — every constraint
   * passes, Save is live, nothing is marked — and `parseInt('1e3', 10)` is 1.
   * An operator asking for a 1000-day link got a 1-day one and no indication
   * anywhere that the number had been changed.
   */
  it('reads exponent notation as the number the operator typed, not its first digit', async () => {
    const user = mount()
    const field = (await screen.findByLabelText(TTL_LABEL)) as HTMLInputElement
    fireEvent.change(field, { target: { value: '1e3' } })

    // The premise: the browser accepts this string, so nothing else stops it.
    expect(field.value).toBe('1e3')
    expect(field.checkValidity()).toBe(true)
    expect(field).toHaveAttribute('aria-invalid', 'false')

    const limits = await saveAndReadInviteLimits(user)
    expect(limits?.linkTtlSeconds).toBe(1000 * 86400)
    expect(limits?.linkTtlSeconds).not.toBe(1 * 86400)
  })

  it('sends no expiry rather than a wrong number when the box holds junk', async () => {
    const user = mount()
    const field = (await screen.findByLabelText(TTL_LABEL)) as HTMLInputElement
    // A number input sanitises this to '' on its own; the assertion is that
    // whatever survives becomes `null` and never a truncated `12`.
    fireEvent.change(field, { target: { value: '12abc' } })

    const limits = await saveAndReadInviteLimits(user)
    expect(limits?.linkTtlSeconds).toBeNull()
    expect(limits?.linkTtlSeconds).not.toBe(12 * 86400)
  })

  // ── Label association ─────────────────────────────────────────────────────

  /**
   * The gap the per-user panel had. This page does not: shadcn's `FormLabel`
   * and `FormControl` wire `htmlFor` / `id` from the same `FormItem` id, which
   * is why every query above can address the fields by their visible label.
   * Pinned so a hand-rolled `<Input>` cannot quietly drop out of the pairing.
   */
  it('associates both invite-limit labels with their inputs', async () => {
    mount()
    const ttl = await screen.findByLabelText(TTL_LABEL)
    const slots = await screen.findByLabelText(SLOTS_LABEL)

    for (const [field, label] of [
      [ttl, TTL_LABEL],
      [slots, SLOTS_LABEL],
    ] as const) {
      expect(field.id).not.toBe('')
      expect(document.querySelector(`label[for="${field.id}"]`)?.textContent).toBe(label)
      // The bound is announced with the field, not merely printed beside it.
      const describedBy = field.getAttribute('aria-describedby')
      expect(describedBy).toBeTruthy()
      expect(document.getElementById(describedBy as string)?.textContent).toMatch(/Minimum/)
    }
  })

  it('keeps the native floor on both boxes as a first line of defence', async () => {
    mount()
    expect(await screen.findByLabelText(TTL_LABEL)).toHaveAttribute('min', '1')
    expect(await screen.findByLabelText(SLOTS_LABEL)).toHaveAttribute('min', '0')
  })
})
