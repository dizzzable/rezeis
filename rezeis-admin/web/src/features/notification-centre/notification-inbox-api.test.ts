import { afterEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import {
  clearInbox,
  deleteNotification,
  fetchInboxPage,
  fetchUnreadCount,
  markNotificationRead,
} from './notification-inbox-api'

afterEach(() => vi.restoreAllMocks())

function get(payload: unknown): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(api, 'get').mockResolvedValue({ data: payload } as never)
}

describe('what the panel asks the inbox for', () => {
  it('sends unreadOnly only when it is on', async () => {
    // `?unreadOnly=false` is a non-empty string, and every naive reader on the
    // other side calls it true. Not sending the parameter says the same thing
    // and cannot be misread — see `query-string-boolean-trap`.
    const spy = get({ items: [], nextCursor: null, unread: 0 })

    await fetchInboxPage({ limit: 20, unreadOnly: false })
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ params: { limit: 20 } })
    expect(spy.mock.calls[0]?.[1]).not.toMatchObject({ params: { unreadOnly: false } })

    await fetchInboxPage({ limit: 20, unreadOnly: true })
    expect(spy.mock.calls[1]?.[1]).toMatchObject({ params: { unreadOnly: true } })
  })

  it('passes the chosen category to the server rather than filtering a page', async () => {
    const spy = get({ items: [], nextCursor: null, unread: 0 })

    await fetchInboxPage({ limit: 20, category: 'fraud' })

    expect(spy.mock.calls[0]?.[1]).toMatchObject({ params: { category: 'fraud' } })
  })

  it('reads a page whether the server wrapped it or not', async () => {
    get({ data: { items: [{ id: 'n-1' }], nextCursor: 'n-1', unread: 4 } })
    const wrapped = await fetchInboxPage({ limit: 20 })
    expect(wrapped.items).toHaveLength(1)
    expect(wrapped.nextCursor).toBe('n-1')
    expect(wrapped.unread).toBe(4)

    get({ items: [], nextCursor: null, unread: 0 })
    const bare = await fetchInboxPage({ limit: 20 })
    expect(bare.items).toHaveLength(0)
    expect(bare.nextCursor).toBeNull()
  })

  it('refuses to call an HTML error page an empty inbox', async () => {
    // An error page served with HTTP 200 reaches here typed as a page. A
    // silent `[]` would tell the operator «уведомлений нет» — a confident
    // false statement about the thing they came to check.
    get({ items: '<html>gateway error</html>', nextCursor: null, unread: 0 })

    await expect(fetchInboxPage({ limit: 20 })).rejects.toThrow()
  })

  it('reads the count a write answers with, whichever noun the route used', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({ data: { marked: 1, unread: 2 } } as never)
    await expect(markNotificationRead('n-1')).resolves.toEqual({ changed: 1, unread: 2 })

    vi.spyOn(api, 'delete').mockResolvedValue({ data: { removed: 7, unread: 0 } } as never)
    await expect(deleteNotification('n-1')).resolves.toEqual({ changed: 7, unread: 0 })
  })

  it('clears only the read ones when that is what was asked for', async () => {
    const spy = vi.spyOn(api, 'delete').mockResolvedValue({ data: { removed: 3, unread: 1 } } as never)

    await clearInbox({ readOnly: true })
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ params: { readOnly: true } })

    await clearInbox({ readOnly: false })
    expect(spy.mock.calls[1]?.[1]).toMatchObject({ params: {} })
  })

  it('reads a missing count as none, not as NaN on the bell', async () => {
    get({})
    await expect(fetchUnreadCount()).resolves.toBe(0)
  })
})
