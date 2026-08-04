import { describe, expect, it } from 'vitest'

import { dropLocale, seedLocale } from './locale-seeding'
import { buildDefaultSection, missingLocales } from './section-defaults'
import type { LandingSection } from './landing-builder-api'

/**
 * Changing the language list must reach every localized leaf, in both
 * directions.
 *
 * A localized field is `{ ru: '…', en: '…' }` — a plain object keyed by locale.
 * If a new language is appended to `locales` without seeding those objects, the
 * key is simply absent: the editor renders no input for it, so the operator
 * cannot type the translation, while publish-strict counts the field as
 * complete (it only checks locales that are present). The result is a language
 * that silently ships untranslated.
 *
 * Removing a language without removing its entries fails the same way from the
 * other side: publish-strict decides a field is "in use" from `locales`, so text
 * stranded under a code no longer listed makes the field look deliberately
 * unset, publish is allowed, and the renderer's last-resort fallback prints the
 * stranded text on a page in a language nothing claims it is.
 */

const LOCALES = ['ru', 'en']

describe('adding a locale', () => {
  it('seeds the new locale into every localized leaf of a section', () => {
    const hero = buildDefaultSection('hero', LOCALES)
    const seeded = seedLocale(hero.data, 'de') as Record<string, unknown>

    const heading = seeded.heading as Record<string, string>
    expect(Object.keys(heading).sort()).toEqual(['de', 'en', 'ru'])
    expect(heading.de).toBe('')

    // …including leaves nested inside objects and arrays.
    const cta = seeded.primaryCta as { label: Record<string, string> }
    expect(cta.label).toHaveProperty('de')
    const media = seeded.media as { alt: Record<string, string> }
    expect(media.alt).toHaveProperty('de')
  })

  it('reaches leaves inside array items', () => {
    const features = buildDefaultSection('featuresGrid', LOCALES)
    const seeded = seedLocale(features.data, 'de') as { items: Array<Record<string, unknown>> }
    expect(seeded.items[0].title).toHaveProperty('de')
    expect(seeded.items[0].body).toHaveProperty('de')
  })

  it('preserves text already entered in the existing locales', () => {
    const source = { heading: { ru: 'Привет', en: 'Hello' } }
    expect(seedLocale(source, 'de')).toEqual({ heading: { ru: 'Привет', en: 'Hello', de: '' } })
  })

  it('is idempotent — re-adding a present locale changes nothing', () => {
    const source = { heading: { ru: 'Привет', en: 'Hello' } }
    expect(seedLocale(source, 'en')).toEqual(source)
  })

  it('leaves non-localized values untouched', () => {
    const source = { align: 'center', columns: 3, visible: true, src: 'https://x/y.png' }
    expect(seedLocale(source, 'de')).toEqual(source)
  })

  it('turns a half-filled field into a real publish blocker for the new locale', () => {
    // The point of seeding: after adding `de`, a field that HAS text in ru/en
    // must be reported as missing `de` so the operator is told to translate it.
    const hero = buildDefaultSection('hero', LOCALES)
    const filled: LandingSection = {
      ...hero,
      data: { ...(hero.data as Record<string, unknown>), heading: { ru: 'Привет', en: 'Hello' } },
    }
    const withDe: LandingSection = {
      ...filled,
      data: seedLocale(filled.data, 'de') as Record<string, unknown>,
    }
    expect(missingLocales(withDe, ['ru', 'en', 'de'])).toEqual(['de'])
  })
})

describe('removing a locale', () => {
  it('drops the locale from every localized leaf of a section', () => {
    const hero = buildDefaultSection('hero', LOCALES)
    const dropped = dropLocale(hero.data, 'en') as Record<string, unknown>

    expect(Object.keys(dropped.heading as Record<string, string>)).toEqual(['ru'])

    // …including leaves nested inside objects and arrays, exactly as seeding
    // reaches them — a leaf one direction misses is a leaf whose key set
    // disagrees with `locales` forever after.
    const cta = dropped.primaryCta as { label: Record<string, string> }
    expect(cta.label).not.toHaveProperty('en')
    const media = dropped.media as { alt: Record<string, string> }
    expect(media.alt).not.toHaveProperty('en')
  })

  it('reaches leaves inside array items', () => {
    const features = buildDefaultSection('featuresGrid', LOCALES)
    const dropped = dropLocale(features.data, 'en') as { items: Array<Record<string, unknown>> }
    expect(dropped.items[0].title).not.toHaveProperty('en')
    expect(dropped.items[0].body).not.toHaveProperty('en')
  })

  it('preserves text entered in the locales that remain', () => {
    const source = { heading: { ru: 'Привет', en: 'Hello' } }
    expect(dropLocale(source, 'en')).toEqual({ heading: { ru: 'Привет' } })
  })

  it('leaves nothing behind for the renderer to fall back to', () => {
    // A field written ONLY in the removed language is the dangerous case: it
    // reads as an unset optional field to publish-strict, so nothing blocks
    // publishing, and whatever survives here is what the page prints.
    const source = { subheading: { ru: '', en: 'Ship faster' } }
    expect(dropLocale(source, 'en')).toEqual({ subheading: { ru: '' } })
  })

  it('is idempotent — removing a locale that is not there changes nothing', () => {
    const source = { heading: { ru: 'Привет', en: 'Hello' } }
    expect(dropLocale(source, 'de')).toEqual(source)
  })

  it('leaves non-localized values untouched', () => {
    const source = { align: 'center', columns: 3, visible: true, src: 'https://x/y.png' }
    expect(dropLocale(source, 'en')).toEqual(source)
  })

  it('does not mutate the config it was handed', () => {
    // The caller passes it straight to `onChange`, which feeds the undo history;
    // an in-place edit would rewrite the step the operator wants to go back to.
    const source = { heading: { ru: 'Привет', en: 'Hello' } }
    dropLocale(source, 'en')
    expect(source).toEqual({ heading: { ru: 'Привет', en: 'Hello' } })
  })
})
