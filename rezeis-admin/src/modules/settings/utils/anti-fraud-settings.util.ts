/**
 * Anti-fraud detector tunables (panel-managed, env fallback)
 * ─────────────────────────────────────────────────────────
 * Stored in `Settings.antiFraudSettings` (JSON). Backs the "Anti-fraud" tab of
 * the panel settings hub and, through `AntiFraudTunablesService`, the four
 * detectors that read these knobs.
 *
 * PRECEDENCE — say it once, here, and never contradict it:
 *
 *     stored panel value  →  environment variable  →  built-in default
 *          (wins)                (fallback)            (fallback's fallback)
 *
 * The env layer is `resolveSharingDetectionConfig` / `resolveTrafficAbuseConfig`
 * verbatim, so a deployment that already sets `ANTIFRAUD_*` keeps behaving
 * exactly as it does today until somebody edits the field in the panel. Once a
 * field IS stored, the panel number is the one in force and the env value only
 * shows up in the form as "environment: N" — this is why the view below carries
 * `fallback` and `overridden` alongside `effective`: an operator who set an env
 * var and then sees a different number has to be able to see *why*.
 *
 * THE `subscriptionUa` SECTION HAS NO ENVIRONMENT LAYER, and that is not an
 * omission. Those three knobs are new: no `ANTIFRAUD_UA_*` variable has ever
 * existed, so there is no deployment whose behaviour an env layer would
 * preserve, and adding one would only create a second place a value could come
 * from. Its `fallback` is `defaultSubscriptionUaDetectionConfig()` — the
 * built-in default and nothing else — and the form labels it "default" rather
 * than "environment" so the two-layer section cannot be misread as a
 * three-layer one. Everything else about it (sparse patch, never-clamp overlay,
 * reject-on-write) is identical to its neighbours.
 *
 * WHY A STORED VALUE IS NEVER CLAMPED ON READ.
 * `traffic-abuse.config.ts` shipped a defect where an *unset* variable reached a
 * `parsed < min` clamp and every default silently collapsed to its range FLOOR —
 * the detector ran at 1 GB / 1.5x / 5% / 1 node instead of 200 / 4 / 35 / 25.
 * The overlay here structurally cannot express that: `pickNumber` only ever
 * returns the operator's own valid value or the fallback, and has no branch that
 * can synthesise a bound. Anything absent, wrong-typed, non-finite, fractional
 * where an integer is required, or out of range is DISCARDED in favour of the
 * fallback — never coerced towards one. The write path (`mergeAntiFraudSettings`
 * plus `UpdateAntiFraudSettingsDto`) rejects such a value outright with a message
 * naming the field and its range, so a bad number from the form is a 400 and not
 * a silent retune.
 *
 * The ranges themselves are NOT redeclared here. They are imported from the two
 * config files that document them, which keeps one source of truth for the env
 * parser, this validator, the DTO and the admin form.
 */

import { BadRequestException } from '@nestjs/common';

import {
  resolveSharingDetectionConfig,
  SHARING_TUNABLE_RANGES,
  type NumericTunableRange,
  type SharingDetectionConfig,
} from '../../anti-fraud/sharing-detection.config';
import {
  defaultSubscriptionUaDetectionConfig,
  SUBSCRIPTION_UA_TUNABLE_RANGES,
  type SubscriptionUaDetectionConfig,
} from '../../anti-fraud/subscription-ua-detection.config';
import {
  resolveTrafficAbuseConfig,
  TRAFFIC_ABUSE_TUNABLE_RANGES,
  type TrafficAbuseConfig,
} from '../../anti-fraud/traffic-abuse.config';
import { readJsonObject } from '../../../common/utils/read-json-object.util';

// ── Stored shape ──────────────────────────────────────────────────────────

/**
 * Raw JSON persisted for the sharing detectors. Deliberately a SPARSE patch:
 * an absent key means "not set in the panel — use the environment", which is
 * the only representation under which the env fallback survives at all.
 */
export interface StoredSharingSettings {
  enableHwidOverage?: boolean;
  enableIpSharing?: boolean;
  enableSharedHwid?: boolean;
  sharedHwidMinAccounts?: number;
  sharedHwidMaxAccounts?: number;
  ipWindowMinutes?: number;
  ipConcurrencyWindowSeconds?: number;
  maxNodesPerRun?: number;
  maxIpsInMetadata?: number;
  ipNetworkGrouping?: boolean;
  ipV4PrefixLength?: number;
  ipV6PrefixLength?: number;
  ipOverageMargin?: number;
}

/** Raw JSON persisted for the per-user node-traffic-abuse detector. */
export interface StoredTrafficAbuseSettings {
  enabled?: boolean;
  minGb?: number;
  medianMultiplier?: number;
  sharePercent?: number;
  maxNodesPerRun?: number;
}

/** Raw JSON persisted for the subscription-fetch User-Agent detector. */
export interface StoredSubscriptionUaSettings {
  enableSubscriptionUaTunnel?: boolean;
  uaEvidenceWindowMinutes?: number;
  uaRequestPageSize?: number;
}

/** Raw JSON shape persisted in `Settings.antiFraudSettings`. */
export interface StoredAntiFraudSettings {
  sharing?: StoredSharingSettings;
  trafficAbuse?: StoredTrafficAbuseSettings;
  subscriptionUa?: StoredSubscriptionUaSettings;
}

/**
 * Patch payload. `null` for a field means "clear the panel value and go back to
 * the environment" — or, for `subscriptionUa`, back to the built-in default,
 * which is the only layer under it; `undefined` (absent) means "leave it alone".
 */
export interface AntiFraudSettingsPatch {
  sharing?: { [K in keyof StoredSharingSettings]?: StoredSharingSettings[K] | null };
  trafficAbuse?: {
    [K in keyof StoredTrafficAbuseSettings]?: StoredTrafficAbuseSettings[K] | null;
  };
  subscriptionUa?: {
    [K in keyof StoredSubscriptionUaSettings]?: StoredSubscriptionUaSettings[K] | null;
  };
}

// ── View returned to the SPA ──────────────────────────────────────────────

/**
 * What the admin form renders.
 *   - `effective` — the values the detectors will actually use on their next run.
 *   - `fallback`  — what `effective` would be with nothing stored (env, else
 *                   built-in default). Shown next to any overridden field so the
 *                   operator can see what the env var says.
 *   - `stored`    — exactly what is in the panel, so the form knows which fields
 *                   it owns and which are inherited.
 *   - `overridden` — the field names currently taken from `stored` rather than
 *                   `fallback`. Not derivable from `stored` alone: a corrupt
 *                   stored value is present but ignored, and the form must not
 *                   claim such a field is in force.
 */
export interface AntiFraudSettingsView {
  readonly effective: {
    readonly sharing: SharingDetectionConfig;
    readonly trafficAbuse: TrafficAbuseConfig;
    readonly subscriptionUa: SubscriptionUaDetectionConfig;
  };
  readonly fallback: {
    readonly sharing: SharingDetectionConfig;
    readonly trafficAbuse: TrafficAbuseConfig;
    /** Built-in defaults — this section has no environment layer. */
    readonly subscriptionUa: SubscriptionUaDetectionConfig;
  };
  readonly stored: StoredAntiFraudSettings;
  readonly overridden: {
    readonly sharing: readonly (keyof StoredSharingSettings)[];
    readonly trafficAbuse: readonly (keyof StoredTrafficAbuseSettings)[];
    readonly subscriptionUa: readonly (keyof StoredSubscriptionUaSettings)[];
  };
  /**
   * The documented bounds, shipped to the form rather than restated in it.
   * The admin SPA has no other source for these, and a hardcoded copy over
   * there would be the one place a range could drift from the config file.
   */
  readonly ranges: {
    readonly sharing: typeof SHARING_TUNABLE_RANGES;
    readonly trafficAbuse: typeof TRAFFIC_ABUSE_TUNABLE_RANGES;
    readonly subscriptionUa: typeof SUBSCRIPTION_UA_TUNABLE_RANGES;
  };
}

/** Effective tunables handed to the detectors. */
export interface AntiFraudTunables {
  readonly sharing: SharingDetectionConfig;
  readonly trafficAbuse: TrafficAbuseConfig;
  readonly subscriptionUa: SubscriptionUaDetectionConfig;
}

// ── Overlay ───────────────────────────────────────────────────────────────

/**
 * Is `value` a usable stored number for `range`?
 *
 * Exported so the write path and the read path answer the question with the
 * same code — a value the writer accepted can never be one the reader silently
 * drops, and vice versa.
 */
export function isValidTunableNumber(value: unknown, range: NumericTunableRange): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (range.integer && !Number.isInteger(value)) return false;
  return value >= range.min && value <= range.max;
}

/**
 * Stored value if it is valid, otherwise the fallback — NEVER a clamp.
 * See the file header for why a clamp here would be a re-run of a shipped bug.
 */
function pickNumber(stored: unknown, fallback: number, range: NumericTunableRange): number {
  return isValidTunableNumber(stored, range) ? stored : fallback;
}

function pickBoolean(stored: unknown, fallback: boolean): boolean {
  return typeof stored === 'boolean' ? stored : fallback;
}

/** Sharing config with any valid stored value laid over the env fallback. */
export function applyStoredSharingSettings(
  fallback: SharingDetectionConfig,
  stored: StoredSharingSettings,
): SharingDetectionConfig {
  const range = SHARING_TUNABLE_RANGES;
  return {
    enableHwidOverage: pickBoolean(stored.enableHwidOverage, fallback.enableHwidOverage),
    enableIpSharing: pickBoolean(stored.enableIpSharing, fallback.enableIpSharing),
    enableSharedHwid: pickBoolean(stored.enableSharedHwid, fallback.enableSharedHwid),
    sharedHwidMinAccounts: pickNumber(
      stored.sharedHwidMinAccounts,
      fallback.sharedHwidMinAccounts,
      range.sharedHwidMinAccounts,
    ),
    sharedHwidMaxAccounts: pickNumber(
      stored.sharedHwidMaxAccounts,
      fallback.sharedHwidMaxAccounts,
      range.sharedHwidMaxAccounts,
    ),
    ipWindowMinutes: pickNumber(
      stored.ipWindowMinutes,
      fallback.ipWindowMinutes,
      range.ipWindowMinutes,
    ),
    ipConcurrencyWindowSeconds: pickNumber(
      stored.ipConcurrencyWindowSeconds,
      fallback.ipConcurrencyWindowSeconds,
      range.ipConcurrencyWindowSeconds,
    ),
    maxNodesPerRun: pickNumber(stored.maxNodesPerRun, fallback.maxNodesPerRun, range.maxNodesPerRun),
    maxIpsInMetadata: pickNumber(
      stored.maxIpsInMetadata,
      fallback.maxIpsInMetadata,
      range.maxIpsInMetadata,
    ),
    ipNetworkGrouping: pickBoolean(stored.ipNetworkGrouping, fallback.ipNetworkGrouping),
    ipV4PrefixLength: pickNumber(
      stored.ipV4PrefixLength,
      fallback.ipV4PrefixLength,
      range.ipV4PrefixLength,
    ),
    ipV6PrefixLength: pickNumber(
      stored.ipV6PrefixLength,
      fallback.ipV6PrefixLength,
      range.ipV6PrefixLength,
    ),
    ipOverageMargin: pickNumber(
      stored.ipOverageMargin,
      fallback.ipOverageMargin,
      range.ipOverageMargin,
    ),
  };
}

/** Traffic-abuse config with any valid stored value laid over the env fallback. */
export function applyStoredTrafficAbuseSettings(
  fallback: TrafficAbuseConfig,
  stored: StoredTrafficAbuseSettings,
): TrafficAbuseConfig {
  const range = TRAFFIC_ABUSE_TUNABLE_RANGES;
  return {
    enabled: pickBoolean(stored.enabled, fallback.enabled),
    minGb: pickNumber(stored.minGb, fallback.minGb, range.minGb),
    medianMultiplier: pickNumber(
      stored.medianMultiplier,
      fallback.medianMultiplier,
      range.medianMultiplier,
    ),
    sharePercent: pickNumber(stored.sharePercent, fallback.sharePercent, range.sharePercent),
    maxNodesPerRun: pickNumber(stored.maxNodesPerRun, fallback.maxNodesPerRun, range.maxNodesPerRun),
  };
}

/**
 * Subscription-UA config with any valid stored value laid over the built-in
 * default. No env layer under it — see the file header.
 */
export function applyStoredSubscriptionUaSettings(
  fallback: SubscriptionUaDetectionConfig,
  stored: StoredSubscriptionUaSettings,
): SubscriptionUaDetectionConfig {
  const range = SUBSCRIPTION_UA_TUNABLE_RANGES;
  return {
    enableSubscriptionUaTunnel: pickBoolean(
      stored.enableSubscriptionUaTunnel,
      fallback.enableSubscriptionUaTunnel,
    ),
    uaEvidenceWindowMinutes: pickNumber(
      stored.uaEvidenceWindowMinutes,
      fallback.uaEvidenceWindowMinutes,
      range.uaEvidenceWindowMinutes,
    ),
    uaRequestPageSize: pickNumber(
      stored.uaRequestPageSize,
      fallback.uaRequestPageSize,
      range.uaRequestPageSize,
    ),
  };
}

/**
 * The effective tunables the detectors run on: stored panel value, else env,
 * else built-in default — except `subscriptionUa`, which has no env layer and
 * goes stored-value-else-default.
 */
export function resolveAntiFraudTunables(
  stored: StoredAntiFraudSettings,
  env: NodeJS.ProcessEnv = process.env,
): AntiFraudTunables {
  return {
    sharing: applyStoredSharingSettings(resolveSharingDetectionConfig(env), stored.sharing ?? {}),
    trafficAbuse: applyStoredTrafficAbuseSettings(
      resolveTrafficAbuseConfig(env),
      stored.trafficAbuse ?? {},
    ),
    subscriptionUa: applyStoredSubscriptionUaSettings(
      defaultSubscriptionUaDetectionConfig(),
      stored.subscriptionUa ?? {},
    ),
  };
}

// ── Reading the column ────────────────────────────────────────────────────

const SHARING_BOOLEAN_KEYS = [
  'enableHwidOverage',
  'enableIpSharing',
  'enableSharedHwid',
  'ipNetworkGrouping',
] as const satisfies readonly (keyof StoredSharingSettings)[];

const SHARING_NUMBER_KEYS = Object.keys(
  SHARING_TUNABLE_RANGES,
) as readonly (keyof typeof SHARING_TUNABLE_RANGES)[];

const TRAFFIC_NUMBER_KEYS = Object.keys(
  TRAFFIC_ABUSE_TUNABLE_RANGES,
) as readonly (keyof typeof TRAFFIC_ABUSE_TUNABLE_RANGES)[];

const SUBSCRIPTION_UA_NUMBER_KEYS = Object.keys(
  SUBSCRIPTION_UA_TUNABLE_RANGES,
) as readonly (keyof typeof SUBSCRIPTION_UA_TUNABLE_RANGES)[];

/**
 * Coerces the JSON column into the stored shape, keeping only keys of the right
 * primitive type. Range checking is NOT done here — an out-of-range stored value
 * survives into `stored` (so the view can show it and the operator can see what
 * is in the column) but is discarded by the overlay, which is what decides what
 * actually runs.
 */
export function readStoredAntiFraudSettings(value: unknown): StoredAntiFraudSettings {
  const root = readJsonObject(value);
  const rawSharing = readJsonObject(root.sharing);
  const rawTraffic = readJsonObject(root.trafficAbuse);
  const rawSubscriptionUa = readJsonObject(root.subscriptionUa);

  const sharing: StoredSharingSettings = {};
  for (const key of SHARING_BOOLEAN_KEYS) {
    if (typeof rawSharing[key] === 'boolean') sharing[key] = rawSharing[key];
  }
  for (const key of SHARING_NUMBER_KEYS) {
    const candidate = rawSharing[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) sharing[key] = candidate;
  }

  const trafficAbuse: StoredTrafficAbuseSettings = {};
  if (typeof rawTraffic.enabled === 'boolean') trafficAbuse.enabled = rawTraffic.enabled;
  for (const key of TRAFFIC_NUMBER_KEYS) {
    const candidate = rawTraffic[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) trafficAbuse[key] = candidate;
  }

  const subscriptionUa: StoredSubscriptionUaSettings = {};
  if (typeof rawSubscriptionUa.enableSubscriptionUaTunnel === 'boolean') {
    subscriptionUa.enableSubscriptionUaTunnel = rawSubscriptionUa.enableSubscriptionUaTunnel;
  }
  for (const key of SUBSCRIPTION_UA_NUMBER_KEYS) {
    const candidate = rawSubscriptionUa[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) subscriptionUa[key] = candidate;
  }

  const result: StoredAntiFraudSettings = {};
  if (Object.keys(sharing).length > 0) result.sharing = sharing;
  if (Object.keys(trafficAbuse).length > 0) result.trafficAbuse = trafficAbuse;
  if (Object.keys(subscriptionUa).length > 0) result.subscriptionUa = subscriptionUa;
  return result;
}

// ── View ──────────────────────────────────────────────────────────────────

export function toAntiFraudSettingsView(
  stored: StoredAntiFraudSettings,
  env: NodeJS.ProcessEnv = process.env,
): AntiFraudSettingsView {
  const fallbackSharing = resolveSharingDetectionConfig(env);
  const fallbackTraffic = resolveTrafficAbuseConfig(env);
  const fallbackSubscriptionUa = defaultSubscriptionUaDetectionConfig();
  const storedSharing = stored.sharing ?? {};
  const storedTraffic = stored.trafficAbuse ?? {};
  const storedSubscriptionUa = stored.subscriptionUa ?? {};

  const overriddenSharing = (
    [...SHARING_BOOLEAN_KEYS, ...SHARING_NUMBER_KEYS] as (keyof StoredSharingSettings)[]
  ).filter((key) => {
    const value = storedSharing[key];
    if (typeof value === 'boolean') return true;
    const range = SHARING_TUNABLE_RANGES[key as keyof typeof SHARING_TUNABLE_RANGES];
    return range !== undefined && isValidTunableNumber(value, range);
  });

  const overriddenTraffic = (
    ['enabled', ...TRAFFIC_NUMBER_KEYS] as (keyof StoredTrafficAbuseSettings)[]
  ).filter((key) => {
    const value = storedTraffic[key];
    if (typeof value === 'boolean') return true;
    const range = TRAFFIC_ABUSE_TUNABLE_RANGES[key as keyof typeof TRAFFIC_ABUSE_TUNABLE_RANGES];
    return range !== undefined && isValidTunableNumber(value, range);
  });

  const overriddenSubscriptionUa = (
    [
      'enableSubscriptionUaTunnel',
      ...SUBSCRIPTION_UA_NUMBER_KEYS,
    ] as (keyof StoredSubscriptionUaSettings)[]
  ).filter((key) => {
    const value = storedSubscriptionUa[key];
    if (typeof value === 'boolean') return true;
    const range = SUBSCRIPTION_UA_TUNABLE_RANGES[key as keyof typeof SUBSCRIPTION_UA_TUNABLE_RANGES];
    return range !== undefined && isValidTunableNumber(value, range);
  });

  return {
    effective: {
      sharing: applyStoredSharingSettings(fallbackSharing, storedSharing),
      trafficAbuse: applyStoredTrafficAbuseSettings(fallbackTraffic, storedTraffic),
      subscriptionUa: applyStoredSubscriptionUaSettings(
        fallbackSubscriptionUa,
        storedSubscriptionUa,
      ),
    },
    fallback: {
      sharing: fallbackSharing,
      trafficAbuse: fallbackTraffic,
      subscriptionUa: fallbackSubscriptionUa,
    },
    stored,
    overridden: {
      sharing: overriddenSharing,
      trafficAbuse: overriddenTraffic,
      subscriptionUa: overriddenSubscriptionUa,
    },
    ranges: {
      sharing: SHARING_TUNABLE_RANGES,
      trafficAbuse: TRAFFIC_ABUSE_TUNABLE_RANGES,
      subscriptionUa: SUBSCRIPTION_UA_TUNABLE_RANGES,
    },
  };
}

// ── Merge (write path) ────────────────────────────────────────────────────

function describeRange(range: NumericTunableRange): string {
  return `${range.integer ? 'an integer' : 'a number'} between ${range.min} and ${range.max}`;
}

/**
 * Validates one incoming number and returns it, or throws.
 *
 * This is the second of two gates — `UpdateAntiFraudSettingsDto` is the first.
 * It exists so the invariant holds even if the DTO is later loosened, and so a
 * caller that bypasses the HTTP layer cannot write a value the reader would
 * silently ignore. Rejecting is the whole point: clamping here is what would
 * turn "operator typed 0" into "detector now runs at its floor" without anyone
 * being told.
 */
function requireValidNumber(
  section: string,
  key: string,
  value: unknown,
  range: NumericTunableRange,
): number {
  if (!isValidTunableNumber(value, range)) {
    throw new BadRequestException(
      `antiFraudSettings.${section}.${key} must be ${describeRange(range)} (received ${JSON.stringify(value)})`,
    );
  }
  return value;
}

function requireBoolean(section: string, key: string, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new BadRequestException(
      `antiFraudSettings.${section}.${key} must be a boolean (received ${JSON.stringify(value)})`,
    );
  }
  return value;
}

/**
 * Applies a patch to the stored JSON. `null` clears a field (back to env);
 * `undefined` leaves it untouched; anything else is validated and stored.
 */
export function mergeAntiFraudSettings(
  previous: StoredAntiFraudSettings,
  patch: AntiFraudSettingsPatch,
): StoredAntiFraudSettings {
  const next: StoredAntiFraudSettings = {
    ...(previous.sharing ? { sharing: { ...previous.sharing } } : {}),
    ...(previous.trafficAbuse ? { trafficAbuse: { ...previous.trafficAbuse } } : {}),
    ...(previous.subscriptionUa ? { subscriptionUa: { ...previous.subscriptionUa } } : {}),
  };

  if (patch.sharing !== undefined) {
    const sharing: StoredSharingSettings = { ...(next.sharing ?? {}) };
    for (const key of SHARING_BOOLEAN_KEYS) {
      const value = patch.sharing[key];
      if (value === undefined) continue;
      if (value === null) delete sharing[key];
      else sharing[key] = requireBoolean('sharing', key, value);
    }
    for (const key of SHARING_NUMBER_KEYS) {
      const value = patch.sharing[key];
      if (value === undefined) continue;
      if (value === null) delete sharing[key];
      else sharing[key] = requireValidNumber('sharing', key, value, SHARING_TUNABLE_RANGES[key]);
    }
    if (Object.keys(sharing).length > 0) next.sharing = sharing;
    else delete next.sharing;
  }

  if (patch.trafficAbuse !== undefined) {
    const trafficAbuse: StoredTrafficAbuseSettings = { ...(next.trafficAbuse ?? {}) };
    const enabled = patch.trafficAbuse.enabled;
    if (enabled === null) delete trafficAbuse.enabled;
    else if (enabled !== undefined) {
      trafficAbuse.enabled = requireBoolean('trafficAbuse', 'enabled', enabled);
    }
    for (const key of TRAFFIC_NUMBER_KEYS) {
      const value = patch.trafficAbuse[key];
      if (value === undefined) continue;
      if (value === null) delete trafficAbuse[key];
      else {
        trafficAbuse[key] = requireValidNumber(
          'trafficAbuse',
          key,
          value,
          TRAFFIC_ABUSE_TUNABLE_RANGES[key],
        );
      }
    }
    if (Object.keys(trafficAbuse).length > 0) next.trafficAbuse = trafficAbuse;
    else delete next.trafficAbuse;
  }

  if (patch.subscriptionUa !== undefined) {
    const subscriptionUa: StoredSubscriptionUaSettings = { ...(next.subscriptionUa ?? {}) };
    const enabled = patch.subscriptionUa.enableSubscriptionUaTunnel;
    if (enabled === null) delete subscriptionUa.enableSubscriptionUaTunnel;
    else if (enabled !== undefined) {
      subscriptionUa.enableSubscriptionUaTunnel = requireBoolean(
        'subscriptionUa',
        'enableSubscriptionUaTunnel',
        enabled,
      );
    }
    for (const key of SUBSCRIPTION_UA_NUMBER_KEYS) {
      const value = patch.subscriptionUa[key];
      if (value === undefined) continue;
      if (value === null) delete subscriptionUa[key];
      else {
        subscriptionUa[key] = requireValidNumber(
          'subscriptionUa',
          key,
          value,
          SUBSCRIPTION_UA_TUNABLE_RANGES[key],
        );
      }
    }
    if (Object.keys(subscriptionUa).length > 0) next.subscriptionUa = subscriptionUa;
    else delete next.subscriptionUa;
  }

  return next;
}
