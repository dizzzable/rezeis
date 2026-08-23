/**
 * "NO CHANGE" AND "UNLIMITED" MUST NOT BE THE SAME GESTURE.
 *
 * The backend accepts `trafficLimit: null` as unlimited and refuses `0`
 * (Remnawave spells unlimited traffic as `0` bytes, so it cannot express a
 * zero-gigabyte cap at all). The subscription quick-edit form had no way to
 * SEND that `null`: `handleSave` only carries a field the operator moved, and
 * an empty traffic box is `parseInt('') === NaN`, which fails `Number.isFinite`
 * and contributes nothing. Blanking the field looked like it should remove the
 * cap and did nothing at all — unlimited was unreachable from this screen.
 *
 * The affordance is a TOGGLE, not a sentinel value typed into the number box,
 * and the choice is the point of this file. "I left the traffic limit alone"
 * and "I removed this customer's traffic cap" are opposite decisions, and an
 * empty text field renders them identically. Conflating them is how an operator
 * wipes a limit by accident, so the two states are asserted to be visibly and
 * behaviourally distinct: a switch that reads its state back, a number input
 * that disables itself, and two different request bodies.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import { usePermissionStore } from '@/features/rbac'

vi.mock('@/features/plans/plans-api', () => ({ usePlans: () => ({ data: [] }) }))

const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: toastMock }))

import UserDetailPanel from './user-detail-panel'

const CAPPED_SUBSCRIPTION = {
  id: 'sub-1',
  status: 'ACTIVE',
  isTrial: false,
  trafficLimit: 100,
  deviceLimit: 3,
  expireAt: '2026-12-01T10:00:00.000Z',
  remnawaveId: null,
  configUrl: null,
  plan: { id: 'plan-1', name: 'Base', type: 'BOTH' },
}

const UNLIMITED_SUBSCRIPTION = { ...CAPPED_SUBSCRIPTION, trafficLimit: null }

function buildUser(subscription: Record<string, unknown>) {
  return {
    id: 'user-1',
    telegramId: '12345',
    username: 'alice',
    name: 'Alice',
    email: 'alice@example.com',
    language: 'en',
    role: 'USER',
    isBlocked: false,
    isPartner: false,
    points: 0,
    personalDiscount: 0,
    purchaseDiscount: 0,
    maxSubscriptions: 1,
    createdAt: '2026-06-04T10:00:00.000Z',
    updatedAt: '2026-06-04T10:00:00.000Z',
    subscriptions: [subscription],
    transactions: [],
    referralsGiven: [],
    partner: null,
    webAccount: null,
  }
}

describe('the subscription quick-edit affordance for unlimited traffic', () => {
  beforeAll(async () => {
    await loadFeatureBundle('userDetail')
    // Radix triggers need these; jsdom ships none of them.
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
  })

  /** Reaches the subscription card's "Quick edits" traffic controls. */
  async function openQuickEdits(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('tab', { name: /^Subscriptions/ }))
    await user.click(await screen.findByRole('button', { name: 'Quick edits' }))
    const numbers = await screen.findAllByRole('spinbutton')
    return {
      traffic: numbers[0] as HTMLInputElement,
      unlimited: screen.getByRole('switch', { name: 'Unlimited traffic' }),
    }
  }

  it('offers a control that reads back which state the card is in', async () => {
    // THE VISIBLE DIFFERENCE, asserted before any save. Without a control that
    // carries its own state, every behavioural assertion below could be met by
    // a hidden default and the operator would still be unable to tell what
    // pressing Save is about to do.
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: buildUser(CAPPED_SUBSCRIPTION) })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    const { traffic, unlimited } = await openQuickEdits(user)

    // A capped subscription: the toggle is off and the number is editable.
    expect(unlimited).toHaveAttribute('aria-checked', 'false')
    expect(traffic).toBeEnabled()
    expect(traffic.value).toBe('100')

    await user.click(unlimited)

    // Unlimited: the toggle reads back on, and the number box stops pretending
    // it still applies. An operator who glances at the card can tell.
    expect(unlimited).toHaveAttribute('aria-checked', 'true')
    expect(
      traffic,
      'the traffic input stayed live under an "unlimited" toggle, so the card ' +
        'shows two limits at once and neither is obviously the real one',
    ).toBeDisabled()
    expect(traffic.value).toBe('')
  })

  it('starts on for a subscription that is already unlimited', async () => {
    // The control has to REPORT, not just command. A toggle that always
    // rendered off would make an unlimited subscription look capped.
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: buildUser(UNLIMITED_SUBSCRIPTION) })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    const { unlimited } = await openQuickEdits(user)

    expect(unlimited).toHaveAttribute('aria-checked', 'true')
  })

  it('sends trafficLimit: null when the operator asks for unlimited', async () => {
    // THE CAPABILITY THAT DID NOT EXIST. `null` is the backend's spelling of
    // unlimited; `0` is refused with a 400 and an empty field means "no change".
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: buildUser(CAPPED_SUBSCRIPTION) })
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    const { unlimited } = await openQuickEdits(user)

    await user.click(unlimited)
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patchSpy).toHaveBeenCalledOnce())
    expect(patchSpy).toHaveBeenCalledWith('/admin/users/subscriptions/sub-1', {
      trafficLimit: null,
    })
  })

  it('does NOT send anything when the field is merely cleared', async () => {
    // THE OTHER HALF OF THE SAME ASSERTION, and the one that makes it mean
    // something. If clearing the box ALSO sent `trafficLimit: null`, the
    // affordance above would be decoration: the two states would still be one
    // gesture, and an operator tidying a field would silently uncap a customer.
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: buildUser(CAPPED_SUBSCRIPTION) })
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    const { traffic, unlimited } = await openQuickEdits(user)

    await user.clear(traffic)
    expect(traffic.value).toBe('')
    // Still visibly "capped" — clearing text is not a decision about the cap.
    expect(unlimited).toHaveAttribute('aria-checked', 'false')

    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(
      patchSpy,
      'clearing the traffic field sent a patch — "no change" and "unlimited" ' +
        'are the same gesture again',
    ).not.toHaveBeenCalled()
    expect(toastMock.info).toHaveBeenCalledWith('No changes to save')
  })

  it('says nothing changed when an already-unlimited card is saved untouched', async () => {
    // The toggle being ON is not by itself an edit. Re-saving an unlimited
    // subscription must not manufacture a write.
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: buildUser(UNLIMITED_SUBSCRIPTION) })
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    const { unlimited } = await openQuickEdits(user)

    // Toggle off and back on: dirty by gesture, identical by value.
    await user.click(unlimited)
    await user.click(unlimited)
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(patchSpy).not.toHaveBeenCalled()
    expect(toastMock.info).toHaveBeenCalledWith('No changes to save')
  })

  it('asks for a number when unlimited is switched off and no cap is named', async () => {
    // The one incoherent combination. Falling through to "No changes to save"
    // would be a lie — the operator did change something, it just cannot be
    // sent — and it is exactly the confusion this whole control exists to end.
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: buildUser(UNLIMITED_SUBSCRIPTION) })
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    const { unlimited } = await openQuickEdits(user)

    await user.click(unlimited)
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(patchSpy).not.toHaveBeenCalled()
    expect(toastMock.info).toHaveBeenCalledWith(
      'Enter a traffic limit in GB, or turn "Unlimited traffic" back on',
    )
    expect(toastMock.info).not.toHaveBeenCalledWith('No changes to save')
  })

  it('sends the typed cap when unlimited is switched off and a number is given', async () => {
    // Unlimited has to be reversible, or the toggle is a one-way door.
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: buildUser(UNLIMITED_SUBSCRIPTION) })
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    const { traffic, unlimited } = await openQuickEdits(user)

    await user.click(unlimited)
    await user.type(traffic, '250')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patchSpy).toHaveBeenCalledOnce())
    expect(patchSpy).toHaveBeenCalledWith('/admin/users/subscriptions/sub-1', {
      trafficLimit: 250,
    })
  })

  it('leaves the device limit alone, where 0 is unlimited and needs no toggle', async () => {
    // THE ANTI-HARMONISATION GUARD. `deviceLimit <= 0` is the product's
    // canonical unlimited and matches the panel's own `hwidDeviceLimit: 0`, so
    // the device field can say "unlimited" by typing `0` and must NOT grow a
    // toggle of its own. Traffic has no such digit — that is the whole reason
    // this control exists — and giving both fields the same treatment would
    // either refuse a legitimate `0` or invent a second way to say the same
    // thing.
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: buildUser(CAPPED_SUBSCRIPTION) })
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    await openQuickEdits(user)

    expect(screen.getAllByRole('switch', { name: 'Unlimited traffic' })).toHaveLength(1)

    const devices = (await screen.findAllByRole('spinbutton'))[1] as HTMLInputElement
    await user.clear(devices)
    await user.type(devices, '0')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patchSpy).toHaveBeenCalledOnce())
    expect(patchSpy).toHaveBeenCalledWith('/admin/users/subscriptions/sub-1', {
      deviceLimit: 0,
    })
  })
})
