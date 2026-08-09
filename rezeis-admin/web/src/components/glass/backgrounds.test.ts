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

/**
 * The one background whose module DOES schedule a frame when it is merely
 * imported — found the moment this sweep stopped testing four hand-picked ids
 * and started testing every id in `BG_LOADERS`.
 *
 * `DotGrid.tsx` is the only background that imports gsap, and THE IMPORT IS THE
 * PROBLEM, not anything the component does with it. gsap-core ends with
 *
 *     _coreReady = 1;
 *     _windowExists() && _wake();          // gsap-core.js, v3.15.0
 *
 * — a top-level statement that starts gsap's global ticker, i.e. a
 * `requestAnimationFrame` loop it owns for the whole page, the moment the
 * module is evaluated in anything with a `window`. So an operator whose
 * background is Dot Grid gets a rAF loop started on the LOGIN SCREEN by the
 * idle prefetch, which is exactly what the prefetch was designed not to do. It
 * is a small loop that gsap puts back to sleep when no tween is running, and it
 * is still the invariant broken.
 *
 * Read this before proposing the obvious fix: moving the top-level
 * `gsap.registerPlugin(InertiaPlugin)` into the component DOES NOT HELP.
 * Measured, not assumed — a bare `await import('gsap')` with `registerPlugin`
 * never called schedules a frame on its own. The only fix that makes the module
 * inert is to make the gsap import itself dynamic (inside the mount effect),
 * which means null-guarding the six `gsap.*` call sites in DotGrid's pointer
 * handlers and accepting that inertia is dead for the first few frames after
 * mount. That is a behaviour change in a component that is otherwise frozen, so
 * it is named here rather than done in passing.
 *
 * No GL context is created either way — that half holds for every module, with
 * no exemptions.
 */
const SCHEDULES_A_FRAME_ON_IMPORT: ReadonlySet<string> = new Set(['dotGrid'])

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

  it('still covers the modules that made this test necessary', () => {
    // The sweep below is derived from BG_LOADERS, so it can never miss a newly
    // added background — but a derived list can also quietly shrink. These four
    // are the ones with a documented reason to be here: `dither` for its
    // top-level `wrapEffect(...)` call, `silk`/`beams` for the ~950 KB three
    // stack they pull, `liquidChrome` because it is the default and therefore
    // the one the login screen actually prefetches.
    expect(Object.keys(BG_LOADERS)).toEqual(
      expect.arrayContaining(['liquidChrome', 'silk', 'beams', 'dither']),
    )
  })

  it.each(Object.keys(BG_LOADERS) as (keyof typeof BG_LOADERS)[])(
    'importing %s creates no GL context and schedules no frame',
    async (id) => {
      const mod = await BG_LOADERS[id]()

      // The module really did evaluate — otherwise this test proves nothing.
      expect(typeof mod.default).toBe('function')
      // …and evaluating it touched neither the GPU…
      expect(contexts).toEqual([])
      // …nor the frame loop. One module does, and is named rather than
      // excused: see SCHEDULES_A_FRAME_ON_IMPORT.
      if (SCHEDULES_A_FRAME_ON_IMPORT.has(id)) {
        // Pinned in the other direction too. The day the import goes quiet —
        // a gsap version that no longer wakes on `registerPlugin`, or the call
        // moving inside the component — this fails and the exemption has to be
        // deleted rather than left behind describing a problem that is gone.
        expect(frames).toBeGreaterThan(0)
      } else {
        expect(frames).toBe(0)
      }
    },
    30_000,
  )

  it('exempts exactly one module, and only one', () => {
    expect([...SCHEDULES_A_FRAME_ON_IMPORT]).toEqual(['dotGrid'])
    // …and it is a background that still exists.
    for (const id of SCHEDULES_A_FRAME_ON_IMPORT) {
      expect(Object.keys(BG_LOADERS)).toContain(id)
    }
  })
})
