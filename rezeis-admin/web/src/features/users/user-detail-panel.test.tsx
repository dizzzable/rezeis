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
        'This action is irreversible. If the account is tied to payments or other protected history, the panel will say so and offer to delete it in full.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'The Remnawave profile goes too: VPN access stops. This cannot be undone.',
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

  it('names what the refusal refused on, and offers the wider delete against it', async () => {
    // THE REPORTED DEFECT. An operator creates test accounts to check their own
    // product, takes the free trial through one, and can never remove it: the
    // refusal was a red toast reading «нельзя», with no way to tell a free
    // trial from real money and nothing to do about either.
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: { ...BASE_USER } })
    const deleteSpy = vi.spyOn(api, 'delete').mockRejectedValueOnce({
      response: {
        status: 409,
        data: {
          code: 'USER_DELETE_PROTECTED_HISTORY',
          message: 'refused',
          blockedBy: {
            transactions: 0,
            promocodeActivations: 0,
            referralPointsExchanges: 0,
            referralRewards: 0,
            partnerTransactions: 0,
            partnerWithdrawals: 0,
            trialClaims: 1,
          },
        },
      },
    })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    await user.click(await screen.findByRole('button', { name: 'Delete user?' }))
    await user.type(screen.getByPlaceholderText('DELETE'), 'DELETE')
    await user.click(await screen.findByRole('button', { name: 'Delete forever' }))

    // The dialog STAYS OPEN and says which. A counter at zero is not printed —
    // «0 payments» would bury the one line that matters.
    expect(await screen.findByText('Trial claims: 1')).toBeInTheDocument()
    expect(screen.queryByText('Payments: 0')).not.toBeInTheDocument()

    deleteSpy.mockResolvedValue({ data: { deleted: true, mode: 'full' } })
    await user.click(screen.getByRole('button', { name: 'Delete in full' }))

    expect(deleteSpy).toHaveBeenLastCalledWith('/admin/users/12345?mode=full')
  })

  it('names what the add-on model holds when that is what refused the delete', async () => {
    // An account with no payment of its own whose subscription holds a paid
    // renewal period and an open incident used to be refused with nothing
    // named at all.
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: { ...BASE_USER } })
    vi.spyOn(api, 'delete').mockRejectedValueOnce({
      response: {
        status: 409,
        data: {
          code: 'USER_DELETE_PROTECTED_HISTORY',
          message: 'refused',
          blockedBy: {
            transactions: 0,
            promocodeActivations: 0,
            referralPointsExchanges: 0,
            referralRewards: 0,
            partnerTransactions: 0,
            partnerWithdrawals: 0,
            trialClaims: 0,
            addOnPurchases: 0,
            paidTerms: 1,
            resetPeriods: 0,
            deviceReductions: 0,
            openIncidents: 2,
          },
        },
      },
    })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    await user.click(await screen.findByRole('button', { name: 'Delete user?' }))
    await user.type(screen.getByPlaceholderText('DELETE'), 'DELETE')
    await user.click(await screen.findByRole('button', { name: 'Delete forever' }))

    expect(await screen.findByText('Paid subscription periods: 1')).toBeInTheDocument()
    expect(screen.getByText('Open incidents: 2')).toBeInTheDocument()
    expect(screen.queryByText('Add-on purchases: 0')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete in full' })).toBeInTheDocument()
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
    // The adjustment carries a reason the subscriber sees and a note that
    // stays in the panel; both are controls with names of their own.
    expect(screen.getByRole('combobox', { name: 'Points adjustment reason' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Note for the points adjustment' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Points history' })).toBeInTheDocument()
  })

  it('sends the reason and the note with the adjustment, and no note key when the note is empty', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: { ...BASE_USER, points: 7 } })
    const postSpy = vi.spyOn(api, 'post').mockResolvedValue({ data: { points: 257 } })
    const user = userEvent.setup()

    renderWithProviders(<UserDetailPanel telegramId="12345" />)

    const delta = await screen.findByRole('spinbutton', { name: 'Points' })
    await user.type(delta, '250')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(postSpy).toHaveBeenCalledWith('/admin/users/12345/points', { delta: 250, reason: 'OTHER' })

    await user.type(screen.getByRole('spinbutton', { name: 'Points' }), '-5')
    await user.type(screen.getByRole('textbox', { name: 'Note for the points adjustment' }), 'shared account')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(postSpy).toHaveBeenLastCalledWith('/admin/users/12345/points', {
      delta: -5,
      reason: 'OTHER',
      note: 'shared account',
    })
  })
})
