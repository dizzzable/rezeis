/**
 * The Payments list's filters, and the three things that must agree about them.
 *
 * ── The address bar is the state ────────────────────────────────────────────
 *
 * The filters lived in `useState`, so nothing could link INTO a filtered list:
 * the user card had no way to say "this client's payments", Cmd+K opened the
 * whole ledger for a single payment, and a filtered view could not be pasted to
 * a colleague. They are read from the URL now, and every change is written back
 * to it — one source, so a link someone pasted and a filter someone clicked
 * produce the same request.
 *
 * ── A value this page does not understand is SENT, not dropped ─────────────
 *
 * `status=PAID` or `userId=12345` in a pasted link is passed to the API as-is,
 * and the API answers 400 naming the field (`ListTransactionsQueryDto`). The
 * page shows that answer. Quietly ignoring it instead would render the whole
 * ledger under a link that promised one customer — the failure the backend's
 * loud 400 exists to prevent, recreated one layer up.
 *
 * ── UI keys and API keys are different sets ────────────────────────────────
 *
 * `payment` (which payment's details are open) and `page` belong to the address
 * bar only. The API forbids unknown parameters, so {@link filtersToApiParams}
 * builds its request from the filter fields alone and can never forward them.
 */

export const PAYMENT_STATUSES = ['COMPLETED', 'PENDING', 'FAILED', 'CANCELED', 'REFUNDED'] as const
export const PURCHASE_TYPES = ['NEW', 'RENEW', 'UPGRADE', 'ADDITIONAL'] as const

/** URL key of the open payment details sheet: a paymentId, gatewayId or record id. */
export const OPEN_PAYMENT_PARAM = 'payment'

export interface PaymentsFilters {
  /** One payment reference — our paymentId, the payment system's id, or the record id. */
  readonly q: string
  /** Free-text customer search: Telegram id, email, username or user id. */
  readonly userSearch: string
  /** One customer, by `User.id` — what the user card links with. */
  readonly userId: string
  /** One subscription, by `Subscription.id` — what the subscriptions page links with. */
  readonly subscriptionId: string
  readonly status: string
  readonly gatewayType: string
  readonly purchaseType: string
  /** A calendar day, `YYYY-MM-DD`, in the operator's own time zone. */
  readonly dateFrom: string
  readonly dateTo: string
  /** 1-based, as it reads in the address bar. */
  readonly page: string
}

const FILTER_KEYS = [
  'q',
  'userSearch',
  'userId',
  'subscriptionId',
  'status',
  'gatewayType',
  'purchaseType',
  'dateFrom',
  'dateTo',
  'page',
] as const satisfies ReadonlyArray<keyof PaymentsFilters>

export const EMPTY_PAYMENTS_FILTERS: PaymentsFilters = {
  q: '',
  userSearch: '',
  userId: '',
  subscriptionId: '',
  status: '',
  gatewayType: '',
  purchaseType: '',
  dateFrom: '',
  dateTo: '',
  page: '',
}

/** Reads the filters out of the address bar. An absent key is an unset filter. */
export function filtersFromSearchParams(params: URLSearchParams): PaymentsFilters {
  const read = (key: keyof PaymentsFilters): string => params.get(key)?.trim() ?? ''
  return {
    q: read('q'),
    userSearch: read('userSearch'),
    userId: read('userId'),
    subscriptionId: read('subscriptionId'),
    status: read('status'),
    gatewayType: read('gatewayType'),
    purchaseType: read('purchaseType'),
    dateFrom: read('dateFrom'),
    dateTo: read('dateTo'),
    page: read('page'),
  }
}

/**
 * Writes `filters` into a copy of `current`, leaving every key that is not a
 * filter — the open payment, anything a later feature adds — where it was.
 */
export function withFilters(current: URLSearchParams, filters: PaymentsFilters): URLSearchParams {
  const next = new URLSearchParams(current)
  for (const key of FILTER_KEYS) {
    const value = filters[key]
    if (value === '' || (key === 'page' && value === '1')) next.delete(key)
    else next.set(key, value)
  }
  return next
}

/** Whether any filter narrows the list — the "reset" link shows only then. */
export function hasActiveFilters(filters: PaymentsFilters): boolean {
  return FILTER_KEYS.some((key) => key !== 'page' && filters[key] !== '')
}

/** The 0-based page the list is on. A malformed `page` is sent on, see `filtersToApiParams`. */
export function pageIndex(filters: PaymentsFilters): number {
  if (filters.page === '') return 0
  const page = Number(filters.page)
  return Number.isInteger(page) && page >= 1 ? page - 1 : Number.NaN
}

/**
 * The request for `GET /admin/payments/transactions`.
 *
 * A day from the date pickers becomes an instant at the operator's local
 * midnight (from) or last millisecond (to), which is what the pickers mean. A
 * value that is not a day is forwarded unchanged so the API refuses it by name.
 */
export function filtersToApiParams(filters: PaymentsFilters, limit: number): URLSearchParams {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  const index = pageIndex(filters)
  params.set('offset', Number.isNaN(index) ? filters.page : String(index * limit))
  if (filters.q !== '') params.set('q', filters.q)
  if (filters.userSearch !== '') params.set('userSearch', filters.userSearch)
  if (filters.userId !== '') params.set('userId', filters.userId)
  if (filters.subscriptionId !== '') params.set('subscriptionId', filters.subscriptionId)
  if (filters.status !== '') params.set('status', filters.status)
  if (filters.gatewayType !== '') params.set('gatewayType', filters.gatewayType)
  if (filters.purchaseType !== '') params.set('purchaseType', filters.purchaseType)
  if (filters.dateFrom !== '') params.set('dateFrom', dayToInstant(filters.dateFrom, 'start'))
  if (filters.dateTo !== '') params.set('dateTo', dayToInstant(filters.dateTo, 'end'))
  return params
}

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

/** `YYYY-MM-DD` → a local `Date`, or `undefined` for anything else. */
export function dayToDate(day: string): Date | undefined {
  const match = DAY_PATTERN.exec(day)
  if (match === null) return undefined
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  // `new Date(2026, 1, 31)` quietly rolls over to 3 March; that is not the day asked for.
  return date.getDate() === Number(match[3]) ? date : undefined
}

/** A local `Date` → `YYYY-MM-DD` in the operator's time zone. */
export function dateToDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function dayToInstant(day: string, edge: 'start' | 'end'): string {
  const date = dayToDate(day)
  if (date === undefined) return day
  if (edge === 'end') date.setHours(23, 59, 59, 999)
  return date.toISOString()
}

/** The link that opens the Payments page on one customer's payments. */
export function clientPaymentsHref(userId: string): string {
  return `/payments?${new URLSearchParams({ userId }).toString()}`
}

/** The link that opens the Payments page on one subscription's payments. */
export function subscriptionPaymentsHref(subscriptionId: string): string {
  return `/payments?${new URLSearchParams({ subscriptionId }).toString()}`
}

/** The link that opens one payment's details. */
export function paymentHref(reference: string): string {
  return `/payments?${new URLSearchParams({ [OPEN_PAYMENT_PARAM]: reference }).toString()}`
}
