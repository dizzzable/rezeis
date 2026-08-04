import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'

import { renderWithProviders } from '@/test/test-utils'

import { SectionEditor } from './section-editor'
import type { LandingSection } from './landing-builder-api'

/**
 * `editorLocale` is the preview dropdown's value, and the preview dropdown is
 * not reconciled when `config.locales` changes — so this component is regularly
 * handed a language the config no longer has. It must not offer an input for
 * one: text typed there is written under a code nothing else in the editor
 * renders, autosaved, uncounted by publish-strict, and then printed by the live
 * renderer's last-resort fallback.
 *
 * The landingBuilder i18n bundle is lazy-loaded by the route, so `t()` falls
 * through to its key here — which is what makes the labels below stable.
 */

const MISSING_BADGE = 'landingBuilderPage.sectionList.missingTranslation'

function sectionWith(data: Record<string, unknown>): LandingSection {
  return { id: 'hero-1', type: 'hero', visible: true, data }
}

describe('SectionEditor — localized inputs follow config.locales', () => {
  it('renders one input per configured locale, editor locale first', () => {
    renderWithProviders(
      <SectionEditor
        section={sectionWith({ heading: { ru: 'Привет', en: 'Hello' } })}
        locales={['ru', 'en']}
        editorLocale="en"
        onChange={vi.fn()}
      />,
    )

    const inputs = screen.getAllByLabelText(/^heading \((?:ru|en)\)$/)
    expect(inputs).toHaveLength(2)
    expect(inputs[0]).toHaveAccessibleName('heading (en)')
  })

  it('renders no input for a locale the config no longer lists', () => {
    renderWithProviders(
      <SectionEditor
        section={sectionWith({ heading: { ru: 'Привет', en: 'Hello' } })}
        locales={['ru']}
        editorLocale="en"
        onChange={vi.fn()}
      />,
    )

    expect(screen.queryAllByLabelText(/\(en\)$/)).toHaveLength(0)
    expect(screen.getByLabelText('heading (ru)')).toHaveValue('Привет')
  })

  it('does not badge a missing translation for a language that no longer exists', () => {
    // The badge is derived from the field's own emptiness, so an input rendered
    // for a removed locale came with an amber "translate me" prompt attached —
    // an instruction to create the very orphan removing the locale cleans up.
    renderWithProviders(
      <SectionEditor
        section={sectionWith({ heading: { ru: 'Привет', en: '' } })}
        locales={['ru']}
        editorLocale="en"
        onChange={vi.fn()}
      />,
    )

    expect(screen.queryAllByText(MISSING_BADGE)).toHaveLength(0)
  })

  it('still badges a locale that IS configured and untranslated', () => {
    // Guards the guard: a badge that never fires would pass the test above.
    renderWithProviders(
      <SectionEditor
        section={sectionWith({ heading: { ru: 'Привет', en: '' } })}
        locales={['ru', 'en']}
        editorLocale="ru"
        onChange={vi.fn()}
      />,
    )

    expect(screen.getAllByText(MISSING_BADGE)).toHaveLength(1)
  })

  it('reaches localized leaves nested in arrays and objects with the same rule', () => {
    renderWithProviders(
      <SectionEditor
        section={sectionWith({
          primaryCta: { label: { ru: '', en: 'Start' }, action: 'register' },
          items: [{ title: { ru: '', en: 'First' } }],
        })}
        locales={['ru']}
        editorLocale="en"
        onChange={vi.fn()}
      />,
    )

    expect(screen.queryAllByLabelText(/\(en\)$/)).toHaveLength(0)
    expect(screen.getAllByLabelText(/\(ru\)$/)).toHaveLength(2)
  })
})
