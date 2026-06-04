import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import SupportTicketsPage from './support-tickets-page'

describe('SupportTicketsPage accessibility', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/support-tickets') {
        return {
          data: {
            items: [
              {
                id: 'ticket-1',
                userTelegramId: '12345',
                subject: 'Cannot connect',
                status: 'open',
                createdAt: '2026-06-04T10:00:00.000Z',
                updatedAt: '2026-06-04T10:05:00.000Z',
                user: { username: 'alice', name: 'Alice', telegramId: '12345' },
                messages: [],
              },
            ],
            total: 1,
          },
        }
      }

      if (path === '/admin/support-tickets/ticket-1') {
        return {
          data: {
            id: 'ticket-1',
            userTelegramId: '12345',
            subject: 'Cannot connect',
            status: 'open',
            createdAt: '2026-06-04T10:00:00.000Z',
            updatedAt: '2026-06-04T10:05:00.000Z',
            user: { username: 'alice', name: 'Alice', telegramId: '12345' },
            messages: [
              {
                id: 'message-1',
                authorType: 'user',
                authorId: '12345',
                content: 'VPN is offline',
                createdAt: '2026-06-04T10:00:00.000Z',
              },
            ],
          },
        }
      }

      return { data: {} }
    })
  })

  it('names ticket filter and reply controls', async () => {
    const user = userEvent.setup()

    renderWithProviders(<SupportTicketsPage />)

    expect(await screen.findByRole('combobox', { name: 'Status' })).toBeInTheDocument()

    await user.click(await screen.findByRole('button', { name: /Cannot connect/ }))

    expect(await screen.findByRole('textbox', { name: 'Reply message' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeInTheDocument()
  })
})
