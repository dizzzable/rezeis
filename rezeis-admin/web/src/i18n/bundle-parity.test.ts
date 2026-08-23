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
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { keyPaths, valueAt } from '@/test/i18n-key-paths'

import { en as coreEn } from './en'
import { ru as coreRu } from './ru'
import { en as advertisingEn } from './features/advertising.en'
import { ru as advertisingRu } from './features/advertising.ru'
import { en as analyticsEn } from './features/analytics.en'
import { ru as analyticsRu } from './features/analytics.ru'
import { en as appearanceEn } from './features/appearance.en'
import { ru as appearanceRu } from './features/appearance.ru'
import { en as automationsEn } from './features/automations.en'
import { ru as automationsRu } from './features/automations.ru'
import { en as botMapEn } from './features/botMap.en'
import { ru as botMapRu } from './features/botMap.ru'
import { en as brandingEn } from './features/branding.en'
import { ru as brandingRu } from './features/branding.ru'
import { en as broadcastEn } from './features/broadcast.en'
import { ru as broadcastRu } from './features/broadcast.ru'
import { en as dashboardEn } from './features/dashboard.en'
import { ru as dashboardRu } from './features/dashboard.ru'
import { en as importsEn } from './features/imports.en'
import { ru as importsRu } from './features/imports.ru'
import { en as landingBuilderEn } from './features/landingBuilder.en'
import { ru as landingBuilderRu } from './features/landingBuilder.ru'
import { en as legalDocumentsEn } from './features/legalDocuments.en'
import { ru as legalDocumentsRu } from './features/legalDocuments.ru'
import { en as notificationsEn } from './features/notifications.en'
import { ru as notificationsRu } from './features/notifications.ru'
import { en as panelLinkReconciliationEn } from './features/panelLinkReconciliation.en'
import { ru as panelLinkReconciliationRu } from './features/panelLinkReconciliation.ru'
import { en as paymentsEn } from './features/payments.en'
import { ru as paymentsRu } from './features/payments.ru'
import { en as platformSettingsEn } from './features/platformSettings.en'
import { ru as platformSettingsRu } from './features/platformSettings.ru'
import { en as remnawaveEn } from './features/remnawave.en'
import { ru as remnawaveRu } from './features/remnawave.ru'
import { en as subpageConfigEn } from './features/subpageConfig.en'
import { ru as subpageConfigRu } from './features/subpageConfig.ru'
import { en as twoFactorEn } from './features/twoFactor.en'
import { ru as twoFactorRu } from './features/twoFactor.ru'
import { en as userDetailEn } from './features/userDetail.en'
import { ru as userDetailRu } from './features/userDetail.ru'

/**
 * ENUMERATED, and checked against the disk.
 * ─────────────────────────────────────────
 * This list used to name three pairs while fifteen more went unchecked, and
 * neither of the two obvious repairs is safe on its own:
 *
 *   • A hand-list silently omits whatever nobody remembers to add. That was
 *     the bug — `payments`, `notifications`, `platformSettings` and a dozen
 *     others were never compared.
 *   • A `import.meta.glob` discovery removes that, and adds a worse failure:
 *     a subtly wrong pattern — wrong directory, unexpected filename shape —
 *     matches NOTHING, `describe.each([])` registers zero suites, and the file
 *     passes having compared nothing at all. Invisible, and green.
 *
 * So: the pairs are enumerated explicitly, where a reader can see them and a
 * reviewer can see one missing, AND `the enumeration is complete` below scans
 * the directory and fails by name when the two disagree in either direction.
 * A new bundle is then a named failure rather than something quietly covered
 * or quietly skipped.
 *
 * `branding` is included here even though `features/branding-bundle.test.ts`
 * checks it as well. The duplicate costs one extra traversal; the alternative
 * is an exclusion list, and an exclusion list is the same object as the
 * hand-list this file just stopped being. There are no exceptions to the
 * completeness rule, deliberately.
 */
const PAIRS = [
  { name: 'i18n/{en,ru}.ts', en: coreEn as unknown, ru: coreRu as unknown },
  { name: 'features/advertising.{en,ru}.ts', en: advertisingEn as unknown, ru: advertisingRu as unknown },
  { name: 'features/analytics.{en,ru}.ts', en: analyticsEn as unknown, ru: analyticsRu as unknown },
  { name: 'features/appearance.{en,ru}.ts', en: appearanceEn as unknown, ru: appearanceRu as unknown },
  { name: 'features/automations.{en,ru}.ts', en: automationsEn as unknown, ru: automationsRu as unknown },
  { name: 'features/botMap.{en,ru}.ts', en: botMapEn as unknown, ru: botMapRu as unknown },
  { name: 'features/branding.{en,ru}.ts', en: brandingEn as unknown, ru: brandingRu as unknown },
  { name: 'features/broadcast.{en,ru}.ts', en: broadcastEn as unknown, ru: broadcastRu as unknown },
  { name: 'features/dashboard.{en,ru}.ts', en: dashboardEn as unknown, ru: dashboardRu as unknown },
  { name: 'features/imports.{en,ru}.ts', en: importsEn as unknown, ru: importsRu as unknown },
  { name: 'features/landingBuilder.{en,ru}.ts', en: landingBuilderEn as unknown, ru: landingBuilderRu as unknown },
  { name: 'features/legalDocuments.{en,ru}.ts', en: legalDocumentsEn as unknown, ru: legalDocumentsRu as unknown },
  { name: 'features/notifications.{en,ru}.ts', en: notificationsEn as unknown, ru: notificationsRu as unknown },
  { name: 'features/panelLinkReconciliation.{en,ru}.ts', en: panelLinkReconciliationEn as unknown, ru: panelLinkReconciliationRu as unknown },
  { name: 'features/payments.{en,ru}.ts', en: paymentsEn as unknown, ru: paymentsRu as unknown },
  { name: 'features/platformSettings.{en,ru}.ts', en: platformSettingsEn as unknown, ru: platformSettingsRu as unknown },
  { name: 'features/remnawave.{en,ru}.ts', en: remnawaveEn as unknown, ru: remnawaveRu as unknown },
  { name: 'features/subpageConfig.{en,ru}.ts', en: subpageConfigEn as unknown, ru: subpageConfigRu as unknown },
  { name: 'features/twoFactor.{en,ru}.ts', en: twoFactorEn as unknown, ru: twoFactorRu as unknown },
  { name: 'features/userDetail.{en,ru}.ts', en: userDetailEn as unknown, ru: userDetailRu as unknown },
] as const

/** Directory the completeness check scans. */
const FEATURES_DIR = join(__dirname, 'features')

/** Bundle names on disk for one language, straight from the filesystem. */
function namesOnDisk(suffix: '.en.ts' | '.ru.ts'): string[] {
  return readdirSync(FEATURES_DIR)
    .filter((file) => file.endsWith(suffix))
    .map((file) => file.slice(0, -suffix.length))
    .sort()
}

/** `features/payments.{en,ru}.ts` -> `payments`; the core pair -> null. */
function enumeratedName(pairName: string): string | null {
  const match = /^features\/(.+)\.\{en,ru\}\.ts$/.exec(pairName)
  return match === null ? null : match[1]
}

/**
 * Divergences that are known, deliberate, and NOT to be silently equalised.
 *
 * Every entry names the exact leaf path, so a second divergence in the same
 * bundle still fails. `no stale exemptions` below asserts each one is still
 * live: when the underlying file is fixed the exemption fails and has to be
 * deleted, which is the only thing stopping this list from becoming the
 * hand-list this file just got rid of.
 *
 * Both entries were found by extending the check to all eighteen bundles on
 * 2026-08-21, and each was classified by rendering it through the real i18next
 * instance rather than by reading the source.
 */
interface KnownDivergence {
  /** Leaves that exist in one language only. */
  readonly keyOnlyIn?: readonly string[]
  /** Leaves that exist in both but whose `{{...}}` sets differ. */
  readonly placeholders?: readonly string[]
  readonly why: string
}

const KNOWN_DIVERGENCES: Readonly<Record<string, KnownDivergence>> = {
  'features/notifications.{en,ru}.ts': {
    placeholders: [
      'notificationsPage.templates.description',
      'notificationsPage.templates.bodyLabel',
    ],
    why:
      'NOT an interpolation contract, so the placeholder rule does not apply. These two ' +
      'strings document the syntax of the NOTIFICATION TEMPLATE the operator types, not ' +
      'values `t()` substitutes: English says "Use {{variable}} for dynamic content", ' +
      'Russian says "{{peremennaya}}" in Cyrillic. Neither is ever interpolated - i18next ' +
      'leaves an unmatched placeholder verbatim, which is exactly what the sibling key ' +
      '`bodyHint` relies on when it prints the REAL variable names ({{planName}}, ' +
      '{{expireAt}}, ...), and those the Russian side correctly does not translate. ' +
      'Equalising these would un-translate operator-facing prose to satisfy a rule about a ' +
      'different template language. Lives in i18n/features/notifications.*, not this file.',
  },
  'features/platformSettings.{en,ru}.ts': {
    keyOnlyIn: [
      'settings.apiTokens.tokensCount_other',
      'settings.apiTokens.tokensCount_one',
    ],
    why:
      'The two languages spell the singular differently: English uses the bare key ' +
      '(`tokensCount: "{{count}} token"`) plus `_other`, the JSON-v3 form; Russian uses ' +
      '`_one`/`_few`/`_many` and leaves its own bare key dead. Verified through the real ' +
      'i18next instance: BOTH render correctly at counts 0/1/2/5/21, because i18next still ' +
      'falls back to the bare key for the singular. A latent hazard rather than a live ' +
      'defect - it breaks the day `compatibilityJSON` is pinned to v4. Reported rather ' +
      'than equalised: the fix is to give English `tokensCount_one` and drop both bare ' +
      'keys, in i18n/features/platformSettings.*, not this file.',
  },
}

function exempt(pairName: string, kind: keyof Omit<KnownDivergence, 'why'>): readonly string[] {
  return KNOWN_DIVERGENCES[pairName]?.[kind] ?? []
}

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

describe.each(PAIRS)('$name', ({ name, en, ru }) => {
  const enKeys = keyPaths(en).sort()
  const ruKeys = keyPaths(ru).sort()
  const enSet = new Set(enKeys)
  const ruSet = new Set(ruKeys)
  const exemptKeys = new Set(exempt(name, 'keyOnlyIn'))
  const exemptPlaceholders = new Set(exempt(name, 'placeholders'))

  it('has no English key the Russian dictionary is missing', () => {
    expect(enKeys.filter((key) => !ruSet.has(key) && !exemptKeys.has(key))).toEqual([])
  })

  it('has no Russian key beyond the English one, except CLDR plural forms', () => {
    const extras = ruKeys.filter((key) => !enSet.has(key) && !exemptKeys.has(key))
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
      .filter((key) => ruSet.has(key) && !exemptPlaceholders.has(key))
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

describe('the enumeration is complete', () => {
  // Everything in this block runs OUTSIDE `describe.each`, so it still runs
  // when `PAIRS` is empty — which is the whole point. A check that lived
  // inside `describe.each` would vanish along with the coverage it was meant
  // to vouch for.
  const enOnDisk = namesOnDisk('.en.ts')
  const ruOnDisk = namesOnDisk('.ru.ts')
  const enumerated = PAIRS.map((pair) => enumeratedName(pair.name))
    .filter((name): name is string => name !== null)
    .sort()

  it('scanned a directory that actually has bundles in it', () => {
    // The anchor. Without it every `toEqual` below is satisfied by two empty
    // sets, and a wrong `FEATURES_DIR` would read as "nothing to check".
    expect(enOnDisk.length).toBeGreaterThan(0)
    expect(ruOnDisk.length).toBeGreaterThan(0)
    expect(enumerated.length).toBe(enOnDisk.length)
  })

  it('covers every English bundle that has a Russian sibling', () => {
    const ruSet = new Set(ruOnDisk)
    const enumeratedSet = new Set(enumerated)
    const uncovered = enOnDisk.filter((name) => ruSet.has(name) && !enumeratedSet.has(name))
    // Names, not a count: the failure has to say WHICH bundle to add.
    expect(uncovered).toEqual([])
  })

  it('enumerates nothing that is not on disk', () => {
    const enSet = new Set(enOnDisk)
    const ruSet = new Set(ruOnDisk)
    expect(enumerated.filter((name) => !enSet.has(name) || !ruSet.has(name))).toEqual([])
  })

  it('has no bundle translated into one language only', () => {
    // An unpaired bundle is a defect in its own right, and it is the one shape
    // the pair-wise checks above cannot see: with no counterpart there is
    // nothing to compare it against, so it would simply go uncovered.
    const enSet = new Set(enOnDisk)
    const ruSet = new Set(ruOnDisk)
    expect(enOnDisk.filter((name) => !ruSet.has(name))).toEqual([])
    expect(ruOnDisk.filter((name) => !enSet.has(name))).toEqual([])
  })
})

describe('the parity check itself', () => {
  // Without this, a `keyPaths` that returned `[]` — or a pair wired to the same
  // object twice — would make every assertion above pass on an empty set.
  // The floor is per-pair and deliberately low: `legalDocuments` has 19 leaves,
  // so a floor tuned to the big dictionaries would have to exempt it, and an
  // exemption is what this file is trying to stop being made of.
  it('is actually reading every pair', () => {
    expect(PAIRS.length).toBeGreaterThan(1)
    for (const pair of PAIRS) {
      expect(keyPaths(pair.en).length, `${pair.name} (en)`).toBeGreaterThan(5)
      expect(keyPaths(pair.ru).length, `${pair.name} (ru)`).toBeGreaterThan(5)
      // A pair wired to the same object twice compares a dictionary with
      // itself and can never fail. The two sides must be distinct objects.
      expect(pair.en, pair.name).not.toBe(pair.ru)
    }
  })

  it('has no stale exemptions', () => {
    // An exemption that no longer describes a real divergence is worse than no
    // exemption: it silently widens the check's blind spot for whatever lands
    // on that key next. When the owning file is fixed, this fails and the
    // entry has to go.
    const stale: string[] = []
    for (const [pairName, divergence] of Object.entries(KNOWN_DIVERGENCES)) {
      const pair = PAIRS.find((candidate) => candidate.name === pairName)
      expect(pair, `KNOWN_DIVERGENCES names a pair that is not enumerated: ${pairName}`).toBeDefined()
      if (pair === undefined) continue
      const enSet = new Set(keyPaths(pair.en))
      const ruSet = new Set(keyPaths(pair.ru))

      for (const key of divergence.keyOnlyIn ?? []) {
        const inEn = enSet.has(key)
        const inRu = ruSet.has(key)
        // Still exactly one side? Then the exemption is still earning its
        // place. Present in both (or in neither) means it was resolved.
        if (inEn === inRu) stale.push(`${pairName} :: keyOnlyIn :: ${key}`)
      }

      for (const key of divergence.placeholders ?? []) {
        if (!enSet.has(key) || !ruSet.has(key)) {
          stale.push(`${pairName} :: placeholders :: ${key} (key no longer in both)`)
          continue
        }
        const same =
          placeholders(valueAt(pair.en, key)).join('|') ===
          placeholders(valueAt(pair.ru, key)).join('|')
        if (same) stale.push(`${pairName} :: placeholders :: ${key}`)
      }
    }
    expect(stale).toEqual([])
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
