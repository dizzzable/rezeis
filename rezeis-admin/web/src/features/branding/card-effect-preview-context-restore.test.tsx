/**
 * A lost context that CAN come back must come back — operator side.
 *
 * WHAT WENT WRONG. `observePreviewCardEffectCanvases` treated every
 * `webglcontextlost` as permanent. It never called `event.preventDefault()` —
 * and per the WebGL spec that is the only thing that asks the user agent to
 * restore a context, so without it `webglcontextrestored` can never fire at all
 * — and it never listened for the restore either. The loss went straight to
 * `setFailedScope`, which is a LATCH here rather than a count: one transient GPU
 * event (sleep/wake, a driver reset, WebKit recycling a context under its cap)
 * left the operator configuring a card against a static preview until the page
 * was reloaded. The same defect shipped in the cabinet; the twin of this file is
 * `reiwa/web/test/card-effect-context-restore.test.tsx`.
 *
 * WHY THE FAILURE HAD TO BECOME DEFERRED RATHER THAN WITHDRAWN. Reporting it
 * first and undoing it on restore is not available: `css-fallback` unmounts the
 * effect, which takes the canvas — and with it the only thing that could hear
 * `webglcontextrestored` — out of the document.
 *
 * WHAT IS NOT COVERED. Whether a real browser fires `webglcontextrestored` after
 * `preventDefault()`: that is the spec's contract, jsdom has no WebGL, and the
 * events here are dispatched by hand. And whether the effect components
 * themselves survive being remounted underneath their own recovery — they are
 * discarded wholesale by the key change, which is safe by construction rather
 * than by test.
 */

import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./card-effect-registry', () => ({
  CARD_EFFECT_COMPONENTS: {
    plasma: () => <canvas data-testid="preview-effect-canvas" />,
  },
}))

import { CardEffectPreviewLayer } from './card-effect-preview-runtime'
import {
  PREVIEW_CONTEXT_RESTORE_GRACE_MS,
  observePreviewCardEffectCanvases,
} from './card-effect-preview-utils'

function runtimeMode(container: HTMLElement): string | null | undefined {
  return container
    .querySelector('[data-preview-card-layer="effect"]')
    ?.getAttribute('data-preview-card-effect-runtime')
}

function effectCanvas(container: HTMLElement): HTMLCanvasElement | null {
  return container.querySelector<HTMLCanvasElement>('[data-testid="preview-effect-canvas"]')
}

function dispatch(target: EventTarget, type: string): Event {
  const event = new Event(type, { cancelable: true })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

function renderPreview() {
  return render(<CardEffectPreviewLayer effect="plasma" props={{}} opacity={1} />)
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    getExtension: vi.fn().mockReturnValue({ loseContext: vi.fn() }),
    isContextLost: () => false,
  } as unknown as WebGL2RenderingContext)
  // Only the clock the grace window runs on. Vitest's fake timers otherwise take
  // over `requestAnimationFrame` too, displacing the synchronous stub the
  // capability probe needs to get past.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a restorable context loss in the operator preview', () => {
  it('is preventDefault-ed, which is what lets the browser restore it', () => {
    const { container } = renderPreview()
    const canvas = effectCanvas(container)
    expect(canvas).not.toBeNull()

    const lost = dispatch(canvas!, 'webglcontextlost')

    expect(
      lost.defaultPrevented,
      'the loss was not preventDefault-ed. Per the WebGL spec the user agent ' +
        'then never restores the context and never fires `webglcontextrestored`, ' +
        'so the operator configures against a static preview for the rest of the ' +
        'session',
    ).toBe(true)
  })

  it('does not fail the preview while the restore is still possible', () => {
    const { container } = renderPreview()
    dispatch(effectCanvas(container)!, 'webglcontextlost')

    expect(runtimeMode(container)).toBe('native')
    act(() => vi.advanceTimersByTime(PREVIEW_CONTEXT_RESTORE_GRACE_MS - 1))
    expect(runtimeMode(container)).toBe('native')
  })

  it('rebuilds the renderer when the context comes back', () => {
    const { container } = renderPreview()
    const before = effectCanvas(container)

    dispatch(before!, 'webglcontextlost')
    dispatch(before!, 'webglcontextrestored')
    act(() => vi.advanceTimersByTime(PREVIEW_CONTEXT_RESTORE_GRACE_MS * 2))

    expect(
      runtimeMode(container),
      'the preview fell back although the context was restored — a restorable ' +
        'loss is being counted as a permanent failure',
    ).toBe('native')

    const after = effectCanvas(container)
    expect(after).not.toBeNull()
    expect(
      after === before,
      'the renderer was not rebuilt. A restored context is not the one the ' +
        'effect was drawing with: every GL handle it holds was detached by the ' +
        'loss, so re-rendering the same instance leaves a live context over a ' +
        'dead scene',
    ).toBe(false)
  })

  it('still reaches the CSS fallback when nothing comes back', () => {
    const { container } = renderPreview()
    dispatch(effectCanvas(container)!, 'webglcontextlost')

    act(() => vi.advanceTimersByTime(PREVIEW_CONTEXT_RESTORE_GRACE_MS))

    expect(
      runtimeMode(container),
      "an unrecoverable loss — WebKit's SyntheticLostContext, which its own " +
        'source marks unrecoverable — no longer reaches the fallback at all',
    ).toBe('css-fallback')
  })

  it('stops rebuilding once the budget is spent', () => {
    const { container } = renderPreview()

    for (let round = 0; round < 2; round += 1) {
      const canvas = effectCanvas(container)
      expect(canvas, `round ${round} lost its renderer early`).not.toBeNull()
      dispatch(canvas!, 'webglcontextlost')
      dispatch(canvas!, 'webglcontextrestored')
      expect(runtimeMode(container)).toBe('native')
    }

    const canvas = effectCanvas(container)
    expect(canvas).not.toBeNull()
    dispatch(canvas!, 'webglcontextlost')
    dispatch(canvas!, 'webglcontextrestored')

    expect(
      runtimeMode(container),
      'the rebuild budget is not bounded — a GPU that keeps losing and ' +
        'restoring drives an unbounded rebuild loop, each turn allocating ' +
        "another context under WebKit's sixteen",
    ).toBe('css-fallback')
  })
})

describe("the panel's own context teardown", () => {
  /**
   * Every effect ends its cleanup with `loseContext()`, and the browser
   * dispatches the resulting `webglcontextlost` one task later — by which time
   * the canvas has left the document. Treating that as a fault would make a
   * remount report a failure against the presentation that replaced it.
   */
  it('is not mistaken for a fault', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const canvas = document.createElement('canvas')
    root.append(canvas)

    const onFailure = vi.fn()
    const onRestored = vi.fn(() => true)
    const stop = observePreviewCardEffectCanvases(root, onFailure, 1_200, 'any', onRestored)

    canvas.remove()
    const lost = new Event('webglcontextlost', { cancelable: true })
    canvas.dispatchEvent(lost)
    vi.advanceTimersByTime(PREVIEW_CONTEXT_RESTORE_GRACE_MS * 2)

    expect(
      lost.defaultPrevented,
      'a teardown loss was preventDefault-ed, asking the browser to restore a ' +
        'context this app is deliberately handing back under a ceiling of 16',
    ).toBe(false)
    expect(onFailure).not.toHaveBeenCalled()
    expect(onRestored).not.toHaveBeenCalled()

    stop()
    root.remove()
  })

  it('cancels a pending loss when the observer is torn down', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const canvas = document.createElement('canvas')
    root.append(canvas)

    const onFailure = vi.fn()
    const stop = observePreviewCardEffectCanvases(root, onFailure, 1_200, 'any', () => true)

    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    stop()
    vi.advanceTimersByTime(PREVIEW_CONTEXT_RESTORE_GRACE_MS * 2)

    expect(
      onFailure,
      'a grace timer outlived the observer and reported a failure against ' +
        'whatever presentation replaced it',
    ).not.toHaveBeenCalled()

    root.remove()
  })
})
