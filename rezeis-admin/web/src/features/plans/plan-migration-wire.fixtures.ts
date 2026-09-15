/**
 * THE PLAN MIGRATION BODIES, WRITTEN ONCE — in the shapes the server sends
 * (spec §4, §9 A1–A3), for every spec that answers the delete dialog.
 *
 * `plan-migration-wire-contract.test.ts` holds each builder here to the
 * backend's own declarations: it reads `plan-migration-query.service.ts` and
 * the utils its interfaces name with the TypeScript parser, and it runs the
 * backend's `describeTwinBlockers` and squad-ownership fold as written. A
 * fixture that drifts from the server fails that file by name, instead of
 * letting a suite agree with itself while the dialog disagrees with the server.
 *
 * Only the BODIES live here; each suite still decides what its server answers,
 * and when.
 *
 * No backend import: the production project compiles this file
 * (`tsconfig.app.json` excludes only tests), and the Docker frontend stage has
 * no backend tree — see `src/build-isolation.test.ts`.
 */
import { PLAN_MIGRATION_WARNING_CODES } from './plan-migration'

export type WireOwnership = 'INHERITED' | 'INDIVIDUAL' | 'UNKNOWN'

export interface WireUser {
  readonly id: string
  readonly name: string | null
  readonly username: string | null
  readonly telegramId: string | null
  readonly email: string | null
}

export interface WireLimits {
  readonly trafficLimit: number | null
  readonly deviceLimit: number
  readonly internalSquads: readonly string[]
  readonly externalSquad: string | null
}

export interface WireLimitValues extends WireLimits {
  readonly isTrial: boolean
}

export interface WireOwnershipView {
  readonly trafficLimit: WireOwnership
  readonly deviceLimit: WireOwnership
  readonly squads: WireOwnership
  readonly internalSquads: WireOwnership
  readonly externalSquad: WireOwnership
}

export interface WireSubscriptionItem {
  readonly subscriptionId: string
  readonly user: WireUser | null
  readonly status: string
  readonly isTrial: boolean
  readonly expiresAt: string | null
  readonly remnawaveLinked: boolean
  readonly limits: WireLimits
  readonly ownership: WireOwnershipView
  readonly flags: {
    readonly pendingRenewalForPlan: boolean
    readonly scheduledTermOnPlan: boolean
    readonly sharedPanelProfile: boolean
  }
}

export interface WireSubscriptionsPage {
  readonly total: number
  readonly matched: number
  readonly items: readonly WireSubscriptionItem[]
  readonly nextCursor: string | null
}

export interface WirePreviewRow {
  readonly subscriptionId: string
  readonly user: WireUser | null
  readonly targetPlanId: string
  readonly before: WireLimitValues
  readonly after: WireLimitValues
  readonly kept: readonly string[]
  readonly warnings: readonly string[]
  readonly willSkip: string | null
  readonly pushesToRemnawave: boolean
}

export interface WirePreviewSummary {
  readonly targetPlanId: string
  readonly count: number
  readonly skipped: number
  readonly warnings: Readonly<Record<string, number>>
}

export interface WirePreview {
  readonly summary: readonly WirePreviewSummary[] | null
  readonly rows: readonly WirePreviewRow[]
  readonly nextCursor: string | null
}

export interface WireProblem {
  readonly subscriptionId: string
  readonly user: WireUser | null
  readonly targetPlanId: string
  readonly kind: string
  readonly reason: string
  readonly detail: string | null
}

export interface WireRunTotals {
  readonly total: number
  readonly pending: number
  readonly moved: number
  readonly skipped: number
  readonly failed: number
  readonly skippedByReason: Readonly<Record<string, number>>
}

export interface WireSyncTotals {
  readonly total: number
  readonly pending: number
  readonly completed: number
  readonly failed: number
}

export interface WireRunView {
  readonly runId: string
  readonly status: string
  readonly totals: WireRunTotals
  readonly sync: WireSyncTotals
  readonly problems: readonly WireProblem[]
  readonly problemsCursor: string | null
  readonly finished: boolean
}

export function wireUser(id: string, fields: Partial<Omit<WireUser, 'id'>> = {}): WireUser {
  return { id, name: null, username: null, telegramId: null, email: null, ...fields }
}

/**
 * The two squad fields folded into `squads` as the server folds them: equal
 * stays, then INDIVIDUAL wins, then UNKNOWN.
 */
export function foldWireSquadOwnership(internal: WireOwnership, external: WireOwnership): WireOwnership {
  if (internal === external) return internal
  if (internal === 'INDIVIDUAL' || external === 'INDIVIDUAL') return 'INDIVIDUAL'
  if (internal === 'UNKNOWN' || external === 'UNKNOWN') return 'UNKNOWN'
  return 'INHERITED'
}

export function wireOwnership(fields: Partial<Omit<WireOwnershipView, 'squads'>> = {}): WireOwnershipView {
  const internalSquads = fields.internalSquads ?? 'INHERITED'
  const externalSquad = fields.externalSquad ?? 'INHERITED'
  return {
    trafficLimit: fields.trafficLimit ?? 'INHERITED',
    deviceLimit: fields.deviceLimit ?? 'INHERITED',
    squads: foldWireSquadOwnership(internalSquads, externalSquad),
    internalSquads,
    externalSquad,
  }
}

export function wireSubscriptionItem(
  subscriptionId: string,
  fields: Partial<Omit<WireSubscriptionItem, 'subscriptionId'>> = {},
): WireSubscriptionItem {
  return {
    subscriptionId,
    user: null,
    status: 'ACTIVE',
    isTrial: false,
    expiresAt: null,
    remnawaveLinked: true,
    limits: { trafficLimit: 50, deviceLimit: 3, internalSquads: [], externalSquad: null },
    ownership: wireOwnership(),
    flags: { pendingRenewalForPlan: false, scheduledTermOnPlan: false, sharedPanelProfile: false },
    ...fields,
  }
}

export function wireLimitValues(fields: Partial<WireLimitValues> = {}): WireLimitValues {
  return { trafficLimit: 50, deviceLimit: 3, internalSquads: [], externalSquad: null, isTrial: false, ...fields }
}

export function wirePreviewRow(
  subscriptionId: string,
  targetPlanId: string,
  fields: Partial<Omit<WirePreviewRow, 'subscriptionId' | 'targetPlanId'>> = {},
): WirePreviewRow {
  return {
    subscriptionId,
    user: null,
    targetPlanId,
    before: wireLimitValues(),
    after: wireLimitValues(),
    kept: [],
    warnings: [],
    willSkip: null,
    pushesToRemnawave: true,
    ...fields,
  }
}

/** A row the move will leave where it is: no change to show, nothing kept, nothing pushed. */
export function wireSkippedPreviewRow(
  subscriptionId: string,
  targetPlanId: string,
  willSkip: string,
  fields: { readonly user?: WireUser | null; readonly values?: WireLimitValues } = {},
): WirePreviewRow {
  const values = fields.values ?? wireLimitValues()
  return wirePreviewRow(subscriptionId, targetPlanId, {
    user: fields.user ?? null,
    before: values,
    after: values,
    willSkip,
    pushesToRemnawave: false,
  })
}

/** Every warning code, zero included — the server never leaves one out. */
export function wireWarningCounts(counts: Readonly<Record<string, number>> = {}): Readonly<Record<string, number>> {
  return Object.fromEntries(PLAN_MIGRATION_WARNING_CODES.map((code) => [code, counts[code] ?? 0]))
}

/**
 * The summary the server computes over `rows`: per target in order of first
 * appearance, `count` including the skipped rows, warnings counted on the rows
 * that move only — and only the codes the server has.
 */
export function summariseWirePreviewRows(rows: readonly WirePreviewRow[]): WirePreviewSummary[] {
  const byTarget = new Map<string, { count: number; skipped: number; warnings: Record<string, number> }>()
  for (const row of rows) {
    const entry = byTarget.get(row.targetPlanId) ?? { count: 0, skipped: 0, warnings: { ...wireWarningCounts() } }
    entry.count += 1
    if (row.willSkip !== null) entry.skipped += 1
    else for (const code of row.warnings) if (Object.hasOwn(entry.warnings, code)) entry.warnings[code] += 1
    byTarget.set(row.targetPlanId, entry)
  }
  return [...byTarget].map(([targetPlanId, entry]) => ({ targetPlanId, ...entry }))
}

/**
 * A preview page. The first page carries the summary — computed from its rows
 * unless one is given — and every later page (`firstPage: false`) sends `null`.
 */
export function wirePreview(
  rows: readonly WirePreviewRow[],
  options: {
    readonly firstPage?: boolean
    readonly summary?: readonly WirePreviewSummary[]
    readonly nextCursor?: string | null
  } = {},
): WirePreview {
  const firstPage = options.firstPage ?? true
  return {
    summary: firstPage ? (options.summary ?? summariseWirePreviewRows(rows)) : null,
    rows,
    nextCursor: options.nextCursor ?? null,
  }
}

export function wireProblem(
  subscriptionId: string,
  fields: Pick<WireProblem, 'kind' | 'reason' | 'targetPlanId'> & Partial<Pick<WireProblem, 'user' | 'detail'>>,
): WireProblem {
  return {
    subscriptionId,
    user: fields.user ?? null,
    targetPlanId: fields.targetPlanId,
    kind: fields.kind,
    reason: fields.reason,
    detail: fields.detail ?? null,
  }
}

/**
 * A run as the server reports it. The counts are held to the server's own
 * arithmetic — every item is in exactly one status, and every skip has a reason
 * — so a spec cannot show the dialog a status no server would send.
 */
export function wireRunView(fields: {
  readonly runId: string
  readonly status?: string
  readonly totals?: Partial<Omit<WireRunTotals, 'skippedByReason'>>
  readonly skippedByReason?: Readonly<Record<string, number>>
  readonly sync?: Partial<WireSyncTotals>
  readonly problems?: readonly WireProblem[]
  readonly problemsCursor?: string | null
  /** Defaults to what the server derives: COMPLETED and no sync job pending. */
  readonly finished?: boolean
}): WireRunView {
  const status = fields.status ?? 'COMPLETED'
  const skippedByReason = fields.skippedByReason ?? {}
  const pending = fields.totals?.pending ?? 0
  const moved = fields.totals?.moved ?? 0
  const skipped = fields.totals?.skipped ?? 0
  const failed = fields.totals?.failed ?? 0
  const totals: WireRunTotals = {
    total: fields.totals?.total ?? pending + moved + skipped + failed,
    pending,
    moved,
    skipped,
    failed,
    skippedByReason,
  }
  const syncPending = fields.sync?.pending ?? 0
  const syncCompleted = fields.sync?.completed ?? 0
  const syncFailed = fields.sync?.failed ?? 0
  const sync: WireSyncTotals = {
    total: fields.sync?.total ?? syncPending + syncCompleted + syncFailed,
    pending: syncPending,
    completed: syncCompleted,
    failed: syncFailed,
  }
  if (totals.total !== totals.pending + totals.moved + totals.skipped + totals.failed) {
    throw new Error(`wireRunView: total ${totals.total} is not the sum of the item statuses`)
  }
  const skipsByReason = Object.values(skippedByReason).reduce((sum, count) => sum + count, 0)
  if (skipsByReason !== totals.skipped) {
    throw new Error(`wireRunView: skippedByReason adds up to ${skipsByReason}, not the ${totals.skipped} skipped`)
  }
  if (sync.total !== sync.pending + sync.completed + sync.failed) {
    throw new Error(`wireRunView: sync total ${sync.total} is not the sum of the job states`)
  }
  return {
    runId: fields.runId,
    status,
    totals,
    sync,
    problems: fields.problems ?? [],
    problemsCursor: fields.problemsCursor ?? null,
    finished: fields.finished ?? (status === 'COMPLETED' && sync.pending === 0),
  }
}

/** The ceiling of `plan_migration_items.detail` (backend `PLAN_MIGRATION_DETAIL_MAX_LENGTH`). */
export const WIRE_DETAIL_MAX_LENGTH = 500

/**
 * The `detail` of a subscription held back by its profile twins, as the
 * backend's `describeTwinBlockers` writes it: the first blocker by id and
 * reason, how many more there are, cut at the column's length.
 */
export function wireTwinBlockedDetail(
  blockers: ReadonlyArray<{ readonly subscriptionId: string; readonly reason: string }>,
): string {
  const [first] = blockers
  if (first === undefined) return ''
  const more = blockers.length > 1 ? `; ${blockers.length - 1} more twin(s) cannot move either` : ''
  const text = `Twin ${first.subscriptionId} on the same Remnawave profile: ${first.reason}${more}`
  return text.length <= WIRE_DETAIL_MAX_LENGTH ? text : `${text.slice(0, WIRE_DETAIL_MAX_LENGTH - 1)}…`
}
