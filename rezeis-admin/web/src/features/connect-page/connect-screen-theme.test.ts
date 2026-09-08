import { describe, expect, it } from 'vitest'

import { CONCEPT_PRESETS } from '../../lib/theme/concept-presets'
import { buildConnectScreenTheme } from './connect-screen-theme'

/**
 * EVERY CONCEPT MUST SURVIVE THE TRIP.
 *
 * This is the test that stops the whole feature failing silently. The payload
 * built here is checked twice more before it becomes anything a customer sees —
 * once by `connect-page.theme.ts` on the way into the database, and once by
 * `connect-theme.ts` in the cabinet on the way into a `style` attribute — and
 * BOTH of those refuse what they do not recognise, because both are guarding a
 * CSS injection surface.
 *
 * A refusal there is invisible. The operator picks a concept, the save appears
 * to work, and the screen looks exactly as it did: no error, nothing in a log
 * they read, and a support ticket that says "I picked a theme and nothing
 * happened". One value form the generator emits that the grammar does not know
 * — `oklch()` is the obvious candidate, since the shadcn generator this sits on
 * top of is free to change what it writes — would do that to all 104 at once.
 *
 * So the grammar is restated here rather than imported. It cannot be imported:
 * the server half lives outside this tsconfig and the cabinet half in another
 * repository entirely. Restating it is the cost of a boundary no compiler can
 * see across, and running it over the WHOLE book rather than a sample is what
 * makes it worth paying.
 */

/** Mirrors `COLOR` in connect-page.theme.ts and in the cabinet's connect-theme.ts. */
const COLOR = /^(?:#[\da-f]{3,8}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/deg]+\)|transparent)$/i
const LENGTH = /^\d+(?:\.\d+)?(?:px|rem)$/
const BACKGROUND_ALLOWED_CHARS = /^[\w\s#%.,()+-]*$/
const BACKGROUND_FUNCTIONS = new Set([
  'linear-gradient',
  'radial-gradient',
  'conic-gradient',
  'repeating-linear-gradient',
  'repeating-radial-gradient',
  'repeating-conic-gradient',
  'rgb',
  'rgba',
  'hsl',
  'hsla',
])

const COLOR_TOKENS = [
  'brand-primary',
  'brand-primary-fg',
  'brand-foreground',
  'brand-muted-foreground',
  'color-surface',
  'color-surface-high',
  'color-border-soft',
  'color-border-strong',
]
// No `radius-pill`: the connect screen has two corners, a card and everything
// inside it. `names no token the connect screen does not read` below is what
// keeps this list honest — adding one back here without the screen reading it
// would be an operator setting something that does nothing.
const LENGTH_TOKENS = ['radius-card', 'radius-item', 'glass-blur']

function backgroundProblem(value: string): string | null {
  if (value.trim().length === 0) return 'empty'
  if (value.length > 4_000) return `too long (${value.length})`
  if (!BACKGROUND_ALLOWED_CHARS.test(value)) {
    const bad = [...value].find((character) => !BACKGROUND_ALLOWED_CHARS.test(character))
    return `character ${JSON.stringify(bad)} the guard rejects`
  }
  let depth = 0
  for (const character of value) {
    if (character === '(') depth += 1
    else if (character === ')') depth -= 1
    if (depth < 0) return 'unbalanced parentheses'
  }
  if (depth !== 0) return 'unbalanced parentheses'
  for (const match of value.matchAll(/([a-z][\w-]*)\s*\(/gi)) {
    if (!BACKGROUND_FUNCTIONS.has(match[1].toLowerCase())) return `function ${match[1]}()`
  }
  if (!/gradient\s*\(/i.test(value)) return 'no gradient in it'
  return null
}

describe('the concept book, end to end', () => {
  it('has concepts to test at all', () => {
    // Guards the guard: an empty catalogue would make every loop below pass by
    // iterating nothing, which is the shape of a test that watches nothing.
    expect(CONCEPT_PRESETS.length).toBeGreaterThan(100)
  })

  it('builds a payload for every concept', () => {
    const missing = CONCEPT_PRESETS.filter((preset) => buildConnectScreenTheme(preset.id) === null)
    expect(missing.map((preset) => preset.id)).toEqual([])
  })

  it('emits only colours the two downstream guards accept', () => {
    const rejected: string[] = []
    for (const preset of CONCEPT_PRESETS) {
      const theme = buildConnectScreenTheme(preset.id)
      if (theme === null) continue
      for (const token of COLOR_TOKENS) {
        const value = theme.tokens[token]
        if (value !== undefined && !COLOR.test(value)) {
          rejected.push(`${preset.id}.${token} = ${value}`)
        }
      }
      for (const [label, value] of [
        ['backgroundColor', theme.backgroundColor],
        ['rail', theme.rail],
      ] as const) {
        if (!COLOR.test(value)) rejected.push(`${preset.id}.${label} = ${value}`)
      }
    }
    expect(rejected.slice(0, 10)).toEqual([])
  })

  it('emits only lengths the two downstream guards accept', () => {
    const rejected: string[] = []
    for (const preset of CONCEPT_PRESETS) {
      const theme = buildConnectScreenTheme(preset.id)
      if (theme === null) continue
      for (const token of LENGTH_TOKENS) {
        const value = theme.tokens[token]
        if (value !== undefined && !LENGTH.test(value)) {
          rejected.push(`${preset.id}.${token} = ${value}`)
        }
      }
    }
    expect(rejected.slice(0, 10)).toEqual([])
  })

  it('emits only backgrounds the two downstream guards accept', () => {
    const rejected: string[] = []
    for (const preset of CONCEPT_PRESETS) {
      const theme = buildConnectScreenTheme(preset.id)
      if (theme === null) continue
      const problem = backgroundProblem(theme.backgroundImage)
      if (problem !== null) rejected.push(`${preset.id}: ${problem}`)
    }
    expect(rejected.slice(0, 10)).toEqual([])
  })

  it('names no token the connect screen does not read', () => {
    const known = new Set([...COLOR_TOKENS, ...LENGTH_TOKENS])
    const stray: string[] = []
    for (const preset of CONCEPT_PRESETS) {
      const theme = buildConnectScreenTheme(preset.id)
      if (theme === null) continue
      for (const token of Object.keys(theme.tokens)) {
        if (!known.has(token)) stray.push(`${preset.id}.${token}`)
      }
    }
    expect(stray.slice(0, 10)).toEqual([])
  })
})

/**
 * What a colour LOOKS like once it has been composited over the page.
 *
 * This is the whole point of the cases below. Two surfaces can be spelled
 * differently and render identically — most concepts write their card with
 * alpha, and a translucent near-black over a near-black page is the page.
 */
function channels(hex: string): [number, number, number, number] | null {
  const body = hex.trim().replace('#', '')
  const wide = body.length >= 6
  const size = wide ? 2 : 1
  if (body.length !== (wide ? 6 : 3) && body.length !== (wide ? 8 : 4)) return null
  const read = (i: number): number => {
    const slice = body.slice(i * size, i * size + size)
    return Number.parseInt(wide ? slice : slice + slice, 16)
  }
  const hasAlpha = body.length === (wide ? 8 : 4)
  return [read(0), read(1), read(2), hasAlpha ? read(3) / 255 : 1]
}

function rendered(colour: string, ground: string): [number, number, number] | null {
  const top = channels(colour)
  const under = channels(ground)
  if (top === null || under === null) return null
  return [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])) as [number, number, number]
}

function visibleGap(a: [number, number, number], b: [number, number, number]): number {
  return Math.max(...[0, 1, 2].map((i) => Math.abs(a[i] - b[i])))
}

describe('what the mapping is for', () => {
  /**
   * The floor the derivation actually guarantees, not a round number.
   *
   * It aims for twelve of 255 and settles for three-quarters of that — nine —
   * when a colour has run into the black or white rail and has to come back the
   * other way. A translucent card then costs up to one more unit, because the
   * fill is solved back through its own alpha and the solve rounds. Liquid
   * Glass Frost is the concept that spends all three allowances at once: a
   * near-white card, 95% opaque, on a page whose blue channel is already 255.
   */
  const FLOOR = 8

  it('keeps the raised and sunken surfaces apart AS RENDERED', () => {
    // The concepts fill the workspace and the tiles with one colour and the
    // chips, buttons and step timeline with a darker one. Collapsing those into
    // a single surface is what makes the timeline read as a hole punched in the
    // card it sits inside — the exact flatness this redesign was reported for.
    //
    // This case used to compare the two STRINGS, which is not the question. The
    // strings differed on all 104 concepts and the test passed; what they
    // produced did not — 55 concepts rendered the two surfaces within 3/255 of
    // each other and twelve of them within 1, which is to say identically. A
    // guard that cannot fail on the defect it is named after is not a guard.
    const flat: string[] = []
    for (const preset of CONCEPT_PRESETS) {
      const theme = buildConnectScreenTheme(preset.id)
      if (theme === null) continue
      const high = rendered(theme.tokens['color-surface-high'] ?? '', theme.backgroundColor)
      const low = rendered(theme.tokens['color-surface'] ?? '', theme.backgroundColor)
      if (high === null || low === null) {
        flat.push(`${preset.code}: unreadable surface`)
        continue
      }
      const gap = visibleGap(high, low)
      if (gap < FLOOR) flat.push(`${preset.code} ${preset.name}: ${gap.toFixed(1)}`)
    }
    expect(flat.slice(0, 10)).toEqual([])
  })

  it('keeps the raised surface apart from the page it sits on', () => {
    // The other half of the same defect, and the one that showed on the
    // operator's screenshot: a card that renders as its own background is not a
    // card, it is a rectangle of border.
    const invisible: string[] = []
    for (const preset of CONCEPT_PRESETS) {
      const theme = buildConnectScreenTheme(preset.id)
      if (theme === null) continue
      const high = rendered(theme.tokens['color-surface-high'] ?? '', theme.backgroundColor)
      const page = channels(theme.backgroundColor)
      if (high === null || page === null) continue
      const gap = visibleGap(high, [page[0], page[1], page[2]])
      if (gap < FLOOR) invisible.push(`${preset.code} ${preset.name}: ${gap.toFixed(1)}`)
    }
    expect(invisible.slice(0, 10)).toEqual([])
  })

  it('keeps the glass, rather than paying for the separation with it', () => {
    // The gradient showing through a card is what `glass-dimensional` and
    // `atmospheric` ARE. The separation above is bought by solving the fill
    // back through the alpha, not by making every card opaque — so most of the
    // book still has translucent cards afterwards.
    const translucent = CONCEPT_PRESETS.filter((preset) => {
      const value = buildConnectScreenTheme(preset.id)?.tokens['color-surface-high'] ?? ''
      const parsed = channels(value)
      return parsed !== null && parsed[3] < 1
    })
    expect(translucent.length).toBeGreaterThan(40)
  })

  it('never rounds a control more than the surface it sits in', () => {
    // The generator classifies the card radius and the control radius
    // independently, and disagreed with itself on 35 of the 104 — Mono
    // Moonlight Crater arrived as a 15px card holding 22px chips. Nothing on
    // any artboard does that; it reads as chips that overflowed their card.
    const inverted: string[] = []
    for (const preset of CONCEPT_PRESETS) {
      const theme = buildConnectScreenTheme(preset.id)
      if (theme === null) continue
      const card = Number.parseFloat(theme.tokens['radius-card'] ?? '0')
      const item = Number.parseFloat(theme.tokens['radius-item'] ?? '0')
      if (item > card) inverted.push(`${preset.code}: ${item} > ${card}`)
    }
    expect(inverted).toEqual([])
  })

  it('carries the radius the concept was drawn with, not a fixed one', () => {
    const radii = new Set(
      CONCEPT_PRESETS.map((preset) => buildConnectScreenTheme(preset.id)?.tokens['radius-card']),
    )
    // A single value across 104 concepts would mean the radius is not travelling
    // at all, which is half of what separates a concept from a palette.
    expect(radii.size).toBeGreaterThan(1)
  })

  it('draws the moon Mono Moonlight Crater is named after', () => {
    // The generic reconstruction rationed this concept to one decor layer and
    // spent it on a hashed ellipse in the top LEFT at a tenth of the brightness
    // — while the board's subject, the thing anybody looks at first, is a moon
    // in the top right. An authored decor is not a guess, so it is not rationed.
    const moonlight = CONCEPT_PRESETS.find((preset) => preset.code === 'AE')
    expect(moonlight, 'the concept this case is about is gone').toBeDefined()
    const theme = buildConnectScreenTheme(moonlight!.id)
    const image = theme?.backgroundImage ?? ''

    // Top right, and SIZED. The first version wrote `circle at 82% 3%` with no
    // radius, which takes it from the farthest corner — so the whole thing was
    // spread across the screen at a sixth of white and read as nothing at all.
    // Reported as "луны я так же не вижу", which was correct.
    expect(image).toMatch(/ellipse [\d.]+% [\d.]+% at 8[0-9]% [\d.]+%/)
    expect(image.split('gradient(').length - 1).toBeGreaterThanOrEqual(4)

    // Bright enough to be a light source. The two stacked layers over the
    // page have to clear the ground by a wide margin, or it is a smudge.
    const page = channels(theme!.backgroundColor)!
    const stops = [...image.matchAll(/#F6F7F6([\da-f]{2})/gi)].map(
      (m) => Number.parseInt(m[1], 16) / 255,
    )
    expect(stops.length, 'the moon is not drawn in the concept foreground').toBeGreaterThan(1)
    const peak = 1 - stops.slice(0, 2).reduce((left, alpha) => left * (1 - alpha), 1)
    const lit = 246 * peak + page[0] * (1 - peak)
    expect(lit, 'the moon is too faint to see').toBeGreaterThan(60)

    // …and NOT so bright that the readability rule fires. When it does, the
    // generator prepends a flat scrim over the WHOLE background — a black sheet
    // that dims the moon it was drawn for and every surface measured against
    // the page. At a 0.386 peak it did exactly that.
    expect(image.startsWith('linear-gradient(#'), 'a readability scrim was added').toBe(false)
  })
})

describe('a concept that is no longer in the book', () => {
  it('answers null for a concept that no longer exists', () => {
    // A retired id reaches this from a stored row. It has to degrade to "the
    // cabinet's own appearance", not take the editor down.
    expect(buildConnectScreenTheme('concept-that-was-retired')).toBeNull()
  })
})
