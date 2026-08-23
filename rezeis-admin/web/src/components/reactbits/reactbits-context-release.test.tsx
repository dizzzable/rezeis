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

import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

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
import PixelTrail from './PixelTrail'
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

/**
 * Fiber-backed components in this directory that are NOT card effects, and so
 * are outside the reach of the catalog guard at the bottom of the file.
 *
 * `pixelTrail` is a GLOBAL cursor effect — `EffectsProvider` mounts it from a
 * settings switch, not from a card — and it is the reason this list exists at
 * all. It carried the same double context release the four card effects did
 * (its own synchronous `forceContextLoss()`, then fiber's from a 500 ms
 * `setTimeout`, INVALID_OPERATION on the second), and nothing in this directory
 * drove it: the guard below compares this suite against `CARD_EFFECT_CATALOG`,
 * so a `<Canvas>` that is not a card effect could never appear in its diff.
 * `covers every fiber-backed component in this directory` is the check that
 * closes that, and it reads the source rather than this list.
 */
const NON_CATALOG_FIBER_EFFECTS = [['pixelTrail', <PixelTrail key="e" />]] as const

/**
 * Everything the cases below are actually driven over. Kept separate from
 * `WEBGL_EFFECTS` because the catalog guard must still compare the CARD list
 * against the catalog — folding a cursor effect into it would make that
 * comparison fail for a component that is correctly absent from the catalog.
 */
const DRIVEN = [...WEBGL_EFFECTS, ...NON_CATALOG_FIBER_EFFECTS]

/** The Paper shaders, driven against the real package in `paper-context-release.test.tsx`. */
const COVERED_ELSEWHERE = [
  'paperMesh',
  'paperWarp',
  'paperGrain',
  'paperDither',
  'paperSwirl',
  'paperMetaballs',
] as const

// `__dirname`, not `fileURLToPath(import.meta.url)`: under this repo's Vite
// transform `import.meta.url` is the dev server's http:// module URL rather
// than a file: one, and `fileURLToPath` throws on it at collection time — which
// prints `Tests no tests` with a ZERO count, not a failure. Same anchor
// `card-effects-manifest.test.ts` next door uses.
const COMPONENT_DIR = __dirname

/**
 * Which named bindings a module pulls out of `@react-three/fiber`.
 *
 * Matched on the IMPORT rather than on `<Canvas`, because `<Canvas` also
 * appears in prose — `fiber-render-scale.tsx` quotes fiber's own source in a
 * comment — and a scan that counted comments would name a module that mounts
 * nothing. Bindings are compared exactly, so `CanvasProps` does not read as
 * `Canvas`.
 */
const FIBER_IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]@react-three\/fiber['"]/g

function mountsFiberCanvas(source: string): boolean {
  for (const match of source.matchAll(FIBER_IMPORT)) {
    const bindings = match[1]
      .split(',')
      .map(part => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
    if (bindings.includes('Canvas')) return true
  }
  return false
}

/**
 * Every component file under this directory that mounts a fiber `<Canvas>`,
 * found by reading the tree rather than by being remembered. Paths are relative
 * to this directory so `originkit/` shows up as such in a failure.
 *
 * `*.test.*` / `*.spec.*` are skipped by name: a suite that imports `Canvas` to
 * build a fixture is not a component anything ships, and this file would
 * otherwise be able to become its own finding.
 */
function discoverFiberCanvasComponents(prefix = ''): string[] {
  const found: string[] = []
  for (const entry of readdirSync(join(COMPONENT_DIR, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      found.push(...discoverFiberCanvasComponents(relative))
      continue
    }
    if (!/\.tsx?$/.test(entry.name)) continue
    if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue
    if (mountsFiberCanvas(readFileSync(join(COMPONENT_DIR, relative), 'utf8'))) {
      found.push(relative)
    }
  }
  return found.sort()
}

let gl: GlStubHarness
const live: Array<{ root: Root; host: HTMLDivElement }> = []

beforeEach(() => {
  gl = installGlStub()
  // react-three-fiber renders through `createRoot` from its own reconciler and
  // warns — then behaves differently — outside an act environment.
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})

afterEach(() => {
  // Defensive: `unmountRoot` restores the clock in a `finally`, but a case that
  // throws from its own `atUnmount` closure would otherwise hand the next test
  // a faked `setTimeout` and a mount that never measures.
  vi.useRealTimers()
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

/**
 * How long `@react-three/fiber` waits before its own teardown. Its
 * `unmountComponentAtNode` hands the reconciler a commit callback that does
 * nothing but `setTimeout(..., 500)`, and the second-to-last thing inside is
 * `state.gl?.forceContextLoss?.()`.
 */
const FIBER_TEARDOWN_MS = 500

/**
 * Unmount, take a reading at the SYNCHRONOUS boundary, then let fiber's
 * deferred teardown run.
 *
 * WHY BOTH PHASES ARE LOAD-BEARING, and why either one alone is an assertion
 * that cannot fail in the direction the defect goes.
 *
 *   - `atUnmount` runs after React has flushed every cleanup and BEFORE the
 *     500 ms timer. It is the only moment at which “this component released its
 *     own context” is distinguishable from “fiber released it half a second
 *     later” — past the flush the two are identical, because fiber's timer
 *     destroys the context whether or not the component did. A suite that only
 *     looked after the flush would go green for a component that released
 *     nothing at all, which is the entire leak this file exists for.
 *
 *   - The advance is what makes a DOUBLE release observable. Without it the
 *     second call never happens in this process, so a lower bound and an exact
 *     count read the same and neither can see two. The four fiber-backed
 *     effects release synchronously on purpose — WebKit caps a web-content
 *     process at 16 live contexts and half a second is several carousel slides
 *     — and fiber then repeated the call on the context they had already
 *     destroyed. `WEBGL_lose_context.loseContext()` on an already-lost context
 *     is INVALID_OPERATION, and it shipped: `loseContext: context already lost`
 *     in a subscriber's console, with this file green.
 *
 * ONLY `setTimeout`/`clearTimeout` ARE FAKED, AND ONLY ACROSS THE UNMOUNT.
 * fiber builds its renderer from an async function and React's `act` reaches
 * for `MessageChannel`; faking the clock wholesale, or before the mount, stalls
 * the mount instead — including react-use-measure's debounce, without which
 * fiber never builds a renderer at all — and tests nothing.
 */
async function unmountRoot(root: Root, atUnmount?: () => void): Promise<void> {
  const index = live.findIndex(entry => entry.root === root)
  if (index >= 0) live.splice(index, 1)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    await act(async () => {
      root.unmount()
    })
    atUnmount?.()
    await act(async () => {
      vi.advanceTimersByTime(FIBER_TEARDOWN_MS)
    })
  } finally {
    vi.useRealTimers()
  }
}

describe.each(DRIVEN)('%s', (id, element) => {
  it('takes a context on mount and hands it back on unmount', async () => {
    const host = makeHost()
    const root = await mountInto(host, element)

    // The premise. Everything below is vacuous against a component that never
    // reached its renderer at all, and under a stub that is an easy state to
    // be in without noticing.
    expect(gl.contexts.length, `${id} never opened a WebGL context`).toBeGreaterThanOrEqual(1)
    const opened = gl.contexts.filter(context => !context.isContextLost())
    expect(opened.length, `${id} destroyed its own context while still mounted`).toBe(1)

    await unmountRoot(root, () => {
      // THE SYNCHRONOUS CHECKPOINT. fiber's 500 ms teardown has not run yet, so
      // everything asserted here is something the COMPONENT did.
      for (const context of gl.contexts) {
        expect(
          context.loseCalls,
          `${id} destroyed its context ${context.loseCalls} times on unmount, ` +
            'not once. Zero is a dropped reference, which frees nothing: WebKit ' +
            'returns the slot only when the context object is destroyed, and it ' +
            'caps a web-content process at 16 before it starts recycling the ' +
            'oldest into an unrecoverable SyntheticLostContext. Two or more is ' +
            'the same slot handed back twice, which is INVALID_OPERATION on the ' +
            'second call and a console error on a real device',
        ).toBe(1)
      }
      expect(gl.liveContexts(), `${id} left a context alive after unmount`).toEqual([])
    })
    host.remove()

    // AND FIBER'S DEFERRED TEARDOWN CHANGED NOTHING. It ran between the closure
    // above and this line, and for the fiber-backed effects it reached for
    // `forceContextLoss` on a context that was already gone.
    for (const context of gl.contexts) {
      expect(
        context.loseCalls,
        `${id} released the same context ${context.loseCalls} times once ` +
          "fiber's deferred teardown had run. The second call lands on a " +
          'context the component already destroyed: INVALID_OPERATION per the ' +
          'WEBGL_lose_context spec, and `loseContext: context already lost` in ' +
          'the console of every subscriber whose card crossed its ' +
          'IntersectionObserver gate',
      ).toBe(1)
    }
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

      await unmountRoot(root, () => {
        // Checked BEFORE fiber's timer, for the same reason as above: past it, a
        // component that released nothing is indistinguishable from one that
        // released everything, and the leak this test exists for goes green.
        expect(
          gl.liveContexts().length,
          `${id} left ${gl.liveContexts().length} contexts alive after round ` +
            `${round} of mount → unmount. At one leaked slot per mount the ` +
            'operator reaches WebKit’s ceiling inside a single sitting, and ' +
            'the effects that were already on screen go permanently blank',
        ).toBe(0)
      })
    }

    // Three rounds allocated three contexts and released all three: the count
    // that grows is the ALLOCATION count, never the live one.
    expect(gl.contexts.length, `${id} did not build a renderer on every round`).toBeGreaterThanOrEqual(3)
    // And every one of them was handed back exactly once, fiber's deferred
    // teardown included. Three rounds is where a double release is cheapest to
    // see: it is three console errors on a device, not one.
    expect(
      gl.contexts.map(context => context.loseCalls),
      `${id} did not release each of its contexts exactly once over three rounds`,
    ).toEqual(gl.contexts.map(() => 1))
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

  /**
   * THE GUARD ABOVE HAS A BLIND SPOT, AND THIS IS IT.
   *
   * That one compares this suite against `CARD_EFFECT_CATALOG`. Every id it can
   * ever name is a card effect, so a component in this directory that mounts a
   * fiber `<Canvas>` WITHOUT being a card effect is outside its reach by
   * construction — not overlooked, unreachable. `PixelTrail` is a global cursor
   * effect, it took a GL context on every mount, it shipped the same double
   * release the four card effects did, and the catalog guard was green
   * throughout because the catalog has nothing to say about cursors.
   *
   * So this one does not consult a list of names. It reads the directory and
   * asks which files import `Canvas` from `@react-three/fiber`, then asks
   * whether this suite drives each of them. A sixth added the same way fails
   * here on the day it is written.
   *
   * WHAT IT DOES NOT COVER, stated rather than implied: components that take a
   * GL context by some other route — raw `getContext('webgl2')`, OGL's
   * `Renderer`, three's `WebGLRenderer` built by hand. Several such components
   * live here (`GhostCursor`, `BlobCursor`, `TargetCursor`, `TextCursor`) and
   * are enumerated by nothing in this directory either. They do not carry THIS
   * defect — the deferred repeat is fiber's, and they have no fiber root — but
   * they are the same shape of gap, and closing it needs a coverage ledger
   * across `cursor-lifecycle.test.tsx` and `reactbits-repaired-lifecycle.test.tsx`
   * rather than a wider regex here.
   */
  it('covers every fiber-backed component in this directory', () => {
    const fiberBacked = discoverFiberCanvasComponents()

    // ANCHORED ON A NON-EMPTY RESULT, and on the files it must already be
    // finding. A scan that quietly found nothing — a moved directory, a changed
    // import style, a regex that stopped matching — would leave the real
    // assertion below iterating an empty list and passing against any tree at
    // all. That is the exact failure this file was rewritten to stop being an
    // example of, so it is not left available to the check that fixes it.
    expect(
      fiberBacked.length,
      'the fiber-component scan found nothing to check. It is supposed to find ' +
        'at least the five components known to mount a `<Canvas>`; finding zero ' +
        'means the scan is broken, not that the directory is clean',
    ).toBeGreaterThanOrEqual(5)
    expect(
      fiberBacked,
      'the fiber-component scan stopped seeing files it used to see',
    ).toEqual(
      expect.arrayContaining([
        'Antigravity.tsx',
        'Beams.tsx',
        'Dither.tsx',
        'PixelTrail.tsx',
        'Silk.tsx',
      ]),
    )

    const driven = new Set(DRIVEN.map(([id]) => id.toLowerCase()))
    const uncovered = fiberBacked.filter(
      file => !driven.has(basename(file).replace(/\.tsx$/, '').toLowerCase()),
    )

    expect(
      uncovered,
      'a component in this directory mounts a react-three-fiber `<Canvas>` and ' +
        'nothing here drives it. It takes one of WebKit’s sixteen context ' +
        'slots on every mount, and fiber repeats `forceContextLoss()` from a ' +
        '500 ms `setTimeout` after any synchronous release the component does ' +
        'itself — which is INVALID_OPERATION on the second call, and is exactly ' +
        'what `PixelTrail` shipped while every test in this directory was ' +
        'green. Add it to WEBGL_EFFECTS if it is a card effect, or to ' +
        'NON_CATALOG_FIBER_EFFECTS if it is not',
    ).toEqual([])
  })
})
