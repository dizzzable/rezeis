/**
 * GlassBackground — renders the selected React Bits background.
 *
 * Key design decisions:
 * - ErrorBoundary catches WebGL/Three.js/OGL crashes
 * - Debounced re-render to avoid rapid WebGL context creation/destruction
 * - key={bgId} forces full unmount→remount when background type changes
 * - Props come directly from store (per-background registry defaults)
 * - CSS gradient fallback on error
 */
import { Component, lazy, Suspense, useState, useEffect, useRef, type ReactNode } from 'react'
import { useGlassStore, type BackgroundId } from '@/lib/theme/glass-store'

// ── Error Boundary ───────────────────────────────────────────────────────────

interface EBState { hasError: boolean }

class GlassErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, EBState> {
  state: EBState = { hasError: false }

  static getDerivedStateFromError(): EBState {
    return { hasError: true }
  }

  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false })
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          width: '100%', height: '100%',
          background: 'radial-gradient(ellipse at center, oklch(0.25 0.04 260) 0%, oklch(0.08 0.02 260) 100%)',
        }} />
      )
    }
    return this.props.children
  }
}

// ── Lazy backgrounds ─────────────────────────────────────────────────────────

const backgrounds: Record<BackgroundId, React.LazyExoticComponent<React.ComponentType<Record<string, unknown>>> | null> = {
  none: null,
  silk: lazy(() => import('@/components/reactbits/Silk')),
  aurora: lazy(() => import('@/components/reactbits/Aurora')),
  threads: lazy(() => import('@/components/reactbits/Threads')),
  waves: lazy(() => import('@/components/reactbits/Waves')),
  iridescence: lazy(() => import('@/components/reactbits/Iridescence')),
  galaxy: lazy(() => import('@/components/reactbits/Galaxy')),
  particles: lazy(() => import('@/components/reactbits/Particles')),
  dotGrid: lazy(() => import('@/components/reactbits/DotGrid')),
  liquidChrome: lazy(() => import('@/components/reactbits/LiquidChrome')),
  balatro: lazy(() => import('@/components/reactbits/Balatro')),
  beams: lazy(() => import('@/components/reactbits/Beams')),
  plasma: lazy(() => import('@/components/reactbits/Plasma')),
  grainient: lazy(() => import('@/components/reactbits/Grainient')),
  softAurora: lazy(() => import('@/components/reactbits/SoftAurora')),
  dither: lazy(() => import('@/components/reactbits/Dither')),
  lineWaves: lazy(() => import('@/components/reactbits/LineWaves')),
  rippleGrid: lazy(() => import('@/components/reactbits/RippleGrid')),
  lightning: lazy(() => import('@/components/reactbits/Lightning')),
  radar: lazy(() => import('@/components/reactbits/Radar')),
}

// ── Main Component ───────────────────────────────────────────────────────────

interface BgState {
  enabled: boolean
  id: BackgroundId
  opacity: number
  props: Record<string, unknown>
}

export function GlassBackground() {
  // Debounced state from store to avoid rapid WebGL remounts
  const [bgState, setBgState] = useState<BgState>(() => {
    const s = useGlassStore.getState()
    return { enabled: s.glassEnabled, id: s.background.id, opacity: s.background.opacity, props: s.background.props }
  })
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // Initial hydration read (after persist loads from localStorage)
    const timer = setTimeout(() => {
      const s = useGlassStore.getState()
      setBgState({ enabled: s.glassEnabled, id: s.background.id, opacity: s.background.opacity, props: s.background.props })
    }, 150)

    // Subscribe to changes with debounce
    const unsub = useGlassStore.subscribe((s) => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        setBgState({ enabled: s.glassEnabled, id: s.background.id, opacity: s.background.opacity, props: s.background.props })
      }, 300) // 300ms debounce prevents rapid WebGL context churn
    })

    return () => {
      clearTimeout(timer)
      if (debounceRef.current) clearTimeout(debounceRef.current)
      unsub()
    }
  }, [])

  if (!bgState.enabled || bgState.id === 'none') return null

  const BgComponent = backgrounds[bgState.id]
  if (!BgComponent) return null

  const opacity = Math.max(0.05, Math.min(1, bgState.opacity ?? 0.3))

  return (
    <div
      id="glass-background"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        zIndex: 0,
        overflow: 'hidden',
        opacity,
      }}
      aria-hidden="true"
    >
      {/* Pointer-events blocker on top so bg doesn't steal clicks */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none' }} />
      {/* Background renders below the blocker */}
      <div style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
        <GlassErrorBoundary resetKey={bgState.id}>
          <Suspense fallback={null}>
            <BgComponent
              key={bgState.id}
              {...bgState.props}
            />
          </Suspense>
        </GlassErrorBoundary>
      </div>
    </div>
  )
}
