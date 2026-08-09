/**
 * Paper Shaders wrappers (rezeis admin — configurator preview).
 * ─────────────────────────────────────────────────────────────
 * Mirror of `reiwa/web/src/components/reactbits/paper.tsx`. Thin adapters
 * around @paper-design/shaders-react so the WEB Reiwa configurator preview
 * renders the REAL shader at 100%×100%. Keep both in lockstep in BEHAVIOUR —
 * unlike the rest of this directory the two are deliberately not byte-identical,
 * because each is written in its own repository's house style.
 *
 * Apache-2.0 (Lost Coast Labs / paper.design); license ships in node_modules.
 */

import { useLayoutEffect, useRef } from 'react'
import {
  Dithering,
  GrainGradient,
  MeshGradient,
  Metaballs,
  Swirl,
  Warp,
  type DitheringProps,
  type GrainGradientProps,
  type MeshGradientProps,
  type MetaballsProps,
  type PaperShaderElement,
  type SwirlProps,
  type WarpProps,
} from '@paper-design/shaders-react'

import { RENDER_PIXEL_BUDGET } from './render-scale'

const FILL = { width: '100%', height: '100%' } as const

/**
 * Hard ceiling on Paper's drawing buffer, in device pixels.
 *
 * It is `RENDER_PIXEL_BUDGET` — the SAME number and the same rationale the
 * other forty-eight effects are capped by, deliberately imported rather than
 * restated. This file used to carry its own `1920 * 1080` with its own
 * argument for it; two constants that happened to agree is one refactor away
 * from two constants that do not, and the whole point of a budget is that a
 * mount costs the same whichever effect an operator picks.
 *
 * Why Paper needs a cap at all: `ShaderMount` renders at
 * `max(devicePixelRatio, minPixelRatio = 2)` — NATIVE DPR on every phone,
 * uncapped — and the package's own default `maxPixelCount` of 8,294,400 (4K)
 * starts binding only beyond 4K. A DPR-3 phone therefore shades 3.01M device
 * pixels per frame (393×852×3²) where the rest of the catalog is capped at
 * 2.07M, and the configurator's full-screen app-background preview multiplies
 * the bill by the whole viewport.
 *
 * Paper implements the cap itself, and implements it the right way: past the
 * ceiling it shrinks the back buffer and stretches it over the UNCHANGED CSS
 * box (`scaleToMeetMaxPixelCount` in `@paper-design/shaders`) — MDN's own
 * smaller-back-buffer mitigation, and exactly what `render-scale.ts` does for
 * everything else. So these six effects need the number and nothing more.
 *
 * Passed AFTER the props spread so saved JSON can never raise it.
 * `minPixelRatio` stays at the package default deliberately.
 */
const PAPER_MAX_PIXEL_COUNT = RENDER_PIXEL_BUDGET

/**
 * Release the WebGL context Paper owns.
 *
 * The renderer is inside the package: `ShaderMount` creates its own canvas and
 * calls `getContext('webgl2')` on it. Its `dispose()` does delete the program
 * and textures, disconnect its observers and remove the canvas — but it never
 * calls `WEBGL_lose_context.loseContext()`. Dropping the reference does not
 * return the slot; WebKit only frees one when the context object is destroyed,
 * and it caps a web-content process at 16 live contexts before it starts
 * recycling the oldest and handing out an unrecoverable SyntheticLostContext.
 * Six effects come out of this file, so a configurator that switches between
 * them reached that cap on its own.
 *
 * Reaching it from outside works because the parent <div> Paper renders is a
 * `PaperShaderElement`, which carries the mount, and `canvasElement` is public.
 * We call the package's own `dispose()` first so the GPU objects go before the
 * context does, then lose the context. Paper's own cleanup calls `dispose()`
 * again a moment later, which is a no-op by then.
 *
 * WHAT WENT WRONG: all of that ran from a `useEffect` cleanup that read
 * `elementRef.current` — and by then the ref is `null`, so the entire release
 * was a silent no-op and the contexts went on leaking exactly as before. The
 * comment that used to sit here blamed "React unmounts parents before children,
 * so this runs while the mount is still attached", which is not the mechanism
 * at issue: when React deletes a subtree it detaches refs during the MUTATION
 * phase, while passive cleanups for that subtree are deferred and flushed after
 * paint, so the ref is always cleared first no matter which way the tree is
 * walked. `paper-context-release.test.tsx` pins that ordering directly, because
 * it is the whole reason for the shape of this hook.
 *
 * Two changes, either of which would be enough, kept together deliberately:
 * the cleanup is a LAYOUT effect, which for a deletion runs parent-first inside
 * the mutation phase and therefore before React reaches the host element that
 * holds the ref; and the element is captured into a local on mount, so the
 * cleanup closes over it and never has to consult a ref at all.
 */
function usePaperContextRelease() {
  const elementRef = useRef<PaperShaderElement | null>(null)

  useLayoutEffect(() => {
    // Refs are attached during the mutation phase, before layout effects run,
    // so this is the element — not `null` and not a stale one. `paperShaderMount`
    // is NOT read here: Paper creates it later, from its own passive effect.
    const mountedElement = elementRef.current

    return () => {
      const element = mountedElement ?? elementRef.current
      if (element === null) return
      const mount = element.paperShaderMount
      const canvas = mount?.canvasElement ?? element.querySelector('canvas')
      mount?.dispose()
      canvas?.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }, [])

  return elementRef
}

export function PaperMesh(props: Record<string, unknown>) {
  const ref = usePaperContextRelease()
  return (
    <MeshGradient
      {...(props as unknown as MeshGradientProps)}
      maxPixelCount={PAPER_MAX_PIXEL_COUNT}
      ref={ref}
      style={FILL}
    />
  )
}

export function PaperWarp(props: Record<string, unknown>) {
  const ref = usePaperContextRelease()
  return <Warp {...(props as unknown as WarpProps)} maxPixelCount={PAPER_MAX_PIXEL_COUNT} ref={ref} style={FILL} />
}

export function PaperGrain(props: Record<string, unknown>) {
  const ref = usePaperContextRelease()
  return (
    <GrainGradient
      {...(props as unknown as GrainGradientProps)}
      maxPixelCount={PAPER_MAX_PIXEL_COUNT}
      ref={ref}
      style={FILL}
    />
  )
}

export function PaperDither(props: Record<string, unknown>) {
  const ref = usePaperContextRelease()
  return (
    <Dithering
      {...(props as unknown as DitheringProps)}
      maxPixelCount={PAPER_MAX_PIXEL_COUNT}
      ref={ref}
      style={FILL}
    />
  )
}

export function PaperSwirl(props: Record<string, unknown>) {
  const ref = usePaperContextRelease()
  return <Swirl {...(props as unknown as SwirlProps)} maxPixelCount={PAPER_MAX_PIXEL_COUNT} ref={ref} style={FILL} />
}

export function PaperMetaballs(props: Record<string, unknown>) {
  const ref = usePaperContextRelease()
  return (
    <Metaballs
      {...(props as unknown as MetaballsProps)}
      maxPixelCount={PAPER_MAX_PIXEL_COUNT}
      ref={ref}
      style={FILL}
    />
  )
}
