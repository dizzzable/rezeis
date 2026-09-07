import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { UserDetail, UserSubscription } from './user-detail-shape'
import {
  describeSyncSettlements,
  liveSyncJobs,
  syncPollInterval,
  SYNC_POLL_FAST_MS,
  SYNC_POLL_FAST_WINDOW_MS,
  SYNC_POLL_SLOW_MS,
} from './subscription-sync-watch'

/**
 * A queued sync has to finish ON SCREEN.
 *
 * THE REPORT, watched on a recording: the operator presses "Синхронизировать
 * все", the "Синхронизация…" chip appears, and fifteen seconds later it is
 * still there. It clears only when the page is reloaded — and even then
 * nothing anywhere says whether the sync worked.
 *
 * Both halves come from the same shape. That endpoint ENQUEUES `ProfileSyncJob`
 * rows and answers with a count; the panel invalidated the user query once,
 * that refetch saw the jobs as PENDING, and nothing ever asked again. So the
 * chip was frozen at the last answer, and the outcome — which arrives seconds
 * later, on the server — reached nobody.
 *
 * The two rules below are what a reload used to do by hand.
 */

const NOW = Date.parse('2026-09-07T18:32:00.000Z')
const ago = (ms: number): string => new Date(NOW - ms).toISOString()

function sub(over: Partial<UserSubscription> = {}): UserSubscription {
  return {
    id: 'sub-1',
    status: 'ACTIVE',
    plan: { name: 'OldMoney' },
    ...over,
  } as UserSubscription
}

function user(subscriptions: UserSubscription[]): UserDetail {
  // The required half of `UserDetail` stated rather than cast away: a cast
  // through `unknown` would keep compiling if the shape gained a field these
  // functions read, and read it as `undefined` forever.
  return {
    id: 'user-1',
    telegramId: '5207654944',
    isBlocked: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    subscriptions,
  }
}

const running = (over: Partial<UserSubscription> = {}, seconds = 1): UserSubscription =>
  sub({
    remnawaveSyncJob: {
      status: 'PENDING',
      action: 'UPDATE',
      attempts: 0,
      lastError: null,
      updatedAt: ago(seconds * 1000),
    },
    ...over,
  })

describe('whether to keep asking', () => {
  it('does not poll when nothing is running', () => {
    // The ordinary state of this screen, and the one that must cost nothing.
    expect(syncPollInterval(user([sub()]), NOW)).toBe(false)
    expect(syncPollInterval(user([sub({ remnawaveSyncJob: null })]), NOW)).toBe(false)
    expect(syncPollInterval(undefined, NOW)).toBe(false)
  })

  it('does not poll for a job that has already finished', () => {
    for (const status of ['SYNCED', 'COMPLETED', 'FAILED', 'CANCELLED']) {
      const finished = sub({
        remnawaveSyncJob: {
          status,
          action: 'UPDATE',
          attempts: 1,
          lastError: null,
          updatedAt: ago(1000),
        },
      })
      expect(syncPollInterval(user([finished]), NOW), status).toBe(false)
    }
  })

  it('polls quickly while the job is young', () => {
    // The seconds the operator is actually watching the chip.
    expect(syncPollInterval(user([running()]), NOW)).toBe(SYNC_POLL_FAST_MS)
    expect(syncPollInterval(user([running({}, 59)]), NOW)).toBe(SYNC_POLL_FAST_MS)
  })

  it('backs off once the job is old, and never gives up', () => {
    // Past a minute the interesting question is "is this stuck?", which does
    // not need an answer every two seconds. Stopping outright would put the
    // screen back exactly where the report found it: a chip that is true only
    // until it is not, with nothing to correct it.
    const old = running({}, SYNC_POLL_FAST_WINDOW_MS / 1000 + 5)
    expect(syncPollInterval(user([old]), NOW)).toBe(SYNC_POLL_SLOW_MS)
  })

  it('keeps the fast pace while ANY job is young', () => {
    const old = running({ id: 'sub-old' }, 300)
    const fresh = running({ id: 'sub-new' }, 2)
    expect(syncPollInterval(user([old, fresh]), NOW)).toBe(SYNC_POLL_FAST_MS)
  })

  it('treats an unreadable timestamp as young', () => {
    // Being wrong this way costs two requests. Being wrong the other way makes
    // the operator watch a stale chip for ten seconds at the moment they are
    // waiting on it.
    const odd = sub({
      remnawaveSyncJob: {
        status: 'RUNNING',
        action: 'UPDATE',
        attempts: 0,
        lastError: null,
        updatedAt: 'not a date',
      },
    })
    expect(syncPollInterval(user([odd]), NOW)).toBe(SYNC_POLL_FAST_MS)
  })

  it('counts RUNNING as live, not only PENDING', () => {
    const inFlight = sub({
      remnawaveSyncJob: {
        status: 'RUNNING',
        action: 'UPDATE',
        attempts: 1,
        lastError: null,
        updatedAt: ago(1000),
      },
    })
    expect(liveSyncJobs(user([inFlight]))).toHaveLength(1)
  })
})

describe('what to say when it ends', () => {
  it('reports a job that landed', () => {
    const before = user([running()])
    const after = user([
      sub({
        remnawaveSyncJob: {
          status: 'SYNCED',
          action: 'UPDATE',
          attempts: 1,
          lastError: null,
          updatedAt: ago(0),
        },
      }),
    ])
    expect(describeSyncSettlements(before, after)).toEqual([
      { kind: 'landed', subscriptionId: 'sub-1', name: 'OldMoney' },
    ])
  })

  it('reports a job that failed, with what it said', () => {
    // The half a reload never fixed either: a FAILED job renders its notice on
    // the card, and until this existed nobody saw the card change.
    const before = user([running()])
    const after = user([
      sub({
        remnawaveSyncJob: {
          status: 'FAILED',
          action: 'UPDATE',
          attempts: 3,
          lastError: 'panel refused: 502',
          updatedAt: ago(0),
        },
      }),
    ])
    expect(describeSyncSettlements(before, after)).toEqual([
      {
        kind: 'failed',
        subscriptionId: 'sub-1',
        name: 'OldMoney',
        lastError: 'panel refused: 502',
      },
    ])
  })

  it('says nothing while the job is still running', () => {
    expect(describeSyncSettlements(user([running()]), user([running({}, 3)]))).toEqual([])
  })

  it('says nothing when nothing was running to begin with', () => {
    // Which is also the first answer of a session: the panel has no "before",
    // so a job that was already running when the page opened has no transition
    // to report yet.
    expect(describeSyncSettlements(user([sub()]), user([running()]))).toEqual([])
    expect(describeSyncSettlements(undefined, user([sub()]))).toEqual([])
  })

  it('says nothing about a subscription that was deleted mid-sync', () => {
    // There is no card left to explain it on, and an operator who just deleted
    // a subscription does not need to hear that its sync finished.
    expect(describeSyncSettlements(user([running()]), user([]))).toEqual([])
  })

  it('reports each subscription once, by its own name', () => {
    const before = user([running({ id: 'a' }), running({ id: 'b', plan: { name: 'Silver' } })])
    const after = user([
      sub({
        id: 'a',
        remnawaveSyncJob: {
          status: 'SYNCED',
          action: 'UPDATE',
          attempts: 1,
          lastError: null,
          updatedAt: ago(0),
        },
      }),
      running({ id: 'b', plan: { name: 'Silver' } }),
    ])
    expect(describeSyncSettlements(before, after)).toEqual([
      { kind: 'landed', subscriptionId: 'a', name: 'OldMoney' },
    ])
  })

  it('falls back to a short id when the subscription has no plan name', () => {
    const before = user([running({ id: 'cmphfcr6i007v01jg0lcu653h', plan: undefined })])
    const after = user([
      sub({
        id: 'cmphfcr6i007v01jg0lcu653h',
        plan: undefined,
        remnawaveSyncJob: {
          status: 'SYNCED',
          action: 'UPDATE',
          attempts: 1,
          lastError: null,
          updatedAt: ago(0),
        },
      }),
    ])
    expect(describeSyncSettlements(before, after)[0]?.name).toBe('#cmphfcr6')
  })
})

describe('the panel actually asks and actually says', () => {
  // Source contract, and labelled as one. Both functions above are pure and
  // well covered, and a panel that imported neither would pass every test in
  // this file while behaving exactly as the report described. `__dirname` and
  // not `import.meta.url`: this project's vitest serves modules over http, so
  // `fileURLToPath(import.meta.url)` throws here.
  const panel = readFileSync(join(__dirname, 'user-detail-panel.tsx'), 'utf8')

  it('drives the refetch off the answer, not off a press', () => {
    expect(panel).toMatch(/refetchInterval:\s*\(query\)\s*=>\s*syncPollInterval\(query\.state\.data\)/)
  })

  it('announces how a queued sync ended', () => {
    expect(panel).toContain('useAnnounceSyncSettlements(user)')
    expect(panel).toContain('describeSyncSettlements(before, user)')
    expect(panel).toContain('subscriptions.syncJobLanded')
    expect(panel).toContain('subscriptions.syncJobFailed')
  })
})
