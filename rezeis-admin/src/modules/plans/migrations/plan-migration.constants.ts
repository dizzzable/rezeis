/** BullMQ queue that runs plan migrations, one tick of a run at a time. */
export const PLAN_MIGRATION_QUEUE = 'plan-migration';

/** The only job on the queue: process the next batch of one run. */
export const PLAN_MIGRATION_TICK_JOB = 'plan-migration.tick';

/** Items one tick processes before handing the run to the next tick. */
export const PLAN_MIGRATION_BATCH_SIZE = 50;

/**
 * Attempts one item's transaction gets when PostgreSQL aborts it to break a
 * deadlock or a serialization conflict. The combined renewal locks its
 * subscriptions in item order, not sorted, so a move of the same subscription
 * can lose a deadlock to it; the whole transaction rolled back and running it
 * again is safe.
 */
export const PLAN_MIGRATION_MAX_ATTEMPTS = 3;

/**
 * Ceiling of one item's transaction. Generous next to Prisma's 5 s default: the
 * term rotation and the projection recompute are several statements, and the
 * transaction may queue behind a renewal holding the subscription row. A timeout
 * rolls the item back whole and it is recorded FAILED, never half-moved.
 */
export const PLAN_MIGRATION_ITEM_TIMEOUT_MS = 30_000;

/**
 * Ceiling of the request that creates a run: it locks the plan, resolves every
 * subscription on it (a JSON-path scan no index serves) and inserts the items.
 */
export const PLAN_MIGRATION_CREATE_TIMEOUT_MS = 60_000;

/**
 * A QUEUED/RUNNING run whose row has not been touched for this long has lost its
 * tick — the worker restarted, or the enqueue after the request failed — and the
 * sweep enqueues a new one. Every tick touches the row before its batch, so a
 * live run never looks stale.
 */
export const PLAN_MIGRATION_STALE_RUN_MS = 2 * 60 * 1000;

/** Delay before re-ticking a run whose batch made no progress (rows locked elsewhere). */
export const PLAN_MIGRATION_IDLE_RETICK_MS = 2_000;

/** Problems per page of `GET …/migrations/:runId`. */
export const PLAN_MIGRATION_PROBLEMS_PAGE_SIZE = 100;

/** `detail` column ceiling (spec §3). */
export const PLAN_MIGRATION_DETAIL_MAX_LENGTH = 500;

/** Reads of many subscriptions are chunked to keep bind-parameter counts sane. */
export const PLAN_MIGRATION_READ_CHUNK = 500;
