/**
 * The shapes the Payments page reads off the wire, and the pure decisions made
 * about them — kept apart from the components so the details sheet and the
 * list share one definition of a row, and so the decisions can be tested
 * without rendering anything.
 */

/** A row of `GET /admin/payments/transactions` (`AdminPaymentTransactionListItemInterface`). */
export interface TransactionRow {
  readonly id: string
  readonly paymentId: string
  readonly userId: string
  readonly userTelegramId?: string | null
  readonly userUsername?: string | null
  readonly userName?: string | null
  readonly userEmail?: string | null
  readonly subscriptionId?: string | null
  /** Subscriptions a combined renewal pays for; its own `subscriptionId` is null. */
  readonly lineItemSubscriptionIds?: readonly string[]
  readonly status: string
  readonly purchaseType: string
  readonly channel?: string | null
  readonly gatewayType: string
  /** The payment system's own id. Null until the gateway has answered the checkout. */
  readonly gatewayId?: string | null
  readonly currency: string
  readonly amount: string | number | null
  readonly paymentAsset?: string | null
  readonly planSnapshot?: unknown
  readonly createdAt: string
  readonly updatedAt?: string | null
  readonly fulfilledAt?: string | null
  /**
   * Set for a payment withheld for refund — a trial's conversion received
   * after another payment had converted the trial, an autopay charge after a
   * refund, a renewal or an upgrade of a subscription with no end date:
   * COMPLETED and stamped delivered, yet applied to nothing, and its money due
   * back to the payer (`payment.withheld`). Null for every other payment;
   * absent from a server older than the mark.
   */
  readonly conversionWithheld?: WithheldConversion | null
}

/** `WithheldConversionMark` on the server. */
export interface WithheldConversion {
  /** Why: a trial's second conversion, or an autopay charge after a refund. Absent for any later reason. */
  readonly reason?: 'TRIAL_ALREADY_CONVERTED' | 'AUTOPAY_AFTER_REFUND'
  /** A renewal or an upgrade of a subscription that has no end date; comes without `reason`. */
  readonly lifetimeSubscription?: boolean
  /** When fulfilment withheld it. */
  readonly withheldAt: string
  /** The payment that converted the trial first. */
  readonly convertedByPaymentId: string | null
  /** When its refund was recorded, by an operator or by the provider; null while the money is still held. */
  readonly refundedAt: string | null
}

export interface TransactionsList {
  readonly items: ReadonlyArray<TransactionRow>
  readonly total: number
}

/** A row of `GET /admin/payments/webhooks/events` (`AdminPaymentWebhookEventListItemInterface`). */
export interface WebhookEventRow {
  readonly id: string
  readonly gatewayType: string
  /** Our `paymentId` — or, for a few gateways' refund notices, the payment system's id. */
  readonly paymentId: string
  readonly providerEventId: string | null
  /** The provider's own status string, before normalisation. */
  readonly eventStatus?: string | null
  readonly status: string
  readonly receivedAt: string
  readonly processedAt?: string | null
  /** Why the last reconciliation attempt gave up; shown before a replay. */
  readonly lastError?: string | null
}

/**
 * Reads a list response, refusing anything that is not one.
 *
 * `items` is iterated and `total` is printed; an HTML page served with 200 by a
 * stale proxy has neither, and has to become the error branch rather than a
 * TypeError inside a table.
 */
export function readTransactionsList(body: unknown): TransactionsList {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null
  if (record === null || !Array.isArray(record['items']) || typeof record['total'] !== 'number') {
    throw new Error('The payments list answered with something that is not a list.')
  }
  return { items: record['items'] as TransactionRow[], total: record['total'] }
}

export type PaymentResolution =
  | { readonly kind: 'found'; readonly transaction: TransactionRow }
  | { readonly kind: 'ambiguous'; readonly count: number }
  | { readonly kind: 'missing' }

/**
 * An imported payment's id: the importer's namespace, then the donor
 * platform's own number (`bedolaga:4821`). The cabinet shows the subscriber
 * only the number, so that is what a support request quotes.
 */
const IMPORTED_PAYMENT_ID = /^[a-z][a-z0-9]*:(.+)$/

/**
 * Which payment `reference` names among the rows `q` returned.
 *
 * Our paymentId, then the record id — both unique. Otherwise the payment
 * system's id, or an imported payment's number as the cabinet shows it — each
 * only when exactly one row carries it: two payment systems can issue the same
 * id, two donor platforms the same number, and naming one of them would be a
 * guess.
 */
export function resolvePayment(items: ReadonlyArray<TransactionRow>, reference: string): PaymentResolution {
  const exact =
    items.find((item) => item.paymentId === reference) ?? items.find((item) => item.id === reference)
  if (exact !== undefined) return { kind: 'found', transaction: exact }
  const candidates = [
    ...new Set(
      items.filter(
        (item) =>
          item.gatewayId === reference || IMPORTED_PAYMENT_ID.exec(item.paymentId)?.[1] === reference,
      ),
    ),
  ]
  if (candidates.length === 1 && candidates[0] !== undefined) {
    return { kind: 'found', transaction: candidates[0] }
  }
  if (candidates.length > 1) return { kind: 'ambiguous', count: candidates.length }
  return { kind: 'missing' }
}

/**
 * Every payment system by the name the Gateways page gives it
 * (`gateway-settings-page.tsx`, `GATEWAY_META`). `PARTNER_BALANCE` is not a
 * brand but our own wallet, so its name is translated
 * (`paymentsPage.gateways.PARTNER_BALANCE`) and is not listed here.
 * `payment-records.test.ts` holds this against `enum PaymentGatewayType`.
 */
export const GATEWAY_LABELS: Readonly<Record<string, string>> = {
  TELEGRAM_STARS: 'Telegram Stars',
  YOOKASSA: 'YooKassa',
  PLATEGA: 'Platega',
  HELEKET: 'Heleket',
  CRYPTOMUS: 'Cryptomus',
  MULENPAY: 'MulenPay',
  ANTILOPAY: 'Antilopay',
  OVERPAY: 'OverPay',
  PAYPALYCH: 'PayPalych',
  RIOPAY: 'RioPay',
  VALUTIX: 'Valutix',
  WATA: 'WATA',
  AURAPAY: 'AuraPay',
  ROLLYPAY: 'RollyPay',
  SEVERPAY: 'SeverPay',
  LAVA: 'Lava.top',
  CRYPTOPAY: 'CryptoPay',
}

/** The wallet method, the one gateway whose name is a phrase. */
export const PARTNER_BALANCE_GATEWAY = 'PARTNER_BALANCE'

/** A payment system by name: the brand as the Gateways page writes it, our wallet translated. */
export function gatewayLabel(type: string, t: (key: string) => string): string {
  if (type === PARTNER_BALANCE_GATEWAY) return t('paymentsPage.gateways.PARTNER_BALANCE')
  return GATEWAY_LABELS[type] ?? type
}

/** Currencies with kopecks and cents: always two decimals. */
const FIAT = new Set(['RUB', 'USD', 'EUR', 'KZT', 'UAH', 'BYN', 'TRY', 'CNY', 'GBP'])
/** The amount column's scale, `Decimal(20, 8)`: no amount has more decimals. */
const AMOUNT_SCALE = 8

/**
 * How many decimals `raw` carries. Prisma's Decimal writes very small values
 * in exponent form (`1e-8`), so the exponent counts too.
 */
function decimalsOf(raw: string): number {
  const match = /^-?\d*(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(raw.trim())
  if (match === null) return 0
  const fraction = match[1]?.length ?? 0
  const exponent = match[2] === undefined ? 0 : Number(match[2])
  return Math.min(AMOUNT_SCALE, Math.max(0, fraction - exponent))
}

/**
 * An amount exactly as stored, in the operator's language and in its currency.
 *
 * Never rounded: an operator reconciling a payment against the provider needs
 * `1 500,50 ₽`, not the `1 501 ₽` a report may print. Fiat keeps its two
 * decimals; a coin or Telegram Stars show the decimals the amount has. A code
 * `Intl` refuses as a currency (USDT, USDC, DASH have four letters) gets the
 * number and the code after it.
 */
export function formatPaymentAmount(
  amount: string | number | null | undefined,
  currency: string,
  locale: string,
): string {
  if (amount === null || amount === undefined || amount === '') return '—'
  const value = typeof amount === 'number' ? amount : Number(amount)
  if (!Number.isFinite(value)) return `${String(amount)} ${currency}`
  const code = currency.toUpperCase()
  const decimals = decimalsOf(String(amount))
  const fraction = FIAT.has(code)
    ? { minimumFractionDigits: 2, maximumFractionDigits: Math.max(2, decimals) }
    : { minimumFractionDigits: 0, maximumFractionDigits: decimals }
  if (/^[A-Z]{3}$/.test(code)) {
    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: code,
        currencyDisplay: 'narrowSymbol',
        ...fraction,
      }).format(value)
    } catch {
      // An engine without `narrowSymbol` falls through to the plain form.
    }
  }
  return `${new Intl.NumberFormat(locale, fraction).format(value)}\xa0${code}`
}

/**
 * The platform an imported payment came from (`planSnapshot.importedFrom`,
 * written by every importer that brings payments over), or `null` for one
 * made here.
 */
export function importedFrom(planSnapshot: unknown): string | null {
  if (typeof planSnapshot !== 'object' || planSnapshot === null || Array.isArray(planSnapshot)) return null
  const source = (planSnapshot as Record<string, unknown>)['importedFrom']
  return typeof source === 'string' && source.length > 0 ? source : null
}

/** The donor platforms by the names the Imports page uses. */
const IMPORT_SOURCE_NAMES: Readonly<Record<string, string>> = {
  altshop: 'Altshop',
  bedolaga: 'Bedolaga',
  remnashop: 'Remnashop',
  stealthnet: 'StealthNet',
}

export function importSourceName(source: string): string {
  return IMPORT_SOURCE_NAMES[source] ?? source
}

/**
 * What can truthfully be said about delivering the purchase.
 *
 * `fulfilledAt` is the stamp the fulfilment writes. Its absence means
 * different things: a pending payment will be delivered once paid; a failed
 * or cancelled one never is; and a completed one without the stamp is either
 * an import the importer did not stamp (Remnashop, Altshop and StealthNet do
 * not) or simply unrecorded. «Ещё нет» for all four was false for three.
 */
export type DeliveryState =
  | { readonly kind: 'delivered'; readonly at: string }
  | { readonly kind: 'withheld' }
  | { readonly kind: 'notDelivered' }
  | { readonly kind: 'noStampImported'; readonly source: string }
  | { readonly kind: 'awaitingPayment' }
  | { readonly kind: 'noStamp' }

export function describeDelivery(
  transaction: Pick<TransactionRow, 'fulfilledAt' | 'status' | 'planSnapshot' | 'conversionWithheld'>,
): DeliveryState {
  // Stamped like a delivery so the payment counts as settled, yet nothing was
  // delivered: the trial it paid to convert had been converted already.
  if (transaction.conversionWithheld) return { kind: 'withheld' }
  if (transaction.fulfilledAt) return { kind: 'delivered', at: transaction.fulfilledAt }
  if (transaction.status === 'FAILED' || transaction.status === 'CANCELED') return { kind: 'notDelivered' }
  const source = importedFrom(transaction.planSnapshot)
  if (source !== null) return { kind: 'noStampImported', source }
  if (transaction.status === 'PENDING') return { kind: 'awaitingPayment' }
  return { kind: 'noStamp' }
}

/** Both answers as one list: each event once, newest first. */
export function mergeEvents(
  ...lists: ReadonlyArray<ReadonlyArray<WebhookEventRow>>
): WebhookEventRow[] {
  const byId = new Map<string, WebhookEventRow>()
  for (const list of lists) for (const event of list) byId.set(event.id, event)
  return [...byId.values()].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
}

export function statusVariant(status: string): 'success' | 'warning' | 'destructive' | 'secondary' | 'outline' {
  switch (status) {
    case 'COMPLETED':
      return 'success'
    case 'PENDING':
      return 'warning'
    case 'FAILED':
      return 'destructive'
    case 'CANCELED':
      return 'secondary'
    default:
      return 'outline'
  }
}
