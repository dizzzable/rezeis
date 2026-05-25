/**
 * LiquidGlassMotion — global pointer/scroll/idle driver for the glass
 * surfaces.
 *
 * Responsibilities
 * ----------------
 * 1. Pointer-driven specular: writes `--lg-light-x` / `--lg-light-y`
 *    (viewport %) on `<html>` so glass surfaces position a soft
 *    radial-gradient highlight where the cursor is.
 * 2. Idle shimmer: when the cursor sits still for 1.5 s, the highlight
 *    drifts slowly along an ellipse so the surface still looks alive
 *    rather than freezing in place. As soon as the user moves again,
 *    the orbit pauses and the highlight snaps back to follow the
 *    pointer.
 * 3. Scroll guard: while the page is being scrolled, sets
 *    `data-glass-scrolling="yes"` on `<html>`. CSS in `index.css`
 *    drops the SVG refraction filter from glass surfaces during the
 *    burst, then it auto-clears 200 ms after the last scroll event.
 *    This sidesteps the well-known `feDisplacementMap`-during-scroll
 *    FPS dip.
 *
 * Why one global driver
 * ---------------------
 * Per-component listeners would multiply the cost across the tree. CSS
 * variables on `<html>` mean any number of glass surfaces read the
 * same value at zero JS cost. All event handlers are passive and
 * rAF-batched.
 *
 * Reduced-motion guard
 * --------------------
 * AppearanceProvider mirrors the OS preference into
 * `data-glass-motion="off"`. When motion is suppressed (either by the
 * OS or by the user toggle), this component still mounts but pins the
 * highlight statically and skips the pointer/idle/scroll handlers
 * entirely.
 */
import { useEffect } from 'react'
import { useGlassStore } from '@/lib/theme/glass-store'

/** How long after the last `pointermove` we consider the cursor idle. */
const IDLE_TIMEOUT_MS = 1500
/** Period of the idle ellipse, in ms. Slow on purpose — the highlight
 *  should look like the surface is breathing, not pulsing. */
const IDLE_PERIOD_MS = 9000
/** Centre + radii of the idle ellipse, in viewport %. */
const IDLE_CENTER_X = 50
const IDLE_CENTER_Y = 35
const IDLE_RADIUS_X = 30
const IDLE_RADIUS_Y = 18
/** Scroll-burst window after which the refraction layer is re-enabled. */
const SCROLL_IDLE_MS = 200

export function LiquidGlassMotion() {
  const glassEnabled = useGlassStore((s) => s.glassEnabled)
  const respectReducedMotion = useGlassStore((s) => s.respectReducedMotion)

  useEffect(() => {
    if (!glassEnabled) return

    const root = document.documentElement
    const reduced =
      respectReducedMotion
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches

    if (reduced) {
      // Pin to a static top-left highlight — same value the CSS would
      // see if the listener never ran. Skip all handlers below.
      root.style.setProperty('--lg-light-x', '20%')
      root.style.setProperty('--lg-light-y', '20%')
      root.dataset.glassScrolling = 'no'
      return
    }

    // ── Pointer + idle drive ──────────────────────────────────────────
    let pointerX = 50
    let pointerY = 50
    let isIdle = false
    let lastMoveAt = performance.now()
    let rafId: number | null = null

    const flushPointerSync = () => {
      // Called both from rAF (after a pointer event) and from the idle
      // orbit. Picks the right source depending on the idle flag.
      if (isIdle) {
        const now = performance.now()
        const phase = ((now / IDLE_PERIOD_MS) % 1) * Math.PI * 2
        const x = IDLE_CENTER_X + Math.cos(phase) * IDLE_RADIUS_X
        const y = IDLE_CENTER_Y + Math.sin(phase) * IDLE_RADIUS_Y
        root.style.setProperty('--lg-light-x', `${x.toFixed(1)}%`)
        root.style.setProperty('--lg-light-y', `${y.toFixed(1)}%`)
      } else {
        root.style.setProperty('--lg-light-x', `${pointerX.toFixed(1)}%`)
        root.style.setProperty('--lg-light-y', `${pointerY.toFixed(1)}%`)
      }
    }

    const tickIdle = () => {
      const elapsed = performance.now() - lastMoveAt
      if (elapsed >= IDLE_TIMEOUT_MS) {
        isIdle = true
        flushPointerSync()
      }
      rafId = requestAnimationFrame(tickIdle)
    }

    const onPointerMove = (e: PointerEvent) => {
      const w = window.innerWidth || 1
      const h = window.innerHeight || 1
      pointerX = (e.clientX / w) * 100
      pointerY = (e.clientY / h) * 100
      lastMoveAt = performance.now()
      isIdle = false
      flushPointerSync()
    }

    // Initial value so the first paint matches the cursor's expected
    // position even before the first pointermove.
    flushPointerSync()
    rafId = requestAnimationFrame(tickIdle)
    window.addEventListener('pointermove', onPointerMove, { passive: true })

    // ── Scroll guard ──────────────────────────────────────────────────
    let scrollTimer: ReturnType<typeof setTimeout> | null = null
    root.dataset.glassScrolling = 'no'
    const onScroll = () => {
      root.dataset.glassScrolling = 'yes'
      if (scrollTimer) clearTimeout(scrollTimer)
      scrollTimer = setTimeout(() => {
        root.dataset.glassScrolling = 'no'
      }, SCROLL_IDLE_MS)
    }
    // `scroll` events bubble in capture phase only, so a window-level
    // capture listener catches scroll on any inner scroll container too.
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })

    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('scroll', onScroll, { capture: true })
      if (rafId !== null) cancelAnimationFrame(rafId)
      if (scrollTimer) clearTimeout(scrollTimer)
      root.dataset.glassScrolling = 'no'
    }
  }, [glassEnabled, respectReducedMotion])

  return null
}
