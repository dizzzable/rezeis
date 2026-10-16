/**
 * «Возврат покупателя» against the Remnawave clean-up (the owner, 15.10.2026).
 *
 * The panel reminds a customer who paid and has not come back 3, 7 and 14 days
 * after their subscription ended — each reminder OFF until the operator turns
 * it on (`notification-toggle.util.ts` on the server). A reminder looks for a
 * subscription that is expired, and the panel deletes an expired subscription's
 * Remnawave profile «Удалять через (дней после истечения)» after the end (3 by
 * default), after which the subscription is deleted, not expired: a reminder
 * due later than that reaches nobody. So the clean-up must wait at least a day
 * past the latest reminder switched on — 15 days for the 14-day one — or be
 * off. The panel says so beside the switches and beside that setting; it does
 * not change either by itself.
 */

/** The reminders, in the order they go out. */
export const WINBACK_NOTIFICATION_KEYS = ['expired_3_days_ago', 'expired_7_days_ago', 'expired_14_days_ago'] as const

export type WinbackNotificationKey = (typeof WINBACK_NOTIFICATION_KEYS)[number]

/** Days after the end each reminder goes out. */
export const WINBACK_DAYS: Readonly<Record<WinbackNotificationKey, number>> = {
  expired_3_days_ago: 3,
  expired_7_days_ago: 7,
  expired_14_days_ago: 14,
}

/** The same query key as the Remnawave settings tab's, so both read one copy. */
export const CLEANUP_SETTINGS_QUERY_KEY = ['remnawave', 'cleanup-settings'] as const

/** «Remnawave → Настройки», where «Очистка профилей при истечении» lives. */
export const REMNAWAVE_SETTINGS_PATH = '/remnawave?tab=settings'

export interface CleanupPolicy {
  readonly deleteEnabled: boolean
  readonly graceDays: number
}

function isWinbackKey(key: string): key is WinbackNotificationKey {
  return (WINBACK_NOTIFICATION_KEYS as readonly string[]).includes(key)
}

/**
 * The last hours before the end (the owner, 17.10.2026): 3 hours and 1 hour
 * before the subscription ends. Extra reminders, OFF until switched on.
 */
export const LAST_HOURS_NOTIFICATION_KEYS = ['expires_in_3_hours', 'expires_in_1_hour'] as const

/**
 * Whether a user-notification switch is on. An absent key is ON — the opt-out
 * rule every switch follows — but for the «Возврат покупателя» and last-hours
 * reminders, which are OFF until switched on. The server reads the map the
 * same way (`isDefaultOffNotificationType`).
 */
export function isUserNotificationOn(toggles: Readonly<Record<string, unknown>>, key: string): boolean {
  const value = toggles[key]
  if (value === undefined || value === null) {
    return !isWinbackKey(key) && !(LAST_HOURS_NOTIFICATION_KEYS as readonly string[]).includes(key)
  }
  return value !== false
}

export interface WinbackCleanupConflict {
  /** The fewest days the clean-up may wait for every reminder switched on to arrive. */
  readonly needed: number
  /** What it waits now. */
  readonly graceDays: number
  /** The reminders switched on that would reach nobody, in the order they go out. */
  readonly cutShort: readonly WinbackNotificationKey[]
}

/**
 * The reminders the clean-up would cut short, or `null` when every reminder
 * switched on still finds its subscription: none is on, the clean-up is off,
 * or it waits long enough. A reminder due on the day the profile is deleted is
 * a race the reminder can lose, so the clean-up must wait a day longer.
 */
export function winbackCleanupConflict(
  toggles: Readonly<Record<string, unknown>>,
  policy: CleanupPolicy,
): WinbackCleanupConflict | null {
  if (!policy.deleteEnabled) return null
  const on = WINBACK_NOTIFICATION_KEYS.filter((key) => isUserNotificationOn(toggles, key))
  if (on.length === 0) return null
  const needed = Math.max(...on.map((key) => WINBACK_DAYS[key])) + 1
  if (policy.graceDays >= needed) return null
  return {
    needed,
    graceDays: policy.graceDays,
    cutShort: on.filter((key) => WINBACK_DAYS[key] + 1 > policy.graceDays),
  }
}
