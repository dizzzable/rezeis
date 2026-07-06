export const PROFILE_SYNC_QUEUE = 'profile-sync';
export const PROFILE_SYNC_JOB = 'profile-sync-job';
export const PROFILE_SYNC_MAX_ATTEMPTS = 5;
// First-retry delay for a transient Remnawave failure. Exponential from here
// (5s → 10s → 20s …). Kept low so a brief panel hiccup doesn't stall delivery
// for 30s+; only genuine outages walk up the backoff toward the sweep cron.
export const PROFILE_SYNC_BACKOFF_MS = 5_000;

/**
 * Worker concurrency — how many Remnawave provisioning jobs run in parallel.
 * Tunable via `PROFILE_SYNC_CONCURRENCY` so the operator can scale for purchase
 * bursts (e.g. 1000 concurrent buyers) against the panel's rate limits. Read
 * from env at import time (decorator evaluation), default 10.
 */
export const PROFILE_SYNC_CONCURRENCY = clampConcurrency(
  process.env.PROFILE_SYNC_CONCURRENCY,
  10,
);

/** Parses a positive-int concurrency from env, clamped to [1, 100]. */
export function clampConcurrency(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, 100);
}
