/**
 * One gibibyte. `Subscription.trafficLimit` counts in these, the panel counts
 * in bytes, and this is the only place in the product that divides one by the
 * other on the way IN.
 */
const BYTES_PER_GIB = 1024 ** 3;

/**
 * The ONE place that turns an upstream BYTE traffic cap into the whole number
 * of gigabytes `Subscription.trafficLimit` stores.
 *
 * ── Why this function exists ────────────────────────────────────────────────
 *
 * There used to be six spellings of this one conversion — the Remnawave
 * importer, the Remnawave webhook mirror, the backup-import overlay, the
 * cabinet's panel overlay, the 3x-ui importer and the STEALTHNET importer each
 * wrote their own — and they had already diverged. Two of them dropped the
 * `Math.max(1, …)` floor below, so a 0.4 GB panel cap landed as `0` through the
 * importer and as `1` through the webhook: the same customer, the same panel
 * row, two different answers depending on which code path touched the row last.
 *
 * ── `0` and `null` are DIFFERENT answers, and the encodings are ASYMMETRIC ──
 *
 * Read this before "simplifying" either branch. Traffic and devices do NOT
 * agree, and the temptation to make them agree has already been declined once:
 *
 *   • TRAFFIC — `Subscription.trafficLimit === null` is UNLIMITED. See
 *     `add-on-entitlements/domain/entitlement-baseline.ts`: "Unlimited is
 *     absorbing, so no contribution is embedded in it." Which leaves `0` free
 *     to mean what it says: genuinely zero gigabytes, a subscription that may
 *     move no traffic at all.
 *
 *   • DEVICES — `Subscription.deviceLimit <= 0` is UNLIMITED. The same file
 *     calls `<= 0` "the product's canonical unlimited", and
 *     `profile-sync.processor.ts#toPanelDeviceLimit` maps null/undefined/
 *     negative to `0` when pushing, because Remnawave spells unlimited devices
 *     `hwidDeviceLimit: 0` too. Moving devices to `-1` so the two columns would
 *     read alike was proposed and declined: it would rewrite every unlimited
 *     row in the database and put us out of step with the panel for no gain.
 *
 * So `deviceLimit: 0` means "as many devices as you like", while
 * `trafficLimit: 0` means "no traffic at all". Same digit, opposite meanings,
 * one row apart. That is the trap this comment exists to spring early.
 *
 * ── Why a positive cap must never round down to `0` ─────────────────────────
 *
 * Because `0` is a real value here, `Math.round(0.4 GB)` is not a harmless
 * rounding — it is a different product. It costs the customer twice:
 *
 *   1. locally the row now says the customer may move zero bytes, which is not
 *      what they paid for and not what the panel says;
 *   2. on the way back OUT it becomes a lie in the other direction —
 *      `profile-sync.processor.ts` sends `(trafficLimit ?? 0) * 1024 ** 3`, so
 *      the `0` we just invented is pushed to the panel as `0` bytes, which
 *      Remnawave reads as UNLIMITED. A 0.4 GB cap silently becomes no cap.
 *
 * Hence the floor: any positive upstream cap is worth at least one gigabyte
 * here, and only an upstream `0` (or negative, or absent — see below) is
 * allowed to produce `null`.
 *
 * ── The round trip is lossy, deliberately ───────────────────────────────────
 *
 * Remnawave has no encoding for "zero bytes allowed": its `0` IS unlimited.
 * A locally-stored `trafficLimit: 0` therefore cannot be expressed upstream and
 * comes back through this function as `null`. That asymmetry is the panel's,
 * not ours — do not "fix" it by folding `0` into `null` on this side, which
 * would throw away the distinction the column is required to keep.
 *
 * ── Absence is the CALLER's decision, not this function's ───────────────────
 *
 * A non-numeric or non-finite input answers `null` so that a malformed payload
 * can never produce `NaN` in the column. That is a floor against garbage, NOT a
 * statement that the field was absent. A caller that must distinguish "the
 * payload did not mention a traffic limit" from "the payload said unlimited"
 * — the webhook mirror and the cabinet overlay both must — has to make that
 * check itself, before calling, and skip the write entirely.
 *
 * @param trafficLimitBytes upstream cap in BYTES (`<= 0` = unlimited).
 * @returns whole gigabytes (always `>= 1`), or `null` for unlimited.
 */
export function panelTrafficLimitToGb(
  trafficLimitBytes: number | null | undefined,
): number | null {
  if (typeof trafficLimitBytes !== 'number' || !Number.isFinite(trafficLimitBytes)) return null;
  if (trafficLimitBytes <= 0) return null;
  return Math.max(1, Math.round(trafficLimitBytes / BYTES_PER_GIB));
}
