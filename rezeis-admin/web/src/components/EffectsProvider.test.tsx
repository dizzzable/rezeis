/**
 * Cursor effects on the `EffectsProvider` switch, and the two opposite ways
 * the `FixedOverlay` they sit in can go wrong.
 *
 * `target` (reactbits/TargetCursor) and `textTrail` (reactbits/TextCursor)
 * guard the first: an effect mounts, renders, occupies the DOM, and never sees
 * a pointer event — which is what happens to any component that binds its
 * listener to its own container while sitting inside `FixedOverlay`
 * (`pointer-events: none`, so that container can never be an event target). So
 * those specs dispatch a real event at `window` and assert something
 * observable came back.
 *
 * `pixelTrail` (reactbits/PixelTrail) guards the reverse, which an operator hit
 * in production: an effect that sees every pointer event and passes none of
 * them on, leaving a page that draws correctly and cannot be used. Its section
 * below carries the mechanism.
 *
 * Both failures are silent in a type checker and in a screenshot, which is why
 * they are pinned here rather than left to review.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'

import { useAppearanceStore } from '@/lib/theme/appearance-store'
import { useEffectsStore, type CursorEffectId } from '@/lib/theme/effects-store'
import { installGlStub, type GlStubHarness } from './reactbits/gl-stub'
import { EffectsProvider } from './EffectsProvider'

/** The overlay `FixedOverlay` renders — the thing that kills container listeners. */
const OVERLAY = '.pointer-events-none.fixed.inset-0'

/**
 * The box `installGlStub` lays every element out at, passed explicitly so the
 * arithmetic in the `pixelTrail` specs cannot drift away from the stub's own
 * defaults.
 */
const VIEWPORT = { width: 1280, height: 800 }

/** The trail texture `PixelTrail` asks `useTrailTexture` for, in pixels. */
const TRAIL_TEXTURE_SIZE = 512

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

  // ── PixelTrail ─────────────────────────────────────────────────────────────

  /**
   * The exact reverse of the failure the rest of this file guards. Those
   * effects could not SEE a pointer event. This one saw every one of them and
   * let nothing through to the page.
   *
   * `PixelTrail` is the only cursor effect built on a react-three-fiber
   * `<Canvas>`, and fiber decides that canvas's pointer transparency itself:
   *
   *     // When the event source is not this div, we need to set pointer-events
   *     // to none. Or else the canvas will block events from reaching it.
   *     const pointerEvents = eventSource ? 'none' : 'auto'
   *
   * With no `eventSource` that lands as an INLINE `pointer-events: auto` on
   * fiber's container, which beats the `pointer-events: none` CLASS on
   * `FixedOverlay` — the property is inherited, and a child that redeclares it
   * wins for itself. That container is `width:100%; height:100%` inside a
   * `fixed inset-0 z-[9999]` parent, so what an operator gets is a sheet across
   * the whole viewport, above everything, that swallows every click. One
   * reported precisely that: the panel drew fine and nothing on it could be
   * used, and only turning the effect off gave the page back.
   *
   * Every other cursor effect sets `pointer-events: none` on its own root
   * (SplashCursor, BlobCursor, GhostCursor, Crosshair, TargetCursor,
   * TextCursor). This was the one that did not.
   *
   * BOTH halves are asserted, because either alone is satisfied by a broken
   * repair. Forcing `pointer-events: none` onto the canvas — via `canvasProps`,
   * which fiber spreads after its own value and would accept — gives the page
   * back and silently kills the effect, since the trail is drawn from
   * `onPointerMove` on the mesh and a canvas that cannot be an event target
   * never fires it. Passing `eventSource` is fiber's own answer and the only
   * one that satisfies both.
   */
  describe('pixelTrail', () => {
    let gl: GlStubHarness

    beforeEach(() => {
      // jsdom lays every element out at 0×0, and fiber refuses to build a
      // renderer — and therefore to connect its event listeners — while the box
      // it measures is zero. The stub supplies a real box and a GL context.
      gl = installGlStub(VIEWPORT)
    })

    afterEach(() => {
      // Unmount, then let the loop notice, and only then take the stub away.
      //
      // fiber drives every root from ONE module-level loop, and that loop
      // reschedules itself only from inside a frame:
      //
      //     if (!running) { running = true; requestAnimationFrame(loop) }
      //
      // A frame still queued when `installGlStub`'s `requestAnimationFrame`
      // disappears is a frame nobody ever runs, so `running` stays `true` for
      // the rest of the FILE and every later `invalidate()` takes the early
      // exit. The next spec then mounts a canvas that is never drawn once —
      // measured: both specs below saw zero draw calls and an unpainted trail,
      // while passing in isolation. Draining after `cleanup()` lets the loop
      // find `_roots` empty, clear its own flag and cancel its frame.
      cleanup()
      gl.runFrames(2)
      gl.teardown()
    })

    /**
     * fiber connects its event listeners from `onCreated`, which it only
     * reaches once it has measured a non-zero box — and jsdom lays everything
     * out at 0×0. `installGlStub` supplies the box, but fiber measures through
     * react-use-measure, whose ResizeObserver never fires under the inert jsdom
     * mock; a window `resize` is the one path that does re-measure. Without it
     * fiber stops at the bare container and no assertion below has a subject.
     */
    async function mountPixelTrail() {
      const view = renderProvider('pixelTrail')
      // A generous budget, and not an arbitrary one: this waits on a DYNAMIC
      // IMPORT — `PixelTrail` is `lazy()`, and it pulls in three.js and fiber.
      // Testing Library's default is one second, which the whole 164-file suite
      // running in parallel workers exceeds often enough to make these three
      // specs red roughly every other run. A guard that is red half the time is
      // not a guard, and the failure it produced ("no canvas yet") says nothing
      // about the property under test.
      await waitFor(
        () => {
          expect(view.container.querySelector(`${OVERLAY} canvas`)).not.toBeNull()
        },
        { timeout: 15_000 },
      )
      await act(async () => {
        window.dispatchEvent(new Event('resize'))
      })
      return view
    }

    it('adds nothing to the overlay that takes the pointer back', async () => {
      const { container } = await mountPixelTrail()

      // Read the inline style, not the computed one: the inline declaration IS
      // the mechanism here, and jsdom does not resolve inherited
      // `pointer-events` through `getComputedStyle` anyway, so a computed-style
      // assertion would pass against the defect.
      const overlay = container.querySelector(OVERLAY) as HTMLElement
      const takesPointer = Array.from(overlay.querySelectorAll<HTMLElement>('*'))
        .filter((el) => el.style.pointerEvents !== '' && el.style.pointerEvents !== 'none')
        .map((el) => `${el.tagName.toLowerCase()}: pointer-events: ${el.style.pointerEvents}`)

      expect(takesPointer).toEqual([])
    })

    it('follows the pointer from an event source outside the overlay', async () => {
      const bodyAdd = vi.spyOn(document.body, 'addEventListener')
      await mountPixelTrail()

      // fiber binds its DOM listeners to whatever it was `connect`ed to, and it
      // reaches this line only after building a real renderer over a real
      // context. Landing them on the body is what says the effect can still
      // follow the mouse now that its own canvas can no longer receive events —
      // the half that a bare `pointer-events: none` patch would destroy in
      // silence.
      expect(bodyAdd.mock.calls.map(([type]) => type)).toContain('pointermove')
    })

    it('hands the GL context back when the operator switches the effect off', async () => {
      const { container, unmount } = await mountPixelTrail()
      const canvas = container.querySelector(`${OVERLAY} canvas`) as HTMLCanvasElement
      const context = gl.contextOf(canvas)
      expect(context, 'fiber never built a renderer, so nothing below is tested').toBeDefined()
      expect(context!.isContextLost()).toBe(false)

      await act(async () => {
        unmount()
      })

      // WebKit gives a web-content process 16 live contexts before it starts
      // recycling the oldest into an unrecoverable loss, and dropping the
      // reference frees nothing. An operator toggling this effect while trying
      // out the others is exactly the sequence that would exhaust them.
      expect(context!.isContextLost()).toBe(true)
    })

    /**
     * The GL state every draw call was issued under.
     *
     * Wrapping `getContext` rather than reaching for the context through the
     * harness after mounting, and that is the whole reason this helper exists:
     * `WebGLState` CACHES every capability it sets, so `gl.enable(gl.BLEND)` is
     * issued at most once, during the first `setMaterial`, and a recorder
     * installed after `render()` sees nothing and reports "no blending calls"
     * for a material that blends perfectly well. Getting between `getContext`
     * and the renderer's constructor is the only place the sequence is whole.
     *
     * The stub's context is a Proxy that routes unknown properties into a spare
     * map, so assigning over `enable`/`disable`/`blendFuncSeparate` replaces the
     * inert defaults; `drawArrays`/`drawElements` are real (they count draws),
     * so those are wrapped and called through.
     */
    function recordDrawState() {
      const original = HTMLCanvasElement.prototype.getContext
      const draws: Array<{ blending: boolean; func: string[] }> = []
      const wired = new WeakSet<object>()
      let blending = false
      let func: string[] = []

      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string) {
        const context = (original as (kind: string) => unknown).call(this, kind) as Record<
          string,
          unknown
        > | null
        if (context === null || kind === '2d' || wired.has(context)) return context
        wired.add(context)
        const nameOf = (value: number) =>
          ['BLEND', 'SRC_ALPHA', 'ONE_MINUS_SRC_ALPHA', 'ONE', 'ZERO'].find(
            (name) => context[name] === value,
          ) ?? String(value)

        context.enable = (cap: number) => {
          if (nameOf(cap) === 'BLEND') blending = true
        }
        context.disable = (cap: number) => {
          if (nameOf(cap) === 'BLEND') blending = false
        }
        context.blendFuncSeparate = (...args: number[]) => {
          func = args.map(nameOf)
        }
        for (const call of ['drawArrays', 'drawElements'] as const) {
          const inner = context[call] as (...args: unknown[]) => void
          context[call] = (...args: unknown[]) => {
            draws.push({ blending, func })
            inner(...args)
          }
        }
        return context
      } as never

      return {
        draws,
        restore: () => {
          HTMLCanvasElement.prototype.getContext = original
        },
      }
    }

    /**
     * Where the trail texture was painted, in its own 512x512 pixels.
     *
     * `useTrailTexture` keeps its trail on a 2D canvas (`id="touchTexture"`) and
     * draws every live point as a radial gradient centred on that point. jsdom
     * has no 2D backend either, but `gl-stub` hands out a recording context, so
     * the centre of each gradient is the one thing in this environment that says
     * where the effect thinks the pointer is.
     */
    function trailPainter() {
      const trail = gl.contexts2d.find((context) => context.canvas.id === 'touchTexture')
      expect(trail, 'drei never built the trail texture, so nothing is under test').toBeDefined()
      const painted: Array<[number, number]> = []
      const inner = trail!.createRadialGradient as (...args: number[]) => unknown
      trail!.createRadialGradient = (...args: number[]) => {
        painted.push([args[0], args[1]])
        return inner(...args)
      }
      return painted
    }

    /**
     * The trail pixel a viewport coordinate should land on.
     *
     * The quad is SQUARE and sized to the viewport's larger side, and the shader
     * maps the screen onto it with the same `coverUv` - so the horizontal axis
     * is 1:1 and the vertical one is compressed by the aspect ratio, and the
     * texture's Y runs the other way (`drawTouch` uses `1 - uv.y`).
     */
    const trailPixel = (clientX: number, clientY: number): [number, number] => {
      const u = clientX / VIEWPORT.width
      const v = 0.5 + (0.5 - clientY / VIEWPORT.height) * (VIEWPORT.height / VIEWPORT.width)
      return [u * TRAIL_TEXTURE_SIZE, (1 - v) * TRAIL_TEXTURE_SIZE]
    }

    /**
     * The full-screen wash - the third way this effect went wrong, and the one
     * an operator hit last: the whole panel under a flat magenta veil, readable
     * and unusable.
     *
     * The shader writes the trail sample as the ALPHA of every pixel
     * (`gl_FragColor = vec4(pixelColor, trail)`) and drei's `shaderMaterial()`
     * passes no `transparent`, so three left the material OPAQUE - `NoBlending`,
     * `gl.enable(gl.BLEND)` never called, alpha discarded. `pixelColor` was
     * therefore written to every pixel of the drawing buffer, and the browser
     * composites that buffer as PREMULTIPLIED (`alpha: true` plus three's own
     * default `premultipliedAlpha: true`, i.e. `src + dst * (1 - srcAlpha)`), so
     * a buffer holding `(pixelColor, 0)` everywhere ADDS `#aa1d8b` to the entire
     * page.
     *
     * WHAT THIS CANNOT SAY. jsdom shades no fragment, so neither the veil nor
     * the trail itself is observable here, and neither is the compositing step -
     * that half is the platform's contract, quoted above, not something this
     * spec measures. What it does measure is the GL state each draw was issued
     * under, which is what decides whether the alpha the shader computes reaches
     * the framebuffer at all. Blending off is the wash; blending on with
     * src-over is a trail.
     */
    it('draws with blending on, so the alpha it computes is not discarded', async () => {
      const recorder = recordDrawState()
      try {
        await mountPixelTrail()
        await act(async () => {
          gl.runFrames(2)
        })

        expect(
          recorder.draws.length,
          'nothing was drawn, so nothing is under test',
        ).toBeGreaterThan(0)
        for (const draw of recorder.draws) {
          expect(draw.blending, 'drawn with GL_BLEND off, which paints the page').toBe(true)
          // `SRC_ALPHA, ONE_MINUS_SRC_ALPHA` and not `ONE, ONE_MINUS_SRC_ALPHA`:
          // three picks the second when `material.premultipliedAlpha` is set,
          // and this shader's colour is NOT premultiplied - under that func an
          // empty trail would write full `pixelColor` at alpha 0 and the wash
          // would come straight back, blending enabled or not.
          expect(draw.func).toEqual([
            'SRC_ALPHA',
            'ONE_MINUS_SRC_ALPHA',
            'ONE',
            'ONE_MINUS_SRC_ALPHA',
          ])
        }
      } finally {
        recorder.restore()
      }
    })

    /**
     * The other half, and the one a repair to the wash could destroy in silence:
     * the trail has to be PAINTED, under the pointer, from an event that arrives
     * at `document.body` - which is where fiber listens now that its own canvas
     * is `pointer-events: none`.
     *
     * `useTrailTexture`'s `onMove` hangs off `onPointerMove` on the mesh, so it
     * runs only if fiber's raycast still reaches the quad after being handed an
     * external event source and told to read `clientX`/`clientY`. If it does
     * not, the texture stays black, every pixel's alpha stays 0, and the setting
     * becomes a no-op that no screenshot tells apart from a working one.
     */
    it('paints the trail under a pointer event delivered to the event source', async () => {
      await mountPixelTrail()
      const painted = trailPainter()

      // Frames with no pointer at all first. The texture is cleared every frame
      // and nothing is drawn onto it - which is what makes each assertion below
      // a statement about the pointer event, and not about a component that
      // paints somewhere regardless.
      await act(async () => {
        gl.runFrames(2)
      })
      expect(painted, 'the trail was painted with no pointer event').toEqual([])

      await act(async () => {
        document.body.dispatchEvent(
          new MouseEvent('pointermove', { clientX: 640, clientY: 400, bubbles: true }),
        )
      })
      await act(async () => {
        gl.runFrames(1)
      })
      // The centre of the viewport is the centre of the texture.
      expect(painted, 'onPointerMove never fired, so the effect is a silent no-op').toEqual([
        trailPixel(640, 400),
      ])

      // And it TRACKS, at the right place. A handler that fired once, or a quad
      // that no longer covers the viewport it is sampled against, cannot follow
      // this — measured: making the quad the SHORT side of the viewport instead
      // of the long one leaves the centre right and lands this point at 51 px
      // instead of 128.
      //
      // What it cannot catch is `eventPrefix`. fiber divides the raw coordinate
      // by the canvas size WITHOUT subtracting the canvas rect, so `client` is
      // right only because `FixedOverlay` puts the canvas at the viewport
      // origin — but jsdom does no layout and hands back `offsetX === clientX`
      // on every event it builds, so the two prefixes are indistinguishable
      // here. Measured: with `eventPrefix: 'offset'` this whole file stays
      // green. That one is held by the comment in `EffectsProvider.tsx`.
      await act(async () => {
        document.body.dispatchEvent(
          new MouseEvent('pointermove', { clientX: 320, clientY: 200, bubbles: true }),
        )
      })
      await act(async () => {
        gl.runFrames(1)
      })
      const [x, y] = painted[painted.length - 1]
      const [expectedX, expectedY] = trailPixel(320, 200)
      expect(x).toBeCloseTo(expectedX, 6)
      expect(y).toBeCloseTo(expectedY, 6)
    })
  })

  // ── Reduced motion ─────────────────────────────────────────────────────────

  /**
   * The app honours `prefers-reduced-motion` twice already — `MotionRoot` passes
   * `reducedMotion="user"` to motion/react, and `index.css` names the CSS
   * animations in a media block. Neither reaches these: a cursor trail is
   * `requestAnimationFrame` and WebGL, and `animation: none` has nothing to
   * switch off in a shader. An audit found every cursor effect and the click
   * sparks running at full speed with the preference set.
   *
   * The preference wins over the operator's pick, matching what the app already
   * does everywhere else. Someone with vestibular sensitivity should not get a
   * full-screen fluid simulation because a dropdown was left on a default.
   */
  describe('prefers-reduced-motion', () => {
    /** jsdom has no media engine; the shared setup answers `false` to everything. */
    function withReducedMotion(reduce: boolean) {
      vi.spyOn(window, 'matchMedia').mockImplementation(
        (query: string) =>
          ({
            matches: reduce && query.includes('prefers-reduced-motion'),
            media: query,
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => false,
          }) as unknown as MediaQueryList,
      )
    }

    it('mounts no cursor effect when the operator asked for reduced motion', async () => {
      // Prove the absence is the PREFERENCE and not the clock. A bare "assert
      // it isn't there" passes on an unresolved lazy chunk, which is
      // indistinguishable from a gate that does nothing — so mount it for real
      // first, on the same budget, and only then set the preference.
      withReducedMotion(false)
      const warm = renderProvider('target')
      await waitFor(() => {
        expect(warm.container.querySelector('.target-cursor-corner')).not.toBeNull()
      })
      warm.unmount()

      withReducedMotion(true)
      const { container } = renderProvider('target')
      await waitFor(() => {
        expect(container.querySelector('main')).not.toBeNull()
      })

      expect(container.querySelector('.target-cursor-corner')).toBeNull()
      // And it must not have hidden the system cursor on the way past.
      expect(document.body.style.cursor).toBe('')
    })

    it('mounts no click effect either', async () => {
      function renderSparks() {
        useEffectsStore.setState({ cursorEffect: 'none', clickEffect: 'spark' })
        return render(
          <EffectsProvider>
            <main>page</main>
          </EffectsProvider>,
        )
      }

      withReducedMotion(false)
      const warm = renderSparks()
      await waitFor(() => {
        expect(warm.container.querySelector('canvas')).not.toBeNull()
      })
      warm.unmount()

      withReducedMotion(true)
      const { container } = renderSparks()
      await waitFor(() => {
        expect(container.querySelector('main')).not.toBeNull()
      })
      expect(container.querySelector('canvas')).toBeNull()
    })

    it('comes back the moment the preference is lifted', async () => {
      withReducedMotion(true)
      const { container, rerender } = renderProvider('target')
      await waitFor(() => {
        expect(container.querySelector('main')).not.toBeNull()
      })
      expect(container.querySelector('.target-cursor-corner')).toBeNull()

      // Not a fresh mount — the same tree, re-read. The gate has to be a live
      // subscription, not a value latched at first render.
      withReducedMotion(false)
      rerender(
        <EffectsProvider>
          <main>page</main>
        </EffectsProvider>,
      )
      await waitFor(() => {
        expect(container.querySelector('.target-cursor-corner')).not.toBeNull()
      })
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
