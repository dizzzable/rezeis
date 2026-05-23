/**
 * EffectsProvider — renders global cursor and click effects based on
 * the effects-store selection. Wraps the app and provides the chosen
 * cursor/click effect as a fixed overlay.
 */
import { lazy, Suspense, type ReactNode } from 'react'
import { useEffectsStore } from '@/lib/theme/effects-store'
import { useAppearanceStore } from '@/lib/theme/appearance-store'

// ── Lazy-loaded cursor effects ───────────────────────────────────────────────

const SplashCursor = lazy(() => import('@/components/reactbits/SplashCursor'))
const BlobCursor = lazy(() => import('@/components/reactbits/BlobCursor'))
const GhostCursor = lazy(() => import('@/components/reactbits/GhostCursor'))
const Crosshair = lazy(() => import('@/components/reactbits/Crosshair'))
const MagnetLines = lazy(() => import('@/components/reactbits/MagnetLines'))
const PixelTrail = lazy(() => import('@/components/reactbits/PixelTrail'))

// ── Lazy-loaded click effects ────────────────────────────────────────────────

const ClickSpark = lazy(() => import('@/components/reactbits/ClickSpark'))

// ── Provider ─────────────────────────────────────────────────────────────────

export function EffectsProvider({ children }: { children: ReactNode }) {
  const visualEffects = useAppearanceStore((s) => s.visualEffects)
  const effectsEnabled = useEffectsStore((s) => s.effectsEnabled)
  const cursorEffect = useEffectsStore((s) => s.cursorEffect)
  const clickEffect = useEffectsStore((s) => s.clickEffect)

  const isActive = visualEffects && effectsEnabled

  // ClickSpark wraps children to capture click events
  const content = isActive && clickEffect === 'spark'
    ? <ClickSparkWrapper>{children}</ClickSparkWrapper>
    : <>{children}</>

  return (
    <>
      {content}
      {isActive && (
        <Suspense fallback={null}>
          <CursorEffectRenderer effect={cursorEffect} />
        </Suspense>
      )}
    </>
  )
}

// ── Click Spark Wrapper ──────────────────────────────────────────────────────

function ClickSparkWrapper({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<>{children}</>}>
      <ClickSpark sparkColor="#aa1d8b" sparkCount={10} sparkRadius={25} duration={500}>
        {children}
      </ClickSpark>
    </Suspense>
  )
}

// ── Cursor Effect Renderer ───────────────────────────────────────────────────

function CursorEffectRenderer({ effect }: { effect: string }) {
  switch (effect) {
    case 'splash':
      return <SplashCursor TRANSPARENT={true} RAINBOW_MODE={true} />
    case 'blob':
      return (
        <div className="fixed inset-0 z-[9999] pointer-events-none">
          <BlobCursor fillColor="#aa1d8b" trailCount={3} zIndex={9999} />
        </div>
      )
    case 'ghost':
      return <GhostCursor />
    case 'crosshair':
      return <Crosshair />
    case 'magnetLines':
      return <MagnetLines />
    case 'pixelTrail':
      return <PixelTrail />
    default:
      return null
  }
}
