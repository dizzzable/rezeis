import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation } from 'react-router'

import { usePermissionStore, type RbacAction } from '@/features/rbac'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import SubscriptionsPage from './subscriptions-page'

/**
 * A subscription row leads to its payments.
 *
 * Nothing did: the subscription list linked only to the user, and the Payments
 * page could not be filtered by subscription at all. The button opens
 * `/payments?subscriptionId=…`, which the list endpoint now answers with the
 * payments that name the subscription AND the combined renewals that carry it.
 */

const SUBSCRIPTION_ID = 'cmfk2x9pq0002abcd1234efgh'
const USER_ID = 'cmfk2x9pq0000abcd1234efgh'

function mockApi(): void {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path.startsWith('/admin/subscriptions?')) {
      return {
        data: {
          items: [
            {
              id: SUBSCRIPTION_ID,
              user: { id: USER_ID, name: 'Alice' },
              userTelegramId: '777',
              status: 'ACTIVE',
              isTrial: false,
              plan: { name: 'Pro' },
              trafficLimit: null,
              deviceLimit: null,
              expireAt: null,
            },
          ],
          total: 1,
        },
      }
    }
    if (path === '/admin/subscriptions/stats') {
      return { data: { total: 1, byStatus: { ACTIVE: 1 }, trialCount: 0, expiringIn7d: 0 } }
    }
    return { data: {} }
  })
}

function grant(tokens: ReadonlyArray<{ resource: string; action: RbacAction }>): void {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(tokens.map((p) => `${p.resource}:${p.action}`)),
    mustChangePassword: false,
    role: 'ADMIN',
    rbacRoleId: 'role-1',
    error: null,
  })
}

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>
}

beforeEach(() => {
  usePermissionStore.getState().reset()
  vi.restoreAllMocks()
})

describe('SubscriptionsPage → payments', () => {
  it("opens the subscription's payments, and not the user the row itself opens", async () => {
    mockApi()
    grant([
      { resource: 'subscriptions', action: 'view' },
      { resource: 'payments', action: 'view' },
    ])
    const user = userEvent.setup()
    renderWithProviders(
      <>
        <SubscriptionsPage />
        <LocationProbe />
      </>,
      { route: '/subscriptions' },
    )

    await user.click(
      await screen.findByRole('button', { name: `Payments for subscription ${SUBSCRIPTION_ID}` }),
    )

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        `/payments?subscriptionId=${SUBSCRIPTION_ID}`,
      ),
    )
  })

  it('offers no such button to an operator who cannot open the Payments page', async () => {
    mockApi()
    grant([{ resource: 'subscriptions', action: 'view' }])
    renderWithProviders(<SubscriptionsPage />, { route: '/subscriptions' })

    // The row is there — only the payments button is not.
    expect(await screen.findByRole('button', { name: `Open user ${USER_ID}` })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: `Payments for subscription ${SUBSCRIPTION_ID}` }),
    ).not.toBeInTheDocument()
  })
})
