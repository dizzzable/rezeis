/**
 * Every effect id in the catalogue must have a label in BOTH locales.
 *
 * `effects-settings-card.tsx` renders each option as
 * `t('effectsSettings.options.<category>.<id>', { defaultValue: def.name })`.
 * The `defaultValue` is why a missing key does not crash — and why it needs a
 * test: a Russian operator would simply see the English name, with nothing
 * anywhere reporting a problem.
 */
import { describe, expect, it } from 'vitest'

import { en as appearanceEn } from '@/i18n/features/appearance.en'
import { ru as appearanceRu } from '@/i18n/features/appearance.ru'
import {
  CLICK_EFFECTS,
  CONTENT_ANIMATIONS,
  CURSOR_EFFECTS,
  HOVER_EFFECTS,
  TEXT_ANIMATIONS,
} from '@/lib/theme/effects-store'

type Dict = Record<string, unknown>

function optionLabels(bundle: Dict, category: string): Dict {
  const settings = (bundle.effectsSettings ?? {}) as Dict
  const options = (settings.options ?? {}) as Dict
  return (options[category] ?? {}) as Dict
}

const CATEGORIES = [
  ['textAnimation', TEXT_ANIMATIONS],
  ['cursorEffect', CURSOR_EFFECTS],
  ['clickEffect', CLICK_EFFECTS],
  ['hoverEffect', HOVER_EFFECTS],
  ['contentAnimation', CONTENT_ANIMATIONS],
] as const

describe('effects option labels', () => {
  it.each(CATEGORIES)('%s: every id is labelled in both locales', (category, defs) => {
    const en = optionLabels(appearanceEn as Dict, category)
    const ru = optionLabels(appearanceRu as Dict, category)

    for (const def of defs) {
      expect(typeof en[def.id], `missing en label for ${category}.${def.id}`).toBe('string')
      expect(typeof ru[def.id], `missing ru label for ${category}.${def.id}`).toBe('string')
    }
  })

  it.each(CATEGORIES)('%s: carries no label for an id that was removed', (category, defs) => {
    const known = new Set<string>(defs.map((d) => d.id))
    for (const bundle of [appearanceEn, appearanceRu]) {
      for (const key of Object.keys(optionLabels(bundle as Dict, category))) {
        expect(known, `stale label ${category}.${key}`).toContain(key)
      }
    }
  })

  it('translates the new options rather than echoing the English name', () => {
    const enText = optionLabels(appearanceEn as Dict, 'textAnimation')
    const ruText = optionLabels(appearanceRu as Dict, 'textAnimation')
    const enCursor = optionLabels(appearanceEn as Dict, 'cursorEffect')
    const ruCursor = optionLabels(appearanceRu as Dict, 'cursorEffect')

    for (const id of ['shuffle', 'typewriter', 'proximity'] as const) {
      expect(ruText[id]).not.toBe(enText[id])
    }
    for (const id of ['target', 'textTrail'] as const) {
      expect(ruCursor[id]).not.toBe(enCursor[id])
    }
  })
})
