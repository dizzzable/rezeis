// @vitest-environment jsdom

/**
 * A context lost WHILE A COMPONENT IS BUILDING must not take the tree down.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS WINDOW. WebKit gives a web-content process sixteen live WebGL
 * contexts and recycles the oldest into a loss the victim never asked for. The
 * cabinet draws card effects on iOS, so "the context died between `getContext`
 * and first paint" is a state a real subscriber's device produces — and it is
 * the one window the rest of the loss suite does not cover, because every other
 * spec loses the context on a component that has already finished building.
 *
 * WHAT IS ACTUALLY AT STAKE, and it is not the card. A blank card is degraded
 * and survivable. An uncaught error escaping a React effect is not: it
 * propagates out of the commit and unmounts the subtree. Both repos wrap
 * effects in an error boundary (cabinet `card-effect-layer.tsx` →
 * `EffectErrorBoundary`; panel `GlassBackground.tsx` and
 * `card-effect-preview-runtime.tsx`), so today that costs the effect LAYER
 * rather than the page — but it costs it permanently: the boundary does not
 * re-run the effect, and the component's `webglcontextrestored` listener is
 * registered after the paint that threw, so the restore that heals every
 * sibling is never heard.
 *
 * ── THE ROOT CAUSE IS IN `ogl`, NOT IN THESE COMPONENTS ──────────────────────
 * `ogl/src/core/Program.js:84` early-returns from the constructor when linking
 * fails — which is what a lost context reports — and returns BEFORE assigning
 * `this.uniformLocations` on line 89. `Program.use()` on line 179 then does
 * `this.uniformLocations.forEach(...)` and throws
 * `TypeError: Cannot read properties of undefined (reading 'forEach')`.
 * Every ogl component inherits it. It is guarded at OUR call sites rather than
 * patched in `node_modules`.
 *
 * three's `WebGLRenderer` tracks its own `_isContextLost` and skips; raw-WebGL
 * `Thunderstrike` checks its own `LINK_STATUS` and bails. So the three
 * renderers behave differently and the census below is split along that line.
 *
 * ── MEASURED OUTCOMES (22 components × 2 task orderings) ─────────────────────
 * A browser queues the `webglcontextlost` EVENT and the next rAF callback as
 * two separate tasks after the driver loses the context, and does not promise
 * an order. Both are driven here because the answer differs:
 *
 *   ordering      recovers   throws in a frame   throws in commit   blank
 *   event-first        21                    0                  0       1
 *   frame-first         7                   14                  0       1
 *
 * KNOWN AND ACCEPTED — the fourteen ogl components that throw in a rAF callback
 * under `frame-first` (EvilEye, FaultyTerminal, PlasmaWave, PrismaticBurst,
 * Aurora, Balatro, Galaxy, Iridescence, LineWaves, LiquidChrome, Radar,
 * RippleGrid, SoftAurora, Threads). That error is reported to `window.onerror`
 * and goes no further: React never sees it, the tree is untouched, and all
 * fourteen HEAL on restore. That healing is the property that makes it
 * acceptable, so it is asserted below — if one ever stops healing, this spec
 * says so. The throwing itself is deliberately NOT asserted: pinning it would
 * turn a future fix in `ogl` into a red test.
 *
 * Do not "discover" those fourteen and start a rewrite. Reworking fourteen
 * components' loss semantics to remove a reported-and-recovered console error
 * is churn; the two that could not recover were fixed, and that was the gap.
 *
 * ── TWO WAYS THIS INSTRUMENT LIED, both corrected here ───────────────────────
 * Recorded because they are the difference between a true and a false answer,
 * and the next person to touch this file will otherwise re-derive them the way
 * they were derived the first time — by disbelieving a confident wrong result.
 *
 *   1. FLIP THE FLAG, DO NOT DISPATCH THE EVENT. Driving the harness's
 *      `loseContext()` at the sabotage point fires `webglcontextlost`
 *      SYNCHRONOUSLY, which runs the component's own handler re-entrantly
 *      inside its build effect. No browser does that: the driver loses the
 *      context, and the event is delivered later as its own task. The
 *      re-entrant version reported 16 components throwing, all of them false.
 *
 *   2. SABOTAGE ONCE PER RUN, NOT ONCE PER CONTEXT. Wiring every context meant
 *      the rebuild a component performs ON RESTORE was sabotaged too, so
 *      fourteen components that recover correctly were scored as crashing on
 *      restore.
 *
 * ── WHAT THIS CANNOT SAY ─────────────────────────────────────────────────────
 * Nothing about the picture — no fragment is ever shaded under the stub. And
 * the mid-build window is entered at a different PHASE per renderer: ogl and
 * raw WebGL build eagerly inside the effect, three compiles its program lazily
 * at the first `render()`, which lands in a rAF callback. So for the three
 * components the commit-safety assertion is satisfied trivially. It is kept
 * uniform anyway — a component that moves its build into the effect should be
 * covered on the day it moves, not on the day someone notices.
 */

import { act, render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'

import Aurora from './Aurora'
import Balatro from './Balatro'
import ColorBends from './ColorBends'
import EvilEye from './EvilEye'
import FaultyTerminal from './FaultyTerminal'
import Galaxy from './Galaxy'
import Iridescence from './Iridescence'
import LaserFlow from './LaserFlow'
import LightPillar from './LightPillar'
import LineWaves from './LineWaves'
import LiquidChrome from './LiquidChrome'
import MagicRings from './MagicRings'
import PixelBlast from './PixelBlast'
import PlasmaWave from './PlasmaWave'
import PrismaticBurst from './PrismaticBurst'
import Radar from './Radar'
import RippleGrid from './RippleGrid'
import SoftAurora from './SoftAurora'
import Threads from './Threads'
import { installGlStub, type GlStubHarness } from './gl-stub'
import ChromaticWaves from './originkit/ChromaticWaves'
import DotMatrix from './originkit/DotMatrix'
import Thunderstrike from './originkit/Thunderstrike'

/** Every WebGL card effect the lifecycle suite drives, in the same order. */
const COMPONENTS = [
  ['ColorBends', <ColorBends key="c" />],
  ['EvilEye', <EvilEye key="c" />],
  ['FaultyTerminal', <FaultyTerminal key="c" />],
  ['LaserFlow', <LaserFlow key="c" />],
  ['LightPillar', <LightPillar key="c" />],
  ['MagicRings', <MagicRings key="c" />],
  ['PixelBlast', <PixelBlast key="c" />],
  ['PlasmaWave', <PlasmaWave key="c" />],
  ['PrismaticBurst', <PrismaticBurst key="c" />],
  ['Aurora', <Aurora key="c" />],
  ['Balatro', <Balatro key="c" />],
  ['Galaxy', <Galaxy key="c" />],
  ['Iridescence', <Iridescence key="c" />],
  ['LineWaves', <LineWaves key="c" />],
  ['LiquidChrome', <LiquidChrome key="c" />],
  ['Radar', <Radar key="c" />],
  ['RippleGrid', <RippleGrid key="c" />],
  ['SoftAurora', <SoftAurora key="c" />],
  ['Threads', <Threads key="c" />],
  ['ChromaticWaves', <ChromaticWaves key="c" />],
  ['DotMatrix', <DotMatrix key="c" />],
  ['Thunderstrike', <Thunderstrike key="c" />],
] as const

/**
 * Presents NO canvas when its build fails, so there is nothing for a restore to
 * reach — it checks `LINK_STATUS` itself, calls `disposeGl()` and returns
 * before `container.appendChild(canvas)` and before its listeners go on.
 *
 * That is the safest of the three shapes on the way in (it is the only
 * component that never throws under either ordering) and the weakest on the way
 * out: it needs a remount rather than healing itself. Named here rather than
 * dropped from the healing list silently, so the asymmetry is a decision on the
 * record instead of a gap.
 */
const NO_CANVAS_ON_FAILED_BUILD = new Set(['Thunderstrike'])

const ORDERINGS = ['event-first', 'frame-first'] as const
type Ordering = (typeof ORDERINGS)[number]

/**
 * Lose the context the instant the first `createProgram` hands back a handle —
 * the flag only, never the event. See correction 1 in the header.
 */
function loseAtFirstProgram() {
  const original = HTMLCanvasElement.prototype.getContext
  const wired = new WeakSet<object>()
  // Once per run, not once per context. See correction 2 in the header.
  let fired = false
  let losses = 0

  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string) {
    const context = (original as unknown as (kind: string) => unknown).call(this, kind) as Record<
      string,
      unknown
    > | null
    if (context === null || kind === '2d' || wired.has(context)) return context
    wired.add(context)
    const inner = context.createProgram as (...args: unknown[]) => unknown
    context.createProgram = (...args: unknown[]) => {
      const program = inner(...args)
      if (!fired) {
        fired = true
        losses++
        const getExtension = context.getExtension as (
          name: string,
        ) => { loseContext(): void } | null
        getExtension('WEBGL_lose_context')?.loseContext()
      }
      return program
    }
    return context
  } as never

  return {
    losses: () => losses,
    restore: () => {
      HTMLCanvasElement.prototype.getContext = original
    },
  }
}

interface Outcome {
  /** An error that escaped React's commit. The one that must always be null. */
  readonly commitError: Error | null
  /** An error that escaped a rAF callback. Reported, survivable, not asserted. */
  readonly frameError: Error | null
  /** Zero means the window was never entered and everything below is vacuous. */
  readonly losses: number
  readonly presentedCanvas: boolean
  readonly healed: boolean
  readonly drewAfterRestore: number
}

const named = (error: unknown): Error => {
  const err = error as Error
  const top = (err.stack ?? '').split('\n')[1]?.trim() ?? ''
  return Object.assign(new Error(`${err.message} @ ${top}`), { name: err.name })
}

/** Drive one component through one ordering. Never throws; reports instead. */
function drive(element: ReactElement, ordering: Ordering, gl: GlStubHarness): Outcome {
  const hook = loseAtFirstProgram()
  const host = document.createElement('div')
  document.body.append(host)

  let commitError: Error | null = null
  let frameError: Error | null = null
  let container: HTMLElement | null = null

  const frames = (count: number) => {
    try {
      gl.runFrames(count)
    } catch (error) {
      frameError = frameError ?? named(error)
    }
  }

  try {
    try {
      container = render(element, { container: host }).container
    } catch (error) {
      commitError = named(error)
    }

    // three compiles lazily at its first `render()`, which lands in a frame:
    // step until the window is entered so those components are measured too.
    for (let i = 0; hook.losses() === 0 && i < 4; i++) frames(1)

    const canvas = container?.querySelector('canvas') ?? null
    const deliverEvent = () => {
      if (!canvas) return
      try {
        act(() => {
          canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
        })
      } catch (error) {
        commitError = commitError ?? named(error)
      }
    }

    if (ordering === 'event-first') {
      deliverEvent()
      frames(3)
    } else {
      frames(1)
      deliverEvent()
      frames(2)
    }

    let healed = false
    let drewAfterRestore = 0
    if (canvas) {
      try {
        act(() => {
          gl.restoreContext(canvas)
        })
      } catch (error) {
        commitError = commitError ?? named(error)
      }
      frames(4)
      const presented = container ? gl.presentedContext(container) : undefined
      drewAfterRestore = presented?.draws ?? 0
      healed = Boolean(presented) && !presented!.isContextLost() && drewAfterRestore > 0
    }

    return {
      commitError,
      frameError,
      losses: hook.losses(),
      presentedCanvas: Boolean(canvas),
      healed,
      drewAfterRestore,
    }
  } finally {
    hook.restore()
    host.remove()
    document.body.innerHTML = ''
  }
}

describe.each(ORDERINGS)('a context lost mid-build (%s)', (ordering) => {
  describe.each(COMPONENTS)('%s', (name, element) => {
    it('lets no error escape React’s commit', () => {
      const gl = installGlStub()
      try {
        const outcome = drive(element, ordering, gl)

        // The premise. Without it this passes for a component the sabotage
        // never reached, which is a different thing entirely from one that
        // survived it.
        expect(
          outcome.losses,
          `${name} never called createProgram across its mount and four frames, ` +
            'so the mid-build window was never entered and nothing below is under test',
        ).toBeGreaterThan(0)

        expect(
          outcome.commitError && `${outcome.commitError.name}: ${outcome.commitError.message}`,
          `${name} threw out of its effect body when the context died mid-build. That ` +
            'error leaves React’s commit and unmounts the subtree: the effect ' +
            'boundary catches it, does not re-run the effect, and the ' +
            '`webglcontextrestored` listener registered after the failing paint is ' +
            'never reached — so the card is blank until the subscriber reloads the ' +
            'page. If the throw is a synchronous first paint inside the effect, ' +
            'wrap it in `if (!gl.isContextLost())` and let the restore path bring ' +
            'the component back; a skipped frame costs a frame',
        ).toBeNull()
      } finally {
        gl.teardown()
      }
    })
  })
})

describe.each(ORDERINGS)('recovery after a mid-build loss (%s)', (ordering) => {
  const healers = COMPONENTS.filter(([name]) => !NO_CANVAS_ON_FAILED_BUILD.has(name))

  describe.each(healers)('%s', (name, element) => {
    it('comes back by itself once the context is restored', () => {
      const gl = installGlStub()
      try {
        const outcome = drive(element, ordering, gl)
        expect(outcome.losses, `${name} never entered the mid-build window`).toBeGreaterThan(0)
        expect(
          outcome.presentedCanvas,
          `${name} presented no canvas after a mid-build loss. If that is now ` +
            'deliberate it belongs in NO_CANVAS_ON_FAILED_BUILD with its reason, ' +
            'because it also means the component cannot hear a restore',
        ).toBe(true)

        // This is the property that makes the fourteen known frame-throwers
        // acceptable. A component may report an error to `window.onerror` on
        // the unlucky ordering; it may not stay dark afterwards.
        expect(
          outcome.healed,
          `${name} did not come back after the context was restored (drew ` +
            `${outcome.drewAfterRestore} frames). On a WebKit context recycle that ` +
            'is a subscriber whose background never returns without a page reload',
        ).toBe(true)
      } finally {
        gl.teardown()
      }
    })
  })
})
