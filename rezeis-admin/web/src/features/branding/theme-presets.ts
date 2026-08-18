/**
 * One-click WEB Reiwa themes.
 *
 * Two families live here behind a `kind` discriminant:
 *
 *   • `legacy` — the eight standard themes shipped before the concept catalog.
 *     They own a palette, a card gradient, the semantic surfaces and the app
 *     background, and stop there: geometry, typography and card artwork remain
 *     operator-owned.
 *
 *     The surfaces and the app background are not an expansion of what these
 *     themes "do" — they are the cabinet they were drawn against. All eight are
 *     dark (`bgPrimary` #08090a…#0c0a09) and each carries only a background;
 *     the text colours painted on it live in `surfaceTheme`. Leaving that field
 *     to whatever a previously selected concept stored composed a dark standard
 *     background with a LIGHT concept's foreground: measured over all 8 × 104
 *     combinations, 352 of 832 fell below the 4.5 AA requirement, the worst at
 *     1.00:1. `theme-presets.test.ts` guards that outcome directly.
 *   • `concept` — resolved from the canonical 104-concept catalog. The source
 *     book and audited Pencil boards expose palettes, semantic surfaces,
 *     typography and geometry. This adapter persists their fully resolved Reiwa
 *     representation, so the runtime never depends on the admin catalog and
 *     continues to render it while Rezeis is unavailable.
 */

import {
  CONCEPT_PRESETS,
  getConceptThemeModeVisual,
  getConceptSourceBackgroundColor,
  getConceptSourceMode,
  getConceptSourceStyle,
  type ConceptSourceMode,
  type ConceptPresetDescriptor,
  type HexColor,
} from '../../lib/theme/concept-presets'

import {
  DEFAULT_APP_BACKGROUND_DRAFT,
  DEFAULT_SURFACE_THEME_DRAFT,
} from './branding-form-schema'

import type {
  BrandingAppBackgroundDraft,
  BrandingCornerRadiiDraft,
  BrandingFormDraft,
  BrandingSubscriptionCardTextDraft,
  BrandingSurfaceThemeDraft,
} from './branding-form-schema'

export const THEME_PRESET_VERSION = 2

export type ConceptComposition =
  | 'orthogonal-bands'
  | 'technical-grid'
  | 'paper-fields'
  | 'orbit-spotlight'
  | 'horizon-waves'
  | 'aurora-veil'
  | 'organic-mesh'
  | 'spotlight'

const FONT_STACK_BY_SOURCE: Readonly<Record<string, string>> = {
  Geist: '"Geist Variable", system-ui, sans-serif',
  'Funnel Sans': '"Funnel Sans Variable", system-ui, sans-serif',
  Archivo: '"Archivo Variable", system-ui, sans-serif',
  'Archivo Narrow': '"Archivo Narrow Variable", system-ui, sans-serif',
  Nunito: '"Nunito Variable", system-ui, sans-serif',
  Newsreader: '"Newsreader Variable", Georgia, serif',
  'Playfair Display': '"Playfair Display Variable", Georgia, serif',
  'Source Sans 3': '"Source Sans 3 Variable", system-ui, sans-serif',
  'Space Grotesk': '"Space Grotesk Variable", system-ui, sans-serif',
  'IBM Plex Mono': '"IBM Plex Mono", ui-monospace, SFMono-Regular, monospace',
}

/**
 * @deprecated Superseded by `appBackground.kind === 'effect'`, which carries
 * the same NONE/MESH/PARTICLES/NOISE/AURORA vocabulary and is the one the
 * cabinet actually renders (`reiwa/web/src/components/layout/app-background.tsx`,
 * the `kind === "effect"` branch). `bgEffect` itself is inert end to end: the
 * cabinet writes it to `root.dataset["bgEffect"]`
 * (`reiwa/web/src/lib/branding-document.ts`) and nothing reads that attribute —
 * no CSS selector, no component, no preview — and the panel has no operator
 * control for it either, only presets write it. Kept as a stored field because
 * removing it needs a settings migration and buys nothing; do not wire it up.
 */
export type ThemePresetBgEffect =
  | 'NONE'
  | 'MESH'
  | 'PARTICLES'
  | 'NOISE'
  | 'AURORA'

/** Everything both theme families resolve. */
interface ThemePresetBase {
  /** Stable id persisted in branding. Doubles as the i18n key for legacy ids. */
  readonly id: string
  readonly version: number
  readonly primary: HexColor
  readonly primaryFg: HexColor
  readonly bgPrimary: HexColor
  readonly bgSecondary: HexColor
  readonly cardGradient: string
  /** @deprecated Dead everywhere; see `ThemePresetBgEffect`. */
  readonly bgEffect: ThemePresetBgEffect
}

/**
 * One of the eight standard themes that predate the concept catalog. It has no
 * source page, no audited composition and no typography of its own, so it does
 * not pretend to: the fields above are exactly what it declares.
 *
 * What it APPLIES is wider than what it declares, by exactly two fields — see
 * `createLegacyThemePresetVisualPatch`.
 */
export interface LegacyThemePreset extends ThemePresetBase {
  readonly kind: 'legacy'
}

/** A theme fully resolved from one of the 104 audited concepts. */
export interface ConceptThemePreset extends ThemePresetBase {
  readonly kind: 'concept'
  readonly code: string
  readonly name: string
  readonly palette: readonly HexColor[]
  readonly sourcePage: number
  readonly visualFamily: string
  readonly appComposition: ConceptComposition
  readonly cardComposition: ConceptComposition
  readonly cardPattern: string | null
  readonly cardEffect: string
  readonly cardEffectProps: Readonly<Record<string, unknown>>
  readonly cardEffectOpacity: number
  readonly appBackground: BrandingAppBackgroundDraft
  readonly borderRadius: string
  readonly cornerRadii: BrandingCornerRadiiDraft
  readonly fontFamily: string
  readonly surfaceTheme: BrandingSurfaceThemeDraft
}

export type ThemePreset = LegacyThemePreset | ConceptThemePreset

/**
 * The eight standard themes, verbatim from before the concept release. Their
 * bare ids stay unprefixed so branding saved by an operator earlier keeps
 * resolving to the same entry.
 */
export const LEGACY_THEME_PRESETS: readonly LegacyThemePreset[] = [
  {
    kind: 'legacy',
    id: 'emerald',
    version: THEME_PRESET_VERSION,
    primary: '#22c55e',
    primaryFg: '#0a0a0a',
    bgPrimary: '#0a0a0a',
    bgSecondary: '#171717',
    cardGradient: 'linear-gradient(135deg, #064e3b 0%, #22c55e 100%)',
    bgEffect: 'AURORA',
  },
  {
    kind: 'legacy',
    id: 'royal',
    version: THEME_PRESET_VERSION,
    primary: '#6366f1',
    primaryFg: '#0a0a0a',
    bgPrimary: '#09090b',
    bgSecondary: '#18181b',
    cardGradient: 'linear-gradient(135deg, #1e1b4b 0%, #6366f1 100%)',
    bgEffect: 'AURORA',
  },
  {
    kind: 'legacy',
    id: 'sunset',
    version: THEME_PRESET_VERSION,
    primary: '#f97316',
    primaryFg: '#0a0a0a',
    bgPrimary: '#0c0a09',
    bgSecondary: '#1c1917',
    cardGradient: 'linear-gradient(135deg, #7c2d12 0%, #f97316 100%)',
    bgEffect: 'AURORA',
  },
  {
    kind: 'legacy',
    id: 'rose',
    version: THEME_PRESET_VERSION,
    primary: '#f43f5e',
    primaryFg: '#0a0a0a',
    bgPrimary: '#0a0a0a',
    bgSecondary: '#18181b',
    cardGradient: 'linear-gradient(135deg, #881337 0%, #f43f5e 100%)',
    bgEffect: 'AURORA',
  },
  {
    kind: 'legacy',
    id: 'cyan',
    version: THEME_PRESET_VERSION,
    primary: '#06b6d4',
    primaryFg: '#0a0a0a',
    bgPrimary: '#08090a',
    bgSecondary: '#15191c',
    cardGradient: 'linear-gradient(135deg, #164e63 0%, #06b6d4 100%)',
    bgEffect: 'AURORA',
  },
  {
    kind: 'legacy',
    id: 'violet',
    version: THEME_PRESET_VERSION,
    primary: '#a855f7',
    primaryFg: '#0a0a0a',
    bgPrimary: '#0a0812',
    bgSecondary: '#1a1625',
    cardGradient: 'linear-gradient(135deg, #4c1d95 0%, #a855f7 100%)',
    bgEffect: 'AURORA',
  },
  {
    kind: 'legacy',
    id: 'amber',
    version: THEME_PRESET_VERSION,
    primary: '#f59e0b',
    primaryFg: '#0a0a0a',
    bgPrimary: '#0c0a09',
    bgSecondary: '#1c1917',
    cardGradient: 'linear-gradient(135deg, #78350f 0%, #f59e0b 100%)',
    bgEffect: 'MESH',
  },
  {
    kind: 'legacy',
    id: 'mono',
    version: THEME_PRESET_VERSION,
    primary: '#e5e5e5',
    primaryFg: '#0a0a0a',
    bgPrimary: '#0a0a0a',
    bgSecondary: '#171717',
    cardGradient: 'linear-gradient(135deg, #262626 0%, #525252 100%)',
    bgEffect: 'NOISE',
  },
] as const

export const CONCEPT_THEME_PRESETS: readonly ConceptThemePreset[] =
  CONCEPT_PRESETS.map(createConceptReiwaPreset)

export const THEME_PRESETS: readonly ThemePreset[] = [
  ...LEGACY_THEME_PRESETS,
  ...CONCEPT_THEME_PRESETS,
]

export const THEME_PRESET_BY_ID: Readonly<Record<string, ThemePreset>> =
  Object.fromEntries(THEME_PRESETS.map((preset) => [preset.id, preset]))

/**
 * Only concept themes resolve an audited app-background texture, so the
 * runtime overlay is keyed on the preset identity rather than on the presence
 * of a texture recipe (every gradient draft carries a default one).
 */
export function isConceptThemePresetId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith('concept-')
}

/** The fields BOTH families resolve from their own declared data. */
type SharedThemePresetVisualPatch = Pick<
  BrandingFormDraft,
  | 'themePresetId'
  | 'themePresetVersion'
  | 'primary'
  | 'primaryFg'
  | 'bgPrimary'
  | 'bgSecondary'
  | 'cardGradient'
  | 'bgEffect'
>

/**
 * What a standard theme writes: the six visual fields it declares, plus the
 * two that decide whether they are legible.
 *
 * `surfaceTheme` and `appBackground` are REQUIRED here rather than optional
 * (`BrandingFormDraft.appBackground` is optional) because omitting them is the
 * defect: the backend merge preserves absent keys and the cabinet applies
 * whatever is stored with no per-preset defaulting, so an omitted key is not
 * "unchanged", it is "whatever the last concept left behind".
 */
export type LegacyThemePresetVisualPatch = SharedThemePresetVisualPatch & {
  readonly surfaceTheme: BrandingSurfaceThemeDraft
  readonly appBackground: BrandingAppBackgroundDraft
}

/** A concept additionally owns card artwork, geometry and typography. */
export type ConceptThemePresetVisualPatch = LegacyThemePresetVisualPatch & {
  readonly cardPattern: string | null
  readonly cardEffect: string
  readonly cardEffectProps: Record<string, unknown>
  readonly cardEffectOpacity: number
  readonly borderRadius: string
  readonly cornerRadii: BrandingCornerRadiiDraft
  readonly fontFamily: string
}

export type ThemePresetVisualPatch =
  | LegacyThemePresetVisualPatch
  | ConceptThemePresetVisualPatch

/**
 * Two resolved representations of one operator-selected concept. Reiwa
 * receives these values as data, so an end user can change only brightness
 * (when the operator permits it) and never gains the concept catalogue.
 */
/**
 * Brightness snapshots must be directly submittable as the current branding
 * DTO. The card-text policy is not a concept visual token, so it is inherited
 * from the operator (or `auto` when called outside the form) rather than
 * derived from a concept palette.
 */
export type ConceptThemeModeVariants = Readonly<{
  light: ConceptThemePresetVisualPatch &
    Pick<BrandingFormDraft, 'subscriptionCardText'>
  dark: ConceptThemePresetVisualPatch &
    Pick<BrandingFormDraft, 'subscriptionCardText'>
}>

const DEFAULT_VARIANT_SUBSCRIPTION_CARD_TEXT: BrandingSubscriptionCardTextDraft = {
  mode: 'auto',
  color: null,
}

function createSharedThemePresetVisualPatch(
  preset: ThemePresetBase,
): SharedThemePresetVisualPatch {
  return {
    themePresetId: preset.id,
    themePresetVersion: preset.version,
    primary: preset.primary,
    primaryFg: preset.primaryFg,
    bgPrimary: preset.bgPrimary,
    bgSecondary: preset.bgSecondary,
    cardGradient: preset.cardGradient,
    bgEffect: preset.bgEffect,
  }
}

/**
 * A standard theme supplies two fields it does not declare, and both are bug
 * fixes rather than new capabilities.
 *
 * `surfaceTheme` — `DEFAULT_SURFACE_THEME_DRAFT` is the pre-concept cabinet
 * these eight themes were designed against, and it is dark, matching all eight
 * of their backgrounds. It is not a choice made here: the identical object is
 * the default in `branding-form-schema.ts`, in reiwa's `types/branding.ts`
 * (`DEFAULT_SURFACE_THEME`) and in the API's `DEFAULT_BRANDING_SETTINGS`.
 * Omitting it left the FOREGROUND colours owned by the concept the operator
 * had just replaced while their BACKGROUND came from the theme they just
 * picked — the exact split `detachSurfaceThemeFromConcept` in `branding-page`
 * exists to prevent, and it is unreadable, not merely mismatched.
 *
 * `appBackground` — reset to the default built-in (`kind: 'none'`). A leftover
 * concept background is not an operator choice worth preserving because it is
 * already rendering broken: the cabinet gates both the texture overlay
 * (`app-background.tsx`) and the concept-texture contribution to the
 * readability veil (`app-background-contrast.ts`) on
 * `themePresetId.startsWith("concept-")`, so under a standard preset id the
 * concept's gradient keeps painting while the layers drawn on top of it stop.
 * That composition is one neither theme designed.
 *
 * Deliberately NOT written: `fontFamily`, `borderRadius`, `cornerRadii`,
 * `cardPattern`, `cardEffect`, `cardEffectProps`, `cardEffectOpacity`. The
 * eight standard themes have no typography, geometry or card artwork of their
 * own, so writing them would not apply anything — it would only erase operator
 * choices that have dedicated controls.
 *
 * Both defaults are COPIED, not aliased, and the test pins that. The value
 * returned here is handed straight to `form.setValue('surfaceTheme', …)` and
 * then edited field-by-field through nested paths
 * (`form.setValue('surfaceTheme.foreground', …)` in `SurfaceColorField`). An
 * alias would put a shared module constant — the same object
 * `createInitialBrandingDraft()` seeds every draft from — inside a mutable
 * form. Whether react-hook-form writes through that alias was not established
 * either way; the copy costs one spread and removes the question. Note that
 * `createConceptThemePresetVisualPatch` does alias its `preset.surfaceTheme`
 * and `preset.appBackground`, so if the answer ever turns out to be "yes",
 * that is where to look — not here.
 */
export function createLegacyThemePresetVisualPatch(
  preset: LegacyThemePreset,
): LegacyThemePresetVisualPatch {
  return {
    ...createSharedThemePresetVisualPatch(preset),
    surfaceTheme: { ...DEFAULT_SURFACE_THEME_DRAFT },
    appBackground: {
      ...DEFAULT_APP_BACKGROUND_DRAFT,
      texture: { ...DEFAULT_APP_BACKGROUND_DRAFT.texture },
      props: { ...DEFAULT_APP_BACKGROUND_DRAFT.props },
    },
  }
}

export function createConceptThemePresetVisualPatch(
  preset: ConceptThemePreset,
): ConceptThemePresetVisualPatch {
  return {
    ...createSharedThemePresetVisualPatch(preset),
    cardPattern: preset.cardPattern,
    cardEffect: preset.cardEffect,
    cardEffectProps: { ...preset.cardEffectProps },
    cardEffectOpacity: preset.cardEffectOpacity,
    appBackground: preset.appBackground,
    borderRadius: preset.borderRadius,
    cornerRadii: preset.cornerRadii,
    fontFamily: preset.fontFamily,
    surfaceTheme: preset.surfaceTheme,
  }
}

export function createConceptThemeModeVariants(
  preset: ConceptThemePreset,
  subscriptionCardText: BrandingSubscriptionCardTextDraft =
    DEFAULT_VARIANT_SUBSCRIPTION_CARD_TEXT,
): ConceptThemeModeVariants {
  const descriptor = CONCEPT_PRESETS.find(
    (candidate) => candidate.id === preset.id,
  )
  // A concept preset is built from this canonical catalogue. Keeping the
  // explicit error protects future refactors from silently shipping a partial
  // theme variant when an id is renamed.
  if (!descriptor) {
    throw new Error(`Unknown concept theme preset: ${preset.id}`)
  }

  const createVariant = (mode: ConceptSourceMode) => ({
    ...createConceptThemePresetVisualPatch(
      createConceptReiwaPresetForMode(descriptor, mode),
    ),
    // Copy, do not retain the form reference: brightness snapshots should not
    // mutate if a user subsequently edits this global policy.
    subscriptionCardText: { ...subscriptionCardText },
  })

  return {
    light: createVariant('light'),
    dark: createVariant('dark'),
  }
}

export function createThemePresetVisualPatch(
  preset: LegacyThemePreset,
): LegacyThemePresetVisualPatch
export function createThemePresetVisualPatch(
  preset: ConceptThemePreset,
): ConceptThemePresetVisualPatch
export function createThemePresetVisualPatch(
  preset: ThemePreset,
): ThemePresetVisualPatch
export function createThemePresetVisualPatch(
  preset: ThemePreset,
): ThemePresetVisualPatch {
  return preset.kind === 'legacy'
    ? createLegacyThemePresetVisualPatch(preset)
    : createConceptThemePresetVisualPatch(preset)
}

export function createConceptReiwaPreset(
  descriptor: ConceptPresetDescriptor,
): ConceptThemePreset {
  return createConceptReiwaPresetForMode(
    descriptor,
    getConceptSourceMode(descriptor),
  )
}

function createConceptReiwaPresetForMode(
  descriptor: ConceptPresetDescriptor,
  mode: ConceptSourceMode,
): ConceptThemePreset {
  if (mode !== getConceptSourceMode(descriptor)) {
    return createOppositeConceptReiwaPreset(descriptor, mode)
  }
  const source = getConceptSourceStyle(descriptor)
  const isLight = getConceptSourceMode(descriptor) === 'light'
  const bgPrimary = getConceptSourceBackgroundColor(descriptor)
  const primary = opaqueHex(source.accent)
  const secondaryAccent = pickPrimary(
    descriptor.palette.filter((color) => color !== primary) as HexColor[],
    bgPrimary,
  )
  const border = opaqueHex(source.border)
  const appGradient = buildBackgroundGradient(descriptor, bgPrimary)
  const appSamples = extractGradientHexColors(appGradient, bgPrimary)
  const foreground = ensureTextContrast(
    opaqueHex(source.foreground),
    bgPrimary,
  )
  const readableSurface = resolveReadableSurface(
    opaqueHex(source.surface),
    sourceAlpha(
      source.surface,
      descriptor.classification.backgroundBlur ? (isLight ? 0.72 : 0.64) : 0.9,
    ),
    bgPrimary,
    appSamples,
    foreground,
  )
  const readableSurfaceHigh = resolveReadableSurface(
    opaqueHex(source.card),
    sourceAlpha(
      source.card,
      descriptor.classification.backgroundBlur ? (isLight ? 0.84 : 0.78) : 0.96,
    ),
    bgPrimary,
    appSamples,
    foreground,
  )
  const surface = readableSurface.color
  const surfaceHigh = readableSurfaceHigh.color
  const surfaceOpacity = readableSurface.opacity
  const surfaceHighOpacity = readableSurfaceHigh.opacity
  const surfaceSamples = appSamples.flatMap((sample) => [
    mixHex(surface, sample, surfaceOpacity),
    mixHex(surfaceHigh, sample, surfaceHighOpacity),
  ])
  // The global semantic foreground must remain readable on the cabinet
  // foundation. Surface copies use the same source family and are almost
  // opaque; muted/control tokens below are the pairs that need composited
  // worst-case enforcement.
  const mutedForeground = ensureContrastAcross(
    opaqueHex(source.mutedForeground),
    surfaceSamples,
    4.5,
  )
  // Keep a small guard above the 3:1 UI threshold so 8-bit rounding and
  // browser colour conversion cannot drop a nominally valid boundary below it.
  const borderStrong = ensureContrastAcross(border, surfaceSamples, 3.1)
  const effect = deriveCardEffect(descriptor)
  const cardPattern = deriveCardPattern(descriptor, primary)
  const hasBlur = descriptor.classification.backgroundBlur
  const cornerRadii = exactCornerRadii(descriptor)

  return {
    kind: 'concept',
    id: descriptor.id,
    version: THEME_PRESET_VERSION,
    code: descriptor.code,
    name: descriptor.name,
    palette: descriptor.palette,
    sourcePage: descriptor.sourcePage,
    visualFamily: descriptor.classification.visualFamily,
    appComposition: classifyAppComposition(descriptor),
    cardComposition: classifyCardComposition(descriptor),
    primary,
    primaryFg: contrastText(primary),
    bgPrimary,
    bgSecondary: surface,
    cardGradient: buildCardGradient(descriptor, bgPrimary),
    cardPattern,
    cardEffect: effect,
    cardEffectProps: buildEffectProps(
      effect,
      primary,
      secondaryAccent,
      bgPrimary,
    ),
    cardEffectOpacity:
      effect === 'paperGrain'
        ? 0.62
        : descriptor.classification.effectClass === 'flat'
          ? 0.68
          : 0.84,
    bgEffect: deriveLegacyBgEffect(descriptor),
    appBackground: buildAppBackground(
      descriptor,
      appGradient,
      primary,
      bgPrimary,
    ),
    borderRadius: radiusClassForConcept(descriptor),
    cornerRadii,
    fontFamily: fontStack(source.bodyFont),
    surfaceTheme: {
      foreground,
      mutedForeground,
      surface,
      surfaceHigh,
      borderSoft: border,
      borderStrong,
      surfaceOpacity,
      surfaceHighOpacity,
      borderSoftOpacity: sourceAlpha(source.border, isLight ? 0.18 : 0.14),
      borderStrongOpacity: Math.min(
        1,
        Math.max(0.32, sourceAlpha(source.border, isLight ? 0.28 : 0.24) * 1.6),
      ),
      glassBlurPx: hasBlur
        ? Math.min(32, Math.max(12, descriptor.classification.canonicalRadius))
        : 0,
    },
  }
}

/**
 * Builds the alternate brightness of an audited concept. The concept's
 * typography, geometry, visual family and animation remain the same; only
 * semantic surfaces and the colour foundations move to the catalogue's
 * opposite light/dark token set. This is intentionally not a generic colour
 * inversion — every composition still comes from its own descriptor.
 */
function createOppositeConceptReiwaPreset(
  descriptor: ConceptPresetDescriptor,
  mode: ConceptSourceMode,
): ConceptThemePreset {
  const source = getConceptSourceStyle(descriptor)
  const visual = getConceptThemeModeVisual(descriptor, mode)
  const tokens = visual.tokens
  const isLight = mode === 'light'
  const bgPrimary = opaqueHex(tokens.background)
  const primary = opaqueHex(tokens.primary)
  const secondaryAccent = opaqueHex(tokens['chart-2'])
  const surface = opaqueHex(tokens.secondary)
  const surfaceHigh = opaqueHex(tokens.card)
  const foreground = ensureTextContrast(opaqueHex(tokens.foreground), bgPrimary)
  const cardGradient = buildModeCardGradient(
    descriptor,
    mode,
    bgPrimary,
    surfaceHigh,
    primary,
    secondaryAccent,
  )
  const appGradient = compactModeAppGradient(
    descriptor,
    visual.backgroundImage,
    bgPrimary,
    surface,
    primary,
    secondaryAccent,
  )
  const effect = deriveCardEffect(descriptor)

  return {
    kind: 'concept',
    id: descriptor.id,
    version: THEME_PRESET_VERSION,
    code: descriptor.code,
    name: descriptor.name,
    palette: descriptor.palette,
    sourcePage: descriptor.sourcePage,
    visualFamily: descriptor.classification.visualFamily,
    appComposition: classifyAppComposition(descriptor),
    cardComposition: classifyCardComposition(descriptor),
    primary,
    primaryFg: contrastText(primary),
    bgPrimary,
    bgSecondary: surface,
    cardGradient,
    cardPattern: deriveCardPattern(descriptor, primary),
    cardEffect: effect,
    cardEffectProps: buildEffectProps(
      effect,
      primary,
      secondaryAccent,
      bgPrimary,
    ),
    cardEffectOpacity:
      effect === 'paperGrain'
        ? 0.62
        : descriptor.classification.effectClass === 'flat'
          ? 0.68
          : 0.84,
    bgEffect: deriveLegacyBgEffect(descriptor),
    appBackground: buildAppBackground(
      descriptor,
      appGradient,
      primary,
      bgPrimary,
    ),
    borderRadius: radiusClassForConcept(descriptor),
    cornerRadii: exactCornerRadii(descriptor),
    fontFamily: fontStack(source.bodyFont),
    surfaceTheme: {
      foreground,
      mutedForeground: ensureContrastAcross(
        opaqueHex(tokens['muted-foreground']),
        [surface, surfaceHigh],
        4.5,
      ),
      surface,
      surfaceHigh,
      borderSoft: opaqueHex(tokens.border),
      borderStrong: ensureContrastAcross(
        opaqueHex(tokens.border),
        [surface, surfaceHigh],
        3.1,
      ),
      surfaceOpacity: isLight ? 0.94 : 0.9,
      surfaceHighOpacity: isLight ? 0.98 : 0.96,
      borderSoftOpacity: isLight ? 0.18 : 0.14,
      borderStrongOpacity: isLight ? 0.38 : 0.34,
      glassBlurPx: descriptor.classification.backgroundBlur
        ? Math.min(32, Math.max(12, descriptor.classification.canonicalRadius))
        : 0,
    },
  }
}

function buildModeCardGradient(
  descriptor: ConceptPresetDescriptor,
  mode: ConceptSourceMode,
  background: HexColor,
  card: HexColor,
  primary: HexColor,
  accent: HexColor,
): string {
  const seed = stableSeed(`${descriptor.id}:${mode}:card-variant`)
  const x = 58 + (seed % 31)
  const y = 8 + ((seed >>> 8) % 35)
  const angle = 112 + ((seed >>> 16) % 67)
  const primaryWash = mode === 'light' ? '54' : 'A8'
  const accentWash = mode === 'light' ? '40' : '88'

  switch (classifyCardComposition(descriptor)) {
    case 'technical-grid':
    case 'orthogonal-bands':
      return `linear-gradient(${angle}deg, ${card} 0 45%, ${withAlpha(primary, primaryWash)} 45% 68%, ${background} 68% 100%)`
    case 'paper-fields':
      return `linear-gradient(${angle}deg, ${card} 0%, ${withAlpha(primary, primaryWash)} 56%, ${background} 100%)`
    case 'horizon-waves':
      return [
        `radial-gradient(ellipse 92% 64% at ${x}% 8%, ${withAlpha(accent, accentWash)} 0%, transparent 66%)`,
        `linear-gradient(180deg, ${card} 0%, ${background} 100%)`,
      ].join(', ')
    case 'orbit-spotlight':
    case 'aurora-veil':
    case 'organic-mesh':
    case 'spotlight':
      return [
        `radial-gradient(circle at ${x}% ${y}%, ${withAlpha(primary, primaryWash)} 0%, transparent 48%)`,
        `radial-gradient(circle at ${100 - x}% ${100 - y}%, ${withAlpha(accent, accentWash)} 0%, transparent 54%)`,
        `linear-gradient(${angle}deg, ${card} 0%, ${background} 100%)`,
      ].join(', ')
  }
}

/**
 * The form/API deliberately caps persisted CSS artwork at 512 characters.
 * A handful of opposite-mode concept compositions contain many decorative
 * layers, so keep their visual family but compact them into a safe, durable
 * two/three-layer background rather than dropping the whole light/dark pair.
 */
function compactModeAppGradient(
  descriptor: ConceptPresetDescriptor,
  artwork: string,
  background: HexColor,
  surface: HexColor,
  primary: HexColor,
  accent: HexColor,
): string {
  if (artwork !== 'none' && artwork.length <= 512) return artwork

  switch (classifyAppComposition(descriptor)) {
    case 'technical-grid':
    case 'orthogonal-bands':
      return `linear-gradient(90deg, ${background} 0 42%, ${surface} 42% 68%, ${primary} 68% 100%)`
    case 'paper-fields':
      return `linear-gradient(135deg, ${surface} 0%, ${background} 58%, ${primary} 100%)`
    case 'horizon-waves':
      return `radial-gradient(ellipse 92% 46% at 70% 10%, ${accent} 0%, transparent 68%), linear-gradient(180deg, ${surface}, ${background})`
    default:
      return `radial-gradient(circle at 74% 18%, ${primary} 0%, transparent 50%), linear-gradient(135deg, ${surface}, ${background})`
  }
}

function pickPrimary(
  palette: readonly HexColor[],
  canvas: HexColor,
): HexColor {
  const candidates = palette.filter((color) => color !== canvas)
  return [...(candidates.length > 0 ? candidates : palette)].sort(
    (left, right) => primaryScore(right, canvas) - primaryScore(left, canvas),
  )[0]
}

function primaryScore(color: HexColor, canvas: HexColor): number {
  const lightness = luminance(color)
  const usable = lightness > 0.015 && lightness < 0.96 ? 0.4 : 0
  return chroma(color) * 1.7 + Math.min(contrastRatio(color, canvas), 7) / 10 + usable
}

function contrastText(background: HexColor): HexColor {
  const black: HexColor = '#000000'
  const white: HexColor = '#FFFFFF'
  return contrastRatio(black, background) >= contrastRatio(white, background)
    ? black
    : white
}

function opaqueHex(color: HexColor): HexColor {
  if (color.length === 4 || color.length === 5) {
    return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}` as HexColor
  }
  return color.slice(0, 7) as HexColor
}

function sourceAlpha(color: HexColor, fallback: number): number {
  if (color.length === 5) {
    return Number.parseInt(`${color[4]}${color[4]}`, 16) / 255
  }
  if (color.length === 9) {
    return Number.parseInt(color.slice(7, 9), 16) / 255
  }
  return fallback
}

function ensureTextContrast(
  preferred: HexColor,
  background: HexColor,
): HexColor {
  if (contrastRatio(preferred, background) >= 4.5) return preferred
  const target = contrastText(background)
  for (let preferredWeight = 0.99; preferredWeight >= 0; preferredWeight -= 0.01) {
    const candidate = mixHex(preferred, target, preferredWeight)
    if (contrastRatio(candidate, background) >= 4.6) return candidate
  }
  return target
}

function ensureContrastAcross(
  preferred: HexColor,
  backgrounds: readonly HexColor[],
  minimum: number,
): HexColor {
  if (
    backgrounds.every(
      (background) => contrastRatio(preferred, background) >= minimum,
    )
  ) {
    return preferred
  }

  const black: HexColor = '#000000'
  const white: HexColor = '#FFFFFF'
  const minimumRatio = (candidate: HexColor): number =>
    Math.min(
      ...backgrounds.map((background) =>
        contrastRatio(candidate, background),
      ),
    )
  const target =
    minimumRatio(black) >= minimumRatio(white) ? black : white

  for (
    let preferredWeight = 0.99;
    preferredWeight >= 0;
    preferredWeight -= 0.01
  ) {
    const candidate = mixHex(preferred, target, preferredWeight)
    if (minimumRatio(candidate) >= minimum + 0.05) return candidate
  }
  return target
}

function extractGradientHexColors(
  gradient: string,
  fallback: HexColor,
): readonly HexColor[] {
  const colors = [...gradient.matchAll(/#[\da-f]{6}(?:[\da-f]{2})?/gi)].map(
    (match) => match[0].toUpperCase() as HexColor,
  )
  const opaqueBackdrops = colors
    .filter((color) => color.length === 7)
    .map(opaqueHex)
  const backdrops =
    opaqueBackdrops.length > 0 ? opaqueBackdrops : [fallback]
  const translucentSamples = colors
    .filter((color) => color.length === 9)
    .flatMap((color) =>
      backdrops.map((backdrop) =>
        mixHex(opaqueHex(color), backdrop, sourceAlpha(color, 1)),
      ),
    )
  return [...new Set([...backdrops, ...translucentSamples])]
}

interface ReadableSurface {
  readonly color: HexColor
  readonly opacity: number
}

/**
 * Preserve the source glass recipe whenever its semantic foreground remains
 * readable over every app-gradient stop. If an exceptionally translucent,
 * accent-coloured surface crosses both light and dark stops, strengthen only
 * that surface towards the concept foundation. This avoids flattening the
 * other concepts while giving the runtime one stable text tone.
 */
function resolveReadableSurface(
  preferred: HexColor,
  preferredOpacity: number,
  foundation: HexColor,
  appSamples: readonly HexColor[],
  foreground: HexColor,
): ReadableSurface {
  const isReadable = (color: HexColor, opacity: number): boolean =>
    appSamples.every(
      (sample) =>
        contrastRatio(foreground, mixHex(color, sample, opacity)) >= 4.6,
    )

  if (isReadable(preferred, preferredOpacity)) {
    return { color: preferred, opacity: preferredOpacity }
  }

  for (
    let opacity = Math.max(0.72, preferredOpacity);
    opacity <= 0.96;
    opacity += 0.04
  ) {
    for (
      let preferredWeight = 0.95;
      preferredWeight >= 0;
      preferredWeight -= 0.05
    ) {
      const candidate = mixHex(preferred, foundation, preferredWeight)
      if (isReadable(candidate, opacity)) {
        return {
          color: candidate,
          opacity: Math.min(0.96, Number(opacity.toFixed(2))),
        }
      }
    }
  }

  return { color: foundation, opacity: 0.96 }
}

function stableSeed(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function conceptTags(descriptor: ConceptPresetDescriptor): Set<string> {
  return new Set(descriptor.classification.visualTags)
}

export function classifyAppComposition(
  descriptor: ConceptPresetDescriptor,
): ConceptComposition {
  const name = descriptor.name.toLocaleLowerCase()
  const tags = conceptTags(descriptor)
  if (/monolith|bauhaus|swiss|construct|modular/.test(name)) {
    return 'orthogonal-bands'
  }
  if (
    tags.has('technical') ||
    /grid|circuit|blueprint|matrix|terminal|map|cartograph|signal/.test(name)
  ) {
    return 'technical-grid'
  }
  if (
    tags.has('editorial') ||
    /paper|linen|parchment|editorial|collage|news/.test(name)
  ) {
    return 'paper-fields'
  }
  if (/aurora|borealis|veil/.test(name)) return 'aurora-veil'
  if (/orbit|lunar|planet|saturn|neptune|venus|polar/.test(name)) {
    return 'orbit-spotlight'
  }
  if (/ocean|lagoon|wave|tide|horizon/.test(name)) return 'horizon-waves'
  if (descriptor.classification.visualFamily === 'glass-dimensional') {
    return 'organic-mesh'
  }
  if (descriptor.classification.visualFamily === 'hard-edge') {
    return 'orthogonal-bands'
  }
  if (
    descriptor.classification.visualFamily.includes('glass') ||
    tags.has('atmospheric')
  ) {
    return 'spotlight'
  }
  return descriptor.classification.backgroundType === 'mesh-gradient'
    ? 'organic-mesh'
    : 'spotlight'
}

export function classifyCardComposition(
  descriptor: ConceptPresetDescriptor,
): ConceptComposition {
  const name = descriptor.name.toLocaleLowerCase()
  const tags = conceptTags(descriptor)
  if (/polar|orbit|lunar|planet|saturn|neptune|venus|monolith/.test(name)) {
    return 'orbit-spotlight'
  }
  if (/ocean|lagoon|wave|tide|horizon/.test(name)) return 'horizon-waves'
  if (/aurora|borealis|veil/.test(name)) return 'aurora-veil'
  if (
    tags.has('technical') ||
    /grid|circuit|blueprint|matrix|terminal|map|cartograph|signal/.test(name)
  ) {
    return 'technical-grid'
  }
  if (
    tags.has('editorial') ||
    /paper|linen|parchment|editorial|collage|swiss|news/.test(name)
  ) {
    return 'paper-fields'
  }
  if (descriptor.classification.visualFamily === 'hard-edge') {
    return 'orthogonal-bands'
  }
  if (descriptor.classification.visualFamily === 'glass-dimensional') {
    return 'organic-mesh'
  }
  return 'spotlight'
}

function buildCardGradient(
  descriptor: ConceptPresetDescriptor,
  canvas: HexColor,
): string {
  const source = getConceptSourceStyle(descriptor)
  const accent = opaqueHex(source.accent)
  const seed = stableSeed(`${descriptor.id}:${descriptor.name}:card`)
  const palette = descriptor.palette.map(opaqueHex)
  const ordered = [...palette].sort((left, right) => luminance(left) - luminance(right))
  const dark = ordered[0]
  const darkTwo = ordered[1] ?? mixHex(dark, canvas, 0.72)
  const light = ordered.at(-1) ?? contrastText(dark)
  const secondary = ordered[Math.min(ordered.length - 1, 4)] ?? accent
  const x = 58 + (seed % 31)
  const y = 8 + ((seed >>> 8) % 35)
  const angle = 112 + ((seed >>> 16) % 67)

  switch (classifyCardComposition(descriptor)) {
    case 'orbit-spotlight':
      return [
        `radial-gradient(circle at ${x}% ${y}%, ${withAlpha(light, 'E8')} 0%, ${withAlpha(accent, 'A0')} 13%, transparent 38%)`,
        `radial-gradient(circle at ${x}% ${y}%, transparent 0 27%, ${withAlpha(secondary, '68')} 28% 30%, transparent 31%)`,
        `linear-gradient(${angle}deg, ${dark} 0%, ${mixHex(dark, accent, 0.84)} 56%, ${darkTwo} 100%)`,
      ].join(', ')
    case 'technical-grid':
      return `linear-gradient(${angle}deg, ${dark} 0 44%, ${mixHex(dark, accent, 0.7)} 44% 67%, ${darkTwo} 67% 100%)`
    case 'paper-fields':
      return `linear-gradient(${angle}deg, ${light} 0 34%, ${mixHex(light, accent, 0.82)} 34% 72%, ${mixHex(light, canvas, 0.72)} 72% 100%)`
    case 'orthogonal-bands':
      return `linear-gradient(${angle}deg, ${dark} 0 52%, ${accent} 52% 68%, ${mixHex(darkTwo, secondary, 0.72)} 68% 100%)`
    case 'horizon-waves':
      return [
        `radial-gradient(ellipse 90% 58% at ${x}% 8%, ${withAlpha(secondary, 'CC')} 0%, transparent 64%)`,
        `linear-gradient(180deg, ${darkTwo} 0%, ${mixHex(dark, accent, 0.72)} 54%, ${dark} 100%)`,
      ].join(', ')
    case 'aurora-veil':
    case 'organic-mesh':
      return [
        `radial-gradient(circle at ${100 - x}% ${y}%, ${withAlpha(accent, 'D6')} 0%, transparent 48%)`,
        `radial-gradient(circle at ${x}% ${100 - y}%, ${withAlpha(secondary, 'B8')} 0%, transparent 52%)`,
        `linear-gradient(${angle}deg, ${dark} 0%, ${darkTwo} 100%)`,
      ].join(', ')
    case 'spotlight':
      return `radial-gradient(circle at ${x}% ${y}%, ${accent} 0%, ${mixHex(darkTwo, accent, 0.74)} 38%, ${dark} 100%)`
  }
}

function buildBackgroundGradient(
  descriptor: ConceptPresetDescriptor,
  canvas: HexColor,
): string {
  const source = getConceptSourceStyle(descriptor)
  let base: string
  if (descriptor.code === 'CU') {
    // Pencil EaXoT: a light polar mesh under the red monolith and blue slabs.
    // Keep this foundation explicit; the generic mesh fallback picks dark
    // palette swatches and turns the right half almost black.
    base = [
      'radial-gradient(circle at 48% 108%, #91AAB2 0%, transparent 56%)',
      'linear-gradient(135deg, #EDF5F7 0%, #C7DBE1 54%, #FFFDFB 100%)',
    ].join(', ')
  } else if (source.background?.includes('gradient(')) {
    base = source.background
  } else if (source.background?.startsWith('#')) {
    const solid = opaqueHex(source.background as HexColor)
    base = `linear-gradient(135deg, ${solid} 0%, ${solid} 100%)`
  } else {
    const [a, b, c] = descriptor.palette.map(opaqueHex)
    base = [
      `radial-gradient(circle at 14% 10%, ${withAlpha(a, '72')} 0%, transparent 42%)`,
      `radial-gradient(circle at 86% 14%, ${withAlpha(c, '58')} 0%, transparent 46%)`,
      `linear-gradient(145deg, ${canvas} 0%, ${b} 100%)`,
    ].join(', ')
  }
  return addAppComposition(descriptor, base)
}

function addAppComposition(
  descriptor: ConceptPresetDescriptor,
  base: string,
): string {
  const seed = stableSeed(`${descriptor.id}:${descriptor.name}:app`)
  const palette = descriptor.palette.map(opaqueHex)
  const accent = opaqueHex(getConceptSourceStyle(descriptor).accent)
  const secondary = palette[3] ?? palette[2] ?? accent
  const support = palette[4] ?? palette[1] ?? accent
  const anchor = 58 + (seed % 24)
  const band = 10 + ((seed >>> 8) % 17)

  if (descriptor.code === 'CU') {
    return [
      'conic-gradient(from 0deg at 86% 40%, #376EA82E 0deg 90deg, transparent 90deg 360deg)',
      'conic-gradient(from 0deg at 70% 40%, #E845452A 0deg 90deg, transparent 90deg 360deg)',
      'conic-gradient(from 180deg at 32% 72%, #376EA824 0deg 90deg, transparent 90deg 360deg)',
      base,
    ].join(', ')
  }

  switch (classifyAppComposition(descriptor)) {
    case 'orthogonal-bands':
      return [
        `linear-gradient(90deg, transparent 0 ${anchor}%, ${withAlpha(accent, '28')} ${anchor}% ${anchor + band}%, ${withAlpha(secondary, '24')} ${anchor + band}% 100%)`,
        `linear-gradient(0deg, ${withAlpha(secondary, '1F')} 0 24%, transparent 24% 100%)`,
        base,
      ].join(', ')
    case 'technical-grid':
      return [
        `repeating-linear-gradient(0deg, ${withAlpha(accent, '16')} 0 1px, transparent 1px 28px)`,
        `repeating-linear-gradient(90deg, ${withAlpha(accent, '12')} 0 1px, transparent 1px 28px)`,
        base,
      ].join(', ')
    case 'paper-fields':
      return [
        `linear-gradient(90deg, ${withAlpha(support, '20')} 0 ${24 + (seed % 18)}%, transparent ${24 + (seed % 18)}% 100%)`,
        base,
      ].join(', ')
    case 'orbit-spotlight':
      return [
        `radial-gradient(circle at ${anchor}% 14%, transparent 0 18%, ${withAlpha(accent, '22')} 19% 21%, transparent 22% 100%)`,
        base,
      ].join(', ')
    case 'horizon-waves':
      return [
        `repeating-radial-gradient(ellipse 70% 34% at 50% 112%, transparent 0 12%, ${withAlpha(accent, '16')} 13% 14%, transparent 15% 22%)`,
        base,
      ].join(', ')
    case 'aurora-veil':
    case 'organic-mesh':
      return [
        `radial-gradient(circle at ${anchor}% 12%, ${withAlpha(accent, '34')} 0%, transparent 38%)`,
        `radial-gradient(circle at ${100 - anchor}% 86%, ${withAlpha(secondary, '2B')} 0%, transparent 44%)`,
        base,
      ].join(', ')
    case 'spotlight':
      return [
        `radial-gradient(circle at ${anchor}% 8%, ${withAlpha(accent, '24')} 0%, transparent 42%)`,
        base,
      ].join(', ')
  }
}

function deriveCardPattern(
  descriptor: ConceptPresetDescriptor,
  primary: HexColor,
): string | null {
  const tags = new Set(descriptor.classification.visualTags)
  if (tags.has('technical')) {
    const line = withAlpha(primary, '24')
    return `linear-gradient(${line} 1px, transparent 1px), linear-gradient(90deg, ${line} 1px, transparent 1px)`
  }
  if (tags.has('editorial')) {
    return `repeating-linear-gradient(0deg, ${withAlpha(primary, '14')} 0 1px, transparent 1px 6px)`
  }
  if (descriptor.classification.decorDensity === 'dense') {
    return `radial-gradient(circle, ${withAlpha(primary, '24')} 1px, transparent 1.5px)`
  }
  return null
}

function deriveCardEffect(descriptor: ConceptPresetDescriptor): string {
  const name = descriptor.name.toLocaleLowerCase()
  const tags = new Set(descriptor.classification.visualTags)

  if (/sakura|botanical|floral|petal|garden/.test(name)) return 'paperSwirl'
  if (/paper|linen|parchment|collage|swiss/.test(name)) return 'paperGrain'
  if (/chrome|metal|silver|pearl|porcelain|ceramic|prism|hologram/.test(name)) {
    return 'liquidChrome'
  }
  if (/ocean|lagoon|wave|tide/.test(name)) return 'lineWaves'
  if (/aurora|borealis/.test(name)) return 'softAurora'
  if (/space|nebula|orbit|lunar|neptune|venus|martian|saturn/.test(name)) {
    return 'galaxy'
  }
  if (/grid|circuit|blueprint|matrix|data|terminal|signal|map|cartograph/.test(name)) {
    return 'rippleGrid'
  }
  if (/smoke|mist|plasma|bloom|veil/.test(name)) return 'plasma'
  if (tags.has('technical')) return 'dither'
  if (tags.has('editorial')) return 'paperMesh'
  if (descriptor.classification.backgroundBlur) return 'softAurora'
  return 'grainient'
}

function buildEffectProps(
  effect: string,
  primary: HexColor,
  accent: HexColor,
  background: HexColor,
): Readonly<Record<string, unknown>> {
  const rgb = normalizedRgb(primary)
  switch (effect) {
    case 'softAurora':
      return { color1: primary, color2: accent, speed: 0.45, brightness: 0.82 }
    case 'rippleGrid':
      return { gridColor: primary, gridSize: 12, glowIntensity: 0.16 }
    case 'plasma':
      return { color: primary, speed: 0.55, scale: 1.25 }
    case 'liquidChrome':
      return { baseColor: rgb, speed: 0.16, amplitude: 0.42 }
    case 'lineWaves':
      return {
        color1: primary,
        color2: accent,
        color3: contrastText(background),
        speed: 0.24,
        brightness: 0.28,
      }
    case 'galaxy':
      return { hueShift: rgbToHue(rgb), density: 0.75, glowIntensity: 0.22 }
    case 'dither':
      return { waveColor: rgb, waveSpeed: 0.035, pixelSize: 2, colorNum: 4 }
    case 'paperGrain':
      return {
        colorBack: background,
        colors: [primary, accent, mixHex(primary, background, 0.55), background],
        speed: 0.35,
        noise: 0.2,
      }
    case 'paperMesh':
      return {
        colors: [primary, accent, mixHex(primary, background, 0.55), background],
        distortion: 0.78,
        swirl: 0.15,
        speed: 0.72,
      }
    case 'paperSwirl':
      return {
        colorBack: background,
        colors: [primary, accent, mixHex(primary, background, 0.55)],
        bandCount: 4,
        twist: 0.22,
        center: 0.24,
        proportion: 0.52,
        softness: 0.18,
        noiseFrequency: 0.55,
        noise: 0.16,
        speed: 0.58,
      }
    case 'grainient':
      return {
        color1: primary,
        color2: accent,
        color3: background,
        timeSpeed: 0.18,
        grainAmount: 0.08,
      }
    default:
      return { colorStops: [primary, accent, primary], speed: 0.6 }
  }
}

function buildAppBackground(
  descriptor: ConceptPresetDescriptor,
  gradient: string,
  primary: HexColor,
  background: HexColor,
): BrandingAppBackgroundDraft {
  const tags = new Set(descriptor.classification.visualTags)
  const composition = classifyAppComposition(descriptor)
  const pattern =
    composition === 'technical-grid'
      ? 'grid'
      : composition === 'horizon-waves'
        ? 'waves'
        : composition === 'orthogonal-bands'
          ? 'diagonal'
          : composition === 'orbit-spotlight'
            ? 'cross'
            : tags.has('editorial')
              ? 'noise'
              : 'dots'

  return {
    // Even a source concept with a solid foundation can have semantic bands,
    // zones or paper fields reconstructed above it. Keep every concept in the
    // gradient branch so Reiwa does not silently discard that composition.
    kind: 'gradient',
    effect: 'NONE',
    props: {},
    opacity: 1,
    gradient,
    texture: {
      pattern,
      color: primary,
      background,
      scale: tags.has('technical') ? 28 : 64,
      opacity: tags.has('technical') ? 0.14 : 0.1,
    },
  }
}

function deriveLegacyBgEffect(
  descriptor: ConceptPresetDescriptor,
): ThemePresetBgEffect {
  if (descriptor.classification.backgroundType === 'mesh-gradient') return 'MESH'
  if (descriptor.classification.visualTags.includes('technical')) return 'PARTICLES'
  if (descriptor.classification.visualTags.includes('editorial')) return 'NOISE'
  return descriptor.classification.backgroundBlur ? 'AURORA' : 'NONE'
}

function radiusClass(radius: number): string {
  if (radius <= 3) return 'rounded-none'
  if (radius <= 10) return 'rounded-lg'
  if (radius <= 16) return 'rounded-xl'
  if (radius <= 22) return 'rounded-2xl'
  if (radius <= 30) return 'rounded-3xl'
  return 'rounded-full'
}

function radiusClassForConcept(descriptor: ConceptPresetDescriptor): string {
  if (descriptor.classification.radiusClass === 'square') return 'rounded-none'
  if (descriptor.classification.radiusClass === 'compact') return 'rounded-lg'
  return radiusClass(descriptor.classification.canonicalRadius)
}

function exactCornerRadii(
  descriptor: ConceptPresetDescriptor,
): BrandingCornerRadiiDraft {
  const sourceCardRadius =
    descriptor.classification.radiusClass === 'square'
      ? descriptor.classification.canonicalRadius
      : descriptor.classification.surfaceRadius
  const surface = Math.min(48, Math.max(0, sourceCardRadius))
  const item = Math.min(
    32,
    Math.max(
      0,
      descriptor.classification.radiusClass === 'square'
        ? surface
        : Math.min(surface, descriptor.classification.canonicalRadius),
    ),
  )
  const pill =
    descriptor.classification.radiusClass === 'square'
      ? item
      : descriptor.classification.radiusClass === 'compact'
        ? Math.min(16, Math.max(item, 4))
        : 9999
  return { cardPx: surface, itemPx: item, pillPx: pill }
}

export interface FontOption {
  readonly id: string
  readonly label: string
  readonly value: string
}

export const FONT_OPTIONS: readonly FontOption[] = [
  { id: 'geist', label: 'Geist', value: FONT_STACK_BY_SOURCE.Geist },
  {
    id: 'funnelSans',
    label: 'Funnel Sans',
    value: FONT_STACK_BY_SOURCE['Funnel Sans'],
  },
  { id: 'archivo', label: 'Archivo', value: FONT_STACK_BY_SOURCE.Archivo },
  {
    id: 'archivoNarrow',
    label: 'Archivo Narrow',
    value: FONT_STACK_BY_SOURCE['Archivo Narrow'],
  },
  { id: 'nunito', label: 'Nunito', value: FONT_STACK_BY_SOURCE.Nunito },
  {
    id: 'newsreader',
    label: 'Newsreader',
    value: FONT_STACK_BY_SOURCE.Newsreader,
  },
  {
    id: 'playfairDisplay',
    label: 'Playfair Display',
    value: FONT_STACK_BY_SOURCE['Playfair Display'],
  },
  {
    id: 'sourceSans3',
    label: 'Source Sans 3',
    value: FONT_STACK_BY_SOURCE['Source Sans 3'],
  },
  {
    id: 'spaceGrotesk',
    label: 'Space Grotesk',
    value: FONT_STACK_BY_SOURCE['Space Grotesk'],
  },
  {
    id: 'ibmPlexMono',
    label: 'IBM Plex Mono',
    value: FONT_STACK_BY_SOURCE['IBM Plex Mono'],
  },
  { id: 'system', label: 'System UI', value: 'Inter, system-ui, sans-serif' },
] as const

function fontStack(font: string): string {
  return FONT_STACK_BY_SOURCE[font] ?? FONT_STACK_BY_SOURCE.Geist
}

export interface CardGradientPreset {
  readonly id: string
  readonly value: string
}

export const CARD_GRADIENT_PRESETS: readonly CardGradientPreset[] = [
  { id: 'emerald', value: 'linear-gradient(135deg, #064e3b 0%, #22c55e 100%)' },
  { id: 'indigo', value: 'linear-gradient(135deg, #1e1b4b 0%, #6366f1 100%)' },
  { id: 'sunset', value: 'linear-gradient(135deg, #7c2d12 0%, #f97316 100%)' },
  { id: 'rose', value: 'linear-gradient(135deg, #881337 0%, #f43f5e 100%)' },
  { id: 'cyan', value: 'linear-gradient(135deg, #164e63 0%, #06b6d4 100%)' },
  { id: 'violet', value: 'linear-gradient(135deg, #4c1d95 0%, #a855f7 100%)' },
  { id: 'amber', value: 'linear-gradient(135deg, #78350f 0%, #f59e0b 100%)' },
  { id: 'slate', value: 'linear-gradient(135deg, #1e293b 0%, #64748b 100%)' },
  {
    id: 'midnight',
    value: 'linear-gradient(135deg, #0f172a 0%, #334155 60%, #0ea5e9 100%)',
  },
  {
    id: 'aurora',
    value: 'linear-gradient(135deg, #042f2e 0%, #0d9488 45%, #6366f1 100%)',
  },
  {
    id: 'fire',
    value: 'linear-gradient(135deg, #7f1d1d 0%, #dc2626 50%, #f59e0b 100%)',
  },
  {
    id: 'grape',
    value: 'linear-gradient(135deg, #2e1065 0%, #7c3aed 55%, #ec4899 100%)',
  },
  {
    id: 'ocean',
    value: 'linear-gradient(135deg, #0c4a6e 0%, #0284c7 50%, #06b6d4 100%)',
  },
  {
    id: 'forest',
    value: 'linear-gradient(135deg, #14532d 0%, #16a34a 60%, #84cc16 100%)',
  },
  {
    id: 'gold',
    value: 'linear-gradient(135deg, #422006 0%, #a16207 50%, #facc15 100%)',
  },
  { id: 'mono', value: 'linear-gradient(135deg, #262626 0%, #525252 100%)' },
  {
    id: 'glow',
    value: 'radial-gradient(circle at 30% 20%, #6366f1 0%, #1e1b4b 70%)',
  },
  {
    id: 'spotlight',
    value: 'radial-gradient(circle at 70% 30%, #f43f5e 0%, #4c0519 75%)',
  },
  {
    id: 'conic',
    value:
      'conic-gradient(from 210deg at 70% 30%, #6366f1, #ec4899, #f59e0b, #6366f1)',
  },
  {
    id: 'nebula',
    value:
      'radial-gradient(circle at 50% 0%, #7c3aed 0%, #1e1b4b 55%, #020617 100%)',
  },
] as const

export function gradientFromPrimary(primary: string): string {
  const dark = shade(primary, -0.55)
  return `linear-gradient(135deg, ${dark} 0%, ${primary} 100%)`
}

function parseHex(hex: HexColor): { r: number; g: number; b: number } {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  }
}

function normalizedRgb(hex: HexColor): readonly [number, number, number] {
  const { r, g, b } = parseHex(hex)
  return [r / 255, g / 255, b / 255]
}

function rgbToHue(rgb: readonly [number, number, number]): number {
  const [r, g, b] = rgb
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  if (delta === 0) return 0
  const raw =
    max === r
      ? ((g - b) / delta) % 6
      : max === g
        ? (b - r) / delta + 2
        : (r - g) / delta + 4
  return Math.round((raw * 60 + 360) % 360)
}

function linearChannel(channel: number): number {
  const value = channel / 255
  return value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4
}

function luminance(hex: HexColor): number {
  const { r, g, b } = parseHex(hex)
  return (
    0.2126 * linearChannel(r) +
    0.7152 * linearChannel(g) +
    0.0722 * linearChannel(b)
  )
}

function contrastRatio(left: HexColor, right: HexColor): number {
  const light = Math.max(luminance(left), luminance(right))
  const dark = Math.min(luminance(left), luminance(right))
  return (light + 0.05) / (dark + 0.05)
}

function chroma(hex: HexColor): number {
  const { r, g, b } = parseHex(hex)
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255
}

function mixHex(left: HexColor, right: HexColor, leftWeight: number): HexColor {
  const a = parseHex(left)
  const b = parseHex(right)
  const rightWeight = 1 - leftWeight
  const channel = (x: number, y: number): string =>
    Math.round(x * leftWeight + y * rightWeight)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase()
  return `#${channel(a.r, b.r)}${channel(a.g, b.g)}${channel(a.b, b.b)}`
}

function withAlpha(hex: HexColor, alpha: string): string {
  return `${hex}${alpha}`
}

function shade(hex: string, amount: number): string {
  const normalized = hex.trim().replace(/^#/, '')
  const full =
    normalized.length === 3
      ? normalized
          .split('')
          .map((character) => character + character)
          .join('')
      : normalized
  if (full.length < 6) return hex
  const r = Number.parseInt(full.slice(0, 2), 16)
  const g = Number.parseInt(full.slice(2, 4), 16)
  const b = Number.parseInt(full.slice(4, 6), 16)
  const mix = (value: number): number =>
    amount >= 0
      ? Math.round(value + (255 - value) * amount)
      : Math.round(value * (1 + amount))
  const toHex = (value: number): string =>
    Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0')
  return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`
}
