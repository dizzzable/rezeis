import { Prisma } from '@prisma/client';

/** Who may claim a trial plan. */
export type TrialAvailabilityScope = 'ALL' | 'INVITED';

/**
 * Normalised trial-plan tunables. Persisted on `Plan.trialSettings` (JSON) and
 * only meaningful when the plan's availability is `TRIAL`.
 */
export interface TrialSettings {
  /** How many times a single user may claim this trial (>= 1). */
  readonly maxClaims: number;
  /** Free grant (true) vs. paid checkout (false — paid path not yet wired). */
  readonly free: boolean;
  /** Audience: everyone, or only users invited via a referral/partner link. */
  readonly availabilityScope: TrialAvailabilityScope;
}

export const DEFAULT_TRIAL_SETTINGS: TrialSettings = {
  maxClaims: 1,
  free: true,
  availabilityScope: 'ALL',
};

/**
 * Defensive reader: tolerates legacy `{}`/null values and clamps the claim
 * count into a sane range so a bad write can't unlock unlimited trials.
 */
export function readTrialSettings(value: Prisma.JsonValue | null | undefined): TrialSettings {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_TRIAL_SETTINGS;
  }
  const record = value as Record<string, unknown>;
  const rawMax = record['maxClaims'];
  const maxClaims =
    typeof rawMax === 'number' && Number.isFinite(rawMax)
      ? Math.min(Math.max(Math.trunc(rawMax), 1), 100)
      : DEFAULT_TRIAL_SETTINGS.maxClaims;
  const free = typeof record['free'] === 'boolean' ? (record['free'] as boolean) : DEFAULT_TRIAL_SETTINGS.free;
  const scope: TrialAvailabilityScope =
    record['availabilityScope'] === 'INVITED' ? 'INVITED' : 'ALL';
  return { maxClaims, free, availabilityScope: scope };
}

/** Serialises trial settings for a Prisma JSON write. */
export function serializeTrialSettings(settings: TrialSettings): Prisma.InputJsonValue {
  return {
    maxClaims: settings.maxClaims,
    free: settings.free,
    availabilityScope: settings.availabilityScope,
  };
}
