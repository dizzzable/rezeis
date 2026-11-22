/**
 * Which plan of a bundle is the bundle's FACE — one rule, three readers.
 *
 * The admin panel's bundle dialog, the merge service and the plan row a bundle
 * is issued as must all agree about the member whose name and traffic counters
 * a merged link reports. Before this file each of them carried its own copy of
 * the rule, and a change to one (like the owner's «the unlimited plan must never
 * be the face», 14.11.2026) would have to be made in three places to stay true.
 *
 * The rule, in order:
 *   1. the operator's explicit choice — but ONLY while that member still has a
 *      traffic limit. A bundle whose limited member was later flipped to
 *      unlimited would otherwise keep showing «unlimited» on a link whose other
 *      half still has a limit to watch;
 *   2. the first LIMITED member in the bundle's display order — an app that
 *      reads «unlimited» hides the limit the customer has to watch, which is
 *      the whole reason the unlimited plan is not the default;
 *   3. the first member at all: a bundle of unlimited-only plans has no limit
 *      to show, and leaving the app without a name would be worse.
 */

export interface VisiblePlanMember {
  readonly planId: string;
  readonly isVisibleInApp: boolean;
  readonly plan: {
    readonly orderIndex: number;
    readonly trafficLimit: number | null;
  };
}

/** Members in the bundle's display order — the order every screen reads them in. */
export function orderBundleMembers<T extends { readonly plan: { readonly orderIndex: number } }>(
  members: readonly T[],
): T[] {
  return [...members].sort((left, right) => left.plan.orderIndex - right.plan.orderIndex);
}

/** The member meant for the app's face, or `null` for an empty bundle. */
export function resolveVisibleMember<T extends VisiblePlanMember>(
  members: readonly T[],
): T | null {
  const ordered = orderBundleMembers(members);
  if (ordered.length === 0) return null;
  const explicit = ordered.find((member) => member.isVisibleInApp);
  if (explicit !== undefined && explicit.plan.trafficLimit !== null) return explicit;
  const limited = ordered.find((member) => member.plan.trafficLimit !== null);
  return limited ?? ordered[0] ?? null;
}

/**
 * The plan id of {@link resolveVisibleMember}, or `null` for an empty bundle.
 * This is the value the admin API returns as `visiblePlanId`.
 */
export function resolveVisiblePlanId(members: readonly VisiblePlanMember[]): string | null {
  return resolveVisibleMember(members)?.planId ?? null;
}

/**
 * Whether a plan can face the app. Unlimited plans cannot: the merged link
 * would report «unlimited» and hide the limit the limited half of the bundle
 * still has to show. The operator's explicit choice is validated by this.
 */
export function canFaceMergedLink(plan: { readonly trafficLimit: number | null }): boolean {
  return plan.trafficLimit !== null;
}
