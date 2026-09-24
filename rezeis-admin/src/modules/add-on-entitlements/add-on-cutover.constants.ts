/** BullMQ queue that brings existing subscriptions into the term model. */
export const ADD_ON_CUTOVER_QUEUE = 'add-on-entitlement-cutover';

/** The only job on the queue: one bounded pass of the cutover. */
export const ADD_ON_CUTOVER_TICK_JOB = 'add-on-entitlement-cutover.tick';

/**
 * The tick's FIXED job id, and the whole of the single-runner guarantee.
 *
 * BullMQ keeps at most one job per id: while a tick waits, is delayed or runs,
 * every further `add` under this id — the next cron, a second worker, a
 * blue/green twin, a restart's bootstrap kick — returns that job and adds
 * nothing. So two passes never run at once, across every process that attaches
 * a worker. The tick is enqueued with `removeOnComplete` and `removeOnFail`, so
 * the id is free again the moment a pass ends; a retained finished job would
 * swallow every later add in silence.
 *
 * No `:` and not an integer: BullMQ refuses a custom id containing `:` unless it
 * splits into exactly three parts, and refuses one that reads as an integer. A
 * constant, so there is no caller-minted key to digest.
 */
export const ADD_ON_CUTOVER_JOB_ID = 'add-on-entitlement-cutover-tick';

/** Subscriptions read per page of a tick. */
export const ADD_ON_CUTOVER_BATCH_SIZE = 200;

/**
 * A tick's budget. Each subscription is its own short transaction (about seven
 * statements, no network), so a tick stops at whichever comes first and the
 * next cron picks up where the candidate set now starts.
 */
export const ADD_ON_CUTOVER_MAX_ROWS_PER_TICK = 5_000;
export const ADD_ON_CUTOVER_TICK_BUDGET_MS = 3 * 60_000;

/** Breath between pages, so a large install is not one uninterrupted burst. */
export const ADD_ON_CUTOVER_PAUSE_MS = 100;
