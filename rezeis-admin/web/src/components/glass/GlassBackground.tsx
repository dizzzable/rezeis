/**
 * GlassBackground — renders the selected React Bits background.
 *
 * Key design decisions:
 * - ErrorBoundary catches WebGL/Three.js/OGL crashes
 * - Debounced re-render to avoid rapid WebGL context creation/destruction
 * - key={bgId} forces full unmount→remount when background type changes
 * - Props come directly from store (per-background registry defaults)
 * - Transparent fallback on error so the selected concept remains visible
 * - Auth gate: the animated (WebGL/rAF) background only mounts once the
 *   operator is authenticated. The sign-in screen gets a static CSS
 *   gradient instead — a full-screen fragment shader was the main reason
 *   /sign-in ran hot (and throttled) on iPhones.
 */
import { Component, Suspense, useState, useEffect, useRef, useMemo, type ReactNode, type CSSProperties } from 'react'
import { useGlassStore, type BackgroundId } from '@/lib/theme/glass-store'
import { useAuth } from '@/features/auth/auth-provider'
import { BG_COMPONENTS, BG_LOADERS } from './backgrounds'

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
      return <div className="absolute inset-0 bg-transparent" />
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

/**
 * Static stand-in shown while unauthenticated. Approximates the default
 * `liquidChrome` palette (near-black with a magenta/violet sheen) with a
 * plain CSS gradient: zero WebGL contexts, zero rAF loops, nothing for a
 * phone to throttle while the operator types a password.
 */
const STATIC_BACKGROUND: CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: [
    'radial-gradient(120% 90% at 18% 8%, oklch(0.45 0.16 340 / 22%), transparent 60%)',
    'radial-gradient(110% 85% at 85% 90%, oklch(0.4 0.14 300 / 18%), transparent 62%)',
    'linear-gradient(160deg, #0c080a 0%, #150f16 48%, #0c080a 100%)',
  ].join(', '),
}

/** The shader layer, composited over the gradient once its chunk lands. */
const ANIMATED_LAYER: CSSProperties = {
  position: 'absolute',
  inset: 0,
  animation: 'glass-background-fade-in 420ms ease-out both',
}

/**
 * Warm a background chunk WITHOUT mounting it.
 *
 * The login moment concentrates a lot of work: the operator authenticates and
 * the dashboard chunk, its queries, the background chunk, a GL context and a
 * shader compile all land on the same frame — and for silk/beams/dither the
 * background chunk alone is the ~950 KB `vendor-three` bundle. Moving the
 * DOWNLOAD to the idle time the login screen has in abundance takes it off
 * that frame.
 *
 * Only the download and module evaluation: `BG_LOADERS[id]()` imports the
 * module, and every `reactbits/` module defines shader strings and functions
 * at the top level and nothing else. No canvas, no GL context, no rAF — the
 * pre-auth "nothing runs on the GPU" invariant is intact. Rendering the
 * `lazy()` component is what would break it, and that is exactly why the raw
 * loader is exported separately.
 */
function prefetchBackground(id: Exclude<BackgroundId, 'none'>): () => void {
  let cancelled = false
  const run = () => {
    if (cancelled) return
    void BG_LOADERS[id]?.().catch(() => {
      // A failed warm-up is a non-event: the `lazy()` component will retry
      // the same import when it actually mounts, and the ErrorBoundary
      // already covers the case where that fails too.
    })
  }
  // iOS Safari has no requestIdleCallback; a timeout keeps behaviour close
  // enough without ever competing with the login-critical requests.
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(run, { timeout: 4_000 })
    return () => {
      cancelled = true
      cancelIdleCallback(handle)
    }
  }
  const handle = setTimeout(run, 2_000)
  return () => {
    cancelled = true
    clearTimeout(handle)
  }
}

export function GlassBackground() {
  const { isAuthenticated } = useAuth()
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

  // Width/height live in index.css (`#glass-background`): 100lvh-based
  // sizing keeps the element at the LARGE viewport size, so the iOS
  // address-bar collapse (which only changes the small/dynamic viewport)
  // never resizes this container mid-scroll — see the CSS comment.
  const wrapperStyle = useMemo<CSSProperties>(
    () => ({
      position: 'fixed',
      top: 0,
      left: 0,
      zIndex: 0,
      overflow: 'hidden',
      opacity,
      pointerEvents: 'none',
    }),
    [opacity],
  )

  const active = bgState.enabled && bgState.id !== 'none' ? bgState.id : null

  // Warm the chunk during the login screen's idle time. Download only — see
  // `prefetchBackground`. Never post-auth: there the component is mounting
  // anyway and a second import would just race it.
  useEffect(() => {
    if (isAuthenticated || active === null) return
    return prefetchBackground(active)
  }, [isAuthenticated, active])

  if (active === null) return null

  const BgComponent = isAuthenticated ? BG_COMPONENTS[active] : null

  // The gradient is a PERMANENT layer, not a pre-auth substitute.
  //
  // It used to be swapped out wholesale the instant `isAuthenticated` flipped,
  // with `<Suspense fallback={null}>` behind it — so the first authenticated
  // frame showed a flat background (gradient gone, shader chunk still in
  // flight) and then the shader appeared on top of nothing. Two visible steps
  // where there should be none. Keeping the gradient underneath means the
  // background never goes flat, and the shader has something to fade onto.
  return (
    <div id="glass-background" style={wrapperStyle} aria-hidden="true">
      <div data-glass-background-static style={STATIC_BACKGROUND} />
      {BgComponent && (
        <GlassErrorBoundary resetKey={active}>
          {/* Still `fallback={null}`: the gradient above is already painted,
              so there is nothing for a fallback to stand in for. */}
          <Suspense fallback={null}>
            <div data-glass-background-animated style={ANIMATED_LAYER}>
              <BgComponent key={active} {...bgState.props} />
            </div>
          </Suspense>
        </GlassErrorBoundary>
      )}
    </div>
  )
}
