/**
 * Keeping the bell's number true without asking every second.
 *
 * WHY THE SOCKET DOES NOT CARRY THE ANSWER. The realtime channel carries
 * fourteen categories of event; which of them becomes an alert, and whether
 * THIS operator is entitled to a copy, is decided on the server by the route
 * table and the category's RBAC gate. Teaching the panel to predict that would
 * be a second copy of the policy, and the day the two disagree the bell lies.
 * So an event means only "something happened — ask again", and the server
 * stays the only thing that knows what is in the inbox.
 *
 * WHY THROTTLED AND NOT DEBOUNCED. A debounce would delay the first alert by
 * its whole window, which is the one this is for. This refreshes immediately
 * and then at most once per window, so a burst of thirty events on a busy
 * panel costs two requests rather than thirty — and the operator still saw the
 * first one land at once.
 *
 * The state is module-scoped because the throttle is about the panel's traffic,
 * not about one component's lifetime: the badge unmounts and remounts with
 * every sign-in, and the bound must not reset with it.
 */
import type { QueryClient } from '@tanstack/react-query'

import { adminQueryKeys } from '@/lib/admin-query-keys'

/** At most one inbox refresh per this window, however many events arrive. */
export const INBOX_REFRESH_INTERVAL_MS = 5_000

let lastRefreshAt = 0
let booked: ReturnType<typeof setTimeout> | null = null

function refresh(queryClient: QueryClient): void {
  lastRefreshAt = Date.now()
  // The prefix, not the badge alone: the popover and the page sit under it and
  // whichever of them is open should show what the number just changed to.
  void queryClient.invalidateQueries({ queryKey: adminQueryKeys.notifications.inbox.all })
}

/** Call on any realtime event: refreshes now, or books the end of the window. */
export function scheduleInboxRefresh(queryClient: QueryClient): void {
  if (booked !== null) return
  const waited = Date.now() - lastRefreshAt
  if (waited >= INBOX_REFRESH_INTERVAL_MS) {
    refresh(queryClient)
    return
  }
  booked = setTimeout(() => {
    booked = null
    refresh(queryClient)
  }, INBOX_REFRESH_INTERVAL_MS - waited)
}

/** Drops a booked refresh — for when the socket goes away with the session. */
export function cancelInboxRefresh(): void {
  if (booked === null) return
  clearTimeout(booked)
  booked = null
}

/**
 * Forgets that anything was ever refreshed. For tests only: without it the
 * window a test opened would still be closing in the test after it.
 */
export function resetInboxRefreshThrottle(): void {
  cancelInboxRefresh()
  lastRefreshAt = 0
}
