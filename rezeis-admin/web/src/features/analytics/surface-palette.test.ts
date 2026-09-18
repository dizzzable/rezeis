/**
 * The usage rings' colours, MEASURED — the way `dashboard-subscription-chart.test.tsx`
 * measures the client-app palette, plus the two checks a pair of eyes cannot
 * make: how the colours separate for a colour-blind operator, and how they
 * stand on the dark and the light card.
 *
 * What is measured is the ASSIGNMENT the card uses (`surfaceCategoryColor` for
 * every category a ring can hold), not the list of hues: two distinct hues
 * given to two categories of one ring is the property, and a palette of five
 * perfectly separated colours handed out wrongly would still fail it.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { SUBSCRIPTION_STATUS_COLORS } from '@/features/dashboard/dashboard-subscription-chart'

import {
  PWA_INSTALL_OS_UNKNOWN,
  SURFACE_CATEGORY_COLORS,
  SURFACE_HUES,
  SURFACE_OTHER_COLOR,
  SURFACE_UNKNOWN_COLOR,
  surfaceCategoryColor,
  type SurfaceDimension,
} from './surface-palette'

type Lab = readonly [number, number, number]
type Rgb = readonly [number, number, number]

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

function oklabFromLinear([r, g, b]: Rgb): Lab {
  const lms = [
    0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b,
    0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b,
    0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b,
  ].map(Math.cbrt) as [number, number, number]
  return [
    0.2104542553 * lms[0] + 0.793617785 * lms[1] - 0.0040720468 * lms[2],
    1.9779984951 * lms[0] - 2.428592205 * lms[1] + 0.4505937099 * lms[2],
    0.0259040371 * lms[0] + 0.7827717662 * lms[1] - 0.808675766 * lms[2],
  ]
}

function linearFromOklab([l, a, b]: Lab): Rgb {
  const [lc, mc, sc] = [
    l + 0.3963377774 * a + 0.2158037573 * b,
    l - 0.1055613458 * a - 0.0638541728 * b,
    l - 0.0894841775 * a - 1.291485548 * b,
  ].map((v) => v ** 3) as [number, number, number]
  return [
    4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
    -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
    -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
  ]
}

/** A CSS colour as linear sRGB. The notations this page's colours use; any other is refused by name. */
function linear(css: string): Rgb {
  const oklch = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(css)
  if (oklch !== null) {
    const [l, c, h] = [Number(oklch[1]), Number(oklch[2]), (Number(oklch[3]) * Math.PI) / 180]
    return linearFromOklab([l, c * Math.cos(h), c * Math.sin(h)])
  }
  const hsl = /^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/.exec(css)
  if (hsl !== null) {
    const [h, s, l] = [Number(hsl[1]), Number(hsl[2]) / 100, Number(hsl[3]) / 100]
    const k = (n: number): number => (n + h / 30) % 12
    const f = (n: number): number => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
    return [f(0), f(8), f(4)].map(toLinear) as unknown as Rgb
  }
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(css)
  if (hex !== null) return [hex[1], hex[2], hex[3]].map((part) => toLinear(parseInt(part as string, 16) / 255)) as unknown as Rgb
  throw new Error(`${css}: teach this test the notation before comparing it`)
}

/** Machado, Oliveira & Fernandes (2009) at full severity — the model the dataviz thresholds are calibrated to. */
const CVD: Readonly<Record<'protanopia' | 'deuteranopia', readonly Rgb[]>> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
}

const clamp = (v: number): number => Math.min(1, Math.max(0, v))
const seenWith = (rgb: Rgb, matrix: readonly Rgb[]): Rgb =>
  matrix.map((row) => clamp(row[0] * clamp(rgb[0]) + row[1] * clamp(rgb[1]) + row[2] * clamp(rgb[2]))) as unknown as Rgb
const gap = (p: Lab, q: Lab): number => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])

const distance = (a: string, b: string): number => gap(oklabFromLinear(linear(a)), oklabFromLinear(linear(b)))
const colourBlindDistance = (a: string, b: string): number =>
  Math.min(
    ...Object.values(CVD).map((matrix) =>
      gap(oklabFromLinear(seenWith(linear(a), matrix)), oklabFromLinear(seenWith(linear(b), matrix))),
    ),
  )
const luminance = (css: string): number => {
  const [r, g, b] = linear(css).map(clamp) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** Every category each ring can hold, as the report can send it. */
const RINGS: Readonly<Record<string, { readonly dimension: SurfaceDimension; readonly keys: readonly string[] }>> = {
  surface: { dimension: 'surface', keys: ['tma', 'browser', 'pwa', 'other'] },
  device: { dimension: 'form', keys: ['mobile', 'tablet', 'desktop', 'other'] },
  os: { dimension: 'os', keys: ['ios', 'android', 'windows', 'macos', 'linux', 'other'] },
  pwaInstalls: { dimension: 'os', keys: ['ios', 'android', 'windows', 'macos', 'linux', 'other', PWA_INSTALL_OS_UNKNOWN] },
}

/** The theme's own `--destructive`, light and dark, read from the stylesheet rather than restated. */
function themeDestructive(): string[] {
  const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../index.css'), 'utf8')
  const found = [...css.matchAll(/^\s*--destructive:\s*(oklch\([^)]*\));/gm)].map((match) => match[1] as string)
  expect(found, 'index.css no longer declares --destructive for both themes').toHaveLength(2)
  return found
}

describe('the usage rings’ colours', () => {
  it('keep every two categories of one ring apart, as seen and as a colour-blind operator sees them', () => {
    /**
     * The dataviz floors: 0.15 as seen (below it, full-colour readers struggle
     * to tell neighbours apart) and 0.08 under protanopia or deuteranopia. A
     * ring puts ANY two of its categories side by side — the order follows the
     * data — so every pair counts, not only neighbours in a list.
     * Measured when chosen: 0.160 and 0.086, both between the sky and the
     * lavender of «Поверхность».
     */
    const MIN_SEEN = 0.15
    const MIN_COLOUR_BLIND = 0.08
    // The measure itself: one colour in two notations reads as one colour.
    expect(distance('hsl(25, 95%, 53%)', 'oklch(0.707 0.186 48.1)')).toBeLessThan(0.01)
    expect(distance('#ffffff', 'oklch(1 0 0)')).toBeLessThan(0.001)

    const tooClose: string[] = []
    let pairs = 0
    for (const [ring, { dimension, keys }] of Object.entries(RINGS)) {
      keys.forEach((key, index) => {
        for (const other of keys.slice(index + 1)) {
          pairs += 1
          const [a, b] = [surfaceCategoryColor(dimension, key), surfaceCategoryColor(dimension, other)]
          const seen = distance(a, b)
          const colourBlind = colourBlindDistance(a, b)
          if (seen < MIN_SEEN) tooClose.push(`${ring}: ${key} ${a} beside ${other} ${b} — ${seen.toFixed(3)} as seen`)
          if (colourBlind < MIN_COLOUR_BLIND) {
            tooClose.push(`${ring}: ${key} ${a} beside ${other} ${b} — ${colourBlind.toFixed(3)} colour-blind`)
          }
        }
      })
    }
    expect(pairs, 'no pair was measured').toBe(6 + 6 + 15 + 21)
    expect(tooClose).toEqual([])
  })

  it('stay clear of every status colour on this page and the dashboard beside it', () => {
    const MIN_DISTANCE = 0.12
    const statuses: ReadonlyArray<readonly [string, string]> = [
      ...Object.entries(SUBSCRIPTION_STATUS_COLORS),
      // This page's own: the providers' success/warning/failure and the green, amber and red of its series.
      ['emerald-500', '#10b981'],
      ['emerald-600', '#059669'],
      ['amber-500', '#f59e0b'],
      ['red-500', '#ef4444'],
      ...themeDestructive().map((css, index) => [index === 0 ? '--destructive (light)' : '--destructive (dark)', css] as const),
    ]
    expect(statuses).toHaveLength(10)

    const everyColour = [...Object.values(SURFACE_HUES), SURFACE_OTHER_COLOR, SURFACE_UNKNOWN_COLOR]
    const tooClose = everyColour.flatMap((colour) =>
      statuses
        .map(([status, css]) => [status, css, distance(colour, css)] as const)
        .filter(([, , d]) => d < MIN_DISTANCE)
        .map(([status, css, d]) => `${colour} beside ${status} ${css}: ${d.toFixed(3)}`),
    )
    expect(tooClose).toEqual([])
  })

  it('stand out on the white card and on the dark one', () => {
    // The themes' own cards: `--card` in `:root` and in `.dark`. Every hue
    // clears 2.3:1 on white (the sky is the palest, 2.32) and 3:1 on the dark
    // card (the plum is the darkest, 3.25). Below 3:1 on white the legend's
    // words and numbers carry the value, which they always do here.
    const WHITE = 'oklch(1 0 0)'
    const DARK = 'oklch(0.205 0 0)'
    const weak = Object.entries(SURFACE_HUES).flatMap(([name, css]) => [
      ...(contrast(css, WHITE) < 2.3 ? [`${name} on white: ${contrast(css, WHITE).toFixed(2)}`] : []),
      ...(contrast(css, DARK) < 3 ? [`${name} on dark: ${contrast(css, DARK).toFixed(2)}`] : []),
    ])
    expect(weak).toEqual([])
    // "Другое" is a colour a reader must still find; "ОС не записана" is pale by design.
    expect(contrast(SURFACE_OTHER_COLOR, WHITE)).toBeGreaterThanOrEqual(3)
    expect(contrast(SURFACE_OTHER_COLOR, DARK)).toBeGreaterThanOrEqual(3)
  })

  it('gives each category of a ring a colour of its own, and the neutral only to what is not a category', () => {
    for (const { dimension, keys } of Object.values(RINGS)) {
      const colours = keys.map((key) => surfaceCategoryColor(dimension, key))
      expect(new Set(colours).size, `${dimension}: ${colours.join(', ')}`).toBe(keys.length)
    }
    for (const [dimension, named] of Object.entries(SURFACE_CATEGORY_COLORS)) {
      for (const colour of Object.values(named)) {
        expect(colour).not.toMatch(/var\(--chart-/)
        expect([SURFACE_OTHER_COLOR, SURFACE_UNKNOWN_COLOR], `${dimension} names a category in a neutral`).not.toContain(colour)
      }
    }
    expect(surfaceCategoryColor('os', 'other')).toBe(SURFACE_OTHER_COLOR)
    expect(surfaceCategoryColor('surface', 'other')).toBe(SURFACE_OTHER_COLOR)
    expect(surfaceCategoryColor('os', PWA_INSTALL_OS_UNKNOWN)).toBe(SURFACE_UNKNOWN_COLOR)
    // A value a newer cabinet starts sending borrows no category's colour.
    expect(surfaceCategoryColor('os', 'harmonyos')).toBe(SURFACE_OTHER_COLOR)
    expect(surfaceCategoryColor('form', 'constructor')).toBe(SURFACE_OTHER_COLOR)
  })

  it('rhymes across rings only where the categories do', () => {
    // Phones and tablets are the warm half in «Устройство», and so are the
    // mobile systems in «ОС»; desktops are blue, and so is Windows. A desktop
    // in an Android colour would be the one rhyme that lies.
    const mobileOs = [surfaceCategoryColor('os', 'ios'), surfaceCategoryColor('os', 'android')]
    const desktopOs = ['windows', 'macos', 'linux'].map((key) => surfaceCategoryColor('os', key))
    expect(mobileOs).toContain(surfaceCategoryColor('form', 'mobile'))
    expect(mobileOs).toContain(surfaceCategoryColor('form', 'tablet'))
    expect(desktopOs).toContain(surfaceCategoryColor('form', 'desktop'))
    expect(mobileOs).not.toContain(surfaceCategoryColor('form', 'desktop'))
    expect(desktopOs).not.toContain(surfaceCategoryColor('form', 'mobile'))
  })
})
