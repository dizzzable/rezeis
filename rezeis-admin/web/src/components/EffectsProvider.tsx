/**
 * EffectsProvider — renders global cursor and click effects based on
 * the effects-store selection. Effects are rendered as fixed-position
 * sibling overlays so they never affect the children's layout.
 *
 * Cursor effects are mounted inside a shared FixedOverlay container
 * (`position: fixed; inset: 0; pointer-events: none; z-index: 9999`) so
 * components that internally use `position: absolute inset-0` (GhostCursor,
 * PixelTrail, BlobCursor) anchor to the viewport instead of collapsing to
 * the document flow.
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

// ── Fixed overlay wrapper ────────────────────────────────────────────────────

/**
 * Standard wrapper for cursor effects that need a positioned parent.
 * Most React Bits cursor components use `position: absolute inset-0` and
 * size their canvas/Three.js context against the parent — without a fixed
 * positioned parent they collapse to the document flow and break the layout.
 */
function FixedOverlay({ children }: { children: ReactNode }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[9999] overflow-hidden"
    >
      {children}
    </div>
  )
}

// ── Cursor Effect Renderer ───────────────────────────────────────────────────

function CursorEffectRenderer({ effect }: { effect: CursorEffectId }) {
  switch (effect) {
    case 'none':
      return null

    // SplashCursor mounts its own fixed full-screen canvas
    case 'splash':
      return (
        <div aria-hidden="true">
          <SplashCursor TRANSPARENT={true} RAINBOW_MODE={true} />
        </div>
      )

    // Crosshair internally sets position:fixed when no containerRef
    case 'crosshair':
      return (
        <div aria-hidden="true">
          <Crosshair />
        </div>
      )

    // BlobCursor needs a positioned parent
    case 'blob':
      return (
        <FixedOverlay>
          <BlobCursor fillColor="#aa1d8b" trailCount={3} zIndex={9999} />
        </FixedOverlay>
      )

    // GhostCursor uses absolute inset-0 — needs fixed parent
    case 'ghost':
      return (
        <FixedOverlay>
          <GhostCursor />
        </FixedOverlay>
      )

    // PixelTrail mounts a Canvas with absolute z-1 — needs fixed parent
    case 'pixelTrail':
      return (
        <FixedOverlay>
          <PixelTrail color="#aa1d8b" />
        </FixedOverlay>
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
