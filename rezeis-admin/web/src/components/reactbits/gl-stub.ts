/**
 * A WebGL/2D canvas stub with the parts of the real lifecycle that the
 * context-ownership defect turns on.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT EXISTS. jsdom has no canvas backend at all: `getContext` returns null
 * for every kind, so none of these components gets past its first line. The
 * obvious fix — hand each `getContext` call a fresh happy-path object — is the
 * one that must NOT be used, and `Lightning.context-ownership.test.tsx` says
 * why: under that stub every setup gets a pristine context no matter what the
 * previous one did to it, so a component that renders a permanently dead canvas
 * passes just as happily as one that works.
 *
 * So this reproduces the platform contract that makes the defect observable,
 * exactly as that file's hand-written `FakeGl` does:
 *
 *   • one context per CANVAS ELEMENT, handed back by every later `getContext`;
 *   • a lost context stays lost and keeps being handed back;
 *   • `isContextLost()` reports it;
 *   • `createShader`/`createProgram`/`createBuffer`/`createTexture` return null
 *     on a lost context, which is how the failure stays SILENT rather than
 *     thrown — the caller gets null and bails.
 *
 * WHY IT IS A PROXY AND NOT A HAND-WRITTEN CLASS. `Lightning.tsx` drives raw
 * WebGL and touches perhaps thirty entry points, which is worth writing out.
 * The twelve components here go through `ogl` and `three.js`, and three's
 * renderer alone probes several hundred — extensions, precision formats,
 * parameters, capabilities — during construction. Enumerating them would be a
 * transcription exercise whose failure mode is a stub that quietly stops
 * modelling the thing under test. The Proxy answers the long tail with inert
 * defaults and keeps hand-written behaviour for the handful of calls that
 * actually carry meaning here: context loss, and the create/link/compile
 * results that a lost context changes.
 *
 * WHAT CANNOT BE ASSERTED WITH IT, stated so it is not assumed. That a real
 * driver frees a context slot on `WEBGL_lose_context`, and that a real canvas
 * hands back a lost context rather than a fresh one, are the platform's
 * contract — modelled here, not observed. Nothing about the PICTURE is
 * observable either: no fragment is ever shaded, so these tests pin ownership,
 * lifetime, allocation counts and the numbers reaching the GL boundary, and say
 * nothing about what the effect looks like.
 */

import { vi } from 'vitest'

/**
 * Every GL enum is a distinct integer, and the name is recoverable from it —
 * which is what lets `getParameter`/`getProgramParameter` answer by NAME
 * instead of by a hardcoded numeric table that would have to match a real
 * driver's.
 */
const enumValues = new Map<string, number>()
const enumNames = new Map<number, string>()
let nextEnum = 0x1000

function glEnum(name: string): number {
  let value = enumValues.get(name)
  if (value === undefined) {
    value = nextEnum++
    enumValues.set(name, value)
    enumNames.set(value, name)
  }
  return value
}

/** Answers for `getParameter`, keyed by the enum's name. */
const PARAMETERS: Record<string, unknown> = {
  VERSION: 'WebGL 2.0 (stub)',
  SHADING_LANGUAGE_VERSION: 'WebGL GLSL ES 3.00 (stub)',
  VENDOR: 'rezeis-test',
  RENDERER: 'rezeis-test',
  MAX_TEXTURE_SIZE: 16384,
  MAX_CUBE_MAP_TEXTURE_SIZE: 16384,
  MAX_RENDERBUFFER_SIZE: 16384,
  MAX_ARRAY_TEXTURE_LAYERS: 2048,
  MAX_3D_TEXTURE_SIZE: 2048,
  MAX_TEXTURE_IMAGE_UNITS: 32,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 32,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 32,
  MAX_VERTEX_ATTRIBS: 32,
  MAX_VERTEX_UNIFORM_VECTORS: 4096,
  MAX_FRAGMENT_UNIFORM_VECTORS: 4096,
  MAX_VARYING_VECTORS: 32,
  MAX_SAMPLES: 4,
  MAX_DRAW_BUFFERS: 8,
  MAX_COLOR_ATTACHMENTS: 8,
  MAX_ELEMENT_INDEX: 0xffffffff,
  MAX_TEXTURE_MAX_ANISOTROPY_EXT: 16,
  SAMPLES: 0,
  RED_BITS: 8,
  GREEN_BITS: 8,
  BLUE_BITS: 8,
  ALPHA_BITS: 8,
  DEPTH_BITS: 24,
  STENCIL_BITS: 8,
  SUBPIXEL_BITS: 4,
  UNPACK_ALIGNMENT: 4,
  PACK_ALIGNMENT: 4,
}

/**
 * Zero active uniforms and zero active attributes: both `ogl` and `three` walk
 * those counts to build their location maps, and zero means the walk is a
 * no-op rather than a source of fabricated locations.
 */
const PROGRAM_PARAMETERS: Record<string, unknown> = {
  LINK_STATUS: true,
  VALIDATE_STATUS: true,
  ACTIVE_UNIFORMS: 0,
  ACTIVE_ATTRIBUTES: 0,
  ACTIVE_UNIFORM_BLOCKS: 0,
  DELETE_STATUS: false,
}

/** A GL object handle. Distinct per creation so counts are observable. */
interface GlHandle {
  readonly kind: string
  readonly id: number
}

export interface StubWebGLContext {
  /** Once true, never false again — the whole point. */
  lost: boolean
  /** How many times this context was handed back to the driver. */
  loseCalls: number
  /** Frames actually drawn (`drawArrays`/`drawElements` on a live context). */
  draws: number
  /** The element this context lives on. */
  readonly canvas: HTMLCanvasElement
  /** Which kind was asked for — `webgl2` or `webgl`. */
  readonly contextKind: string
  isContextLost(): boolean
  getExtension(name: string): unknown
  [key: string]: unknown
}

let nextHandleId = 1

function createContext(canvas: HTMLCanvasElement, contextKind: string): StubWebGLContext {
  const state = {
    lost: false,
    loseCalls: 0,
    draws: 0,
    canvas,
    contextKind,
    drawingBufferWidth: 1,
    drawingBufferHeight: 1,
  }

  const handle = (kind: string): GlHandle | null =>
    state.lost ? null : { kind, id: nextHandleId++ }

  const own: Record<string, unknown> = {
    isContextLost: () => state.lost,

    // A lost context creates nothing. This is the exact mechanism by which the
    // ownership defect is silent: the caller gets null and returns early.
    createShader: () => handle('shader'),
    createProgram: () => handle('program'),
    createBuffer: () => handle('buffer'),
    createTexture: () => handle('texture'),
    createFramebuffer: () => handle('framebuffer'),
    createRenderbuffer: () => handle('renderbuffer'),
    createVertexArray: () => handle('vao'),
    createQuery: () => handle('query'),
    createSampler: () => handle('sampler'),

    getShaderParameter: (_shader: unknown, pname: number) =>
      enumNames.get(pname) === 'COMPILE_STATUS' ? !state.lost : 0,
    getProgramParameter: (_program: unknown, pname: number) => {
      const name = enumNames.get(pname) ?? ''
      if (name === 'LINK_STATUS' || name === 'VALIDATE_STATUS') return !state.lost
      return PROGRAM_PARAMETERS[name] ?? 0
    },
    // Null, not '' — a lost context has no diagnostic to give, which is why a
    // real failure here prints nothing useful.
    getShaderInfoLog: () => (state.lost ? null : ''),
    getProgramInfoLog: () => (state.lost ? null : ''),
    getActiveUniform: () => null,
    getActiveAttrib: () => null,
    getAttribLocation: () => 0,
    getUniformLocation: (_program: unknown, name: string) => ({ name }),
    getUniformBlockIndex: () => 0,

    getParameter: (pname: number) => {
      const name = enumNames.get(pname) ?? ''
      if (name in PARAMETERS) return PARAMETERS[name]
      if (name === 'VIEWPORT' || name === 'SCISSOR_BOX') return new Int32Array([0, 0, 1, 1])
      if (name === 'MAX_VIEWPORT_DIMS') return new Int32Array([16384, 16384])
      if (name === 'COMPRESSED_TEXTURE_FORMATS') return new Int32Array([])
      return 0
    },
    getShaderPrecisionFormat: () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }),
    getContextAttributes: () => ({
      alpha: true,
      antialias: false,
      depth: true,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'default',
      failIfMajorPerformanceCaveat: false,
    }),
    getSupportedExtensions: () => ['WEBGL_lose_context'],
    getError: () => 0,

    getExtension: (name: string) => {
      if (name !== 'WEBGL_lose_context') return null
      return {
        loseContext: () => {
          state.loseCalls++
          state.lost = true
        },
        restoreContext: () => {
          state.lost = false
        },
      }
    },

    drawArrays: () => {
      if (!state.lost) state.draws++
    },
    drawElements: () => {
      if (!state.lost) state.draws++
    },
    drawArraysInstanced: () => {
      if (!state.lost) state.draws++
    },
    drawElementsInstanced: () => {
      if (!state.lost) state.draws++
    },

    viewport: (_x: number, _y: number, width: number, height: number) => {
      state.drawingBufferWidth = width
      state.drawingBufferHeight = height
    },
  }

  // `canvas.width/height` are the truth about the drawing buffer, and both
  // libraries write them through `setSize`, so reading them here rather than
  // caching a number is what makes the device-pixel budget observable.
  Object.defineProperty(own, 'drawingBufferWidth', {
    get: () => canvas.width,
    enumerable: true,
  })
  Object.defineProperty(own, 'drawingBufferHeight', {
    get: () => canvas.height,
    enumerable: true,
  })

  const extras: Record<string, unknown> = {}

  return new Proxy(own as unknown as StubWebGLContext, {
    get(target, property, receiver) {
      if (typeof property !== 'string') return Reflect.get(target, property, receiver)
      if (property in target) return Reflect.get(target, property, receiver)
      if (property in extras) return extras[property]
      if (property in state) return state[property as keyof typeof state]
      // `MAX_TEXTURE_SIZE`, `TRIANGLES`, `COMPILE_STATUS`, … — every GL enum.
      if (/^[A-Z][A-Z0-9_]*$/.test(property)) return glEnum(property)
      // Everything else is a command with no return value worth modelling.
      const noop = () => undefined
      extras[property] = noop
      return noop
    },
    set(target, property, value, receiver) {
      // `ogl` writes `gl.renderer = this` onto the context object.
      if (typeof property === 'string' && !(property in target)) {
        extras[property] = value
        return true
      }
      return Reflect.set(target, property, value, receiver)
    },
    has(target, property) {
      return (
        Reflect.has(target, property) ||
        (typeof property === 'string' && (property in extras || property in state))
      )
    },
  })
}

/** A 2D context. Records nothing but the calls the tests actually read. */
export interface Stub2DContext {
  readonly canvas: HTMLCanvasElement
  /** Every colour assigned to `fillStyle`, in order. */
  readonly fillStyles: string[]
  /** Every glyph drawn, in order — the alphabet under test. */
  readonly filledText: string[]
  /** Every colour handed to `addColorStop`, on any gradient, in order. */
  readonly gradientStops: string[]
  /** `[a, d]` of the last `setTransform`: the device-pixel budget's ratio. */
  transform: [number, number]
  clears: number
  [key: string]: unknown
}

function create2DContext(canvas: HTMLCanvasElement): Stub2DContext {
  const fillStyles: string[] = []
  const filledText: string[] = []
  const gradientStops: string[] = []
  const gradient = {
    addColorStop: (_offset: number, color: string) => {
      gradientStops.push(color)
    },
  }
  const own: Record<string, unknown> = {
    canvas,
    fillStyles,
    filledText,
    gradientStops,
    transform: [1, 1] as [number, number],
    clears: 0,
    font: '',
    textBaseline: '',
    globalAlpha: 1,
    lineWidth: 1,
    strokeStyle: '#000',
    setTransform(a: number, _b: number, _c: number, d: number) {
      ;(own.transform as [number, number]) = [a, d]
    },
    clearRect() {
      ;(own.clears as number)++
    },
    fillText(text: string) {
      filledText.push(text)
    },
    createRadialGradient() {
      return gradient
    },
    createLinearGradient() {
      return gradient
    },
    measureText() {
      return { width: 10 }
    },
  }

  let fillStyle: unknown = '#000'
  Object.defineProperty(own, 'fillStyle', {
    get: () => fillStyle,
    set: (value: unknown) => {
      fillStyle = value
      if (typeof value === 'string') fillStyles.push(value)
    },
    enumerable: true,
  })

  const extras: Record<string, unknown> = {}
  return new Proxy(own as unknown as Stub2DContext, {
    get(target, property, receiver) {
      if (typeof property !== 'string') return Reflect.get(target, property, receiver)
      if (property in target) return Reflect.get(target, property, receiver)
      if (property in extras) return extras[property]
      const noop = () => undefined
      extras[property] = noop
      return noop
    },
    set(target, property, value, receiver) {
      if (typeof property === 'string' && !(property in target)) {
        extras[property] = value
        return true
      }
      return Reflect.set(target, property, value, receiver)
    },
  })
}

/**
 * A recording IntersectionObserver.
 *
 * `src/test/setup-tests.ts` already installs one, but it is inert in both
 * directions: it records nothing and can never be made to fire, so under it a
 * component that observes NOTHING is indistinguishable from one that observes
 * correctly — which is exactly how `PixelBlast` shipped a `visibilityRef` that
 * was read by its render loop and written by nothing at all.
 *
 * This one is inert BY DEFAULT for the same reason (an observer that fired on
 * `observe` would change every other test in the file), but it remembers what
 * it was asked to watch, so a test can both prove the observer exists and drive
 * it. Nothing here modifies the shared setup file.
 */
interface RecordedObserver {
  readonly targets: Element[]
  readonly callback: IntersectionObserverCallback
  readonly instance: IntersectionObserver
  disconnected: boolean
}

export interface GlStubHarness {
  /** Every IntersectionObserver constructed while the stub was installed. */
  readonly intersectionObservers: RecordedObserver[]
  /**
   * Deliver an intersection change for `target` to every live observer
   * watching it. Returns how many observers were notified — zero means nothing
   * is watching, which is the defect, not a passing test.
   */
  setIntersecting(target: Element, isIntersecting: boolean): number
  /** Every WebGL context ever created, in creation order. */
  readonly contexts: StubWebGLContext[]
  /** Every 2D context ever created, in creation order. */
  readonly contexts2d: Stub2DContext[]
  /** The still-live subset — the number WebKit's 16-slot ceiling counts. */
  liveContexts(): StubWebGLContext[]
  /** The context backing a given canvas, if it has one. */
  contextOf(canvas: HTMLCanvasElement): StubWebGLContext | undefined
  /** The context backing the canvas the operator is actually looking at. */
  presentedContext(root?: ParentNode): StubWebGLContext | undefined
  /** Run every queued frame once, advancing the clock by `stepMs` each time. */
  runFrames(count: number, stepMs?: number): void
  /** How many frames are queued right now. */
  pendingFrames(): number
  /** Move the clock without running anything. */
  advanceClock(ms: number): void
  /**
   * Drive a real context-loss round trip on a canvas. Returns the dispatched
   * event so the caller can read `defaultPrevented` — without
   * `preventDefault()` a browser never fires `webglcontextrestored` and a
   * recoverable loss becomes permanent.
   */
  loseContext(canvas: HTMLCanvasElement): Event
  restoreContext(canvas: HTMLCanvasElement): void
  /** Tear the stub down. Call from `afterEach`. */
  teardown(): void
}

export interface GlStubOptions {
  /**
   * The CSS box every element reports. jsdom lays everything out at 0×0, and a
   * component that measures zero never allocates a buffer worth asserting on.
   */
  readonly width?: number
  readonly height?: number
  /** What `window.devicePixelRatio` reports. */
  readonly devicePixelRatio?: number
}

/**
 * Install the stub. Returns the handle the tests read.
 *
 * Sizing is stubbed on BOTH paths a component might measure with —
 * `getBoundingClientRect`, and `clientWidth`/`offsetWidth` — because the twelve
 * components under test are split roughly evenly between them, and a component
 * that measured the one that was left at zero would silently do nothing.
 */
export function installGlStub(options: GlStubOptions = {}): GlStubHarness {
  const width = options.width ?? 1280
  const height = options.height ?? 800
  const devicePixelRatio = options.devicePixelRatio ?? 1

  const contexts: StubWebGLContext[] = []
  const contexts2d: Stub2DContext[] = []
  const contextOf = new WeakMap<HTMLCanvasElement, StubWebGLContext>()
  const context2dOf = new WeakMap<HTMLCanvasElement, Stub2DContext>()

  let pending = new Map<number, FrameRequestCallback>()
  let nextHandle = 0
  let clock = 0

  const intersectionObservers: RecordedObserver[] = []

  class RecordingIntersectionObserver implements IntersectionObserver {
    readonly root = null
    readonly rootMargin = ''
    // Part of the DOM lib's `IntersectionObserver` in this TypeScript version.
    // `src/test/setup-tests.ts`'s mock predates it and escapes the check only
    // because it never declares `implements`.
    readonly scrollMargin = ''
    readonly thresholds: ReadonlyArray<number> = []
    readonly #record: RecordedObserver

    constructor(callback: IntersectionObserverCallback) {
      this.#record = { targets: [], callback, instance: this, disconnected: false }
      intersectionObservers.push(this.#record)
    }
    observe(target: Element): void {
      this.#record.targets.push(target)
    }
    unobserve(target: Element): void {
      const index = this.#record.targets.indexOf(target)
      if (index >= 0) this.#record.targets.splice(index, 1)
    }
    disconnect(): void {
      this.#record.disconnected = true
      this.#record.targets.length = 0
    }
    takeRecords(): IntersectionObserverEntry[] {
      return []
    }
  }

  vi.stubGlobal('IntersectionObserver', RecordingIntersectionObserver)
  vi.stubGlobal('devicePixelRatio', devicePixelRatio)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    nextHandle += 1
    pending.set(nextHandle, callback)
    return nextHandle
  })
  vi.stubGlobal('cancelAnimationFrame', (handleId: number) => {
    pending.delete(handleId)
  })
  // Monotonic, and it only moves when a test says so, so anything integrated
  // from it is a deterministic function of the frames that were run.
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  vi.spyOn(Date, 'now').mockImplementation(() => clock)

  const rect = {
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect as DOMRect)
  for (const property of ['clientWidth', 'offsetWidth'] as const) {
    vi.spyOn(HTMLElement.prototype, property, 'get').mockReturnValue(width)
  }
  for (const property of ['clientHeight', 'offsetHeight'] as const) {
    vi.spyOn(HTMLElement.prototype, property, 'get').mockReturnValue(height)
  }

  // Pin the machine, not just the viewport.
  //
  // `LightPillar` drops from its `high` tier to `medium` when
  // `navigator.hardwareConcurrency <= 4`, and `medium` carries its own
  // `pixelRatio: 0.65`. That is sound product behaviour — a 4-core device
  // should not march 80 steps per fragment — but it makes every assertion about
  // the DEVICE-PIXEL BUDGET depend on the core count of whatever machine ran
  // the suite. It shipped green on a developer workstation and went red on a
  // 2-core CI runner: `expected 286 to be 880`, where 286 is `440 * 0.65` and
  // the budget itself had correctly returned a scale of exactly 1.
  //
  // A budget test must measure the budget. Fixing the core count here keeps the
  // quality tier constant so the only thing that can move a buffer size is
  // `resolveRenderScale`. 8 is chosen to sit above the `<= 4` threshold with
  // room to spare; a component that wants to assert the low-end path should
  // override this locally rather than depend on the host.
  vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(8)

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
    kind: string,
  ) {
    if (kind === '2d') {
      let context = context2dOf.get(this)
      if (!context) {
        context = create2DContext(this)
        context2dOf.set(this, context)
        contexts2d.push(context)
      }
      return context
    }
    if (kind !== 'webgl' && kind !== 'webgl2') return null
    // THE CONTRACT: a canvas has exactly one context for its whole life and
    // returns it to every caller, lost or not. Reaching for a fresh one here is
    // what makes a suite green against a component that presents a dead canvas.
    let context = contextOf.get(this)
    if (!context) {
      context = createContext(this, kind)
      contextOf.set(this, context)
      contexts.push(context)
    }
    return context
  } as never)

  return {
    intersectionObservers,
    setIntersecting(target: Element, isIntersecting: boolean) {
      let notified = 0
      for (const record of intersectionObservers) {
        if (record.disconnected || !record.targets.includes(target)) continue
        notified++
        const entry = {
          target,
          isIntersecting,
          intersectionRatio: isIntersecting ? 1 : 0,
          time: 0,
          boundingClientRect: target.getBoundingClientRect(),
          intersectionRect: target.getBoundingClientRect(),
          rootBounds: null,
        } as unknown as IntersectionObserverEntry
        record.callback([entry], record.instance)
      }
      return notified
    },
    contexts,
    contexts2d,
    liveContexts: () => contexts.filter(context => !context.isContextLost()),
    contextOf: (canvas: HTMLCanvasElement) => contextOf.get(canvas),
    presentedContext(root: ParentNode = document) {
      const canvas = root.querySelector('canvas')
      return canvas ? contextOf.get(canvas) : undefined
    },
    runFrames(count: number, stepMs = 16) {
      for (let i = 0; i < count; i++) {
        clock += stepMs
        const due = [...pending.values()]
        pending.clear()
        for (const callback of due) callback(clock)
      }
    },
    pendingFrames: () => pending.size,
    advanceClock(ms: number) {
      clock += ms
    },
    loseContext(canvas: HTMLCanvasElement) {
      const context = contextOf.get(canvas)
      if (context) {
        context.lost = true
        context.loseCalls++
      }
      // `cancelable`, or `preventDefault()` cannot be observed — and observing
      // it is the point: without it a browser never fires `webglcontextrestored`
      // and a recoverable loss becomes permanent.
      const event = new Event('webglcontextlost', { cancelable: true })
      canvas.dispatchEvent(event)
      return event
    },
    restoreContext(canvas: HTMLCanvasElement) {
      const context = contextOf.get(canvas)
      if (context) context.lost = false
      canvas.dispatchEvent(new Event('webglcontextrestored'))
    },
    teardown() {
      pending = new Map()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    },
  }
}
