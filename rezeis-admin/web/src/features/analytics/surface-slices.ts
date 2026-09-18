/**
 * From a breakdown the report sends to the slices a ring draws: a label in the
 * operator's language, a colour that belongs to the category, and a share.
 */
import type { SurfaceCount } from './analytics-api'
import {
  PWA_INSTALL_OS_UNKNOWN,
  SURFACE_CATEGORY_COLORS,
  surfaceCategoryColor,
  type SurfaceDimension,
} from './surface-palette'

/**
 * Every value the backend can put in a breakdown, and the dictionary key that
 * names it. Spelled out rather than built as `${dimension}.${key}`: a template
 * key that misses renders its own path, and no parity check can see a key that
 * exists in neither language (`surface-slices.test.ts` holds every entry here to
 * both bundles, and every value the cabinet's clamp writes to an entry).
 */
export const SURFACE_LABEL_KEYS: {
  readonly [D in SurfaceDimension]: Readonly<Record<string, string>>
} = {
  surface: {
    tma: 'analyticsPage.surfaces.surface.tma',
    browser: 'analyticsPage.surfaces.surface.browser',
    pwa: 'analyticsPage.surfaces.surface.pwa',
    other: 'analyticsPage.surfaces.surface.other',
  },
  form: {
    mobile: 'analyticsPage.surfaces.form.mobile',
    tablet: 'analyticsPage.surfaces.form.tablet',
    desktop: 'analyticsPage.surfaces.form.desktop',
    other: 'analyticsPage.surfaces.form.other',
  },
  os: {
    ios: 'analyticsPage.surfaces.os.ios',
    android: 'analyticsPage.surfaces.os.android',
    windows: 'analyticsPage.surfaces.os.windows',
    macos: 'analyticsPage.surfaces.os.macos',
    linux: 'analyticsPage.surfaces.os.linux',
    other: 'analyticsPage.surfaces.os.other',
    [PWA_INSTALL_OS_UNKNOWN]: 'analyticsPage.surfaces.os.unknown',
  },
}

export interface SurfaceSlice {
  readonly key: string
  /** The legend's words; also what the tooltip names the slice by. */
  readonly name: string
  readonly count: number
  readonly color: string
}

/**
 * The slices of one ring, in the order they are drawn and listed: the named
 * categories largest first, then the neutral ones — "Другое", an unrecorded OS,
 * a value this page has no words for yet — so the grey never sits between two
 * colours it could be mistaken for part of.
 */
export function surfaceSlices(
  dimension: SurfaceDimension,
  rows: readonly SurfaceCount[],
  translate: (key: string) => string,
): SurfaceSlice[] {
  const named = SURFACE_CATEGORY_COLORS[dimension]
  return rows
    .filter((row) => row.count > 0)
    .map((row, position) => ({ row, position, neutral: !Object.hasOwn(named, row.key) }))
    .sort((a, b) => Number(a.neutral) - Number(b.neutral) || b.row.count - a.row.count || a.position - b.position)
    .map(({ row }) => {
      const labelKey = Object.hasOwn(SURFACE_LABEL_KEYS[dimension], row.key)
        ? SURFACE_LABEL_KEYS[dimension][row.key]
        : undefined
      return {
        key: row.key,
        name: labelKey === undefined ? row.key : translate(labelKey),
        count: row.count,
        color: surfaceCategoryColor(dimension, row.key),
      }
    })
}

/**
 * The size of the total in a ring's hole, chosen by the number the count ENDS
 * on — not the one it is passing through, or the text would change size
 * mid-count. The hole is 70% of 7rem across; «270 539» in the panel's widest
 * theme font (IBM Plex Mono) overran it at text-lg.
 */
export function surfaceHoleTextClass(formatted: string): string {
  if (formatted.length <= 5) return 'text-lg'
  if (formatted.length <= 7) return 'text-sm'
  return 'text-xs'
}

/**
 * A slice's share of its ring, e.g. «63 %».
 *
 * BOTH ENDS ARE GUARDED, and for the same reason: whole percents are too coarse
 * at the ends of the scale and print a share that contradicts the ring beside
 * them. Rounded to whole percents a slice that is there reads «0 %», and the
 * one beside it — 9 960 of 10 000 — reads «100 %» next to «Браузер 0,3 %», as
 * if the browser were outside the total. So the last percent at either end is
 * written with one decimal, and inside a tenth of a percent of the end with
 * «<» or «>»: «<0,1 %» and «>99,9 %» are true of every share in those
 * slivers, where «0,0 %» and «100,0 %» are not.
 */
export function formatSurfaceShare(count: number, total: number, locale: string): string {
  if (total <= 0) return new Intl.NumberFormat(locale, { style: 'percent' }).format(0)
  const share = count / total
  if (share > 0 && share < 0.01) {
    const edge = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 })
    return share < 0.001 ? `<${edge.format(0.001)}` : edge.format(share)
  }
  if (share > 0.99 && share < 1) {
    const edge = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 })
    return share > 0.999 ? `>${edge.format(0.999)}` : edge.format(share)
  }
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(share)
}
