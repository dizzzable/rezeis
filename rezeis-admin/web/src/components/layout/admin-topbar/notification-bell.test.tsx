import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation } from 'react-router'

import { NotificationBell } from '@/components/layout/admin-topbar/notification-bell'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

/**
 * The bell in the header.
 *
 * What is pinned here is what an operator would notice if it broke: the
 * number, that pressing a row both opens the thing and marks it read, that the
 * × is theirs alone, and that the popover's eight rows are not fetched for
 * every sign-in that never opens it.
 */

const UNREAD_PATH = '/admin/notifications/inbox/unread-count'
const LIST_PATH = '/admin/notifications/inbox'

const TICKET = {
  id: 'n-1',
  category: 'support',
  severity: 'INFO',
  type: 'support.ticket_created',
  title: 'Поддержка',
  message: 'New ticket #42 from @alice',
  url: '/support-tickets?ticket=t-42',
  readAt: null,
  createdAt: new Date().toISOString(),
}

function mockInbox(options: { readonly unread?: number; readonly items?: unknown[] } = {}): {
  readonly get: ReturnType<typeof vi.spyOn>
  readonly post: ReturnType<typeof vi.spyOn>
  readonly remove: ReturnType<typeof vi.spyOn>
} {
  const unread = options.unread ?? 1
  const items = options.items ?? [TICKET]
  const get = vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === UNREAD_PATH) return { data: { unread } } as never
    if (path === LIST_PATH) return { data: { items, nextCursor: null, unread } } as never
    return { data: {} } as never
  })
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { marked: 1, unread: 0 } } as never)
  const remove = vi
    .spyOn(api, 'delete')
    .mockResolvedValue({ data: { removed: 1, unread: 0 } } as never)
  return { get, post, remove }
}

function Probe() {
  const location = useLocation()
  return <span data-testid="where">{`${location.pathname}${location.search}`}</span>
}

async function openBell(): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: /уведомлен|notification/i }))
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('NotificationBell', () => {
  it('shows how many alerts are waiting, and nothing at all when none are', async () => {
    mockInbox({ unread: 3 })
    renderWithProviders(<NotificationBell />)

    const badge = await screen.findByText('3')
    expect(badge).toHaveAttribute('data-unread-badge', '3')

    cleanup()
    vi.restoreAllMocks()
    mockInbox({ unread: 0 })
    renderWithProviders(<NotificationBell />)

    // Nothing waiting is not «0» on the bell — it is a bell with no badge.
    await waitFor(() => expect(screen.queryByText('0')).not.toBeInTheDocument())
  })

  it('does not move on the first number it is given', async () => {
    // That number is what was already waiting at sign-in, not an arrival. A
    // bell that shakes on every page load teaches the operator to ignore it.
    mockInbox({ unread: 5 })
    renderWithProviders(<NotificationBell />)

    await screen.findByText('5')
    expect(screen.getByRole('button', { name: /уведомлен|notification/i })).toHaveAttribute(
      'data-bell-ring',
      'off',
    )
  })

  it('leaves the list alone until the bell is actually opened', async () => {
    // The header needs one number. Eight rows nobody looked at are eight rows
    // of traffic per sign-in, on every tab the operator keeps open.
    const { get } = mockInbox()
    renderWithProviders(<NotificationBell />)

    await screen.findByText('1')
    expect(get.mock.calls.some((call: unknown[]) => call[0] === LIST_PATH)).toBe(false)

    await openBell()
    await waitFor(() => expect(get.mock.calls.some((call: unknown[]) => call[0] === LIST_PATH)).toBe(true))
  })

  it('opens what the alert is about, and marks it read on the way', async () => {
    const { post } = mockInbox()
    renderWithProviders(
      <>
        <NotificationBell />
        <Probe />
      </>,
    )

    await openBell()
    await userEvent.click(await screen.findByRole('button', { name: 'Поддержка' }))

    expect(post).toHaveBeenCalledWith('/admin/notifications/inbox/n-1/read')
    await waitFor(() =>
      expect(screen.getByTestId('where')).toHaveTextContent('/support-tickets?ticket=t-42'),
    )
  })

  it('deletes one alert without touching what it was about', async () => {
    const { remove } = mockInbox()
    renderWithProviders(<NotificationBell />)

    await openBell()
    await userEvent.click(await screen.findByRole('button', { name: /удалить|delete/i }))

    expect(remove).toHaveBeenCalledWith('/admin/notifications/inbox/n-1')
  })

  it('says so when nothing has arrived, instead of showing an empty box', async () => {
    mockInbox({ unread: 0, items: [] })
    renderWithProviders(<NotificationBell />)

    await openBell()

    expect(await screen.findByText(/пока нет|arrived yet/i)).toBeInTheDocument()
  })
})
