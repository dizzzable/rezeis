/**
 * The queries and writes behind the bell and the notification centre page.
 *
 * Both surfaces read the same cache: the badge is one number under
 * `inbox.unread`, the lists are pages under `inbox.list(<filter>)`, and every
 * write puts the fresh number straight into the badge instead of asking for it
 * again. A realtime event refreshes the whole prefix — see
 * `notification-inbox-live.ts` for why the socket cannot answer this itself.
 */
import { useCallback } from 'react'
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type UseInfiniteQueryResult,
} from '@tanstack/react-query'

import { adminQueryKeys } from '@/lib/admin-query-keys'

import {
  clearInbox,
  deleteNotification,
  fetchInboxPage,
  fetchUnreadCount,
  markAllNotificationsRead,
  markNotificationRead,
  type InboxCategory,
  type InboxNotification,
  type InboxPage,
  type InboxWriteResult,
} from './notification-inbox-api'

/** How many alerts the popover shows, and how many a page of the list holds. */
export const BELL_PAGE_SIZE = 8
export const PAGE_SIZE = 20

/** How often the badge re-asks on its own, when no event has arrived at all. */
const BADGE_POLL_MS = 5 * 60_000

export interface InboxFilter {
  readonly unreadOnly: boolean
  /** `'all'` means "do not filter"; the five others are the push categories. */
  readonly category: InboxCategory | 'all'
}

function filterKey(filter: InboxFilter, limit: number): string {
  return `${filter.category}:${filter.unreadOnly ? 'unread' : 'any'}:${limit}`
}

/**
 * The number on the bell.
 *
 * `refetchOnWindowFocus` is on deliberately, against the panel's global
 * default. The poll below stops while the tab is hidden — that is what
 * `refetchIntervalInBackground: false` is for — so an operator who comes back
 * after lunch would otherwise read a badge from before it, for up to five
 * minutes. The dashboard's online card was fixed for exactly this reason.
 */
export function useUnreadCount(): {
  readonly unread: number
  /** False until the server has said a number — 0 means "none", not "not yet". */
  readonly answered: boolean
  readonly isError: boolean
} {
  const query = useQuery({
    queryKey: adminQueryKeys.notifications.inbox.unread,
    queryFn: ({ signal }) => fetchUnreadCount(signal),
    staleTime: 30_000,
    refetchInterval: BADGE_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  })
  return { unread: query.data ?? 0, answered: query.data !== undefined, isError: query.isError }
}

export function useInboxList(
  filter: InboxFilter,
  options: { readonly limit?: number; readonly enabled?: boolean } = {},
): UseInfiniteQueryResult<InfiniteData<InboxPage>, Error> {
  const limit = options.limit ?? PAGE_SIZE
  return useInfiniteQuery({
    queryKey: adminQueryKeys.notifications.inbox.list(filterKey(filter, limit)),
    queryFn: ({ pageParam, signal }) =>
      fetchInboxPage(
        {
          limit,
          cursor: typeof pageParam === 'string' ? pageParam : undefined,
          unreadOnly: filter.unreadOnly,
          category: filter.category === 'all' ? undefined : filter.category,
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: options.enabled ?? true,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  })
}

/** Flattens the pages the way every consumer wants them: one list, newest first. */
export function inboxItems(data: InfiniteData<InboxPage> | undefined): readonly InboxNotification[] {
  return data?.pages.flatMap((page) => page.items) ?? []
}

function applyWrite(queryClient: QueryClient, result: InboxWriteResult): void {
  queryClient.setQueryData(adminQueryKeys.notifications.inbox.unread, result.unread)
  // The lists have lost or gained a row; the badge already has its answer, so
  // only the list queries are refetched — and only the ones actually mounted.
  void queryClient.invalidateQueries({ queryKey: ['admin', 'notifications', 'inbox', 'list'] })
}

export interface InboxActions {
  readonly markRead: (id: string) => Promise<InboxWriteResult>
  readonly markAllRead: () => Promise<InboxWriteResult>
  readonly remove: (id: string) => Promise<InboxWriteResult>
  readonly clear: (options: { readonly readOnly: boolean }) => Promise<InboxWriteResult>
  readonly isBusy: boolean
}

/**
 * Everything the operator can do to their own inbox.
 *
 * The four are one hook rather than four because every one of them ends the
 * same way — a new unread count into the badge and the open list refreshed —
 * and a caller that forgot that step would leave the bell showing a number the
 * server no longer agrees with.
 */
export function useInboxActions(): InboxActions {
  const queryClient = useQueryClient()

  const onSuccess = useCallback(
    (result: InboxWriteResult) => applyWrite(queryClient, result),
    [queryClient],
  )

  const readOne = useMutation({ mutationFn: markNotificationRead, onSuccess })
  const readAll = useMutation({ mutationFn: markAllNotificationsRead, onSuccess })
  const removeOne = useMutation({ mutationFn: deleteNotification, onSuccess })
  const clearAll = useMutation({ mutationFn: clearInbox, onSuccess })

  return {
    markRead: readOne.mutateAsync,
    markAllRead: () => readAll.mutateAsync(),
    remove: removeOne.mutateAsync,
    clear: clearAll.mutateAsync,
    isBusy: readOne.isPending || readAll.isPending || removeOne.isPending || clearAll.isPending,
  }
}
