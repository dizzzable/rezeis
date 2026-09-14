/**
 * The panel's date helpers run WHILE RENDERING, so they must never throw.
 *
 * `Intl.DateTimeFormat#format` throws `RangeError: Invalid time value` on an
 * invalid date, and one missing timestamp handed to it took the whole
 * Automations page down through the route's error boundary (panel 0.9.7.56).
 * A missing or malformed date is one cell's problem: it renders as a dash.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { i18n } from '@/i18n/i18n'
import { formatDate, formatDateTime } from './utils'

const INSTANT = '2026-09-14T09:30:00.000Z'

const DATE_OPTIONS: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' }
const DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  ...DATE_OPTIONS,
  hour: '2-digit',
  minute: '2-digit',
}

const NOT_A_DATE: ReadonlyArray<readonly [string, string | Date | null | undefined]> = [
  ['undefined', undefined],
  ['null', null],
  ['an empty string', ''],
  ['words', 'not a date'],
  ['an invalid Date', new Date('nope')],
]

describe.each([
  ['formatDate', formatDate, DATE_OPTIONS],
  ['formatDateTime', formatDateTime, DATE_TIME_OPTIONS],
] as const)('%s', (_name, format, options) => {
  let languageBefore: string

  beforeAll(() => {
    languageBefore = i18n.language
  })

  afterAll(async () => {
    await i18n.changeLanguage(languageBefore)
  })

  it.each(NOT_A_DATE)('renders a dash for %s instead of throwing', (_label, value) => {
    expect(() => format(value)).not.toThrow()
    expect(format(value)).toBe('—')
  })

  it.each([
    ['ru', 'ru-RU'],
    ['en', 'en-US'],
  ] as const)('formats a real date exactly as before in %s', async (language, locale) => {
    await i18n.changeLanguage(language)
    const expected = new Intl.DateTimeFormat(locale, options).format(new Date(INSTANT))

    expect(format(INSTANT)).toBe(expected)
    expect(format(new Date(INSTANT))).toBe(expected)
    expect(expected).toContain('2026')
  })

  it("follows the operator's language, not the browser's", async () => {
    await i18n.changeLanguage('ru')
    expect(format(INSTANT)).toMatch(/сент/)
    await i18n.changeLanguage('en')
    expect(format(INSTANT)).toMatch(/Sep/)
  })
})
