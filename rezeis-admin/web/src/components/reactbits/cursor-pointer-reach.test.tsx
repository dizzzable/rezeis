/**
 * The two cursor effects that could not be reached by a pointer.
 * ─────────────────────────────────────────────────────────────────────────────
 * `EffectsProvider` mounts both inside `FixedOverlay` — `pointer-events: none;
 * position: fixed; inset: 0; z-index: 9999` — and that one declaration is
 * inherited by the entire subtree, so no node under it can ever be the TARGET
 * of a pointer event.
 *
 * `GhostCursor` bound `pointermove`/`pointerenter`/`pointerleave` to
 * `host.parentElement`, which under the provider IS that overlay. `BlobCursor`
 * used React's `onMouseMove`/`onTouchMove` on its own root, and a React
 * synthetic handler only fires when the NATIVE target lies in that subtree. So
 * an operator switched either effect on and got a component that mounted, held
 * a WebGL context and a render loop, occupied the DOM, and followed nothing.
 * Identical to the defect already fixed in `TextCursor` — see the comment there
 * and the `textTrail` case in `EffectsProvider.tsx`.
 *
 * Both specs below therefore go through the real provider, dispatch a real
 * event at `window`, and assert something VISIBLE changed: the ghost's render
 * loop wakes and its mouse uniform lands on the pointer, the blobs get a
 * transform that puts them under it. A "the listener is on window" assertion
 * would pass against a component that listened and then did nothing.
 *
 * The second half is `GhostCursor` writing `position: relative` INLINE onto the
 * overlay it does not own. Inline beats the `fixed` class, and the overlay has
 * no width/height of its own (only `inset-0`), so the full-screen layer
 * collapsed into an ordinary block in the flow — and the "restore" read back an
 * empty string, because there had never been an inline value to save.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import * as THREE from 'three'
import gsap from 'gsap'

import { useAppearanceStore } from '@/lib/theme/appearance-store'
import { useEffectsStore, type CursorEffectId } from '@/lib/theme/effects-store'
import { EffectsProvider } from '@/components/EffectsProvider'
import { installGlStub, type GlStubHarness } from './gl-stub'

/** The overlay `FixedOverlay` renders — the thing that kills subtree listeners. */
const OVERLAY = '.pointer-events-none.fixed.inset-0'

/** `installGlStub` lays every element out at this box, and at origin (0,0). */
const VIEWPORT = { width: 1280, height: 800 }

function renderProvider(effect: CursorEffectId) {
  useEffectsStore.setState({ cursorEffect: effect, clickEffect: 'none' })
  return render(
    <EffectsProvider>
      <main>page</main>
    </EffectsProvider>,
  )
}

/** Every listener a component bound to `window`, by event type. */
function listenerLedger() {
  const add = vi.spyOn(window, 'addEventListener')
  const remove = vi.spyOn(window, 'removeEventListener')
  const handlersFor = (spy: typeof add, type: string) =>
    spy.mock.calls.filter(([t]) => t === type).map(([, fn]) => fn)
  return {
    added: (type: string) => handlersFor(add, type),
    removed: (type: string) => handlersFor(remove, type),
  }
}

/**
 * A pointer event carrying viewport coordinates. jsdom's `PointerEvent` is used
 * where it exists; the handler under test reads nothing but `clientX`/`clientY`,
 * which `MouseEvent` carries identically.
 */
const PointerMoveEvent: new (type: string, init: MouseEventInit) => MouseEvent =
  typeof PointerEvent === 'function' ? PointerEvent : MouseEvent

function pointerMove(clientX: number, clientY: number) {
  return new PointerMoveEvent('pointermove', { clientX, clientY, bubbles: true })
}

describe('GhostCursor — a pointer event at window reaches it', () => {
  let gl: GlStubHarness

  beforeEach(() => {
    useEffectsStore.getState().reset()
    useAppearanceStore.setState({ visualEffects: true })
    // jsdom has no canvas backend and lays everything out at 0×0, so without
    // this the component never gets a context and `resize` never validates a
    // size — nothing below would have a subject.
    gl = installGlStub(VIEWPORT)
  })

  afterEach(() => {
    cleanup()
    gl.teardown()
  })

  /**
   * The `ShaderMaterial` the effect draws with.
   *
   * Nothing about the PICTURE is observable in jsdom — no fragment is ever
   * shaded, and `gl-stub` reports zero active uniforms, so three never uploads
   * a uniform value to the GL boundary either. The uniform object the render
   * loop writes each frame is therefore the closest thing to "where the ghost
   * is" that this environment can see, and `scene.add(mesh)` is where it
   * becomes reachable from outside the component.
   */
  function captureGhostMaterial() {
    const spy = vi.spyOn(THREE.Object3D.prototype, 'add')
    return () => {
      const added = spy.mock.calls.flat() as THREE.Object3D[]
      const mesh = added.find(
        (object): object is THREE.Mesh =>
          ((object as THREE.Mesh).material as THREE.ShaderMaterial | undefined)?.uniforms
            ?.iMouse !== undefined,
      )
      return mesh?.material as THREE.ShaderMaterial | undefined
    }
  }

  async function mountGhost() {
    const ghostMaterial = captureGhostMaterial()
    const view = renderProvider('ghost')
    await waitFor(() => {
      expect(view.container.querySelector(`${OVERLAY} canvas`)).not.toBeNull()
    })
    const canvas = view.container.querySelector(`${OVERLAY} canvas`) as HTMLCanvasElement
    const context = gl.contextOf(canvas)
    expect(context, 'no GL context — nothing below is under test').toBeDefined()
    return { ...view, canvas, context: context!, ghostMaterial }
  }

  /**
   * With no pointer feeding it positions the trail fades and the loop retires
   * itself — which is what makes "a frame is queued again" a statement about
   * the pointer event and nothing else.
   */
  async function idleUntilTheLoopStops() {
    await act(async () => {
      gl.runFrames(4, 1000)
    })
    expect(gl.pendingFrames(), 'the render loop never went to sleep').toBe(0)
  }

  it('wakes its render loop and moves the ghost onto the pointer', async () => {
    const { context, ghostMaterial } = await mountGhost()
    await idleUntilTheLoopStops()
    const drawsWhileAsleep = context.draws

    await act(async () => {
      window.dispatchEvent(pointerMove(320, 200))
    })

    // Bound to the overlay this stayed asleep forever: the event has no path to
    // a `pointer-events: none` subtree.
    expect(gl.pendingFrames(), 'the pointer event did not reach the effect').toBe(1)

    await act(async () => {
      gl.runFrames(1)
    })

    expect(context.draws, 'awake but drawing nothing').toBeGreaterThan(drawsWhileAsleep)

    // 320/1280 and 1 − 200/800: the overlay is `fixed inset-0`, so its rect
    // origin is (0,0) and viewport coordinates need no correction — but the
    // component still measures its own box, which is what makes it correct
    // anywhere else too.
    const material = ghostMaterial()!
    expect(material.uniforms.iMouse.value.x).toBeCloseTo(0.25, 5)
    expect(material.uniforms.iMouse.value.y).toBeCloseTo(0.75, 5)
    expect(material.uniforms.iOpacity.value, 'woke up already faded out').toBe(1)
  })

  it('follows the pointer across the whole viewport', async () => {
    const { ghostMaterial } = await mountGhost()
    await idleUntilTheLoopStops()

    // Three corners of the box, not one sample: a handler that fired once by
    // accident, or one that dropped the vertical flip, cannot keep pace.
    const path: Array<[number, number, number, number]> = [
      [0, 0, 0, 1],
      [1280, 800, 1, 0],
      [640, 400, 0.5, 0.5],
    ]

    for (const [clientX, clientY, expectedX, expectedY] of path) {
      await act(async () => {
        window.dispatchEvent(pointerMove(clientX, clientY))
        gl.runFrames(1)
      })
      const material = ghostMaterial()!
      expect(material.uniforms.iMouse.value.x).toBeCloseTo(expectedX, 5)
      expect(material.uniforms.iMouse.value.y).toBeCloseTo(expectedY, 5)
    }
  })

  it('writes no inline style onto the overlay it does not own', async () => {
    const { container } = await mountGhost()

    // `position: relative` inline beats the `fixed` CLASS, and the overlay
    // carries no size of its own — only `inset-0` — so the full-screen layer
    // becomes a zero-height block in the document flow, taking every effect
    // mounted in it with it.
    const overlay = container.querySelector(OVERLAY) as HTMLElement
    expect(overlay.style.position).toBe('')
    expect(overlay.getAttribute('style'), 'the component wrote to a node it does not own').toBe(
      null,
    )
  })

  it('releases its context and its window listener when the effect is switched off', async () => {
    const ledger = listenerLedger()
    const { context, unmount } = await mountGhost()
    expect(context.isContextLost()).toBe(false)

    const bound = ledger.added('pointermove')
    expect(bound.length, 'nothing was bound to window at all').toBeGreaterThan(0)

    await act(async () => {
      unmount()
    })

    for (const handler of bound) expect(ledger.removed('pointermove')).toContain(handler)
    // WebKit hands a web-content process 16 live contexts before it recycles the
    // oldest into an unrecoverable loss, and an operator trying the effects out
    // one by one is exactly that sequence.
    expect(context.isContextLost()).toBe(true)

    // And a late event must not resurrect the loop over a disposed renderer.
    expect(gl.pendingFrames()).toBe(0)
    await act(async () => {
      window.dispatchEvent(pointerMove(10, 10))
    })
    expect(gl.pendingFrames(), 'a listener outlived the component').toBe(0)
  })
})

describe('BlobCursor — a pointer event at window reaches it', () => {
  let gl: GlStubHarness

  beforeEach(() => {
    useEffectsStore.getState().reset()
    useAppearanceStore.setState({ visualEffects: true })
    // No canvas here, but the same harness pins `getBoundingClientRect` to a
    // real box at origin (0,0) and freezes the clock, which is what makes the
    // gsap assertions below deterministic (see `settleGsap`).
    gl = installGlStub(VIEWPORT)
  })

  afterEach(() => {
    cleanup()
    gl.teardown()
  })

  /**
   * gsap animates on its own ticker, driven by a clock `installGlStub` freezes,
   * so a tween created inside a test never advances on its own — which is what
   * keeps these assertions from racing an asynchronous ticker. Driving the
   * global timeline forward renders every live tween to its end synchronously,
   * and the end state is the one worth asserting: where the blob was told to go.
   */
  function settleGsap() {
    gsap.globalTimeline.time(gsap.globalTimeline.time() + 1)
  }

  async function mountBlob() {
    const view = renderProvider('blob')
    await waitFor(() => {
      expect(view.container.querySelector(OVERLAY)).not.toBeNull()
    })
    const blobs = Array.from(
      view.container.querySelectorAll<HTMLElement>(`${OVERLAY} .will-change-transform`),
    )
    expect(blobs, 'the trail did not render').toHaveLength(3)
    // Nothing has moved yet, so "it moved" below cannot be a leftover.
    expect(blobs.map((blob) => blob.style.transform)).toEqual(['', '', ''])
    return { ...view, blobs }
  }

  it('moves every blob onto a mouse event dispatched at window', async () => {
    const { blobs } = await mountBlob()

    await act(async () => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 320, clientY: 200 }))
    })
    settleGsap()

    // The root is inside `fixed inset-0`, so its rect origin is (0,0) and the
    // container-relative position the component computes is the viewport
    // position — but it still subtracts its own rect, which is what keeps it
    // correct if it is ever mounted somewhere else.
    for (const blob of blobs) {
      expect(blob.style.transform, 'nothing was written to the element').not.toBe('')
      expect(gsap.getProperty(blob, 'x')).toBe(320)
      expect(gsap.getProperty(blob, 'y')).toBe(200)
    }
  })

  it('follows a touch move as well', async () => {
    const { blobs } = await mountBlob()

    // jsdom builds no `TouchEvent` worth using, and the handler reads exactly
    // `e.touches[0].clientX/clientY` — so an event carrying that shape is a
    // faithful stand-in for what a phone delivers.
    const touchmove = Object.assign(new Event('touchmove'), {
      touches: [{ clientX: 100, clientY: 60 }],
    })

    await act(async () => {
      window.dispatchEvent(touchmove)
    })
    settleGsap()

    for (const blob of blobs) {
      expect(gsap.getProperty(blob, 'x')).toBe(100)
      expect(gsap.getProperty(blob, 'y')).toBe(60)
    }
  })

  it('stops following once the effect is switched off', async () => {
    const ledger = listenerLedger()
    const { blobs, unmount } = await mountBlob()

    const bound = ledger.added('mousemove')
    expect(bound.length, 'nothing was bound to window at all').toBeGreaterThan(0)

    await act(async () => {
      unmount()
    })
    for (const handler of bound) expect(ledger.removed('mousemove')).toContain(handler)

    // A leaked listener would keep tweening detached nodes for the rest of the
    // session, which is invisible on screen and costs a frame every move.
    await act(async () => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 700, clientY: 400 }))
    })
    settleGsap()
    for (const blob of blobs) expect(blob.style.transform).toBe('')
  })

  it('adds nothing to the overlay that takes the pointer back', async () => {
    const { container } = await mountBlob()

    // Structural, and deliberately so: this is the reverse defect an operator
    // already hit with PixelTrail — a full-bleed layer at z-9999 that swallows
    // every click. Now that the root carries no handlers, nothing about it
    // needs to be hit-testable.
    const root = container.querySelector(OVERLAY)?.firstElementChild as HTMLElement
    expect(root.className).toContain('pointer-events-none')
    const takesPointer = Array.from(
      container.querySelectorAll<HTMLElement>(`${OVERLAY} *`),
    ).filter((el) => el.style.pointerEvents !== '' && el.style.pointerEvents !== 'none')
    expect(takesPointer).toEqual([])
  })
})
