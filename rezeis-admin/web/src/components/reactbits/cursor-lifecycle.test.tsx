// @vitest-environment jsdom

/**
 * The two global cursor effects that never took anything down.
 * ─────────────────────────────────────────────────────────────────────────────
 * `SplashCursor` ("Жидкий курсор") and `Crosshair` ("Прицел") are mounted by
 * `EffectsProvider` from a settings switch, so their whole lifecycle is
 * mount → unmount → mount, repeatedly, inside one page load. Both were written
 * as if that never happened:
 *
 *   • `SplashCursor`'s effect body had no cleanup at all — no `return () => …`.
 *     It left five `window` listeners, two `document.body` listeners, a
 *     self-rescheduling `requestAnimationFrame` loop and a raw WebGL context
 *     behind on every unmount. The picture vanished (React removes the canvas)
 *     while the fluid simulation kept stepping and drawing into a detached
 *     canvas until the page reloaded.
 *
 *   • `Crosshair` removed its listeners but never cancelled its frame loop, so
 *     every mount added a permanent 60 Hz `gsap.set` loop.
 *
 * WebKit gives a web-content process 16 live WebGL contexts before it starts
 * recycling the oldest into an unrecoverable SyntheticLostContext. An operator
 * trying the eight cursor effects in one sitting walks into that, which is why
 * ACCUMULATION — three mount/unmount cycles with the counters flat — is the
 * assertion that matters here and not merely "cleanup was called once".
 *
 * WHAT IS OBSERVABLE HERE, AND WHAT IS NOT. `gl-stub.ts` supplies a WebGL
 * context per canvas element, a countable rAF queue and a non-zero CSS box; it
 * models the platform contracts (a lost context stays lost; a real driver frees
 * a slot on `WEBGL_lose_context`) rather than observing them. No fragment is
 * ever shaded, so nothing about the PICTURE is claimed. What is claimed is
 * ownership and lifetime: live contexts, queued frames, and bound listeners
 * after unmount.
 */

import { act, render } from '@testing-library/react'
import { StrictMode, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import Crosshair from './Crosshair'
import SplashCursor from './SplashCursor'
import { installGlStub, type GlStubHarness } from './gl-stub'

let gl: GlStubHarness
let bindings: ListenerLedger

const roots: Array<{ root: Root; host: HTMLDivElement }> = []

// One hook, not two: Vitest runs `afterEach` in reverse registration order, so
// a second hook would tear the stub down BEFORE the roots it has to outlive.
afterEach(() => {
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  // A leaked listener does not stop at the end of a test: `document.body` and
  // `window` outlive every `render`, so the handlers a failing test left behind
  // fire again inside the next one and inflate its counts. The ledger knows
  // exactly which are still bound, so it takes them off — AFTER the assertions
  // have read it, and never in place of them.
  bindings?.unbindAll()
  bindings?.restore()
  gl?.teardown()
})

// ── The two probes ───────────────────────────────────────────────────────────

/**
 * `gl-stub`'s Proxy answers its long tail of GL commands with inert noops, so
 * `checkFramebufferStatus()` returns `undefined` and never equals
 * `FRAMEBUFFER_COMPLETE`. `SplashCursor` reads that as "this driver supports no
 * render-texture format at all", hands `null` formats to `initFramebuffers`
 * and throws on `null.internalFormat` before it ever reaches the code under
 * test. Answering COMPLETE is the same happy-path assumption the stub already
 * makes for `COMPILE_STATUS` and `LINK_STATUS`; it is not what is being
 * asserted, it is what lets the component get as far as owning anything.
 *
 * Assigned rather than `vi.spyOn`'d on purpose: `installGlStub` has already
 * spied this property, and `vi.spyOn` reuses an existing spy instead of
 * wrapping it — taking the "original" back out of it yields the spy itself and
 * the delegation below becomes infinite recursion. `gl.teardown()` restores the
 * real method either way.
 */
function completeFramebuffers(): void {
  const stubbed = HTMLCanvasElement.prototype.getContext as unknown as (
    kind: string,
    options?: unknown,
  ) => unknown
  function patched(this: HTMLCanvasElement, kind: string, options?: unknown) {
    const context = stubbed.call(this, kind, options) as
      | (Record<string, unknown> & { FRAMEBUFFER_COMPLETE: number })
      | null
    if (context && kind !== '2d') {
      context.checkFramebufferStatus = () => context.FRAMEBUFFER_COMPLETE
    }
    return context
  }
  HTMLCanvasElement.prototype.getContext = patched as typeof HTMLCanvasElement.prototype.getContext
}

interface Binding {
  readonly target: string
  readonly type: string
  readonly handler: unknown
}

interface ListenerLedger {
  /** Every listener bound and not yet unbound, in binding order. */
  readonly live: Binding[]
  /** `['window:mousemove', …]` — what a failure message should read out. */
  names(): string[]
  /** Take every survivor off, so one test's leak is not the next one's input. */
  unbindAll(): void
  restore(): void
}

/**
 * A ledger of what is still bound, keyed by HANDLER IDENTITY.
 *
 * Counting `addEventListener` calls against `removeEventListener` calls would
 * pass for the defect this file exists to catch: a cleanup that removes a
 * freshly created anonymous function removes nothing at all, while the call
 * counts balance perfectly. So a removal only strikes an entry when it names
 * the very function that was bound.
 */
function trackListeners(targets: ReadonlyArray<readonly [string, EventTarget]>): ListenerLedger {
  const live: Binding[] = []
  const restores: Array<() => void> = []
  const unbind = new Map<string, (type: string, handler: unknown) => void>()

  for (const [name, target] of targets) {
    const add = target.addEventListener
    const remove = target.removeEventListener
    unbind.set(name, (type, handler) => {
      ;(remove as (...args: unknown[]) => unknown).call(target, type, handler)
    })
    target.addEventListener = function (this: EventTarget, type: string, handler: unknown, options?: unknown) {
      live.push({ target: name, type, handler })
      return (add as (...args: unknown[]) => unknown).call(this, type, handler, options)
    } as EventTarget['addEventListener']
    target.removeEventListener = function (this: EventTarget, type: string, handler: unknown, options?: unknown) {
      const index = live.findIndex(
        entry => entry.target === name && entry.type === type && entry.handler === handler,
      )
      if (index >= 0) live.splice(index, 1)
      return (remove as (...args: unknown[]) => unknown).call(this, type, handler, options)
    } as EventTarget['removeEventListener']
    restores.push(() => {
      target.addEventListener = add
      target.removeEventListener = remove
    })
  }

  return {
    live,
    names: () => live.map(entry => `${entry.target}:${entry.type}`),
    unbindAll: () => {
      for (const entry of live.splice(0)) unbind.get(entry.target)?.(entry.type, entry.handler)
    },
    restore: () => {
      for (const restore of restores) restore()
    },
  }
}

/**
 * A host element the TEST owns, so the same DOM node can be mounted into
 * twice. Testing Library caches one React root per container and refuses to
 * render into it again after `unmount()` — which is precisely the case here.
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

/** A `mousemove` real enough for both components: they read `clientX/clientY`. */
function moveMouse(over: EventTarget): void {
  act(() => {
    over.dispatchEvent(new MouseEvent('mousemove', { clientX: 40, clientY: 30, bubbles: true }))
  })
}

/**
 * jsdom implements no `TouchEvent`, so the shape the handler actually reads is
 * supplied directly: `targetTouches[i].clientX/clientY/identifier`.
 */
function startTouch(over: EventTarget): void {
  act(() => {
    const event = new Event('touchstart', { bubbles: true })
    Object.defineProperty(event, 'targetTouches', {
      value: [{ clientX: 40, clientY: 30, identifier: 1 }],
    })
    over.dispatchEvent(event)
  })
}

/**
 * The opposite of `completeFramebuffers`: a machine that hands back no WebGL
 * context at all. `2d` still works, because `gl-stub` uses it for its own
 * bookkeeping and refusing it would be modelling a different platform.
 *
 * Assigned rather than `vi.spyOn`'d for the reason spelled out above.
 */
function refuseWebGLContexts(): void {
  const stubbed = HTMLCanvasElement.prototype.getContext as unknown as (
    kind: string,
    options?: unknown,
  ) => unknown
  function patched(this: HTMLCanvasElement, kind: string, options?: unknown) {
    if (kind !== '2d') return null
    return stubbed.call(this, kind, options)
  }
  HTMLCanvasElement.prototype.getContext = patched as typeof HTMLCanvasElement.prototype.getContext
}

// ── SplashCursor ─────────────────────────────────────────────────────────────

describe('SplashCursor lifecycle', () => {
  beforeEach(() => {
    gl = installGlStub()
    completeFramebuffers()
    bindings = trackListeners([
      ['window', window],
      ['document.body', document.body],
    ])
  })

  it('mounts, opens one context and runs its simulation', () => {
    const view = render(<SplashCursor />)

    const canvas = view.container.querySelector('canvas')
    expect(canvas, 'SplashCursor rendered no canvas').not.toBeNull()
    expect(gl.liveContexts()).toHaveLength(1)

    // The loop is dormant until the first pointer event: `handleFirstMouseMove`
    // is what calls `updateFrame()` the first time.
    expect(gl.pendingFrames()).toBe(0)
    moveMouse(document.body)
    expect(gl.pendingFrames(), 'the simulation never started').toBe(1)
    expect(gl.contexts[0].draws, 'the simulation drew nothing').toBeGreaterThan(0)

    view.unmount()
  })

  it('hands its WebGL context back on unmount', () => {
    const view = render(<SplashCursor />)
    moveMouse(document.body)
    const context = gl.contexts[0]
    expect(context.loseCalls, 'the context was released before unmount').toBe(0)

    view.unmount()

    expect(
      context.loseCalls,
      'the raw WebGL context was left alive on unmount. A dropped reference ' +
        'frees nothing — WebKit returns the slot only when the context object ' +
        'is destroyed, and this effect is unmounted every time the operator ' +
        'picks a different cursor',
    ).toBeGreaterThanOrEqual(1)
    expect(context.isContextLost()).toBe(true)
    expect(gl.liveContexts(), 'a context outlived the component').toEqual([])
  })

  it('cancels its queued frame on unmount', () => {
    const view = render(<SplashCursor />)
    moveMouse(document.body)
    expect(gl.pendingFrames()).toBe(1)

    view.unmount()

    expect(
      gl.pendingFrames(),
      'the fluid simulation is still queued after unmount. `updateFrame` ends ' +
        'in `requestAnimationFrame(updateFrame)`, so an id that is never stored ' +
        'and never cancelled keeps the loop, the context and the detached ' +
        'canvas alive until the page reloads',
    ).toBe(0)
  })

  it('leaves no loop running when two were started', () => {
    // `handleFirstMouseMove` and `handleFirstTouchStart` BOTH call
    // `updateFrame()`, so a device that reports a mouse move and a touch start
    // — a touchscreen laptop, a tablet with a trackpad — runs two independent
    // rAF chains. Only the last requested id can be stored, so cancelling is
    // not enough on its own: an unmounted flag is what stops the other chain
    // from asking for the frame after it.
    const view = render(<SplashCursor />)
    moveMouse(document.body)
    startTouch(document.body)
    gl.runFrames(1)
    expect(gl.pendingFrames(), 'expected two independent frame loops').toBe(2)

    view.unmount()
    gl.runFrames(3)

    expect(
      gl.pendingFrames(),
      'a frame loop survived unmount and re-queued itself. Cancelling the last ' +
        'stored id cannot reach a second chain — the already-dispatched frame ' +
        'has to see that the component is gone and stop asking for another',
    ).toBe(0)
  })

  it('unbinds every listener when it is unmounted before the pointer ever moves', () => {
    // The case that pins the two `document.body` probes. `handleFirstMouseMove`
    // and `handleFirstTouchStart` unbind THEMSELVES once they have fired, so an
    // operator who moved the mouse hides them; an operator who switched the
    // effect straight from the settings page leaves both behind.
    const view = render(<SplashCursor />)
    expect(bindings.names().sort(), 'SplashCursor bound something else than expected').toEqual([
      'document.body:mousemove',
      'document.body:touchstart',
      'window:mousedown',
      'window:mousemove',
      'window:touchend',
      'window:touchmove',
      'window:touchstart',
    ])

    view.unmount()

    expect(
      bindings.names(),
      'listeners survived unmount and go on driving a component that is no ' +
        'longer on screen',
    ).toEqual([])
  })

  it('unbinds every listener after the pointer has driven it', () => {
    const view = render(<SplashCursor />)
    moveMouse(document.body)
    startTouch(document.body)
    expect(bindings.live.length, 'SplashCursor bound nothing at all').toBeGreaterThan(0)

    view.unmount()

    expect(
      bindings.names(),
      'listeners survived unmount and go on driving a component that is no ' +
        'longer on screen',
    ).toEqual([])
  })

  /**
   * The other half of releasing a context: OWNING the canvas it lives on.
   *
   * A canvas hands the SAME context object back to every later `getContext`
   * call, lost or not. So a component that opens its context on a
   * `<canvas ref>` — an element React keeps across an effect cleanup — and
   * destroys that context in the cleanup gives its own next setup a dead one.
   * `createShader`/`createProgram` return null on a lost context, so the
   * component bails to a permanently blank full-screen canvas with nothing
   * thrown for an error boundary to catch. `reactbits-canvas-ownership.test.ts`
   * bans the shape across the directory; these pin the runtime behaviour for
   * this component.
   *
   * WHICH OF THESE ACTUALLY DISCRIMINATES, measured by reverting the repair
   * rather than assumed. The first two do: both go red when the canvas goes
   * back to `<canvas ref>`, and both go red when only `container.removeChild`
   * is dropped, because the dead element stays stacked over the live one and is
   * what `querySelector('canvas')` returns. The third does NOT, and is kept as
   * a liveness anchor rather than a guard — see the note on it.
   */
  describe('canvas ownership', () => {
    it('gives StrictMode’s second setup a live context', () => {
      // setup → cleanup → setup against the SAME rendered tree. This is every
      // dev mount, and it needs no dependency change to reproduce.
      const view = render(
        <StrictMode>
          <SplashCursor />
        </StrictMode>,
      )
      moveMouse(document.body)

      const canvas = view.container.querySelector('canvas')
      expect(canvas, 'no canvas was presented after the double-invoke').not.toBeNull()
      const presented = gl.contextOf(canvas!)
      expect(
        presented?.isContextLost(),
        'the canvas on screen is backed by a context that was already ' +
          'destroyed: it survived the cleanup that lost its context, and ' +
          '`getContext` handed the same dead one to the second setup',
      ).toBe(false)
      expect(presented!.draws, 'the presented canvas never drew — the second setup bailed').toBeGreaterThan(0)
      expect(
        view.container.querySelectorAll('canvas').length,
        "the first setup's canvas was never taken out of the container; it " +
          'paints nothing and is still stacked full-screen over the live one',
      ).toBe(1)
      expect(gl.liveContexts().length, 'the double-invoke leaked a context').toBe(1)

      view.unmount()
    })

    it('gives a re-run of the effect a live context', () => {
      // `BACK_COLOR` defaults to a fresh object literal every render, so this
      // component's 16-entry dependency array changes identity on EVERY render
      // of its parent — and `EffectsProvider` re-renders on any store change.
      // The effect therefore tears down and rebuilds in production, over an
      // element React holds onto, which is the same poisoning as StrictMode's
      // but without the dev-only framing.
      const view = render(<SplashCursor />)
      moveMouse(document.body)
      const firstCanvas = view.container.querySelector('canvas')

      view.rerender(<SplashCursor />)
      moveMouse(document.body)

      const canvas = view.container.querySelector('canvas')
      expect(canvas, 'the re-run presented no canvas').not.toBeNull()
      expect(canvas, 'the re-run reused the element whose context it had destroyed').not.toBe(
        firstCanvas,
      )
      const context = gl.contextOf(canvas!)
      expect(context?.isContextLost(), 'the re-run inherited a dead context').toBe(false)
      expect(context!.draws, 'the re-run never drew a frame').toBeGreaterThan(0)
      expect(view.container.querySelectorAll('canvas').length, 'the old canvas was left behind').toBe(1)
      expect(gl.liveContexts().length, 'the re-run leaked the previous context').toBe(1)

      view.unmount()
    })

    it('gives a remount into the same host element a live context', () => {
      // The SAME host node both times — what production does when the operator
      // switches to another cursor effect and back.
      //
      // WHAT THIS DOES NOT PROVE, stated so it is not assumed. It is NOT the
      // ownership guard: `root.unmount()` makes React discard its own subtree,
      // so the second mount gets a fresh `<canvas>` element even under the
      // defect, and this spec stays green against it — measured, not reasoned.
      // The two above are the discriminating ones, because they are the two
      // shapes where React KEEPS the element across the cleanup. What is left
      // here is still worth pinning: a full cycle through a real React root
      // draws again and leaks no context.
      const host = makeHost()
      const first = mountInto(host, <SplashCursor />)
      moveMouse(document.body)
      const firstCanvas = host.querySelector('canvas')
      expect(firstCanvas, 'the first mount presented no canvas').not.toBeNull()

      unmountRoot(first)
      expect(
        host.querySelector('canvas'),
        'the dead canvas was left in the container after unmount',
      ).toBeNull()

      mountInto(host, <SplashCursor />)
      moveMouse(document.body)

      const canvas = host.querySelector('canvas')
      expect(canvas, 'the remount presented no canvas').not.toBeNull()
      expect(canvas, 'the remount reused the element whose context it destroyed').not.toBe(firstCanvas)
      const context = gl.contextOf(canvas!)
      expect(context?.isContextLost(), 'the remount inherited a dead context').toBe(false)
      expect(context!.draws, 'the remount never drew a frame').toBeGreaterThan(0)
      expect(gl.liveContexts().length, 'the remount leaked the first mount').toBe(1)
    })
  })

  it('accumulates nothing across three mount/unmount cycles', () => {
    for (let cycle = 0; cycle < 3; cycle++) {
      const view = render(<SplashCursor />)
      moveMouse(document.body)
      startTouch(document.body)
      gl.runFrames(2)
      view.unmount()
      gl.runFrames(2)
    }

    expect(gl.contexts, 'the three mounts did not each open a context').toHaveLength(3)
    expect(
      gl.liveContexts().length,
      'live WebGL contexts pile up one per toggle; sixteen of them is where ' +
        'WebKit starts handing out unrecoverable losses',
    ).toBe(0)
    expect(gl.pendingFrames(), 'frame loops pile up one per toggle').toBe(0)
    expect(bindings.names(), 'listeners pile up one set per toggle').toEqual([])
  })
})

// ── Crosshair ────────────────────────────────────────────────────────────────

/**
 * What happens when the machine cannot give this effect what it needs.
 *
 * A cursor trail is decoration. Its failure budget is "the operator does not
 * get a cursor trail" — never "the operator gets a white screen". Both paths
 * below ended in the second one:
 *
 *   1. NO CONTEXT AT ALL. `getWebGLContext` threw `Unable to initialize WebGL.`
 *      straight out of the effect body, so the exception went to React and took
 *      the whole admin panel down. The `if (!gl || !ext) return;` guard one line
 *      above it could never run — control never reached it.
 *
 *   2. A CONTEXT, BUT NO USABLE RENDER-TEXTURE FORMAT. `getSupportedFormat`
 *      returns `null` by design when a driver supports none, and
 *      `initFramebuffers` dereferences `rgba.internalFormat` without asking.
 *      Same white screen through a different door, and it is the reason
 *      `completeFramebuffers()` exists at the top of this file — every other
 *      spec has to hand the component a working format just to get past it.
 *
 * Both are reachable in the field, not merely in theory: a browser with WebGL
 * disabled hits the first, and so does any tab that has already spent WebKit's
 * 16 contexts — which is exactly the ceiling the accumulation specs above are
 * about. So the two failure modes compound.
 */
describe('SplashCursor when the machine cannot give it a context', () => {
  beforeEach(() => {
    gl = installGlStub()
    bindings = trackListeners([
      ['window', window],
      ['document.body', document.body],
    ])
  })

  it('renders nothing rather than taking the panel down with it', () => {
    refuseWebGLContexts()

    let view: ReturnType<typeof render> | undefined
    expect(() => {
      view = render(<SplashCursor />)
    }, 'a decorative effect threw out of its effect body and unmounted the app').not.toThrow()

    // The canvas joins the document only once a context is behind it, so its
    // absence is what "gave up quietly" looks like from the DOM.
    expect(view?.container.querySelector('canvas'), 'a dead canvas was left on screen').toBeNull()
  })

  /**
   * WHAT THIS DOES AND DOES NOT PROVE, because the name alone would overstate
   * it. Today nothing binds before the context is acquired — every listener and
   * the frame loop are set up further down, past the point where a refusal
   * returns. So against the current ORDER this assertion has nothing to observe
   * and would hold even if the cleanup were deleted.
   *
   * It is here for the order itself. Move one `addEventListener` above the
   * acquisition — an easy thing to do while editing a 1300-line effect — and a
   * refused mount starts leaking a listener per attempt, with no picture on
   * screen to hint at it. That it can see such a leak is not assumed either: it
   * was checked by binding one deliberately above the acquisition, and this
   * spec failed with `[ 'window:mousedown' ]`.
   */
  it('binds nothing before it knows it has a context', () => {
    refuseWebGLContexts()
    const view = render(<SplashCursor />)
    view.unmount()

    expect(bindings.names(), 'a listener was bound before the context was in hand').toEqual([])
    expect(gl.pendingFrames(), 'a frame was queued before the context was in hand').toBe(0)
  })

  it('survives a driver that supports no render-texture format', () => {
    // Deliberately NOT calling `completeFramebuffers()`: this spec is the one
    // place that lets the stub answer as the pessimistic driver it models.
    expect(() => {
      render(<SplashCursor />)
    }, 'null formats reached initFramebuffers and threw on .internalFormat').not.toThrow()
  })
})

describe('Crosshair lifecycle', () => {
  beforeEach(() => {
    gl = installGlStub()
    bindings = trackListeners([['window', window]])
  })

  it('starts its frame loop on the first pointer move', () => {
    const view = render(<Crosshair />)

    expect(gl.pendingFrames()).toBe(0)
    moveMouse(window)
    expect(gl.pendingFrames(), 'Crosshair never started its loop').toBe(1)

    view.unmount()
  })

  it('cancels its frame loop on unmount', () => {
    const view = render(<Crosshair />)
    moveMouse(window)

    view.unmount()

    expect(
      gl.pendingFrames(),
      'the crosshair render loop is still queued after unmount. It ends in ' +
        '`requestAnimationFrame(render)` and re-queues itself forever, so every ' +
        'toggle of this effect adds a permanent 60 Hz `gsap.set` loop over ' +
        'elements React has already removed',
    ).toBe(0)

    gl.runFrames(3)
    expect(gl.pendingFrames(), 'the loop re-queued itself after unmount').toBe(0)
  })

  it('still unbinds its pointer listeners on unmount', () => {
    const view = render(<Crosshair />)
    moveMouse(window)

    view.unmount()

    expect(bindings.names(), 'a pointer listener outlived the component').toEqual([])
  })

  it('accumulates nothing across three mount/unmount cycles', () => {
    for (let cycle = 0; cycle < 3; cycle++) {
      const view = render(<Crosshair />)
      moveMouse(window)
      gl.runFrames(2)
      view.unmount()
      gl.runFrames(2)
    }

    expect(
      gl.pendingFrames(),
      'a 60 Hz loop is left behind on every toggle, so three toggles leave ' +
        'three of them running against a component that is gone',
    ).toBe(0)
    expect(bindings.names(), 'listeners pile up one set per toggle').toEqual([])
  })
})
