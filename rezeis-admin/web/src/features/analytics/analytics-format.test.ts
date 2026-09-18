/**
 * The analytics page speaks the panel's language, in numbers too.
 *
 * The owner's screenshot read «RUB 9.7K» under a Russian heading, and `30d` on
 * the period buttons. Every figure here is formatted with the locale the
 * operator chose — asserted for both, with the whitespace `Intl` puts inside
 * («9,7 тыс. ₽» carries no-break spaces) folded to plain spaces.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  formatBucket,
  formatCohortMonth,
  formatCount,
  formatDay,
  formatMoney,
  formatPercent,
  pointDelta,
  relativeDelta,
} from './analytics-format'

const plain = (text: string): string => text.replace(/\s/g, ' ')

describe('money', () => {
  it('reads «9,7 тыс. ₽» to a Russian operator and «₽9.7K» to an English one — never «RUB 9.7K»', () => {
    expect(plain(formatMoney(9700, 'RUB', { compact: true, locale: 'ru-RU' }))).toBe('9,7 тыс. ₽')
    expect(plain(formatMoney(9700, 'RUB', { compact: true, locale: 'en-US' }))).toBe('₽9.7K')
    expect(plain(formatMoney(1_234_567, 'RUB', { compact: true, locale: 'ru-RU' }))).toBe('1,2 млн ₽')
  })

  it('keeps kopecks under 100 and whole roubles above', () => {
    expect(plain(formatMoney(99.5, 'RUB', { locale: 'ru-RU' }))).toBe('99,5 ₽')
    expect(plain(formatMoney(9700.4, 'RUB', { locale: 'ru-RU' }))).toBe('9 700 ₽')
  })

  it('writes a four-letter coin after the number, which Intl cannot format as a currency', () => {
    expect(plain(formatMoney(1234.5, 'USDT', { locale: 'ru-RU' }))).toBe('1 235 USDT')
    expect(plain(formatMoney(12.5, 'USDT', { locale: 'ru-RU' }))).toBe('12,5 USDT')
    expect(plain(formatMoney(12, 'usdt', { locale: 'en-US' }))).toBe('12 USDT')
  })

  it('shows a fraction of a coin by its significant digits, and Stars as whole', () => {
    expect(plain(formatMoney(0.00123, 'BTC', { locale: 'ru-RU' }))).toBe('0,00123 BTC')
    expect(plain(formatMoney(1500, 'XTR', { locale: 'ru-RU' }))).toBe('1 500 XTR')
  })
})

describe('counts and shares', () => {
  it('groups digits the operator’s way and abbreviates only on an axis', () => {
    expect(plain(formatCount(12345, { locale: 'ru-RU' }))).toBe('12 345')
    expect(plain(formatCount(12345, { compact: true, locale: 'ru-RU' }))).toBe('12,3 тыс.')
    expect(formatCount(12345, { compact: true, locale: 'en-US' })).toBe('12.3K')
  })

  it('keeps a decimal under ten percent so a real share never reads 0 %', () => {
    expect(plain(formatPercent(0.004, { locale: 'ru-RU' }))).toBe('0,4 %')
    expect(plain(formatPercent(0.38, { locale: 'ru-RU' }))).toBe('38 %')
    expect(formatPercent(0.38, { locale: 'en-US' })).toBe('38%')
  })
})

describe('change against the previous period', () => {
  it('signs the percentage and calls a rise good for revenue', () => {
    expect(relativeDelta(9700, 8818, { locale: 'ru-RU' })).toEqual({ kind: 'up', text: expect.stringMatching(/^\+10\s%$/), tone: 'good' })
    expect(relativeDelta(30, 40, { locale: 'en-US' })).toEqual({ kind: 'down', text: '-25%', tone: 'bad' })
  })

  it('has no percentage of zero: a first sale is «new», nothing and nothing is «flat»', () => {
    expect(relativeDelta(500, 0).kind).toBe('new')
    expect(relativeDelta(500, 0).tone).toBe('good')
    expect(relativeDelta(0, 0).kind).toBe('flat')
    expect(relativeDelta(null, 10).kind).toBe('none')
  })

  it('measures a rate in percentage points, and a rise in churn is bad news', () => {
    const churnUp = pointDelta(0.125, 0.1, { higherIsBetter: false, locale: 'ru-RU' })
    expect(churnUp).toEqual({ kind: 'up', text: '+2,5', tone: 'bad' })
    expect(pointDelta(0.08, 0.1, { higherIsBetter: false, locale: 'en-US' })).toEqual({ kind: 'down', text: '-2', tone: 'good' })
  })
})

describe('the names of the bars', () => {
  it('a day, a week and a month, in Russian, as the server dates them', () => {
    expect(plain(formatBucket({ from: '2026-09-17', to: '2026-09-17' }, 'day', 'axis', 'ru-RU'))).toBe('17 сент.')
    expect(plain(formatBucket({ from: '2026-09-17', to: '2026-09-17' }, 'day', 'full', 'ru-RU'))).toBe('чт, 17 сентября')
    expect(plain(formatBucket({ from: '2026-06-21', to: '2026-06-27' }, 'week', 'full', 'ru-RU'))).toBe('21–27 июня')
    expect(plain(formatBucket({ from: '2026-02-01', to: '2026-02-28' }, 'month', 'full', 'ru-RU'))).toBe('февраль 2026 г.')
  })

  it('names a month the window only partly covers by its days', () => {
    expect(plain(formatBucket({ from: '2025-09-19', to: '2025-09-30' }, 'month', 'full', 'ru-RU'))).toBe('19–30 сентября')
    expect(plain(formatBucket({ from: '2026-09-01', to: '2026-09-18' }, 'month', 'full', 'en-US'))).toBe('September 1 – 18')
  })
})

describe('the dates of the bars in a browser west of UTC', () => {
  // The server sends local calendar days of the operator's zone as
  // `YYYY-MM-DD`. Read as `new Date('2026-09-18')` — UTC midnight — and
  // formatted in the browser's own zone, a day turns into the one before it
  // anywhere west of Greenwich.
  const hostZone = process.env['TZ']
  beforeAll(() => {
    process.env['TZ'] = 'America/Los_Angeles'
  })
  afterAll(() => {
    if (hostZone === undefined) delete process.env['TZ']
    else process.env['TZ'] = hostZone
  })

  it('names the day the server sent, not the day before it', () => {
    // The trap is live in this process: the naive reading is a day early.
    expect(new Date('2026-09-18').getDate()).toBe(17)
    expect(plain(formatBucket({ from: '2026-09-18', to: '2026-09-18' }, 'day', 'axis', 'ru-RU'))).toBe('18 сент.')
    expect(plain(formatBucket({ from: '2026-09-18', to: '2026-09-18' }, 'day', 'full', 'ru-RU'))).toBe('пт, 18 сентября')
    expect(plain(formatBucket({ from: '2026-09-13', to: '2026-09-19' }, 'week', 'full', 'ru-RU'))).toBe('13–19 сентября')
    expect(plain(formatBucket({ from: '2026-09-01', to: '2026-09-30' }, 'month', 'full', 'ru-RU'))).toBe('сентябрь 2026 г.')
    expect(plain(formatDay('2026-09-01', 'axis', 'ru-RU'))).toBe('1 сент.')
    expect(plain(formatCohortMonth('2026-09', 'ru-RU'))).toBe('сент. 2026 г.')
  })
})
