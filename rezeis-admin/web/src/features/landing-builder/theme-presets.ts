import type { LandingTheme } from './landing-builder-api'
import { GENERATED_THEME_PRESETS } from './theme-presets.generated'

/**
 * theme-presets
 * ─────────────
 * A theme preset is presentation ONLY — no sections, no copy.
 *
 * This is the distinction that makes a large theme catalog affordable, and it
 * is the opposite of `LANDING_TEMPLATES`, which bundles a theme WITH starter
 * sections and replaces both. A template is how you begin a landing; a preset
 * is how you re-skin the one you already wrote. Applying a preset must never
 * touch `config.sections` — the industry name for getting this wrong is
 * "changing the theme wiped my content", and it is why Wix, Webflow and Framer
 * cannot swap themes at all: their pages carry style inline, with no separate
 * theme layer to substitute.
 *
 * Two rules keep the substitution total and reversible:
 *
 *  1. **`inherit: false` on every preset.** With `inherit: true` the renderer
 *     ignores the theme's colours and falls back to platform branding, so the
 *     preset would appear to do nothing.
 *  2. **The preset is the complete presentation state**, not a partial patch.
 *     Every key the theme supports is written, so switching from a glass preset
 *     to a solid one cannot leave the previous surface style behind. A preset
 *     that omitted keys would inherit fragments of whichever preset ran before
 *     it, and the same preset would render differently depending on history.
 *
 * `theme.font` is the one exception, and deliberately so — see `preserveFont`.
 */
export interface LandingThemePreset {
  readonly id: string
  /** Human-readable name, stored here rather than in i18n: a catalog this size
   *  would otherwise double the translation bundle for values that are proper
   *  nouns in both languages. */
  readonly name: string
  /** Coarse grouping for the gallery filter. */
  readonly mood: 'dark' | 'light'
  readonly theme: LandingTheme
}

/**
 * The presentation keys no preset has an opinion about. They are still written,
 * and written explicitly: absence is not neutral here. `isPresetApplied` reads a
 * key the preset does not carry as "matches whatever the theme has", so an
 * operator's hover or overlay choice looked like part of the preset — the
 * gallery skipped remembering it, and the next tile click erased it past undo.
 */
const NEUTRAL_INTERACTION = {
  backgroundOverlay: 'none',
  cardHover: 'none',
  ctaStyle: 'none',
} as const satisfies Partial<LandingTheme>

/**
 * Builds a preset with every presentation key set, so applying it fully
 * replaces the previous look rather than merging with it. Typography excepted:
 * no preset names a typeface, so none may clear one — see `preserveFont`.
 */
function preset(input: {
  id: string
  name: string
  mood: 'dark' | 'light'
  primary: string
  bg: string
  fg: string
  accent: string
  background: LandingTheme['background']
  backgroundColors: string[]
  surfaceStyle: NonNullable<LandingTheme['surfaceStyle']>
  radius: NonNullable<LandingTheme['radius']>
}): LandingThemePreset {
  return {
    id: input.id,
    name: input.name,
    mood: input.mood,
    theme: {
      inherit: false,
      colors: { primary: input.primary, bg: input.bg, fg: input.fg, accent: input.accent },
      radius: input.radius,
      background: input.background,
      backgroundColors: input.backgroundColors,
      animateBackground: true,
      surfaceStyle: input.surfaceStyle,
      ...NEUTRAL_INTERACTION,
    },
  }
}

/**
 * Fills in the keys a preset literal may omit. The generated catalog is emitted
 * from extracted palettes, which carry no hover or overlay information, so its
 * entries stop short of the complete-presentation rule above. The default is
 * applied here rather than taught to the generator: it belongs to the preset
 * system, and this way it also covers whatever the next extraction leaves out.
 */
function withNeutralInteraction(entry: LandingThemePreset): LandingThemePreset {
  return { ...entry, theme: { ...NEUTRAL_INTERACTION, ...entry.theme } }
}

/**
 * Hand-curated presets. These lead the gallery: they are the looks worth
 * showing first, and they double as the readable reference for the shape the
 * generator emits.
 */
const CURATED_THEME_PRESETS: readonly LandingThemePreset[] = [
  preset({
    id: 'vital-link',
    name: 'Vital Link',
    mood: 'dark',
    primary: '#C92F26',
    bg: '#090706',
    fg: '#F8F5F1',
    accent: '#C92F26',
    background: 'glow',
    backgroundColors: ['#351411', '#090706'],
    surfaceStyle: 'solid',
    radius: 'lg',
  }),
  preset({
    id: 'reiwa-pulse',
    name: 'Reiwa Pulse',
    mood: 'dark',
    primary: '#A855F7',
    bg: '#07060D',
    fg: '#F8F6FB',
    accent: '#A855F7',
    background: 'aurora',
    backgroundColors: ['#25113B', '#0A0812', '#07060D'],
    surfaceStyle: 'glass',
    radius: 'xl',
  }),
  preset({
    id: 'liquid-glass-aurora',
    name: 'Liquid Glass Aurora',
    mood: 'dark',
    primary: '#BE7CFF',
    bg: '#071123',
    fg: '#F8FBFF',
    accent: '#66F3FF',
    background: 'mesh',
    backgroundColors: ['#50E8FF', '#7046E8', '#32155F', '#071123'],
    surfaceStyle: 'glass',
    radius: 'xl',
  }),
  preset({
    id: 'liquid-glass-frost',
    name: 'Liquid Glass Frost',
    mood: 'light',
    primary: '#6D5DE7',
    bg: '#EAF0F8',
    fg: '#172033',
    accent: '#5FD9EF',
    background: 'mesh',
    backgroundColors: ['#D7FCFF', '#E5DEFF', '#F6F8FF', '#EAF0F8'],
    surfaceStyle: 'glass',
    radius: 'xl',
  }),
  preset({
    id: 'quiet-mint',
    name: 'Quiet Mint',
    mood: 'light',
    primary: '#176B55',
    bg: '#E4EEEA',
    fg: '#17352C',
    accent: '#176B55',
    background: 'gradient',
    backgroundColors: ['#FBFCF7', '#EDF4EE', '#E4EEEA'],
    surfaceStyle: 'glass',
    radius: 'lg',
  }),
  preset({
    id: 'signal-pass',
    name: 'Signal Pass',
    mood: 'dark',
    primary: '#E6FF58',
    bg: '#09080D',
    fg: '#F5F2F7',
    accent: '#E6FF58',
    background: 'grid',
    backgroundColors: ['#3A2449', '#17111E', '#09080D'],
    surfaceStyle: 'outline',
    radius: 'sm',
  }),
  preset({
    id: 'glacier-finance-glass',
    name: 'Glacier Finance Glass',
    mood: 'dark',
    primary: '#3D9FBC',
    bg: '#030405',
    fg: '#F8FBFF',
    accent: '#3D9FBC',
    background: 'blobs',
    backgroundColors: ['#3D9FBC', '#064865', '#033D58', '#030405'],
    surfaceStyle: 'glass',
    radius: 'md',
  }),
  preset({
    id: 'ember-smoke-glass',
    name: 'Ember Smoke Glass',
    mood: 'dark',
    primary: '#F25A25',
    bg: '#030202',
    fg: '#F8FBFF',
    accent: '#F25A25',
    background: 'aurora',
    backgroundColors: ['#A64B1C', '#4D250C', '#1B0D08', '#030202'],
    surfaceStyle: 'glass',
    radius: 'lg',
  }),
]

/**
 * The catalog: curated presets first, then the full generated set with any
 * duplicate ids dropped. Dedupe by id rather than by name so a curated entry
 * always wins over its generated twin — the curated one carries the deliberate
 * choices (e.g. a background effect the extraction could not infer).
 */
export const LANDING_THEME_PRESETS: readonly LandingThemePreset[] = (() => {
  // Deduped on id AND name: two tiles sharing a name are indistinguishable in
  // the gallery even when their ids differ, so a curated entry whose id drifted
  // from its generated twin would otherwise show up twice.
  const ids = new Set(CURATED_THEME_PRESETS.map((preset) => preset.id))
  const names = new Set(CURATED_THEME_PRESETS.map((preset) => preset.name))
  return [
    ...CURATED_THEME_PRESETS,
    ...GENERATED_THEME_PRESETS.filter(
      (preset) => !ids.has(preset.id) && !names.has(preset.name),
    ),
  ].map(withNeutralInteraction)
})()

/**
 * Every key the preset system considers part of "the look".
 *
 * `font` is not one of them. A theme with the operator's typeface on it is
 * still the preset it was made from, and if it were compared here the tile
 * would go dark the moment a font was set — and the gallery would then start
 * treating that font as a per-preset tweak to file away, which is the opposite
 * of a setting that belongs to the landing as a whole.
 */
const PRESENTATION_KEYS = [
  'inherit',
  'colors',
  'radius',
  'background',
  'backgroundOverlay',
  'backgroundColors',
  'animateBackground',
  'surfaceStyle',
  'cardHover',
  'ctaStyle',
] as const satisfies readonly (keyof LandingTheme)[]

/**
 * Applies a preset over the current theme, replacing the presentation wholesale
 * so no fragment of the previous preset survives. Pass the current theme
 * through `preserveFont` on the way to the config — this returns the preset as
 * catalogued, which names no typeface.
 */
export function applyThemePreset(preset: LandingThemePreset): LandingTheme {
  return structuredClone(preset.theme)
}

/**
 * Carries the operator's typography onto an incoming look.
 *
 * Presets are palettes and surfaces; not one of them expresses a typeface (the
 * generated catalog is extracted from colour palettes, and the curated entries
 * name none either), while the font is set once for the whole landing, in
 * Settings. So the wholesale-replace rule — which exists to stop one preset
 * leaving fragments in the next — has nothing to say about `font`, and applying
 * it there only meant that trying on a look silently reverted a typography
 * choice made in a different panel. Since every preset leaves the font exactly
 * as it found it, no order of clicks can make the same preset render two ways.
 *
 * Applies to a remembered variant too: that was captured whenever the operator
 * last left the tile, so its font is the older of the two.
 */
export function preserveFont(next: LandingTheme, current: LandingTheme): LandingTheme {
  const merged: LandingTheme = { ...next }
  if (current.font === undefined) delete merged.font
  else merged.font = structuredClone(current.font)
  return merged
}

/** True when `theme` still matches `preset` exactly (used to mark the active tile). */
export function isPresetApplied(theme: LandingTheme, preset: LandingThemePreset): boolean {
  return PRESENTATION_KEYS.every(
    (key) => JSON.stringify(theme[key]) === JSON.stringify(preset.theme[key]),
  )
}

export function findThemePreset(id: string): LandingThemePreset | undefined {
  return LANDING_THEME_PRESETS.find((entry) => entry.id === id)
}
