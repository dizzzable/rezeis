/**
 * How one alert reads in the list: its tone, its age, and the number on the
 * bell. Pure — no React, no i18next instance — so the rules can be asserted
 * without rendering anything.
 */
import { activeLocale, formatDateTime } from '@/lib/utils'

export type NotificationTone = 'error' | 'warning' | 'info'

/** Anything the server did not call ERROR or WARNING reads as ordinary news. */
export function notificationTone(severity: string): NotificationTone {
  if (severity === 'ERROR') return 'error'
  if (severity === 'WARNING') return 'warning'
  return 'info'
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * An alert's age: relative while that is the useful thing to know, and the
 * date and time once it is not.
 *
 * WHY THE SWITCH AT A DAY. «14 часов назад» is a sum the reader has to do to
 * get to "yesterday evening", and a date is what they would look for anyway.
 * Under a day the opposite holds: «5 минут назад» is the whole point, and the
 * clock time would make them do the subtraction instead.
 *
 * A clock that is behind the server's shows a future timestamp; that is not an
 * error worth a branch of its own, so anything not in the past reads as «just
 * now» rather than as «через 3 минуты».
 */
export function formatNotificationAge(createdAt: string, now: number, justNow: string): string {
  const at = new Date(createdAt).getTime()
  if (!Number.isFinite(at)) return '—'
  const elapsed = now - at
  if (elapsed < MINUTE_MS) return justNow
  if (elapsed >= DAY_MS) return formatDateTime(createdAt)

  const relative = new Intl.RelativeTimeFormat(activeLocale(), { numeric: 'auto' })
  return elapsed < HOUR_MS
    ? relative.format(-Math.floor(elapsed / MINUTE_MS), 'minute')
    : relative.format(-Math.floor(elapsed / HOUR_MS), 'hour')
}

/**
 * The deep link an alert opens, or `null` when it does not open anywhere.
 *
 * The stored url is composed by the panel's own route table, so this is not a
 * defence against the server — it is a defence against a row whose url was
 * written by an older version, or by a rule whose metadata carried something
 * unexpected into the template. A path inside the panel is the only thing the
 * router can take: `//evil.example` is a protocol-relative ADDRESS, not a path,
 * and handing it to `navigate()` leaves the panel.
 */
export function toPanelPath(url: string): string | null {
  if (!url.startsWith('/') || url.startsWith('//')) return null
  return url
}

/** The most the badge on the bell will show before it stops counting. */
export const UNREAD_BADGE_LIMIT = 99

/**
 * The number on the bell. Past the limit it says «99+», because the badge is
 * the width of two digits and a three-digit count would either overflow it or
 * shrink to something nobody can read — and by then the exact number has
 * stopped meaning anything anyway.
 */
export function formatUnreadBadge(unread: number): string {
  return unread > UNREAD_BADGE_LIMIT ? `${UNREAD_BADGE_LIMIT}+` : String(unread)
}
