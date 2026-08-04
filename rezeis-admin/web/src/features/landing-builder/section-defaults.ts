/**
 * Safe default `data` for each section type, so a newly-added section always
 * renders and can be published once its localized strings are filled in for
 * every configured locale.
 *
 * Optional but renderable fields (hero eyebrow/subheading/secondaryCta, CTA
 * `url`, image `src`) are seeded so they are EDITABLE through the form — the
 * data-driven editor only shows keys that exist. Empty localized fields are
 * treated as "unset" by publish-strict (see `missingLocales`), so seeding them
 * blank does not force the operator to fill optional copy.
 */
import type { LandingSection, LandingSectionType, LocalizedText } from './landing-builder-api'

function emptyLocalized(locales: readonly string[]): LocalizedText {
  const map: LocalizedText = {}
  for (const locale of locales) map[locale] = ''
  return map
}

function id(type: string): string {
  return `${type}-${Math.random().toString(36).slice(2, 8)}`
}

export function buildDefaultSection(
  type: LandingSectionType,
  locales: readonly string[],
): LandingSection {
  const L = () => emptyLocalized(locales)
  const cta = (action: 'register' | 'login' | 'url' = 'register') => ({ label: L(), action, url: '' })
  const image = () => ({ src: '', alt: L() })
  const data: Record<LandingSectionType, Record<string, unknown>> = {
    hero: {
      eyebrow: L(),
      heading: L(),
      subheading: L(),
      primaryCta: cta('register'),
      secondaryCta: cta('login'),
      media: image(),
      align: 'center',
    },
    featuresGrid: { heading: L(), columns: 3, items: [{ icon: 'zap', title: L(), body: L() }] },
    howItWorks: { heading: L(), steps: [{ title: L(), body: L(), media: image() }] },
    // `staticPlans` is seeded (empty) so switching `source` to 'static' reveals
    // a usable list instead of nothing — the editor only renders keys that
    // exist. It stays hidden while `source` is 'catalog'.
    pricing: { source: 'catalog', billingToggle: false, heading: L(), staticPlans: [] },
    faq: { heading: L(), items: [{ question: L(), answer: L() }] },
    testimonials: {
      heading: L(),
      items: [{ quote: L(), author: L(), role: L(), avatar: image(), rating: 5 }],
    },
    stats: { heading: L(), items: [{ value: '', label: L() }] },
    trustLogos: { heading: L(), logos: [{ image: image(), href: '' }] },
    ctaBanner: { heading: L(), body: L(), cta: cta('register'), style: 'gradient' },
    footer: {
      columns: [{ title: L(), links: [{ label: L(), href: '' }] }],
      legal: L(),
      socials: [],
    },
  }
  return { id: id(type), type, visible: true, data: data[type] }
}

/**
 * Template for a fresh item appended to an array field, keyed by the array's
 * property name. Ensures adding an item to an initially-empty array (logos,
 * links, socials, staticPlans, features) yields editable fields rather than an
 * empty `{}`. Falls back to a deep clone of the first existing item.
 */
export function newArrayItem(
  key: string,
  locales: readonly string[],
  existing: readonly unknown[],
): unknown {
  const L = () => emptyLocalized(locales)
  switch (key) {
    case 'logos':
      return { image: { src: '', alt: L() }, href: '' }
    case 'links':
      return { label: L(), href: '' }
    case 'socials':
      return { platform: 'telegram', href: '' }
    case 'features':
      return L()
    case 'staticPlans':
      return {
        name: L(),
        priceMonthly: '',
        priceYearly: '',
        currency: 'RUB',
        badge: L(),
        highlighted: false,
        features: [],
        cta: { label: L(), action: 'register', url: '' },
      }
    case 'steps':
      return { title: L(), body: L(), media: { src: '', alt: L() } }
    case 'columns':
      return { title: L(), links: [{ label: L(), href: '' }] }
    default: {
      if (existing.length > 0) return clearLocalizedDeep(structuredClone(existing[0]))
      return {}
    }
  }
}

/** Deep-clone a section and give it a fresh id (for the duplicate action). */
export function cloneSection(section: LandingSection): LandingSection {
  const cloned = JSON.parse(JSON.stringify(section)) as LandingSection
  return { ...cloned, id: id(section.type) }
}

function isLocalized(node: unknown): node is Record<string, string> {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return false
  const keys = Object.keys(node)
  return keys.length > 0 && keys.every((k) => /^[a-z]{2}$/.test(k))
}

/** Blank out localized-text leaves in a cloned template (for the add-item fallback). */
function clearLocalizedDeep(node: unknown): unknown {
  if (isLocalized(node)) {
    const cleared: Record<string, string> = {}
    for (const k of Object.keys(node)) cleared[k] = ''
    return cleared
  }
  if (Array.isArray(node)) return node.map(clearLocalizedDeep)
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = clearLocalizedDeep(v)
    return out
  }
  return node
}

/**
 * Locales missing a value for a localized-text leaf that is IN USE. A localized
 * field left entirely blank across every configured locale is treated as
 * "unset" (an optional field the operator chose not to fill) and skipped — this
 * mirrors the backend publish-strict semantics so the UI badge and the server
 * agree. A field with a value in at least one locale must be complete in all.
 */
export function missingLocales(section: LandingSection, locales: readonly string[]): string[] {
  const missing = new Set<string>()
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    if (isLocalized(node)) {
      const map = node as Record<string, unknown>
      const inUse = locales.some((l) => typeof map[l] === 'string' && (map[l] as string).trim().length > 0)
      if (!inUse) return
      for (const locale of locales) {
        const value = map[locale]
        if (typeof value !== 'string' || value.trim().length === 0) missing.add(locale)
      }
      return
    }
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    Object.values(node as Record<string, unknown>).forEach(walk)
  }
  walk(section.data)
  return Array.from(missing)
}

export function configMissingLocales(
  sections: readonly LandingSection[],
  locales: readonly string[],
): boolean {
  return sections.some((s) => s.visible && missingLocales(s, locales).length > 0)
}
