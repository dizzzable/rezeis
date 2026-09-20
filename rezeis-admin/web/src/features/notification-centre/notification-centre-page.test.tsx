import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

import NotificationCentrePage from './notification-centre-page'

const LIST_PATH = '/admin/notifications/inbox'

const ALERT = {
  id: 'n-1',
  category: 'payment',
  severity: 'ERROR',
  type: 'payment.failed',
  title: 'Платёж',
  message: 'Payment 8f3a failed: insufficient funds',
  url: '/payments',
  readAt: '2026-09-20T09:00:00.000Z',
  createdAt: '2026-09-20T09:00:00.000Z',
}

function mockInbox(): {
  readonly get: ReturnType<typeof vi.spyOn>
  readonly post: ReturnType<typeof vi.spyOn>
  readonly remove: ReturnType<typeof vi.spyOn>
} {
  const get = vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === `${LIST_PATH}/unread-count`) return { data: { unread: 2 } } as never
    if (path === LIST_PATH) return { data: { items: [ALERT], nextCursor: null, unread: 2 } } as never
    return { data: {} } as never
  })
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { marked: 2, unread: 0 } } as never)
  const remove = vi
    .spyOn(api, 'delete')
    .mockResolvedValue({ data: { removed: 1, unread: 0 } } as never)
  return { get, post, remove }
}

/** The parameters of the last list request the page made. */
function lastListParams(get: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const calls = get.mock.calls.filter((call: unknown[]) => call[0] === LIST_PATH)
  const config = calls[calls.length - 1]?.[1] as { params?: Record<string, unknown> } | undefined
  return config?.params ?? {}
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the notification centre page', () => {
  it('asks the server for the unread ones, rather than hiding rows it already has', async () => {
    // A page is twenty rows. Filtering those would answer «непрочитанных нет»
    // for an inbox whose unread alerts are on page two.
    const { get } = mockInbox()
    renderWithProviders(<NotificationCentrePage />)

    await screen.findByText('Платёж')
    await userEvent.click(screen.getByRole('button', { name: /непрочитанн|unread/i }))

    await waitFor(() => expect(lastListParams(get)).toMatchObject({ unreadOnly: true }))
  })

  it('marks everything read from one button', async () => {
    const { post } = mockInbox()
    renderWithProviders(<NotificationCentrePage />)

    await screen.findByText('Платёж')
    await userEvent.click(screen.getByRole('button', { name: /прочитать всё|mark all read/i }))

    expect(post).toHaveBeenCalledWith('/admin/notifications/inbox/read-all')
  })

  it('clears only the read ones when that is the button that was pressed', async () => {
    const { remove } = mockInbox()
    renderWithProviders(<NotificationCentrePage />)

    await screen.findByText('Платёж')
    await userEvent.click(screen.getByRole('button', { name: /^очистить$|^clear$/i }))
    await userEvent.click(
      await screen.findByRole('button', { name: /удалить прочитанные|delete the read ones/i }),
    )

    await waitFor(() =>
      expect(remove).toHaveBeenCalledWith(LIST_PATH, { params: { readOnly: true } }),
    )
  })

  it('says what belongs here when the inbox is empty, instead of an empty card', async () => {
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === `${LIST_PATH}/unread-count`) return { data: { unread: 0 } } as never
      return { data: { items: [], nextCursor: null, unread: 0 } } as never
    })
    renderWithProviders(<NotificationCentrePage />)

    expect(await screen.findByText(/пока нет|arrived yet/i)).toBeInTheDocument()
    // And the difference from the audit log is stated rather than assumed.
    expect(screen.getByText(/журнале действий|audit log/i)).toBeInTheDocument()
  })
})
