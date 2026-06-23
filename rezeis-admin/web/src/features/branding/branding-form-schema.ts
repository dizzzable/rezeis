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

export interface BrandingFormDraft {
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
  readonly fontFamily: string
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

export interface BrandingCardEffectSlotDraft {
  readonly cardEffect: string
  readonly cardEffectProps: Record<string, unknown>
  readonly cardEffectOpacity: number
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
}

const HEX_PATTERN = /^#([0-9a-fA-F]{3,8})$/
const DATA_IMAGE_BASE64_PATTERN = /^data:image\/[a-z0-9+.-]+;base64,[A-Za-z0-9+/=]+$/i
/**
 * Max length for image-bearing fields (`logoUrl`, `cardLogoUrl`,
 * `cardPattern`). Generous enough to hold an inline `data:image` base64
 * logo (~512 KB string ≈ a ~384 KB image) — the previous 8 KB cap rejected
 * almost every real PNG/SVG data URI with a bare "Invalid input".
 */
const IMAGE_URL_MAX = 524288

const DEFAULT_BRANDING_DRAFT: BrandingFormDraft = {
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
  bgEffect: 'AURORA',
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
  fontFamily: 'Geist Variable, system-ui, sans-serif',
}

export function createBrandingFormSchema(messages: BrandingFormValidationMessages) {
  return z
    .object({
      brandName: z.string().trim().min(1).max(64),
      tagline: optionalNullableString(128),
      logoUrl: optionalImageUrl(messages.imageUrlInvalid),
      pwaIconUrl: optionalImageUrl(messages.imageUrlInvalid),
      primary: z.string().regex(HEX_PATTERN, messages.hexInvalid),
      primaryFg: z.string().regex(HEX_PATTERN, messages.hexInvalid),
      bgPrimary: z.string().regex(HEX_PATTERN, messages.hexInvalid),
      bgSecondary: z.string().regex(HEX_PATTERN, messages.hexInvalid),
      cardGradient: z.string().trim().min(1).max(512),
      cardPattern: optionalNullableString(IMAGE_URL_MAX),
      cardLogo: z.enum(CARD_LOGO_PRESETS),
      cardLogoUrl: optionalImageUrl(messages.imageUrlInvalid),
      cardEffect: z.string().max(32),
      cardEffectProps: z.record(z.string(), z.unknown()).optional(),
      cardEffectOpacity: z.number().min(0.05).max(1),
      cardEffectsByIndex: z
        .array(
          z.object({
            cardEffect: z.string().max(32),
            cardEffectProps: z.record(z.string(), z.unknown()),
            cardEffectOpacity: z.number().min(0.05).max(1),
          }),
        )
        .optional(),
      bgEffect: z.enum(BRANDING_BG_EFFECTS),
      appBackground: z
        .object({
          kind: z.enum(BRANDING_APP_BG_KINDS),
          effect: z.string().max(32),
          props: z.record(z.string(), z.unknown()),
          opacity: z.number().min(0.05).max(1),
          gradient: z.string().max(512),
          texture: z.object({
            pattern: z.enum(BRANDING_APP_BG_TEXTURES),
            color: z.string(),
            background: z.string(),
            scale: z.number().min(8).max(256),
            opacity: z.number().min(0.05).max(1),
          }),
        })
        .optional(),
      iconColorMode: z.enum(BRANDING_ICON_COLOR_MODES),
      iconColors: z.record(z.string(), z.string()).optional(),
      borderRadius: z.string().trim().min(1).max(64),
      fontFamily: z.string().trim().min(1).max(256),
    })
    .transform((values): BrandingFormData => ({
      ...values,
      cardEffectsByIndex: values.cardEffectsByIndex ?? [],
      cardEffectProps: values.cardEffectProps ?? {},
      appBackground: values.appBackground ?? DEFAULT_APP_BACKGROUND_DRAFT,
      iconColors: values.iconColors ?? {},
    }))
}

export function createInitialBrandingDraft(input?: Partial<BrandingFormDraft> | null): BrandingFormDraft {
  return {
    ...DEFAULT_BRANDING_DRAFT,
    ...(input ?? {}),
    tagline: normalizeDraftNullableString(input?.tagline),
    logoUrl: normalizeDraftNullableString(input?.logoUrl),
    pwaIconUrl: normalizeDraftNullableString(input?.pwaIconUrl),
    cardPattern: normalizeDraftNullableString(input?.cardPattern),
    cardLogoUrl: normalizeDraftNullableString(input?.cardLogoUrl),
    cardEffectProps: isPlainRecord(input?.cardEffectProps) ? input.cardEffectProps : {},
    cardEffectsByIndex: Array.isArray(input?.cardEffectsByIndex) ? input.cardEffectsByIndex : [],
    appBackground: normalizeAppBackgroundDraft(input?.appBackground),
    iconColors: isPlainRecord(input?.iconColors) ? input.iconColors : {},
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
    effect: typeof value.effect === 'string' ? value.effect : 'NONE',
    props: isPlainRecordUnknown(value.props) ? value.props : {},
    opacity: clamp(value.opacity, 0.05, 1, 1),
    gradient: typeof value.gradient === 'string' && value.gradient.trim().length > 0 ? value.gradient : d.gradient,
    texture: {
      pattern: (BRANDING_APP_BG_TEXTURES as readonly string[]).includes(t.pattern ?? '')
        ? (t.pattern as BrandingAppBackgroundTextureDraft['pattern'])
        : d.texture.pattern,
      color: typeof t.color === 'string' ? t.color : d.texture.color,
      background: typeof t.background === 'string' ? t.background : d.texture.background,
      scale: Math.round(clamp(t.scale, 8, 256, d.texture.scale)),
      opacity: clamp(t.opacity, 0.05, 1, d.texture.opacity),
    },
  }
}

function optionalImageUrl(message: string) {
  return optionalNullableString(IMAGE_URL_MAX)
    .refine((value) => value === null || isAllowedImageUrl(value), { message })
}

function optionalNullableString(maxLength: number) {
  return z
    .union([z.string(), z.null(), z.undefined()])
    .transform((value) => (typeof value === 'string' ? value.trim() : ''))
    .pipe(z.string().max(maxLength))
    .transform((value) => (value.length > 0 ? value : null))
}

function isAllowedImageUrl(value: string): boolean {
  if (DATA_IMAGE_BASE64_PATTERN.test(value)) {
    return true
  }
  // Relative upload path served same-origin by the admin (and proxied by reiwa),
  // e.g. an uploaded logo / PWA icon at `/uploads/branding/<hash>.png`.
  if (/^\/uploads\/[A-Za-z0-9._/-]+$/.test(value)) {
    return true
  }
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
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
