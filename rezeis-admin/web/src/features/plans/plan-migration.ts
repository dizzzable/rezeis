/**
 * WHAT THE DELETE DIALOG DECIDES WHILE IT MOVES SUBSCRIPTIONS OFF A PLAN.
 *
 * Owner decisions of 15.09.2026: deleting a plan that still has subscriptions
 * on it lets the operator move them to other plans first, in the same dialog —
 * all or some, different subscriptions to different plans — preview "было →
 * станет", watch the move, and delete the plan once it is done.
 *
 * Every decision that is not drawing lives here, pure, so each has a unit test
 * that does not need a page: which plans may take the subscriptions, how the
 * operator's assignments become the request body, what a warning or a failure
 * reason is called, when the move counts as a success and when polling stops.
 * Like `plan-delete.ts`, this module never translates: it hands dictionary keys
 * to the components.
 *
 * ── A CODE THIS BUILD CANNOT NAME IS SHOWN, NEVER DROPPED ──────────────────
 *
 * Warning codes, skip and failure reasons and problem kinds are server strings.
 * A newer backend may send one this build has no words for; it renders with a
 * generic label carrying the raw code. Dropping it would turn "this subscription
 * failed for a reason you cannot read" into silence right above a delete button.
 * Lookups go through a `Map`: a record lookup answers `'toString'` with a
 * function off `Object.prototype`.
 */
import type {
  PlanMigrationGroup,
  PlanMigrationRequest,
  PlanMigrationRunStatus,
  PlanMigrationUser,
} from './plan-migration-api'

// ── Target plans ────────────────────────────────────────────────────────────

export interface MigrationTargetCandidate {
  readonly id: string
  readonly name: string
  readonly availability: string
  readonly isActive: boolean
  readonly isArchived: boolean
}

/**
 * The plans subscriptions may be moved to (owner decision 3): every plan the
 * catalogue lists — it lists only plans that are not deleted — ARCHIVED and
 * inactive ones included, except the plan being deleted and except TRIAL plans.
 * Catalogue order. `undefined` (the catalogue has not loaded) is no plans.
 *
 * Wider than `selectableTransitionTargets` on purpose: an upgrade target has to
 * be on sale, a new home for existing subscribers does not.
 */
export function listMigrationTargets<T extends MigrationTargetCandidate>(
  plans: readonly T[] | undefined,
  sourcePlanId: string,
): T[] {
  if (plans === undefined) return []
  return plans.filter((plan) => plan.id !== sourcePlanId && plan.availability !== 'TRIAL')
}

/**
 * A plan named by id: its catalogue name, or its id cut to ten characters when
 * the catalogue does not have it (deleted meanwhile, or never loaded). Never
 * blank — a problem row without a target would read as "moved nowhere".
 */
export function planLabelOf(plansById: ReadonlyMap<string, { readonly name: string }>, planId: string): string {
  const name = plansById.get(planId)?.name
  if (name !== undefined && name.length > 0) return name
  return planId.length > 10 ? `${planId.slice(0, 10)}…` : planId
}

// ── Assignments ─────────────────────────────────────────────────────────────

/**
 * What the operator has assigned so far.
 *
 * `explicit` maps a subscription id to its target plan — rows assigned through
 * a selection. `restTargetPlanId` is the target of every OTHER subscription on
 * the plan, loaded or not: it is how "all N" is expressed without sending N ids
 * (the server resolves the rest when the request arrives, spec §4.2).
 */
export interface MigrationAssignment {
  readonly explicit: ReadonlyMap<string, string>
  readonly restTargetPlanId: string | null
}

export const EMPTY_MIGRATION_ASSIGNMENT: MigrationAssignment = Object.freeze({
  explicit: new Map<string, string>(),
  restTargetPlanId: null,
})

/** Assigns `targetPlanId` to each of `subscriptionIds`; a re-assigned id takes the new target. */
export function assignSelected(
  assignment: MigrationAssignment,
  subscriptionIds: Iterable<string>,
  targetPlanId: string,
): MigrationAssignment {
  const explicit = new Map(assignment.explicit)
  for (const subscriptionId of subscriptionIds) explicit.set(subscriptionId, targetPlanId)
  return { explicit, restTargetPlanId: assignment.restTargetPlanId }
}

/**
 * "All subscriptions of the plan → this target". Clears every explicit
 * assignment: the operator selected ALL of them, so an earlier per-row choice
 * would otherwise survive a selection that included it. Rows assigned after
 * this are exceptions to the rest, which is the usual order of work — "all to
 * Premium, these three to Basic".
 */
export function assignAll(targetPlanId: string): MigrationAssignment {
  return { explicit: new Map<string, string>(), restTargetPlanId: targetPlanId }
}

/** The target a subscription will move to, or `null` when it has none yet. */
export function assignedTargetOf(assignment: MigrationAssignment, subscriptionId: string): string | null {
  return assignment.explicit.get(subscriptionId) ?? assignment.restTargetPlanId
}

/**
 * The request body for the preview and the start.
 *
 * An assignment to a plan no longer in `eligibleTargetIds` is left out — the
 * catalogue was refreshed and the plan is gone or became a trial — so it is
 * never sent to a target the server refuses; {@link summariseAssignment} counts
 * those subscriptions as unassigned and holds «Далее» until they are assigned
 * again. With a rest target that hold is the only thing between them and the
 * rest, which would otherwise take them to a plan nobody picked for them. An
 * explicit id whose target equals the rest target is folded into the rest: the
 * move is the same, and the body stays under the server's id limit for "all but
 * a few".
 */
export function buildMigrationRequest(
  assignment: MigrationAssignment,
  eligibleTargetIds: ReadonlySet<string>,
): PlanMigrationRequest {
  const rest =
    assignment.restTargetPlanId !== null && eligibleTargetIds.has(assignment.restTargetPlanId)
      ? assignment.restTargetPlanId
      : null
  const byTarget = new Map<string, string[]>()
  for (const [subscriptionId, targetPlanId] of assignment.explicit) {
    if (!eligibleTargetIds.has(targetPlanId) || targetPlanId === rest) continue
    const ids = byTarget.get(targetPlanId)
    if (ids === undefined) byTarget.set(targetPlanId, [subscriptionId])
    else ids.push(subscriptionId)
  }
  const groups: PlanMigrationGroup[] = [...byTarget].map(([targetPlanId, subscriptionIds]) => ({
    targetPlanId,
    subscriptionIds,
  }))
  return rest === null ? { groups } : { groups, restTargetPlanId: rest }
}

export interface MigrationAssignmentSummary {
  /** How many of `total` subscriptions have an eligible target. */
  readonly assigned: number
  readonly unassigned: number
  /** Explicit groups with their sizes, in assignment order. */
  readonly groups: ReadonlyArray<{ readonly targetPlanId: string; readonly count: number }>
  readonly restTargetPlanId: string | null
  /** Targets assigned earlier that are no longer eligible. */
  readonly ineligibleTargetIds: readonly string[]
  /** Every subscription has an eligible target: «Далее» may proceed. */
  readonly complete: boolean
}

export function summariseAssignment(
  assignment: MigrationAssignment,
  total: number,
  eligibleTargetIds: ReadonlySet<string>,
): MigrationAssignmentSummary {
  const request = buildMigrationRequest(assignment, eligibleTargetIds)
  const rest = request.restTargetPlanId ?? null
  let explicitEligible = 0
  let explicitIneligible = 0
  const ineligible = new Set<string>()
  for (const target of assignment.explicit.values()) {
    if (eligibleTargetIds.has(target)) {
      explicitEligible += 1
    } else {
      explicitIneligible += 1
      ineligible.add(target)
    }
  }
  if (assignment.restTargetPlanId !== null && rest === null) ineligible.add(assignment.restTargetPlanId)
  // A row's own choice outranks the rest, so a row whose chosen plan is gone is
  // NOT covered by the rest: it waits for a new choice like any unassigned row.
  const assigned = rest !== null ? Math.max(0, total - explicitIneligible) : Math.min(explicitEligible, total)
  const unassigned = Math.max(0, total - assigned)
  return {
    assigned,
    unassigned,
    groups: request.groups.map((group) => ({ targetPlanId: group.targetPlanId, count: group.subscriptionIds.length })),
    restTargetPlanId: rest,
    ineligibleTargetIds: [...ineligible],
    complete: total > 0 && unassigned === 0,
  }
}

// ── Selection ───────────────────────────────────────────────────────────────

/**
 * Which rows are selected. `all` is "every subscription on the plan", loaded or
 * not — offered once every shown row is selected and there are more — and
 * assigning with it assigns the rest target (spec §7.3).
 */
export interface MigrationSelection {
  readonly all: boolean
  readonly ids: ReadonlySet<string>
}

export const EMPTY_MIGRATION_SELECTION: MigrationSelection = Object.freeze({
  all: false,
  ids: new Set<string>(),
})

export function isRowSelected(selection: MigrationSelection, subscriptionId: string): boolean {
  return selection.all || selection.ids.has(subscriptionId)
}

/**
 * Toggles one row. Leaving "all" by unticking a row keeps every OTHER shown row
 * selected — the operator unticked one subscription, not the whole selection.
 */
export function toggleRow(
  selection: MigrationSelection,
  subscriptionId: string,
  visibleIds: readonly string[],
): MigrationSelection {
  if (selection.all) {
    return { all: false, ids: new Set(visibleIds.filter((id) => id !== subscriptionId)) }
  }
  const ids = new Set(selection.ids)
  if (ids.has(subscriptionId)) ids.delete(subscriptionId)
  else ids.add(subscriptionId)
  return { all: false, ids }
}

/** The header checkbox: selects every shown row, or clears them when all are selected. */
export function toggleVisible(selection: MigrationSelection, visibleIds: readonly string[]): MigrationSelection {
  if (selection.all) return EMPTY_MIGRATION_SELECTION
  const everyShown = visibleIds.length > 0 && visibleIds.every((id) => selection.ids.has(id))
  const ids = new Set(selection.ids)
  for (const id of visibleIds) {
    if (everyShown) ids.delete(id)
    else ids.add(id)
  }
  return { all: false, ids }
}

export function visibleSelectionState(
  selection: MigrationSelection,
  visibleIds: readonly string[],
): boolean | 'indeterminate' {
  if (visibleIds.length === 0) return false
  if (selection.all) return true
  const selected = visibleIds.filter((id) => selection.ids.has(id)).length
  if (selected === 0) return false
  return selected === visibleIds.length ? true : 'indeterminate'
}

export function selectedCount(selection: MigrationSelection, total: number): number {
  return selection.all ? total : selection.ids.size
}

/**
 * Whether to offer "select all N": every shown row is selected, and the plan
 * holds subscriptions the selection does not — rows not loaded yet, or hidden
 * by the search.
 */
export function canOfferSelectAll(
  selection: MigrationSelection,
  visibleIds: readonly string[],
  total: number,
): boolean {
  if (selection.all || visibleIds.length === 0) return false
  return visibleIds.every((id) => selection.ids.has(id)) && total > selection.ids.size
}

// ── Limits ──────────────────────────────────────────────────────────────────

export type TrafficLimitValue = { readonly kind: 'unlimited' } | { readonly kind: 'gigabytes'; readonly value: number }
export type DeviceLimitValue = { readonly kind: 'unlimited' } | { readonly kind: 'count'; readonly value: number }

/**
 * Traffic: `null` is UNLIMITED, and `0` is a cap of ZERO gigabytes — the
 * opposite fact. Never fold the two: see the note on `Plan.trafficLimit`.
 */
export function readTrafficLimit(value: number | null): TrafficLimitValue {
  return value === null ? { kind: 'unlimited' } : { kind: 'gigabytes', value }
}

/** Devices: `<= 0` is UNLIMITED — the opposite convention to traffic, on purpose. */
export function readDeviceLimit(value: number): DeviceLimitValue {
  return value <= 0 ? { kind: 'unlimited' } : { kind: 'count', value }
}

export type LimitDirection = 'same' | 'less' | 'more'

function compareCaps(before: number, after: number): LimitDirection {
  if (before === after) return 'same'
  return after < before ? 'less' : 'more'
}

export function compareTrafficLimits(before: number | null, after: number | null): LimitDirection {
  return compareCaps(before ?? Number.POSITIVE_INFINITY, after ?? Number.POSITIVE_INFINITY)
}

export function compareDeviceLimits(before: number, after: number): LimitDirection {
  const cap = (value: number): number => (value <= 0 ? Number.POSITIVE_INFINITY : value)
  return compareCaps(cap(before), cap(after))
}

export interface SquadChange {
  readonly kept: readonly string[]
  readonly removed: readonly string[]
  readonly added: readonly string[]
}

export function diffSquads(before: readonly string[], after: readonly string[]): SquadChange {
  const afterSet = new Set(after)
  const beforeSet = new Set(before)
  return {
    kept: before.filter((id) => afterSet.has(id)),
    removed: before.filter((id) => !afterSet.has(id)),
    added: after.filter((id) => !beforeSet.has(id)),
  }
}

// ── Warnings ────────────────────────────────────────────────────────────────

/** The warning codes of spec §4.2, in the order the dialog shows them. */
export const PLAN_MIGRATION_WARNING_CODES = [
  'FEWER_DEVICES',
  'LESS_TRAFFIC',
  'SQUADS_REMOVED',
  'TARGET_NOT_RENEWABLE',
  'TRIAL_BECOMES_REGULAR',
  'UNKNOWN_LIMIT_TAKES_TARGET',
  'PENDING_RENEWAL_FOR_SOURCE',
  'LOCAL_ONLY',
] as const

export type PlanMigrationWarningCode = (typeof PLAN_MIGRATION_WARNING_CODES)[number]

/** `caution` takes something away from the subscriber; `info` changes how it is handled. */
export type MigrationTone = 'caution' | 'info' | 'danger'

interface WarningSpec {
  readonly labelKey: string
  readonly hintKey: string
  readonly tone: MigrationTone
}

/** Keys written out, never computed — a renamed key would render its own path. */
export const PLAN_MIGRATION_WARNING_SPECS: Readonly<Record<PlanMigrationWarningCode, WarningSpec>> = Object.freeze({
  FEWER_DEVICES: {
    labelKey: 'plansPage.deleteDialog.migrate.warnings.fewerDevices',
    hintKey: 'plansPage.deleteDialog.migrate.warnings.fewerDevicesHint',
    tone: 'caution',
  },
  LESS_TRAFFIC: {
    labelKey: 'plansPage.deleteDialog.migrate.warnings.lessTraffic',
    hintKey: 'plansPage.deleteDialog.migrate.warnings.lessTrafficHint',
    tone: 'caution',
  },
  SQUADS_REMOVED: {
    labelKey: 'plansPage.deleteDialog.migrate.warnings.squadsRemoved',
    hintKey: 'plansPage.deleteDialog.migrate.warnings.squadsRemovedHint',
    tone: 'caution',
  },
  TARGET_NOT_RENEWABLE: {
    labelKey: 'plansPage.deleteDialog.migrate.warnings.targetNotRenewable',
    hintKey: 'plansPage.deleteDialog.migrate.warnings.targetNotRenewableHint',
    tone: 'caution',
  },
  TRIAL_BECOMES_REGULAR: {
    labelKey: 'plansPage.deleteDialog.migrate.warnings.trialBecomesRegular',
    hintKey: 'plansPage.deleteDialog.migrate.warnings.trialBecomesRegularHint',
    tone: 'info',
  },
  UNKNOWN_LIMIT_TAKES_TARGET: {
    labelKey: 'plansPage.deleteDialog.migrate.warnings.unknownLimitTakesTarget',
    hintKey: 'plansPage.deleteDialog.migrate.warnings.unknownLimitTakesTargetHint',
    tone: 'info',
  },
  PENDING_RENEWAL_FOR_SOURCE: {
    labelKey: 'plansPage.deleteDialog.migrate.warnings.pendingRenewalForSource',
    hintKey: 'plansPage.deleteDialog.migrate.warnings.pendingRenewalForSourceHint',
    tone: 'info',
  },
  LOCAL_ONLY: {
    labelKey: 'plansPage.deleteDialog.migrate.warnings.localOnly',
    hintKey: 'plansPage.deleteDialog.migrate.warnings.localOnlyHint',
    tone: 'info',
  },
})

/** A warning this build cannot name: `{{code}}` in the label. Caution, the conservative reading. */
export const PLAN_MIGRATION_UNKNOWN_WARNING: WarningSpec = Object.freeze({
  labelKey: 'plansPage.deleteDialog.migrate.warnings.unknown',
  hintKey: 'plansPage.deleteDialog.migrate.warnings.unknownHint',
  tone: 'caution',
})

const WARNING_BY_CODE: ReadonlyMap<string, WarningSpec> = new Map(
  PLAN_MIGRATION_WARNING_CODES.map((code) => [code, PLAN_MIGRATION_WARNING_SPECS[code]] as const),
)
const WARNING_ORDER: ReadonlyMap<string, number> = new Map(
  PLAN_MIGRATION_WARNING_CODES.map((code, index) => [code, index] as const),
)

export interface MigrationWarningDisplay extends WarningSpec {
  readonly code: string
  readonly recognised: boolean
}

export function describeMigrationWarning(code: string): MigrationWarningDisplay {
  const spec = WARNING_BY_CODE.get(code)
  return spec === undefined
    ? { ...PLAN_MIGRATION_UNKNOWN_WARNING, code, recognised: false }
    : { ...spec, code, recognised: true }
}

/**
 * A row's warnings: each once, known codes in the fixed order above, unknown
 * ones after them in the server's order. Never fewer distinct codes than sent.
 */
export function describeMigrationWarnings(codes: readonly string[]): MigrationWarningDisplay[] {
  const distinct = [...new Set(codes)]
  const known = distinct
    .filter((code) => WARNING_ORDER.has(code))
    .sort((a, b) => (WARNING_ORDER.get(a) ?? 0) - (WARNING_ORDER.get(b) ?? 0))
  const unknown = distinct.filter((code) => !WARNING_ORDER.has(code))
  return [...known, ...unknown].map(describeMigrationWarning)
}

/** A summary's warning counts: only those above zero, in the same order as a row's. */
export function describeWarningCounts(
  counts: Readonly<Record<string, number>>,
): Array<MigrationWarningDisplay & { readonly count: number }> {
  const present = Object.entries(counts).filter(([, count]) => count > 0)
  const countOf = new Map(present)
  return describeMigrationWarnings(present.map(([code]) => code)).map((warning) => ({
    ...warning,
    count: countOf.get(warning.code) ?? 0,
  }))
}

// ── Reasons and problem kinds ───────────────────────────────────────────────

/**
 * The machine reasons the backend sends (spec §5.4, as BE-MOVE implemented it):
 * skips — `NOT_ON_SOURCE_PLAN`, `SUBSCRIPTION_DELETED`, `SCHEDULED_TERM`,
 * `SHARED_PROFILE_TARGET_CONFLICT`; failures — `TARGET_DELETED`,
 * `TARGET_IS_TRIAL`, `SHARED_PROFILE_TARGET_CONFLICT`, `INTERNAL_ERROR`;
 * `SHARED_PROFILE_TWIN_BLOCKED` on either (subscriptions sharing one Remnawave
 * profile move together, so one that cannot move holds the others back, and
 * `detail` names that one's reason); and the sync failure `SYNC_FAILED`. The
 * same code reads the same whichever kind carries it: the kind badge beside it
 * says skipped or failed.
 */
export const PLAN_MIGRATION_REASON_CODES = [
  'NOT_ON_SOURCE_PLAN',
  'SUBSCRIPTION_DELETED',
  'SCHEDULED_TERM',
  'TARGET_DELETED',
  'TARGET_IS_TRIAL',
  'SHARED_PROFILE_TARGET_CONFLICT',
  'SHARED_PROFILE_TWIN_BLOCKED',
  'INTERNAL_ERROR',
  'SYNC_FAILED',
] as const

export type PlanMigrationReasonCode = (typeof PLAN_MIGRATION_REASON_CODES)[number]

export const PLAN_MIGRATION_REASON_I18N_KEYS: Readonly<Record<PlanMigrationReasonCode, string>> = Object.freeze({
  NOT_ON_SOURCE_PLAN: 'plansPage.deleteDialog.migrate.reasons.notOnSourcePlan',
  SUBSCRIPTION_DELETED: 'plansPage.deleteDialog.migrate.reasons.subscriptionDeleted',
  SCHEDULED_TERM: 'plansPage.deleteDialog.migrate.reasons.scheduledTerm',
  TARGET_DELETED: 'plansPage.deleteDialog.migrate.reasons.targetDeleted',
  TARGET_IS_TRIAL: 'plansPage.deleteDialog.migrate.reasons.targetIsTrial',
  SHARED_PROFILE_TARGET_CONFLICT: 'plansPage.deleteDialog.migrate.reasons.sharedProfileTargetConflict',
  SHARED_PROFILE_TWIN_BLOCKED: 'plansPage.deleteDialog.migrate.reasons.sharedProfileTwinBlocked',
  INTERNAL_ERROR: 'plansPage.deleteDialog.migrate.reasons.internalError',
  SYNC_FAILED: 'plansPage.deleteDialog.migrate.reasons.syncFailed',
})

/**
 * A reason this build cannot name: a generic "could not be moved", with the raw
 * code printed beside it in small type — never in place of the sentence.
 */
export const PLAN_MIGRATION_UNKNOWN_REASON_I18N_KEY = 'plansPage.deleteDialog.migrate.reasons.unknown'

const REASON_KEY_BY_CODE: ReadonlyMap<string, string> = new Map(
  PLAN_MIGRATION_REASON_CODES.map((code) => [code, PLAN_MIGRATION_REASON_I18N_KEYS[code]] as const),
)

export interface MigrationReasonDisplay {
  readonly code: string
  readonly recognised: boolean
  readonly i18nKey: string
}

export function describeMigrationReason(code: string): MigrationReasonDisplay {
  const i18nKey = REASON_KEY_BY_CODE.get(code)
  return i18nKey === undefined
    ? { code, recognised: false, i18nKey: PLAN_MIGRATION_UNKNOWN_REASON_I18N_KEY }
    : { code, recognised: true, i18nKey }
}

export const PLAN_MIGRATION_PROBLEM_KINDS = ['MOVE_FAILED', 'MOVE_SKIPPED', 'SYNC_FAILED'] as const
export type PlanMigrationProblemKind = (typeof PLAN_MIGRATION_PROBLEM_KINDS)[number]

interface ProblemKindSpec {
  readonly i18nKey: string
  readonly tone: MigrationTone
}

export const PLAN_MIGRATION_PROBLEM_KIND_SPECS: Readonly<Record<PlanMigrationProblemKind, ProblemKindSpec>> =
  Object.freeze({
    MOVE_FAILED: { i18nKey: 'plansPage.deleteDialog.migrate.problems.kinds.moveFailed', tone: 'danger' },
    MOVE_SKIPPED: { i18nKey: 'plansPage.deleteDialog.migrate.problems.kinds.moveSkipped', tone: 'caution' },
    SYNC_FAILED: { i18nKey: 'plansPage.deleteDialog.migrate.problems.kinds.syncFailed', tone: 'danger' },
  })

export const PLAN_MIGRATION_UNKNOWN_PROBLEM_KIND: ProblemKindSpec = Object.freeze({
  i18nKey: 'plansPage.deleteDialog.migrate.problems.kinds.unknown',
  tone: 'danger',
})

const PROBLEM_KIND_BY_CODE: ReadonlyMap<string, ProblemKindSpec> = new Map(
  PLAN_MIGRATION_PROBLEM_KINDS.map((kind) => [kind, PLAN_MIGRATION_PROBLEM_KIND_SPECS[kind]] as const),
)

export function describeMigrationProblemKind(kind: string): ProblemKindSpec & { readonly recognised: boolean } {
  const spec = PROBLEM_KIND_BY_CODE.get(kind)
  return spec === undefined ? { ...PLAN_MIGRATION_UNKNOWN_PROBLEM_KIND, recognised: false } : { ...spec, recognised: true }
}

// ── The run ─────────────────────────────────────────────────────────────────

/**
 * Whether the server reports the run over — AND its own counts agree.
 *
 * `finished: false` is never over, whatever else the status says: since §9 A1
 * a profile sync that failed but will still be retried counts as PENDING, so a
 * transient Remnawave failure keeps the run unfinished instead of looking like a
 * final one. And `finished` alone is not taken either: a status that says
 * finished while items or sync jobs are still pending is inconsistent, and
 * reading it as finished would delete the plan in the middle of the move.
 */
export function isMigrationRunSettled(status: PlanMigrationRunStatus): boolean {
  return status.finished && status.totals.pending === 0 && status.sync.pending === 0
}

export type MigrationRunOutcome = 'running' | 'success' | 'problems'

/**
 * The skip reasons that leave nothing on the plan (§9 A2): the subscription had
 * already left it, or was deleted. Every other skip keeps a subscription there.
 */
export const PLAN_MIGRATION_BENIGN_SKIP_REASONS = ['NOT_ON_SOURCE_PLAN', 'SUBSCRIPTION_DELETED'] as const

/** How many of the run's skips are benign, from the server's per-reason counts. */
export function benignSkipCount(totals: PlanMigrationRunStatus['totals']): number {
  const byReason = new Map(Object.entries(totals.skippedByReason))
  return PLAN_MIGRATION_BENIGN_SKIP_REASONS.reduce((sum, reason) => sum + (byReason.get(reason) ?? 0), 0)
}

/**
 * Success (spec §7.6, §9 A2): nothing failed, no sync failed, and every skip
 * is benign — counted over ALL items by `skippedByReason`, never inferred from
 * the problems list, whose first page stops at 100. Anything else is
 * `problems`, where the operator decides.
 */
export function classifyMigrationRun(status: PlanMigrationRunStatus): MigrationRunOutcome {
  if (!isMigrationRunSettled(status)) return 'running'
  if (status.totals.failed > 0 || status.sync.failed > 0) return 'problems'
  return status.totals.skipped === benignSkipCount(status.totals) ? 'success' : 'problems'
}

/**
 * Failure reasons a retry cannot fix — the target plan is gone or became a
 * trial, or twins on one Remnawave profile were given different plans (a retry
 * keeps the targets) — so the dialog offers choosing another plan for what is
 * left instead.
 *
 * `SHARED_PROFILE_TWIN_BLOCKED` is not in the set: it takes the status of the
 * twin that blocks it, so it FAILS only when that twin failed, and a retry
 * retries both together. What decides is the BLOCKER's reason, read from
 * `detail` (see {@link twinBlockerReason}).
 */
export const PLAN_MIGRATION_NOT_RETRYABLE_REASONS: ReadonlySet<string> = new Set([
  'TARGET_DELETED',
  'TARGET_IS_TRIAL',
  'SHARED_PROFILE_TARGET_CONFLICT',
])

/**
 * The reason of the twin holding a `SHARED_PROFILE_TWIN_BLOCKED` subscription
 * back, off its `detail` — `Twin <id> on the same Remnawave profile: <REASON>`,
 * optionally followed by `; N more twin(s) cannot move either`, exactly as the
 * backend's `describeTwinBlockers` writes it (`plan-migration-wire-contract.test.ts`
 * runs that function). `null` when the detail does not read so — including one
 * cut short at the column's length — and the caller then shows it as it came.
 */
export function twinBlockerReason(detail: string | null): string | null {
  if (detail === null) return null
  const match = /^Twin \S+ on the same Remnawave profile: ([A-Z][A-Z0-9_]*)(?=; |$)/.exec(detail)
  return match === null ? null : match[1]
}

/** The reason that decides whether retrying a failure can help: a twin's blocker's, else its own. */
function reasonDecidingRetry(problem: PlanMigrationRunStatus['problems'][number]): string {
  if (problem.reason !== 'SHARED_PROFILE_TWIN_BLOCKED') return problem.reason
  return twinBlockerReason(problem.detail) ?? problem.reason
}

/**
 * Whether to offer «Выбрать другой тариф для оставшихся»: something failed to
 * move, or was held back by its profile twin — which comes as a SKIP when the
 * blocker was skipped, and then no retry can help. Other skips — a subscription
 * renewed in advance — would be skipped again whatever plan it were given, and
 * a failed sync has already moved its subscription.
 */
export function canChooseAnotherTarget(totals: PlanMigrationRunStatus['totals']): boolean {
  const twinBlocked = new Map(Object.entries(totals.skippedByReason)).get('SHARED_PROFILE_TWIN_BLOCKED') ?? 0
  return totals.failed > 0 || twinBlocked > 0
}

/**
 * Whether «Повторить для неудавшихся» would only fail again: the problems list
 * is complete (no further page), accounts for every failed item, and each of
 * those failures has a reason a retry cannot fix. An incomplete list proves
 * nothing about the failures not on it, so it keeps the retry.
 */
export function failuresNeedAnotherTarget(
  problems: PlanMigrationRunStatus['problems'],
  listComplete: boolean,
  failedCount: number,
): boolean {
  if (!listComplete || failedCount === 0) return false
  const failures = problems.filter((problem) => problem.kind === 'MOVE_FAILED')
  return (
    failures.length === failedCount &&
    failures.every((problem) => PLAN_MIGRATION_NOT_RETRYABLE_REASONS.has(reasonDecidingRetry(problem)))
  )
}

export type TwinDetailDisplay =
  | { readonly kind: 'blockerReason'; readonly reason: MigrationReasonDisplay }
  | { readonly kind: 'raw'; readonly text: string }

/**
 * What a problem row says under its reason. A twin held back names its
 * blocker's reason in the operator's words when this build knows the code, and
 * the detail as it came otherwise; every other detail is shown as it came.
 * `null` when there is nothing to show.
 */
export function describeProblemDetail(problem: PlanMigrationRunStatus['problems'][number]): TwinDetailDisplay | null {
  if (problem.reason === 'SHARED_PROFILE_TWIN_BLOCKED') {
    const blocker = twinBlockerReason(problem.detail)
    if (blocker !== null) {
      const reason = describeMigrationReason(blocker)
      if (reason.recognised) return { kind: 'blockerReason', reason }
    }
  }
  return problem.detail === null || problem.detail.length === 0 ? null : { kind: 'raw', text: problem.detail }
}

/**
 * Whether a finished status is still to be read as the run BEFORE an accepted
 * retry (see `PLAN_MIGRATION_RETRY_ECHO_MS`). Only a SETTLED status can be such
 * an echo; a status that reports work in progress is the retry's own answer.
 */
export function isAwaitingRetryEcho(
  status: PlanMigrationRunStatus | undefined,
  dataUpdatedAt: number,
  retryRequestedAt: number | null,
  echoMs: number,
): boolean {
  if (retryRequestedAt === null || status === undefined) return false
  if (!isMigrationRunSettled(status)) return false
  return dataUpdatedAt - retryRequestedAt < echoMs
}

/**
 * Whether the status query keeps polling. It does while there is no status
 * (the first answer has not arrived, or failed), while the run is not settled,
 * and inside the retry window. A settled run with no retry pending stops it —
 * an open dialog on a finished move makes no requests.
 */
export function shouldPollMigrationRun(
  status: PlanMigrationRunStatus | undefined,
  dataUpdatedAt: number,
  retryRequestedAt: number | null,
  echoMs: number,
): boolean {
  if (status === undefined) return true
  if (!isMigrationRunSettled(status)) return true
  return isAwaitingRetryEcho(status, dataUpdatedAt, retryRequestedAt, echoMs)
}

export type MigrationRunPhase = 'queued' | 'moving' | 'syncing' | 'settled'

export interface MigrationRunProgress {
  readonly phase: MigrationRunPhase
  /** moved + skipped + failed, of all items. */
  readonly move: { readonly done: number; readonly total: number }
  /** completed + failed, of the sync jobs this run created. */
  readonly sync: { readonly done: number; readonly failed: number; readonly total: number }
}

export function describeMigrationProgress(status: PlanMigrationRunStatus): MigrationRunProgress {
  const { totals, sync } = status
  const move = { done: totals.moved + totals.skipped + totals.failed, total: totals.total }
  const syncProgress = { done: sync.completed + sync.failed, failed: sync.failed, total: sync.total }
  let phase: MigrationRunPhase
  if (isMigrationRunSettled(status)) phase = 'settled'
  else if (status.status === 'QUEUED') phase = 'queued'
  else if (totals.pending > 0 || status.status !== 'COMPLETED') phase = 'moving'
  else phase = 'syncing'
  return { phase, move, sync: syncProgress }
}

/** A whole percentage for a progress bar; an empty phase is complete. */
export function progressPercent(done: number, total: number): number {
  if (total <= 0) return 100
  return Math.min(100, Math.round((done / total) * 100))
}

// ── Refusals ────────────────────────────────────────────────────────────────

/** The 400/409 codes of spec §4.2–§4.3 the dialog names. */
export const PLAN_MIGRATION_REFUSAL_I18N_KEYS: ReadonlyMap<string, string> = new Map([
  ['TARGET_IS_SOURCE', 'plansPage.deleteDialog.migrate.refusals.targetIsSource'],
  ['TARGET_NOT_FOUND', 'plansPage.deleteDialog.migrate.refusals.targetNotFound'],
  ['TARGET_IS_TRIAL', 'plansPage.deleteDialog.migrate.refusals.targetIsTrial'],
  ['DUPLICATE_SUBSCRIPTION', 'plansPage.deleteDialog.migrate.refusals.duplicateSubscription'],
  ['EMPTY_ASSIGNMENT', 'plansPage.deleteDialog.migrate.refusals.emptyAssignment'],
  ['TOO_MANY_IDS', 'plansPage.deleteDialog.migrate.refusals.tooManyIds'],
  ['MIGRATION_ALREADY_RUNNING', 'plansPage.deleteDialog.migrate.refusals.alreadyRunning'],
])

/** Refusals after which the catalogue the targets came from is stale. */
export const PLAN_MIGRATION_TARGET_REFUSALS: ReadonlySet<string> = new Set([
  'TARGET_NOT_FOUND',
  'TARGET_IS_TRIAL',
  'TARGET_IS_SOURCE',
])

/** Whether a failed request was refused by the server with a code this dialog names. */
export function isKnownMigrationRefusal(code: string | null): boolean {
  return code !== null && PLAN_MIGRATION_REFUSAL_I18N_KEYS.has(code)
}

/**
 * Whether a failed request got NO answer: it timed out, or the connection
 * failed (§9 A6.2). Such a start may still have committed on the server, so
 * the dialog asks for the current run before it says anything. An axios
 * CANCEL is not this — that is the dialog itself abandoning the request.
 * Duck-typed, like `readProductCode`.
 */
export function isNoResponseError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { isAxiosError, response, code } = error as { isAxiosError?: unknown; response?: unknown; code?: unknown }
  if (isAxiosError !== true) return false
  if (code === 'ERR_CANCELED') return false
  return response === undefined || response === null
}

/**
 * Whether a failed START may have committed all the same, so the dialog asks for
 * the current run before it says anything: there was no answer at all
 * ({@link isNoResponseError}), or the answer was a timeout given by something
 * that stopped waiting while the handler went on — the app's own request-timeout
 * middleware (408, with no code) or a proxy in front of it (504).
 *
 * Not for the preview: a preview writes nothing, so its 408 or 504 is a preview
 * that failed, and asking again is the operator's Retry.
 */
export function mayHaveStartedAnyway(error: unknown): boolean {
  if (isNoResponseError(error)) return true
  if (typeof error !== 'object' || error === null) return false
  const { isAxiosError, response } = error as { isAxiosError?: unknown; response?: { status?: unknown } | null }
  if (isAxiosError !== true || typeof response !== 'object' || response === null) return false
  return response.status === 408 || response.status === 504
}

// ── Who a row is ────────────────────────────────────────────────────────────

export type SubscriberDetail =
  | { readonly kind: 'username'; readonly value: string }
  | { readonly kind: 'telegramId'; readonly value: string }
  | { readonly kind: 'email'; readonly value: string }

export interface SubscriberDescription {
  /** The name the row leads with: name, @username, email, Telegram ID, else the subscription id. */
  readonly primary: string
  /** `primary` is the subscription id — no user identifier to show. */
  readonly anonymous: boolean
  readonly details: readonly SubscriberDetail[]
}

export function describeSubscriber(
  user: PlanMigrationUser | null | undefined,
  subscriptionId: string,
): SubscriberDescription {
  const present = (value: string | null | undefined): string | null => {
    const trimmed = value?.trim() ?? ''
    return trimmed.length > 0 ? trimmed : null
  }
  const name = present(user?.name)
  const username = present(user?.username)
  const email = present(user?.email)
  const telegramId = present(user?.telegramId)
  const handle = username === null ? null : `@${username.replace(/^@/, '')}`
  const primary = name ?? handle ?? email ?? telegramId
  const details: SubscriberDetail[] = []
  if (handle !== null && handle !== primary) details.push({ kind: 'username', value: handle })
  if (telegramId !== null && telegramId !== primary) details.push({ kind: 'telegramId', value: telegramId })
  if (email !== null && email !== primary) details.push({ kind: 'email', value: email })
  return primary === null
    ? { primary: subscriptionId, anonymous: true, details }
    : { primary, anonymous: false, details }
}
