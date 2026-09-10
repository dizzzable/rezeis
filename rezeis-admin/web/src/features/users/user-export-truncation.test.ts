import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createInstance, type i18n as I18nInstance } from 'i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { downloadCsv } from '@/features/partners/csv-download'
import { en } from '@/i18n/en'
import { ru } from '@/i18n/ru'

/**
 * THE HALF THE DIALOG'S OWN SPEC CANNOT SEE.
 *
 * `user-export-dialog.test.tsx` mocks `downloadCsv` outright, so it proves what
 * the dialog does with a truncation flag and nothing at all about where that
 * flag comes from. The flag comes from a RESPONSE HEADER, and the download
 * helper used to discard the response the moment the blob was built — so
 * `X-Export-Truncated` was set by the server on every export, travelled the
 * wire, and was read by nobody.
 *
 * That is the failure this file guards: not "the alert renders" but "the header
 * survives the download".
 */

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }))

const { api } = await import('@/lib/api')

function respondWith(headers: Record<string, string>): void {
  vi.mocked(api.get).mockResolvedValue({
    data: new ArrayBuffer(8),
    headers,
    status: 200,
    statusText: 'OK',
    config: {},
  } as never)
}

describe('what a CSV download reports back', () => {
  beforeEach(() => {
    // jsdom implements neither, and the helper calls both around the anchor.
    URL.createObjectURL = vi.fn(() => 'blob:test')
    URL.revokeObjectURL = vi.fn()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('carries the truncation header out of the response', async () => {
    respondWith({ 'x-export-truncated': 'true', 'x-export-row-count': '20000' })

    const result = await downloadCsv({ path: '/admin/users/export/users.csv', filename: 'a.csv' })

    expect(result.truncated).toBe(true)
    expect(result.rowCount).toBe(20000)
  })

  it('does not read the string "false" as a truth', async () => {
    // The trap this codebase has already paid for once: `Boolean('false')` is
    // `true`, and a header is a string like any other. Getting this wrong warns
    // on every complete export, which trains the operator to ignore the warning
    // that matters.
    respondWith({ 'x-export-truncated': 'false', 'x-export-row-count': '12' })

    const result = await downloadCsv({ path: '/admin/users/export/users.csv', filename: 'a.csv' })

    expect(result.truncated).toBe(false)
    expect(result.rowCount).toBe(12)
  })

  it('reports no row count rather than zero when the endpoint sends none', async () => {
    // The partners exports share this helper and send neither header. A `0`
    // there is a claim about a file — "it holds no rows" — that nothing has
    // made.
    respondWith({})

    const result = await downloadCsv({ path: '/admin/partners/export.csv', filename: 'p.csv' })

    expect(result.truncated).toBe(false)
    expect(result.rowCount).toBeNull()
  })

  it('still saves the file', async () => {
    // The return value is an addition, not a replacement: the whole point of
    // the helper is the save dialog, and a refactor that reads headers and
    // forgets to click the anchor downloads nothing at all.
    respondWith({ 'x-export-truncated': 'true', 'x-export-row-count': '5' })
    const clicks: string[] = []
    const realCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const node = realCreate(tag)
      if (tag === 'a') node.addEventListener('click', () => clicks.push('clicked'))
      return node
    })

    await downloadCsv({ path: '/admin/users/export/users.csv', filename: 'a.csv' })

    expect(clicks).toEqual(['clicked'])
    vi.mocked(document.createElement).mockRestore()
  })
})

describe('the truncation sentences the operator reads', () => {
  /**
   * THERE USED TO BE A BRIDGE HERE.
   *
   * `user-export-truncation.ts` held both sentences as constants and fed them
   * to `t()` as i18next's `defaultValue`, picking the language off
   * `i18n.language` by hand — only because the dictionaries were owned by
   * another change in flight. The keys are in `i18n/{en,ru}.ts` now and the
   * bridge is deleted, so nothing stands between the operator and a red box
   * reading `usersPage.export.truncatedWarning` except this suite.
   *
   * None of it pins a sentence to itself. Each check reads the CALL SITE out
   * of `user-export-dialog.tsx` and then asks the real dictionaries whether
   * they can answer what it asks for.
   */

  const HERE = dirname(fileURLToPath(import.meta.url))
  const DIALOG = readFileSync(resolve(HERE, 'user-export-dialog.tsx'), 'utf8')

  /**
   * `t('usersPage.export.truncatedRows', { rows: … })` → `truncatedRows` and
   * the option names it fills in. The options object is read as source text on
   * purpose: what matters is the NAME the call site passes, and a name is the
   * one thing i18next changes its behaviour on (see the plural check below).
   */
  const CALL_SITES = new Map<string, readonly string[]>(
    Array.from(
      DIALOG.matchAll(/\bt\('usersPage\.export\.(truncated\w+)'(?:,\s*\{([^}]*)\})?\)/g),
      (match): [string, readonly string[]] => [
        match[1],
        Array.from((match[2] ?? '').matchAll(/^\s*(\w+)\s*:/gm), (option) => option[1]).sort(),
      ],
    ),
  )

  type Dict = Record<string, unknown>

  /** `usersPage.export` out of a bundle, as a bag of keys. */
  function exportBlock(bundle: unknown): Dict {
    return ((bundle as Dict)['usersPage'] as Dict)['export'] as Dict
  }

  /** `'Rows in the downloaded file: {{rows}}.'` → `['rows']`. */
  function placeholders(sentence: string): readonly string[] {
    return [...new Set(Array.from(sentence.matchAll(/\{\{(\w+)\}\}/g), (m) => m[1]))].sort()
  }

  /**
   * A real i18next over the real bundles — resolution is its job, not ours.
   *
   * `fallbackLng: false` deliberately: the app falls back to English, which
   * means a Russian key that never landed shows an English sentence and no
   * failure anywhere. Here each language has to answer for itself.
   */
  function instance(lng: 'en' | 'ru'): I18nInstance {
    const i18n = createInstance()
    void i18n.init({
      lng,
      fallbackLng: false,
      resources: {
        en: { translation: en as unknown as Record<string, unknown> },
        ru: { translation: ru as unknown as Record<string, unknown> },
      },
      interpolation: { escapeValue: false },
    })
    return i18n
  }

  const BUNDLES = [
    { lng: 'en' as const, bundle: en as unknown },
    { lng: 'ru' as const, bundle: ru as unknown },
  ]

  it('found both call sites in the dialog at all', () => {
    // Anti-emptiness anchor. A rename over there, or a refactor that moved the
    // `t()` call onto a variable, would leave every loop below iterating
    // nothing — which is this file agreeing that zero sentences are correct.
    expect([...CALL_SITES.keys()].sort()).toEqual(['truncatedRows', 'truncatedWarning'])
  })

  it('answers every key in both languages, never with the key path', () => {
    // The raw key path IS how a missing translation reaches an operator in
    // this app, and it reaches them inside a red alert that is supposed to be
    // explaining that their spreadsheet is short.
    for (const { lng } of BUNDLES) {
      const i18n = instance(lng)
      for (const [key, vars] of CALL_SITES) {
        const filled = Object.fromEntries(vars.map((name) => [name, '20 000']))
        const rendered = i18n.t(`usersPage.export.${key}`, filled)
        expect(rendered, `${lng}: ${key}`).not.toMatch(/usersPage\.export\./)
        expect(rendered.length, `${lng}: ${key} is empty`).toBeGreaterThan(10)
      }
    }
  })

  it('carries exactly the placeholders the call site fills in', () => {
    // Both directions. A translation that drops `{{rows}}` renders a sentence
    // with the number missing — "Строк в скачанном файле: ." — and one that
    // invents a placeholder renders the braces literally.
    for (const [key, vars] of CALL_SITES) {
      for (const { lng, bundle } of BUNDLES) {
        const sentence = exportBlock(bundle)[key]
        expect(typeof sentence, `${lng}: ${key} is not a string`).toBe('string')
        expect(placeholders(sentence as string), `${lng}: ${key}`).toEqual([...vars])
      }
    }
  })

  it('interpolates rows, not count, so there is no plural ladder to get wrong', () => {
    // i18next pluralises on a variable NAMED `count` and on nothing else.
    // `rows` therefore has exactly one form per language, which is what the
    // bundles carry — and it is the right call twice over, because the number
    // is already a locale-formatted STRING ("20 000") by the time it gets
    // here, and a plural rule cannot agree with a string.
    //
    // If this assertion ever fails because the call site renamed `rows` to
    // `count`, that rename is not finished: Russian then needs a full
    // `_one`/`_few`/`_many`/`_other` ladder here with the noun agreed
    // ("1 строка" / "2 строки" / "5 строк"), and `toLocaleString` has to stop
    // running before `t()` does.
    expect(CALL_SITES.get('truncatedRows')).toEqual(['rows'])
    for (const { lng, bundle } of BUNDLES) {
      const forms = Object.keys(exportBlock(bundle))
        .filter((key) => key.startsWith('truncatedRows'))
        .sort()
      expect(forms, `${lng}: truncatedRows grew plural forms nothing selects`).toEqual([
        'truncatedRows',
      ])
    }
  })
})
