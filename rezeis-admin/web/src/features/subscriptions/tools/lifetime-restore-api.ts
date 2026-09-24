/**
 * «Бессрочные подписки с датой» — the wire boundary.
 * ─────────────────────────────────────────────────
 *   `GET  /admin/subscriptions/lifetime-restore`  the census
 *   `POST /admin/subscriptions/lifetime-restore`  `{ subscriptionIds }` → one result per id
 *
 * A subscription sold without an end must carry no end date. Until the panel
 * learned to send Remnawave its "no end" date, it sent "created + 30 days",
 * took that date back as its own, and every lifetime guard stopped applying —
 * on day 30 Remnawave switched the customer off. The census lists live rows
 * that still carry such a date together with the EVIDENCE that they were sold
 * without an end; the operator restores the ones they choose. Nothing here
 * restores anything by itself.
 *
 * Read defensively, like every wire file in this feature: arrays checked with
 * `expectArray`, codes kept as strings so a new one renders by name.
 */
import { api } from '@/lib/api'
import { expectArray, isRecord } from '@/lib/api-utils'

export const LIFETIME_RESTORE_PATH = '/admin/subscriptions/lifetime-restore'

/**
 * How many ids one POST carries. The server accepts up to 200, but it restores
 * each id in a transaction of its own and the panel cuts a request at 30 s, so
 * 200 on a slow server can be cut mid-run. A larger selection goes out as
 * consecutive batches of this size — see {@link restoreLifetime}; the operator
 * still presses one button.
 */
export const LIFETIME_RESTORE_BATCH_SIZE = 50

export const LIFETIME_EVIDENCE_KINDS = ['snapshot', 'payment', 'paymentLine', 'plan'] as const

export interface LifetimeEvidence {
  /** Kept open: a kind added server-side still reaches the screen. */
  readonly kind: string
  readonly paymentId: string | null
  readonly planId: string | null
}

export interface LifetimeCensusRow {
  readonly subscriptionId: string
  readonly userId: string
  readonly userName: string | null
  readonly userTelegramId: string | null
  readonly planName: string | null
  readonly status: string
  /** The date it carries now. */
  readonly expiresAt: string | null
  readonly createdAt: string | null
  /** Has a Remnawave link (a restore then queues one sync). */
  readonly linked: boolean
  readonly evidence: readonly LifetimeEvidence[]
  /** Hint: the date is a completed CREATE's completion + 30 days (any CREATE: a re-created profile got it too) — the old defect's fingerprint. */
  readonly thirtyDaysAfterCreate: boolean
  /** Hint: a payment for a real term came after the last "no end" one — the date may be paid for. */
  readonly datedPaymentAfter: boolean
  /**
   * `thirtyDaysAfterCreate && !datedPaymentAfter`, decided by the server — the
   * rows the tab selects in advance, and the only ones.
   */
  readonly suggested: boolean
}

export interface LifetimeCensus {
  readonly rows: readonly LifetimeCensusRow[]
  /** null = the server did not say. */
  readonly total: number | null
  readonly truncated: boolean
}

export const LIFETIME_RESTORE_OUTCOMES = [
  'restored',
  'alreadyLifetime',
  'notEligible',
  'deleted',
  'notFound',
  'failed',
] as const

export interface LifetimeRestoreResult {
  readonly subscriptionId: string
  /**
   * One of {@link LIFETIME_RESTORE_OUTCOMES}, a code added server-side, or one
   * of this tab's own two words for an id the server did not answer for:
   * {@link LIFETIME_RESTORE_NO_ANSWER} and {@link LIFETIME_RESTORE_NOT_SENT}.
   */
  readonly outcome: string
  readonly previousExpiresAt: string | null
  readonly statusBefore: string | null
  readonly statusAfter: string | null
  readonly revivedAddOns: number | null
  readonly syncQueued: boolean
  readonly error: string | null
}

/**
 * An id that WAS sent and got no answer: its batch failed as a request, or the
 * server's answer did not name it. It may or may not have been restored —
 * pressing again is safe, a restored row answers `alreadyLifetime`.
 */
export const LIFETIME_RESTORE_NO_ANSWER = 'noAnswer'

/** An id that was never sent, because an earlier batch failed. */
export const LIFETIME_RESTORE_NOT_SENT = 'notSent'

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return readString(value)
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readEvidence(value: unknown): LifetimeEvidence | null {
  if (!isRecord(value)) return null
  const kind = readString(value.kind)
  if (kind === null) return null
  return { kind, paymentId: readId(value.paymentId), planId: readId(value.planId) }
}

function readCensusRow(value: unknown): LifetimeCensusRow | null {
  if (!isRecord(value)) return null
  const subscriptionId = readString(value.subscriptionId)
  if (subscriptionId === null) return null
  return {
    subscriptionId,
    userId: readString(value.userId) ?? '',
    userName: readString(value.userName),
    userTelegramId: readId(value.userTelegramId),
    planName: readString(value.planName),
    status: readString(value.status) ?? '',
    expiresAt: readString(value.expiresAt),
    createdAt: readString(value.createdAt),
    linked: value.linked === true,
    evidence: expectArray<unknown>(value.evidence)
      .map(readEvidence)
      .filter((evidence): evidence is LifetimeEvidence => evidence !== null),
    thirtyDaysAfterCreate: value.thirtyDaysAfterCreate === true,
    datedPaymentAfter: value.datedPaymentAfter === true,
    // `=== true`: a row is selected in advance only when the server says so.
    // Selecting one it did not suggest is the operator's decision, not ours.
    suggested: value.suggested === true,
  }
}

/**
 * The rows selected before the operator acts: exactly the ones the server
 * marks `suggested` (the fingerprint, with no payment for a term after it).
 */
export function suggestedLifetimeIds(rows: readonly LifetimeCensusRow[]): Set<string> {
  return new Set(rows.filter((row) => row.suggested).map((row) => row.subscriptionId))
}

export async function fetchLifetimeCensus(): Promise<LifetimeCensus> {
  const { data } = await api.get<unknown>(LIFETIME_RESTORE_PATH)
  const body = isRecord(data) ? data : {}
  return {
    rows: expectArray<unknown>(body.rows)
      .map(readCensusRow)
      .filter((row): row is LifetimeCensusRow => row !== null),
    total: readNumber(body.total),
    truncated: body.truncated === true,
  }
}

function readResult(value: unknown): LifetimeRestoreResult | null {
  if (!isRecord(value)) return null
  const subscriptionId = readString(value.subscriptionId)
  if (subscriptionId === null) return null
  return {
    subscriptionId,
    outcome: readString(value.outcome) ?? '',
    previousExpiresAt: readString(value.previousExpiresAt),
    statusBefore: readString(value.statusBefore),
    statusAfter: readString(value.statusAfter),
    revivedAddOns: readNumber(value.revivedAddOns),
    syncQueued: value.syncQueued === true,
    error: readString(value.error),
  }
}

export interface LifetimeRestoreRun {
  /** One entry per id sent or meant to be sent, in the order they were given. */
  readonly results: readonly LifetimeRestoreResult[]
  /** The failure that stopped the run, or `null` when every batch was answered. */
  readonly error: unknown
}

function unanswered(subscriptionId: string, outcome: string): LifetimeRestoreResult {
  return {
    subscriptionId,
    outcome,
    previousExpiresAt: null,
    statusBefore: null,
    statusAfter: null,
    revivedAddOns: null,
    syncQueued: false,
    error: null,
  }
}

/**
 * Restores exactly `subscriptionIds` — the ids the operator selected, nothing
 * added, nothing dropped, no duplicates.
 *
 * In batches of {@link LIFETIME_RESTORE_BATCH_SIZE}, one after another: a request
 * the server needs longer than 30 s for is cut, and the census can list more. A batch
 * that fails as a REQUEST (a dead host, a 500) stops the run: the server may or
 * may not have written it, so nothing is fired after it. Every id the server
 * did not answer for still gets a line — `noAnswer` for the ids that went out,
 * `notSent` for the ones that never did — so the screen never shows silence
 * where a row went unanswered.
 */
export async function restoreLifetime(subscriptionIds: readonly string[]): Promise<LifetimeRestoreRun> {
  const ids = [...new Set(subscriptionIds)]
  const answered = new Map<string, LifetimeRestoreResult>()
  const sent = new Set<string>()
  let error: unknown = null
  for (let start = 0; start < ids.length; start += LIFETIME_RESTORE_BATCH_SIZE) {
    const batch = ids.slice(start, start + LIFETIME_RESTORE_BATCH_SIZE)
    for (const id of batch) sent.add(id)
    try {
      const { data } = await api.post<unknown>(LIFETIME_RESTORE_PATH, { subscriptionIds: batch })
      const body = isRecord(data) ? data : {}
      for (const result of expectArray<unknown>(body.results)) {
        const read = readResult(result)
        if (read !== null) answered.set(read.subscriptionId, read)
      }
    } catch (failure) {
      error = failure
      break
    }
  }
  return {
    results: ids.map(
      (id) =>
        answered.get(id) ??
        unanswered(id, sent.has(id) ? LIFETIME_RESTORE_NO_ANSWER : LIFETIME_RESTORE_NOT_SENT),
    ),
    error,
  }
}
