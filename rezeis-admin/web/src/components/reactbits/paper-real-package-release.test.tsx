// @vitest-environment jsdom

/**
 * The six Paper shaders hand their context back — driven through the REAL
 * `@paper-design/shaders-react`.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS ALONGSIDE THE TWO `paper-context-release.test.tsx` FILES.
 * There are already two — `src/features/branding/` here, and `web/test/` in the
 * cabinet — and they pin the SHAPE of `usePaperContextRelease`: that the
 * cleanup is a LAYOUT cleanup, and that it releases the element it captured at
 * mount rather than one it reads back out of a ref React has already cleared.
 * They pin those two halves well, and both name the same blind spot in their
 * headers:
 *
 *   "`@paper-design/shaders-react` is mocked, by a stand-in that forwards the
 *    ref it is given straight to its own <div>. Whether the REAL component
 *    chain forwards a ref to a `PaperShaderElement` at all, and whether that
 *    element carries `paperShaderMount` with a live `canvasElement`, is assumed
 *    here and asserted nowhere. A package upgrade that stopped forwarding refs
 *    would leave every test below green and the release dead."
 *
 * So this file closes it: it mounts the genuine `MeshGradient`/`Warp`/… chain
 * against `gl-stub.ts` and asserts the outcome the operator pays for — the
 * WebGL context is DESTROYED, not merely dereferenced — with nothing between
 * the wrapper and the package.
 *
 * It lives here rather than in the cabinet because this is the tree the effect
 * components are run in: `gl-stub.ts` and every lifecycle, ownership and
 * render-scale suite are here, and the cabinet's own freeze test says the same
 * ("the panel repo is the source, because it is the only tree that can run
 * them"). That is a convention, not a hard limit — the cabinet resolves `ogl`,
 * `three` and this package from `web/node_modules`, so a spec under `web/test/`
 * can drive them; `web/test/aurora-context-release.test.tsx` over there does
 * exactly that for the one effect the freeze deliberately excludes.
 *
 * WHY THE RELEASE IS NOT OPTIONAL. `ShaderMount.dispose()` deletes the program,
 * the textures and the canvas, and never calls
 * `WEBGL_lose_context.loseContext()`. Dropping the reference returns no slot:
 * WebKit frees one only when the context object is destroyed, and it caps a
 * web-content process at 16 before it starts recycling the oldest into an
 * unrecoverable SyntheticLostContext. Six effects come out of one wrapper
 * module, so a carousel used to reach that cap on its own.
 *
 * WHAT IS NOT OBSERVABLE HERE. As everywhere under `gl-stub.ts`: no fragment is
 * shaded, so nothing about the picture is claimed — see that file's header. The
 * cabinet's `paper.tsx` is a separate hand-written file (deliberately, per that
 * repo's house style) and is guarded by the cabinet's own suite; this one
 * guards the panel's copy.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installGlStub, type GlStubHarness } from './gl-stub'
import {
  PaperDither,
  PaperGrain,
  PaperMesh,
  PaperMetaballs,
  PaperSwirl,
  PaperWarp,
} from './paper'

const PAPER_EFFECTS = [
  ['paperDither', PaperDither],
  ['paperGrain', PaperGrain],
  ['paperMesh', PaperMesh],
  ['paperMetaballs', PaperMetaballs],
  ['paperSwirl', PaperSwirl],
  ['paperWarp', PaperWarp],
] as const

let gl: GlStubHarness
const live: Array<{ root: Root; host: HTMLDivElement }> = []

/**
 * The two pieces of BROWSER the package needs and jsdom does not have. Neither
 * touches the thing under test:
 *
 *  • `visualViewport` — read as a BARE global (`visualViewport?.addEventListener`),
 *    so in jsdom it is a ReferenceError rather than the `undefined` the optional
 *    chain expects, and `new ShaderMount` throws before it ever reaches a canvas.
 *  • image loading — several shaders take a noise texture, and `ShaderMount`
 *    refuses an image that is not `complete` with a non-zero `naturalWidth`.
 *    jsdom never loads one. `src` is left alone beyond firing `load`, so no
 *    fetch is attempted.
 */
function installBrowserGaps(): void {
  vi.stubGlobal('visualViewport', {
    width: 1280,
    height: 800,
    scale: 1,
    offsetLeft: 0,
    offsetTop: 0,
    addEventListener: () => {},
    removeEventListener: () => {},
  })
  vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true)
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(2)
  vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(2)
  vi.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation(function (
    this: HTMLImageElement,
  ) {
    queueMicrotask(() => this.dispatchEvent(new Event('load')))
  })
}

beforeEach(() => {
  gl = installGlStub()
  installBrowserGaps()
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
 * `async`, because the package builds its `ShaderMount` from an async effect —
 * it awaits every image uniform first. A synchronous render returns before the
 * canvas, the context or `paperShaderMount` exist.
 */
async function mountInto(host: HTMLDivElement, element: React.ReactElement): Promise<Root> {
  const root = createRoot(host)
  live.push({ root, host })
  await act(async () => {
    root.render(element)
  })
  await act(async () => {
    gl.runFrames(1)
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

describe.each(PAPER_EFFECTS)('%s', (id, Component) => {
  it('opens a real WebGL2 context and destroys it on unmount', async () => {
    const host = makeHost()
    const root = await mountInto(host, <Component />)

    // The premise, and the half the cabinet's mocked suite cannot reach: the
    // package really did build a `ShaderMount`, on a canvas of its own, with a
    // context on it. Every assertion below is vacuous without this.
    const element = host.querySelector('[data-paper-shader]') as
      | (HTMLElement & { paperShaderMount?: { canvasElement?: HTMLCanvasElement } })
      | null
    expect(element, `${id} never mounted a Paper shader element`).not.toBeNull()
    const canvas = element!.paperShaderMount?.canvasElement
    expect(
      canvas,
      `${id}'s element carries no \`paperShaderMount.canvasElement\`. The release ` +
        'hook reaches the context through exactly this property; if the package ' +
        'stops setting it the release silently frees nothing',
    ).toBeInstanceOf(HTMLCanvasElement)

    const context = gl.contextOf(canvas!)
    expect(context, `${id} opened no WebGL context`).toBeDefined()
    expect(context!.isContextLost(), `${id} destroyed its context while mounted`).toBe(false)
    expect(gl.liveContexts().length).toBe(1)

    await unmountRoot(root)
    host.remove()

    expect(
      context!.loseCalls,
      `${id} dropped its context reference without destroying it. \`dispose()\` ` +
        'frees the program, the textures and the canvas and leaves the CONTEXT ' +
        'alive; WebKit returns the slot only when the context object goes, and ' +
        'it caps a web-content process at 16',
    ).toBeGreaterThanOrEqual(1)
    expect(gl.liveContexts(), `${id} left a context alive after unmount`).toEqual([])
  })

  it('does not accumulate contexts over three mount/unmount rounds', async () => {
    const host = makeHost()

    for (const round of [1, 2, 3]) {
      const root = await mountInto(host, <Component />)
      expect(
        gl.liveContexts().length,
        `${id} held ${gl.liveContexts().length} live contexts while mounted on round ${round}`,
      ).toBe(1)

      await unmountRoot(root)

      expect(
        gl.liveContexts().length,
        `${id} left ${gl.liveContexts().length} contexts alive after round ${round}. ` +
          'Six effects share this wrapper, so a leak of one per mount reaches ' +
          'WebKit’s sixteen inside a single carousel',
      ).toBe(0)
    }

    expect(gl.contexts.length, `${id} did not build a shader on every round`).toBe(3)
    host.remove()
  })
})
