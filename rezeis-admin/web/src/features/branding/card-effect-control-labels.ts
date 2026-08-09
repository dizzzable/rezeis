/**
 * Translation of the per-effect control labels and their select options.
 *
 * Effect NAMES were translated; the parameters underneath them never were, so a
 * Russian operator picked «Символьные волны» and was handed `Glyph Ramp`,
 * `Cell Size`, `Direction`, `Weight`, `Tension` — around five hundred English
 * strings across the fifty-four effects.
 *
 * Keyed by the control's `prop`, not by effect × prop: `speed`, `color`, `gap`,
 * `count`, `opacity`, `scale`, `direction` and their kin recur across dozens of
 * effects, so one shared map of ~240 entries covers what an effect-scoped map
 * would have needed thousands of entries to say. Twenty-odd controls do reuse a
 * prop name under a genuinely different meaning (`type` is `Dither Type` on
 * paperDither and `Direction` on pulseLines), and only those get an
 * effect-scoped override, checked first. Anything absent from both maps falls
 * back to the catalogue's English label, so a new effect ships readable rather
 * than showing a raw i18n key.
 */

import type { ControlDef } from '@/features/appearance/background-controls'

/**
 * A key lookup with a fallback — `t()` narrowed to what these resolvers need,
 * so `card-effect-i18n.test.ts` can drive the real resolution order against the
 * ru/en dictionaries without standing up i18next.
 */
export type LabelLookup = (key: string, fallback: string) => string

export function resolveControlLabel(
  lookup: LabelLookup,
  effect: string,
  control: ControlDef,
): string {
  const override = lookup(
    `brandingPage.cardEffectControlOverrides.${effect}.${control.prop}`,
    '',
  )
  return override || lookup(`brandingPage.cardEffectControls.${control.prop}`, control.label)
}

/**
 * Select options are raw stored values (`left`, `hexagon`, `counterclockwise`),
 * and the dropdown printed them verbatim. Font families and numeric enumerations
 * (`monospace`, `4x4`, `700`) are left alone on purpose — they are CSS tokens
 * and matrix/weight numbers, identical in any language.
 */
export function resolveOptionLabel(
  lookup: LabelLookup,
  prop: string,
  option: string,
): string {
  const override = lookup(`brandingPage.cardEffectOptionOverrides.${prop}.${option}`, '')
  return override || lookup(`brandingPage.cardEffectOptions.${option}`, option)
}
