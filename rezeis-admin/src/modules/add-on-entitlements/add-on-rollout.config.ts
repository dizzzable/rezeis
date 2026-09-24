import { Logger } from '@nestjs/common';

import { ResetCapabilityMap, ResetStrategy } from './domain/reset-cycle-policy';

/**
 * Staged rollout flags for the durable add-on entitlement feature.
 *
 * Each flag has a DEFAULT in {@link ADD_ON_ROLLOUT_FLAG_DEFAULTS}, which is
 * what an install gets while the variable is unset. Flags are read from the
 * environment (resolved per call so tests can vary `process.env` without
 * module-reload gymnastics) — they are deployment-time toggles, deliberately
 * NOT panel-editable, so a stage can never be flipped from the admin UI by
 * accident: entry into the model is one-way per subscription, and the web and
 * worker processes must change together, which a `.env` edit plus
 * `docker compose up -d` does and a settings row does not.
 *
 * Rollout order (each stage assumes the previous):
 *  1. `entitlementShadow`       — subscriptions ENTER the term model (the
 *                                 background cutover and the renewal/upgrade
 *                                 term producers); legacy limits stay what is
 *                                 pushed.
 *  2. `directPurchase`          — new checkouts commit the ledger.
 *  3. `projectionSync`          — versioned desired writes drive Remnawave.
 *  4. `resetExpiry.<strategy>`  — per-strategy commercial reset expiry (after parity).
 *  5. `renewalAddOns`           — scheduled renewal composition.
 *  6. `deviceCleanupAuto`       — automatic HWID reduction.
 *
 * WHAT A FLAG DOES NOT DECIDE. Once a subscription has a term, how that term
 * is rotated, aligned and expired follows the term row, never a flag: the
 * boundary sweep, the cutover's `ensureTermInTransaction`, the plan-change
 * rotation and the tail alignment read no flag at all. Turning stage 1 off
 * therefore stops NEW entrants; it does not strand the ones already in.
 */
export interface AddOnRolloutFlags {
  readonly entitlementShadow: boolean;
  readonly directPurchase: boolean;
  readonly projectionSync: boolean;
  readonly renewalAddOns: boolean;
  readonly deviceCleanupAuto: boolean;
  readonly resetExpiry: Readonly<Record<Exclude<ResetStrategy, 'NO_RESET'>, boolean>>;
}

/** Every rollout variable this module reads. */
export type AddOnRolloutFlagName =
  | 'ADDON_ENTITLEMENT_SHADOW'
  | 'ADDON_ENTITLEMENT_DIRECT_PURCHASE'
  | 'ADDON_PROJECTION_SYNC'
  | 'ADDON_RENEWAL_ADDONS'
  | 'ADDON_DEVICE_CLEANUP_AUTO'
  | 'ADDON_RESET_EXPIRY_DAY'
  | 'ADDON_RESET_EXPIRY_WEEK'
  | 'ADDON_RESET_EXPIRY_MONTH'
  | 'ADDON_RESET_EXPIRY_MONTH_ROLLING';

export type AddOnRolloutFlagDefaults = Readonly<Record<AddOnRolloutFlagName, boolean>>;

/**
 * THE DEFAULTS, IN ONE PLACE: what an install runs with while the variable is
 * unset.
 *
 * STAGES 1, 2 AND 6 ARE ON, STAGES 3, 4 AND 5 OFF — the owner's decision of
 * 24.09.2026, shipped once renewals, upgrades and plan changes gated on the
 * term row, payments brought subscriptions in lazily, and the background
 * cutover existed (`EntitlementCutoverJobService`). An install that sets
 * nothing gets the model on its first boot of this version. Why the OFF ones
 * stay OFF:
 *   - stage 3: the versioned PATCH omits `expireAt`, `status`, `description`
 *     and the contacts, so a paid upgrade would never move the panel expiry;
 *   - stage 4: no parity evidence against the served Remnawave 3.x lines;
 *   - stage 5: the owner's decision.
 *
 * An explicit value always wins over the default, in BOTH directions — see
 * {@link parseFlag}. That is what makes the flip reversible per install with
 * one `.env` line per stage (`ADDON_ENTITLEMENT_SHADOW=false` and so on); what
 * switching off does NOT undo is in `docs/operator-add-on-entitlements-rollout.md`
 * («Rollback»). `.env.example` and `docs/environment.md` state every default
 * below, and `add-on-rollout.config.spec.ts` holds them to it.
 */
export const ADD_ON_ROLLOUT_FLAG_DEFAULTS: AddOnRolloutFlagDefaults = {
  ADDON_ENTITLEMENT_SHADOW: true,
  ADDON_ENTITLEMENT_DIRECT_PURCHASE: true,
  ADDON_PROJECTION_SYNC: false,
  ADDON_RENEWAL_ADDONS: false,
  ADDON_DEVICE_CLEANUP_AUTO: true,
  ADDON_RESET_EXPIRY_DAY: false,
  ADDON_RESET_EXPIRY_WEEK: false,
  ADDON_RESET_EXPIRY_MONTH: false,
  ADDON_RESET_EXPIRY_MONTH_ROLLING: false,
};

const LOGGER = new Logger('AddOnRolloutFlags');

/** `name=value` pairs already warned about, so a per-call read warns once. */
const warnedUnknownValues = new Set<string>();

/** What an operator writes for ON, and for OFF — compared lower-cased and trimmed. */
const ON_SPELLINGS: ReadonlySet<string> = new Set(['true', '1', 'on', 'yes']);
const OFF_SPELLINGS: ReadonlySet<string> = new Set(['false', '0', 'off', 'no']);

/**
 * One rollout flag, read against its default.
 *
 * `true`, `1`, `on` or `yes` is ON and `false`, `0`, `off` or `no` is OFF,
 * case-insensitively and with surrounding whitespace ignored; unset or empty is
 * the default. Anything else is the default too, with a warning naming the
 * variable — once per distinct value, because flags are read per call.
 *
 * THE OFF SPELLINGS ARE THE ONES THAT MATTER. With a default that is ON, the
 * only way an operator turns a stage off is an explicit value, and the old
 * reader (`value === 'true' || value === '1'`) could not express that at all:
 * everything that was not ON was simply "not ON", which is the default again.
 * A `False` or ` false` that silently kept a stage ON would be the one
 * rollback that does not roll back — and so would `off` and `no`, which this
 * reader also took for the default until 24.09.2026: once the defaults are
 * ON, an operator who "switched it off" in their own words would have got it
 * ON, with only a log line to say so.
 */
export function parseFlag(
  value: string | undefined,
  defaultValue: boolean,
  name: string = 'ADDON_*',
): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return defaultValue;
  if (ON_SPELLINGS.has(normalized)) return true;
  if (OFF_SPELLINGS.has(normalized)) return false;
  const key = `${name}=${value}`;
  if (!warnedUnknownValues.has(key)) {
    warnedUnknownValues.add(key);
    LOGGER.warn(
      `${name}="${value}" is not a recognised value (true, 1, on, yes; false, 0, off, no); ` +
        `using the default, ${defaultValue ? 'ON' : 'OFF'}`,
    );
  }
  return defaultValue;
}

export function resolveAddOnRolloutFlags(
  env: NodeJS.ProcessEnv = process.env,
  defaults: AddOnRolloutFlagDefaults = ADD_ON_ROLLOUT_FLAG_DEFAULTS,
): AddOnRolloutFlags {
  const flag = (name: AddOnRolloutFlagName): boolean => parseFlag(env[name], defaults[name], name);
  return {
    entitlementShadow: flag('ADDON_ENTITLEMENT_SHADOW'),
    directPurchase: flag('ADDON_ENTITLEMENT_DIRECT_PURCHASE'),
    projectionSync: flag('ADDON_PROJECTION_SYNC'),
    renewalAddOns: flag('ADDON_RENEWAL_ADDONS'),
    deviceCleanupAuto: flag('ADDON_DEVICE_CLEANUP_AUTO'),
    resetExpiry: {
      DAY: flag('ADDON_RESET_EXPIRY_DAY'),
      WEEK: flag('ADDON_RESET_EXPIRY_WEEK'),
      MONTH: flag('ADDON_RESET_EXPIRY_MONTH'),
      MONTH_ROLLING: flag('ADDON_RESET_EXPIRY_MONTH_ROLLING'),
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
