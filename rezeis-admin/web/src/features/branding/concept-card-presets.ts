/**
 * Independent subscription-card presets derived from the canonical
 * 104-concept WEB Reiwa catalog.
 *
 * Applying one of these presets intentionally changes only the global card
 * visual. Page colors/background, corner radii and per-subscription slot
 * overrides remain operator-owned.
 */

import type { BrandingFormDraft } from './branding-form-schema'
import {
  CARD_EFFECT_REGISTRY,
  getCardEffectDef,
} from './card-effect-registry'
import { THEME_PRESETS, type ThemePreset } from './theme-presets'

export interface ConceptCardPreset {
  readonly id: string
  readonly sourceThemePresetId: string
  readonly code: string
  readonly name: string
  readonly sourcePage: number
  readonly visualFamily: string
  readonly palette: readonly string[]
  readonly cardGradient: string
  readonly cardPattern: string | null
  readonly cardEffect: string
  readonly cardEffectName: string
  readonly cardEffectProps: Readonly<Record<string, unknown>>
  readonly cardEffectOpacity: number
}

export interface ConceptCardPresetVisualPatch {
  readonly cardGradient: BrandingFormDraft['cardGradient']
  readonly cardPattern: BrandingFormDraft['cardPattern']
  readonly cardEffect: BrandingFormDraft['cardEffect']
  readonly cardEffectProps: NonNullable<BrandingFormDraft['cardEffectProps']>
  readonly cardEffectOpacity: BrandingFormDraft['cardEffectOpacity']
}

export interface ConceptCardPresetFilter {
  readonly query?: string
  readonly visualFamily?: string
  readonly cardEffect?: string
}

export const CONCEPT_CARD_PRESETS: readonly ConceptCardPreset[] =
  THEME_PRESETS.map(createConceptCardPreset)

export const CONCEPT_CARD_PRESET_BY_ID: Readonly<
  Record<string, ConceptCardPreset>
> = Object.fromEntries(
  CONCEPT_CARD_PRESETS.map((preset) => [preset.id, preset]),
)

export const CONCEPT_CARD_VISUAL_FAMILIES: readonly string[] = [
  ...new Set(CONCEPT_CARD_PRESETS.map((preset) => preset.visualFamily)),
]

export const CONCEPT_CARD_EFFECTS: readonly {
  readonly id: string
  readonly name: string
}[] = CARD_EFFECT_REGISTRY.filter((effect) =>
  CONCEPT_CARD_PRESETS.some((preset) => preset.cardEffect === effect.id),
).map((effect) => ({ id: effect.id, name: effect.name }))

/**
 * Returns the exact five-field patch owned by an independent card preset.
 * The props object is cloned so subsequent manual tuning cannot mutate the
 * canonical catalog entry.
 */
export function createConceptCardPresetVisualPatch(
  preset: ConceptCardPreset,
): ConceptCardPresetVisualPatch {
  return {
    cardGradient: preset.cardGradient,
    cardPattern: preset.cardPattern,
    cardEffect: preset.cardEffect,
    cardEffectProps: { ...preset.cardEffectProps },
    cardEffectOpacity: preset.cardEffectOpacity,
  }
}

export function filterConceptCardPresets(
  presets: readonly ConceptCardPreset[],
  filter: ConceptCardPresetFilter,
): readonly ConceptCardPreset[] {
  const query = normalizeSearch(filter.query ?? '')
  const visualFamily = filter.visualFamily ?? ''
  const cardEffect = filter.cardEffect ?? ''

  return presets.filter((preset) => {
    if (visualFamily && preset.visualFamily !== visualFamily) return false
    if (cardEffect && preset.cardEffect !== cardEffect) return false
    if (!query) return true

    return [
      preset.id,
      preset.code,
      preset.name,
      preset.visualFamily,
      preset.cardEffect,
      preset.cardEffectName,
    ].some((value) => normalizeSearch(value).includes(query))
  })
}

function createConceptCardPreset(theme: ThemePreset): ConceptCardPreset {
  return {
    id: theme.id,
    sourceThemePresetId: theme.id,
    code: theme.code,
    name: theme.name,
    sourcePage: theme.sourcePage,
    visualFamily: theme.visualFamily,
    palette: theme.palette,
    cardGradient: theme.cardGradient,
    cardPattern: theme.cardPattern,
    cardEffect: theme.cardEffect,
    cardEffectName:
      getCardEffectDef(theme.cardEffect)?.name ?? theme.cardEffect,
    cardEffectProps: { ...theme.cardEffectProps },
    cardEffectOpacity: theme.cardEffectOpacity,
  }
}

function normalizeSearch(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase()
}
