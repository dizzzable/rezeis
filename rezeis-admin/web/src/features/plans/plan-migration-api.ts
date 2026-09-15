/**
 * THE MIGRATION ENDPOINTS OF THE PLAN DELETE DIALOG (plan migration spec §4,
 * 15.09.2026).
 *
 * Before a plan with subscriptions on it is deleted, the dialog lists those
 * subscriptions, previews what moving them to other plans does, starts the move
 * and follows it. Six routes under `admin/plans/:planId` — pinned to the
 * controller by `plan-migration-wire-contract.test.ts` — plus the two squad
 * option lists the preview names squads with.
 *
 * ── EVERY BODY IS READ, NOT CAST ────────────────────────────────────────────
 *
 * `readPlanReferences` next door is the model: anything that is not the shape
 * the contract names THROWS `errors.unexpectedResponsePayload`, and the dialog
 * renders that as "could not load" — never as a default. The defaults are
 * exactly the dangerous sentences here: an unreadable list read as empty says
 * "nothing is on this plan" and deletes it without moving anyone; an unreadable
 * status read as finished deletes the plan while the move is still running.
 *
 * SHAPES AND NUMBERS ARE CHECKED STRICTLY — they are what decisions are made on.
 * ENUMERATED STRINGS (a status, a warning code, a reason, a problem kind) are
 * checked for being strings and nothing more: a rolling deploy WILL put a newer
 * backend behind this panel, and a value this build has no words for is shown
 * as such (see `plan-migration.ts`) rather than failing the whole answer.
 *
 * ── UNLIMITED IS ENCODED TWO OPPOSITE WAYS ──────────────────────────────────
 *
 * The limits are the subscription COLUMNS' encodings (spec §4): `trafficLimit`
 * `null` is unlimited and `0` is a cap of zero; `deviceLimit` `<= 0` is
 * unlimited. They are kept exactly as sent — folding either at this boundary
 * turns unlimited into its opposite. `plan-migration.ts` reads them.
 *
 * ── THE QUERY KEYS SIT OUTSIDE `plansQueryKeys.all` ─────────────────────────
 *
 * For the reason `plansQueryKeys.references` gives: a successful delete
 * invalidates `all` while this dialog may still be mounted, and a key under that
 * root would be refetched on the spot — for a plan that no longer exists.
 */
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import { api } from '@/lib/api'
import { isRecord } from '@/lib/api-utils'

import { shouldPollMigrationRun } from './plan-migration'
import { PLAN_MIGRATION_POLL_MS, PLAN_MIGRATION_RETRY_ECHO_MS } from './plan-migration-timing'

// ── Wire types ──────────────────────────────────────────────────────────────

export interface PlanMigrationUser {
  readonly id: string
  readonly name: string | null
  readonly username: string | null
  readonly telegramId: string | null
  readonly email: string | null
}

/** A subscription's limits, in the subscription columns' own encodings. */
export interface PlanMigrationLimits {
  /** Gigabytes; `null` is UNLIMITED, `0` is a cap of zero. */
  readonly trafficLimit: number | null
  /** `<= 0` is UNLIMITED. */
  readonly deviceLimit: number
  readonly internalSquads: readonly string[]
  readonly externalSquad: string | null
}

export interface PlanSubscriptionFlags {
  /** An in-flight renewal payment for this plan. Informational: it is moved anyway. */
  readonly pendingRenewalForPlan: boolean
  /** A scheduled term on this plan: the move will SKIP it. */
  readonly scheduledTermOnPlan: boolean
  /** Another live subscription shares its Remnawave profile. */
  readonly sharedPanelProfile: boolean
}

export interface PlanSubscriptionItem {
  readonly subscriptionId: string
  readonly user: PlanMigrationUser | null
  /** `ACTIVE | LIMITED | DISABLED | EXPIRED` by contract; kept as sent. */
  readonly status: string
  readonly isTrial: boolean
  readonly expiresAt: string | null
  readonly remnawaveLinked: boolean
  readonly limits: PlanMigrationLimits
  /** Per limit field: `INHERITED | INDIVIDUAL | UNKNOWN`. Keys as the server splits them. */
  readonly ownership: Readonly<Record<string, string>>
  readonly flags: PlanSubscriptionFlags
}

/** `GET /admin/plans/:planId/subscriptions` (§4.1). */
export interface PlanSubscriptionsPage {
  /** Every subscription on the plan, ignoring the search. */
  readonly total: number
  /** With the search applied. */
  readonly matched: number
  readonly items: readonly PlanSubscriptionItem[]
  readonly nextCursor: string | null
}

/** One assignment group of a migration request. */
export interface PlanMigrationGroup {
  readonly targetPlanId: string
  readonly subscriptionIds: readonly string[]
}

/**
 * The body of the preview and of the start (§4.2, §4.3), without paging. Each
 * subscription id appears at most once across the groups; `restTargetPlanId`
 * takes every OTHER subscription on the plan, resolved by the server at request
 * time, and is left out entirely when there is no rest assignment.
 */
export interface PlanMigrationRequest {
  readonly groups: readonly PlanMigrationGroup[]
  readonly restTargetPlanId?: string
}

export interface PlanMigrationSnapshot extends PlanMigrationLimits {
  readonly isTrial: boolean
}

export interface PlanMigrationPreviewRow {
  readonly subscriptionId: string
  readonly targetPlanId: string
  /**
   * Who the row is, in the list's shape (§9 A3) — also for the rows the list
   * never loaded, which the "rest" group swept in. `null` for an id that names
   * no subscription.
   */
  readonly user: PlanMigrationUser | null
  readonly before: PlanMigrationSnapshot
  /**
   * For a row the move will skip, `after` equals `before` — and for an id that
   * does not exist at all both are neutral values — so a skipped row has no
   * "было → станет" to show (BE-MOVE, 15.09.2026).
   */
  readonly after: PlanMigrationSnapshot
  /** Fields kept because the operator set them individually: `trafficLimit | deviceLimit | squads`. */
  readonly kept: readonly string[]
  readonly warnings: readonly string[]
  readonly willSkip: string | null
  readonly pushesToRemnawave: boolean
}

export interface PlanMigrationPreviewSummary {
  readonly targetPlanId: string
  /** Every row assigned to this target, the skipped ones INCLUDED (BE-MOVE, 15.09.2026). */
  readonly count: number
  /** How many of `count` the move will skip. Not in §4.2; added by BE-MOVE. */
  readonly skipped: number
  /** Warning code → how many rows of this target carry it — counted on rows that will move only. */
  readonly warnings: Readonly<Record<string, number>>
}

/** `POST /admin/plans/:planId/migrations/preview` (§4.2). */
export interface PlanMigrationPreview {
  /**
   * Per target. Computed for the FIRST page only; later pages send `null`
   * (§9 A3), so the dialog keeps the first page's summary for good.
   */
  readonly summary: readonly PlanMigrationPreviewSummary[] | null
  readonly rows: readonly PlanMigrationPreviewRow[]
  readonly nextCursor: string | null
}

/** `POST /admin/plans/:planId/migrations` → 202 (§4.3). */
export interface PlanMigrationStarted {
  readonly runId: string
  readonly totalItems: number
}

/**
 * `GET /admin/plans/:planId/migrations/current` — NOT in §4; added by BE-MOVE.
 * The plan's QUEUED or RUNNING run, or `null`. The dialog asks it while
 * checking, so a reload or a second operator lands on the running move instead
 * of a list of subscriptions that are moving already, and after a start refused
 * with `MIGRATION_ALREADY_RUNNING`, whose safe-error body names no run.
 */
export interface PlanMigrationCurrent {
  readonly runId: string | null
}

export interface PlanMigrationTotals {
  readonly total: number
  readonly pending: number
  readonly moved: number
  readonly skipped: number
  readonly failed: number
  /**
   * `skipped` split by reason (§9 A2). The only way to tell a harmless skip
   * from one that keeps subscriptions on the plan across ALL items: the
   * problems list is paged, and its first page proves nothing about the rest.
   */
  readonly skippedByReason: Readonly<Record<string, number>>
}

export interface PlanMigrationSyncTotals {
  readonly total: number
  readonly pending: number
  readonly completed: number
  readonly failed: number
}

export interface PlanMigrationProblem {
  readonly subscriptionId: string
  readonly user: PlanMigrationUser | null
  readonly targetPlanId: string
  /** `MOVE_FAILED | MOVE_SKIPPED | SYNC_FAILED` by contract; kept as sent. */
  readonly kind: string
  readonly reason: string
  readonly detail: string | null
}

/** `GET /admin/plans/:planId/migrations/:runId` (§4.4). */
export interface PlanMigrationRunStatus {
  readonly runId: string
  /** `QUEUED | RUNNING | COMPLETED` by contract; kept as sent. */
  readonly status: string
  readonly totals: PlanMigrationTotals
  readonly sync: PlanMigrationSyncTotals
  readonly problems: readonly PlanMigrationProblem[]
  readonly problemsCursor: string | null
  readonly finished: boolean
}

export type PlanMigrationRetryScope = 'failed' | 'sync'

export interface PlanMigrationSquadOption {
  readonly uuid: string
  readonly name: string
}

// ── Readers ─────────────────────────────────────────────────────────────────

const MALFORMED = 'errors.unexpectedResponsePayload'

function malformed(): never {
  throw new Error(MALFORMED)
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) malformed()
  return value
}

function readArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) malformed()
  return value
}

/** An identifier or an enumerated value: a string with something in it. */
function readText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) malformed()
  return value
}

function readNullableString(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') malformed()
  return value
}

function readBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') malformed()
  return value
}

/** A count: a whole number, never negative. */
function readCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) malformed()
  return value
}

function readInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) malformed()
  return value
}

/** `null` or a cursor with something in it — an empty cursor would page forever. */
function readCursor(value: unknown): string | null {
  if (value === null) return null
  return readText(value)
}

function readTextList(value: unknown): readonly string[] {
  return readArray(value).map(readText)
}

function readUser(value: unknown): PlanMigrationUser | null {
  if (value === null) return null
  const user = readRecord(value)
  return {
    id: readText(user.id),
    name: readNullableString(user.name),
    username: readNullableString(user.username),
    telegramId: readNullableString(user.telegramId),
    email: readNullableString(user.email),
  }
}

function readLimits(record: Record<string, unknown>): PlanMigrationLimits {
  return {
    // `null` is unlimited and stays `null`: `readCount` refuses nothing else.
    trafficLimit: record.trafficLimit === null ? null : readCount(record.trafficLimit),
    deviceLimit: readInteger(record.deviceLimit),
    internalSquads: readTextList(record.internalSquads),
    externalSquad: readNullableString(record.externalSquad),
  }
}

function readSnapshot(value: unknown): PlanMigrationSnapshot {
  const record = readRecord(value)
  return { ...readLimits(record), isTrial: readBoolean(record.isTrial) }
}

/**
 * A server-keyed record, rebuilt with `Object.fromEntries` rather than by
 * assignment: `JSON.parse` gives `"__proto__"` as an own key, and assigning it
 * would replace the prototype instead of storing a value.
 */
function readKeyedRecord<T>(value: unknown, readValue: (entry: unknown) => T): Readonly<Record<string, T>> {
  const record = readRecord(value)
  return Object.freeze(
    Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, readValue(entry)])),
  )
}

function readSubscriptionItem(value: unknown): PlanSubscriptionItem {
  const item = readRecord(value)
  const flags = readRecord(item.flags)
  return {
    subscriptionId: readText(item.subscriptionId),
    user: readUser(item.user),
    status: readText(item.status),
    isTrial: readBoolean(item.isTrial),
    expiresAt: readNullableString(item.expiresAt),
    remnawaveLinked: readBoolean(item.remnawaveLinked),
    limits: readLimits(readRecord(item.limits)),
    ownership: readKeyedRecord(item.ownership, readText),
    flags: {
      pendingRenewalForPlan: readBoolean(flags.pendingRenewalForPlan),
      scheduledTermOnPlan: readBoolean(flags.scheduledTermOnPlan),
      sharedPanelProfile: readBoolean(flags.sharedPanelProfile),
    },
  }
}

export function readPlanSubscriptionsPage(body: unknown): PlanSubscriptionsPage {
  const page = readRecord(body)
  return {
    total: readCount(page.total),
    matched: readCount(page.matched),
    items: readArray(page.items).map(readSubscriptionItem),
    nextCursor: readCursor(page.nextCursor),
  }
}

function readPreviewRow(value: unknown): PlanMigrationPreviewRow {
  const row = readRecord(value)
  return {
    subscriptionId: readText(row.subscriptionId),
    targetPlanId: readText(row.targetPlanId),
    user: readUser(row.user),
    before: readSnapshot(row.before),
    after: readSnapshot(row.after),
    kept: readTextList(row.kept),
    warnings: readTextList(row.warnings),
    willSkip: row.willSkip === null ? null : readText(row.willSkip),
    pushesToRemnawave: readBoolean(row.pushesToRemnawave),
  }
}

export function readPlanMigrationPreview(body: unknown): PlanMigrationPreview {
  const preview = readRecord(body)
  return {
    // `null` is a later page (§9 A3) — present and null, never absent.
    summary:
      preview.summary === null
        ? null
        : readArray(preview.summary).map((value): PlanMigrationPreviewSummary => {
            const entry = readRecord(value)
            return {
              targetPlanId: readText(entry.targetPlanId),
              count: readCount(entry.count),
              skipped: readCount(entry.skipped),
              warnings: readKeyedRecord(entry.warnings, readCount),
            }
          }),
    rows: readArray(preview.rows).map(readPreviewRow),
    nextCursor: readCursor(preview.nextCursor),
  }
}

export function readPlanMigrationStarted(body: unknown): PlanMigrationStarted {
  const started = readRecord(body)
  return { runId: readText(started.runId), totalItems: readCount(started.totalItems) }
}

/** `{ runId }` with the key PRESENT: a body without it is not "no run", it is unreadable. */
export function readPlanMigrationCurrent(body: unknown): PlanMigrationCurrent {
  const current = readRecord(body)
  if (!('runId' in current)) malformed()
  return { runId: current.runId === null ? null : readText(current.runId) }
}

export function readPlanMigrationRunStatus(body: unknown): PlanMigrationRunStatus {
  const run = readRecord(body)
  const totals = readRecord(run.totals)
  const sync = readRecord(run.sync)
  return {
    runId: readText(run.runId),
    status: readText(run.status),
    totals: {
      total: readCount(totals.total),
      pending: readCount(totals.pending),
      moved: readCount(totals.moved),
      skipped: readCount(totals.skipped),
      failed: readCount(totals.failed),
      skippedByReason: readKeyedRecord(totals.skippedByReason, readCount),
    },
    sync: {
      total: readCount(sync.total),
      pending: readCount(sync.pending),
      completed: readCount(sync.completed),
      failed: readCount(sync.failed),
    },
    problems: readArray(run.problems).map((value): PlanMigrationProblem => {
      const problem = readRecord(value)
      return {
        subscriptionId: readText(problem.subscriptionId),
        user: readUser(problem.user),
        targetPlanId: readText(problem.targetPlanId),
        kind: readText(problem.kind),
        reason: readText(problem.reason),
        detail: readNullableString(problem.detail),
      }
    }),
    problemsCursor: readCursor(run.problemsCursor),
    finished: readBoolean(run.finished),
  }
}

export function readPlanMigrationRetry(body: unknown): { readonly runId: string } {
  return { runId: readText(readRecord(body).runId) }
}

export function readSquadOptions(body: unknown): readonly PlanMigrationSquadOption[] {
  // `Array.isArray` HERE, not only inside `readArray`: `api-array-contract.test.ts`
  // follows validation one hop from the fetcher, and `readArray` is a second hop.
  if (!Array.isArray(body)) malformed()
  return body.map((value) => {
    const option = readRecord(value)
    return { uuid: readText(option.uuid), name: readText(option.name) }
  })
}

// ── Query keys ──────────────────────────────────────────────────────────────

/**
 * DELIBERATELY NOT under `plansQueryKeys.all` (`['admin', 'plans']`) — see the
 * module comment. `plan-migration-api.test.ts` pins that no key here starts
 * with that root.
 */
export const planMigrationQueryKeys = {
  subscriptionsOfPlan: (planId: string) => ['admin', 'plan-migration', planId, 'subscriptions'] as const,
  subscriptions: (planId: string, search: string) =>
    [...planMigrationQueryKeys.subscriptionsOfPlan(planId), search] as const,
  preview: (planId: string, requestKey: string) =>
    ['admin', 'plan-migration', planId, 'preview', requestKey] as const,
  run: (planId: string, runId: string) => ['admin', 'plan-migration', planId, 'run', runId] as const,
  current: (planId: string) => ['admin', 'plan-migration', planId, 'current'] as const,
  squadOptions: (kind: 'internal' | 'external') => ['admin', 'plan-migration-squads', kind] as const,
}

// ── Fetchers ────────────────────────────────────────────────────────────────

/** The page size of the subscriptions list; the dialog's first request asks for exactly this. */
export const PLAN_SUBSCRIPTIONS_PAGE_SIZE = 50
export const PLAN_MIGRATION_PREVIEW_PAGE_SIZE = 50

/**
 * The timeout of the preview, the start and the retry (§9 A6.2), in place of the
 * client-wide 30 s — the same 120 s the server's request-timeout middleware
 * gives these three routes. The preview and the start resolve every subscription
 * on the plan, and a start also writes a run with an item per subscription; on a
 * large plan that outlasts 30 s, and a start or a retry the client gave up on
 * can still COMMIT — the move then runs while the dialog says it could not be
 * started. So a start that times out is followed by asking for the current run,
 * and a retry that fails in any way by reading the run again (see the dialog).
 */
export const PLAN_MIGRATION_WRITE_TIMEOUT_MS = 120_000

/**
 * The timeout of the lookups the dialog makes as it opens — the first page of
 * subscriptions and the move already running — like the references' 10 s next
 * door (`plans-api.ts`). Delete waits for them, and a lookup that cannot be had
 * lets the dialog fall back to deleting without a move, so a slow one must not
 * hold the button for the client-wide thirty seconds.
 */
export const PLAN_MIGRATION_LOOKUP_TIMEOUT_MS = 10_000

const planPath = (planId: string): string => `/admin/plans/${encodeURIComponent(planId)}`

export async function fetchPlanSubscriptionsPage(
  planId: string,
  page: {
    readonly search?: string
    readonly cursor?: string | null
    readonly limit?: number
    /** Omitted: the client-wide timeout. */
    readonly timeout?: number
  },
  signal?: AbortSignal,
): Promise<PlanSubscriptionsPage> {
  // Only the parameters that carry something: the DTO forbids unknown ones,
  // and an empty `search=` or `cursor=` is a value, not an absence.
  const params: Record<string, string | number> = { limit: page.limit ?? PLAN_SUBSCRIPTIONS_PAGE_SIZE }
  if (page.search !== undefined && page.search.length > 0) params.search = page.search
  if (page.cursor !== undefined && page.cursor !== null) params.cursor = page.cursor
  const response = await api.get(`${planPath(planId)}/subscriptions`, {
    params,
    signal,
    ...(page.timeout === undefined ? {} : { timeout: page.timeout }),
  })
  return readPlanSubscriptionsPage(response.data)
}

export async function previewPlanMigration(
  planId: string,
  request: PlanMigrationRequest,
  page: { readonly cursor: string | null; readonly limit: number },
  signal?: AbortSignal,
): Promise<PlanMigrationPreview> {
  const body = page.cursor === null ? { ...request, limit: page.limit } : { ...request, cursor: page.cursor, limit: page.limit }
  const response = await api.post(`${planPath(planId)}/migrations/preview`, body, {
    signal,
    timeout: PLAN_MIGRATION_WRITE_TIMEOUT_MS,
  })
  return readPlanMigrationPreview(response.data)
}

export async function startPlanMigration(
  planId: string,
  request: PlanMigrationRequest,
): Promise<PlanMigrationStarted> {
  const response = await api.post(`${planPath(planId)}/migrations`, request, {
    timeout: PLAN_MIGRATION_WRITE_TIMEOUT_MS,
  })
  return readPlanMigrationStarted(response.data)
}

/**
 * `timeout` omitted is the client-wide one: after a start that got no verdict,
 * the answer decides between following a move and saying it did not start, and
 * is worth waiting for.
 */
export async function fetchPlanMigrationCurrent(
  planId: string,
  signal?: AbortSignal,
  timeout?: number,
): Promise<PlanMigrationCurrent> {
  const response = await api.get(`${planPath(planId)}/migrations/current`, {
    signal,
    ...(timeout === undefined ? {} : { timeout }),
  })
  return readPlanMigrationCurrent(response.data)
}

export async function fetchPlanMigrationRunStatus(
  planId: string,
  runId: string,
  page: { readonly problemsCursor?: string | null },
  signal?: AbortSignal,
): Promise<PlanMigrationRunStatus> {
  const params =
    page.problemsCursor === undefined || page.problemsCursor === null
      ? undefined
      : { problemsCursor: page.problemsCursor }
  const response = await api.get(`${planPath(planId)}/migrations/${encodeURIComponent(runId)}`, {
    params,
    signal,
  })
  return readPlanMigrationRunStatus(response.data)
}

export async function retryPlanMigration(
  planId: string,
  runId: string,
  scope: PlanMigrationRetryScope,
): Promise<{ readonly runId: string }> {
  const response = await api.post(
    `${planPath(planId)}/migrations/${encodeURIComponent(runId)}/retry`,
    { scope },
    { timeout: PLAN_MIGRATION_WRITE_TIMEOUT_MS },
  )
  return readPlanMigrationRetry(response.data)
}

export async function fetchSquadOptions(
  kind: 'internal' | 'external',
  signal?: AbortSignal,
): Promise<readonly PlanMigrationSquadOption[]> {
  const response = await api.get(`/admin/plans/options/${kind}-squads`, { signal })
  return readSquadOptions(response.data)
}

// ── Hooks ───────────────────────────────────────────────────────────────────

/**
 * The subscriptions on a plan, page by page. No cache (`gcTime: 0`), for the
 * reason `usePlanReferences` has none: these rows sit right above a destructive
 * button, and a copy from the last opening would render instantly and then
 * change under the operator's cursor.
 *
 * `placeholderData` keeps the previous search's rows on screen while the next
 * search is asked, so typing does not blank the list on every keystroke — for
 * a SEARCH only. The unsearched list is reset to read what is still on the plan
 * after a move («Выбрать другой тариф для оставшихся»), and a placeholder there
 * would put the subscriptions that already moved back on screen.
 */
export function usePlanSubscriptions(planId: string, search: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: planMigrationQueryKeys.subscriptions(planId, search),
    queryFn: ({ pageParam, signal }) =>
      fetchPlanSubscriptionsPage(
        planId,
        {
          search,
          cursor: pageParam,
          limit: PLAN_SUBSCRIPTIONS_PAGE_SIZE,
          // The unsearched first page is what Delete waits for as the dialog opens.
          timeout: pageParam === null && search.length === 0 ? PLAN_MIGRATION_LOOKUP_TIMEOUT_MS : undefined,
        },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last: PlanSubscriptionsPage) => last.nextCursor,
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    placeholderData: search.length > 0 ? keepPreviousData : undefined,
  })
}

/**
 * The move already under way for a plan, read once while the dialog checks.
 * No cache, and no refetch on reconnect: an answer arriving later would pull
 * the operator out of whatever step they have moved on to.
 */
export function usePlanMigrationCurrent(planId: string, enabled: boolean) {
  return useQuery({
    queryKey: planMigrationQueryKeys.current(planId),
    queryFn: ({ signal }) => fetchPlanMigrationCurrent(planId, signal, PLAN_MIGRATION_LOOKUP_TIMEOUT_MS),
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnReconnect: false,
  })
}

/** The dry run of one request, page by page. `null` disables it. */
export function usePlanMigrationPreview(planId: string, request: PlanMigrationRequest | null) {
  return useInfiniteQuery({
    queryKey: planMigrationQueryKeys.preview(planId, request === null ? '' : JSON.stringify(request)),
    queryFn: ({ pageParam, signal }) =>
      previewPlanMigration(
        planId,
        request as PlanMigrationRequest,
        { cursor: pageParam, limit: PLAN_MIGRATION_PREVIEW_PAGE_SIZE },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last: PlanMigrationPreview) => last.nextCursor,
    enabled: request !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })
}

/**
 * Follows one run. Polls every {@link PLAN_MIGRATION_POLL_MS} until the run is
 * settled, then stops by itself — see `shouldPollMigrationRun` for the retry
 * window that keeps it going a little longer after a retry. `null` disables it.
 */
export function usePlanMigrationRun(planId: string, runId: string | null, retryRequestedAt: number | null) {
  return useQuery({
    queryKey: planMigrationQueryKeys.run(planId, runId ?? ''),
    queryFn: ({ signal }) => fetchPlanMigrationRunStatus(planId, runId as string, {}, signal),
    enabled: runId !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: (query) =>
      shouldPollMigrationRun(
        query.state.data,
        query.state.dataUpdatedAt,
        retryRequestedAt,
        PLAN_MIGRATION_RETRY_ECHO_MS,
      )
        ? PLAN_MIGRATION_POLL_MS
        : false,
  })
}

/**
 * Squad uuid → name, from the plans module's own option routes. A failure is
 * not an error the preview shows: an unnamed squad prints its short id.
 */
export function useMigrationSquadNames(enabled: boolean): ReadonlyMap<string, string> {
  const internal = useQuery({
    queryKey: planMigrationQueryKeys.squadOptions('internal'),
    queryFn: ({ signal }) => fetchSquadOptions('internal', signal),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  })
  const external = useQuery({
    queryKey: planMigrationQueryKeys.squadOptions('external'),
    queryFn: ({ signal }) => fetchSquadOptions('external', signal),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  })
  return useMemo(
    () =>
      new Map(
        [...(internal.data ?? []), ...(external.data ?? [])].map((option) => [option.uuid, option.name] as const),
      ),
    [internal.data, external.data],
  )
}
