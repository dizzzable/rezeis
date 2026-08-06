/**
 * Tunables for the subscription-fetch User-Agent (re-host / double-tunnel)
 * detector.
 *
 * THIS FILE IS THE **FALLBACK** LAYER, NOT THE EFFECTIVE ONE — but with only
 * two layers, not three.
 * ────────────────────────────────────────────────────────────────────────────
 * Its neighbours (`sharing-detection.config.ts`, `traffic-abuse.config.ts`)
 * resolve "stored panel value → `ANTIFRAUD_*` environment variable → built-in
 * default", because those knobs WERE environment variables before the panel
 * learned to hold them and removing that layer would silently retune every
 * deployment that sets one.
 *
 * These three knobs have no such history. They are new, so there is no
 * `ANTIFRAUD_UA_*` variable anybody could already be setting, and none is being
 * introduced: an env layer nothing has ever written to buys no compatibility and
 * costs a second place a value can come from. Precedence here is therefore just
 *
 *     stored panel value  →  built-in default
 *          (wins)              (fallback)
 *
 * and {@link defaultSubscriptionUaDetectionConfig} is that fallback in full.
 * The admin form says "default", not "environment", for exactly this reason.
 *
 * The ranges and defaults are declared ONCE, in the table below, so the panel
 * validator, the PATCH DTO, the admin form's `min`/`max` and the detector's own
 * documented behaviour cannot drift apart.
 */
import type { NumericTunableRange } from './sharing-detection.config';

export interface SubscriptionUaDetectionConfig {
  /**
   * Master switch. **OFF by default**, and deliberately.
   *
   * The detector reads a live panel surface, files against a paying customer,
   * and is unproven in production: its whole premise is that no legitimate
   * client puts a node config in its User-Agent, which is true of every client
   * we know of and cannot be true of every client that exists. An operator has
   * to be able to switch it off without a deploy, and until somebody has
   * watched it on a real panel it should not be on for them by default.
   */
  readonly enableSubscriptionUaTunnel: boolean;
  /**
   * How far back a subscription fetch counts as evidence, in minutes.
   *
   * Comfortably wider than the 5-minute detector cadence so a fetch is not
   * missed between runs, and short enough that a signal describes current
   * behaviour rather than history. Raising it widens what one run considers —
   * but only as far as {@link SubscriptionUaDetectionConfig.uaRequestPageSize}
   * rows actually reach back, which is why the two are neighbours.
   */
  readonly uaEvidenceWindowMinutes: number;
  /**
   * How many of the newest request-log rows to read per run.
   *
   * `GET /api/subscription-request-history` takes `size` and `start` and
   * nothing else on both 2.7.4 and 2.8.0 — no user filter, no TIME filter — so
   * this is the ONLY lever over how much of the evidence window a single page
   * actually covers. On a busy panel a page of 500 can be minutes wide; the
   * detector says so (`windowFullyCovered: false`, plus a WARN) rather than
   * implying it saw the whole window. Raise this, or shorten the window, when
   * it does.
   *
   * 500 is one request and matches the page size the adapter already uses for
   * the panel user walk.
   */
  readonly uaRequestPageSize: number;
}

/**
 * The documented range and default of every numeric subscription-UA tunable —
 * the ONE declaration the panel validator, the PATCH DTO and the admin form all
 * read.
 *
 * `integer: true` on both: a fractional page size is meaningless to the panel
 * API, and a fractional window has no expressible meaning the minute-granular
 * knob does not already cover.
 */
export const SUBSCRIPTION_UA_TUNABLE_RANGES = {
  uaEvidenceWindowMinutes: { default: 60, min: 15, max: 360, integer: true },
  uaRequestPageSize: { default: 500, min: 100, max: 2000, integer: true },
} as const satisfies Record<string, NumericTunableRange>;

/** Default for the boolean subscription-UA tunable (nothing to range-check). */
export const SUBSCRIPTION_UA_TUNABLE_BOOLEAN_DEFAULTS = {
  enableSubscriptionUaTunnel: false,
} as const satisfies Record<string, boolean>;

/**
 * The built-in defaults — the FALLBACK layer, and the whole of it. A stored
 * panel value overrides whatever this returns; see the file header.
 *
 * Takes no `env` argument on purpose: a parameter this function ignores would
 * read, at every call site, as though an environment variable were consulted.
 */
export function defaultSubscriptionUaDetectionConfig(): SubscriptionUaDetectionConfig {
  return {
    enableSubscriptionUaTunnel:
      SUBSCRIPTION_UA_TUNABLE_BOOLEAN_DEFAULTS.enableSubscriptionUaTunnel,
    uaEvidenceWindowMinutes: SUBSCRIPTION_UA_TUNABLE_RANGES.uaEvidenceWindowMinutes.default,
    uaRequestPageSize: SUBSCRIPTION_UA_TUNABLE_RANGES.uaRequestPageSize.default,
  };
}
