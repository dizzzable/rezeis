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
