/**
 * THE DAY THE OPERATOR PICKS IS THE DAY THAT GETS STORED — and the day the
 * screen agrees was already stored.
 *
 * Two defects lived in the subscription quick-edit expiry, and both of them
 * were invisible from inside UTC.
 *
 * ── A. The instant, and the calendar the change was judged in ──────────────
 *
 * react-day-picker hands back LOCAL midnight. `handleSave` sent that instant
 * verbatim (`expiresAt.toISOString()`) and decided whether anything had
 * changed by comparing `.toISOString().slice(0, 10)` on both sides — the UTC
 * day. Every other rendering of this field is local: the picker trigger
 * (`format(value, 'dd.MM.yyyy')`), the read-only "Expires" row
 * (`toLocaleDateString()`), and the operator's own head.
 *
 * At UTC+3 — Moscow, which is where this product's operators are — those two
 * calendars are three hours apart, and the damage was not symmetric:
 *
 *   • a stored expiry of 10:00Z is UTC day D; local midnight of D+1 is 21:00Z
 *     on D, i.e. UTC day D as well. Moving the expiry ONE DAY FORWARD
 *     therefore compared equal, sent NOTHING, and told the operator there were
 *     "no changes to save";
 *   • the reverse: local midnight of the day already on screen is the PREVIOUS
 *     UTC day, so re-picking the date the subscription already has compared
 *     UNEQUAL and fired a patch that moved the expiry back three hours into
 *     the day before.
 *
 * ── B. "Make it unlimited" is a gesture that exists and does nothing ───────
 *
 * `components/ui/calendar.tsx` does not pass `required`, so react-day-picker's
 * `mode="single"` deselects on a second click of the selected day:
 * `onSelect(undefined)` fires, `setExpiresAt(undefined)` and `setDirty(true)`
 * both run. `if (expiresAt)` then treated that identically to "never touched
 * the picker" — Save stayed lit, nothing was sent, and if it was the only edit
 * the operator was told there were no changes about a change they had just
 * made. So they went looking for the button that clears an expiry, and there
 * is not one: `PATCH /admin/users/subscriptions/:id` guards its write with
 * `body.expiresAt !== null`, so no request from this screen can clear it.
 *
 * ── ANTI-VACUITY, stated plainly ──────────────────────────────────────────
 *
 * The two change-detector specs below are VACUOUS AT UTC+0: at offset 0 the
 * local and UTC calendars are the same calendar and the old code behaves
 * correctly. This file therefore PINS the zone (`process.env.TZ`, hoisted
 * above the imports) and asserts the offset it got, so a harness that ignores
 * the variable fails by name instead of passing on a technicality.
 *
 * The instant assertion is NOT vacuous at UTC+0 — it checks the time-of-day
 * too, and local midnight is not 13:00 in any zone.
 *
 * No absolute date literal appears anywhere below: the year is taken from the
 * clock the test is running on and pushed into the future, so nothing here can
 * quietly become an "expired subscription" fixture as the calendar moves.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { usePermissionStore } from '@/features/rbac'
import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

/**
 * Pinned BEFORE the imports run — `vi.hoisted` is lifted above them — because
 * everything below is a statement about a zone east of UTC and there is no
 * such statement to make from inside UTC. Moscow has had no DST since 2014, so
 * the offset is +03:00 every day of the year and no fixture here can land on a
 * transition.
 */
const ORIGINAL_TZ = vi.hoisted(() => {
  const previous = process.env.TZ
  process.env.TZ = 'Europe/Moscow'
  return previous
})

vi.mock('@/features/plans/plans-api', () => ({ usePlans: () => ({ data: [] }) }))

const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: toastMock }))

import UserDetailPanel, { localCalendarDay, subscriptionExpiryInstant } from './user-detail-panel'

// ── Fixture arithmetic, all of it derived ─────────────────────────────────
/** Far enough ahead that no run of this file can read as an expired row. */
const YEAR = new Date().getFullYear() + 1
/** June: mid-month, mid-year, and clear of every DST transition. */
const MONTH_INDEX = 5
const STORED_DAY = 15
const NEXT_DAY = STORED_DAY + 1
/** The zone this file pins, in hours. Asserted below, never assumed. */
const OFFSET_HOURS = 3
/** 10:00Z — comfortably inside the day in both calendars, so the fixture itself is unambiguous. */
const STORED_UTC_HOUR = 10
/** What 10:00Z reads as on the operator's clock, spelled out rather than recomputed. */
const STORED_LOCAL_HOUR = STORED_UTC_HOUR + OFFSET_HOURS

const STORED_EXPIRY = new Date(
  Date.UTC(YEAR, MONTH_INDEX, STORED_DAY, STORED_UTC_HOUR, 0, 0, 0),
).toISOString()

const SUBSCRIPTION = {
  id: 'sub-1',
  status: 'ACTIVE',
  isTrial: false,
  trafficLimit: 100,
  deviceLimit: 3,
  expireAt: STORED_EXPIRY,
  remnawaveId: null,
  configUrl: null,
  plan: { id: 'plan-1', name: 'Base', type: 'BOTH' },
}

function userWith(sub: Record<string, unknown>) {
  return {
    id: 'user-1',
    telegramId: '12345',
    username: 'alice',
    name: 'Alice',
    language: 'en',
    role: 'USER',
    isBlocked: false,
    isPartner: false,
    points: 0,
    personalDiscount: 0,
    purchaseDiscount: 0,
    maxSubscriptions: 1,
    createdAt: new Date(Date.UTC(YEAR - 2, 0, 1)).toISOString(),
    updatedAt: new Date(Date.UTC(YEAR - 2, 0, 1)).toISOString(),
    subscriptions: [sub],
    transactions: [],
    referralsGiven: [],
    partner: null,
    webAccount: null,
  }
}

/** Read from the ACTIVE bundle rather than retyped, so a copy edit cannot make these silently unreachable. */
const noChangesToast = (): string => i18n.t('userDetailPanel.subscriptions.noChanges')
const clearRefusalToast = (): string =>
  i18n.t('userDetailPanel.subscriptions.expiryCannotBeCleared')

describe('subscription quick-edit expiry, from a zone east of UTC', () => {
  beforeAll(async () => {
    await loadFeatureBundle('userDetail')
    // Radix needs these; jsdom ships none of them.
    const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>
    proto['hasPointerCapture'] ??= () => false
    proto['setPointerCapture'] ??= () => {}
    proto['releasePointerCapture'] ??= () => {}
    proto['scrollIntoView'] ??= () => {}
  })

  // NO TZ restore here. The zone this file pins belongs to the WHOLE file,
  // and the describe below makes the same statements about it. Restoring
  // at the end of this block put those specs back on the harness's own
  // zone: green here (Europe/Moscow either way) and red in CI (UTC), where
  // the local and UTC calendars are the same calendar. The single restore
  // now lives in the last describe of the file.

  beforeEach(() => {
    vi.restoreAllMocks()
    usePermissionStore.setState({ loaded: true, role: 'DEV' })
    toastMock.info.mockClear()
    toastMock.success.mockClear()
    toastMock.error.mockClear()
    toastMock.warning.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  it('really is running east of UTC — the two change-detector specs are vacuous at offset 0', () => {
    expect(
      new Date(Date.UTC(YEAR, MONTH_INDEX, STORED_DAY, 12)).getTimezoneOffset(),
      'process.env.TZ was not honoured: at offset 0 the local and UTC calendars ' +
        'are the same calendar and the old UTC comparison passes every spec below',
    ).toBe(-OFFSET_HOURS * 60)
  })

  /** Opens the Subscriptions tab, the quick edits, and the expiry popover. Returns the picker's trigger. */
  async function openExpiryPicker(
    user: ReturnType<typeof userEvent.setup>,
  ): Promise<HTMLElement> {
    await user.click(await screen.findByRole('tab', { name: /^Subscriptions/ }))
    await user.click(await screen.findByRole('button', { name: 'Quick edits' }))
    // The trigger is the only dd.MM.yyyy button on the card. Matched by SHAPE,
    // not by re-running `format()` over the fixture — that would only assert
    // the formatter equals itself.
    const trigger = screen.getByRole('button', { name: /^\d{2}\.\d{2}\.\d{4}$/ })
    await user.click(trigger)
    await screen.findByRole('grid')
    return trigger
  }

  /**
   * The in-month cell for a day number.
   *
   * `aria-label` on these buttons is a full `PPPP` date string, so the
   * accessible name is useless for this; the text content is the day number.
   * Outside days (the greyed neighbours of the previous/next month) are
   * excluded by their `day-outside` class, and the count is asserted so a
   * changed DOM shape fails loudly instead of silently picking the wrong cell.
   */
  function calendarDay(day: number): HTMLElement {
    const grid = screen.getByRole('grid')
    const cells = within(grid)
      .getAllByRole('button')
      .filter(
        (button) =>
          button.textContent?.trim() === String(day)
          && !(button.parentElement?.classList.contains('day-outside') ?? false),
      )
    expect(cells, `expected exactly one in-month calendar cell for day ${day}`).toHaveLength(1)
    return cells[0] as HTMLElement
  }

  it('stores the day the operator picked, keeping the expiry’s own time of day', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: userWith(SUBSCRIPTION) })
    const patchSpy = vi
      .spyOn(api, 'patch')
      .mockResolvedValue({ data: { ...SUBSCRIPTION, expiresAt: STORED_EXPIRY } })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    await openExpiryPicker(user)
    await user.click(calendarDay(NEXT_DAY))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patchSpy).toHaveBeenCalledOnce())
    const [url, body] = patchSpy.mock.calls[0] as [string, Record<string, unknown>]
    expect(url).toBe('/admin/users/subscriptions/sub-1')
    expect(typeof body.expiresAt).toBe('string')

    const sent = new Date(body.expiresAt as string)
    // THE DAY, in the calendar the operator was looking at — plus the time of
    // day, which is what distinguishes "moved the day" from "sent local
    // midnight" in EVERY zone, offset 0 included.
    expect({
      year: sent.getFullYear(),
      month: sent.getMonth(),
      day: sent.getDate(),
      hour: sent.getHours(),
      minute: sent.getMinutes(),
      second: sent.getSeconds(),
      millisecond: sent.getMilliseconds(),
    }).toEqual({
      year: YEAR,
      month: MONTH_INDEX,
      day: NEXT_DAY,
      hour: STORED_LOCAL_HOUR,
      minute: 0,
      second: 0,
      millisecond: 0,
    })
    // And the same day in the calendar the ROW is stored in: `expires_at` is a
    // DateTime, and every UTC-side reading of it has to name the day on screen
    // too. Local midnight of NEXT_DAY would be the previous UTC day here.
    expect({ utcMonth: sent.getUTCMonth(), utcDay: sent.getUTCDate() }).toEqual({
      utcMonth: MONTH_INDEX,
      utcDay: NEXT_DAY,
    })
    // The whole defect was that this move was reported as no move at all.
    expect(toastMock.info).not.toHaveBeenCalledWith(noChangesToast())
  })

  it('treats re-picking the day already on screen as no change at all', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: userWith(SUBSCRIPTION) })
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    const trigger = await openExpiryPicker(user)

    // Away and back: clicking the SELECTED day would deselect it (that is the
    // other defect, below), so the stored day is re-picked by leaving it first.
    await user.click(calendarDay(NEXT_DAY))
    await user.click(calendarDay(STORED_DAY))

    // What the screen says, spelled out from the parts the fixture owns rather
    // than by re-running `format()`/`toLocaleDateString()` over it.
    expect(trigger).toHaveTextContent(`${STORED_DAY}.0${MONTH_INDEX + 1}.${YEAR}`)
    // The read-only "Expires:" row, which renders `toLocaleDateString('en-US')`
    // off `sub.expireAt`. Written out from the parts the fixture owns — running
    // the same formatter here would only assert it equals itself.
    expect(
      screen.getByText(`${MONTH_INDEX + 1}/${STORED_DAY}/${YEAR}`),
      'the card is not showing the stored day, so "the detector agrees with the ' +
        'screen" is not the thing being asserted below',
    ).toBeInTheDocument()

    const save = screen.getByRole('button', { name: 'Save' })
    expect(
      save,
      'Save is disabled, so the click below asserts nothing about the change detector',
    ).toBeEnabled()
    await user.click(save)

    expect(
      toastMock.info,
      'the picked day is the day already stored, so there is nothing to send',
    ).toHaveBeenCalledWith(noChangesToast())
    expect(
      patchSpy,
      'a patch was sent for a day that did not move — the change detector is ' +
        'judging in a calendar the operator cannot see',
    ).not.toHaveBeenCalled()
  })

  it('refuses the deselect by name instead of discarding it', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: userWith(SUBSCRIPTION) })
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    const trigger = await openExpiryPicker(user)

    // Second click on the selected day. `calendar.tsx` sets no `required`, so
    // react-day-picker answers `onSelect(undefined)`.
    await user.click(calendarDay(STORED_DAY))
    expect(
      trigger,
      'the day was not deselected, so the refusal below would be unreachable ' +
        'and this spec would pass for the wrong reason',
    ).not.toHaveTextContent(/^\d{2}\.\d{2}\.\d{4}$/)

    const save = screen.getByRole('button', { name: 'Save' })
    expect(save, 'the deselect did not mark the card dirty').toBeEnabled()
    await user.click(save)

    expect(
      toastMock.info,
      'clearing the expiry was swallowed — the operator is left hunting for a ' +
        'button that makes a subscription unlimited, and there is none',
    ).toHaveBeenCalledWith(clearRefusalToast())
    expect(
      toastMock.info,
      '"no changes" is a lie about a change the operator really did make',
    ).not.toHaveBeenCalledWith(noChangesToast())
    expect(patchSpy, 'nothing can be sent for this — the server refuses null').not.toHaveBeenCalled()
  })

  it('still sends an unrelated edit when the expiry was never touched', async () => {
    // ANTI-VACUITY for the refusal above: an untouched picker on a
    // subscription that HAS an expiry must not trip it.
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: userWith(SUBSCRIPTION) })
    const patchSpy = vi
      .spyOn(api, 'patch')
      .mockResolvedValue({ data: { ...SUBSCRIPTION, deviceLimit: 9 } })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    await user.click(await screen.findByRole('tab', { name: /^Subscriptions/ }))
    await user.click(await screen.findByRole('button', { name: 'Quick edits' }))
    const devices = (await screen.findAllByRole('spinbutton'))[1] as HTMLInputElement
    await user.clear(devices)
    await user.type(devices, '9')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patchSpy).toHaveBeenCalledOnce())
    expect(patchSpy.mock.calls[0][1]).toEqual({ deviceLimit: 9 })
    expect(toastMock.info).not.toHaveBeenCalledWith(clearRefusalToast())
  })
})

/**
 * The two pure helpers, driven directly.
 *
 * The component specs above prove the wiring; these prove the rule, including
 * the branch no fixture in this file reaches — a subscription with no expiry
 * on record, where there is no time of day to keep and "expires on the Nth"
 * has to mean the subscriber keeps service THROUGH the Nth.
 */
describe('subscriptionExpiryInstant / localCalendarDay', () => {
  // Last describe in the file, so this is where the pinned zone goes back.
  afterAll(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ
    else process.env.TZ = ORIGINAL_TZ
  })

  it('really is running east of UTC — the calendar-day spec is vacuous at offset 0', () => {
    // Same guard as the block above, and for the same reason: at offset 0
    // `localCalendarDay` and `toISOString().slice(0, 10)` agree, so the spec
    // that separates them would pass while asserting nothing. This one also
    // catches the restore-too-early defect that shipped on 23.08.2026.
    expect(
      new Date(Date.UTC(YEAR, MONTH_INDEX, STORED_DAY, 12)).getTimezoneOffset(),
      'process.env.TZ was not honoured for this block: at offset 0 the local ' +
        'and UTC calendars are the same calendar',
    ).toBe(-OFFSET_HOURS * 60)
  })

  /** What react-day-picker hands back for a click on `day`: LOCAL midnight. */
  const picked = (day: number): Date => new Date(YEAR, MONTH_INDEX, day)

  it('keeps the stored time of day and moves only the calendar day', () => {
    const sent = new Date(subscriptionExpiryInstant(picked(NEXT_DAY), STORED_EXPIRY))
    expect({
      day: sent.getDate(),
      hour: sent.getHours(),
      minute: sent.getMinutes(),
      second: sent.getSeconds(),
      millisecond: sent.getMilliseconds(),
    }).toEqual({
      day: NEXT_DAY,
      hour: STORED_LOCAL_HOUR,
      minute: 0,
      second: 0,
      millisecond: 0,
    })
  })

  it('reproduces the stored instant exactly when the stored day is re-picked', () => {
    // This is what makes the change detector and the sender agree instead of
    // fighting: picking the day that is already stored is a true no-op.
    expect(subscriptionExpiryInstant(picked(STORED_DAY), STORED_EXPIRY)).toBe(STORED_EXPIRY)
  })

  it('gives the whole of the picked day when there is no expiry on record', () => {
    for (const nothing of [undefined, null, '']) {
      const sent = new Date(subscriptionExpiryInstant(picked(STORED_DAY), nothing))
      expect({
        day: sent.getDate(),
        hour: sent.getHours(),
        minute: sent.getMinutes(),
        second: sent.getSeconds(),
        millisecond: sent.getMilliseconds(),
      }).toEqual({ day: STORED_DAY, hour: 23, minute: 59, second: 59, millisecond: 999 })
    }
  })

  it('reads the local calendar day, not the UTC one', () => {
    // 22:00Z is the NEXT day on a +03:00 clock. `.toISOString().slice(0, 10)`
    // answers the day before the one the panel renders for this same instant.
    const lateEvening = new Date(Date.UTC(YEAR, MONTH_INDEX, STORED_DAY, 22, 0, 0, 0))
    expect(localCalendarDay(lateEvening)).toBe(
      `${YEAR}-0${MONTH_INDEX + 1}-${String(NEXT_DAY).padStart(2, '0')}`,
    )
    expect(lateEvening.toISOString().slice(0, 10)).not.toBe(localCalendarDay(lateEvening))
  })

  it('answers an empty key for an unparseable date instead of throwing', () => {
    // `new Date('nonsense').toISOString()` raises RangeError, and `expireAt` is
    // `string | null | undefined` on the wire with nothing promising it parses.
    expect(localCalendarDay(new Date('nonsense'))).toBe('')
  })
})
