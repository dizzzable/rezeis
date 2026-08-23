/**
 * Pure, deterministic device-reduction target selection (T-011).
 *
 * When a subscription's desired device limit drops below the number of HWID
 * devices currently bound on the panel (an EXTRA_DEVICES entitlement expired),
 * the exact set of devices to remove must be chosen deterministically so a
 * replan or a retry always resolves to the identical immutable target list —
 * no arbitrary victims.
 *
 * ORDERING RULE (design D-7), UNCHANGED: sort by `createdAt` DESC (newest
 * first), ties broken by canonical `hwid` DESC, then take the first `overage`
 * devices as deletion targets. This keeps the OLDEST `desiredLimit` devices and
 * removes the most recently added — the queue-rejects-the-new-entrant reading:
 * you are over your limit, so the addition you just made is refused.
 *
 * That policy was deliberately KEPT rather than inverted. It is defensible on
 * its own terms, and a customer who legitimately owns three devices and
 * registers a fourth may well prefer losing the fourth to losing the one they
 * use least often but still own. Reordering by staleness would change the
 * outcome of EVERY ordinary over-limit reduction; the defect below changes only
 * the outcome nobody defends.
 *
 * THE DEFECT IT DOES NOT SURVIVE. Multiple HWID registrations per physical
 * device are the EXPECTED state on this deployment — the panel registers a row
 * per client, the FAQ tells customers to try several clients, and a sideloaded
 * APK re-registers on reinstall. So a customer over their limit routinely holds
 * rows that no longer correspond to anything running. `createdAt` cannot tell
 * those apart from a device bought last week, because a registration left
 * behind by a reinstall is among the OLDEST rows, and "delete the newest" will
 * therefore destroy the phone in the customer's hand and retain a row last seen
 * six months ago.
 *
 * THE INVARIANT (new, and the only behaviour this file changes): a registration
 * that has not been seen for a full billing period must never be RETAINED in
 * preference to one seen recently. When the ordering rule would do that, this
 * function refuses — {@link DeviceRetentionConflictError} — and the caller
 * raises an incident for a human instead of guessing a victim. It does not pick
 * a different victim: with several rows per device, an automated second guess
 * is as likely to be wrong as the first, and this saga's whole design is to
 * stop rather than guess (see the duplicate-hwid refusal below).
 *
 * See {@link classifyDeviceActivity} for why the refusal cannot misfire on a
 * panel that does not report activity at all.
 *
 * The function is fail-closed on invalid source data: a non-parseable
 * `createdAt`, an empty `hwid`, or a duplicate `hwid` throws
 * {@link DeviceReductionSourceError} so the caller blocks BEFORE any mutation
 * rather than deleting a guessed victim.
 */

export interface DeviceSelectionInput {
  readonly hwid: string;
  readonly createdAt: string;
  /**
   * Panel-reported last activity, when the panel reports any.
   *
   * OPTIONAL on purpose, and `null` is a first-class value: "we do not know
   * when this row was last used" is a real answer from a real panel, and it
   * must never be silently substituted with `createdAt`. Reading a registration
   * date as an activity date is precisely how a live device gets classified
   * dormant, which is the failure this whole mechanism exists to prevent.
   */
  readonly lastSeenAt?: string | null;
}

export interface DeviceReductionSelection {
  /** How many devices exceed the desired finite limit (0 when within limit). */
  readonly overage: number;
  /** Exact devices to delete, in deletion order (newest → oldest of the cut). */
  readonly targets: readonly DeviceSelectionInput[];
  /** The devices retained after the reduction (the oldest `desiredLimit`). */
  readonly retained: readonly DeviceSelectionInput[];
}

export class DeviceReductionSourceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DeviceReductionSourceError';
  }
}

/**
 * How long a registration may go unused before it stops outranking a live one.
 *
 * NOT a round number picked for looking sensible - it is bounded from BELOW by
 * a window this codebase already reasoned about and committed to, and it is the
 * next natural quantum above it:
 *
 *   - `HWID_DOWNGRADE_GRACE_DAYS = 14` (anti-fraud `sharing-detectors.ts`)
 *     exists because a customer's own device may sit idle a long time before
 *     they touch it: "for a spare tablet or a work laptop, easily a week or two
 *     out". That is this deployment's recorded position on how long a device
 *     someone genuinely owns may stay silent. Any dormancy horizon must be
 *     strictly LONGER than that, or the two components contradict each other -
 *     one excusing a device as normally idle while the other calls it dead.
 *   - The subscription period is 30 days (`knowledge/service/tariffs.md`;
 *     `Plan.durationDays`). A registration that did not connect once across a
 *     whole paid period, which the customer then renewed, has missed the
 *     longest cycle the product has.
 *
 * So: more than double the longest idle gap the codebase already treats as
 * ordinary ownership, and exactly one full billing period. Deliberately a
 * constant and not an operator tunable, for the same reason
 * `HWID_DOWNGRADE_GRACE_DAYS` is one: it bounds a destructive action, and an
 * operator who set it to zero would restore the defect it exists to fix.
 */
export const DEVICE_DORMANCY_HORIZON_DAYS = 30;

const DEVICE_DORMANCY_HORIZON_MS = DEVICE_DORMANCY_HORIZON_DAYS * 24 * 60 * 60 * 1000;

/**
 * How far `lastSeenAt` must sit past `createdAt` before it counts as evidence
 * that the panel tracks activity AT ALL (see {@link classifyDeviceActivity}).
 *
 * A panel that stamps `updatedAt = createdAt` at insert and never touches it
 * again produces a difference of at most the write skew inside one transaction
 * - milliseconds. A panel that records real use produces a difference of at
 * least one reconnection. A minute sits far above the first and far below the
 * second, so it separates them without needing to know which panel we are on.
 */
const ACTIVITY_SIGNAL_TOLERANCE_MS = 60 * 1000;

/**
 * What we are willing to claim about one row's activity.
 *
 * `unknown` is not a defect and not a rounding of `dormant`: it is the honest
 * answer for a row the panel says nothing about, and it never participates in a
 * refusal in either direction.
 */
export type DeviceActivity = 'active' | 'dormant' | 'unknown';

export interface DeviceActivityReading {
  readonly hwid: string;
  readonly activity: DeviceActivity;
  /** Parsed `lastSeenAt`, or `null` when absent or unparseable. */
  readonly lastSeenMs: number | null;
}

/**
 * Classifies each row as active / dormant / unknown against `nowMs`.
 *
 * WHY THERE IS A SIGNAL GATE, and why it is the most important line here.
 *
 * `lastSeenAt` reaches us from `strictListUserDevices`, which reads the panel's
 * `lastSeenAt` and falls back to `updatedAt`. Whether a Remnawave HWID row's
 * `updatedAt` actually ADVANCES on use is not something this repository can
 * prove - there is no fixture, no note and no live panel behind a unit test.
 * If it never advances, then `lastSeenAt` is just `createdAt` wearing another
 * name, and any rule that reads it as activity would classify every
 * long-standing device as dormant and refuse every ordinary reduction.
 *
 * So the classification first asks whether the field MOVES on this profile: at
 * least one row whose `lastSeenAt` sits more than
 * {@link ACTIVITY_SIGNAL_TOLERANCE_MS} past its own `createdAt`. Nothing moved
 * => every row is `unknown` => the refusal below cannot fire => behaviour is
 * exactly what it was before this file learned about activity.
 *
 * That makes the whole mechanism fail-SAFE under the uncertainty rather than
 * betting on it: on a panel that reports activity it protects the live device,
 * and on a panel that does not it is inert instead of catastrophic.
 */
export function classifyDeviceActivity(
  devices: readonly DeviceSelectionInput[],
  nowMs: number,
): readonly DeviceActivityReading[] {
  const parsed = devices.map((device) => {
    const raw = device.lastSeenAt ?? null;
    const seen = typeof raw === 'string' && raw.length > 0 ? Date.parse(raw) : Number.NaN;
    const created = Date.parse(device.createdAt);
    return {
      hwid: device.hwid,
      lastSeenMs: Number.isNaN(seen) ? null : seen,
      createdMs: Number.isNaN(created) ? null : created,
    };
  });

  const carriesSignal = parsed.some(
    (row) =>
      row.lastSeenMs !== null &&
      row.createdMs !== null &&
      row.lastSeenMs - row.createdMs > ACTIVITY_SIGNAL_TOLERANCE_MS,
  );

  return parsed.map((row) => {
    if (!carriesSignal || row.lastSeenMs === null) {
      return { hwid: row.hwid, activity: 'unknown' as const, lastSeenMs: row.lastSeenMs };
    }
    const idleMs = nowMs - row.lastSeenMs;
    return {
      hwid: row.hwid,
      activity: idleMs > DEVICE_DORMANCY_HORIZON_MS ? ('dormant' as const) : ('active' as const),
      lastSeenMs: row.lastSeenMs,
    };
  });
}

/** The two sides of a refusal, named so an operator can act on it. */
export interface DormantRetentionConflict {
  /** Targets seen within the horizon - the devices we were about to destroy. */
  readonly activeTargets: readonly string[];
  /** Rows the plan would KEEP that have not been seen for a full period. */
  readonly dormantRetained: readonly string[];
}

/**
 * The invariant check: is any device we are about to DELETE demonstrably in use
 * while a device we would KEEP has been silent for a full billing period?
 *
 * Deliberately an ABSOLUTE classification against `nowMs`, not a relative
 * comparison of the two timestamps. "Delete X, whose `lastSeenAt` is newer than
 * retained Y's" fires on two devices that are BOTH in daily use and merely
 * connected an hour apart - it would turn every ordinary reduction into an
 * incident. Comparing each row to now instead asks the question that actually
 * matters, and answers it the same way for both rows.
 *
 * Shared by the planner (which has the freshly-selected split) and the executor
 * (which has an immutable persisted target list and a fresh panel read), so the
 * two cannot drift apart into two different definitions of the same rule.
 */
export function findDormantRetentionConflict(
  devices: readonly DeviceSelectionInput[],
  targetHwids: ReadonlySet<string>,
  nowMs: number,
): DormantRetentionConflict | null {
  const readings = classifyDeviceActivity(devices, nowMs);
  const activeTargets: string[] = [];
  const dormantRetained: string[] = [];
  for (const reading of readings) {
    if (targetHwids.has(reading.hwid)) {
      if (reading.activity === 'active') activeTargets.push(reading.hwid);
    } else if (reading.activity === 'dormant') {
      dormantRetained.push(reading.hwid);
    }
  }
  if (activeTargets.length === 0 || dormantRetained.length === 0) return null;
  return { activeTargets, dormantRetained };
}

/**
 * Raised INSTEAD of returning a selection that would destroy a device in active
 * use while keeping a dormant one.
 *
 * Distinct from {@link DeviceReductionSourceError} on purpose: that one means
 * the panel handed us data we cannot reason about, this one means the data was
 * fine and the ANSWER was unacceptable. They need different operator copy and
 * different incident codes, and folding them together would hide the only one
 * of the two that indicates a live customer is about to lose a device.
 */
/**
 * The one token an operator sees for this refusal: the `summaryCode` on the
 * incident, the `reason` on the BLOCKED outcome from the planner, and the
 * `lastErrorCode` on a plan the executor stops. Declared beside the rule it
 * names so the planner and the executor cannot drift into two spellings.
 */
export const DORMANT_RETENTION_CONFLICT = 'DORMANT_RETENTION_CONFLICT';

export class DeviceRetentionConflictError extends Error {
  public readonly activeTargets: readonly string[];
  public readonly dormantRetained: readonly string[];

  public constructor(conflict: DormantRetentionConflict) {
    super(
      `refusing to delete ${conflict.activeTargets.length} device(s) seen within ` +
        `${DEVICE_DORMANCY_HORIZON_DAYS}d while retaining ${conflict.dormantRetained.length} ` +
        'device(s) not seen for longer',
    );
    this.name = 'DeviceRetentionConflictError';
    this.activeTargets = conflict.activeTargets;
    this.dormantRetained = conflict.dormantRetained;
  }
}

/**
 * Selects the exact deletion targets for a device-limit reduction.
 *
 * @param devices      Strict device list (validated envelope upstream).
 * @param desiredLimit The desired FINITE device limit (>= 0). Unlimited
 *                     (`null`) must never reach this function — there is no
 *                     reduction to plan.
 * @param options      `nowMs` overrides the clock the dormancy horizon is
 *                     measured against. Injected rather than read from
 *                     `Date.now()` so the refusal is testable at a fixed
 *                     instant; production callers omit it.
 * @throws {DeviceRetentionConflictError} when the selection would delete a
 *                     device seen within the horizon while retaining one that
 *                     has not been seen for longer.
 */
export function selectDeviceReductionTargets(
  devices: readonly DeviceSelectionInput[],
  desiredLimit: number,
  options: { readonly nowMs?: number } = {},
): DeviceReductionSelection {
  if (!Number.isInteger(desiredLimit) || desiredLimit < 0) {
    throw new DeviceReductionSourceError(`desiredLimit must be a non-negative integer, got ${desiredLimit}`);
  }

  const seen = new Set<string>();
  const decorated = devices.map((device) => {
    if (device.hwid.length === 0) {
      throw new DeviceReductionSourceError('device has an empty hwid');
    }
    if (seen.has(device.hwid)) {
      throw new DeviceReductionSourceError(`duplicate hwid ${device.hwid}`);
    }
    seen.add(device.hwid);
    const epoch = Date.parse(device.createdAt);
    if (Number.isNaN(epoch)) {
      throw new DeviceReductionSourceError(`device ${device.hwid} has an invalid createdAt "${device.createdAt}"`);
    }
    return { device, epoch };
  });

  // Newest first; ties broken by canonical hwid DESC for full determinism.
  decorated.sort((left, right) => {
    if (left.epoch !== right.epoch) return right.epoch - left.epoch;
    return right.device.hwid.localeCompare(left.device.hwid);
  });

  const overage = Math.max(0, decorated.length - desiredLimit);
  const targets = decorated.slice(0, overage).map((entry) => entry.device);
  const retained = decorated.slice(overage).map((entry) => entry.device);

  // The invariant, applied to the answer the ordering rule just produced. It
  // runs LAST and changes nothing about how the split is computed: on every
  // input where the ordering rule was already acceptable this is a no-op, and
  // on the one shape it is not, nothing is returned at all.
  if (overage > 0) {
    const conflict = findDormantRetentionConflict(
      devices,
      new Set(targets.map((d) => d.hwid)),
      options.nowMs ?? Date.now(),
    );
    if (conflict !== null) throw new DeviceRetentionConflictError(conflict);
  }

  return { overage, targets, retained };
}
