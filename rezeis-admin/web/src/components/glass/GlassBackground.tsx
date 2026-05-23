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
import { Component, Suspense, useState, useEffect, useRef, useMemo, type ReactNode, type CSSProperties } from 'react'
import { useGlassStore, type BackgroundId } from '@/lib/theme/glass-store'
import { BG_COMPONENTS } from './backgrounds'

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
      return <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,oklch(0.25_0.04_260)_0%,oklch(0.08_0.02_260)_100%)]" />
    }
    return this.props.children
  }
}

// ── Main Component ───────────────────────────────────────────────────────────

interface BgState {
  enabled: boolean
  id: BackgroundId
  opacity: number
  props: Record<string, unknown>
}

const SUBSCRIBE_DEBOUNCE_MS = 300

function snapshotState(): BgState {
  const s = useGlassStore.getState()
  return {
    enabled: s.glassEnabled,
    id: s.background.id,
    opacity: s.background.opacity,
    props: s.background.props,
  }
}

export function GlassBackground() {
  const [bgState, setBgState] = useState<BgState>(snapshotState)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // Wait for zustand persist hydration before reading the final state.
    const handleHydration = () => {
      setBgState(snapshotState())
    }

    // If persist already hydrated (synchronously), use current state.
    if (useGlassStore.persist.hasHydrated()) {
      handleHydration()
    }
    const unsubHydration = useGlassStore.persist.onFinishHydration(handleHydration)

    // Subscribe to changes with debounce — only the background-related slice.
    const unsubStore = useGlassStore.subscribe((s, prev) => {
      const changed =
        s.glassEnabled !== prev.glassEnabled ||
        s.background.id !== prev.background.id ||
        s.background.opacity !== prev.background.opacity ||
        s.background.props !== prev.background.props
      if (!changed) return

      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        setBgState(snapshotState())
      }, SUBSCRIBE_DEBOUNCE_MS)
    })

    return () => {
      unsubHydration()
      unsubStore()
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  // Clamp opacity once per state change
  const opacity = Math.max(0.05, Math.min(1, bgState.opacity ?? 0.3))

  const wrapperStyle = useMemo<CSSProperties>(
    () => ({
      position: 'fixed',
      top: 0,
      left: 0,
      width: '100vw',
      height: '100vh',
      zIndex: 0,
      overflow: 'hidden',
      opacity,
      pointerEvents: 'none',
    }),
    [opacity],
  )

  if (!bgState.enabled || bgState.id === 'none') return null

  const BgComponent = BG_COMPONENTS[bgState.id]
  if (!BgComponent) return null

  return (
    <div id="glass-background" style={wrapperStyle} aria-hidden="true">
      <GlassErrorBoundary resetKey={bgState.id}>
        <Suspense fallback={null}>
          <BgComponent key={bgState.id} {...bgState.props} />
        </Suspense>
      </GlassErrorBoundary>
    </div>
  )
}
