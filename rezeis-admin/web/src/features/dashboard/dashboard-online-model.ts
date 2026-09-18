/**
 * What the «Онлайн пользователей» card and its «Ноды и страны» side share:
 * numbers, times and country names in the language of the interface, and the
 * window and side this browser last looked at.
 *
 * `activeLocale()`, never a bare `toLocaleString()`: the bare one follows the
 * BROWSER, so a Russian panel in an English browser printed «4:00 PM» under a
 * Russian heading — which is what the chart's axis did before this card was
 * rebuilt (`toLocaleTimeString([], …)`).
 */
import type { TFunction } from 'i18next'

import { activeLocale } from '@/lib/utils'

import { ONLINE_RANGES, type OnlineRange } from './dashboard-api'

/** The green the card has always drawn online in — the subscription ring's «active» too. */
export const ONLINE_COLOR = 'hsl(142, 71%, 45%)'

/** Both sides refetch once a minute while the dashboard is in front, as the card always has. */
export const ONLINE_REFETCH_MS = 60_000

export type OnlineCardView = 'chart' | 'distribution'

export interface OnlineCardPreference {
  readonly range: OnlineRange
  readonly view: OnlineCardView
}

/** Per browser: the window and the side of the card this operator left it on. */
export const ONLINE_CARD_PREFERENCE_KEY = 'rezeis.dashboard.onlineCard'

const DEFAULT_PREFERENCE: OnlineCardPreference = { range: '24h', view: 'chart' }

/**
 * `localStorage` can throw (Safari private mode, a locked-down webview) or hold
 * anything at all; either way the card opens on its defaults rather than not at
 * all.
 */
export function readOnlineCardPreference(): OnlineCardPreference {
  try {
    const raw = window.localStorage.getItem(ONLINE_CARD_PREFERENCE_KEY)
    if (raw === null) return DEFAULT_PREFERENCE
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_PREFERENCE
    const { range, view } = parsed as Record<string, unknown>
    return {
      range: ONLINE_RANGES.find((known) => known === range) ?? DEFAULT_PREFERENCE.range,
      view: view === 'distribution' ? 'distribution' : 'chart',
    }
  } catch {
    return DEFAULT_PREFERENCE
  }
}

export function writeOnlineCardPreference(preference: OnlineCardPreference): void {
  try {
    window.localStorage.setItem(ONLINE_CARD_PREFERENCE_KEY, JSON.stringify(preference))
  } catch {
    // Unwritable storage: the choice holds for this visit and is simply not remembered.
  }
}

export function formatCount(value: number, locale = activeLocale()): string {
  return new Intl.NumberFormat(locale).format(value)
}

/** A share of the node total: one decimal below 10 %, where a whole number would say 0 %. */
export function formatShare(share: number, locale = activeLocale()): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: share > 0 && share < 0.1 ? 1 : 0,
  }).format(share)
}

/**
 * A clock time the way the language writes it: «04:00» in Russian, «4:00 AM»
 * in English. Read off the locale's own short time format — asking for
 * `hour: 'numeric'` outright printed «4:00» on a Russian axis.
 */
function clockOptions(locale: string): Intl.DateTimeFormatOptions {
  const hour = new Intl.DateTimeFormat(locale, { timeStyle: 'short' })
    .formatToParts(new Date(2000, 0, 1, 4))
    .find((part) => part.type === 'hour')?.value
  return { hour: hour !== undefined && hour.length === 2 ? '2-digit' : 'numeric', minute: '2-digit' }
}

function startOfDay(at: number, daysBack = 0): number {
  const day = new Date(at)
  day.setHours(0, 0, 0, 0)
  day.setDate(day.getDate() - daysBack)
  return day.getTime()
}

/**
 * When something happened, as a person would say it: «в 21:40» today, «вчера в
 * 21:40», «12 сент. в 21:40» before that. `now` is the server's clock at the
 * answer (`generatedAt`), the clock every time in the answer was stamped by.
 */
export function describeMoment(iso: string, now: number, t: TFunction, locale = activeLocale()): string {
  const at = Date.parse(iso)
  const time = new Intl.DateTimeFormat(locale, clockOptions(locale)).format(at)
  if (at >= startOfDay(now)) return t('dashboardPage.onlineTrend.moment.at', { time })
  const day =
    at >= startOfDay(now, 1)
      ? new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-1, 'day')
      : new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(at)
  return t('dashboardPage.onlineTrend.moment.atDay', { day, time })
}

/** The x-axis label of one tick: an hour of the day for 24 hours, a date for 7 days. */
export function formatAxisTick(at: number, range: OnlineRange, locale = activeLocale()): string {
  return new Intl.DateTimeFormat(
    locale,
    range === '24h' ? clockOptions(locale) : { day: 'numeric', month: 'short' },
  ).format(at)
}

/**
 * The tooltip's heading for one point. A 7-day point is an HOUR — the highest
 * reading in it — so it is labelled as the hour it covers, «сб, 12 сент.,
 * 17:00–18:00», not as an instant it was never measured at.
 */
export function formatPointLabel(at: number, range: OnlineRange, bucketMinutes: number, locale = activeLocale()): string {
  if (range === '24h') {
    return new Intl.DateTimeFormat(locale, { weekday: 'short', ...clockOptions(locale) }).format(at)
  }
  const format = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...clockOptions(locale),
  })
  return format.formatRange(at, at + bucketMinutes * 60_000)
}

/**
 * Where the x-axis puts its labels, in the operator's own time: every fourth
 * hour for 24 hours, each midnight for 7 days. Stepped by the calendar rather
 * than by adding milliseconds, so a daylight-saving change does not slide every
 * later label off the hour.
 */
export function axisTicks(range: OnlineRange, start: number, end: number): number[] {
  const ticks: number[] = []
  if (!(end > start)) return ticks
  const cursor = new Date(start)
  if (range === '24h') {
    cursor.setMinutes(0, 0, 0)
    while (cursor.getTime() < start || cursor.getHours() % 4 !== 0) cursor.setHours(cursor.getHours() + 1)
    while (cursor.getTime() <= end) {
      ticks.push(cursor.getTime())
      cursor.setHours(cursor.getHours() + 4)
    }
    return ticks
  }
  cursor.setHours(24, 0, 0, 0)
  while (cursor.getTime() <= end) {
    ticks.push(cursor.getTime())
    cursor.setDate(cursor.getDate() + 1)
  }
  return ticks
}

/**
 * The country's name in the interface language (`Intl.DisplayNames`), or
 * `null` for a node without one. A code the runtime has no name for comes back
 * as itself, which is still more than nothing.
 */
export function countryName(code: string, locale = activeLocale()): string | null {
  if (!/^[A-Z]{2}$/.test(code)) return null
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}
