/**
 * GlareHover — adds a glare/shine effect on hover that follows the cursor.
 * Inspired by React Bits GlareHover component.
 *
 * Uses refs + rAF-throttled DOM writes to avoid layout thrash with many
 * cards on screen. Mouse handlers are skipped when visualEffects is off.
 */
import { useEffect, useRef, useCallback, type ReactNode, type MouseEvent } from 'react'
import { useAppearanceStore } from '@/lib/theme/appearance-store'
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
  const visualEffects = useAppearanceStore((s) => s.visualEffects)

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
      onMouseMove={visualEffects ? handleMouseMove : undefined}
      onMouseEnter={visualEffects ? handleMouseEnter : undefined}
      onMouseLeave={visualEffects ? handleMouseLeave : undefined}
    >
      {children}
      {visualEffects && (
        <div
          ref={glareRef}
          className="pointer-events-none absolute inset-0 z-10 opacity-0 transition-opacity duration-200"
        />
      )}
    </div>
  )
}
