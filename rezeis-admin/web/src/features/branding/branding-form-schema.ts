import { z } from 'zod'

import { CARD_LOGO_PRESETS, type CardLogoPreset } from './branding-options'

export const BRANDING_BG_EFFECTS = ['NONE', 'MESH', 'PARTICLES', 'NOISE', 'AURORA'] as const
export const BRANDING_ICON_COLOR_MODES = ['default', 'theme', 'custom'] as const
export const BRANDING_APP_BG_KINDS = ['none', 'gradient', 'texture', 'effect'] as const
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
export const BRANDING_CARD_EFFECTS = [
  'NONE',
  'aurora',
  'threads',
  'softAurora',
  'rippleGrid',
  'radar',
  'plasma',
  'particles',
  'liquidChrome',
  'lineWaves',
  'iridescence',
  'grainient',
  'galaxy',
  'balatro',
  'waves',
  'silk',
  'beams',
  'dither',
  'paperMesh',
  'paperWarp',
  'paperGrain',
  'paperDither',
  'paperSwirl',
  'paperMetaballs',
] as const

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
  readonly brandName: string
  readonly tagline: string | null
  readonly logoUrl: string | null
  readonly pwaIconUrl: string | null
  readonly primary: string
  readonly primaryFg: string
  readonly bgPrimary: string
  readonly bgSecondary: string
  readonly cardGradient: string
  readonly cardPattern: string | null
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

/** Per-plan tariff-card style draft (mirrors backend `PlanCardStyle`). */
export interface PlanCardStyleDraft {
  readonly gradient?: string | null
  readonly accent?: string | null
  readonly texturePreset?: (typeof BRANDING_APP_BG_TEXTURES)[number] | null
  readonly textureUrl?: string | null
  readonly cardEffect?: string | null
  readonly cardEffectProps?: Record<string, unknown>
  readonly cardEffectOpacity?: number | null
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

export interface BrandingCardEffectSlotDraft {
  readonly cardEffect: string
  readonly cardEffectProps: Record<string, unknown>
  readonly cardEffectOpacity: number
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
  brandName: 'Reiwa',
  tagline: null,
  logoUrl: null,
  pwaIconUrl: null,
  primary: '#22c55e',
  primaryFg: '#0a0a0a',
  bgPrimary: '#0a0a0a',
  bgSecondary: '#171717',
  cardGradient: 'linear-gradient(135deg, #064e3b 0%, #22c55e 100%)',
  cardPattern: null,
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
  return z
    .object({
      themePresetId: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
        .nullable(),
      themePresetVersion: z.number().int().min(1).max(2_147_483_647).nullable(),
      brandName: z.string().trim().min(1).max(64),
      tagline: optionalNullableString(128),
      logoUrl: optionalImageUrl(messages.imageUrlInvalid),
      pwaIconUrl: optionalImageUrl(messages.imageUrlInvalid),
      primary: z.string().regex(HEX_PATTERN, messages.hexInvalid),
      primaryFg: z.string().regex(HEX_PATTERN, messages.hexInvalid),
      bgPrimary: z.string().regex(HEX_PATTERN, messages.hexInvalid),
      bgSecondary: z.string().regex(HEX_PATTERN, messages.hexInvalid),
      cardGradient: safeGradientSchema(messages.gradientInvalid),
      cardPattern: optionalGradientSchema(messages.gradientInvalid, true),
      cardLogo: z.enum(CARD_LOGO_PRESETS),
      cardLogoUrl: optionalImageUrl(messages.imageUrlInvalid),
      cardEffect: z.enum(BRANDING_CARD_EFFECTS),
      cardEffectProps: z.record(z.string(), z.unknown()).optional(),
      cardEffectOpacity: z.number().min(0.05).max(1),
      cardEffectsByIndex: z
        .array(
          z.object({
            cardEffect: z.enum(BRANDING_CARD_EFFECTS),
            cardEffectProps: z.record(z.string(), z.unknown()),
            cardEffectOpacity: z.number().min(0.05).max(1),
            cardGradient: optionalGradientSchema(messages.gradientInvalid),
          }),
        )
        .max(20)
        .optional(),
      bgEffect: z.enum(BRANDING_BG_EFFECTS),
      appBackground: z
        .object({
          kind: z.enum(BRANDING_APP_BG_KINDS),
          effect: z.enum(BRANDING_CARD_EFFECTS),
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
        .optional(),
      iconColorMode: z.enum(BRANDING_ICON_COLOR_MODES),
      iconColors: z
        .record(
          z.string().min(1).max(64),
          z.string().regex(HEX_PATTERN, messages.hexInvalid),
        )
        .refine((value) => Object.keys(value).length <= 100)
        .optional(),
      borderRadius: z.string().trim().min(1).max(64),
      cornerRadii: z.object({
        cardPx: z.number().min(0).max(48),
        itemPx: z.number().min(0).max(32),
        pillPx: z.number().min(0).max(9999),
      }),
      fontFamily: z.string().trim().min(1).max(256),
      surfaceTheme: z.object({
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
      }),
      planCardStyles: z
        .record(
          z.string().min(1).max(64),
          z.object({
            gradient: optionalGradientSchema(messages.gradientInvalid),
            accent: z
              .string()
              .regex(HEX_PATTERN, messages.hexInvalid)
              .nullish(),
            texturePreset: z.enum(BRANDING_APP_BG_TEXTURES).nullish(),
            textureUrl: optionalImageUrl(messages.imageUrlInvalid),
            cardEffect: z.enum(BRANDING_CARD_EFFECTS).nullish(),
            cardEffectProps: z.record(z.string(), z.unknown()).optional(),
            cardEffectOpacity: z.number().min(0.05).max(1).nullish(),
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
    tagline: normalizeDraftNullableString(input?.tagline),
    logoUrl: normalizeDraftNullableString(input?.logoUrl),
    pwaIconUrl: normalizeDraftNullableString(input?.pwaIconUrl),
    cardPattern: normalizeDraftNullableString(input?.cardPattern),
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
      (BRANDING_CARD_EFFECTS as readonly string[]).includes(value.effect)
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

function optionalImageUrl(message: string) {
  return optionalNullableString(IMAGE_URL_MAX)
    .refine((value) => value === null || isAllowedImageUrl(value), { message })
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
