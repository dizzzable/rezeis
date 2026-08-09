/**
 * The background registry, checked against the components it claims to drive.
 *
 * `BACKGROUND_REGISTRY` is prose about other files. Three of its claims are
 * unfalsifiable by anything else in this tree, and all three fail SILENTLY:
 *
 *  1. "this control drives this prop" — the background is rendered as
 *     `<BgComponent {...props} />` over a `Record<string, unknown>`, so a
 *     control naming a prop the component does not have type-checks, renders,
 *     persists, and syncs across devices while changing nothing on screen. That
 *     is the defect the whole registry exists to avoid, and until this file
 *     there was nothing between it and an operator.
 *  2. "this background needs WebGL2 / needs no GPU at all" — a classification
 *     nobody can check by looking at the registry.
 *  3. "this slider does not reach the value that stops the picture" — true of
 *     some sliders by name (`speed`, `spin`) and of others only by what the
 *     shader does with them.
 *
 * So each claim is re-derived here FROM THE COMPONENT SOURCE, which is the
 * thing that is actually true. The component files are located through
 * `BG_LOADERS` rather than a second hand-kept map: the registry, the loaders
 * and the id union are already required to agree, and a list here would be a
 * fourth place to forget.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { BG_LOADERS } from '@/components/glass/backgrounds'
import { en as appearanceEn } from '@/i18n/features/appearance.en'
import { ru as appearanceRu } from '@/i18n/features/appearance.ru'

import {
  BACKGROUND_REGISTRY,
  ZERO_FLOOR_REASONS,
  type BackgroundDef,
  type BackgroundRenderer,
  type ControlDef,
} from './background-controls'

// ── Locating each background's component ─────────────────────────────────────

const REACTBITS_DIR = join(__dirname, '..', '..', 'components', 'reactbits')

/**
 * Pull the module path out of a loader's source.
 *
 * `BG_LOADERS.silk.toString()` is `() =>
 * __vite_ssr_dynamic_import__("/src/components/reactbits/Silk.tsx")` under
 * vitest's transform. Only the BASENAME is used — the directory is resolved
 * from `__dirname` — so this survives any change to how the transform spells
 * the path, and if it ever stops matching at all, `resolves a component file
 * for every background` below goes red rather than quietly checking nothing.
 */
const LOADER_MODULE = /reactbits\/([A-Za-z0-9_-]+)(?:\.tsx?)?["')]/

function componentFileFor(id: string): string | null {
  const loader = BG_LOADERS[id as keyof typeof BG_LOADERS]
  if (!loader) return null
  const match = LOADER_MODULE.exec(loader.toString())
  return match ? `${match[1]}.tsx` : null
}

const sourceCache = new Map<string, string>()

function componentSource(file: string): string {
  const cached = sourceCache.get(file)
  if (cached !== undefined) return cached
  const text = readFileSync(join(REACTBITS_DIR, file), 'utf8')
  sourceCache.set(file, text)
  return text
}

// ── Reading a component's own props type ─────────────────────────────────────

/**
 * The props an operator can actually reach: the top-level keys of
 * `interface <Name>Props`, `type <Name>Props = {…}`, or the bare `Props` some
 * of these components use (`RippleGrid`, `LaserFlow`).
 *
 * Nested keys are excluded by brace depth, so `offset?: { x?: number }` does
 * not quietly legitimise a control named `x`.
 */
function declaredProps(source: string, componentName: string): ReadonlySet<string> {
  const declaration = new RegExp(
    String.raw`(?:export\s+)?(?:interface|type)\s+(?:${componentName}Props|Props)\b[^{}]*\{`,
  )
  const match = declaration.exec(source)
  if (!match) return new Set()

  const bodyStart = match.index + match[0].length
  let depth = 1
  let end = bodyStart
  while (end < source.length && depth > 0) {
    const ch = source[end]
    if (ch === '{') depth += 1
    else if (ch === '}') depth -= 1
    end += 1
  }

  const props = new Set<string>()
  let nesting = 0
  for (const line of source.slice(bodyStart, end - 1).split('\n')) {
    const key = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(line)
    if (nesting === 0 && key) props.add(key[1])
    for (const ch of line) {
      if (ch === '{' || ch === '(' || ch === '[') nesting += 1
      else if (ch === '}' || ch === ')' || ch === ']') nesting -= 1
    }
  }
  return props
}

// ── Re-deriving the renderer tier ────────────────────────────────────────────

/**
 * What the component actually opens, in the order that decides it.
 *
 * `three` first: r184 asks for a `webgl2` context and throws from the
 * constructor when it cannot get one, so a three-backed component is WebGL2
 * whatever else it also does — PixelBlast draws its touch texture on a 2D
 * canvas and is still a WebGL2 background. Then the GLSL ES 3.00 directive,
 * which is a hard WebGL2 requirement no matter which library submits it. Only
 * then WebGL1, and last the components that open no GL context at all.
 */
function deriveRenderer(source: string): BackgroundRenderer | null {
  if (/from ['"]three['"]|@react-three\/fiber/.test(source)) return 'webgl2'
  if (source.includes('#version 300 es')) return 'webgl2'
  if (/from ['"]ogl['"]/.test(source) || /getContext\(\s*['"]webgl/.test(source)) return 'webgl1'
  if (/getContext\(\s*['"]2d['"]/.test(source)) return 'canvas2d'
  return null
}

// ── Shared fixtures ──────────────────────────────────────────────────────────

interface Resolved {
  readonly def: BackgroundDef
  readonly file: string | null
}

const resolved: readonly Resolved[] = BACKGROUND_REGISTRY.map((def) => ({
  def,
  file: componentFileFor(def.id),
}))

const sliders: readonly { id: string; control: ControlDef }[] = BACKGROUND_REGISTRY.flatMap(
  (def) =>
    def.controls
      .filter((control) => control.type === 'slider')
      .map((control) => ({ id: `${def.id}.${control.prop}`, control })),
)

type Dict = Record<string, unknown>

function glassDict(bundle: unknown, section: 'backgrounds' | 'controls'): Dict {
  const settings = ((bundle as Dict).glassSettings ?? {}) as Dict
  return (settings[section] ?? {}) as Dict
}

// ── The registry describes real components ───────────────────────────────────

describe('every background points at a component', () => {
  it('resolves a component file for every background', () => {
    // The anchor for everything below: if the loader-source trick ever stops
    // working, every other test in this file would pass while reading nothing.
    expect(resolved.filter((entry) => entry.file === null).map((entry) => entry.def.id)).toEqual([])
    expect(resolved.length).toBeGreaterThan(30)
  })

  it('finds a props type in each of them', () => {
    const empty = resolved
      .filter((entry) => entry.file !== null)
      .filter((entry) => declaredProps(componentSource(entry.file!), entry.file!.replace(/\.tsx?$/, '')).size === 0)
      .map((entry) => entry.def.id)

    expect(empty, 'a component whose props could not be read would accept any control name').toEqual([])
  })
})

describe('every control names a prop the component has', () => {
  it('finds no control naming something the component does not accept', () => {
    const dead: string[] = []

    for (const { def, file } of resolved) {
      if (file === null) continue
      const props = declaredProps(componentSource(file), file.replace(/\.tsx?$/, ''))
      for (const control of def.controls) {
        if (!props.has(control.prop)) {
          dead.push(`${def.id}.${control.prop} (not a prop of ${file})`)
        }
      }
    }

    expect(
      dead,
      'a control naming a prop the component does not have is a slider that moves and changes nothing',
    ).toEqual([])
  })

  it('checks enough controls for that to mean something', () => {
    expect(BACKGROUND_REGISTRY.flatMap((def) => def.controls).length).toBeGreaterThan(150)
  })
})

describe('the renderer tier each entry declares', () => {
  it('matches what the component actually opens', () => {
    const wrong: string[] = []

    for (const { def, file } of resolved) {
      if (file === null) continue
      const derived = deriveRenderer(componentSource(file))
      if (derived === null) {
        wrong.push(`${def.id}: ${file} matches no known renderer`)
      } else if (derived !== def.renderer) {
        wrong.push(`${def.id}: declared ${def.renderer}, ${file} is ${derived}`)
      }
    }

    expect(wrong).toEqual([])
  })

  it('still has canvas2d backgrounds, and they open no GL context', () => {
    // Filing a canvas background as WebGL costs it exactly the devices it was
    // chosen for. The reverse — a shader filed as canvas2d — would promise a
    // context slot it does take.
    const canvas = resolved.filter((entry) => entry.def.renderer === 'canvas2d')
    expect(canvas.length).toBeGreaterThan(0)

    for (const entry of canvas) {
      const source = componentSource(entry.file!)
      expect(/from ['"](?:three|ogl)['"]/.test(source), `${entry.def.id} imports a GL library`).toBe(false)
      expect(/getContext\(\s*['"]2d['"]/.test(source), `${entry.def.id} never opens a 2D context`).toBe(true)
    }
  })
})

// ── The zero end of a slider ─────────────────────────────────────────────────

/**
 * Same narrow rule as the card catalogue's: the PROP name, not the label.
 * Amplitude-style props reach zero legitimately — zero amplitude is a picture,
 * not a stopped one.
 *
 * Matched per camelCase SEGMENT rather than as a substring of the whole name,
 * which the card-effect version does. `wispIntensity` contains the letters
 * "spin" — wi-SPIN-tensity — and a substring rule therefore demands a floor on
 * a slider whose zero end is simply "no wisps", i.e. a picture. Anchoring to
 * segment starts keeps `flowSpeed`, `spinRotation`, `waveSpeedX` and `speed1`
 * in and leaves that one out.
 */
const RATE_SEGMENT = /^(?:speed|spin)/i

function isRateProp(prop: string): boolean {
  return prop.split(/(?=[A-Z])/).some((segment) => RATE_SEGMENT.test(segment))
}

describe('background motion sliders', () => {
  const rateSliders = sliders.filter((slider) => isRateProp(slider.id.split('.')[1]))

  it('finds them, so a rename cannot empty this file silently', () => {
    expect(rateSliders.length).toBeGreaterThan(20)
    expect(sliders.length).toBeGreaterThan(100)
  })

  it('lets none of them reach zero', () => {
    // Every one of these multiplies elapsed time and nothing else moves, so
    // zero does not pause the background — it freezes the image while the rAF
    // loop keeps redrawing it at full cost. `spinRotation`-style signed sliders
    // are not caught by `min === 0`, and should not be: their zero is an angle.
    expect(rateSliders.filter((slider) => slider.control.min === 0).map((s) => s.id)).toEqual([])
  })
})

describe('the sliders whose zero end stops the picture', () => {
  it('names only sliders that exist', () => {
    const known = new Set(sliders.map((slider) => slider.id))
    expect(Object.keys(ZERO_FLOOR_REASONS).filter((id) => !known.has(id))).toEqual([])
  })

  it('holds every one of them above zero', () => {
    const byId = new Map(sliders.map((slider) => [slider.id, slider.control]))
    const reachesZero = Object.keys(ZERO_FLOOR_REASONS).filter((id) => (byId.get(id)?.min ?? 0) <= 0)

    expect(reachesZero).toEqual([])
  })

  it('gives every entry a reason quoting the component', () => {
    // A reason is a claim about the component. Paraphrase rots; a quoted line
    // can be checked against the file it names.
    const weak = Object.entries(ZERO_FLOOR_REASONS)
      .filter(([, reason]) => reason.trim().length < 40 || !reason.includes('`'))
      .map(([id]) => id)

    expect(weak).toEqual([])
  })

  it('covers the ones no name rule would catch', () => {
    // Spelled out rather than derived: `timeScale` is a clock that is not
    // called speed, `ringCount`/`opacity`/`particleSize`/`count` draw nothing
    // at zero, and the two `Sizing` props are divisors. Deleting one of these
    // from the list and from its floor in the same edit — which the two tests
    // above would both accept — has to stay a deliberate act.
    for (const id of [
      'faultyTerminal.timeScale',
      'magicRings.ringCount',
      'magicRings.opacity',
      'laserFlow.decay',
      'laserFlow.falloffStart',
      'laserFlow.verticalSizing',
      'laserFlow.horizontalSizing',
      'antigravity.particleSize',
      'antigravity.count',
    ] as const) {
      expect(ZERO_FLOOR_REASONS[id], `${id} is not in ZERO_FLOOR_REASONS`).toBeTruthy()
    }
  })
})

// ── Control shapes the studio can actually render ────────────────────────────

describe('control defaults the studio can render', () => {
  it('gives every colour control a six-digit hex', () => {
    // `ColorControl` tests `/^#[0-9a-fA-F]{6}$/` and falls back to the default
    // when the value fails — so a three-digit default (`#999`, which is what
    // ShapeGrid's component writes) renders an empty swatch and an operator
    // cannot tell the picker from a broken one.
    const bad: string[] = []
    for (const def of BACKGROUND_REGISTRY) {
      for (const control of def.controls) {
        if (control.type === 'color' && !/^#[0-9a-fA-F]{6}$/.test(String(control.default))) {
          bad.push(`${def.id}.${control.prop} = ${String(control.default)}`)
        }
        if (control.type === 'colorArray') {
          const colors = control.default as unknown
          if (!Array.isArray(colors) || colors.length !== control.count) {
            bad.push(`${def.id}.${control.prop}: needs ${control.count} colours`)
          } else if (colors.some((c) => !/^#[0-9a-fA-F]{6}$/.test(String(c)))) {
            bad.push(`${def.id}.${control.prop}: not all six-digit hex`)
          }
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('offers no select, which this card renders untranslated', () => {
    // `SelectControl` prints the raw option value. Until the studio gets the
    // option-label layer the card-effect section has, an enum control ships
    // English into a Russian panel.
    expect(
      BACKGROUND_REGISTRY.flatMap((def) =>
        def.controls.filter((c) => c.type === 'select' || c.type === 'text').map((c) => `${def.id}.${c.prop}`),
      ),
    ).toEqual([])
  })

  it('keeps every default inside its own slider range', () => {
    const outside = sliders
      .filter(({ control }) => {
        const value = control.default as number
        return (
          typeof value !== 'number' ||
          (control.min !== undefined && value < control.min) ||
          (control.max !== undefined && value > control.max)
        )
      })
      .map(({ id }) => id)

    expect(outside).toEqual([])
  })
})

// ── Both locales ─────────────────────────────────────────────────────────────

describe('background labels', () => {
  it('labels every background id in both locales', () => {
    // `glass-settings-card` renders each option as
    // `t('glassSettings.backgrounds.<id>', { defaultValue: bg.name })`. The
    // `defaultValue` is why a missing key does not crash — and why it needs a
    // test: an operator would just see the fallback, with nothing reporting it.
    const en = glassDict(appearanceEn, 'backgrounds')
    const ru = glassDict(appearanceRu, 'backgrounds')

    for (const def of BACKGROUND_REGISTRY) {
      expect(typeof en[def.id], `missing en label for ${def.id}`).toBe('string')
      expect(typeof ru[def.id], `missing ru label for ${def.id}`).toBe('string')
    }
    // `none` is not in the registry but the selector renders it too.
    expect(typeof en.none).toBe('string')
    expect(typeof ru.none).toBe('string')
  })

  it('carries no label for a background that was removed', () => {
    const known = new Set<string>([...BACKGROUND_REGISTRY.map((def) => def.id), 'none'])
    for (const [locale, bundle] of [['en', appearanceEn], ['ru', appearanceRu]] as const) {
      for (const key of Object.keys(glassDict(bundle, 'backgrounds'))) {
        expect(known, `stale ${locale} label for ${key}`).toContain(key)
      }
    }
  })
})

describe('control labels', () => {
  const props = new Map<string, string>()
  for (const def of BACKGROUND_REGISTRY) {
    for (const control of def.controls) props.set(control.prop, control.label)
  }

  it('labels every control prop in both locales', () => {
    const en = glassDict(appearanceEn, 'controls')
    const ru = glassDict(appearanceRu, 'controls')
    const missing: string[] = []

    for (const prop of props.keys()) {
      if (typeof en[prop] !== 'string') missing.push(`en.${prop}`)
      if (typeof ru[prop] !== 'string') missing.push(`ru.${prop}`)
    }

    // Reported as one list rather than one failure: a bare `toBe('string')`
    // per prop stops at the first gap, and the first gap is never the only one.
    expect(missing).toEqual([])
  })

  it('matches the English label the registry states', () => {
    // The label key is the PROP NAME with no per-background scoping, so two
    // backgrounds sharing a prop share one word. Where the registry and the
    // dictionary disagree the dictionary wins silently, and the entry becomes a
    // description of something the operator never sees.
    const en = glassDict(appearanceEn, 'controls')
    const wrong: string[] = []
    for (const [prop, label] of props) {
      if (typeof en[prop] === 'string' && en[prop] !== label) {
        wrong.push(`${prop}: dictionary "${String(en[prop])}" != registry "${label}"`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('translates them rather than echoing the English', () => {
    const en = glassDict(appearanceEn, 'controls')
    const ru = glassDict(appearanceRu, 'controls')
    const untranslated = [...props.keys()].filter(
      (prop) => typeof ru[prop] === 'string' && ru[prop] === en[prop],
    )
    expect(untranslated).toEqual([])
  })
})
