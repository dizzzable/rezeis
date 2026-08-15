import { z } from 'zod'

import { CARD_LOGO_PRESETS, type CardLogoPreset } from './branding-options'
import { CARD_EFFECT_CATALOG, type CardEffectId } from './card-effect-catalog'

export const BRANDING_BG_EFFECTS = ['NONE', 'MESH', 'PARTICLES', 'NOISE', 'AURORA'] as const
export const BRANDING_ICON_COLOR_MODES = ['default', 'theme', 'custom'] as const
export const BRANDING_THEME_MODE_POLICIES = ['fixed', 'user-selectable'] as const
export const BRANDING_THEME_MODES = ['light', 'dark'] as const
export const BRANDING_SUBSCRIPTION_CARD_TEXT_MODES = ['auto', 'light', 'dark', 'custom'] as const
/**
 * Per-plan tariff-card text modes: the four global ones plus `inherit`.
 *
 * `inherit` is the default and means "follow `subscriptionCardText`", the same
 * baseline/override rule the positional card slots use. It is a separate value
 * from `auto` because `auto` is an explicit per-plan instruction to compute
 * contrast from that card's own artwork — the only way to exempt one plan while
 * the global policy is light, dark or custom.
 */
export const BRANDING_PLAN_CARD_TEXT_MODES = [
  'inherit',
  'auto',
  'light',
  'dark',
  'custom',
] as const
/**
 * Site-wide app-background modes offered by the picker, in display order.
 *
 * `none` is the cabinet's BUILT-IN background — reiwa's `<NetworkBg>`: brand
 * glows, a dot grid and diagonals. It is the default and it draws a picture.
 * `plain` is the flat `bgPrimary` colour, which is what the panel used to
 * promise under the name "None" while the cabinet drew the pattern.
 *
 * Order matters only for the tab strip; the stored value of the default mode
 * stays `none` so no existing installation changes appearance.
 */
export const BRANDING_APP_BG_KINDS = [
  'none',
  'plain',
  'gradient',
  'texture',
  'effect',
] as const
export const BRANDING_APP_BG_TEXTURES = [
  'dots',
  'grid',
  'diagonal',
  'cross',
  'waves',
  'carbon',
  'triangles',
  'noise',
] as const
/**
 * What the card-effect fields accept, derived from the catalog.
 *
 * This used to be a hand-written copy of the effect names, and it was one of
 * the six places that had to be edited in lockstep to add a single effect. A
 * name missing here made the panel reject a value its own picker had offered,
 * with a validation error that named no field.
 *
 * `z.custom` rather than `z.enum` because a `z.enum` needs a literal tuple, and
 * a literal tuple is exactly the hand-written copy being removed. The type is
 * still the precise union — it comes from the catalog's keys.
 */
export type BrandingCardEffect = 'NONE' | CardEffectId

const BRANDING_CARD_EFFECT_SET: ReadonlySet<string> = new Set<string>([
  'NONE',
  ...Object.keys(CARD_EFFECT_CATALOG),
])

export function isBrandingCardEffect(value: unknown): value is BrandingCardEffect {
  return typeof value === 'string' && BRANDING_CARD_EFFECT_SET.has(value)
}

const cardEffectField = () => z.custom<BrandingCardEffect>(isBrandingCardEffect)

/** Cabinet nav destinations (mirrors backend `NAV_DESTINATIONS`). */
export const BRANDING_NAV_DESTINATIONS = [
  'subscriptions',
  'plans',
  'referrals',
  'devices',
  'activity',
  'promo',
  'support',
  'faq',
  'settings',
] as const
export type NavDestinationId = (typeof BRANDING_NAV_DESTINATIONS)[number]
/** Destinations that can never be hidden from the nav. */
export const BRANDING_NAV_ESSENTIALS: readonly NavDestinationId[] = ['subscriptions', 'settings']

/** One nav entry draft (mirrors backend `NavItemSetting`). */
export interface NavItemDraft {
  readonly id: NavDestinationId
  readonly visible: boolean
}

/** Default nav layout — current 3-tab cabinet, with the rest available to enable. */
export const DEFAULT_NAV_ITEMS: readonly NavItemDraft[] = [
  { id: 'subscriptions', visible: true },
  { id: 'referrals', visible: true },
  { id: 'settings', visible: true },
  { id: 'plans', visible: false },
  { id: 'devices', visible: false },
  { id: 'activity', visible: false },
  { id: 'promo', visible: false },
  { id: 'support', visible: false },
]

export interface BrandingFormDraft {
  readonly themePresetId: string | null
  readonly themePresetVersion: number | null
  /** Whether only the operator's default mode is used, or the user may switch brightness. */
  readonly themeModePolicy: (typeof BRANDING_THEME_MODE_POLICIES)[number]
  /** Operator-chosen mode; also the initial mode when user selection is enabled. */
  readonly themeDefaultMode: (typeof BRANDING_THEME_MODES)[number]
  /** Fully resolved light/dark representations of one selected concept. */
  readonly themeVariants: BrandingThemeVariantsDraft | null
  readonly brandName: string
  readonly tagline: string | null
  readonly logoUrl: string | null
  readonly pwaIconUrl: string | null
  readonly primary: string
  readonly primaryFg: string
  readonly bgPrimary: string
  readonly bgSecondary: string
  /**
   * Who owns the four colours above. `concept` while a preset supplies them,
   * `custom` from the first manual edit onwards — that edit is what detaches
   * the concept, so the operator's own palette stops being overwritten by the
   * preset's per-brightness copy on every read in the cabinet.
   */
  readonly brandPaletteSource: 'concept' | 'custom'
  readonly cardGradient: string
  /**
   * Who owns the gradient. `concept` while a preset supplies it, `custom` from
   * the first manual edit onwards — that edit is what detaches the concept, so
   * the operator's own gradient stops being overwritten by the preset's
   * per-brightness copy on every read in the cabinet.
   */
  readonly cardGradientSource: 'concept' | 'custom'
  readonly cardPattern: string | null
  readonly subscriptionCardText: BrandingSubscriptionCardTextDraft
  readonly subscriptionCardGlass: BrandingSubscriptionCardGlassDraft
  readonly cardLogo: CardLogoPreset
  readonly cardLogoUrl: string | null
  readonly cardEffect: string
  readonly cardEffectProps?: Record<string, unknown>
  readonly cardEffectOpacity: number
  readonly cardEffectsByIndex?: readonly BrandingCardEffectSlotDraft[]
  readonly bgEffect: (typeof BRANDING_BG_EFFECTS)[number]
  readonly appBackground?: BrandingAppBackgroundDraft
  readonly iconColorMode: (typeof BRANDING_ICON_COLOR_MODES)[number]
  readonly iconColors?: Record<string, string>
  readonly borderRadius: string
  readonly cornerRadii: BrandingCornerRadiiDraft
  readonly fontFamily: string
  readonly surfaceTheme: BrandingSurfaceThemeDraft
  readonly planCardStyles?: Record<string, PlanCardStyleDraft>
  readonly navItems?: readonly NavItemDraft[]
  readonly navGap?: number
}

/**
 * Renderable visual subset for one brightness of an operator-selected concept.
 * The concept id itself deliberately lives outside this object: Reiwa users
 * can select a mode, never another concept preset.
 */
export interface BrandingThemeVariantDraft {
  readonly primary: string
  readonly primaryFg: string
  readonly bgPrimary: string
  readonly bgSecondary: string
  readonly cardGradient: string
  readonly cardPattern: string | null
  readonly subscriptionCardText: BrandingSubscriptionCardTextDraft
  readonly cardEffect: string
  readonly cardEffectProps: Record<string, unknown>
  readonly cardEffectOpacity: number
  readonly cardEffectsByIndex: readonly BrandingCardEffectSlotDraft[]
  readonly bgEffect: (typeof BRANDING_BG_EFFECTS)[number]
  readonly appBackground: BrandingAppBackgroundDraft
  readonly borderRadius: string
  readonly cornerRadii: BrandingCornerRadiiDraft
  readonly fontFamily: string
  readonly surfaceTheme: BrandingSurfaceThemeDraft
}

export interface BrandingThemeVariantsDraft {
  readonly light: BrandingThemeVariantDraft
  readonly dark: BrandingThemeVariantDraft
}

/** Text policy for subscription-card content, independent of primary-button text. */
export interface BrandingSubscriptionCardTextDraft {
  readonly mode: (typeof BRANDING_SUBSCRIPTION_CARD_TEXT_MODES)[number]
  readonly color: string | null
}

/** Independent glass film above subscription-card artwork. */
export interface BrandingSubscriptionCardGlassDraft {
  readonly enabled: boolean
  readonly tint: string
  readonly opacity: number
  readonly blurPx: number
  readonly borderOpacity: number
}

export interface BrandingSurfaceThemeDraft {
  readonly foreground: string
  readonly mutedForeground: string
  readonly surface: string
  readonly surfaceHigh: string
  readonly borderSoft: string
  readonly borderStrong: string
  readonly surfaceOpacity: number
  readonly surfaceHighOpacity: number
  readonly borderSoftOpacity: number
  readonly borderStrongOpacity: number
  readonly glassBlurPx: number
}

export interface BrandingCornerRadiiDraft {
  readonly cardPx: number
  readonly itemPx: number
  readonly pillPx: number
}

/** One per-plan tariff-card text decision (mirrors backend `PlanCardTextSettings`). */
export interface PlanCardTextDraft {
  readonly mode: (typeof BRANDING_PLAN_CARD_TEXT_MODES)[number]
  readonly color: string | null
}

/** Per-plan tariff-card style draft (mirrors backend `PlanCardStyle`). */
export interface PlanCardStyleDraft {
  readonly gradient?: string | null
  readonly accent?: string | null
  readonly texturePreset?: (typeof BRANDING_APP_BG_TEXTURES)[number] | null
  readonly textureUrl?: string | null
  readonly cardEffect?: string | null
  readonly cardEffectProps?: Record<string, unknown>
  readonly cardEffectOpacity?: number | null
  /**
   * Absent means inherit — every entry written before this control existed has
   * no `text` key, and those cards must keep following `subscriptionCardText`.
   */
  readonly text?: PlanCardTextDraft | null
}

export interface BrandingAppBackgroundDraft {
  readonly kind: (typeof BRANDING_APP_BG_KINDS)[number]
  readonly effect: string
  readonly props: Record<string, unknown>
  readonly opacity: number
  readonly gradient: string
  readonly texture: BrandingAppBackgroundTextureDraft
}

export interface BrandingAppBackgroundTextureDraft {
  readonly pattern: (typeof BRANDING_APP_BG_TEXTURES)[number]
  readonly color: string
  readonly background: string
  readonly scale: number
  readonly opacity: number
}

export const DEFAULT_APP_BACKGROUND_DRAFT: BrandingAppBackgroundDraft = {
  kind: 'none',
  effect: 'NONE',
  props: {},
  opacity: 1,
  gradient: 'linear-gradient(135deg, #0a0a0a 0%, #171717 100%)',
  texture: { pattern: 'dots', color: '#22c55e', background: '#0a0a0a', scale: 24, opacity: 0.15 },
}

export const DEFAULT_SURFACE_THEME_DRAFT: BrandingSurfaceThemeDraft = {
  foreground: '#fafafa',
  mutedForeground: '#a1a1a1',
  surface: '#18181b',
  surfaceHigh: '#27272a',
  borderSoft: '#ffffff',
  borderStrong: '#ffffff',
  surfaceOpacity: 0.7,
  surfaceHighOpacity: 0.8,
  borderSoftOpacity: 0.06,
  borderStrongOpacity: 0.12,
  glassBlurPx: 16,
}

export const DEFAULT_CORNER_RADII_DRAFT: BrandingCornerRadiiDraft = {
  cardPx: 24,
  itemPx: 14,
  pillPx: 9999,
}

/** Disabled by default so an existing card retains its exact visual result. */
export const DEFAULT_SUBSCRIPTION_CARD_GLASS_DRAFT: BrandingSubscriptionCardGlassDraft = {
  enabled: false,
  tint: '#ffffff',
  opacity: 0.14,
  blurPx: 8,
  borderOpacity: 0.18,
}

export const CORNER_RADII_BY_LEGACY_CLASS: Readonly<
  Record<string, BrandingCornerRadiiDraft>
> = {
  'rounded-none': { cardPx: 0, itemPx: 0, pillPx: 0 },
  'rounded-lg': { cardPx: 12, itemPx: 8, pillPx: 12 },
  'rounded-xl': { cardPx: 16, itemPx: 12, pillPx: 9999 },
  'rounded-2xl': DEFAULT_CORNER_RADII_DRAFT,
  'rounded-3xl': { cardPx: 32, itemPx: 18, pillPx: 9999 },
  'rounded-full': { cardPx: 40, itemPx: 24, pillPx: 9999 },
}

/**
 * The one border-radius vocabulary the panel may write.
 *
 * Derived from the map above rather than restated, so the panel cannot grow a
 * seventh class with no radii behind it — and so the form, the request DTO and
 * the radius dropdown all answer to a single list.
 *
 * The Reiwa cabinet guard accepts exactly these six
 * (`reiwa/src/application/ports/public-config-persistence.port.ts`,
 * `BORDER_RADII`). Its refusal is invisible: the cabinet keeps serving its
 * PREVIOUS snapshot, so a value this form lets through and the cabinet does
 * not freezes the cabinet's appearance indefinitely. `navItems` and
 * `cardEffect` already cost an outage this way; both are commented in that
 * file. A seventh class has to reach the cabinet FIRST.
 */
export const BORDER_RADIUS_CLASSES: readonly string[] = Object.keys(
  CORNER_RADII_BY_LEGACY_CLASS,
)

export interface BrandingCardEffectSlotDraft {
  readonly mode?: 'inherit' | 'override'
  readonly cardEffect?: string
  readonly cardEffectProps?: Record<string, unknown>
  readonly cardEffectOpacity?: number
  readonly cardGradient?: string | null
}

export type BrandingFormData = Omit<BrandingFormDraft, 'cardEffectsByIndex'> & {
  readonly logoUrl: string | null
  readonly cardPattern: string | null
  readonly cardLogoUrl: string | null
  readonly cardEffectsByIndex?: readonly BrandingCardEffectSlotDraft[]
}

export interface BrandingFormValidationMessages {
  readonly hexInvalid: string
  readonly imageUrlInvalid: string
  readonly gradientInvalid: string
}

const HEX_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const OPAQUE_HEX_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const DATA_IMAGE_BASE64_PATTERN = /^data:image\/[a-z0-9+.-]+;base64,[A-Za-z0-9+/=]+$/i
const BRANDING_UPLOAD_PATH_PATTERN =
  /^\/uploads\/branding\/(?![A-Za-z0-9._-]*\.\.)[A-Za-z0-9][A-Za-z0-9._-]*$/
/**
 * Max length for image-bearing fields (`logoUrl`, `cardLogoUrl`). Generous
 * enough to hold an inline `data:image` base64
 * logo (~512 KB string ≈ a ~384 KB image) — the previous 8 KB cap rejected
 * almost every real PNG/SVG data URI with a bare "Invalid input".
 */
const IMAGE_URL_MAX = 524288

const DEFAULT_BRANDING_DRAFT: BrandingFormDraft = {
  themePresetId: null,
  themePresetVersion: null,
  themeModePolicy: 'fixed',
  themeDefaultMode: 'dark',
  themeVariants: null,
  brandName: 'Reiwa',
  tagline: null,
  logoUrl: null,
  pwaIconUrl: null,
  primary: '#22c55e',
  primaryFg: '#0a0a0a',
  bgPrimary: '#0a0a0a',
  bgSecondary: '#171717',
  brandPaletteSource: 'concept',
  cardGradient: 'linear-gradient(135deg, #064e3b 0%, #22c55e 100%)',
  cardGradientSource: 'concept',
  cardPattern: null,
  subscriptionCardText: { mode: 'auto', color: null },
  subscriptionCardGlass: DEFAULT_SUBSCRIPTION_CARD_GLASS_DRAFT,
  cardLogo: 'DEFAULT',
  cardLogoUrl: null,
  cardEffect: 'aurora',
  cardEffectProps: {},
  cardEffectOpacity: 1,
  cardEffectsByIndex: [],
  bgEffect: 'NONE',
  appBackground: {
    kind: 'none',
    effect: 'NONE',
    props: {},
    opacity: 1,
    gradient: 'linear-gradient(135deg, #0a0a0a 0%, #171717 100%)',
    texture: { pattern: 'dots', color: '#22c55e', background: '#0a0a0a', scale: 24, opacity: 0.15 },
  },
  iconColorMode: 'default',
  iconColors: {},
  borderRadius: 'rounded-2xl',
  cornerRadii: DEFAULT_CORNER_RADII_DRAFT,
  fontFamily: 'Geist Variable, system-ui, sans-serif',
  surfaceTheme: DEFAULT_SURFACE_THEME_DRAFT,
  planCardStyles: {},
  navItems: DEFAULT_NAV_ITEMS,
  navGap: 2,
}

export function createBrandingFormSchema(messages: BrandingFormValidationMessages) {
  const cardEffectSlotSchema = z.object({
    mode: z.enum(['inherit', 'override']).optional(),
    cardEffect: cardEffectField().optional(),
    cardEffectProps: z.record(z.string(), z.unknown()).optional(),
    cardEffectOpacity: z.number().min(0.05).max(1).optional(),
    cardGradient: optionalGradientSchema(messages.gradientInvalid),
  })
  const appBackgroundSchema = z.object({
    kind: z.enum(BRANDING_APP_BG_KINDS),
    effect: cardEffectField(),
    props: z.record(z.string(), z.unknown()),
    opacity: z.number().min(0.05).max(1),
    gradient: safeGradientSchema(messages.gradientInvalid),
    texture: z.object({
      pattern: z.enum(BRANDING_APP_BG_TEXTURES),
      color: z.string().regex(HEX_PATTERN, messages.hexInvalid),
      background: z.string().regex(HEX_PATTERN, messages.hexInvalid),
      scale: z.number().min(8).max(256),
      opacity: z.number().min(0.05).max(1),
    }),
  })
  const cornerRadiiSchema = z.object({
    cardPx: z.number().min(0).max(48),
    itemPx: z.number().min(0).max(32),
    pillPx: z.number().min(0).max(9999),
  })
  const surfaceThemeSchema = z.object({
    foreground: z.string().regex(HEX_PATTERN, messages.hexInvalid),
    mutedForeground: z.string().regex(HEX_PATTERN, messages.hexInvalid),
    surface: z.string().regex(HEX_PATTERN, messages.hexInvalid),
    surfaceHigh: z.string().regex(HEX_PATTERN, messages.hexInvalid),
    borderSoft: z.string().regex(HEX_PATTERN, messages.hexInvalid),
    borderStrong: z.string().regex(HEX_PATTERN, messages.hexInvalid),
    surfaceOpacity: z.number().min(0).max(1),
    surfaceHighOpacity: z.number().min(0).max(1),
    borderSoftOpacity: z.number().min(0).max(1),
    borderStrongOpacity: z.number().min(0).max(1),
    glassBlurPx: z.number().min(0).max(40),
  })
  const subscriptionCardTextSchema = z
    .object({
      mode: z.enum(BRANDING_SUBSCRIPTION_CARD_TEXT_MODES),
      color: z.string().regex(OPAQUE_HEX_PATTERN, messages.hexInvalid).nullable(),
    })
    .refine((value) => value.mode !== 'custom' || value.color !== null, {
      path: ['color'],
      message: messages.hexInvalid,
    })
  /**
   * Per-plan text policy, as it appears INSIDE a `z.record` value object.
   *
   * The trailing `.nullish()` is the whole reason this is a named schema rather
   * than an inline object, and removing it breaks every branding save in the
   * panel — the exact defect this release fixed for `textureUrl`. Under Zod 4 a
   * property whose own schema does not declare optionality FAILS on an ABSENT
   * key, and almost no `planCardStyles` entry carries this key: every entry
   * written before this control existed lacks it, and every control except this
   * one patches an object that never mentions it. The failure surfaces as a
   * validation error at path `planCardStyles.<planId>.text`, which react-hook-
   * form cannot attach to any rendered input — so no field lights up and the
   * operator is left with a Save button that silently does nothing. Every
   * sibling above ends in `.optional()`/`.nullish()` for the same reason.
   *
   * `.nullish()` (not just `.optional()`) because an explicit `null` is what a
   * "clear this" patch would send, and a value that is legitimately clearable
   * must not be the one thing that refuses the submit.
   *
   * The refine mirrors the global control: `custom` without a colour is not a
   * decision. It is placed BEFORE `.nullish()` so an absent value never reaches
   * it.
   */
  const planCardTextSchema = z
    .object({
      mode: z.enum(BRANDING_PLAN_CARD_TEXT_MODES),
      // Opaque hex only, exactly like `subscriptionCardText.color`: an
      // alpha-bearing foreground renders differently over every gradient, so
      // the cabinet and this preview could not agree on the result.
      //
      // `.nullish()` here as well. The panel always writes both keys, but a
      // stored entry from a hand-edited payload or a future writer might carry
      // only `mode`, and an absent `color` must not be able to refuse the whole
      // branding submit for a plan the operator is not even editing.
      color: z
        .string()
        .regex(OPAQUE_HEX_PATTERN, messages.hexInvalid)
        .nullish()
        .transform((value) => value ?? null),
    })
    .refine((value) => value.mode !== 'custom' || value.color !== null, {
      path: ['color'],
      message: messages.hexInvalid,
    })
    .nullish()
  const subscriptionCardGlassSchema = z.object({
    enabled: z.boolean(),
    tint: z.string().regex(OPAQUE_HEX_PATTERN, messages.hexInvalid),
    opacity: z.number().min(0).max(1),
    blurPx: z.number().min(0).max(40),
    borderOpacity: z.number().min(0).max(1),
  })
  const themeVariantSchema = z.object({
    primary: z.string().regex(HEX_PATTERN, messages.hexInvalid),
    primaryFg: z.string().regex(HEX_PATTERN, messages.hexInvalid),
    bgPrimary: z.string().regex(HEX_PATTERN, messages.hexInvalid),
    bgSecondary: z.string().regex(HEX_PATTERN, messages.hexInvalid),
    cardGradient: safeGradientSchema(messages.gradientInvalid),
    cardPattern: optionalGradientSchema(messages.gradientInvalid, true),
    subscriptionCardText: subscriptionCardTextSchema,
    cardEffect: cardEffectField(),
    cardEffectProps: z.record(z.string(), z.unknown()),
    cardEffectOpacity: z.number().min(0.05).max(1),
    cardEffectsByIndex: z.array(cardEffectSlotSchema).max(20),
    bgEffect: z.enum(BRANDING_BG_EFFECTS),
    appBackground: appBackgroundSchema,
    borderRadius: borderRadiusSchema(),
    cornerRadii: cornerRadiiSchema,
    fontFamily: z.string().trim().min(1).max(256),
    surfaceTheme: surfaceThemeSchema,
  })

  return z
    .object({
      themePresetId: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
        .nullable(),
      themePresetVersion: z.number().int().min(1).max(2_147_483_647).nullable(),
      themeModePolicy: z.enum(BRANDING_THEME_MODE_POLICIES),
      themeDefaultMode: z.enum(BRANDING_THEME_MODES),
      themeVariants: z
        .object({ light: themeVariantSchema, dark: themeVariantSchema })
        .nullable(),
      brandName: z.string().trim().min(1).max(64),
      tagline: optionalNullableString(128),
      logoUrl: optionalImageUrl(messages.imageUrlInvalid),
      pwaIconUrl: optionalImageUrl(messages.imageUrlInvalid),
      primary: z.string().regex(HEX_PATTERN, messages.hexInvalid),
      primaryFg: z.string().regex(HEX_PATTERN, messages.hexInvalid),
      bgPrimary: z.string().regex(HEX_PATTERN, messages.hexInvalid),
      bgSecondary: z.string().regex(HEX_PATTERN, messages.hexInvalid),
      brandPaletteSource: z.enum(['concept', 'custom']),
      cardGradient: safeGradientSchema(messages.gradientInvalid),
      cardGradientSource: z.enum(['concept', 'custom']),
      cardPattern: optionalGradientSchema(messages.gradientInvalid, true),
      subscriptionCardText: subscriptionCardTextSchema,
      subscriptionCardGlass: subscriptionCardGlassSchema,
      cardLogo: z.enum(CARD_LOGO_PRESETS),
      cardLogoUrl: optionalImageUrl(messages.imageUrlInvalid),
      cardEffect: cardEffectField(),
      cardEffectProps: z.record(z.string(), z.unknown()).optional(),
      cardEffectOpacity: z.number().min(0.05).max(1),
      cardEffectsByIndex: z
        .array(cardEffectSlotSchema)
        .max(20)
        .optional(),
      bgEffect: z.enum(BRANDING_BG_EFFECTS),
      appBackground: appBackgroundSchema.optional(),
      iconColorMode: z.enum(BRANDING_ICON_COLOR_MODES),
      iconColors: z
        .record(
          z.string().min(1).max(64),
          z.string().regex(HEX_PATTERN, messages.hexInvalid),
        )
        .refine((value) => Object.keys(value).length <= 100)
        .optional(),
      borderRadius: borderRadiusSchema(),
      cornerRadii: cornerRadiiSchema,
      fontFamily: z.string().trim().min(1).max(256),
      surfaceTheme: surfaceThemeSchema,
      planCardStyles: z
        .record(
          z.string().min(1).max(64),
          z.object({
            gradient: optionalGradientSchema(messages.gradientInvalid),
            accent: optionalHexColour(messages.hexInvalid),
            texturePreset: z.enum(BRANDING_APP_BG_TEXTURES).nullish(),
            textureUrl: optionalImageUrl(messages.imageUrlInvalid),
            cardEffect: cardEffectField().nullish(),
            cardEffectProps: z.record(z.string(), z.unknown()).optional(),
            cardEffectOpacity: z.number().min(0.05).max(1).nullish(),
            text: planCardTextSchema,
          }),
        )
        .refine((value) => Object.keys(value).length <= 500)
        .optional(),
      navItems: z
        .array(
          z.object({
            id: z.enum(BRANDING_NAV_DESTINATIONS),
            visible: z.boolean(),
          }),
        )
        .optional(),
      navGap: z.number().min(0).max(24).optional(),
    })
    .transform((values): BrandingFormData => ({
      ...values,
      cardEffectsByIndex: values.cardEffectsByIndex ?? [],
      cardEffectProps: values.cardEffectProps ?? {},
      appBackground: values.appBackground ?? DEFAULT_APP_BACKGROUND_DRAFT,
      iconColors: values.iconColors ?? {},
      planCardStyles: values.planCardStyles ?? {},
      navItems: values.navItems ?? DEFAULT_NAV_ITEMS,
      navGap: values.navGap ?? 2,
    }))
}

export type BrandingFormSchema = ReturnType<typeof createBrandingFormSchema>
export type BrandingFormField = keyof BrandingFormDraft
export type BrandingDirtyFields = Partial<Record<BrandingFormField, unknown>>

export type BrandingDirtyPatchResult =
  | {
      readonly success: true
      readonly data: Partial<BrandingFormData>
      readonly fields: readonly BrandingFormField[]
    }
  | {
      readonly success: false
      readonly error: z.ZodError
      readonly fields: readonly BrandingFormField[]
    }

export function getBrandingChangedFields(
  values: BrandingFormDraft,
  baseline: BrandingFormDraft,
): BrandingDirtyFields {
  const changed: BrandingDirtyFields = {}
  for (const field of Object.keys(DEFAULT_BRANDING_DRAFT) as BrandingFormField[]) {
    if (!areBrandingValuesEqual(values[field], baseline[field])) {
      changed[field] = true
    }
  }
  return changed
}

/**
 * Validates and resolves only the top-level fields changed by the operator.
 *
 * The endpoint is a PATCH, so unchanged persisted settings must not be
 * re-submitted. This is especially important for installations carrying
 * legacy values that a newer client intentionally no longer accepts: those
 * values can be edited independently, but cannot block applying a new theme.
 */
export function createBrandingDirtyPatch(input: {
  readonly values: BrandingFormDraft
  readonly dirtyFields: BrandingDirtyFields
  readonly schema: BrandingFormSchema
}): BrandingDirtyPatchResult {
  const fields = Object.keys(input.dirtyFields).filter(
    (field): field is BrandingFormField => field in DEFAULT_BRANDING_DRAFT,
  )
  const candidate: Record<string, unknown> = { ...DEFAULT_BRANDING_DRAFT }
  for (const field of fields) {
    candidate[field] = input.values[field]
  }

  const result = input.schema.safeParse(candidate)
  if (!result.success) {
    return { success: false, error: result.error, fields }
  }

  const data: Partial<BrandingFormData> = {}
  const writableData = data as Record<string, unknown>
  for (const field of fields) {
    writableData[field] = result.data[field]
  }
  return { success: true, data, fields }
}

export function createInitialBrandingDraft(input?: Partial<BrandingFormDraft> | null): BrandingFormDraft {
  const subscriptionCardText = normalizeSubscriptionCardTextDraft(
    input?.subscriptionCardText,
  )
  const subscriptionCardGlass = normalizeSubscriptionCardGlassDraft(
    input?.subscriptionCardGlass,
  )
  return {
    ...DEFAULT_BRANDING_DRAFT,
    ...(input ?? {}),
    themePresetId:
      typeof input?.themePresetId === 'string' && input.themePresetId.trim().length > 0
        ? input.themePresetId.trim()
        : null,
    themePresetVersion:
      typeof input?.themePresetVersion === 'number' &&
      Number.isInteger(input.themePresetVersion) &&
      input.themePresetVersion > 0
        ? input.themePresetVersion
        : null,
    themeModePolicy:
      input?.themeModePolicy === 'user-selectable' ? 'user-selectable' : 'fixed',
    themeDefaultMode:
      input?.themeDefaultMode === 'light' ? 'light' : 'dark',
    themeVariants: normalizeThemeVariantsDraft(
      input?.themeVariants,
      subscriptionCardText,
    ),
    tagline: normalizeDraftNullableString(input?.tagline),
    logoUrl: normalizeDraftNullableString(input?.logoUrl),
    pwaIconUrl: normalizeDraftNullableString(input?.pwaIconUrl),
    cardPattern: normalizeDraftNullableString(input?.cardPattern),
    subscriptionCardText,
    subscriptionCardGlass,
    cardLogoUrl: normalizeDraftNullableString(input?.cardLogoUrl),
    cardEffectProps: isPlainRecord(input?.cardEffectProps) ? input.cardEffectProps : {},
    cardEffectsByIndex: Array.isArray(input?.cardEffectsByIndex) ? input.cardEffectsByIndex : [],
    appBackground: normalizeAppBackgroundDraft(input?.appBackground),
    iconColors: isPlainRecord(input?.iconColors) ? input.iconColors : {},
    cornerRadii: normalizeCornerRadiiDraft(
      input?.cornerRadii,
      input?.borderRadius,
    ),
    surfaceTheme: normalizeSurfaceThemeDraft(input?.surfaceTheme),
    planCardStyles: isPlainRecordUnknown(input?.planCardStyles)
      ? (input.planCardStyles as Record<string, PlanCardStyleDraft>)
      : {},
    navItems: Array.isArray(input?.navItems) ? input.navItems : DEFAULT_NAV_ITEMS,
    navGap: typeof input?.navGap === 'number' ? input.navGap : 2,
  }
}

function normalizeSubscriptionCardTextDraft(
  value: unknown,
): BrandingSubscriptionCardTextDraft {
  if (!isPlainRecordUnknown(value)) {
    return { ...DEFAULT_BRANDING_DRAFT.subscriptionCardText }
  }
  const mode = BRANDING_SUBSCRIPTION_CARD_TEXT_MODES.includes(
    value.mode as BrandingSubscriptionCardTextDraft['mode'],
  )
    ? (value.mode as BrandingSubscriptionCardTextDraft['mode'])
    : 'auto'
  if (mode !== 'custom') return { mode, color: null }
  const color =
    typeof value.color === 'string' && OPAQUE_HEX_PATTERN.test(value.color.trim())
      ? value.color.trim()
      : null
  return color ? { mode, color } : { mode: 'auto', color: null }
}

function normalizeSubscriptionCardGlassDraft(
  value: unknown,
): BrandingSubscriptionCardGlassDraft {
  if (!isPlainRecordUnknown(value)) {
    return { ...DEFAULT_SUBSCRIPTION_CARD_GLASS_DRAFT }
  }
  const fallback = DEFAULT_SUBSCRIPTION_CARD_GLASS_DRAFT
  const tint =
    typeof value.tint === 'string' && OPAQUE_HEX_PATTERN.test(value.tint.trim())
      ? value.tint.trim()
      : fallback.tint
  const boundedNumber = (
    key: 'opacity' | 'blurPx' | 'borderOpacity',
    max: number,
  ): number =>
    typeof value[key] === 'number' && Number.isFinite(value[key])
      ? Math.min(max, Math.max(0, value[key] as number))
      : fallback[key]
  return {
    enabled: value.enabled === true,
    tint,
    opacity: boundedNumber('opacity', 1),
    blurPx: boundedNumber('blurPx', 40),
    borderOpacity: boundedNumber('borderOpacity', 1),
  }
}

function isThemeVariantsDraft(
  value: unknown,
): value is BrandingThemeVariantsDraft {
  if (!isPlainRecordUnknown(value)) return false
  return isPlainRecordUnknown(value.light) && isPlainRecordUnknown(value.dark)
}

/**
 * API snapshots may contain a valid pre-card-text variant pair.  The backend
 * preserves that absence so Reiwa can fall back to the root policy; the form,
 * however, always submits complete variant DTOs.  Hydrate the missing fields
 * from the root decision only in this editable draft, never in persistence.
 */
function normalizeThemeVariantsDraft(
  value: unknown,
  fallbackSubscriptionCardText: BrandingSubscriptionCardTextDraft,
): BrandingThemeVariantsDraft | null {
  if (!isThemeVariantsDraft(value)) return null
  const normalizeVariant = (variant: BrandingThemeVariantsDraft['light']) => {
    const candidate = variant as unknown as Record<string, unknown>
    return {
      ...candidate,
      subscriptionCardText: normalizeSubscriptionCardTextDraft(
        candidate.subscriptionCardText ?? fallbackSubscriptionCardText,
      ),
    } as BrandingThemeVariantsDraft['light']
  }

  return {
    light: normalizeVariant(value.light),
    dark: normalizeVariant(value.dark),
  }
}

function areBrandingValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => areBrandingValuesEqual(value, right[index]))
    )
  }
  if (
    typeof left !== 'object' ||
    left === null ||
    typeof right !== 'object' ||
    right === null
  ) {
    return false
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        areBrandingValuesEqual(leftRecord[key], rightRecord[key]),
    )
  )
}

function normalizeCornerRadiiDraft(
  value: Partial<BrandingCornerRadiiDraft> | undefined,
  legacyClass: string | undefined,
): BrandingCornerRadiiDraft {
  const fallback =
    (typeof legacyClass === 'string'
      ? CORNER_RADII_BY_LEGACY_CLASS[legacyClass]
      : undefined) ??
    DEFAULT_CORNER_RADII_DRAFT
  if (typeof value !== 'object' || value === null) return fallback

  const number = (
    candidate: unknown,
    minimum: number,
    maximum: number,
    defaultValue: number,
  ): number =>
    typeof candidate === 'number' && Number.isFinite(candidate)
      ? Math.min(maximum, Math.max(minimum, candidate))
      : defaultValue

  return {
    cardPx: number(value.cardPx, 0, 48, fallback.cardPx),
    itemPx: number(value.itemPx, 0, 32, fallback.itemPx),
    pillPx: number(value.pillPx, 0, 9999, fallback.pillPx),
  }
}

function normalizeSurfaceThemeDraft(
  value: Partial<BrandingSurfaceThemeDraft> | undefined,
): BrandingSurfaceThemeDraft {
  if (typeof value !== 'object' || value === null) {
    return DEFAULT_SURFACE_THEME_DRAFT
  }

  const fallback = DEFAULT_SURFACE_THEME_DRAFT
  const color = (candidate: unknown, defaultValue: string): string =>
    typeof candidate === 'string' && HEX_PATTERN.test(candidate.trim())
      ? candidate.trim()
      : defaultValue
  const number = (
    candidate: unknown,
    minimum: number,
    maximum: number,
    defaultValue: number,
  ): number =>
    typeof candidate === 'number' && Number.isFinite(candidate)
      ? Math.min(maximum, Math.max(minimum, candidate))
      : defaultValue

  return {
    foreground: color(value.foreground, fallback.foreground),
    mutedForeground: color(value.mutedForeground, fallback.mutedForeground),
    surface: color(value.surface, fallback.surface),
    surfaceHigh: color(value.surfaceHigh, fallback.surfaceHigh),
    borderSoft: color(value.borderSoft, fallback.borderSoft),
    borderStrong: color(value.borderStrong, fallback.borderStrong),
    surfaceOpacity: number(value.surfaceOpacity, 0, 1, fallback.surfaceOpacity),
    surfaceHighOpacity: number(
      value.surfaceHighOpacity,
      0,
      1,
      fallback.surfaceHighOpacity,
    ),
    borderSoftOpacity: number(
      value.borderSoftOpacity,
      0,
      1,
      fallback.borderSoftOpacity,
    ),
    borderStrongOpacity: number(
      value.borderStrongOpacity,
      0,
      1,
      fallback.borderStrongOpacity,
    ),
    glassBlurPx: number(value.glassBlurPx, 0, 40, fallback.glassBlurPx),
  }
}

function normalizeAppBackgroundDraft(
  value: Partial<BrandingAppBackgroundDraft> | undefined,
): BrandingAppBackgroundDraft {
  if (typeof value !== 'object' || value === null) {
    return DEFAULT_APP_BACKGROUND_DRAFT
  }
  const d = DEFAULT_APP_BACKGROUND_DRAFT
  const clamp = (n: unknown, min: number, max: number, fb: number): number =>
    typeof n === 'number' && Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fb
  // Infer kind for legacy drafts that only carry `effect`.
  const kind = (BRANDING_APP_BG_KINDS as readonly string[]).includes(value.kind ?? '')
    ? (value.kind as BrandingAppBackgroundDraft['kind'])
    : typeof value.effect === 'string' && value.effect !== 'NONE'
      ? 'effect'
      : 'none'
  const t = (value.texture ?? {}) as Partial<BrandingAppBackgroundTextureDraft>
  return {
    kind,
    effect:
      typeof value.effect === 'string' &&
      isBrandingCardEffect(value.effect)
        ? value.effect
        : 'NONE',
    props: isPlainRecordUnknown(value.props) ? value.props : {},
    opacity: clamp(value.opacity, 0.05, 1, 1),
    gradient: typeof value.gradient === 'string' && value.gradient.trim().length > 0 ? value.gradient : d.gradient,
    texture: {
      pattern: (BRANDING_APP_BG_TEXTURES as readonly string[]).includes(t.pattern ?? '')
        ? (t.pattern as BrandingAppBackgroundTextureDraft['pattern'])
        : d.texture.pattern,
      color:
        typeof t.color === 'string' && HEX_PATTERN.test(t.color.trim())
          ? t.color.trim()
          : d.texture.color,
      background:
        typeof t.background === 'string' && HEX_PATTERN.test(t.background.trim())
          ? t.background.trim()
          : d.texture.background,
      scale: Math.round(clamp(t.scale, 8, 256, d.texture.scale)),
      opacity: clamp(t.opacity, 0.05, 1, d.texture.opacity),
    },
  }
}

/**
 * An image field that may be absent, null, or empty — all three meaning "no
 * image", all three normalized to `null`.
 *
 * The `.optional()` on the end is load-bearing and was missing, which is what
 * made per-plan tariff-card styles refuse to save. `optionalNullableString`
 * accepts `undefined` as one arm of its union, so this reads as optional and
 * behaved that way everywhere it had been used before: `logoUrl`, `pwaIconUrl`
 * and `cardLogoUrl` are top-level fields, and `createBrandingDirtyPatch` builds
 * its candidate from `DEFAULT_BRANDING_DRAFT`, so those keys are ALWAYS present
 * (as `null`) and the union arm was the only thing ever consulted.
 *
 * `planCardStyles` is the first place this schema sits under a `z.record`, and
 * a record's values are non-optional in Zod 4: a property whose schema does not
 * itself declare `.optional()` fails an ABSENT key with `expected nonoptional`,
 * even though it accepts a key explicitly set to `undefined`. Every plan-style
 * control except the texture picker patches an entry that has no `textureUrl`
 * key at all — a gradient, an accent, a card effect — so the whole branding
 * submit was rejected client-side before any request left the browser. The
 * error names `planCardStyles.<planId>.textureUrl`, which react-hook-form
 * cannot attach to any rendered input, so the operator saw a save that did
 * nothing and no field marked wrong.
 *
 * Nothing else in the chain ever wanted it: `PlanCardStyleDraft.textureUrl` is
 * declared optional, the backend DTO's `hasOnlyAllowedPlanTextureUrls` returns
 * true for an absent value, `readPlanCardStyles` simply omits it, and reiwa's
 * `hasOptionalImageUrlOrNull` accepts `undefined`. This helper was the only
 * side demanding the key, and it is now shaped exactly like its sibling
 * `optionalGradientSchema`, which has always carried the same tail.
 */
function optionalImageUrl(message: string) {
  return optionalNullableString(IMAGE_URL_MAX)
    .refine((value) => value === null || isAllowedImageUrl(value), { message })
    .optional()
    .transform((value) => value ?? null)
}

/**
 * A hex colour the operator may also clear, spelled the way a free-text input
 * actually hands it over.
 *
 * Written as a bare `z.string().regex(...)` this rejected TWO things nothing
 * downstream objects to, and both blocked the whole branding submit rather
 * than the one field:
 *
 *  - the empty string. Clearing the per-plan accent box is how an operator
 *    removes an accent, and the box emits `''`, not `null`. `setStyle` only
 *    deletes the entry when EVERY field is empty, so a plan that also has a
 *    gradient kept `accent: ''` and the save was refused client-side;
 *  - a value with surrounding whitespace, which is what pasting a colour
 *    usually produces.
 *
 * The backend accepts both — `readPlanCardStyles` tests `accent.trim()` and
 * simply omits an accent it cannot read — and so does reiwa's `isHex`, which
 * trims before matching. The panel was the only side treating "no accent" as a
 * validation failure, and its own sibling field `gradient` has always gone
 * through `optionalGradientSchema`, which trims and maps empty to `null`.
 *
 * A genuinely malformed colour (`#2`, `22c55e`) still fails, deliberately: that
 * is an operator mistake worth naming rather than silently discarding.
 */
function optionalHexColour(message: string) {
  // Generous cap so the message below is what an over-long value gets, rather
  // than a length complaint about a field whose real problem is its shape.
  return optionalNullableString(64)
    .refine((value) => value === null || HEX_PATTERN.test(value), { message })
    .optional()
    .transform((value) => value ?? null)
}

/**
 * `borderRadius`, constrained to `BORDER_RADIUS_CLASSES`.
 *
 * Kept as a trimmed `z.string()` with a refinement rather than a `z.enum` so
 * the parsed type stays `string`: the dropdown, the presets and the persisted
 * draft all hand this field a plain string, and narrowing the output type
 * would ripple into every caller for no validation gain.
 *
 * The message is composed rather than taken from `messages` because the
 * dropdown cannot produce a rejected value — only an API client, a hand-edited
 * database row or a future control can — and whoever hits it needs the two
 * facts an i18n string would not carry: what was sent and what is allowed.
 */
function borderRadiusSchema() {
  return z
    .string()
    .trim()
    .min(1)
    .max(64)
    .superRefine((value, ctx) => {
      if (BORDER_RADIUS_CLASSES.includes(value)) return
      // Bounded: `.max(64)` above does not stop this refinement from running.
      const received = value.length > 40 ? `${value.slice(0, 40)}…` : value
      ctx.addIssue({
        code: 'custom',
        message: `borderRadius must be one of ${BORDER_RADIUS_CLASSES.join(
          ', ',
        )}; received "${received}"`,
      })
    })
}

function safeGradientSchema(message: string) {
  return z
    .string()
    .trim()
    .min(1)
    .max(512)
    .refine(isSafeBrandingGradient, { message })
}

function optionalGradientSchema(message: string, allowNone = false) {
  return optionalNullableString(512)
    .refine(
      (value) =>
        value === null ||
        (allowNone && value === 'none') ||
        isSafeBrandingGradient(value),
      { message },
    )
    .optional()
    .transform((value) => value ?? null)
}

function optionalNullableString(maxLength: number) {
  return z
    .union([z.string(), z.null(), z.undefined()])
    .transform((value) => (typeof value === 'string' ? value.trim() : ''))
    .pipe(z.string().max(maxLength))
    .transform((value) => (value.length > 0 ? value : null))
}

export function isSafeBrandingGradient(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const input = value.trim()
  if (
    input.length === 0 ||
    input.length > 512 ||
    /(?:url|image-set|-webkit-image-set|cross-fade|element|paint)\s*\(/i.test(input) ||
    /[;{}@\\]/.test(input) ||
    /\/\*|\*\//.test(input) ||
    hasControlCharacter(input)
  ) {
    return false
  }

  let index = 0
  while (index < input.length) {
    while (index < input.length && /\s/.test(input[index] ?? '')) index += 1
    const match = /^(?:(?:repeating-)?(?:linear|radial|conic)-gradient)\s*\(/i.exec(
      input.slice(index),
    )
    if (!match) return false
    index += match[0].length

    let depth = 1
    while (index < input.length && depth > 0) {
      const character = input[index]
      if (character === '(') depth += 1
      if (character === ')') depth -= 1
      index += 1
    }
    if (depth !== 0) return false

    while (index < input.length && /\s/.test(input[index] ?? '')) index += 1
    if (index === input.length) return true
    if (input[index] !== ',') return false
    index += 1
  }
  return false
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f
  })
}

function isAllowedImageUrl(value: string): boolean {
  if (DATA_IMAGE_BASE64_PATTERN.test(value)) {
    return true
  }
  // Relative upload path served same-origin by the admin and mirrored durably
  // by Reiwa while the panel is unavailable,
  // e.g. an uploaded logo / PWA icon at `/uploads/branding/<hash>.png`.
  if (BRANDING_UPLOAD_PATH_PATTERN.test(value)) {
    return true
  }
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}

function normalizeDraftNullableString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function isPlainRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlainRecordUnknown(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
