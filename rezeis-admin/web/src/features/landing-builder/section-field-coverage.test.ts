import { describe, expect, it } from 'vitest'

import { LANDING_SECTION_TYPES, type LandingSection } from './landing-builder-api'
import { buildDefaultSection, missingLocales, newArrayItem } from './section-defaults'

/**
 * The editor is data-driven: `SectionEditor` renders a control for every key
 * that EXISTS in `section.data`, and nothing for a key that does not. An
 * optional field left unseeded is therefore not "optional" from the operator's
 * side — it is unreachable. `pricing.staticPlans`, `hero.media`,
 * `howItWorks.steps[].media` and `testimonials[].avatar` were all in that state:
 * supported by the schema, rendered in production, impossible to fill in.
 *
 * These tests pin the seeds so a future section keeps its optional fields
 * reachable, and pin the other half of the contract: seeding must not turn an
 * optional field into a publish blocker.
 */

const LOCALES = ['ru', 'en'] as const

const dataOf = (type: (typeof LANDING_SECTION_TYPES)[number]): Record<string, unknown> =>
  buildDefaultSection(type, LOCALES).data as Record<string, unknown>

describe('optional section fields are reachable through the form', () => {
  it('seeds hero media', () => {
    expect(dataOf('hero')).toHaveProperty('media')
  })

  it('seeds media on a how-it-works step', () => {
    const steps = dataOf('howItWorks').steps as Array<Record<string, unknown>>
    expect(steps[0]).toHaveProperty('media')
  })

  it('seeds role and avatar on a testimonial', () => {
    const items = dataOf('testimonials').items as Array<Record<string, unknown>>
    expect(items[0]).toHaveProperty('role')
    expect(items[0]).toHaveProperty('avatar')
  })

  it('seeds staticPlans so switching source to "static" reveals a usable list', () => {
    const pricing = dataOf('pricing')
    expect(pricing).toHaveProperty('staticPlans')
    expect(pricing.staticPlans).toEqual([])
  })

  it('gives a newly added static plan every field the schema supports', () => {
    const plan = newArrayItem('staticPlans', LOCALES, []) as Record<string, unknown>
    for (const key of ['name', 'priceMonthly', 'priceYearly', 'currency', 'badge', 'highlighted', 'features', 'cta']) {
      expect(plan, `staticPlans item is missing "${key}"`).toHaveProperty(key)
    }
  })

  it('gives a newly added step the same shape as the seeded one', () => {
    const seeded = (dataOf('howItWorks').steps as Array<Record<string, unknown>>)[0]
    const added = newArrayItem('steps', LOCALES, []) as Record<string, unknown>
    expect(Object.keys(added).sort()).toEqual(Object.keys(seeded).sort())
  })
})

describe('seeding does not create publish blockers', () => {
  it.each(LANDING_SECTION_TYPES)('a freshly added %s reports no missing locales', (type) => {
    // An all-empty localized field means "unset", not "untranslated". If seeding
    // ever flipped that, every new section would arrive pre-blocked from publish.
    expect(missingLocales(buildDefaultSection(type, LOCALES), LOCALES)).toEqual([])
  })

  it('still flags a genuinely half-translated field', () => {
    const hero = buildDefaultSection('hero', LOCALES)
    const half: LandingSection = {
      ...hero,
      data: { ...(hero.data as Record<string, unknown>), heading: { ru: 'Заголовок', en: '' } },
    }
    expect(missingLocales(half, LOCALES)).toEqual(['en'])
  })

  it('does not flag an image alt left blank in both locales', () => {
    const hero = buildDefaultSection('hero', LOCALES)
    const withUrl: LandingSection = {
      ...hero,
      data: {
        ...(hero.data as Record<string, unknown>),
        media: { src: 'https://example.com/a.png', alt: { ru: '', en: '' } },
      },
    }
    expect(missingLocales(withUrl, LOCALES)).toEqual([])
  })
})
