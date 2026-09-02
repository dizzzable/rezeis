import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { PointsLedgerSheet } from '@/features/users/points-ledger-sheet'
import { loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

const NOW = new Date()

function page(items: unknown[], nextCursor: string | null) {
  return { data: { items, nextCursor } }
}

const CASHBACK_ROW = {
  id: 'ledger-3',
  delta: 13,
  balanceAfter: 18,
  source: 'CASHBACK',
  referenceKey: 'tx-1',
  details: {
    paidAmount: '180',
    paidCurrency: 'XTR',
    lines: [{ kind: 'PLAN', id: 'plan-1', name: 'Premium', durationDays: 90, points: 13 }],
  },
  createdAt: NOW.toISOString(),
}

const MANUAL_ROW = {
  id: 'ledger-2',
  delta: -4,
  balanceAfter: 5,
  source: 'MANUAL_ADJUSTMENT',
  referenceKey: null,
  details: { adminId: 'admin-1', reason: 'VIOLATION', note: 'shared account' },
  createdAt: new Date(NOW.getTime() - 60_000).toISOString(),
}

const OPENING_ROW = {
  id: 'ledger-1',
  delta: 9,
  balanceAfter: 9,
  source: 'OPENING_BALANCE',
  referenceKey: 'user-1',
  details: null,
  createdAt: new Date(NOW.getTime() - 120_000).toISOString(),
}

describe('PointsLedgerSheet', () => {
  beforeAll(async () => {
    await loadFeatureBundle('userDetail')
  })

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('lists the movements newest first with what each one was for, and pages with the cursor', async () => {
    const getSpy = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce(page([CASHBACK_ROW, MANUAL_ROW], 'ledger-2'))
      .mockResolvedValueOnce(page([OPENING_ROW], null))
    const user = userEvent.setup()

    renderWithProviders(<PointsLedgerSheet telegramId="12345" balance={18} open onOpenChange={() => undefined} />)

    expect(await screen.findByText('Purchase cashback')).toBeInTheDocument()
    expect(screen.getByText('Current balance: 18')).toBeInTheDocument()
    expect(screen.getByText('+13')).toBeInTheDocument()
    expect(screen.getByText('Premium · 90 d. · paid 180 XTR')).toBeInTheDocument()
    expect(screen.getByText('Operator adjustment')).toBeInTheDocument()
    expect(screen.getByText('-4')).toBeInTheDocument()
    expect(screen.getByText('Rules violation · note: shared account')).toBeInTheDocument()
    expect(getSpy).toHaveBeenCalledWith('/admin/users/12345/points/ledger', {
      params: { cursor: undefined, limit: 25 },
    })

    await user.click(screen.getByRole('button', { name: 'Show more' }))

    expect(await screen.findByText('Opening balance')).toBeInTheDocument()
    expect(screen.getByText('balance carried over at the update')).toBeInTheDocument()
    expect(getSpy).toHaveBeenLastCalledWith('/admin/users/12345/points/ledger', {
      params: { cursor: 'ledger-2', limit: 25 },
    })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument())
  })

  it('says so when there is nothing yet, and offers a retry when the load fails', async () => {
    vi.spyOn(api, 'get').mockResolvedValueOnce(page([], null))
    const { unmount } = renderWithProviders(
      <PointsLedgerSheet telegramId="12345" balance={0} open onOpenChange={() => undefined} />,
    )
    expect(await screen.findByText('No movements yet')).toBeInTheDocument()
    unmount()

    vi.spyOn(api, 'get').mockRejectedValueOnce(new Error('boom'))
    renderWithProviders(<PointsLedgerSheet telegramId="12345" balance={0} open onOpenChange={() => undefined} />)
    expect(await screen.findByText('Could not load the history')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('does not fetch while closed', () => {
    const getSpy = vi.spyOn(api, 'get')

    renderWithProviders(<PointsLedgerSheet telegramId="12345" balance={0} open={false} onOpenChange={() => undefined} />)

    expect(getSpy).not.toHaveBeenCalled()
  })
})
