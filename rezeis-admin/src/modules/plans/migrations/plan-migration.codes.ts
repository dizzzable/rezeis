/**
 * THE STABLE STRINGS OF THE PLAN MIGRATION WIRE CONTRACT.
 *
 * The delete dialog in the panel SPA translates every one of these; the server
 * never writes operator copy. They are grouped by where they appear:
 *
 *   - refusals: the `code` of a 400/409 body. They reach the SPA only because
 *     each is listed in `SAFE_PRODUCT_CODES`
 *     (`common/filters/admin-safe-exception.filter.ts`) — the filter strips any
 *     other code, and `plan-migration.controller.spec.ts` checks the containment
 *     by value so a code added here and forgotten there fails a named test;
 *   - item reasons: `plan_migration_items.reason`, and the `reason` of a problem
 *     in `GET …/migrations/:runId`;
 *   - warnings: per preview row and counted per target in the summary.
 *
 * Renaming one is a breaking change for the SPA. Appending one is not: the SPA
 * renders an unknown code with a generic label.
 *
 * The module imports nothing — a table of literals, copied (never imported) by
 * the SPA, whose image has no backend tree.
 */
export const PLAN_MIGRATION_REFUSAL_CODES = Object.freeze({
  /** A target plan is the plan being deleted. */
  TARGET_IS_SOURCE: 'TARGET_IS_SOURCE',
  /** A target plan does not exist or is deleted. */
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  /** A target plan is a TRIAL plan — never a target (owner decision 3). */
  TARGET_IS_TRIAL: 'TARGET_IS_TRIAL',
  /** A subscription id appears more than once across the groups. */
  DUPLICATE_SUBSCRIPTION: 'DUPLICATE_SUBSCRIPTION',
  /** No subscription ids in any group and no "rest" target. */
  EMPTY_ASSIGNMENT: 'EMPTY_ASSIGNMENT',
  /** More than {@link PLAN_MIGRATION_MAX_EXPLICIT_IDS} ids across the groups. */
  TOO_MANY_IDS: 'TOO_MANY_IDS',
  /** A QUEUED or RUNNING run already exists for the plan (409). */
  MIGRATION_ALREADY_RUNNING: 'MIGRATION_ALREADY_RUNNING',
});

export type PlanMigrationRefusalCode =
  (typeof PLAN_MIGRATION_REFUSAL_CODES)[keyof typeof PLAN_MIGRATION_REFUSAL_CODES];

/** Why an item was SKIPPED or FAILED (`plan_migration_items.reason`). */
export const PLAN_MIGRATION_REASONS = Object.freeze({
  /** SKIPPED: the subscription is not (or no longer) on the source plan. */
  NOT_ON_SOURCE_PLAN: 'NOT_ON_SOURCE_PLAN',
  /** SKIPPED: the subscription was deleted before it could be moved. */
  SUBSCRIPTION_DELETED: 'SUBSCRIPTION_DELETED',
  /**
   * SKIPPED: a paid SCHEDULED term would undo the move — see
   * `PlanMigrationMoveService` for the two shapes that count.
   */
  SCHEDULED_TERM: 'SCHEDULED_TERM',
  /** FAILED: the target plan was deleted after the run was created. */
  TARGET_DELETED: 'TARGET_DELETED',
  /** FAILED: the target plan became a TRIAL plan after the run was created. */
  TARGET_IS_TRIAL: 'TARGET_IS_TRIAL',
  /** FAILED: subscriptions sharing one Remnawave profile were given different targets. */
  SHARED_PROFILE_TARGET_CONFLICT: 'SHARED_PROFILE_TARGET_CONFLICT',
  /**
   * SKIPPED or FAILED: this subscription could move, but a twin on the same
   * Remnawave profile cannot, and twins move together or not at all. The item
   * takes the blocking twin's status (FAILED when a retry could clear it) and
   * `detail` names the twin and its reason, e.g.
   * `Twin cmf… on the same Remnawave profile: SCHEDULED_TERM`.
   */
  SHARED_PROFILE_TWIN_BLOCKED: 'SHARED_PROFILE_TWIN_BLOCKED',
  /** FAILED: anything else; `detail` carries a short safe text. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  /** A MOVED item whose profile-sync job FAILED (a problem, not an item status). */
  SYNC_FAILED: 'SYNC_FAILED',
});

export type PlanMigrationReason = (typeof PLAN_MIGRATION_REASONS)[keyof typeof PLAN_MIGRATION_REASONS];

/**
 * The reasons a PREVIEW row reports in `willSkip` — every outcome that leaves
 * the subscription where it is, including the one the run records as FAILED
 * (`SHARED_PROFILE_TARGET_CONFLICT`), because the preview answers "will this
 * row move", not "which item status will it get".
 */
export type PlanMigrationSkipReason =
  | typeof PLAN_MIGRATION_REASONS.NOT_ON_SOURCE_PLAN
  | typeof PLAN_MIGRATION_REASONS.SUBSCRIPTION_DELETED
  | typeof PLAN_MIGRATION_REASONS.SCHEDULED_TERM
  | typeof PLAN_MIGRATION_REASONS.SHARED_PROFILE_TARGET_CONFLICT
  | typeof PLAN_MIGRATION_REASONS.SHARED_PROFILE_TWIN_BLOCKED;

/**
 * Skips that do not keep the source plan referenced: the subscription is no
 * longer on the plan or no longer exists (spec §9 A2). Every other reason leaves
 * a subscription on the plan.
 */
export const PLAN_MIGRATION_BENIGN_SKIP_REASONS: ReadonlySet<string> = new Set([
  PLAN_MIGRATION_REASONS.NOT_ON_SOURCE_PLAN,
  PLAN_MIGRATION_REASONS.SUBSCRIPTION_DELETED,
]);

/** Per-row warnings, in the order the summary lists them. */
export const PLAN_MIGRATION_WARNING_CODES = [
  'FEWER_DEVICES',
  'LESS_TRAFFIC',
  'SQUADS_REMOVED',
  'TRIAL_BECOMES_REGULAR',
  'UNKNOWN_LIMIT_TAKES_TARGET',
  'TARGET_NOT_RENEWABLE',
  'PENDING_RENEWAL_FOR_SOURCE',
  'LOCAL_ONLY',
] as const;

export type PlanMigrationWarningCode = (typeof PLAN_MIGRATION_WARNING_CODES)[number];

/** `payload.source` of every profile-sync job a move creates. */
export const PLAN_MIGRATION_SYNC_SOURCE = 'PLAN_MIGRATION';

/** Upper bound of explicit ids across all groups; "all" is `restTargetPlanId`. */
export const PLAN_MIGRATION_MAX_EXPLICIT_IDS = 5000;
