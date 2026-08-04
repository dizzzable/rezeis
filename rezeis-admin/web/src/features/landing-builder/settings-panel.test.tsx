import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderWithProviders } from '@/test/test-utils'

import { SettingsPanel } from './settings-panel'
import { buildDefaultSection, missingLocales } from './section-defaults'
import { pickLocalized } from './live/landing-schema'
import type { LandingConfig } from './landing-builder-api'

/**
 * The two ways this panel could hand the rest of the system a config it cannot
 * cope with: text stranded under a language that was just removed, and a `meta`
 * that never arrived.
 *
 * The landingBuilder i18n bundle is lazy-loaded by the route, so `t()` falls
 * through to its key here — which is what makes the accessible names below
 * stable and language-independent.
 */

const LOCALES = ['ru', 'en']

/** A landing whose hero subheading exists ONLY in English. */
function configWithEnglishOnlySubheading(): LandingConfig {
  const hero = buildDefaultSection('hero', LOCALES)
  return {
    schemaVersion: 1,
    enabled: true,
    theme: { inherit: true },
    locales: [...LOCALES],
    defaultLocale: 'ru',
    meta: { title: { ru: 'Заголовок', en: 'Title' }, description: { ru: '', en: '' } },
    sections: [
      {
        ...hero,
        data: {
          ...hero.data,
          subheading: { ru: '', en: 'Ship faster' },
          primaryCta: {
            ...(hero.data.primaryCta as Record<string, unknown>),
            label: { ru: '', en: 'Start' },
          },
        },
      },
    ],
  } as LandingConfig
}

/** Clicks the trash button on the `en` chip and returns the emitted config. */
async function removeEnglish(config: LandingConfig): Promise<LandingConfig> {
  const onChange = vi.fn()
  renderWithProviders(<SettingsPanel config={config} onChange={onChange} />)
  await userEvent.click(screen.getByRole('button', { name: /\sen$/ }))
  expect(onChange).toHaveBeenCalledTimes(1)
  return onChange.mock.calls[0][0] as LandingConfig
}

describe('SettingsPanel — removing a locale', () => {
  it('strips the removed language from meta and from every nested section leaf', async () => {
    const next = await removeEnglish(configWithEnglishOnlySubheading())

    expect(next.locales).toEqual(['ru'])
    expect(next.meta.title).toEqual({ ru: 'Заголовок' })
    expect(next.meta.description).toEqual({ ru: '' })

    const data = next.sections[0].data
    expect(data.subheading).toEqual({ ru: '' })
    expect((data.primaryCta as { label: Record<string, string> }).label).toEqual({ ru: '' })
    expect((data.media as { alt: Record<string, string> }).alt).not.toHaveProperty('en')
    // Nothing anywhere in the document is still keyed by the dead language.
    expect(JSON.stringify(next)).not.toContain('"en"')
  })

  it('leaves the live renderer nothing to resurrect onto the remaining page', async () => {
    const before = configWithEnglishOnlySubheading()
    // While `en` is configured the half-filled subheading is a real publish
    // blocker, and the operator is told to translate it.
    expect(missingLocales(before.sections[0], before.locales)).toEqual(['ru'])

    const after = await removeEnglish(before)

    // Now publish is allowed — publish-strict reads "in use" from `locales`, so
    // the field counts as an optional one nobody filled…
    expect(missingLocales(after.sections[0], after.locales)).toEqual([])
    // …which is only safe because the English text went with the language. Left
    // behind, the renderer's last-resort fallback would print it on the Russian
    // page that publish just waved through.
    expect(pickLocalized(after.sections[0].data.subheading, 'ru', 'ru')).toBe('')
  })

  it('repoints the default locale when the default itself is removed', async () => {
    const config = { ...configWithEnglishOnlySubheading(), defaultLocale: 'en' }
    const next = await removeEnglish(config)
    expect(next.defaultLocale).toBe('ru')
  })
})

describe('SettingsPanel — a config that arrived without meta', () => {
  it('renders the SEO fields instead of taking the whole page down', () => {
    // An import reaches this panel by more doors than the JSON tab's pre-flight
    // (a corrupted draft, a rolled-back revision), and throwing here hands the
    // route error boundary the entire page — including the tab the operator
    // opened to repair exactly this.
    const config = { ...configWithEnglishOnlySubheading(), meta: undefined } as unknown as LandingConfig
    renderWithProviders(<SettingsPanel config={config} onChange={vi.fn()} />)

    const russianFields = screen.getAllByLabelText(/\(ru\)$/)
    expect(russianFields).toHaveLength(2)
    for (const field of russianFields) expect(field).toHaveValue('')
  })

  it('still writes a well-formed meta when the operator types into it', async () => {
    const onChange = vi.fn()
    const config = { ...configWithEnglishOnlySubheading(), meta: undefined } as unknown as LandingConfig
    renderWithProviders(<SettingsPanel config={config} onChange={onChange} />)

    await userEvent.type(screen.getAllByLabelText(/\(ru\)$/)[0], 'Т')

    const next = onChange.mock.calls[0][0] as LandingConfig
    expect(next.meta).toEqual({ title: { ru: 'Т' }, description: {} })
  })
})
