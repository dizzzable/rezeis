/**
 * The Users-page "Notify" dialog, driven as an operator drives it.
 *
 * Two behaviours are under test and both replace a control that reported
 * success on a no-op:
 *
 *  1. **The channel choice reaches the server.** The dialog previously posted
 *     `{ message }` and nothing else — there was no channel parameter and no
 *     branch behind it — so "send this to Telegram only" was not expressible.
 *     These assert the REQUEST THAT ACTUALLY GOES OUT, not that a checkbox
 *     rendered.
 *  2. **The outcome rendered back is the one the server reported.** The
 *     previous version called `toast.success` in `onSuccess`, which fires on
 *     any 2xx — and the route returned a literal `{ sent: true }` before
 *     delivery was even attempted. A relay outage and a delivered message were
 *     the same green toast.
 *
 * A channel the user cannot receive on is asserted disabled WITH its reason:
 * offering it is a button that lies, and the operator only discovers the lie
 * when the message never arrives.
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
  subscriptions: [],
  transactions: [],
  referralsGiven: [],
  partner: null,
  webAccount: null,
}

interface ChannelAvailability {
  channel: 'telegram' | 'webpush'
  available: boolean
  reason: string | null
}

const BOTH_AVAILABLE: ChannelAvailability[] = [
  { channel: 'telegram', available: true, reason: null },
  { channel: 'webpush', available: true, reason: null },
]

function mockGet(channels: ChannelAvailability[]) {
  return vi.spyOn(api, 'get').mockImplementation((async (url: string) => {
    if (url.endsWith('/notify/channels')) return { data: { channels } }
    return { data: { ...BASE_USER } }
  }) as never)
}

async function openNotifyDialog() {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Notify' }))
  // The dialog only knows what to offer once the availability answer lands.
  await screen.findByText('Deliver via')
  return user
}

describe('Notify dialog channel selection', () => {
  beforeAll(async () => {
    await loadFeatureBundle('userDetail')
  })

  beforeEach(() => {
    vi.restoreAllMocks()
    toastMock.success.mockClear()
    toastMock.error.mockClear()
    usePermissionStore.setState({ loaded: true, role: 'DEV' })
  })

  it('posts only the channels the operator left selected', async () => {
    mockGet(BOTH_AVAILABLE)
    const postSpy = vi.spyOn(api, 'post').mockResolvedValue({
      data: {
        sent: true,
        outcomes: [
          { channel: 'telegram', status: 'delivered', reason: null, delivered: null, attempted: null },
          { channel: 'webpush', status: 'notSelected', reason: null, delivered: null, attempted: null },
        ],
      },
    } as never)

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    const user = await openNotifyDialog()

    await user.type(screen.getByPlaceholderText('Message text (HTML supported)…'), 'Hello there')
    // Both start checked because both are available; drop browser push.
    await user.click(screen.getByLabelText('Browser push'))
    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(postSpy).toHaveBeenCalled())
    const [url, body] = postSpy.mock.calls[0] as [string, { message: string; channels: string[] }]
    expect(url).toBe('/admin/users/12345/notify')
    expect(body.message).toBe('Hello there')
    // The whole point: the selection is on the wire. Asserting only that the
    // checkbox unchecked would pass against a dialog that posts `{ message }`.
    expect(body.channels).toEqual(['telegram'])
  })

  it('defaults the selection to every channel the user can actually receive on', async () => {
    mockGet(BOTH_AVAILABLE)
    const postSpy = vi.spyOn(api, 'post').mockResolvedValue({
      data: {
        sent: true,
        outcomes: [
          { channel: 'telegram', status: 'delivered', reason: null, delivered: null, attempted: null },
          { channel: 'webpush', status: 'delivered', reason: null, delivered: 1, attempted: 1 },
        ],
      },
    } as never)

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    const user = await openNotifyDialog()

    await user.type(screen.getByPlaceholderText('Message text (HTML supported)…'), 'Everywhere')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(postSpy).toHaveBeenCalled())
    const [, body] = postSpy.mock.calls[0] as [string, { channels: string[] }]
    expect([...body.channels].sort()).toEqual(['telegram', 'webpush'])
    expect(toastMock.success).toHaveBeenCalledWith('Notification sent')
  })

  it('disables a channel the user cannot receive on and shows the reason', async () => {
    mockGet([
      { channel: 'telegram', available: false, reason: 'noTelegramId' },
      { channel: 'webpush', available: false, reason: 'noSubscription' },
    ])
    const postSpy = vi.spyOn(api, 'post').mockResolvedValue({
      data: { sent: true, outcomes: [] },
    } as never)

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    const user = await openNotifyDialog()

    expect(screen.getByLabelText('Telegram')).toBeDisabled()
    expect(screen.getByLabelText('Browser push')).toBeDisabled()
    expect(screen.getByText('No Telegram account linked')).toBeInTheDocument()
    expect(screen.getByText('User has no browser registered for push')).toBeInTheDocument()

    await user.type(screen.getByPlaceholderText('Message text (HTML supported)…'), 'Nowhere')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(postSpy).toHaveBeenCalled())
    // Nothing is selectable, so nothing is requested — the message is recorded
    // in the feed and the operator is not told it was delivered anywhere.
    const [, body] = postSpy.mock.calls[0] as [string, { channels: string[] }]
    expect(body.channels).toEqual([])
  })

  it('reports a failed channel as a failure instead of a green toast', async () => {
    mockGet(BOTH_AVAILABLE)
    vi.spyOn(api, 'post').mockResolvedValue({
      data: {
        sent: false,
        outcomes: [
          {
            channel: 'telegram',
            status: 'failed',
            reason: 'relayUnavailable',
            delivered: null,
            attempted: null,
          },
          { channel: 'webpush', status: 'notSelected', reason: null, delivered: null, attempted: null },
        ],
      },
    } as never)

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    const user = await openNotifyDialog()

    await user.type(screen.getByPlaceholderText('Message text (HTML supported)…'), 'Undelivered')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    // THE assertion. This response is a 2xx, and the shipped dialog toasted
    // `success` on it because `onSuccess` fires on any 2xx.
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        'Saved to the feed, but some channels did not deliver',
      ),
    )
    expect(toastMock.success).not.toHaveBeenCalled()
    // And the operator can read WHICH channel failed and why — the dialog stays
    // open so the breakdown survives longer than a toast.
    expect(await screen.findByText('Delivery result')).toBeInTheDocument()
    expect(
      screen.getByText('Telegram relay unavailable — message not sent'),
    ).toBeInTheDocument()
  })

  it('still reports a genuinely delivered send as sent', async () => {
    // Anti-vacuity control. Without it, a dialog that rendered EVERYTHING as a
    // failure would satisfy the test above.
    mockGet(BOTH_AVAILABLE)
    vi.spyOn(api, 'post').mockResolvedValue({
      data: {
        sent: true,
        outcomes: [
          { channel: 'telegram', status: 'delivered', reason: null, delivered: null, attempted: null },
          { channel: 'webpush', status: 'delivered', reason: null, delivered: 2, attempted: 2 },
        ],
      },
    } as never)

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    const user = await openNotifyDialog()

    await user.type(screen.getByPlaceholderText('Message text (HTML supported)…'), 'Delivered')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Notification sent'))
    expect(toastMock.error).not.toHaveBeenCalled()
  })
})
