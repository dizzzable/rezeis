import { AddOnLifetime, TrafficLimitStrategy } from '@prisma/client';

import {
  ResetCapabilityMap,
  getResetCapability,
  planResetEpoch,
} from './reset-cycle-policy';

/**
 * "Until WHEN can this add-on actually be delivered to this subscription?" —
 * asked once, answered once.
 *
 * ── Why it is a shared function and not a method ──────────────────────────
 *
 * This is the LIFETIME axis of the same offer↔money split that
 * `configured-baseline.util.ts` closed on the RESOURCE axis. Both axes decide
 * whether an add-on may be SOLD, and both used to be answered in one place
 * only — the OFFER — while the money path answered a different question, or
 * none at all:
 *
 *   * `AddOnEligibilityService.evaluate` withheld a `UNTIL_NEXT_RESET` add-on
 *     whose reset window the intake cannot honour.
 *   * `AddOnPurchaseService.checkout` asked NOTHING about lifetime, so a
 *     crafted (or merely stale) checkout still drafted, was paid, and reached
 *     `PaymentSubscriptionMutationService.applyAddOnTopUp`, whose ledger path
 *     declines a reset-scoped entitlement it cannot bind to an epoch and falls
 *     through to the PERMANENT legacy increment. The customer bought a
 *     temporary top-up and received a permanent one — unpriced, and with no
 *     entitlement row anything could ever expire.
 *
 * The repair is the one that already worked for the resource axis: ONE reader,
 * called from both sides. A second derivation of this rule is a defect on the
 * day the copies disagree, and that day has already happened once in this
 * feature.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 *
 * `UNTIL_SUBSCRIPTION_END` needs a term end to expire at; an open-ended term
 * has none, so the lifetime cannot be honoured at all.
 *
 * `UNTIL_NEXT_RESET` binds expiry to the plan's reset cycle. It is valid for
 * BOTH resources — the reset epoch is the profile's refresh boundary, on which
 * traffic rolls back AND extra devices are removed — so availability is gated
 * by the strategy and the capability, never by the add-on type:
 *
 *   NO_RESET                → no boundary exists.
 *   capability !== ENABLED  → the boundary exists but is not verified for
 *                             commercial expiry (staged rollout).
 *   resetAnchorAt === null  → a boundary strategy with no anchor yields no
 *                             epoch. Withheld rather than letting
 *                             `planResetEpoch` throw, which would 500 the
 *                             whole listing on the offer side.
 *
 * `capabilities` is the CALLER's capability map and is deliberately an input:
 * the offer and the direct-purchase checkout both pass the INTAKE-gated map
 * ({@link resolveIntakeResetCapabilities}), while
 * {@link EntitlementBoundaryService} expires ALREADY-PAID entitlements against
 * the flag-pure map — expiry of prior goods must never depend on whether
 * intake is open. Baking either choice in here would fuse two rules that are
 * meant to move independently.
 *
 * Only those two callers reach THIS function, so the binary above is exact for
 * it. The flag-pure map itself has a third reader — the fulfilment path in
 * `PaymentSubscriptionMutationService.applyAddOnViaLedger` — which is why the
 * doc on {@link resolveResetCapabilities} carries the equivalence that keeps
 * the quoted and the delivered `expiresAt` identical, and what breaks if it
 * ever stops holding.
 */
export interface AddOnLifetimeBaseline {
  /** The term window's end — `null` for an open-ended term. */
  readonly endsAt: Date | null;
  readonly trafficResetStrategy: TrafficLimitStrategy;
  readonly resetAnchorAt: Date | null;
}

export interface AddOnLifetimeGrant {
  /** When the entitlement this lifetime describes stops delivering. */
  readonly expiresAt: Date;
  readonly explanationCode: 'ELIGIBLE_UNTIL_SUBSCRIPTION_END' | 'ELIGIBLE_UNTIL_NEXT_RESET';
}

/**
 * The expiry this lifetime can actually be delivered with, or `null` when it
 * cannot be delivered at all.
 *
 * Pure: `now` is passed in rather than read, so the offer's quote and the
 * checkout's re-validation are the same computation on the same clock.
 */
export function resolveAddOnLifetimeGrant(input: {
  readonly lifetime: AddOnLifetime;
  readonly baseline: AddOnLifetimeBaseline;
  readonly capabilities: ResetCapabilityMap;
  readonly now: Date;
}): AddOnLifetimeGrant | null {
  if (input.lifetime === AddOnLifetime.UNTIL_SUBSCRIPTION_END) {
    if (input.baseline.endsAt === null) return null; // open-ended term has no expiry date
    // …and a term window that has ALREADY CLOSED cannot be delivered either.
    //
    // The intake is where this bites: `applyAddOnViaLedger` requires
    // `term.endsAt > now` before it will bind an entitlement to that window, and
    // when it cannot it falls through to the PERMANENT legacy increment. So a
    // term whose `endsAt` is in the past — an expired subscription still
    // carrying its ACTIVE term, or a lapsed one being browsed — was OFFERED a
    // bounded add-on, sold it at the bounded price, and delivered an UNBOUNDED
    // one: a raw column increment with no entitlement row that anything could
    // ever expire.
    //
    // The test belongs HERE and nowhere else. Adding it on the offer alone
    // leaves the crafted/stale checkout selling it; adding it on the checkout
    // alone re-opens the divergence in the other direction, listing a product
    // that answers 400 at the till. Both callers pass the same `now`, so they
    // move together.
    if (input.baseline.endsAt.getTime() <= input.now.getTime()) return null;
    return {
      expiresAt: input.baseline.endsAt,
      explanationCode: 'ELIGIBLE_UNTIL_SUBSCRIPTION_END',
    };
  }

  if (input.baseline.trafficResetStrategy === TrafficLimitStrategy.NO_RESET) return null;
  const capability = getResetCapability(input.baseline.trafficResetStrategy, input.capabilities);
  if (capability !== 'ENABLED') return null;
  if (input.baseline.resetAnchorAt === null) return null;

  const epoch = planResetEpoch({
    strategy: input.baseline.trafficResetStrategy,
    capability,
    anchorAt: input.baseline.resetAnchorAt,
    referenceAt: input.now,
  });
  if (epoch === null) return null;
  return { expiresAt: epoch.plannedEndsAt, explanationCode: 'ELIGIBLE_UNTIL_NEXT_RESET' };
}
