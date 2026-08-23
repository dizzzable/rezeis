/**
 * `POST /admin/profile-sync/duplicate-subscription-merge` — the wire boundary.
 * ──────────────────────────────────────────────────────────────────────────
 * Mirrors `DuplicateMergeReport` in
 * `src/modules/profile-sync/duplicate-subscription-merge.service.ts`.
 *
 * This is the most consequential write the panel can ask for: a merge retires
 * one subscription row and moves the customer's payments, receipt lines,
 * promocode activations, referral spends and trial claim onto the other one.
 * Three guarantees live here rather than in the component, because each of them
 * is the kind that fails silently.
 *
 * 1. `dryRun` LEAVES AS A BOOLEAN. The controller writes only on the literal
 *    `false` (`body.dryRun !== false`), so every other spelling of "no" — the
 *    string `'false'`, `0`, `'0'` — previews. That direction is safe. The
 *    direction that hurts is a `true` arriving as something the backend reads
 *    as "not false", and `?flag=false` coercing to `true` is a documented
 *    defect class in this repository: both request shapes that produce it (a
 *    query string and a `FormData`/`URLSearchParams` body) stringify silently.
 *    So the body is an object of real primitives handed to axios as JSON, and
 *    `duplicate-subscription-merge-panel.test.tsx` pins the runtime TYPE of the
 *    flag, not only its value.
 *
 * 2. THE ARRAYS ARE CHECKED, NOT ASSERTED. `api.post<T>()` is a cast; axios
 *    verifies nothing. An HTML error page served with HTTP 200 — which
 *    `web/nginx.conf` really produces for an unmatched `/api` path — is a
 *    string with a working `.length`, so it walks past every emptiness guard
 *    and dies at the first `.map` INSIDE render, replacing the whole route with
 *    the generic error card. `expectArray` from `@/lib/api-utils` is the
 *    sanctioned check and is applied to `rows` and to each row's `reattached`.
 *
 * 3. `pairs` IS NEVER SENT. The endpoint accepts an explicit pair list, and
 *    supplying one is a CLAIM about which half survives — the service refuses a
 *    nomination that has the polarity of this defect backwards. Discovery makes
 *    no such claim: it names two ids and lets the service derive the survivor
 *    from `createdAt`. A surface that let an operator type two ids would be a
 *    surface on which they can nominate the wrong survivor, so this one does
 *    not have one. Batch discovery only.
 *
 * WHAT IS READ DEFENSIVELY, AND WHY. The SPA and the API deploy as separate
 * images, so a panel build can meet a backend that predates any field here.
 * Counters, `reattached` and the two `holdsLiveIdentity` flags therefore
 * normalise to `null` rather than to `0` / `[]` / `false`: a zero invented for
 * a number nobody sent, "nothing moved" for an audit trail the server never
 * wrote, or "not bound to the live profile" for a flag an older backend does
 * not ship, is a confident false statement — and confident false statements
 * about which rows a merge touched are the whole reason this endpoint is behind
 * a dry run.
 */
import { api } from '@/lib/api'
import { expectArray, isRecord } from '@/lib/api-utils'

export const DUPLICATE_SUBSCRIPTION_MERGE_PATH =
  '/admin/profile-sync/duplicate-subscription-merge'

/** Mirrors `DUPLICATE_MERGE_DEFAULT_LIMIT` / `_MAX_LIMIT` in the service. */
export const DUPLICATE_MERGE_DEFAULT_LIMIT = 25
export const DUPLICATE_MERGE_MAX_LIMIT = 200

/**
 * Every outcome one pair can have. `merged` and `wouldMerge` are the same
 * verdict under the two modes; `refused` always carries a named refusal.
 */
export const DUPLICATE_MERGE_OUTCOMES = ['merged', 'wouldMerge', 'refused'] as const

export type DuplicateMergeOutcome = (typeof DUPLICATE_MERGE_OUTCOMES)[number]

/**
 * WHETHER PRESSING IT AGAIN CAN EVER CHANGE THE ANSWER.
 *
 * This is the classification the operator actually needs, and it is not the
 * same question as "what went wrong". A batch of refusals mixes an outage that
 * clears by itself with two rows that belong to two different customers, and an
 * operator who cannot tell them apart re-runs the whole batch forever — or,
 * worse, reads "refused" as "the tool is broken" and goes back to fixing
 * duplicates by hand in the database, which is the practice this endpoint
 * exists to end.
 *
 *   `retryable`  the pair is fine and the WORLD was briefly not: the panel did
 *                not answer, a sync job was mid-flight, another writer got
 *                there first. Nothing is wrong with the data. Run it again.
 *   `blocked`    the pair may well be a real pair, but something else has to
 *                happen first — repair the link, resolve entitlement history by
 *                hand, settle the trial ledger. Running it again unchanged
 *                returns the same refusal.
 *   `never`      these two rows are NOT the pair this defect produces. Two
 *                customers, two panel profiles, somebody else's profile, a row
 *                that does not exist, a row already retired. No amount of
 *                re-running turns them into a pair, and merging them anyway
 *                would move one customer's payment history onto another.
 *
 * A refusal this build has never heard of is deliberately NOT bucketed — see
 * {@link refusalClass}.
 */
export type DuplicateMergeRetryClass = 'retryable' | 'blocked' | 'never'

/**
 * The refusals, grouped by that classification. Every code in
 * `DuplicateMergeRefusal` (the service's own union) appears exactly once, and
 * `duplicate-subscription-merge-panel.test.tsx` compares this table against the
 * backend's union so a code added or renamed there fails a test by name instead
 * of quietly falling into the unknown bucket.
 */
export const DUPLICATE_MERGE_REFUSALS_RETRYABLE = [
  /** The panel would not resolve one half's own route. It may next time. */
  'survivorUnresolved',
  'duplicateUnresolved',
  /** The profile resolved but could not be read back — panel down, bad body. */
  'profileUnreadable',
  /** A sync job for the duplicate is RUNNING. Re-run once it finishes. */
  'syncJobRunning',
  /** Something moved under the merge; the transaction rolled back cleanly. */
  'raceLost',
] as const

export const DUPLICATE_MERGE_REFUSALS_BLOCKED = [
  /** Neither row is bound to the profile they resolve to. Repair the link first. */
  'neitherHoldsIdentity',
  /** The duplicate carries entitlement-lifecycle history that cannot be re-parented. */
  'entitlementHistoryOnDuplicate',
  /** Both hold a trial claim and the column is UNIQUE. The ledger decides, not the merge. */
  'trialClaimOnBoth',
  /** The nominated survivor is not the older row, or both were created at one instant. */
  'survivorNotOlder',
  /** The same id was handed in as both halves. */
  'sameSubscription',
] as const

export const DUPLICATE_MERGE_REFUSALS_NEVER = [
  /** Two rows of two customers are never a pair. */
  'differentCustomers',
  /** Two different panel profiles means two real subscriptions. */
  'differentPanelProfiles',
  /** The profile carries somebody else's ownership marker. */
  'notOwned',
  'survivorMissing',
  'duplicateMissing',
  /** One half is already DELETED, so this is not two live rows. */
  'alreadyRetired',
] as const

/**
 * Display order: the pairs that must NEVER be merged first, because they are
 * the ones an operator has to read rather than skim; then the ones waiting on
 * work; then the ones to simply press again.
 */
export const DUPLICATE_MERGE_REFUSALS = [
  ...DUPLICATE_MERGE_REFUSALS_NEVER,
  ...DUPLICATE_MERGE_REFUSALS_BLOCKED,
  ...DUPLICATE_MERGE_REFUSALS_RETRYABLE,
] as const

export type DuplicateMergeRefusal = (typeof DUPLICATE_MERGE_REFUSALS)[number]

const REFUSAL_CLASS: ReadonlyMap<string, DuplicateMergeRetryClass> = new Map<
  string,
  DuplicateMergeRetryClass
>([
  ...DUPLICATE_MERGE_REFUSALS_NEVER.map(
    (code) => [code, 'never'] as [string, DuplicateMergeRetryClass],
  ),
  ...DUPLICATE_MERGE_REFUSALS_BLOCKED.map(
    (code) => [code, 'blocked'] as [string, DuplicateMergeRetryClass],
  ),
  ...DUPLICATE_MERGE_REFUSALS_RETRYABLE.map(
    (code) => [code, 'retryable'] as [string, DuplicateMergeRetryClass],
  ),
])

const KNOWN_REFUSALS: ReadonlySet<string> = new Set<string>(DUPLICATE_MERGE_REFUSALS)

export function isKnownRefusal(refusal: string): refusal is DuplicateMergeRefusal {
  return KNOWN_REFUSALS.has(refusal)
}

/**
 * Which bucket a refusal is in, or `null` when this build does not recognise
 * it.
 *
 * `null` IS THE POINT, and it must not be quietly folded into any of the three.
 * Calling an unknown refusal `retryable` invites the operator to press a button
 * that may be refusing for a reason nothing can fix; calling it `never` tells
 * them to give up on a pair that a retry would have merged. So an unrecognised
 * refusal renders under its own raw name, says out loud that this build does
 * not know it, and offers no verdict on retrying at all.
 */
export function refusalClass(refusal: string): DuplicateMergeRetryClass | null {
  return REFUSAL_CLASS.get(refusal) ?? null
}

/** Sort key for grouping. Anything the backend grows later sorts last. */
export function refusalRank(refusal: string): number {
  const at = (DUPLICATE_MERGE_REFUSALS as readonly string[]).indexOf(refusal)
  return at === -1 ? DUPLICATE_MERGE_REFUSALS.length : at
}

/** One relation on `Subscription`, and how many of its rows moved (or would). */
export interface DuplicateMergeReattachment {
  /** The Prisma relation name, e.g. `transactions`. Kept open: a new one must render. */
  readonly relation: string
  readonly model: string
  readonly column: string
  readonly moved: number
}

export interface DuplicateMergeRow {
  /** The OLDER row. It survives and keeps the customer's history. */
  readonly survivorSubscriptionId: string
  /** The NEWER row the importer minted. It is retired. */
  readonly duplicateSubscriptionId: string
  readonly userId: string | null
  /** Kept as a string: an outcome added server-side must still reach the screen. */
  readonly outcome: string
  readonly refusal: string | null
  readonly reason: string | null
  /** The live panel identity that moved (or would move) onto the survivor. */
  readonly remnawaveId: string | null
  readonly remnawavePanelId: number | null
  readonly panelUsername: string | null
  readonly configUrl: string | null
  /** What each half held BEFORE the merge. These two are the undo. */
  readonly survivorPreviousRemnawaveId: string | null
  readonly survivorPreviousPanelId: number | null
  readonly duplicatePreviousRemnawaveId: string | null
  readonly duplicatePreviousPanelId: number | null
  /**
   * WHICH HALF IS BOUND TO THE LIVE PANEL PROFILE — stated by the server, one
   * flag per half, as of the verification that produced the row (the same
   * instant the four `previous` fields above describe).
   *
   * THIS USED TO BE DERIVED HERE, from those four fields, and that derivation
   * was a second copy of the service's `namesProfile` — including its
   * two-spellings rule, where one panel profile has two legitimate local
   * spellings (a numeric id may sit in `remnawaveId` as a decimal STRING, or
   * in `remnawavePanelId`). The service's own docblock says misreading the
   * polarity of that rule is how an operator issues a panel DELETE against a
   * paying customer, and a rule with two implementations in two repositories is
   * a rule that will eventually be true in only one of them. The server now
   * calls `namesProfile` and reports the answer; this file reads it.
   *
   * `null` when the server did not say — an older backend that predates the
   * field, or a pair refused before the panel was ever asked. NEVER `false`:
   * "not bound" is the sentence that points an operator at the destructive
   * action, and inventing it for an answer nobody gave is the exact
   * confident-false-statement failure this surface exists to prevent.
   */
  readonly survivorHoldsLiveIdentity: boolean | null
  readonly duplicateHoldsLiveIdentity: boolean | null
  /**
   * Every relation that moved, or would move, with its count — `null` when the
   * server did not report the field at all.
   *
   * NEVER `[]` FOR AN ABSENT FIELD. An empty list renders as "nothing
   * referenced the duplicate", which is a statement about a customer's payment
   * history; making it for a backend that simply never sent the audit trail is
   * the exact confident-false-statement failure this surface exists to avoid.
   */
  readonly reattached: readonly DuplicateMergeReattachment[] | null
  /** Non-terminal sync jobs of the duplicate that were (or would be) superseded. */
  readonly supersededSyncJobs: number | null
}

export interface DuplicateMergeReport {
  readonly dryRun: boolean
  readonly pairsExamined: number
  readonly merged: number
  readonly wouldMerge: number
  readonly refused: number
  readonly rows: readonly DuplicateMergeRow[]
  readonly hasMore: boolean
  readonly nextCursor: string | null
  /** `null` when the discovery sweep could not tell which era answered. */
  readonly panelEra: string | null
}

export interface DuplicateMergeRequest {
  /**
   * `false` writes. Required rather than optional so no call site can reach the
   * endpoint without having decided, and so the decision is visible in every
   * caller and every test.
   */
  readonly dryRun: boolean
  readonly limit?: number
  readonly chunkSize?: number
  readonly startAfterId?: string
}

/** The body as it goes on the wire. Booleans stay booleans, numbers numbers. */
interface DuplicateMergeBody {
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

function readReattachment(value: unknown): DuplicateMergeReattachment {
  const row = isRecord(value) ? value : {}
  return {
    relation: readString(row.relation) ?? '',
    model: readString(row.model) ?? '',
    column: readString(row.column) ?? '',
    moved: readCount(row.moved),
  }
}

/**
 * The audit trail for one pair, or `null` when the server did not send one.
 *
 * ABSENT AND MALFORMED ARE DIFFERENT, and both matter. An absent field is a
 * backend that predates this report shape, and the honest answer is "not
 * reported". Anything PRESENT that is not an array is the HTML-page-with-status-
 * 200 case, and that must throw here through the sanctioned check rather than
 * a page down inside `.map` during render.
 */
function readReattachments(value: unknown): DuplicateMergeReattachment[] | null {
  if (value === undefined || value === null) return null
  return expectArray<unknown>(value).map(readReattachment)
}

function readRow(value: unknown): DuplicateMergeRow {
  const row = isRecord(value) ? value : {}
  return {
    survivorSubscriptionId: readString(row.survivorSubscriptionId) ?? '',
    duplicateSubscriptionId: readString(row.duplicateSubscriptionId) ?? '',
    userId: readString(row.userId),
    outcome: readString(row.outcome) ?? '',
    refusal: readString(row.refusal),
    reason: readString(row.reason),
    remnawaveId: readString(row.remnawaveId),
    remnawavePanelId: readNumber(row.remnawavePanelId),
    panelUsername: readString(row.panelUsername),
    configUrl: readString(row.configUrl),
    survivorPreviousRemnawaveId: readString(row.survivorPreviousRemnawaveId),
    survivorPreviousPanelId: readNumber(row.survivorPreviousPanelId),
    duplicatePreviousRemnawaveId: readString(row.duplicatePreviousRemnawaveId),
    duplicatePreviousPanelId: readNumber(row.duplicatePreviousPanelId),
    survivorHoldsLiveIdentity: readFlag(row.survivorHoldsLiveIdentity),
    duplicateHoldsLiveIdentity: readFlag(row.duplicateHoldsLiveIdentity),
    reattached: readReattachments(row.reattached),
    supersededSyncJobs: readNumber(row.supersededSyncJobs),
  }
}

/**
 * `'unknown'` is a value `getPanelShape()` really produces for a panel whose
 * version could not be read, and it means precisely what an ABSENT field means
 * here. Both collapse to `null` so the surface has one "we do not know" branch.
 */
function readPanelEra(value: unknown): string | null {
  const era = readString(value)
  return era === null || era === 'unknown' ? null : era
}

/**
 * WHICH HALF IS BOUND TO THE LIVE PANEL PROFILE, as the SERVER reported it.
 *
 * READ, NOT DERIVED, and that is the whole point of the two fields. The rule
 * that answers this question — `namesProfile` in
 * `src/modules/profile-sync/duplicate-subscription-merge.service.ts` — has one
 * implementation, on the server, next to the merge that acts on it. The copy
 * that used to live here reconstructed the answer from the four `previous`
 * fields and had to reproduce the two-spellings rule to do it; the two copies
 * agreeing was a thing nothing checked.
 *
 * `=== true` ON BOTH BRANCHES, deliberately. `null` (nobody said) and `false`
 * (we looked, and this half is not the one) are different facts, but they lead
 * to the same place here: neither is a licence to NAME a half. Only an explicit
 * `true` names one, so an absent field can never be read as "the duplicate" —
 * which is the reading that points at the panel DELETE.
 *
 * `'both'` IS A REAL ANSWER, NOT A DEFENSIVE BRANCH. The shared-identity arm of
 * the reconciliation sweep (`resolvedBy: 'storedIdentity'`) finds pairs whose two
 * rows ALREADY store the same well-formed identity, so the server reports both
 * flags true. Collapsing that onto one name — as the older code did, taking the
 * duplicate because that is the row the service uses as the identity source —
 * tells the operator the SURVIVOR is not bound. It is, and the reading that
 * follows from being told otherwise ends in a panel DELETE against a live
 * profile. So the two-halves case is named outright and checked FIRST.
 *
 * Below it the duplicate is checked before the survivor, mirroring the service:
 * it is the row the importer minted against the live profile.
 */
export function liveIdentityHolder(
  row: DuplicateMergeRow,
): 'survivor' | 'duplicate' | 'both' | null {
  if (row.duplicateHoldsLiveIdentity === true && row.survivorHoldsLiveIdentity === true) {
    return 'both'
  }
  if (row.duplicateHoldsLiveIdentity === true) return 'duplicate'
  if (row.survivorHoldsLiveIdentity === true) return 'survivor'
  return null
}

export function normalizeDuplicateMergeReport(
  payload: unknown,
  requested: DuplicateMergeRequest,
): DuplicateMergeReport {
  const record = isRecord(payload) ? payload : {}
  // The sanctioned check rather than a cast: an object, a `{ data: [...] }`
  // envelope or an HTML page all reach this line typed as an array and would
  // otherwise throw inside render instead of here.
  const rows = expectArray<unknown>(record.rows).map(readRow)
  return {
    // The server echoes the mode back; when it does not, the mode is the one
    // this caller ASKED for. Never optimistically "dry".
    dryRun: typeof record.dryRun === 'boolean' ? record.dryRun : requested.dryRun !== false,
    pairsExamined: readCount(record.pairsExamined),
    merged: readCount(record.merged),
    wouldMerge: readCount(record.wouldMerge),
    refused: readCount(record.refused),
    rows,
    hasMore: record.hasMore === true,
    nextCursor: readString(record.nextCursor),
    panelEra: readPanelEra(record.panelEra),
  }
}

/**
 * Runs one page of the merge.
 *
 * `limit` / `chunkSize` are dropped rather than coerced when they are not
 * finite numbers: the controller reads them as `typeof … === 'number' ? … :
 * undefined`, so a stringified bound is SILENTLY replaced by the server
 * default — an operator who asked for 5 pairs would get 25 and be told nothing.
 * Omitting the field produces the same server default and is honest about it.
 */
export async function runDuplicateSubscriptionMerge(
  request: DuplicateMergeRequest,
): Promise<DuplicateMergeReport> {
  const body: DuplicateMergeBody = {
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

  const response = await api.post<unknown>(DUPLICATE_SUBSCRIPTION_MERGE_PATH, body)
  return normalizeDuplicateMergeReport(response.data, request)
}
