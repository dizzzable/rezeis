/**
 * Lightning: the loop must stop, the buffer must not churn, the context must go.
 *
 * WHY THIS EXISTS. Three defects, all of which were dormant for as long as the
 * panel background never unmounted, and all of which the auth gate woke up by
 * unmounting it on every logout:
 *
 *   1. the rAF handle was never stored, so the render loop could not be
 *      cancelled and went on drawing into a detached canvas forever;
 *   2. `render()` called `resizeCanvas()` on EVERY frame, and assigning
 *      `canvas.width` reallocates the WebGL drawing buffer even for an
 *      identical value — a full-viewport reallocation sixty times a second;
 *   3. nothing released the context. WebKit gives a web-content process 16
 *      before it starts recycling the oldest and handing out an unrecoverable
 *      SyntheticLostContext, so this leaked one shader per logout.
 *
 * WHAT CANNOT BE ASSERTED HERE, stated so it is not assumed: that the GPU
 * actually frees anything. jsdom has no WebGL. The `gl` object below is a stub,
 * so what is pinned is that the component ISSUES the calls — cancel, the guard,
 * `loseContext` — which is the part the component controls. Whether the driver
 * honours `WEBGL_lose_context` is the platform's contract.
 *
 * AND WHAT THIS FILE STRUCTURALLY CANNOT SEE — read this before adding a
 * context-lifetime test here. `getContext` below is stubbed as `() => stubGl()`:
 * a FRESH happy-path context on every call. A real canvas hands the SAME
 * context object to every caller, lost or not, and the difference is an entire
 * class of defect — a component that destroys its context in cleanup and then
 * reopens one on the same element gets the dead one back. All six tests here
 * were verified green against exactly that broken component. Anything about
 * WHICH element owns the context, how many are allocated, or what a second setup
 * receives belongs in `Lightning.context-ownership.test.tsx`, whose stub models
 * the real contract.
 */
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Lightning from './Lightning'

/** The canvas's CSS box. jsdom reports 0 for every layout dimension. */
const box = { width: 390, height: 844 }

/**
 * A real rAF queue: handles are unique and monotonic, and cancelling one
 * actually removes it.
 *
 * An array of callbacks with a "was cancel called" spy is NOT enough, and the
 * mutation proves it: dropping the handle assignment from inside the loop
 * leaves the FIRST handle stored, so `cancelAnimationFrame` is still called
 * with a plausible number while every re-armed frame runs on forever. What
 * separates the two is whether the loop actually stops, so the loop has to be
 * runnable after unmount.
 */
let pending = new Map<number, FrameRequestCallback>()
let nextHandle = 0
let drawCalls = 0
let loseContext: ReturnType<typeof vi.fn>
let widthWrites: number[] = []
let heightWrites: number[] = []
let sizeDescriptors: Array<[string, PropertyDescriptor]> = []

/** Every WebGL call `Lightning` makes, answered with the happy path. */
function stubGl() {
  const constants = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    TRIANGLES: 8,
  }
  return {
    ...constants,
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader: () => {},
    createProgram: () => ({}),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    deleteProgram: () => {},
    useProgram: () => {},
    createBuffer: () => ({}),
    bindBuffer: () => {},
    bufferData: () => {},
    deleteBuffer: () => {},
    getAttribLocation: () => 0,
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    getUniformLocation: () => ({}),
    viewport: () => {},
    uniform1f: () => {},
    uniform2f: () => {},
    drawArrays: () => {
      drawCalls++
    },
    getExtension: () => ({ loseContext }),
  }
}

beforeEach(() => {
  box.width = 390
  box.height = 844
  pending = new Map()
  nextHandle = 0
  drawCalls = 0
  widthWrites = []
  heightWrites = []
  loseContext = vi.fn()

  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    // Handles start at 1, so an unstored one (`0`/`undefined`) can never be
    // mistaken for a live registration.
    nextHandle += 1
    pending.set(nextHandle, cb)
    return nextHandle
  })
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    pending.delete(handle)
  })

  for (const [prop, key] of [
    ['clientWidth', 'width'],
    ['clientHeight', 'height'],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get() {
        return box[key]
      },
    })
  }

  // Count the buffer reallocations. `canvas.width` is a real accessor on the
  // jsdom prototype, and assigning it is precisely the expensive operation
  // being guarded — so the setter is what has to be watched, not the value.
  sizeDescriptors = (['width', 'height'] as const).map((name) => [
    name,
    Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, name)!,
  ])
  for (const [name, sink] of [
    ['width', widthWrites],
    ['height', heightWrites],
  ] as const) {
    let stored = 300
    Object.defineProperty(HTMLCanvasElement.prototype, name, {
      configurable: true,
      get() {
        return stored
      },
      set(value: number) {
        stored = value
        sink.push(value)
      },
    })
  }

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((kind: string) =>
    kind === 'webgl' ? stubGl() : null) as never)
})

afterEach(() => {
  for (const [name, descriptor] of sizeDescriptors) {
    Object.defineProperty(HTMLCanvasElement.prototype, name, descriptor)
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Run every queued frame once, the way the browser would. */
function runFrames(count: number): void {
  for (let i = 0; i < count; i++) {
    const due = [...pending.values()]
    pending.clear()
    for (const cb of due) cb(0)
  }
}

describe('Lightning', () => {
  it('sizes its buffer once and leaves it alone for a box that did not move', () => {
    render(<Lightning />)
    expect(widthWrites).toEqual([390])
    widthWrites.length = 0
    heightWrites.length = 0

    runFrames(30)

    expect(
      widthWrites,
      'reallocated the WebGL drawing buffer once per frame — `render()` calls `resizeCanvas()` unguarded',
    ).toEqual([])
    expect(heightWrites).toEqual([])
  })

  it('still resizes when the box genuinely changes', () => {
    render(<Lightning />)
    widthWrites.length = 0
    heightWrites.length = 0

    box.width = 844
    box.height = 390
    runFrames(1)

    expect(widthWrites).toEqual([844])
    expect(heightWrites).toEqual([390])
  })

  it('reallocates when only ONE dimension changes', () => {
    // A soft keyboard moves height alone; a window drag moves width alone.
    // Written with `&&` where it needs `||`, the guard passes every case above
    // and then freezes the buffer for exactly these two.
    render(<Lightning />)
    widthWrites.length = 0
    heightWrites.length = 0

    box.height = 700
    runFrames(1)
    expect(
      heightWrites,
      'ignored a height-only change — the guard is comparing the wrong thing',
    ).toEqual([700])
    // Both axes are rewritten whenever either moves, which is what the guard
    // is for: one comparison, one reallocation of the whole buffer.
    expect(widthWrites).toEqual([390])
    widthWrites.length = 0
    heightWrites.length = 0

    box.width = 500
    runFrames(1)
    expect(
      widthWrites,
      'ignored a width-only change — the guard is comparing the wrong thing',
    ).toEqual([500])
    expect(heightWrites).toEqual([700])
  })

  it('caps the buffer at the device-pixel budget without touching the CSS box', () => {
    box.width = 2560
    box.height = 1440
    render(<Lightning />)

    // 2560×1440 = 3.7M buffer pixels; the budget resolves to 0.75.
    expect(widthWrites).toEqual([1920])
    expect(heightWrites).toEqual([1080])
    // The element itself is untouched — `w-full h-full` still, so the shader
    // presents across the whole box and only samples it less densely.
    expect(document.querySelector('canvas')!.className).toContain('w-full')
  })

  it('stops the render loop on unmount', () => {
    const view = render(<Lightning />)
    runFrames(3)
    // The loop re-arms itself, so by now the handle it must cancel is the
    // FOURTH one issued, not the first.
    expect(pending.size).toBe(1)
    expect(nextHandle).toBeGreaterThan(1)
    const drewWhileMounted = drawCalls
    expect(drewWhileMounted).toBeGreaterThan(0)

    view.unmount()

    // Not "cancel was called": with the handle stored only on the first
    // request, cancel IS still called, with a plausible number, and the loop
    // runs forever anyway. What is asserted is that nothing is left to run.
    expect(
      pending.size,
      'the render loop outlived the component — its rAF handle is not the one being cancelled',
    ).toBe(0)
    runFrames(5)
    expect(drawCalls).toBe(drewWhileMounted)
  })

  it('releases the WebGL context on unmount', () => {
    const view = render(<Lightning />)
    expect(loseContext).not.toHaveBeenCalled()

    view.unmount()

    expect(
      loseContext,
      'the context was left alive — WebKit only returns the slot when it is destroyed',
    ).toHaveBeenCalledTimes(1)
  })
})
