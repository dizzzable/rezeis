/**
 * The words and numbers a usage ring is built from: which category gets which
 * label, in what order the slices come, how a share is written, and whether
 * every value the cabinet can report has words at all.
 *
 * Label keys are spelled out in `SURFACE_LABEL_KEYS` so that this file can hold
 * them to both dictionaries: a key that exists in neither language passes the
 * bundle parity check (both sides equally empty) and prints its own path on the
 * page. And the values are read off the cabinet report's clamp in the backend,
 * so an OS the clamp starts writing is a red test here rather than
 * `analyticsPage.surfaces.os.chromeos` in front of an operator.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { en as core } from '@/i18n/en'
import { ru as coreRu } from '@/i18n/ru'
import { en } from '@/i18n/features/analytics.en'
import { ru } from '@/i18n/features/analytics.ru'
import { valueAt } from '@/test/i18n-key-paths'

import { PWA_INSTALL_OS_UNKNOWN, SURFACE_CATEGORY_COLORS } from './surface-palette'
import { formatSurfaceShare, SURFACE_LABEL_KEYS, surfaceHoleTextClass, surfaceSlices } from './surface-slices'

const HERE = dirname(fileURLToPath(import.meta.url))
const backend = (relative: string): string => readFileSync(resolve(HERE, '../../../../src', relative), 'utf8')

/** The string literals inside one top-level function of a backend file. */
function literalsOf(source: string, fn: string): string[] {
  const start = source.indexOf(`function ${fn}(`)
  if (start === -1) throw new Error(`${fn} is gone from the backend — find where the value is clamped now`)
  const end = source.indexOf('\n}', start)
  return [...source.slice(start, end).matchAll(/'([a-z]+)'/g)].map((match) => match[1] as string)
}

describe('every value the cabinet can report has words, in both languages', () => {
  const edge = backend('modules/internal-user/services/internal-user-edge.service.ts')
  const WRITTEN = {
    surface: literalsOf(edge, 'normalizeSurface'),
    form: literalsOf(edge, 'normalizeFormFactor'),
    os: literalsOf(edge, 'normalizeOs'),
  } as const

  it('reads the clamp it is checked against', () => {
    // Anchors: an empty extraction would make the next case agree with nothing.
    expect(new Set(WRITTEN.surface)).toEqual(new Set(['tma', 'pwa', 'browser']))
    expect(new Set(WRITTEN.form)).toEqual(new Set(['mobile', 'tablet', 'desktop']))
    expect(new Set(WRITTEN.os)).toEqual(new Set(['ios', 'android', 'windows', 'macos', 'linux', 'other']))
  })

  it('labels each of them, and "other" — what the report says for a customer with no value — and an unrecorded OS', () => {
    // The report groups by the three columns and calls a customer with no
    // value in one of them «other» — the key this page must have words for.
    const report = backend('modules/business-analytics/utils/usage-surface-report.util.ts')
    expect(report).toContain("const key = row.key ?? 'other';")
    for (const column of ['last_surface', 'last_form_factor', 'last_os']) {
      expect(report, column).toContain(`"${column}"`)
    }

    for (const [dimension, values] of Object.entries(WRITTEN)) {
      const labelled = Object.keys(SURFACE_LABEL_KEYS[dimension as keyof typeof WRITTEN])
      for (const value of [...values, 'other']) expect(labelled, `${dimension}.${value}`).toContain(value)
    }
    expect(Object.keys(SURFACE_LABEL_KEYS.os)).toContain(PWA_INSTALL_OS_UNKNOWN)
  })

  it('finds every label key, and every key the card prints, in the Russian and the English bundle', () => {
    const keys = [
      ...Object.values(SURFACE_LABEL_KEYS).flatMap((named) => Object.values(named)),
      ...['title', 'about', 'aboutLabel', 'tracked', 'active30d', 'pwaInstalls', 'lastVisit', 'unavailable', 'empty', 'emptyInstalls', 'pwaAbout', 'pwaAboutLabel']
        .map((key) => `analyticsPage.surfaces.${key}`),
      ...['surface', 'form', 'os', 'pwa'].map((panel) => `analyticsPage.surfaces.panels.${panel}`),
    ]
    expect(keys).toHaveLength(15 + 12 + 4)
    const missing = keys.flatMap((key) => [
      ...(typeof valueAt(ru, key) === 'string' ? [] : [`ru: ${key}`]),
      ...(typeof valueAt(en, key) === 'string' ? [] : [`en: ${key}`]),
    ])
    expect(missing).toEqual([])
  })

  it('writes the Russian copy in Russian', () => {
    // Brand names (Mini App, iOS, PWA) are the same in both; prose is not.
    const prose = ['about', 'lastVisit', 'unavailable', 'empty', 'emptyInstalls', 'pwaAbout', 'panels.surface', 'panels.form', 'panels.pwa', 'os.unknown', 'form.mobile']
    for (const key of prose) {
      const [russian, english] = [valueAt(ru, `analyticsPage.surfaces.${key}`), valueAt(en, `analyticsPage.surfaces.${key}`)]
      expect(russian, key).not.toBe(english)
      expect(String(russian), key).toMatch(/[а-яё]/i)
    }
  })

  it('scopes «каждый клиент учтён один раз — по последнему заходу» to the three rings it is true of', () => {
    // It is not true of «Установки PWA по ОС», which counts the customers who
    // installed the app, by the OS of the install — a different question, and
    // one the sentence used to answer wrongly for the whole card.
    for (const [language, bundle] of [['ru', ru], ['en', en]] as const) {
      const about = String(valueAt(bundle, 'analyticsPage.surfaces.about'))
      const panels = bundle.analyticsPage.surfaces.panels
      for (const ring of ['surface', 'form', 'os'] as const) {
        expect(about, `${language}: names «${panels[ring]}»`).toContain(panels[ring])
      }
      expect(about, `${language}: names «${panels.pwa}» apart`).toContain(panels.pwa)
      expect(about.indexOf(panels.pwa), language).toBeGreaterThan(about.indexOf(panels.surface))
    }
  })

  it('names only screens that exist under those very words', () => {
    // The installs note sends the operator to the audit log for the record.
    expect(ru.analyticsPage.surfaces.pwaAbout).toContain('«Журнал аудита»')
    expect(coreRu.adminNav.items.audit).toBe('Журнал аудита')
    expect(coreRu.auditPage.title).toBe('Журнал аудита')
    expect(en.analyticsPage.surfaces.pwaAbout).toContain('"Audit log"')
    expect(core.adminNav.items.audit).toBe('Audit log')
    expect(core.auditPage.title).toBe('Audit log')
  })
})

describe('the slices of a ring', () => {
  const words = (key: string): string => `«${key}»`

  it('come largest first, the neutral buckets after every category whatever their size, empty rows dropped', () => {
    const slices = surfaceSlices(
      'os',
      [
        { key: 'unknown', count: 9 },
        { key: 'android', count: 3 },
        { key: 'other', count: 5 },
        { key: 'ios', count: 7 },
        { key: 'linux', count: 0 },
        { key: 'harmonyos', count: 4 },
      ],
      words,
    )
    expect(slices.map((slice) => [slice.key, slice.count])).toEqual([
      ['ios', 7],
      ['android', 3],
      ['unknown', 9],
      ['other', 5],
      ['harmonyos', 4],
    ])
  })

  it('keeps the report’s order between two of the same size', () => {
    const slices = surfaceSlices('form', [{ key: 'tablet', count: 2 }, { key: 'mobile', count: 2 }], words)
    expect(slices.map((slice) => slice.key)).toEqual(['tablet', 'mobile'])
  })

  it('names a category by its dictionary key and a value it has no words for by the value itself', () => {
    const slices = surfaceSlices('os', [{ key: 'ios', count: 2 }, { key: 'harmonyos', count: 1 }], words)
    expect(slices.map((slice) => slice.name)).toEqual(['«analyticsPage.surfaces.os.ios»', 'harmonyos'])
    expect(slices[0]?.color).toBe(SURFACE_CATEGORY_COLORS.os.ios)
  })
})

describe('a share', () => {
  it('is a whole percent, in the interface’s language', () => {
    expect(formatSurfaceShare(30, 48, 'ru-RU')).toBe(new Intl.NumberFormat('ru-RU', { style: 'percent' }).format(0.63))
    expect(formatSurfaceShare(30, 48, 'en-US')).toBe('63%')
    expect(formatSurfaceShare(48, 48, 'en-US')).toBe('100%')
  })

  it('never reads 0% for a slice that is there', () => {
    expect(formatSurfaceShare(3, 1000, 'en-US')).toBe('0.3%')
    expect(formatSurfaceShare(1, 5000, 'en-US')).toBe('<0.1%')
    expect(formatSurfaceShare(0, 0, 'en-US')).toBe('0%')
  })

  it('never reads 100% while there is another slice beside it', () => {
    // 9 960 of 10 000 rounded to «100 %» next to «Браузер 0,3 %» read as if the
    // browser users were outside the total. Both ends of the scale are written
    // the same way, so the numbers of one ring always add up on the page.
    const oneDecimal = (value: number): string =>
      new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 1 }).format(value)
    expect(formatSurfaceShare(9_960, 10_000, 'ru-RU')).toBe(oneDecimal(0.996))
    expect(formatSurfaceShare(9_960, 10_000, 'en-US')).toBe('99.6%')
    expect(formatSurfaceShare(9_999, 10_000, 'en-US')).toBe('>99.9%')
    expect(formatSurfaceShare(30, 10_000, 'en-US')).toBe('0.3%')
    // A ring with nothing else in it does read 100%, because it is.
    expect(formatSurfaceShare(48, 48, 'en-US')).toBe('100%')
  })
})

describe('the number in a ring’s hole', () => {
  it('is sized by the number it ends on, small enough for six digits to stay inside', () => {
    expect(surfaceHoleTextClass('48')).toBe('text-lg')
    expect(surfaceHoleTextClass('9 999')).toBe('text-lg')
    expect(surfaceHoleTextClass('270 539')).toBe('text-sm')
    expect(surfaceHoleTextClass('1 270 539')).toBe('text-xs')
  })
})
