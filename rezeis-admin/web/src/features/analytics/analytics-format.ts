/**
 * Numbers, money and dates on the analytics page, in the panel's language.
 *
 * The page used to print its own compact money — `RUB 9.7K`, an English
 * abbreviation after a currency code — to a Russian operator, and `30d` on its
 * period buttons. Everything here goes through `Intl` with the locale the
 * operator chose (`activeLocale()`), never the browser's: Russian compact money
 * reads «9,7 тыс. ₽», English «₽9.7K».
 *
 * Money is always formatted WITH its currency: a report states its figures in
 * one currency (see `MoneyView`), and a number without its currency is how the
 * old page came to print 1 000 ₽ + 10 USDT as «1010».
 */
import type { TFunction } from 'i18next'

import { activeLocale } from '@/lib/utils'

import type { AnalyticsBucketLabel, AnalyticsGranularity, CurrencyAmount, PartnerBalanceSpend } from './analytics-api'

/** «к предыдущим 30 дням», or «к предыдущему году» for the year. */
export function comparisonText(t: TFunction, days: number): string {
  return days === 365 ? t('analyticsPage.delta.vsYear') : t('analyticsPage.delta.vsPrevious', { count: days })
}

/** Exact sums in their own currencies: «300 ₽ + 12 USDT». */
export function formatAmounts(amounts: readonly CurrencyAmount[], locale: string = activeLocale()): string {
  return amounts.map((slice) => formatMoney(slice.amount, slice.currency, { locale })).join(' + ')
}

/**
 * The line beside revenue for purchases paid from a partner's balance — money
 * the panel counted once already, when the partner's referral paid:
 * «Оплачено балансом партнёра — не выручка: 300 ₽ · 1 платёж». `null` when there were none.
 */
export function partnerBalanceText(t: TFunction, spend: PartnerBalanceSpend): string | null {
  if (spend.payments === 0) return null
  return t('analyticsPage.partnerBalance.line', {
    amount: formatAmounts(spend.figure.byCurrency),
    payments: t('analyticsPage.partnerBalance.payments', { count: spend.payments }),
  })
}

/** A payment system's name; a type this panel does not know yet is shown as the server spells it. */
export function gatewayName(t: TFunction, gatewayType: string): string {
  return t(`analyticsPage.gateways.${gatewayType}`, { defaultValue: gatewayType })
}

/** Currencies with kopecks and cents: whole units from 100 up, two decimals below. */
const FIAT = new Set(['RUB', 'USD', 'EUR', 'KZT', 'UAH', 'BYN', 'TRY', 'CNY', 'GBP'])
/** Telegram Stars have no fractions. */
const WHOLE = new Set(['XTR'])

const ISO_CURRENCY = /^[A-Z]{3}$/

/**
 * Whether `Intl` can format `code` as a currency. USDT, USDC and DASH have four
 * letters and are refused by `Intl` outright (`RangeError: Invalid currency
 * code`); those get the number and the code written after it.
 */
function isIntlCurrency(code: string): boolean {
  return ISO_CURRENCY.test(code)
}

function fractionDigits(currency: string, abs: number): Intl.NumberFormatOptions {
  if (WHOLE.has(currency)) return { minimumFractionDigits: 0, maximumFractionDigits: 0 }
  if (abs >= 100 || abs === 0) return { minimumFractionDigits: 0, maximumFractionDigits: 0 }
  if (FIAT.has(currency) || abs >= 1) return { minimumFractionDigits: 0, maximumFractionDigits: 2 }
  // A fraction of a coin: significant digits, or 0.0012 BTC prints as 0.
  return { minimumSignificantDigits: 1, maximumSignificantDigits: 3 }
}

export interface MoneyFormatOptions {
  /** «9,7 тыс. ₽» instead of «9 700 ₽». */
  readonly compact?: boolean
  readonly locale?: string
}

/** `value` of `currency` in the operator's language. */
export function formatMoney(value: number, currency: string, options: MoneyFormatOptions = {}): string {
  const locale = options.locale ?? activeLocale()
  const code = currency.toUpperCase()
  const abs = Math.abs(value)
  const digits: Intl.NumberFormatOptions =
    options.compact && abs >= 1000
      ? { notation: 'compact', minimumFractionDigits: 0, maximumFractionDigits: 1 }
      : fractionDigits(code, abs)
  if (isIntlCurrency(code)) {
    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: code,
        currencyDisplay: 'narrowSymbol',
        ...digits,
      }).format(value)
    } catch {
      // An engine without `narrowSymbol` falls through to the plain form.
    }
  }
  return `${new Intl.NumberFormat(locale, digits).format(value)}\xa0${code}`
}

/** A count: «12 345», or compact «12 тыс.» for an axis. */
export function formatCount(value: number, options: { readonly compact?: boolean; readonly locale?: string } = {}): string {
  const locale = options.locale ?? activeLocale()
  return new Intl.NumberFormat(
    locale,
    options.compact && Math.abs(value) >= 1000
      ? { notation: 'compact', maximumFractionDigits: 1 }
      : { maximumFractionDigits: 0 },
  ).format(value)
}

/** A share (0–1) as a percentage: «12,3 %». Under one percent keeps a decimal so a real share never reads «0 %». */
export function formatPercent(ratio: number, options: { readonly digits?: number; readonly locale?: string } = {}): string {
  const locale = options.locale ?? activeLocale()
  const digits = options.digits ?? (Math.abs(ratio) < 0.1 ? 1 : 0)
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: digits }).format(ratio)
}

/** A number of days with at most one decimal: «4,5». */
export function formatDays(days: number, locale: string = activeLocale()): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(days)
}

// ── Change against the previous period ──────────────────────────────────────

export type DeltaTone = 'good' | 'bad' | 'neutral'

export interface Delta {
  /**
   * `up`/`down` with a percentage; `flat` when nothing changed; `new` when the
   * previous period had none (no percentage can be taken of zero); `none` when
   * either side is unknown.
   */
  readonly kind: 'up' | 'down' | 'flat' | 'new' | 'none'
  readonly text: string
  readonly tone: DeltaTone
}

const NO_DELTA: Delta = { kind: 'none', text: '', tone: 'neutral' }

function toneOf(kind: Delta['kind'], higherIsBetter: boolean): DeltaTone {
  if (kind === 'up' || kind === 'new') return higherIsBetter ? 'good' : 'bad'
  if (kind === 'down') return higherIsBetter ? 'bad' : 'good'
  return 'neutral'
}

/** The relative change of a quantity: «+12 %», «−3,5 %». */
export function relativeDelta(
  current: number | null,
  previous: number | null,
  options: { readonly higherIsBetter?: boolean; readonly locale?: string } = {},
): Delta {
  if (current === null || previous === null || !Number.isFinite(current) || !Number.isFinite(previous)) return NO_DELTA
  const higherIsBetter = options.higherIsBetter ?? true
  if (previous === 0) {
    if (current === 0) return { kind: 'flat', text: '', tone: 'neutral' }
    const kind = current > 0 ? 'new' : 'down'
    return { kind, text: '', tone: toneOf(kind, higherIsBetter) }
  }
  const ratio = (current - previous) / Math.abs(previous)
  if (Math.abs(ratio) < 0.0005) return { kind: 'flat', text: '', tone: 'neutral' }
  const kind = ratio > 0 ? 'up' : 'down'
  const text = new Intl.NumberFormat(options.locale ?? activeLocale(), {
    style: 'percent',
    signDisplay: 'exceptZero',
    maximumFractionDigits: Math.abs(ratio) < 0.1 ? 1 : 0,
  }).format(ratio)
  return { kind, text, tone: toneOf(kind, higherIsBetter) }
}

/**
 * The change of a RATE in percentage points: 10 % → 12,5 % is «+2,5», not
 * «+25 %». The caller adds the unit (п. п. / pp) from the dictionary.
 */
export function pointDelta(
  current: number | null,
  previous: number | null,
  options: { readonly higherIsBetter?: boolean; readonly locale?: string } = {},
): Delta {
  if (current === null || previous === null) return NO_DELTA
  const points = (current - previous) * 100
  if (Math.abs(points) < 0.05) return { kind: 'flat', text: '', tone: 'neutral' }
  const kind = points > 0 ? 'up' : 'down'
  const text = new Intl.NumberFormat(options.locale ?? activeLocale(), {
    signDisplay: 'exceptZero',
    maximumFractionDigits: 1,
  }).format(points)
  return { kind, text, tone: toneOf(kind, options.higherIsBetter ?? true) }
}

// ── Dates of the bars ───────────────────────────────────────────────────────

/** A `YYYY-MM-DD` UTC day as the instant of its midnight. */
export function utcDay(key: string): Date {
  return new Date(`${key}T00:00:00Z`)
}

function isWholeMonth(bucket: AnalyticsBucketLabel): boolean {
  const from = utcDay(bucket.from)
  const to = utcDay(bucket.to)
  const nextDay = new Date(to.getTime() + 86_400_000)
  return from.getUTCDate() === 1 && nextDay.getUTCDate() === 1
}

/**
 * A bar's name. `axis`: short enough to sit under a bar («17 сент.», «июн.»);
 * `full`: what the tooltip heads with («чт, 17 сентября», «17–23 июня»,
 * «сентябрь 2026 г.», or the days of a month the window only partly covers).
 */
export function formatBucket(
  bucket: AnalyticsBucketLabel,
  granularity: AnalyticsGranularity,
  style: 'axis' | 'full',
  locale: string = activeLocale(),
): string {
  const from = utcDay(bucket.from)
  const to = utcDay(bucket.to)
  const utc = { timeZone: 'UTC' } as const
  if (granularity === 'day') {
    return style === 'axis'
      ? new Intl.DateTimeFormat(locale, { ...utc, day: 'numeric', month: 'short' }).format(from)
      : new Intl.DateTimeFormat(locale, { ...utc, weekday: 'short', day: 'numeric', month: 'long' }).format(from)
  }
  if (granularity === 'month' && (style === 'axis' || isWholeMonth(bucket))) {
    return style === 'axis'
      ? new Intl.DateTimeFormat(locale, { ...utc, month: 'short' }).format(from)
      : new Intl.DateTimeFormat(locale, { ...utc, month: 'long', year: 'numeric' }).format(from)
  }
  if (style === 'axis') return new Intl.DateTimeFormat(locale, { ...utc, day: 'numeric', month: 'short' }).format(from)
  if (bucket.from === bucket.to) return new Intl.DateTimeFormat(locale, { ...utc, day: 'numeric', month: 'long' }).format(from)
  return new Intl.DateTimeFormat(locale, { ...utc, day: 'numeric', month: 'long' }).formatRange(from, to)
}

/** A calendar day of the coming month («пт, 19 сент.»), from its `YYYY-MM-DD`. */
export function formatDay(key: string, style: 'axis' | 'full', locale: string = activeLocale()): string {
  return new Intl.DateTimeFormat(
    locale,
    style === 'axis'
      ? { timeZone: 'UTC', day: 'numeric', month: 'short' }
      : { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'long' },
  ).format(utcDay(key))
}

/** A cohort's `YYYY-MM` as «сент. 2026». */
export function formatCohortMonth(key: string, locale: string = activeLocale()): string {
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', month: 'short', year: 'numeric' }).format(utcDay(`${key}-01`))
}

/** An instant as a local calendar date: «18 сент.». */
export function formatShortDate(iso: string, locale: string = activeLocale()): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(date)
}
