/**
 * EffectsProvider — renders global cursor and click effects based on
 * the effects-store selection. Effects are rendered as fixed-position
 * sibling overlays so they never affect the children's layout.
 */
import { lazy, Suspense, type ReactNode } from 'react'
import {
  useEffectsStore,
  type CursorEffectId,
  type ClickEffectId,
} from '@/lib/theme/effects-store'
import { useAppearanceStore } from '@/lib/theme/appearance-store'
import { ClickSparkOverlay } from './effects/ClickSparkOverlay'

// ── Lazy-loaded cursor effects ───────────────────────────────────────────────

const SplashCursor = lazy(() => import('@/components/reactbits/SplashCursor'))
const BlobCursor = lazy(() => import('@/components/reactbits/BlobCursor'))
const GhostCursor = lazy(() => import('@/components/reactbits/GhostCursor'))
const Crosshair = lazy(() => import('@/components/reactbits/Crosshair'))
const MagnetLines = lazy(() => import('@/components/reactbits/MagnetLines'))
const PixelTrail = lazy(() => import('@/components/reactbits/PixelTrail'))

// ── Provider ─────────────────────────────────────────────────────────────────

export function EffectsProvider({ children }: { children: ReactNode }) {
  const visualEffects = useAppearanceStore((s) => s.visualEffects)
  const effectsEnabled = useEffectsStore((s) => s.effectsEnabled)
  const cursorEffect = useEffectsStore((s) => s.cursorEffect)
  const clickEffect = useEffectsStore((s) => s.clickEffect)

  const isActive = visualEffects && effectsEnabled

  return (
    <>
      {children}
      {isActive && (
        <Suspense fallback={null}>
          <CursorEffectRenderer effect={cursorEffect} />
        </Suspense>
      )}
      {isActive && <ClickEffectRenderer effect={clickEffect} />}
    </>
  )
}

// ── Cursor Effect Renderer ───────────────────────────────────────────────────

function CursorEffectRenderer({ effect }: { effect: CursorEffectId }) {
  switch (effect) {
    case 'none':
      return null
    case 'splash':
      return (
        <div aria-hidden="true">
          <SplashCursor TRANSPARENT={true} RAINBOW_MODE={true} />
        </div>
      )
    case 'blob':
      return (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-[9999]"
        >
          <BlobCursor fillColor="#aa1d8b" trailCount={3} zIndex={9999} />
        </div>
      )
    case 'ghost':
      return (
        <div aria-hidden="true">
          <GhostCursor />
        </div>
      )
    case 'crosshair':
      return (
        <div aria-hidden="true">
          <Crosshair />
        </div>
      )
    case 'magnetLines':
      return (
        <div aria-hidden="true">
          <MagnetLines />
        </div>
      )
    case 'pixelTrail':
      return (
        <div aria-hidden="true">
          <PixelTrail />
        </div>
      )
    default:
      return null
  }
}

// ── Click Effect Renderer ────────────────────────────────────────────────────

function ClickEffectRenderer({ effect }: { effect: ClickEffectId }) {
  switch (effect) {
    case 'none':
      return null
    case 'spark':
      return <ClickSparkOverlay color="#aa1d8b" count={10} radius={25} duration={500} />
    case 'starBorder':
      // Star Border requires per-element integration, not a global overlay.
      // Reserved for future implementation.
      return null
    default:
      return null
  }
}
