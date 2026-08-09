/**
 * ClickSparkOverlay — global click-spark effect rendered as a fixed
 * canvas overlay listening to document-level clicks.
 *
 * Unlike the React Bits ClickSpark which wraps children, this overlay
 * sits as a sibling of the app shell so it never alters layout.
 */
import { useEffect, useRef } from 'react'

interface ClickSparkOverlayProps {
  /** Spark color (CSS color string) */
  color?: string
  /** Number of sparks per click */
  count?: number
  /** Spark animation duration (ms) */
  duration?: number
  /** Spark radius in px */
  radius?: number
  /** Initial spark size */
  size?: number
}

interface Spark {
  x: number
  y: number
  angle: number
  startTime: number
}

const TWO_PI = Math.PI * 2

export function ClickSparkOverlay({
  color = '#aa1d8b',
  count = 10,
  duration = 500,
  radius = 25,
  size = 8,
}: ClickSparkOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sparksRef = useRef<Spark[]>([])
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Dimensions currently written into the backing store. Local to this
    // effect run, so a remount always re-applies (the canvas is new, and its
    // context state with it) — never inferred from `canvas.width`, whose
    // pre-first-resize value is jsdom's/HTML's 300×150 default and could
    // coincide with a real viewport.
    let applied: { width: number; height: number } | null = null

    const resize = () => {
      // Clamp the backing store to 2× — sparks are 2px strokes, so 3×
      // (iPhone) only triples the pixels cleared/composited per frame
      // without any visible gain.
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const width = Math.round(window.innerWidth * dpr)
      const height = Math.round(window.innerHeight * dpr)

      // Identity guard. This overlay is mounted on EVERY route, and writing
      // `canvas.width` reallocates the backing store and wipes the context
      // even when the value is unchanged — on a phone that is ~5 MB
      // (390×844 at 2×, 4 bytes/px) thrown away and re-zeroed. iOS fires
      // `resize` repeatedly through the address-bar collapse, mid-scroll,
      // which is the exact gesture `#glass-background`'s `lvh` sizing exists
      // to keep away from the GL canvas; without this guard the 2D canvas
      // took the same beating.
      //
      // Both dimensions must match to skip — `||` here would skip whenever
      // EITHER matched, and the address-bar case changes height while width
      // stays put, so the canvas would silently never resize at all.
      if (applied !== null && applied.width === width && applied.height === height) return
      applied = { width, height }

      canvas.width = width
      canvas.height = height
      canvas.style.width = `${window.innerWidth}px`
      canvas.style.height = `${window.innerHeight}px`
      // Reset any previously applied transform before re-applying the
      // device-pixel-ratio scale; without this, repeated resize/remounts
      // stack scale(dpr, dpr) on top of each other, which both inflates
      // sparks and makes clearRect miss most of the canvas (leaving
      // ghost trails of the previous frames).
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.scale(dpr, dpr)
    }

    resize()
    window.addEventListener('resize', resize)

    const draw = () => {
      // Use the CSS dimensions (logical pixels) for clearRect because
      // the context is already scaled by devicePixelRatio. Using
      // canvas.width / canvas.height here would only clear a
      // 1/dpr fraction of the visible area on hi-DPI displays.
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)
      const now = performance.now()

      sparksRef.current = sparksRef.current.filter((s) => now - s.startTime < duration)

      // The loop runs ONLY while sparks are alive. An always-on rAF was
      // clearing a full-viewport canvas 60×/s for a decorative effect
      // that is idle ~100% of the time — measurable battery drain on
      // phones. The clearRect above has already wiped the final frame,
      // so stopping here leaves a clean canvas.
      if (sparksRef.current.length === 0) {
        rafRef.current = null
        return
      }

      for (const spark of sparksRef.current) {
        const progress = (now - spark.startTime) / duration
        const eased = 1 - (1 - progress) * (1 - progress) // ease-out
        const dist = eased * radius
        const len = (1 - eased) * size
        const x1 = spark.x + dist * Math.cos(spark.angle)
        const y1 = spark.y + dist * Math.sin(spark.angle)
        const x2 = spark.x + (dist + len) * Math.cos(spark.angle)
        const y2 = spark.y + (dist + len) * Math.sin(spark.angle)

        ctx.strokeStyle = color
        ctx.globalAlpha = 1 - progress
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(x2, y2)
        ctx.stroke()
      }
      ctx.globalAlpha = 1

      rafRef.current = requestAnimationFrame(draw)
    }

    const handleClick = (e: MouseEvent) => {
      const now = performance.now()
      for (let i = 0; i < count; i++) {
        sparksRef.current.push({
          x: e.clientX,
          y: e.clientY,
          angle: (TWO_PI * i) / count,
          startTime: now,
        })
      }
      // Wake the loop for this burst (no-op if a burst is already running).
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(draw)
      }
    }

    document.addEventListener('click', handleClick)

    return () => {
      document.removeEventListener('click', handleClick)
      window.removeEventListener('resize', resize)
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      // Null the handle so a re-run of this effect (prop change) sees the
      // loop as stopped — otherwise the next click would skip its wake-up.
      rafRef.current = null
      sparksRef.current = []
    }
  }, [color, count, duration, radius, size])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-9998"
    />
  )
}
