import { clampDiscountPercent } from './discount.util';

/**
 * Choosing which unspent discount a purchase gets.
 *
 * ── Why the choice is not obvious ─────────────────────────────────────────
 *
 * `User.purchaseDiscount` was a single number, so there was nothing to choose:
 * a second grant simply overwrote the first, and the restrictions the promocode
 * carried were checked when the CODE was activated and forgotten by the time
 * the discount was spent. That is why "-20%, but only on the six-month plan"
 * could not be expressed — by checkout, nothing remembered the restriction, and
 * the discount applied to whatever was bought.
 *
 * Grants now carry their own restrictions and there can be several, so this
 * decides between them. It is a pure function on purpose: the catalog needs the
 * answer to show a price, and the checkout needs the same answer to charge one,
 * and those run in different services minutes apart. A number computed twice by
 * two different rules is a price that differs from the amount charged.
 */

export interface PendingDiscountGrant {
  readonly id: string;
  readonly percent: number;
  /** Empty = spendable on any plan. */
  readonly allowedPlanIds: readonly string[];
  readonly expiresAt: Date | null;
  readonly consumedAt: Date | null;
}

export interface ChosenDiscount {
  readonly percent: number;
  /** The grant to mark spent, or `null` when the legacy column supplied it. */
  readonly grantId: string | null;
}

/** Whether this grant can still be spent, and on this plan. */
export function isGrantApplicable(
  grant: PendingDiscountGrant,
  planId: string | null,
  now: Date,
): boolean {
  if (grant.consumedAt !== null) return false;
  if (grant.expiresAt !== null && grant.expiresAt.getTime() <= now.getTime()) return false;
  if (grant.allowedPlanIds.length === 0) return true;
  // A restricted grant needs to know WHICH plan is being priced. Asked without
  // one, it does not apply: showing a restricted discount on an unidentified
  // purchase is how a price ends up lower than the amount charged.
  if (planId === null) return false;
  return grant.allowedPlanIds.includes(planId);
}

/**
 * The best discount available for this purchase.
 *
 * ── Best, not sum ─────────────────────────────────────────────────────────
 *
 * Discounts have never stacked here: the pricing snapshot takes the purchase
 * discount, or else the personal one, and does not add them. Making grants sum
 * would change what every existing promocode does, silently, on the release
 * that introduced the table — so several grants behave the way one always did,
 * and the largest applicable one wins.
 *
 * `legacyPercent` is `User.purchaseDiscount`: grants written before this table
 * existed, and anything a donor import writes. It competes on equal terms and
 * carries no restrictions, because it never had any.
 */
export function pickBestDiscount(input: {
  readonly grants: readonly PendingDiscountGrant[];
  readonly planId: string | null;
  readonly legacyPercent: number;
  readonly now: Date;
}): ChosenDiscount {
  let bestGrant: ChosenDiscount | null = null;
  for (const grant of input.grants) {
    if (!isGrantApplicable(grant, input.planId, input.now)) continue;
    const percent = clampDiscountPercent(grant.percent);
    if (bestGrant === null || percent > bestGrant.percent) {
      bestGrant = { percent, grantId: grant.id };
    }
  }

  // ── A GRANT WINS A TIE WITH THE COLUMN ──────────────────────────────────
  //
  // And a tie is the NORMAL case, not an edge one: granting a discount writes
  // the grant and mirrors it into `user.purchaseDiscount`, so both hold the
  // same percentage. Letting the column win looked harmless and was not — the
  // caller marks `grantId` spent, so a `null` there meant the grant was never
  // consumed. The column was zeroed, the grant stayed unspent, and the customer
  // kept the discount on every purchase after that, for ever.
  const legacyPercent = clampDiscountPercent(input.legacyPercent);
  if (bestGrant !== null && bestGrant.percent >= legacyPercent) {
    return bestGrant;
  }
  return { percent: legacyPercent, grantId: null };
}
