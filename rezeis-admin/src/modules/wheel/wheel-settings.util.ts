/**
 * The wheel's global switches, read out of `Settings.wheelSettings`.
 *
 * In the panel and not in `.env`, like every other operator-facing knob in
 * this system: an operator who has to redeploy a container to change a
 * cooldown will not change it.
 *
 * Absent or unreadable means OFF, deliberately and in every field. An update
 * that shipped this column must not start a giveaway behind the operator's
 * back — the same rule the points block follows.
 */

export interface WheelSettings {
  /** The master switch. Off means no one can spin, whatever the sectors say. */
  readonly enabled: boolean;
  /**
   * Hours between free spins. `null` — and, deliberately, `0` — means the
   * operator turned free spins off; see `isFreeSpinEnabled` for why zero
   * cannot mean "unlimited".
   */
  readonly freeSpinCooldownHours: number | null;
  /**
   * What one spin costs in points. `null` means spins cannot be bought at
   * all, which is not the same as free: a spin is still spent from the
   * balance, there is simply no way to top that balance up with points.
   */
  readonly spinPricePoints: number | null;
}

export const WHEEL_OFF: WheelSettings = {
  enabled: false,
  freeSpinCooldownHours: null,
  spinPricePoints: null,
};

export function readWheelSettings(wheelSettings: unknown): WheelSettings {
  const root =
    typeof wheelSettings === 'object' && wheelSettings !== null && !Array.isArray(wheelSettings)
      ? (wheelSettings as Record<string, unknown>)
      : {};

  return {
    enabled: root['enabled'] === true,
    freeSpinCooldownHours: positiveWholeOrNull(root['freeSpinCooldownHours']),
    spinPricePoints: positiveWholeOrNull(root['spinPricePoints']),
  };
}

/**
 * Anything that is not a positive whole number is `null`, which every reader
 * treats as "off". A fraction of an hour and a price of minus five are both
 * ways of saying the value cannot be trusted, and neither deserves its own
 * behaviour.
 */
function positiveWholeOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) return null;
  return value > 0 ? value : null;
}
