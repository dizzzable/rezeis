/**
 * Aurora — animated gradient background with flowing color blobs.
 * Inspired by React Bits Aurora component.
 *
 * The blobs are pre-blurred radial gradients moved with translate-only
 * transforms (see `.aurora-blob` in index.css). The previous version
 * animated `scale` on `blur(80–100px)` divs, which forced iOS to
 * re-rasterize a viewport-sized Gaussian blur every frame — one of the
 * main reasons /sign-in dropped frames and heated up iPhones.
 */
import { useAppearanceStore } from '@/lib/theme/appearance-store'
import { cn } from '@/lib/utils'

interface AuroraProps {
  className?: string
}

export function Aurora({ className }: AuroraProps) {
  const visualEffects = useAppearanceStore((s) => s.visualEffects)

  if (!visualEffects) return null

  return (
    <div
      className={cn(
        'aurora-bg pointer-events-none absolute inset-0 -z-10 overflow-hidden',
        className,
      )}
      aria-hidden="true"
    >
      <div className="aurora-blob aurora-blob--1 animate-aurora-1" />
      <div className="aurora-blob aurora-blob--2 animate-aurora-2" />
      <div className="aurora-blob aurora-blob--3 animate-aurora-3" />
    </div>
  )
}
