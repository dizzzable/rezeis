import {
  DEFAULT_REMNAWAVE_TIME_ZONE,
  resolveRemnawaveTimeZone,
  ResetCyclePolicyError,
} from '../domain/reset-cycle-policy';

/**
 * «ЧАСОВОЙ ПОЯС REMNAWAVE» — the zone Remnawave's scheduler resets traffic in.
 *
 * Remnawave runs its four reset jobs on its scheduler process's own clock
 * (`reset-cycle-policy.ts` restates the rule): UTC on a default install, whose
 * image sets no `TZ`, and whatever a `TZ` line in the Remnawave server's `.env`
 * says otherwise. No API tells the panel which zone that is, so the operator
 * does, on «Доп. услуги» → «Настройки». It moves the MINUTE of every reset,
 * never a rolling profile's DAY: that is the date of Remnawave's database,
 * which its compose file pins to UTC (proved live on 3.2.3, 3.3.2 and 3.4.4 —
 * `test/reset-schedule-lab-parity.spec.ts`).
 *
 * Stored in `settings.add_on_settings` beside the switches, under
 * {@link REMNAWAVE_TIME_ZONE_KEY}, and read with them in ONE row read
 * (`AddOnSwitchesService.flags`), so every operation that reads the flags once
 * before its transaction has the zone from the same snapshot. Absent means
 * never set, which is UTC. ONE reader of the key for everybody:
 * `readStoredRemnawaveTimeZone` in `add-on-rollout.config.ts`.
 */
export const REMNAWAVE_TIME_ZONE_KEY = 'remnawaveTimeZone';

/** The longest name accepted; the longest IANA name is 32 characters. */
export const REMNAWAVE_TIME_ZONE_MAX_LENGTH = 64;

/**
 * The shape of an IANA name: letters first, then letters, digits, `_`, `+`, `-`
 * and `/` between parts (`Europe/Moscow`, `Etc/GMT+3`, `America/Argentina/Salta`).
 * Offsets like `+03:00` are not names: Remnawave's `TZ` does not take them.
 */
const IANA_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/** Why an operator's zone was refused; the page names it in its own words. */
export const ADD_ON_TIME_ZONE_INVALID = 'ADD_ON_TIME_ZONE_INVALID';

/** One zone as the page shows it. */
export interface RemnawaveTimeZoneState {
  /** The zone the panel predicts Remnawave's resets in right now: the stored one, or UTC. */
  readonly value: string;
  /** The operator's own value, or `null` while never set. */
  readonly stored: string | null;
  readonly defaultValue: string;
}

export function describeRemnawaveTimeZone(stored: string | null): RemnawaveTimeZoneState {
  return { value: stored ?? DEFAULT_REMNAWAVE_TIME_ZONE, stored, defaultValue: DEFAULT_REMNAWAVE_TIME_ZONE };
}

/** An operator's zone refused: not a name, or a name this runtime does not know. */
export class RemnawaveTimeZoneInputError extends Error {
  public constructor(public readonly input: string) {
    super(
      `Unknown time zone ${JSON.stringify(input)}: give the IANA name Remnawave runs in, such as UTC or ` +
        'Europe/Moscow (the TZ line of the Remnawave server .env; UTC when there is none)',
    );
    this.name = 'RemnawaveTimeZoneInputError';
  }
}

/**
 * The value to store for what the operator typed: the zone's canonical name
 * (`europe/moscow` → `Europe/Moscow`), or `null` for an empty field, which puts
 * the zone back to its default, UTC. Throws {@link RemnawaveTimeZoneInputError}
 * for anything that is not a zone this runtime knows — the same test the
 * schedule itself applies (`resolveRemnawaveTimeZone`), so a value that passes
 * here can never be refused by the money path later.
 */
export function normalizeRemnawaveTimeZoneInput(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  if (trimmed.length > REMNAWAVE_TIME_ZONE_MAX_LENGTH || !IANA_NAME.test(trimmed)) {
    throw new RemnawaveTimeZoneInputError(trimmed);
  }
  let resolved: string;
  try {
    resolved = resolveRemnawaveTimeZone(trimmed);
  } catch (error) {
    if (error instanceof ResetCyclePolicyError) throw new RemnawaveTimeZoneInputError(trimmed);
    throw error;
  }
  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat('en-US', { timeZone: resolved }).resolvedOptions().timeZone;
  } catch {
    throw new RemnawaveTimeZoneInputError(trimmed);
  }
  // A canonical spelling the policy would not take back is no use; keep the
  // one it accepted.
  try {
    return resolveRemnawaveTimeZone(canonical);
  } catch {
    return resolved;
  }
}
