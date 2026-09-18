/**
 * How the usage rings move: a sweep and a count when a panel first comes into
 * view, and nothing at all when the operator asked for stillness.
 *
 * TWO SWITCHES, BOTH HONOURED. The system's "reduce motion" and the panel's own
 * animations setting (`appearance-store.animationsEnabled`). The CSS side of
 * the app already obeys both — `index.css` zeroes animation durations under
 * `data-animations="off"` — but a Recharts sweep and a counted number are driven
 * from JavaScript, where no stylesheet reaches. So this file asks, and every
 * moving part of the card asks this file.
 *
 * WHY "FIRST COMES INTO VIEW". The card sits below the daily chart; on most
 * screens it loads off-screen. Animated on arrival, the sweep would be over long
 * before anybody scrolled to it — all of the cost, none of the point.
 *
 * TIME, NOT FRAMES. A counted number follows the clock: a background tab stops
 * the frame loop outright, and on return the first frame lands at the end
 * instead of resuming a count nobody saw.
 */
import { type RefObject, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'

import { useAppearanceStore } from '@/lib/theme/appearance-store'
import { usePrefersReducedMotion } from '@/lib/theme/effects-active'

/** How long a ring takes to sweep in, and a number to count up with it. */
export const SURFACE_SWEEP_MS = 900
/** How far behind its neighbour each panel starts, so a row of four cascades. */
export const SURFACE_STAGGER_MS = 90
/** How much of a panel must be on screen before it plays. */
export const SURFACE_APPEAR_THRESHOLD = 0.35

/**
 * Whether the rings may move at all: the panel's animations setting, the
 * system's preference, AND whether the browser is printing.
 *
 * PRINTING STOPS EVERYTHING. A page printed before the card was ever scrolled
 * to used to print «С телеметрией 0» and four empty rings: the count starts at
 * zero and the sweep waits for the panel to be seen, and neither ever happens
 * on a page nobody looked at. `beforeprint` fires before the snapshot is taken,
 * so the state change is flushed synchronously there, and the card draws the
 * numbers it ended on. It stays still for the rest of this mount — after
 * printing, the operator is looking at the finished rings, and replaying the
 * sweep under them would only be a surprise.
 */
export function useSurfaceMotion(): boolean {
  const animationsEnabled = useAppearanceStore((state) => state.animationsEnabled)
  const reduceMotion = usePrefersReducedMotion()
  const [printing, setPrinting] = useState(false)

  useEffect(() => {
    if (printing || typeof window.addEventListener !== 'function') return
    const stop = (): void => flushSync(() => setPrinting(true))
    window.addEventListener('beforeprint', stop)
    return () => window.removeEventListener('beforeprint', stop)
  }, [printing])

  return animationsEnabled && !reduceMotion && !printing
}

/**
 * Which panels have already played, for one visit to the page.
 *
 * The card is rebuilt more often than it is arrived at: every 7d/30d/90d/1y
 * click re-renders the tab around it, and leaving the tab unmounts it. Without
 * a memory outside the card, each of those replayed four sweeps and four counts
 * — the page twitching in answer to a click that was about another card.
 *
 * Held by the page and handed down, not kept in a module: two analytics pages
 * open in two windows are two visits, and a set that outlived the route would
 * never let the card animate again. Mounted without one — a test, a story — the
 * card keeps its own, so it still plays exactly once.
 */
export function useSurfacePlayed(shared: Set<string> | undefined): Set<string> {
  const [own] = useState(() => new Set<string>())
  return shared ?? own
}

const canObserve = (): boolean => typeof IntersectionObserver === 'function'

/**
 * Whether `target` has been on screen yet — asked only while `watch` holds.
 *
 * Not watching means nothing waits: a still card is drawn complete from the
 * first frame. Neither does a browser without `IntersectionObserver`, which
 * could otherwise never report the panel and would leave it blank.
 */
export function useFirstAppearance(target: RefObject<Element | null>, watch: boolean): boolean {
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    if (!watch || seen || !canObserve()) return
    const element = target.current
    if (element === null) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true)
          observer.disconnect()
        }
      },
      { threshold: SURFACE_APPEAR_THRESHOLD },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [target, watch, seen])
  return !watch || seen || !canObserve()
}

const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3

/**
 * `target`, counted up from zero once `started`, over the sweep's duration and
 * after `delayMs`; later changes count from wherever the number stands. When
 * the card may not move, it is simply `target`.
 */
export function useCountUp(target: number, animate: boolean, started: boolean, delayMs: number): number {
  const [shown, setShown] = useState(0)
  const standing = useRef(0)

  useEffect(() => {
    if (!animate || !started) return
    const from = standing.current
    if (from === target) return
    const begin = performance.now() + delayMs
    let frame = 0
    const tick = (now: number): void => {
      const progress = Math.min(1, Math.max(0, (now - begin) / SURFACE_SWEEP_MS))
      const value = from + (target - from) * easeOutCubic(progress)
      standing.current = value
      setShown(value)
      if (progress < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target, animate, started, delayMs])

  if (!animate) return target
  if (!started) return 0
  return Math.round(shown)
}
