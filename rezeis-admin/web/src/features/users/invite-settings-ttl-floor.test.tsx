import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import { usePermissionStore } from '@/features/rbac'
import UserDetailPanel from './user-detail-panel'

/**
 * The per-user link TTL is floored at 60s server-side
 * (`UpdateUserInviteSettingsDto` refuses less; `ReferralInviteLimitsService`
 * clamps whatever is already stored). This box is PREFILLED from what is
 * stored, so an operator opening a legacy sub-minute config and pressing Save
 * met a bare 400 that named no number.
 *
 * The server stays the authority - this only checks that the panel says the
 * floor out loud first.
 */

const MIN_HINT = 'Minimum 60 seconds. Shorter links expire before they can be shared.'

function userWithTtlOverride(linkTtlSeconds: number) {
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
    subscriptions: [],
    transactions: [],
    referralsGiven: [],
    partner: null,
    webAccount: null,
    effectiveInviteSettings: {
      linkTtlEnabled: true,
      linkTtlSeconds,
      slotsEnabled: false,
      initialSlots: null,
      refillThresholdQualified: null,
      refillAmount: null,
    },
    userInviteSettingsOverride: {
      useGlobalSettings: false,
      linkTtlEnabled: true,
      linkTtlSeconds,
    },
  }
}

async function openInvitesTab(linkTtlSeconds: number): Promise<void> {
  vi.spyOn(api, 'get').mockResolvedValue({ data: userWithTtlOverride(linkTtlSeconds) })
  renderWithProviders(<UserDetailPanel telegramId="12345" />)
  const tab = await screen.findByRole('tab', { name: 'Invites' })
  await userEvent.setup().click(tab)
}

describe('Invite settings link TTL floor', () => {
  beforeAll(async () => {
    await loadFeatureBundle('userDetail')
  })

  beforeEach(() => {
    vi.restoreAllMocks()
    usePermissionStore.setState({ loaded: true, role: 'DEV' })
  })

  it('names the floor instead of leaving the operator to discover it in a 400', async () => {
    await openInvitesTab(30)

    expect(await screen.findByText(MIN_HINT)).toBeInTheDocument()
  })

  it('marks a stored sub-minute TTL invalid and holds Save', async () => {
    const user = userEvent.setup()
    await openInvitesTab(30)

    const field = await screen.findByLabelText('Link TTL (seconds)')
    expect(field).toHaveAttribute('aria-invalid', 'true')

    // Save only renders once the form is dirty.
    await user.clear(field)
    await user.type(field, '30')

    expect(await screen.findByRole('button', { name: /Save/ })).toBeDisabled()
  })

  /**
   * ANTI-VACUITY CONTROL. A field that refuses everything would be its own
   * outage: the floor itself must be accepted, and Save must be reachable.
   */
  it('accepts the floor exactly and releases Save', async () => {
    const user = userEvent.setup()
    await openInvitesTab(30)

    const field = await screen.findByLabelText('Link TTL (seconds)')
    await user.clear(field)
    await user.type(field, '60')

    expect(field).toHaveAttribute('aria-invalid', 'false')
    expect(await screen.findByRole('button', { name: /Save/ })).toBeEnabled()
  })

  it('leaves an ordinary stored TTL alone', async () => {
    await openInvitesTab(86400)

    const field = await screen.findByLabelText('Link TTL (seconds)')
    expect(field).toHaveAttribute('aria-invalid', 'false')
  })
})
