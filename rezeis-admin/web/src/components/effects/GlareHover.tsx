/**
 * GlareHover — adds a glare/shine effect on hover that follows the cursor.
 * Inspired by React Bits GlareHover component.
 *
 * Uses refs + rAF-throttled DOM writes to avoid layout thrash with many
 * cards on screen. Mouse handlers are skipped when effects are off — gated on
 * `useEffectsActive()`, not on the appearance flag alone, which nothing in the
 * UI ever clears and which therefore let the quick actions keep glinting after
 * the operator turned effects off. See lib/theme/effects-active.ts.
 */
import { useEffect, useRef, useCallback, type ReactNode, type MouseEvent } from 'react'
import { useEffectsActive } from '@/lib/theme/effects-active'
import { cn } from '@/lib/utils'

interface GlareHoverProps {
  children: ReactNode
  className?: string
  /** Glare color */
  glareColor?: string
}

export function GlareHover({
  children,
  className,
  glareColor = 'oklch(1 0 0 / 20%)',
}: GlareHoverProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const glareRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number | null>(null)
  const pendingPosRef = useRef<{ x: number; y: number } | null>(null)
  const effectsActive = useEffectsActive()

  // Also runs on the on→off transition, so a frame queued by the last mousemove
  // before the switch flipped never lands.
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [effectsActive])

  const flushPending = useCallback(() => {
    rafRef.current = null
    const glare = glareRef.current
    const pos = pendingPosRef.current
    if (!glare || !pos) return
    glare.style.background = `radial-gradient(circle at ${pos.x}% ${pos.y}%, ${glareColor}, transparent 60%)`
  }, [glareColor])

  const handleMouseMove = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      const container = containerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      pendingPosRef.current = {
        x: ((e.clientX - rect.left) / rect.width) * 100,
        y: ((e.clientY - rect.top) / rect.height) * 100,
      }
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(flushPending)
      }
    },
    [flushPending],
  )

  const handleMouseEnter = useCallback(() => {
    if (glareRef.current) glareRef.current.style.opacity = '1'
  }, [])

  const handleMouseLeave = useCallback(() => {
    if (glareRef.current) glareRef.current.style.opacity = '0'
  }, [])

  return (
    <div
      ref={containerRef}
      className={cn('glare-hover-effect relative overflow-hidden', className)}
      onMouseMove={effectsActive ? handleMouseMove : undefined}
      onMouseEnter={effectsActive ? handleMouseEnter : undefined}
      onMouseLeave={effectsActive ? handleMouseLeave : undefined}
    >
      {children}
      {effectsActive && (
        <div
          ref={glareRef}
          className="pointer-events-none absolute inset-0 z-10 opacity-0 transition-opacity duration-200"
        />
      )}
    </div>
  )
}
