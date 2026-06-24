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
  /** Free grant (true) vs. paid checkout (false — billed via the normal
   *  payment pipeline as a NEW purchase of the trial plan). */
  readonly free: boolean;
  /** Audience: everyone, or only users invited via a referral/partner link. */
  readonly availabilityScope: TrialAvailabilityScope;
  /**
   * Require a linked Telegram account before the trial can be claimed.
   * Applies to BOTH free grants and paid trial checkouts. A web-only user
   * (no `User.telegramId`) is denied with `TRIAL_REQUIRES_TELEGRAM` until they
   * link Telegram in the cabinet. Default `false` (backward compatible).
   */
  readonly requireTelegramLink: boolean;
}

export const DEFAULT_TRIAL_SETTINGS: TrialSettings = {
  maxClaims: 1,
  free: true,
  availabilityScope: 'ALL',
  requireTelegramLink: false,
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
  const requireTelegramLink =
    typeof record['requireTelegramLink'] === 'boolean'
      ? (record['requireTelegramLink'] as boolean)
      : DEFAULT_TRIAL_SETTINGS.requireTelegramLink;
  return { maxClaims, free, availabilityScope: scope, requireTelegramLink };
}

/** Serialises trial settings for a Prisma JSON write. */
export function serializeTrialSettings(settings: TrialSettings): Prisma.InputJsonValue {
  return {
    maxClaims: settings.maxClaims,
    free: settings.free,
    availabilityScope: settings.availabilityScope,
    requireTelegramLink: settings.requireTelegramLink,
  };
}

/** Reason a trial claim is rejected. Mirrors the warning/reason codes used
 *  across the free-grant and paid-checkout trial paths. */
export type TrialClaimDenyReason =
  | 'TRIAL_ALREADY_USED'
  | 'TRIAL_INVITED_ONLY'
  | 'TRIAL_REQUIRES_TELEGRAM';

export interface TrialClaimContext {
  /** How many trials the user has already claimed (counted by `isTrial`
   *  subscriptions, including deleted ones — a consumed trial always counts). */
  readonly priorTrialClaims: number;
  /** Whether the user arrived via a referral or partner invite link. */
  readonly isInvited: boolean;
  /** Whether the user has a linked Telegram account (`User.telegramId`). */
  readonly hasTelegram: boolean;
}

/**
 * Single source of truth for the trial abuse guards shared by the free
 * grant and the paid checkout: a user may claim a trial at most
 * `maxClaims` times, `INVITED`-scoped trials require an invite edge, and a
 * `requireTelegramLink` trial requires a linked Telegram account.
 * The "no active subscription" rule is free-grant specific and stays in
 * the eligibility service rather than here.
 */
export function evaluateTrialClaim(
  settings: TrialSettings,
  context: TrialClaimContext,
): { readonly allowed: boolean; readonly reason: TrialClaimDenyReason | null } {
  if (context.priorTrialClaims >= settings.maxClaims) {
    return { allowed: false, reason: 'TRIAL_ALREADY_USED' };
  }
  if (settings.requireTelegramLink && !context.hasTelegram) {
    return { allowed: false, reason: 'TRIAL_REQUIRES_TELEGRAM' };
  }
  if (settings.availabilityScope === 'INVITED' && !context.isInvited) {
    return { allowed: false, reason: 'TRIAL_INVITED_ONLY' };
  }
  return { allowed: true, reason: null };
}
