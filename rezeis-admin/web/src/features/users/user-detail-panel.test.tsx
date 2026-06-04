import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'

import { loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import UserDetailPanel from './user-detail-panel'

describe('UserDetailPanel accessibility', () => {
  beforeAll(async () => {
    await loadFeatureBundle('userDetail')
  })

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('names the icon-only delete user trigger', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
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
      },
    })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)

    expect(await screen.findByRole('button', { name: 'Delete user?' })).toBeInTheDocument()
  })

  it('names compact profile action controls', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        id: 'user-1',
        telegramId: '12345',
        username: 'alice',
        name: 'Alice',
        email: 'alice@example.com',
        language: 'en',
        role: 'USER',
        isBlocked: false,
        isPartner: false,
        points: 7,
        personalDiscount: 5,
        purchaseDiscount: 10,
        maxSubscriptions: 2,
        createdAt: '2026-06-04T10:00:00.000Z',
        updatedAt: '2026-06-04T10:00:00.000Z',
        subscriptions: [],
        transactions: [],
        referralsGiven: [],
        partner: null,
        webAccount: null,
      },
    })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)

    expect(await screen.findByRole('combobox', { name: 'Role' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Max subscriptions' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Partner balance currency' })).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Personal discount %' })).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Purchase discount %' })).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Points' })).toBeInTheDocument()
  })
})
