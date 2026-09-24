/**
 * What the panel push SENDS for a subscription's two limit columns — the OUT
 * direction of `panel-traffic-limit.util.ts`, which reads a panel cap IN.
 *
 * ── Why this is one function per field, shared ─────────────────────────────
 *
 * Two readers have to agree on these numbers to the byte:
 *
 *   • `profile-sync.processor.ts` builds the CREATE and UPDATE bodies with
 *     them — this is what Remnawave actually receives;
 *   • `remnawave-webhook.service.ts` compares a panel event against them to
 *     decide whether Remnawave still holds what rezeis would push for a
 *     subscription in the term model, and pushes again when it does not.
 *
 * If the second ever computed a value the first does not send, the echo of our
 * own push would read as a difference, the webhook would push again, and the
 * next echo would read the same — a push loop through the panel. So the
 * comparison is made in WIRE space, with the very functions that build the
 * wire, rather than by converting the panel's numbers back into columns.
 *
 * ── The encodings (see `panel-traffic-limit.util.ts` for why they differ) ───
 *
 *   • TRAFFIC — `Subscription.trafficLimit` is whole GiB, `null` unlimited. The
 *     panel counts bytes and spells unlimited `0`. A local `0` (a real budget of
 *     zero) has no panel spelling and goes out as `0` too: the round trip is
 *     lossy there by the panel's design, not ours.
 *   • DEVICES — `Subscription.deviceLimit <= 0` is unlimited (plans store `-1`,
 *     mirrors write `0`); Remnawave validates `hwidDeviceLimit >= 0` and spells
 *     unlimited `0`, so anything below zero must go out as `0` or the panel
 *     refuses the write with `400 "Device limit must be greater than 0"`.
 */

/** One gibibyte, the unit `Subscription.trafficLimit` counts in. */
const BYTES_PER_GIB = 1024 ** 3;

/** `Subscription.trafficLimit` (GiB, `null` unlimited) → the panel's `trafficLimitBytes`. */
export function toPanelTrafficLimitBytes(trafficLimitGb: number | null | undefined): number {
  return (trafficLimitGb ?? 0) * BYTES_PER_GIB;
}

/** `Subscription.deviceLimit` (`<= 0` unlimited) → the panel's `hwidDeviceLimit`. */
export function toPanelDeviceLimit(deviceLimit: number | null | undefined): number {
  if (deviceLimit === null || deviceLimit === undefined || deviceLimit < 0) {
    return 0;
  }
  return deviceLimit;
}
