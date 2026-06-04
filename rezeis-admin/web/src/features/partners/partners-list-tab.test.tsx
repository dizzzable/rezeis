import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'

import { renderWithProviders } from '@/test/test-utils'
import PartnersListTab from './partners-list-tab'
import { partnersAdminApi, type Partner } from './partners-api'

describe('PartnersListTab accessibility', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps row navigation on the named manage action instead of the table row', async () => {
    vi.spyOn(partnersAdminApi, 'listPartners').mockResolvedValue([partnerFixture()])

    renderWithProviders(<PartnersListTab />)

    const partnerCell = await screen.findByText('Alice')
    expect(partnerCell.closest('tr')).not.toHaveClass('cursor-pointer')
    expect(screen.getByRole('button', { name: 'Manage' })).toBeInTheDocument()
  })
})

function partnerFixture(): Partner {
  return {
    id: 'partner-1',
    user: {
      id: 'user-1',
      login: 'alice',
      username: 'alice',
      name: 'Alice',
      telegramId: '12345',
      createdAt: '2026-06-04T00:00:00.000Z',
    },
    balance: 12500,
    totalEarned: 50000,
    totalWithdrawn: 10000,
    isActive: true,
    referralsCount: 3,
    useGlobalSettings: true,
    accrualStrategy: 'ON_EACH_PAYMENT',
    rewardType: 'PERCENT',
    level1Percent: '10',
    level2Percent: '5',
    level3Percent: '1',
    level1FixedAmount: null,
    level2FixedAmount: null,
    level3FixedAmount: null,
    createdAt: '2026-06-04T00:00:00.000Z',
    updatedAt: '2026-06-04T00:00:00.000Z',
  }
}
