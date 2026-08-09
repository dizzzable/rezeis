/** Runtime-safe renderer for the WEB Reiwa card preview. */

import {
  Component,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { CARD_EFFECT_COMPONENTS, type CardEffectId } from './card-effect-registry'
import {
  buildCardEffectPreviewArtwork,
  isPreviewCardEffect,
  observePreviewCardEffectCanvases,
  requiresPreviewCardEffectCanvas2d,
  requiresPreviewCardEffectWebGL,
  requiresPreviewCardEffectWebGL2,
  resolveCardEffectPreviewColors,
  resolveCardEffectPreviewOpacity,
} from './card-effect-preview-utils'

import './card-effect-preview-runtime.css'

interface CardEffectCapabilities {
  readonly canvas2d: boolean
  readonly webgl: boolean
  readonly webgl2: boolean
}

type CardEffectPreviewRuntime =
  | 'probing'
  | 'native'
  | 'css-fallback'

/**
 * How many times one preview may be rebuilt after a restorable context loss
 * before the loss is treated as the permanent kind.
 *
 * A restored context is a real recovery, so the honest response is to rebuild:
 * only a handful of catalog components can heal themselves, and the rest come
 * back to a canvas whose GL handles the loss detached. But "the browser restored
 * it" is not a promise that it will stay, and a GPU that keeps losing and
 * restoring would otherwise drive an unbounded rebuild loop, each turn of it
 * allocating another context under WebKit's sixteen. Budget is per `scope`, so
 * anything the operator changes starts again. Kept in step with
 * `MAX_CONTEXT_RESTORES` in the cabinet's `card-effect-layer.tsx`.
 */
const MAX_CONTEXT_RESTORES = 2

class PreviewEffectErrorBoundary extends Component<{
  readonly children: ReactNode
  readonly resetKey: string
  readonly onError: () => void
}, { hasError: boolean; resetKey: string }> {
  state = { hasError: false, resetKey: this.props.resetKey }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  static getDerivedStateFromProps(
    props: { readonly resetKey: string },
    state: { readonly hasError: boolean; readonly resetKey: string },
  ) {
    return props.resetKey === state.resetKey
      ? null
      : { hasError: false, resetKey: props.resetKey }
  }

  componentDidCatch() {
    this.props.onError()
  }

  render() {
    return this.state.hasError ? null : this.props.children
  }
}

function EffectReadySignal({
  presentationKey,
  onReady,
}: {
  readonly presentationKey: string
  readonly onReady: (key: string) => void
}) {
  useEffect(() => {
    onReady(presentationKey)
  }, [onReady, presentationKey])

  return null
}

function detectCapabilities(): CardEffectCapabilities {
  if (typeof document === 'undefined') {
    return { canvas2d: false, webgl: false, webgl2: false }
  }

  const probe = (kind: 'webgl' | 'webgl2'): boolean => {
    const canvas = document.createElement('canvas')
    try {
      const context = canvas.getContext(kind, {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: 'low-power',
      })
      if (context === null || !('getExtension' in context)) return false
      const loseContext = context.getExtension('WEBGL_lose_context') as
        | { loseContext?: () => void }
        | null
      loseContext?.loseContext?.()
      return true
    } catch {
      return false
    }
  }

  const webgl2 = probe('webgl2')
  const canvas2d = (() => {
    try {
      return document.createElement('canvas').getContext('2d') !== null
    } catch {
      return false
    }
  })()
  return { canvas2d, webgl2, webgl: webgl2 || probe('webgl') }
}

export function CardEffectPreviewLayer({
  effect,
  props,
  opacity,
}: {
  readonly effect: string
  readonly props: Readonly<Record<string, unknown>>
  readonly opacity: number
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [capabilitySnapshot, setCapabilitySnapshot] = useState<{
    readonly scope: string
    readonly capabilities: CardEffectCapabilities
  } | null>(null)
  const [failedScope, setFailedScope] = useState<string | null>(null)
  const [readyKey, setReadyKey] = useState<string | null>(null)
  const propsKey = useMemo(() => JSON.stringify(props), [props])
  const scope = `${effect}:${propsKey}`
  const valid = isPreviewCardEffect(effect)

  /**
   * Rebuild the renderer after a context came back.
   *
   * A restored context is not the one the effect was drawing with: every GL
   * handle it holds was detached by the loss, and almost no component in the
   * catalog rebuilds itself. Bumping the generation changes the renderer's
   * `key`, so React unmounts the effect and mounts a fresh one on a fresh
   * context.
   *
   * Returns whether the rebuild was taken. `false` hands the loss back to the
   * observer as an ordinary failure, which is what keeps the budget from being a
   * suggestion. The budget lives in a ref rather than in state because the
   * observer needs the answer synchronously, inside the DOM event.
   */
  const restoreBudgetRef = useRef<{ scope: string; used: number } | null>(null)
  const [rendererGeneration, setRendererGeneration] = useState(0)
  const requestRendererRebuild = useCallback(() => {
    const budget = restoreBudgetRef.current
    const used = budget?.scope === scope ? budget.used : 0
    if (used >= MAX_CONTEXT_RESTORES) return false
    restoreBudgetRef.current = { scope, used: used + 1 }
    setRendererGeneration((generation) => generation + 1)
    return true
  }, [scope])

  // The probe allocates a temporary canvas, so schedule it after React has
  // committed the unchanging gradient/pattern baseline instead of performing
  // browser work during render. The one-frame probing state intentionally has
  // no effect layer and therefore cannot flash a foreign colour.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const frame = window.requestAnimationFrame(() => {
      setCapabilitySnapshot({
        scope: effect,
        capabilities:
          valid &&
          (requiresPreviewCardEffectWebGL(effect) ||
            requiresPreviewCardEffectCanvas2d(effect))
            ? detectCapabilities()
            : { canvas2d: false, webgl: false, webgl2: false },
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [effect, valid])

  const capabilities = capabilitySnapshot?.scope === effect
    ? capabilitySnapshot.capabilities
    : null
  const effectFailed = failedScope === scope
  const runtime: CardEffectPreviewRuntime | null =
    !valid
      ? null
      : capabilities === null
        ? 'probing'
        : effectFailed
          ? 'css-fallback'
          : requiresPreviewCardEffectCanvas2d(effect)
            ? capabilities.canvas2d
              ? 'native'
              : 'css-fallback'
            : !requiresPreviewCardEffectWebGL(effect)
              ? 'native'
            : !capabilities.webgl || (requiresPreviewCardEffectWebGL2(effect) && !capabilities.webgl2)
              ? 'css-fallback'
              : 'native'
  const runtimeEffect: CardEffectId | null = !valid ? null : effect
  const Effect = runtimeEffect === null || runtime === 'css-fallback' || runtime === 'probing' || runtime === null
    ? null
    : CARD_EFFECT_COMPONENTS[runtimeEffect]
  const runtimeProps = props
  const overlayOpacity = resolveCardEffectPreviewOpacity(opacity)
  // `gen-` is what makes a rebuild after a restored context a NEW presentation:
  // readiness has to be handshaken again and the canvas observer is rebuilt
  // around the new canvas.
  const presentationKey = `${scope}:${runtime}:gen-${rendererGeneration}`
  const isReady = runtime === 'css-fallback' || readyKey === presentationKey
  const rendererCommitted = Effect !== null && readyKey === presentationKey

  useEffect(() => {
    // A lazy component can stay suspended for arbitrarily long while its
    // chunk downloads. Start the no-canvas watchdog only after a child inside
    // that Suspense boundary has actually committed. From this point a blank
    // renderer is a real initialisation failure, not network latency.
    if (!rendererCommitted) return
    const root = rootRef.current
    if (root === null || typeof MutationObserver === 'undefined') return

    const markFailed = () => setFailedScope(scope)
    return observePreviewCardEffectCanvases(
      root,
      markFailed,
      1_200,
      requiresPreviewCardEffectCanvas2d(effect) ? '2d' : 'any',
      requestRendererRebuild,
    )
  }, [effect, rendererCommitted, requestRendererRebuild, scope])

  if (!valid || runtime === null) return null

  return (
    <div
      ref={rootRef}
      aria-hidden="true"
      data-preview-card-layer="effect"
      data-preview-card-effect-runtime={runtime}
      data-preview-card-effect-ready={isReady ? 'true' : 'false'}
      data-preview-card-effect-foundation="transparent"
      className="absolute inset-0"
      style={{
        overflow: 'hidden',
        // Match the public Reiwa card: operator-selected artwork uses normal
        // source-over alpha. `screen` silently recoloured the gradient below
        // it, so this preview used to reproduce the same misleading result.
      }}
    >
      {runtime === 'css-fallback' && (
        <div
          data-preview-card-effect-artwork
          className="card-effect-preview__css-artwork absolute inset-0"
          style={{
            backgroundImage: buildCardEffectPreviewArtwork(
              resolveCardEffectPreviewColors(effect, props),
            ),
            opacity: overlayOpacity,
          }}
        />
      )}
      {Effect !== null && (
        <PreviewEffectErrorBoundary
          resetKey={presentationKey}
          onError={() => setFailedScope(scope)}
        >
          <Suspense fallback={null}>
            <div
              data-preview-card-effect-renderer
              data-preview-card-effect-renderer-source={runtimeEffect}
              className="absolute inset-0"
              style={{ opacity: overlayOpacity }}
            >
              {/* The generation is part of the key, not decoration: a restored
                  context needs a NEW component instance on a NEW canvas, and
                  re-rendering the same one would keep the GL handles the loss
                  detached. */}
              <Effect key={`${runtimeEffect}:${rendererGeneration}`} {...runtimeProps} />
            </div>
            <EffectReadySignal
              presentationKey={presentationKey}
              onReady={setReadyKey}
            />
          </Suspense>
        </PreviewEffectErrorBoundary>
      )}
    </div>
  )
}
