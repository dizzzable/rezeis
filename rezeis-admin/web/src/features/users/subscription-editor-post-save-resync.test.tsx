/**
 * ONE CARD MUST NOT SHOW ONE FIELD TWO WAYS.
 *
 * `SubscriptionCard` is keyed by `sub.id`, so its `useState` initialisers run
 * once per card lifetime. `updateSubMutation.onSuccess` invalidates the user
 * query but does not remount the card, so after a save the read-only rows at
 * the top re-render from the server while the quick-edit inputs below still
 * hold whatever the operator typed. Whenever the two differ — `parseInt`
 * truncating the typed fraction before the patch goes out is the shape that
 * actually produces it today — the same field reads one number above and a
 * different one below, in one card, in one screenful, with nothing saying
 * which is real.
 *
 * NO SPEC HERE MODELS A SERVER BEHAVIOUR THIS ENDPOINT DOES NOT HAVE. The two
 * traffic specs used to turn on a whole-gigabyte FLOOR — `0` sent, `1` stored
 * — and `readOperatorTrafficLimitGb` refuses anything below `1` outright, so
 * that answer is a 400 and never a row. Both now use the client-side
 * truncation instead, which is reachable exactly as written; the two
 * unlimited-switch specs at the bottom are the only ones left that pin a shape
 * production cannot currently produce, and they say so in their own docblock.
 *
 * The obvious repair is the wrong one: keying the card on a changing value
 * remounts it, which fixes this and breaks something worse — any background
 * refetch would then throw away a half-typed number mid-keystroke. So the
 * editor RECONCILES instead of remounting, under two rules that are both
 * pinned below:
 *
 *   1. only the fields THIS save sent are adopted;
 *   2. only while the input still holds exactly what was sent — the check runs
 *      inside a functional state updater, so it reads the value at commit
 *      time, and anything typed between the press and the response wins.
 *
 * No absolute date literal appears here: the fixture's dates are derived from
 * the clock the test is running on, so nothing in this file can quietly turn
 * into an "expired subscription" assertion as the calendar moves.
 */
import { act, cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePermissionStore } from '@/features/rbac'
import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

vi.mock('@/features/plans/plans-api', () => ({ usePlans: () => ({ data: [] }) }))

const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: toastMock }))

import UserDetailPanel from './user-detail-panel'

/** Comfortably ahead of whenever this file is run. Never written down. */
const YEAR = new Date().getFullYear() + 1
const FUTURE_EXPIRY = new Date(Date.UTC(YEAR, 5, 15, 10, 0, 0, 0)).toISOString()
const PAST_TIMESTAMP = new Date(Date.UTC(YEAR - 2, 0, 1)).toISOString()

const ASSIGNED_TRAFFIC_GB = 100
const ASSIGNED_DEVICES = 3

/** The row as `GET /admin/users/:telegramId` maps it — note `expireAt`. */
const SUBSCRIPTION = {
  id: 'sub-1',
  status: 'ACTIVE',
  isTrial: false,
  trafficLimit: ASSIGNED_TRAFFIC_GB,
  deviceLimit: ASSIGNED_DEVICES,
  expireAt: FUTURE_EXPIRY,
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
    createdAt: PAST_TIMESTAMP,
    updatedAt: PAST_TIMESTAMP,
    subscriptions: [sub],
    transactions: [],
    referralsGiven: [],
    partner: null,
    webAccount: null,
  }
}

/**
 * The PATCH answer: `{ ...updated, syncPending, remnawaveLinkRequired }`, i.e.
 * the Prisma row that was written — so the COLUMN's names, `expiresAt` and not
 * the read model's `expireAt`.
 */
function writtenRow(overrides: Record<string, unknown>) {
  return {
    id: 'sub-1',
    status: 'ACTIVE',
    trafficLimit: ASSIGNED_TRAFFIC_GB,
    deviceLimit: ASSIGNED_DEVICES,
    expiresAt: FUTURE_EXPIRY,
    syncPending: false,
    remnawaveLinkRequired: false,
    ...overrides,
  }
}

describe('subscription quick edits after a successful save', () => {
  beforeAll(async () => {
    await loadFeatureBundle('userDetail')
    const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>
    proto['hasPointerCapture'] ??= () => false
    proto['setPointerCapture'] ??= () => {}
    proto['releasePointerCapture'] ??= () => {}
    proto['scrollIntoView'] ??= () => {}
  })

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

  /**
   * Serves whatever `state.user` currently holds, so a test can change what
   * the server reports and let `invalidateQueries` pick it up — exactly as a
   * real refetch after a write would.
   */
  function serveUser(sub: Record<string, unknown>): { current: Record<string, unknown> } {
    const state = { current: sub }
    vi.spyOn(api, 'get').mockImplementation(async () => ({ data: userWith(state.current) }) as never)
    return state
  }

  async function openQuickEdits(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('tab', { name: /^Subscriptions/ }))
    await user.click(await screen.findByRole('button', { name: 'Quick edits' }))
    const numbers = await screen.findAllByRole('spinbutton')
    return {
      traffic: numbers[0] as HTMLInputElement,
      devices: numbers[1] as HTMLInputElement,
      save: screen.getByRole('button', { name: 'Save' }),
    }
  }

  /** The read-only "Traffic:" row, which renders `${sub.trafficLimit} GB` off the refetched user. */
  const trafficRow = (gigabytes: number): HTMLElement => screen.getByText(`${gigabytes} GB`)

  it('shows the traffic the server stored, not the number that was typed', async () => {
    // NO SERVER BEHAVIOUR IS MODELLED HERE. The divergence is client-side and
    // reachable against today's backend exactly as written — the same shape,
    // and the same cause, as the device spec below.
    //
    // The traffic box is `type="number"`, so it holds `5.7` quite happily.
    // `parseInt(trafficLimit, 10)` in `handleSave` truncates that to `5`
    // before the patch goes out; the column then holds `5`, the read-only row
    // above re-renders from the refetched user as `5 GB`, and without the
    // reconcile the input below still reads `5.7`. One field, one card, two
    // answers — which is the whole defect this file exists for.
    //
    // ── WHAT THIS SPEC USED TO SAY, AND WHY IT WAS FICTION ────────────────
    //
    // A whole-gigabyte FLOOR: `0` typed, `0` sent, `1` stored, `1` adopted.
    // That response cannot happen. `readOperatorTrafficLimitGb`
    // (`admin-user-subscriptions.controller.ts`) is
    //
    //     if (!Number.isInteger(value) || value < 1) throw new BadRequestException(…)
    //
    // so a `0` on this path is a 400 and never a stored `1` — the endpoint
    // refuses precisely because Remnawave spells unlimited traffic as `0`
    // bytes and cannot express a zero-gigabyte cap. The panel already knew:
    // the input this test types into carries `min="1"` with a comment saying
    // exactly that. The old spec therefore passed while pinning an adoption
    // that could only follow an answer the server is incapable of sending.
    const TYPED = '5.7'
    const STORED = 5

    const user = userEvent.setup()
    const served = serveUser(SUBSCRIPTION)
    const patchSpy = vi.spyOn(api, 'patch').mockImplementation(async () => {
      served.current = { ...SUBSCRIPTION, trafficLimit: STORED }
      return { data: writtenRow({ trafficLimit: STORED }) } as never
    })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    const { traffic, save } = await openQuickEdits(user)
    expect(traffic.value).toBe(String(ASSIGNED_TRAFFIC_GB))

    await user.clear(traffic)
    await user.type(traffic, TYPED)
    // The premise, measured rather than assumed: the box really is holding a
    // fraction at the moment Save is pressed.
    expect(traffic.value).toBe(TYPED)
    await user.click(save)

    // …and a whole number is what left, which is the difference to reconcile.
    await waitFor(() => expect(patchSpy).toHaveBeenCalledOnce())
    expect(patchSpy.mock.calls[0][1]).toEqual({ trafficLimit: STORED })

    // The input adopts what was actually written…
    await waitFor(() =>
      expect(
        traffic.value,
        'the input still holds the typed number while the row above shows the ' +
          'stored one — one field, one card, two answers',
      ).toBe(String(STORED)),
    )
    // …and the read-only row above it, which comes from the refetched user,
    // says the same thing.
    await waitFor(() => expect(trafficRow(STORED)).toBeInTheDocument())
    expect(screen.queryByText(`${TYPED} GB`)).toBeNull()
  })

  it('shows the device count the server stored, for a value it merely truncated', async () => {
    // NO CLAMP AND NO FIXTURE FICTION — this one is reachable against today's
    // backend exactly as written. The device box is `type="number"`, which
    // happily holds `5.7`; `parseInt(trafficLimit, 10)` truncates it to `5`
    // before the patch goes out, and the column then holds `5` while the input
    // above still reads `5.7`. One field, two readings, no server behaviour
    // being modelled.
    //
    // (Leading zeros do NOT work for this: the number input normalises `007`
    // to `7` on its own, before any of this code sees it, so a spec built on
    // them passes whether the reconcile exists or not. Measured, not assumed.)
    const TYPED = '5.7'
    const STORED = 5

    const user = userEvent.setup()
    const served = serveUser(SUBSCRIPTION)
    const patchSpy = vi.spyOn(api, 'patch').mockImplementation(async () => {
      served.current = { ...SUBSCRIPTION, deviceLimit: STORED }
      return { data: writtenRow({ deviceLimit: STORED }) } as never
    })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    const { devices, save } = await openQuickEdits(user)

    await user.clear(devices)
    await user.type(devices, TYPED)
    await user.click(save)

    await waitFor(() => expect(patchSpy).toHaveBeenCalledOnce())
    expect(patchSpy.mock.calls[0][1]).toEqual({ deviceLimit: STORED })
    await waitFor(() => expect(devices.value).toBe(String(STORED)))
  })

  it('leaves a field the save never sent alone', async () => {
    // ANTI-VACUITY for rule 1: a blanket "re-seed everything from the
    // response" would satisfy the two specs above and quietly reset a field
    // the operator is still working on. Only what was sent may be adopted.
    const user = userEvent.setup()
    const served = serveUser(SUBSCRIPTION)
    vi.spyOn(api, 'patch').mockImplementation(async () => {
      served.current = { ...SUBSCRIPTION, deviceLimit: 5 }
      return { data: writtenRow({ deviceLimit: 5 }) } as never
    })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    const { traffic, devices, save } = await openQuickEdits(user)

    await user.clear(devices)
    await user.type(devices, '5')
    // Typed but NOT saved: `parseInt('', 10)` is NaN, so a blanked traffic
    // field contributes nothing to the patch and is not this save's business.
    await user.clear(traffic)
    await user.click(save)

    await waitFor(() => expect(devices.value).toBe('5'))
    expect(
      traffic.value,
      'a field the patch never mentioned was overwritten from the response',
    ).toBe('')
  })

  it('does not eat what the operator typed while the save was in flight', async () => {
    // ANTI-VACUITY for rule 2, and the reason this is a reconcile and not a
    // remount. The response is held open, a new number is typed on top of the
    // one that was sent, and the answer must lose to the live input.
    //
    // Same reachable divergence as the first spec — `parseInt` truncating the
    // typed fraction — and for the same reason: this one used to model the
    // floor that does not exist (`0` sent, `1` stored), which
    // `readOperatorTrafficLimitGb` answers with a 400.
    const TYPED_BEFORE_SAVE = '5.7'
    const STORED_AFTER_TRUNCATION = 5
    const TYPED_WHILE_IN_FLIGHT = '512'

    const user = userEvent.setup()
    const served = serveUser(SUBSCRIPTION)
    let settlePatch: ((value: unknown) => void) | null = null
    vi.spyOn(api, 'patch').mockImplementation(
      () =>
        new Promise((resolve) => {
          settlePatch = resolve
        }) as never,
    )

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    const { traffic, save } = await openQuickEdits(user)

    await user.clear(traffic)
    await user.type(traffic, TYPED_BEFORE_SAVE)
    await user.click(save)
    await waitFor(() => expect(settlePatch).not.toBeNull())

    // The operator keeps working while the request is open.
    await user.clear(traffic)
    await user.type(traffic, TYPED_WHILE_IN_FLIGHT)

    served.current = { ...SUBSCRIPTION, trafficLimit: STORED_AFTER_TRUNCATION }
    await act(async () => {
      settlePatch?.({ data: writtenRow({ trafficLimit: STORED_AFTER_TRUNCATION }) })
      await Promise.resolve()
    })

    // The read-only row moves — that is the server's answer, and it is true.
    await waitFor(() => expect(trafficRow(STORED_AFTER_TRUNCATION)).toBeInTheDocument())
    // The input does not — the operator is holding it.
    expect(
      traffic.value,
      'the save response overwrote a number typed after the button was pressed',
    ).toBe(TYPED_WHILE_IN_FLIGHT)
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  /**
   * ── THE TOGGLE HALF OF THE RECONCILE NEEDS TWO SPECS, NOT ONE ────────────
   *
   * "Unlimited" is a `useState` of its own rather than a value in the traffic
   * box, so `adoptSavedValues` has to move the SWITCH as well as the number —
   * and it has one half per spelling this column uses for the field:
   *
   *     stored `null`   → switch ON,  box blanked and disabled, `∞` offered
   *     stored a number → switch OFF, box holding that number
   *
   * Both halves are functional updaters guarded by `current ===
   * typed.unlimited`, so each one CHANGES the switch only when the answer's
   * spelling differs from the send's. A spec that turns the switch on itself,
   * sends `null` and gets `null` back therefore asserts nothing: the branch
   * sets `true` over the `true` the spec's own click produced, and the spec
   * stays green with the whole branch deleted. That is what the single spec
   * these two replace did, and the `∞` it checked afterwards did not rescue
   * it — that row renders from the refetched user, not from the reconcile.
   *
   * ── THESE PIN A CONTRACT, NOT A SCENARIO TODAY'S SAVE CAN PRODUCE ────────
   *
   * Worth stating plainly, because it is the first thing a reader will want to
   * check. `PATCH /admin/users/subscriptions/:id` answers with the row it just
   * wrote, and it writes exactly what `readOperatorTrafficLimitGb` validated —
   * so from THIS card a number goes out and a number comes back, `null` goes
   * out and `null` comes back, and neither half below fires in production as
   * things stand. The kind-divergence they model is not invented, though: the
   * same handler overrides the traffic it was sent whenever a `planId` rides
   * along — `if (body.trafficLimit !== undefined && assignedPlanId === null)`,
   * after which `plan.trafficLimit` (an `Int?`, nullable) is what lands in the
   * column — and `SubscriptionWriteResult.trafficLimit` is declared
   * `number | null` for that reason.
   *
   * So what is pinned is the rule the card claims: THE SERVER'S ANSWER WINS,
   * whichever spelling it arrives in. Should this patch ever carry a `planId`,
   * or the endpoint start normalising, the card cannot go back to showing one
   * field two ways without one of these two going red.
   *
   * Neither spec re-seeds the switch from props, and neither could: the card
   * is keyed on `sub.id`, so its `useState` initialisers run once per card
   * lifetime — a fact `does not eat what the operator typed while the save was
   * in flight` above already pins, since re-keying the card would remount it
   * and throw away the number that spec holds.
   */
  it('turns the unlimited switch on when the answer has no cap, over the number that was sent', async () => {
    const TYPED_CAP = '50'

    const user = userEvent.setup()
    const served = serveUser(SUBSCRIPTION)
    const patchSpy = vi.spyOn(api, 'patch').mockImplementation(async () => {
      served.current = { ...SUBSCRIPTION, trafficLimit: null }
      return { data: writtenRow({ trafficLimit: null }) } as never
    })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    const { traffic, save } = await openQuickEdits(user)
    const unlimited = screen.getByRole('switch', {
      name: i18n.t('userDetailPanel.subscriptions.trafficUnlimitedLabel'),
    })
    // THIS SPEC NEVER TOUCHES THE SWITCH. It is off because the subscription
    // has a cap, and the reconcile is the only thing that can turn it on.
    expect(unlimited).toHaveAttribute('aria-checked', 'false')

    await user.clear(traffic)
    await user.type(traffic, TYPED_CAP)
    await user.click(save)

    await waitFor(() => expect(patchSpy).toHaveBeenCalledOnce())
    // A NUMBER went out. The answer is about to disagree with it.
    expect(patchSpy.mock.calls[0][1]).toEqual({ trafficLimit: Number(TYPED_CAP) })

    await waitFor(() =>
      expect(
        unlimited,
        'the answer said this subscription has no cap and the switch still reads capped',
      ).toHaveAttribute('aria-checked', 'true'),
    )
    // …and the box says the same thing, in the only way it can: blank,
    // disabled, offering `∞` — not still holding the cap that was overruled.
    expect(traffic.value).toBe('')
    expect(traffic).toBeDisabled()
    expect(traffic.placeholder).toBe('∞')
    // One card, one answer: the read-only row above agrees, and neither the
    // typed cap nor the old one is on screen anywhere.
    await waitFor(() => expect(screen.getAllByText('∞').length).toBeGreaterThan(0))
    expect(screen.queryByText(`${TYPED_CAP} GB`)).toBeNull()
    expect(screen.queryByText(`${ASSIGNED_TRAFFIC_GB} GB`)).toBeNull()
  })

  it('turns the unlimited switch off when the answer names a cap, over the unlimited that was sent', async () => {
    // The other half, and the one nothing reached at all: the only other spec
    // that gets into this branch types a number with the switch already off,
    // where `setUnlimitedTraffic(false)` over `false` is as much a no-op as
    // the case above was.
    const STORED_CAP = 200

    const user = userEvent.setup()
    const served = serveUser(SUBSCRIPTION)
    const patchSpy = vi.spyOn(api, 'patch').mockImplementation(async () => {
      served.current = { ...SUBSCRIPTION, trafficLimit: STORED_CAP }
      return { data: writtenRow({ trafficLimit: STORED_CAP }) } as never
    })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    const { traffic, save } = await openQuickEdits(user)
    const unlimited = screen.getByRole('switch', {
      name: i18n.t('userDetailPanel.subscriptions.trafficUnlimitedLabel'),
    })

    // The operator asks for no cap at all…
    await user.click(unlimited)
    expect(unlimited).toHaveAttribute('aria-checked', 'true')
    await user.click(save)

    await waitFor(() => expect(patchSpy).toHaveBeenCalledOnce())
    // `null` went out — the spelling this column uses for unlimited.
    expect(patchSpy.mock.calls[0][1]).toEqual({ trafficLimit: null })

    // …and a cap came back, so the switch the operator just turned ON has to
    // go back off. Nothing else in this card can move it.
    await waitFor(() =>
      expect(
        unlimited,
        'the answer named a cap and the switch still reads unlimited',
      ).toHaveAttribute('aria-checked', 'false'),
    )
    expect(traffic).toBeEnabled()
    expect(traffic.value).toBe(String(STORED_CAP))
    // One card, one answer: the read-only row above says the same number.
    await waitFor(() => expect(trafficRow(STORED_CAP)).toBeInTheDocument())
  })
})
