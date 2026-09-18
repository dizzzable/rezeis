/**
 * Whether the answer on the online card is still a CURRENT one.
 *
 * The card's queries do not retry, and react-query keeps the last good answer
 * on screen when a refetch fails. Both sides only asked "is there data", so a
 * failing Remnawave or a dead panel left the old numbers up under a green
 * «live» dot indefinitely. And the reading-age check on the node side compares
 * the reading with its own answer's `generatedAt` — an answer that no longer
 * refreshes never looks old to it.
 *
 * So the card also asks what only the browser knows: did the latest refetch
 * fail (`isRefetchError`), and when did the answer on screen ARRIVE
 * (`dataUpdatedAt`, this browser's clock). Three missed refetches, or a failed
 * one, and the card says the answer is not current and offers a retry.
 *
 * The clock is one for every card on the page: re-read every 15 s, and at once
 * when the tab comes back (`focus`, `visibilitychange`) — a laptop that slept
 * through the afternoon must not show the morning's answer as live while its
 * first refetch is still on the way.
 */
import { useSyncExternalStore } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'

import { ONLINE_REFETCH_MS } from './dashboard-online-model'

/** An answer that has not been refreshed for three refetch intervals is not current. */
export const ONLINE_ANSWER_STALE_MS = 3 * ONLINE_REFETCH_MS

const CLOCK_TICK_MS = 15_000

let clock = Date.now()
const listeners = new Set<() => void>()
let ticker: ReturnType<typeof setInterval> | null = null

function reread(): void {
  clock = Date.now()
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    ticker = setInterval(reread, CLOCK_TICK_MS)
    window.addEventListener('focus', reread)
    document.addEventListener('visibilitychange', reread)
  }
  // A card mounting now must not judge by a clock read before it existed.
  clock = Date.now()
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0) return
    if (ticker !== null) clearInterval(ticker)
    ticker = null
    window.removeEventListener('focus', reread)
    document.removeEventListener('visibilitychange', reread)
  }
}

const readClock = (): number => clock

/** This browser's clock as of its last re-read: in render, without reading `Date.now()` there. */
export function useBrowserClock(): number {
  return useSyncExternalStore(subscribe, readClock, readClock)
}

export interface AnswerFreshness {
  /** The answer on screen is not a current one: its last refetch failed, or none has landed for too long. */
  readonly stale: boolean
  /** When this browser received the answer on screen. */
  readonly receivedAt: number
  /** This browser's clock, to say how long ago that was. */
  readonly now: number
}

export function useAnswerFreshness(query: UseQueryResult<unknown>): AnswerFreshness {
  const now = useBrowserClock()
  const receivedAt = query.dataUpdatedAt
  // A previous window's answer standing in for a new one (`isPlaceholderData`)
  // is not "old": its own query is being fetched right now.
  const stale =
    query.data !== undefined &&
    !query.isPlaceholderData &&
    (query.isRefetchError || (receivedAt > 0 && now - receivedAt > ONLINE_ANSWER_STALE_MS))
  return { stale, receivedAt, now }
}
