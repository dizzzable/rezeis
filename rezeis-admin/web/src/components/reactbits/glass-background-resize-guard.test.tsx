/**
 * Every WebGL glass background must ignore a resize that changed nothing.
 *
 * `LiquidChrome.test.tsx` states the case for the DEFAULT background; this is
 * the same case for the eight other ogl-backed backgrounds an operator can
 * choose, kept in one file because the failure and the fix are identical and
 * nine copies of the same three assertions would rot at nine different rates.
 *
 * The precondition, restated so it can be checked rather than remembered:
 *  - `#glass-background` is sized `100lvw × 100lvh` (index.css), the LARGE
 *    viewport — deliberately the address-bar-collapsed size, so it does not
 *    move when the bar does;
 *  - the panel's document scrolls normally, so on a mobile browser a scroll
 *    flick collapses the address bar and fires `window.resize` per frame;
 *  - ogl's `Renderer.setSize` assigns `gl.canvas.width/height` unconditionally,
 *    and writing a canvas's width reallocates the WebGL drawing buffer even
 *    when the value is identical.
 * Together: a burst of full-screen buffer reallocations, mid-gesture, for a
 * box that never moved.
 *
 * These components also back the branding page's card-effect preview and its
 * picker tiles, where the same event arrives with the same unchanged box.
 *
 * `ogl` is mocked because jsdom has no WebGL. The stub's `setSize` mirrors the
 * real one (node_modules/ogl/src/core/Renderer.js): it stores `this.width` /
 * `this.height` and writes `gl.canvas.width/height`. Those stored values are
 * exactly what each guard compares against, so stubbing them away would make
 * every case below vacuous.
 */
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const setSizeSpy = vi.hoisted(() => vi.fn())
/** The renderer each component built, so `dpr` can be read back off it. */
const rendererRef = vi.hoisted(() => ({ current: null as { dpr: number } | null }))

vi.mock('ogl', () => {
  class Renderer {
    width = 0
    height = 0
    // ogl's own default, and the value the device-pixel budget replaces.
    dpr = 1
    gl: Record<string, unknown> & { canvas: HTMLCanvasElement }

    constructor(options?: { dpr?: number }) {
      const canvas = document.createElement('canvas')
      if (typeof options?.dpr === 'number') this.dpr = options.dpr
      this.gl = {
        canvas,
        POINTS: 0,
        clearColor: () => {},
        getExtension: () => null,
        enable: () => {},
        disable: () => {},
        blendFunc: () => {},
      }
      this.setSize(300, 150)
      rendererRef.current = this
    }

    setSize(width: number, height: number): void {
      setSizeSpy(width, height)
      this.width = width
      this.height = height
      // Mirrors ogl's real `setSize`: `dpr` multiplies the drawing buffer only,
      // and `canvas.style` takes the CSS numbers unchanged. Collapsing that
      // here would make the budget cases below unable to tell a lowered ratio
      // from a shrunken box, which is the whole distinction being tested.
      this.gl.canvas.width = width * this.dpr
      this.gl.canvas.height = height * this.dpr
    }

    render(): void {}
  }

  class Color {
    r: number
    g: number
    b: number
    constructor(r = 0, g = 0, b = 0) {
      // `new Color('#rrggbb')` is also legal in ogl; nothing here reads the
      // channels of a hex-constructed colour, so a number-or-string first
      // argument collapses to zero rather than to a parse.
      this.r = typeof r === 'number' ? r : 0
      this.g = g
      this.b = b
    }
  }

  class Vec3 {
    x = 0
    y = 0
    z = 0
    set(x: number, y: number, z: number): this {
      this.x = x
      this.y = y
      this.z = z
      return this
    }
  }

  class Camera {
    position = new Vec3()
    perspective(): this {
      return this
    }
  }

  // `remove()` is real ogl API — the components call it on unmount to release
  // GPU objects. Without it here the teardown throws and takes the assertions
  // with it, which looks like a resize failure and is not one.
  class Program {
    uniforms: Record<string, { value: unknown }>
    constructor(_gl: unknown, options: { uniforms?: Record<string, { value: unknown }> }) {
      this.uniforms = options.uniforms ?? {}
    }
    remove(): void {}
  }

  class Geometry {
    remove(): void {}
  }

  class Mesh {
    position = new Vec3()
    rotation = new Vec3()
    remove(): void {}
  }

  class Triangle {}

  return { Renderer, Program, Mesh, Triangle, Color, Camera, Geometry, Vec3 }
})

import Balatro from './Balatro'
import Galaxy from './Galaxy'
import Iridescence from './Iridescence'
import LineWaves from './LineWaves'
import Particles from './Particles'
import Radar from './Radar'
import RippleGrid from './RippleGrid'
import SoftAurora from './SoftAurora'
import Threads from './Threads'

/** jsdom reports 0 for every layout dimension; make them scriptable. */
const box = { width: 390, height: 844 }

const BACKGROUNDS = [
  ['Balatro', Balatro],
  ['Galaxy', Galaxy],
  ['Iridescence', Iridescence],
  ['LineWaves', LineWaves],
  ['Particles', Particles],
  ['Radar', Radar],
  ['RippleGrid', RippleGrid],
  ['SoftAurora', SoftAurora],
  ['Threads', Threads],
] as const

beforeEach(() => {
  box.width = 390
  box.height = 844
  // Both spellings: these nine are split between `offsetWidth` and
  // `clientWidth`, and a stub that covered only one would let half of them
  // measure 0×0 and pass every case below without ever reaching a guard.
  for (const [prop, key] of [
    ['offsetWidth', 'width'],
    ['offsetHeight', 'height'],
    ['clientWidth', 'width'],
    ['clientHeight', 'height'],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get() {
        return this.tagName === 'CANVAS' ? 0 : box[key]
      },
    })
  }
  // Freeze the render loop; these cases are about sizing, not frames.
  vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(
    1 as unknown as ReturnType<typeof window.requestAnimationFrame>,
  )
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  setSizeSpy.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe.each(BACKGROUNDS)('%s resize guard', (name, Background) => {
  it('sizes the drawing buffer to the container on mount', () => {
    render(<Background />)

    // Anchors the two cases below: a component that measured 0×0, or never
    // reached its own resize handler, would satisfy "does not reallocate"
    // while guarding nothing at all.
    expect(
      setSizeSpy,
      `${name} never sized its buffer to the container — the cases below would pass vacuously`,
    ).toHaveBeenLastCalledWith(390, 844)
  })

  it('ignores the iOS address-bar resize storm (dimensions unchanged)', () => {
    render(<Background />)
    setSizeSpy.mockClear()

    for (let i = 0; i < 8; i++) window.dispatchEvent(new Event('resize'))

    expect(
      setSizeSpy,
      `${name} reallocated its WebGL drawing buffer for a box that did not move`,
    ).not.toHaveBeenCalled()
  })

  it('still reallocates when the box genuinely changes, then settles', () => {
    render(<Background />)
    setSizeSpy.mockClear()

    box.width = 844
    box.height = 390
    window.dispatchEvent(new Event('resize'))

    expect(
      setSizeSpy,
      `${name} skipped a rotation — the guard is comparing the wrong thing`,
    ).toHaveBeenCalledWith(844, 390)
    expect(setSizeSpy).toHaveBeenCalledTimes(1)

    // …and goes quiet again once the new size is the current size.
    window.dispatchEvent(new Event('resize'))
    expect(setSizeSpy).toHaveBeenCalledTimes(1)
  })

  it('reallocates when only ONE dimension changes', () => {
    // The two commonest real resizes move a single axis: a horizontal window
    // drag changes width alone, a soft keyboard changes height alone. Written
    // with `&&` instead of `||` the guard passes every case above — both axes
    // move in a rotation, and both move on mount — and then silently freezes
    // the buffer for exactly these two. The mutation was run; without this
    // case it was not caught.
    render(<Background />)
    setSizeSpy.mockClear()

    box.height = 700
    window.dispatchEvent(new Event('resize'))
    expect(
      setSizeSpy,
      `${name} ignored a height-only resize — the guard is joined with && where it needs ||`,
    ).toHaveBeenCalledWith(390, 700)

    box.width = 500
    window.dispatchEvent(new Event('resize'))
    expect(
      setSizeSpy,
      `${name} ignored a width-only resize — the guard is joined with && where it needs ||`,
    ).toHaveBeenCalledWith(500, 700)
  })

  it('leaves the pixel ratio alone for a box inside the device-pixel budget', () => {
    // A phone-sized full-screen mount, and every card, must be bit-identical
    // to what they rendered before the budget existed. Exactly 1, not
    // approximately: a ratio of 0.975 would resample every card in the product
    // and look entirely plausible in a screenshot.
    render(<Background />)

    expect(
      rendererRef.current!.dpr,
      `${name} resampled a 390×844 box that is well inside the budget`,
    ).toBe(1)
  })

  it('lowers the pixel ratio — and NOT the CSS size — over the budget', () => {
    box.width = 2560
    box.height = 1440
    render(<Background />)
    const renderer = rendererRef.current!

    // The CSS numbers are the container's, untouched. This is the line that
    // separates this design from the `transform: scale()` governor it
    // replaced: that one shrank the box every effect derives its FEATURES
    // from, so a 10 px lattice became 33 px and half the particles vanished.
    expect(
      setSizeSpy,
      `${name} shrank the CSS box instead of the drawing buffer`,
    ).toHaveBeenLastCalledWith(2560, 1440)
    // 2560×1440 at 0.75 is 1920×1080 — the budget, exactly.
    expect(renderer.dpr).toBe(0.75)
    expect(2560 * 1440 * renderer.dpr ** 2).toBe(1920 * 1080)
  })
})
