// @vitest-environment jsdom

/**
 * Every WebGL card effect hands its context back, proved by running it.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A FILE THAT LOOKS LIKE IT ALREADY EXISTS. The catalog ships 38 WebGL
 * effects, and until this file the claim "all 38 release their context" rested
 * on three different kinds of evidence of very different strength:
 *
 *   • 20 were driven for real by `reactbits-repaired-lifecycle.test.tsx`;
 *   • 2 raw-WebGL ones and 6 mocked Paper ones by two files in the cabinet;
 *   • the remaining 10 — `plasma`, `particles`, `grainient`, `silk`, `beams`,
 *     `dither`, `chromaticWaves`, `dotMatrix`, `tornado`, `particleSphere` —
 *     by nothing but the standing source audit in the cabinet's
 *     `card-effect-context-ownership.test.tsx`.
 *
 * That audit asks a DIFFERENT question: "does this file destroy a context on a
 * canvas React owns?". A component that allocates its own canvas and then never
 * releases anything passes it, because it destroys nothing on a React element —
 * it destroys nothing at all. That is not a hypothetical: the release in
 * `paper.tsx` existed, read a ref React had already cleared, and never ran, and
 * the audit had nothing to say about it.
 *
 * WHAT THIS FILE ADDS ON TOP OF THE LIFECYCLE SUITE. One uniform list of all 38
 * — so a new effect that is added to the catalog and forgotten here is visible
 * as a gap in one place — and the property the older suite never asserted:
 *
 *   ACCUMULATION. Three mount → unmount rounds over the SAME host element, with
 *   the live-context count checked after every single one. WebKit gives a
 *   web-content process 16 live contexts and then starts recycling the oldest
 *   into an unrecoverable SyntheticLostContext; an operator scrolling the
 *   effect picker reaches 16 in one sitting. A single-round test cannot see a
 *   leak of one per mount as anything other than "the last one is still open".
 *
 * WHAT IS NOT OBSERVABLE HERE, so it is not claimed. `gl-stub.ts` models the
 * platform contract (one context per canvas element, a lost context stays lost)
 * rather than observing a driver, and no fragment is ever shaded. So this pins
 * ownership, lifetime and counts, and says nothing about the picture. See that
 * file's header.
 *
 * WHERE THE OTHER SIX ARE. The Paper shaders come out of one wrapper module and
 * are driven against the REAL `@paper-design/shaders-react` in
 * `paper-real-package-release.test.tsx` next door. The two suites named
 * `paper-context-release.test.tsx` — one in `src/features/branding/`, one in
 * the cabinet — mock the package, and both name that as their blind spot.
 *
 * A DEFECT THIS SUITE FOUND AND DELIBERATELY DOES NOT COVER. All 38 release
 * their context. Three of them — `chromaticWaves`, `dotMatrix` (both OGL, both
 * vendored under `originkit/`) and `thunderstrike` (raw WebGL) — register no
 * `webglcontextlost` listener at all, so they never call `preventDefault()` and
 * never stop their frame loop. WebGL reads a loss that was not
 * `preventDefault`ed as "do not bother restoring": the browser never fires
 * `webglcontextrestored`, and the recoverable loss WebKit produces when it
 * recycles the oldest of its sixteen contexts becomes a permanently blank card
 * for the rest of the session, with the render loop still burning a frame slot
 * against dead handles. Their siblings show the pattern — `cosmicOrb` has the
 * full handler in raw WebGL, `plasma`/`grainient` have it in OGL — and
 * `reactbits-repaired-lifecycle.test.tsx` already has the three cases that pin
 * it for the twenty effects it covers.
 *
 * It is not fixed here because it is a behaviour change to files that are
 * BYTE-FROZEN against the cabinet and vendored in the opposite direction from
 * everything else (`scripts/sync-originkit.mjs` copies originkit reiwa → panel,
 * with a hash manifest on both sides), so the repair is a cross-repo change
 * with its own tests, not a rider on a testing task.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Antigravity from './Antigravity'
import Aurora from './Aurora'
import Balatro from './Balatro'
import Beams from './Beams'
import ColorBends from './ColorBends'
import Dither from './Dither'
import EvilEye from './EvilEye'
import FaultyTerminal from './FaultyTerminal'
import Galaxy from './Galaxy'
import Grainient from './Grainient'
import Iridescence from './Iridescence'
import LaserFlow from './LaserFlow'
import LightPillar from './LightPillar'
import LineWaves from './LineWaves'
import LiquidChrome from './LiquidChrome'
import MagicRings from './MagicRings'
import Particles from './Particles'
import PixelBlast from './PixelBlast'
import Plasma from './Plasma'
import PlasmaWave from './PlasmaWave'
import PrismaticBurst from './PrismaticBurst'
import Radar from './Radar'
import RippleGrid from './RippleGrid'
import Silk from './Silk'
import SoftAurora from './SoftAurora'
import Threads from './Threads'
import { installGlStub, type GlStubHarness } from './gl-stub'
import ChromaticWaves from './originkit/ChromaticWaves'
import CosmicOrb from './originkit/CosmicOrb'
import DotMatrix from './originkit/DotMatrix'
import Particlesphere from './originkit/Particlesphere'
import Thunderstrike from './originkit/Thunderstrike'
import Tornado from './originkit/Tornado'

/**
 * The catalog id, so this list can be compared against
 * `card-effect-catalog.ts` by eye and by the guard at the bottom of the file.
 * The six `paper*` ids are covered next door and are named in
 * `COVERED_ELSEWHERE` rather than left silently missing.
 */
const WEBGL_EFFECTS = [
  ['antigravity', <Antigravity key="e" />],
  ['aurora', <Aurora key="e" />],
  ['balatro', <Balatro key="e" />],
  ['beams', <Beams key="e" />],
  ['chromaticWaves', <ChromaticWaves key="e" />],
  ['colorBends', <ColorBends key="e" />],
  ['cosmicOrb', <CosmicOrb key="e" />],
  ['dither', <Dither key="e" />],
  ['dotMatrix', <DotMatrix key="e" />],
  ['evilEye', <EvilEye key="e" />],
  ['faultyTerminal', <FaultyTerminal key="e" />],
  ['galaxy', <Galaxy key="e" />],
  ['grainient', <Grainient key="e" />],
  ['iridescence', <Iridescence key="e" />],
  ['laserFlow', <LaserFlow key="e" />],
  ['lightPillar', <LightPillar key="e" />],
  ['lineWaves', <LineWaves key="e" />],
  ['liquidChrome', <LiquidChrome key="e" />],
  ['magicRings', <MagicRings key="e" />],
  ['particleSphere', <Particlesphere key="e" />],
  ['particles', <Particles key="e" />],
  ['pixelBlast', <PixelBlast key="e" />],
  ['plasma', <Plasma key="e" />],
  ['plasmaWave', <PlasmaWave key="e" />],
  ['prismaticBurst', <PrismaticBurst key="e" />],
  ['radar', <Radar key="e" />],
  ['rippleGrid', <RippleGrid key="e" />],
  ['silk', <Silk key="e" />],
  ['softAurora', <SoftAurora key="e" />],
  ['threads', <Threads key="e" />],
  ['thunderstrike', <Thunderstrike key="e" />],
  ['tornado', <Tornado key="e" />],
] as const

/** The Paper shaders, driven against the real package in `paper-context-release.test.tsx`. */
const COVERED_ELSEWHERE = [
  'paperMesh',
  'paperWarp',
  'paperGrain',
  'paperDither',
  'paperSwirl',
  'paperMetaballs',
] as const

let gl: GlStubHarness
const live: Array<{ root: Root; host: HTMLDivElement }> = []

beforeEach(() => {
  gl = installGlStub()
  // react-three-fiber renders through `createRoot` from its own reconciler and
  // warns — then behaves differently — outside an act environment.
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})

afterEach(() => {
  for (const { root, host } of live.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  gl?.teardown()
})

function makeHost(): HTMLDivElement {
  const host = document.createElement('div')
  document.body.append(host)
  return host
}

/**
 * Mount and let the component reach its renderer.
 *
 * The `resize` dispatch is what fiber needs: it measures with
 * react-use-measure, which starts at 0×0 and only reads the element when
 * something tells it to, and it refuses to build a renderer for a zero-size
 * box — so without this the canvas never exists in jsdom. It is harmless for
 * the rest: an ogl or three component re-measures the same stubbed rect.
 *
 * `async` throughout because fiber configures its renderer from an async
 * function, so a synchronous render returns before the canvas is created.
 */
async function mountInto(host: HTMLDivElement, element: React.ReactElement): Promise<Root> {
  const root = createRoot(host)
  live.push({ root, host })
  await act(async () => {
    root.render(element)
  })
  await act(async () => {
    window.dispatchEvent(new Event('resize'))
  })
  await act(async () => {
    gl.runFrames(2)
  })
  return root
}

async function unmountRoot(root: Root): Promise<void> {
  const index = live.findIndex(entry => entry.root === root)
  if (index >= 0) live.splice(index, 1)
  await act(async () => {
    root.unmount()
  })
}

describe.each(WEBGL_EFFECTS)('%s', (id, element) => {
  it('takes a context on mount and hands it back on unmount', async () => {
    const host = makeHost()
    const root = await mountInto(host, element)

    // The premise. Everything below is vacuous against a component that never
    // reached its renderer at all, and under a stub that is an easy state to
    // be in without noticing.
    expect(gl.contexts.length, `${id} never opened a WebGL context`).toBeGreaterThanOrEqual(1)
    const opened = gl.contexts.filter(context => !context.isContextLost())
    expect(opened.length, `${id} destroyed its own context while still mounted`).toBe(1)

    await unmountRoot(root)
    host.remove()

    for (const context of gl.contexts) {
      expect(
        context.loseCalls,
        `${id} dropped a context reference without destroying it. A dropped ` +
          'reference frees nothing: WebKit returns the slot only when the ' +
          'context object is destroyed, and it caps a web-content process at 16 ' +
          'before it starts recycling the oldest into an unrecoverable ' +
          'SyntheticLostContext',
      ).toBeGreaterThanOrEqual(1)
    }
    expect(gl.liveContexts(), `${id} left a context alive after unmount`).toEqual([])
  })

  it('does not accumulate contexts over three mount/unmount rounds', async () => {
    // The same host element every round — an operator stepping through the
    // effect picker replaces the effect in one slot, and React keeps the DOM.
    // A leak of one context per mount is invisible to a single-round test,
    // which cannot tell it apart from "the one that is still mounted".
    const host = makeHost()

    for (const round of [1, 2, 3]) {
      const root = await mountInto(host, element)

      expect(
        gl.liveContexts().length,
        `${id} held ${gl.liveContexts().length} live contexts while mounted on ` +
          `round ${round}. Sixteen is the whole budget for the page`,
      ).toBe(1)

      await unmountRoot(root)

      expect(
        gl.liveContexts().length,
        `${id} left ${gl.liveContexts().length} contexts alive after round ` +
          `${round} of mount → unmount. At one leaked slot per mount the ` +
          'operator reaches WebKit’s ceiling inside a single sitting, and ' +
          'the effects that were already on screen go permanently blank',
      ).toBe(0)
    }

    // Three rounds allocated three contexts and released all three: the count
    // that grows is the ALLOCATION count, never the live one.
    expect(gl.contexts.length, `${id} did not build a renderer on every round`).toBeGreaterThanOrEqual(3)
    host.remove()
  })
})

describe('the harness itself', () => {
  /**
   * A stub whose primitives lie is worse than no stub, and this one lied.
   *
   * `GlStubHarness.loseContext()` used to destroy a context by assigning
   * `context.lost = true`. The context is a Proxy whose real state lives in a
   * closure, and its set trap routes any unknown property into a side table —
   * so the assignment created a SHADOW property that read back as `true` while
   * `isContextLost()` went on answering `false` and `liveContexts()` went on
   * counting the context as live.
   *
   * Measured before the fix: `lost=true isContextLost=false live=1`, and a draw
   * issued after the "loss" was booked as a live one. Every assertion shaped
   * like `expect(context.isContextLost()).toBe(false)` after a harness-driven
   * loss was therefore unfailable — a test that cannot go red for the reason it
   * names. This case is what keeps that from coming back.
   *
   * IT ALSO PINS THE DRAW ACCOUNTING, which had the same disease one layer
   * down. The counter used to read `if (!state.lost) state.draws++`, so a draw
   * into a dead context was not merely a no-op — it was invisible, and
   * `expect(draws).toBe(drewAtLoss)` after a loss held for every possible
   * implementation. The contract asserted here is the repaired one: the call is
   * COUNTED (real WebGL issues it and silently does nothing), and the fact that
   * it went into a dead context is recorded next to it.
   */
  it('really destroys a context when it says it did', () => {
    const canvas = document.createElement('canvas')
    document.body.append(canvas)
    const context = canvas.getContext('webgl2') as unknown as {
      isContextLost(): boolean
      draws: number
      drawsWhileLost: number
      drawArrays(): void
      getUniformLocation(program: unknown, name: string): { name: string } | null
    }
    context.drawArrays()
    const drewBefore = context.draws
    expect(context.drawsWhileLost, 'a live draw was booked against a dead context').toBe(0)

    gl.loseContext(canvas)

    expect(context.isContextLost(), 'the loss never reached the context object').toBe(true)
    expect(gl.liveContexts(), 'a destroyed context is still counted as live').toEqual([])

    context.drawArrays()
    expect(
      context.draws,
      'the harness lost sight of a draw call the moment it mattered most. A draw ' +
        'into a lost context is a silent no-op in real WebGL, not an unevent — ' +
        'a stub that declines to count it makes "stopped drawing after the loss" ' +
        'true for every implementation, including one that never stops',
    ).toBe(drewBefore + 1)
    expect(
      context.drawsWhileLost,
      'the draw was counted but not attributed to the loss, so no test can tell ' +
        'a loop that stopped from one that did not',
    ).toBe(1)

    // AND THE STUB IS NOT MORE FORGIVING THAN THE PLATFORM. Real WebGL returns
    // null here; this used to hand back a usable-looking location whatever the
    // state, so a component missing its null check would throw on a device and
    // pass in this suite — the blind draw counter's mirror image, a crash that
    // cannot surface rather than an assertion that cannot fail. It is pinned
    // HERE, in the harness's own spec, precisely because no component reaches
    // it: measured across all 510 tests in this directory, this branch is
    // called zero times, so nothing else would notice it rotting back.
    expect(
      context.getUniformLocation(null, 'uTime'),
      'a dead context handed back a usable uniform location',
    ).toBeNull()

    gl.restoreContext(canvas)
    expect(context.isContextLost(), 'the restore never reached the context object').toBe(false)
    // The window closed: a draw after the restore is a live one again.
    context.drawArrays()
    expect(context.drawsWhileLost, 'the restore did not end the loss window').toBe(1)
    canvas.remove()
  })
})

describe('the list itself', () => {
  it('covers every WebGL effect in the card catalog', async () => {
    // Imported lazily so the catalog — which is renderer-free on purpose — is
    // not dragged into the module graph of every mount above.
    const { CARD_EFFECT_CATALOG } = await import('@/features/branding/card-effect-catalog')
    const webglIds = Object.entries(CARD_EFFECT_CATALOG)
      .filter(([, entry]) => entry.renderer !== 'canvas2d')
      .map(([id]) => id)
      .sort()

    const proved = [...WEBGL_EFFECTS.map(([id]) => id), ...COVERED_ELSEWHERE].sort()

    // Not `toContain` per id: the point is that the two sets are EQUAL, so an
    // effect added to the catalog and forgotten here fails, and so does a name
    // left behind here after an effect is removed.
    expect(
      proved,
      'the catalog and this suite disagree about which effects run on a GPU ' +
        'context. Every one of them costs a slot out of WebKit’s sixteen, so ' +
        'a new one needs its release driven here before it ships',
    ).toEqual(webglIds)
    expect(webglIds.length, 'the catalog no longer holds 38 WebGL effects').toBe(38)
  })
})
