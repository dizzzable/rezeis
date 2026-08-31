import { AddOnType, Prisma } from '@prisma/client';

import type { RecordedAddOnContribution } from '../../subscriptions/services/plan-inherited-limits.util';
import {
  resolveEntitlementBaseline,
  type EntitlementBaseline,
} from '../domain/entitlement-baseline';

/**
 * "What is this ONE subscription entitled to before add-ons, and can an add-on
 * of this type still extend it?" — asked once, answered once.
 *
 * ── Why it is a shared function and not a method ──────────────────────────
 *
 * The question has four askers and they sit in three modules:
 *
 *   1. `EffectiveProjectionService.recomputeInTransaction` — fulfillment, the
 *      one that actually mints the desired state.
 *   2. `AddOnEligibilityService.resolveConfiguredBaseline` — the OFFER.
 *   3. `AddOnPurchaseService.checkout` — the direct-purchase CHECKOUT.
 *   4. `PaymentSubscriptionMutationService` — CAPTURE, on both the renewal and
 *      the direct-purchase paths.
 *
 * Every one of them used to answer it separately. The offer and the checkout
 * were the pair that proved why that is a defect rather than duplication: the
 * offer was corrected to ask {@link resolveEntitlementBaseline} while checkout
 * kept testing the RAW `Subscription` columns, so an imported row with an
 * unreadable `planSnapshot` and `deviceLimit = 0` was correctly OFFERED the
 * add-on and then answered 400 at checkout. The customer was shown a product
 * they could not buy. Agreement by hand is what failed; the only repair that
 * cannot fail again is one reader.
 *
 * The rule itself — INHERITED / OVERRIDDEN / UNDECIDABLE, and why UNDECIDABLE
 * deliberately resolves toward the PLAN — is NOT restated here. It lives in
 * `../domain/entitlement-baseline.ts` and this file only calls it.
 */

/** The term baseline, as every asker already reads it. */
export interface ConfiguredBaselineTerm {
  readonly baseTrafficLimitBytes: bigint | null;
  readonly baseDeviceLimit: number | null;
}

/** The three subscription columns the override rule compares. */
export interface ConfiguredBaselineSubscription {
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly planSnapshot: unknown;
}

/**
 * Only the delegate this function touches. Narrower than
 * `Prisma.TransactionClient` on purpose: a `PrismaService`, a transaction
 * client and a test double all satisfy it, and none of them can be handed a
 * function that quietly starts reading something else.
 */
export type ProjectionReader = Pick<Prisma.TransactionClient, 'subscriptionEffectiveProjection'>;

/**
 * The baseline `EffectiveProjectionService` will build for this subscription,
 * built the same way and from the same three inputs.
 *
 * `recorded` is the contribution the PREVIOUS projection row carries, not the
 * one a recompute is about to derive: the subscription's limit columns were
 * mirrored from that row, so it is the only quantity that can legitimately be
 * subtracted back out of them before they are compared with the stored
 * `planSnapshot`. A subscription with no projection row yet contributes
 * nothing — the same `?? 0` fallback `recomputeInTransaction` uses. Passing a
 * hard 0 instead of reading the row would be a second, divergent derivation of
 * the baseline, which is the failure this file exists to prevent.
 */
export async function resolveConfiguredEntitlementBaseline(
  db: ProjectionReader,
  input: {
    readonly subscriptionId: string;
    readonly term: ConfiguredBaselineTerm;
    readonly subscription: ConfiguredBaselineSubscription;
  },
): Promise<EntitlementBaseline> {
  return resolveEntitlementBaseline({
    term: input.term,
    subscription: input.subscription,
    recorded: await resolveRecordedAddOnContribution(db, input.subscriptionId),
  });
}

/**
 * The add-on share of this subscription's limit COLUMNS, as the last projection
 * recompute recorded it — the ONE place that number is read.
 *
 * Every reader of the override rule needs it, and they do not all sit in this
 * module: `EffectiveProjectionService` takes it from the row it has already
 * locked, and the RENEWAL path in
 * `PaymentSubscriptionMutationService` has to subtract exactly the same
 * quantity before comparing a column with the stored `planSnapshot` — until it
 * did, an add-on holder read as OVERRIDDEN on every renewal and no plan edit
 * ever reached them again.
 *
 * `?? 0` for a subscription with no projection row yet is the same fallback
 * `recomputeInTransaction` uses, and it is deliberately here rather than at
 * each call site: passing a hard 0 where a row might exist is a second,
 * divergent derivation of the baseline, which is the failure this file exists
 * to prevent.
 */
export async function resolveRecordedAddOnContribution(
  db: ProjectionReader,
  subscriptionId: string,
): Promise<RecordedAddOnContribution> {
  const recorded = await db.subscriptionEffectiveProjection.findUnique({
    where: { subscriptionId },
    select: { activeTrafficContributionBytes: true, activeDeviceContribution: true },
  });
  return {
    activeTrafficContributionBytes: recorded?.activeTrafficContributionBytes ?? 0n,
    activeDeviceContribution: recorded?.activeDeviceContribution ?? 0,
  };
}

/**
 * Can an add-on of this type still ADD anything to this baseline?
 *
 * Unlimited is absorbing in `addTrafficLimit` / `addDeviceLimit`, so an add-on
 * layered onto an unlimited baseline changes nothing and the customer paid for
 * nothing. Withholding it also closes the legacy `0 + N` footgun, where an
 * extra-device purchase turned an unlimited profile finite.
 *
 * The two resources are encoded DIFFERENTLY and that is not an accident to be
 * tidied away:
 *
 *   - traffic: `null` is unlimited, and `0n` bytes is a real, finite budget of
 *     zero gigabytes — extendable, because adding 50 GB to it delivers 50 GB.
 *     A negative byte budget is a data anomaly and is refused rather than
 *     extended.
 *   - devices: `<= 0` is the product's canonical unlimited (sharing detection,
 *     the devices UI and the panel device-limit mapping all agree), so a device
 *     baseline is extendable only when it is strictly positive. In practice
 *     {@link resolveEntitlementBaseline} already maps that to `null`; the `<= 0`
 *     arm keeps the predicate honest for a raw term row that never went through
 *     it.
 */
export function isBaselineExtendable(
  type: AddOnType,
  baseline: {
    readonly baseTrafficLimitBytes: bigint | null;
    readonly baseDeviceLimit: number | null;
  },
): boolean {
  // EVERY TYPE IS NAMED. The last line used to be a bare fallthrough to the
  // device rule, so a type added later — `RESET_TRAFFIC` was the first — would
  // have been silently judged against the DEVICE baseline: offered on an
  // unlimited-traffic profile whenever the device limit happened to be finite,
  // and withheld from a finite-traffic profile with unlimited devices. Both
  // answers wrong, neither visible.
  if (type === AddOnType.EXTRA_TRAFFIC || type === AddOnType.RESET_TRAFFIC) {
    // A reset does not EXTEND the baseline — it zeroes what has been consumed
    // against it. The question is the same one either way: is there a finite
    // traffic allowance for the answer to mean anything? On an unlimited
    // profile nothing is consumed and a reset is a no-op worth nobody's money.
    return baseline.baseTrafficLimitBytes !== null && baseline.baseTrafficLimitBytes >= 0n;
  }
  if (type === AddOnType.EXTRA_DEVICES) {
    return baseline.baseDeviceLimit !== null && baseline.baseDeviceLimit > 0;
  }
  // A type nobody taught this function about is not offered. Refusing to sell
  // is recoverable; selling something the fulfilment path cannot deliver is not.
  return false;
}
