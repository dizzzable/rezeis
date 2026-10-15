import { PaymentGatewayType, ProviderSubscriptionStatus } from '@prisma/client';

import { requireSetting } from '../services/payment-provider-execution.helpers';

/**
 * AuraPay's repeat charges (docs.aurapay.tech, API 1.2.1, «Подписки»): the
 * payer pays the first invoice of a subscription on AuraPay's form, by card
 * only, and AuraPay then charges the same sum every `period` × `interval` on
 * its own schedule. Like Platega, RollyPay and Antilopay, the PROVIDER runs
 * the schedule; the panel never asks for a charge.
 *
 * What AuraPay gives, and what it does not:
 *  - `GET /subscription/status` names the status, the next charge date and
 *    when the subscription was activated — but no list of charges and no count.
 *    So the first payment is read from the status (activated = paid), and every
 *    later charge only from its callback: the subscription's `PAID` event (and
 *    the invoice callback beside it), each naming the charge's invoice, which is
 *    the documented idempotency key («PAID — invoice_id»).
 *  - Callbacks are signed like every AuraPay callback (HMAC-SHA256 over the
 *    sorted values, secret key #2), so a callback is trusted as far as the
 *    invoice it names; the invoice is still read back (`POST /invoice/status`)
 *    before anything is delivered.
 *  - A callback lost after AuraPay's five tries leaves a charge undelivered,
 *    with no list to find it in: the sweep then sees access ending long before
 *    AuraPay's next charge and tells the operator (`tellMissedAurapayCharge`).
 */
export const AURAPAY_API = 'https://app.aurapay.tech';

/** «Сумма от 1 до 50 000 ₽»: the most one regular charge of a subscription may take. */
export const AURAPAY_SUBSCRIPTION_MAX_AMOUNT = 50_000;

/** `interval` of `POST /subscription/create`. */
export type AurapayInterval = 'day' | 'month' | 'year';

/** The headers every AuraPay API call authenticates with. */
export function aurapayHeaders(settings: Record<string, unknown>): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-ApiKey': requireSetting(settings, 'apiKey'),
    'X-ShopId': requireSetting(settings, 'shopId'),
  };
}

/**
 * Our id of a sign-up at AuraPay (`subscription_id`, «Идентификатор подписки в
 * системе мерчанта», unique per kassa): the checkout's payment id with a prefix
 * of its own, so it is never the same string as an `order_id`. Chosen by us
 * before the call, so every callback — which all carry it — finds the row, and
 * the cancel and the status read go by it.
 */
export function aurapaySubscriptionRef(paymentId: string): string {
  return `sub-${paymentId}`;
}

/**
 * A status word of AuraPay's, in any case: the API answers in lower case
 * (`active`), the callbacks in upper (`ACTIVE`). `waiting_payment` is the first
 * payment in progress before activation, and a failed charge being retried
 * after it. An unknown word is null — never read as a cancellation.
 */
export function mapAurapaySubscriptionStatus(
  status: string | null,
  activated: boolean,
): ProviderSubscriptionStatus | null {
  switch (status?.trim().toLowerCase()) {
    case 'new':
      return ProviderSubscriptionStatus.PENDING;
    case 'waiting_payment':
      return activated ? ProviderSubscriptionStatus.PAST_DUE : ProviderSubscriptionStatus.PENDING;
    case 'active':
      return ProviderSubscriptionStatus.ACTIVE;
    case 'error':
      return ProviderSubscriptionStatus.FAILED;
    case 'deactivated':
      return ProviderSubscriptionStatus.CANCELLED;
    default:
      return null;
  }
}

export interface AurapaySubscription {
  readonly status: ProviderSubscriptionStatus | null;
  readonly providerStatus: string | null;
  readonly nextChargeAt: Date | null;
  /** When the first payment was paid; null while it is not. */
  readonly activatedAt: Date | null;
}

/** `GET /subscription/status`, read with our own keys. */
export function parseAurapaySubscription(data: unknown): AurapaySubscription {
  const root = asRecord(data);
  const providerStatus = typeof root['status'] === 'string' && root['status'].length > 0 ? root['status'] : null;
  const activatedAt = readAurapayDate(root['activated_at']);
  return {
    status: mapAurapaySubscriptionStatus(providerStatus, activatedAt !== null),
    providerStatus,
    nextChargeAt: readAurapayDate(root['next_pay_at']),
    activatedAt,
  };
}

export interface AurapayInvoice {
  readonly id: string;
  readonly orderId: string | null;
  /** PENDING, PAID, REFUNDED or EXPIRED. */
  readonly status: string | null;
  readonly amount: string | null;
}

/** `POST /invoice/status`. Null for a body that names no invoice. */
export function parseAurapayInvoice(data: unknown): AurapayInvoice | null {
  const root = asRecord(data);
  const id = text(root['id']);
  if (id === null) return null;
  const amount = root['amount'];
  return {
    id,
    orderId: text(root['order_id']),
    status: text(root['status'])?.toUpperCase() ?? null,
    amount: typeof amount === 'number' || typeof amount === 'string' ? String(amount) : null,
  };
}

/** What an AuraPay callback says about a subscription. */
export interface AurapayCallbackReferences {
  /** Our `subscription_id`. */
  readonly subscriptionRef: string;
  /** ACTIVATED, PAID, PAYMENT_ERROR or DEACTIVATED for a subscription's event; null for an invoice's callback. */
  readonly event: string | null;
  /** The invoice: the event's `invoice_id`, or the invoice callback's own `id`. */
  readonly invoiceId: string | null;
  /** An invoice callback's `order_id`: ours for a sign-up's first payment, AuraPay's own for a later charge. */
  readonly orderId: string | null;
  readonly status: string | null;
}

/**
 * The subscription an AuraPay callback belongs to, or null when it is an
 * ordinary payment's (no `subscription_id`), not AuraPay's, or not JSON.
 *
 * A subscription posts two kinds to the one address: its own events
 * («Тип события передаётся в поле event»), which name no order of ours, and
 * the callbacks of its invoices, which carry `subscription_id` beside the
 * usual fields — the first payment's under OUR order, a later charge's under
 * one AuraPay makes up.
 */
export function readAurapayCallbackReferences(
  gatewayType: PaymentGatewayType,
  rawBody: Buffer,
): AurapayCallbackReferences | null {
  if (gatewayType !== PaymentGatewayType.AURAPAY) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  const body = asRecord(parsed);
  const subscriptionRef = text(body['subscription_id']);
  if (subscriptionRef === null) return null;
  const event = text(body['event'])?.toUpperCase() ?? null;
  return {
    subscriptionRef,
    event,
    invoiceId: event === null ? text(body['id']) : text(body['invoice_id']),
    orderId: event === null ? text(body['order_id']) : null,
    status: text(body['status'])?.toUpperCase() ?? null,
  };
}

/**
 * The invoice a callback says was PAID: a subscription's `PAID` event (a
 * regular charge) or `ACTIVATED` (the first payment), or an invoice callback
 * with status PAID. Null for everything else — a failed attempt, a deactivation.
 */
export function aurapayPaidInvoiceId(references: AurapayCallbackReferences): string | null {
  if (references.event === 'PAID' || references.event === 'ACTIVATED') return references.invoiceId;
  if (references.event === null && references.status === 'PAID') return references.invoiceId;
  return null;
}

/**
 * AuraPay's `YYYY-MM-DD HH:MM:SS`. Its zone is not documented; it is read as
 * Moscow time, the provider's own. Every use of these dates has a margin of a
 * day or more (`CHARGE_GRACE_MS`, half a period), so three hours either way
 * changes nothing. An ISO date is read as it is.
 */
export function readAurapayDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const trimmed = value.trim();
  const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(trimmed);
  const parsed = new Date(local === null ? trimmed : `${local[1]}T${local[2]}+03:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
