/**
 * The online card's words for numbers and times, and what it remembers.
 *
 * Every expected string is built here with `Intl` directly, in this machine's
 * own zone — the zone the card draws in — so the file holds on any machine,
 * and a helper that went back to the browser's language (the axis once did,
 * with `toLocaleTimeString([], …)`) cannot pass by agreeing with itself.
 */
import type { TFunction } from 'i18next'
import { afterEach, describe, expect, it } from 'vitest'

import {
  axisTicks,
  countryName,
  describeMoment,
  formatAxisTick,
  formatPointLabel,
  formatShare,
  ONLINE_CARD_PREFERENCE_KEY,
  readOnlineCardPreference,
} from './dashboard-online-model'

const local = (month: number, day: number, hour: number, minute = 0): number =>
  new Date(2026, month - 1, day, hour, minute).getTime()

/** Enough of `t` to see which template was chosen and with what. */
const t = ((key: string, vars?: Record<string, unknown>) => `${key}${vars ? ` ${JSON.stringify(vars)}` : ''}`) as unknown as TFunction

afterEach(() => {
  window.localStorage.clear()
})

describe('the x-axis', () => {
  it('labels 24 hours at every fourth hour of the day, and 7 days at each midnight', () => {
    const start = local(9, 17, 12, 30)
    const end = local(9, 18, 12, 34)
    expect(axisTicks('24h', start, end)).toEqual([
      local(9, 17, 16),
      local(9, 17, 20),
      local(9, 18, 0),
      local(9, 18, 4),
      local(9, 18, 8),
      local(9, 18, 12),
    ])
    expect(axisTicks('7d', local(9, 11, 12), local(9, 18, 12, 34))).toEqual([
      local(9, 12, 0),
      local(9, 13, 0),
      local(9, 14, 0),
      local(9, 15, 0),
      local(9, 16, 0),
      local(9, 17, 0),
      local(9, 18, 0),
    ])
    expect(axisTicks('24h', end, start), 'an empty window has no labels').toEqual([])
  })

  it('writes an hour the way the language does — «04:00» in Russian, «4:00 AM» in English — and a day as a date', () => {
    const four = local(9, 18, 4)
    expect(formatAxisTick(four, '24h', 'ru-RU')).toBe('04:00')
    expect(formatAxisTick(four, '24h', 'en-US')).toBe(new Intl.DateTimeFormat('en-US', { timeStyle: 'short' }).format(four))
    expect(formatAxisTick(four, '7d', 'ru-RU')).toBe(new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(four))
  })

  it('heads a week’s point with the hour it covers, not an instant', () => {
    const at = local(9, 12, 17)
    const label = formatPointLabel(at, '7d', 60, 'ru-RU')
    expect(label).toContain('17:00')
    expect(label).toContain('18:00')
    expect(label).toBe(
      new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).formatRange(
        at,
        at + 60 * 60_000,
      ),
    )
    // A day's point is one reading, at one moment.
    expect(formatPointLabel(at, '24h', 5, 'ru-RU')).toBe(
      new Intl.DateTimeFormat('ru-RU', { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(at),
    )
  })
})

describe('when something happened', () => {
  const now = local(9, 18, 12, 34)
  const clock = (at: number) => new Intl.DateTimeFormat('en-US', { timeStyle: 'short' }).format(at)

  it('says today’s time alone, yesterday by name, and a date before that', () => {
    const today = local(9, 18, 0, 5)
    const yesterday = local(9, 17, 23, 50)
    const earlier = local(9, 12, 21, 40)

    expect(describeMoment(new Date(today).toISOString(), now, t, 'en-US')).toBe(
      `dashboardPage.onlineTrend.moment.at ${JSON.stringify({ time: clock(today) })}`,
    )
    expect(describeMoment(new Date(yesterday).toISOString(), now, t, 'en-US')).toBe(
      `dashboardPage.onlineTrend.moment.atDay ${JSON.stringify({ day: 'yesterday', time: clock(yesterday) })}`,
    )
    expect(describeMoment(new Date(earlier).toISOString(), now, t, 'en-US')).toBe(
      `dashboardPage.onlineTrend.moment.atDay ${JSON.stringify({
        day: new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short' }).format(earlier),
        time: clock(earlier),
      })}`,
    )
  })
})

describe('shares and countries', () => {
  it('keeps a decimal under ten per cent, where a whole number would say nothing', () => {
    expect(formatShare(0.052, 'en-US')).toBe('5.2%')
    expect(formatShare(0.47, 'en-US')).toBe('47%')
    expect(formatShare(0, 'en-US')).toBe('0%')
  })

  it('names a country in the interface language, and a node with none as none', () => {
    expect(countryName('DE', 'ru-RU')).toBe(new Intl.DisplayNames(['ru-RU'], { type: 'region' }).of('DE'))
    expect(countryName('DE', 'en-US')).toBe('Germany')
    expect(countryName('', 'en-US')).toBeNull()
  })
})

describe('what the card remembers', () => {
  it('opens on the defaults when nothing, or nonsense, is stored', () => {
    expect(readOnlineCardPreference()).toEqual({ range: '24h', view: 'chart' })
    window.localStorage.setItem(ONLINE_CARD_PREFERENCE_KEY, '{not json')
    expect(readOnlineCardPreference()).toEqual({ range: '24h', view: 'chart' })
    window.localStorage.setItem(ONLINE_CARD_PREFERENCE_KEY, JSON.stringify({ range: '14d', view: 'globe' }))
    expect(readOnlineCardPreference()).toEqual({ range: '24h', view: 'chart' })
    window.localStorage.setItem(ONLINE_CARD_PREFERENCE_KEY, JSON.stringify({ range: '7d', view: 'distribution' }))
    expect(readOnlineCardPreference()).toEqual({ range: '7d', view: 'distribution' })
  })
})
