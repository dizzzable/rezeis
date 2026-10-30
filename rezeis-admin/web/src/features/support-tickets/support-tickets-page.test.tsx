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

describe('the AI assistant on a ticket (panel 0.9.7.76)', () => {
  function mockTicket(ai: { active: boolean; handedOffAt: string | null; handoffReason: string | null }) {
    vi.restoreAllMocks()
    usePermissionStore.setState({
      loaded: true,
      role: null,
      granted: new Set(['support_tickets:view', 'support_tickets:edit']),
    })
    const detail = {
      id: 'ticket-ai',
      userTelegramId: '12345',
      subject: 'VPN is down',
      status: 'waiting_reply',
      channel: 'cabinet',
      createdAt: '2026-10-16T10:00:00.000Z',
      updatedAt: '2026-10-16T10:01:00.000Z',
      user: { id: 'u-1', username: 'ann', name: 'Ann', telegramId: '12345' },
      ai,
      messages: [
        { id: 'm-1', authorType: 'user', authorId: 'u-1', content: 'It does not connect', createdAt: '2026-10-16T10:00:00.000Z' },
        {
          id: 'm-2',
          authorType: 'admin',
          authorId: null,
          content: 'Re-add the subscription',
          createdAt: '2026-10-16T10:00:30.000Z',
          metadata: { ai: true, model: 'gpt-4o-mini' },
        },
      ],
      docRequests: [],
    }
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/support-tickets') return { data: { items: [{ ...detail, messages: [] }], total: 1 } }
      if (path === '/admin/support-tickets/ticket-ai') return { data: detail }
      return { data: {} }
    })
    return vi.spyOn(api, 'post').mockResolvedValue({ data: detail })
  }

  it('marks the assistant\'s reply and lets the operator take the thread without writing', async () => {
    const post = mockTicket({ active: true, handedOffAt: null, handoffReason: null })
    const user = userEvent.setup()
    renderWithProviders(<SupportTicketsPage />)

    await user.click(await screen.findByRole('button', { name: /VPN is down/ }))
    expect(await screen.findByText('AI assistant')).toBeInTheDocument()
    expect(screen.getByTestId('ticket-ai-strip')).toHaveTextContent(/The AI assistant answers this ticket/)

    await user.click(screen.getByRole('button', { name: 'Take from the AI' }))
    expect(post).toHaveBeenCalledWith('/admin/support-tickets/ticket-ai/ai', { active: false })
  })

  it('says why the assistant handed the thread over, in words', async () => {
    mockTicket({ active: false, handedOffAt: '2026-10-16T10:02:00.000Z', handoffReason: 'ai_error' })
    const user = userEvent.setup()
    renderWithProviders(<SupportTicketsPage />)

    await user.click(await screen.findByRole('button', { name: /VPN is down/ }))
    const strip = await screen.findByTestId('ticket-ai-strip')
    expect(strip).toHaveTextContent(/the model did not answer/)
    expect(screen.getByRole('button', { name: 'Give back to the AI' })).toBeInTheDocument()
  })
})

/**
 * The client card beside a ticket (30.10.2026). The owner's ticket: the header
 * said «Ни разу не подключался» and showed no subscription — panel columns
 * only — while the client wrote «Сейчас работает»; the hand-over strip still
 * read like an open fault six minutes after it was not one.
 */
describe('what the operator knows about the client (30.10.2026)', () => {
  const NOW = Date.now()
  const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()

  function mockTicketWithCard(card: unknown, messages?: unknown[]) {
    vi.restoreAllMocks()
    usePermissionStore.setState({
      loaded: true,
      role: null,
      granted: new Set(['support_tickets:view', 'support_tickets:edit']),
    })
    const detail = {
      id: 'ticket-card',
      userTelegramId: null,
      subject: 'VPN не работает',
      status: 'open',
      channel: 'cabinet',
      createdAt: at(10),
      updatedAt: at(4),
      user: { id: 'u-1', login: 'Zuli', name: null, username: null, telegramId: null, hasEverConnected: false, subscription: null },
      ai: { active: false, handedOffAt: at(9), handoffReason: 'Клиент оплатил продление, а VPN не работает' },
      messages: messages ?? [
        { id: 'm-1', authorType: 'user', authorId: 'u-1', content: 'Я оплатила продление', createdAt: at(10) },
        { id: 'm-2', authorType: 'admin', authorId: null, content: 'Передаю специалисту', createdAt: at(9), metadata: { ai: true } },
        { id: 'm-3', authorType: 'user', authorId: 'u-1', content: 'Когда', createdAt: at(8) },
        { id: 'm-4', authorType: 'user', authorId: 'u-1', content: 'Сейчас работает', createdAt: at(4) },
      ],
      docRequests: [],
    }
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/support-tickets') return { data: { items: [{ ...detail, messages: [] }], total: 1 } }
      if (path === '/admin/support-tickets/ticket-card') return { data: detail }
      if (path === '/admin/support-tickets/ticket-card/client-card') return { data: { card } }
      return { data: {} }
    })
  }

  const liveCard = {
    asOf: at(0),
    zone: 'Europe/Moscow',
    account: { createdAt: at(100_000), isBlocked: false, surface: null, os: null, lastSeenAt: null, firstTrafficAt: at(3) },
    subscriptions: [
      {
        id: 's-1',
        plan: 'Стандарт',
        status: 'ACTIVE',
        isTrial: false,
        startedAt: at(100),
        expiresAt: new Date(NOW + 30 * 86_400_000).toISOString(),
        trafficLimitGb: 100,
        deviceLimit: 3,
        read: 'live',
        remnawave: { status: 'ACTIVE', expiresAt: null, usedBytes: 2 * 1024 ** 3, onlineAt: at(2), firstConnectedAt: at(3), devices: 1 },
        sync: null,
      },
    ],
    payments: [
      {
        number: '4821',
        createdAt: at(12),
        status: 'COMPLETED',
        purchaseType: 'RENEW',
        amount: '299',
        currency: 'RUB',
        gateway: 'Карта или СБП',
        plan: 'Стандарт',
        appliedAt: null,
      },
    ],
    alerts: [{ kind: 'paid_not_applied', payment: '4821', paidAt: at(12) }],
  }

  it('shows the live card, its fault first, and drops the stale «never connected» badge', async () => {
    mockTicketWithCard(liveCard)
    const user = userEvent.setup()
    renderWithProviders(<SupportTicketsPage />)
    await user.click(await screen.findByRole('button', { name: /VPN не работает/ }))

    const panel = await screen.findByTestId('ticket-client-card')
    expect(panel).toHaveTextContent('Client now')
    expect(panel).toHaveTextContent(/Стандарт · Subscription active, until/)
    expect(screen.getByTestId('ticket-client-alerts')).toHaveTextContent(/Payment #4821 was paid .* but never applied to the subscription/)
    // Unfolded by itself because of the fault: the live line and the payment.
    expect(panel).toHaveTextContent(/Remnawave: ACTIVE · traffic 2\.0 of 100 GB · 1 of 3 devices · online 2 minutes ago/)
    expect(panel).toHaveTextContent(/Renewal «Стандарт» · 299 RUB · Карта или СБП · paid, NOT applied · №4821/)
    expect(screen.queryByText('Never connected')).not.toBeInTheDocument()
  })

  it('stays folded to one line when nothing is wrong', async () => {
    mockTicketWithCard({ ...liveCard, alerts: [], payments: [] })
    const user = userEvent.setup()
    renderWithProviders(<SupportTicketsPage />)
    await user.click(await screen.findByRole('button', { name: /VPN не работает/ }))

    const panel = await screen.findByTestId('ticket-client-card')
    expect(panel).toHaveTextContent(/Стандарт · Subscription active/)
    expect(panel).not.toHaveTextContent(/online 2 minutes ago/)
    await user.click(screen.getByRole('button', { name: 'Details' }))
    expect(panel).toHaveTextContent(/online 2 minutes ago/)
  })

  it('says the client wrote after the hand-over, so the reason may be out of date', async () => {
    mockTicketWithCard(null)
    const user = userEvent.setup()
    renderWithProviders(<SupportTicketsPage />)
    await user.click(await screen.findByRole('button', { name: /VPN не работает/ }))

    expect(await screen.findByTestId('ticket-ai-since')).toHaveTextContent(
      /Since the hand-over the client wrote 2 more messages \(last .*\) — the reason may be out of date\./,
    )
    expect(screen.queryByTestId('ticket-client-card')).not.toBeInTheDocument()
  })

  it('says nothing of the kind when the client has not written since', async () => {
    mockTicketWithCard(null, [
      { id: 'm-1', authorType: 'user', authorId: 'u-1', content: 'Я оплатила продление', createdAt: at(10) },
      { id: 'm-2', authorType: 'admin', authorId: null, content: 'Передаю специалисту', createdAt: at(9), metadata: { ai: true } },
    ])
    const user = userEvent.setup()
    renderWithProviders(<SupportTicketsPage />)
    await user.click(await screen.findByRole('button', { name: /VPN не работает/ }))

    await screen.findByTestId('ticket-ai-strip')
    expect(screen.queryByTestId('ticket-ai-since')).not.toBeInTheDocument()
  })
})
