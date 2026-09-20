import type { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { adminQueryKeys } from '@/lib/admin-query-keys'

import {
  INBOX_REFRESH_INTERVAL_MS,
  cancelInboxRefresh,
  resetInboxRefreshThrottle,
  scheduleInboxRefresh,
} from './notification-inbox-live'

function fakeClient(): { client: QueryClient; invalidate: ReturnType<typeof vi.fn> } {
  const invalidate = vi.fn()
  return { client: { invalidateQueries: invalidate } as unknown as QueryClient, invalidate }
}

describe('keeping the bell current without asking every second', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetInboxRefreshThrottle()
  })

  afterEach(() => {
    resetInboxRefreshThrottle()
    vi.useRealTimers()
  })

  it('asks at once for the first event, and once more for the burst behind it', () => {
    const { client, invalidate } = fakeClient()

    scheduleInboxRefresh(client)
    // The alert the operator is waiting for must not sit out a debounce window.
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: adminQueryKeys.notifications.inbox.all,
    })

    // A busy panel: thirty events inside the window cost one more request, not
    // thirty.
    for (let i = 0; i < 30; i += 1) scheduleInboxRefresh(client)
    expect(invalidate).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(INBOX_REFRESH_INTERVAL_MS)
    expect(invalidate).toHaveBeenCalledTimes(2)
  })

  it('drops a booked refresh when the socket goes away with the session', () => {
    const { client, invalidate } = fakeClient()

    scheduleInboxRefresh(client)
    scheduleInboxRefresh(client)
    cancelInboxRefresh()
    vi.advanceTimersByTime(INBOX_REFRESH_INTERVAL_MS * 3)

    // Only the immediate one: the second would have refetched a signed-out
    // panel's inbox.
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('asks again immediately once the window has passed in silence', () => {
    const { client, invalidate } = fakeClient()

    scheduleInboxRefresh(client)
    vi.advanceTimersByTime(INBOX_REFRESH_INTERVAL_MS + 1)
    scheduleInboxRefresh(client)

    expect(invalidate).toHaveBeenCalledTimes(2)
  })
})
