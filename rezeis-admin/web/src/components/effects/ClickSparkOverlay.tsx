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

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      canvas.width = window.innerWidth * dpr
      canvas.height = window.innerHeight * dpr
      canvas.style.width = `${window.innerWidth}px`
      canvas.style.height = `${window.innerHeight}px`
      ctx.scale(dpr, dpr)
    }

    resize()
    window.addEventListener('resize', resize)

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
    }

    document.addEventListener('click', handleClick)

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const now = performance.now()

      sparksRef.current = sparksRef.current.filter((s) => now - s.startTime < duration)

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

    rafRef.current = requestAnimationFrame(draw)

    return () => {
      document.removeEventListener('click', handleClick)
      window.removeEventListener('resize', resize)
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      sparksRef.current = []
    }
  }, [color, count, duration, radius, size])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[9998]"
    />
  )
}
