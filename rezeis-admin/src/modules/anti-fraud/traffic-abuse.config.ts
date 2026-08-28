/**
 * Tunables for the per-user node-traffic-abuse detector.
 *
 * Powered by the panel's `bandwidth-stats/nodes/users` endpoint (per-user
 * traffic across nodes). The detector is **advisory** — it flags users whose
 * bandwidth is a clear outlier (heavy enough in absolute terms AND far above
 * the cohort), which on a VPN usually means torrenting / bulk transfer / a
 * shared account. Conservative defaults keep false positives low.
 *
 * THIS FILE IS THE **FALLBACK** LAYER, NOT THE EFFECTIVE ONE.
 * ──────────────────────────────────────────────────────────
 * Precedence: **a stored panel value wins; the environment variable is only
 * the fallback default; the constant in the table below is the fallback's own
 * fallback.** `resolveTrafficAbuseConfig` answers "env, else built-in default"
 * and nothing more — the overlay that lets a panel value beat it lives in
 * `settings/utils/anti-fraud-settings.util.ts`, and the detector reads the
 * combined result through `AntiFraudTunablesService`. Existing deployments
 * that set the variables keep working exactly as before.
 *
 * The ranges and defaults are declared ONCE, in the exported table below, so
 * the env parser here, the panel validator, the PATCH DTO and the admin form
 * cannot drift apart.
 */
import type { NumericTunableRange } from './sharing-detection.config';

export interface TrafficAbuseConfig {
  /**
   * Master switch for the detector, and now the ONLY switch.
   *
   * It used to say "also gated by the 2.8 capability", and that second gate
   * is gone with 2.x support. Worth recording why its removal is a gain
   * rather than a loss of safety: the capability answered "stand down" for an
   * UNKNOWN panel version as well as for an old one, and unknown is the state
   * a perfectly healthy panel passes through whenever the version probe has a
   * bad moment. So the detector fell silent exactly when silence is
   * indistinguishable from a clean panel. A 2.x panel is now turned away
   * centrally by `LegacyPanelRefusal`, once, with a message naming the remedy.
   */
  readonly enabled: boolean;
  /** Absolute floor: ignore anyone below this many GB over the panel window. */
  readonly minGb: number;
  /** Flag when a user's traffic is at least this multiple of the cohort median. */
  readonly medianMultiplier: number;
  /** …or when a single user holds at least this share (%) of the top-users total. */
  readonly sharePercent: number;
  /** Max connected nodes aggregated per run (bounds the panel call). */
  readonly maxNodesPerRun: number;
}

/**
 * The documented range and default of every numeric traffic-abuse tunable —
 * the ONE declaration the env parser, the panel validator and the admin form
 * all read.
 *
 * `integer: false` throughout because the env path parses these with `Number`,
 * so `4.5` has always been an accepted multiplier. Keeping the panel path
 * equally permissive means neither path can produce a value the other could
 * not, which is the property that makes the two interchangeable.
 */
export const TRAFFIC_ABUSE_TUNABLE_RANGES = {
  minGb: { default: 200, min: 1, max: 100_000, integer: false },
  medianMultiplier: { default: 4, min: 1.5, max: 100, integer: false },
  sharePercent: { default: 35, min: 5, max: 100, integer: false },
  maxNodesPerRun: { default: 25, min: 1, max: 500, integer: false },
} as const satisfies Record<string, NumericTunableRange>;

/** Default for the boolean traffic-abuse tunable (nothing to range-check). */
export const TRAFFIC_ABUSE_TUNABLE_BOOLEAN_DEFAULTS = {
  enabled: true,
} as const satisfies Record<string, boolean>;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

function parseNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  // The absent case MUST be handled before coercion. `Number('')` is `0` — a
  // finite number — so `Number(value ?? '')` made the `fallback` branch below
  // unreachable for an unset variable, and the `parsed < min` clamp then
  // returned the FLOOR instead. Every default in this file was silently the
  // minimum of its range: the detector ran at 1 GB / 1.5× / 5% / 1 node
  // instead of 200 / 4 / 35 / 25, i.e. flagging almost anyone above 1 GB
  // while scanning a single arbitrary node per run.
  // `sharing-detection.config.ts` is not affected — `Number.parseInt('')` is
  // `NaN`, which does reach its fallback.
  if (value === undefined || value.trim().length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

function fromEnv(value: string | undefined, range: NumericTunableRange): number {
  return parseNumber(value, range.default, range.min, range.max);
}

/**
 * "Environment, else built-in default" — the FALLBACK layer. A stored panel
 * value overrides whatever this returns; see the file header.
 */
export function resolveTrafficAbuseConfig(
  env: NodeJS.ProcessEnv = process.env,
): TrafficAbuseConfig {
  const range = TRAFFIC_ABUSE_TUNABLE_RANGES;
  return {
    enabled: parseBoolean(
      env.ANTIFRAUD_NODE_TRAFFIC_USER_ENABLED,
      TRAFFIC_ABUSE_TUNABLE_BOOLEAN_DEFAULTS.enabled,
    ),
    minGb: fromEnv(env.ANTIFRAUD_NODE_TRAFFIC_MIN_GB, range.minGb),
    medianMultiplier: fromEnv(env.ANTIFRAUD_NODE_TRAFFIC_MEDIAN_MULTIPLIER, range.medianMultiplier),
    sharePercent: fromEnv(env.ANTIFRAUD_NODE_TRAFFIC_SHARE_PERCENT, range.sharePercent),
    maxNodesPerRun: fromEnv(env.ANTIFRAUD_NODE_TRAFFIC_MAX_NODES, range.maxNodesPerRun),
  };
}
