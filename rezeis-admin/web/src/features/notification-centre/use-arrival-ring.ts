/**
 * When the bell should move.
 *
 * Its own module because the rule is the whole feature: a bell that shakes at
 * the wrong moment is worse than one that never moves, and "at the wrong
 * moment" has three shapes, each of which this answers `false` to.
 *
 *  • THE FIRST ANSWER IS NOT AN ARRIVAL. What the badge shows on load is what
 *    was already waiting; a panel that shakes on every sign-in teaches the
 *    operator that the movement means nothing. `null` is how the caller says
 *    "the server has not answered yet" — and it is load-bearing, because a
 *    query reads as 0 until it does, so treating that 0 as a number would make
 *    every first answer above zero look like an arrival. A test caught exactly
 *    that.
 *  • READING IS NOT AN ARRIVAL. The count going down is the operator's own
 *    doing and does not need announcing back to them.
 *  • STILLNESS IS A SETTING. `enabled` carries both switches — the panel's
 *    «Анимации» and the system's reduce-motion — and neither is advisory.
 */
import { useEffect, useRef, useState } from 'react'

/** How long the bell moves when something arrives. */
export const RING_MS = 700

export function useArrivalRing(unread: number | null, enabled: boolean): boolean {
  const previous = useRef<number | null>(null)
  const [ringing, setRinging] = useState(false)

  useEffect(() => {
    if (unread === null) return
    const before = previous.current
    previous.current = unread
    if (before === null || unread <= before || !enabled) return
    setRinging(true)
    const timer = setTimeout(() => setRinging(false), RING_MS)
    return () => clearTimeout(timer)
  }, [unread, enabled])

  return ringing
}
