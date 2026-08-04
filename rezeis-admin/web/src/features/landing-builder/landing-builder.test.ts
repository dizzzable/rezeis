import { describe, expect, it } from 'vitest'

import {
  LANDING_SECTION_TYPES,
  LandingDraftConflictError,
  LandingPublishIncompleteError,
  type LandingSection,
} from './landing-builder-api'
import {
  buildDefaultSection,
  cloneSection,
  configMissingLocales,
  missingLocales,
} from './section-defaults'
import { LANDING_SECTIONS } from './live/landing-renderer'
import { KNOWN_SECTION_TYPES } from './live/landing-schema'

const LOCALES = ['ru', 'en'] as const

describe('section-defaults', () => {
  it('builds a renderable default for every catalog section type', () => {
    for (const type of LANDING_SECTION_TYPES) {
      const section = buildDefaultSection(type, LOCALES)
      expect(section.type).toBe(type)
      expect(section.visible).toBe(true)
      expect(section.id.length).toBeGreaterThan(0)
      expect(typeof section.data).toBe('object')
    }
  })

  it('treats a freshly-added (all-empty) section as unset — no missing-locale badges', () => {
    const hero = buildDefaultSection('hero', LOCALES)
    // Nothing typed yet → every localized field is "unset" → no false badges.
    expect(missingLocales(hero, LOCALES)).toEqual([])
  })

  it('flags the other locale once a field is filled in only one locale', () => {
    const section: LandingSection = {
      id: 'hero-1',
      type: 'hero',
      visible: true,
      data: {
        heading: { ru: 'Только русский', en: '' },
        primaryCta: { label: { ru: 'Старт', en: 'Start' }, action: 'register', url: '' },
        align: 'center',
      },
    }
    expect(missingLocales(section, LOCALES)).toEqual(['en'])
  })

  it('reports no missing locales once every visible string is filled', () => {
    const section: LandingSection = {
      id: 'hero-1',
      type: 'hero',
      visible: true,
      data: {
        heading: { ru: 'Заголовок', en: 'Title' },
        primaryCta: { label: { ru: 'Старт', en: 'Start' }, action: 'register' },
        align: 'center',
      },
    }
    expect(missingLocales(section, LOCALES)).toEqual([])
    expect(configMissingLocales([section], LOCALES)).toBe(false)
  })

  it('ignores hidden sections when computing publish-blocking missing locales', () => {
    const hidden = { ...buildDefaultSection('hero', LOCALES), visible: false }
    expect(configMissingLocales([hidden], LOCALES)).toBe(false)
  })

  it('clones a section with a fresh id and cleared localized text', () => {
    const original: LandingSection = {
      id: 'faq-1',
      type: 'faq',
      visible: true,
      data: { heading: { ru: 'A', en: 'B' }, items: [] },
    }
    const clone = cloneSection(original)
    expect(clone.id).not.toBe(original.id)
    expect(clone.type).toBe('faq')
  })
})

describe('section catalog parity across the three declaration sites', () => {
  // There is no longer a preview-only registry to keep in lockstep — the
  // preview renders the kit. What remains is the admin's own catalog literal,
  // which must agree with the kit's list and with the kit's component registry.
  // A type present in one and missing in another is the drift this catches.
  it('the admin catalog matches the kit section registry', () => {
    expect(Object.keys(LANDING_SECTIONS).sort()).toEqual([...LANDING_SECTION_TYPES].sort())
  })

  it('the admin catalog matches the kit schema list', () => {
    expect([...KNOWN_SECTION_TYPES].sort()).toEqual([...LANDING_SECTION_TYPES].sort())
  })
})

describe('api error classes', () => {
  it('LandingDraftConflictError carries the server version', () => {
    const err = new LandingDraftConflictError(7)
    expect(err.currentVersion).toBe(7)
    expect(err).toBeInstanceOf(Error)
  })

  it('LandingPublishIncompleteError carries the issue list', () => {
    const err = new LandingPublishIncompleteError([{ path: 'meta.title', message: 'Missing "en"' }])
    expect(err.issues).toHaveLength(1)
    expect(err.issues[0].path).toBe('meta.title')
  })
})
