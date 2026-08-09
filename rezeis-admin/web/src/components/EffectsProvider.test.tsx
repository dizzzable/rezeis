/**
 * The two cursor effects wired onto the `EffectsProvider` switch —
 * `target` (reactbits/TargetCursor) and `textTrail` (reactbits/TextCursor).
 *
 * The failure these guard against is not "it throws". It is that a cursor
 * effect mounts, renders, occupies the DOM, and never sees a pointer event —
 * which is what happens to any component that binds its listener to its own
 * container while sitting inside `FixedOverlay` (`pointer-events: none`, so
 * the container can never be an event target). So every spec here dispatches a
 * real event at `window` and asserts something observable came back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'

import { useAppearanceStore } from '@/lib/theme/appearance-store'
import { useEffectsStore, type CursorEffectId } from '@/lib/theme/effects-store'
import { EffectsProvider } from './EffectsProvider'

/** The overlay `FixedOverlay` renders — the thing that kills container listeners. */
const OVERLAY = '.pointer-events-none.fixed.inset-0'

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

describe('EffectsProvider — newly wired cursor effects', () => {
  beforeEach(() => {
    useEffectsStore.getState().reset()
    useAppearanceStore.setState({ visualEffects: true })
    document.body.style.cursor = ''
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    document.body.style.cursor = ''
  })

  // ── TargetCursor ───────────────────────────────────────────────────────────

  describe('target', () => {
    it('mounts bare, not inside the pointer-events-none overlay', async () => {
      const { container } = renderProvider('target')

      await waitFor(() => {
        expect(container.querySelector('.target-cursor-corner')).not.toBeNull()
      })

      const root = container.querySelector('.target-cursor-corner')?.parentElement
      // It renders its own `fixed top-0 left-0 pointer-events-none z-[9999]`
      // root — exactly like the `crosshair` case — so nesting it in a second
      // fixed root buys nothing and would only add a stacking context.
      expect(root?.className).toContain('fixed')
      expect(root?.className).toContain('z-[9999]')
      expect(root?.closest(OVERLAY)).toBeNull()
      expect(container.querySelectorAll('.target-cursor-corner')).toHaveLength(4)
    })

    it('binds its pointer listeners to window and removes them on unmount', async () => {
      const ledger = listenerLedger()
      const { container, unmount } = renderProvider('target')

      await waitFor(() => {
        expect(container.querySelector('.target-cursor-corner')).not.toBeNull()
      })

      for (const type of ['mousemove', 'mouseover', 'mousedown', 'mouseup', 'scroll']) {
        expect(ledger.added(type).length).toBeGreaterThan(0)
      }

      // A real pointer event has to reach it and do something. The mouseover
      // handler walks up from `e.target` looking for `targetSelector`, and on a
      // match binds a `mouseleave` to that element — so a mouseleave landing on
      // the probe is proof the whole path ran with `.cursor-target` in force.
      const probe = document.createElement('div')
      probe.className = 'cursor-target'
      document.body.appendChild(probe)
      const probeAdd = vi.spyOn(probe, 'addEventListener')

      await act(async () => {
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: 120, clientY: 80 }))
        probe.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      })

      expect(probeAdd.mock.calls.map(([type]) => type)).toContain('mouseleave')
      probe.remove()

      const bound = ['mousemove', 'mouseover', 'mousedown', 'mouseup', 'scroll'].flatMap((t) =>
        ledger.added(t).map((fn) => [t, fn] as const),
      )
      unmount()
      for (const [type, fn] of bound) {
        expect(ledger.removed(type)).toContain(fn)
      }
    })

    it('hides the system cursor and puts back exactly what it found', async () => {
      // Not '' — restoring to empty would look identical to restoring
      // correctly if the component simply cleared the property.
      document.body.style.cursor = 'progress'

      const { container, unmount } = renderProvider('target')
      await waitFor(() => {
        expect(container.querySelector('.target-cursor-corner')).not.toBeNull()
      })
      expect(document.body.style.cursor).toBe('none')

      unmount()
      expect(document.body.style.cursor).toBe('progress')
    })

    it('renders nothing at all on a touch device', async () => {
      // `isMobile` is computed once, at mount, from touch support + width.
      // jsdom does not define `maxTouchPoints` at all, so this has to be
      // installed rather than spied.
      const hadTouch = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints')
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
      const hadWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
      Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true })

      const { container } = renderProvider('target')
      // Give the lazy chunk the same window the other specs get.
      await act(async () => {
        await Promise.resolve()
      })
      await waitFor(() => {
        expect(container.querySelector('main')).not.toBeNull()
      })

      expect(container.querySelector('.target-cursor-corner')).toBeNull()
      // Critically: it must not have hidden the cursor on the way out.
      expect(document.body.style.cursor).toBe('')

      if (hadTouch) Object.defineProperty(navigator, 'maxTouchPoints', hadTouch)
      else Reflect.deleteProperty(navigator, 'maxTouchPoints')
      if (hadWidth) Object.defineProperty(window, 'innerWidth', hadWidth)
    })
  })

  // ── TextCursor ─────────────────────────────────────────────────────────────

  describe('textTrail', () => {
    it('emits a glyph for a pointer event dispatched at window', async () => {
      const { container } = renderProvider('textTrail')

      await waitFor(() => {
        expect(container.querySelector(OVERLAY)).not.toBeNull()
      })
      expect(screen.queryAllByText('⚛️')).toHaveLength(0)

      // This is the whole repair. The listener used to be bound to the
      // component's own container, which lives inside a `pointer-events: none`
      // overlay — an element that can never be the target of a pointer event.
      // Dispatching here produced nothing at all.
      await act(async () => {
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: 140, clientY: 90 }))
      })

      expect(screen.getAllByText('⚛️')).toHaveLength(1)
    })

    it('adds a glyph per qualifying move, so every window event lands', async () => {
      const { container } = renderProvider('textTrail')
      await waitFor(() => {
        expect(container.querySelector(OVERLAY)).not.toBeNull()
      })

      // `spacing` is 100px and the component interpolates `floor(distance /
      // spacing)` points from the LAST point, not from the pointer — so a step
      // of exactly `spacing` yields exactly one new glyph per move. Counting
      // them is a sharper proof than "at least one appeared": a listener that
      // fired once by accident would not keep pace.
      for (let i = 0; i < 4; i += 1) {
        await act(async () => {
          window.dispatchEvent(
            new MouseEvent('mousemove', { clientX: 100 + i * 100, clientY: 90 }),
          )
        })
        expect(screen.getAllByText('⚛️')).toHaveLength(i + 1)
      }
    })

    it('sits inside the viewport-sized overlay it measures against', async () => {
      const { container } = renderProvider('textTrail')
      await waitFor(() => {
        expect(container.querySelector(OVERLAY)).not.toBeNull()
      })

      // The component has no positioning of its own — `w-full h-full relative`
      // — so it needs the overlay to be viewport-sized. That is also what makes
      // its `e.clientX - rect.left` arithmetic correct: for a `fixed inset-0`
      // parent the container rect origin is (0,0), so viewport coordinates pass
      // through unchanged.
      const overlay = container.querySelector(OVERLAY)
      const root = overlay?.firstElementChild as HTMLElement
      expect(root.className).toContain('w-full')
      expect(root.className).toContain('h-full')
      expect(root.className).toContain('relative')
    })

    it('unsubscribes from window on unmount', async () => {
      const ledger = listenerLedger()
      const { container, unmount } = renderProvider('textTrail')

      await waitFor(() => {
        expect(container.querySelector(OVERLAY)).not.toBeNull()
      })
      const bound = ledger.added('mousemove')
      expect(bound.length).toBeGreaterThan(0)

      unmount()
      for (const fn of bound) expect(ledger.removed('mousemove')).toContain(fn)

      // And a post-unmount event must not resurrect anything.
      await act(async () => {
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 10 }))
      })
      expect(screen.queryAllByText('⚛️')).toHaveLength(0)
    })
  })

  // ── The switch itself ──────────────────────────────────────────────────────

  it('renders one cursor effect at a time', async () => {
    const { container, rerender } = renderProvider('target')
    await waitFor(() => {
      expect(container.querySelector('.target-cursor-corner')).not.toBeNull()
    })

    act(() => {
      useEffectsStore.setState({ cursorEffect: 'textTrail' })
    })
    rerender(
      <EffectsProvider>
        <main>page</main>
      </EffectsProvider>,
    )

    await waitFor(() => {
      expect(container.querySelector(OVERLAY)).not.toBeNull()
    })
    expect(container.querySelector('.target-cursor-corner')).toBeNull()
    // Swapping away from TargetCursor must also give the system cursor back.
    expect(document.body.style.cursor).toBe('')
  })
})
