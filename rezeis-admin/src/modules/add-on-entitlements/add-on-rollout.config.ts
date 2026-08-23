import { ResetCapabilityMap, ResetStrategy } from './domain/reset-cycle-policy';

/**
 * Staged rollout flags for the durable add-on entitlement feature.
 *
 * Every flag defaults to OFF so the feature is dormant out of the box: the
 * legacy one-time top-up path stays authoritative until an operator opts a
 * stage in. Flags are read from the environment (resolved per call so tests
 * can vary `process.env` without module-reload gymnastics) — they are
 * deployment-time toggles, deliberately NOT panel-editable, so a stage can
 * never be flipped from the admin UI by accident.
 *
 * Rollout order (each stage assumes the previous):
 *  1. `entitlementShadow`       — shadow projection built, legacy authoritative.
 *  2. `directPurchase`          — new checkouts commit the ledger.
 *  3. `projectionSync`          — versioned desired writes drive Remnawave.
 *  4. `resetExpiry.<strategy>`  — per-strategy commercial reset expiry (after parity).
 *  5. `renewalAddOns`           — scheduled renewal composition.
 *  6. `deviceCleanupAuto`       — automatic HWID reduction (last).
 */
export interface AddOnRolloutFlags {
  readonly entitlementShadow: boolean;
  readonly directPurchase: boolean;
  readonly projectionSync: boolean;
  readonly renewalAddOns: boolean;
  readonly deviceCleanupAuto: boolean;
  readonly resetExpiry: Readonly<Record<Exclude<ResetStrategy, 'NO_RESET'>, boolean>>;
}

function parseBoolean(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

export function resolveAddOnRolloutFlags(env: NodeJS.ProcessEnv = process.env): AddOnRolloutFlags {
  return {
    entitlementShadow: parseBoolean(env.ADDON_ENTITLEMENT_SHADOW),
    directPurchase: parseBoolean(env.ADDON_ENTITLEMENT_DIRECT_PURCHASE),
    projectionSync: parseBoolean(env.ADDON_PROJECTION_SYNC),
    renewalAddOns: parseBoolean(env.ADDON_RENEWAL_ADDONS),
    deviceCleanupAuto: parseBoolean(env.ADDON_DEVICE_CLEANUP_AUTO),
    resetExpiry: {
      DAY: parseBoolean(env.ADDON_RESET_EXPIRY_DAY),
      WEEK: parseBoolean(env.ADDON_RESET_EXPIRY_WEEK),
      MONTH: parseBoolean(env.ADDON_RESET_EXPIRY_MONTH),
      MONTH_ROLLING: parseBoolean(env.ADDON_RESET_EXPIRY_MONTH_ROLLING),
    },
  };
}

/**
 * Derive the reset-cycle capability map from the rollout flags. A strategy is
 * `ENABLED` only when its `reset_expiry_<strategy>` flag is on (the operator's
 * assertion that staging parity was verified for that strategy); everything
 * else is DISABLED. `NO_RESET` never has a boundary.
 *
 * TWO KINDS OF CALLER, and the second one is not obvious. The split stated on
 * {@link resolveIntakeResetCapabilities} below — intake-gated map for the
 * selling sides, flag-pure map for expiry — is real, but it does not describe
 * everything that reads THIS function:
 *
 *   - `EntitlementBoundaryService` (several sites) expires already-paid
 *     entitlements. Flag-pure is the whole point there: closing direct
 *     purchase must not strand goods that were already sold.
 *   - `PaymentSubscriptionMutationService.applyAddOnViaLedger` passes this map
 *     into `ensureLiveResetEpoch` on the FULFILMENT path — which is a selling
 *     side, and on the face of it ought to be reading the intake-gated map.
 *
 * That second one is correct TODAY, and only because of a guard one frame up.
 * `applyAddOnViaLedger` is private with a single call site, inside
 * `applyAddOnTopUp`, and that call site sits behind `flags.directPurchase`.
 * Reaching this map therefore already proves `directPurchase` is on — and
 * {@link resolveIntakeResetCapabilities} is DEFINED as exactly
 * `resolveResetCapabilities()` whenever `directPurchase` is on. The two maps
 * are the same value at that call site, so the offer, the checkout and the
 * fulfilment all quote one `expiresAt`. That equivalence is load-bearing and
 * nothing in the type system holds it up, which is why it is written here.
 *
 * WHAT BREAKS IF IT EVER DIVERGES. Give
 * {@link resolveIntakeResetCapabilities} a second narrowing condition, or drop
 * or widen the `flags.directPurchase` guard on the ledger branch, and the two
 * maps stop agreeing silently — fulfilment carries on reading the wider
 * flag-pure one. The dangerous direction is the offer quoting an
 * `UNTIL_NEXT_RESET` expiry that fulfilment then refuses:
 * `ensureLiveResetEpoch` returns `null`, `applyAddOnViaLedger` falls through
 * to the PERMANENT legacy increment, and a temporary top-up is delivered
 * forever — unpriced, with no entitlement row to expire and no projection to
 * report drift against. Change either half and change that call site in the
 * same commit.
 */
export function resolveResetCapabilities(env: NodeJS.ProcessEnv = process.env): ResetCapabilityMap {
  const flags = resolveAddOnRolloutFlags(env);
  const map: Partial<Record<ResetStrategy, 'ENABLED'>> = {};
  if (flags.resetExpiry.DAY) map.DAY = 'ENABLED';
  if (flags.resetExpiry.WEEK) map.WEEK = 'ENABLED';
  if (flags.resetExpiry.MONTH) map.MONTH = 'ENABLED';
  if (flags.resetExpiry.MONTH_ROLLING) map.MONTH_ROLLING = 'ENABLED';
  return map;
}

/**
 * The reset-cycle capability map as the money INTAKE may use it — the single
 * seam that decides whether a `UNTIL_NEXT_RESET` add-on may be SOLD.
 *
 * It is {@link resolveResetCapabilities} narrowed by ONE extra condition:
 * `directPurchase` must be on. That flag guards the intake
 * (`PaymentSubscriptionMutationService.applyAddOnViaLedger`) which is the only
 * code that binds a purchased entitlement to a reset epoch. With it off, a
 * captured add-on falls through to the PERMANENT legacy increment, so a
 * reset-scoped one would deliver the service forever instead of until the next
 * reset — more than was sold, unpriced, and with no entitlement row to expire.
 *
 * Both selling sides read THIS function and nothing else:
 *  - `AddOnEligibilityService.getResetCapabilities` (the offer), and
 *  - `AddOnPurchaseService.checkout` (the direct-purchase checkout).
 * They used to disagree by omission — the offer withheld, the checkout did not
 * ask — which is exactly how a crafted or stale checkout sold a temporary
 * top-up that was fulfilled permanently.
 *
 * Deliberately SEPARATE from {@link resolveResetCapabilities}, which
 * `EntitlementBoundaryService` uses to EXPIRE entitlements that already exist.
 * Expiry of prior goods must not depend on whether intake is open, so that
 * resolver stays flag-pure; fusing the two would strand paid entitlements the
 * day an operator closes direct purchase.
 *
 * The fulfilment path reads the flag-pure resolver too, and the note on
 * {@link resolveResetCapabilities} explains why the two maps coincide there
 * and what breaks if this function ever gains a second narrowing condition.
 * Read it before changing the condition below.
 */
export function resolveIntakeResetCapabilities(
  env: NodeJS.ProcessEnv = process.env,
): ResetCapabilityMap {
  if (!resolveAddOnRolloutFlags(env).directPurchase) return {};
  return resolveResetCapabilities(env);
}
