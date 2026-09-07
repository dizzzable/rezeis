/**
 * Watching a queued Remnawave sync until it actually lands.
 *
 * THE REPORT, and it is two faults wearing one badge. "Синхронизировать все"
 * ENQUEUES `ProfileSyncJob` rows and answers immediately with how many it
 * queued; the panel then invalidates the user query ONCE, that refetch sees the
 * fresh jobs as `PENDING`, and the "Синхронизация…" chip appears. Nothing ever
 * asks again. So:
 *
 *   1. the chip is frozen at whatever the last fetch happened to see, and only
 *      a page reload clears it — even though the job usually finishes seconds
 *      later;
 *   2. nobody is ever told the outcome. A job that FAILED renders its notice
 *      only after that same manual reload, so "did it work?" has no answer on
 *      the screen the operator is looking at.
 *
 * Both halves are one question — "is a job still live?" — asked twice: once to
 * decide whether to keep polling, and once to notice the moment the answer
 * changes. Everything here is pure so both can be tested without a server.
 */
import type { UserDetail, UserSubscription } from './user-detail-shape'

/** `ProfileSyncJob.status` values that mean the work has not finished. */
const LIVE_STATUSES = new Set(['PENDING', 'RUNNING'])

/**
 * Poll fast while a job is young, then slowly, and never stop while one lives.
 *
 * A job normally lands within a few seconds, which is the window worth watching
 * closely — that is where the operator is still looking at the chip. After a
 * minute the interesting case has become "this one is stuck", and a stuck job
 * is a state that deserves a live chip rather than a poll every two seconds
 * forever.
 *
 * It never gives up entirely, deliberately: stopping would put the screen back
 * in exactly the state this file exists to fix — a chip that is true only until
 * it is not, with nothing to correct it.
 */
export const SYNC_POLL_FAST_MS = 2_000
export const SYNC_POLL_SLOW_MS = 10_000
/** How long a job is "young". Past this, the poll backs off. */
export const SYNC_POLL_FAST_WINDOW_MS = 60_000

export interface LiveSyncJob {
  readonly subscriptionId: string
  readonly status: string
  /** `ProfileSyncJob.updatedAt`, parsed. `null` when unusable. */
  readonly updatedAt: number | null
}

function jobOf(sub: UserSubscription): LiveSyncJob | null {
  const job = sub.remnawaveSyncJob
  if (job === undefined || job === null) return null
  if (!LIVE_STATUSES.has(job.status)) return null
  const parsed = Date.parse(job.updatedAt)
  return {
    subscriptionId: sub.id,
    status: job.status,
    updatedAt: Number.isFinite(parsed) ? parsed : null,
  }
}

/** Every subscription of this user whose sync has not finished. */
export function liveSyncJobs(user: UserDetail | undefined): readonly LiveSyncJob[] {
  const subs = user?.subscriptions ?? []
  const live: LiveSyncJob[] = []
  for (const sub of subs) {
    const job = jobOf(sub)
    if (job !== null) live.push(job)
  }
  return live
}

/**
 * How often to ask again, or `false` for "nothing is running".
 *
 * A job with an unreadable timestamp is treated as YOUNG rather than old: the
 * cost of being wrong that way is a couple of extra requests, and the cost of
 * being wrong the other way is the operator watching a stale chip for ten
 * seconds at the exact moment they are waiting on it.
 */
export function syncPollInterval(
  user: UserDetail | undefined,
  now: number = Date.now(),
): number | false {
  const live = liveSyncJobs(user)
  if (live.length === 0) return false
  const anyYoung = live.some(
    (job) => job.updatedAt === null || now - job.updatedAt < SYNC_POLL_FAST_WINDOW_MS,
  )
  return anyYoung ? SYNC_POLL_FAST_MS : SYNC_POLL_SLOW_MS
}

export type SyncSettlement =
  | { readonly kind: 'landed'; readonly subscriptionId: string; readonly name: string }
  | {
      readonly kind: 'failed'
      readonly subscriptionId: string
      readonly name: string
      readonly lastError: string | null
    }

/** The name to put in the sentence — the plan's, or a short id when it has none. */
function nameOf(sub: UserSubscription): string {
  const name = sub.plan?.name ?? sub.planSnapshot?.name ?? null
  if (typeof name === 'string' && name.trim().length > 0) return name.trim()
  return `#${sub.id.slice(0, 8)}`
}

/**
 * Which subscriptions stopped being "in progress" between two answers, and how
 * each one ended.
 *
 * Reads the AFTER state for the verdict rather than inferring one from the
 * disappearance: a job row that is gone and a job row that says `FAILED` are
 * different facts, and only the second is worth an error.
 *
 * A subscription that vanished from the list entirely (deleted while its sync
 * ran) reports nothing. There is no card left to explain it on, and an operator
 * who just deleted a subscription does not need to hear that its sync finished.
 */
export function describeSyncSettlements(
  before: UserDetail | undefined,
  after: UserDetail | undefined,
): readonly SyncSettlement[] {
  // An empty set is not special-cased: the membership test below already
  // answers nothing for it, and an early return would be a branch no test can
  // tell apart from its absence.
  const wasLive = new Set(liveSyncJobs(before).map((job) => job.subscriptionId))
  const settled: SyncSettlement[] = []
  for (const sub of after?.subscriptions ?? []) {
    if (!wasLive.has(sub.id)) continue
    if (jobOf(sub) !== null) continue
    const status = sub.remnawaveSyncJob?.status ?? null
    if (status === 'FAILED') {
      settled.push({
        kind: 'failed',
        subscriptionId: sub.id,
        name: nameOf(sub),
        lastError: sub.remnawaveSyncJob?.lastError ?? null,
      })
      continue
    }
    settled.push({ kind: 'landed', subscriptionId: sub.id, name: nameOf(sub) })
  }
  return settled
}
