/**
 * The connection signal's numbers, in one place so the probe, the health and
 * their specs cannot drift apart.
 */

/** Redis key the worker's probe mirrors its last cycle into; the API reads it. */
export const CONNECT_PROBE_STATUS_KEY = 'rezeis:connect-signal:probe';

/** Every ten minutes, in the worker only. */
export const CONNECT_PROBE_CRON = '*/10 * * * *';

/** At most this many single-profile reads per cycle — ≤ 600 an hour. */
export const CONNECT_PROBE_BATCH = 100;

/** Reads in flight at once. */
export const CONNECT_PROBE_CONCURRENCY = 4;

/**
 * How long one read may take. The shared outbound timeout is 45 s; with a
 * hundred reads a cycle an unresponsive panel would stretch one cycle past the
 * next tick. Losing the race counts as unavailable and costs nothing else.
 */
export const CONNECT_PROBE_READ_DEADLINE_MS = 3_000;

/**
 * The horizon the signal is kept for: subscriptions created, or paid for, in
 * the last 30 days — the longest window any «не подключился» filter looks back.
 */
export const CONNECT_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A subscription read successfully less than this long ago is not read again,
 * unless the automatic sender is about to decide it. Verification is good for
 * 24 hours; re-reading every ten minutes would only load the panel.
 */
export const CONNECT_PROBE_RECHECK_MS = 60 * 60 * 1000;

/** From this many consecutive failures on a row, the probe backs off. */
export const CONNECT_PROBE_BACKOFF_AFTER = 3;

/** Backoff: 2^failures × this, … */
export const CONNECT_PROBE_BACKOFF_STEP_MS = 10 * 60 * 1000;

/** … never longer than this. */
export const CONNECT_PROBE_BACKOFF_CAP_MS = 24 * 60 * 60 * 1000;

/** The probe counts as failing once it has not read anything for this long. */
export const CONNECT_PROBE_STALE_MS = 30 * 60 * 1000;

/** A `user.*` webhook this recent means webhooks are arriving. */
export const CONNECT_WEBHOOK_FRESH_MS = 24 * 60 * 60 * 1000;

/** How long the health answer is reused in one process. */
export const CONNECT_HEALTH_CACHE_MS = 60 * 1000;

/**
 * How far ahead of its moment the sender's candidates are read first, so the
 * sender finds them freshly verified.
 */
export const CONNECT_PROBE_DUE_AHEAD_MS = 60 * 60 * 1000;

/** The sender's catch-up window after its N hours (worker downtime, a switch turned on). */
export const CONNECT_HELP_CATCH_UP_MS = 72 * 60 * 60 * 1000;
