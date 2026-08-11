/**
 * English/Russian parity for the dictionaries that carry operator-facing prose.
 *
 * `branding-bundle.test.ts` has checked its own bundle since the day it was
 * split out, and nothing checked the rest — including the two bundles the
 * Remnawave 3.2.x work edited most. The failure mode is silent by
 * construction: i18next falls back to `fallbackLng: 'en'` for a key the active
 * language is missing, so a half-translated edit renders English in a Russian
 * panel and nothing anywhere reports it. The reverse — a key only Russian has
 * — is worse than silent: it renders the raw key path to an English operator.
 *
 * Three things are compared per pair, because each catches a different edit:
 *   • the leaf key PATHS      — someone added a key to one language only;
 *   • the leaf value TYPE     — a string in one language, an object or an
 *                               array in the other, which crashes `t()`'s
 *                               caller rather than showing bad prose;
 *   • the `{{placeholder}}` set — the interpolation contract. A translation
 *                               that drops `{{count}}` silently renders a
 *                               sentence with a hole where the number was,
 *                               and one that invents a placeholder renders
 *                               the braces literally.
 *
 * Russian is allowed to carry `_few` / `_many` on top of the `_one` / `_other`
 * pair English has: those are CLDR plural categories Russian genuinely needs
 * and English genuinely does not. They are not waved through, though — each is
 * held to the placeholder contract of the English `_other` form it belongs to,
 * so `{{count}}` cannot go missing from the form an operator sees most.
 */
import { describe, expect, it } from 'vitest'

import { keyPaths, valueAt } from '@/test/i18n-key-paths'

import { en as coreEn } from './en'
import { ru as coreRu } from './ru'
import { en as remnawaveEn } from './features/remnawave.en'
import { ru as remnawaveRu } from './features/remnawave.ru'
import { en as userDetailEn } from './features/userDetail.en'
import { ru as userDetailRu } from './features/userDetail.ru'

const PAIRS = [
  { name: 'i18n/{en,ru}.ts', en: coreEn as unknown, ru: coreRu as unknown },
  { name: 'features/remnawave.{en,ru}.ts', en: remnawaveEn as unknown, ru: remnawaveRu as unknown },
  { name: 'features/userDetail.{en,ru}.ts', en: userDetailEn as unknown, ru: userDetailRu as unknown },
] as const

/**
 * The CLDR categories Russian has and English does not. A Russian-only key is
 * legitimate ONLY when it is one of these AND the English side carries the
 * same base key — an extra `_many` under a base English never heard of is a
 * typo, not a plural.
 */
const RU_ONLY_PLURAL_SUFFIXES = ['_few', '_many'] as const

/** `foo.bar_few` → `foo.bar_other`, or null when the key is not a RU-only plural. */
function englishPluralSibling(path: string): string | null {
  for (const suffix of RU_ONLY_PLURAL_SUFFIXES) {
    if (path.endsWith(suffix)) return `${path.slice(0, -suffix.length)}_other`
  }
  return null
}

/**
 * The interpolation contract of one string, as a sorted set.
 *
 * The name is taken up to the first comma so i18next's formatting suffix
 * (`{{count, number}}`) compares equal to the bare name — the format is a
 * per-language decision, the variable is not.
 */
function placeholders(value: unknown): string[] {
  if (typeof value !== 'string') return []
  const found = value.match(/\{\{[^}]+\}\}/g) ?? []
  const names = found.map((token) => token.slice(2, -2).split(',')[0].trim())
  return [...new Set(names)].sort()
}

function typeName(value: unknown): string {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

describe.each(PAIRS)('$name', ({ en, ru }) => {
  const enKeys = keyPaths(en).sort()
  const ruKeys = keyPaths(ru).sort()
  const enSet = new Set(enKeys)
  const ruSet = new Set(ruKeys)

  it('has no English key the Russian dictionary is missing', () => {
    expect(enKeys.filter((key) => !ruSet.has(key))).toEqual([])
  })

  it('has no Russian key beyond the English one, except CLDR plural forms', () => {
    const extras = ruKeys.filter((key) => !enSet.has(key))
    const unexplained = extras.filter((key) => {
      const sibling = englishPluralSibling(key)
      return sibling === null || !enSet.has(sibling)
    })
    expect(unexplained).toEqual([])
  })

  it('agrees on the type of every shared leaf', () => {
    const mismatched = enKeys
      .filter((key) => ruSet.has(key))
      .filter((key) => typeName(valueAt(en, key)) !== typeName(valueAt(ru, key)))
    expect(mismatched).toEqual([])
  })

  it('agrees on the placeholders of every shared leaf', () => {
    const mismatched = enKeys
      .filter((key) => ruSet.has(key))
      .filter(
        (key) =>
          placeholders(valueAt(en, key)).join('|') !== placeholders(valueAt(ru, key)).join('|'),
      )
    expect(mismatched).toEqual([])
  })

  it('keeps the placeholders on the Russian-only plural forms too', () => {
    // These have no English counterpart of their own, so the check above skips
    // them entirely — and `_few` / `_many` are exactly the forms a hurried
    // edit copies from a sibling and forgets to re-check.
    const mismatched = ruKeys
      .filter((key) => !enSet.has(key))
      .filter((key) => {
        const sibling = englishPluralSibling(key)
        if (sibling === null || !enSet.has(sibling)) return false
        return placeholders(valueAt(ru, key)).join('|') !== placeholders(valueAt(en, sibling)).join('|')
      })
    expect(mismatched).toEqual([])
  })
})

describe('the parity check itself', () => {
  // Without this, a `keyPaths` that returned `[]` — or a pair wired to the same
  // object twice — would make every assertion above pass on an empty set.
  it('is actually reading all three pairs', () => {
    for (const pair of PAIRS) {
      expect(keyPaths(pair.en).length).toBeGreaterThan(50)
      expect(keyPaths(pair.ru).length).toBeGreaterThan(50)
    }
  })

  it('fails when a key exists in one language only', () => {
    const en = { page: { title: 'Title' } }
    const ru = { page: { title: 'Заголовок', subtitle: 'Подзаголовок' } }
    const enSet = new Set(keyPaths(en))
    const extras = keyPaths(ru).filter((key) => !enSet.has(key))
    expect(extras).toEqual(['page.subtitle'])
    // …and the plural exemption does not launder it: `subtitle` is neither
    // `_few` nor `_many`.
    expect(englishPluralSibling('page.subtitle')).toBeNull()
  })

  it('fails when a translation drops an interpolated variable', () => {
    expect(placeholders('Online: {{users}} users · {{ips}} IPs')).toEqual(['ips', 'users'])
    expect(placeholders('Онлайн: {{users}} польз.')).toEqual(['users'])
  })

  it('treats a formatted placeholder as the same variable', () => {
    expect(placeholders('{{count, number}} nodes')).toEqual(placeholders('{{count}} нод'))
  })
})
