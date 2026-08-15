/**
 * The appearance tab's two silent defects, pinned.
 *
 * 1. `:root[data-effects="off"]` in index.css was unreachable. The attribute is
 *    written by `AppearanceProvider` from `appearance-store.visualEffects`, and
 *    nothing in the UI has ever called `setVisualEffects` — so the flag is
 *    permanently true, the attribute is permanently "on", and the whole block
 *    (animation / backdrop-filter / filter / will-change resets) selected
 *    nothing no matter what the operator switched off. The switch the operator
 *    DOES have is `effects-store.effectsEnabled`, which the attribute ignored.
 *    So the assertion here is end to end — click the switch the operator sees,
 *    read the attribute the stylesheet selects on — because every step between
 *    them existed and worked, and the chain still did not connect.
 *
 *    Both flags are checked, not just the new one: reading `effectsEnabled`
 *    INSTEAD of `visualEffects` would satisfy the operator-switch test while
 *    quietly dropping the appearance-level gate that `Aurora`, `Noise` and
 *    `SpotlightCard` still honour.
 *
 * 2. The two canvas preview tiles took `effect` as a `useEffect` dependency and
 *    never branched on it, so all seven cursor effects previewed as the same
 *    violet dot trail — a tile that answers a question it has no answer to is
 *    worse than no tile. And both held an unconditional `requestAnimationFrame`,
 *    clearing two canvases 60×/s for an operator who is not moving.
 *
 * WHY THE IDLE TEST COUNTS `clearRect` AND NOT ONLY QUEUED FRAMES. `clears` is
 * the work itself, and it is attributable to a specific canvas; the frame queue
 * is shared with anything else on the page that animates. Both are asserted,
 * but the clear count is the one that cannot be diluted.
 *
 * WHY THERE IS A SECOND, WAKING TEST. "Nothing was drawn" is also what a tile
 * whose loop never starts at all reports. The burst test is what makes the idle
 * test mean idle rather than broken.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { AppearanceProvider } from '@/components/AppearanceProvider'
import {
  installGlStub,
  type GlStubHarness,
  type Stub2DContext,
} from '@/components/reactbits/gl-stub'
import { loadFeatureBundle } from '@/i18n/i18n'
import { useAppearanceStore } from '@/lib/theme/appearance-store'
import {
  CURSOR_EFFECTS,
  useEffectsStore,
  type CursorEffectId,
} from '@/lib/theme/effects-store'
import { renderWithProviders } from '@/test/test-utils'
import { EffectsSettingsCard } from './effects-settings-card'

type PaintedCursorEffect = Exclude<CursorEffectId, 'none'>

/** Every cursor effect that has a tile — `none` hides the preview entirely. */
const PAINTED_CURSOR_EFFECTS = CURSOR_EFFECTS
  .map((effect) => effect.id)
  .filter((id): id is PaintedCursorEffect => id !== 'none')

const cursorTile = (): HTMLElement =>
  screen.getByRole('button', { name: 'Preview cursor effect' })

const clickTile = (): HTMLElement =>
  screen.getByRole('button', { name: 'Preview click effect' })

describe('data-effects follows the switch the operator actually has', () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    // The tiles are not what this group is about, and jsdom has no canvas
    // backend. Keep the null-context path local so unrelated suites still see
    // real canvas access rather than having it hidden globally.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    localStorage.clear()
    useEffectsStore.getState().reset()
    useAppearanceStore.setState({ visualEffects: true })
    delete document.documentElement.dataset.effects
    await loadFeatureBundle('appearance')
  })

  afterEach(() => {
    // The attribute lives on the shared document root; leaving it set would
    // hand the next test a starting state it did not choose.
    delete document.documentElement.dataset.effects
  })

  it('turns the attribute off when the operator turns effects off', async () => {
    const user = userEvent.setup()

    renderWithProviders(
      <AppearanceProvider>
        <EffectsSettingsCard />
      </AppearanceProvider>,
    )
    expect(document.documentElement.dataset.effects).toBe('on')

    await user.click(screen.getByRole('switch', { name: 'Enable visual effects' }))

    expect(useEffectsStore.getState().effectsEnabled).toBe(false)
    expect(document.documentElement.dataset.effects).toBe('off')
  })

  it('turns it back on when the operator turns effects back on', async () => {
    const user = userEvent.setup()
    useEffectsStore.getState().setEffectsEnabled(false)

    renderWithProviders(
      <AppearanceProvider>
        <EffectsSettingsCard />
      </AppearanceProvider>,
    )
    expect(document.documentElement.dataset.effects).toBe('off')

    await user.click(screen.getByRole('switch', { name: 'Enable visual effects' }))

    expect(document.documentElement.dataset.effects).toBe('on')
  })

  it('still honours the appearance-level flag on its own', () => {
    useAppearanceStore.setState({ visualEffects: false })

    renderWithProviders(<AppearanceProvider>{null}</AppearanceProvider>)

    expect(useEffectsStore.getState().effectsEnabled).toBe(true)
    expect(document.documentElement.dataset.effects).toBe('off')
  })
})

describe('preview tiles', () => {
  let gl: GlStubHarness

  /** The stub context backing the canvas inside a given tile. */
  function context2dOf(tile: HTMLElement): Stub2DContext {
    const canvas = tile.querySelector('canvas')
    if (!canvas) throw new Error('preview tile renders no canvas')
    const context = gl.contexts2d.find((candidate) => candidate.canvas === canvas)
    if (!context) throw new Error('preview canvas never asked for a 2d context')
    return context
  }

  beforeEach(async () => {
    localStorage.clear()
    useEffectsStore.getState().reset()
    // Only the two canvas tiles are under test. The text/content previews
    // animate through motion/react and would put frames on the shared queue
    // that have nothing to do with the loops being measured.
    useEffectsStore.setState({
      textAnimation: 'none',
      contentAnimation: 'none',
      hoverEffect: 'none',
    })
    // Matches the canvas's own 400×100 backing store, so a pointer position in
    // client space needs no scaling to land where the assertion expects.
    gl = installGlStub({ width: 400, height: 100 })
    await loadFeatureBundle('appearance')
  })

  afterEach(() => {
    // Unmount while `cancelAnimationFrame` is still the stubbed one, so a tile
    // that DOES hold a frame is released against the same queue it booked on.
    cleanup()
    gl.teardown()
  })

  /**
   * A tile identifies its effect two ways: the NAME in the corner caption, and
   * the CHROME around it — the caption's icon and hue, the border accent. This
   * spec owns the chrome. What gets painted on the canvas belongs to `paints a
   * different mark` below, and the pair is what covers "the tiles look
   * different".
   *
   * WHY THE TEXT IS BLANKED FIRST. Comparing whole markup made this a
   * disjunction, and the weaker half answered for the stronger one: a mutation
   * that gave all seven tiles a single hue, a single icon and a single border
   * still passed, because the names alone kept the strings apart. Every element,
   * class and inline style stays in the comparison — only the words come out —
   * so what survives is exactly the part a reader recognises without reading.
   */
  it('gives every cursor effect its own tile chrome, names aside', () => {
    /** Strip the words, keep the structure. */
    function chromeOf(tile: HTMLElement): string {
      const clone = tile.cloneNode(true) as HTMLElement
      const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT)
      const texts: Text[] = []
      while (walker.nextNode()) texts.push(walker.currentNode as Text)
      for (const node of texts) node.data = ''
      return clone.outerHTML
    }

    const chrome = new Map<PaintedCursorEffect, string>()

    for (const effect of PAINTED_CURSOR_EFFECTS) {
      useEffectsStore.setState({ cursorEffect: effect })
      renderWithProviders(<EffectsSettingsCard />)
      chrome.set(effect, chromeOf(cursorTile()))
      cleanup()
    }

    expect(chrome.size).toBe(PAINTED_CURSOR_EFFECTS.length)
    for (const [left, leftChrome] of chrome) {
      for (const [right, rightChrome] of chrome) {
        if (left >= right) continue
        expect(
          rightChrome,
          `"${left}" and "${right}" are indistinguishable once their names are removed`,
        ).not.toBe(leftChrome)
      }
    }
  })

  /**
   * The stored effect id is operator state that survives a deploy, and the
   * preview tiles index a `Record` with it. `PreviewCaption` destructures
   * `style.Icon` on the spot, so an id outside the union threw and took the
   * whole Appearance page down — the page an operator opens to turn the
   * offending effect off in the first place.
   *
   * `migrate` in `effects-store` is no help: it runs only when the persisted
   * version differs, so an id that stops being valid without a version bump is
   * stored, loaded and fatal. Retiring an effect id is a normal thing to do.
   */
  it('falls back to a tile instead of taking the page down on an unknown effect', () => {
    useEffectsStore.setState({ cursorEffect: 'sparkTrail' as never, clickEffect: 'ripple' as never })

    expect(() => {
      renderWithProviders(<EffectsSettingsCard />)
    }, 'a retired effect id in localStorage bricked the settings page').not.toThrow()
  })

  it('paints a different mark for every cursor effect', () => {
    const painted = new Map<PaintedCursorEffect, string>()

    for (const effect of PAINTED_CURSOR_EFFECTS) {
      useEffectsStore.setState({ cursorEffect: effect })
      renderWithProviders(<EffectsSettingsCard />)
      const tile = cursorTile()
      const context = context2dOf(tile)

      fireEvent.mouseMove(tile, { clientX: 120, clientY: 40 })
      // A ZERO-length frame, so every mark is sampled at exactly age 0.
      // Advancing the clock instead would make each effect's own lifetime bleed
      // into the mark's alpha, and seven different lifetimes are then enough to
      // make seven identical dots look distinct — which is how a first cut of
      // this test passed against a draw function that had been mutated back to
      // one violet dot for every effect. What is under test here is the MARK.
      gl.runFrames(1, 0)

      // What the stub can observe: every colour assigned to `fillStyle`, every
      // glyph drawn, every gradient stop — plus the leftover pen state, which
      // is how the two stroked shapes (crosshair guides, target brackets) are
      // told apart at all. The stub logs fills but not strokes, so their colour
      // and width are read from the context instead of from a log.
      painted.set(
        effect,
        JSON.stringify({
          fills: context.fillStyles,
          text: context.filledText,
          gradient: context.gradientStops,
          stroke: context.strokeStyle,
          lineWidth: context.lineWidth,
          font: context.font,
        }),
      )
      cleanup()
    }

    for (const [left, leftPaint] of painted) {
      for (const [right, rightPaint] of painted) {
        if (left >= right) continue
        expect(
          rightPaint,
          `"${left}" and "${right}" paint the same mark`,
        ).not.toBe(leftPaint)
      }
    }
  })

  it('draws nothing at all while the operator sits still', () => {
    useEffectsStore.setState({ cursorEffect: 'crosshair', clickEffect: 'spark' })

    renderWithProviders(<EffectsSettingsCard />)
    const cursor = context2dOf(cursorTile())
    const click = context2dOf(clickTile())

    expect(gl.pendingFrames()).toBe(0)

    gl.runFrames(30)

    expect(cursor.clears).toBe(0)
    expect(click.clears).toBe(0)
    expect(gl.pendingFrames()).toBe(0)
  })

  it('wakes for a burst and goes back to sleep when it ends', () => {
    useEffectsStore.setState({ cursorEffect: 'ghost', clickEffect: 'spark' })

    renderWithProviders(<EffectsSettingsCard />)
    const tile = cursorTile()
    const cursor = context2dOf(tile)
    const click = context2dOf(clickTile())

    fireEvent.mouseMove(tile, { clientX: 120, clientY: 40 })
    gl.runFrames(3)
    expect(cursor.clears).toBeGreaterThan(0)
    // A pointer over the cursor tile is not a click, so the other tile stays
    // asleep — the two loops are independent.
    expect(click.clears).toBe(0)

    // 120 × 16 ms = 1.92 s, past the longest mark lifetime in the table.
    gl.runFrames(120)
    const settled = cursor.clears
    gl.runFrames(30)

    expect(cursor.clears).toBe(settled)
    expect(gl.pendingFrames()).toBe(0)
  })
})
