/**
 * `POST /admin/profile-sync/panel-link-reconciliation` — the wire boundary.
 * ────────────────────────────────────────────────────────────────────────
 * Mirrors `PanelLinkReconciliationReport` in
 * `src/modules/profile-sync/panel-link-reconciliation.service.ts`.
 *
 * TWO THINGS THIS MODULE EXISTS TO GUARANTEE, both of which have bitten this
 * repository before:
 *
 * 1. `dryRun` LEAVES AS A BOOLEAN. The endpoint writes only on the literal
 *    `false` (`body.dryRun !== false`), which means every OTHER spelling of
 *    "no" — the string `'false'`, `0`, `'0'` — previews instead of writing.
 *    That is the safe direction, and it is not the direction that hurts: the
 *    dangerous one is a `true` that arrives as something the backend reads as
 *    "not false". `?flag=false` coercing to `true` is a documented defect
 *    class here, and the two request shapes that produce it — a query string
 *    and a `FormData`/`URLSearchParams` body — both stringify silently. So
 *    the body is built as an object of real primitives, handed to axios as
 *    JSON, and `panel-link-reconciliation-panel.test.tsx` pins the runtime
 *    TYPE of every field, not just its value.
 *
 * 2. THE ARRAYS ARE CHECKED, NOT ASSERTED. `api.post<T>()` is a cast; axios
 *    verifies nothing. An HTML error page served with HTTP 200 (which
 *    `web/nginx.conf` really does produce for an unmatched `/api` path) is a
 *    string with a working `.length`, so it walks past every emptiness guard
 *    in the panel and dies at the first `.map` INSIDE render — replacing the
 *    whole route with the generic error card. `expectArray` from
 *    `@/lib/api-utils` is the sanctioned check and is applied to both arrays.
 *
 * FIELDS READ DEFENSIVELY, AND WHY THEY STAY THAT WAY. The `staleIdentity` /
 * `duplicatePair` outcomes, `storedRemnawaveId`, `duplicateOfSubscriptionId`,
 * `holdsLiveIdentity`, `staleIdentityScanned`, `duplicatePairs` and `panelEra`
 * were added to the backend report alongside this surface, so a panel build can
 * meet a backend that predates any of them — the SPA and the API are deployed
 * as separate images. Every one is therefore read as possibly-absent, and the
 * two new COUNTERS plus `holdsLiveIdentity` normalise to `null` rather than to
 * `0` / `false`: a zero for a number the server never sent, or a "not bound"
 * for a flag it never set, is a confident false statement — and confident false
 * statements are the whole reason this endpoint exists.
 *
 * `panelEra` carries `'2.x'`, `'3.x'` or `null` (`PANEL_ERA_2X` / `PANEL_ERA_3X`
 * in the service). `'unknown'` is folded into `null` as well, because that is
 * the string `getPanelShape()` produces for an unreadable panel and it means
 * exactly what an absent field means here.
 */
import { api } from '@/lib/api'
import { expectArray, isRecord } from '@/lib/api-utils'

export const PANEL_LINK_RECONCILIATION_PATH = '/admin/profile-sync/panel-link-reconciliation'

/** Mirrors `PANEL_LINK_RECONCILIATION_*` in the service. */
export const PANEL_LINK_RECONCILIATION_DEFAULT_LIMIT = 200
export const PANEL_LINK_RECONCILIATION_MAX_LIMIT = 1000
export const PANEL_LINK_RECONCILIATION_DEFAULT_CHUNK = 25
export const PANEL_LINK_RECONCILIATION_MAX_CHUNK = 100

/**
 * Every outcome this build knows how to label, in the order the report shows
 * them: the two repairable ones first, then the failures roughly by how much
 * operator work each implies.
 *
 * An outcome NOT on this list still renders — see `outcomeRank`. Dropping an
 * unrecognised row would be the exact silence this sweep was built to repair.
 */
export const PANEL_LINK_OUTCOMES = [
  'linked',
  'wouldLink',
  'duplicatePair',
  'conflict',
  'staleIdentity',
  'notOwned',
  'unresolved',
  'raceLost',
] as const

export type PanelLinkReconciliationOutcome = (typeof PANEL_LINK_OUTCOMES)[number]

/**
 * The only two eras {@link PanelLinkReconciliationReport.panelEra} ever names
 * (`PANEL_ERA_2X` / `PANEL_ERA_3X` in the service). Anything else — including
 * `null` and the `'unknown'` `getPanelShape()` produces for a panel it could
 * not read — means the sweep REFUSED TO GUESS, which is a third state and not
 * a smaller number of repairs.
 */
export const PANEL_ERA_2X = '2.x'
export const PANEL_ERA_3X = '3.x'

/**
 * The routes {@link PanelLinkReconciliationRow.resolvedBy} names on the wire —
 * `'shortUuid' | 'username' | 'storedIdentity'` in the service.
 *
 * `storedIdentity` is NOT a third resolve, and an operator who reads it as one
 * reaches for the wrong action. It says the panel was never asked, because
 * both rows ALREADY store the same well-formed identity — so both halves of
 * that pair are live on the same real profile and neither is the broken one.
 * The other two routes always leave exactly one half bound.
 *
 * Named constants rather than repeated literals because the panel now branches
 * on this value in two places (the column label and the danger notice), and a
 * misspelling in either would fall silently through to the raw-value path.
 * `resolvedBy` itself stays typed as `string`: a fourth route added
 * server-side must still reach the screen under its own name.
 */
export const PANEL_LINK_RESOLVED_BY_SHORT_UUID = 'shortUuid'
export const PANEL_LINK_RESOLVED_BY_USERNAME = 'username'
export const PANEL_LINK_RESOLVED_BY_STORED_IDENTITY = 'storedIdentity'

const KNOWN_OUTCOMES: ReadonlySet<string> = new Set<string>(PANEL_LINK_OUTCOMES)

export function isKnownOutcome(outcome: string): outcome is PanelLinkReconciliationOutcome {
  return KNOWN_OUTCOMES.has(outcome)
}

/**
 * Sort key for grouping. Known outcomes keep the declared order; anything the
 * backend grows later sorts after them instead of disappearing.
 */
export function outcomeRank(outcome: string): number {
  const at = (PANEL_LINK_OUTCOMES as readonly string[]).indexOf(outcome)
  return at === -1 ? PANEL_LINK_OUTCOMES.length : at
}

export interface PanelLinkReconciliationRow {
  readonly subscriptionId: string
  readonly userId: string
  readonly panelUsername: string
  /** One of `PANEL_LINK_RESOLVED_BY_*`; kept open so a fourth route renders. */
  readonly resolvedBy: string
  /** Kept as a string: an outcome added server-side must still reach the screen. */
  readonly outcome: string
  /** The identity that was (or would be) written. */
  readonly remnawaveId: string | null
  /** What the row holds RIGHT NOW — the dead identity. `null` when it holds none. */
  readonly storedRemnawaveId: string | null
  readonly panelId: number | null
  /** The other subscription on the same panel profile, when there is one. */
  readonly duplicateOfSubscriptionId: string | null
  /**
   * Whether THIS row is bound to the live panel profile as the report leaves
   * the database — `null` when the server did not say.
   *
   * THE POLARITY IS BACKWARDS FROM INSTINCT, which is why the server states it
   * as a field instead of leaving it to be inferred: in the pair a broken link
   * produced, the OLDER row carrying the customer's history stores a dead 2.x
   * uuid and is bound to nothing, while the NEWER, wrong-looking duplicate is
   * the one actually pointing at the live profile. An operator who tidies up
   * the wrong-looking card issues a panel DELETE against a paying customer.
   *
   * AND ON A SHARED-IDENTITY PAIR IT IS `true` ON BOTH HALVES. Those rows
   * (`resolvedBy === PANEL_LINK_RESOLVED_BY_STORED_IDENTITY`) already store the
   * same well-formed identity, so there is no unbound half at all. Nothing on
   * this surface may read one half's `true` as the other half's `false`, and no
   * copy may tell the operator to go and find the unbound one.
   *
   * `null` rather than `false` when absent, for the same reason: guessing
   * "not bound" for a row that IS bound points at the dangerous action.
   */
  readonly holdsLiveIdentity: boolean | null
  readonly reason: string | null
}

export interface PanelLinkReconciliationReport {
  readonly dryRun: boolean
  readonly scanned: number
  readonly linked: number
  readonly wouldLink: number
  readonly repaired: readonly PanelLinkReconciliationRow[]
  readonly unrepaired: readonly PanelLinkReconciliationRow[]
  readonly hasMore: boolean
  readonly nextCursor: string | null
  /** `null` when the server did not report it — NOT the same as zero. */
  readonly staleIdentityScanned: number | null
  readonly duplicatePairs: number | null
  /**
   * How many of {@link duplicatePairs} came from the SHARED-IDENTITY arm — the
   * pairs where both rows already store the same well-formed identity and BOTH
   * halves are therefore bound to the live profile.
   *
   * Reported separately because the two populations need opposite advice. In a
   * resolve-route pair exactly one half is bound and the operator's job is to
   * find it; here there is no unbound half to find, and any instruction to
   * look for one points at a panel DELETE. `null` rather than `0` when absent,
   * for the same reason every counter on this report is: a zero invented for a
   * backend that predates the arm would say "none of that kind", which is the
   * one answer that makes the danger invisible.
   */
  readonly sharedIdentityPairs: number | null
  /** `null` when the sweep could not tell which era of the panel API answered. */
  readonly panelEra: string | null
}

export interface PanelLinkReconciliationRequest {
  /**
   * `false` writes. Required rather than optional so no call site can reach
   * the endpoint without having decided, and so the decision is visible in
   * every caller and every test.
   */
  readonly dryRun: boolean
  readonly limit?: number
  readonly chunkSize?: number
  readonly startAfterId?: string
}

/** The body as it goes on the wire. Booleans stay booleans, numbers numbers. */
interface PanelLinkReconciliationBody {
  dryRun: boolean
  limit?: number
  chunkSize?: number
  startAfterId?: string
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** A flag the server may not have sent. Absent stays absent — never `false`. */
function readFlag(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Absent / unusable counters read as 0 where a total is required. */
function readCount(value: unknown): number {
  return readNumber(value) ?? 0
}

function readRow(value: unknown): PanelLinkReconciliationRow {
  const row = isRecord(value) ? value : {}
  return {
    subscriptionId: readString(row.subscriptionId) ?? '',
    userId: readString(row.userId) ?? '',
    panelUsername: readString(row.panelUsername) ?? '',
    resolvedBy: readString(row.resolvedBy) ?? '',
    outcome: readString(row.outcome) ?? '',
    remnawaveId: readString(row.remnawaveId),
    storedRemnawaveId: readString(row.storedRemnawaveId),
    panelId: readNumber(row.panelId),
    duplicateOfSubscriptionId: readString(row.duplicateOfSubscriptionId),
    holdsLiveIdentity: readFlag(row.holdsLiveIdentity),
    reason: readString(row.reason),
  }
}

/**
 * `'unknown'` is a value `getPanelShape()` really produces for a panel whose
 * version could not be read, and it means precisely what an ABSENT field means
 * here. Both collapse to `null` so the surface has one "we do not know" branch
 * rather than two that can drift apart.
 */
function readPanelEra(value: unknown): string | null {
  const era = readString(value)
  return era === null || era === 'unknown' ? null : era
}

export function normalizePanelLinkReconciliationReport(
  payload: unknown,
  requested: PanelLinkReconciliationRequest,
): PanelLinkReconciliationReport {
  const record = isRecord(payload) ? payload : {}
  // Both arrays go through the sanctioned check rather than a cast: an object,
  // a `{ data: [...] }` envelope or an HTML page all reach this line typed as
  // an array and would otherwise throw inside render instead of here.
  const repaired = expectArray<unknown>(record.repaired).map(readRow)
  const unrepaired = expectArray<unknown>(record.unrepaired).map(readRow)
  return {
    // The server echoes the mode back; when it does not, the mode is the one
    // this caller ASKED for. Never optimistically "dry".
    dryRun: typeof record.dryRun === 'boolean' ? record.dryRun : requested.dryRun !== false,
    scanned: readCount(record.scanned),
    linked: readCount(record.linked),
    wouldLink: readCount(record.wouldLink),
    repaired,
    unrepaired,
    hasMore: record.hasMore === true,
    nextCursor: readString(record.nextCursor),
    staleIdentityScanned: readNumber(record.staleIdentityScanned),
    duplicatePairs: readNumber(record.duplicatePairs),
    sharedIdentityPairs: readNumber(record.sharedIdentityPairs),
    panelEra: readPanelEra(record.panelEra),
  }
}

/**
 * Runs one page of the sweep.
 *
 * `limit` / `chunkSize` are dropped rather than coerced when they are not
 * finite numbers: the controller reads them as `typeof … === 'number' ? … :
 * undefined`, so a stringified bound is SILENTLY replaced by the server
 * default — an operator who asked for 50 rows would get 200 and be told
 * nothing. Omitting the field produces the same server default and is honest
 * about it.
 */
export async function runPanelLinkReconciliation(
  request: PanelLinkReconciliationRequest,
): Promise<PanelLinkReconciliationReport> {
  const body: PanelLinkReconciliationBody = {
    // Not `request.dryRun`, not `String(...)`, not `!!`: an explicit boolean
    // literal on both branches, so no value from a form can reach the wire.
    dryRun: request.dryRun === false ? false : true,
  }
  if (typeof request.limit === 'number' && Number.isFinite(request.limit)) {
    body.limit = Math.floor(request.limit)
  }
  if (typeof request.chunkSize === 'number' && Number.isFinite(request.chunkSize)) {
    body.chunkSize = Math.floor(request.chunkSize)
  }
  if (typeof request.startAfterId === 'string' && request.startAfterId.length > 0) {
    body.startAfterId = request.startAfterId
  }

  const response = await api.post<unknown>(PANEL_LINK_RECONCILIATION_PATH, body)
  return normalizePanelLinkReconciliationReport(response.data, request)
}
