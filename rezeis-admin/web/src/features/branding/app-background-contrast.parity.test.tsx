/**
 * Parity between the operator's preview and the subscriber's cabinet.
 *
 * The readability veil under the cabinet's direct copy used to be computed
 * twice — once by `reiwa/web/src/lib/app-background-contrast.ts`, once by a
 * shorter re-implementation inside `branding-preview.tsx` — and the two
 * disagreed on inputs the operator can type into the app-background gradient
 * field, which is free text guarded only by `isSafeBrandingGradient`.
 *
 * This file is the check whose absence let that happen, in four layers:
 *
 *   1. the vendored copy is byte-identical to reiwa's original;
 *   2. both modules return the same object on every shape the validator
 *      accepts — hex in all four lengths, `rgb()`/`rgba()`, `hsl()`/`hsla()`,
 *      named colours, translucent stops, many stops, every gradient function
 *      and angle, layered gradients, and textures over light and dark bases;
 *   3. a table of recorded cabinet answers, so CI (which has no reiwa
 *      checkout) still fails if the vendored copy starts answering differently;
 *   4. the preview COMPONENT renders those recorded answers — i.e. it really
 *      delegates instead of quietly growing a second implementation again.
 *
 * Layers 1 and 2 need the sibling reiwa checkout and skip without it, exactly
 * as `live-kit-manifest.test.ts` does for the vendored landing kit. Layers 3
 * and 4 run everywhere.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { renderWithProviders } from '@/test/test-utils'

import {
  resolveAppBackgroundReadability,
  type AppBackgroundReadability,
} from './app-background-contrast'
import {
  isSafeBrandingGradient,
  type BrandingAppBackgroundDraft,
  type BrandingSurfaceThemeDraft,
} from './branding-form-schema'

vi.mock('@/features/plans/plans-api', () => ({
  usePlans: () => ({ data: [] }),
}))

import { BrandingPreview } from './branding-preview'

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
  'app-background-contrast.ts',
)
const VENDORED_SOURCE = join(__dirname, 'app-background-contrast.ts')

/**
 * `import.meta.glob` rather than a plain import: a static import of a file
 * outside this repo turns a missing reiwa checkout into a collection error for
 * the whole file, and CI for this repo has no reiwa working tree. A glob that
 * matches nothing is simply an empty object.
 */
const reiwaModules = import.meta.glob(
  '../../../../../../reiwa/web/src/lib/app-background-contrast.ts',
)
const reiwaEntry = Object.values(reiwaModules)[0]
const hasSibling = existsSync(REIWA_SOURCE) && reiwaEntry !== undefined

type Resolver = (branding: {
  readonly appBackground?: unknown
  readonly bgPrimary: string
  readonly surfaceTheme?: unknown
  readonly themePresetId?: string | null
}) => AppBackgroundReadability | null

async function loadCabinetResolver(): Promise<Resolver> {
  const module = (await reiwaEntry!()) as {
    resolveAppBackgroundReadability: Resolver
  }
  return module.resolveAppBackgroundReadability
}

/**
 * The one edit the vendored copy carries is its header (reiwa imports its
 * `Branding` type from the cabinet's own module). Everything from the first
 * `const WHITE_RGB` onwards must be identical, so that is where the comparison
 * starts.
 */
const VERBATIM_MARKER = 'const WHITE_RGB'

/**
 * Compare canonical LF form. Both repos are checked out with
 * `core.autocrlf=true`, so identical committed content is LF in git and can be
 * CRLF on disk; hashing raw bytes would make this assertion depend on the
 * checkout's line-ending policy rather than on content.
 */
function verbatimBody(path: string): string {
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
  const start = text.indexOf(VERBATIM_MARKER)
  expect(start, `${path} has no \`${VERBATIM_MARKER}\` marker`).toBeGreaterThan(-1)
  return text.slice(start)
}

// ── the input matrix ────────────────────────────────────────────────────────

const LIGHT_COPY: BrandingSurfaceThemeDraft = {
  foreground: '#fafafa',
  mutedForeground: '#a1a1a1',
  surface: '#18181b',
  surfaceHigh: '#27272a',
  borderSoft: '#ffffff',
  borderStrong: '#ffffff',
  surfaceOpacity: 0.7,
  surfaceHighOpacity: 0.8,
  borderSoftOpacity: 0.06,
  borderStrongOpacity: 0.12,
  glassBlurPx: 16,
}

const DARK_COPY: BrandingSurfaceThemeDraft = {
  ...LIGHT_COPY,
  foreground: '#111827',
  mutedForeground: '#334155',
}

const DEFAULT_TEXTURE = {
  pattern: 'dots',
  color: '#22c55e',
  background: '#0a0a0a',
  scale: 24,
  opacity: 0.15,
} as const

/**
 * Every colour notation `isSafeBrandingGradient` lets through. It validates the
 * gradient's STRUCTURE — the functions, the balanced parens, the absence of
 * `url()` and declaration breaks — and says nothing at all about how the colour
 * stops inside are written, which is precisely why the preview's hex-only
 * reader was wrong. `accepts every gradient in the matrix` below keeps this
 * list honest.
 */
const GRADIENTS: readonly string[] = [
  // hex, all four lengths the parser accepts
  'linear-gradient(180deg, #fff 0%, #eee 100%)',
  'linear-gradient(180deg, #fffa 0%, #0a0a0a 100%)',
  'linear-gradient(180deg, #f8fafc 0%, #e2e8f0 100%)',
  'linear-gradient(180deg, #f8fafcff 0%, #e2e8f0cc 100%)',
  // translucent stop over a dark foundation — the stacking path
  'linear-gradient(180deg, #ffffffcc 0%, #e2e8f0 100%)',
  // rgb()/rgba(), space- and comma-separated, percentages, slash alpha
  'linear-gradient(180deg, rgb(248 250 252) 0%, rgb(226 232 240) 100%)',
  'linear-gradient(180deg, rgb(248, 250, 252) 0%, rgba(226, 232, 240, 0.4) 100%)',
  'linear-gradient(180deg, rgb(100% 98% 96%) 0%, rgba(10 10 10 / 55%) 100%)',
  // hsl()/hsla(), both syntaxes
  'linear-gradient(180deg, hsl(210 40% 98%) 0%, hsl(214 32% 91%) 100%)',
  'linear-gradient(180deg, hsl(210, 40%, 98%) 0%, hsla(214, 32%, 91%, 0.5) 100%)',
  // named colours
  'linear-gradient(180deg, white 0%, #e2e8f0 100%)',
  'linear-gradient(180deg, black 0%, white 100%)',
  'linear-gradient(90deg, white, black)',
  // many stops, other angles, other gradient functions
  'linear-gradient(45deg, #f3c79c 0%, #b56c68 35.6%, #5d3156 74%, #251225 110%)',
  'radial-gradient(ellipse 50% 37% at 16% 5%, #351411 0%, #090706 100%)',
  'conic-gradient(from 210deg at 50% 50%, #fde68a 0deg, #7c3aed 180deg, #fde68a 360deg)',
  'repeating-linear-gradient(135deg, rgb(255 255 255 / 0.85) 0 12px, hsl(220 14% 96%) 12px 24px)',
  // layered gradients mixing notations — the real Concept AM shape
  'linear-gradient(90deg, #f28a4b20 0 28%, transparent 28% 100%), linear-gradient(180deg, white -10%, hsl(340 30% 40%) 60%, #251225 110%)',
  // nothing parseable at all — the resolver must fall back, not throw
  'linear-gradient(180deg, transparent 0%, currentColor 100%)',
]

const TEXTURES: readonly BrandingAppBackgroundDraft['texture'][] = [
  // light base
  { pattern: 'dots', color: '#94a3b8', background: '#f8fafc', scale: 24, opacity: 0.2 },
  // dark base
  { pattern: 'grid', color: '#22c55e', background: '#0a0a0a', scale: 32, opacity: 0.15 },
  // bright pattern dimmed almost to nothing — the preview used to sample the
  // colour at full strength and veil a background the cabinet leaves bright
  { pattern: 'noise', color: '#ffffff', background: '#0a0a0a', scale: 24, opacity: 0.05 },
  // fully opaque pattern over a dark base
  { pattern: 'carbon', color: '#fef3c7', background: '#0a0a0a', scale: 48, opacity: 1 },
]

interface MatrixCase {
  readonly name: string
  readonly branding: {
    readonly appBackground: BrandingAppBackgroundDraft
    readonly bgPrimary: string
    readonly surfaceTheme: BrandingSurfaceThemeDraft
    readonly themePresetId: string | null
  }
}

function buildMatrix(): MatrixCase[] {
  const cases: MatrixCase[] = []
  const surfaces = [
    ['light-copy', LIGHT_COPY],
    ['dark-copy', DARK_COPY],
  ] as const
  const foundations = ['#0a0a0a', '#ffffff'] as const
  const presets = [null, 'concept-am'] as const

  for (const [surfaceName, surfaceTheme] of surfaces) {
    for (const themePresetId of presets) {
      for (const [index, gradient] of GRADIENTS.entries()) {
        for (const bgPrimary of foundations) {
          cases.push({
            name: `gradient#${index} ${surfaceName} on ${bgPrimary} preset=${themePresetId ?? 'none'}`,
            branding: {
              appBackground: {
                kind: 'gradient',
                effect: 'NONE',
                props: {},
                opacity: 1,
                gradient,
                texture: { ...DEFAULT_TEXTURE, background: bgPrimary },
              },
              bgPrimary,
              surfaceTheme,
              themePresetId,
            },
          })
        }
      }
      for (const [index, texture] of TEXTURES.entries()) {
        cases.push({
          name: `texture#${index} ${surfaceName} preset=${themePresetId ?? 'none'}`,
          branding: {
            appBackground: {
              kind: 'texture',
              effect: 'NONE',
              props: {},
              opacity: 1,
              gradient: 'linear-gradient(180deg, #0a0a0a 0%, #171717 100%)',
              texture,
            },
            bgPrimary: '#0a0a0a',
            surfaceTheme,
            themePresetId,
          },
        })
      }
      // The two kinds that must produce no veil at all.
      for (const kind of ['none', 'effect'] as const) {
        cases.push({
          name: `kind=${kind} ${surfaceName} preset=${themePresetId ?? 'none'}`,
          branding: {
            appBackground: {
              kind,
              effect: kind === 'effect' ? 'aurora' : 'NONE',
              props: {},
              opacity: 1,
              gradient: 'linear-gradient(180deg, #f8fafc 0%, #e2e8f0 100%)',
              texture: DEFAULT_TEXTURE,
            },
            bgPrimary: '#0a0a0a',
            surfaceTheme,
            themePresetId,
          },
        })
      }
    }
  }
  return cases
}

const MATRIX = buildMatrix()

// ── the recorded table ──────────────────────────────────────────────────────

/**
 * The rows from the drift report, with the answer the CABINET gives, measured
 * against the sibling checkout. Anything that changes these numbers changes
 * what the subscriber sees, so updating them is a deliberate act: change the
 * algorithm in reiwa, re-copy the body, re-measure, then edit this table.
 *
 * `preview` is what the old hex-only re-implementation returned, kept as the
 * record of what the divergence actually cost.
 */
interface TableRow {
  readonly name: string
  readonly branding: MatrixCase['branding']
  /** Cabinet answer: veil opacity, or null for "no veil". */
  readonly cabinet: number | null
  /** What the preview's own implementation used to answer. */
  readonly previewBefore: number | null
}

function gradientCase(
  gradient: string,
  extra: Partial<MatrixCase['branding']> = {},
): MatrixCase['branding'] {
  return {
    appBackground: {
      kind: 'gradient',
      effect: 'NONE',
      props: {},
      opacity: 1,
      gradient,
      texture: DEFAULT_TEXTURE,
    },
    bgPrimary: '#0a0a0a',
    surfaceTheme: LIGHT_COPY,
    themePresetId: null,
    ...extra,
  }
}

const TABLE: readonly TableRow[] = [
  {
    name: 'light gradient, hex',
    branding: gradientCase('linear-gradient(180deg, #f8fafc 0%, #e2e8f0 100%)'),
    cabinet: 0.804,
    previewBefore: 0.804,
  },
  {
    name: 'gradient via rgb()',
    branding: gradientCase(
      'linear-gradient(180deg, rgb(248 250 252) 0%, rgb(226 232 240) 100%)',
    ),
    cabinet: 0.804,
    previewBefore: null,
  },
  {
    name: 'gradient via hsl()',
    branding: gradientCase(
      'linear-gradient(180deg, hsl(210 40% 98%) 0%, hsl(214 32% 91%) 100%)',
    ),
    cabinet: 0.804,
    previewBefore: null,
  },
  {
    name: 'named white stop',
    branding: gradientCase('linear-gradient(180deg, white 0%, #e2e8f0 100%)'),
    cabinet: 0.808,
    previewBefore: 0.785,
  },
  {
    name: 'translucent stop #ffffffcc',
    branding: gradientCase('linear-gradient(180deg, #ffffffcc 0%, #e2e8f0 100%)'),
    cabinet: 0.808,
    previewBefore: 0.785,
  },
  {
    name: 'texture, light base',
    branding: {
      ...gradientCase('linear-gradient(180deg, #0a0a0a 0%, #171717 100%)'),
      appBackground: {
        kind: 'texture',
        effect: 'NONE',
        props: {},
        opacity: 1,
        gradient: 'linear-gradient(180deg, #0a0a0a 0%, #171717 100%)',
        texture: {
          pattern: 'dots',
          color: '#94a3b8',
          background: '#f8fafc',
          scale: 24,
          opacity: 0.2,
        },
      },
    },
    cabinet: 0.804,
    previewBefore: 0.804,
  },
  {
    name: 'texture, dim bright pattern on a dark base',
    branding: {
      ...gradientCase('linear-gradient(180deg, #0a0a0a 0%, #171717 100%)'),
      appBackground: {
        kind: 'texture',
        effect: 'NONE',
        props: {},
        opacity: 1,
        gradient: 'linear-gradient(180deg, #0a0a0a 0%, #171717 100%)',
        texture: {
          pattern: 'dots',
          color: '#ffffff',
          background: '#0a0a0a',
          scale: 24,
          opacity: 0.05,
        },
      },
    },
    cabinet: null,
    previewBefore: 0.808,
  },
  {
    name: 'concept gradient with its soft-light texture',
    branding: {
      appBackground: {
        kind: 'gradient',
        effect: 'NONE',
        props: {},
        opacity: 1,
        gradient:
          'linear-gradient(180deg, #F3C79C -10%, #B56C68 35.6%, #5D3156 74%, #251225 110%)',
        texture: {
          pattern: 'noise',
          color: '#F28A4B',
          background: '#251225',
          scale: 64,
          opacity: 0.1,
        },
      },
      bgPrimary: '#251225',
      surfaceTheme: LIGHT_COPY,
      themePresetId: 'concept-am',
    },
    cabinet: 0.756,
    previewBefore: 0.756,
  },
]

function renderPreviewVeil(branding: MatrixCase['branding']): {
  readonly opacity: number | null
  readonly veil: string | null
  readonly style: string
} {
  const { container, unmount } = renderWithProviders(
    <BrandingPreview
      values={{
        themePresetId: branding.themePresetId,
        bgPrimary: branding.bgPrimary,
        surfaceTheme: branding.surfaceTheme,
        appBackground: branding.appBackground,
        // Keep the subscription card static: this spec is about the app
        // background layer, and an animated card effect would drag a WebGL
        // renderer into jsdom for no reason.
        cardEffect: 'NONE',
      }}
    />,
  )
  const node = container.querySelector(
    '[data-preview-app-readability="wcag-direct-copy-zones"]',
  )
  const raw = node?.getAttribute('data-preview-app-readability-opacity')
  const result = {
    opacity: raw === null || raw === undefined ? null : Number(raw),
    veil: node?.getAttribute('data-preview-app-readability-veil') ?? null,
    style: node?.getAttribute('style') ?? '',
  }
  unmount()
  return result
}

// ── layers 1 + 2: against the real cabinet module ───────────────────────────

describe('vendored cabinet resolver', () => {
  it.skipIf(!hasSibling)(
    'is byte-identical to reiwa below the adapted header',
    () => {
      expect(
        verbatimBody(VENDORED_SOURCE),
        'app-background-contrast.ts differs from reiwa — re-copy the body',
      ).toBe(verbatimBody(REIWA_SOURCE))
    },
  )

  it.skipIf(!hasSibling)(
    'answers exactly as the cabinet on every accepted gradient shape',
    async () => {
      const cabinet = await loadCabinetResolver()
      const drifted: string[] = []
      for (const testCase of MATRIX) {
        const here = resolveAppBackgroundReadability(testCase.branding)
        const there = cabinet(testCase.branding)
        if (JSON.stringify(here) !== JSON.stringify(there)) {
          drifted.push(
            `${testCase.name}: preview=${JSON.stringify(here)} cabinet=${JSON.stringify(there)}`,
          )
        }
      }
      expect(drifted).toEqual([])
      expect(MATRIX.length).toBeGreaterThan(100)
    },
    // The matrix is a full cross-product of every reachable input, and running
    // BOTH resolvers over all of it takes about seven seconds on its own. In the
    // whole suite, with 164 files across parallel workers, the same work takes
    // over sixteen — which is how this spec came to fail every other full run
    // while passing alone. Slow is what this spec is: the alternative is a
    // sampled matrix, and a parity check that samples is a parity check that
    // misses the one shape that drifted.
    60_000,
  )

  it.skipIf(!hasSibling)(
    'and on every row of the recorded table',
    async () => {
      const cabinet = await loadCabinetResolver()
      const measured = TABLE.map(
        (row) => cabinet(row.branding)?.veilOpacity ?? null,
      )
      expect(
        measured,
        'the recorded table no longer matches the cabinet — re-measure it',
      ).toEqual(TABLE.map((row) => row.cabinet))
    },
    // Same reason as above: this one also drives the cabinet's resolver.
    60_000,
  )
})

// ── layer 3: the matrix is the reachable input space ────────────────────────

describe('the matrix covers what an operator can save', () => {
  it.each(GRADIENTS)('isSafeBrandingGradient accepts %s', (gradient) => {
    expect(isSafeBrandingGradient(gradient)).toBe(true)
  })
})

// ── layer 3: recorded answers, no sibling checkout needed ───────────────────

describe('vendored resolver against the recorded cabinet answers', () => {
  it.each(TABLE.map((row) => [row.name, row] as const))(
    '%s',
    (_name, row) => {
      const result = resolveAppBackgroundReadability(row.branding)
      expect(result?.veilOpacity ?? null).toBe(row.cabinet)
      if (row.cabinet !== null) {
        expect(result?.veilRgb).toBe('0 0 0')
        expect(result?.overlayBackground).toContain(
          `rgb(0 0 0 / ${row.cabinet}) 40%`,
        )
      }
    },
  )
})

// ── layer 4: the preview component renders those answers ────────────────────

describe('the preview renders the cabinet answer, not one of its own', () => {
  it.each(TABLE.map((row) => [row.name, row] as const))(
    '%s',
    (_name, row) => {
      const rendered = renderPreviewVeil(row.branding)
      expect(rendered.opacity).toBe(row.cabinet)
      if (row.cabinet !== null) {
        expect(rendered.veil).toBe('dark')
        // jsdom re-serialises `rgb(r g b / a)` into the legacy comma form.
        expect(rendered.style).toContain(`rgba(0, 0, 0, ${row.cabinet}) 40%`)
      }
    },
  )

  it('no longer answers what the old hex-only implementation answered', () => {
    const regressed = TABLE.filter(
      (row) => row.previewBefore !== row.cabinet,
    ).filter((row) => renderPreviewVeil(row.branding).opacity === row.previewBefore)
    expect(
      regressed.map((row) => row.name),
      'the preview is back to computing the veil itself',
    ).toEqual([])
  })
})
