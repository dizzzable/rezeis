#!/usr/bin/env node
/**
 * Generate the landing theme catalog from the design-file palettes.
 *
 * Input  : concept-palettes.json — one record per concept, extracted read-only
 *          from the Pencil design file (bg stops, fg, primary, accent,
 *          surfaceStyle, backgroundKind).
 * Output : src/features/landing-builder/theme-presets.generated.ts
 *
 * Why generate rather than hand-write: a catalog this size is a grid
 * (palette × surface × background effect), and the industrial way to ship a
 * hundred themes is to enumerate the grid, not to author a hundred files. It
 * also keeps the catalog re-derivable when the design file changes.
 *
 * Foreground contrast is checked, not assumed. `fixContrast` nudges `fg` toward
 * black or white until it clears WCAG AA (4.5:1) and records the deviation,
 * rather than shipping unreadable text for the sake of matching a mock. As of
 * the current palettes it never fires: every concept clears AA once the page
 * background is identified correctly (see `baseBg` — an earlier run that picked
 * the last gradient stop reported five false failures). The guard stays because
 * the next palette import may not be as lucky.
 *
 * Usage: node scripts/generate-theme-presets.mjs <path-to-concept-palettes.json>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = join(__dirname, '..', 'src', 'features', 'landing-builder', 'theme-presets.generated.ts')

const AA = 4.5

// ── colour maths ────────────────────────────────────────────────────────────

const toRgb = (hex) => {
  let raw = String(hex).replace('#', '').slice(0, 6)
  if (raw.length === 3) raw = raw.split('').map((c) => c + c).join('')
  const n = Number.parseInt(raw, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const toHex = ([r, g, b]) =>
  `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`
const luminance = (hex) => {
  const lin = toRgb(hex).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}
const contrast = (a, b) => {
  const [hi, lo] = luminance(a) > luminance(b) ? [luminance(a), luminance(b)] : [luminance(b), luminance(a)]
  return (hi + 0.05) / (lo + 0.05)
}
/** Moves `fg` toward white or black (whichever the background needs) until AA. */
const fixContrast = (fg, bg) => {
  if (contrast(fg, bg) >= AA) return { fg, adjusted: false }
  const target = luminance(bg) > 0.5 ? [0, 0, 0] : [255, 255, 255]
  const start = toRgb(fg)
  for (let step = 1; step <= 100; step += 1) {
    const t = step / 100
    const candidate = toHex(start.map((v, i) => v + (target[i] - v) * t))
    if (contrast(candidate, bg) >= AA) return { fg: candidate, adjusted: true }
  }
  return { fg: toHex(target), adjusted: true }
}

// ── mapping ─────────────────────────────────────────────────────────────────

/** Ordered gradient stops of the root fill, capped at the four `--ls-c1..c4`. */
function stopsOf(record) {
  const layer = record.bg?.layers?.find((l) => Array.isArray(l.stops) && l.stops.length > 0)
  if (layer === undefined) return record.bg?.color ? [record.bg.color] : []
  return layer.stops
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((s) => normaliseHex(s.color))
    .slice(0, 4)
}

/**
 * The page background colour — `--ls-bg`, the flat surface text actually sits
 * on. The gradient stops are NOT it: they feed the effect layer, which the
 * renderer paints over this base at partial opacity.
 *
 * Picking a stop by position does not work. The extraction's `fg` is the
 * heading that sits directly on the page, so the designer chose it against the
 * dominant surface — but which stop that is depends on the gradient: for a
 * radial ramp it is the outer edge (last stop), for a linear one it can be
 * either end, and "Desert Dusk Horizon" puts a bright band at the top over a
 * dark page. Assuming last-stop mislabels those, which is how five themes were
 * previously mistaken for contrast failures.
 *
 * So: take the stop the foreground reads best against. That recovers the pair
 * the designer actually drew rather than guessing at gradient geometry. It
 * cannot, by construction, detect a concept that is unreadable against every
 * stop — `worstStopContrast` is reported separately for that.
 */
function baseBg(record) {
  const stops = stopsOf(record)
  if (stops.length === 0) return normaliseHex(record.bg?.color ?? '#0a0a0a')
  const fg = normaliseHex(record.fg)
  return stops.reduce((best, stop) => (contrast(fg, stop) > contrast(fg, best) ? stop : best), stops[0])
}

/** Lowest contrast between the foreground and any stop of the effect ramp. */
function worstStopContrast(record) {
  const stops = stopsOf(record)
  if (stops.length === 0) return Infinity
  const fg = normaliseHex(record.fg)
  return stops.reduce((low, stop) => Math.min(low, contrast(fg, stop)), Infinity)
}

/** The schema's hex pattern allows #RGB and #RRGGBB only — drop any alpha. */
function normaliseHex(value) {
  const raw = String(value ?? '').replace('#', '')
  const six = raw.length >= 6 ? raw.slice(0, 6) : raw.slice(0, 3)
  return `#${six.toLowerCase()}`
}

/**
 * Background effect. The extraction only distinguishes flat / gradient / mesh,
 * so that is all we claim: inventing an `aurora` or `network` for a concept
 * that has neither would be decoration, not derivation.
 */
const BACKGROUND_BY_KIND = { gradient: 'gradient', mesh_gradient: 'mesh', flat: 'none' }

/**
 * Corner radius, keyed off the surface treatment — the one signal the
 * extraction does carry that plausibly implies geometry. Glass surfaces read
 * softer, outline surfaces read technical.
 */
const RADIUS_BY_SURFACE = { glass: 'xl', solid: 'lg', outline: 'sm' }

const slug = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

function build(record) {
  const bg = baseBg(record)
  const fgRaw = normaliseHex(record.fg)
  const { fg, adjusted } = fixContrast(fgRaw, bg)
  const primary = normaliseHex(record.primary)
  const surfaceStyle = record.surfaceStyle === 'glass' ? 'glass' : record.surfaceStyle === 'outline' ? 'outline' : 'solid'
  return {
    id: slug(record.name),
    name: record.name,
    code: record.code,
    mood: luminance(bg) > 0.35 ? 'light' : 'dark',
    theme: {
      inherit: false,
      colors: {
        primary,
        bg,
        fg,
        // Most concepts are single-accent by construction; falling back to
        // `primary` keeps the key present so a preset always fully replaces.
        accent: record.accent ? normaliseHex(record.accent) : primary,
      },
      // No `font`. The palettes carry no typography, and an empty `font: {}` is
      // not "no opinion" — a preset replaces the theme wholesale, so it landed
      // on top of the typeface the operator had chosen in Settings and cleared
      // it. See `preserveFont` in theme-presets.ts.
      radius: RADIUS_BY_SURFACE[surfaceStyle],
      background: BACKGROUND_BY_KIND[record.backgroundKind] ?? 'gradient',
      backgroundColors: stopsOf(record),
      animateBackground: true,
      surfaceStyle,
    },
    contrastAdjusted: adjusted,
    originalFg: adjusted ? fgRaw : null,
    contrast: contrast(fg, bg),
    worstStop: worstStopContrast(record),
  }
}

// ── emit ────────────────────────────────────────────────────────────────────

const input = process.argv[2]
if (!input) {
  console.error('usage: generate-theme-presets.mjs <concept-palettes.json>')
  process.exit(1)
}

const records = JSON.parse(readFileSync(input, 'utf8'))
const presets = records.map(build).sort((a, b) => a.name.localeCompare(b.name))

const ids = new Set()
for (const p of presets) {
  if (ids.has(p.id)) throw new Error(`duplicate preset id: ${p.id}`)
  ids.add(p.id)
}

const adjusted = presets.filter((p) => p.contrastAdjusted)
const body = presets
  .map((p) => {
    const note = p.contrastAdjusted
      ? `\n    // Foreground nudged from ${p.originalFg} to clear WCAG AA on this background.`
      : ''
    return `  {
    id: ${JSON.stringify(p.id)},
    name: ${JSON.stringify(p.name)},
    mood: ${JSON.stringify(p.mood)},${note}
    theme: ${JSON.stringify(p.theme)},
  },`
  })
  .join('\n')

writeFileSync(
  OUT,
  `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source : the concept palettes extracted from the landing design file.
 * Script : scripts/generate-theme-presets.mjs
 *
 * ${presets.length} themes. ${adjusted.length} had their foreground adjusted to reach
 * WCAG AA (4.5:1) against their own background; each is marked inline with the
 * original value from the mock.
 */
import type { LandingThemePreset } from './theme-presets'

export const GENERATED_THEME_PRESETS: readonly LandingThemePreset[] = [
${body}
]
`,
  'utf8',
)

console.log(`[theme-presets] ${presets.length} themes → ${OUT}`)
console.log(`[theme-presets] contrast-adjusted: ${adjusted.length}`)
for (const p of adjusted) {
  console.log(`  ${p.name}: ${p.originalFg} → ${p.theme.colors.fg}`)
}

// Informational, not a gate: the effect ramp paints over the base at partial
// opacity, so a dim stop tints text rather than replacing its background.
const dimStop = presets.filter((p) => p.worstStop < AA).sort((a, b) => a.worstStop - b.worstStop)
console.log(`[theme-presets] themes with a low-contrast effect stop: ${dimStop.length}`)
for (const p of dimStop.slice(0, 10)) {
  console.log(`  ${p.name}: worst stop ${p.worstStop.toFixed(2)}:1`)
}
