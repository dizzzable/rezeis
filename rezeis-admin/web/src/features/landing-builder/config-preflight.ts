import { LANDING_SECTION_TYPES } from './landing-builder-api'

/**
 * config-preflight
 * ────────────────
 * Structural sanity check for a config pasted into the JSON panel.
 *
 * Deliberately NOT a copy of the backend Zod schema. The server owns validation
 * and reports precise issues on save (`LandingDraftInvalidError`); mirroring it
 * here would make a fourth copy of the section catalog to keep in sync, and the
 * copies would drift the way the preview renderer did.
 *
 * What this covers instead is the narrow class of input that the server would
 * also reject, but which breaks the EDITOR first: an import that is not a
 * config at all, or carries a section shape the builder cannot render. Without
 * it the paste is accepted, the editor throws mid-render, and the only symptom
 * the operator sees is a failed autosave 800 ms later.
 */

type Translate = (key: string, opts?: Record<string, unknown>) => string

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export function preflightConfig(parsed: unknown, t: Translate): string[] {
  const problems: string[] = []
  const say = (key: string, opts?: Record<string, unknown>): void => {
    problems.push(t(`landingBuilderPage.json.preflight.${key}`, { defaultValue: key, ...opts }))
  }

  if (!isRecord(parsed)) {
    say('notAnObject')
    return problems
  }

  if (!Array.isArray(parsed['sections'])) {
    say('sectionsMissing')
  } else {
    const known = new Set<string>(LANDING_SECTION_TYPES)
    parsed['sections'].forEach((section, index) => {
      if (!isRecord(section)) {
        say('sectionNotAnObject', { index: index + 1 })
        return
      }
      const type = section['type']
      if (typeof type !== 'string' || !known.has(type)) {
        say('sectionUnknownType', { index: index + 1, type: String(type) })
      }
      if (typeof section['id'] !== 'string' || section['id'].length === 0) {
        say('sectionMissingId', { index: index + 1 })
      }
      if (!isRecord(section['data'])) {
        say('sectionMissingData', { index: index + 1 })
      }
    })

    const ids = parsed['sections']
      .filter(isRecord)
      .map((section) => section['id'])
      .filter((id): id is string => typeof id === 'string')
    const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index)
    // Duplicate ids survive the schema (it validates each section in isolation)
    // but collide as React keys and make selection ambiguous in the builder.
    for (const id of new Set(duplicated)) say('duplicateSectionId', { id })
  }

  if (!isRecord(parsed['theme'])) say('themeMissing')

  if (!Array.isArray(parsed['locales']) || parsed['locales'].length === 0) {
    say('localesMissing')
  } else if (typeof parsed['defaultLocale'] !== 'string') {
    say('defaultLocaleMissing')
  } else if (!parsed['locales'].includes(parsed['defaultLocale'])) {
    // The editor picks the default locale as its starting tab; if it is not in
    // the list, every localized field renders against a locale nothing writes.
    say('defaultLocaleNotListed', { locale: parsed['defaultLocale'] })
  }

  const meta = parsed['meta']
  if (!isRecord(meta)) {
    say('metaMissing')
  } else {
    // The settings tab indexes `meta.title[locale]` per configured locale. The
    // server rejects this import too, but only 800 ms later as a failed
    // autosave — and the operator's next move is the tab that would let them
    // fix it, which throws mid-render and takes the whole page down with the
    // route error boundary, leaving a reload as the only way out.
    if (!isRecord(meta['title'])) say('metaTitleMissing')
    if (!isRecord(meta['description'])) say('metaDescriptionMissing')
  }

  return problems
}
