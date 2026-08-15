/**
 * Noise — a subtle SVG noise texture overlay for glass-card surfaces.
 * Inspired by React Bits Noise component.
 *
 * Each instance gets a unique filter ID via useId() to avoid SVG filter
 * collisions when multiple Noise components are rendered on the same page.
 */
import { useId } from 'react'
import { useEffectsActive } from '@/lib/theme/effects-active'
import { cn } from '@/lib/utils'

interface NoiseProps {
  className?: string
  /** Opacity of the noise layer (0–1) */
  opacity?: number
}

export function Noise({ className, opacity = 0.03 }: NoiseProps) {
  const effectsActive = useEffectsActive()
  const filterId = useId()

  // Returning null drops the whole `<feTurbulence>` subtree, not just its
  // opacity: the filter is re-evaluated by the compositor for every repaint of
  // the surface underneath, which is the cost the operator's switch is for.
  if (!effectsActive) return null

  return (
    <div
      className={cn('pointer-events-none absolute inset-0 z-1 mix-blend-overlay', className)}
      style={{ opacity }}
      aria-hidden="true"
    >
      <svg className="h-full w-full" xmlns="http://www.w3.org/2000/svg">
        <filter id={filterId}>
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.8"
            numOctaves="4"
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#${filterId})`} />
      </svg>
    </div>
  )
}
