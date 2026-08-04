import { describe, expect, it } from 'vitest'

import { preflightConfig } from './config-preflight'
import { LANDING_TEMPLATES } from './templates'
import { buildDefaultSection } from './section-defaults'

/** Echoes the key so assertions read against key names, not translated copy. */
const t = (key: string): string => key
const key = (full: string): string => full.replace('landingBuilderPage.json.preflight.', '')

const LOCALES = ['ru', 'en']

function validConfig(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    enabled: true,
    theme: { inherit: true },
    locales: LOCALES,
    defaultLocale: 'ru',
    meta: { title: { ru: '', en: '' }, description: { ru: '', en: '' } },
    sections: [buildDefaultSection('hero', LOCALES)],
  }
}

describe('JSON import pre-flight', () => {
  it('passes a config the builder itself produced', () => {
    expect(preflightConfig(validConfig(), t)).toEqual([])
  })

  it('passes every shipped template', () => {
    for (const template of LANDING_TEMPLATES) {
      const config = {
        ...validConfig(),
        theme: template.theme,
        sections: template.sections.map((section, index) => ({ ...section, id: `s-${index}` })),
      }
      expect(preflightConfig(config, t).map(key), `template ${template.id}`).toEqual([])
    }
  })

  it.each([null, 42, 'text', ['a']])('rejects %p as a root value', (value) => {
    expect(preflightConfig(value, t).map(key)).toEqual(['notAnObject'])
  })

  it('reports a missing sections array', () => {
    const { sections: _sections, ...rest } = validConfig()
    expect(preflightConfig(rest, t).map(key)).toContain('sectionsMissing')
  })

  it('names the section index for an unknown type', () => {
    const config = validConfig()
    config.sections = [{ id: 'a', type: 'carousel', data: {} }]
    expect(preflightConfig(config, t).map(key)).toContain('sectionUnknownType')
  })

  it('catches a section missing its id or data', () => {
    const config = validConfig()
    config.sections = [{ type: 'hero' }]
    const problems = preflightConfig(config, t).map(key)
    expect(problems).toContain('sectionMissingId')
    expect(problems).toContain('sectionMissingData')
  })

  it('catches duplicate section ids, which the schema alone would allow', () => {
    // Each section validates fine in isolation; the collision only shows up as
    // a React key clash and ambiguous selection inside the builder.
    const config = validConfig()
    const hero = buildDefaultSection('hero', LOCALES)
    config.sections = [
      { ...hero, id: 'same' },
      { ...hero, id: 'same' },
    ]
    expect(preflightConfig(config, t).map(key)).toContain('duplicateSectionId')
  })

  it('catches a default locale that is not among the configured locales', () => {
    const config = validConfig()
    config.defaultLocale = 'de'
    expect(preflightConfig(config, t).map(key)).toContain('defaultLocaleNotListed')
  })

  it('reports a config that arrived without meta', () => {
    // The settings tab indexes `meta.title[locale]`. Accepted here, the import
    // reaches it and throws mid-render, and the route error boundary replaces
    // the page the operator opened to repair the import.
    const { meta: _meta, ...rest } = validConfig()
    expect(preflightConfig(rest, t).map(key)).toContain('metaMissing')
  })

  it('catches a meta object that carries neither title nor description map', () => {
    const config = validConfig()
    config.meta = {}
    const problems = preflightConfig(config, t).map(key)
    expect(problems).toContain('metaTitleMissing')
    expect(problems).toContain('metaDescriptionMissing')
  })

  it('catches a meta whose localized maps are not objects', () => {
    const config = validConfig()
    config.meta = { title: 'Landing', description: { ru: '', en: '' } }
    const problems = preflightConfig(config, t).map(key)
    expect(problems).toContain('metaTitleMissing')
    expect(problems).not.toContain('metaDescriptionMissing')
  })

  it('reports missing theme and locales', () => {
    const config = validConfig()
    delete config.theme
    delete config.locales
    const problems = preflightConfig(config, t).map(key)
    expect(problems).toContain('themeMissing')
    expect(problems).toContain('localesMissing')
  })
})
