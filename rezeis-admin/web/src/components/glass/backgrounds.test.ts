/**
 * `BG_LOADERS` — the claim that makes the login-screen prefetch safe.
 *
 * `GlassBackground` warms the selected background's chunk during idle time on
 * the login screen so the download is not competing with the dashboard chunk,
 * its queries, a GL context and a shader compile on the first authenticated
 * frame. That is only acceptable if importing the module is genuinely inert —
 * the pre-auth invariant is that NOTHING runs on the GPU before an operator is
 * inside the panel, and it is the reason the WebGL backgrounds were gated on
 * auth in the first place.
 *
 * "The modules only define things at the top level" is an easy thing to
 * believe and an easy thing to break: one `wrapEffect(...)`, one module-level
 * `new Renderer()`, one eager `requestAnimationFrame` in a helper, and the
 * login screen quietly starts doing the work it was rescued from. So it is
 * asserted, against the real modules, not reasoned about.
 *
 * `dither` is in the list deliberately: it is the one module with a top-level
 * CALL (`wrapEffect(RetroEffectImpl)` from @react-three/postprocessing).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BG_COMPONENTS, BG_LOADERS } from './backgrounds'

let contexts: string[]
let frames: number

beforeEach(() => {
  contexts = []
  frames = 0
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((kind: string) => {
    contexts.push(kind)
    return null
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext)
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => {
    frames += 1
    return 0
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('BG_LOADERS', () => {
  it('covers every background the component map can render', () => {
    // A background present in BG_COMPONENTS but missing from BG_LOADERS would
    // silently lose its prefetch; the reverse would prefetch a chunk nothing
    // renders. They are derived from one object, and this proves it stayed
    // that way.
    const componentIds = Object.keys(BG_COMPONENTS).filter((id) => id !== 'none').sort()
    expect(Object.keys(BG_LOADERS).sort()).toEqual(componentIds)
    expect(componentIds.length).toBeGreaterThan(15)
  })

  it.each(['liquidChrome', 'silk', 'beams', 'dither'] as const)(
    'importing %s creates no GL context and schedules no frame',
    async (id) => {
      const mod = await BG_LOADERS[id]()

      // The module really did evaluate — otherwise this test proves nothing.
      expect(typeof mod.default).toBe('function')
      // …and evaluating it touched neither the GPU nor the frame loop.
      expect(contexts).toEqual([])
      expect(frames).toBe(0)
    },
    30_000,
  )
})
