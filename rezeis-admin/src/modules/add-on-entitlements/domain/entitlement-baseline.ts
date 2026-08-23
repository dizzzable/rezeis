import {
  PLAN_INHERITED_LIMIT_KEYS,
  resolvePlanLimitOwnership,
  type PartialPlanInheritedLimits,
  type PlanInheritedLimitKey,
  type PlanInheritedLimits,
  type RecordedAddOnContribution,
} from '../../subscriptions/services/plan-inherited-limits.util';
import { GIB_BYTES } from './cutover-baseline';

/**
 * What a subscription is entitled to BEFORE add-ons — the projection's baseline.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * Individual configuration and billing are separate concerns: an operator can
 * configure ONE customer's subscription from the admin Users page while that
 * customer keeps being billed for the tariff plan. The payment renewal path
 * honours that through the shared ownership reader
 * (`src/modules/subscriptions/services/plan-inherited-limits.util.ts`) — it
 * refreshes only the columns that still match the stored `planSnapshot`.
 *
 * That fix did not survive scheduled-term activation. A `SubscriptionTerm`
 * records "what the customer BOUGHT for this term" and its
 * `baseTrafficLimitBytes` / `baseDeviceLimit` are minted from the plan and
 * never mutated afterwards. `EffectiveProjectionService` then derived
 * `desired = term baseline + ACTIVE add-ons`, so at the moment the term
 * activated the hand-set value was replaced by the plan's — and pushed into the
 * Remnawave panel, because the versioned sync path reads
 * `SubscriptionEffectiveProjection.desired*`, not the mirrored columns. The
 * customer genuinely lost the devices.
 *
 * The term row is not the place to repair this and it is deliberately not
 * touched here: it is a BILLING record, written once, and the override may be
 * set long after the term was scheduled. The repair belongs where the term
 * baseline becomes the subscription's desired state — the projection — so every
 * writer that mirrors the projection (term activation, boundary expiry,
 * `forceReconcile`, `reverseEntitlement`, add-on fulfillment, plan change)
 * inherits it from one place instead of agreeing by hand.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 *
 * The override test is NOT re-derived here. It is
 * {@link resolvePlanLimitOwnership}, called once, for all four fields:
 *
 *   column === snapshot   INHERITED   → the term's plan baseline stands.
 *   column !== snapshot   OVERRIDDEN  → the operator's value IS the baseline,
 *                                       and add-ons layer on top of it.
 *   snapshot unreadable   UNDECIDABLE → the term's plan baseline stands.
 *
 * UNDECIDABLE resolves toward the PLAN here, and that is the one place this
 * file departs from the renewal reader, on purpose. The renewal reader is
 * deciding whether to WRITE over a column, so "do nothing" preserves. This is
 * deciding what a paid term is worth, and the same projection carries paid PLAN
 * CHANGES: resolving an unreadable snapshot toward the column would mean an
 * imported/legacy subscriber could buy an upgrade and stay on the old limits,
 * with the money taken. That is a larger, quieter harm than the one it would
 * avoid, and preserving nothing here is also exactly today's behaviour for
 * those rows, so nothing regresses. The cost is stated plainly: a legacy row
 * with no readable snapshot still loses a hand-set limit when its term
 * activates.
 *
 * Separating UNDECIDABLE from OVERRIDDEN is the whole reason this file needs a
 * THREE-way answer rather than the renewal fragment, which merges them (both
 * simply omit the key). It no longer re-derives that distinction from a
 * key-presence probe of its own: the shared reader returns it, so the two
 * cannot drift apart, and a refactor that collapses the two states breaks this
 * file's callers rather than silently changing what a paid term is worth.
 *
 * ── Removing the add-ons before comparing ─────────────────────────────────
 *
 * `Subscription.trafficLimit` / `deviceLimit` are mirrors of the projection's
 * DESIRED state, so on a subscription holding a live add-on they already carry
 * the contribution. Comparing them to the snapshot raw would read every add-on
 * holder as overridden and then add the contribution a second time. So the
 * comparison runs against the column with the contribution the projection LAST
 * RECORDED removed — which is also what keeps remediation able to repair drift:
 * the add-on share of the column is re-derived from the live ledger on every
 * recompute and is never attributed to the operator. Only the remainder is.
 *
 * That subtraction is NOT performed here either. It lives beside the comparison
 * it feeds, in {@link resolvePlanLimitOwnership}, because the renewal path has
 * to make exactly the same deduction and a second copy of it is a defect on the
 * day the two disagree — which is precisely what happened: for years the
 * renewal path compared the raw column, so from the first add-on a customer
 * bought, no plan edit ever reached them again.
 */

/** The projection baseline, in the projection's own units. */
export interface EntitlementBaseline {
  readonly baseTrafficLimitBytes: bigint | null;
  readonly baseDeviceLimit: number | null;
  /** Which fields the operator owns. Empty when the plan baseline stands. */
  readonly overriddenKeys: readonly PlanInheritedLimitKey[];
}

export type { PartialPlanInheritedLimits };

/** The same shape while it is being built. */
type LimitBuilder = { -readonly [K in keyof PlanInheritedLimits]?: PlanInheritedLimits[K] };

/**
 * Placeholders for the fields a caller did not ask about. They exist only to
 * satisfy the resolver's total input shape; every key the caller omitted is
 * dropped from the result before it is returned, so these values can never
 * reach a decision.
 */
const UNASKED: PlanInheritedLimits = {
  trafficLimit: null,
  deviceLimit: 0,
  internalSquads: [],
  externalSquad: null,
};

/**
 * The subset of `configured` an OPERATOR owns: the fields whose stored snapshot
 * is readable and disagrees with the subscription's own value.
 *
 * Returns the operator's values, not just the key names, so no caller has to
 * re-read them and none of them can read them differently.
 *
 * Ask only about the fields you are going to use. A key absent from
 * `configured` is absent from the answer, so two callers that own different
 * fields cannot end up evaluating this rule on two different views of the same
 * subscription.
 *
 * There is no `recorded` add-on contribution here because the only caller left
 * asks about SQUADS, and nothing in the catalogue grants a squad. A caller that
 * needs the numeric fields wants {@link resolveEntitlementBaseline}, which
 * passes the recorded contribution through.
 */
export function resolveOperatorConfiguredLimits(input: {
  readonly configured: PartialPlanInheritedLimits;
  readonly planSnapshot: unknown;
}): PartialPlanInheritedLimits {
  const asked = PLAN_INHERITED_LIMIT_KEYS.filter((key) => key in input.configured);
  const current: PlanInheritedLimits = { ...UNASKED, ...input.configured };
  const { ownership } = resolvePlanLimitOwnership({
    current,
    planSnapshot: input.planSnapshot,
  });

  const overridden: LimitBuilder = {};
  for (const key of asked) {
    // INHERITED and UNDECIDABLE both mean "not the operator's", and they are
    // kept apart by the shared reader rather than re-derived here.
    if (ownership[key] !== 'OVERRIDDEN') continue;
    if (key === 'trafficLimit') overridden.trafficLimit = current.trafficLimit;
    else if (key === 'deviceLimit') overridden.deviceLimit = current.deviceLimit;
    else if (key === 'internalSquads') overridden.internalSquads = [...current.internalSquads];
    else overridden.externalSquad = current.externalSquad;
  }
  return overridden;
}

/**
 * Resolve the baseline a projection recompute must build its desired state on.
 *
 * `recorded` is the contribution the PREVIOUS projection row carries, not the
 * one about to be computed: the columns were mirrored from that row, so it is
 * the only quantity that can be subtracted back out of them. When an add-on has
 * since expired or been reversed, the stale contribution is removed from the
 * column, the remainder matches the snapshot, and the baseline returns to the
 * plan — which is how a genuinely drifted column is still corrected.
 */
export function resolveEntitlementBaseline(input: {
  readonly term: {
    readonly baseTrafficLimitBytes: bigint | null;
    readonly baseDeviceLimit: number | null;
  };
  readonly subscription: {
    readonly trafficLimit: number | null;
    readonly deviceLimit: number;
    readonly planSnapshot: unknown;
  };
  readonly recorded: RecordedAddOnContribution;
}): EntitlementBaseline {
  const { ownership, base } = resolvePlanLimitOwnership({
    current: {
      ...UNASKED,
      trafficLimit: input.subscription.trafficLimit,
      deviceLimit: input.subscription.deviceLimit,
    },
    planSnapshot: input.subscription.planSnapshot,
    recorded: input.recorded,
  });

  const overriddenKeys: PlanInheritedLimitKey[] = [];
  let baseTrafficLimitBytes = input.term.baseTrafficLimitBytes;
  if (ownership.trafficLimit === 'OVERRIDDEN') {
    overriddenKeys.push('trafficLimit');
    const value = base.trafficLimit;
    baseTrafficLimitBytes =
      value === null || value === undefined ? null : BigInt(value) * GIB_BYTES;
  }

  let baseDeviceLimit = input.term.baseDeviceLimit;
  if (ownership.deviceLimit === 'OVERRIDDEN') {
    overriddenKeys.push('deviceLimit');
    const value = base.deviceLimit;
    baseDeviceLimit = value === undefined || value <= 0 ? null : value;
  }

  return { baseTrafficLimitBytes, baseDeviceLimit, overriddenKeys };
}
