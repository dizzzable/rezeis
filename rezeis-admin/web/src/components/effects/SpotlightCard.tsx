/**
 * SpotlightCard — a card wrapper that renders a radial gradient spotlight
 * following the user's cursor. Inspired by React Bits SpotlightCard.
 *
 * Performance notes:
 * - Uses refs + direct DOM manipulation (no re-renders on mousemove)
 * - rAF-throttled gradient updates so we never write more than once per frame,
 *   even with many cards on screen.
 * - Mouse handlers are skipped when visualEffects is disabled to avoid
 *   running rect math for nothing.
 */
import { useEffect, useRef, useCallback, type ReactNode, type MouseEvent } from 'react'
import { useAppearanceStore } from '@/lib/theme/appearance-store'
import { cn } from '@/lib/utils'

interface SpotlightCardProps {
  children: ReactNode
  className?: string
  /** Spotlight color — defaults to primary with low opacity */
  spotlightColor?: string
  /** Spotlight radius in px */
  radius?: number
}

export function SpotlightCard({
  children,
  className,
  spotlightColor = 'oklch(0.546 0.245 262.881 / 15%)',
  radius = 200,
}: SpotlightCardProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number | null>(null)
  const pendingPosRef = useRef<{ x: number; y: number } | null>(null)
  const visualEffects = useAppearanceStore((s) => s.visualEffects)

  // Cancel any pending rAF on unmount.
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [])

  const flushPending = useCallback(() => {
    rafRef.current = null
    const overlay = overlayRef.current
    const pos = pendingPosRef.current
    if (!overlay || !pos) return
    overlay.style.background = `radial-gradient(${radius}px circle at ${pos.x}px ${pos.y}px, ${spotlightColor}, transparent 80%)`
  }, [radius, spotlightColor])

  const handleMouseMove = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      const container = containerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      pendingPosRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      }
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(flushPending)
      }
    },
    [flushPending],
  )

  const handleMouseEnter = useCallback(() => {
    if (overlayRef.current) overlayRef.current.style.opacity = '1'
  }, [])

  const handleMouseLeave = useCallback(() => {
    if (overlayRef.current) overlayRef.current.style.opacity = '0'
  }, [])

  return (
    <div
      ref={containerRef}
      className={cn('spotlight-effect relative overflow-hidden', className)}
      onMouseMove={visualEffects ? handleMouseMove : undefined}
      onMouseEnter={visualEffects ? handleMouseEnter : undefined}
      onMouseLeave={visualEffects ? handleMouseLeave : undefined}
    >
      {visualEffects && (
        <div
          ref={overlayRef}
          className="pointer-events-none absolute inset-0 z-0 opacity-0 transition-opacity duration-300"
        />
      )}
      <div className="relative z-10">{children}</div>
    </div>
  )
}
