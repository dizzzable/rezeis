/**
 * The panel's notification centre — one operator's own alerts.
 *
 * The server half (`admin/notifications/inbox`) writes a row per admin when an
 * alert is raised, so everything here is already scoped: the token decides
 * whose inbox this is, and no call takes an admin id. «Прочитано» and
 * «удалить» belong to the operator who pressed them and take nothing away from
 * anyone else.
 *
 * WHAT IS IN HERE is decided entirely by the server — the same route table
 * that decides what goes out as web push. The panel never re-implements that
 * question; it asks how many are unread and what they say.
 *
 * Every write answers with the fresh unread count, which the caller writes
 * straight into the badge's cache: marking one alert read must not cost a
 * second round trip to learn the number that changed by one.
 */
import { api } from '@/lib/api'
import { expectArray, unwrapPayload } from '@/lib/api-utils'

const BASE = '/admin/notifications/inbox'

/**
 * The five categories an alert can carry — the push vocabulary, not the
 * socket's fourteen. They are the same five the operator switches on and off
 * in Settings → Push, so the filter here and the preference there name the
 * same thing.
 */
export const INBOX_CATEGORIES = ['support', 'payment', 'fraud', 'withdrawal', 'system'] as const

export type InboxCategory = (typeof INBOX_CATEGORIES)[number]

export type InboxSeverity = 'INFO' | 'WARNING' | 'ERROR'

export interface InboxNotification {
  readonly id: string
  /** One of `INBOX_CATEGORIES` — typed as a string because the server owns the list. */
  readonly category: string
  readonly severity: string
  /** The system-event type it was filed from, e.g. `payment.failed`. */
  readonly type: string
  /** Composed by the route table: «Поддержка», «Платёж», «Автоматизация «…»». */
  readonly title: string
  readonly message: string
  /** The SPA deep link the alert opens. */
  readonly url: string
  readonly readAt: string | null
  readonly createdAt: string
}

export interface InboxPage {
  readonly items: readonly InboxNotification[]
  /** Pass back as `cursor` for the next page; `null` when this was the last one. */
  readonly nextCursor: string | null
  /** Unread across the whole inbox, not just this page. */
  readonly unread: number
}

export interface InboxQuery {
  readonly limit?: number
  readonly cursor?: string
  readonly unreadOnly?: boolean
  /** One of `INBOX_CATEGORIES`; omitted means every category. */
  readonly category?: InboxCategory
}

/** What every write answers with: what it changed, and the badge's new number. */
export interface InboxWriteResult {
  readonly changed: number
  readonly unread: number
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0
}

function toCursor(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * A write's answer, whichever noun the route used for the count it changed.
 * `read`/`read-all` call it `marked`, the two deletes call it `removed`; the
 * caller cares about the same two numbers either way.
 */
function toWriteResult(payload: unknown): InboxWriteResult {
  const record = unwrapPayload(payload)
  return {
    changed: toCount(record.marked ?? record.removed),
    unread: toCount(record.unread),
  }
}

export async function fetchUnreadCount(signal?: AbortSignal): Promise<number> {
  const { data } = await api.get(`${BASE}/unread-count`, { signal })
  return toCount(unwrapPayload(data).unread)
}

export async function fetchInboxPage(query: InboxQuery, signal?: AbortSignal): Promise<InboxPage> {
  const params: Record<string, string | number | boolean> = {}
  if (query.limit !== undefined) params.limit = query.limit
  if (query.cursor !== undefined) params.cursor = query.cursor
  if (query.category !== undefined) params.category = query.category
  // Sent only when it is on: `?unreadOnly=false` is a string the server has to
  // spell out a rule for, and not sending it says the same thing with nothing.
  if (query.unreadOnly === true) params.unreadOnly = true

  const { data } = await api.get(BASE, { params, signal })
  const record = unwrapPayload(data)
  return {
    items: expectArray<InboxNotification>(record.items ?? []),
    nextCursor: toCursor(record.nextCursor),
    unread: toCount(record.unread),
  }
}

export async function markNotificationRead(id: string): Promise<InboxWriteResult> {
  const { data } = await api.post(`${BASE}/${encodeURIComponent(id)}/read`)
  return toWriteResult(data)
}

export async function markAllNotificationsRead(): Promise<InboxWriteResult> {
  const { data } = await api.post(`${BASE}/read-all`)
  return toWriteResult(data)
}

export async function deleteNotification(id: string): Promise<InboxWriteResult> {
  const { data } = await api.delete(`${BASE}/${encodeURIComponent(id)}`)
  return toWriteResult(data)
}

/** Clears the inbox — everything, or only what has already been read. */
export async function clearInbox(options: { readonly readOnly: boolean }): Promise<InboxWriteResult> {
  const { data } = await api.delete(BASE, {
    params: options.readOnly ? { readOnly: true } : {},
  })
  return toWriteResult(data)
}
