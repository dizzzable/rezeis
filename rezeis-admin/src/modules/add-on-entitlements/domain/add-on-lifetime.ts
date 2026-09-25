import { AddOnLifetime, AddOnType, TrafficLimitStrategy } from '@prisma/client';

import {
  RESET_EXPIRY_MARGIN_MS,
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
 *     declined a reset-scoped entitlement it could not bind to an epoch and
 *     fell through to the PERMANENT legacy increment. The customer bought a
 *     temporary top-up and received a permanent one — unpriced, and with no
 *     entitlement row anything could ever expire.
 *
 * The repair is the one that already worked for the resource axis: ONE reader,
 * called from both sides. A second derivation of this rule is a defect on the
 * day the copies disagree, and that day has already happened once in this
 * feature. The checkout then writes the answer into the payment's marker, and
 * the capture binds to that quote rather than asking again
 * (`PaymentSubscriptionMutationService.applyAddOnViaLedger`).
 *
 * ── Which lifetime is sold ────────────────────────────────────────────────
 *
 * Decided here, not by the catalogue row ({@link resolveEffectiveAddOnLifetime}):
 * devices always end with the subscription, and so does a traffic add-on on a
 * plan that never resets; a traffic add-on on a plan that resets ends at the
 * next reset once stage 4 («Докупка трафика до сброса») is on for the plan's
 * strategy. Until then, the catalogue value, as before.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 *
 * `UNTIL_SUBSCRIPTION_END` needs a term end to expire at; an open-ended term
 * has none, so the lifetime cannot be honoured at all.
 *
 * `UNTIL_NEXT_RESET` ends at Remnawave's next traffic reset (plus the half
 * hour `reset-cycle-policy.ts` explains) — or at the subscription's end, when
 * that comes first: the add-on never outlives the subscription. It is withheld
 * when:
 *
 *   NO_RESET                → no boundary exists.
 *   capability !== ENABLED  → the boundary exists but stage 4 is off for the
 *                             strategy.
 *   resetAnchorAt === null  → a boundary strategy with no anchor yields no
 *                             epoch. Withheld rather than letting
 *                             `planResetEpoch` throw, which would 500 the
 *                             whole listing on the offer side.
 *   an unknown zone         → «Часовой пояс Remnawave» the runtime does not
 *                             know: no cycle can be computed, so none is sold.
 *   the subscription ended  → nothing is left to deliver on.
 *
 * `capabilities` is the CALLER's capability map and is deliberately an input:
 * the offer and the direct-purchase checkout both pass the INTAKE-gated map
 * ({@link resolveIntakeResetCapabilities}), while
 * {@link EntitlementBoundaryService} expires ALREADY-PAID entitlements against
 * the flag-pure map — expiry of prior goods must never depend on whether
 * intake is open. Baking either choice in here would fuse two rules that are
 * meant to move independently.
 */
export interface AddOnLifetimeBaseline {
  /** The term window's end — `null` for an open-ended term. */
  readonly endsAt: Date | null;
  /**
   * The subscription's own end (`Subscription.expiresAt`), `null` for a
   * lifetime subscription: a reset-scoped add-on never outlives it. Not the
   * term's end — with a paid period queued after the current one the
   * subscription runs on, and so does the add-on, until its reset.
   */
  readonly subscriptionEndsAt: Date | null;
  readonly trafficResetStrategy: TrafficLimitStrategy;
  readonly resetAnchorAt: Date | null;
}

/** Which bound ended the add-on: Remnawave's traffic reset, or the subscription's end. */
export type AddOnEndBound = 'reset' | 'subscription_end';

export type AddOnLifetimeExplanation =
  | 'ELIGIBLE_UNTIL_SUBSCRIPTION_END'
  | 'ELIGIBLE_UNTIL_NEXT_RESET'
  /** A reset-scoped add-on the subscription's end cuts short. */
  | 'ELIGIBLE_UNTIL_SUBSCRIPTION_END_BEFORE_RESET';

export interface AddOnLifetimeGrant {
  /** The lifetime sold — {@link resolveEffectiveAddOnLifetime}, not the catalogue row. */
  readonly lifetime: AddOnLifetime;
  /** When the entitlement this lifetime describes stops delivering. */
  readonly expiresAt: Date;
  readonly endsBound: AddOnEndBound;
  /** `UNTIL_NEXT_RESET` only: Remnawave's reset instant that closes the cycle (the date shown), else `null`. */
  readonly resetAt: Date | null;
  /** `UNTIL_NEXT_RESET` only: the reset that opened the cycle, else `null`. */
  readonly cycleStartsAt: Date | null;
  readonly explanationCode: AddOnLifetimeExplanation;
}

/**
 * THE LIFETIME AN ADD-ON IS SOLD WITH (the owner's decisions of 24.09.2026).
 *
 *  - Devices end with the subscription, whatever the catalogue row says. A
 *    device slot that ended at a traffic reset would be taken away at every
 *    reset — with automatic cleanup, the customer's newest device deleted —
 *    and nobody sold that. A traffic reset has no lifetime at all.
 *  - Traffic, while stage 4 («Докупка трафика до сброса») is on for the
 *    plan's strategy: until the next reset. On a plan that never resets,
 *    until the end of the subscription. The catalogue value is not asked:
 *    operators no longer choose this for traffic.
 *  - Traffic with stage 4 off for the strategy: the catalogue value, exactly
 *    as before — a row still set to «до следующего сброса» stays withheld.
 *
 * "On" for a plan without a reset means any of the four stage-4 flags is on
 * (they move together as the one switch unless `.env` splits them).
 */
export function resolveEffectiveAddOnLifetime(input: {
  readonly type: AddOnType;
  readonly catalogLifetime: AddOnLifetime;
  readonly trafficResetStrategy: TrafficLimitStrategy;
  readonly capabilities: ResetCapabilityMap;
}): AddOnLifetime {
  if (input.type !== AddOnType.EXTRA_TRAFFIC) return AddOnLifetime.UNTIL_SUBSCRIPTION_END;
  if (input.trafficResetStrategy === TrafficLimitStrategy.NO_RESET) {
    const stageFourOn = Object.values(input.capabilities).some((capability) => capability === 'ENABLED');
    return stageFourOn ? AddOnLifetime.UNTIL_SUBSCRIPTION_END : input.catalogLifetime;
  }
  return getResetCapability(input.trafficResetStrategy, input.capabilities) === 'ENABLED'
    ? AddOnLifetime.UNTIL_NEXT_RESET
    : input.catalogLifetime;
}

/**
 * The lifetime this add-on is sold with, and the expiry it can actually be
 * delivered with — or `null` when it cannot be delivered at all.
 *
 * Pure: `now` is passed in rather than read, so the offer's quote and the
 * checkout's re-validation are the same computation on the same clock.
 * `timeZone` is «Часовой пояс Remnawave» (`AddOnRolloutFlags.remnawaveTimeZone`).
 */
export function resolveAddOnLifetimeGrant(input: {
  readonly type: AddOnType;
  /** The catalogue row's value; {@link resolveEffectiveAddOnLifetime} decides what is sold. */
  readonly lifetime: AddOnLifetime;
  readonly baseline: AddOnLifetimeBaseline;
  readonly capabilities: ResetCapabilityMap;
  readonly now: Date;
  readonly timeZone?: string;
}): AddOnLifetimeGrant | null {
  const lifetime = resolveEffectiveAddOnLifetime({
    type: input.type,
    catalogLifetime: input.lifetime,
    trafficResetStrategy: input.baseline.trafficResetStrategy,
    capabilities: input.capabilities,
  });
  if (lifetime === AddOnLifetime.UNTIL_SUBSCRIPTION_END) {
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
      lifetime,
      expiresAt: input.baseline.endsAt,
      endsBound: 'subscription_end',
      resetAt: null,
      cycleStartsAt: null,
      explanationCode: 'ELIGIBLE_UNTIL_SUBSCRIPTION_END',
    };
  }

  if (input.baseline.trafficResetStrategy === TrafficLimitStrategy.NO_RESET) return null;
  const capability = getResetCapability(input.baseline.trafficResetStrategy, input.capabilities);
  if (capability !== 'ENABLED') return null;
  if (input.baseline.resetAnchorAt === null) return null;
  const subscriptionEndsAt = input.baseline.subscriptionEndsAt;
  if (subscriptionEndsAt !== null && subscriptionEndsAt.getTime() <= input.now.getTime()) return null;

  let epoch: ReturnType<typeof planResetEpoch>;
  try {
    epoch = planResetEpoch({
      strategy: input.baseline.trafficResetStrategy,
      capability,
      anchorAt: input.baseline.resetAnchorAt,
      referenceAt: input.now,
      timeZone: input.timeZone,
    });
  } catch {
    // An anchor or a zone the policy refuses: no cycle to sell against, and
    // one bad value must not 500 the whole listing.
    return null;
  }
  if (epoch === null) return null;
  // The earlier of the two ends, and the customer is told which one it is.
  const cappedBySubscription = subscriptionEndsAt !== null && subscriptionEndsAt.getTime() < epoch.expiresAt.getTime();
  return {
    lifetime,
    expiresAt: cappedBySubscription ? subscriptionEndsAt : epoch.expiresAt,
    endsBound: cappedBySubscription ? 'subscription_end' : 'reset',
    resetAt: epoch.plannedEndsAt,
    cycleStartsAt: epoch.startsAt,
    explanationCode: cappedBySubscription ? 'ELIGIBLE_UNTIL_SUBSCRIPTION_END_BEFORE_RESET' : 'ELIGIBLE_UNTIL_NEXT_RESET',
  };
}

/**
 * Which bound ends a RECORDED entitlement — for everything that shows or acts
 * on an add-on after the sale (the cabinet's «Мои опции», notices, the
 * boundary sweep's confirmation of Remnawave's reset).
 *
 * An `UNTIL_NEXT_RESET` entitlement bound to a reset epoch ends at that reset
 * when its `expiresAt` is the reset plus the margin, and at the subscription's
 * end when that cut it short (`expiresAt` earlier). Everything else with an
 * end ends with the subscription. `null` only for a row with no end at all.
 */
export function entitlementEndBound(row: {
  readonly lifetime: AddOnLifetime;
  readonly expiresAt: Date | null;
  /** `expiryEpoch.plannedEndsAt`: Remnawave's reset instant; `null` without an epoch. */
  readonly epochPlannedEndsAt: Date | null;
}): AddOnEndBound | null {
  if (row.expiresAt === null) return null;
  if (row.lifetime !== AddOnLifetime.UNTIL_NEXT_RESET || row.epochPlannedEndsAt === null) return 'subscription_end';
  return row.expiresAt.getTime() >= row.epochPlannedEndsAt.getTime() + RESET_EXPIRY_MARGIN_MS ? 'reset' : 'subscription_end';
}
