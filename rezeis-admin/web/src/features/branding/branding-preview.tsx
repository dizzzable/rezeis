/**
 * BrandingPreview
 * ───────────────
 * Live phone-frame preview of the reiwa web cabinet. Mirrors the real
 * redesigned dashboard: branded header with the Reiwa mark, an aurora-style
 * subscription card (CSS approximation of the SPA's WebGL Aurora), action
 * buttons and the floating bottom-nav pill — all driven by the branding values
 * the operator is editing, so changes are visible instantly.
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { motion, type PanInfo } from 'motion/react'
import {
  Wifi,
  WalletCards,
  Settings,
  Sparkles,
  Tag,
  UserPlus,
  MonitorSmartphone,
  Activity,
  TicketPercent,
  LifeBuoy,
  CircleHelp,
  Copy,
  Info,
  RefreshCw,
  Trash2,
  type LucideIcon,
} from 'lucide-react'

import { ReiwaMark } from './reiwa-mark'
import { CardLogoMark, type CardLogoPreset } from './card-logo-mark'
import {
  getCardEffectDefaults,
} from './card-effect-registry'
import {
  CardEffectPreviewLayer,
} from './card-effect-preview-runtime'
import {
  hasFullOutputGamut,
  isPreviewCardEffect,
  resolveCardEffectPreviewOpacity,
} from './card-effect-preview-utils'
import { usePlans, type Plan } from '@/features/plans/plans-api'
import { autoPlanGradient, resolvePlanCardText } from './plan-card-style-utils'
import { buildTextureCss } from './app-texture'
import { PlanIconView } from '@/features/plans/plan-icon-view'
import {
  DEFAULT_SUBSCRIPTION_CARD_GLASS_DRAFT,
  DEFAULT_NAV_ITEMS,
  type PlanCardStyleDraft,
  type BrandingAppBackgroundDraft,
  type BrandingCornerRadiiDraft,
  type BrandingSubscriptionCardGlassDraft,
  type BrandingSubscriptionCardTextDraft,
  type BrandingSurfaceThemeDraft,
  type NavItemDraft,
  type NavDestinationId,
} from './branding-form-schema'

interface BrandingPreviewProps {
  values: {
    themePresetId?: string | null
    brandName?: string
    tagline?: string | null
    logoUrl?: string | null
    primary?: string
    primaryFg?: string
    bgPrimary?: string
    bgSecondary?: string
    cardGradient?: string
    cardPattern?: string | null
    subscriptionCardText?: BrandingSubscriptionCardTextDraft
    subscriptionCardGlass?: BrandingSubscriptionCardGlassDraft
    cardLogo?: CardLogoPreset
    cardLogoUrl?: string | null
    cardEffect?: string
    cardEffectProps?: Record<string, unknown>
    cardEffectOpacity?: number
    cardEffectsByIndex?: readonly {
      mode?: 'inherit' | 'override'
      cardEffect?: string
      cardEffectProps?: Record<string, unknown>
      cardEffectOpacity?: number
      cardGradient?: string | null
    }[]
    fontFamily?: string
    borderRadius?: string
    cornerRadii?: BrandingCornerRadiiDraft
    surfaceTheme?: BrandingSurfaceThemeDraft
    planCardStyles?: Record<string, PlanCardStyleDraft>
    appBackground?: BrandingAppBackgroundDraft
    navItems?: readonly NavItemDraft[]
    navGap?: number
  }
  /** Active configurator tab — drives a context-aware preview view. */
  focus?: string
}

/**
 * Mirrors the SPA's `brandAuroraStops`: a darkened → lightened → darkened triad
 * derived from the brand colour, so the default Aurora effect in the preview
 * tracks the chosen primary (same intent as the live cabinet).
 */
function brandAuroraStops(primary: string): [string, string, string] {
  return [shadeHex(primary, -0.25), shadeHex(primary, 0.35), shadeHex(primary, -0.1)]
}

function shadeHex(hex: string, amount: number): string {
  const m = hex.trim().replace(/^#/, '')
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m
  if (full.length < 6) return hex
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  const mix = (n: number) =>
    amount >= 0 ? Math.round(n + (255 - n) * amount) : Math.round(n * (1 + amount))
  const toHex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')
  return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`
}

function toRgba(hex: string, opacity: number): string {
  const raw = hex.trim().replace(/^#/, '')
  const normalized =
    raw.length === 3 || raw.length === 4
      ? raw
          .slice(0, 3)
          .split('')
          .map((character) => character + character)
          .join('')
      : raw.slice(0, 6)
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return hex
  const alpha = Math.min(1, Math.max(0, opacity))
  return `rgba(${Number.parseInt(normalized.slice(0, 2), 16)}, ${Number.parseInt(
    normalized.slice(2, 4),
    16,
  )}, ${Number.parseInt(normalized.slice(4, 6), 16)}, ${alpha})`
}

const RADIUS_MAP: Record<string, string> = {
  'rounded-none': '0',
  'rounded-lg': '0.5rem',
  'rounded-xl': '0.75rem',
  'rounded-2xl': '1rem',
  'rounded-3xl': '1.5rem',
  'rounded-full': '9999px',
}

/** Bottom-nav destination → preview glyph (mirrors the reiwa `useNavTabs`). */
const NAV_ICONS: Record<NavDestinationId, LucideIcon> = {
  subscriptions: WalletCards,
  plans: Tag,
  referrals: UserPlus,
  devices: MonitorSmartphone,
  activity: Activity,
  promo: TicketPercent,
  support: LifeBuoy,
  faq: CircleHelp,
  settings: Settings,
}

/**
 * Which subscriptions a preview page stands for.
 *
 * `slot` is the Nth configured per-position card. `fallback` is the global
 * card background, which the section's own description promises to every
 * subscription BEYOND the configured slots — a design that always exists and
 * that the operator could previously never see next to their slot artwork.
 */
type PreviewCardRole = 'slot' | 'fallback'

interface PreviewCardVisual {
  readonly role: PreviewCardRole
  readonly gradient: string
  readonly effect: string
  readonly effectProps: Record<string, unknown>
  readonly opacity: number
  readonly subscriptionCardText: BrandingSubscriptionCardTextDraft
  readonly subscriptionCardGlass: BrandingSubscriptionCardGlassDraft
}

/**
 * How many per-position slots the strip will page through. Slots beyond this
 * stay unpreviewable (the cabinet still renders them); the cap only bounds the
 * dot row. It counts SLOTS, not pages: the trailing fallback page describes
 * every subscription past the last slot, i.e. usually most of them, so it is
 * the one page that must never be squeezed out by the cap.
 */
const MAX_PREVIEW_SLOT_PAGES = 6

type PreviewRgb = readonly [number, number, number]

interface PreviewCardContrast {
  readonly foreground: string
  readonly foundation: string
  readonly veilChannels: string
  readonly veilOpacity: number
  readonly weakManualContrast: boolean
}

interface PreviewAppReadability {
  readonly veil: 'dark' | 'light'
  readonly veilChannels: string
  readonly veilOpacity: number
}

interface PreviewAppVeilCandidate {
  readonly veil: 'dark' | 'light'
  readonly veilRgb: PreviewRgb
  readonly rawOpacity: number
  readonly veilOpacity: number
}

const PREVIEW_BLACK: PreviewRgb = [0, 0, 0]
const PREVIEW_WHITE: PreviewRgb = [255, 255, 255]

// Which effects amplify, add or post-process their uniforms into display
// extremes now comes from the catalog, beside the effect it describes. It used
// to be a hand-written set here, and it went stale the moment the catalogue
// grew: ten effects that widen their gamut were missing from it, so the
// operator tuned against a preview that judged text readable on evidence the
// cabinet did not accept. That divergence is the exact failure the catalog
// exists to end — see `hasFullOutputGamut`.

/**
 * The colour forms an effect prop may be written in.
 *
 * This is the THIRD reader of effect props, and until now the only one still
 * testing `/^#[\da-f]{3,8}$/`: `card-effect-preview-utils.isSafeHexColor` (the
 * tile preview) and the cabinet's `card-effect-runtime.asColor` (the live card)
 * were both widened to `rgb()`, `rgba()`, `hsl()` and `transparent` when the
 * catalogue started shipping `rgba()` defaults and the colour codec began
 * writing `rgba()` back to keep an operator's alpha. Hex-only here meant Pixel
 * Card — three `rgba(255,255,255,…)` marks over `#000000` — read as an entirely
 * black card, so the phone preview promised light text while the cabinet, which
 * saw the three whites, shipped dark. `pixelCard` carries no `fullOutputGamut`,
 * so nothing papered over the disagreement.
 *
 * Kept as a local pattern rather than hoisted into `card-effect-preview-utils`:
 * that module is being edited alongside this change, and the two agree by test
 * (`branding-preview-effect-colors.test.tsx` runs one table of values through
 * both and fails on the first value they disagree about) rather than by hope.
 * Hoisting it is the right follow-up once both files are still again.
 *
 * Anchored for a prop value, unanchored for scanning artwork; one source so the
 * two cannot drift. Bare keywords beyond `transparent` are deliberately absent,
 * exactly as in the other two: telling `white` from `checks` needs the full
 * keyword table, and no effect default uses one.
 */
const PREVIEW_COLOR_SOURCE =
  '#(?:[\\da-f]{3,4}|[\\da-f]{6}|[\\da-f]{8})(?![\\da-f])|(?:rgb|hsl)a?\\([^()]*\\)|transparent'
const PREVIEW_COLOR_VALUE = new RegExp(`^(?:${PREVIEW_COLOR_SOURCE})$`, 'i')
const PREVIEW_COLOR_TOKEN = new RegExp(PREVIEW_COLOR_SOURCE, 'gi')

function isPreviewColorValue(value: unknown): value is string {
  return typeof value === 'string' && PREVIEW_COLOR_VALUE.test(value.trim())
}

/** `50%` and bare numbers both appear in the wild; both resolve to 0–255. */
function parsePreviewChannel(raw: string, full: number): number | null {
  const text = raw.trim()
  const percent = text.endsWith('%')
  const value = Number.parseFloat(percent ? text.slice(0, -1) : text)
  if (!Number.isFinite(value)) return null
  return percent ? (value / 100) * full : value
}

function previewHslChannel(hue: number, saturation: number, lightness: number, offset: number): number {
  const k = (offset + hue / 30) % 12
  const a = saturation * Math.min(lightness, 1 - lightness)
  return Math.round(
    (lightness - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))) * 255,
  )
}

/**
 * Any form `PREVIEW_COLOR_VALUE` accepts, flattened onto `backdrop`.
 *
 * `transparent` yields `null` on purpose: it is a colour form the props may
 * legitimately carry, and it contributes nothing to contrast. Compositing it
 * would silently add the backdrop as a sample and tilt the verdict toward
 * whatever is behind the card.
 */
function parsePreviewCssColor(
  value: string,
  backdrop: PreviewRgb = PREVIEW_BLACK,
): PreviewRgb | null {
  const text = value.trim()
  if (text.startsWith('#')) return parsePreviewHex(text, backdrop)
  const fn = /^(rgb|hsl)a?\(([^()]*)\)$/i.exec(text)
  if (!fn) return null
  const [channelsPart, slashAlpha] = fn[2].split('/').map((part) => part.trim())
  const parts = channelsPart
    .replace(/,/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  if (parts.length < 3) return null
  const alphaRaw = slashAlpha ?? parts[3]
  const alpha =
    alphaRaw === undefined
      ? 1
      : Math.min(1, Math.max(0, parsePreviewChannel(alphaRaw, 1) ?? 1))
  let rgb: PreviewRgb
  if (fn[1].toLowerCase() === 'rgb') {
    const channels = parts.slice(0, 3).map((part) => parsePreviewChannel(part, 255))
    if (channels.some((channel) => channel === null)) return null
    rgb = channels.map((channel) =>
      Math.round(Math.min(255, Math.max(0, channel ?? 0))),
    ) as unknown as PreviewRgb
  } else {
    const hue = Number.parseFloat(parts[0].replace(/deg$/i, ''))
    const saturation = parsePreviewChannel(parts[1], 1)
    const lightness = parsePreviewChannel(parts[2], 1)
    if (!Number.isFinite(hue) || saturation === null || lightness === null) return null
    const s = Math.min(1, Math.max(0, saturation))
    const l = Math.min(1, Math.max(0, lightness))
    const h = ((hue % 360) + 360) % 360
    rgb = [
      previewHslChannel(h, s, l, 0),
      previewHslChannel(h, s, l, 8),
      previewHslChannel(h, s, l, 4),
    ]
  }
  return alpha >= 1 ? rgb : previewComposite(rgb, backdrop, alpha)
}

function previewRgbVectorColor(value: unknown): string | null {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some(
      (channel) => typeof channel !== 'number' || !Number.isFinite(channel),
    )
  ) {
    return null
  }
  const scale = value.every((channel) => channel >= 0 && channel <= 1)
    ? 255
    : 1
  return `#${value
    .map((channel) =>
      Math.round(Math.min(255, Math.max(0, channel * scale)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

function resolvePreviewEffectInputColors(
  effect: string,
  props: Readonly<Record<string, unknown>>,
): readonly string[] {
  const colors: string[] = []
  for (const value of Object.values(props)) {
    if (isPreviewColorValue(value)) {
      colors.push(value)
      continue
    }
    if (!Array.isArray(value)) continue
    colors.push(...value.filter((entry): entry is string => isPreviewColorValue(entry)))
    const vector = previewRgbVectorColor(value)
    if (vector) colors.push(vector)
  }
  if (effect === 'rippleGrid' && props['enableRainbow'] === true) {
    colors.push(
      '#ff0000',
      '#ffff00',
      '#00ff00',
      '#00ffff',
      '#0000ff',
      '#ff00ff',
    )
  }
  if (['dither', 'radar', 'plasma', 'beams', 'galaxy'].includes(effect)) {
    colors.push('#000000')
  }
  if (['liquidChrome', 'galaxy'].includes(effect)) {
    colors.push('#ffffff')
  }
  return [...new Set(colors)]
}

function resolvePreviewEffectColors(
  effect: string,
  props: Readonly<Record<string, unknown>>,
): string {
  const colors = [...resolvePreviewEffectInputColors(effect, props)]
  if (hasFullOutputGamut(effect)) {
    colors.push('#000000', '#ffffff')
  }
  return [...new Set(colors)].join(' ')
}

/**
 * Lightweight mirror of reiwa's artwork contrast resolver. Branding gradients
 * are produced by colour inputs and the concept catalogue, so sampling their
 * hex stops keeps the live preview aligned without mounting another renderer.
 */
function resolvePreviewCardContrast(
  gradient: string,
  foundation: string,
  preferredForeground: string,
  effectArtwork = '',
  effectOpacity = 0,
  subscriptionCardText: BrandingSubscriptionCardTextDraft = {
    mode: 'auto',
    color: null,
  },
): PreviewCardContrast {
  const foundationRgb = parsePreviewHex(foundation)
  const baseSamples = Array.from(gradient.matchAll(/#[\da-f]{3,8}(?![\da-f])/gi))
    .map((match) => parsePreviewHex(match[0], foundationRgb ?? PREVIEW_BLACK))
    .filter((sample): sample is PreviewRgb => sample !== null)
  // The effect artwork is OUR string — the extractor's output, joined — so it
  // is scanned for every form the extractor accepts. Widening the extractor
  // without widening this would have changed nothing: an `rgba()` mark would be
  // recognised as a colour and then dropped on the floor one line later. The
  // operator gradient above stays hex-only; it is authored by colour inputs.
  const effectSamples = Array.from(effectArtwork.matchAll(PREVIEW_COLOR_TOKEN))
    .map((match) => parsePreviewCssColor(match[0]))
    .filter((sample): sample is PreviewRgb => sample !== null)
  const clampedEffectOpacity = Math.min(1, Math.max(0, effectOpacity))
  const samples =
    effectSamples.length > 0 && clampedEffectOpacity > 0
      ? [
          ...baseSamples,
          ...baseSamples.flatMap((base) =>
            effectSamples.map((effect) =>
              previewComposite(effect, base, clampedEffectOpacity),
            ),
          ),
        ]
      : baseSamples
  const resolvedSamples =
    samples.length > 0
      ? samples
      : [foundationRgb ?? (isPreviewLight(preferredForeground) ? PREVIEW_BLACK : PREVIEW_WHITE)]
  const manualForeground = resolvePreviewManualCardForeground(subscriptionCardText)
  if (manualForeground) {
    const foregroundRgb = parsePreviewHex(manualForeground)
    if (foregroundRgb) {
      // Reiwa evaluates both support veils for a forced foreground and takes
      // the weaker safe candidate. Keeping that policy here makes a custom
      // text colour render identically in the preview and real cabinet.
      const darkRequirement = previewRequiredVeil(
        resolvedSamples,
        foregroundRgb,
        PREVIEW_BLACK,
      )
      const lightRequirement = previewRequiredVeil(
        resolvedSamples,
        foregroundRgb,
        PREVIEW_WHITE,
      )
      const useLightVeil = lightRequirement < darkRequirement
      const rawRequirement = useLightVeil ? lightRequirement : darkRequirement
      const veil = useLightVeil ? PREVIEW_WHITE : PREVIEW_BLACK
      return {
        foreground: manualForeground,
        foundation,
        veilChannels: veil.join(' '),
        veilOpacity:
          Math.round(Math.min(0.75, Math.max(0.12, rawRequirement + 0.025)) * 1000) /
          1000,
        weakManualContrast: resolvedSamples.some(
          (sample) => previewContrast(foregroundRgb, sample) < 4.5,
        ),
      }
    }
  }
  const darkRequirement = previewRequiredVeil(resolvedSamples, PREVIEW_BLACK, PREVIEW_WHITE)
  const lightRequirement = previewRequiredVeil(resolvedSamples, PREVIEW_WHITE, PREVIEW_BLACK)
  const prefersLight = isPreviewLight(preferredForeground)
  const useLight =
    Math.abs(darkRequirement - lightRequirement) <= 0.015
      ? prefersLight
      : lightRequirement < darkRequirement
  const rawRequirement = useLight ? lightRequirement : darkRequirement
  const veil = useLight ? PREVIEW_BLACK : PREVIEW_WHITE

  return {
    foreground: useLight ? '#ffffff' : '#0a0a0a',
    foundation,
    veilChannels: veil.join(' '),
    veilOpacity:
      Math.round(Math.min(0.75, Math.max(0.12, rawRequirement + 0.025)) * 1000) / 1000,
    weakManualContrast: false,
  }
}

function resolvePreviewManualCardForeground(
  value: BrandingSubscriptionCardTextDraft,
): string | null {
  if (value.mode === 'light') return '#ffffff'
  if (value.mode === 'dark') return '#0a0a0a'
  if (
    value.mode === 'custom' &&
    value.color &&
    isOpaquePreviewHex(value.color) &&
    parsePreviewHex(value.color)
  ) {
    return value.color
  }
  return null
}

function isOpaquePreviewHex(value: string): boolean {
  return /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value.trim())
}

function parsePreviewHex(value: string, backdrop: PreviewRgb = PREVIEW_BLACK): PreviewRgb | null {
  let raw = value.trim().replace(/^#/, '')
  if (![3, 4, 6, 8].includes(raw.length) || !/^[\da-f]+$/i.test(raw)) return null
  if (raw.length === 3 || raw.length === 4) {
    raw = raw
      .split('')
      .map((channel) => `${channel}${channel}`)
      .join('')
  }
  const rgb = [0, 2, 4].map((offset) =>
    Number.parseInt(raw.slice(offset, offset + 2), 16),
  ) as unknown as PreviewRgb
  if (raw.length !== 8) return rgb
  const alpha = Number.parseInt(raw.slice(6, 8), 16) / 255
  return previewComposite(rgb, backdrop, alpha)
}

function previewRequiredVeil(
  samples: readonly PreviewRgb[],
  foreground: PreviewRgb,
  veil: PreviewRgb,
): number {
  let required = 0
  for (const sample of samples) {
    if (previewContrast(foreground, sample) >= 4.5) continue
    let low = 0
    let high = 1
    for (let iteration = 0; iteration < 18; iteration += 1) {
      const midpoint = (low + high) / 2
      if (previewContrast(foreground, previewComposite(veil, sample, midpoint)) >= 4.5) {
        high = midpoint
      } else {
        low = midpoint
      }
    }
    required = Math.max(required, high)
  }
  return required
}

function previewSupportsContrast(
  samples: readonly PreviewRgb[],
  textColors: readonly PreviewRgb[],
  veil: PreviewRgb,
  opacity: number,
): boolean {
  return samples.every((sample) => {
    const supported = previewComposite(veil, sample, opacity)
    return textColors.every(
      (text) => previewContrast(text, supported) >= 4.5,
    )
  })
}

function resolvePreviewAppVeilCandidate(
  samples: readonly PreviewRgb[],
  textColors: readonly PreviewRgb[],
  veil: 'dark' | 'light',
  veilRgb: PreviewRgb,
): PreviewAppVeilCandidate | null {
  const rawOpacity = Math.max(
    ...textColors.map((text) =>
      previewRequiredVeil(samples, text, veilRgb),
    ),
  )
  if (rawOpacity <= 0) return null

  const veilOpacity =
    Math.round(Math.min(0.88, Math.max(0, rawOpacity + 0.03)) * 1000) /
    1000
  if (!previewSupportsContrast(samples, textColors, veilRgb, veilOpacity)) {
    return null
  }

  return { veil, veilRgb, rawOpacity, veilOpacity }
}

function previewComposite(
  foreground: PreviewRgb,
  background: PreviewRgb,
  alpha: number,
): PreviewRgb {
  return foreground.map(
    (channel, index) => channel * alpha + background[index] * (1 - alpha),
  ) as unknown as PreviewRgb
}

function previewContrast(left: PreviewRgb, right: PreviewRgb): number {
  const leftLuminance = previewLuminance(left)
  const rightLuminance = previewLuminance(right)
  return (
    (Math.max(leftLuminance, rightLuminance) + 0.05) /
    (Math.min(leftLuminance, rightLuminance) + 0.05)
  )
}

function previewLuminance(rgb: PreviewRgb): number {
  const [red, green, blue] = rgb.map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function isPreviewLight(value: string): boolean {
  const color = parsePreviewHex(value)
  return color ? previewLuminance(color) >= 0.5 : true
}

function resolvePreviewAppReadability(
  gradient: string,
  foundation: string,
  foreground: string,
  mutedForeground: string,
  texture:
    | {
        readonly background: string
        readonly color: string
        readonly opacity: number
      }
    | undefined,
  textureMode: 'none' | 'texture' | 'concept',
): PreviewAppReadability | null {
  const foundationRgb = parsePreviewHex(foundation) ?? PREVIEW_BLACK
  const gradientSamples = Array.from(
    gradient.matchAll(/#[\da-f]{3,8}(?![\da-f])/gi),
  )
    .map((match) => parsePreviewHex(match[0], foundationRgb))
    .filter((sample): sample is PreviewRgb => sample !== null)
  const textureBackground = texture
    ? parsePreviewHex(texture.background)
    : null
  const textureColor = texture ? parsePreviewHex(texture.color) : null
  const textureSamples: PreviewRgb[] =
    textureMode === 'texture'
      ? [textureBackground, textureColor].filter(
          (sample): sample is PreviewRgb => sample !== null,
        )
      : textureMode === 'concept' && textureBackground && textureColor
        ? [
            textureBackground,
            previewComposite(
              textureColor,
              textureBackground,
              Math.min(1, Math.max(0, texture?.opacity ?? 0)),
            ),
          ]
        : []
  const samples = [...gradientSamples, ...textureSamples]
  if (samples.length === 0) return null
  const textColors = [foreground, mutedForeground]
    .map((value) => parsePreviewHex(value))
    .filter((sample): sample is PreviewRgb => sample !== null)
  const resolvedTextColors = textColors.length > 0 ? textColors : [PREVIEW_WHITE]
  const candidates = [
    resolvePreviewAppVeilCandidate(
      samples,
      resolvedTextColors,
      'dark',
      PREVIEW_BLACK,
    ),
    resolvePreviewAppVeilCandidate(
      samples,
      resolvedTextColors,
      'light',
      PREVIEW_WHITE,
    ),
  ].filter(
    (candidate): candidate is PreviewAppVeilCandidate => candidate !== null,
  )
  if (candidates.length === 0) return null

  candidates.sort((left, right) => left.rawOpacity - right.rawOpacity)
  const selected = candidates[0]!

  return {
    veil: selected.veil,
    veilChannels: selected.veilRgb.join(' '),
    veilOpacity: selected.veilOpacity,
  }
}

function previewAppReadabilityZones(
  readability: PreviewAppReadability,
): string {
  const channels = readability.veilChannels
  const veil = readability.veilOpacity
  const edge = Math.min(0.88, veil + 0.12)
  return `linear-gradient(180deg, rgb(${channels} / ${edge}) 0%, rgb(${channels} / ${veil}) 16%, rgb(${channels} / ${veil}) 28%, rgb(${channels} / ${veil}) 40%, rgb(${channels} / ${veil}) 60%, rgb(${channels} / ${veil}) 72%, rgb(${channels} / ${veil}) 84%, rgb(${channels} / ${edge}) 100%)`
}

/** One subscription-card mock in the preview, with its own effect + gradient. */
function PreviewSubscriptionCard({
  visual,
  primary,
  primaryFg,
  foundation,
  brandName,
  cardPattern,
  cardLogo,
  cardLogoUrl,
  radius,
}: {
  visual: PreviewCardVisual
  primary: string
  primaryFg: string
  foundation: string
  brandName: string
  cardPattern?: string | null
  cardLogo: CardLogoPreset
  cardLogoUrl?: string | null
  radius: string
}) {
  const { t } = useTranslation()
  const hasEffect = isPreviewCardEffect(visual.effect)
  const effectProps = useMemo<Record<string, unknown>>(() => {
    if (!hasEffect) return {}
    const base = { ...getCardEffectDefaults(visual.effect), ...visual.effectProps }
    if (visual.effect === 'aurora' && base['colorStops'] === undefined) {
      return { colorStops: brandAuroraStops(primary), amplitude: 1.1, blend: 0.55, speed: 0.8, ...base }
    }
    return base
  }, [hasEffect, visual.effect, visual.effectProps, primary])
  const effectOpacity = resolveCardEffectPreviewOpacity(visual.opacity)
  const contrast = useMemo(
    () =>
      resolvePreviewCardContrast(
        visual.gradient,
        foundation,
        primaryFg,
        resolvePreviewEffectColors(visual.effect, effectProps),
        hasEffect ? effectOpacity : 0,
        visual.subscriptionCardText,
      ),
    [
      effectProps,
      effectOpacity,
      foundation,
      hasEffect,
      primaryFg,
      visual.effect,
      visual.gradient,
      visual.subscriptionCardText,
    ],
  )
  return (
    <div
      data-preview-subscription-card
      data-preview-card-foreground={
        contrast.foreground === '#0a0a0a' ? 'dark' : 'light'
      }
      data-preview-card-text-mode={visual.subscriptionCardText.mode}
      data-preview-card-artwork={hasEffect ? 'animated' : 'static'}
      className="relative isolate h-[160px] overflow-hidden p-4 [contain:paint]"
      style={{
        borderRadius: radius,
        color: contrast.foreground,
        boxShadow: `inset 0 0 0 1px ${toRgba(contrast.foreground, 0.1)}`,
      }}
    >
      {/* Layer order mirrors the normal reiwa card frame. */}
      <div
        data-preview-card-layer="foundation"
        className="absolute inset-0"
        style={{ backgroundColor: contrast.foundation }}
      />
      <div
        data-preview-card-layer="gradient"
        className="absolute inset-0"
        style={{ backgroundImage: visual.gradient }}
      />
      {cardPattern && cardPattern !== 'none' && (
        <div
          data-preview-card-layer="pattern"
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            backgroundImage: cardPattern,
            backgroundSize: cardPattern.includes('gradient(')
              ? '24px 24px'
              : undefined,
          }}
        />
      )}
      {/* Subscription-card effects intentionally stay live in the preview.
          Reiwa treats an explicitly configured card effect as branded artwork
          rather than decorative motion, so this must mirror the live card. */}
      {hasEffect && (
        <CardEffectPreviewLayer
          effect={visual.effect}
          props={effectProps}
          opacity={visual.opacity}
        />
      )}
      {/* Choosing a text tone must not repaint the operator's gradient. The
          contrast calculation is retained for the foreground and warning,
          while any visual film is an explicit glass setting below. */}
      {visual.subscriptionCardGlass.enabled && (
        <div
          data-preview-card-layer="glass"
          className="pointer-events-none absolute inset-0 z-0"
          style={{
            backgroundColor: toRgba(
              visual.subscriptionCardGlass.tint,
              visual.subscriptionCardGlass.opacity,
            ),
            border: `1px solid ${toRgba(
              visual.subscriptionCardGlass.tint,
              visual.subscriptionCardGlass.borderOpacity,
            )}`,
            backdropFilter:
              visual.subscriptionCardGlass.blurPx > 0
                ? `blur(${visual.subscriptionCardGlass.blurPx}px)`
                : undefined,
            WebkitBackdropFilter:
              visual.subscriptionCardGlass.blurPx > 0
                ? `blur(${visual.subscriptionCardGlass.blurPx}px)`
                : undefined,
          }}
        />
      )}
      {/* Watermark — operator-configurable glyph or custom image */}
      <CardLogoMark
        preset={cardLogo}
        customUrl={cardLogoUrl}
        className="pointer-events-none absolute -right-4 -bottom-6 h-28 w-28"
        style={{ color: contrast.foreground, opacity: 0.12 }}
      />
      {contrast.weakManualContrast && (
        <span
          data-preview-card-contrast-warning
          role="status"
          className="absolute bottom-1 left-2 z-10 rounded bg-black/55 px-1.5 py-0.5 text-[8px] font-medium text-white"
        >
          {t('brandingPage.sections.preview.cardTextContrastWarning')}
        </span>
      )}

      {/* Card content */}
      <div className="relative flex h-full flex-col justify-between">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Wifi className="h-3.5 w-3.5 opacity-90" />
            <span className="text-[11px] font-semibold">{brandName}</span>
          </div>
          <span
            className="rounded-full px-2 py-0.5 text-[8px] font-bold uppercase backdrop-blur-md"
            style={{
              backgroundColor: toRgba(contrast.foreground, 0.16),
            }}
          >
            {t('brandingPage.sections.preview.statusLabel')}
          </span>
        </div>

        <p className="w-fit max-w-full truncate font-mono text-sm tracking-[0.18em]">
          usr_a1b2c3d4e5f6
        </p>

        <div>
          <div
            className="mb-2 h-1.5 w-full overflow-hidden rounded-full"
            style={{ backgroundColor: toRgba(contrast.foreground, 0.18) }}
          >
            <div
              className="h-full w-2/3 rounded-full"
              style={{ backgroundColor: toRgba(contrast.foreground, 0.82) }}
            />
          </div>
          <div className="flex items-end justify-between">
            <div>
              <p className="text-[10px] font-medium uppercase">
                {t('brandingPage.sections.preview.remaining')}
              </p>
              <p className="text-[13px] font-bold leading-none">
                {t('brandingPage.sections.preview.daysMock')}
              </p>
              <p className="mt-0.5 text-[10px]">
                {t('brandingPage.sections.preview.until', { date: '03/2026' })}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[10px] font-medium uppercase">
                {t('brandingPage.sections.preview.device')}
              </p>
              <p className="text-[11px] font-medium">iPhone 15</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Swipeable strip of subscription cards for the live preview. */
function SubscriptionCardsPreview({
  cards,
  primary,
  primaryFg,
  foundation,
  brandName,
  cardPattern,
  cardLogo,
  cardLogoUrl,
  radius,
  captionColor,
}: {
  cards: readonly PreviewCardVisual[]
  primary: string
  primaryFg: string
  foundation: string
  brandName: string
  cardPattern?: string | null
  cardLogo: CardLogoPreset
  cardLogoUrl?: string | null
  radius: string
  captionColor: string
}) {
  const { t } = useTranslation()
  const [page, setPage] = useState(0)
  const total = Math.max(cards.length, 1)
  const active = Math.min(page, total - 1)
  const multi = total > 1

  function onDragEnd(_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo): void {
    if (info.offset.x < -40) setPage((p) => Math.min(p + 1, total - 1))
    else if (info.offset.x > 40) setPage((p) => Math.max(p - 1, 0))
  }

  /**
   * A page name the operator can act on. "Card 7" would say nothing about the
   * one page that is not a slot — the global card background every
   * subscription past the last slot gets — so that page is named for what it
   * covers instead of for its position in the strip.
   */
  function pageLabel(index: number): string {
    return cards[index]?.role === 'fallback'
      ? t('brandingPage.sections.preview.cardPageRest')
      : t('brandingPage.sections.preview.cardDot', { index: index + 1 })
  }

  const activeCard = cards[active] ?? cards[0]!

  return (
    <div className="relative">
      <motion.div
        key={active}
        data-preview-card-page={activeCard.role}
        drag={multi ? 'x' : false}
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.18}
        onDragEnd={onDragEnd}
        className={multi ? 'cursor-grab active:cursor-grabbing' : ''}
      >
        <PreviewSubscriptionCard
          visual={activeCard}
          primary={primary}
          primaryFg={primaryFg}
          foundation={foundation}
          brandName={brandName}
          cardPattern={cardPattern}
          cardLogo={cardLogo}
          cardLogoUrl={cardLogoUrl}
          radius={radius}
        />
      </motion.div>
      {multi && (
        <div className="mt-2 flex flex-col items-center gap-1">
          <p
            data-preview-card-page-label={activeCard.role}
            className="text-[9px] font-medium"
            style={{ color: captionColor }}
          >
            {pageLabel(active)}
          </p>
          <div className="flex items-center justify-center gap-1.5">
            {cards.map((card, i) => (
              <button
                key={i}
                type="button"
                data-preview-card-dot={card.role}
                aria-label={pageLabel(i)}
                aria-current={i === active}
                onClick={() => setPage(i)}
                className="flex h-6 w-6 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black/70"
              >
                <span
                  aria-hidden="true"
                  className={`h-1.5 rounded-full transition-all ${
                    i === active ? 'w-4 bg-white/80' : 'w-1.5 bg-white/30'
                  }`}
                />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * A compact, non-interactive copy of the dashboard device area.  The live
 * preview previously jumped straight from the action buttons to an icon-only
 * nav, which made its rhythm noticeably different from the real cabinet.
 * This uses the same hierarchy as Reiwa: title/actions, device rows, then the
 * bottom navigation as the final fixed visual anchor.
 */
function DashboardDevicesPreview({
  primary,
  surfaceTheme,
  itemRadius,
}: {
  primary: string
  surfaceTheme: BrandingSurfaceThemeDraft
  itemRadius: string
}) {
  const { t } = useTranslation()
  const devices = ['iPhone 12 Pro Max', 'Windows 11 Pro', 'Windows 11 amd64']

  return (
    <section
      data-preview-devices
      className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold" style={{ color: surfaceTheme.foreground }}>
          {t('brandingPage.sections.preview.devicesTitle')}
        </p>
        <div className="flex items-center gap-2 text-[8px]" style={{ color: surfaceTheme.mutedForeground }}>
          <Info className="h-3 w-3" />
          <span className="flex items-center gap-1"><Copy className="h-3 w-3" />{t('brandingPage.sections.preview.copyLink')}</span>
          <span className="flex items-center gap-1"><RefreshCw className="h-3 w-3" />{t('brandingPage.sections.preview.regenerate')}</span>
        </div>
      </div>
      <div className="mt-2 space-y-1.5">
        {devices.map((name) => (
          <div
            key={name}
            className="flex items-center gap-2 border px-2 py-1.5"
            style={{
              borderRadius: itemRadius,
              backgroundColor: toRgba(surfaceTheme.surface, surfaceTheme.surfaceOpacity),
              borderColor: toRgba(surfaceTheme.borderSoft, surfaceTheme.borderSoftOpacity),
              backdropFilter: `blur(${surfaceTheme.glassBlurPx}px)`,
            }}
          >
            <div
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
              style={{ backgroundColor: toRgba(surfaceTheme.surfaceHigh, surfaceTheme.surfaceHighOpacity) }}
            >
              <MonitorSmartphone className="h-3.5 w-3.5" style={{ color: primary }} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[9px] font-medium" style={{ color: surfaceTheme.foreground }}>{name}</p>
              <p className="truncate text-[7px]" style={{ color: surfaceTheme.mutedForeground }}>
                {t('brandingPage.sections.preview.lastSeen')}
              </p>
            </div>
            <Trash2 className="h-3 w-3 shrink-0" style={{ color: surfaceTheme.mutedForeground }} />
          </div>
        ))}
      </div>
    </section>
  )
}

export function BrandingPreview({ values, focus }: BrandingPreviewProps) {
  const { t } = useTranslation()
  const {
    themePresetId,
    brandName = 'Reiwa',
    tagline,
    logoUrl,
    primary = '#22c55e',
    primaryFg = '#0a0a0a',
    bgPrimary = '#0a0a0a',
    bgSecondary = '#18181b',
    cardGradient = 'linear-gradient(135deg, #064e3b 0%, #22c55e 100%)',
    cardPattern,
    subscriptionCardText = { mode: 'auto', color: null },
    subscriptionCardGlass = DEFAULT_SUBSCRIPTION_CARD_GLASS_DRAFT,
    cardLogo = 'DEFAULT',
    cardLogoUrl,
    cardEffect = 'aurora',
    cardEffectProps = {},
    cardEffectOpacity = 1,
    cardEffectsByIndex = [],
    fontFamily = 'Geist Variable, system-ui, sans-serif',
    borderRadius = 'rounded-2xl',
    cornerRadii,
    surfaceTheme = {
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
    },
    planCardStyles = {},
    appBackground,
    navItems,
    navGap = 2,
  } = values

  const radius = cornerRadii
    ? `${cornerRadii.cardPx}px`
    : RADIUS_MAP[borderRadius] ?? '1rem'
  const itemRadius = `${cornerRadii?.itemPx ?? 14}px`
  const pillRadius = `${cornerRadii?.pillPx ?? 9999}px`

  // Plans power the context-aware tariff preview (planCards tab). Shared,
  // react-query-cached fetch — free when the section already loaded it.
  const { data: plans } = usePlans()

  // Live site-wide app background (App background tab). Mirrors the cabinet
  // shell: gradient / tiled texture / animated effect / plain colour.
  const appBgEffectProps = useMemo<Record<string, unknown>>(() => {
    if (appBackground?.kind !== 'effect' || !isPreviewCardEffect(appBackground.effect)) {
      return {}
    }
    const base = { ...getCardEffectDefaults(appBackground.effect), ...appBackground.props }
    if (appBackground.effect === 'aurora' && base['colorStops'] === undefined) {
      return { colorStops: brandAuroraStops(primary), amplitude: 1.1, blend: 0.55, speed: 0.8, ...base }
    }
    return base
  }, [appBackground, primary])
  const overlaysConceptTexture =
    appBackground?.kind === 'gradient' &&
    typeof themePresetId === 'string' &&
    themePresetId.startsWith('concept-')
  const appBgTextureCss =
    appBackground?.kind === 'texture' || overlaysConceptTexture
      ? buildTextureCss(appBackground.texture)
      : null
  const appReadability = useMemo(
    () =>
      appBackground &&
      appBackground.kind !== 'none' &&
      appBackground.kind !== 'effect'
        ? resolvePreviewAppReadability(
            appBackground.kind === 'gradient'
              ? appBackground.gradient
              : '',
            appBackground.kind === 'texture'
              ? appBackground.texture.background
              : bgPrimary,
            surfaceTheme.foreground,
            surfaceTheme.mutedForeground,
            appBackground.texture,
            appBackground.kind === 'texture'
              ? 'texture'
              : overlaysConceptTexture
                ? 'concept'
                : 'none',
          )
        : null,
    [
      appBackground,
      bgPrimary,
      overlaysConceptTexture,
      surfaceTheme.foreground,
      surfaceTheme.mutedForeground,
    ],
  )

  // Configured bottom navigation (Навигация tab) → live preview pill.
  const navSource = navItems && navItems.length > 0 ? navItems : DEFAULT_NAV_ITEMS
  const visibleNav = navSource.filter((i) => i.visible).slice(0, 5)

  // Build the list of subscription cards to preview. Each configured
  // per-position slot (cardEffectsByIndex) becomes its own page with its own
  // effect + gradient (falling back to the global values), and ONE trailing
  // page always shows the global card background.
  //
  // That trailing page is not decoration. The slots section states its own
  // contract — "slot 1 → the first subscription, slot 2 → the second, and so
  // on; subscriptions beyond the configured slots use the global card
  // background above" — so the moment a single slot exists the operator has
  // TWO designs in production and could previously see only the first. Passing
  // `undefined` for the slot resolves every field to the global value, which is
  // exactly what the cabinet renders past the last slot.
  //
  // With zero slots this collapses to the single global card it always was
  // (no dots, no drag: only one design exists).
  const previewCards = useMemo<PreviewCardVisual[]>(() => {
    const slots = cardEffectsByIndex ?? []
    const toVisual = (
      slot: (typeof slots)[number] | undefined,
      role: PreviewCardRole,
    ): PreviewCardVisual => {
      const slotGradient = (slot?.cardGradient ?? '').trim()
      const slotOverridesEffect = slot?.mode === 'override'
      return {
        role,
        gradient: slotGradient.length > 0 ? slotGradient : cardGradient,
        effect: slotOverridesEffect ? slot?.cardEffect ?? cardEffect : cardEffect,
        effectProps: slotOverridesEffect ? slot?.cardEffectProps ?? cardEffectProps : cardEffectProps,
        opacity: slotOverridesEffect ? slot?.cardEffectOpacity ?? cardEffectOpacity : cardEffectOpacity,
        subscriptionCardText,
        subscriptionCardGlass,
      }
    }
    return [
      ...slots
        .slice(0, MAX_PREVIEW_SLOT_PAGES)
        .map((slot) => toVisual(slot, 'slot')),
      toVisual(undefined, 'fallback'),
    ]
  }, [
    cardEffectsByIndex,
    cardGradient,
    cardEffect,
    cardEffectProps,
    cardEffectOpacity,
    subscriptionCardText,
    subscriptionCardGlass,
  ])

  return (
    <div className="flex flex-col items-center">
      {/* Phone frame */}
      <div
        data-preview-phone-frame
        className="relative flex h-[560px] w-[300px] flex-col overflow-hidden rounded-[2.5rem] border-4 shadow-2xl"
        style={{
          backgroundColor: bgPrimary,
          borderColor: toRgba(surfaceTheme.borderStrong, surfaceTheme.borderStrongOpacity),
          color: surfaceTheme.foreground,
          fontFamily,
        }}
      >
        {/* Ambient brand glow */}
        <div
          className="pointer-events-none absolute -top-16 -left-16 h-48 w-48 rounded-full blur-3xl"
          style={{ background: primary, opacity: 0.18 }}
        />

        {/* Live site-wide app background layer (App background tab). */}
        {appBackground && appBackground.kind !== 'none' && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 overflow-hidden"
          >
            {appBackground.kind === 'gradient' && (
              <div className="absolute inset-0" style={{ backgroundImage: appBackground.gradient }} />
            )}
            {appBgTextureCss && (
              <div
                data-preview-app-background-texture={appBackground.texture.pattern}
                className="absolute inset-0"
                style={{
                  backgroundColor:
                    appBackground.kind === 'texture'
                      ? appBgTextureCss.backgroundColor
                      : undefined,
                  backgroundImage: appBgTextureCss.backgroundImage,
                  backgroundSize: appBgTextureCss.backgroundSize,
                  backgroundRepeat: 'repeat',
                  mixBlendMode: overlaysConceptTexture
                    ? 'soft-light'
                    : undefined,
                }}
              />
            )}
            {appReadability && appReadability.veilOpacity > 0 && (
              <div
                data-preview-app-readability="wcag-direct-copy-zones"
                data-preview-app-readability-veil={appReadability.veil}
                data-preview-app-readability-opacity={
                  appReadability.veilOpacity
                }
                className="absolute inset-0"
                style={{
                  background: previewAppReadabilityZones(appReadability),
                }}
              />
            )}
            {appBackground.kind === 'effect' && appBackground.effect !== 'NONE' && (
              <div
                data-preview-app-background-layer="foundation"
                className="absolute inset-0"
                style={{ backgroundImage: appBackground.gradient }}
              />
            )}
            {appBackground.kind === 'effect' && isPreviewCardEffect(appBackground.effect) && (
              <div
                data-preview-app-background-layer="effect"
                className="absolute inset-0"
              >
                <CardEffectPreviewLayer
                  effect={appBackground.effect}
                  props={appBgEffectProps}
                  opacity={appBackground.opacity}
                />
              </div>
            )}
          </div>
        )}

        {/* Status bar */}
        <div className="relative flex items-center justify-between px-6 pt-3 pb-1">
          <span className="text-[10px] font-medium" style={{ color: surfaceTheme.mutedForeground }}>9:41</span>
          <span className="text-[10px]" style={{ color: surfaceTheme.mutedForeground }}>●●● ▮</span>
        </div>

        {/* Content area */}
        <div className="relative flex min-h-0 flex-1 flex-col px-4 pb-0">
          {/* Header: logo + brand + actions */}
          <div className="flex items-center justify-between py-3">
            <div className="flex items-center gap-2">
              {logoUrl ? (
                <img src={logoUrl} alt={brandName} className="h-7 w-7 rounded-lg object-contain" />
              ) : (
                <ReiwaMark className="h-7 w-7" style={{ color: primary }} />
              )}
              <div className="leading-tight">
                <p className="text-xs font-semibold" style={{ color: surfaceTheme.foreground }}>{brandName}</p>
                <p className="truncate text-[9px]" style={{ color: surfaceTheme.mutedForeground }}>
                  {tagline?.trim() || t('brandingPage.sections.preview.welcome')}
                </p>
              </div>
            </div>
            <div className="flex gap-1.5">
              <span
                className="h-6 w-6 rounded-full border"
                style={{
                  backgroundColor: toRgba(surfaceTheme.surface, surfaceTheme.surfaceOpacity),
                  borderColor: toRgba(surfaceTheme.borderSoft, surfaceTheme.borderSoftOpacity),
                  backdropFilter: `blur(${surfaceTheme.glassBlurPx}px)`,
                }}
              />
              <span
                className="h-6 w-6 rounded-full border"
                style={{
                  backgroundColor: toRgba(surfaceTheme.surface, surfaceTheme.surfaceOpacity),
                  borderColor: toRgba(surfaceTheme.borderSoft, surfaceTheme.borderSoftOpacity),
                  backdropFilter: `blur(${surfaceTheme.glassBlurPx}px)`,
                }}
              />
            </div>
          </div>

          {/* Context-aware body: tariff cards on the planCards tab, else the
              dashboard mock (subscription card + actions + nav). */}
          {focus === 'planCards' ? (
            <TariffListPreview
              plans={(plans ?? []).slice(0, 3)}
              planCardStyles={planCardStyles}
              primary={primary}
              primaryFg={primaryFg}
              foundation={bgSecondary}
              subscriptionCardText={subscriptionCardText}
              cardLogo={cardLogo}
              cardLogoUrl={cardLogoUrl}
              radius={radius}
              unlimitedLabel={t('brandingPage.sections.planCards.unlimited')}
              emptyLabel={t('brandingPage.sections.planCards.empty')}
            />
          ) : (
            <>
          {/* Subscription card(s) — swipeable strip; each configured
              per-position card shows its own gradient + effect. */}
          <SubscriptionCardsPreview
            cards={previewCards}
            primary={primary}
            primaryFg={primaryFg}
            foundation={bgSecondary}
            brandName={brandName}
            cardPattern={cardPattern}
            cardLogo={cardLogo}
            cardLogoUrl={cardLogoUrl}
            radius={radius}
            captionColor={surfaceTheme.mutedForeground}
          />

          {/* Action buttons */}
          <div className="mt-3 grid grid-cols-3 gap-2">
            {[
              t('brandingPage.sections.preview.actions.buy'),
              t('brandingPage.sections.preview.actions.connect'),
              t('brandingPage.sections.preview.actions.upgrade'),
            ].map((label, i) => (
              <div
                key={label}
                className="flex flex-col items-center gap-1 rounded-2xl py-2.5"
                style={
                  i === 1
                    ? { borderRadius: itemRadius, backgroundColor: primary }
                    : {
                        borderRadius: itemRadius,
                        backgroundColor: toRgba(
                          surfaceTheme.surface,
                          surfaceTheme.surfaceOpacity,
                        ),
                        border: `1px solid ${toRgba(
                          surfaceTheme.borderSoft,
                          surfaceTheme.borderSoftOpacity,
                        )}`,
                        backdropFilter: `blur(${surfaceTheme.glassBlurPx}px)`,
                      }
                }
              >
                <div
                  className="h-3.5 w-3.5 rounded-full"
                  style={{ backgroundColor: i === 1 ? primaryFg : primary }}
                />
                <span
                  className="text-[9px] font-medium"
                  style={{ color: i === 1 ? primaryFg : surfaceTheme.mutedForeground }}
                >
                  {label}
                </span>
              </div>
            ))}
          </div>

          {/* Bottom nav pill — reflects the configured navItems + navGap (Навигация tab) */}
          <DashboardDevicesPreview
            primary={primary}
            surfaceTheme={surfaceTheme}
            itemRadius={itemRadius}
          />

          <div
            data-preview-bottom-nav
            data-preview-nav-gap={navGap}
            className="mt-auto -mx-1 pb-3 pt-2"
          >
            <div
              className="mx-auto w-fit max-w-full rounded-3xl border px-1 py-1.5 shadow-[0_8px_32px_rgba(0,0,0,0.18)]"
              style={{
                backgroundColor: toRgba(
                  surfaceTheme.surfaceHigh,
                  surfaceTheme.surfaceHighOpacity,
                ),
                borderColor: toRgba(
                  surfaceTheme.borderSoft,
                  surfaceTheme.borderSoftOpacity,
                ),
                backdropFilter: `blur(${surfaceTheme.glassBlurPx}px)`,
                borderRadius: pillRadius,
              }}
            >
              <div
                data-preview-nav-items
                className="relative flex"
                style={{ gap: `${navGap}px` }}
              >
                {visibleNav.map((item, i) => {
                  const Icon = NAV_ICONS[item.id];
                  const active = i === 0;
                  return (
                    <div
                      key={item.id}
                      data-preview-nav-tab={item.id}
                      className="relative z-10 flex min-h-[44px] w-[50px] flex-col items-center justify-center gap-1 px-1 py-1.5"
                      style={{
                        borderRadius: itemRadius,
                        color: active ? primaryFg : surfaceTheme.mutedForeground,
                      }}
                    >
                      {active && (
                        <span
                          aria-hidden="true"
                          className="absolute inset-0 -z-10"
                          style={{ backgroundColor: primary, borderRadius: itemRadius }}
                        />
                      )}
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      <span className="max-w-full truncate text-[7px] font-medium leading-none tracking-tight">
                        {t(`brandingPage.sections.nav.dest.${item.id}`)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
            </>
          )}
        </div>
      </div>

      <p className="mt-3 text-center text-xs text-muted-foreground">
        {t('brandingPage.sections.preview.liveLabel')}
      </p>
    </div>
  )
}

/**
 * Context-aware tariff preview shown on the "Тарифные карточки" tab. Renders up
 * to three plans as cabinet-style cards (gradient + texture + accent + clean
 * icon) using the SAME resolution rules as the reiwa `/plans` page, so the
 * operator sees per-plan edits live in the phone frame.
 */
interface TariffListPreviewProps {
  readonly plans: ReadonlyArray<Plan>
  readonly planCardStyles: Record<string, PlanCardStyleDraft>
  readonly primary: string
  readonly primaryFg: string
  /** Colour behind the card, used when the gradient carries no sampleable stops. */
  readonly foundation: string
  /** The global decision an unconfigured tariff card inherits. */
  readonly subscriptionCardText: BrandingSubscriptionCardTextDraft
  readonly cardLogo: CardLogoPreset
  readonly cardLogoUrl?: string | null
  readonly radius: string
  readonly unlimitedLabel: string
  readonly emptyLabel: string
}

function TariffListPreview({
  plans,
  planCardStyles,
  primary,
  primaryFg,
  foundation,
  subscriptionCardText,
  cardLogo,
  cardLogoUrl,
  radius,
  unlimitedLabel,
  emptyLabel,
}: TariffListPreviewProps) {
  if (plans.length === 0) {
    return (
      <div className="mt-2 flex h-[180px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-white/10 px-4 text-center">
        <Sparkles className="h-6 w-6 text-white/30" />
        <p className="text-[10px] text-white/40">{emptyLabel}</p>
      </div>
    )
  }
  return (
    <div className="mt-2 space-y-2.5">
      {plans.map((plan) => (
        <TariffPreviewCard
          key={plan.id}
          plan={plan}
          style={planCardStyles[plan.id]}
          primary={primary}
          primaryFg={primaryFg}
          foundation={foundation}
          subscriptionCardText={subscriptionCardText}
          cardLogo={cardLogo}
          cardLogoUrl={cardLogoUrl}
          radius={radius}
          unlimitedLabel={unlimitedLabel}
        />
      ))}
    </div>
  )
}

function TariffPreviewCard({
  plan,
  style,
  primary,
  primaryFg,
  foundation,
  subscriptionCardText,
  cardLogo,
  cardLogoUrl,
  radius,
  unlimitedLabel,
}: {
  readonly plan: Plan
  readonly style: PlanCardStyleDraft | undefined
  readonly primary: string
  readonly primaryFg: string
  readonly foundation: string
  readonly subscriptionCardText: BrandingSubscriptionCardTextDraft
  readonly cardLogo: CardLogoPreset
  readonly cardLogoUrl?: string | null
  readonly radius: string
  readonly unlimitedLabel: string
}) {
  const gradient = style?.gradient && style.gradient.length > 0 ? style.gradient : autoPlanGradient(plan.id)
  const accent = style?.accent && style.accent.length > 0 ? style.accent : primary
  const textureUrl = style?.textureUrl && style.textureUrl.length > 0 ? style.textureUrl : null
  const textureCss =
    !textureUrl && style?.texturePreset
      ? buildTextureCss({
          pattern: style.texturePreset,
          color: accent,
          background: 'transparent',
          scale: 18,
          opacity: 0.5,
        })
      : null
  // Per-plan animated effect (opt-in) — mirrors the cabinet tariff card.
  const effect = style?.cardEffect && style.cardEffect !== 'NONE' ? style.cardEffect : 'NONE'
  const effectProps = useMemo<Record<string, unknown>>(() => {
    if (!isPreviewCardEffect(effect)) return {}
    const base = { ...getCardEffectDefaults(effect), ...(style?.cardEffectProps ?? {}) }
    if (effect === 'aurora' && base['colorStops'] === undefined) {
      return { colorStops: brandAuroraStops(primary), amplitude: 1.1, blend: 0.55, speed: 0.8, ...base }
    }
    return base
  }, [effect, style?.cardEffectProps, primary])
  const effectOpacity = typeof style?.cardEffectOpacity === 'number' ? style.cardEffectOpacity : 1
  // Icon resolves exactly like the cabinet tariff card: lucide preset →
  // glyph, `custom:<id>` → uploaded icon, `:slug:`/unicode → emoji, else
  // a Sparkles fallback. Centralised in PlanIconView (no local regex).

  /**
   * Card copy colour, resolved exactly as the cabinet resolves it: the per-plan
   * override if there is one, otherwise the global subscription-card policy,
   * and `auto` runs the same contrast computation the subscription-card mock
   * above uses. Without this the operator picks a text colour and the preview
   * goes on drawing white — which is choosing blind, and the only place the
   * mistake would surface is a subscriber's screen.
   *
   * The effect artwork is fed in for the same reason the cabinet feeds it in:
   * an opaque animation over a dark gradient changes what is readable. It is
   * suppressed when a `textureUrl` is set, because the image wins and the
   * effect layer is not mounted (the condition above renders it identically).
   */
  const drawsOverlay = isPreviewCardEffect(effect) && !textureUrl
  const contrast = useMemo(
    () =>
      resolvePreviewCardContrast(
        gradient,
        foundation,
        primaryFg,
        drawsOverlay ? resolvePreviewEffectColors(effect, effectProps) : '',
        drawsOverlay ? effectOpacity : 0,
        resolvePlanCardText(style, subscriptionCardText),
      ),
    [
      gradient,
      foundation,
      primaryFg,
      drawsOverlay,
      effect,
      effectProps,
      effectOpacity,
      style,
      subscriptionCardText,
    ],
  )

  return (
    <div
      data-preview-tariff-card
      data-preview-tariff-card-foreground={contrast.foreground}
      className="relative overflow-hidden p-3 ring-1 ring-white/10"
      style={{ borderRadius: radius, backgroundImage: gradient, color: contrast.foreground }}
    >
      {isPreviewCardEffect(effect) && !textureUrl && (
        <CardEffectPreviewLayer
          effect={effect}
          props={effectProps}
          opacity={effectOpacity}
        />
      )}
      {textureUrl ? (
        <div
          className="absolute inset-0 opacity-25"
          style={{ backgroundImage: `url("${textureUrl}")`, backgroundSize: 'cover', backgroundPosition: 'center' }}
        />
      ) : textureCss ? (
        <div
          className="absolute inset-0"
          style={{ backgroundImage: textureCss.backgroundImage, backgroundSize: textureCss.backgroundSize }}
        />
      ) : null}
      {/* Same diagonal veil at the same two opacities as before; only its TONE
          now follows the contrast result. On every card that resolves to light
          copy the channels are `0 0 0` and this is byte-identical to the
          `from-black/30 … to-black/55` classes it replaces — but a card the
          operator switched to dark text used to get dark copy over a black
          veil, which is the one combination nobody can read. */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `linear-gradient(to bottom right, rgb(${contrast.veilChannels} / 0.3) 0%, transparent 50%, rgb(${contrast.veilChannels} / 0.55) 100%)`,
        }}
      />
      <CardLogoMark
        preset={cardLogo}
        customUrl={cardLogoUrl}
        className="pointer-events-none absolute -right-3 -bottom-4 h-20 w-20"
        style={{ color: contrast.foreground, opacity: 0.12 }}
      />
      <div className="relative flex items-center gap-2.5">
        <span className="shrink-0 leading-none drop-shadow" style={{ color: accent }}>
          <PlanIconView value={plan.icon} className="h-5 w-5 text-xl" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-semibold drop-shadow">{plan.name}</p>
          <p className="text-[9px] font-medium opacity-80">
            {plan.trafficLimit > 0 ? `${plan.trafficLimit} GB` : unlimitedLabel}
            {plan.deviceLimit > 0 ? ` · ${plan.deviceLimit}` : ''}
          </p>
        </div>
      </div>
    </div>
  )
}
