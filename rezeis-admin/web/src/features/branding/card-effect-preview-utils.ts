/** Pure card-preview helpers shared by the live renderer and configurator UI. */

import {
  CARD_EFFECT_CATALOG,
  cardEffectPalette,
  cardEffectRenderer,
  hasFullOutputGamut,
  isKnownCardEffect,
  type CardEffectId,
} from './card-effect-catalog'

// Re-exported so the big phone preview reads the catalog through the same
// module the tile preview does, rather than keeping its own copy — which is
// exactly how the stale gamut set got there in the first place.
export { hasFullOutputGamut }

// Which effects need WebGL2, which draw on a plain canvas, which palette each
// falls back to, and which escape their input gamut: all of it now comes from
// the catalog, stated once beside the effect it describes. The four hand-kept
// sets that used to sit here are precisely what this file existed to keep in
// step with the cabinet, and precisely what kept slipping.

/**
 * The Paper Shaders family, still named as a group because the preview arranges
 * them together. Derived from the catalog so the membership cannot drift.
 */
export const PAPER_CARD_EFFECTS = new Set(
  Object.keys(CARD_EFFECT_CATALOG).filter((id) => id.startsWith('paper')),
)

export function resolveCardEffectPreviewOpacity(opacity: number): number {
  return Math.min(Math.max(Number.isFinite(opacity) ? opacity : 1, 0.05), 1)
}

export function isPreviewCardEffect(effect: string): effect is CardEffectId {
  return effect !== 'NONE' && isKnownCardEffect(effect)
}

export function requiresPreviewCardEffectWebGL(effect: string): boolean {
  const renderer = cardEffectRenderer(effect)
  // `'NONE'` and anything the panel does not have draw nothing, so they ask
  // nothing of the GPU.
  return renderer !== null && renderer !== 'canvas2d'
}

export function requiresPreviewCardEffectCanvas2d(effect: string): boolean {
  return cardEffectRenderer(effect) === 'canvas2d'
}

export function requiresPreviewCardEffectWebGL2(effect: string): boolean {
  return cardEffectRenderer(effect) === 'webgl2'
}

export function resolveCardEffectPreviewColors(
  effect: string,
  props: Readonly<Record<string, unknown>>,
): readonly string[] {
  const fromArray = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((entry): entry is string => isSafeHexColor(entry))
      : []
  const asHex = (value: unknown): string | null =>
    isSafeHexColor(value) ? value : null

  /**
   * Every prop is inspected, rather than a fixed list of prop names.
   *
   * The list was thirteen hand-written keys, and the effects that arrived since
   * do not use those names — `background`, `bgColor`, `voidColor`,
   * `strokeColor`, `particleColor`, `anchor`, `colorA`… A missing name is not a
   * harmless omission, because a PARTIAL match is worse than none: the caller
   * treats any non-empty result as authoritative and stops falling back to the
   * effect's palette, so whatever was recognised becomes the whole picture.
   * Black Hole showed it: three white marks recognised, its black field not, so
   * contrast concluded the card was white.
   *
   * Kept in step with `resolveCardEffectColors` in the cabinet, which does the
   * same. A difference between the two IS the divergence between what the
   * operator previews and what the subscriber gets.
   */
  const colors = Object.values(props).flatMap((value) => {
    const single = asHex(value) ?? rgbVectorColor(value)
    if (single !== null) return [single]
    return fromArray(value)
  })

  if (effect === 'rippleGrid' && props['enableRainbow'] === true) {
    colors.push('#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff')
  }
  if (['dither', 'radar', 'plasma', 'beams', 'galaxy'].includes(effect)) {
    colors.push('#000000')
  }
  if (['liquidChrome', 'galaxy'].includes(effect)) colors.push('#ffffff')

  return colors.length > 0 ? [...new Set(colors)] : cardEffectPalette(effect)
}

export function resolveCardEffectPreviewOutputColors(
  effect: string,
  props: Readonly<Record<string, unknown>>,
): readonly string[] {
  const colors = [...resolveCardEffectPreviewColors(effect, props)]
  if (hasFullOutputGamut(effect)) {
    colors.push('#000000', '#ffffff')
  }
  return [...new Set(colors)]
}

export function buildCardEffectPreviewArtwork(colors: readonly string[]): string {
  const first = colors[0] ?? '#5227FF'
  const middle = colors[Math.floor((colors.length - 1) / 2)] ?? first
  const last = colors.at(-1) ?? middle
  // Keep fallback art translucent at every selected opacity. The configured
  // gradient is the card foundation; a fallback must enhance it, never replace
  // it with a full-frame palette of its own.
  return `radial-gradient(70% 110% at 4% 100%, ${first} 0%, transparent 72%), radial-gradient(66% 100% at 100% 2%, ${last} 0%, transparent 72%), radial-gradient(54% 66% at 52% 50%, ${middle} 0%, transparent 82%)`
}

/** Opaque, palette-faithful artwork for the small effect picker thumbnails. */
export function buildCardEffectThumbnailArtwork(colors: readonly string[]): string {
  const visibleColors = colors.filter((color) => !/^#0{3,8}$/i.test(color))
  const palette = visibleColors.length > 0 ? visibleColors : colors
  const first = palette[0] ?? '#5227FF'
  const middle = palette[Math.floor((palette.length - 1) / 2)] ?? first
  const last = palette.at(-1) ?? middle

  return `${buildCardEffectPreviewArtwork(colors)}, linear-gradient(135deg, ${first} 0%, ${middle} 52%, ${last} 100%)`
}

/**
 * How long a lost context has to come back before it counts as a failure.
 *
 * WHY THE FAILURE IS DELAYED AT ALL. It cannot be reported first and withdrawn
 * later: a reported failure resolves the preview to `css-fallback`, which
 * unmounts the effect — taking the canvas, and therefore the only thing that
 * could ever hear `webglcontextrestored`, out of the document. So the choice is
 * to wait or to be permanently deaf, and this is the wait.
 *
 * Kept in step with `CARD_EFFECT_CONTEXT_RESTORE_GRACE_MS` in the cabinet
 * (`reiwa/web/src/components/reactbits/card-effect-layer-utils.ts`). A
 * difference between the two is a difference between what the operator sees
 * after a GPU event and what the subscriber sees.
 */
export const PREVIEW_CONTEXT_RESTORE_GRACE_MS = 2_000

/**
 * Detect explicit and silent canvas initialisation failures in live preview.
 *
 * WHAT WENT WRONG. Every `webglcontextlost` was a permanent failure. This
 * handler never called `event.preventDefault()` — and per the WebGL spec that is
 * the only thing that asks the user agent to restore a context, so without it
 * `webglcontextrestored` can never fire at all — and it never listened for the
 * restore either. One transient GPU event (sleep/wake, a driver reset, WebKit
 * recycling a context under its cap) therefore stranded the operator's preview
 * as a static card until the page was reloaded, and there is not even a failure
 * COUNT here: the caller latches a single `failedScope`.
 *
 * `onContextRestored` is how a restorable loss actually gets restored. It
 * returns whether the caller took the rebuild; a caller that has spent its
 * rebuild budget answers `false` and the loss becomes an ordinary failure at
 * once, which is what stops a GPU that keeps losing and restoring from driving
 * an unbounded rebuild loop. With no callback every loss is still a failure,
 * only later.
 *
 * A loss on a canvas that has left the document is this app's own teardown —
 * every effect ends its cleanup by destroying its context, and the event arrives
 * one task later. It is neither `preventDefault`ed (that would ask the browser
 * to restore a slot being deliberately handed back) nor reported.
 */
export function observePreviewCardEffectCanvases(
  root: HTMLElement,
  onFailure: () => void,
  timeoutMs = 1_200,
  requiredContext: 'any' | '2d' = 'any',
  onContextRestored?: () => boolean,
  restoreGraceMs = PREVIEW_CONTEXT_RESTORE_GRACE_MS,
): () => void {
  const listeners = new Map<HTMLCanvasElement, () => void>()
  const awaitingRestore = new Map<HTMLCanvasElement, number>()
  let sawUsableCanvas = false

  const supportsRequiredContext = (canvas: HTMLCanvasElement): boolean => {
    if (requiredContext !== '2d') return true
    try {
      return canvas.getContext('2d') !== null
    } catch {
      return false
    }
  }

  const stopWaiting = (canvas: HTMLCanvasElement): boolean => {
    const timer = awaitingRestore.get(canvas)
    if (timer === undefined) return false
    window.clearTimeout(timer)
    awaitingRestore.delete(canvas)
    return true
  }

  const observeCanvas = () => {
    root.querySelectorAll('canvas').forEach((canvas) => {
      if (!supportsRequiredContext(canvas)) {
        onFailure()
        return
      }
      sawUsableCanvas = true
      if (listeners.has(canvas)) return

      const handleContextLost = (event: Event) => {
        if (!canvas.isConnected) return
        // Not a gesture event: this blocks nothing. It is the whole difference
        // between a context that can come back and one that cannot.
        event.preventDefault()
        if (awaitingRestore.has(canvas)) return
        awaitingRestore.set(
          canvas,
          window.setTimeout(() => {
            awaitingRestore.delete(canvas)
            onFailure()
          }, restoreGraceMs),
        )
      }

      const handleContextRestored = () => {
        if (!stopWaiting(canvas)) return
        if (onContextRestored?.() === true) return
        onFailure()
      }

      canvas.addEventListener('webglcontextlost', handleContextLost)
      canvas.addEventListener('webglcontextrestored', handleContextRestored)
      canvas.addEventListener('webglcontextcreationerror', onFailure)
      listeners.set(canvas, () => {
        stopWaiting(canvas)
        canvas.removeEventListener('webglcontextlost', handleContextLost)
        canvas.removeEventListener('webglcontextrestored', handleContextRestored)
        canvas.removeEventListener('webglcontextcreationerror', onFailure)
      })
    })
  }

  const observer = new MutationObserver(observeCanvas)
  observer.observe(root, { childList: true, subtree: true })
  observeCanvas()
  const readinessTimer = window.setTimeout(() => {
    if (!sawUsableCanvas) onFailure()
  }, timeoutMs)

  return () => {
    window.clearTimeout(readinessTimer)
    observer.disconnect()
    listeners.forEach((remove) => remove())
  }
}

/**
 * Recognisable CSS colour forms, matching `asColor` in the cabinet's
 * `card-effect-runtime.ts` exactly.
 *
 * Hex alone is not enough now that every prop is inspected: several effects
 * ship `rgba(…)` or `transparent` defaults, and a preview that ignored them
 * while the cabinet read them would put the two contrast decisions on different
 * evidence — the divergence this file is supposed to prevent. Anchored, so a
 * value like `checks` or the word a globe spells is not mistaken for a colour
 * and cannot reach the gradient string built below.
 */
function isSafeHexColor(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})|(?:rgb|hsl)a?\([^()]*\)|transparent)$/i.test(
      value.trim(),
    )
  )
}

function rgbVectorColor(value: unknown): string | null {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((channel) => typeof channel !== 'number' || !Number.isFinite(channel))
  ) {
    return null
  }
  const scale = value.every((channel) => channel >= 0 && channel <= 1) ? 255 : 1
  return `#${value
    .map((channel) =>
      Math.round(Math.min(255, Math.max(0, channel * scale)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}
