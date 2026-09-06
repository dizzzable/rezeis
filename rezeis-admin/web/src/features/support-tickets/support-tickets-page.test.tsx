import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import { usePermissionStore } from '@/features/rbac'
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

/**
 * Opening a ticket WITH a client.
 *
 * The control is gated on `support_tickets:create`, a permission that
 * existed in the RBAC catalog for a long time with no route behind it — so
 * older custom roles do not carry it. An operator without it must not see a
 * button whose only possible outcome is a 403.
 */
describe('SupportTicketsPage — opening a ticket with a client', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    usePermissionStore.setState({ loaded: true, role: null, granted: new Set<string>() })
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/support-tickets') return { data: { items: [], total: 0 } }
      // The freshly opened thread: `onSuccess` selects it, so the detail
      // pane loads it right away.
      if (path === '/admin/support-tickets/ticket-9') {
        return {
          data: {
            id: 'ticket-9',
            userTelegramId: '12345',
            subject: 'A question',
            status: 'open',
            channel: 'cabinet',
            createdAt: '2026-09-06T10:00:00.000Z',
            updatedAt: '2026-09-06T10:00:00.000Z',
            user: { id: 'u-1', username: 'ann', name: 'Ann', telegramId: '12345' },
            messages: [
              {
                id: 'm-1',
                authorType: 'admin',
                authorId: 'admin-1',
                content: 'Hello',
                createdAt: '2026-09-06T10:00:00.000Z',
              },
            ],
            docRequests: [],
          },
        }
      }
      return { data: {} }
    })
  })

  function grant(...tokens: string[]): void {
    usePermissionStore.setState({ loaded: true, role: null, granted: new Set(tokens) })
  }

  it('hides the control from a role without support_tickets:create', async () => {
    grant('support_tickets:view', 'support_tickets:edit')
    renderWithProviders(<SupportTicketsPage />)
    // Wait for the toolbar itself before asserting an absence, so the case
    // cannot pass simply because nothing had rendered yet.
    await screen.findByRole('button', { name: /^Settings$/i })
    expect(screen.queryByRole('button', { name: /Message a client/i })).toBeNull()
  })

  it('offers it to a role that carries the permission', async () => {
    grant('support_tickets:view', 'support_tickets:create')
    renderWithProviders(<SupportTicketsPage />)
    expect(await screen.findByRole('button', { name: /Message a client/i })).toBeInTheDocument()
  })

  it('will not submit until a recipient, a subject and a message are all present', async () => {
    const user = userEvent.setup()
    grant('support_tickets:create')
    renderWithProviders(<SupportTicketsPage />)
    await user.click(await screen.findByRole('button', { name: /Message a client/i }))

    const submit = await screen.findByRole('button', { name: /Open ticket/i })
    expect(submit).toBeDisabled()

    await user.type(screen.getByLabelText(/^To$/i), '12345')
    expect(submit).toBeDisabled()
    await user.type(screen.getByLabelText(/^Subject$/i), 'A question')
    expect(submit).toBeDisabled()
    await user.type(screen.getByLabelText(/First message/i), 'Hello')
    expect(submit).toBeEnabled()
  })

  it('posts the recipient, subject and message, trimmed', async () => {
    const user = userEvent.setup()
    grant('support_tickets:create')
    const post = vi
      .spyOn(api, 'post')
      .mockResolvedValue({ data: { id: 'ticket-9' } } as never)

    renderWithProviders(<SupportTicketsPage />)
    await user.click(await screen.findByRole('button', { name: /Message a client/i }))
    await user.type(screen.getByLabelText(/^To$/i), '  12345  ')
    await user.type(screen.getByLabelText(/^Subject$/i), '  A question  ')
    await user.type(screen.getByLabelText(/First message/i), '  Hello  ')
    await user.click(screen.getByRole('button', { name: /Open ticket/i }))

    expect(post).toHaveBeenCalledWith('/admin/support-tickets', {
      userRef: '12345',
      subject: 'A question',
      message: 'Hello',
    })
  })

  it('shows what the server refused, not a generic failure', async () => {
    // The two refusals an operator can act on are "no such user" and "that
    // @username matches two accounts" — both are useless as "could not open
    // the ticket".
    const user = userEvent.setup()
    grant('support_tickets:create')
    vi.spyOn(api, 'post').mockRejectedValue({
      response: { data: { message: 'That username matches more than one account — use the Telegram ID' } },
    })

    renderWithProviders(<SupportTicketsPage />)
    await user.click(await screen.findByRole('button', { name: /Message a client/i }))
    await user.type(screen.getByLabelText(/^To$/i), '@ann')
    await user.type(screen.getByLabelText(/^Subject$/i), 'Q')
    await user.type(screen.getByLabelText(/First message/i), 'Hi')
    await user.click(screen.getByRole('button', { name: /Open ticket/i }))

    expect(await screen.findByText(/matches more than one account/i)).toBeInTheDocument()
  })
})
