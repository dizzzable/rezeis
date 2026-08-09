/**
 * ClickSparkOverlay on-demand rendering.
 *
 * The overlay is mounted globally (default click effect is 'spark'), so it
 * sits on every route including /sign-in. It used to run an unconditional
 * rAF loop clearing a full-viewport canvas at native DPR 60×/s even with
 * zero sparks — on an iPhone (DPR 3) that is ~21 MP of pixels cleared per
 * second for an effect that is idle almost always. Under test:
 *   1. no clicks → no rAF loop at all;
 *   2. a click wakes the loop, and it stops again once the burst expires;
 *   3. the canvas backing store is clamped to DPR ≤ 2.
 * Visual behavior for actual clicks (spark geometry, easing, duration) is
 * untouched — the draw code only gained the stop condition.
 */
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ClickSparkOverlay } from './ClickSparkOverlay'

interface FakeCtx {
  clearRect: ReturnType<typeof vi.fn>
  stroke: ReturnType<typeof vi.fn>
  beginPath: ReturnType<typeof vi.fn>
  moveTo: ReturnType<typeof vi.fn>
  lineTo: ReturnType<typeof vi.fn>
  setTransform: ReturnType<typeof vi.fn>
  scale: ReturnType<typeof vi.fn>
  strokeStyle: string
  globalAlpha: number
  lineWidth: number
}

function makeFakeCtx(): FakeCtx {
  return {
    clearRect: vi.fn(),
    stroke: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    setTransform: vi.fn(),
    scale: vi.fn(),
    strokeStyle: '',
    globalAlpha: 1,
    lineWidth: 0,
  }
}

let ctx: FakeCtx
let rafQueue: FrameRequestCallback[]
let now: number

/** Runs every currently queued frame callback exactly once. */
function runFrame(): void {
  const callbacks = rafQueue
  rafQueue = []
  for (const cb of callbacks) cb(now)
}

beforeEach(() => {
  ctx = makeFakeCtx()
  rafQueue = []
  now = 0
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    ((kind: string) =>
      kind === '2d'
        ? ctx
        : null) as unknown as typeof HTMLCanvasElement.prototype.getContext,
  )
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    rafQueue.push(cb)
    return rafQueue.length
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  vi.spyOn(performance, 'now').mockImplementation(() => now)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ClickSparkOverlay rAF lifecycle', () => {
  it('does not run any loop while there are no sparks', () => {
    render(<ClickSparkOverlay />)

    expect(rafQueue).toHaveLength(0)
    expect(ctx.clearRect).not.toHaveBeenCalled()
  })

  it('wakes on click, draws the burst, and stops once it drains', () => {
    render(<ClickSparkOverlay count={10} duration={500} />)

    document.dispatchEvent(new MouseEvent('click', { clientX: 50, clientY: 60 }))
    expect(rafQueue).toHaveLength(1)

    // Mid-burst frame: sparks are drawn and the next frame is scheduled.
    now = 100
    runFrame()
    expect(ctx.stroke).toHaveBeenCalledTimes(10)
    expect(rafQueue).toHaveLength(1)

    // Past `duration`: the frame wipes the last drawing and the loop parks.
    now = 601
    runFrame()
    expect(rafQueue).toHaveLength(0)

    // No zombie frames afterwards, and the final state is a cleared canvas.
    const clears = ctx.clearRect.mock.calls.length
    expect(clears).toBeGreaterThan(0)

    // A new click restarts the loop from the parked state.
    document.dispatchEvent(new MouseEvent('click', { clientX: 5, clientY: 5 }))
    expect(rafQueue).toHaveLength(1)
  })

  it('does not double-schedule when clicks land mid-burst', () => {
    render(<ClickSparkOverlay />)

    document.dispatchEvent(new MouseEvent('click', { clientX: 1, clientY: 1 }))
    document.dispatchEvent(new MouseEvent('click', { clientX: 2, clientY: 2 }))

    expect(rafQueue).toHaveLength(1)
  })
})

describe('ClickSparkOverlay backing-store DPR', () => {
  it('clamps the canvas backing store to at most 2×', () => {
    vi.stubGlobal('devicePixelRatio', 3)

    const { container } = render(<ClickSparkOverlay />)
    const canvas = container.querySelector('canvas') as HTMLCanvasElement

    expect(canvas.width).toBe(window.innerWidth * 2)
    expect(canvas.height).toBe(window.innerHeight * 2)
    expect(ctx.scale).toHaveBeenCalledWith(2, 2)

    vi.unstubAllGlobals()
  })

  it('keeps 1× displays at 1×', () => {
    vi.stubGlobal('devicePixelRatio', 1)

    const { container } = render(<ClickSparkOverlay />)
    const canvas = container.querySelector('canvas') as HTMLCanvasElement

    expect(canvas.width).toBe(window.innerWidth)
    expect(ctx.scale).toHaveBeenCalledWith(1, 1)

    vi.unstubAllGlobals()
  })
})

describe('ClickSparkOverlay resize identity guard', () => {
  /** Set the viewport and fire the event the browser fires. */
  function setViewport(width: number, height: number): void {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
    window.dispatchEvent(new Event('resize'))
  }

  afterEach(() => {
    setViewport(1024, 768)
    vi.unstubAllGlobals()
  })

  it('does not touch the backing store when the size is unchanged', () => {
    // This overlay is on every route. iOS fires `resize` repeatedly through
    // the address-bar collapse mid-scroll, and each `canvas.width` write
    // reallocates and re-zeroes ~5 MB on a phone. Writing the SAME value is
    // not a no-op to the browser — only skipping the write is.
    vi.stubGlobal('devicePixelRatio', 2)
    setViewport(390, 844)

    const { container } = render(<ClickSparkOverlay />)
    const canvas = container.querySelector('canvas') as HTMLCanvasElement
    expect(canvas.width).toBe(780)

    // Observe the writes themselves rather than the resulting value, which
    // an unguarded implementation reproduces identically.
    const writes: number[] = []
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      'width',
    ) as PropertyDescriptor
    Object.defineProperty(canvas, 'width', {
      configurable: true,
      get: () => descriptor.get!.call(canvas),
      set: (value: number) => {
        writes.push(value)
        descriptor.set!.call(canvas, value)
      },
    })
    ctx.setTransform.mockClear()

    for (let i = 0; i < 8; i++) window.dispatchEvent(new Event('resize'))

    expect(writes).toEqual([])
    expect(ctx.setTransform).not.toHaveBeenCalled()
  })

  it('DOES resize when only one axis changes (the address-bar case)', () => {
    // The mutation this exists for: `applied.width === width || ... === height`
    // skips whenever EITHER matches. An address-bar collapse changes height
    // and leaves width alone, so with `||` the canvas would never resize —
    // a guard that guards everything, including the thing it must not.
    vi.stubGlobal('devicePixelRatio', 1)
    setViewport(390, 844)

    const { container } = render(<ClickSparkOverlay />)
    const canvas = container.querySelector('canvas') as HTMLCanvasElement
    expect(canvas.height).toBe(844)

    setViewport(390, 750) // same width, shorter viewport
    expect(canvas.height).toBe(750)
    expect(canvas.width).toBe(390)

    setViewport(500, 750) // same height, narrower viewport
    expect(canvas.width).toBe(500)
    expect(canvas.height).toBe(750)
  })

  it('re-applies the dpr scale exactly once per real size change', () => {
    vi.stubGlobal('devicePixelRatio', 2)
    setViewport(390, 844)

    render(<ClickSparkOverlay />)
    ctx.scale.mockClear()

    setViewport(390, 800)
    window.dispatchEvent(new Event('resize'))
    window.dispatchEvent(new Event('resize'))

    expect(ctx.scale).toHaveBeenCalledTimes(1)
    expect(ctx.scale).toHaveBeenCalledWith(2, 2)
  })
})
