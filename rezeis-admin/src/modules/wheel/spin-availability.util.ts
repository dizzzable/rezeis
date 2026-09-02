/**
 * When the free spin is available, answered by subtraction rather than by a
 * counter somebody has to top up.
 *
 * ── Why the clock and not a balance ───────────────────────────────────────
 *
 * The free spin does not accumulate: a person who does not spin for a week
 * comes back to exactly one, not seven. Stored as a counter that needs a
 * nightly job to decide who is owed one, and the answer drifts the moment the
 * job is late or runs twice. Stored as "when did you last spend it", the
 * answer is a subtraction that is correct for everybody at every instant, and
 * costs nothing to keep true.
 *
 * It also gives the operator's rule its exact meaning: the cooldown runs from
 * the SPIN, not from midnight. Not spinning does not start the clock.
 */

export interface FreeSpinState {
  /** Can the free spin be taken right now. */
  readonly available: boolean;
  /**
   * When it becomes available, ISO. `null` when it is available now or when
   * the operator has turned free spins off entirely.
   */
  readonly availableAt: string | null;
}

/**
 * Free spins are on only for a positive whole number of hours.
 *
 * `null` is "the operator turned them off". So is `0`, deliberately: read as a
 * cooldown it would mean a free spin on every request, which is an unlimited
 * wheel one careless keystroke away. An operator who wants an unlimited wheel
 * has a clearer way to say it — price the spin at zero points.
 */
export function isFreeSpinEnabled(cooldownHours: number | null | undefined): cooldownHours is number {
  return (
    typeof cooldownHours === 'number' &&
    Number.isFinite(cooldownHours) &&
    Number.isInteger(cooldownHours) &&
    cooldownHours > 0
  );
}

export function resolveFreeSpin(input: {
  readonly freeSpinUsedAt: Date | null;
  readonly cooldownHours: number | null | undefined;
  readonly now?: Date;
}): FreeSpinState {
  if (!isFreeSpinEnabled(input.cooldownHours)) return { available: false, availableAt: null };
  if (input.freeSpinUsedAt === null) return { available: true, availableAt: null };
  const now = input.now ?? new Date();
  const readyAt = new Date(input.freeSpinUsedAt.getTime() + input.cooldownHours * 60 * 60 * 1000);
  if (readyAt.getTime() <= now.getTime()) return { available: true, availableAt: null };
  return { available: false, availableAt: readyAt.toISOString() };
}

/**
 * The instant a free spin taken now would have had to be spent before, for the
 * conditional write that claims it: `freeSpinUsedAt <= threshold` is "the
 * cooldown has passed", evaluated by PostgreSQL against the row it locks
 * rather than against a value read a moment earlier.
 */
export function freeSpinClaimThreshold(cooldownHours: number, now: Date): Date {
  return new Date(now.getTime() - cooldownHours * 60 * 60 * 1000);
}
