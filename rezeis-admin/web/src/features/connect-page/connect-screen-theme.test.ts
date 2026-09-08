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
const LENGTH_TOKENS = ['radius-card', 'radius-item', 'radius-pill', 'glass-blur']

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

describe('what the mapping is for', () => {
  it('keeps the raised and sunken surfaces apart', () => {
    // The concepts fill the workspace and the tiles with one colour and the
    // chips, buttons and step timeline with a darker one. Collapsing those into
    // a single surface is what makes the timeline read as a hole punched in the
    // card it sits inside — the exact flatness this redesign was reported for.
    const same: string[] = []
    for (const preset of CONCEPT_PRESETS) {
      const theme = buildConnectScreenTheme(preset.id)
      if (theme === null) continue
      if (theme.tokens['color-surface'] === theme.tokens['color-surface-high']) {
        same.push(preset.id)
      }
    }
    expect(same.slice(0, 10)).toEqual([])
  })

  it('carries the radius the concept was drawn with, not a fixed one', () => {
    const radii = new Set(
      CONCEPT_PRESETS.map((preset) => buildConnectScreenTheme(preset.id)?.tokens['radius-card']),
    )
    // A single value across 104 concepts would mean the radius is not travelling
    // at all, which is half of what separates a concept from a palette.
    expect(radii.size).toBeGreaterThan(1)
  })

  it('answers null for a concept that no longer exists', () => {
    // A retired id reaches this from a stored row. It has to degrade to "the
    // cabinet's own appearance", not take the editor down.
    expect(buildConnectScreenTheme('concept-that-was-retired')).toBeNull()
  })
})
