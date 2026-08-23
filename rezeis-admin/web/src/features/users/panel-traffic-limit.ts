/**
 * The panel's BYTE traffic cap, read as the whole gigabytes
 * `Subscription.trafficLimit` stores.
 *
 * A HAND-WRITTEN COPY of the backend's `panelTrafficLimitToGb`
 * (`src/modules/remnawave/utils/panel-traffic-limit.util.ts`), and it has to be
 * one. Nothing the production frontend project compiles may reach into `src/`:
 * the Docker frontend stage is `COPY web/ .` and nothing else, so an import
 * across that boundary type-checks on a developer's machine and then dies with
 * TS2307 inside the image. `build-isolation.test.ts` pins that arrangement, and
 * `subscription-sync-refusals.ts` is the same move one file over — its comment
 * says the identical thing about the backend's refusal codes.
 *
 * THE COPY IS NOT LEFT TO DRIFT. `panel-traffic-limit-parity.test.ts` imports
 * the backend's real function — legal from a TEST, which `tsconfig.app.json`
 * excludes precisely so it may, and `tsconfig.test.json` type-checks with the
 * whole repository around it — and runs both over one table of inputs. Change
 * the rule on either side without the other and that test fails by name.
 *
 * ── Why the sync card needed this at all ───────────────────────────────────
 *
 * There was a SEVENTH spelling of this conversion inline in
 * `user-detail-panel.tsx`, in the OLD defective form: `Math.round(bytes / 1024
 * ** 3)`, no floor. Once the backend grew the floor the two sides disagreed by
 * construction — a 0.4 GB panel cap was stored as `1` and rendered as `0`, so
 * the drift notice reported a drift that did not exist and sent the operator
 * off to investigate two sides that agreed.
 *
 * ── `null` means UNLIMITED, and ONLY that ──────────────────────────────────
 *
 * `<= 0` bytes is how Remnawave spells unlimited traffic; it has no encoding
 * for "zero bytes allowed" at all. So a non-positive cap answers `null` here,
 * exactly as it does on the server.
 *
 * That is NOT the same statement as "the panel did not mention a traffic
 * limit". A caller that has to tell those two apart must make the absence check
 * ITSELF, before calling. `SubscriptionSyncOutcomeNotice` does: a payload with
 * no `trafficLimitBytes` at all would otherwise render as the panel positively
 * enforcing no cap, which is a drift claim made out of missing data.
 *
 * ── And `0` GIGABYTES is a real, different answer ──────────────────────────
 *
 * `Subscription.trafficLimit === null` is unlimited, which leaves `0` free to
 * mean what it says: no traffic at all. The floor below exists so a positive
 * upstream cap can never collapse into that value by rounding. Do not fold the
 * two together on this side — telling them apart is the whole job here.
 *
 * (`Subscription.deviceLimit` is the opposite convention: `<= 0` there IS the
 * product's canonical unlimited, matching the panel's own `hwidDeviceLimit: 0`.
 * The asymmetry is deliberate and documented on the server. Do not harmonise.)
 *
 * @param trafficLimitBytes upstream cap in BYTES (`<= 0` = unlimited).
 * @returns whole gigabytes (always `>= 1`), or `null` for unlimited.
 */

/** One gibibyte — the panel counts bytes, the column counts these. */
const BYTES_PER_GIB = 1024 ** 3

export function panelTrafficLimitToGb(trafficLimitBytes: number | null | undefined): number | null {
  if (typeof trafficLimitBytes !== 'number' || !Number.isFinite(trafficLimitBytes)) return null
  if (trafficLimitBytes <= 0) return null
  return Math.max(1, Math.round(trafficLimitBytes / BYTES_PER_GIB))
}
