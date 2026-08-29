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

describe('the silence-device control on a guest conversation', () => {
  /**
   * Gated on the SIGNAL, never on the flag.
   *
   * Requiring `flaggedReason` meant the only device an operator could ever
   * silence was one already tied to a ban or to a third visit inside a week —
   * so the ordinary pest, arriving twice a week from a device with no history,
   * could not be silenced at all, and neither could a single abusive ticket
   * from an otherwise clean machine. There is no other route to it: the panel
   * deliberately ships `hasDeviceSignal` and never the fingerprint itself, so
   * the blocklist page cannot stand in.
   */
  function mockGuestTicket(guest: Record<string, unknown> | null) {
    vi.restoreAllMocks()
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      const base = {
        id: 'ticket-1',
        userTelegramId: null,
        subject: 'Cannot connect',
        status: 'open',
        channel: 'guest',
        createdAt: '2026-06-04T10:00:00.000Z',
        updatedAt: '2026-06-04T10:05:00.000Z',
        user: null,
        guest,
        messages: [],
      }
      if (path === '/admin/support-tickets') {
        return { data: { items: [base], total: 1 } }
      }
      if (path === '/admin/support-tickets/ticket-1') {
        return { data: base }
      }
      return { data: {} }
    })
  }

  it('offers it for an UNFLAGGED device that carries a signal', async () => {
    const user = userEvent.setup()
    mockGuestTicket({ id: 'g-1', hasDeviceSignal: true, flaggedReason: null })

    renderWithProviders(<SupportTicketsPage />)
    await user.click(await screen.findByRole('button', { name: /Cannot connect/ }))

    expect(
      await screen.findByRole('button', { name: /Silence device/i }),
    ).toBeInTheDocument()
  })

  it('hides it when there is no signal to act on', async () => {
    const user = userEvent.setup()
    mockGuestTicket({ id: 'g-1', hasDeviceSignal: false, flaggedReason: null })

    renderWithProviders(<SupportTicketsPage />)
    await user.click(await screen.findByRole('button', { name: /Cannot connect/ }))

    // The endpoint refuses this case anyway; offering a button that can only
    // fail tells the operator the pest is handled when nothing was written.
    await screen.findByRole('button', { name: /Cannot connect/ })
    expect(screen.queryByRole('button', { name: /Silence device/i })).toBeNull()
  })
})
