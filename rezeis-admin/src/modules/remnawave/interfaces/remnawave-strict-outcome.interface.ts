/**
 * Normalized outcome of a STRICT Remnawave adapter operation (T-010).
 *
 * Paid/destructive operations (desired-limit PATCH, device read-back, exact
 * HWID delete) must NOT reuse the best-effort UI read methods that swallow
 * every failure into a `null`/`[]` fallback — a fulfillment/device saga has to
 * tell "not found" from "panel down" from "the panel returned garbage". These
 * operations therefore return this discriminated union instead of throwing a
 * generic `ServiceUnavailableException`:
 *
 *  - `ok`             — validated value; `detectedVersion` records the panel
 *                       build when derivable (else `null`), so callers can log
 *                       which 2.7.4/2.8.0 wire shape they saw.
 *  - `notFound`       — the target user/device is absent (HTTP 404). For a
 *                       delete this is only idempotent-success once a strict
 *                       read-back proves the absence.
 *  - `unsupported`    — the panel rejected the operation as not available on
 *                       this build (e.g. HTTP 405/501).
 *  - `unavailable`    — transient failure (network, timeout, 5xx, 429).
 *                       `retryAfterMs` carries a server-provided hint when
 *                       present. Retryable.
 *  - `invalidContract`— the panel responded 2xx but the payload violated the
 *                       expected envelope/fields/counts/encoding. NOT retryable
 *                       by hot-loop; surfaces as an incident.
 */
export type RemnawaveStrictOutcome<T> =
  | { readonly kind: 'ok'; readonly value: T; readonly detectedVersion: string | null }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'unavailable'; readonly retryAfterMs: number | null }
  | { readonly kind: 'invalidContract'; readonly details: string };

export function strictOk<T>(value: T, detectedVersion: string | null = null): RemnawaveStrictOutcome<T> {
  return { kind: 'ok', value, detectedVersion };
}

export function strictNotFound<T>(): RemnawaveStrictOutcome<T> {
  return { kind: 'notFound' };
}

export function strictUnsupported<T>(): RemnawaveStrictOutcome<T> {
  return { kind: 'unsupported' };
}

export function strictUnavailable<T>(retryAfterMs: number | null = null): RemnawaveStrictOutcome<T> {
  return { kind: 'unavailable', retryAfterMs };
}

export function strictInvalidContract<T>(details: string): RemnawaveStrictOutcome<T> {
  return { kind: 'invalidContract', details };
}

/**
 * One-line, log-safe rendering of an outcome.
 *
 * A caller that DEGRADES on a non-`ok` outcome (skips a detector run, falls
 * back to backup values) has to say so out loud — a silent degrade is exactly
 * the failure mode the strict outcomes exist to end.
 */
export function describeStrictOutcome(outcome: RemnawaveStrictOutcome<unknown>): string {
  switch (outcome.kind) {
    case 'ok':
      return 'ok';
    case 'notFound':
      return 'notFound';
    case 'unsupported':
      return 'unsupported';
    case 'unavailable':
      return outcome.retryAfterMs === null
        ? 'unavailable'
        : `unavailable (retry after ${outcome.retryAfterMs}ms)`;
    case 'invalidContract':
      return `invalidContract: ${outcome.details}`;
  }
}

/** A strict user snapshot with the canonical nullable-unlimited encoding. */
export interface RemnawaveStrictUser {
  /**
   * How this panel names the profile: a 2.x uuid, or a 3.x numeric id rendered
   * in decimal. It is the identity as the ROW gave it, not a value converted
   * from one era to the other.
   */
  readonly uuid: string;
  /**
   * The panel's numeric id, present on every supported version. Carried so a
   * caller can back-fill `Subscription.remnawavePanelId` from a read it was
   * making anyway — which is what keeps a 2.x-created profile addressable after
   * the operator upgrades to 3.x and the panel drops the uuid column.
   * `null` only when the panel omitted the field entirely.
   */
  readonly panelId: number | null;
  readonly status: string;
  /** Authoritative anchor used by Remnawave MONTH_ROLLING. */
  readonly createdAt: string;
  /** Full writable identity projection used by profile-sync read-back. */
  readonly tag: string | null;
  readonly trafficLimitStrategy: string;
  readonly activeInternalSquads: readonly string[];
  readonly externalSquadUuid: string | null;
  /** Canonical unlimited = `null` (upstream `0` is decoded to `null`). */
  readonly trafficLimitBytes: bigint | null;
  /** Canonical unlimited = `null` (upstream `0` is decoded to `null`). */
  readonly hwidDeviceLimit: number | null;
}

/**
 * The two fields the expired-profile sweep reads from a panel profile.
 *
 * Deliberately NOT `RemnawaveStrictUser`: that parser fails closed on nine
 * fields the sweep never looks at, so an unrelated contract drift (a `tag`
 * shape, a squad encoding) would make the sweep defer every deletion forever.
 * This one validates exactly what it uses.
 */
export interface RemnawavePanelExpirySnapshot {
  /** Panel-canonical expiry, already proven parseable by the adapter. */
  readonly expireAtMs: number;
  readonly subscriptionUrl: string | null;
}

/** A strict, owner-agnostic device row (never trusts a row's own owner field). */
export interface RemnawaveStrictDevice {
  readonly hwid: string;
  readonly createdAt: string;
  /**
   * Panel-reported last activity, or `null` when the panel reported none.
   *
   * REQUIRED, not optional, and that is the point. This projection used to stop
   * at `{ hwid, createdAt }`, which left the device-reduction saga unable to
   * distinguish a registration in daily use from one abandoned six months ago
   * and choosing its victim by registration date alone. A required field forces
   * the producer to DECIDE, every time; an optional one lets the same omission
   * come back silently the next time a row shape is touched.
   *
   * `null` is a real answer and must never be softened into `createdAt`: see
   * `classifyDeviceActivity` in the add-on-entitlements domain, which treats an
   * unknown last-seen as unknown and refuses to infer activity from it.
   */
  readonly lastSeenAt: string | null;
}

export interface RemnawaveStrictDeviceList {
  readonly devices: readonly RemnawaveStrictDevice[];
  readonly total: number;
}
