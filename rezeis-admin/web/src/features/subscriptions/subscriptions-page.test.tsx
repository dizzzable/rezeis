import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen } from '@testing-library/react'

import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import SubscriptionsPage from './subscriptions-page'

describe('SubscriptionsPage accessibility', () => {
  beforeEach(() => {
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path.startsWith('/admin/subscriptions?')) {
        return {
          data: {
            items: [
              {
                id: 'subscription-1',
                user: { name: 'Alice' },
                userTelegramId: '12345',
                status: 'ACTIVE',
                isTrial: false,
                plan: { name: 'Premium' },
                trafficLimit: null,
                deviceLimit: null,
                expireAt: '2026-06-04T10:00:00.000Z',
              },
            ],
            total: 1,
          },
        }
      }

      if (path === '/admin/subscriptions/stats') {
        return {
          data: {
            total: 1,
            byStatus: { ACTIVE: 1 },
            trialCount: 0,
            expiringIn7d: 0,
          },
        }
      }

      return { data: {} }
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('names icon-only subscription actions', async () => {
    renderWithProviders(<SubscriptionsPage />)

    expect(await screen.findByRole('button', { name: 'Refresh subscriptions' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Open user 12345' })).toBeInTheDocument()
  })

  it('names the status filter select', async () => {
    renderWithProviders(<SubscriptionsPage />)

    expect(await screen.findByRole('combobox', { name: 'Status' })).toBeInTheDocument()
  })

  it('keeps row navigation on the named action instead of the table row', async () => {
    renderWithProviders(<SubscriptionsPage />)

    const userCell = await screen.findByText('Alice')
    expect(userCell.closest('tr')).not.toHaveClass('cursor-pointer')
    expect(screen.getByRole('button', { name: 'Open user 12345' })).toBeInTheDocument()
  })
})
