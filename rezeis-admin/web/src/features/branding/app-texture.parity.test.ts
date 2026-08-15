/**
 * Parity between the operator's texture preview and the subscriber's cabinet.
 *
 * There are two tile generators — this one, which paints the live preview in
 * the configurator, and `reiwa/web/src/lib/app-texture.ts`, which paints the
 * real background on the subscriber's screen. Neither can import the other:
 * they answer to different builds and different type worlds (the cabinet takes
 * `AppBackgroundTextureSettings` from its own `types/branding`, the panel takes
 * a form draft whose `pattern` is a bare string).
 *
 * They currently agree byte for byte on every input a form can produce. Nothing
 * held that agreement in place — it was two files that happened to still match.
 * The cost of them drifting is specific: the preview stops being a preview. An
 * operator tunes scale and opacity against a picture, saves, and the cabinet
 * paints a different one, with no error anywhere and no way to tell which side
 * is wrong.
 *
 * WHAT THIS FILE CHECKS
 * ---------------------
 *   1. behaviour, over the whole reachable input space: both modules return an
 *      identical `TextureCss` for every pattern at both ends of the scale and
 *      opacity ranges the form allows, several values inside them, every colour
 *      spelling the hex parser accepts plus one it rejects, and pattern ids
 *      neither module knows;
 *   2. vocabulary: the two `switch` statements name the same patterns, so an
 *      id one side draws and the other silently resolves to `dots` cannot slip
 *      through — a mismatch there produces a valid tile of the wrong picture;
 *   3. (offline) the panel's own picker list and its own `switch` agree, and
 *      the matrix really does span the form's ranges.
 *
 * Layers 1 and 2 need the sibling reiwa checkout and skip without it, exactly
 * as `app-background-contrast.parity.test.tsx` and `live-kit-manifest.test.ts`
 * do. CI for this repo has no reiwa working tree; what guards the picture there
 * is the geometry table in `app-texture.test.ts`, which is duplicated verbatim
 * in `reiwa/test/web/app-texture.test.ts` — so a one-sided drift fails in
 * whichever repo's CI it was committed to, and this file catches the rest
 * (encoding, quote escaping, clamping, colour maths) whenever both checkouts
 * are present.
 *
 * Note on what is compared: the FULL output object, string for string. That is
 * deliberately stricter than the geometry table next door, and it is the right
 * granularity here — the two files are meant to be identical, so a difference
 * in whitespace or attribute order between them is itself the drift, even when
 * a browser would not care. Inside one repo the same strictness would be a
 * snapshot that punishes benign edits; across the two it is the contract.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  APP_BG_TEXTURE_PATTERNS,
  buildTextureCss,
  type TextureCss,
} from './app-texture'

// ── the sibling checkout ────────────────────────────────────────────────────

const REIWA_SOURCE = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'reiwa',
  'web',
  'src',
  'lib',
  'app-texture.ts',
)
const PANEL_SOURCE = join(__dirname, 'app-texture.ts')

/**
 * `import.meta.glob` rather than a plain import: a static import of a file
 * outside this repo turns a missing reiwa checkout into a collection error for
 * the whole file, and CI for this repo has no reiwa working tree. A glob that
 * matches nothing is simply an empty object.
 */
const reiwaModules = import.meta.glob('../../../../../../reiwa/web/src/lib/app-texture.ts')
const reiwaEntry = Object.values(reiwaModules)[0]
const hasSibling = existsSync(REIWA_SOURCE) && reiwaEntry !== undefined

/**
 * The shape both sides agree on. The panel types `pattern` as a bare string and
 * the cabinet as a union; the wire format they both read is the same object,
 * and an unknown id is a case both must handle identically.
 */
interface TextureInput {
  readonly pattern: string
  readonly color: string
  readonly background: string
  readonly scale: number
  readonly opacity: number
}

type BuildTexture = (texture: TextureInput) => TextureCss

async function loadCabinetBuilder(): Promise<BuildTexture> {
  const module = (await reiwaEntry!()) as { buildTextureCss: BuildTexture }
  return module.buildTextureCss
}

/** The `case '<id>':` labels of a generator's `switch`, in source order. */
function switchLabels(path: string): string[] {
  const source = readFileSync(path, 'utf8')
  const labels: string[] = []
  const pattern = /case\s+['"]([^'"]+)['"]\s*:/g
  let match = pattern.exec(source)
  while (match !== null) {
    labels.push(match[1])
    match = pattern.exec(source)
  }
  expect(labels.length, `${path} has no \`case\` labels — did patternSvg move?`).toBeGreaterThan(0)
  return labels
}

// ── the input matrix ────────────────────────────────────────────────────────
//
// Not a sample. `branding-form-schema.ts` clamps a saved texture to
// scale ∈ [8, 256] and opacity ∈ [0.05, 1] with a hex colour, so BOTH ends of
// both ranges are here, several values between them, and values outside them —
// because `buildTextureCss` clamps too, and the two clamps must agree even on
// input the form should never have let through.

const SCALES: readonly number[] = [4, 8, 12, 24, 28, 40, 64, 128, 256, 400, 24.6]
const OPACITIES: readonly number[] = [0, 0.05, 0.1, 0.17, 0.5, 0.75, 1, 1.6]
const COLORS: readonly string[] = [
  '#63f0e0',
  '#fff', // shorthand — both sides must expand it the same way
  '#F28A4B', // uppercase
  '#0a0a0a',
  'chartreuse', // rejected by the hex parser: both must fall back to white
]
const BACKGROUNDS: readonly string[] = ['#040b0e', '#f8fafc', '#251225']
/** Ids no `case` covers: the `default` branch has to agree as well. */
const UNKNOWN_PATTERNS: readonly string[] = ['', 'spirograph', 'DOTS', 'noise ']

interface MatrixCase {
  readonly name: string
  readonly input: TextureInput
}

function buildMatrix(): MatrixCase[] {
  const cases: MatrixCase[] = []

  // Every pattern against both ends of both ranges and the values between.
  let rotation = 0
  for (const pattern of APP_BG_TEXTURE_PATTERNS) {
    for (const scale of SCALES) {
      for (const opacity of OPACITIES) {
        const color = COLORS[rotation % COLORS.length]
        const background = BACKGROUNDS[rotation % BACKGROUNDS.length]
        rotation += 1
        cases.push({
          name: `${pattern} scale=${scale} opacity=${opacity} color=${color}`,
          input: { pattern, color, background, scale, opacity },
        })
      }
    }
  }

  // Every pattern against every colour spelling, at the form's defaults.
  for (const pattern of APP_BG_TEXTURE_PATTERNS) {
    for (const color of COLORS) {
      for (const background of BACKGROUNDS) {
        cases.push({
          name: `${pattern} color=${color} background=${background}`,
          input: { pattern, color, background, scale: 24, opacity: 0.15 },
        })
      }
    }
  }

  // The default branch.
  for (const pattern of UNKNOWN_PATTERNS) {
    for (const opacity of [0.05, 1]) {
      cases.push({
        name: `unknown pattern ${JSON.stringify(pattern)} opacity=${opacity}`,
        input: {
          pattern,
          color: '#22c55e',
          background: '#0a0a0a',
          scale: 24,
          opacity,
        },
      })
    }
  }

  return cases
}

const MATRIX = buildMatrix()

// ── layer 1: behaviour, against the real cabinet module ─────────────────────

describe('the preview tile and the cabinet tile', () => {
  it.skipIf(!hasSibling)(
    'are identical on every texture the form can save',
    async () => {
      const cabinet = await loadCabinetBuilder()
      const drifted: string[] = []
      for (const testCase of MATRIX) {
        const here = buildTextureCss(testCase.input)
        const there = cabinet(testCase.input)
        if (JSON.stringify(here) !== JSON.stringify(there)) {
          drifted.push(
            `${testCase.name}\n  preview: ${JSON.stringify(here)}\n  cabinet: ${JSON.stringify(there)}`,
          )
        }
      }
      expect(
        drifted,
        'the operator is previewing a background the subscriber will not get',
      ).toEqual([])
      expect(MATRIX.length).toBeGreaterThan(500)
    },
    30_000,
  )

  it.skipIf(!hasSibling)('agree on the pattern vocabulary', async () => {
    // Behaviour alone cannot see this: both sides answer an unknown id with the
    // dots tile, so a `case` that exists on one side only produces a perfectly
    // valid tile of the wrong picture, identical to `dots`, for a pattern the
    // picker offers by name.
    expect(
      switchLabels(REIWA_SOURCE),
      'the two generators no longer draw the same set of patterns',
    ).toEqual(switchLabels(PANEL_SOURCE))
  })
})

// ── layer 2: the matrix is the reachable input space ────────────────────────

describe('the matrix covers what an operator can save', () => {
  it('spans every pattern the picker offers', () => {
    const covered = new Set(MATRIX.map((testCase) => testCase.input.pattern))
    for (const pattern of APP_BG_TEXTURE_PATTERNS) {
      expect(covered.has(pattern), `${pattern} is not in the parity matrix`).toBe(true)
    }
  })

  it('spans both ends of the ranges the form allows', () => {
    // `branding-form-schema.ts`: scale ∈ [8, 256], opacity ∈ [0.05, 1].
    for (const scale of [8, 256]) {
      expect(SCALES).toContain(scale)
    }
    for (const opacity of [0.05, 1]) {
      expect(OPACITIES).toContain(opacity)
    }
    expect(SCALES.some((scale) => scale < 8 || scale > 256)).toBe(true)
    expect(OPACITIES.some((opacity) => opacity < 0.05 || opacity > 1)).toBe(true)
  })

  it("names every pattern this repo's own switch draws", () => {
    // Runs without the sibling. A picker entry with no `case` behind it renders
    // as dots in the preview AND in the cabinet — consistent, and not what the
    // operator picked.
    expect(switchLabels(PANEL_SOURCE)).toEqual([...APP_BG_TEXTURE_PATTERNS])
  })
})
