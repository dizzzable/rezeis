/**
 * How long a provider-side invoice is allowed to remain payable.
 *
 * The invariant: **the provider's invoice must never outlive our own pending
 * draft.** `PaymentPendingExpiryService` cancels a PENDING transaction once it
 * is older than 30 minutes; if the invoice at the provider is still payable at
 * that moment, we have a row we consider dead and a link the buyer can still
 * pay. That gap is what makes releasing a paid-trial reservation on cancel
 * unsafe — the buyer can stack several payable links and settle them all.
 *
 * No gateway in this system exposes an API to cancel an invoice, so the only
 * lever we have is to ask for a short life up front. Aligning the two clocks
 * closes the gap without needing anything from the providers.
 *
 * Deliberately equal to, not shorter than, the sweep window: the sweep matches
 * `createdAt < now - TTL`, so it fires strictly after this has elapsed and the
 * invoice is already expired by the time we touch it.
 *
 * Keep in step with `PENDING_TTL_MS` in `payment-pending-expiry.service.ts`.
 */
export const CHECKOUT_LIFETIME_MINUTES = 30;

export const CHECKOUT_LIFETIME_SECONDS = CHECKOUT_LIFETIME_MINUTES * 60;

export const CHECKOUT_LIFETIME_MS = CHECKOUT_LIFETIME_SECONDS * 1000;

/**
 * Absolute expiry for providers that take a timestamp rather than a duration
 * (Wata's `expirationDateTime`, Overpay's `order.expired_at`). ISO-8601 UTC.
 */
export function checkoutExpiresAt(now: Date = new Date()): string {
  return new Date(now.getTime() + CHECKOUT_LIFETIME_MS).toISOString();
}
