import { describe, expect, it } from 'vitest'

import {
  AUTHORED_DECOR_CODES,
  CONCEPT_PRESETS,
  authoredDecorLayers,
  getConceptSourceMode,
  getConceptSourceStyle,
  getConceptThemeModeVisual,
  type ConceptPresetDescriptor,
} from '../../lib/theme/concept-presets'
import { createConceptReiwaPreset } from './theme-presets'

/**
 * A DECOR WRITTEN FOR A CONCEPT HAS TO REACH BOTH BACKGROUNDS.
 *
 * There are two of them, built by different code for different surfaces:
 *
 *   - the CONNECT SCREEN's ground, from `buildConceptComposition`, which
 *     assembles the family reconstruction and the base gradient;
 *   - the CABINET's own app background, from `buildBackgroundGradient` in
 *     `theme-presets.ts`, which rebuilds from the source style and adds its own
 *     `addAppComposition` layers.
 *
 * They were written a year apart and neither knew about the other's decor. So
 * Mono Moonlight Crater's moon — written against its board — appeared on the
 * connect screen and nowhere else, and an operator who picked that concept for
 * the CABINET got the concept without the thing it is named after. Reported as
 * exactly that: "то что ты сделал к теме сабки … нужно было применить и для
 * темы кабинета".
 *
 * `authoredDecorLayers` is now the single definition and both paths consult it.
 * Nothing but this file makes that stay true, because the two paths still build
 * everything else separately and always will.
 */

function ink(descriptor: ConceptPresetDescriptor) {
  const mode = getConceptSourceMode(descriptor)
  const values = getConceptThemeModeVisual(descriptor, mode).tokens as unknown as Record<
    string,
    string
  >
  return { foreground: values['foreground'] ?? '#ffffff', background: values['background'] ?? '#000000' }
}

describe('a decor written against the board', () => {
  it('is written for at least one concept', () => {
    // Anti-emptiness anchor: with no authored concepts every loop below passes
    // by iterating nothing, which is the shape of a test that watches nothing.
    expect(AUTHORED_DECOR_CODES.length).toBeGreaterThan(0)
  })

  it('reaches the connect screen ground', () => {
    for (const code of AUTHORED_DECOR_CODES) {
      const descriptor = CONCEPT_PRESETS.find((preset) => preset.code === code)
      expect(descriptor, `authored decor names a concept that is gone: ${code}`).toBeDefined()
      const mode = getConceptSourceMode(descriptor!)
      const ground = getConceptThemeModeVisual(descriptor!, mode).backgroundImage
      const layers = authoredDecorLayers(code, ink(descriptor!)) ?? []
      for (const layer of layers) {
        expect(ground, `${code}: the connect ground is missing an authored layer`).toContain(layer)
      }
    }
  })

  it('reaches the cabinet background, at BOTH brightnesses', () => {
    // Both, because they are built by two different functions: the concept's
    // own brightness rebuilds from the source style, and the opposite one
    // forwards the reconstruction through a length cap. A decor can be lost by
    // either.
    for (const code of AUTHORED_DECOR_CODES) {
      const descriptor = CONCEPT_PRESETS.find((preset) => preset.code === code)!
      const source = getConceptSourceMode(descriptor)
      const opposite = source === 'dark' ? 'light' : 'dark'
      for (const mode of [source, opposite] as const) {
        const preset = createConceptReiwaPreset(descriptor, mode) as unknown as {
          appBackground: { gradient: string }
        }
        // The position is the drawing's signature and survives a change of ink
        // between the two brightnesses, which the exact layer string does not.
        const marker = /at \d+% \d+%/.exec(
          (authoredDecorLayers(code, ink(descriptor)) ?? [])[0] ?? '',
        )?.[0]
        expect(marker, `${code}: the authored decor draws nothing positioned`).toBeDefined()
        expect(
          preset.appBackground.gradient,
          `${code}: the cabinet background at ${mode} lost the authored decor`,
        ).toContain(marker!)
      }
    }
  })

  it('draws with the concept ink rather than a literal colour', () => {
    // The same drawing serves two paths that resolve tokens differently, which
    // only works while it takes its colours as arguments. A hard-coded hex here
    // would look right on one surface and wrong on the other.
    for (const code of AUTHORED_DECOR_CODES) {
      const descriptor = CONCEPT_PRESETS.find((preset) => preset.code === code)!
      const pale = authoredDecorLayers(code, { foreground: '#ffffff', background: '#000000' })
      const dark = authoredDecorLayers(code, { foreground: '#111111', background: '#eeeeee' })
      expect(pale).not.toEqual(dark)
      expect(getConceptSourceStyle(descriptor)).toBeDefined()
    }
  })
})
