/**
 * Tunables for the subscription-sharing detectors.
 *
 * THIS FILE IS THE **FALLBACK** LAYER, NOT THE EFFECTIVE ONE.
 * ──────────────────────────────────────────────────────────
 * Since these knobs became operator-editable from the admin panel, precedence
 * is: **a stored panel value wins; the environment variable is only the
 * fallback default; the constant below is the fallback's own fallback.**
 * `resolveSharingDetectionConfig` answers "env, else built-in default" and
 * nothing more — the overlay that lets a panel value beat it lives in
 * `settings/utils/anti-fraud-settings.util.ts`, and the detectors read the
 * combined result through `AntiFraudTunablesService`. Deployments that already
 * set the variables below keep working untouched: an operator who never opens
 * the new tab gets exactly the behaviour they have today.
 *
 * ONE KNOB IS DELIBERATELY EXCLUDED FROM THE ENV LAYER.
 * ────────────────────────────────────────────────────
 * `ipConcurrencyWindowSeconds` is NEW. Every other variable read below existed
 * before the panel learned to hold these values, which is the entire reason the
 * env layer is still here — dropping it would silently retune deployments that
 * already set one. A brand-new knob has no such history: there is no
 * `ANTIFRAUD_SHARING_IP_CONCURRENCY_WINDOW_SECONDS` anybody could already be
 * setting, so an env layer for it buys zero compatibility and costs a second
 * place a value can come from. It is panel-editable like the rest, so its
 * precedence is just `stored panel value → built-in default`. This is the same
 * reasoning, and the same outcome, as `subscription-ua-detection.config.ts`
 * (see its header) — which refuses an env layer for all three of ITS new knobs.
 * A new tunable added here should follow suit unless it is replacing a variable
 * that already shipped.
 *
 * The ranges and defaults are declared ONCE, in the two exported tables below,
 * so the env parser here, the panel-settings validator, the PATCH DTO and the
 * admin form cannot drift apart. Change a bound in one place and it moves
 * everywhere.
 *
 * All values are resolved once per call (cheap) so tests can override
 * `process.env` without module-reload gymnastics.
 *
 * REMOVED: `jobPollAttempts` / `jobPollIntervalMs`
 * (`ANTIFRAUD_SHARING_JOB_POLL_ATTEMPTS`, `..._JOB_POLL_INTERVAL_MS`). They
 * were resolved here and read by nobody: `RemnawaveApiService.pollIpControlJob`
 * takes its attempts/interval as optional arguments and defaults them to 12 and
 * 500 ms, and `fetchUsersIpsForNode` passes neither. Setting either variable
 * changed nothing. They are deleted rather than wired because wiring them means
 * threading the values through `remnawave-api.service.ts`, which this change
 * does not own — and because a knob that lies about what it controls is worse
 * than no knob. Neither appeared in `.env.example`, so no documented operator
 * contract is broken by their removal; if the poll budget ever needs to be
 * tunable, add it back together with the parameter pass-through in the same
 * change.
 */
export interface SharingDetectionConfig {
  /** Enable the HWID device-overage detector. */
  readonly enableHwidOverage: boolean;
  /**
   * Enable the concurrent-IP (network) sharing detector. OFF by default:
   * device-identity (HWID overage) is the authoritative, low-false-positive
   * sharing signal. The IP detector is advisory only — even when enabled it
   * counts distinct *networks* (not raw IPs) and emits LOW/MEDIUM, never HIGH.
   */
  readonly enableIpSharing: boolean;
  /**
   * Staleness bound: an IP sample older than this many minutes is evicted and
   * never considered. This is a LOOKBACK, not a concurrency test — see
   * {@link SharingDetectionConfig.ipConcurrencyWindowSeconds}, which is what
   * decides whether two surviving samples were actually simultaneous.
   */
  readonly ipWindowMinutes: number;
  /**
   * Concurrency window: how close two of a user's sightings must be for them to
   * count as *at the same time*.
   *
   * WHY THIS EXISTS. The panel gives us `{ ip, lastSeen }` and nothing else —
   * no connect/disconnect times, so no interval to intersect. Under the old
   * code every IP inside `ipWindowMinutes` was counted, which meant a person on
   * Wi-Fi at T−9m and on LTE at T−1m read as "two simultaneous networks". That
   * is one phone walking out of the house, and it was the single largest source
   * of false accusations in this detector.
   *
   * What `lastSeen` actually means is "the last moment this IP carried traffic
   * for this user". A live connection refreshes it continuously; an abandoned
   * one freezes at the moment it was abandoned. So `anchor − lastSeen`, where
   * the anchor is that user's OWN most recent sighting, is a usable proxy for
   * "were these two in use together?" — and sequential switching collapses to a
   * single network because the abandoned IP's clock stopped.
   *
   * Default 180s. It has to be wide enough to cover, in order of size:
   *   • the detector's own multi-node walk — up to `maxNodesPerRun` (25) job
   *     round-trips, each polled at 500 ms, so the first node's samples can be
   *     a minute or more older than the last node's for a user genuinely on
   *     both. A window under that would make cross-node sharing invisible;
   *   • idle keepalive gaps on a connected-but-quiet device (WireGuard's
   *     persistent keepalive is 25 s; mux/TCP heartbeats are of that order);
   *   • node clock skew.
   * And narrow enough to be a real gate: it cuts the sequential-switch exposure
   * from the full 10-minute lookback to 3 minutes. Combined with
   * `ipOverageMargin`, a single user now has to change networks twice inside
   * three minutes, into distinct /24s, before they can be named.
   *
   * Seconds rather than minutes because the interesting tuning range (roughly
   * 60–300 s) is finer than a minute-granular knob can express. The 15 s floor
   * exists so a mis-set value cannot silently reduce every user to one network
   * and turn the detector into one that can never fire; setting it at or above
   * `ipWindowMinutes` disables the gate and restores the old lookback semantics.
   */
  readonly ipConcurrencyWindowSeconds: number;
  /** Max connected nodes probed per detector run (protects nodes). */
  readonly maxNodesPerRun: number;
  /** Cap on the number of IP samples persisted in signal metadata. */
  readonly maxIpsInMetadata: number;
  /**
   * Group source IPs into networks before counting, so a single user roaming
   * within one carrier / home subnet (or IPv6 privacy-address rotation) isn't
   * flagged. When off, the detector falls back to raw distinct-IP counting.
   */
  readonly ipNetworkGrouping: boolean;
  /** IPv4 prefix length used for network grouping (e.g. 24 → /24). */
  readonly ipV4PrefixLength: number;
  /** IPv6 prefix length used for network grouping (e.g. 48 → /48, collapses a delegated site). */
  readonly ipV6PrefixLength: number;
  /**
   * Tolerance added to the device limit before a subscription is flagged:
   * offender ⇔ distinctNetworks > deviceLimit + margin. Absorbs the natural
   * "one extra network" of a legitimate single user (home Wi-Fi + mobile).
   */
  readonly ipOverageMargin: number;
}

/** Range + default metadata for one numeric tunable. */
export interface NumericTunableRange {
  /** Value used when neither the panel nor the environment supplies one. */
  readonly default: number;
  readonly min: number;
  readonly max: number;
  /** Whether a non-integer is a valid value for this knob. */
  readonly integer: boolean;
}

/**
 * The documented range and default of every numeric sharing tunable — the ONE
 * declaration the env parser, the panel validator and the admin form all read.
 *
 * `integer: true` on all of them because the env path parses them with
 * `Number.parseInt`; the panel path rejects fractions for the same reason, so
 * both paths can only ever produce the same kind of value.
 */
export const SHARING_TUNABLE_RANGES = {
  ipWindowMinutes: { default: 10, min: 1, max: 1440, integer: true },
  ipConcurrencyWindowSeconds: { default: 180, min: 15, max: 3600, integer: true },
  maxNodesPerRun: { default: 25, min: 1, max: 500, integer: true },
  maxIpsInMetadata: { default: 20, min: 1, max: 200, integer: true },
  ipV4PrefixLength: { default: 24, min: 8, max: 32, integer: true },
  ipV6PrefixLength: { default: 48, min: 16, max: 128, integer: true },
  ipOverageMargin: { default: 1, min: 0, max: 50, integer: true },
} as const satisfies Record<string, NumericTunableRange>;

/** Defaults for the boolean sharing tunables (nothing to range-check). */
export const SHARING_TUNABLE_BOOLEAN_DEFAULTS = {
  enableHwidOverage: true,
  enableIpSharing: false,
  ipNetworkGrouping: true,
} as const satisfies Record<string, boolean>;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

/**
 * `Number.parseInt` is load-bearing here and must not become `Number`.
 *
 * `Number.parseInt('', 10)` and `Number.parseInt('   ', 10)` are both `NaN`, so
 * an unset or blank variable reaches the `fallback` branch below. `Number('')`
 * is `0` — finite — which would skip the fallback and let the `min` clamp
 * return each range's FLOOR instead of the documented default. That is exactly
 * the bug `traffic-abuse.config.ts` shipped with, and the reason its parser now
 * tests for the empty string explicitly. Verified by
 * `resolveSharingDetectionConfig returns the documented defaults` in
 * `test/sharing-detectors.spec.ts`.
 */
function parseInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

function fromEnv(value: string | undefined, range: NumericTunableRange): number {
  return parseInteger(value, range.default, range.min, range.max);
}

/**
 * "Environment, else built-in default" — the FALLBACK layer. A stored panel
 * value overrides whatever this returns; see the file header.
 */
export function resolveSharingDetectionConfig(
  env: NodeJS.ProcessEnv = process.env,
): SharingDetectionConfig {
  const range = SHARING_TUNABLE_RANGES;
  const bool = SHARING_TUNABLE_BOOLEAN_DEFAULTS;
  return {
    enableHwidOverage: parseBoolean(env.ANTIFRAUD_SHARING_HWID_ENABLED, bool.enableHwidOverage),
    enableIpSharing: parseBoolean(env.ANTIFRAUD_SHARING_IP_ENABLED, bool.enableIpSharing),
    ipWindowMinutes: fromEnv(env.ANTIFRAUD_SHARING_IP_WINDOW_MINUTES, range.ipWindowMinutes),
    // No `fromEnv`, and no variable to read: this knob is new, so the env layer
    // would be a second source of truth that buys no backward compatibility.
    // See the header. Operators tune it in the admin panel; the panel overlay
    // in `settings/utils/anti-fraud-settings.util.ts` takes it from there.
    ipConcurrencyWindowSeconds: range.ipConcurrencyWindowSeconds.default,
    maxNodesPerRun: fromEnv(env.ANTIFRAUD_SHARING_MAX_NODES_PER_RUN, range.maxNodesPerRun),
    maxIpsInMetadata: fromEnv(env.ANTIFRAUD_SHARING_MAX_IPS_IN_METADATA, range.maxIpsInMetadata),
    ipNetworkGrouping: parseBoolean(
      env.ANTIFRAUD_SHARING_IP_NETWORK_GROUPING,
      bool.ipNetworkGrouping,
    ),
    ipV4PrefixLength: fromEnv(env.ANTIFRAUD_SHARING_IP_V4_PREFIX, range.ipV4PrefixLength),
    ipV6PrefixLength: fromEnv(env.ANTIFRAUD_SHARING_IP_V6_PREFIX, range.ipV6PrefixLength),
    ipOverageMargin: fromEnv(env.ANTIFRAUD_SHARING_IP_OVERAGE_MARGIN, range.ipOverageMargin),
  };
}
