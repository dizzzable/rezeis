import { describe, expect, it } from 'vitest'

import { LANDING_SECTION_TYPES, type LandingSection } from './landing-builder-api'
import { buildDefaultSection } from './section-defaults'
import { LANDING_TEMPLATES } from './templates'

/**
 * The invariant that makes a 104-theme catalog affordable:
 *
 *   No field in `data` of any section carries a colour, font or radius.
 *
 * Presentation lives in `theme` (and only there), so switching theme is
 * non-destructive BY CONSTRUCTION and a new theme costs O(1) rather than
 * O(number of sections). The moment one section starts storing its own colour,
 * every new theme becomes a manual review of every section — which is how a
 * theme catalog turns into a regression suite.
 *
 * These tests fail loudly when someone adds a presentational field to a section
 * schema. If a section genuinely needs to vary its look, add a named slot
 * (`colorScheme: 'default' | 'muted' | 'inverse' | 'accent'`) that resolves
 * against the theme — never a raw value.
 */

const LOCALES = ['ru', 'en'] as const

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const CSS_COLOR_FN = /\b(?:rgba?|hsla?|oklch|oklab|color-mix)\s*\(/i
const RADIUS_KEYWORD = /^(?:none|sm|md|lg|xl)$/

const CSS_LENGTH = /\b\d+(?:\.\d+)?(?:px|rem|em|vh|vw)\b/i
const FONT_STACK = /\b(?:sans-serif|serif|monospace|system-ui|cursive)\b/i
const CSS_DECLARATION = /[a-z-]+\s*:\s*[^;]+/i

/**
 * A bare token like `gradient`, `outline` or `fadeUp` — a NAMED slot the theme
 * resolves, not a value of its own. These are the sanctioned way for a section
 * to vary its look (`ctaBanner.style`, `section.animation`), and the pattern the
 * planned `colorScheme` slot will follow, so they must not trip the invariant:
 * the section still holds no colour, and re-skinning stays a theme-only edit.
 */
const NAMED_VARIANT = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/i

/** Keys whose value, when it is raw CSS, means the section styles itself. */
const RAW_CSS_CARRIERS = ['classname', 'css', 'style', 'sx']

interface Violation {
  readonly path: string
  readonly reason: string
}

/** The invariant is about VALUES: a raw colour, length, font stack or declaration. */
function rawPresentationReason(value: string): string | null {
  const trimmed = value.trim()
  if (HEX.test(trimmed)) return `hex colour "${trimmed}"`
  if (CSS_COLOR_FN.test(trimmed)) return `css colour function "${trimmed}"`
  if (FONT_STACK.test(trimmed)) return `font stack "${trimmed}"`
  if (CSS_LENGTH.test(trimmed)) return `css length "${trimmed}"`
  return null
}

function collectViolations(node: unknown, path: string, out: Violation[]): void {
  if (typeof node === 'string') {
    const reason = rawPresentationReason(node)
    if (reason !== null) out.push({ path, reason })
    return
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectViolations(item, `${path}[${i}]`, out))
    return
  }
  if (node === null || typeof node !== 'object') return

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const next = path.length > 0 ? `${path}.${key}` : key
    if (
      RAW_CSS_CARRIERS.includes(key.toLowerCase()) &&
      typeof value === 'string' &&
      !NAMED_VARIANT.test(value.trim()) &&
      CSS_DECLARATION.test(value)
    ) {
      out.push({ path: next, reason: `raw css in "${key}": "${value}"` })
    }
    collectViolations(value, next, out)
  }
}

/**
 * Only `type` (for the label) and `data` are inspected. Kept structural on
 * purpose: template sections are stored without an `id` — it is minted when the
 * template is applied — so requiring a full `LandingSection` would exclude
 * exactly the shipped presets this invariant most needs to cover.
 */
function violationsOf(section: { readonly type: string; readonly data: unknown }, label: string): Violation[] {
  const out: Violation[] = []
  collectViolations(section.data, `${label}(${section.type}).data`, out)
  return out
}

describe('theme invariant — sections carry content, never presentation', () => {
  it('holds for the default of every catalog section type', () => {
    const violations = LANDING_SECTION_TYPES.flatMap((type) =>
      violationsOf(buildDefaultSection(type, LOCALES), 'default'),
    )
    expect(violations).toEqual([])
  })

  it('holds for every section of every shipped template', () => {
    const violations = LANDING_TEMPLATES.flatMap((template) =>
      template.sections.flatMap((section) => violationsOf(section, `template:${template.id}`)),
    )
    expect(violations).toEqual([])
  })

  it('keeps presentation on the theme, where a preset can replace it wholesale', () => {
    // The mirror of the invariant: the theme is where colour actually lives, so
    // a preset that patches only `theme` fully re-skins the page.
    for (const template of LANDING_TEMPLATES) {
      expect(template.theme.colors?.primary).toMatch(HEX)
      expect(template.theme.colors?.bg).toMatch(HEX)
    }
  })

  it('allows a named variant — that is how a section is meant to vary', () => {
    // `ctaBanner.style` is already 'solid' | 'gradient' | 'outline': a slot the
    // theme resolves. The planned per-section `colorScheme` will look the same,
    // and neither breaks a theme swap, so neither may be reported.
    const named = {
      ...buildDefaultSection('ctaBanner', LOCALES),
      data: {
        ...buildDefaultSection('ctaBanner', LOCALES).data,
        style: 'outline',
        colorScheme: 'inverse',
      },
    } as LandingSection
    expect(violationsOf(named, 'named')).toEqual([])
  })

  it.each([
    ['hex colour', { accentColor: '#ff0000' }],
    ['css colour function', { tint: 'rgba(255,0,0,.5)' }],
    ['font stack', { face: 'Inter, sans-serif' }],
    ['hardcoded length', { gap: '24px' }],
    ['raw css', { style: 'background: #fff; padding: 4px' }],
  ])('recognises a %s smuggled into section data', (_label, extra) => {
    // Guards the guard: a detector that silently matches nothing is worthless.
    const base = buildDefaultSection('hero', LOCALES)
    const poisoned = { ...base, data: { ...base.data, ...extra } } as LandingSection
    expect(violationsOf(poisoned, 'poisoned')).not.toEqual([])
  })
})

describe('theme radius is a theme concern', () => {
  it('every shipped template pins a radius on the theme, not on sections', () => {
    for (const template of LANDING_TEMPLATES) {
      expect(template.theme.radius).toMatch(RADIUS_KEYWORD)
    }
  })
})
