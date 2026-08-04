import type { LocalizedText } from './landing-builder-api'

/**
 * locale-seeding
 * ──────────────
 * Adds a newly configured language to — or removes a dropped one from — every
 * localized leaf of a config subtree.
 *
 * A localized field is `{ ru: '…', en: '…' }` — a plain object keyed by locale.
 * Both directions have to reach every leaf, because everything downstream reads
 * the leaf's key set and `config.locales` as one fact; where they disagree, the
 * disagreement itself is invisible.
 *
 * Appending a language to `config.locales` without seeding those objects leaves
 * the key absent, and absence is invisible in both directions: the editor
 * renders no input for a key that is not there, so the operator cannot type the
 * translation, while publish-strict only inspects the locales present on the
 * field and therefore reports it complete. The language ships untranslated with
 * nothing anywhere saying so.
 *
 * Dropping a language from `config.locales` without dropping its entries is the
 * mirror image, and the leftover text is not inert. Publish-strict decides
 * whether a field is IN USE from `config.locales` alone, so a field written only
 * in the removed language now reads as an optional field nobody filled and
 * publish goes through — and the renderer's last-resort fallback then prints
 * that orphan on a page in a language nothing claims it is.
 */

/** True for an object whose keys are all 2-letter locale codes. */
function isLocalized(node: unknown): node is LocalizedText {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return false
  const keys = Object.keys(node)
  return keys.length > 0 && keys.every((key) => /^[a-z]{2}$/.test(key))
}

/**
 * Returns a copy of `node` with every localized leaf rewritten through `edit`,
 * arrays and nested objects preserved. Both directions share this traversal on
 * purpose: a second walk would drift from it, and a leaf one of them misses is
 * exactly the leaf that ends up disagreeing with `config.locales`.
 */
function mapLocalized(node: unknown, edit: (leaf: LocalizedText) => LocalizedText): unknown {
  if (isLocalized(node)) return edit(node)
  if (Array.isArray(node)) return node.map((item) => mapLocalized(item, edit))
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      out[key] = mapLocalized(value, edit)
    }
    return out
  }
  return node
}

/** Returns a copy with an empty entry for `locale` on every localized leaf. */
export function seedLocale(node: unknown, locale: string): unknown {
  return mapLocalized(node, (leaf) => ({ ...leaf, [locale]: leaf[locale] ?? '' }))
}

/** Returns a copy with the entry for `locale` gone from every localized leaf. */
export function dropLocale(node: unknown, locale: string): unknown {
  return mapLocalized(node, (leaf) =>
    Object.fromEntries(Object.entries(leaf).filter(([code]) => code !== locale)),
  )
}
