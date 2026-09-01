/**
 * The one place a discount percentage is bounded.
 *
 * ── Why this is shared ────────────────────────────────────────────────────
 *
 * There were two `clampDiscount` functions — one in `PricingService`, one in
 * `PromocodeRewardsService` — written separately and both capping at 100. Two
 * copies of the same rule is how the rule stops being one rule: raising the
 * ceiling in the promocode path while the pricing path kept its own would let a
 * value through that the checkout then applied in full.
 *
 * ── Why 90 and not 100 ────────────────────────────────────────────────────
 *
 * A 100% discount is a free order that still goes through a payment provider,
 * and the shapes around it are all bad: a zero-amount invoice some gateways
 * refuse outright, others accept and never call back. Ninety leaves a real
 * amount to charge while still being a deep enough discount for any campaign
 * an operator actually runs. Anything given away entirely belongs in a
 * SUBSCRIPTION action, which grants access without an order at all.
 *
 * Applied on the way IN (when a promocode is configured and when a grant is
 * written) and again on the way OUT (when the checkout builds a price), so a
 * row that predates the ceiling — or one written by a donor import — cannot
 * spend more than the ceiling either.
 */
export const MAX_DISCOUNT_PERCENT = 90;

/** Bounds a percentage to `0..MAX_DISCOUNT_PERCENT`, truncating fractions. */
export function clampDiscountPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_DISCOUNT_PERCENT, Math.trunc(value)));
}
