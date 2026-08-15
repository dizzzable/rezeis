// @vitest-environment jsdom

/**
 * The twelve components that were vendored and never rendered.
 * ────────────────────────────────────────────────────────────
 * Every one of these had been in the tree for months without being mounted a
 * single time: `eslint.config.mjs` ignores this directory, nothing imported
 * them, and `tsc` has nothing to say about a runtime ownership bug. They are
 * about to become operator-selectable, so this file is the first thing that
 * actually RUNS them, and it pins the four properties that separate a component
 * this project can ship from one it cannot:
 *
 *   1. IT MOUNTS AT ALL, and puts a canvas on screen. Two of these could not
 *      have been rendered from a registry as written — `LetterGlitch`'s props
 *      had no optional markers, so `<LetterGlitch />` was a type error.
 *
 *   2. UNMOUNT HANDS THE CONTEXT BACK. WebKit gives a web-content process 16
 *      live WebGL contexts before it starts recycling the oldest into an
 *      unrecoverable SyntheticLostContext, and a dropped reference frees
 *      nothing — the slot comes back only when the context object is
 *      destroyed. Four of these leaked one per mount; `LightPillar` leaked two.
 *
 *   3. MOUNT → UNMOUNT → MOUNT ON THE SAME ELEMENT STILL DRAWS. This is the
 *      defect class `reactbits-canvas-ownership.test.ts` stands over, reproduced
 *      here at runtime: React keeps its elements across an effect cleanup, and a
 *      canvas hands the SAME context object to every later `getContext` call,
 *      lost or not. It is StrictMode's double-invoke in dev and any remount over
 *      preserved DOM in production.
 *
 *   4. THE DEVICE-PIXEL BUDGET IS APPLIED. Full-screen, these shade the whole
 *      viewport every frame; `render-scale.ts` caps the drawing buffer at one
 *      1080p frame while leaving the CSS box exactly as laid out.
 *
 * WHAT IS DELIBERATELY NOT HERE. Nothing about the picture: no fragment is ever
 * shaded under a stub, so appearance is not observable and is not claimed. The
 * per-component sections below add only what is specific to that component's
 * defect — a dead prop that is now live, a churn count, a colour that used to
 * be hardcoded.
 */

import { act, render } from '@testing-library/react'
import { StrictMode, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Antigravity from './Antigravity'
import Aurora from './Aurora'
import Balatro from './Balatro'
import ColorBends from './ColorBends'
import EvilEye from './EvilEye'
import FaultyTerminal from './FaultyTerminal'
import Galaxy from './Galaxy'
import Iridescence from './Iridescence'
import LaserFlow from './LaserFlow'
import LetterGlitch from './LetterGlitch'
import LightPillar from './LightPillar'
import LineWaves from './LineWaves'
import LiquidChrome from './LiquidChrome'
import MagicRings from './MagicRings'
import PixelBlast from './PixelBlast'
import PlasmaWave from './PlasmaWave'
import PrismaticBurst from './PrismaticBurst'
import Radar from './Radar'
import RippleGrid from './RippleGrid'
import ShapeGrid from './ShapeGrid'
import SoftAurora from './SoftAurora'
import Threads from './Threads'
import ChromaticWaves from './originkit/ChromaticWaves'
import DotMatrix from './originkit/DotMatrix'
import Thunderstrike from './originkit/Thunderstrike'
import { installGlStub, type GlStubHarness } from './gl-stub'
import { RENDER_PIXEL_BUDGET } from './render-scale'

/**
 * A box big enough to be over the budget at DPR 2 — 2560 × 1440 × 4 =
 * 14,745,600 device pixels against a 2,073,600 ceiling, which resolves to
 * exactly ratio 0.75 and exactly 1920 × 1080 of buffer.
 */
const OVERSIZED = { width: 2560, height: 1440, devicePixelRatio: 2 }

let gl: GlStubHarness

const roots: Array<{ root: Root; host: HTMLDivElement }> = []

afterEach(() => {
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  gl?.teardown()
})

/**
 * A host element the test owns, so the SAME DOM node can be mounted into twice.
 * Testing Library caches one React root per container and refuses to render
 * into it again after `unmount()`, which is precisely the case being tested —
 * a remount over DOM that React kept.
 */
function makeHost(): HTMLDivElement {
  const host = document.createElement('div')
  document.body.append(host)
  return host
}

function mountInto(host: HTMLDivElement, element: ReactElement): Root {
  const root = createRoot(host)
  roots.push({ root, host })
  act(() => {
    root.render(element)
  })
  return root
}

function unmountRoot(root: Root): void {
  const index = roots.findIndex(entry => entry.root === root)
  if (index >= 0) roots.splice(index, 1)
  act(() => root.unmount())
}

/**
 * The nine raw-WebGL components with their own un-budgeted pixel ratio — the
 * clamp each one applies before `render-scale.ts` sees it. They differ
 * (`PlasmaWave` caps at 1.5, the rest at 2), and the "below the budget nothing
 * moves" assertion has to be denominated in each component's own number or it
 * would only ever be testing that they all picked 2.
 */
/**
 * The components whose device-pixel behaviour has been measured, and which the
 * budget suite below may therefore make assertions about. Kept separate from
 * the lifecycle list on purpose: the ratio in the third slot is a MEASURED
 * property of each component, not a default, and a guessed one would assert
 * something nobody checked.
 */
const PIXEL_BUDGET_COMPONENTS = [
  ['ColorBends', <ColorBends key="c" />, 2],
  ['EvilEye', <EvilEye key="c" />, 2],
  ['FaultyTerminal', <FaultyTerminal key="c" />, 2],
  ['LaserFlow', <LaserFlow key="c" />, 2],
  ['LightPillar', <LightPillar key="c" />, 2],
  ['MagicRings', <MagicRings key="c" />, 2],
  ['PixelBlast', <PixelBlast key="c" />, 2],
  ['PlasmaWave', <PlasmaWave key="c" />, 1.5],
  ['PrismaticBurst', <PrismaticBurst key="c" />, 2],
] as const

/**
 * Repaired later, and guarded for LIFECYCLE ONLY.
 *
 * Every one of them was shipped with its repair unguarded — the list above is
 * what this suite covered, and none of these were on it. They handled a context
 * loss by drawing into dead GL handles, or did not handle it at all, which on a
 * phone is the ordinary outcome of backgrounding the tab: context alive, canvas
 * blank, and only a page reload brings the animation back.
 *
 * They are deliberately NOT in the device-pixel budget suite. That suite
 * asserts a measured per-component ratio, and these were repaired for context
 * loss, not measured for pixel budget — putting them there would assert a
 * property nobody checked. (It also caught the author of this list guessing
 * `2` for nine components that render at `1`.)
 *
 * `Aurora` is the default card effect, so it is the one that matters most — and
 * note this guards the PANEL's copy. The cabinet renders its own
 * `components/ui/aurora`, eagerly; the freeze script records that divergence on
 * purpose and reiwa guards its copy separately.
 */
const RESTORED_COMPONENTS = [
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
  // The three that had NO `webglcontextlost` listener at all. three.js gets
  // one from `WebGLRenderer`; every other OGL component here registers its
  // own; OGL itself does not (`ogl/src/core/Renderer.js`: "TODO: Handle
  // context loss"). Measured before the repair: the event arrived with
  // `defaultPrevented === false` and the loop kept drawing afterwards, so
  // the browser never sent `webglcontextrestored` and WebKit's recycling of
  // the oldest of its 16 contexts left a blank card for the session.
  //
  // They live in `originkit/`, which is byte-frozen and vendored the OTHER
  // way — reiwa is the source, `scripts/sync-originkit.mjs` copies it here.
  // So the repair was made there and synced; `originkit-manifest.test.ts`
  // holds the two copies identical.
  ['ChromaticWaves', <ChromaticWaves key="c" />],
  ['DotMatrix', <DotMatrix key="c" />],
  ['Thunderstrike', <Thunderstrike key="c" />],
] as const

/** Everything that must survive a mount, a remount and a context loss. */
const WEBGL_COMPONENTS = [
  ...PIXEL_BUDGET_COMPONENTS.map(([name, element]) => [name, element] as const),
  ...RESTORED_COMPONENTS,
] as const

describe.each(WEBGL_COMPONENTS)('%s lifecycle', (name, element) => {
  beforeEach(() => {
    gl = installGlStub()
  })

  it('mounts without throwing and presents a canvas', () => {
    const view = render(element)

    const canvas = view.container.querySelector('canvas')
    expect(canvas, `${name} rendered no canvas at all`).not.toBeNull()

    const context = gl.contextOf(canvas!)
    expect(context, 'the presented canvas has no GL context on it').toBeDefined()
    expect(
      context!.isContextLost(),
      'the canvas on screen is backed by an already-destroyed context',
    ).toBe(false)

    gl.runFrames(3)
    expect(context!.draws, 'the component never reached its render loop').toBeGreaterThan(0)
  })

  it('opens exactly one context, not one per canvas it left behind', () => {
    render(element)
    gl.runFrames(2)

    expect(
      gl.liveContexts().length,
      'expected exactly one live WebGL context after a plain mount, and got ' +
        gl.liveContexts().length,
    ).toBe(1)
  })

  it('hands the context back on unmount', () => {
    const view = render(element)
    gl.runFrames(2)
    const context = gl.contexts[0]
    expect(context.loseCalls, 'the context was released before unmount').toBe(0)

    view.unmount()

    expect(
      context.loseCalls,
      'the context was left alive on unmount. A dropped reference frees nothing: ' +
        'WebKit returns the slot only when the context object is destroyed, and ' +
        'every one of these is unmounted whenever the operator picks a different ' +
        'effect',
    ).toBeGreaterThanOrEqual(1)
    expect(context.isContextLost()).toBe(true)
    expect(gl.liveContexts(), 'a context outlived the component').toEqual([])
  })

  it('stops its animation loop on unmount', () => {
    const view = render(element)
    gl.runFrames(2)
    const drewBefore = gl.contexts[0].draws
    expect(drewBefore, `${name} never drew, so it has no loop to stop`).toBeGreaterThan(0)

    // Unmount RELEASES the context (the spec above pins that), so under the old
    // draw counter — which stopped counting the moment a context went lost —
    // this assertion could not move either, for any of these components. It is
    // live again only because the counter now records the call rather than
    // judging it.
    view.unmount()
    gl.runFrames(3)

    expect(
      gl.contexts[0].draws,
      'the render loop is still running after unmount, drawing into a released context',
    ).toBe(drewBefore)
  })

  it('gives a second mount on the same element a live context, not the dead one', () => {
    // StrictMode runs setup → cleanup → setup against the SAME rendered tree.
    // That is the production defect's exact shape and it needs no dependency
    // array to reproduce.
    const view = render(<StrictMode>{element}</StrictMode>)

    const canvas = view.container.querySelector('canvas')
    expect(canvas, 'no canvas was presented after the double-invoke').not.toBeNull()
    const presented = gl.contextOf(canvas!)
    expect(
      presented?.isContextLost(),
      'the canvas on screen is backed by a context that was already destroyed. ' +
        'The canvas survived the effect cleanup that lost its context, and ' +
        '`getContext` handed the same dead one to the second setup — every ' +
        'create* call then returns null and the component bails to a ' +
        'permanently blank canvas, silently',
    ).toBe(false)

    gl.runFrames(3)
    expect(
      presented!.draws,
      'the presented canvas never drew — the second setup bailed before its loop',
    ).toBeGreaterThan(0)
    expect(
      view.container.querySelectorAll('canvas').length,
      "the first setup's canvas was never taken out of the container; its context " +
        'is gone so it paints nothing, but it is still stacked over the live one',
    ).toBe(1)
    expect(
      gl.liveContexts().length,
      'expected exactly one live context after setup → cleanup → setup, and got ' +
        gl.liveContexts().length,
    ).toBe(1)
  })

  it('survives a full unmount and remount into the same host element', () => {
    // The SAME DOM node both times — the remount-over-preserved-DOM case,
    // which is what production does when the operator switches effects and
    // back, and what StrictMode does on every dev mount.
    const host = makeHost()
    const first = mountInto(host, element)
    gl.runFrames(2)
    unmountRoot(first)

    mountInto(host, element)
    gl.runFrames(3)

    const canvas = host.querySelector('canvas')
    expect(canvas, 'the remount presented no canvas').not.toBeNull()
    const context = gl.contextOf(canvas!)
    expect(context?.isContextLost(), 'the remount inherited a dead context').toBe(false)
    expect(context!.draws, 'the remount never drew a frame').toBeGreaterThan(0)
    expect(gl.liveContexts().length, 'the remount leaked the first mount').toBe(1)
    expect(host.querySelectorAll('canvas').length, 'a dead canvas was left stacked').toBe(1)
  })
})

describe.each(PIXEL_BUDGET_COMPONENTS)('%s device-pixel budget', (name, element, baseRatio) => {
  beforeEach(() => {
    gl = installGlStub(OVERSIZED)
  })

  it('caps the drawing buffer without shrinking the CSS box', () => {
    const view = render(element)
    gl.runFrames(2)

    const canvas = view.container.querySelector('canvas')!
    const buffer = canvas.width * canvas.height
    expect(buffer, `${name} allocated no buffer at all`).toBeGreaterThan(0)
    expect(
      buffer,
      `${name} allocated ${buffer} device pixels for a 2560×1440 box at DPR 2. ` +
        'Un-budgeted that is 14,745,600 — a ×7 fill-rate multiplier nothing in ' +
        'this catalog was designed against, paid on every frame',
    ).toBeLessThanOrEqual(RENDER_PIXEL_BUDGET)
    expect(
      canvas.width,
      'the budget did not engage: the buffer is still the raw CSS box × DPR',
    ).toBeLessThan(OVERSIZED.width * OVERSIZED.devicePixelRatio)

    // The other half of the mitigation, and the half a previous round got
    // wrong: the CSS presentation size must be untouched, or the picture
    // changes rather than its sampling density — every feature is derived from
    // the box, so shrinking it magnifies each one by 1/scale.
    const cssWidth = canvas.style.width
    expect(
      cssWidth === '' || cssWidth === '100%' || cssWidth === `${OVERSIZED.width}px`,
      `${name} shrank its CSS box to ${cssWidth || '(unset)'}; only the backing ` +
        'store may move',
    ).toBe(true)
  })

  it('leaves a box already inside the budget bit-identical', () => {
    gl.teardown()
    // The largest phone in the range, at a ratio already clamped to 2:
    // 440 × 956 × 4 = 1,682,560, under the 2,073,600 ceiling. This is the row
    // `render-scale.ts` sets the budget to protect — a smaller ceiling would
    // quantise exactly this device down and soften the one mount that cannot
    // afford it.
    gl = installGlStub({ width: 440, height: 956, devicePixelRatio: 2 })

    const view = render(element)
    gl.runFrames(2)

    const canvas = view.container.querySelector('canvas')!
    expect(
      canvas.width,
      `${name} softened a phone-sized mount. Below the budget the scale is ` +
        'exactly 1, so cards, previews and phones must come out untouched',
    ).toBe(Math.floor(440 * baseRatio))
  })
})

describe.each(WEBGL_COMPONENTS)('%s context loss', (name, element) => {
  beforeEach(() => {
    gl = installGlStub()
  })

  it('preventDefaults the loss, so the browser is allowed to restore it', () => {
    const view = render(element)
    gl.runFrames(2)
    const canvas = view.container.querySelector('canvas')!

    let event!: Event
    act(() => {
      event = gl.loseContext(canvas)
    })

    expect(
      event.defaultPrevented,
      `${name} did not call preventDefault() on webglcontextlost. WebGL treats ` +
        'that as "do not bother restoring": the browser never fires ' +
        '`webglcontextrestored`, and a loss that was recoverable — a GPU reset, ' +
        'a background tab reclaimed, WebKit recycling the oldest of its sixteen ' +
        'contexts — becomes a permanently blank canvas for the rest of the session',
    ).toBe(true)
  })

  /**
   * WHAT THIS USED TO BE, because the shape is worth recognising elsewhere.
   *
   * It read `const drewAtLoss = context.draws` after the loss and asserted the
   * count had not moved — against a stub whose draw counter was
   * `if (!state.lost) state.draws++`. The count could not move. The assertion
   * held for every possible implementation, including one that calls
   * `drawArrays` every frame forever, and it was measured doing exactly that:
   * the render-loop stop was removed from all three originkit components and
   * the suite produced zero failures.
   *
   * `drawsWhileLost` is the repaired accounting — the draw is counted, and the
   * fact that it went into a dead context is recorded next to it — so this now
   * fails, once per component, when the loop does not stop.
   */
  it('stops drawing into a context that is gone', () => {
    const view = render(element)
    gl.runFrames(2)
    const canvas = view.container.querySelector('canvas')!
    const context = gl.contextOf(canvas)!
    // The premise. Without it this is green against a component that never
    // reached its render loop at all, which is a different defect wearing the
    // same colour.
    expect(context.draws, `${name} never drew, so it has no loop to stop`).toBeGreaterThan(0)

    act(() => {
      gl.loseContext(canvas)
    })
    gl.runFrames(3)

    expect(
      context.drawsWhileLost,
      `${name} issued ${context.drawsWhileLost} draw calls against a dead ` +
        'context — every one of them returns null or is a no-op, and it burns a ' +
        'frame slot doing it. On the phone this is the ordinary outcome of ' +
        'backgrounding the tab',
    ).toBe(0)
  })

  it('comes back on restore, still holding exactly one context', () => {
    const host = makeHost()
    mountInto(host, element)
    gl.runFrames(2)
    const canvas = host.querySelector('canvas')!

    act(() => {
      gl.loseContext(canvas)
    })
    act(() => {
      gl.restoreContext(canvas)
    })

    // Two shapes are correct here and the library decides which. three's
    // WebGLRenderer rebuilds every GL resource it owns on restore, so the
    // component only pauses and resumes on the SAME context. `ogl` does not
    // (`ogl/src/core/Renderer.js`: "TODO: Handle context loss"), so those
    // components bump a generation counter and build a whole new renderer.
    // Either way the operator gets a live canvas and the process gets its slot
    // count back where it started.
    const presented = gl.presentedContext(host)
    expect(presented, 'nothing is on screen after the restore').toBeDefined()
    expect(presented!.isContextLost(), 'the restored canvas is backed by a dead context').toBe(
      false,
    )

    // BASELINED AT THE RESTORE, not measured from zero. On the three.js shape
    // the presented context is the one that was already drawing before the
    // loss, so `draws > 0` says nothing about whether the loop came back — it
    // was satisfied by frames issued minutes of test-clock earlier. Only the
    // frames drawn AFTER the restore answer the question this spec asks.
    const drewAtRestore = presented!.draws
    gl.runFrames(3)
    expect(
      presented!.draws,
      `${name} never resumed drawing after the restore — the canvas is live and ` +
        'permanently blank, which is what an operator sees when a backgrounded ' +
        'tab comes forward',
    ).toBeGreaterThan(drewAtRestore)
    expect(
      gl.liveContexts().length,
      'the restore left more than one live context — a rebuilt renderer that ' +
        'never released the one it replaced walks straight into the 16-context ceiling',
    ).toBe(1)
    expect(host.querySelectorAll('canvas').length, 'a dead canvas was left stacked').toBe(1)
  })
})

describe('per-component defects', () => {
  beforeEach(() => {
    gl = installGlStub()
  })

  it('FaultyTerminal does not rebuild its context when the parent re-renders', () => {
    const view = render(<FaultyTerminal />)
    gl.runFrames(2)
    expect(gl.contexts).toHaveLength(1)
    const context = gl.contexts[0]

    // Identical props, five times — one pointer drag across an unrelated
    // control anywhere on the page. `gridMul` defaulted to a fresh `[2, 1]`
    // ARRAY LITERAL on every render and sat in the effect's dependency array,
    // so reference inequality tore the whole WebGL context down and rebuilt it
    // every single time.
    for (let i = 0; i < 5; i++) view.rerender(<FaultyTerminal />)
    gl.runFrames(2)

    expect(
      gl.contexts.length,
      'a bare re-render of the parent rebuilt the whole renderer. On a slider ' +
        'drag that is one context allocation per pointer move',
    ).toBe(1)
    expect(context.loseCalls, 'the running renderer was torn down mid-drag').toBe(0)
    expect(context.isContextLost()).toBe(false)
  })

  it('FaultyTerminal feeds a moved slider to the running renderer', () => {
    const view = render(<FaultyTerminal scale={1} brightness={1} />)
    gl.runFrames(2)
    const contextsBefore = gl.contexts.length

    view.rerender(<FaultyTerminal scale={2.5} brightness={0.4} timeScale={0.9} />)
    gl.runFrames(2)

    // Splitting construction from uniform pushes only helps if the pushes
    // actually happen: a build effect with narrow deps and no second effect
    // would freeze the picture at whatever the operator had at mount.
    expect(gl.contexts.length, 'the uniform push rebuilt the renderer').toBe(contextsBefore)
    expect(gl.contexts[0].draws, 'the animation stopped while the operator tuned it').toBeGreaterThan(
      0,
    )
  })

  it.each([
    ['EvilEye', <EvilEye key="c" />, <EvilEye key="c" flameSpeed={3} intensity={2} />],
    [
      'PrismaticBurst',
      <PrismaticBurst key="c" />,
      <PrismaticBurst key="c" speed={2} intensity={4} />,
    ],
    ['MagicRings', <MagicRings key="c" />, <MagicRings key="c" speed={2} ringCount={3} />],
    ['PlasmaWave', <PlasmaWave key="c" />, <PlasmaWave key="c" speed1={0.4} bend1={2} />],
    ['ColorBends', <ColorBends key="c" />, <ColorBends key="c" speed={0.9} scale={2} />],
    ['LightPillar', <LightPillar key="c" />, <LightPillar key="c" rotationSpeed={2} />],
    ['LaserFlow', <LaserFlow key="c" />, <LaserFlow key="c" decay={2} falloffStart={3} />],
    ['PixelBlast', <PixelBlast key="c" />, <PixelBlast key="c" speed={2} patternScale={4} />],
  ])('%s does not rebuild its context when a slider moves', (name, initial, moved) => {
    const view = render(initial)
    gl.runFrames(2)
    expect(gl.contexts).toHaveLength(1)
    const context = gl.contexts[0]
    const drewBefore = context.draws

    view.rerender(moved)
    gl.runFrames(2)

    expect(
      gl.contexts.length,
      `${name} allocated a second WebGL context when a prop changed. The panel's ` +
        'preview re-renders on every `onValueChange`, undebounced, so a drag ' +
        'allocates one context per pointer move and stutters',
    ).toBe(1)
    expect(context.loseCalls, 'the running renderer was torn down mid-drag').toBe(0)
    expect(context.draws, 'the animation stopped while the operator was tuning it').toBeGreaterThan(
      drewBefore,
    )
  })

  it('LightPillar opens one context per mount, not two', () => {
    render(<LightPillar />)
    gl.runFrames(2)

    // It used to run a "check WebGL support" effect that created a throwaway
    // canvas, called `getContext('webgl')` on it, and neither released nor
    // returned it — a second permanent slot per mount, to answer a question
    // `new THREE.WebGLRenderer` answers by throwing.
    expect(
      gl.contexts.length,
      'LightPillar opened more than one WebGL context for a single mount',
    ).toBe(1)
  })

  it('ColorBends does not put the string "undefined" in its class list', () => {
    const { container } = render(<ColorBends />)
    const wrapper = container.firstElementChild as HTMLElement

    // `${className}` with no default: every mount from a registry that spreads
    // a `Record<string, unknown>` of operator settings omits it.
    expect(wrapper.className).not.toContain('undefined')
    expect(wrapper.className).toBe('w-full h-full relative overflow-hidden')
  })

  it('FaultyTerminal does not put the string "undefined" in its class list', () => {
    const { container } = render(<FaultyTerminal />)
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.className).not.toContain('undefined')
  })

  it('PixelBlast rebuilds — and releases — only on a reinit key', () => {
    const view = render(<PixelBlast />)
    gl.runFrames(2)
    const first = gl.contexts[0]

    // `antialias` is a WebGL CONTEXT ATTRIBUTE — fixed when the context is
    // created — so it genuinely cannot change without a new one. (It defaults
    // to true here, hence `false`.) The old context has to go back.
    view.rerender(<PixelBlast antialias={false} />)
    gl.runFrames(2)

    expect(gl.contexts.length, 'a reinit key did not rebuild the renderer').toBe(2)
    expect(
      first.loseCalls,
      'the replaced context was never handed back — a reinit-key change would ' +
        'then cost a slot every time',
    ).toBeGreaterThanOrEqual(1)
    expect(gl.liveContexts().length, 'both contexts are live at once').toBe(1)
    expect(gl.contexts[1].draws, 'the rebuilt renderer never drew').toBeGreaterThan(0)
  })

  /**
   * `autoPauseOffscreen` DEFAULTS TO TRUE, so this promise is made on every
   * mount whether the operator asked for it or not — and it was kept by
   * nothing. `visibilityRef` was declared `{ visible: true }`, read by the
   * render loop, and written by no line in the file: no IntersectionObserver,
   * no `visibilitychange`, so the pause branch was unreachable and the effect
   * shaded the full viewport behind whatever the operator had scrolled to.
   *
   * These four are written to fail if it rots back: the first fails if the
   * observer stops existing, the second if the flag it writes stops reaching
   * the loop, the third if the loop never comes back, the fourth if the prop
   * stops gating.
   */
  describe('PixelBlast autoPauseOffscreen', () => {
    /** The element the component observes — its own container div. */
    const containerOf = (root: HTMLElement) => root.firstElementChild as HTMLElement

    it('observes its container', () => {
      const { container } = render(<PixelBlast />)

      const watching = gl.intersectionObservers.filter(
        observer => !observer.disconnected && observer.targets.includes(containerOf(container)),
      )
      expect(
        watching.length,
        'nothing is observing the container, so `visibilityRef.current.visible` ' +
          'is written by no one and stays true forever — `autoPauseOffscreen` ' +
          'cannot do anything',
      ).toBe(1)
    })

    it('stops drawing once the container leaves the viewport', () => {
      const { container } = render(<PixelBlast />)
      gl.runFrames(2)
      const context = gl.contexts[0]
      expect(context.draws, 'it never drew in the first place').toBeGreaterThan(0)

      const notified = gl.setIntersecting(containerOf(container), false)
      expect(notified, 'no observer received the change').toBe(1)

      const drewBefore = context.draws
      gl.runFrames(4)

      expect(
        context.draws,
        'the effect kept shading the whole viewport after scrolling out of view. ' +
          '`autoPauseOffscreen` defaults to true, so this is a promise made on ' +
          'every mount and kept on none',
      ).toBe(drewBefore)
    })

    it('resumes when it comes back into view', () => {
      const { container } = render(<PixelBlast />)
      gl.runFrames(2)
      const context = gl.contexts[0]

      gl.setIntersecting(containerOf(container), false)
      gl.runFrames(3)
      const drewWhilePaused = context.draws

      gl.setIntersecting(containerOf(container), true)
      gl.runFrames(3)

      // The pause keeps the frame SCHEDULED and skips the work, rather than
      // cancelling the loop — so there is nothing to restart, and no second
      // owner of `raf` to race the context-loss path that also stops and starts
      // it. This is the assertion that the choice actually works.
      expect(
        context.draws,
        'the effect never came back after scrolling into view — a paused ' +
          'background that stays paused is worse than one that never paused',
      ).toBeGreaterThan(drewWhilePaused)
    })

    it('keeps drawing off screen when the operator turns the pause off', () => {
      const { container } = render(<PixelBlast autoPauseOffscreen={false} />)
      gl.runFrames(2)
      const context = gl.contexts[0]

      gl.setIntersecting(containerOf(container), false)
      const drewBefore = context.draws
      gl.runFrames(3)

      expect(
        context.draws,
        'the prop no longer gates anything — it now pauses whether or not the ' +
          'operator asked for it, which is the same defect pointing the other way',
      ).toBeGreaterThan(drewBefore)
    })

    it('disconnects the observer on unmount', () => {
      const { container, unmount } = render(<PixelBlast />)
      const target = containerOf(container)
      expect(gl.setIntersecting(target, false)).toBe(1)

      unmount()

      expect(
        gl.setIntersecting(target, false),
        'the observer outlived the component, holding a reference to a detached ' +
          'element and calling back into a torn-down closure',
      ).toBe(0)
    })
  })

  it('EvilEye builds its noise texture once, not once per slider tick', () => {
    // 256 × 256 pixels × 8 octaves ≈ 524,000 synchronous noise evaluations on
    // the MAIN THREAD — felt as a frozen tap, not a dropped frame. It used to
    // sit inside an effect that depended on every prop.
    //
    // The build lives in the effect that creates the renderer, so "the renderer
    // was not rebuilt" is exactly "the noise was not regenerated". (Across
    // separate MOUNTS a module-level cache covers it too: the generator is pure
    // and deterministic, so one result serves the life of the module.)
    const view = render(<EvilEye />)
    gl.runFrames(1)

    for (const flameSpeed of [1.2, 1.4, 1.6, 1.8, 2]) {
      view.rerender(<EvilEye flameSpeed={flameSpeed} />)
    }
    gl.runFrames(2)

    expect(
      gl.contexts.length,
      'a slider tick rebuilt the renderer, and with it the noise texture — ' +
        'half a million noise evaluations, synchronously, per pointer move',
    ).toBe(1)
    expect(gl.contexts[0].draws, 'the animation stopped while the operator tuned it').toBeGreaterThan(
      0,
    )
  })
})

describe('Antigravity (react-three-fiber)', () => {
  beforeEach(() => {
    gl = installGlStub()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  })

  /**
   * fiber configures its renderer from an async function, so a synchronous
   * render returns before the canvas exists. It also measures with
   * react-use-measure, which starts at 0×0 and only reads the element on a
   * resize — and refuses to build a renderer for a zero-size box.
   */
  async function mountFiber(element: React.ReactElement) {
    const view = render(element)
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    return view
  }

  it('mounts, presents a canvas, and releases it on unmount', async () => {
    const view = await mountFiber(<Antigravity />)

    const canvas = view.container.querySelector('canvas')
    expect(canvas, 'fiber never created a canvas').not.toBeNull()
    const context = gl.contextOf(canvas!)
    expect(context, 'the fiber canvas has no GL context').toBeDefined()
    expect(context!.isContextLost()).toBe(false)

    await act(async () => {
      view.unmount()
    })

    expect(
      context!.loseCalls,
      'fiber releases the context from inside a 500 ms setTimeout and never calls ' +
        'gl.dispose(); half a second is several slides of a carousel swipe, and ' +
        'this must be synchronous with the unmount',
    ).toBeGreaterThanOrEqual(1)
    expect(context!.isContextLost()).toBe(true)
  })

  it('survives unmount and remount into the same host element', async () => {
    const host = makeHost()
    const first = mountInto(host, <Antigravity />)
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    unmountRoot(first)

    mountInto(host, <Antigravity />)
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })

    const canvas = host.querySelector('canvas')
    expect(canvas, 'the remount presented no canvas').not.toBeNull()
    expect(gl.contextOf(canvas!)?.isContextLost(), 'the remount got a dead context').toBe(
      false,
    )
    expect(gl.liveContexts().length, 'the remount leaked the first mount').toBe(1)
  })

  it('runs its ring animation when autoAnimate is on', async () => {
    // The catalogue will want `autoAnimate` true — with it false the ring pins
    // to viewport centre, because `pointer` is (0, 0) until something moves it
    // and there is no pointer in a cabinet. The DEFAULT is deliberately left
    // false (that is the wiring agent's call); what this pins is that turning
    // it on does not throw out of `useFrame`, which is where the ring's
    // position is integrated.
    const view = await mountFiber(<Antigravity autoAnimate count={12} />)
    expect(view.container.querySelector('canvas')).not.toBeNull()
    await act(async () => {
      gl.runFrames(3)
    })
    expect(gl.liveContexts().length).toBe(1)
  })

  it('caps the drawing buffer on an oversized box', async () => {
    gl.teardown()
    gl = installGlStub(OVERSIZED)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

    const view = await mountFiber(<Antigravity />)
    // `BudgetedDpr` resolves in an effect, so the budgeted ratio lands on the
    // `dpr` prop one render after the measurement.
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })

    const canvas = view.container.querySelector('canvas')!
    expect(
      canvas.width * canvas.height,
      'fiber re-applies the `dpr` PROP on every render, so a component that ' +
        'lowered the ratio from inside would have it silently restored',
    ).toBeLessThanOrEqual(RENDER_PIXEL_BUDGET)
  })
})

describe('LetterGlitch (canvas 2D)', () => {
  beforeEach(() => {
    gl = installGlStub()
  })

  it('renders with no props at all', () => {
    // It could not before: the props interface carried no optional markers, so
    // `<LetterGlitch />` was a type error and a `Record<string, unknown>` spread
    // — which is how a registry mounts these — could not satisfy it either.
    const view = render(<LetterGlitch />)
    expect(view.container.querySelector('canvas')).not.toBeNull()
    expect(gl.contexts2d.length).toBe(1)
  })

  it('does not paint the surface beneath it black by default', () => {
    const { container } = render(<LetterGlitch />)
    const wrapper = container.firstElementChild as HTMLElement

    expect(
      wrapper.className,
      'the wrapper hardcoded `bg-black`, which paints out whatever the operator ' +
        'put behind this effect on every theme',
    ).not.toContain('bg-black')
    expect(wrapper.style.backgroundColor).toBe('')
    // The outer vignette is a black radial overlay and used to default ON,
    // which darkens the surface beneath just as effectively.
    expect(
      container.querySelectorAll('.pointer-events-none').length,
      'a vignette overlay is painted with nothing asking for one',
    ).toBe(0)
  })

  it('still paints a background and a vignette when asked', () => {
    const { container } = render(
      <LetterGlitch backgroundColor="#101014" outerVignette centerVignette />,
    )
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.style.backgroundColor).toBe('rgb(16, 16, 20)')
    expect(container.querySelectorAll('.pointer-events-none').length).toBe(2)
  })

  it('honours a changed `characters` without a remount', () => {
    const view = render(<LetterGlitch characters="AAAA" smooth={false} />)
    gl.runFrames(2, 200)
    const context = gl.contexts2d[0]
    expect(context.filledText.length, 'nothing was ever drawn').toBeGreaterThan(0)
    expect(new Set(context.filledText)).toEqual(new Set(['A']))

    view.rerender(<LetterGlitch characters="ZZZZ" smooth={false} />)
    const drawnBefore = context.filledText.length
    gl.runFrames(4, 200)

    const after = context.filledText.slice(drawnBefore)
    expect(after.length, 'the loop stopped after the prop changed').toBeGreaterThan(0)
    // The loop is started ONCE and re-schedules itself, so it keeps the closure
    // it was created with. Reading `characters` from that closure — which is
    // what it used to do, with a dependency array of only [glitchSpeed, smooth]
    // — made this prop dead: changing it changed nothing at all.
    expect(
      after.includes('Z'),
      'the render loop is still drawing the alphabet it captured at mount; ' +
        '`characters` is a dead control',
    ).toBe(true)
  })

  it('honours a changed `glitchColors` without a remount', () => {
    const view = render(<LetterGlitch glitchColors={['#ff0000']} smooth={false} />)
    gl.runFrames(2, 200)
    const context = gl.contexts2d[0]
    expect(new Set(context.fillStyles)).toEqual(new Set(['#ff0000']))

    view.rerender(<LetterGlitch glitchColors={['#00ff00']} smooth={false} />)
    const before = context.fillStyles.length
    gl.runFrames(4, 200)

    expect(
      context.fillStyles.slice(before).includes('#00ff00'),
      'the render loop is still drawing the palette it captured at mount; ' +
        '`glitchColors` is a dead control',
    ).toBe(true)
  })

  it('stops its loop on unmount and remounts cleanly', () => {
    const host = makeHost()
    const first = mountInto(host, <LetterGlitch />)
    gl.runFrames(2, 200)
    const context = gl.contexts2d[0]
    const drawnBefore = context.filledText.length
    expect(drawnBefore, 'nothing was drawn on the first mount').toBeGreaterThan(0)

    unmountRoot(first)
    gl.runFrames(3, 200)
    expect(
      context.filledText.length,
      'the rAF loop outlived the component — it is a MAIN-THREAD loop, so it is ' +
        'paid for in input latency on every page the operator navigates to next',
    ).toBe(drawnBefore)

    mountInto(host, <LetterGlitch />)
    const beforeRemount = gl.contexts2d[gl.contexts2d.length - 1].filledText.length
    gl.runFrames(2, 200)
    expect(host.querySelector('canvas')).not.toBeNull()
    // The 2D context is handed back per canvas ELEMENT, exactly as a GL one
    // would be, so a remount over preserved DOM re-enters the same object.
    expect(
      gl.contexts2d[gl.contexts2d.length - 1].filledText.length,
      'the remount never drew',
    ).toBeGreaterThan(beforeRemount)
  })

  it('caps the bitmap and keeps the glyph lattice in CSS pixels', () => {
    gl.teardown()
    gl = installGlStub(OVERSIZED)

    const view = render(<LetterGlitch />)
    const canvas = view.container.querySelector('canvas')!
    const context = gl.contexts2d[0]

    expect(canvas.width * canvas.height).toBeLessThanOrEqual(RENDER_PIXEL_BUDGET)
    expect(canvas.style.width, 'the CSS box was shrunk along with the bitmap').toBe(
      `${OVERSIZED.width}px`,
    )
    // Drawing coordinates stay in CSS pixels and the transform maps them into
    // the bitmap, so the type is the same size on screen at every ratio.
    expect(context.transform[0]).toBeCloseTo(canvas.width / OVERSIZED.width)
    expect(context.transform[1]).toBeCloseTo(canvas.height / OVERSIZED.height)
  })
})

describe('ShapeGrid (canvas 2D)', () => {
  beforeEach(() => {
    gl = installGlStub()
  })

  it('mounts, draws, stops on unmount and remounts cleanly', () => {
    const host = makeHost()
    const first = mountInto(host, <ShapeGrid />)
    gl.runFrames(2)
    const context = gl.contexts2d[0]
    expect(context.clears, 'nothing was ever drawn').toBeGreaterThan(0)

    const clearsBefore = context.clears
    unmountRoot(first)
    gl.runFrames(3)
    expect(context.clears, 'the rAF loop outlived the component').toBe(clearsBefore)

    mountInto(host, <ShapeGrid />)
    const beforeRemount = gl.contexts2d[gl.contexts2d.length - 1].clears
    gl.runFrames(2)
    expect(host.querySelector('canvas')).not.toBeNull()
    expect(
      gl.contexts2d[gl.contexts2d.length - 1].clears,
      'the remount never drew',
    ).toBeGreaterThan(beforeRemount)
  })

  it('exposes the vignette colour that used to be hardcoded', () => {
    const view = render(<ShapeGrid />)
    gl.runFrames(2)
    const context = gl.contexts2d[0]
    // The default preserves the appearance it has always had.
    expect(context.gradientStops, 'the vignette was not drawn at all').toContain('#120F17')

    const before = context.gradientStops.length
    view.rerender(<ShapeGrid vignetteColor="#F4F4F5" />)
    gl.runFrames(2)

    // Before this it was the literal '#120F17', filled over the whole canvas
    // every frame with nothing controlling it — a fixed dark-purple wash, right
    // for one dark theme and wrong over a light one or over any gradient the
    // operator picked.
    expect(
      context.gradientStops.slice(before),
      'the vignette colour is still the hardcoded one; the prop reaches nothing',
    ).toContain('#F4F4F5')
  })

  it('skips the full-canvas vignette composite at strength 0', () => {
    const view = render(<ShapeGrid vignetteStrength={0} />)
    gl.runFrames(3)
    const context = gl.contexts2d[0]
    expect(context.clears, 'the grid itself stopped drawing too').toBeGreaterThan(0)
    expect(
      context.gradientStops,
      'a fully transparent vignette is still composited over the whole canvas ' +
        'every frame',
    ).toEqual([])
    view.unmount()
  })

  it('caps the bitmap and keeps the lattice pitch in CSS pixels', () => {
    gl.teardown()
    gl = installGlStub(OVERSIZED)

    const view = render(<ShapeGrid squareSize={40} />)
    const canvas = view.container.querySelector('canvas')!
    const context = gl.contexts2d[0]

    expect(canvas.width * canvas.height).toBeLessThanOrEqual(RENDER_PIXEL_BUDGET)
    // `resolveRenderScale(2560, 1440, 1)` — this component draws at ratio 1, so
    // the budget resolves against 3,686,400 device pixels, not 14.7M.
    expect(context.transform[0]).toBeCloseTo(canvas.width / OVERSIZED.width)
    expect(
      canvas.style.width,
      'the canvas is `w-full h-full`; nothing here may touch its presentation size',
    ).toBe('')
  })
})
