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
 * ── The rule (24.09.2026) ────────────────────────────────────────────────
 *
 * THE BASELINE IS THE SUBSCRIPTION'S OWN SHARE OF ITS COLUMNS — the column
 * with the contribution the projection last recorded taken back out — whoever
 * wrote it, whatever the snapshot says. The term's base is only the FALLBACK,
 * for a column that cannot be read as "own share + recorded contribution" (a
 * device column at or below the live add-ons, a traffic column not a whole
 * number of GiB above them).
 *
 * WHY THE COLUMNS AND NOT THE TERM. The columns are where every writer
 * outside the ledger writes: the operator's editor, a legacy add-on increment
 * (stage 2 off, a rollback, the ledger's fallback), an import, the Remnawave
 * pull and webhook, bulk operations, a refund's lowering. The rule used to be
 * that only an OVERRIDDEN field (column ≠ snapshot) kept its column, and an
 * INHERITED or UNDECIDABLE one took the term's base — frozen when the term was
 * minted, usually by the cutover from the columns of that day. So every such
 * write was undone at the next recompute (an add-on purchase or expiry, a term
 * activation), mirrored into the columns and pushed:
 *
 *  - a never-assigned import (a snapshot with no limit keys: UNDECIDABLE)
 *    at 200 GB / 5 renewed into a term minted from the plan's 100 / 3, and was
 *    cut to 100 / 3 when that term started — where the column path keeps what
 *    it has (an unreadable snapshot PRESERVES the column).
 *  - an operator's raise on such an import came back down at the next
 *    purchase; an operator's cut of a grandfathered raise to the plan's value
 *    (INHERITED) came back up, to the base the cutover had minted with it.
 *  - A refund lowering a legacy add-on to the plan's value came back the same
 *    way, and so did a Remnawave-side change mirrored into the columns.
 *
 * Each writer keeps the lifetime it has on the column path, because nothing
 * about how the columns are written changes: an OVERRIDDEN value survives a
 * renewal (the renewal's refresh leaves it alone), an INHERITED one is put
 * back to the plan by the next renewal's refresh — written into the columns at
 * the payment, as the column path writes it, and taken from there.
 *
 * WHAT A TERM CHANGE STILL MOVES. Every path that moves a subscription onto a
 * plan writes the plan's snapshot and the columns it carries BEFORE it
 * recomputes — a paid upgrade, «Назначить план», the bulk assignment, a plan
 * migration — so the new plan reaches `desired` through the columns. That is
 * also why the old reason for resolving UNDECIDABLE toward the plan ("an
 * imported subscriber could buy an upgrade and stay on the old limits") no
 * longer holds: the upgrade's snapshot carries the keys, and its carried
 * columns are the new plan's.
 *
 * The ownership verdict (INHERITED / OVERRIDDEN / UNDECIDABLE) is still
 * computed — by {@link resolvePlanLimitOwnership}, once, for all four fields —
 * and still returned as `overriddenKeys`: it is what the renewal refresh and
 * the plan-change carry decide on, and what a capture-time check compares.
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
 * Resolve the baseline a projection recompute must build its desired state on:
 * the subscription's own share of its columns, or the term's base where the
 * columns cannot be read that way — see "The rule" above.
 *
 * `recorded` is the contribution the PREVIOUS projection row carries, not the
 * one about to be computed: the columns were mirrored from that row, so it is
 * the only quantity that can be subtracted back out of them. When an add-on has
 * since expired or been reversed, its stale share is removed from the column
 * here and the new contribution no longer carries it — which is how the
 * add-on's end reaches `desired` without touching what the subscription owns.
 *
 * `null` when the subscription has NO projection row yet: nothing has ever
 * recorded how much of its columns is add-ons, so they cannot be split, and
 * the rule is the one before 24.09.2026 — an operator's value (OVERRIDDEN) is
 * read off the column, everything else stands on the term's base, minted by
 * the cutover from these same columns in the transaction that creates the
 * first row. Only a row that reached the term model some other way can meet
 * this, and reading all of its columns as its own would count any live add-on
 * in them twice.
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
  readonly recorded: RecordedAddOnContribution | null;
}): EntitlementBaseline {
  const { ownership, base } = resolvePlanLimitOwnership({
    current: {
      ...UNASKED,
      trafficLimit: input.subscription.trafficLimit,
      deviceLimit: input.subscription.deviceLimit,
    },
    planSnapshot: input.subscription.planSnapshot,
    recorded: input.recorded ?? undefined,
  });

  const overriddenKeys: PlanInheritedLimitKey[] = [];
  if (ownership.trafficLimit === 'OVERRIDDEN') overriddenKeys.push('trafficLimit');
  if (ownership.deviceLimit === 'OVERRIDDEN') overriddenKeys.push('deviceLimit');

  // The subscription's own share, INHERITED, OVERRIDDEN or UNDECIDABLE alike:
  // `base` holds a field exactly when its column reads as own share plus the
  // recorded contribution. With no row recorded yet, only an operator's value
  // (OVERRIDDEN) is read off the column, as before the rule; the rest stands on
  // the term's base, which the cutover minted from these columns. Unlimited
  // stays unlimited (`null`; a device column at or below zero is the product's
  // unlimited).
  const ownTraffic =
    input.recorded === null && ownership.trafficLimit !== 'OVERRIDDEN' ? undefined : base.trafficLimit;
  const baseTrafficLimitBytes =
    ownTraffic === undefined
      ? input.term.baseTrafficLimitBytes
      : ownTraffic === null
        ? null
        : BigInt(ownTraffic) * GIB_BYTES;
  const ownDevices =
    input.recorded === null && ownership.deviceLimit !== 'OVERRIDDEN' ? undefined : base.deviceLimit;
  const baseDeviceLimit =
    ownDevices === undefined ? input.term.baseDeviceLimit : ownDevices <= 0 ? null : ownDevices;

  return { baseTrafficLimitBytes, baseDeviceLimit, overriddenKeys };
}
