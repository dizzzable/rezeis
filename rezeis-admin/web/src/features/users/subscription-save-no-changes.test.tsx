/**
 * The subscription quick-edit Save must never be silent.
 *
 * `handleSave` builds a patch field by field and used to wrap the whole action
 * in `if (Object.keys(data).length > 0)`. When the edits amounted to nothing,
 * the operator got no request, no toast and no state change — and because
 * `setDirty(false)` was trapped INSIDE that guard, the button stayed enabled
 * and the card went on advertising unsaved work that would never be sent.
 *
 * Unlike the branding page's equivalent guard this one is reachable straight
 * from the UI, and cheaply: `setDirty(true)` fires on every keystroke in the
 * traffic/device inputs, while the patch only accepts a value that both parses
 * (`Number.isFinite(parseInt(...))`) and differs from what is stored. Typing a
 * digit and erasing it satisfies the first and fails the second.
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

const SUBSCRIPTION = {
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

const BASE_USER = {
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
  subscriptions: [SUBSCRIPTION],
  transactions: [],
  referralsGiven: [],
  partner: null,
  webAccount: null,
}

describe('subscription quick-edit save with an empty patch', () => {
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

  /** Reaches the subscription card's "Quick edits" traffic input. */
  async function openQuickEdits(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('tab', { name: /^Subscriptions/ }))
    await user.click(await screen.findByRole('button', { name: 'Quick edits' }))
    const numbers = await screen.findAllByRole('spinbutton')
    return { traffic: numbers[0] as HTMLInputElement }
  }

  it('says there is nothing to save and releases the dirty state', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: { ...BASE_USER } })
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    const { traffic } = await openQuickEdits(user)

    // Type a digit and erase it: dirty by keystroke, identical by value.
    await user.type(traffic, '5')
    await user.keyboard('{Backspace}')
    expect(traffic.value).toBe('100')

    const save = screen.getByRole('button', { name: 'Save' })
    expect(
      save,
      'Save is disabled, so the click below asserts nothing — this test would ' +
        'pass no matter what the empty-patch branch does',
    ).toBeEnabled()

    await user.click(save)

    expect(
      toastMock.info,
      'pressing Save produced no message at all — from the operator side that ' +
        'is indistinguishable from a save that failed',
    ).toHaveBeenCalledWith('No changes to save')
    expect(
      patchSpy,
      'an empty patch must not reach the API',
    ).not.toHaveBeenCalled()
    // The stuck flag was the second half of the defect: the one visible signal
    // kept claiming the edit was still pending.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Save' }),
        'Save stayed enabled after a no-op, so the card still reads "unsaved"',
      ).toBeDisabled(),
    )
  })

  it('still sends the update exactly once when a limit really changed', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: { ...BASE_USER } })
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    const { traffic } = await openQuickEdits(user)

    await user.clear(traffic)
    await user.type(traffic, '250')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patchSpy).toHaveBeenCalledOnce())
    expect(patchSpy).toHaveBeenCalledWith('/admin/users/subscriptions/sub-1', {
      trafficLimit: 250,
    })
    expect(toastMock.info).not.toHaveBeenCalledWith('No changes to save')
  })
})
