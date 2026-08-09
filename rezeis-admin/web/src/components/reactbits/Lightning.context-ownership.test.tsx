/**
 * Lightning: a second setup must not inherit the context the first one killed,
 * and moving a slider must not cause a second setup at all.
 *
 * WHY THIS FILE EXISTS, and why `Lightning.test.tsx` could not host it. That
 * file stubs `getContext` as `() => stubGl()` — a FRESH happy-path object on
 * every call. Under that stub the defect below is invisible: every setup gets a
 * pristine context no matter what the previous one did to it, so all six of its
 * tests passed against the broken component. The stub here has the real
 * contract instead, and it is the only reason any of this is provable:
 *
 *   • one context per CANVAS ELEMENT, handed back by every later `getContext`;
 *   • a lost context stays lost and keeps being handed back;
 *   • `isContextLost()` reports it;
 *   • `createShader`/`createProgram` return null on a lost context, with a null
 *     info log — which is what the component actually sees, and why the failure
 *     was silent rather than thrown.
 *
 * THE TWO DEFECTS, kept separate because they are separate:
 *
 *   1. OWNERSHIP. The component rendered `<canvas ref>` and opened the context
 *      on React's element, then destroyed that context in its cleanup. React
 *      keeps the element across a cleanup, so the next setup's `getContext`
 *      returned the ALREADY-LOST context, `createShader` gave null, and the
 *      component bailed to a permanently dead canvas.
 *   2. CHURN. Its dependency array was `[hue, xOffset, speed, intensity, size]`
 *      — four of them operator sliders — so the teardown in (1) was triggered by
 *      the operator, on every tick of every slider, in a preview
 *      (`glass-settings-card.tsx` → `LivePreview`) that is not debounced.
 *
 * WHAT CANNOT BE ASSERTED HERE, stated so it is not assumed. jsdom has no
 * WebGL: that a real driver frees a slot on `WEBGL_lose_context`, and that it
 * hands back a lost context rather than a fresh one, are the platform's
 * contract, modelled here and not observed. What is pinned is everything the
 * component controls — which element the context lives on, how many are
 * allocated, when they are released, and what reaches the uniforms.
 */

import { render } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Lightning from './Lightning'

/** A WebGL context with the parts of the real lifecycle that matter here. */
class FakeGl {
  readonly VERTEX_SHADER = 1
  readonly FRAGMENT_SHADER = 2
  readonly COMPILE_STATUS = 3
  readonly LINK_STATUS = 4
  readonly ARRAY_BUFFER = 5
  readonly STATIC_DRAW = 6
  readonly FLOAT = 7
  readonly TRIANGLES = 8

  /** Once true, never false again — the whole point. */
  lost = false
  loseCalls = 0
  draws = 0
  /** Last value uploaded, by uniform name. */
  uniforms: Record<string, number> = {}

  #locations = new Map<string, { name: string }>()

  isContextLost(): boolean {
    return this.lost
  }

  // A lost context creates nothing. This is the exact mechanism by which the
  // defect was silent: the caller gets null and returns early.
  createShader(): object | null {
    return this.lost ? null : {}
  }
  createProgram(): object | null {
    return this.lost ? null : {}
  }
  createBuffer(): object | null {
    return this.lost ? null : {}
  }

  shaderSource(): void {}
  compileShader(): void {}
  getShaderParameter(): boolean {
    return !this.lost
  }
  // Null, not '' — a lost context has no diagnostic to give, which is why the
  // console line the component prints says nothing useful.
  getShaderInfoLog(): string | null {
    return this.lost ? null : ''
  }
  deleteShader(): void {}
  attachShader(): void {}
  linkProgram(): void {}
  getProgramParameter(): boolean {
    return !this.lost
  }
  getProgramInfoLog(): string | null {
    return this.lost ? null : ''
  }
  deleteProgram(): void {}
  useProgram(): void {}
  bindBuffer(): void {}
  bufferData(): void {}
  deleteBuffer(): void {}
  getAttribLocation(): number {
    return 0
  }
  enableVertexAttribArray(): void {}
  vertexAttribPointer(): void {}
  getUniformLocation(_program: unknown, name: string): { name: string } {
    let location = this.#locations.get(name)
    if (!location) {
      location = { name }
      this.#locations.set(name, location)
    }
    return location
  }
  viewport(): void {}
  uniform1f(location: { name: string } | null, value: number): void {
    if (location) this.uniforms[location.name] = value
  }
  uniform2f(): void {}
  drawArrays(): void {
    if (!this.lost) this.draws++
  }
  getExtension(name: string): { loseContext: () => void } | null {
    if (name !== 'WEBGL_lose_context') return null
    return {
      loseContext: () => {
        this.loseCalls++
        this.lost = true
      },
    }
  }
}

let contexts: FakeGl[] = []
let contextOf: WeakMap<HTMLCanvasElement, FakeGl>
let pending = new Map<number, FrameRequestCallback>()
let nextHandle = 0
let clock = 0

beforeEach(() => {
  contexts = []
  contextOf = new WeakMap()
  pending = new Map()
  nextHandle = 0
  clock = 0

  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    nextHandle += 1
    pending.set(nextHandle, callback)
    return nextHandle
  })
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    pending.delete(handle)
  })
  // The wall clock the shader phase integrates. Monotonic, and it only moves
  // when a test says so, so `iTime` is a deterministic function of the frames
  // that were run and the speed that was live for each of them.
  vi.spyOn(performance, 'now').mockImplementation(() => clock)

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
    kind: string,
  ) {
    if (kind !== 'webgl') return null
    // THE CONTRACT: a canvas has exactly one context for its whole life and
    // returns it to every caller, lost or not. Reaching for a fresh one here is
    // what made the old suite green against a broken component.
    let context = contextOf.get(this)
    if (!context) {
      context = new FakeGl()
      contextOf.set(this, context)
      contexts.push(context)
    }
    return context
  } as never)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Run every queued frame once, after moving the clock forward by `stepMs`. */
function runFrames(count: number, stepMs = 0): void {
  for (let i = 0; i < count; i++) {
    clock += stepMs
    const due = [...pending.values()]
    pending.clear()
    for (const callback of due) callback(clock)
  }
}

/** The context backing the canvas the operator is actually looking at. */
function presentedContext(): FakeGl | undefined {
  const canvas = document.querySelector('canvas')
  return canvas ? contextOf.get(canvas) : undefined
}

const liveContexts = () => contexts.filter((context) => !context.isContextLost())

describe('Lightning context ownership', () => {
  it('gives a second setup a live context, not the one the first setup destroyed', () => {
    // StrictMode runs setup → cleanup → setup against the SAME rendered tree.
    // That is the production defect's exact shape, and it needs no dependency
    // array to reproduce — so this guard survives the churn fix below.
    render(
      <StrictMode>
        <Lightning />
      </StrictMode>,
    )

    const presented = presentedContext()
    expect(presented, 'no canvas was presented at all').toBeDefined()
    expect(
      presented!.isContextLost(),
      'the canvas on screen is backed by a context that was already destroyed. ' +
        'The canvas is React-owned, so it survived the effect cleanup that lost ' +
        'its context, and `getContext` handed the same dead one to the second ' +
        'setup — `createShader` then returns null and the component bails to a ' +
        'permanently blank canvas, silently',
    ).toBe(false)

    runFrames(2)
    expect(
      presented!.draws,
      'the presented canvas never drew a frame — the second setup bailed before ' +
        'reaching its render loop',
    ).toBeGreaterThan(0)
  })

  it('leaves exactly one context alive after a second setup', () => {
    render(
      <StrictMode>
        <Lightning />
      </StrictMode>,
    )

    // Both directions are failures, and they are opposite defects. More than
    // one: the previous setup's context was never handed back, and each mount
    // now eats two of the sixteen WebKit gives a web-content process before it
    // recycles the oldest into an unrecoverable SyntheticLostContext. Fewer
    // than one: everything allocated was destroyed and nothing is drawing.
    expect(
      liveContexts().length,
      'expected exactly one live WebGL context after setup → cleanup → setup, ' +
        'and got ' +
        liveContexts().length +
        ' — more than one means the released one was never released, none means ' +
        'the second setup inherited a dead context and gave up',
    ).toBe(1)
  })

  it('leaves exactly one canvas in the container after a second setup', () => {
    const { container } = render(
      <StrictMode>
        <Lightning />
      </StrictMode>,
    )

    expect(
      container.querySelectorAll('canvas').length,
      "the previous setup's canvas was never taken out of the container. Its " +
        'context is gone, so it paints nothing, but it is still stacked over the ' +
        'live one — and every further setup adds another',
    ).toBe(1)
  })

  it('still hands the context back on unmount', () => {
    const view = render(<Lightning />)
    runFrames(1)
    const context = contexts[0]
    expect(context.loseCalls).toBe(0)

    view.unmount()

    expect(
      context.loseCalls,
      'the context was left alive on unmount. A dropped reference frees nothing: ' +
        'WebKit returns the slot only when the context object is destroyed, and ' +
        'the auth gate unmounts this background on every logout',
    ).toBe(1)
    expect(context.isContextLost()).toBe(true)
    expect(
      document.querySelector('canvas'),
      'the canvas outlived the effect that created it',
    ).toBeNull()
  })
})

describe('Lightning slider churn', () => {
  it('does not build a second renderer when a slider moves', () => {
    const view = render(<Lightning speed={1} />)
    runFrames(2)
    expect(contexts).toHaveLength(1)
    const context = contexts[0]
    const drewBefore = context.draws

    // One pointer drag across the Speed control. `LivePreview` re-renders on
    // every `onValueChange`, undebounced.
    for (const speed of [1.1, 1.2, 1.3, 1.4]) {
      view.rerender(<Lightning speed={speed} />)
    }
    runFrames(2)

    expect(
      contexts.length,
      'a slider tick rebuilt the whole WebGL renderer. Every prop this component ' +
        'takes is a uniform, so none of them belongs in the effect dependency ' +
        'array — a drag allocates one context per pointer move and stutters',
    ).toBe(1)
    expect(
      context.loseCalls,
      'the running renderer was torn down mid-drag',
    ).toBe(0)
    expect(context.isContextLost()).toBe(false)
    expect(
      context.draws,
      'the animation stopped while the operator was tuning it',
    ).toBeGreaterThan(drewBefore)
  })

  it('feeds a moved slider to the running renderer instead of freezing it at mount', () => {
    const view = render(<Lightning hue={200} intensity={1} size={1} xOffset={0} />)
    runFrames(2)
    const context = contexts[0]
    expect(context.uniforms.uHue).toBe(200)

    view.rerender(<Lightning hue={40} intensity={2.5} size={0.4} xOffset={0.3} />)
    runFrames(2)

    // Without the rebuild there is nothing else that could carry a new value in:
    // if the render loop reads its closure instead of the live ref, the picture
    // is frozen at whatever the operator had when the component mounted.
    expect(
      context.uniforms.uHue,
      'the render loop is still uploading the props it captured at mount — ' +
        'moving a slider now changes nothing at all',
    ).toBe(40)
    expect(context.uniforms.uIntensity).toBe(2.5)
    expect(context.uniforms.uSize).toBe(0.4)
    expect(context.uniforms.uXOffset).toBeCloseTo(0.3)
  })

  it('scales the shader clock by the speed that is live for each frame', () => {
    const view = render(<Lightning speed={1} />)
    runFrames(2, 50)
    const context = contexts[0]
    const phaseAtSpeed1 = context.uniforms.iTime
    expect(phaseAtSpeed1, 'the shader clock never advanced').toBeGreaterThan(0)

    view.rerender(<Lightning speed={4} />)
    runFrames(2, 50)

    // Same wall time, four times the speed → four times the phase. The clock is
    // INTEGRATED (`phase += dt * speed`) rather than multiplied (`t * speed`)
    // precisely so that a change mid-flight is continuous instead of a jump.
    expect(
      context.uniforms.iTime - phaseAtSpeed1,
      'the Speed control no longer reaches the shader clock',
    ).toBeCloseTo(phaseAtSpeed1 * 4)
  })
})
