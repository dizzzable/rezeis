import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import { usePermissionStore } from '@/features/rbac'
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

describe('UserDetailPanel accessibility', () => {
  beforeAll(async () => {
    await loadFeatureBundle('userDetail')
  })

  beforeEach(() => {
    vi.restoreAllMocks()
    usePermissionStore.setState({ loaded: true, role: 'DEV' })
  })

  it('names the icon-only delete user trigger', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: { ...BASE_USER } })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)

    expect(await screen.findByRole('button', { name: 'Delete user?' })).toBeInTheDocument()
  })

  it('gates the user delete behind a typed DELETE confirmation', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: { ...BASE_USER } })
    const deleteSpy = vi.spyOn(api, 'delete').mockResolvedValue({ data: {} })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)

    await user.click(await screen.findByRole('button', { name: 'Delete user?' }))

    expect(
      screen.getByText(
        'This action is irreversible. Accounts with payments or other protected history cannot be deleted.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        "Financial and reward history is never deleted—block that user instead. A clean local account is deleted before best-effort Remnawave cleanup.",
      ),
    ).toBeInTheDocument()

    // The destructive action is disabled until the confirmation matches.
    const confirmAction = await screen.findByRole('button', { name: 'Delete forever' })
    expect(confirmAction).toBeDisabled()

    await user.type(screen.getByPlaceholderText('DELETE'), 'DELETE')
    expect(confirmAction).toBeEnabled()
    expect(deleteSpy).not.toHaveBeenCalled()

    await user.click(confirmAction)
    expect(deleteSpy).toHaveBeenCalledWith('/admin/users/12345')
  })

  it('names compact profile action controls', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        ...BASE_USER,
        points: 7,
        personalDiscount: 5,
        purchaseDiscount: 10,
        maxSubscriptions: 2,
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
