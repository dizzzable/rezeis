/**
 * LiquidChrome resize guard (the DEFAULT panel background).
 *
 * iOS fires `window.resize` repeatedly while the address bar collapses during
 * a scroll gesture. The host element (`#glass-background`) is sized in `lvh`,
 * so its box does not actually change — but the handler used to call
 * `renderer.setSize()` on every one of those events, and ogl's `setSize`
 * assigns `gl.canvas.width/height` unconditionally. Writing a canvas's width
 * reallocates the WebGL drawing buffer even when the value is identical, so
 * a single flick produced a burst of buffer reallocations mid-gesture.
 *
 * The guard: skip `setSize` when the container's dimensions are unchanged.
 *
 * `ogl` is mocked because jsdom has no WebGL. The stub's `setSize` mirrors
 * the real implementation (node_modules/ogl/src/core/Renderer.js): it stores
 * `this.width`/`this.height` and writes `gl.canvas.width/height` — those
 * stored values are exactly what the guard compares against, so mocking them
 * away would make this test vacuous.
 */
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const setSizeSpy = vi.hoisted(() => vi.fn())
/** The renderer the component built, so `dpr` can be read back off it. */
const rendererRef = vi.hoisted(() => ({ current: null as { dpr: number } | null }))

vi.mock('ogl', () => {
  class Renderer {
    width = 0
    height = 0
    // ogl's own default, and the value the budget replaces.
    dpr = 1
    gl: {
      canvas: HTMLCanvasElement
      clearColor: () => void
      getExtension: () => null
    }

    constructor() {
      const canvas = document.createElement('canvas')
      this.gl = { canvas, clearColor: () => {}, getExtension: () => null }
      this.setSize(0, 0)
      rendererRef.current = this
    }

    setSize(width: number, height: number): void {
      setSizeSpy(width, height)
      this.width = width
      this.height = height
      // Mirrors ogl's real `setSize`: the DPR multiplies the drawing buffer
      // only, and `canvas.style` takes the CSS numbers unchanged.
      this.gl.canvas.width = width * this.dpr
      this.gl.canvas.height = height * this.dpr
    }

    render(): void {}
  }
  class Program {
    uniforms: Record<string, { value: unknown }>
    constructor(_gl: unknown, options: { uniforms: Record<string, { value: unknown }> }) {
      this.uniforms = options.uniforms
    }
  }
  class Mesh {}
  class Triangle {}
  return { Renderer, Program, Mesh, Triangle }
})

import { LiquidChrome } from './LiquidChrome'

/** jsdom reports 0 for every offset dimension; make them scriptable. */
const box = { width: 390, height: 844 }

beforeEach(() => {
  box.width = 390
  box.height = 844
  for (const [prop, key] of [
    ['offsetWidth', 'width'],
    ['offsetHeight', 'height'],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get() {
        return this.tagName === 'CANVAS' ? 0 : box[key]
      },
    })
  }
  // Freeze the render loop; these tests are about sizing, not frames.
  vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(
    1 as unknown as ReturnType<typeof window.requestAnimationFrame>,
  )
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  setSizeSpy.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('LiquidChrome resize', () => {
  it('sizes the drawing buffer once on mount', () => {
    render(<LiquidChrome />)

    // The constructor's own setSize(0, 0) plus the mount-time resize().
    expect(setSizeSpy).toHaveBeenCalledTimes(2)
    expect(setSizeSpy).toHaveBeenLastCalledWith(390, 844)
  })

  it('ignores the iOS address-bar resize storm (dimensions unchanged)', () => {
    render(<LiquidChrome />)
    setSizeSpy.mockClear()

    for (let i = 0; i < 8; i++) window.dispatchEvent(new Event('resize'))

    expect(setSizeSpy).not.toHaveBeenCalled()
  })

  it('still reallocates when the box genuinely changes (rotation, window drag)', () => {
    render(<LiquidChrome />)
    setSizeSpy.mockClear()

    box.width = 844
    box.height = 390
    window.dispatchEvent(new Event('resize'))

    expect(setSizeSpy).toHaveBeenCalledTimes(1)
    expect(setSizeSpy).toHaveBeenCalledWith(844, 390)

    // …and settles again once the new size is the current size.
    window.dispatchEvent(new Event('resize'))
    expect(setSizeSpy).toHaveBeenCalledTimes(1)
  })

  it('reallocates when only ONE dimension changes', () => {
    // The two commonest real resizes move a single axis: a soft keyboard
    // changes height alone, a horizontal window drag changes width alone.
    // WHY IT IS HERE NOW: an independent audit flipped this guard's `&&` to
    // `||` and every case above stayed green — a rotation moves both axes and
    // so does the mount — while the buffer silently froze for exactly these
    // two. The eight other ogl backgrounds carry the same case in
    // `glass-background-resize-guard.test.tsx`; the DEFAULT background, which
    // is this one, was the only member of the family without it.
    render(<LiquidChrome />)
    setSizeSpy.mockClear()

    box.height = 700
    window.dispatchEvent(new Event('resize'))
    expect(
      setSizeSpy,
      'ignored a height-only resize — the guard is joined with || where it needs &&',
    ).toHaveBeenCalledWith(390, 700)

    box.width = 500
    window.dispatchEvent(new Event('resize'))
    expect(
      setSizeSpy,
      'ignored a width-only resize — the guard is joined with || where it needs &&',
    ).toHaveBeenCalledWith(500, 700)
  })

  it('lowers the pixel ratio for a box over the device-pixel budget', () => {
    // The CSS numbers handed to `setSize` are the container's, untouched — a
    // cap that changed them would change every feature the shader draws. What
    // moves is `renderer.dpr`, which ogl multiplies ONLY into
    // `canvas.width/height`.
    box.width = 2560
    box.height = 1440
    const { container } = render(<LiquidChrome />)
    const renderer = rendererRef.current!

    expect(setSizeSpy).toHaveBeenLastCalledWith(2560, 1440)
    expect(renderer.dpr).toBe(0.75)
    // 2560×1440 at ratio 0.75 = 1920×1080 = the budget exactly.
    expect(2560 * 1440 * renderer.dpr ** 2).toBe(1920 * 1080)
    // …and the element CSS is untouched.
    expect(container.firstElementChild!.className).toContain('w-full')
  })

  it('leaves a card at ogl’s own ratio', () => {
    box.width = 343
    box.height = 201
    render(<LiquidChrome />)

    // Exactly 1 — not "about 1". A card that resampled at 0.975 would be a
    // silent change to every subscription card in the product.
    expect(rendererRef.current!.dpr).toBe(1)
  })
})
