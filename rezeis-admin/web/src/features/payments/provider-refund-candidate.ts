/**
 * Which payments «Отметить возврат» is offered for (`provider-refund.tsx`),
 * kept out of the component file so a test reads the rule on its own. The
 * server checks all of it again (`providerRefundRecordRefusal`).
 */
import { importedFrom, PARTNER_BALANCE_GATEWAY } from './payment-records'

/** A payment as either page knows it. */
export interface ProviderRefundPayment {
  readonly id: string
  readonly paymentId?: string | null
  readonly status: string
  readonly gatewayType: string | null
  readonly purchaseType: string | null
  readonly amount: string | number | null
  readonly currency: string
  readonly conversionWithheld?: unknown
  /** Known on the Payments page; the «Операции» tab does not carry it, and the server checks it. */
  readonly fulfilledAt?: string | null
  /** Known on the Payments page; see {@link isProviderRefundCandidate}. */
  readonly planSnapshot?: unknown
}

/** The gateway the panel refunds itself, with «Вернуть». */
const PANEL_REFUNDED_GATEWAY = 'YOOKASSA'

/** An imported payment's id: the importer's namespace, then the donor's own number (`bedolaga:4821`). */
const IMPORTED_PAYMENT_ID = /^[a-z][a-z0-9]*:/

/**
 * Whether «Отметить возврат» is offered for the payment: COMPLETED, for more
 * than nothing, of a gateway the panel does not refund itself, not withheld,
 * not imported from another bot, and — where the page knows it — delivered.
 */
export function isProviderRefundCandidate(payment: ProviderRefundPayment): boolean {
  if (payment.status !== 'COMPLETED') return false
  if (payment.gatewayType === null || payment.gatewayType === PANEL_REFUNDED_GATEWAY) return false
  if (payment.gatewayType === PARTNER_BALANCE_GATEWAY) return false
  if (payment.conversionWithheld) return false
  const amount = Number(payment.amount)
  if (!Number.isFinite(amount) || amount <= 0) return false
  if (payment.fulfilledAt === null) return false
  if (importedFrom(payment.planSnapshot) !== null) return false
  if (typeof payment.paymentId === 'string' && IMPORTED_PAYMENT_ID.test(payment.paymentId)) return false
  return true
}
