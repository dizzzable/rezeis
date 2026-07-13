/**
 * Pure, deterministic device-reduction target selection (T-011).
 *
 * When a subscription's desired device limit drops below the number of HWID
 * devices currently bound on the panel (an EXTRA_DEVICES entitlement expired),
 * the exact set of devices to remove must be chosen deterministically so a
 * replan or a retry always resolves to the identical immutable target list —
 * no arbitrary victims.
 *
 * Rule (design D-7): sort by `createdAt` DESC (newest first), ties broken by
 * canonical `hwid` DESC, then take the first `overage` devices as deletion
 * targets. This keeps the OLDEST `desiredLimit` devices (the long-standing
 * ones) and removes the most recently added — the ones the now-expired extra
 * slots most plausibly enabled.
 *
 * The function is fail-closed on invalid source data: a non-parseable
 * `createdAt`, an empty `hwid`, or a duplicate `hwid` throws
 * {@link DeviceReductionSourceError} so the caller blocks BEFORE any mutation
 * rather than deleting a guessed victim.
 */

export interface DeviceSelectionInput {
  readonly hwid: string;
  readonly createdAt: string;
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
 * Selects the exact deletion targets for a device-limit reduction.
 *
 * @param devices      Strict device list (validated envelope upstream).
 * @param desiredLimit The desired FINITE device limit (>= 0). Unlimited
 *                     (`null`) must never reach this function — there is no
 *                     reduction to plan.
 */
export function selectDeviceReductionTargets(
  devices: readonly DeviceSelectionInput[],
  desiredLimit: number,
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
  return { overage, targets, retained };
}
