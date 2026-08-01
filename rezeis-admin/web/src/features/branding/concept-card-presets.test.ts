import { describe, expect, it } from 'vitest'

import {
  CONCEPT_CARD_PRESETS,
  createConceptCardPresetVisualPatch,
  filterConceptCardPresets,
} from './concept-card-presets'
import { CONCEPT_THEME_PRESETS } from './theme-presets'

describe('independent concept subscription-card presets', () => {
  it('derives exactly 104 stable unique entries from the theme catalog', () => {
    expect(CONCEPT_CARD_PRESETS).toHaveLength(104)
    expect(new Set(CONCEPT_CARD_PRESETS.map((preset) => preset.id)).size).toBe(
      104,
    )

    for (const [index, preset] of CONCEPT_CARD_PRESETS.entries()) {
      const theme = CONCEPT_THEME_PRESETS[index]
      expect(preset).toMatchObject({
        id: theme.id,
        sourceThemePresetId: theme.id,
        code: theme.code,
        name: theme.name,
        visualFamily: theme.visualFamily,
        cardGradient: theme.cardGradient,
        cardPattern: theme.cardPattern,
        cardEffect: theme.cardEffect,
        cardEffectOpacity: theme.cardEffectOpacity,
      })
    }
  })

  it('creates a five-field card-only patch and clones effect props', () => {
    const preset = CONCEPT_CARD_PRESETS[40]
    const patch = createConceptCardPresetVisualPatch(preset)

    expect(Object.keys(patch).sort()).toEqual(
      [
        'cardGradient',
        'cardPattern',
        'cardEffect',
        'cardEffectProps',
        'cardEffectOpacity',
      ].sort(),
    )
    expect(patch).not.toHaveProperty('themePresetId')
    expect(patch).not.toHaveProperty('appBackground')
    expect(patch).not.toHaveProperty('cornerRadii')
    expect(patch).not.toHaveProperty('cardEffectsByIndex')
    expect(patch.cardEffectProps).toEqual(preset.cardEffectProps)
    expect(patch.cardEffectProps).not.toBe(preset.cardEffectProps)
  })

  it('searches names, codes and effect names and combines taxonomy filters', () => {
    const polarRed = CONCEPT_CARD_PRESETS.find(
      (preset) => preset.name === 'Polar Red Monolith',
    )
    expect(polarRed).toBeDefined()

    expect(
      filterConceptCardPresets(CONCEPT_CARD_PRESETS, {
        query: polarRed?.code,
      }),
    ).toContainEqual(polarRed)
    expect(
      filterConceptCardPresets(CONCEPT_CARD_PRESETS, {
        query: polarRed?.cardEffectName,
        visualFamily: polarRed?.visualFamily,
        cardEffect: polarRed?.cardEffect,
      }),
    ).toContainEqual(polarRed)
    expect(
      filterConceptCardPresets(CONCEPT_CARD_PRESETS, {
        query: 'definitely-not-a-concept',
      }),
    ).toEqual([])
  })
})
